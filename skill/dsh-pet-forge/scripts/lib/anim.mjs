// =============================================================================
// dsh-pet-forge · 动画渲染器
// -----------------------------------------------------------------------------
// 输入：一张已规范化到严格 cellW×cellH 的基础帧（角色水平居中、脚底对齐）。
// 输出：每一行（动作）的一组帧，尺寸**严格等于** cellW×cellH。
//
// 两档动画：
//   Tier A 程序化（零成本、离线可用）：整身变换 + 上下半身分带错相，做出呼吸、
//          奔跑、跳跃、摔倒、挥手、思考等动作。适合"一张主图直接出桌宠"。
//   Tier B 生图多帧：让生图模型直接给 4 帧姿态条带，切片后规范化再合成，
//          动作更真实；成本是每动作一次生图。
// 两者最终都走同一套 fitToCell + composeAtlas，因此**契约一致**。
// =============================================================================

import {
  newImg, cloneImg, composite, resize, flipX, translate, scaleAlpha, fitToCell, alphaBounds, crop, trim,
} from './imaging.mjs'

const TAU = Math.PI * 2

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
const easeOut = (t) => 1 - Math.pow(1 - t, 3)
const easeIn = (t) => t * t * t
const lerp = (a, b, t) => a + (b - a) * t

/**
 * 通用仿射变形（对整格做逆映射 + 双线性采样）。
 * 前向：dst = R(θ)·S(sx,sy)·(src − anchor) + anchor + (dx,dy)
 * @param {object} base  cellW×cellH
 * @param {object} p     { scaleX, scaleY, rotate(度), dx, dy, flipX, anchorX, anchorY, opacity }
 */
export function warpCell(base, p = {}) {
  const w = base.width
  const h = base.height
  const sx = p.scaleX ?? 1
  const sy = p.scaleY ?? 1
  const rad = ((p.rotate ?? 0) * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const flip = p.flipX ? -1 : 1
  const ax = p.anchorX ?? w / 2
  const ay = p.anchorY ?? h
  const dx = p.dx ?? 0
  const dy = p.dy ?? 0
  const opacity = p.opacity ?? 1

  const a = cos * sx * flip
  const b = -sin * sy
  const c = sin * sx * flip
  const d = cos * sy
  const det = a * d - b * c
  if (Math.abs(det) < 1e-9) return cloneImg(base)
  const ia = d / det
  const ib = -b / det
  const ic = -c / det
  const id = a / det

  const out = newImg(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x - ax - dx
      const py = y - ay - dy
      const fx = ia * px + ib * py + ax
      const fy = ic * px + id * py + ay
      if (fx < -1 || fy < -1 || fx > w || fy > h) continue
      const o = (y * w + x) * 4
      const x0 = Math.floor(fx)
      const y0 = Math.floor(fy)
      const tx = fx - x0
      const ty = fy - y0
      let acc = [0, 0, 0, 0]
      let wsum = 0
      for (let k = 0; k < 4; k++) {
        const sxp = x0 + (k & 1)
        const syp = y0 + (k >> 1)
        if (sxp < 0 || syp < 0 || sxp >= w || syp >= h) continue
        const ww = ((k & 1) ? tx : 1 - tx) * ((k >> 1) ? ty : 1 - ty)
        if (ww <= 0) continue
        const si = (syp * w + sxp) * 4
        acc[0] += base.data[si] * ww
        acc[1] += base.data[si + 1] * ww
        acc[2] += base.data[si + 2] * ww
        acc[3] += base.data[si + 3] * ww
        wsum += ww
      }
      if (wsum <= 0) continue
      out.data[o] = Math.round(acc[0] / wsum)
      out.data[o + 1] = Math.round(acc[1] / wsum)
      out.data[o + 2] = Math.round(acc[2] / wsum)
      out.data[o + 3] = Math.round((acc[3] / wsum) * opacity)
    }
  }
  return out
}

/** 生成一个纵向遮罩：y<=y0 全 1，y0..y1 线性降到 0，y>=y1 全 0。 */
function verticalMask(w, h, y0, y1) {
  const m = new Float32Array(w * h)
  const span = Math.max(1, y1 - y0)
  for (let y = 0; y < h; y++) {
    let v = 1
    if (y >= y1) v = 0
    else if (y > y0) v = 1 - (y - y0) / span
    for (let x = 0; x < w; x++) m[y * w + x] = v
  }
  return m
}

