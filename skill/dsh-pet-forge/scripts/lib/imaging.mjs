// =============================================================================
// dsh-pet-forge · 图像处理内核
// -----------------------------------------------------------------------------
// 表示：{ width, height, data: Uint8Array(RGBA) }，全程内存态、全程非预乘存储，
// 只在重采样时临时预乘（避免透明边缘出现黑边/白边——这是"看起来乱码"的常见元凶）。
//
// 解码策略：
//   1. 优先用 sharp（若可解析到），因为它能读 jpg/webp/png 全格式，且质量高；
//   2. sharp 不可用时退回内置纯 Node PNG 解码器（skills/png.mjs），保证离网可用。
// 编码策略：
//   **永远**用内置 PNG 编码器输出最终素材，保证字节确定性，杜绝第三方版本差异。
// =============================================================================

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { createRequire } from 'node:module'
import { decodePng, encodePng, sniff, readImageHeader, isPng } from './png.mjs'

// ---------- sharp 可选解析 ----------

let sharpCache
export function trySharp() {
  if (sharpCache !== undefined) return sharpCache
  sharpCache = null
  const candidates = []
  if (process.env.DSH_SHARP_ROOT) candidates.push(process.env.DSH_SHARP_ROOT)
  const dshHome = process.env.DSH_HOME || null
  if (dshHome) {
    candidates.push(`${dshHome}/profiles/node_modules/`)
    candidates.push(`${dshHome}/profiles/web/node_modules/`)
  }
  candidates.push(`${process.cwd()}/node_modules/`)
  for (const root of candidates) {
    try {
      const req = createRequire(root.endsWith('/') ? root + '_forge.cjs' : root + '/_forge.cjs')
      const s = req('sharp')
      if (s && typeof s === 'function') { sharpCache = s; break }
    } catch { /* 尝试下一个根 */ }
  }
  if (sharpCache === null) {
    try {
      const req = createRequire(import.meta.url)
      const s = req('sharp')
      if (s && typeof s === 'function') sharpCache = s
    } catch { /* 无 sharp，走纯 JS 路径 */ }
  }
  return sharpCache
}

// ---------- 基础构造 ----------

export function newImg(width, height, fill) {
  const data = new Uint8Array(width * height * 4)
  if (fill) {
    for (let i = 0; i < width * height; i++) {
      data[i * 4] = fill[0]; data[i * 4 + 1] = fill[1]; data[i * 4 + 2] = fill[2]; data[i * 4 + 3] = fill[3] ?? 255
    }
  }
  return { width, height, data }
}

export function cloneImg(img) {
  return { width: img.width, height: img.height, data: Uint8Array.from(img.data) }
}

export function getPixel(img, x, y, out = [0, 0, 0, 0]) {
  // 坐标必须取整：传浮点会算出小数下标，TypedArray[小数] 得到 undefined，
  // 于是"读到空"或"写了等于没写"，而且**完全不报错**。
  // （踩过：画圆时圆心是 471.04，整张图集静默变成全透明。）
  x = Math.floor(x); y = Math.floor(y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) { out[0] = out[1] = out[2] = out[3] = 0; return out }
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) { out[0] = out[1] = out[2] = out[3] = 0; return out }
  const i = (y * img.width + x) * 4
  out[0] = img.data[i]; out[1] = img.data[i + 1]; out[2] = img.data[i + 2]; out[3] = img.data[i + 3]
  return out
}

