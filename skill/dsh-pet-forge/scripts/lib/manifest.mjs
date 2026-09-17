// =============================================================================
// dsh-pet-forge · 宠物包清单（pet.json）
// -----------------------------------------------------------------------------
// 宠物包是一个**自描述目录**：插件只认识这一份清单，素材路径全部相对包目录。
// 这样"生成 / 导入 / 分发"共用同一套契约，也便于校验（防止图集与状态表对不上
// 导致画面错位、串帧这类"看起来像乱码"的问题）。
// =============================================================================

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { readImageHeader } from './png.mjs'

export const SCHEMA = 'dsh-pet/2'
export const SKILL_VERSION = '1.0.0'

export const DEFAULT_ATLAS = { cols: 8, rows: 11, cellW: 192, cellH: 208 }

/** 行号契约（与 docs/SPRITESHEET-CONTRACT.md 一致）。 */
export const STATE_ROWS = {
  idle: 0, runRight: 1, runLeft: 2, waving: 3, jumping: 4,
  failed: 5, waiting: 6, running: 7, review: 8, look: 9,
}

export const STATE_META = {
  idle: { label: '待机呼吸', host: '空闲时', frames: 6, fps: 6, recommended: true },
  runRight: { label: '向右跑', host: '拖拽（向右）', frames: 8, fps: 12, recommended: false },
  runLeft: { label: '向左跑', host: '拖拽（向左）', frames: 8, fps: 12, recommended: false },
  waving: { label: '挥手', host: '悬停/问候', frames: 4, fps: 8, recommended: false },
  jumping: { label: '跳跃庆祝', host: '对话完成', frames: 5, fps: 10, recommended: true },
  failed: { label: '摔倒', host: '出错 / 连点三次', frames: 8, fps: 12, recommended: true },
  waiting: { label: '等待', host: '等待审批 / 提问', frames: 6, fps: 5, recommended: true },
  running: { label: '专注工作', host: '工具执行中', frames: 6, fps: 12, recommended: true },
  review: { label: '思考', host: '回合思考', frames: 6, fps: 6, recommended: true },
  look: { label: '视线跟随', host: '鼠标悬停', frames: 16, fps: 4, recommended: true },
}

/** 把任意名字变成文件名安全的 slug。 */
export function slugify(input, fallback = 'pet') {
  const raw = String(input || '').trim()
  if (!raw) return fallback
  const ascii = raw
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!ascii) return fallback
  // 纯中文名 → 用拼音不可行，退化为时间戳短 id，避免跨平台路径问题
  if (/^[\u4e00-\u9fff-]+$/.test(ascii)) return `pet-${Date.now().toString(36).slice(-5)}`
  return ascii.slice(0, 40)
}

/** 新建一份清单骨架。 */
export function makeManifest(opts) {
  const atlas = { file: 'atlas.png', ...DEFAULT_ATLAS, ...(opts.atlas || {}) }
  const states = opts.states || buildDefaultStates(atlas)
  return {
    schema: SCHEMA,
    id: opts.id,
    name: opts.name || opts.id,
    createdAt: new Date().toISOString(),
    generator: { skill: 'dsh-pet-forge', version: SKILL_VERSION },
    source: opts.source || { kind: 'image' },
    atlas,
    states,
    behavior: opts.behavior || 'idle',
    size: opts.size ?? 120,
    audio: opts.audio || {},
    triggers: opts.triggers || {},
    interactions: opts.interactions || {},
    phrases: opts.phrases || [],
    divePhrases: opts.divePhrases || [],
    yaw: opts.yaw || null,
    tags: opts.tags || [],
  }
}

/** 按契约行号生成 states 表（只包含被选中的动作，未选的降级到 idle）。 */
export function buildDefaultStates(atlas, enabled = null) {
  const { cols } = atlas
  const states = {}
  const on = enabled ? new Set(enabled) : null
  const idleRow = STATE_ROWS.idle
  for (const [key, row] of Object.entries(STATE_ROWS)) {
    if (key === 'look') continue
    const meta = STATE_META[key]
    const frames = Math.min(meta.frames, cols)
    if (!on || key === 'idle' || on.has(key)) {
      states[key] = { row, frames, fps: meta.fps }
    } else {
      states[key] = { row: idleRow, frames: Math.min(STATE_META.idle.frames, cols), fps: STATE_META.idle.fps, aliasOf: 'idle' }
    }
  }
  if (!on || on.has('look')) {
    if (atlas.rows >= 11) states.look = { rows: [STATE_ROWS.look, STATE_ROWS.look + 1], frames: 8 }
  }
  return states
}

