// =============================================================================
// dsh-pet-forge · 从视频生成桌宠（抽帧 → 抠绿幕 → 切动作 → 图集）
// -----------------------------------------------------------------------------
// 输入：一段（或多段）拍摄/渲染好的视频，角色在纯色幕布前做动作。
// 输出：一份标准的宠物包（atlas.png + pet.json），可直接 verify / inspect / install。
//
// 流水线：
//   1. 找解码引擎：ffmpeg（最稳） → python + OpenCV（本机常见，自带一份 FFmpeg） → 用户已抽好的帧
//   2. 抽帧（按目标 fps，只取需要的时间区间）
//   3. 抠像：在 UV 色度平面上按距离做键控（similarity / blend 双阈值羽化）+ 绿边溢色抑制（despill）
//   4. 切动作：显式时间段（推荐）或按运动幅度自动切分
//   5. 对齐落格：**全体帧共用并集包围盒 + 统一缩放**，再把每帧投进严格 cellW×cellH 的格子
//      （这一条是从 anim.mjs 借来的：它保证跳跃/摔倒不会被裁掉、且帧间相对位移精确保留）
//   6. 写 atlas.png + pet.json，并跑一遍严格校验
//
// 为什么抠像放在 JS 而不是交给 ffmpeg 的 chromakey 滤镜：
//   · 两个引擎（ffmpeg / cv2）行为才能一致，测试也能离线复现；
//   · 我们的阈值语义（similarity / blend / spill / erode）在两条通道上是同一套数字；
//   · 抽帧用 RGB、抠像用 alpha，出问题时能分别看"原帧"和"抠完的帧"。
// =============================================================================

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadImage, newImg, getPixel, cloneImg, encodeImage } from './imaging.mjs'
import { unionBounds, projectFrames, composeAtlas, auditAtlas, ACTION_TO_ROW } from './anim.mjs'
import { makeManifest, writeManifest, buildDefaultStates, validatePackage, STATE_META, DEFAULT_ATLAS } from './manifest.mjs'

export { unionBounds, projectFrames }

const __dirname = dirname(fileURLToPath(import.meta.url))
const PY_EXTRACTOR = resolve(__dirname, '..', 'py', 'extract_frames.py')

// ---------------------------------------------------------------------------
// 引擎探测
// ---------------------------------------------------------------------------

const CANDIDATE_FFMPEG = [
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
  join(process.env.USERPROFILE || '', 'scoop', 'shims', 'ffmpeg.exe'),
  '/usr/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/opt/homebrew/bin/ffmpeg',
]

function runCapture(cmd, args, { timeoutMs = 8000 } = {}) {
  const res = spawnSync(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' })
  return {
    ok: res.status === 0 && !res.error,
    status: res.status,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || ''),
    error: res.error ? String(res.error.message || res.error) : '',
  }
}

/** 找 ffmpeg：显式路径 → 环境变量 → PATH → 常见安装位置。 */
export function findFfmpeg(opts = {}) {
  const explicit = opts.ffmpegPath || process.env.DSH_PET_FFMPEG || process.env.FFMPEG_PATH
  const tried = []
  const probe = (p, source) => {
    const r = runCapture(p, ['-version'])
    tried.push({ path: p, source, ok: r.ok, status: r.status, error: r.error })
    if (r.ok) {
      const version = (r.stdout.split('\n')[0] || '').trim()
      return { path: p, source, version, ffprobe: siblingFfprobe(p) }
    }
    return null
  }
  if (explicit) {
    const hit = probe(explicit, 'explicit')
    if (hit) return { ...hit, tried }
    return { path: null, tried, error: `指定的 ffmpeg 不可用：${explicit}` }
  }
  const onPath = probe('ffmpeg', 'PATH')
  if (onPath) return { ...onPath, tried }
  for (const p of CANDIDATE_FFMPEG) {
    if (p && existsSync(p)) {
      const hit = probe(p, 'common-dir')
      if (hit) return { ...hit, tried }
    }
  }
  return { path: null, tried }
}

function siblingFfprobe(ffmpegPath) {
  const guess = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'))
  return existsSync(guess) ? guess : null
}

/** 找 python（优先当前 PATH 里的 python / python3 / py -3）。 */
export function findPython(opts = {}) {
  const candidates = []
  if (opts.pythonPath || process.env.DSH_PET_PYTHON) candidates.push(opts.pythonPath || process.env.DSH_PET_PYTHON)
  candidates.push('python', 'python3', 'py')
  const tried = []
  for (const cmd of candidates) {
    if (!cmd) continue
    const args = cmd === 'py' ? ['-3', '--version'] : ['--version']
    const r = runCapture(cmd, args, { timeoutMs: 8000 })
    tried.push({ cmd, ok: r.ok, status: r.status, error: r.error || r.stderr.slice(0, 120) })
    if (r.ok) return { path: cmd, py3: cmd === 'py', version: (r.stdout || r.stderr).trim(), tried }
  }
  return { path: null, tried }
}

/** 有 python 也不一定有 opencv；单独探一次。 */
export function probeCv2(python) {
  if (!python || !python.path) return { ok: false, reason: '没有可用的 python' }
  const args = python.py3 ? ['-3', '-c', 'import cv2;print(cv2.__version__)'] : ['-c', 'import cv2;print(cv2.__version__)']
  const r = runCapture(python.path, args, { timeoutMs: 20000 })
  if (r.ok && r.stdout.trim()) return { ok: true, version: r.stdout.trim(), python: python.path, py3: python.py3 }
  return {
    ok: false,
    reason: (r.stderr || r.error || '').split('\n').filter(Boolean).slice(-1)[0] || 'import cv2 失败',
    hint: 'python -m pip install opencv-python',
  }
}

let enginesCache = null

/** 汇总可用的解码引擎（进程内缓存，doctor 与 video 命令共用）。 */
export async function probeEngines(opts = {}) {
  if (enginesCache && !opts.force) return enginesCache
  const ffmpeg = findFfmpeg(opts)
  const python = findPython(opts)
  const cv2 = probeCv2(python)
  const list = []
  if (ffmpeg.path) list.push('ffmpeg')
  if (cv2.ok) list.push('cv2')
  enginesCache = {
    ffmpeg: ffmpeg.path ? { ok: true, path: ffmpeg.path, version: ffmpeg.version, ffprobe: ffmpeg.ffprobe } : { ok: false, tried: ffmpeg.tried, error: ffmpeg.error },
    python,
    cv2,
    available: list,
    preferred: list[0] || null,
    hint: list.length
      ? ''
      : '没有可用的视频解码引擎。任选其一：① winget install Gyan.FFmpeg（推荐，最稳，还能抽音频）；'
        + '② pip install opencv-python（本机若已有 Anaconda 通常已装）；'
        + '③ 自己抽好 PNG 帧后用 --frames-dir 导入，其余流程照样能用。',
  }
  return enginesCache
}

// ---------------------------------------------------------------------------
// 视频元信息
// ---------------------------------------------------------------------------