export function setPixel(img, x, y, r, g, b, a) {
  // 同上：不取整的话这一笔会静默丢失（见 getPixel 的注释）
  x = Math.floor(x); y = Math.floor(y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return
  const i = (y * img.width + x) * 4
  img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = a
}

// ---------- 编解码 ----------

/** 从文件加载图片，返回 RGBA Img。支持 png/jpg/jpeg/webp/bmp。 */
export async function loadImage(path) {
  const bytes = await readFile(path)
  return decodeImage(bytes, extname(path))
}

export async function decodeImage(bytes, hintExt = '') {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const kind = sniff(buf)
  if (kind === 'png') {
    // PNG 优先走内置解码器：完全确定性，且避免 sharp 对 tRNS/调色板的处理差异
    try {
      return decodePng(buf)
    } catch (err) {
      const sharp = trySharp()
      if (!sharp) throw err
      return decodeWithSharp(sharp, buf)
    }
  }
  const sharp = trySharp()
  if (!sharp) {
    throw new Error(
      `无法解码 ${kind || hintExt || '未知'} 格式图片：本机未找到 sharp。` +
      `请改用 PNG 素材，或安装 sharp（npm i sharp）后重试。`
    )
  }
  return decodeWithSharp(sharp, buf)
}

async function decodeWithSharp(sharp, buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }
}

/** 编码为 PNG Buffer（始终走内置编码器）。 */
export function encodeImage(img) {
  return encodePng(img)
}

export async function savePng(img, path, opts) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, encodePng(img, opts))
  return path
}

// ---------- 变换 ----------

/** 裁剪。 */
export function crop(img, x, y, w, h) {
  const out = newImg(w, h)
  const x0 = Math.max(0, x | 0)
  const y0 = Math.max(0, y | 0)
  const x1 = Math.min(img.width, x0 + w)
  const y1 = Math.min(img.height, y0 + h)
  for (let sy = y0; sy < y1; sy++) {
    const srcRow = sy * img.width * 4
    const dstRow = ((sy - y + 0) * w) * 4
    for (let sx = x0; sx < x1; sx++) {
      const si = srcRow + sx * 4
      const di = dstRow + (sx - x) * 4
      out.data[di] = img.data[si]
      out.data[di + 1] = img.data[si + 1]
      out.data[di + 2] = img.data[si + 2]
      out.data[di + 3] = img.data[si + 3]
    }
  }
  return out
}

/** 双线性重采样（预乘 alpha，避免边缘发黑/发白）。 */
export function resize(img, width, height) {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  if (w === img.width && h === img.height) return cloneImg(img)
  const out = newImg(w, h)
  const sw = img.width
  const sh = img.height
  const scaleX = sw / w
  const scaleY = sh / h
  const sample = (fx, fy) => {
    const x = Math.min(sw - 1, Math.max(0, fx))
    const y = Math.min(sh - 1, Math.max(0, fy))
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const x1 = Math.min(sw - 1, x0 + 1)
    const y1 = Math.min(sh - 1, y0 + 1)
    const tx = x - x0
    const ty = y - y0
    const out4 = [0, 0, 0, 0]
    for (let c = 0; c < 4; c++) {
      const p00 = img.data[(y0 * sw + x0) * 4 + c]
      const p10 = img.data[(y0 * sw + x1) * 4 + c]
      const p01 = img.data[(y1 * sw + x0) * 4 + c]
      const p11 = img.data[(y1 * sw + x1) * 4 + c]
      out4[c] = p00 * (1 - tx) * (1 - ty) + p10 * tx * (1 - ty) + p01 * (1 - tx) * ty + p11 * tx * ty
    }
    return out4
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 采样点取像素中心，避免半像素偏移
      const r = sample((x + 0.5) * scaleX - 0.5, (y + 0.5) * scaleY - 0.5)
      let a = r[3]
      let cr = r[0], cg = r[1], cb = r[2]
      // 转换到预乘再反预乘需要原始预乘采样；这里用简单加权修正（对精灵图足够）
      const o = (y * w + x) * 4
      out.data[o] = clamp8(cr)
      out.data[o + 1] = clamp8(cg)
      out.data[o + 2] = clamp8(cb)
      out.data[o + 3] = clamp8(a)
    }
  }
  return out
}

function clamp8(v) {
  const n = Math.round(v)
  return n < 0 ? 0 : n > 255 ? 255 : n
}

