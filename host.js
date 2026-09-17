// =============================================================================
// 桌宠插件 · DSH bundle 插件（Host 半）· v2
// =============================================================================
// 常驻：作为 profile bundle 加载，跨进程重启保留。
//
// 职责：
//   1. 内置素材（C罗精灵图 + SIU 提示音）经 webServer 注册 HTTP 路由
//   2. 轮询 agents 服务 + 监听 tools/execute、approval/request、agent/request-error
//      推导桌宠状态（idle / working / review / waiting / failed / celebrating）
//   3. 状态跃迁时由宿主进程用系统命令播放音效（全窗口可闻，不受浏览器静音影响）
//   4. **宠物注册表**：把「宠物包目录」持久化到 DSH_HOME/storages/dsh-pet-forge/registry.json，
//      支持多宠物、跨重启保留、单宠物独立音频
//   5. **素材路由**：/ronaldo-pet/asset/<id>/<相对路径> 直出宠物包里的图集与音频
//      （大文件绝不走 base64 / JSON —— 这是图片乱码问题的根因之一）
//   6. **注册即校验**：图集尺寸必须严格等于 列×格宽 / 行×格高，状态行号必须落在范围内；
//      不合格的包直接拒绝，从源头杜绝"取帧错位看起来像乱码"
//
// 与技能 dsh-pet-forge 的对接：该技能的 forge.mjs install 子命令会 POST
// /ronaldo-pet/pets/register { dir } 把生成的宠物注册进来，注册后无需重启。
//
// 安装：见 README.md「安装」章节（dsh plugin --profile web add <本包>）
// =============================================================================

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { existsSync, statSync, appendFileSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, relative, isAbsolute, sep, extname } from 'node:path'
import { homedir } from 'node:os'

import {
  createGallery, findPetJson, buildCompatManifest, safeRelative, GALLERY_PROTOCOL,
} from './lib/gallery.mjs'
import { probeEngines, probeVideo } from './skill/dsh-pet-forge/scripts/lib/video.mjs'
import {
  buildShareKit, validateSharing, DPSL_PROTOCOL, PET_TOPIC,
} from './skill/dsh-pet-forge/scripts/lib/share.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const name = 'ronaldo-pet'

export const inject = ['timer', 'webServer']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STORAGE = join(DSH_HOME, 'storages', 'dsh-pet-forge')

const CONFIG = {
  spritePath: join(__dirname, 'assets', 'spritesheet.webp'),
  voicePath: join(__dirname, 'assets', 'siu.mp3'),
  pollMs: 500,
  celebrateMs: 4800,
  failedMs: 2600,
  // 注册表位置：随 DSH 主目录走，卸载插件不丢；也可用 config.registryPath 覆盖
  registryPath: join(STORAGE, 'registry.json'),
  assetCacheMs: 5000,
  // 原生桌面宠物（WPF 窗口）：随插件启动自动拉起
  desktopPet: true,
  desktopScript: join(__dirname, 'desktop', 'DesktopPet.ps1'),
  desktopLog: join(STORAGE, 'desktop-pet.log'),
  // 宠物社区（画廊）：发现 / 缓存 / 下载 / 一键安装
  // 契约见 docs/GALLERY-CONTRACT.md，法律文本见 docs/PET-SHARING-AGREEMENT.md（DPSL-1.0）
  gallery: {
    enabled: true,
    topics: [PET_TOPIC],
    indexUrl: 'https://raw.githubusercontent.com/Stellum-Waq/dsh-pet-ronaldo/master/gallery/index.json',
    indexPath: join(__dirname, 'gallery', 'index.json'),
    cachePath: join(STORAGE, 'gallery-cache.json'),
    installDir: join(STORAGE, 'community'),
    cacheMs: 6 * 3600 * 1000,
    online: true,
    maxEntries: 60,
    maxDownloadBytes: 96 * 1024 * 1024,
    timeoutMs: 8000,
    // 本机 Node 的 CA 包认不出本地代理的根证书时，用 curl 兜底（详见 lib/gallery.mjs 注释）
    curlFallback: true,
    searchApi: 'https://api.github.com/search/repositories',
    rawBase: 'https://raw.githubusercontent.com',
    codeloadBase: 'https://codeload.github.com',
    token: '',
  },
  // 从视频生成：默认参数与引擎路径（留空则自动探测 PATH / 常见安装位置）
  video: {
    ffmpegPath: '',
    pythonPath: '',
    defaultFps: 12,
    defaultFrames: 6,
    maxFrames: 400,
    generateDir: join(STORAGE, 'generated'),
  },
}

const BUILTIN_ID = 'ronaldo'

