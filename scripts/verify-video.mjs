#!/usr/bin/env node
// =============================================================================
// dsh-pet-forge · 「从视频生成桌宠」验证器
// -----------------------------------------------------------------------------
//   node scripts/verify-video.mjs [--keep]
//
// 分三段跑：
//   [1] 纯算法（不需要任何解码器）：抠像 / 自动取幕布色 / 时间段解析 / 运动切分 / 落格装配
//   [2] 端到端（有 cv2 或 ffmpeg 时才跑）：现造一段绿幕视频 → 抽帧 → 抠像 → 出宠物包 → 严格校验
//   [3] 无解码器路径：直接给一堆 PNG 帧，照样出宠物包
//
// 为什么要单独一个脚本：视频这条路最容易"看起来跑通了但画面是坏的"
// （绿边没抠干净、动作行错位、抠像把角色也抠掉了）。所以这里除了"流程 ok"，
// 还要用像素级指标验：**不透明像素里还有多少绿色残留**、每行动作是否真的在动。
// =============================================================================

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')
const LIB = join(REPO, 'skill', 'dsh-pet-forge', 'scripts', 'lib')
const PY_EXTRACTOR = join(REPO, 'skill', 'dsh-pet-forge', 'scripts', 'py', 'extract_frames.py')

const imaging = await import(pathToFileURL(join(LIB, 'imaging.mjs')).href)
const video = await import(pathToFileURL(join(LIB, 'video.mjs')).href)
const manifestLib = await import(pathToFileURL(join(LIB, 'manifest.mjs')).href)

const { newImg, setPixel, getPixel, encodeImage, decodeImage } = imaging

let pass = 0
let fail = 0
let skip = 0
const check = (cond, label, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label + (detail ? '  — ' + detail : '')) }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  — ' + detail : '')) }
}
const skipped = (label, why) => { skip++; console.log('  skip ' + label + (why ? '  — ' + why : '')) }

// ---------------------------------------------------------------- 合成绿幕帧
const KEY = { r: 0, g: 177, b: 64 }
const BODY = [240, 140, 40]
const HAT = [40, 90, 220]

/** 造一帧绿幕素材：绿底 + 橙身 + 蓝帽 + 一条绿边（用来验溢色抑制）。 */
function greenScreenFrame({ w = 240, h = 180, cx = 120, cy = 110, r = 26, hat = true, greenFringe = false } = {}) {
  const img = newImg(w, h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, KEY.r, KEY.g, KEY.b, 255)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy)
      if (d <= r) setPixel(img, x, y, BODY[0], BODY[1], BODY[2], 255)
      else if (greenFringe && d <= r + 2) setPixel(img, x, y, 120, 200, 120, 255) // 半绿边（模拟压缩溢色）
      if (hat && Math.hypot(x - cx, y - (cy - r + 2)) <= r * 0.55) setPixel(img, x, y, HAT[0], HAT[1], HAT[2], 255)
    }
  }
  return img
}

/** 不透明像素里"还是绿色"的比例 —— 抠像干不干净的硬指标。 */
function greenResidue(img) {
  let opaque = 0
  let green = 0
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < 32) continue
    opaque++
    const r = img.data[i]
    const g = img.data[i + 1]
    const b = img.data[i + 2]
    if (g > r + 25 && g > b + 25) green++
  }
  return opaque === 0 ? 1 : green / opaque
}

function opaqueRatio(img) {
  let n = 0
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 32) n++
  return n / (img.width * img.height)
}

/** 两个 Img 之间的平均色差（只看双方都不透明的像素）：用来验"同一行里各帧真的不一样"。 */
function meanDiff(a, b) {
  let acc = 0
  let n = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i + 3] < 32 || b.data[i + 3] < 32) continue
    acc += (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3
    n++
  }
  return n === 0 ? 0 : acc / n
}