export async function probeVideo({ video, engine, ffmpegPath, pythonPath }) {
  if (!video) return { ok: false, error: '缺少视频路径' }
  if (!existsSync(video)) return { ok: false, error: `视频文件不存在：${video}` }
  const engines = await probeEngines({ ffmpegPath, pythonPath })
  const use = engine && engine !== 'auto' ? engine : engines.preferred
  if (use === 'ffmpeg') {
    const ffprobe = engines.ffmpeg.ffprobe
    if (ffprobe) {
      const r = runCapture(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', video], { timeoutMs: 20000 })
      if (r.ok) {
        try {
          const data = JSON.parse(r.stdout)
          const v = (data.streams || []).find((s) => s.codec_type === 'video') || {}
          const a = (data.streams || []).find((s) => s.codec_type === 'audio')
          const [num, den] = String(v.avg_frame_rate || '0/1').split('/').map(Number)
          const fps = den ? num / den : 0
          return {
            ok: true, engine: 'ffmpeg', video,
            width: v.width, height: v.height, fps: round4(fps),
            frames: v.nb_frames ? Number(v.nb_frames) : 0,
            duration: round4(Number((data.format || {}).duration) || 0),
            codec: v.codec_name || '', hasAudio: Boolean(a), audioCodec: a ? a.codec_name : null,
          }
        } catch { /* 落到 ffmpeg -i 解析 */ }
      }
    }
    // 没有 ffprobe：解析 `ffmpeg -i` 的 stderr（老办法，但够用）
    const r = runCapture(engines.ffmpeg.path, ['-hide_banner', '-i', video], { timeoutMs: 20000 })
    const text = r.stderr + r.stdout
    const dur = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(text)
    const vid = /Stream #\d+:\d+.*?Video:.*?(\d{2,5})x(\d{2,5})/.exec(text)
    const fps = /(\d+(?:\.\d+)?)\s*fps/.exec(text)
    return {
      ok: true, engine: 'ffmpeg', video,
      width: vid ? Number(vid[1]) : 0, height: vid ? Number(vid[2]) : 0,
      fps: fps ? Number(fps[1]) : 0,
      duration: dur ? (Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])) : 0,
      frames: 0, codec: '', hasAudio: /Stream #\d+:\d+.*?Audio:/.test(text),
      note: 'ffprobe 不可用，元信息来自 ffmpeg -i 的文本输出（够用但不精确）',
    }
  }
  if (use === 'cv2') {
    const r = runPython(pythonPath || engines.cv2.python, ['probe', video], { timeoutMs: 60000 })
    if (!r.json) return { ok: false, error: `python 抽帧脚本没有返回 JSON：${r.error || r.stderr.slice(0, 200)}` }
    return r.json
  }
  return { ok: false, error: engines.hint || '没有可用的视频解码引擎' }
}

const round4 = (n) => Math.round(Number(n) * 10000) / 10000

function runPython(python, args, opts = {}) {
  const py3 = opts.py3 || false
  const full = py3 ? ['-3', PY_EXTRACTOR, ...args] : [PY_EXTRACTOR, ...args]
  const r = runCapture(python, full, { timeoutMs: opts.timeoutMs || 120000 })
  const text = (r.stdout || '').trim()
  let json = null
  const line = text.split('\n').filter(Boolean).slice(-1)[0] || ''
  try { json = JSON.parse(line) } catch { /* 不是 JSON 就把原文带回去 */ }
  return { ...r, json }
}

// ---------------------------------------------------------------------------
// 抽帧
// ---------------------------------------------------------------------------

/**
 * 抽帧。返回 { ok, engine, files:[{path,t,index}], ... }
 * @param {object} opts
 *   video, outDir, fps, start, end, maxWidth, maxFrames, engine, ffmpegPath, pythonPath
 */
export async function extractFrames(opts) {
  const {
    video, outDir, fps = 12, start = 0, end = 0, maxWidth = 0, maxFrames = 400,
  } = opts
  const engines = await probeEngines(opts)
  const engine = opts.engine && opts.engine !== 'auto' ? opts.engine : engines.preferred
  if (!engine) return { ok: false, error: engines.hint }
  await mkdir(outDir, { recursive: true })
  if (engine === 'ffmpeg') return extractFramesFfmpeg({ ...opts, outDir, fps, start, end, maxWidth, maxFrames, ffmpegPath: engines.ffmpeg.path })
  if (engine === 'cv2') {
    return extractFramesCv2({ ...opts, outDir, fps, start, end, maxWidth, maxFrames, pythonPath: opts.pythonPath || engines.cv2.python, py3: engines.cv2.py3 })
  }
  return { ok: false, error: `未知引擎：${engine}` }
}

export async function extractFramesFfmpeg(opts) {
  const { video, outDir, fps, start, end, maxWidth, maxFrames, ffmpegPath } = opts
  const pattern = join(outDir, 'f_%05d.png')
  const filters = [`fps=${fps}`]
  if (maxWidth > 0) {
    // 只缩小、不放大；filter 里逗号要转义（这个字符串不经过 shell，转义是给 ffmpeg 自己看的）
    filters.push(`scale=w=min(iw\\,${maxWidth}):h=-2:flags=lanczos`)
  }
  const args = ['-hide_banner', '-nostdin', '-y']
  if (start > 0) args.push('-ss', String(start))
  args.push('-i', video)
  if (end > 0) args.push('-t', String(Math.max(0.05, end - start)))
  // 不用 -fps_mode/-vsync：ffmpeg 4 上没有 -fps_mode，而 fps 滤镜自己就把节奏定好了
  args.push('-vf', filters.join(','), '-pix_fmt', 'rgb24', pattern)
  const r = runCapture(ffmpegPath, args, { timeoutMs: Math.max(120000, Number(opts.timeoutMs) || 0) })
  const names = existsSync(outDir) ? (await readdir(outDir)).filter((f) => f.endsWith('.png')).sort() : []
  if (names.length === 0) {
    return {
      ok: false,
      engine: 'ffmpeg',
      error: `ffmpeg 没抽出任何帧：${(r.stderr || r.error || '').split('\n').filter(Boolean).slice(-2).join(' ')}`,
    }
  }
  if (names.length > maxFrames) {
    return { ok: false, engine: 'ffmpeg', error: `抽到 ${names.length} 帧，超过上限 ${maxFrames}（降低 --fps 或缩短区间）` }
  }
  const files = names.map((n, i) => ({ path: join(outDir, n), t: round4(start + i / fps), index: i }))
  return { ok: true, engine: 'ffmpeg', video, outDir, count: files.length, targetFps: fps, range: [start, end || null], files }
}

export async function extractFramesCv2(opts) {
  const { video, outDir, fps, start, end, maxWidth, maxFrames, pythonPath, py3 } = opts
  const r = runPython(pythonPath, ['extract', video, outDir, String(fps), String(start), String(end || 0), String(maxWidth || 0), String(maxFrames)], { timeoutMs: 300000, py3 })
  if (!r.json) {
    return {
      ok: false,
      engine: 'cv2',
      error: `python 抽帧没有返回 JSON：${r.error || (r.stderr || '').split('\n').filter(Boolean).slice(-2).join(' ') || '未知错误'}`,
    }
  }
  return r.json
}

// ---------------------------------------------------------------------------
// 抠像（色度键控）
// ---------------------------------------------------------------------------