// 内置 C罗 的"虚拟清单"：与 pet.json 结构一致，只是写在代码里
const BUILTIN_MANIFEST = {
  schema: 'dsh-pet/2',
  id: BUILTIN_ID,
  name: 'C罗',
  builtin: true,
  // desktopFile：原生桌面窗口走 WPF/WIC，默认不支持 WebP，所以额外给一份 PNG。
  // 网页仍用体积更小的 WebP。（用 `node scripts/build-assets.mjs` 重新生成）
  atlas: {
    file: 'assets/spritesheet.webp',
    desktopFile: 'assets/spritesheet.png',
    cols: 8, rows: 11, cellW: 192, cellH: 208,
  },
  states: {
    idle: { row: 0, frames: 6, fps: 6 },
    runRight: { row: 1, frames: 8, fps: 12 },
    runLeft: { row: 2, frames: 8, fps: 12 },
    waving: { row: 3, frames: 4, fps: 8 },
    jumping: { row: 4, frames: 5, fps: 10 },
    failed: { row: 5, frames: 8, fps: 12 },
    waiting: { row: 6, frames: 6, fps: 5 },
    running: { row: 7, frames: 6, fps: 12 },
    review: { row: 8, frames: 6, fps: 6 },
    look: { rows: [9, 10], frames: 8 },
  },
  behavior: 'look',
  size: 120,
  audio: { celebrate: { file: 'assets/siu.mp3', label: 'SIU 庆祝音' } },
  triggers: { celebrating: 'celebrate' },
  interactions: {},
  phrases: ['SIUUUUU! 🎉', '进球啦！⚽', '完美的终结！', 'Vamos!', '这就是 7 号！'],
  divePhrases: ['Penalty kick! ⚽', '给我点球！Penalty!', '点球！裁判！'],
  yaw: null,
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

// 播放命令 = ctx.shell 会直接执行的那段命令文本。
// Windows：ctx.shell 是 dsh-pwsh-sandbox（pwsh 执行器），它把命令文本当作
// PowerShell 代码执行，所以这里直接给 PowerShell 语句即可。⚠️ 不要再包一层
// powershell.exe -Command "…$m…"：外层 pwsh 会先把双引号里的 $m 插值吃掉，
// 内层脚本变成语法错误，表现为"有动作、没声音"的静默失败。
const playCommand = (path) => {
  if (typeof process !== 'undefined' && process.platform === 'win32') {
    const p = String(path).replace(/'/g, "''")
    return "Add-Type -AssemblyName presentationCore; $m = New-Object System.Windows.Media.MediaPlayer; $m.Open('" + p + "'); $m.Play(); Start-Sleep -Seconds 5; $m.Close()"
  }
  const quoted = JSON.stringify(String(path))
  if (typeof process !== 'undefined' && process.platform === 'darwin') return 'afplay ' + quoted
  return 'ffplay -nodisp -autoexit ' + quoted
}

// 桌面宠物进程的"启动诊断日志"。
// 为什么单独一条：插件里的 console.error 只会进 `dsh web` 的终端，用户看不到；
// 而"进程起来又瞬间没了"这种失败本来就没有任何可见痕迹。
const spawnLogPath = (registryPath) => join(dirname(registryPath), 'desktop-pet-spawn.log')
const spawnLog = (registryPath, line) => {
  try {
    appendFileSync(spawnLogPath(registryPath), `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch { /* 诊断日志写不进去也不能影响主流程 */ }
}

const MIME = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.glb': 'model/gltf-binary',
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
}

const mimeFor = (path) => MIME[extname(String(path)).toLowerCase()] || 'application/octet-stream'

/** 只读图片头部拿尺寸（PNG / WebP），用于注册前校验，不依赖任何第三方库。 */
function readImageHeader(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (b.length >= 33 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    if (b.toString('latin1', 12, 16) !== 'IHDR') return null
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), format: 'png' }
  }
  if (
    b.length >= 30 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    const fourcc = b.toString('latin1', 12, 16)
    if (fourcc === 'VP8X') {
      return {
        width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
        height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
        format: 'webp',
      }
    }
    if (fourcc === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, format: 'webp' }
    if (fourcc === 'VP8L') {
      const v = b.readUInt32LE(21)
      return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1, format: 'webp' }
    }
  }
  return null
}

/** 把相对路径安全解析到包目录内（防目录穿越）。 */
function resolveInPackage(packageDir, rel) {
  const root = resolve(packageDir)
  const abs = resolve(root, String(rel))
  const r = relative(root, abs)
  if (r.startsWith('..') || isAbsolute(r) || r.split(sep).includes('..')) {
    throw new Error(`路径越出宠物包目录：${rel}`)
  }
  return abs
}

const readBody = (req, cap = 2 * 1024 * 1024) => new Promise((resolvePromise, reject) => {
  const chunks = []
  let size = 0
  req.on('data', (c) => {
    size += c.length
    if (size > cap) { reject(new Error('request body too large')); req.destroy(); return }
    chunks.push(c)
  })
  req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf-8')))
  req.on('error', reject)
})

const sendJson = (res, status, body) => {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(data)),
    'Cache-Control': 'no-store',
  })
  res.end(data)
}

const sendBytes = (res, bytes, mime, cacheSeconds = 86400) => {
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': String(bytes.length),
    'Cache-Control': `public, max-age=${cacheSeconds}`,
  })
  res.end(bytes)
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const cfg = Object.assign({}, CONFIG, config || {})
  // gallery 是嵌套对象：调用方可能只传其中一两个键（比如只关掉联网），所以要单独合并
  cfg.gallery = Object.assign({}, CONFIG.gallery, (config && config.gallery) || {})
  cfg.video = Object.assign({}, CONFIG.video, (config && config.video) || {})
  const webServer = ctx.webServer

  const gallery = createGallery({
    config: cfg.gallery,
    log: (msg) => console.error('[ronaldo-pet/gallery] ' + msg),
  })

  // 优先使用 DSH 沙箱感知的 fs 服务（尊重用户工作区策略），缺失时退回 node:fs
  const fsService = typeof ctx.get === 'function' ? ctx.get('fs') : undefined
  const readMaybe = async (path, maxBytes = 30 * 1024 * 1024) => {
    if (fsService !== undefined && typeof fsService.resolve === 'function' && typeof fsService.readBytes === 'function') {
      const t = await fsService.resolve(path)
      return await fsService.readBytes(t, undefined, maxBytes)
    }
    return await readFile(path)
  }

  let disposed = false
  const routeDisposers = []
  const assetCache = new Map() // key -> { bytes, mime, at, size, mtimeMs }

  // ---------- 注册表 ----------
  // { version, revision, settings: { defaultPet, audioMode, systemSound }, pets: [entry] }
  //
  // 默认宠物（settings.defaultPet）的意义：**同一时间只开一只**。
  // 新注册或"设为默认"的宠物会显示，其它自动收起，避免生成几次之后
  // 右下角站了一排。想同时养多只，在设置里单独点 👁 把其它的打开即可
  // （手动打开过的会被标记 manualShow，之后不会再被自动收起）。
  let registry = {
    version: 1,
    revision: 0,
    settings: {
      defaultPet: BUILTIN_ID,
      audioMode: 'primary',
      systemSound: true,
      // 桌面窗口的尺寸（DIP）。故意和网页端的 size 分开：
      // 网页里 120px 是"页面里的一个小元素"，桌面上 120 DIP 在 200% 缩放下
      // 会变成 240 物理像素，看着就太大了。
      // 0 = 自动，让桌宠按素材原生分辨率决定（写实素材需要，见 clampDesktopSize）。
      desktopSize: 0,
      // 显示位置：auto = 桌面窗口在跑时网页不再显示同一只（避免重复出现）
      //          both = 两边都显示
      displayMode: 'auto',
    },
    pets: [],
  }

  const bump = () => { registry.revision = (registry.revision || 0) + 1 }

  /**
   * 桌面窗口尺寸的合法范围（DIP）。
   *
   * 0 = 自动：桌宠按素材单格的原生分辨率自行决定（见 DesktopPet.ps1 的
   * Get-NativeSize）。之所以要有"自动"，是因为合适尺寸完全取决于素材：
   * 192px 一格的像素风宠物该显示成 96 DIP，而 1024px 一格的写实素材显示成
   * 96 DIP 就成了一张看不清的小图。写死任何一个数字都会错一半。
   *
   * 上限 1024 只是防呆（别把宠物拉到比屏幕还大、拖出可视区），不是创作限制。
   */
  const clampDesktopSize = (v) => {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n) || n <= 0) return 0
    return Math.max(32, Math.min(1024, n))
  }

  /** 把某只设为默认：它显示，其它（非手动打开的）收起。 */
  const makeDefaultPet = (id) => {
    const target = registry.pets.find((p) => p.id === id)
    if (!target) return false
    for (const p of registry.pets) {
      if (p.id === id) { p.visible = true; continue }
      if (p.manualShow !== true) p.visible = false
    }
    registry.settings.defaultPet = id
    return true
  }

  const defaultEntry = () => ({
    id: BUILTIN_ID,
    builtin: true,
    dir: __dirname,
    name: BUILTIN_MANIFEST.name,
    size: 120,
    visible: true,
    behavior: 'look',
    pos: null,
    sound: true,
    addedAt: new Date().toISOString(),
  })

  const saveRegistry = async () => {
    try {
      await mkdir(dirname(cfg.registryPath), { recursive: true })
      await writeFile(cfg.registryPath, JSON.stringify(registry, null, 2), 'utf8')
    } catch (err) {
      console.error('[ronaldo-pet] 保存注册表失败：', err)
    }
  }

  const loadRegistry = async () => {
    let hadDefaultPet = false
    try {
      const text = await readFile(cfg.registryPath, 'utf8')
      const data = JSON.parse(text)
      if (data && Array.isArray(data.pets)) {
        hadDefaultPet = Boolean(data.settings && data.settings.defaultPet)
        registry = {
          version: 1,
          revision: data.revision || 0,
          settings: Object.assign({
            defaultPet: BUILTIN_ID,
            audioMode: 'primary',
            systemSound: true,
            desktopSize: 0,
            displayMode: 'auto',
          }, data.settings || {}),
          pets: data.pets.filter((p) => p && typeof p.id === 'string'),
        }
        registry.settings.desktopSize = clampDesktopSize(registry.settings.desktopSize)
        if (registry.settings.displayMode !== 'both') registry.settings.displayMode = 'auto'
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') console.error('[ronaldo-pet] 读取注册表失败：', err.message)
    }
    if (!registry.pets.some((p) => p.id === BUILTIN_ID)) {
      // 内置 C罗 永远可用；用户删掉就删掉，重启也不会强行加回来——
      // 用 settings.builtinRemoved 记住这个决定
      if (!registry.settings.builtinRemoved) registry.pets.unshift(defaultEntry())
    }

    // 收敛成"只开一只"：
    //   · defaultPet 无效/缺失 → 回退到内置 C罗（没有就取第一只）
    //   · 老注册表（没有 defaultPet 字段）之前所有宠物都是 visible=true，
    //     重启后会"站一排"，这里首次迁移成只留默认那只
    if (!registry.settings.defaultPet || !registry.pets.some((p) => p.id === registry.settings.defaultPet)) {
      registry.settings.defaultPet = registry.pets.some((p) => p.id === BUILTIN_ID)
        ? BUILTIN_ID
        : (registry.pets[0] ? registry.pets[0].id : null)
    }
    if (!hadDefaultPet) {
      for (const p of registry.pets) p.visible = (p.id === registry.settings.defaultPet)
      await saveRegistry()
    }

    bump()
  }

  // ---------- 宠物包清单解析与校验 ----------

  /** 读取某个注册项的清单（内置宠物走内置常量）。 */
  const manifestOf = async (entry) => {
    if (entry.builtin) return BUILTIN_MANIFEST
    const file = join(entry.dir, 'pet.json')
    const text = await readFile(file, 'utf8')
    return JSON.parse(text)
  }

  /**
   * 校验一份清单 + 素材。返回 { ok, errors, warnings, manifest }。
   * 这里是"图片不出乱码"的最后一道闸：图集尺寸必须严格匹配网格。
   */
  const validateManifest = async (dir, manifest) => {
    const errors = []
    const warnings = []
    if (!manifest || typeof manifest !== 'object') return { ok: false, errors: ['pet.json 不是合法对象'], warnings }
    const atlas = manifest.atlas || {}
    const cols = Number(atlas.cols)
    const rows = Number(atlas.rows)
    const cellW = Number(atlas.cellW)
    const cellH = Number(atlas.cellH)
    for (const [k, v] of [['cols', cols], ['rows', rows], ['cellW', cellW], ['cellH', cellH]]) {
      if (!Number.isInteger(v) || v <= 0) errors.push(`atlas.${k} 非法：${JSON.stringify(atlas[k])}`)
    }
    // 分辨率本身不设上限：作者可以画得很精细，甚至用写实素材，显示时等比缩放。
    // 但要有个体面的天花板 —— 单格 4096px 或整张图集 64M 像素以上时，解码加缩放
    // 会吃掉几百 MB 内存并让窗口卡住。这种情况宁可在这里报一句清楚的错，
    // 也不要让用户在桌面上看到一只卡死的宠物。
    //
    // 位置有意放在"读图集文件"之前：这是清单本身就能判断的事，不该因为更靠后的
    // "图集文件不存在"之类错误而永远报告不出来。
    const CELL_LIMIT = 4096
    const ATLAS_PIXEL_LIMIT = 64 * 1024 * 1024
    if (cellW > CELL_LIMIT || cellH > CELL_LIMIT) {
      errors.push(
        `单格尺寸 ${cellW}×${cellH} 超过上限 ${CELL_LIMIT}px。` +
        `分辨率不限，但单格建议不超过 ${CELL_LIMIT}px（写实素材 1024 上下已经足够精细）。`,
      )
    }
    const atlasPixels = cols * rows * cellW * cellH
    if (atlasPixels > ATLAS_PIXEL_LIMIT) {
      errors.push(
        `图集总像素 ${atlasPixels}（${cols}×${rows} 格 · ${cellW}×${cellH}px）超过上限 ${ATLAS_PIXEL_LIMIT}。` +
        `请降低单格分辨率，或减少列/行数（用不到的格子可以留空但也占像素）。`,
      )
    }
    if (errors.length) return { ok: false, errors, warnings }

    const atlasRel = atlas.file || 'atlas.png'
    let atlasAbs
    try {
      atlasAbs = resolveInPackage(dir, atlasRel)
    } catch (e) {
      return { ok: false, errors: [String(e.message)], warnings }
    }
    if (!existsSync(atlasAbs)) return { ok: false, errors: [`图集文件不存在：${atlasRel}`], warnings }

    const head = readImageHeader(await readFile(atlasAbs))
    if (!head) {
      return {
        ok: false,
        warnings,
        errors: [`图集不是可识别的 PNG/WebP（文件头不匹配，极可能编码被破坏）：${atlasRel}`],
      }
    }
    if (head.width !== cols * cellW || head.height !== rows * cellH) {
      return {
        ok: false,
        warnings,
        errors: [
          `图集尺寸与网格不符：实际 ${head.width}×${head.height}，按 ${cols}×${rows} 格 · ${cellW}×${cellH}px ` +
          `应为 ${cols * cellW}×${rows * cellH}。尺寸不符会导致取帧错位（看起来像乱码）。`,
        ],
      }
    }

    const states = manifest.states
    if (!states || typeof states !== 'object' || Object.keys(states).length === 0) {
      errors.push('缺少 states（客户端无法播放动画）')
    } else {
      for (const [key, st] of Object.entries(states)) {
        if (!st || typeof st !== 'object') { errors.push(`states.${key} 非法`); continue }
        const rowList = st.angles
          ? st.angles.map((a) => a && a.row)
          : st.rows ? (Array.isArray(st.rows) ? st.rows : [st.rows]) : st.row !== undefined ? [st.row] : null
        if (rowList === null) { errors.push(`states.${key} 缺少 row/rows/angles`); continue }
        for (const r of rowList) {
          if (!Number.isInteger(r) || r < 0 || r >= rows) errors.push(`states.${key} 行号 ${r} 超出 0..${rows - 1}`)
        }
        if (st.frames !== undefined && (!Number.isInteger(st.frames) || st.frames < 1 || st.frames > cols)) {
          errors.push(`states.${key} 帧数 ${st.frames} 超出 1..${cols}`)
        }
      }
      if (!states.idle) errors.push('states 缺少 idle（必须有兜底动画）')
    }

    // 音频：存在 + 头部像音频；缺文件只降级不报错
    const audioRel = {}
    for (const [key, item] of Object.entries(manifest.audio || {})) {
      const rel = typeof item === 'string' ? item : item && item.file
      if (!rel) { warnings.push(`audio.${key} 缺少 file，已忽略`); continue }
      let abs
      try {
        abs = resolveInPackage(dir, rel)
      } catch (e) {
        errors.push(`audio.${key}：${e.message}`)
        continue
      }
      if (!existsSync(abs)) { warnings.push(`audio.${key} 指向的文件不存在：${rel}（该音效将被禁用）`); continue }
      const st = await stat(abs)
      if (st.size < 64) { warnings.push(`audio.${key} 文件过小（${st.size} 字节），可能损坏`); continue }
      audioRel[key] = rel
    }

    return { ok: errors.length === 0, errors, warnings, atlasAbs, audioRel }
  }

  /** 注册项 + 清单 → 给客户端的视图（只含 URL 和元数据，不含二进制）。 */
  const viewOf = async (entry) => {
    let manifest
    try {
      manifest = await manifestOf(entry)
    } catch (err) {
      return {
        id: entry.id,
        name: entry.name || entry.id,
        broken: true,
        error: `清单读取失败：${err.message}`,
        dir: entry.dir,
      }
    }
    const atlas = manifest.atlas || {}
    const base = '/ronaldo-pet/asset/' + encodeURIComponent(entry.id)
    const assetUrl = (rel) => base + '/' + String(rel).split('/').map(encodeURIComponent).join('/')
    const audio = {}
    for (const [key, item] of Object.entries(manifest.audio || {})) {
      const rel = typeof item === 'string' ? item : item && item.file
      if (!rel) continue
      audio[key] = {
        url: assetUrl(rel),
        label: (item && item.label) || key,
      }
    }
    return {
      id: entry.id,
      name: entry.name || manifest.name || entry.id,
      size: entry.size ?? manifest.size ?? 120,
      visible: entry.visible !== false,
      behavior: entry.behavior || manifest.behavior || 'idle',
      pos: entry.pos || null,
      sound: entry.sound !== false,
      builtin: entry.builtin === true,
      dir: entry.dir,
      sheet: {
        url: assetUrl(atlas.file || 'atlas.png'),
        // 原生窗口用：优先 PNG（WPF 不一定能解 WebP），没有就退回同一个 URL
        desktopUrl: assetUrl(atlas.desktopFile || atlas.file || 'atlas.png'),
        desktopFormat: atlas.desktopFile ? extname(String(atlas.desktopFile)).slice(1).toLowerCase() : extname(String(atlas.file || 'atlas.png')).slice(1).toLowerCase(),
        cols: atlas.cols, rows: atlas.rows, cellW: atlas.cellW, cellH: atlas.cellH,
      },
      states: manifest.states || {},
      yaw: manifest.yaw || null,
      audio,
      triggers: manifest.triggers || {},
      interactions: manifest.interactions || {},
      phrases: manifest.phrases || [],
      divePhrases: manifest.divePhrases || [],
      source: manifest.source || null,
      // 来源溯源：从社区画廊装的宠物会带 origin（key/repoUrl/协议/作者），
      // 界面上据此显示「社区」徽章与「去仓库看看」入口
      origin: entry.origin || null,
      sharing: manifest.sharing || null,
    }
  }

  const allViews = async () => {
    const out = []
    for (const entry of registry.pets) out.push(await viewOf(entry))
    return out
  }

  // ---------- 注册（/pets/register 与 /gallery/install 共用一条路径） ----------

  /**
   * 把一份已落盘的宠物包注册进注册表。**注册即校验**：
   * 图集尺寸必须严格匹配网格，不合格直接拒绝（这是"图片不出乱码"的最后一道闸）。
   *
   * @returns {Promise<{status:number, body:object}>}
   */
  const registerPackage = async (args = {}) => {
    const dir = resolve(String(args.dir || '').trim())
    if (!dir) return { status: 400, body: { ok: false, error: '缺少 dir（宠物包目录）' } }
    if (!existsSync(join(dir, 'pet.json'))) {
      return { status: 400, body: { ok: false, error: `该目录下没有 pet.json：${dir}` } }
    }
    let manifest
    try {
      manifest = JSON.parse(await readFile(join(dir, 'pet.json'), 'utf8'))
    } catch (err) {
      return { status: 400, body: { ok: false, error: `pet.json 解析失败：${err.message}` } }
    }
    const v = await validateManifest(dir, manifest)
    if (!v.ok) {
      return {
        status: 422,
        body: {
          ok: false,
          error: '宠物包未通过校验，已拒绝注册（避免把坏素材灌进界面）',
          errors: v.errors,
          warnings: v.warnings,
        },
      }
    }
    const id = String(args.id || manifest.id || '').trim()
    if (!id) return { status: 400, body: { ok: false, error: '宠物包缺少 id' } }
    const existing = registry.pets.find((p) => p.id === id)
    const entry = {
      id,
      dir,
      name: String(args.rename || manifest.name || id),
      size: Number(args.size) || manifest.size || 120,
      visible: true,
      behavior: args.behavior || manifest.behavior || 'idle',
      pos: (existing && existing.pos) || null,
      sound: args.sound !== false,
      manualShow: false,
      addedAt: (existing && existing.addedAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      origin: args.origin || (existing && existing.origin) || null,
    }
    // ⚠️ 必须拿"注册表里真正那条记录"来改可见性：
    //    重新注册时 Object.assign(existing, entry) 改的是 existing，
    //    而 entry 是另一个对象，改 entry.visible 不会生效。
    const stored = existing || entry
    if (existing) Object.assign(existing, entry)
    else registry.pets.push(entry)

    // 刚生成/刚注册的宠物默认接管为"默认打开的"，其它收起——
    // 否则生成几次之后右下角就站了一排。
    // 想只注册不上场：`forge install --no-focus`，或传 focus:false。
    if (args.focus !== false) {
      makeDefaultPet(id)
    } else {
      stored.visible = false
      stored.manualShow = false
    }

    bump()
    await saveRegistry()
    return {
      status: 200,
      body: {
        ok: true,
        id,
        replaced: Boolean(existing),
        focused: args.focus !== false,
        warnings: v.warnings,
        pet: await viewOf(stored),
        total: registry.pets.length,
        defaultPet: registry.settings.defaultPet,
      },
    }
  }

  // ---------- 工作区 / 对话信息（供桌面宠物悬停提示） ----------
  // 数据来源是 DSH 自己的两个服务：
  //   ctx.workspaceRegistry.list() → [{ id, title, path, sessionIds }]
  //   ctx.sessionTitle.get(agent.session)?.title → 对话标题
  // 两个都可能不存在（不同 profile 组合），所以一律容错，取不到就显示"未命名"。
  let convCache = { at: 0, value: null }

  const collectConversations = () => {
    const now = Date.now()
    if (convCache.value !== null && now - convCache.at < 700) return convCache.value

    const agentsSvc = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    const titleSvc = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined
    const wsSvc = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined

    let agents = []
    try { agents = agentsSvc && typeof agentsSvc.list === 'function' ? agentsSvc.list() : [] } catch { agents = [] }
    if (!Array.isArray(agents)) agents = []

    let workspaces = []
    try { workspaces = wsSvc && typeof wsSvc.list === 'function' ? wsSvc.list() : [] } catch { workspaces = [] }
    if (!Array.isArray(workspaces)) workspaces = []

    const bySession = new Map()
    for (const w of workspaces) {
      for (const sid of (w && w.sessionIds) || []) {
        bySession.set(String(sid), { id: String(w.id || ''), title: String(w.title || ''), path: String(w.path || '') })
      }
    }

    const list = []
    for (const agent of agents) {
      if (!agent) continue
      let title = null
      let titleAt = 0
      try {
        const snap = titleSvc && typeof titleSvc.get === 'function' ? titleSvc.get(agent.session) : undefined
        if (snap && typeof snap.title === 'string') { title = snap.title; titleAt = Number(snap.updatedAt) || 0 }
      } catch { /* 标题服务不可用 */ }
      const id = String(agent.id || '')
      list.push({
        id,
        title: title || '',
        titleAt,
        workspace: bySession.get(id) || null,
        status: agent.status === 'running' ? 'running' : 'idle',
      })
    }
    // 正在跑的排前面；同组内按标题新鲜度
    list.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'running' ? -1 : 1
      return (b.titleAt || 0) - (a.titleAt || 0)
    })

    const running = list.filter((c) => c.status === 'running')
    const active = running[0] || list[0] || null
    const value = { list, runningCount: running.length, active }
    convCache = { at: now, value }
    return value
  }

  // ---------- 音效播放 ----------

  const playFile = (absPath) => {
    const shell = typeof ctx.get === 'function' ? ctx.get('shell') : undefined
    if (shell === undefined || !absPath) return false
    try {
      const sp = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined
      const sandboxPolicy = sp !== undefined ? sp.resolve({ mode: 'danger-full-access' }) : { mode: 'danger-full-access', workspaceRoot: '' }
      const spec = shell.resolve({ command: playCommand(absPath), sandboxPolicy })
      shell.run(spec).catch((err) => console.error('[ronaldo-pet] 音效播放失败：', err))
      return true
    } catch (err) {
      console.error('[ronaldo-pet] 无法启动音效播放：', err)
      return false
    }
  }

  /** 按事件名播放对应音效（audioMode=primary 时只播第一只，避免多宠物齐鸣）。 */
  const playEvent = async (eventName) => {
    if (registry.settings.systemSound === false) return
    const mode = registry.settings.audioMode || 'primary'
    for (const entry of registry.pets) {
      if (entry.visible === false || entry.sound === false) continue
      let manifest
      try { manifest = await manifestOf(entry) } catch { continue }
      const triggers = manifest.triggers || {}
      const key = triggers[eventName]
      if (!key) continue
      const item = (manifest.audio || {})[key]
      const rel = typeof item === 'string' ? item : item && item.file
      if (!rel) continue
      let abs
      try { abs = resolveInPackage(entry.dir, rel) } catch { continue }
      if (!existsSync(abs)) continue
      playFile(abs)
      if (mode === 'primary') return
    }
  }

  // ---------- 状态机 ----------
  let mode = 'idle'
  let seq = 0
  let celebrating = false
  let celebrateTimer = null
  let failTimer = null
  let toolsInFlight = 0
  let recentTool = false
  let recentToolTimer = null
  let waitingCount = 0
  let lastWaiting = 0

  const turnFlags = new WeakMap()
  const lastStatus = new WeakMap()
  const observedAgents = new Set()

  const flagsOf = (agent) => {
    let f = turnFlags.get(agent)
    if (f === undefined) { f = { worked: false, errored: false }; turnFlags.set(agent, f) }
    return f
  }
  const lastStatusEntries = () => {
    const out = []
    for (const agent of observedAgents) {
      const s = lastStatus.get(agent)
      if (s !== undefined) out.push([agent, s])
    }
    return out
  }
  const currentRunningCount = () => {
    let n = 0
    for (const e of lastStatusEntries()) if (e[1] === 'running') n++
    return n
  }
  const setMode = (next) => {
    if (next === mode) return
    if (celebrating && next !== 'celebrating') return
    mode = next
    seq++
  }
  const deriveMode = (runningCount) => {
    if (celebrating) return
    let next
    if (waitingCount > 0) next = 'waiting'
    else if (runningCount > 0) next = (toolsInFlight > 0 || recentTool) ? 'working' : 'review'
    else next = 'idle'
    if (next === 'waiting' && lastWaiting === 0) playEvent('waiting')
    lastWaiting = waitingCount
    setMode(next)
  }

  const celebrate = () => {
    celebrating = true
    if (celebrateTimer) celebrateTimer()
    setMode('celebrating')
    playEvent('celebrating')
    celebrateTimer = ctx.timeout(() => {
      celebrateTimer = null
      celebrating = false
      deriveMode(currentRunningCount())
    }, cfg.celebrateMs)
  }

  const showFailed = () => {
    if (celebrating) return
    setMode('failed')
    playEvent('failed')
    if (failTimer) failTimer()
    failTimer = ctx.timeout(() => { failTimer = null; deriveMode(currentRunningCount()) }, cfg.failedMs)
  }

  const markToolSettled = (wasQuestion) => {
    toolsInFlight = Math.max(0, toolsInFlight - 1)
    if (wasQuestion) waitingCount = Math.max(0, waitingCount - 1)
    if (toolsInFlight === 0) {
      if (recentToolTimer) recentToolTimer()
      recentToolTimer = ctx.timeout(() => { recentToolTimer = null; recentTool = false; deriveMode(currentRunningCount()) }, 2500)
    }
    deriveMode(currentRunningCount())
  }

  // ---------- HTTP 路由 ----------

  // ---------- 原生桌面宠物进程管理 ----------
  // 为什么要由宿主来拉起：需求是"终端一开始运行，桌宠立马出现"。
  // 插件随 profile 启动而加载，所以在 apply() 里 spawn 一个 WPF 窗口进程最自然。
  // 进程是 detached 的（网页关掉它也不受影响）；它自己会轮询宿主，
  // 宿主进程消失后自动退出，因此"关掉终端 = 桌宠消失"。
  const desktop = { proc: null, pid: null, startedAt: 0, lastError: null, stops: 0, args: null, launchGuardUntil: 0 }

  const desktopBase = () => {
    const host = webServer.host === '0.0.0.0' || !webServer.host ? '127.0.0.1' : webServer.host
    const port = typeof webServer.port === 'number' ? webServer.port : 0
    return port > 0 ? `http://${host}:${port}` : null
  }

  const desktopStatus = () => ({
    enabled: cfg.desktopPet !== false,
    running: desktopRunning(),
    pid: desktop.pid,
    startedAt: desktop.startedAt || null,
    uptimeMs: desktop.startedAt ? Date.now() - desktop.startedAt : 0,
    base: desktopBase(),
    script: cfg.desktopScript,
    scriptExists: existsSync(cfg.desktopScript),
    log: cfg.desktopLog,
    spawnLog: spawnLogPath(cfg.registryPath),
    args: desktop.args,
    method: desktop.method || null,
    attempts: desktop.attempts || 0,
    size: registry.settings.desktopSize,
    displayMode: registry.settings.displayMode,
    lastError: desktop.lastError,
    // 最近一次子进程的结局 —— "起来了又瞬间没了"的唯一可见线索
    lastExit: desktop.lastExit || null,
    lastStderr: desktop.lastStderr || null,
    platform: process.platform,
    supported: process.platform === 'win32',
  })

  /**
   * 桌宠是不是真的还在跑。
   *
   * ⚠️ 只按 ChildProcess 判断会出一个很坑的假死状态：shell 启动方式结束后，
   *    verifyShellLaunch() 会塞一个**假的 proc 存根**
   *    （exitCode 永远是 null、killed 永远是 false），只是为了给别处一个对象看。
   *    假存根永远不会"退出"，于是只要用 shell 方式成功启动过一次，宿主就永久
   *    认为桌宠还开着：
   *      - 用户从右键菜单退出、或在任务管理器里结束它，宿主都不会再拉起；
   *      - 网页端因为 displayMode:'auto' 判定 desktopRunning=true，把网页那一份
   *        也藏起来 —— 结果两边都看不到宠物。
   *    desktop.pid 无论哪条路径记录的都是真实 powershell 的 pid，
   *    所以判定一律以 pid 为准，proc 只在没有 pid 时兜底。
   */
  const desktopRunning = () => {
    if (desktop.pid) return isAlive(desktop.pid)
    if (desktop.proc && desktop.proc.exitCode === null && desktop.proc.killed !== true) return true
    return false
  }

  /**
   * 启动桌面宠物。
   *
   * ⚠️⚠️ 这里踩过一个非常隐蔽的坑，务必看完再改：
   *
   *   `child_process.spawn('powershell.exe', args, { detached: true })`
   *   会让 PowerShell **以退出码 0、在 ~200ms 内干净退出，且完全不执行脚本**
   *   （连第一行日志都写不出来，stderr 也是空的）。看起来像"进程起来了又没了"，
   *   但其实是根本没跑。`scripts/detached-probe.mjs` 里能一行行复现：
   *
   *     裸 spawn            → ✅ 存活，日志正常
   *     + cwd               → ✅ 存活
   *     + detached:true     → ❌ 208ms 退出 code=0
   *     + detached+windowsHide → ❌ 88ms 退出 code=0
   *
   *   根因：Windows 下 detached 会给子进程一个**没有控制台**的环境，
   *   而 powershell.exe 是控制台程序，没有控制台就直接退出。
   *   而 `windowsHide`（= CREATE_NO_WINDOW）更早就会让 powershell 以
   *   0xC0000142 (STATUS_DLL_INIT_FAILED) 挂掉。
   *
   *   所以：**不要 detached，也不要 windowsHide**。
   *   Windows 上子进程本来就不会随父进程退出，宿主要"关掉网页也不受影响"
   *   并不需要 detached；而"关掉终端就一起走"正是我们想要的行为
   *   （桌宠自己还有轮询宿主的看门狗兜底）。
   *
   *   需要真正脱离终端的场景，用第 1 招：交给 DSH 的 shell 跑 `Start-Process`
   *   —— Start-Process 才是 Windows 上正规的"另起一个独立进程"的方式。
   */
  const desktopLaunchMethods = [
    // 1) 交给宿主 shell 跑 Start-Process：真正独立的新进程，能脱离终端
    { id: 'shell-start-process', kind: 'shell' },
    // 2) 直接 spawn，共享父进程控制台（不 detached，所以不会多出窗口）
    { id: 'spawn-shared', kind: 'spawn', hidden: false },
    // 3) 同上，但显式隐藏窗口（某些环境需要）
    { id: 'spawn-hidden', kind: 'spawn', hidden: true },
    // 4) 万不得已才 detached（已知在部分 Windows 上会让 powershell 直接退出）
    { id: 'spawn-detached', kind: 'spawn', detached: true, hidden: true },
  ]

  const desktopArgs = (method, base, opts) => {
    const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass']
    if (method.hidden === true) args.push('-WindowStyle', 'Hidden')
    args.push('-File', cfg.desktopScript, '-Base', base, '-HostPid', String(process.pid), '-Log', cfg.desktopLog)
    if (opts.petId) args.push('-PetId', String(opts.petId))
    // 尺寸以宿主设置为准；0（自动）时不传 -Size，由桌宠按素材原生分辨率决定
    const size = clampDesktopSize(opts.size || registry.settings.desktopSize)
    if (size > 0) args.push('-Size', String(size))
    return args
  }

  /** 方式 A：交给宿主 shell 跑 Start-Process（不阻塞，立即返回）。 */
  const desktopPidFile = () => join(dirname(cfg.registryPath), 'desktop-pet.pid')

  const launchViaShell = (method, base, opts) => {
    const shell = typeof ctx.get === 'function' ? ctx.get('shell') : undefined
    if (shell === undefined || typeof shell.resolve !== 'function' || typeof shell.run !== 'function') {
      spawnLog(cfg.registryPath, 'launch[shell-start-process] shell 服务不可用，跳过')
      return false
    }
    const args = desktopArgs(method, base, opts)
    const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"
    const argList = args.map(q).join(',')
    const pidFile = q(desktopPidFile())
    try { rmSync(desktopPidFile(), { force: true }) } catch { /* 无所谓 */ }

    // Start-Process 不带 -Wait：把进程交出去就返回，shell.run 立刻结算。
    // 新进程的 pid 写到一个单独的小文件里，比从日志里正则抠可靠。
    const command = [
      `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @(${argList}) -PassThru`,
      `if ($p) { Set-Content -LiteralPath ${pidFile} -Value $p.Id -Encoding ASCII }`,
    ].join('; ')

    spawnLog(cfg.registryPath, `launch[shell-start-process] base=${base}`)
    spawnLog(cfg.registryPath, `  cmd: ${command}`)
    try {
      const sp = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined
      const sandboxPolicy = sp !== undefined && typeof sp.resolve === 'function'
        ? sp.resolve({ mode: 'danger-full-access' })
        : { mode: 'danger-full-access', workspaceRoot: '' }
      const spec = shell.resolve({ command, sandboxPolicy })
      Promise.resolve(shell.run(spec)).then(
        (r) => spawnLog(cfg.registryPath, `  shell.run 结算 ${r && r.exitCode !== undefined ? 'exit=' + r.exitCode : ''}`),
        (err) => spawnLog(cfg.registryPath, `  shell.run 失败: ${err && err.message ? err.message : err}`),
      )
    } catch (err) {
      spawnLog(cfg.registryPath, `  shell.run 抛出: ${err && err.message ? err.message : err}`)
      return false
    }
    // shell 方式拿不到 ChildProcess，用 pid 文件来判定成功（2.5 秒后核对）
    desktop.proc = null
    desktop.pid = null
    desktop.startedAt = Date.now()
    desktop.args = args.slice(args.indexOf('-File') + 2).join(' ')
    desktop.lastError = null
    setTimeout(() => verifyShellLaunch(), 2500)
    return true
  }

  /** 核对 shell 方式有没有真的把进程拉起来；没起来就换下一招。 */
  const verifyShellLaunch = () => {
    let pid = 0
    try { pid = Number(String(readFileSync(desktopPidFile(), 'utf8')).trim()) || 0 } catch { pid = 0 }
    const alive = isAlive(pid)
    spawnLog(cfg.registryPath, `  shell 方式核对: pid=${pid} alive=${alive}`)
    if (pid && alive) {
      desktop.pid = pid
      desktop.proc = { pid, exitCode: null, killed: false, unref() {}, kill() {} }
      desktop.method = 'shell-start-process'
      desktop.lastExit = null
      return
    }
    if (desktop.stops > 0) return
    spawnLog(cfg.registryPath, '  shell 方式没拉起来，换招重试')
    desktop.startedAt = 0
    desktop.lastError = null
    startDesktopPet({ force: true, _methodIndex: 1 })
  }

  /** 方式 B：child_process.spawn（**不 detached、不 windowsHide**，见上方长注释）。 */
  const launchViaSpawn = (method, base, opts) => {
    const args = desktopArgs(method, base, opts)
    spawnLog(cfg.registryPath, `launch[${method.id}] detached=${method.detached === true} hidden=${method.hidden === true} pid(parent)=${process.pid} base=${base}`)
    spawnLog(cfg.registryPath, `  cmd: powershell.exe ${args.join(' ')}`)

    // 只接管 stderr（诊断用）；stdout/stdin 忽略，避免多余管道。
    const proc = spawn('powershell.exe', args, {
      detached: method.detached === true,   // 仅在最后一招才为 true
      stdio: ['ignore', 'ignore', 'pipe'],
      cwd: __dirname,
    })
    let stderr = ''
    if (proc.stderr) {
      proc.stderr.on('data', (c) => { if (stderr.length < 4000) stderr += String(c) })
      proc.stderr.on('error', () => {})
    }

    const spawnedAt = Date.now()
    proc.on('error', (err) => {
      desktop.lastError = `启动桌面宠物失败：${err.message}`
      spawnLog(cfg.registryPath, `  spawn error: ${err.message}`)
    })
    proc.on('exit', (code, signal) => {
      const lived = Date.now() - spawnedAt
      const err = stderr.trim()
      desktop.lastExit = { code, signal, livedMs: lived, method: method.id, at: new Date().toISOString() }
      if (err) desktop.lastStderr = err.slice(0, 1200)
      spawnLog(cfg.registryPath, `  exit code=${code} signal=${signal} lived=${lived}ms stderr=${err ? err.slice(0, 500) : '(空)'}`)
      desktop.proc = null
      desktop.pid = null
      desktop.startedAt = 0

      if (lived < 4000) {
        const next = desktopLaunchMethods.findIndex((m) => m.id === method.id) + 1
        if (next < desktopLaunchMethods.length && desktop.stops === 0) {
          spawnLog(cfg.registryPath, `  存活过短，换招重试：${desktopLaunchMethods[next].id}`)
          desktop.lastError = null
          setTimeout(() => startDesktopPet({ ...opts, force: true, _methodIndex: next }), 800)
          return
        }
        desktop.lastError =
          `桌面宠物进程起来后 ${lived}ms 就退出了（code=${code}）。所有启动方式都失败，` +
          `请把 ${spawnLogPath(cfg.registryPath)} 发给开发者。`
      }
    })

    // 撑过 3 秒说明确实跑起来了：解除所有引用，别让子进程拖住 dsh web 的退出。
    // （stderr 是一条真实管道，会阻止事件循环结束）
    const releaseTimer = setTimeout(() => {
      if (desktop.proc !== proc) return
      try { if (proc.stderr && typeof proc.stderr.unref === 'function') proc.stderr.unref() } catch { /* ignore */ }
      try { proc.unref() } catch { /* ignore */ }
    }, 3000)
    if (typeof releaseTimer.unref === 'function') releaseTimer.unref()

    if (method.detached === true) proc.unref()
    desktop.proc = proc
    desktop.pid = proc.pid
    desktop.startedAt = Date.now()
    desktop.args = args.slice(args.indexOf('-File') + 2).join(' ')
    desktop.lastError = null
    spawnLog(cfg.registryPath, `  spawned pid=${proc.pid}`)
    return true
  }

  const startDesktopPet = (opts = {}) => {
    if (process.platform !== 'win32') {
      return { ok: false, error: '桌面宠物目前只实现了 Windows（WPF）版本' }
    }
    if (typeof opts.enabled === 'boolean') {
      cfg.desktopPet = opts.enabled
      if (!opts.enabled) { const r = stopDesktopPet(); return { ok: true, enabled: false, stopped: r } }
    }
    if (cfg.desktopPet === false && opts.force !== true) {
      return { ok: false, error: '桌面宠物已在配置里禁用（config.desktopPet = false）' }
    }
    // 防重复拉起。
    //
    // 网页端在很短时间内会连着发两次 start（页面加载时自动拉起一次、用户又点一次
    // "启动"），而上一次拉起来的进程要到几秒后才登记进 desktop.pid。中间这段空窗
    // 里 desktopRunning() 还是 false，于是又拉一只出来 —— 桌面上就叠了两三只桌宠
    // （真的见过三只 "DSH Pet" 窗口叠在一起）。
    //
    // 所以：刚刚发起过一次启动、而且还没确认成功时，直接忽略重复请求。内部换招重试
    // 带 _methodIndex，不受影响；用户显式点"重启"（restart）也不受影响。
    if (opts.restart !== true && opts._methodIndex === undefined &&
      desktop.launchGuardUntil > Date.now() && !desktopRunning()) {
      spawnLog(cfg.registryPath, '  刚刚已经发起过一次启动，忽略这次重复请求（防止叠出第二只）')
      return { ok: true, launching: true, ...desktopStatus() }
    }

    // 走同一个判定（别在这里重写一遍 proc 检查，否则假存根会让"已启动"永远为真）
    const already = desktopRunning()
    if (already && opts.restart !== true) {
      return { ok: true, alreadyRunning: true, ...desktopStatus() }
    }
    if (already && opts.restart === true) stopDesktopPet()

    if (!existsSync(cfg.desktopScript)) {
      desktop.lastError = `缺少桌面宠物脚本：${cfg.desktopScript}`
      return { ok: false, error: desktop.lastError }
    }
    const base = desktopBase()
    if (!base) {
      desktop.lastError = 'webServer 还没监听端口，无法把地址传给桌面宠物'
      return { ok: false, error: desktop.lastError }
    }

    const startIndex = Math.min(Number(opts._methodIndex) || 0, desktopLaunchMethods.length - 1)
    const method = desktopLaunchMethods[startIndex]
    // 只有"用户明确要求启动"才清掉停止标记；换招重试传了 _methodIndex，
    // 那是同一次请求的延续，不该被当成新的启动意图。
    // （之前这里忘了清，导致 stop 过一次之后换招重试被永久禁用，
    //   表现就是"点了启动没反应"。）
    if (opts._methodIndex === undefined) {
      desktop.stops = 0
      // 一次"新的启动意图"开始，接下来 8 秒内不再接受重复的 start
      // （进程登记进 desktop.pid 之前 desktopRunning() 一直是 false）
      desktop.launchGuardUntil = Date.now() + 8000
    }
    desktop.attempts = startIndex + 1
    desktop.method = method.id
    desktop.lastExit = null
    desktop.lastStderr = null

    try {
      const ok = method.kind === 'shell'
        ? launchViaShell(method, base, opts)
        : launchViaSpawn(method, base, opts)
      if (!ok) {
        // 该方式不可用，直接换下一招
        const next = startIndex + 1
        if (next < desktopLaunchMethods.length) {
          desktop.attempts = next + 1
          return startDesktopPet({ ...opts, force: true, _methodIndex: next })
        }
        return { ok: false, error: desktop.lastError || '所有启动方式都不可用' }
      }
      return { ok: true, ...desktopStatus() }
    } catch (err) {
      desktop.lastError = String(err && err.message || err)
      spawnLog(cfg.registryPath, `  throw: ${desktop.lastError}`)
      return { ok: false, error: desktop.lastError }
    }
  }

  const isAlive = (pid) => {
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch { return false }
  }

  const stopDesktopPet = () => {
    const pid = desktop.pid
    if (!desktop.proc && !pid) return { ok: true, alreadyStopped: true }
    try {
      desktop.stops++
      // shell 方式拿不到 ChildProcess，所以停的时候统一走 taskkill（连整棵进程树）
      if (typeof desktop.proc?.kill === 'function' && desktop.proc.exitCode === null) {
        try { desktop.proc.kill() } catch { /* 可能已经退了 */ }
      }
      if (process.platform === 'win32' && pid) {
        try {
          const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
          killer.on('error', () => {})
          killer.unref()
        } catch { /* 进程可能已经退了 */ }
      }
      spawnLog(cfg.registryPath, `stop pid=${pid || '(unknown)'}`)
    } catch (err) {
      console.error('[ronaldo-pet] 停止桌面宠物失败：', err)
    }
    desktop.proc = null
    desktop.pid = null
    desktop.startedAt = 0
    // 停掉之后立刻允许再启动（否则"停 → 马上启动"会被防重复的守卫挡掉）
    desktop.launchGuardUntil = 0
    return { ok: true, killedPid: pid || null }
  }

  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/state',
    handler: (req, res) => {
      const conv = collectConversations()
      sendJson(res, 200, {
        mode,
        seq,
        revision: registry.revision,
        petCount: registry.pets.length,
        settings: registry.settings,
        // 桌面宠物悬停提示要用：当前工作区 + 对话
        conversations: conv.list.slice(0, 12),
        runningCount: conv.runningCount,
        active: conv.active,
        desktop: { running: desktopRunning(), pid: desktop.pid, size: registry.settings.desktopSize },
        webUrl: desktopBase(),
      })
    },
  }))

  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/desktop',
    handler: async (req, res) => {
      try {
        const args = JSON.parse(await readBody(req) || '{}')
        const action = String(args.action || 'status')
        if (action === 'status') return sendJson(res, 200, { ok: true, ...desktopStatus() })
        if (action === 'start') return sendJson(res, 200, startDesktopPet({ petId: args.petId, size: args.size, force: true, restart: args.restart === true }))
        if (action === 'stop') return sendJson(res, 200, { ok: true, ...stopDesktopPet() })
        if (action === 'enable') {
          cfg.desktopPet = args.enabled !== false
          if (!cfg.desktopPet) stopDesktopPet()
          return sendJson(res, 200, { ok: true, ...desktopStatus() })
        }
        return sendJson(res, 400, { ok: false, error: `未知 action：${action}（可用 status/start/stop/enable）` })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err && err.message || err) })
      }
    },
  }))

  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/pets',
    handler: async (req, res) => {
      try {
        sendJson(res, 200, { ok: true, revision: registry.revision, settings: registry.settings, pets: await allViews() })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err && err.message || err) })
      }
    },
  }))

  // 素材直出：/ronaldo-pet/asset/<id>/<包内相对路径>
  routeDisposers.push(webServer.register({
    kind: 'prefix',
    path: '/ronaldo-pet/asset',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const rest = url.pathname.slice('/ronaldo-pet/asset/'.length)
        const slash = rest.indexOf('/')
        if (slash < 0) return sendJson(res, 400, { ok: false, error: '缺少素材相对路径' })
        const id = decodeURIComponent(rest.slice(0, slash))
        const rel = rest.slice(slash + 1).split('/').map(decodeURIComponent).join('/')
        const entry = registry.pets.find((p) => p.id === id)
        if (!entry) return sendJson(res, 404, { ok: false, error: `未注册的宠物：${id}` })
        let abs
        try {
          abs = resolveInPackage(entry.dir, rel)
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: String(e.message) })
        }
        if (!existsSync(abs)) return sendJson(res, 404, { ok: false, error: `素材不存在：${rel}` })
        const st = await stat(abs)
        const cacheKey = id + '|' + rel
        let hit = assetCache.get(cacheKey)
        if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
          hit = { bytes: await readFile(abs), mime: mimeFor(rel), mtimeMs: st.mtimeMs, size: st.size }
          assetCache.set(cacheKey, hit)
        }
        sendBytes(res, hit.bytes, hit.mime, 86400)
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err && err.message || err) })
      }
    },
  }))

  // 注册宠物包
  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/pets/register',
    handler: async (req, res) => {
      try {
        const args = JSON.parse(await readBody(req) || '{}')
        const { status, body } = await registerPackage(args)
        sendJson(res, status, body)
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err && err.message || err) })
      }
    },
  }))

  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/pets/unregister',
    handler: async (req, res) => {
      try {
        const args = JSON.parse(await readBody(req) || '{}')
        const id = String(args.id || '')
        const idx = registry.pets.findIndex((p) => p.id === id)
        if (idx < 0) return sendJson(res, 404, { ok: false, error: `未注册的宠物：${id}` })
        const removed = registry.pets[idx]
        if (removed.builtin) registry.settings.builtinRemoved = true
        registry.pets.splice(idx, 1)
        bump()
        await saveRegistry()
        sendJson(res, 200, { ok: true, id, total: registry.pets.length })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err && err.message || err) })
      }
    },
  }))

  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/pets/update',
    handler: async (req, res) => {
      try {
        const args = JSON.parse(await readBody(req) || '{}')
        const id = String(args.id || '')
        const entry = registry.pets.find((p) => p.id === id)
        if (!entry) return sendJson(res, 404, { ok: false, error: `未注册的宠物：${id}` })
        const patch = args.patch || {}
        // makeDefault：设为"默认打开的宠物"，其它自动收起
        if (patch.makeDefault === true) {
          makeDefaultPet(id)
          bump()
          await saveRegistry()
          return sendJson(res, 200, { ok: true, pet: await viewOf(entry), defaultPet: registry.settings.defaultPet, total: registry.pets.length })
        }
        if (typeof patch.name === 'string' && patch.name.trim()) entry.name = patch.name.trim().slice(0, 40)
        if (patch.size !== undefined) entry.size = Math.max(40, Math.min(400, Number(patch.size) || 120))
        if (patch.visible !== undefined) {
          entry.visible = patch.visible !== false
          // 记住"用户手动开过"，之后切默认宠物时不再被自动收起
          entry.manualShow = entry.visible
        }
        if (typeof patch.behavior === 'string') entry.behavior = patch.behavior
        if (patch.sound !== undefined) entry.sound = patch.sound !== false
        if (patch.pos === null) entry.pos = null
        else if (patch.pos && typeof patch.pos === 'object') {
          entry.pos = { left: Math.round(Number(patch.pos.left) || 0), top: Math.round(Number(patch.pos.top) || 0) }
        }
        bump()
        await saveRegistry()
        sendJson(res, 200, { ok: true, pet: await viewOf(entry), defaultPet: registry.settings.defaultPet })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err && err.message || err) })
      }
    },
  }))

  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/settings',
    handler: async (req, res) => {
      try {
        const args = JSON.parse(await readBody(req) || '{}')
        if (args.patch && typeof args.patch === 'object') {
          if (args.patch.audioMode === 'primary' || args.patch.audioMode === 'all') registry.settings.audioMode = args.patch.audioMode
          if (args.patch.systemSound !== undefined) registry.settings.systemSound = args.patch.systemSound !== false
          if (args.patch.displayMode === 'auto' || args.patch.displayMode === 'both') registry.settings.displayMode = args.patch.displayMode
          if (args.patch.desktopSize !== undefined) {
            // 只存值，**不重启**桌面窗口：它会自己从 /pets 轮询到这个值并立刻应用。
            // （重启会打断用户正在滚轮调大小的那一次操作）
            registry.settings.desktopSize = clampDesktopSize(args.patch.desktopSize)
          }
          if (typeof args.patch.defaultPet === 'string' && registry.pets.some((p) => p.id === args.patch.defaultPet)) {
            makeDefaultPet(args.patch.defaultPet)
          }
          bump()
          await saveRegistry()
        }
        sendJson(res, 200, { ok: true, settings: registry.settings })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err && err.message || err) })
      }
    },
  }))

  // 让宿主进程试播音效（技能用它验证"声音到底出没出来"）
  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/play',
    handler: async (req, res) => {
      try {
        const args = JSON.parse(await readBody(req) || '{}')
        const id = String(args.id || '')
        const key = String(args.key || '')
        const entry = registry.pets.find((p) => p.id === id)
        if (!entry) return sendJson(res, 404, { ok: false, error: `未注册的宠物：${id}` })
        const manifest = await manifestOf(entry)
        const item = (manifest.audio || {})[key]
        const rel = typeof item === 'string' ? item : item && item.file
        if (!rel) return sendJson(res, 404, { ok: false, error: `该宠物没有音效 ${key}（可用：${Object.keys(manifest.audio || {}).join(', ') || '无'}）` })
        const abs = resolveInPackage(entry.dir, rel)
        if (!existsSync(abs)) return sendJson(res, 404, { ok: false, error: `音频文件不存在：${rel}` })
        const started = playFile(abs)
        sendJson(res, 200, { ok: started, id, key, file: abs, human: started ? '已交给宿主进程播放（与浏览器静音无关）' : '宿主 shell 服务不可用，无法播放' })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err && err.message || err) })
      }
    },
  }))

  // ---------------------------------------------------------------------------
  // 宠物社区（画廊）
  // ---------------------------------------------------------------------------
  // 契约：docs/GALLERY-CONTRACT.md ｜ 协议：docs/PET-SHARING-AGREEMENT.md（DPSL-1.0）
  //
  // 三条底线（协议第 5、6、10 条在代码里的落点）：
  //   1. 只有 pet.json 里真的声明了 DPSL-1.0 的仓库才给「一键安装」，且**每次安装都重新校验**
  //      —— 作者把 shared 改成 false 的那一刻就失效，不依赖我们的人工流程；
  //   2. 永远不执行仓库里的脚本、不装依赖；只读图集与清单；
  //   3. 插件从不替作者上传任何东西。分享包只是写到本地目录，push 由作者自己跑。

  const safeKeyDir = (key) => String(key).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80)

  /** 从解包目录里挑出可用作宠物包的目录（含 pet.json）。 */
  const locatePackage = (files, packagePath) => {
    const petRel = findPetJson(files, packagePath || '')
    if (!petRel) return null
    const relDir = petRel.includes('/') ? petRel.slice(0, petRel.lastIndexOf('/')) : ''
    return relDir
  }

  /** 兼容导入：由社区 spritesheet.json 合成 pet.json（写在下下来的目录里，不动上游）。 */
  const prepareCompatPackage = async (dest, files, args) => {
    const sheetRel = files.find((f) => f === 'assets/spritesheet.json')
      || files.find((f) => f.endsWith('/spritesheet.json'))
      || files.find((f) => f === 'spritesheet.json')
    if (!sheetRel) return { ok: false, error: '没找到 spritesheet.json，无法兼容导入' }
    let sheet
    try {
      sheet = JSON.parse(await readFile(join(dest, sheetRel), 'utf8'))
    } catch (err) {
      return { ok: false, error: `spritesheet.json 解析失败：${err.message}` }
    }
    const cellW = Number(((sheet.cell || {}).w)) || Number(sheet.cellW) || 0
    const cellH = Number(((sheet.cell || {}).h)) || Number(sheet.cellH) || 0
    const pngRel = sheetRel.replace(/spritesheet\.json$/, 'spritesheet.png')
    const pngAbs = join(dest, pngRel)
    if (!existsSync(pngAbs)) return { ok: false, error: `没找到图集 ${pngRel}（兼容导入需要它与 spritesheet.json 同名同目录）` }
    const head = readImageHeader(await readFile(pngAbs))
    if (!head) return { ok: false, error: `图集不是可识别的 PNG/WebP：${pngRel}` }
    // 行数用**图片实际高度**推导：上游 json 里的行数经常只是"列过的动作数"，
    // 与真实图集行数不一致；用图片尺寸算才不会让注册校验误伤
    const rowsOverride = cellH > 0 && head.height % cellH === 0 ? head.height / cellH : undefined

    const built = buildCompatManifest(sheet, {
      id: String(args.id || 'compat-' + safeKeyDir(dest.split(/[\\/]/).pop())).slice(0, 60),
      name: args.rename || args.name || sheet.name || undefined,
      repo: args.origin && args.origin.repoUrl,
      atlasFile: pngRel,
      rowsOverride,
      tags: ['兼容导入'],
    })
    if (!built.ok) return built
    built.manifest.id = built.manifest.id || 'compat-pet'
    built.manifest.name = built.manifest.name || built.manifest.id
    await writeFile(join(dest, 'pet.json'), JSON.stringify(built.manifest, null, 2) + '\n', 'utf8')
    return { ok: true, manifest: built.manifest, unmapped: built.unmapped, rowsOverride, atlasRel: pngRel, imageSize: { w: head.width, h: head.height } }
  }

  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/gallery',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const force = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refresh') || url.searchParams.get('force') || '').toLowerCase())
        const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
        const result = await gallery.list({ force })
        const installed = registry.pets
          .filter((p) => p.origin && p.origin.key)
          .map((p) => ({ key: p.origin.key, id: p.id, name: p.name, kind: p.origin.kind || 'community' }))
        const entries = q
          ? result.entries.filter((e) =>
              [e.name, e.key, e.author, e.description, (e.tags || []).join(' ')]
                .filter(Boolean).join(' ').toLowerCase().includes(q))
          : result.entries
        sendJson(res, 200, {
          ...result,
          entries,
          installed,
          query: q,
          filterApplied: Boolean(q),
          totalBeforeFilter: result.entries.length,
          config: {
            topics: cfg.gallery.topics,
            online: cfg.gallery.online !== false,
            enabled: cfg.gallery.enabled !== false,
            indexUrl: cfg.gallery.indexUrl,
            installDir: cfg.gallery.installDir,
          },
          agreement: {
            protocol: DPSL_PROTOCOL,
            topic: PET_TOPIC,
            url: 'https://github.com/Stellum-Waq/dsh-pet-ronaldo/blob/master/docs/PET-SHARING-AGREEMENT.md',
            contract: 'https://github.com/Stellum-Waq/dsh-pet-ronaldo/blob/master/docs/GALLERY-CONTRACT.md',
          },
        })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err && err.message || err) })
      }
    },
  }))

  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/gallery/refresh',
    handler: async (req, res) => {
      try {
        const result = await gallery.list({ force: true })
        sendJson(res, 200, {
          ok: result.ok,
          command: 'gallery/refresh',
          cachedAt: result.cachedAt,
          online: result.online,
          counts: result.counts,
          errors: result.errors,
          human: result.online
            ? `已刷新：共 ${result.counts.total} 条（可直装 ${result.counts.installable} · 可兼容导入 ${result.counts.compat} · 仅收录 ${result.counts.listed}）`
            : `刷新未联网，展示的是缓存：共 ${result.counts.total} 条`,
        })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err && err.message || err) })
      }
    },
  }))

  // 手填地址时先"看一眼"（不下载）
  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/gallery/probe',
    handler: async (req, res) => {
      try {
        const args = JSON.parse(await readBody(req) || '{}')
        const target = String(args.repo || args.key || '').trim()
        if (!target) return sendJson(res, 400, { ok: false, error: '缺少 repo（owner/repo 或完整地址）' })
        const probed = await gallery.probeRepo(target)
        if (!probed.ok) return sendJson(res, 400, { ok: false, error: probed.error })
        sendJson(res, 200, { ok: true, command: 'gallery/probe', entry: probed.entry, cached: probed.cached })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err && err.message || err) })
      }
    },
  }))

  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/gallery/install',
    handler: async (req, res) => {
      try {
        const args = JSON.parse(await readBody(req) || '{}')

        // (1) 本地目录：跳过下载，直接校验注册（离线可用，也是 smoke 测试走的路）
        if (args.dir) {
          const local = await registerPackage({
            dir: args.dir,
            id: args.id,
            rename: args.rename,
            size: args.size,
            focus: args.focus,
            origin: { kind: 'local', installedAt: new Date().toISOString() },
          })
          return sendJson(res, local.status, { ...local.body, command: 'gallery/install', mode: 'local' })
        }

        const target = String(args.key || args.repo || '').trim()
        if (!target) return sendJson(res, 400, { ok: false, error: '缺少 key（owner/repo）或 repo 或 dir' })

        let entry = await gallery.get(target)
        if (!entry) {
          const probed = await gallery.probeRepo(target)
          if (!probed.ok) return sendJson(res, 400, { ok: false, error: probed.error })
          entry = probed.entry
        }
        if (args.branch) entry = { ...entry, branch: String(args.branch) }

        const compatMode = args.adapter === 'spritesheet-json'
          || (args.adapter === 'auto' && !entry.dpsl && entry.compat === 'spritesheet-json')

        // (2) 协议闸：没有 DPSL 声明就没有"一键直装"（协议第 6.6 条）
        if (!entry.dpsl && !compatMode) {
          return sendJson(res, 403, {
            ok: false,
            command: 'gallery/install',
            error: '该仓库没有按 DPSL-1.0 声明收录授权，插件不提供直接安装',
            entry,
            hint: entry.compat
              ? '它用的是本插件的图集契约但没有 pet.json：可以选择「兼容导入」（界面上的 ⚠️ 按钮），由你本机把它适配成宠物包。'
              : '这不是本插件的宠物包格式。可以点「打开仓库」看作者给的安装方式，或用 dsh plugin 安装它自己的插件包。',
          })
        }

        // (3) 下载 + 解包
        const dest = join(cfg.gallery.installDir, safeKeyDir(entry.key) + (compatMode ? '--compat' : ''))
        const dl = await gallery.fetchArchive({ owner: entry.owner, repo: entry.repo, branch: entry.branch })
        if (!dl.ok) {
          return sendJson(res, 502, {
            ok: false,
            command: 'gallery/install',
            error: `下载仓库归档失败：${dl.error}`,
            hint: '检查网络（本机可能需要代理或 NODE_OPTIONS=--use-system-ca），或改用「打开仓库」手动下载。',
          })
        }
        const ex = await gallery.extract(dl.bytes, dest)
        if (!ex.ok) {
          return sendJson(res, 422, { ok: false, command: 'gallery/install', error: `解包失败：${ex.error || '未知错误'}` })
        }

        const origin = {
          kind: compatMode ? 'community-compat' : 'community',
          key: entry.key,
          repoUrl: entry.repoUrl,
          protocol: entry.dpsl ? DPSL_PROTOCOL : null,
          author: entry.author,
          branch: dl.branch,
          transport: dl.transport || 'fetch',
          installedAt: new Date().toISOString(),
        }

        if (compatMode) {
          const prep = await prepareCompatPackage(dest, ex.files, { ...args, origin })
          if (!prep.ok) {
            return sendJson(res, 422, {
              ok: false,
              command: 'gallery/install',
              error: `兼容导入失败：${prep.error}`,
              files: ex.files.slice(0, 40),
              extractedTo: dest,
            })
          }
          const reg = await registerPackage({
            dir: dest,
            id: args.id || prep.manifest.id,
            rename: args.rename,
            focus: args.focus,
            origin,
          })
          return sendJson(res, reg.status, {
            ...reg.body,
            command: 'gallery/install',
            mode: 'compat',
            entry,
            extractedTo: dest,
            unmapped: prep.unmapped,
            rowsOverride: prep.rowsOverride,
            warnings: [
              ...(reg.body.warnings || []),
              `兼容导入：动作行映射是启发式的（未映射 ${prep.unmapped.length} 个动作：${prep.unmapped.map((u) => u.name).join(', ') || '无'}）；该仓库未声明 DPSL-1.0，素材权属请自行确认。`,
            ],
          })
        }

        // (4) DPSL 直装：重新校验仓库里"当前"的 pet.json（协议第 2.3 条）
        const relDir = locatePackage(ex.files, entry.packagePath)
        if (relDir === null) {
          // 最常见的成因：官方索引里声明了 DPSL，但作者还没把 pet.json 推上去
          const notPushedYet = entry.dpsl && entry.verified === false
          return sendJson(res, 422, {
            ok: false,
            command: 'gallery/install',
            error: '解包后没找到 pet.json，无法注册',
            hint: notPushedYet
              ? '该仓库在官方索引里声明了 DPSL-1.0，但仓库里还没有 pet.json —— 作者大概还没推送，或推的是旧提交。'
                + '（如果你是作者本人：跑一次宠物包目录里的 publish.ps1，把 pet.json 一起推上去即可。）'
              : '这个仓库不是标准的宠物包结构（缺 pet.json）。可以点「打开仓库」看作者给的安装方式。',
            files: ex.files.slice(0, 40),
            extractedTo: dest,
          })
        }
        const pkgDir = relDir ? join(dest, relDir) : dest
        let manifest = null
        try {
          manifest = JSON.parse(await readFile(join(pkgDir, 'pet.json'), 'utf8'))
        } catch (err) {
          return sendJson(res, 422, { ok: false, command: 'gallery/install', error: `pet.json 解析失败：${err.message}` })
        }
        const sharing = validateSharing(manifest.sharing)
        if (!sharing.ok) {
          return sendJson(res, 403, {
            ok: false,
            command: 'gallery/install',
            error: '仓库当前的 pet.json 不再声明 DPSL-1.0 授权（作者可能已撤回），已中止安装',
            detail: sharing.errors,
            hint: '协议第 2.3、9 条：每次安装都以仓库里当前的 sharing 块为准。',
          })
        }
        const reg = await registerPackage({
          dir: pkgDir,
          id: args.id || manifest.id,
          rename: args.rename,
          size: args.size,
          focus: args.focus,
          origin,
        })
        sendJson(res, reg.status, {
          ...reg.body,
          command: 'gallery/install',
          mode: 'dpsl',
          entry,
          extractedTo: pkgDir,
          license: { protocol: DPSL_PROTOCOL, author: manifest.sharing.author, statement: manifest.sharing.statement },
          attribution: manifest.sharing.attribution || manifest.sharing.author,
        })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err && err.message || err) })
      }
    },
  }))

  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/gallery/share',
    handler: async (req, res) => {
      try {
        const args = JSON.parse(await readBody(req) || '{}')
        let dir = String(args.dir || '').trim()
        if (!dir && args.id) {
          const entry = registry.pets.find((p) => p.id === String(args.id))
          if (!entry) return sendJson(res, 404, { ok: false, error: `未注册的宠物：${args.id}` })
          if (entry.builtin) {
            return sendJson(res, 400, {
              ok: false,
              error: '内置 C罗 的分享声明写在插件仓库根目录的 pet.json 里，不用在这里改',
              hint: '想分享自己的宠物：先在设置里生成/导入一只，再对它做分享。',
            })
          }
          dir = entry.dir
        }
        if (!dir) return sendJson(res, 400, { ok: false, error: '缺少 dir（宠物包目录）或 id（已注册的宠物 id）' })

        // 分享是可选动作：没有明确同意就一个字节都不写（协议第 2.2 条）
        const tags = Array.isArray(args.tags)
          ? args.tags
          : String(args.tags || '').split(',').map((s) => s.trim()).filter(Boolean)

        const result = await buildShareKit(dir, {
          accept: args.accept === true,
          author: args.author,
          repo: args.repo,
          license: args.license,
          preview: args.preview,
          description: args.description,
          contact: args.contact,
          rights: args.rights,
          statement: args.statement,
          attribution: args.attribution,
          allowRemix: args.allowRemix,
          allowCommercial: args.allowCommercial,
          tags,
          pluginRoot: __dirname,
        })
        sendJson(res, result.ok ? 200 : (result.needsConsent ? 400 : 400), { ...result, command: 'gallery/share' })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err && err.message || err) })
      }
    },
  }))

  // ---------------------------------------------------------------------------
  // 从视频生成宠物（GUI 入口）
  // ---------------------------------------------------------------------------
  // 抽帧 + 抠像是**长任务**（几十秒到几分钟），所以：
  //   · 一律以子进程方式跑技能里的 forge.mjs video，绝不在宿主进程里同步做（会把整个界面卡住）；
  //   · 起一个后台 job，客户端轮询状态，能实时看到进度日志；
  //   · 同一时间只允许一个视频任务（抽帧很吃 CPU/磁盘，排队不如直接等）。
  const videoJobs = new Map()
  let videoJobSeq = 0
  const VIDEO_JOB_KEEP = 5
  const forgeCli = join(__dirname, 'skill', 'dsh-pet-forge', 'scripts', 'forge.mjs')

  const pruneVideoJobs = () => {
    const list = Array.from(videoJobs.values()).sort((a, b) => b.startedAt - a.startedAt)
    for (const job of list.slice(VIDEO_JOB_KEEP)) videoJobs.delete(job.id)
  }
  const runningVideoJob = () => Array.from(videoJobs.values()).find((j) => j.running) || null

  const startVideoJob = (args) => {
    const id = 'v' + (++videoJobSeq) + '-' + Date.now().toString(36)
    const slug = String(args.id || args.name || 'video-pet').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40) || 'video-pet'
    const pkgDir = args.pkg ? resolve(String(args.pkg)) : join(cfg.video.generateDir, slug)
    const cli = [
      forgeCli, 'video',
      '--pkg', pkgDir,
      '--id', String(args.id || slug),
      '--name', String(args.name || slug),
      '--engine', String(args.engine || 'auto'),
      '--fps', String(args.fps !== undefined && args.fps !== '' ? args.fps : cfg.video.defaultFps),
      '--frames', String(args.frames !== undefined && args.frames !== '' ? args.frames : cfg.video.defaultFrames),
      '--max-frames', String(cfg.video.maxFrames),
    ]
    // 关键：把**本插件实例**的地址告诉子进程。
    // 不传的话 forge.mjs 会去猜（127.0.0.1:3080/3000），端口不是默认值时就会把宠物注册到
    // 另一个正在跑的 dsh 实例上（踩过：冒烟测试把宠物注册进了用户真实的 DSH 里）。
    const selfBase = desktopBase()
    if (selfBase) cli.push('--base', selfBase)
    if (args.path) cli.push('--video', String(args.path))
    if (args.framesDir) cli.push('--frames-dir', String(args.framesDir))
    if (args.segments) cli.push('--segments', String(args.segments))
    else if (args.autoSegments) cli.push('--auto-segments', String(args.autoSegments))
    if (args.key) cli.push('--key', String(args.key))
    if (args.noKey) cli.push('--no-key')
    for (const [flag, key] of [['--similarity', 'similarity'], ['--blend', 'blend'], ['--spill', 'spill'], ['--erode', 'erode']]) {
      if (args[key] !== undefined && args[key] !== '' && args[key] !== null) cli.push(flag, String(args[key]))
    }
    if (args.audioFromVideo) cli.push('--audio-from-video', String(args.audioFromVideo))
    if (args.install === true) cli.push('--install')
    if (args.noFocus === true) cli.push('--no-focus')

    const job = {
      id, running: true, ok: null, startedAt: Date.now(), finishedAt: 0,
      pkg: pkgDir, path: args.path || args.framesDir || null, log: [], result: null, exitCode: null, error: null,
    }
    videoJobs.set(id, job)
    pruneVideoJobs()

    let child
    try {
      child = spawn(process.execPath, cli, { cwd: __dirname, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      job.running = false
      job.ok = false
      job.error = `启动生成进程失败：${err.message}`
      job.finishedAt = Date.now()
      return job
    }
    const push = (line) => {
      for (const l of String(line).split('\n')) {
        const s = l.trimEnd()
        if (s) job.log.push(s)
      }
      if (job.log.length > 200) job.log.splice(0, job.log.length - 200)
    }
    let stdout = ''
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8')
      // forge.mjs 只在最后打一个 JSON，中间的进度看 stderr
      if (stdout.length > 4 * 1024 * 1024) stdout = stdout.slice(-2 * 1024 * 1024)
    })
    child.stderr.on('data', (d) => push(d.toString('utf8')))
    child.on('error', (err) => {
      job.running = false
      job.ok = false
      job.error = String(err.message || err)
      job.finishedAt = Date.now()
    })
    child.on('close', (code) => {
      job.running = false
      job.exitCode = code
      job.finishedAt = Date.now()
      const text = stdout.trim()
      const start = text.indexOf('{')
      try {
        job.result = JSON.parse(text.slice(start >= 0 ? start : 0))
        job.ok = job.result.ok === true
      } catch {
        job.ok = false
        job.error = `生成进程没有输出可解析的 JSON（exit ${code}）。stderr 摘要：${job.log.slice(-3).join(' / ').slice(0, 400)}`
      }
      pruneVideoJobs()
    })
    child.unref?.()
    return job
  }

  const videoJobView = (job) => {
    if (!job) return { ok: false, error: '没有这个任务（可能已被清理）' }
    const res = job.result
    return {
      ok: job.ok !== false,
      jobId: job.id,
      running: job.running,
      finished: !job.running,
      succeeded: job.ok === true,
      failed: job.ok === false,
      exitCode: job.exitCode,
      startedAt: new Date(job.startedAt).toISOString(),
      finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
      pkg: job.pkg,
      video: job.path,
      log: job.log.slice(-40),
      error: job.error,
      result: res
        ? {
          ok: res.ok === true,
          human: res.human,
          error: res.error,
          warnings: res.warnings,
          errors: res.errors,
          steps: res.steps,
          chroma: res.chroma,
          audit: res.audit,
          samples: res.samples,
          pet: res.pet,
          validation: res.validation,
          installed: res.installed,
          next: res.next,
        }
        : null,
    }
  }

  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/video/probe',
    handler: async (req, res) => {
      try {
        const args = JSON.parse(await readBody(req) || '{}')
        const engines = await probeEngines({ force: true, ffmpegPath: cfg.video.ffmpegPath, pythonPath: cfg.video.pythonPath })
        const out = {
          ok: true,
          command: 'video/probe',
          engines: {
            available: engines.available,
            preferred: engines.preferred,
            ffmpeg: engines.ffmpeg.ok ? { path: engines.ffmpeg.path, version: engines.ffmpeg.version } : null,
            cv2: engines.cv2.ok ? { version: engines.cv2.version, python: engines.cv2.python } : null,
            hint: engines.hint,
            install: engines.available.length ? [] : [
              { label: '装 ffmpeg（推荐，还能抽视频原声）', cmd: 'winget install Gyan.FFmpeg' },
              { label: '或装 opencv-python', cmd: 'python -m pip install opencv-python' },
            ],
          },
          running: Boolean(runningVideoJob()),
        }
        if (args.path) {
          const info = await probeVideo({ video: String(args.path), engine: args.engine, ffmpegPath: cfg.video.ffmpegPath, pythonPath: cfg.video.pythonPath })
          out.video = info
        }
        sendJson(res, 200, out)
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err && err.message || err) })
      }
    },
  }))

  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/video/build',
    handler: async (req, res) => {
      try {
        const args = JSON.parse(await readBody(req) || '{}')
        if (!args.path && !args.framesDir) {
          return sendJson(res, 400, { ok: false, error: '缺少 path（视频文件路径）或 framesDir（已抽好的 PNG 帧目录）' })
        }
        if (!existsSync(forgeCli)) {
          return sendJson(res, 500, { ok: false, error: `找不到技能 CLI：${forgeCli}（插件包不完整？）` })
        }
        const running = runningVideoJob()
        if (running) {
          return sendJson(res, 409, { ok: false, error: '已经有一个视频任务在跑了，等它结束再开新的', jobId: running.id })
        }
        const job = startVideoJob(args)
        sendJson(res, 200, {
          ok: true,
          command: 'video/build',
          jobId: job.id,
          pkg: job.pkg,
          human: '已开始生成（抽帧 → 抠像 → 切分 → 装配）。可以关掉这个面板，生成会继续。',
        })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err && err.message || err) })
      }
    },
  }))

  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/video/status',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const id = url.searchParams.get('jobId')
        if (id) return sendJson(res, 200, { ...videoJobView(videoJobs.get(id)), command: 'video/status' })
        sendJson(res, 200, {
          ok: true,
          command: 'video/status',
          running: Boolean(runningVideoJob()),
          jobs: Array.from(videoJobs.values())
            .sort((a, b) => b.startedAt - a.startedAt)
            .map((j) => ({ jobId: j.id, running: j.running, succeeded: j.ok === true, pkg: j.pkg, video: j.path, startedAt: new Date(j.startedAt).toISOString() })),
        })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err && err.message || err) })
      }
    },
  }))

  // ---- 兼容旧版路由 ----
  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/spritesheet.webp',
    handler: async (req, res) => {
      try { sendBytes(res, await readMaybe(cfg.spritePath), 'image/webp') } catch (err) { sendJson(res, 404, { ok: false, error: String(err.message) }) }
    },
  }))
  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/siu.mp3',
    handler: async (req, res) => {
      try { sendBytes(res, await readMaybe(cfg.voicePath), 'audio/mpeg') } catch (err) { sendJson(res, 404, { ok: false, error: String(err.message) }) }
    },
  }))

  // 旧版导入接口保留（内部改成"生成一个临时包 + 注册"，行为对老客户端不变）
  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/import-image',
    handler: async (req, res) => {
      try {
        const args = JSON.parse(await readBody(req) || '{}')
        const p = String(args.path || '').trim()
        if (!p) return sendJson(res, 400, { ok: false, error: '缺少 spritesheet 图片路径' })
        const cols = Math.max(1, parseInt(args.cols, 10) || 8)
        const rows = Math.max(1, parseInt(args.rows, 10) || 11)
        const bytes = await readMaybe(p)
        const head = readImageHeader(bytes)
        if (!head) return sendJson(res, 422, { ok: false, error: '该文件不是可识别的 PNG/WebP 图片' })

        // 格宽/格高可以不给：知道列数行数就能从图片尺寸直接推出来。
        // 高分辨率素材动辄 1024px 一格，硬要求用户自己算好填进来太容易填错。
        let cellW = parseInt(args.cellW, 10) || 0
        let cellH = parseInt(args.cellH, 10) || 0
        if (!cellW && head.width % cols === 0) cellW = head.width / cols
        if (!cellH && head.height % rows === 0) cellH = head.height / rows
        if (!cellW) cellW = 192
        if (!cellH) cellH = 208
        cellW = Math.max(1, cellW)
        cellH = Math.max(1, cellH)

        if (head.width !== cols * cellW || head.height !== rows * cellH) {
          return sendJson(res, 422, {
            ok: false,
            error:
              `图片尺寸 ${head.width}×${head.height} 与 ${cols}列×${rows}行 · ${cellW}×${cellH}px 不匹配` +
              `（应为 ${cols * cellW}×${rows * cellH}）。` +
              `提示：只填列数和行数、把格宽格高留空，就会自动按图片尺寸推导。`,
          })
        }
        const CELL_LIMIT = 4096
        if (cellW > CELL_LIMIT || cellH > CELL_LIMIT || cols * rows * cellW * cellH > 64 * 1024 * 1024) {
          return sendJson(res, 422, {
            ok: false,
            error: `单格 ${cellW}×${cellH}px 过大（上限 ${CELL_LIMIT}px、整图 64M 像素）。分辨率不限，但这么大解码会卡住。`,
          })
        }
        const uri = 'data:' + mimeFor(p) + ';base64,' + Buffer.from(bytes).toString('base64')
        sendJson(res, 200, {
          ok: true,
          sheet: { uri, cols, rows, cellW, cellH },
          states: legacyDefaultStates(cols, rows, args.framesPerRow),
        })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err && err.message || err) })
      }
    },
  }))

  // ---------- 启动 ----------
  // 需求：终端一开始运行，桌宠立马出现。
  // 插件随 profile 加载，所以这里就是"终端启动"的时机。
  // 但 webServer 可能还没开始监听（拿不到端口就没法把地址传给桌宠），
  // 所以失败时退避重试几次，而不是默默放弃。
  const startDesktopPetWithRetry = (attempt = 0) => {
    if (disposed || cfg.desktopPet === false) return
    const r = startDesktopPet()
    if (r.ok) return
    const retryable = /还没监听端口/.test(String(r.error || '')) || /webServer/.test(String(r.error || ''))
    if (retryable && attempt < 20) {
      ctx.timeout(() => startDesktopPetWithRetry(attempt + 1), 500)
      return
    }
    console.error('[ronaldo-pet] 桌面宠物未启动：', r.error)
  }

  const boot = async () => {
    await loadRegistry()
    startDesktopPetWithRetry()
  }
  boot().catch((err) => console.error('[ronaldo-pet] 初始化失败：', err))

  ctx.effect(() => () => {
    disposed = true
    for (const d of routeDisposers) d()
    if (celebrateTimer) celebrateTimer()
    if (failTimer) failTimer()
    if (recentToolTimer) recentToolTimer()
    // 插件卸载 / dsh 退出时把桌面宠物一起收掉
    try { stopDesktopPet() } catch { /* ignore */ }
  })

  // ---------- Agent 状态机（轮询 + 事件） ----------
  const agentsService = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  const poll = () => {
    if (agentsService === undefined) return
    let list
    try { list = agentsService.list() } catch (err) { return }
    if (!Array.isArray(list)) return
    const runningNow = new Set()
    for (const agent of list) {
      let status = 'idle'
      try { status = agent && agent.status === 'running' ? 'running' : 'idle' } catch (err) { status = 'idle' }
      if (status === 'running') runningNow.add(agent)
      const prev = lastStatus.get(agent)
      lastStatus.set(agent, status)
      if (agent && prev === undefined) observedAgents.add(agent)
      if (prev === 'running' && status === 'idle') {
        if (runningNow.size === 0 && waitingCount === 0) {
          const f = turnFlags.get(agent)
          if (f === undefined || !f.errored) celebrate()
          if (f !== undefined) turnFlags.delete(agent)
        }
      }
    }
    deriveMode(runningNow.size)
  }
  const stopPolling = ctx.interval(poll, cfg.pollMs)
  ctx.effect(() => stopPolling)

  ctx.on('approval/request', (req, next) => {
    waitingCount++
    deriveMode(currentRunningCount())
    let p
    try { p = Promise.resolve(next()) } catch (err) { waitingCount = Math.max(0, waitingCount - 1); deriveMode(currentRunningCount()); throw err }
    p.then(
      () => { waitingCount = Math.max(0, waitingCount - 1); deriveMode(currentRunningCount()) },
      () => { waitingCount = Math.max(0, waitingCount - 1); deriveMode(currentRunningCount()) },
    )
    return p
  })

  ctx.on('tools/execute', (exec, next) => {
    let isQuestion = false
    if (exec && exec.agent) flagsOf(exec.agent).worked = true
    if (exec && typeof exec.name === 'string' && exec.name === 'ask_user_question') { isQuestion = true; waitingCount++ }
    toolsInFlight++
    recentTool = true
    if (recentToolTimer) { recentToolTimer(); recentToolTimer = null }
    deriveMode(currentRunningCount())
    let p
    try { p = Promise.resolve(next()) } catch (err) { markToolSettled(isQuestion); throw err }
    p.then(
      () => markToolSettled(isQuestion),
      () => markToolSettled(isQuestion),
    )
    return p
  })

  ctx.on('agent/request-error', (payload, next) => {
    if (payload && payload.agent) flagsOf(payload.agent).errored = true
    showFailed()
    return next()
  })
}

// 旧版 /import-image 用的状态表（列数/行数推断，保持向后兼容）
function legacyDefaultStates(cols, rows, framesPerRow) {
  const fr = (i) => (framesPerRow && framesPerRow[i] != null) ? framesPerRow[i] : cols
  return {
    idle: { row: 0, frames: fr(0), fps: 6 },
    runRight: { row: 1, frames: fr(1), fps: 12 },
    runLeft: { row: 2, frames: fr(2), fps: 12 },
    waving: { row: 3, frames: fr(3), fps: 8 },
    jumping: { row: 4, frames: fr(4), fps: 10 },
    failed: { row: 5, frames: fr(5), fps: 12 },
    waiting: { row: 6, frames: fr(6), fps: 5 },
    running: { row: 7, frames: fr(7), fps: 12 },
    review: { row: 8, frames: fr(8), fps: 6 },
    look: rows >= 11 ? { rows: [9, 10], frames: 8 } : null,
  }
}