/** 取图集里某一格第 c 列。 */
function cellAt(atlas, row, col, cellW, cellH) {
  const out = newImg(cellW, cellH)
  for (let y = 0; y < cellH; y++) {
    for (let x = 0; x < cellW; x++) {
      const si = ((row * cellH + y) * atlas.width + col * cellW + x) * 4
      const di = (y * cellW + x) * 4
      out.data[di] = atlas.data[si]
      out.data[di + 1] = atlas.data[si + 1]
      out.data[di + 2] = atlas.data[si + 2]
      out.data[di + 3] = atlas.data[si + 3]
    }
  }
  return out
}

/**
 * 不透明像素的重心 Y（0 = 顶部）。
 * 为什么不用"逐像素色差"判断姿态是否不同：角色在上/在下时，两者的**不透明区域几乎不重叠**，
 * 逐像素比较会自动跳过所有差异点，于是"跳跃"和"待机"算出来的差只有 0.7 —— 完全测不出来。
 * 重心能直接反映"角色在格子里站得高还是低"，这才是要验的东西。
 */
function alphaCentroidY(img) {
  let sum = 0
  let n = 0
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] < 32) continue
      sum += y
      n++
    }
  }
  return n === 0 ? null : sum / n
}

/** 一行里"站得最高"的那一帧的重心（跳跃行要拿它和待机行比）。 */
function minCentroidY(cells) {
  let best = Infinity
  for (const c of cells) {
    const y = alphaCentroidY(c)
    if (y !== null && y < best) best = y
  }
  return best
}