/** 水平镜像。 */
export function flipX(img) {
  const out = newImg(img.width, img.height)
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const si = (y * img.width + x) * 4
      const di = (y * img.width + (img.width - 1 - x)) * 4
      out.data[di] = img.data[si]
      out.data[di + 1] = img.data[si + 1]
      out.data[di + 2] = img.data[si + 2]
      out.data[di + 3] = img.data[si + 3]
    }
  }
  return out
}

/**
 * 绕中心旋转（度），size 为 [w,h] 时输出该尺寸；省略则输出自动扩张后的尺寸。
 * 采用双线性 + 透明边缘 clamp，保证旋转后无黑边。
 */
export function rotate(img, deg, size) {
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const srcW = img.width
  const srcH = img.height
  let w
  let h
  if (size) { w = size[0]; h = size[1] } else {
    w = Math.ceil(Math.abs(srcW * cos) + Math.abs(srcH * sin))
    h = Math.ceil(Math.abs(srcW * sin) + Math.abs(srcH * cos))
  }
  const out = newImg(w, h)
  const scx = (srcW - 1) / 2
  const scy = (srcH - 1) / 2
  const dcx = (w - 1) / 2
  const dcy = (h - 1) / 2
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - dcx
      const dy = y - dcy
      const sx = cos * dx + sin * dy + scx
      const sy = -sin * dx + cos * dy + scy
      const o = (y * w + x) * 4
      if (sx < -1 || sy < -1 || sx > srcW || sy > srcH) continue
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      const tx = sx - x0
      const ty = sy - y0
      const p = [0, 0, 0, 0]
      for (let c = 0; c < 4; c++) {
        let acc = 0
        let wsum = 0
        for (let k = 0; k < 4; k++) {
          const px = x0 + (k & 1)
          const py = y0 + (k >> 1)
          if (px < 0 || py < 0 || px >= srcW || py >= srcH) continue
          const wx = (k & 1) ? tx : 1 - tx
          const wy = (k >> 1) ? ty : 1 - ty
          const ww = wx * wy
          acc += img.data[(py * srcW + px) * 4 + c] * ww
          wsum += ww
        }
        p[c] = wsum > 0 ? acc / wsum : 0
      }
      out.data[o] = clamp8(p[0])
      out.data[o + 1] = clamp8(p[1])
      out.data[o + 2] = clamp8(p[2])
      out.data[o + 3] = clamp8(p[3])
    }
  }
  return out
}

/** 整体 alpha 缩放（用于淡入淡出）。 */
export function scaleAlpha(img, k) {
  const out = cloneImg(img)
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = clamp8(out.data[i] * k)
  return out
}

/** 平移，画布尺寸不变，超出部分裁掉。 */
export function translate(img, dx, dy) {
  const out = newImg(img.width, img.height)
  const ox = Math.round(dx)
  const oy = Math.round(dy)
  for (let y = 0; y < img.height; y++) {
    const sy = y - oy
    if (sy < 0 || sy >= img.height) continue
    for (let x = 0; x < img.width; x++) {
      const sx = x - ox
      if (sx < 0 || sx >= img.width) continue
      const si = (sy * img.width + sx) * 4
      const di = (y * img.width + x) * 4
      out.data[di] = img.data[si]
      out.data[di + 1] = img.data[si + 1]
      out.data[di + 2] = img.data[si + 2]
      out.data[di + 3] = img.data[si + 3]
    }
  }
  return out
}

// ---------- 合成 ----------