/** 用浮点遮罩乘 alpha 后返回新图。 */
function applyMask(img, mask) {
  const out = cloneImg(img)
  for (let i = 0, p = 0; i < out.data.length; i += 4, p++) {
    out.data[i + 3] = Math.round(out.data[i + 3] * mask[p])
  }
  return out
}

/**
 * 分带变形：上下半身用不同参数，接缝处羽化混合。
 * 用于跑动/跳跃时让"腿"和"身体"错相，比整身刚性位移自然得多。
 */
export function warpCellBanded(base, opts) {
  const w = base.width
  const h = base.height
  const splitY = Math.round((opts.splitY ?? 0.62) * h)
  const blend = Math.max(2, Math.round(opts.blend ?? h * 0.06))
  const upper = warpCell(base, opts.upper || {})
  const lower = warpCell(base, opts.lower || {})
  const upMask = verticalMask(w, h, splitY - blend, splitY)
  const lowMask = verticalMask(w, h, h, h - 0) // 全 1 的底图
  for (let i = 0; i < lowMask.length; i++) lowMask[i] = 1 - upMask[i]
  const out = newImg(w, h)
  composite(out, applyMask(lower, lowMask), 0, 0)
  composite(out, applyMask(upper, upMask), 0, 0)
  return out
}

// ---------- 动作库 ----------

/**
 * 每个动作返回 frames 个变形参数。
 * 约定：anchorX = 格子中线，anchorY = 格子底边（脚底）。
 */
export const ACTION_LIBRARY = {
  idle: {
    frames: 6,
    fps: 6,
    label: '待机呼吸',
    hint: '轻微上下起伏，安静地陪着你',
    params: (i, n) => {
      const t = i / n
      const breathe = (1 - Math.cos(TAU * t)) / 2
      return { dy: -1.5 * breathe, scaleY: 1 + 0.018 * breathe, scaleX: 1 - 0.010 * breathe }
    },
  },
  runRight: {
    frames: 8,
    fps: 12,
    label: '向右跑',
    hint: '被拖着走时的奔跑动作',
    params: (i, n) => {
      const t = i / n
      const step = Math.sin(TAU * t)
      return {
        rotate: 6,
        dx: 0,
        dy: -Math.abs(Math.sin(TAU * t * 2)) * 3.5,
        scaleY: 1 + 0.03 * Math.abs(step),
        banded: true,
        splitY: 0.6,
        lower: { rotate: 6 + step * 6, dx: step * 2.5, dy: -Math.abs(step) * 2, scaleY: 1 - 0.02 * step },
        upper: { rotate: 6 - step * 3, dy: -Math.abs(step) * 3, scaleY: 1 + 0.02 * step },
      }
    },
  },
  waving: {
    frames: 4,
    fps: 8,
    label: '挥手打招呼',
    hint: '空闲时向你挥手',
    params: (i, n) => {
      const t = i / n
      const s = Math.sin(TAU * t)
      return {
        rotate: s * 5,
        dx: s * 2,
        dy: -Math.abs(s) * 1.5,
        scaleX: 1 + 0.02 * Math.abs(s),
        banded: true,
        splitY: 0.34,
        upper: { rotate: s * 9, dx: s * 3.5, scaleX: 1 + 0.03 * Math.abs(s) },
        lower: { rotate: s * 1.5, dx: s * 1 },
      }
    },
  },
  jumping: {
    frames: 5,
    fps: 10,
    label: '跳跃庆祝',
    hint: '任务完成时跳起来',
    params: (i, n) => {
      const t = i / (n - 1 || 1)
      const up = Math.sin(Math.PI * t)
      const landing = t > 0.75 ? (t - 0.75) / 0.25 : 0
      return {
        dy: -22 * up,
        scaleY: 1 + 0.10 * up - 0.14 * landing,
        scaleX: 1 - 0.06 * up + 0.12 * landing,
        rotate: Math.sin(TAU * t) * 5,
      }
    },
  },
  failed: {
    frames: 8,
    fps: 12,
    label: '摔倒/出错',
    hint: '报错时戏剧性地倒下',
    params: (i, n) => {
      const t = i / (n - 1 || 1)
      const fall = easeIn(Math.min(1, t / 0.55))
      const bounce = t > 0.55 ? Math.max(0, 1 - (t - 0.55) / 0.2) * 5 : 0
      return {
        rotate: fall * 82,
        anchorY: undefined,
        dy: fall * 6 - bounce,
        scaleY: 1 - 0.03 * fall,
        shake: true,
        dx: t > 0.6 ? Math.sin((t - 0.6) * 90) * (1 - t) * 5 : 0,
      }
    },
  },
  waiting: {
    frames: 6,
    fps: 5,
    label: '等待回复',
    hint: '等你输入时耐心地看着你',
    params: (i, n) => {
      const t = i / n
      const s = Math.sin(TAU * t)
      return { dy: -2.5 * (1 - Math.cos(TAU * t)) / 2, scaleY: 1 + 0.022 * (1 - Math.cos(TAU * t)) / 2, rotate: s * 2 }
    },
  },
  running: {
    frames: 6,
    fps: 12,
    label: '颠球/专注工作',
    hint: 'Agent 干活时忙个不停',
    params: (i, n) => {
      const t = i / n
      const s = Math.abs(Math.sin(TAU * t))
      return {
        dy: -6 * s,
        scaleY: 1 - 0.05 * s,
        scaleX: 1 + 0.045 * s,
        rotate: Math.sin(TAU * t * 2) * 3,
      }
    },
  },
  review: {
    frames: 6,
    fps: 6,
    label: '思考/审阅',
    hint: 'Agent 想事情时歪着头',
    params: (i, n) => {
      const t = i / n
      const s = Math.sin(TAU * t)
      return {
        rotate: -4 + s * 4,
        dy: -1.5 * Math.abs(s),
        banded: true,
        splitY: 0.3,
        upper: { rotate: -4 + s * 7, dx: s * 1.5 },
        lower: { rotate: s * 1 },
      }
    },
  },
  look: {
    frames: 16,
    fps: 4,
    label: '视线跟随光标',
    hint: '16 个方向，用轻微位移+倾斜模拟注视（2D 素材友好）',
    params: (i, n) => {
      const angle = (i / n) * TAU
      return {
        dx: Math.sin(angle) * 3.5,
        dy: -Math.cos(angle) * 2.5,
        rotate: Math.sin(angle) * 3.5,
        scaleX: 1 + Math.max(0, -Math.cos(angle)) * 0.01,
      }
    },
  },
}