// ---------------------------------------------------------------- 1. 纯算法
function section1() {
  console.log('\n[1] 抠像与切分（纯算法，不需要解码器）')

  // 1.1 抠像：绿底必须全透明，角色必须保住
  const frame = greenScreenFrame({})
  const keyed = video.chromaKey(frame, { key: KEY })
  const greenPixel = getPixel(frame, 5, 5)
  const bodyPixel = keyed.img.data.slice(((110 * frame.width) + 120) * 4, ((110 * frame.width) + 120) * 4 + 4)
  const greenAfter = keyed.img.data.slice(((5 * frame.width) + 5) * 4, ((5 * frame.width) + 5) * 4 + 4)
  check(greenAfter[3] === 0, '绿幕像素被抠成完全透明', `alpha=${greenAfter[3]}`)
  check(bodyPixel[3] === 255, '角色身体像素保持不透明', `alpha=${bodyPixel[3]}`)
  check(bodyPixel[0] === BODY[0] && bodyPixel[1] === BODY[1], '角色颜色没有被改掉',
    `rgb=${bodyPixel[0]},${bodyPixel[1]},${bodyPixel[2]}`)
  check(greenPixel[3] === 255, '（前置）原帧里那个点确实是绿的')
  check(keyed.report.transparentRatio > 0.5, '透明比例合理', `transparent=${(keyed.report.transparentRatio * 100).toFixed(1)}%`)

  // 1.2 溢色抑制：半绿边要变淡
  const fringe = greenScreenFrame({ greenFringe: true })
  const withSpill = video.chromaKey(fringe, { key: KEY, spill: 0.9 })
  const noSpill = video.chromaKey(fringe, { key: KEY, spill: 0 })
  check(greenResidue(withSpill.img) < greenResidue(noSpill.img) + 1e-9,
    '开启溢色抑制后绿色残留不增加',
    `spill0=${(greenResidue(noSpill.img) * 100).toFixed(2)}% spill0.9=${(greenResidue(withSpill.img) * 100).toFixed(2)}%`)
  check(greenResidue(withSpill.img) < 0.02, '抠完的帧里几乎没有绿色残留',
    `${(greenResidue(withSpill.img) * 100).toFixed(3)}%`)

  // 1.3 自动取幕布色
  const probe = video.sampleKeyColor([greenScreenFrame({}), greenScreenFrame({ cx: 130 })], {})
  check(probe.ok === true, '能从画面边缘自动取到幕布色')
  check(Math.abs(probe.r - KEY.r) <= 2 && Math.abs(probe.g - KEY.g) <= 2 && Math.abs(probe.b - KEY.b) <= 2,
    '取到的颜色就是幕布色', `${probe.r},${probe.g},${probe.b}（置信度 ${probe.confidence}）`)

  // 1.4 幕布色解析
  const c1 = video.parseChromaColor('0x00FF00')
  const c2 = video.parseChromaColor('#0f0')
  const c3 = video.parseChromaColor('green')
  const c4 = video.parseChromaColor('auto')
  check(c1 && c1.g === 255 && c1.r === 0, '0x00FF00 解析正确', JSON.stringify(c1))
  check(c2 && c2.g === 255, '#0f0 三位十六进制也能解析', JSON.stringify(c2))
  check(c3 && c3.g === 255, 'green 别名可用')
  check(c4 === 'auto', 'auto 走自动取样')
  check(video.parseChromaColor('紫色乱写') === null, '看不懂的颜色返回 null（上层报错）')

  // 1.5 时间段解析
  const seg = video.parseSegments('idle:0-2.5, waving:3-5.4', 6)
  check(seg.ok === true && seg.segments.length === 2, '时间段解析成功', JSON.stringify(seg.segments))
  check(seg.segments[1].action === 'waving' && seg.segments[1].from === 3, '动作名与区间正确')
  const segBad = video.parseSegments('idle:0-2.5, nope:3-4', 6)
  check(segBad.ok === false && segBad.errors.some((e) => e.includes('未知动作')), '未知动作被拒绝')
  const segLook = video.parseSegments('look:0-2', 6)
  check(segLook.ok === false && segLook.errors.some((e) => e.includes('look')), '明确说明视频做不了 look（16 方向视线）')
  const segOver = video.parseSegments('idle:0-3, waving:2-4', 6)
  check(segOver.ok === true && segOver.warnings.some((w) => w.includes('重叠')), '时间段重叠给警告但不报错')
  const segEnd = video.parseSegments('idle:4-', 6)
  check(segEnd.ok === true && segEnd.segments[0].to === 6, '末尾留空 = 到视频结束', JSON.stringify(segEnd.segments))

  // 1.6 运动切分：切点必须落在"运动低谷"，硬切（没有停顿）时必须如实标注不可信
  const frames = []
  for (let i = 0; i < 30; i++) {
    // 造一段"真实的"素材：0-9 只有极轻微抖动（停下来喘气），10-19 小幅摆，20-29 大幅动
    const jitter = i < 10 ? (i % 2) : 0
    const cx = i < 10 ? 80 + jitter : i < 20 ? 160 + ((i % 3) - 1) * 3 : 120 + ((i % 5) - 2) * 14
    frames.push(greenScreenFrame({ cx }))
  }
  const energies = video.computeMotionEnergies(frames)
  const split = video.splitByMotion(energies, { count: 3, minLen: 3 })
  check(split.cuts.length === 2, '找到了 2 个切点', JSON.stringify(split.cuts))
  // 自动切分是启发式的：这里验"切出来的三段各自主要落在该落的姿态块里"，
  // 而不是要求切点分毫不差（那是 --segments 的职责）
  const intended = [[0, 9], [10, 19], [20, 29]]
  const overlaps = split.segments.map((s, i) => {
    const [a, b] = intended[i]
    const lo = Math.max(s.from, a)
    const hi = Math.min(s.to, b)
    return Math.max(0, hi - lo + 1) / (b - a + 1)
  })
  check(overlaps.every((o) => o >= 0.6), '三段各自主要落在正确的姿态块里',
    `mode=${split.mode} cuts=${JSON.stringify(split.cuts)} 覆盖率=${overlaps.map((o) => (o * 100).toFixed(0) + '%').join('/')}`)
  check(split.ambiguous === false, '边界清楚的视频不会被标成"不可信"')

  // 硬切（三个静止姿态直接跳变，中间没有过渡）：必须精确切在姿态边界上
  const hardCut = []
  for (let i = 0; i < 24; i++) hardCut.push(greenScreenFrame({ cx: i < 8 ? 70 : i < 16 ? 150 : 110 }))
  const hardSplit = video.splitByMotion(video.computeMotionEnergies(hardCut), { count: 3, minLen: 3 })
  check(hardSplit.cuts.join(',') === '8,16', '硬切视频精确切在三个姿态的边界上',
    `mode=${hardSplit.mode} cuts=${JSON.stringify(hardSplit.cuts)} snapped=${hardSplit.snappedToTransitions}`)

  // 真·停顿型：动作之间角色完全静止 → 要在停顿处下刀
  const paused = []
  for (let i = 0; i < 32; i++) {
    const moving = (i >= 4 && i < 10) || (i >= 16 && i < 22)
    const cx = moving ? 100 + ((i % 3) - 1) * 22 : 100
    paused.push(greenScreenFrame({ cx }))
  }
  const pauseSplit = video.splitByMotion(video.computeMotionEnergies(paused), { count: 3, minLen: 3 })
  check(pauseSplit.mode === 'pauses', '有真实停顿的视频走"停顿型"切分', `mode=${pauseSplit.mode}`)
  const staticRanges = [[0, 4], [10, 15], [22, 31]]
  check(pauseSplit.cuts.every((c) => staticRanges.some(([a, b]) => c >= a && c <= b)),
    '切点落在两段动作之间的静止区间里（不会切进动作中间）', JSON.stringify(pauseSplit.cuts))

  // 匀速运动（能量是平台）→ 必须如实标注不可信
  const flatEnergies = new Array(23).fill(0.5)
  const flatSplit = video.splitByMotion(flatEnergies, { count: 3, minLen: 3 })
  check(flatSplit.ambiguous === true, '运动曲线是平台时标注 ambiguous（如实说"位置是随机挑的"）')

  const even = video.splitByMotion([0.5, 0.5, 0.5, 0.5, 0.5], { count: 4, minLen: 3 })
  check(even.synthetic === true, '帧数不足时如实退化成等分并标注 synthetic')

  // 1.7 均匀取帧
  const pick = video.pickEvenly([1, 2, 3, 4, 5, 6, 7, 8], 4)
  check(pick.length === 4 && pick[0] === 1 && pick[3] === 8, 'pickEvenly 取到含首尾的均匀帧', JSON.stringify(pick))

  // 1.8 落格装配 + 并集包围盒（注意：buildRowFrames 吃的是**抠完**的帧）
  const keyedFrames = (frames) => frames.map((f) => video.chromaKey(f, { key: KEY }).img)
  const sampled = [
    { action: 'idle', from: 0, to: 1, frames: keyedFrames([greenScreenFrame({ cx: 100, cy: 110 }), greenScreenFrame({ cx: 104, cy: 108 })]) },
    { action: 'jumping', from: 1, to: 2, frames: keyedFrames([greenScreenFrame({ cx: 105, cy: 70 }), greenScreenFrame({ cx: 105, cy: 90 })]) },
  ]
  const built = video.buildRowFrames(sampled, { cellW: 192, cellH: 208 })
  check(Object.keys(built.rowFrames).length === 2, '两个动作各落一行', Object.keys(built.rowFrames).join(','))
  check(built.rowFrames[0][0].width === 192 && built.rowFrames[0][0].height === 208, '每格严格 192×208')
  // 默认所有动作共用同一个并集包围盒 —— 这是"体型一致、跳跃不被裁"的保证
  check(built.perAction.idle.bbox.height === built.perAction.jumping.bbox.height,
    '默认共用并集包围盒（各动作体型一致）',
    `idle ${built.perAction.idle.bbox.height} / jumping ${built.perAction.jumping.bbox.height}`)
  check(built.perAction.idle.bbox.y <= 32 && built.perAction.idle.bbox.height >= 100,
    '并集包围盒完整覆盖了跳得最高的那一帧（不会被裁）',
    JSON.stringify(built.perAction.idle.bbox))
  // loose：把某个动作单独缩放（摔倒/跳跃这种大幅位移的动作该这么用）
  const built2 = video.buildRowFrames(sampled, { cellW: 192, cellH: 208, looseActions: ['jumping'] })
  check(built2.perAction.jumping.bbox.height < built.perAction.idle.bbox.height,
    'looseActions 里的动作会单独算包围盒（不再拖累别人）',
    `loose jumping ${built2.perAction.jumping.bbox.height} < 全局 ${built.perAction.idle.bbox.height}`)
  check(built.rowFrames[4][0].height === 208, '跳跃所在行（row 4）也严格落格')
  // 跳得高的那一帧在格子里必须明显更靠上
  const idleTop = minCentroidY(built.rowFrames[0])
  const jumpTop = minCentroidY(built.rowFrames[4])
  check(jumpTop < idleTop - 8, '跳跃帧在格子里明显站得更高（相对位移被保留）',
    `idle 最高重心 ${idleTop.toFixed(1)} vs jumping ${jumpTop.toFixed(1)}`)
}