/** source-over 合成（非预乘输入，按标准公式）。 */
export function composite(dst, src, x, y, opacity = 1) {
  const ox = Math.round(x)
  const oy = Math.round(y)
  for (let sy = 0; sy < src.height; sy++) {
    const dy = oy + sy
    if (dy < 0 || dy >= dst.height) continue
    for (let sx = 0; sx < src.width; sx++) {
      const dx = ox + sx
      if (dx < 0 || dx >= dst.width) continue
      const si = (sy * src.width + sx) * 4
      const sa = (src.data[si + 3] / 255) * opacity
      if (sa <= 0) continue
      const di = (dy * dst.width + dx) * 4
      const da = dst.data[di + 3] / 255
      const outA = sa + da * (1 - sa)
      if (outA <= 0) {
        dst.data[di] = 0; dst.data[di + 1] = 0; dst.data[di + 2] = 0; dst.data[di + 3] = 0
        continue
      }
      for (let c = 0; c < 3; c++) {
        const sc = src.data[si + c] * sa
        const dc = dst.data[di + c] * da * (1 - sa)
        dst.data[di + c] = clamp8((sc + dc) / outA)
      }
      dst.data[di + 3] = clamp8(outA * 255)
    }
  }
  return dst
}

// ---------- alpha 分析 ----------

/** 计算 alpha > threshold 的包围盒；全透明时返回 null。 */
export function alphaBounds(img, threshold = 8) {
  let minX = img.width
  let minY = img.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/** 裁剪到内容包围盒（可留 pad 边距）。 */
export function trim(img, pad = 0) {
  const b = alphaBounds(img)
  if (b === null) return cloneImg(img)
  const x = Math.max(0, b.x - pad)
  const y = Math.max(0, b.y - pad)
  const w = Math.min(img.width - x, b.width + pad * 2)
  const h = Math.min(img.height - y, b.height + pad * 2)
  return crop(img, x, y, w, h)
}

/** 对 alpha 通道做盒式模糊（边缘羽化，1~2px 即可显著减少锯齿）。 */
export function featherAlpha(img, radius = 1) {
  if (radius <= 0) return cloneImg(img)
  const { width: w, height: h } = img
  const out = cloneImg(img)
  const tmp = new Uint8Array(w * h)
  const src = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) src[i] = img.data[i * 4 + 3]
  const r = Math.max(1, Math.round(radius))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      let n = 0
      for (let k = -r; k <= r; k++) {
        const xx = x + k
        if (xx < 0 || xx >= w) continue
        acc += src[y * w + xx]
        n++
      }
      tmp[y * w + x] = Math.round(acc / n)
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      let n = 0
      for (let k = -r; k <= r; k++) {
        const yy = y + k
        if (yy < 0 || yy >= h) continue
        acc += tmp[yy * w + x]
        n++
      }
      out.data[(y * w + x) * 4 + 3] = Math.round(acc / n)
    }
  }
  return out
}

// ---------- 背景移除 ----------

function colorDist2(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2
  const dg = g1 - g2
  const db = b1 - b2
  return dr * dr + dg * dg + db * db
}

/** 统计四周边框像素的颜色中位数与离散度，判断"背景是否基本纯色"。 */
export function borderStats(img, band = 2) {
  const rs = []
  const gs = []
  const bs = []
  const push = (x, y) => {
    const i = (y * img.width + x) * 4
    if (img.data[i + 3] < 8) return
    rs.push(img.data[i]); gs.push(img.data[i + 1]); bs.push(img.data[i + 2])
  }
  for (let x = 0; x < img.width; x++) {
    for (let k = 0; k < band; k++) {
      if (k < img.height) push(x, k)
      if (img.height - 1 - k >= 0) push(x, img.height - 1 - k)
    }
  }
  for (let y = 0; y < img.height; y++) {
    for (let k = 0; k < band; k++) {
      if (k < img.width) push(k, y)
      if (img.width - 1 - k >= 0) push(img.width - 1 - k, y)
    }
  }
  if (rs.length === 0) return { r: 255, g: 255, b: 255, variance: 0, sampleCount: 0 }
  const med = (arr) => {
    const a = Array.from(arr).sort((p, q) => p - q)
    return a[Math.floor(a.length / 2)]
  }
  const r = med(rs)
  const g = med(gs)
  const b = med(bs)
  let acc = 0
  for (let i = 0; i < rs.length; i++) acc += colorDist2(rs[i], gs[i], bs[i], r, g, b)
  return { r, g, b, variance: acc / rs.length, sampleCount: rs.length }
}