/** 契约行号（与 docs/SPRITESHEET-CONTRACT.md 一致）。 */
export const STATE_ROWS = {
  idle: 0,
  runRight: 1,
  runLeft: 2,
  waving: 3,
  jumping: 4,
  failed: 5,
  waiting: 6,
  running: 7,
  review: 8,
  look: 9, // 占用 9 与 10 两行
}

/** 默认推荐动作组合（多轮询问时作为"推荐"选项）。 */
export const RECOMMENDED_ACTIONS = ['idle', 'running', 'review', 'waiting', 'jumping', 'failed']
export const ALL_ACTIONS = ['idle', 'runRight', 'runLeft', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review', 'look']

/**
 * 渲染一个动作的所有帧。
 * @param {object} baseCell cellW×cellH 规范化基础帧
 * @param {string} action
 * @param {object} [opts] { frames, flipX }
 * @returns {object[]} 帧数组，每帧严格 cellW×cellH
 */
export function renderAction(baseCell, action, opts = {}) {
  const spec = ACTION_LIBRARY[action]
  if (!spec) throw new Error(`未知动作：${action}`)
  const n = Math.max(1, opts.frames ?? spec.frames)
  const frames = []
  for (let i = 0; i < n; i++) {
    const p = spec.params(i, n) || {}
    let img
    if (p.banded) {
      const upper = { ...p.upper, anchorX: p.anchorX, anchorY: p.anchorY, flipX: opts.flipX }
      const lower = { ...p.lower, anchorX: p.anchorX, anchorY: p.anchorY, flipX: opts.flipX }
      const common = { flipX: opts.flipX, anchorX: p.anchorX, anchorY: p.anchorY }
      img = warpCellBanded(baseCell, {
        splitY: p.splitY,
        blend: p.blend,
        upper: { ...common, ...upper },
        lower: { ...common, ...lower },
      })
    } else {
      img = warpCell(baseCell, { ...p, flipX: opts.flipX })
    }
    frames.push(img)
  }
  return frames
}

/**
 * 从"多帧素材"（生图条带切片结果）渲染一个动作。
 * 帧数不足时按需插帧（在相邻帧之间做交叉淡化式变形过渡），保证动画平滑。
 */
export function renderActionFromFrames(baseFrames, opts = {}) {
  const target = Math.max(1, opts.frames ?? baseFrames.length)
  if (baseFrames.length === 0) throw new Error('renderActionFromFrames: 没有可用帧')
  const out = []
  for (let i = 0; i < target; i++) {
    const src = (i / target) * baseFrames.length
    const i0 = Math.floor(src) % baseFrames.length
    const i1 = (i0 + 1) % baseFrames.length
    const t = src - Math.floor(src)
    if (baseFrames.length === 1 || t < 1e-3) { out.push(cloneImg(baseFrames[i0])); continue }
    // 相邻帧做 alpha 加权混合，避免生图帧之间跳变
    const mixed = cloneImg(baseFrames[i0])
    const other = baseFrames[i1]
    for (let k = 0; k < mixed.data.length; k += 4) {
      for (let c = 0; c < 4; c++) {
        mixed.data[k + c] = Math.round(mixed.data[k + c] * (1 - t) + other.data[k + c] * t)
      }
    }
    out.push(mixed)
  }
  return out
}

// ---------- 图集合成 ----------

/**
 * 合成完整图集。
 * @param {object} opts
 *   cols, rows, cellW, cellH
 *   rowFrames: { [rowIndex]: Image[] }  行号 → 该行从左往右的帧
 * @returns {{img:object, warnings:string[]}}
 */
export function composeAtlas(opts) {
  const { cols, rows, cellW, cellH } = opts
  const atlasW = cols * cellW
  const atlasH = rows * cellH
  const atlas = newImg(atlasW, atlasH)
  const warnings = []
  const entries = Object.entries(opts.rowFrames || {})
  for (const [rowKey, frames] of entries) {
    const row = Number(rowKey)
    if (!Number.isInteger(row) || row < 0 || row >= rows) {
      warnings.push(`行号 ${rowKey} 超出图集范围（0..${rows - 1}），已跳过`)
      continue
    }
    if (!Array.isArray(frames)) continue
    if (frames.length > cols) {
      warnings.push(`第 ${row} 行帧数 ${frames.length} 超过列数 ${cols}，多余帧已丢弃`)
    }
    for (let c = 0; c < Math.min(cols, frames.length); c++) {
      const f = frames[c]
      if (!f) continue
      if (f.width !== cellW || f.height !== cellH) {
        warnings.push(`第 ${row} 行第 ${c} 帧尺寸 ${f.width}×${f.height} ≠ 格子 ${cellW}×${cellH}，已强制缩放`)
        composite(atlas, resize(f, cellW, cellH), c * cellW, row * cellH)
      } else {
        composite(atlas, f, c * cellW, row * cellH)
      }
    }
  }
  return { img: atlas, warnings }
}

/**
 * 图集自检：逐格检查是否落在格子里、是否出现"跨格串帧"的典型症状。
 * 串帧检测：检查每格边缘 1px 是否有非透明像素（一般说明角色被切到边界外）。
 */
export function auditAtlas(atlas, opts) {
  const { cols, rows, cellW, cellH } = opts
  const problems = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let edgeBleed = 0
      for (let x = 0; x < cellW; x++) {
        for (const y of [0, cellH - 1]) {
          const i = ((r * cellH + y) * atlas.width + (c * cellW + x)) * 4
          if (atlas.data[i + 3] > 24) edgeBleed++
        }
      }
      for (let y = 0; y < cellH; y++) {
        for (const x of [0, cellW - 1]) {
          const i = ((r * cellH + y) * atlas.width + (c * cellW + x)) * 4
          if (atlas.data[i + 3] > 24) edgeBleed++
        }
      }
      if (edgeBleed > Math.max(6, (cellW + cellH) * 0.06)) {
        problems.push({
          row: r,
          col: c,
          type: 'edge-bleed',
          detail: `第 ${r} 行第 ${c} 列在格子边缘有 ${edgeBleed} 个非透明像素，可能被裁切或跨格串帧`,
        })
      }
    }
  }
  return problems
}