// ---------------------------------------------------------------- 2. 端到端（真视频）
const PY_GEN = `import cv2, numpy as np, os, sys, math
out = sys.argv[1]
W, H, N, FPS = 480, 360, 72, 12
vw = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*'mp4v'), FPS, (W, H))
for f in range(N):
    img = np.zeros((H, W, 3), np.uint8)
    img[:, :] = (64, 177, 0)                      # BGR 绿幕
    t = f / FPS
    if t < 2.0:
        bob, arm = math.sin(f * 0.5) * 3, 0
    elif t < 4.0:
        bob, arm = math.sin(f * 0.8) * 4, math.sin((t - 2.0) * math.pi * 3) * 28
    else:
        bob, arm = -abs(math.sin((t - 4.0) * math.pi * 2)) * 40, 10
    cx, cy = W // 2, int(H * 0.62 + bob)
    cv2.circle(img, (cx, cy), 46, (40, 140, 240), -1)
    cv2.circle(img, (cx, cy - 44), 26, (220, 90, 40), -1)
    cv2.line(img, (cx + 40, cy - 6), (cx + 46 + int(abs(arm)), cy - 30 - int(arm)), (40, 140, 240), 9)
    vw.write(img)
vw.release()
print('OK', os.path.getsize(out))
`

async function section2(tmp) {
  console.log('\n[2] 端到端：造一段绿幕视频 → 出宠物包')
  const engines = await video.probeEngines({ force: true })
  if (engines.available.length === 0) {
    skipped('整段端到端', '这台机器既没有 ffmpeg 也没有 python+opencv（' + engines.hint.slice(0, 60) + '…）')
    return
  }
  console.log('   （引擎：' + engines.available.join(' + ') + '）')

  // 造视频：只有 cv2 能无中生有地写 mp4；ffmpeg 场景用 lavfi 的 testsrc 类源不方便做绿幕，
  // 所以这里统一用 python+cv2 造素材，再用被验证的引擎去读它。
  const videoPath = join(tmp, 'greenscreen.mp4')
  if (!engines.cv2.ok) {
    skipped('造测试视频', '需要 python+opencv 才能无中生有造一段绿幕 mp4')
    return
  }
  const pyFile = join(tmp, 'gen_video.py')
  await writeFile(pyFile, PY_GEN, 'utf8')
  const r = spawnSync(engines.cv2.python, [pyFile, videoPath], { encoding: 'utf8', windowsHide: true })
  check(existsSync(videoPath), '测试视频生成成功', r.stdout.trim().slice(0, 40))

  const info = await video.probeVideo({ video: videoPath })
  check(info.ok === true, 'probeVideo 能读出元信息', info.ok ? `${info.width}×${info.height} · ${info.duration}s · ${info.fps}fps` : info.error)

  const pkg = join(tmp, 'pets', 'green-pet')
  const res = await video.buildPetFromVideo(pkg, {
    video: videoPath,
    segments: 'idle:0-2,waving:2-4,jumping:4-6',
    name: '绿幕测试宠',
    id: 'green-pet',
    fps: 12,
    frames: 6,
    maxWidth: 480,
  })
  check(res.ok === true, '整条流水线跑通并通过严格校验',
    res.ok ? res.human : (res.error || JSON.stringify(res.validation && res.validation.errors)))
  if (!res.ok) return

  const atlas = await decodeImage(await readFile(join(pkg, 'atlas.png')))
  check(atlas.width === 8 * 192 && atlas.height === 11 * 208, '图集尺寸严格 1536×2288', `${atlas.width}×${atlas.height}`)
  const manifest = JSON.parse(await readFile(join(pkg, 'pet.json'), 'utf8'))
  check(manifest.states.idle && manifest.states.idle.row === 0 && manifest.states.idle.frames === 6, 'idle 落在 0 行 6 帧')
  check(manifest.states.waving && manifest.states.waving.row === 3, 'waving 落在 3 行')
  check(manifest.states.jumping && manifest.states.jumping.row === 4, 'jumping 落在 4 行')
  check(manifest.source && manifest.source.kind === 'video', 'pet.json 里记下了来源是视频')
  check(!manifest.states.look, '没有伪造 look（视频做不了 16 方向视线）')

  // 抠像质量：整行 6 格里绿色残留必须极低
  let worstResidue = 0
  for (const row of [0, 3, 4]) {
    for (let c = 0; c < 6; c++) {
      const cell = cellAt(atlas, row, c, 192, 208)
      worstResidue = Math.max(worstResidue, greenResidue(cell))
      const ratio = opaqueRatio(cell)
      if (c === 0) check(ratio > 0.02 && ratio < 0.9, `第 ${row} 行有角色且不是整格实心`, `不透明占比 ${(ratio * 100).toFixed(1)}%`)
    }
  }
  check(worstResidue < 0.03, '所有关键格子里几乎没有绿色残留（抠像干净）', `最高 ${(worstResidue * 100).toFixed(2)}%`)

  // 动作真的在动：行内相邻帧必须有差异，行间整体姿态必须不同
  const rowDiff = (row) => {
    let acc = 0
    for (let c = 1; c < 6; c++) acc += meanDiff(cellAt(atlas, row, c - 1, 192, 208), cellAt(atlas, row, c, 192, 208))
    return acc / 5
  }
  check(rowDiff(3) > 0.4, 'waving 行里各帧确实在动', `帧间平均差 ${rowDiff(3).toFixed(2)}`)
  // 拿"一行里站得最高的那一帧"比：跳跃段的**第一帧**是刚起跳的瞬间（和待机一样高），
  // 拿它比会得出"两行一样"的错误结论（踩过），必须取整行的最高姿态。
  const idleTop = minCentroidY([0, 1, 2, 3, 4, 5].map((c) => cellAt(atlas, 0, c, 192, 208)))
  const jumpTop = minCentroidY([0, 1, 2, 3, 4, 5].map((c) => cellAt(atlas, 4, c, 192, 208)))
  check(jumpTop < idleTop - 8,
    'jumping 行里确实有"跳起来"的帧（重心明显比待机高）',
    `idle 最高重心 Y ${idleTop.toFixed(1)} vs jumping ${jumpTop.toFixed(1)}`)

  // 自动取色：应当落在绿幕附近
  check(res.chroma && res.chroma.keySource === 'auto', '幕布色是自动取样得到的')
  check(res.chroma && res.chroma.key.g > 120 && res.chroma.key.r < 80, '取到的确实是绿色幕布',
    `${res.chroma.key.r},${res.chroma.key.g},${res.chroma.key.b}`)
  check(res.chroma.avgTransparentRatio > 0.5, '抠掉了大部分背景', `${(res.chroma.avgTransparentRatio * 100).toFixed(1)}%`)

  // 抽样图与抽帧留存
  check((res.samples || []).length >= 4 && res.samples.every((s) => existsSync(s)), '写出了肉眼可查的关键帧样张')
  check(existsSync(res.framesDir), '抽出来的原帧保留着（便于复查）', res.framesDir)

  // 手动指定幕布色 + 关掉抠像 + 每动作一段视频，三条分支都要能跑
  const pkg2 = join(tmp, 'pets', 'manual-key')
  const res2 = await video.buildPetFromVideo(pkg2, {
    framesDir: join(pkg, 'video-frames', 'all'),
    segments: 'idle:0-2,waving:2-4',
    key: '0x00B140',
    name: '手填幕布色',
    id: 'manual-key',
    fps: 12,
  })
  check(res2.ok === true, '用 --frames-dir + 手填幕布色 也能跑通（不走解码器）', res2.ok ? res2.human : res2.error)
  check(res2.chroma && res2.chroma.keySource === 'explicit', '手填的幕布色被标记为 explicit')

  const res3 = await video.buildPetFromVideo(join(tmp, 'pets', 'no-key'), {
    framesDir: join(pkg, 'video-frames', 'all'),
    segments: 'idle:0-3',
    noKey: true,
    name: '不抠像',
    id: 'no-key',
    fps: 12,
  })
  check(res3.ok === true, '--no-key（不抠像）时原样导入', res3.ok ? res3.human : res3.error)

  // ---- CLI 层的两条回归 ----------------------------------------------------
  //
  // 上面两条测的是**库**：res3 传的是 noKey:true，正好绕开了下面这两条真实出过问题
  // 的路径。dsh-pet-video 技能里专门写了"要靠复制一份 forge 打补丁来绕开这两个 bug"，
  // 现在 bug 修在这里，就得有测试守住，否则补丁脚本会重新变得"必要"。
  //
  // ① CLI 的 --no-key 会把 key 翻成 'none'，而 parseChromaColor('none') 返回 null。
  //    以前先解析颜色再算 noKey，于是 'none' 会在"无法理解的幕布颜色"那行直接退出。
  // ② forge.mjs 判断"有没有 --frames-dir"时查的是 args.framesDir，而 parseArgs
  //    产出的是带横线的 'frames-dir'，恒为 undefined。于是**没有解码引擎**的机器
  //    即使手里已经有抽好的 PNG 帧，也会被判"导不了视频"。
  //    这里用不存在的 --ffmpeg/--python 强制探不到引擎，把那条退路真正走一遍。
  const forgeBin = join(REPO, 'skill', 'dsh-pet-forge', 'scripts', 'forge.mjs')
  const cliFrames = join(pkg, 'video-frames', 'all')
  const runVideoCli = (outDir, extra) => {
    const r = spawnSync(process.execPath, [
      forgeBin, 'video', '--pkg', outDir, '--frames-dir', cliFrames, '--segments', 'idle:0-3', ...extra,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    let json = null
    try { json = JSON.parse(r.stdout) } catch { /* 下面是断言的事 */ }
    return { status: r.status, json, stderr: String(r.stderr || '') }
  }

  const bogus = join(tmp, 'no-such-engine')
  const cliA = runVideoCli(join(tmp, 'pets', 'cli-frames-noengine'),
    ['--ffmpeg', bogus + '.exe', '--python', bogus + '.exe'])
  check(cliA.status === 0 && cliA.json && cliA.json.ok === true,
    'CLI：探不到任何解码引擎时 --frames-dir 依然可用（退路不再是死代码）',
    cliA.json ? (cliA.json.human || cliA.json.error) : ('exit=' + cliA.status + ' ' + cliA.stderr.slice(0, 160)))

  const cliB = runVideoCli(join(tmp, 'pets', 'cli-no-key'), ['--no-key'])
  check(cliB.status === 0 && cliB.json && cliB.json.ok === true,
    'CLI：--no-key 真的走得通（key=none 不再被当成无法理解的颜色）',
    cliB.json ? (cliB.json.human || cliB.json.error) : ('exit=' + cliB.status + ' ' + cliB.stderr.slice(0, 160)))

  // 抠像把角色也抠掉时，必须明确报错（而不是产出空白宠物）
  const res4 = await video.buildPetFromVideo(join(tmp, 'pets', 'bad-key'), {
    framesDir: join(pkg, 'video-frames', 'all'),
    segments: 'idle:0-3',
    key: '0x00B140',
    similarity: 0.9,      // 阈值开这么大 = 把角色也一起算成幕布色
    blend: 0.3,
    name: '抠过头',
    id: 'bad-key',
    fps: 12,
  })
  check(res4.ok === false && /抠掉了/.test(String(res4.error)), '阈值开太大把角色抠没了时明确报错',
    String(res4.error).slice(0, 70))

  // 时间段非法要提前拦住
  const res5 = await video.buildPetFromVideo(join(tmp, 'pets', 'bad-seg'), {
    video: videoPath, segments: 'idle:99-100', name: '越界', id: 'bad-seg',
  })
  check(res5.ok === false && /时间段|超过/.test(String(res5.error)), '时间段超出视频长度时明确报错', String(res5.error).slice(0, 70))
}

// ---------------------------------------------------------------- 3. 无解码器路径
async function section3(tmp) {
  console.log('\n[3] 无解码器路径：直接喂 PNG 帧')
  const dir = join(tmp, 'frames')
  await mkdir(dir, { recursive: true })
  for (let i = 0; i < 12; i++) {
    const img = greenScreenFrame({ cx: 100 + i * 4, cy: 110 - (i % 4) * 6 })
    await writeFile(join(dir, `f_${String(i).padStart(3, '0')}.png`), encodeImage(img))
  }
  const engines = await video.probeEngines({ force: true })
  const pkg = join(tmp, 'pets', 'from-frames')
  const res = await video.buildPetFromVideo(pkg, {
    framesDir: dir,
    segments: 'idle:0-0.5,waving:0.5-1',
    fps: 12,
    name: '帧导入宠',
    id: 'from-frames',
    engine: engines.available.length ? undefined : 'frames',
  })
  check(res.ok === true, '一堆 PNG 帧也能出宠物包（不需要任何解码器）', res.ok ? res.human : res.error)
  if (res.ok) {
    const v = await manifestLib.validatePackage(pkg, JSON.parse(await readFile(join(pkg, 'pet.json'), 'utf8')))
    check(v.ok === true, '产物通过严格校验', v.ok ? '' : v.errors.join('；'))
  }
}

// ---------------------------------------------------------------- 主流程
const main = async () => {
  const args = process.argv.slice(2)
  const keep = args.includes('--keep')
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-pet-video-'))
  console.log('dsh-pet-forge · 视频转桌宠验证')
  console.log('临时目录：' + tmp)
  try {
    section1()
    await section2(tmp)
    await section3(tmp)
  } finally {
    if (!keep) await rm(tmp, { recursive: true, force: true })
  }
  console.log('')
  const tail = skip ? `（跳过 ${skip} 段）` : ''
  console.log(fail === 0 ? `✅ 全部通过（${pass} 项）${tail}` : `❌ ${fail} 项失败 / 共 ${pass + fail} 项`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('验证脚本自身出错：', err && err.stack || err)
  process.exit(1)
})
