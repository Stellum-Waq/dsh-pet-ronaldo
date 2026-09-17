// =============================================================================
// dsh-pet-forge · 纯 Node PNG 编解码器（零第三方依赖）
// -----------------------------------------------------------------------------
// 为什么自己写：桌宠素材最容易出问题的地方就是"图片乱码"——由第三方原生库
// 版本差异、平台二进制缺失、或经过文本管道（PowerShell / JSON / base64）传输
// 导致字节被改写。这里的编码器是**确定性**的：同样的像素永远产出同样的字节，
// 且全程走 Buffer，不经过任何字符串编码转换。
//
// 支持解码：8bit / 非隔行 / 颜色类型 0(灰度) 2(RGB) 3(调色板) 4(灰度+A) 6(RGBA)
// 支持编码：8bit RGBA（颜色类型 6），自适应行滤波 + zlib deflate
// =============================================================================

import { inflateSync, deflateSync, constants as zlibConstants } from 'node:zlib'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 判断一段字节是否是 PNG。 */
export function isPng(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  return b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG)
}

/** 判断一段字节是否是 WebP（RIFF....WEBP）。 */
export function isWebp(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  return (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
}

/** 判断 JPEG。 */
export function isJpeg(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
}

/** 嗅探图片格式，返回 'png' | 'webp' | 'jpeg' | null。 */
export function sniff(bytes) {
  if (isPng(bytes)) return 'png'
  if (isWebp(bytes)) return 'webp'
  if (isJpeg(bytes)) return 'jpeg'
  return null
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'latin1')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

const CHANNELS_FOR_COLOR_TYPE = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/**
 * 解码 PNG 为 RGBA。
 * @param {Buffer|Uint8Array} bytes
 * @returns {{width:number,height:number,channels:4,data:Uint8Array}}
 */
export function decodePng(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (!isPng(buf)) throw new Error('decodePng: 不是 PNG 数据（签名不匹配）')

  let off = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  let interlace = 0
  let palette = null
  let trns = null
  const idat = []

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    const dataStart = off + 8
    const dataEnd = dataStart + len
    if (dataEnd > buf.length) throw new Error('decodePng: 数据块越界，文件可能已损坏')
    const data = buf.subarray(dataStart, dataEnd)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') {
      palette = Buffer.from(data)
    } else if (type === 'tRNS') {
      trns = Buffer.from(data)
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    off = dataEnd + 4
  }

  if (width <= 0 || height <= 0) throw new Error('decodePng: IHDR 缺失或尺寸非法')
  if (interlace !== 0) throw new Error('decodePng: 不支持隔行（Adam7）PNG，请先转换为非隔行')
  if (bitDepth !== 8) throw new Error(`decodePng: 仅支持 8bit，实际 ${bitDepth}bit`)
  if (!(colorType in CHANNELS_FOR_COLOR_TYPE)) throw new Error(`decodePng: 不支持的颜色类型 ${colorType}`)

  const bpp = CHANNELS_FOR_COLOR_TYPE[colorType] // 每像素字节数（8bit）
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const expected = (stride + 1) * height
  if (raw.length < expected) {
    throw new Error(`decodePng: 解压后数据不足（期望 ${expected}，实际 ${raw.length}）`)
  }

  // 逐行反滤波
  const lines = Buffer.alloc(stride * height)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const dst = lines.subarray(y * stride, (y + 1) * stride)
    src.copy(dst)
    unfilter(ft, dst, prev, bpp, stride)
    prev = dst
  }

  // 展开到 RGBA
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    const orow = y * width * 4
    for (let x = 0; x < width; x++) {
      const i = row + x * bpp
      const o = orow + x * 4
      if (colorType === 0) {
        const g = lines[i]
        out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255
      } else if (colorType === 2) {
        out[o] = lines[i]; out[o + 1] = lines[i + 1]; out[o + 2] = lines[i + 2]; out[o + 3] = 255
      } else if (colorType === 3) {
        if (palette === null) throw new Error('decodePng: 调色板 PNG 缺少 PLTE')
        const idx = lines[i]
        out[o] = palette[idx * 3]
        out[o + 1] = palette[idx * 3 + 1]
        out[o + 2] = palette[idx * 3 + 2]
        out[o + 3] = trns !== null && idx < trns.length ? trns[idx] : 255
      } else if (colorType === 4) {
        const g = lines[i]
        out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = lines[i + 1]
      } else {
        out[o] = lines[i]; out[o + 1] = lines[i + 1]; out[o + 2] = lines[i + 2]; out[o + 3] = lines[i + 3]
      }
    }
  }
  return { width, height, channels: 4, data: out }
}