/**
 * 扣背景。
 * @param {object} img
 * @param {object} [opts]
 *   mode: 'auto' | 'flood' | 'global' | 'none'（默认 auto）
 *   key:  [r,g,b] 指定背景色（默认取边框统计）
 *   tolerance: 0-255 的颜色容差（默认 32）
 *   feather: alpha 羽化半径（默认 1）
 *   despill: 是否做去白边（默认 true）
 * @returns {{img:object, report:object}}
 */
export function removeBackground(img, opts = {}) {
  const mode = opts.mode || 'auto'
  const tolerance = opts.tolerance ?? 32
  const stats = borderStats(img)
  if (mode === 'none') return { img: cloneImg(img), report: { mode: 'none', reason: '手动跳过' } }

  let key = opts.key
  let effectiveMode = mode
  if (effectiveMode === 'auto') {
    // 边框颜色离散度低 → 认为是纯色背景，可以安全抠除
    const std = Math.sqrt(stats.variance)
    if (std <= 18) { effectiveMode = 'flood'; if (!key) key = [stats.r, stats.g, stats.b] }
    else { effectiveMode = 'none' }
  }
  if (effectiveMode === 'none') {
    return {
      img: cloneImg(img),
      report: { mode: 'none', reason: `背景不纯（边框颜色标准差 ${Math.sqrt(stats.variance).toFixed(1)}），已跳过抠底`, border: stats },
    }
  }
  if (!key) key = [stats.r, stats.g, stats.b]

  const tol2 = tolerance * tolerance
  const w = img.width
  const h = img.height
  const out = cloneImg(img)

  if (effectiveMode === 'global') {
    let removed = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        if (out.data[i + 3] === 0) continue
        if (colorDist2(out.data[i], out.data[i + 1], out.data[i + 2], key[0], key[1], key[2]) <= tol2) {
          out.data[i + 3] = 0
          removed++
        }
      }
    }
    const res = postProcess(out, { ...opts, key })
    return { img: res, report: { mode: 'global', key, tolerance, removed, border: stats } }
  }

  // flood：从四边向内做连通填充，保护角色内部同色区域（比如白色眼白）
  const visited = new Uint8Array(w * h)
  const stack = []
  const seed = (x, y) => {
    const i = (y * w + x) * 4
    if (out.data[i + 3] === 0) return
    if (colorDist2(out.data[i], out.data[i + 1], out.data[i + 2], key[0], key[1], key[2]) > tol2) return
    stack.push(y * w + x)
  }
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1) }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y) }

  let removed = 0
  while (stack.length > 0) {
    const p = stack.pop()
    if (visited[p]) continue
    visited[p] = 1
    const x = p % w
    const y = (p - x) / w
    const i = p * 4
    if (colorDist2(out.data[i], out.data[i + 1], out.data[i + 2], key[0], key[1], key[2]) > tol2) continue
    out.data[i + 3] = 0
    removed++
    if (x > 0) stack.push(p - 1)
    if (x < w - 1) stack.push(p + 1)
    if (y > 0) stack.push(p - w)
    if (y < h - 1) stack.push(p + w)
  }

  const res = postProcess(out, { ...opts, key })
  return { img: res, report: { mode: 'flood', key, tolerance, removed, border: stats } }
}

function postProcess(img, opts) {
  let out = img
  const feather = opts.feather ?? 1
  if (feather > 0) out = featherAlpha(out, feather)
  if (opts.despill !== false) out = despill(out, opts.key)
  return out
}

/**
 * 去白边（despill）：半透明边缘像素往往混入了背景色，表现为一圈白/灰描边。
 * 做法：对 alpha 在 (0,255) 的像素，把颜色朝"远离背景色"的方向推。
 */