export async function readManifest(packageDir) {
  const file = join(packageDir, 'pet.json')
  const text = await readFile(file, 'utf8')
  return JSON.parse(text)
}

export async function writeManifest(packageDir, manifest) {
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'pet.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return join(packageDir, 'pet.json')
}

/** 安全地把相对路径解析到包目录内（防目录穿越）。 */
export function resolveInPackage(packageDir, rel) {
  const root = resolve(packageDir)
  const abs = resolve(root, String(rel))
  const r = relative(root, abs)
  if (r.startsWith('..') || isAbsolute(r) || r.split(sep).includes('..')) {
    throw new Error(`清单中的路径越出了宠物包目录：${rel}`)
  }
  return abs
}

/**
 * 校验一份清单 + 包内素材。
 * @returns {Promise<{ok:boolean, errors:string[], warnings:string[], info:object}>}
 */
export async function validatePackage(packageDir, manifest) {
  const errors = []
  const warnings = []
  const info = {}

  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: ['pet.json 不是合法对象'], warnings, info }
  }
  if (manifest.schema !== SCHEMA) {
    warnings.push(`schema 为 ${manifest.schema ?? '(缺失)'}，当前工具预期 ${SCHEMA}（仍会尝试兼容读取）`)
  }
  if (!manifest.id) errors.push('缺少 id')
  if (!manifest.name) warnings.push('缺少 name，将使用 id 作为显示名')

  const atlas = manifest.atlas || {}
  const cols = Number(atlas.cols)
  const rows = Number(atlas.rows)
  const cellW = Number(atlas.cellW)
  const cellH = Number(atlas.cellH)
  for (const [k, v] of [['cols', cols], ['rows', rows], ['cellW', cellW], ['cellH', cellH]]) {
    if (!Number.isInteger(v) || v <= 0) errors.push(`atlas.${k} 非法：${atlas[k]}`)
  }
  if (errors.length > 0) return { ok: false, errors, warnings, info }

  // ---- 图集文件 ----
  const atlasRel = atlas.file || 'atlas.png'
  let atlasAbs
  try {
    atlasAbs = resolveInPackage(packageDir, atlasRel)
  } catch (err) {
    errors.push(String(err.message))
    return { ok: false, errors, warnings, info }
  }
  if (!existsSync(atlasAbs)) {
    errors.push(`图集文件不存在：${atlasRel}`)
    return { ok: false, errors, warnings, info }
  }
  const atlasBytes = await readFile(atlasAbs)
  const header = readImageHeader(atlasBytes)
  if (!header) {
    errors.push(`图集不是可识别的 PNG/WebP：${atlasRel}（文件头不匹配，极可能是编码被破坏）`)
    return { ok: false, errors, warnings, info }
  }
  const expectW = cols * cellW
  const expectH = rows * cellH
  if (header.width !== expectW || header.height !== expectH) {
    errors.push(
      `图集尺寸与网格不符：实际 ${header.width}×${header.height}，` +
      `按 ${cols}列×${rows}行 · ${cellW}×${cellH}px 应为 ${expectW}×${expectH}。` +
      `尺寸不符会导致取帧错位（画面看起来像乱码）。`
    )
  }
  if (header.bitDepth !== undefined && header.bitDepth !== 8) {
    warnings.push(`图集位深为 ${header.bitDepth}bit，建议 8bit`)
  }
  info.atlas = {
    file: atlasRel, abs: atlasAbs, bytes: atlasBytes.length,
    width: header.width, height: header.height, cols, rows, cellW, cellH,
  }

  // ---- 状态表 ----
  const states = manifest.states
  if (!states || typeof states !== 'object' || Object.keys(states).length === 0) {
    errors.push('缺少 states（没有状态表，客户端无法播放动画）')
  } else {
    for (const [key, st] of Object.entries(states)) {
      if (!st || typeof st !== 'object') { errors.push(`states.${key} 非法`); continue }
      // 行号可以来自三种写法：row（单行）/ rows（多行，如 2D 的 16 方向 look）/
      // angles（3D 环视：每个角度一个格子，形如 [{row,col}, ...]）
      const rowList = st.angles
        ? (Array.isArray(st.angles) ? st.angles.map((a) => a && a.row) : null)
        : st.rows ? (Array.isArray(st.rows) ? st.rows : [st.rows]) : (st.row !== undefined ? [st.row] : null)
      if (rowList === null || rowList.length === 0) { errors.push(`states.${key} 缺少 row/rows/angles`); continue }
      for (const r of rowList) {
        if (!Number.isInteger(r) || r < 0 || r >= rows) errors.push(`states.${key} 行号 ${r} 超出 0..${rows - 1}`)
      }
      if (st.frames !== undefined && (!Number.isInteger(st.frames) || st.frames < 1 || st.frames > cols)) {
        errors.push(`states.${key} 帧数 ${st.frames} 超出 1..${cols}`)
      }
      if (st.fps !== undefined && (typeof st.fps !== 'number' || st.fps <= 0 || st.fps > 60)) {
        warnings.push(`states.${key} 的 fps ${st.fps} 异常（建议 1..60）`)
      }
    }
    if (!states.idle) errors.push('states 缺少 idle（必须有兜底动画）')
  }

  // ---- 音频文件 ----
  const audio = manifest.audio || {}
  const audioInfo = {}
  for (const [key, entry] of Object.entries(audio)) {
    const rel = typeof entry === 'string' ? entry : entry && entry.file
    if (!rel) { warnings.push(`audio.${key} 缺少 file 字段，已忽略`); continue }
    let abs
    try {
      abs = resolveInPackage(packageDir, rel)
    } catch (err) {
      errors.push(`audio.${key}：${err.message}`)
      continue
    }
    if (!existsSync(abs)) { warnings.push(`audio.${key} 指向的文件不存在：${rel}（该音效将被禁用）`); continue }
    const st = await stat(abs)
    if (st.size < 64) { warnings.push(`audio.${key} 文件过小（${st.size} 字节），可能损坏`); continue }
    const head = await readFile(abs).then((b) => b.subarray(0, 12))
    const isWav = head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WAVE'
    const isMp3 = head.toString('latin1', 0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)
    const isOgg = head.toString('latin1', 0, 4) === 'OggS'
    if (!isWav && !isMp3 && !isOgg) {
      errors.push(`audio.${key} 不是可识别的音频（WAV/MP3/OGG 头均不匹配）：${rel}`)
      continue
    }
    audioInfo[key] = {
      file: rel, abs, bytes: st.size,
      format: isWav ? 'wav' : isMp3 ? 'mp3' : 'ogg',
      mime: isWav ? 'audio/wav' : isMp3 ? 'audio/mpeg' : 'audio/ogg',
      label: (entry && entry.label) || key,
    }
  }
  info.audio = audioInfo

  // ---- 3D 偏航 ----
  // 两种形态：
  //   { count, rowsPerYaw }  每个角度占 rowsPerYaw 行（角度 0 在 0..rowsPerYaw-1，以此类推）
  //   { count, kind:'rows' } 每个角度**单独一行**（Blender 环视渲染用的就是这种，
  //                          等价于 rowsPerYaw = 1）
  if (manifest.yaw) {
    const count = manifest.yaw.count
    const rowsPerYaw = manifest.yaw.kind === 'rows' ? 1 : manifest.yaw.rowsPerYaw
    if (!Number.isInteger(count) || count < 2) errors.push(`yaw.count 非法：${count}`)
    if (!Number.isInteger(rowsPerYaw) || rowsPerYaw < 1) errors.push(`yaw.rowsPerYaw 非法：${manifest.yaw.rowsPerYaw}`)
    if (Number.isInteger(count) && Number.isInteger(rowsPerYaw) && count * rowsPerYaw > rows) {
      errors.push(`yaw 需要的行数 ${count * rowsPerYaw} 超过图集总行数 ${rows}`)
    }
  }

  return { ok: errors.length === 0, errors, warnings, info }
}

/** 生成一个可直接喂给客户端/插件的"视图对象"（只含元数据，不含二进制）。 */
export function toPetView(manifest, baseUrl = '/ronaldo-pet') {
  const atlas = manifest.atlas || {}
  const id = manifest.id
  const audio = {}
  for (const [key, entry] of Object.entries(manifest.audio || {})) {
    const rel = typeof entry === 'string' ? entry : entry && entry.file
    if (!rel) continue
    const label = (entry && entry.label) || key
    audio[key] = { url: `${baseUrl}/asset/${id}/${encodeURIComponent(rel).replace(/%2F/g, '/')}`, label }
  }
  return {
    id,
    name: manifest.name || id,
    size: manifest.size ?? 120,
    behavior: manifest.behavior || 'idle',
    sheet: {
      url: `${baseUrl}/asset/${id}/${encodeURIComponent(atlas.file || 'atlas.png').replace(/%2F/g, '/')}`,
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
  }
}