/** 生成 16 方向 look 行：返回 [rowA(8 帧), rowB(8 帧)]。 */
export function renderLookRows(baseCell, opts = {}) {
  const frames = renderAction(baseCell, 'look', { frames: 16 })
  const a = frames.slice(0, 8)
  const b = frames.slice(8, 16)
  if (opts.mirrorFallback) {
    return [a.map((f) => f), b.map((f) => flipX(f))]
  }
  return [a, b]
}

// =============================================================================
// 两趟渲染：先在大画布上把所有动作都跑一遍，量出"全体帧的并集包围盒"，
// 再据此算出一个**统一缩放与落位**，把每一帧映射进严格 cellW×cellH 的格子。
//
// 为什么必须两趟：跳跃会把角色抬高 34px、摔倒会旋转 80° 把身体甩到侧面，
// 如果直接把基础帧按格子尺寸归一化，这些动作必然被格子边界裁掉——表现为
// "宠物一跳就缺头""摔倒时半个身子没了"，这正是需要从流程上根除的毛病。
// 并集包围盒保证**没有任何一帧会被裁切**，且所有动作共用同一缩放，体型一致。
// =============================================================================

/** 把角色图放进一张大工作画布，脚底对齐到 anchorY，水平居中于 anchorX。 */
function placeInWorkingCanvas(img, opts) {
  const { W, H, anchorX, anchorY, maxW, maxH } = opts
  const trimmed = trim(img, 0)
  const k = Math.min(maxW / trimmed.width, maxH / trimmed.height)
  const rw = Math.max(1, Math.round(trimmed.width * k))
  const rh = Math.max(1, Math.round(trimmed.height * k))
  const scaled = resize(trimmed, rw, rh)
  const canvas = newImg(W, H)
  composite(canvas, scaled, Math.round(anchorX - rw / 2), Math.round(anchorY - rh))
  return canvas
}