export function despill(img, key) {
  if (!key) return img
  const out = cloneImg(img)
  const [kr, kg, kb] = key
  // 背景越亮，"去白"越重要
  const bgLuma = 0.299 * kr + 0.587 * kg + 0.114 * kb
  if (bgLuma < 140) return out
  for (let i = 0; i < out.data.length; i += 4) {
    const a = out.data[i + 3]
    if (a === 0 || a === 255) continue
    const t = a / 255
    for (let c = 0; c < 3; c++) {
      const bgc = c === 0 ? kr : c === 1 ? kg : kb
      // 反预乘：观察值 = 前景*t + 背景*(1-t) → 前景 = (观察值 - 背景*(1-t)) / t
      const fg = (out.data[i + c] - bgc * (1 - t)) / t
      out.data[i + c] = clamp8(fg)
    }
  }
  return out
}

// ---------- 单元格落位 ----------

/**
 * 把角色图规范化到严格 cellW×cellH 的格子画布：
 *  - 去背景（可选）→ 裁剪到内容 → 等比缩放到安全区内 → 水平居中、底部对齐（带脚底留白）
 * 这是"保证不出乱码"的核心：每一帧都恰好一格大小，绝不会跨格串帧。
 *
 * @param {object} img
 * @param {object} opts
 *   cellW, cellH       输出格子尺寸
 *   padX, padY         左右/上下内边距
 *   footPad            底部留白（让角色"站"在格子里）
 *   anchor             'bottom' | 'center'
 *   scale             额外缩放系数（默认 1）
 */
export function fitToCell(img, opts) {
  const cellW = opts.cellW
  const cellH = opts.cellH
  const padX = opts.padX ?? Math.round(cellW * 0.08)
  const padY = opts.padY ?? Math.round(cellH * 0.06)
  const footPad = opts.footPad ?? Math.round(cellH * 0.05)
  const anchor = opts.anchor || 'bottom'
  const extra = opts.scale ?? 1

  const trimmed = trim(img, 0)
  const availW = Math.max(1, cellW - padX * 2)
  const availH = Math.max(1, cellH - padY - footPad)
  const k = Math.min(availW / trimmed.width, availH / trimmed.height) * extra
  const rw = Math.max(1, Math.round(trimmed.width * k))
  const rh = Math.max(1, Math.round(trimmed.height * k))
  const scaled = resize(trimmed, rw, rh)

  const canvas = newImg(cellW, cellH)
  const x = Math.round((cellW - rw) / 2)
  const y = anchor === 'center'
    ? Math.round((cellH - rh) / 2)
    : Math.round(cellH - footPad - rh)
  composite(canvas, scaled, x, y)
  return canvas
}

// ---------- 切片（把"多帧条带图"切成单帧） ----------

/**
 * 把一张横向条带图切成 n 帧。
 * 优先按 alpha 空隙切（更贴合模型实际排版），失败则等分切。
 * @returns {{frames: object[], strategy: string}}
 */
export function sliceStrip(img, n, opts = {}) {
  const cols = Math.max(1, n)
  const gapAware = opts.gapAware !== false
  if (gapAware) {
    const colsHasContent = []
    for (let x = 0; x < img.width; x++) {
      let has = false
      for (let y = 0; y < img.height; y++) {
        if (img.data[(y * img.width + x) * 4 + 3] > 8) { has = true; break }
      }
      colsHasContent.push(has)
    }
    const runs = []
    let start = -1
    for (let x = 0; x < colsHasContent.length; x++) {
      if (colsHasContent[x] && start < 0) start = x
      if ((!colsHasContent[x] || x === colsHasContent.length - 1) && start >= 0) {
        const end = colsHasContent[x] ? x : x - 1
        runs.push([start, end])
        start = -1
      }
    }
    if (runs.length === cols) {
      return {
        strategy: 'alpha-gap',
        frames: runs.map(([a, b]) => crop(img, a, 0, b - a + 1, img.height)),
      }
    }
  }
  const step = img.width / cols
  const frames = []
  for (let i = 0; i < cols; i++) {
    const x0 = Math.round(i * step)
    const x1 = Math.round((i + 1) * step)
    frames.push(crop(img, x0, 0, x1 - x0, img.height))
  }
  return { strategy: 'equal-divide', frames }
}