const NAMED_KEYS = {
  green: [0, 255, 0],
  chroma: [0, 177, 64],      // 标准绿幕布
  blue: [0, 71, 187],        // 标准蓝幕布
  white: [255, 255, 255],
  black: [0, 0, 0],
  magenta: [255, 0, 255],
}

/** '0x00FF00' / '#00ff00' / 'green' / 'auto' / [r,g,b] → {r,g,b} | 'auto' | null */
export function parseChromaColor(input) {
  if (input === undefined || input === null || input === '' || String(input).toLowerCase() === 'auto') return 'auto'
  if (Array.isArray(input)) return { r: input[0], g: input[1], b: input[2] }
  const s = String(input).trim().toLowerCase()
  if (NAMED_KEYS[s]) { const [r, g, b] = NAMED_KEYS[s]; return { r, g, b } }
  const hex = s.replace(/^0x/, '').replace(/^#/, '')
  if (/^[0-9a-f]{6}$/.test(hex)) {
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) }
  }
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return {
      r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16),
    }
  }
  const parts = s.split(/[,\s]+/).map(Number)
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) return { r: parts[0], g: parts[1], b: parts[2] }
  return null
}

/** Rec.601 的色度分量（Cb/Cr），抠像只看这两个值。 */
const chromaOf = (r, g, b) => [
  -0.168736 * r - 0.331264 * g + 0.5 * b,
  0.5 * r - 0.418688 * g - 0.081312 * b,
]

/**
 * 从"画面边缘"采样幕布颜色。
 * 用边框而不是全图：角色在中间，边缘基本都是幕布。
 */
export function sampleKeyColor(imgs, opts = {}) {
  const band = opts.band || Math.max(2, Math.round((imgs[0]?.height || 100) * 0.02))
  const rs = []
  const gs = []
  const bs = []
  const step = Math.max(1, Math.floor(imgs.length / 6))
  for (let k = 0; k < imgs.length; k += step) {
    const img = imgs[k]
    const push = (x, y) => {
      const [r, g, b, a] = getPixel(img, x, y)
      if (a < 8) return
      rs.push(r); gs.push(g); bs.push(b)
    }
    for (let x = 0; x < img.width; x += 2) {
      for (let d = 0; d < band; d++) { push(x, d); push(x, img.height - 1 - d) }
    }
    for (let y = 0; y < img.height; y += 2) {
      for (let d = 0; d < band; d++) { push(d, y); push(img.width - 1 - d, y) }
    }
  }
  if (rs.length === 0) return { ok: false, error: '边框一个不透明像素都没有，无法自动取幕布色' }
  const med = (arr) => { const a = arr.slice().sort((p, q) => p - q); return a[Math.floor(a.length / 2)] }
  const r = med(rs)
  const g = med(gs)
  const b = med(bs)
  let acc = 0
  for (let i = 0; i < rs.length; i++) {
    acc += (rs[i] - r) ** 2 + (gs[i] - g) ** 2 + (bs[i] - b) ** 2
  }
  const std = Math.sqrt(acc / rs.length)
  return {
    ok: true, r, g, b, std: round4(std), sampleCount: rs.length,
    confidence: std <= 12 ? 'high' : std <= 30 ? 'medium' : 'low',
    warning: std > 30
      ? `边框颜色离散度偏高（标准差 ${std.toFixed(1)}）：背景可能不是纯色幕布、有渐变或阴影，抠像边缘可能不干净`
      : null,
  }
}

/**
 * 色度键控。
 * @param {object} img
 * @param {object} opts
 *   key        {r,g,b}
 *   similarity 内阈值（0~1，越小抠得越少）；默认 0.16
 *   blend      羽化带宽（0~1）；默认 0.10
 *   spill      绿边抑制强度 0~1；默认 0.6
 *   alphaFloor 低于这个 alpha 直接清零（去噪点）；默认 16
 * @returns {{img:object, report:object}}
 */
export function chromaKey(img, opts = {}) {
  const key = opts.key || NAMED_KEYS.chroma
  const similarity = opts.similarity ?? 0.16
  const blend = opts.blend ?? 0.1
  const spill = opts.spill ?? 0.6
  const alphaFloor = opts.alphaFloor ?? 16
  const [kcb, kcr] = chromaOf(key.r, key.g, key.b)
  const simD = similarity * 255
  const outD = (similarity + blend) * 255
  const out = cloneImg(img)
  let transparent = 0
  let semi = 0
  let kept = 0
  const w = img.width
  const h = img.height
  for (let p = 0; p < w * h; p++) {
    const i = p * 4
    const a0 = out.data[i + 3]
    if (a0 === 0) { transparent++; continue }
    const r = out.data[i]
    const g = out.data[i + 1]
    const b = out.data[i + 2]
    const [cb, cr] = chromaOf(r, g, b)
    const d = Math.hypot(cb - kcb, cr - kcr)
    let a = a0
    if (d <= simD) a = 0
    else if (d < outD) a = Math.round(a0 * ((d - simD) / Math.max(1e-6, outD - simD)))
    if (a <= alphaFloor) {
      out.data[i + 3] = 0
      transparent++
      continue
    }
    out.data[i + 3] = a
    if (a < 250) semi++
    else kept++
    // 溢色抑制：幕布是绿/蓝时，角色边缘会染上幕布色，把那个通道往 r/b 的均值压回去
    if (spill > 0) {
      const [sr, sg, sb] = despillPixel(r, g, b, key, spill)
      out.data[i] = sr
      out.data[i + 1] = sg
      out.data[i + 2] = sb
    }
  }
  return {
    img: out,
    report: {
      key, similarity, blend, spill,
      transparent, semi, kept,
      total: w * h,
      transparentRatio: round4(transparent / (w * h)),
    },
  }
}

/**
 * 单个像素的溢色抑制。
 * 绿幕：g 明显高于 r/b 时把 g 压向 (r+b)/2；蓝幕同理压 b。
 * 只压"超出部分"的一部分（strength），避免把角色本身的绿色也一起吃掉。
 */
export function despillPixel(r, g, b, key, strength) {
  const [kr, kg, kb] = [key.r, key.g, key.b]
  // 判断这块幕布偏哪个通道：取最大值通道
  const dominant = kg >= kr && kg >= kb ? 1 : (kb >= kr ? 2 : 0)
  const s = Math.max(0, Math.min(1, strength))
  if (dominant === 1) {
    const limit = (r + b) / 2
    if (g > limit) return [r, Math.round(limit + (g - limit) * (1 - s)), b]
    return [r, g, b]
  }
  if (dominant === 2) {
    const limit = (r + g) / 2
    if (b > limit) return [r, g, Math.round(limit + (b - limit) * (1 - s))]
    return [r, g, b]
  }
  const limit = (g + b) / 2
  if (r > limit) return [Math.round(limit + (r - limit) * (1 - s)), g, b]
  return [r, g, b]
}

/** alpha 腐蚀（只动 alpha，不动颜色）：用来收掉残留的一圈幕布边。 */
export function erodeAlpha(img, radius) {
  const r = Math.max(0, Math.round(radius))
  if (r === 0) return cloneImg(img)
  const out = cloneImg(img)
  const w = img.width
  const h = img.height
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if (img.data[i + 3] === 0) continue
      let min = 255
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx
          const ny = y + dy
          const a = (nx < 0 || ny < 0 || nx >= w || ny >= h) ? 0 : img.data[(ny * w + nx) * 4 + 3]
          if (a < min) min = a
          if (min === 0) break
        }
        if (min === 0) break
      }
      out.data[i + 3] = min
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 动作切分
// ---------------------------------------------------------------------------