/** 计算一组帧的并集 alpha 包围盒。
 *  导出给 3D 装配用：Blender 是直接按格渲染的，跳跃/摔倒会把模型顶出画面，
 *  所以那边也要用同一套"并集包围盒 + 统一缩放"来保证不裁切。 */
export function unionBounds(frames, threshold = 6) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -1
  let maxY = -1
  for (const f of frames) {
    const b = alphaBounds(f, threshold)
    if (b === null) continue
    if (b.x < minX) minX = b.x
    if (b.y < minY) minY = b.y
    if (b.x + b.width - 1 > maxX) maxX = b.x + b.width - 1
    if (b.y + b.height - 1 > maxY) maxY = b.y + b.height - 1
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/**
 * 把"工作画布坐标"的一组帧映射到严格 cellW×cellH 的格子。
 * 所有帧共享同一 bbox 与缩放，因此**帧间相对位移被精确保留**。
 * 导出给 3D 装配复用。
 */
export function projectFrames(frames, bbox, opts) {
  const { cellW, cellH, padX, topPad, footPad } = opts
  const availW = Math.max(1, cellW - padX * 2)
  const availH = Math.max(1, cellH - topPad - footPad)
  const k = Math.min(availW / bbox.width, availH / bbox.height, opts.maxScale ?? 1.3)
  const rw = Math.max(1, Math.round(bbox.width * k))
  const rh = Math.max(1, Math.round(bbox.height * k))
  const x = Math.round((cellW - rw) / 2)
  const y = Math.round(cellH - footPad - rh)
  return frames.map((f) => {
    const region = crop(f, bbox.x, bbox.y, bbox.width, bbox.height)
    const scaled = resize(region, rw, rh)
    const cell = newImg(cellW, cellH)
    composite(cell, scaled, x, y)
    return cell
  })
}

/** 行号 → 动作名（look 特殊：占 9、10 两行）。 */
export const ACTION_TO_ROW = {
  idle: 0, runRight: 1, runLeft: 2, waving: 3, jumping: 4,
  failed: 5, waiting: 6, running: 7, review: 8,
}

/**
 * 主入口：从一张基础角色图渲染出整张图集所需的各行帧。
 *
 * @param {object} baseImg 已抠底的角色图（任意尺寸，内部会规范化）
 * @param {object} opts
 *   cellW, cellH        目标格子尺寸（契约默认 192×208）
 *   cols                列数（默认 8）
 *   actions             要渲染的动作数组（默认推荐组合）
 *   framesOverride      { [action]: n } 覆盖帧数
 *   looseActions        单独缩放的"大幅位移"动作（默认 ['failed']，避免摔倒把全员缩小）
 *   backgroundMode      传给 removeBackground（此函数不调用，由上层处理）
 * @returns {{rowFrames:Object, report:Object}}
 */
export function renderPetRows(baseImg, opts = {}) {
  const cellW = opts.cellW ?? 192
  const cellH = opts.cellH ?? 208
  const cols = opts.cols ?? 8
  const actions = opts.actions || RECOMMENDED_ACTIONS
  const loose = new Set(opts.looseActions || ['failed'])
  const framesOverride = opts.framesOverride || {}

  const padX = Math.round(cellW * (opts.padX ?? 0.03))
  const topPad = Math.round(cellH * (opts.topPad ?? 0.03))
  const footPad = Math.round(cellH * (opts.footPad ?? 0.04))

  // 工作画布：留足空间让旋转/抬升不被截断
  const W = Math.round(cellW * 2)
  const H = Math.round(cellH * 2)
  const anchorX = Math.round(W / 2)
  const footAnchorY = Math.round(H - H * 0.08)

  const working = placeInWorkingCanvas(baseImg, {
    W, H, anchorX, anchorY: footAnchorY,
    maxW: cellW * 0.94,
    maxH: cellH * 0.94,
  })

  const anchor = { anchorX, anchorY: footAnchorY }

  // ---- 第一趟：渲染 ----
  const raw = {}
  const spec = {}
  for (const action of actions) {
    if (action === 'look') {
      const f = renderAction(working, 'look', { frames: 16 }).map((x) => ({ ...anchor, img: x }))
      raw.look = f
      spec.look = { kind: 'look' }
      continue
    }
    const lib = ACTION_LIBRARY[action]
    if (!lib) continue
    const n = Math.max(1, Math.min(cols, framesOverride[action] ?? lib.frames))
    raw[action] = renderAction(working, action, { frames: n }).map((x) => ({ ...anchor, img: x }))
    spec[action] = { frames: n, fps: lib.fps }
  }

  // ---- 计算统一缩放 ----
  const strictFrames = []
  for (const [name, list] of Object.entries(raw)) {
    if (loose.has(name)) continue
    for (const it of list) strictFrames.push(it.img)
  }
  let bbox = unionBounds(strictFrames)
  if (bbox === null) bbox = unionBounds(Object.values(raw).flat().map((it) => it.img))
  if (bbox === null) throw new Error('renderPetRows: 基础图全透明，无法渲染任何动作')

  const report = { bbox, cellW, cellH, actions: {}, notes: [] }
  const rowFrames = {}
  const projectOpts = { cellW, cellH, padX, topPad, footPad }

  for (const [name, list] of Object.entries(raw)) {
    const imgs = list.map((it) => it.img)
    const own = loose.has(name) ? unionBounds(imgs) : null
    const use = own || bbox
    const cells = projectFrames(imgs, use, projectOpts)
    const k = Math.min((cellW - padX * 2) / use.width, (cellH - topPad - footPad) / use.height, 1.3)
    report.actions[name] = {
      frames: cells.length,
      scale: Number(k.toFixed(4)),
      bbox: use,
      loose: loose.has(name),
    }
    if (name === 'look') {
      rowFrames[9] = cells.slice(0, 8)
      rowFrames[10] = cells.slice(8, 16)
    } else {
      const row = ACTION_TO_ROW[name]
      if (row !== undefined) rowFrames[row] = cells
    }
  }

  // runLeft：默认用 runRight 镜像（省一半渲染，且左右完全对称）
  if (opts.mirrorRunLeft !== false && raw.runRight && !raw.runLeft) {
    rowFrames[2] = (rowFrames[1] || []).map((f) => flipX(f))
    report.notes.push('runLeft 由 runRight 水平镜像生成')
  }
  // idle 兜底：任何情况下都必须有 idle
  if (!rowFrames[0]) {
    const idle = projectFrames(renderAction(working, 'idle', { frames: 6 }), bbox, projectOpts)
    rowFrames[0] = idle
    report.notes.push('未指定 idle，已自动补上')
  }

  return { rowFrames, report, working }
}

export { fitToCell, alphaBounds, translate, scaleAlpha }
export { warpCell as default }