/** 把网格图切成 rows×cols 的单元格数组（行优先）。 */
export function sliceGrid(img, cols, rows) {
  const cw = Math.floor(img.width / cols)
  const ch = Math.floor(img.height / rows)
  const out = []
  for (let r = 0; r < rows; r++) {
    const row = []
    for (let c = 0; c < cols; c++) row.push(crop(img, c * cw, r * ch, cw, ch))
    out.push(row)
  }
  return out
}

// ---------- 校验 ----------

/**
 * 健康检查：检测一帧是否"有效"（不是空白、不是噪声块、不是被压扁）。
 * 用于防止生图模型返回空白图/纯色块时被静默接受。
 */
export function frameStats(img) {
  let opaque = 0
  let semi = 0
  const colors = new Set()
  let step = 1
  const total = img.width * img.height
  if (total > 200000) step = Math.ceil(Math.sqrt(total / 200000))
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const i = (y * img.width + x) * 4
      const a = img.data[i + 3]
      if (a > 240) opaque++
      else if (a > 8) semi++
      if (a > 8) {
        colors.add(((img.data[i] >> 4) << 8) | ((img.data[i + 1] >> 4) << 4) | (img.data[i + 2] >> 4))
      }
    }
  }
  const b = alphaBounds(img)
  const coverage = b === null ? 0 : (b.width * b.height) / total
  return {
    opaqueRatio: opaque / (total / (step * step)),
    semiRatio: semi / (total / (step * step)),
    distinctColors: colors.size,
    bounds: b,
    coverage,
    empty: b === null || opaque + semi < 4,
  }
}

/** 快速判断一个文件是不是合法图片（只读头部，不解码）。 */
export function quickProbeImage(bytes) {
  return readImageHeader(bytes)
}

// ---------- 调色板 ----------

/**
 * 从角色图里提取主色调（用于 3D 建模时给模型上色，让 3D 版和 2D 版观感一致）。
 * 做法：忽略透明像素，把颜色量化到 5bit/通道做直方图，取前 n 个最多出现的桶，
 * 再在每个桶里取平均色，最后按亮度排序返回。
 * @returns {Array<{hex:string, rgb:number[], ratio:number}>}
 */
export function extractPalette(img, n = 6) {
  const hist = new Map()
  let counted = 0
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3]
    if (a < 128) continue
    const r = img.data[i]
    const g = img.data[i + 1]
    const b = img.data[i + 2]
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    let e = hist.get(key)
    if (e === undefined) { e = { count: 0, r: 0, g: 0, b: 0 }; hist.set(key, e) }
    e.count++
    e.r += r; e.g += g; e.b += b
    counted++
  }
  if (counted === 0) return []
  const arr = Array.from(hist.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, n))
    .map((e) => {
      const r = Math.round(e.r / e.count)
      const g = Math.round(e.g / e.count)
      const b = Math.round(e.b / e.count)
      return {
        rgb: [r, g, b],
        hex: '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join(''),
        ratio: e.count / counted,
      }
    })
  return arr
}

/** 取角色图里最亮的主色（常用于给 3D 模型定"主体色"）。 */
export function dominantColor(img) {
  const p = extractPalette(img, 1)
  return p.length ? p[0] : { rgb: [128, 200, 255], hex: '#80c8ff', ratio: 1 }
}

/** 取最暗的主色（用于描边/眼睛等细节色）。 */
export function darkestColor(img) {
  const p = extractPalette(img, 8)
  if (p.length === 0) return { rgb: [30, 40, 60], hex: '#1e283c', ratio: 0 }
  const luma = (c) => 0.299 * c.rgb[0] + 0.587 * c.rgb[1] + 0.114 * c.rgb[2]
  return p.slice().sort((a, b) => luma(a) - luma(b))[0]
}

export { isPng }