/** 相邻两帧的差异（0~1）：只看"任一帧不透明"的像素，避免背景噪声干扰。
 *  大图按 stride 抽样 —— 这个值只用来找"动作停顿点"，不需要逐像素精确。 */
export function motionEnergy(a, b) {
  const w = Math.min(a.width, b.width)
  const h = Math.min(a.height, b.height)
  const stride = Math.max(1, Math.floor(Math.sqrt((w * h) / 30000)))
  let acc = 0
  let count = 0
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      const i = (y * a.width + x) * 4
      const j = (y * b.width + x) * 4
      const aa = a.data[i + 3]
      const ba = b.data[j + 3]
      if (aa === 0 && ba === 0) continue
      const la = 0.299 * a.data[i] + 0.587 * a.data[i + 1] + 0.114 * a.data[i + 2]
      const lb = 0.299 * b.data[j] + 0.587 * b.data[j + 1] + 0.114 * b.data[j + 2]
      acc += Math.abs(la - lb) / 255
      count++
    }
  }
  return count === 0 ? 0 : acc / count
}

export function computeMotionEnergies(frames) {
  const out = []
  for (let i = 1; i < frames.length; i++) out.push(round4(motionEnergy(frames[i - 1], frames[i])))
  return out
}

/**
 * 按运动幅度把一串帧切成 count 段：在"动作最小"的地方下刀（人做动作之间总有停顿）。
 * 找不到足够多的低点就退化成等分，并如实标注 synthetic。
 */
/**
 * 按运动幅度把一串帧切成 count 段。两种策略，按素材实际情况自动选：
 *
 *  ① pauses（停顿型）：找**夹在两段真实动作之间**的能量低谷 —— 人做完一个动作会停下来，
 *     这是手拍素材最常见的形态。注意"附近也全是静的"不算停顿（那只是整段视频的一部分），
 *     所以要求低谷两侧 ±minLen 窗口里出现过明显动作。
 *  ② transitions（转折型）：没有停顿、动作是硬切/一轮一轮做的时候，改在**能量尖峰**处下刀
 *     （局部极大），切出来的每段正好是一个动作。
 *
 * 两种都找不到足够切点 → 退化成等分并标 synthetic；尖峰全是平台（没有局部极大）→
 * 标 ambiguous，让上层如实提醒用户"自动切分不可信，请给 --segments"。
 */
export function splitByMotion(energies, opts = {}) {
  const count = Math.max(1, opts.count || 2)
  const minLen = Math.max(2, opts.minLen || 3)
  const n = energies.length + 1
  if (count <= 1) return { cuts: [], segments: [{ from: 0, to: n - 1 }], synthetic: false, ambiguous: false, mode: 'single' }
  if (n < count * minLen) {
    return { cuts: [], segments: equalSegments(n, count), synthetic: true, ambiguous: false, mode: 'equal', reason: `帧数太少（${n}），已等分` }
  }
  const maxEnergy = energies.reduce((a, b) => Math.max(a, b), 0)
  const sorted = (list) => list.slice().sort((a, b) => b.e - a.e)
  /** 贪心挑点：彼此间距 ≥ minLen，且离两端也 ≥ minLen。 */
  const pick = (candidates, need) => {
    const out = []
    for (const c of candidates) {
      if (out.length >= need) break
      if (out.some((x) => Math.abs(x.i - c.i) < minLen)) continue
      out.push(c)
    }
    return out.length === need ? out.map((x) => x.i).sort((a, b) => a - b) : null
  }

  if (maxEnergy <= 1e-6) {
    // 整段视频都没动 —— 切成几段都一样，如实说"没有可切的边界"
    return {
      cuts: [], segments: equalSegments(n, count), synthetic: true, ambiguous: true, mode: 'equal',
      reason: '整段视频几乎没有运动（画面里角色没动？），无法按动作切分，已等分',
    }
  }

  const isPeak = (i) => {
    if (i < minLen || i > n - minLen) return false
    const e = energies[i - 1]
    if (e < maxEnergy * 0.4) return false
    const prev = i - 2 >= 0 ? energies[i - 2] : -1
    const next = i <= energies.length - 1 ? energies[i] : -1
    return e >= prev && e >= next && (e > prev || e > next)
  }
  /**
   * "孤立尖峰"：它周围 ±minLen 里没有别的强运动。
   * 这类尖峰是**姿态边界**（硬切/换动作那一刻），切在它上面比切在旁边的静止区更准；
   * 而连续运动里那些密集的尖峰不是边界（只是动作本身在动），不能吸附过去。
   */
  const isIsolatedPeak = (i) => {
    if (!isPeak(i)) return false
    for (let k = Math.max(0, i - 1 - minLen); k <= Math.min(energies.length - 1, i - 1 + minLen); k++) {
      if (k === i - 1) continue
      if (energies[k] >= maxEnergy * 0.4) return false
    }
    return true
  }

  // ① 停顿型
  const valleys = []
  for (let i = minLen; i <= n - minLen; i++) {
    const e = energies[i - 1]
    if (e > maxEnergy * 0.25) continue
    let around = 0
    for (let k = Math.max(0, i - 1 - minLen); k <= Math.min(energies.length - 1, i - 1 + minLen); k++) {
      if (energies[k] > around) around = energies[k]
    }
    // 附近必须真有动作，否则这不是"动作之间的停顿"，而是"整段都静止"
    if (around < maxEnergy * 0.4) continue
    valleys.push({ i, e })
  }
  const rawValleys = pick(sorted(valleys), count - 1)
  if (rawValleys) {
    // 吸附：紧挨着孤立尖峰的停顿点，改切在尖峰上（姿态边界）
    const snapped = []
    let snappedAny = false
    for (const c of rawValleys) {
      let best = c
      let bestD = Infinity
      for (let p = Math.max(minLen, c - minLen); p <= Math.min(n - minLen, c + minLen); p++) {
        if (!isIsolatedPeak(p)) continue
        const d = Math.abs(p - c)
        if (d < bestD) { bestD = d; best = p }
      }
      if (best !== c) snappedAny = true
      snapped.push(best)
    }
    const finalCuts = Array.from(new Set(snapped)).sort((a, b) => a - b).filter((c, i, arr) => i === 0 || c - arr[i - 1] >= minLen)
    if (finalCuts.length === count - 1) {
      return {
        cuts: finalCuts, segments: segmentsFrom(finalCuts, n), synthetic: false, ambiguous: false, mode: 'pauses',
        snappedToTransitions: snappedAny,
        cutEnergies: finalCuts.map((c) => round4(energies[c - 1])), maxEnergy: round4(maxEnergy),
      }
    }
  }

  // ② 转折型：局部极大（平台不算尖峰，否则整段匀速运动会挑出随机位置）
  const peaks = []
  for (let i = minLen; i <= n - minLen; i++) if (isPeak(i)) peaks.push({ i, e: energies[i - 1] })
  const peakCuts = pick(sorted(peaks), count - 1)
  if (peakCuts) {
    return {
      cuts: peakCuts, segments: segmentsFrom(peakCuts, n), synthetic: false, ambiguous: false, mode: 'transitions',
      cutEnergies: peakCuts.map((c) => round4(energies[c - 1])), maxEnergy: round4(maxEnergy),
    }
  }

  // ③ 只剩平台/噪声：挑最强的几个位置，但标注"不可信"
  const flatCuts = pick(sorted(energies.map((e, i) => ({ i: i + 1, e })).filter((c) => c.i >= minLen && c.i <= n - minLen)), count - 1)
  if (flatCuts) {
    return {
      cuts: flatCuts, segments: segmentsFrom(flatCuts, n), synthetic: false, ambiguous: true, mode: 'flat',
      cutEnergies: flatCuts.map((c) => round4(energies[c - 1])), maxEnergy: round4(maxEnergy),
      reason: '运动曲线是平台（没有明显的停顿或转折），切点位置等于随机挑的',
    }
  }
  return { cuts: [], segments: equalSegments(n, count), synthetic: true, ambiguous: false, mode: 'equal', reason: '找不到可用的切点，已等分' }
}