function unfilter(ft, dst, prev, bpp, stride) {
  switch (ft) {
    case 0:
      break
    case 1:
      for (let i = bpp; i < stride; i++) dst[i] = (dst[i] + dst[i - bpp]) & 0xff
      break
    case 2:
      for (let i = 0; i < stride; i++) dst[i] = (dst[i] + prev[i]) & 0xff
      break
    case 3:
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? dst[i - bpp] : 0
        dst[i] = (dst[i] + ((a + prev[i]) >> 1)) & 0xff
      }
      break
    case 4:
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? dst[i - bpp] : 0
        const b = prev[i]
        const c = i >= bpp ? prev[i - bpp] : 0
        dst[i] = (dst[i] + paeth(a, b, c)) & 0xff
      }
      break
    default:
      throw new Error(`decodePng: 未知的行滤波类型 ${ft}`)
  }
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/**
 * 编码 RGBA 为 PNG（8bit，颜色类型 6，非隔行）。
 * 采用 MSAD 启发式选择行滤波，保证输出体积可控且完全确定性。
 * @param {{width:number,height:number,data:Uint8Array|Buffer}} img
 * @param {{level?:number}} [opts]
 * @returns {Buffer}
 */
export function encodePng(img, opts = {}) {
  const { width, height } = img
  const data = Buffer.isBuffer(img.data) ? img.data : Buffer.from(img.data)
  if (data.length !== width * height * 4) {
    throw new Error(`encodePng: 像素数据长度不符（期望 ${width * height * 4}，实际 ${data.length}）`)
  }
  const stride = width * 4
  const out = Buffer.alloc((stride + 1) * height)
  const zeroRow = Buffer.alloc(stride)
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)]

  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride)
    const prev = y === 0 ? zeroRow : data.subarray((y - 1) * stride, y * stride)
    let best = 0
    let bestScore = Infinity
    for (let ft = 0; ft < 5; ft++) {
      const buf = cand[ft]
      let score = 0
      for (let i = 0; i < stride; i++) {
        const raw = row[i]
        const a = i >= 4 ? row[i - 4] : 0
        const b = prev[i]
        const c = i >= 4 ? prev[i - 4] : 0
        let v
        if (ft === 0) v = raw
        else if (ft === 1) v = raw - a
        else if (ft === 2) v = raw - b
        else if (ft === 3) v = raw - ((a + b) >> 1)
        else v = raw - paeth(a, b, c)
        v &= 0xff
        buf[i] = v
        score += v < 128 ? v : 256 - v
      }
      if (score < bestScore) { bestScore = score; best = ft }
    }
    out[y * (stride + 1)] = best
    cand[best].copy(out, y * (stride + 1) + 1)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // RGBA
  ihdr[10] = 0  // deflate
  ihdr[11] = 0  // adaptive filtering
  ihdr[12] = 0  // no interlace

  const idat = deflateSync(out, { level: opts.level ?? 9, memLevel: 9, strategy: zlibConstants.Z_DEFAULT_STRATEGY })
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 只读 PNG 头部拿尺寸（用于大文件快速校验，不解码整张图）。
 * @returns {{width:number,height:number,bitDepth:number,colorType:number,interlace:number}|null}
 */
export function readPngHeader(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (!isPng(buf) || buf.length < 33) return null
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    interlace: buf[28],
  }
}

/** 只读 WebP 头部拿尺寸（覆盖 VP8X / VP8 / VP8L 三种）。 */
export function readWebpHeader(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (!isWebp(buf) || buf.length < 30) return null
  const fourcc = buf.toString('latin1', 12, 16)
  if (fourcc === 'VP8X') {
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
    return { width: w, height: h }
  }
  if (fourcc === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  }
  if (fourcc === 'VP8L') {
    const b = buf.readUInt32LE(21)
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
  }
  return null
}

/** 统一入口：只读头部拿尺寸，PNG / WebP 都支持。 */
export function readImageHeader(bytes) {
  return readPngHeader(bytes) || readWebpHeader(bytes)
}