function segmentsFrom(cuts, n) {
  const bounds = [0, ...cuts, n]
  const segments = []
  for (let i = 0; i < bounds.length - 1; i++) segments.push({ from: bounds[i], to: bounds[i + 1] - 1 })
  return segments
}

function equalSegments(n, count) {
  const out = []
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * n) / count)
    const to = Math.floor(((i + 1) * n) / count) - 1
    out.push({ from, to: Math.max(from, to) })
  }
  return out
}

/**
 * 解析显式动作时间段："idle:0-2.5, waving:3-5.2, jumping:5.2-"（秒；末尾留空表示到结束）
 * 也接受 `=` 分隔：`idle=0-2.5`。
 */
export function parseSegments(spec, duration = 0) {
  const errors = []
  const segments = []
  if (spec === true || spec === undefined || spec === null || spec === '') return { ok: false, segments, errors: ['没有给出时间段'] }
  const items = String(spec).split(/[,;]/).map((s) => s.trim()).filter(Boolean)
  if (items.length === 0) return { ok: false, segments, errors: ['时间段是空的'] }
  for (const item of items) {
    const m = /^([A-Za-z][A-Za-z0-9]*)\s*[:=]\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)?$/.exec(item)
    if (!m) {
      errors.push(`看不懂这一段：「${item}」。格式应为 动作:起始-结束（秒），例如 idle:0-2.5`)
      continue
    }
    const action = m[1]
    if (action === 'look') {
      errors.push('视频生成不了「look」（16 方向视线需要多角度素材）：请改用 idle/running/waving/jumping/failed/waiting/review')
      continue
    }
    if (!(action in ACTION_TO_ROW)) {
      errors.push(`未知动作「${action}」（可用：${Object.keys(ACTION_TO_ROW).join(' / ')}）`)
      continue
    }
    const from = Number(m[2])
    const to = m[3] === undefined ? (duration > 0 ? duration : 0) : Number(m[3])
    if (!(to > from)) {
      errors.push(`「${item}」的结束时间必须大于起始时间（视频时长 ${duration ? duration.toFixed(2) + ' 秒' : '未知'}）`)
      continue
    }
    if (duration > 0 && from >= duration) {
      errors.push(`「${item}」的起始时间 ${from}s 已经超过视频时长 ${duration.toFixed(2)}s`)
      continue
    }
    segments.push({ action, from, to: duration > 0 ? Math.min(to, duration) : to })
  }
  // 重叠只提醒不报错：有些动作本来就共享一段素材
  const warnings = []
  const sorted = segments.slice().sort((a, b) => a.from - b.from)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].from < sorted[i - 1].to - 1e-6) {
      warnings.push(`「${sorted[i - 1].action}」与「${sorted[i].action}」的时间段有重叠（这不影响生成，但两段会拿到同样的帧）`)
    }
  }
  const seen = new Set()
  for (const s of segments) {
    if (seen.has(s.action)) warnings.push(`动作「${s.action}」出现了多次，后一段会覆盖前一段`)
    seen.add(s.action)
  }
  return { ok: errors.length === 0 && segments.length > 0, segments, errors, warnings }
}

/** 帧序列 → 每个动作的分段（帧下标区间）。 */
export function segmentFramesByTime(frames, segments) {
  const out = []
  for (const seg of segments) {
    const picked = frames.filter((f) => f.t >= seg.from - 1e-9 && f.t <= seg.to + 1e-9)
    out.push({ action: seg.action, from: seg.from, to: seg.to, frames: picked })
  }
  return out
}

/** 均匀取 n 个（含首尾），保持动作的起止姿态。 */
export function pickEvenly(list, n) {
  if (n <= 0) return []
  if (list.length <= n) return list.slice()
  if (n === 1) return [list[0]]
  const out = []
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (list.length - 1)) / (n - 1))
    out.push(list[idx])
  }
  return out
}

// ---------------------------------------------------------------------------
// 组装宠物包
// ---------------------------------------------------------------------------

/**
 * 关键帧 → 图集各行。
 * 全体帧共用**并集包围盒 + 统一缩放**（loose 里的动作例外：它们自己算一份，
 * 免得"摔倒时甩出去半个身位"把所有人的体型都缩小）。
 */
export function buildRowFrames(sampled, opts) {
  const cellW = opts.cellW
  const cellH = opts.cellH
  const padX = Math.round(cellW * (opts.padX ?? 0.03))
  const topPad = Math.round(cellH * (opts.topPad ?? 0.03))
  const footPad = Math.round(cellH * (opts.footPad ?? 0.05))
  const loose = new Set(opts.looseActions || ['failed'])
  const all = []
  for (const item of sampled) all.push(...item.frames)
  const globalBbox = unionBounds(all, 6)
  const rowFrames = {}
  const perAction = {}
  const problems = []
  for (const item of sampled) {
    const row = ACTION_TO_ROW[item.action]
    if (row === undefined) { problems.push(`动作「${item.action}」没有对应的图集行，已跳过`); continue }
    if (item.frames.length === 0) { problems.push(`动作「${item.action}」这一段没取到帧，已跳过`); continue }
    const bbox = (loose.has(item.action) ? unionBounds(item.frames, 6) : null) || globalBbox
    if (!bbox) { problems.push(`动作「${item.action}」所有帧都是空的（抠像抠过头了？）`); continue }
    const cells = projectFrames(item.frames, bbox, { cellW, cellH, padX, topPad, footPad, maxScale: opts.maxScale ?? 1.35 })
    rowFrames[row] = cells
    perAction[item.action] = { row, frames: cells.length, bbox, sourceFrames: item.frames.length }
  }
  return { rowFrames, perAction, globalBbox, problems }
}

/** 每个动作的播放帧率：默认按"素材段时长 → 播放帧数"还原真实速度。 */
export function playFpsFor(item, frames, explicit) {
  if (explicit && explicit > 0) return explicit
  const span = Math.max(0.05, item.to - item.from)
  const natural = frames / span
  const fallback = STATE_META[item.action] ? STATE_META[item.action].fps : 8
  const v = Number.isFinite(natural) && natural > 0 ? natural : fallback
  return Math.max(2, Math.min(24, Math.round(v)))
}

/**
 * 主流程：一段视频（或若干段）→ 宠物包。
 *
 * @param {string} pkgDir 宠物包目录（会写入 atlas.png / pet.json / video-report.json）
 * @param {object} opts
 *   video          单个视频路径
 *   videos         { action: path } 每个动作一个视频（优先于 video+segments）
 *   framesDir      已经抽好的 PNG 帧目录（不给视频时用）
 *   segments       'idle:0-2.5,waving:3-5' 或 'auto'
 *   actions        自动切分时按这个顺序分配动作
 *   key            'auto' | '0x00FF00' | 'green' | ...
 *   similarity/blend/spill/erode
 *   fps/start/end/maxWidth/maxFrames
 *   cols/rows/cellW/cellH/name/id/size
 *   engine/ffmpegPath/pythonPath
 *   keepFrames     是否保留抽出来的原帧（默认 true）
 */
export async function buildPetFromVideo(pkgDir, opts = {}) {
  const dir = resolve(pkgDir)
  // 进度回调：GUI（插件的视频面板）靠它显示实时进度。CLI 把它打到 stderr，
  // 最终 JSON 仍然只走 stdout —— 别把进度混进 JSON 流里，那会把解析搞坏。
  const progress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {}
  const step = (msg) => { try { progress(msg) } catch { /* 进度回调出错不能影响主流程 */ } }
  const report = {
    ok: false,
    command: 'video',
    pkg: dir,
    steps: [],
    warnings: [],
    errors: [],
  }
  const atlasCfg = {
    cols: opts.cols || DEFAULT_ATLAS.cols,
    rows: opts.rows || DEFAULT_ATLAS.rows,
    cellW: opts.cellW || DEFAULT_ATLAS.cellW,
    cellH: opts.cellH || DEFAULT_ATLAS.cellH,
  }
  const framesRoot = join(dir, 'video-frames')
  const engines = await probeEngines(opts)
  report.engines = {
    available: engines.available,
    preferred: engines.preferred,
    ffmpeg: engines.ffmpeg.ok ? engines.ffmpeg.path : null,
    cv2: engines.cv2.ok ? engines.cv2.version : null,
  }

  step('[1/6] 解码引擎：' + (engines.available.length ? engines.available.join(' + ') : '无（' + engines.hint + '）'))
  // ---- 1. 取帧 -------------------------------------------------------------
  /** @type {{action: string, frames: any[], from: number, to: number}[]} */
  let sampled = []
  /** @type {{path:string,t:number,index:number,img?:any}[]} */
  let extracted = []
  /** 多视频模式：每个动作的文件清单（抠像后再转成图片） */
  const videoGroups = []
  let videoInfo = null

  const loadFrames = async (files) => {
    const imgs = []
    for (const f of files) {
      const img = await loadImage(f.path)
      imgs.push(img)
    }
    return imgs
  }

  if (opts.videos && Object.keys(opts.videos).length > 0) {
    // 每动作一个视频：最省事也最准。
    // ⚠️ 这里只登记"哪个动作对应哪些帧文件"，真正取图放到抠像之后 ——
    //    否则 sampled 里握着的是**没抠过的原帧**，画面会是整块绿幕（踩过）。
    for (const [action, path] of Object.entries(opts.videos)) {
      if (!(action in ACTION_TO_ROW)) { report.errors.push(`未知动作「${action}」`); continue }
      const info = await probeVideo({ video: path, ...opts })
      if (!info.ok) { report.errors.push(`「${action}」的视频读不了：${info.error}`); continue }
      const outDir = join(framesRoot, action)
      step(`[2/6] 抽帧：${action} …`)
      const ex = await extractFrames({ ...opts, video: path, outDir, start: 0, end: 0 })
      if (!ex.ok) { report.errors.push(`「${action}」抽帧失败：${ex.error}`); continue }
      step(`[2/6] 抽帧：${action} → ${ex.count} 帧（引擎 ${ex.engine}）`)
      report.steps.push({ step: 'extract', action, engine: ex.engine, frames: ex.count, video: path, info })
      const imgs = await loadFrames(ex.files)
      extracted.push(...ex.files.map((f, i) => ({ ...f, img: imgs[i] })))
      videoGroups.push({ action, from: 0, to: info.duration || 0, files: ex.files })
      videoInfo = videoInfo || info
    }
  } else if (opts.framesDir) {
    // 用户自己抽好的帧：只按文件名排序，全部当作一段
    const names = (await readdir(opts.framesDir)).filter((f) => /\.(png|webp|jpg|jpeg)$/i.test(f)).sort()
    if (names.length === 0) return { ...report, error: `frames-dir 里没有图片：${opts.framesDir}` }
    const fps = opts.fps || 12
    const files = names.map((n, i) => ({ path: join(opts.framesDir, n), t: round4(i / fps), index: i }))
    const imgs = await loadFrames(files)
    extracted = files.map((f, i) => ({ ...f, img: imgs[i] }))
    step(`[2/6] 已读入 ${files.length} 张现成的帧（${opts.framesDir}）`)
    report.steps.push({ step: 'read-frames', dir: opts.framesDir, count: files.length, fps })
    videoInfo = { ok: true, engine: 'frames', duration: files.length / fps, fps, width: imgs[0].width, height: imgs[0].height }
    sampled = [] // 下面按 segments / auto 再切
  } else if (opts.video) {
    videoInfo = await probeVideo({ video: opts.video, ...opts })
    if (!videoInfo.ok) return { ...report, error: videoInfo.error, hint: engines.hint }
    // 有显式时间段时，只抽需要的那一段（省时间省磁盘）
    let winStart = Number(opts.start) || 0
    let winEnd = Number(opts.end) || 0
    let parsed = null
    if (opts.segments && opts.segments !== 'auto' && opts.segments !== true) {
      parsed = parseSegments(opts.segments, videoInfo.duration || 0)
      if (!parsed.ok) return { ...report, error: '时间段解析失败：' + parsed.errors.join('；'), errors: parsed.errors }
      winStart = Math.max(0, Math.min(...parsed.segments.map((s) => s.from)))
      winEnd = Math.max(...parsed.segments.map((s) => s.to))
      report.warnings.push(...parsed.warnings)
    }
    const ex = await extractFrames({ ...opts, video: opts.video, outDir: join(framesRoot, 'all'), start: winStart, end: winEnd })
    if (!ex.ok) return { ...report, error: ex.error, hint: engines.hint }
    step(`[2/6] 抽到 ${ex.count} 帧（引擎 ${ex.engine}，区间 ${winStart}~${round4(winEnd || videoInfo.duration || 0)}s）`)
    report.steps.push({ step: 'extract', engine: ex.engine, frames: ex.count, range: [winStart, winEnd], info: videoInfo })
    const imgs = await loadFrames(ex.files)
    ex.files.forEach((f, i) => extracted.push({ ...f, img: imgs[i] }))
  } else {
    return {
      ...report,
      error: '需要 --video <视频>，或 --frames-dir <已抽好的帧目录>',
      hint: '也可以在对话里说「用这个视频做桌宠：D:\\videos\\cat.mp4」',
    }
  }

  if (extracted.length === 0) {
    return { ...report, error: report.errors.length ? report.errors.join('；') : '没有可用的帧' }
  }

  // ---- 2. 抠像 -------------------------------------------------------------
  // ⚠️ noKey 必须在解析幕布颜色之前算出来。
  // CLI 的 --no-key 会把 key 翻成 'none'，而 parseChromaColor('none') 返回 null；
  // 以前先解析再判断 noKey，于是 'none' 会在"颜色无法理解"那行直接报错退出，
  // --no-key 永远走不到 —— 没有幕布、素材自带 alpha（人体分割的产物）的路线整条不通。
  const noKey = opts.noKey === true || opts.key === 'none' || opts.key === false
  let keySpec = noKey ? null : parseChromaColor(opts.key === undefined ? 'auto' : opts.key)
  if (!noKey && keySpec === null) return { ...report, error: `无法理解的幕布颜色：${opts.key}（用 auto / 0x00FF00 / green / 蓝幕 blue 都行）` }
  let keySource = 'explicit'
  if (!noKey && keySpec === 'auto') {
    const probeImgs = pickEvenly(extracted.map((e) => e.img), 5)
    const sampledKey = sampleKeyColor(probeImgs, {})
    if (!sampledKey.ok) return { ...report, error: sampledKey.error }
    keySpec = { r: sampledKey.r, g: sampledKey.g, b: sampledKey.b }
    keySource = 'auto'
    if (sampledKey.warning) report.warnings.push(sampledKey.warning)
    report.autoKey = sampledKey
  }

  const keyed = []
  step(noKey ? '[3/6] 按参数跳过抠像' : `[3/6] 抠幕布（${keySpec.r},${keySpec.g},${keySpec.b}${keySource === 'auto' ? ' 自动取样' : ' 指定'}）…`)
  if (noKey) {
    report.steps.push({ step: 'chroma', mode: 'none', reason: '按参数跳过了抠像' })
    for (const e of extracted) keyed.push(e.img)
  } else {
    let tSum = 0
    let sSum = 0
    for (const e of extracted) {
      let r = chromaKey(e.img, { key: keySpec, similarity: opts.similarity, blend: opts.blend, spill: opts.spill })
      if (opts.erode > 0) r = { img: erodeAlpha(r.img, opts.erode), report: r.report }
      tSum += r.report.transparentRatio
      sSum += r.report.semi / Math.max(1, r.report.total)
      keyed.push(r.img)
      e.keyReport = r.report
    }
    const avgTransparent = tSum / extracted.length
    report.chroma = {
      key: keySpec,
      keySource,
      similarity: opts.similarity ?? 0.16,
      blend: opts.blend ?? 0.1,
      spill: opts.spill ?? 0.6,
      erode: opts.erode || 0,
      avgTransparentRatio: round4(avgTransparent),
      avgSemiRatio: round4(sSum / extracted.length),
    }
    report.steps.push({ step: 'chroma', mode: 'chroma-key', key: keySpec, transparent: round4(avgTransparent) })
    step(`[3/6] 抠完：平均抠掉 ${(avgTransparent * 100).toFixed(1)}% 的背景`)
    if (avgTransparent < 0.05) {
      report.warnings.push(
        `只有 ${(avgTransparent * 100).toFixed(1)}% 的像素被抠掉：背景可能不是纯色幕布（改用 --key 手动指定幕布色，或调大 --similarity）`,
      )
    }
    if (avgTransparent > 0.97) {
      return {
        ...report,
        error:
          '抠像把角色也一起抠掉了（超过 97% 的画面变成透明）。两种可能：'
          + '① 幕布色选错了 —— 用 --key 0x00FF00 手动指定，或调小 --similarity；'
          + '② 角色在画面里太小（不到 3%）—— 换成人物占据画面的近景，或显式指定 --key 后继续',
        chroma: report.chroma,
      }
    }
  }
  for (let i = 0; i < extracted.length; i++) extracted[i].img = keyed[i]

  // 多视频模式：现在（抠像之后）才把每组视频的帧挂成"动作素材"
  if (videoGroups.length > 0) {
    const byPath = new Map(extracted.map((e) => [e.path, e.img]))
    for (const g of videoGroups) {
      const frames = g.files.map((f) => byPath.get(f.path)).filter(Boolean)
      if (frames.length === 0) { report.warnings.push(`「${g.action}」这一段没有可用帧`); continue }
      sampled.push({ action: g.action, from: g.from, to: g.to, frames })
    }
    report.steps.push({ step: 'segment', mode: 'per-video', assignment: sampled.map((s) => `${s.action}(${s.frames.length}帧)`) })
  }

  // ---- 3. 切动作 -----------------------------------------------------------
  // 多视频模式已经在上面按"一个动作一段视频"切好了；这里只处理"单视频"的两种情况。
  const actionOrder = (opts.actions && opts.actions.length ? opts.actions : ['idle', 'waving', 'jumping', 'running', 'review', 'waiting', 'failed'])
    .filter((a) => a in ACTION_TO_ROW)

  if (videoGroups.length === 0 && sampled.length === 0) {
    if (opts.segments && opts.segments !== 'auto' && opts.segments !== true) {
      const parsed = parseSegments(opts.segments, videoInfo.duration || 0)
      if (!parsed.ok) return { ...report, error: '时间段解析失败：' + parsed.errors.join('；') }
      const byAction = segmentFramesByTime(extracted, parsed.segments)
      for (const item of byAction) {
        if (item.frames.length === 0) { report.warnings.push(`「${item.action}」在 ${item.from}~${item.to}s 之间没有帧，已跳过`); continue }
        sampled.push({ action: item.action, from: item.from, to: item.to, frames: item.frames.map((f) => f.img) })
      }
      report.steps.push({ step: 'segment', mode: 'explicit', segments: parsed.segments })
    } else {
      // 自动切分：在运动低谷下刀，再按顺序贴动作名
      const imgs = extracted.map((e) => e.img)
      const energies = computeMotionEnergies(imgs)
      const count = Math.max(1, Math.min(actionOrder.length, Number(opts.autoSegments) > 0 ? Number(opts.autoSegments) : Math.min(3, actionOrder.length)))
      const split = splitByMotion(energies, { count, minLen: Math.max(2, Math.round(imgs.length / (count * 4))) })
      const times = extracted.map((e) => e.t)
      split.segments.forEach((seg, i) => {
        const action = actionOrder[i] || actionOrder[actionOrder.length - 1]
        const frames = imgs.slice(seg.from, seg.to + 1)
        if (frames.length === 0) return
        sampled.push({ action, from: times[seg.from], to: times[Math.min(seg.to, times.length - 1)], frames })
      })
      report.steps.push({
        step: 'segment',
        mode: 'auto',
        strategy: split.mode,
        count,
        synthetic: split.synthetic === true,
        ambiguous: split.ambiguous === true,
        cuts: split.cuts,
        cutEnergies: split.cutEnergies,
        reason: split.reason,
        assignment: sampled.map((s) => `${s.action} ${round4(s.from)}~${round4(s.to)}s`),
      })
      if (split.synthetic === true) {
        report.warnings.push(
          `自动切分退化成了等分（${split.reason}）：动作划分可能不准。想要准的，请显式给时间段 --segments "idle:0-2,waving:2-4"`,
        )
      } else if (split.ambiguous === true) {
        report.warnings.push(
          `自动切分不可信（${split.reason || '运动曲线没有明显边界'}）：请显式给时间段 `
          + '--segments "idle:0-2,waving:2-4,jumping:4-6"，或拆成多段视频用 --videos "idle=a.mp4,waving=b.mp4"',
        )
      } else if (split.mode === 'transitions') {
        report.steps.push({ step: 'segment-note', note: '这段视频里动作之间没有停顿，已按"运动转折点"切分' })
      }
      if (opts.autoSegments || (opts.segments === 'auto' || opts.segments === true)) {
        report.warnings.push(
          '自动切分是启发式的，请核对一下划分结果：'
          + sampled.map((s) => `${s.action} ${round4(s.from)}~${round4(s.to)}s`).join(' / ')
          + '。要精确就显式给 --segments（例如 --segments "idle:0-2,waving:2-4"），它会按你给的时间段严格切。',
        )
      }
    }
  }

  if (sampled.length === 0) return { ...report, error: '没有切出任何动作段' }

  // ---- 4. 选帧 + 对齐落格 --------------------------------------------------
  const perActionFrames = Math.max(1, Math.min(atlasCfg.cols, Number(opts.frames) || Math.min(6, atlasCfg.cols)))
  const prepared = sampled.map((s) => ({
    action: s.action,
    from: s.from,
    to: s.to,
    frames: pickEvenly(s.frames, perActionFrames),
  }))
  const built = buildRowFrames(prepared, {
    cellW: atlasCfg.cellW,
    cellH: atlasCfg.cellH,
    looseActions: opts.loose ? String(opts.loose).split(',').map((s) => s.trim()).filter(Boolean) : ['failed'],
    maxScale: opts.maxScale,
  })
  report.warnings.push(...built.problems)
  if (Object.keys(built.rowFrames).length === 0) return { ...report, error: '没有任何一行装配成功' }

  // ---- 5. 图集 + 清单 ------------------------------------------------------
  const { img: atlas, warnings: atlasWarnings } = composeAtlas({ ...atlasCfg, rowFrames: built.rowFrames })
  report.warnings.push(...atlasWarnings)
  const audit = auditAtlas(atlas, atlasCfg)
  report.audit = audit

  const states = buildDefaultStates(atlasCfg, prepared.map((p) => p.action))
  for (const p of prepared) {
    const info = built.perAction[p.action]
    if (!info) continue
    states[p.action] = {
      row: info.row,
      frames: info.frames,
      fps: playFpsFor(p, info.frames, Number(opts.playFps) || 0),
    }
  }
  delete states.look // 视频生成不了 16 方向视线，留给 idle 兜底

  const manifest = makeManifest({
    id: opts.id,
    name: opts.name,
    atlas: { file: 'atlas.png', ...atlasCfg },
    states,
    behavior: opts.behavior || 'look',
    size: opts.size ?? 120,
    audio: opts.audio || {},
    source: {
      kind: 'video',
      video: opts.video || null,
      videos: opts.videos || null,
      frames: extracted.length,
      engine: report.steps.find((s) => s.step === 'extract') ? report.steps.find((s) => s.step === 'extract').engine : null,
      chromaKey: report.chroma || { mode: 'none' },
      segments: prepared.map((p) => ({ action: p.action, from: round4(p.from), to: round4(p.to), frames: p.frames.length })),
      generatedAt: new Date().toISOString(),
    },
    tags: opts.tags || ['视频生成'],
  })
  manifest.id = manifest.id || 'video-pet'
  manifest.name = manifest.name || manifest.id

  await mkdir(dir, { recursive: true })
  const { encodeImage } = await import('./imaging.mjs')
  await writeFile(join(dir, 'atlas.png'), encodeImage(atlas))
  await writeManifest(dir, manifest)
  report.steps.push({ step: 'assemble', rows: Object.keys(built.rowFrames).length, perAction: built.perAction })
  step(`[5/6] 装配完成：${Object.keys(built.rowFrames).length} 行 × ${perActionFrames} 帧，格子 ${atlasCfg.cellW}×${atlasCfg.cellH}`)

  // 关键帧留样：出问题时能直接看"抠完长什么样"
  const samplesDir = join(dir, 'video-samples')
  await mkdir(samplesDir, { recursive: true })
  const sampleList = []
  for (const p of prepared) {
    const info = built.perAction[p.action]
    if (!info) continue
    const cells = built.rowFrames[info.row] || []
    for (let i = 0; i < Math.min(2, cells.length); i++) {
      const name = `${p.action}_${i}.png`
      await writeFile(join(samplesDir, name), encodeImage(cells[i]))
      sampleList.push(name)
    }
  }
  report.samples = sampleList.map((n) => join(samplesDir, n))

  if (opts.keepFrames === false) {
    await rm(framesRoot, { recursive: true, force: true })
    report.framesRemoved = true
  } else {
    report.framesDir = framesRoot
  }

  // ---- 6. 严格校验 ---------------------------------------------------------
  const v = await validatePackage(dir, manifest)
  step(v.ok ? '[6/6] 严格校验通过' : `[6/6] 校验未通过：${v.errors.join('；')}`)
  report.validation = { ok: v.ok, errors: v.errors, warnings: v.warnings }
  report.warnings.push(...v.warnings.map((w) => '校验提醒：' + w))
  report.errors.push(...v.errors)
  report.ok = v.ok
  report.pet = { id: manifest.id, name: manifest.name, actions: prepared.map((p) => p.action), framesPerAction: perActionFrames }
  report.atlas = { ...atlasCfg, file: join(dir, 'atlas.png') }
  report.videoInfo = videoInfo

  const manual = {}
  for (const p of prepared) manual[p.action] = `${round4(p.from)}s~${round4(p.to)}s`
  report.human = [
    `视频 ${videoInfo && videoInfo.width ? videoInfo.width + '×' + videoInfo.height + ' · ' + (videoInfo.duration || 0).toFixed(2) + 's' : ''}`,
    `抽帧 ${extracted.length} 张（引擎 ${report.steps.find((s) => s.step === 'extract') ? report.steps.find((s) => s.step === 'extract').engine : 'frames'}）`,
    noKey ? '未抠像' : `抠像：幕布 ${keySpec.r},${keySpec.g},${keySpec.b}${keySource === 'auto' ? '（自动取样）' : '（指定）'}，平均抠掉 ${((report.chroma ? report.chroma.avgTransparentRatio : 0) * 100).toFixed(1)}%`,
    `动作 ${prepared.length} 个：` + prepared.map((p) => `${p.action}(${built.perAction[p.action] ? built.perAction[p.action].frames : 0}帧)`).join(' / '),
    audit.length ? `⚠️ 图集自检有 ${audit.length} 处提醒（见 audit）` : '图集自检无异常',
  ].join(' | ')
  report.next = [
    'node forge.mjs inspect --pkg <目录>     # 出目视检查图，确认抠像边缘和动作对齐',
    'node forge.mjs verify --pkg <目录>      # 严格校验',
    'node forge.mjs install --pkg <目录>     # 注册进 DSH（右下角立刻出现）',
  ]
  return report
}


