// =============================================================================
// dsh-ronaldo-pet · 宠物社区画廊（发现 / 缓存 / 下载 / 解包）
// -----------------------------------------------------------------------------
// 契约文档：docs/GALLERY-CONTRACT.md
// 法律文本：docs/PET-SHARING-AGREEMENT.md（DPSL-1.0）
//
// 这个模块只做「读」的事：
//   · 读官方索引（包内置一份 + 远端一份）
//   · 读 GitHub 上带 dsh-pet topic 的公开仓库（搜索 API）
//   · 读每个仓库根目录的 pet.json，判断它是否按 DPSL-1.0 授权
//   · 下载 tarball 并解包到本地（不执行任何脚本、不写目录以外的路径）
//
// 它**不**注册宠物、**不**碰注册表 —— 那是 host.js 的事。
//
// 设计上把三个外部地址做成配置（searchApi / rawBase / codeloadBase）：
// 既方便企业内网换镜像，也让"发现→下载→解包"整条链路可以在没有外网的环境里
// 被 scripts/smoke-host.mjs 用本地桩服务器完整验证。
// =============================================================================

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path'

import { DPSL_PROTOCOL, validateSharing, parseRepoUrl } from '../skill/dsh-pet-forge/scripts/lib/share.mjs'

export const GALLERY_PROTOCOL = 'dsh-pet-gallery/1'
export const DEFAULT_TOPICS = ['dsh-pet']
export const USER_AGENT = 'dsh-ronaldo-pet-gallery/1 (+https://github.com/Stellum-Waq/dsh-pet-ronaldo)'

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const nowMs = () => Date.now()
const asArray = (v) => (Array.isArray(v) ? v : [])

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
}

/** 带超时的 fetch；返回 { ok, status, json, text, error }，**不抛异常**。 */
async function safeFetch(url, opts = {}, fetchImpl = globalThis.fetch) {
  const { timeoutMs = 8000, method = 'GET', headers = {}, body } = opts
  if (typeof fetchImpl !== 'function') return { ok: false, status: 0, error: '当前 Node 运行时没有 fetch（需要 Node 18+）' }
  try {
    const res = await fetchImpl(url, {
      method,
      headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...headers },
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch { /* 非 JSON 就只留文本 */ }
    return { ok: res.ok, status: res.status, json, text }
  } catch (err) {
    return { ok: false, status: 0, error: String((err && err.message) || err) }
  }
}

/**
 * 二进制安全版：tarball 绝不能走 res.text()（会按 UTF-8 解码，二进制直接烂掉，
 * 表现为"下载成功但解包失败/图片损坏"）。这里用 arrayBuffer → Buffer。
 */
async function safeFetchBytes(url, opts = {}, fetchImpl = globalThis.fetch) {
  const { timeoutMs = 30000, headers = {} } = opts
  if (typeof fetchImpl !== 'function') return { ok: false, status: 0, error: '当前 Node 运行时没有 fetch（需要 Node 18+）' }
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'application/octet-stream', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    })
    if (!res.ok) return { ok: false, status: res.status }
    const ab = await res.arrayBuffer()
    return { ok: true, status: res.status, bytes: Buffer.from(ab) }
  } catch (err) {
    return { ok: false, status: 0, error: String((err && err.message) || err) }
  }
}

// ---------------------------------------------------------------------------
// curl 兜底通道
// ---------------------------------------------------------------------------
// 为什么需要它：本机（以及不少国内代理/加速器环境）把 raw.githubusercontent.com 之类
// 域名指到本地 MITM 代理，Windows 证书store 里有那张根证书、但 Node 自己的 CA 包里没有，
// 于是 Node 的 fetch 直接抛 UNABLE_TO_VERIFY_LEAF_SIGNATURE：
//     fetch failed | cause: UNABLE_TO_VERIFY_LEAF_SIGNATURE unable to verify the first certificate
// 实测 curl.exe（走 Windows Schannel，认系统证书）在同样的环境里一次就通。
// 所以：fetch 优先，失败之后自动换 curl 再试一次，并把 transport 写进结果里，便于排查。
//
// 另一条路是让 dsh 带 `NODE_OPTIONS=--use-system-ca` 启动（Node 22+），错误提示里会写。

let curlProbe = null

function probeCurl(curlPath) {
  if (curlProbe) return curlProbe
  curlProbe = new Promise((resolvePromise) => {
    let child
    try {
      child = execFile(curlPath, ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        resolvePromise(!err && /^curl /i.test(String(stdout || '')))
      })
    } catch {
      return resolvePromise(false)
    }
    child.on('error', () => resolvePromise(false))
  })
  return curlProbe
}

/**
 * 用 curl 取 URL。binary=true 时写入临时文件再读回（避免 stdout 上的二进制/状态码混杂）。
 * @returns {Promise<{ok:boolean,status:number,text?:string,bytes?:Buffer,error?:string}>}
 */
async function fetchViaCurl(url, opts = {}) {
  const { timeoutMs = 15000, headers = {}, binary = false, curlPath = 'curl' } = opts
  if (!(await probeCurl(curlPath))) return { ok: false, status: 0, error: 'curl 不可用' }
  const seconds = Math.max(3, Math.ceil(timeoutMs / 1000))
  const args = ['-sS', '-L', '--max-time', String(seconds), '-w', '%{http_code}']
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`)
  let tmp = null
  if (binary) {
    tmp = join(tmpdir(), `dsh-pet-gallery-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`)
    args.push('-o', tmp)
  }
  args.push(url)
  const run = new Promise((resolvePromise) => {
    try {
      execFile(curlPath, args, { timeout: timeoutMs + 5000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
        if (err && !stdout) return resolvePromise({ ok: false, status: 0, error: String(err.message || err) })
        resolvePromise({ ok: true, raw: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || '')) })
      })
    } catch (err) {
      resolvePromise({ ok: false, status: 0, error: String((err && err.message) || err) })
    }
  })
  const res = await run
  if (!res.ok) {
    if (tmp) { try { await rm(tmp, { force: true }) } catch { /* 忽略 */ } }
    return { ok: false, status: 0, error: res.error }
  }
  const text = res.raw.toString('utf8')
  const nl = text.lastIndexOf('\n')
  const status = Number(text.slice(nl + 1).trim()) || 0
  if (binary) {
    let bytes = null
    try {
      bytes = await readFile(tmp)
    } catch { /* 下面统一报错 */ }
    try { await rm(tmp, { force: true }) } catch { /* 忽略 */ }
    if (!bytes) return { ok: false, status, error: 'curl 输出文件读取失败' }
    return { ok: status >= 200 && status < 300, status, bytes, transport: 'curl' }
  }
  const body = nl >= 0 ? text.slice(0, nl) : ''
  let json = null
  try { json = JSON.parse(body) } catch { /* 非 JSON */ }
  return { ok: status >= 200 && status < 300, status, text: body, json, transport: 'curl' }
}

const TLS_HINT =
  '（本机 Node 无法验证证书：可能是本地代理/MITM 根证书不在 Node 的 CA 包里。' +
  '可用 NODE_OPTIONS=--use-system-ca 启动 dsh（Node 22+），或配置 NODE_EXTRA_CA_CERTS 指向该根证书）'

const encPath = (p) => String(p).split('/').map(encodeURIComponent).join('/')

// ---------------------------------------------------------------------------
// tar.gz 解包（零依赖）
// ---------------------------------------------------------------------------

/**
 * 解 gzip + 解析 ustar 归档。
 * 支持：普通文件（'0'、'\0'）、目录（'5'）、GNU 长名（'L'）、pax 扩展头（'x'/'g'，跳过）。
 * 忽略：符号链接（'2'）、硬链接（'1'）—— 它们有可能指向包外，直接不落地最安全。
 */
export function untarGz(bytes, opts = {}) {
  const maxFiles = opts.maxFiles || 4000
  const maxBytes = opts.maxBytes || 256 * 1024 * 1024
  const entries = []
  const skipped = []
  let total = 0
  let buf
  try {
    buf = gunzipSync(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))
  } catch (err) {
    return { ok: false, error: `gzip 解压失败（不是 .tar.gz？）：${err.message}`, entries, skipped }
  }

  let off = 0
  let pendingName = null
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    // 全零块 = 归档结束
    if (header.every((b) => b === 0)) break
    const rawName = header.toString('latin1', 0, 100).replace(/\0.*$/, '')
    const sizeField = header.toString('latin1', 124, 136).replace(/\0.*$/, '').trim()
    const size = parseInt(sizeField, 8) || 0
    const typeflag = header.toString('latin1', 156, 157)
    const prefix = header.toString('latin1', 345, 500).replace(/\0.*$/, '')
    let name = pendingName || (prefix ? `${prefix}/${rawName}` : rawName)
    if (pendingName) pendingName = null
    const dataStart = off + 512
    const dataEnd = dataStart + size
    const padded = Math.ceil(size / 512) * 512

    if (typeflag === 'L') {
      // GNU 长文件名：内容就是下一个条目的名字
      pendingName = buf.toString('utf8', dataStart, dataEnd).replace(/\0.*$/, '')
      off = dataStart + padded
      continue
    }
    if (typeflag === 'x' || typeflag === 'g') {
      // pax 扩展头：跳过，正文里只有 key=value 元数据
      off = dataStart + padded
      continue
    }
    if (typeflag === '1' || typeflag === '2') {
      skipped.push({ path: name, reason: typeflag === '2' ? '符号链接' : '硬链接' })
      off = dataStart + padded
      continue
    }
    if (typeflag === '5' || name.endsWith('/')) {
      off = dataStart + padded
      continue
    }
    if (size === 0) {
      off = dataStart + padded
      continue
    }

    total += size
    if (total > maxBytes) {
      return { ok: false, error: `归档解包后超过上限（${maxBytes} 字节），已中止`, entries, skipped }
    }
    if (entries.length >= maxFiles) {
      return { ok: false, error: `归档文件数超过上限（${maxFiles}），已中止`, entries, skipped }
    }
    entries.push({ path: name, bytes: buf.subarray(dataStart, dataEnd) })
    off = dataStart + padded
  }
  return { ok: true, entries, skipped, bytes: total }
}

/** 去掉 tarball 的顶层目录（GitHub 归档是 `<repo>-<ref>/...`）。 */
export function stripTopDir(path, depth = 1) {
  const parts = String(path).split('/').filter(Boolean)
  return parts.slice(depth).join('/')
}

/** 路径消毒：拒绝绝对路径、盘符、`..`。返回 null 表示不安全。 */
export function safeRelative(rel) {
  const s = String(rel || '').replace(/\\/g, '/')
  if (!s) return null
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.startsWith('~')) return null
  const parts = s.split('/')
  if (parts.some((p) => p === '..')) return null
  return parts.filter((p) => p !== '' && p !== '.').join('/')
}

/** 把解包结果落盘到 destDir（只写 destDir 以内）。 */
export async function writeEntries(entries, destDir, opts = {}) {
  const root = resolve(destDir)
  const written = []
  const skipped = []
  for (const e of entries) {
    const rel = safeRelative(opts.stripTop === false ? e.path : stripTopDir(e.path, 1))
    if (!rel) { skipped.push({ path: e.path, reason: '路径不安全' }); continue }
    const abs = resolve(root, rel)
    const r = relative(root, abs)
    if (r.startsWith('..') || isAbsolute(r) || r.split(sep).includes('..')) {
      skipped.push({ path: e.path, reason: '路径越界' })
      continue
    }
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, e.bytes)
    written.push(rel)
  }
  return { root, files: written, skipped }
}

/** 在文件列表里找 pet.json：packagePath 优先 → 根目录 → 最浅的那个（深度 ≤ 3）。 */
export function findPetJson(files, packagePath = '') {
  const norm = files.map((f) => String(f).replace(/\\/g, '/'))
  if (packagePath) {
    const want = (safeRelative(packagePath) || '') + '/pet.json'
    const hit = norm.find((f) => f === want.replace(/^\//, ''))
    if (hit) return hit
  }
  if (norm.includes('pet.json')) return 'pet.json'
  const candidates = norm
    .filter((f) => f === 'pet.json' || f.endsWith('/pet.json'))
    .filter((f) => f.split('/').length <= 4)
    .sort((a, b) => a.split('/').length - b.split('/').length)
  return candidates[0] || null
}

// ---------------------------------------------------------------------------
// 兼容导入：spritesheet.json（同契约变体）→ pet.json
// ---------------------------------------------------------------------------

const COMPAT_NAME_MAP = {
  idle: ['idle', 'stand', 'default', 'breathe'],
  runright: ['walk-right', 'run-right', 'walkright', 'run', 'walk'],
  runleft: ['walk-left', 'run-left', 'walkleft'],
  waving: ['wave', 'waving', 'hello', 'hi'],
  jumping: ['jump', 'celebrate', 'happy', 'jumping'],
  failed: ['sad', 'failed', 'oops', 'error', 'fall', 'startle'],
  waiting: ['wait', 'waiting', 'sleep', 'sleep1'],
  running: ['work', 'working', 'focus', 'busy', 'peck', 'dribble'],
  review: ['think', 'thinking', 'review', 'plan', 'search'],
  look: ['look', 'gaze'],
}

const COMPAT_FPS = {
  idle: 6, runRight: 12, runLeft: 12, waving: 8, jumping: 10,
  failed: 12, waiting: 5, running: 12, review: 6, look: 4,
}

/**
 * 由社区常见的 spritesheet.json 合成一份 pet.json。
 * 行名映射是**启发式**的：认不出来就退回 idle，界面会标「兼容导入」提示用户可能不准。
 */
export function buildCompatManifest(sheet, opts = {}) {
  const cols = Number(sheet && sheet.cols) || 8
  const cell = (sheet && sheet.cell) || {}
  const cellW = Number(cell.w) || 192
  const cellH = Number(cell.h) || 208
  const rows = asArray(sheet && sheet.rows)
  if (!rows.length) return { ok: false, error: 'spritesheet.json 里没有 rows（无法推断动作行）' }

  const maxRow = Math.max(...rows.map((r) => Number(r.index) || 0)) + 1
  // 行数优先用"图集实际高度 ÷ 单格高"（由调用方 readImageHeader 算好传进来）：
  // 上游 json 里的行数经常只是"列出来的动作数"，和真实图集行数对不上，
  // 用错会让注册校验误报"行号超出范围"。
  const rowCount = Number.isInteger(opts.rowsOverride) && opts.rowsOverride > 0
    ? opts.rowsOverride
    : Math.max(maxRow, rows.length)
  const states = {}
  const unmapped = []
  const byKey = {}
  for (const row of rows) {
    const idx = Number(row.index)
    if (!Number.isInteger(idx) || idx < 0 || idx >= rowCount) continue
    const lower = String(row.name || '').toLowerCase().trim()
    let key = null
    for (const [state, aliases] of Object.entries(COMPAT_NAME_MAP)) {
      if (aliases.includes(lower)) { key = state; break }
    }
    if (!key) { unmapped.push({ row: idx, name: row.name }); continue }
    if (byKey[key] === undefined) byKey[key] = idx
  }
  const idleRow = byKey.idle !== undefined ? byKey.idle : 0
  for (const key of ['idle', 'runRight', 'runLeft', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review']) {
    const row = byKey[key]
    const frames = (() => {
      const r = rows.find((x) => Number(x.index) === (row === undefined ? idleRow : row))
      const count = r && Number(r.count)
      return Number.isInteger(count) && count > 0 ? Math.min(count, cols) : Math.min(6, cols)
    })()
    states[key] = row === undefined
      ? { row: idleRow, frames, fps: COMPAT_FPS.idle, aliasOf: 'idle' }
      : { row, frames, fps: COMPAT_FPS[key] || 8 }
  }
  if (byKey.look !== undefined && rowCount > byKey.look) {
    states.look = { row: byKey.look, frames: Math.min(16, cols) }
  }

  const atlasFile = opts.atlasFile || 'assets/spritesheet.png'
  return {
    ok: true,
    manifest: {
      schema: 'dsh-pet/2',
      id: opts.id,
      name: opts.name || opts.id,
      createdAt: new Date().toISOString(),
      generator: { skill: 'dsh-pet-forge', version: '1.0.0', adapter: 'spritesheet-json' },
      source: {
        kind: 'compat',
        adapter: 'spritesheet-json',
        repo: opts.repo || null,
        note: '兼容导入：由社区仓库的 assets/spritesheet.json 合成的清单，动作行映射为启发式，可能与作者本意不完全一致。',
      },
      atlas: { file: atlasFile, cols, rows: rowCount, cellW, cellH },
      states,
      behavior: 'look',
      size: opts.size || 120,
      audio: {},
      triggers: {},
      interactions: {},
      phrases: opts.phrases || [],
      divePhrases: [],
      yaw: null,
      tags: opts.tags || [],
      compat: { unmapped, source: opts.repo || null },
    },
    unmapped,
  }
}

// ---------------------------------------------------------------------------
// 索引条目规范化
// ---------------------------------------------------------------------------

function normalizeIndexEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const parsed = parseRepoUrl(raw.repo || raw.key || '')
  if (!parsed.ok) return null
  const protocol = String(raw.protocol || (raw.license === DPSL_PROTOCOL ? DPSL_PROTOCOL : '') || '')
  return {
    key: parsed.key,
    owner: parsed.owner,
    repo: parsed.repo,
    repoUrl: raw.repo || parsed.url,
    name: String(raw.name || parsed.repo),
    author: String(raw.author || parsed.owner),
    description: String(raw.description || ''),
    tags: asArray(raw.tags).map(String),
    protocol: protocol || null,
    dpsl: protocol === DPSL_PROTOCOL,
    license: raw.license || null,
    statement: raw.statement ? String(raw.statement) : null,
    rights: raw.rights ? String(raw.rights) : null,
    packagePath: raw.packagePath !== undefined ? String(raw.packagePath) : '',
    previewPath: raw.preview ? String(raw.preview) : null,
    contact: raw.contact ? String(raw.contact) : null,
    homepage: raw.homepage ? String(raw.homepage) : null,
    compat: raw.compat ? String(raw.compat) : null,
    addedAt: raw.addedAt || null,
    revoked: raw.revoked === true || raw.hidden === true,
    note: raw.note ? String(raw.note) : null,
    source: 'index',
    stars: Number(raw.stars) || 0,
    updatedAt: raw.updatedAt || null,
    branch: raw.branch ? String(raw.branch) : null,
  }
}

// ---------------------------------------------------------------------------
// 画廊
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object} opts.config   CONFIG.gallery 合并后的配置
 * @param {function} [opts.log]  日志函数（默认 console.error）
 * @param {function} [opts.fetchImpl] 便于测试注入
 */
export function createGallery(opts = {}) {
  const cfg = opts.config || {}
  const log = typeof opts.log === 'function' ? opts.log : (...a) => console.error('[ronaldo-pet/gallery]', ...a)
  const fetchImpl = opts.fetchImpl || globalThis.fetch

  const topics = asArray(cfg.topics).length ? cfg.topics.map(String) : DEFAULT_TOPICS
  const searchApi = cfg.searchApi || 'https://api.github.com/search/repositories'
  const rawBase = String(cfg.rawBase || 'https://raw.githubusercontent.com').replace(/\/+$/, '')
  const codeloadBase = String(cfg.codeloadBase || 'https://codeload.github.com').replace(/\/+$/, '')
  const indexUrl = cfg.indexUrl || ''
  const indexPath = cfg.indexPath || ''
  const cachePath = cfg.cachePath || ''
  const cacheMs = Number(cfg.cacheMs) > 0 ? Number(cfg.cacheMs) : 6 * 3600 * 1000
  const online = cfg.online !== false
  const maxEntries = Number(cfg.maxEntries) > 0 ? Number(cfg.maxEntries) : 60
  const timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 8000
  const token = cfg.token || process.env.DSH_PET_GITHUB_TOKEN || process.env.GITHUB_TOKEN || ''
  const enabled = cfg.enabled !== false
  const curlFallback = cfg.curlFallback !== false
  const curlPath = cfg.curlPath || 'curl'

  const authHeaders = token ? { authorization: `Bearer ${token}` } : {}

  /** 统一的取文本：fetch 优先，失败（含证书问题）换 curl 再试一次。 */
  async function getJson(url, { accept = 'application/json', timeout } = {}) {
    const t = timeout || timeoutMs
    const headers = { accept, ...authHeaders }
    const first = await safeFetch(url, { timeoutMs: t, headers }, fetchImpl)
    if (first.ok || first.status > 0) return first
    if (curlFallback !== false) {
      const viaCurl = await fetchViaCurl(url, { timeoutMs: t, headers, curlPath })
      if (viaCurl.ok || viaCurl.status > 0) return viaCurl
      return { ...first, error: `${first.error}${TLS_HINT}（curl 兜底也失败：${viaCurl.error}）` }
    }
    return { ...first, error: `${first.error}${TLS_HINT}` }
  }

  /** 统一的取二进制：同上。 */
  async function getBytes(url, { timeout, maxBytes } = {}) {
    const t = timeout || Math.max(timeoutMs, 30000)
    const headers = { ...authHeaders }
    const first = await safeFetchBytes(url, { timeoutMs: t, headers }, fetchImpl)
    if (first.ok || first.status > 0) return first
    if (curlFallback !== false) {
      const viaCurl = await fetchViaCurl(url, { timeoutMs: t, headers, binary: true, curlPath })
      if (viaCurl.ok || viaCurl.status > 0) {
        if (maxBytes && viaCurl.bytes && viaCurl.bytes.length > maxBytes) {
          return { ok: false, status: viaCurl.status, error: `归档体积 ${viaCurl.bytes.length} 字节超过上限 ${maxBytes}` }
        }
        return viaCurl
      }
      return { ...first, error: `${first.error}${TLS_HINT}（curl 兜底也失败：${viaCurl.error}）` }
    }
    return { ...first, error: `${first.error}${TLS_HINT}` }
  }

  // ---------- 索引 ----------

  async function loadLocalIndex() {
    if (!indexPath || !existsSync(indexPath)) return { entries: [], source: null, error: null }
    try {
      const data = JSON.parse(await readFile(indexPath, 'utf8'))
      const entries = asArray(data.entries).map(normalizeIndexEntry).filter(Boolean)
      return { entries, source: indexPath, error: null, updatedAt: data.updatedAt || null }
    } catch (err) {
      return { entries: [], source: indexPath, error: `内置索引解析失败：${err.message}` }
    }
  }

  async function loadRemoteIndex() {
    if (!online || !indexUrl) return { entries: [], error: null, skipped: true }
    const res = await getJson(indexUrl, {})
    if (!res.ok || !res.json) {
      return { entries: [], error: `远端索引抓取失败（HTTP ${res.status}${res.error ? ' · ' + res.error : ''}）：${indexUrl}` }
    }
    const entries = asArray(res.json.entries).map(normalizeIndexEntry).filter(Boolean)
    return { entries, error: null, updatedAt: res.json.updatedAt || null }
  }

  // ---------- 发现 ----------

  async function searchRepos() {
    const errors = []
    const repos = []
    for (const topic of topics) {
      const url = `${searchApi}?q=${encodeURIComponent('topic:' + topic)}&per_page=${Math.min(100, maxEntries)}&sort=updated`
      const res = await getJson(url, { accept: 'application/vnd.github+json' })
      if (!res.ok || !res.json) {
        errors.push(
          `GitHub 搜索「${topic}」失败：HTTP ${res.status}${res.error ? ' · ' + res.error : ''}` +
          (res.status === 403 ? '（很可能是未认证的速率限制，可配置 gallery.token 或稍后重试）' : ''),
        )
        continue
      }
      for (const item of asArray(res.json.items)) {
        if (!item || !item.full_name) continue
        const [owner, repo] = String(item.full_name).split('/')
        if (!owner || !repo) continue
        repos.push({
          key: (owner + '/' + repo).toLowerCase(),
          owner,
          repo,
          repoUrl: item.html_url || `https://github.com/${owner}/${repo}`,
          name: repo,
          description: item.description || '',
          tags: asArray(item.topics).map(String),
          stars: Number(item.stargazers_count) || 0,
          updatedAt: item.updated_at || null,
          pushedAt: item.pushed_at || null,
          branch: item.default_branch || 'main',
          license: (item.license && item.license.spdx_id) || null,
        })
      }
    }
    return { repos, errors }
  }

  // ---------- 单仓库探测 ----------

  /** 读 raw 上的一个文件；返回 { ok, text, json, status }。 */
  async function readRaw(owner, repo, branch, rel) {
    const url = `${rawBase}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${encPath(rel)}`
    return getJson(url, { accept: '*/*' })
  }

  /**
   * 探测一个仓库：有没有 pet.json？有没有 DPSL 授权？能不能兼容导入？
   * 最多两跳（pet.json → spritesheet.json），命中即停。
   */
  async function probe(owner, repo, branch = 'main', hints = {}) {
    const out = {
      petJson: null,
      packagePath: hints.packagePath || '',
      dpsl: false,
      statement: null,
      rights: null,
      previewPath: hints.previewPath || null,
      compat: null,
      errors: [],
    }

    const petRel = (out.packagePath ? out.packagePath.replace(/\/+$/, '') + '/' : '') + 'pet.json'
    const petRes = await readRaw(owner, repo, branch, petRel)
    if (petRes.ok && petRes.json && typeof petRes.json === 'object') {
      out.petJson = petRes.json
      const check = validateSharing(petRes.json.sharing)
      out.dpsl = check.ok
      out.statement = petRes.json.sharing ? (petRes.json.sharing.statement || null) : null
      out.rights = petRes.json.sharing ? (petRes.json.sharing.rights || null) : null
      out.previewPath = out.previewPath || (petRes.json.sharing && petRes.json.sharing.preview) || null
      if (!out.dpsl && check.errors.length) out.errors.push(...check.errors.slice(0, 3))
    } else if (petRes.status && petRes.status !== 404) {
      out.errors.push(`读取 pet.json 失败：HTTP ${petRes.status}${petRes.error ? ' · ' + petRes.error : ''}`)
    }

    if (!out.dpsl) {
      // 兼容导入探测：社区同契约变体
      for (const rel of ['assets/spritesheet.json', 'spritesheet.json', 'docs/spritesheet.json']) {
        const r = await readRaw(owner, repo, branch, rel)
        if (r.ok && r.json && Array.isArray(r.json.rows)) {
          out.compat = 'spritesheet-json'
          out.compatPath = rel
          if (!out.previewPath) out.previewPath = 'assets/spritesheet.png'
          break
        }
      }
    }
    return out
  }

  // ---------- 合并 ----------

  const previewUrlFor = (owner, repo, branch, rel) =>
    rel ? `${rawBase}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${encPath(rel)}` : null

  function finalize(entry, probeResult) {
    const p = probeResult || {}
    const branch = entry.branch || 'main'
    const verified = Boolean(p.petJson)
    // 已核验 → 以仓库里 pet.json 的 sharing 块为准（协议第 2.3 条）；
    // 没能核验（离线/索引声明）→ 暂按索引声明展示，界面上标「未核验」。
    const dpsl = verified ? p.dpsl === true : entry.dpsl === true
    const compat = p.compat || (entry.compat === 'spritesheet-json' ? 'spritesheet-json' : null)
    const previewRel = p.previewPath || entry.previewPath || null
    return {
      key: entry.key,
      owner: entry.owner,
      repo: entry.repo,
      repoUrl: entry.repoUrl || `https://github.com/${entry.owner}/${entry.repo}`,
      name: entry.name || entry.repo,
      author: (p.petJson && p.petJson.sharing && p.petJson.sharing.author) || entry.author || entry.owner,
      description: entry.description || (p.petJson && p.petJson.description) || '',
      tags: entry.tags && entry.tags.length ? entry.tags : asArray(p.petJson && p.petJson.tags).map(String),
      stars: entry.stars || 0,
      updatedAt: entry.updatedAt || null,
      pushedAt: entry.pushedAt || null,
      branch,
      protocol: dpsl ? DPSL_PROTOCOL : (p.petJson && p.petJson.sharing ? (p.petJson.sharing.protocol || null) : entry.protocol || null),
      license: (p.petJson && p.petJson.sharing && p.petJson.sharing.license) || entry.license || null,
      dpsl,
      verified,
      statement: p.statement || entry.statement || null,
      rights: p.rights || entry.rights || null,
      // installable 只是界面提示：真正安装时还会重新校验下载到的 pet.json（见 host.js）
      installable: dpsl,
      compat,
      compatPath: p.compatPath || null,
      packagePath: p.packagePath !== undefined ? p.packagePath : (entry.packagePath || ''),
      petId: (p.petJson && p.petJson.id) || null,
      atlas: p.petJson && p.petJson.atlas
        ? { cols: p.petJson.atlas.cols, rows: p.petJson.atlas.rows, cellW: p.petJson.atlas.cellW, cellH: p.petJson.atlas.cellH }
        : null,
      previewUrl: previewUrlFor(entry.owner, entry.repo, branch, previewRel),
      cardUrl: `https://opengraph.githubassets.com/1/${entry.owner}/${entry.repo}`,
      tarballUrl: `${codeloadBase}/${entry.owner}/${entry.repo}/tar.gz/refs/heads/${branch}`,
      contact: entry.contact || `https://github.com/${entry.owner}/${entry.repo}/issues`,
      homepage: entry.homepage || null,
      note: entry.note || null,
      addedAt: entry.addedAt || null,
      source: entry.source || 'discovery',
      problems: asArray(p.errors),
    }
  }

  function mergeEntries(indexEntries, discoveredProbes, discoveredRaw) {
    const byKey = new Map()
    for (const e of indexEntries) {
      if (e.revoked) continue
      byKey.set(e.key, { entry: e, probe: discoveredProbes.get(e.key) })
    }
    for (const raw of discoveredRaw) {
      if (raw.revoked) continue
      const existing = byKey.get(raw.key)
      if (existing) {
        // 索引负责说明性字段，发现负责动态字段
        existing.entry = {
          ...raw,
          ...existing.entry,
          stars: raw.stars,
          updatedAt: raw.updatedAt,
          pushedAt: raw.pushedAt,
          branch: existing.entry.branch || raw.branch,
          source: 'both',
        }
      } else {
        byKey.set(raw.key, { entry: raw, probe: discoveredProbes.get(raw.key) })
      }
    }
    return Array.from(byKey.values())
      .map(({ entry, probe }) => finalize(entry, probe))
      .sort((a, b) => Number(b.installable) - Number(a.installable) || (b.stars - a.stars))
  }

  // ---------- 缓存 ----------

  async function readCache() {
    if (!cachePath) return null
    try {
      const data = JSON.parse(await readFile(cachePath, 'utf8'))
      if (!data || !Array.isArray(data.entries)) return null
      return data
    } catch {
      return null
    }
  }

  async function writeCache(payload) {
    if (!cachePath) return
    try {
      await mkdir(dirname(cachePath), { recursive: true })
      await writeFile(cachePath, JSON.stringify(payload, null, 2), 'utf8')
    } catch (err) {
      log('写缓存失败：' + err.message)
    }
  }

  // ---------- 对外：列表 ----------

  let inflight = null

  async function build(query = {}) {
    const errors = []
    const local = await loadLocalIndex()
    if (local.error) errors.push(local.error)
    const remote = await loadRemoteIndex()
    if (remote.error) errors.push(remote.error)

    const indexByKey = new Map()
    for (const e of [...remote.entries, ...local.entries]) {
      // 本地种子在前、远端在后：远端同名条目的说明字段覆盖本地，但 revoked 保留（本地黑名单优先）
      const prev = indexByKey.get(e.key)
      indexByKey.set(e.key, prev ? { ...prev, ...e, revoked: prev.revoked || e.revoked } : e)
    }
    const indexEntries = Array.from(indexByKey.values())

    let rawRepos = []
    const probeResults = new Map()
    if (online && enabled) {
      const search = await searchRepos()
      errors.push(...search.errors)
      rawRepos = search.repos.slice(0, maxEntries)
      // 逐个探测（并发 6）
      const queue = rawRepos.slice()
      const worker = async () => {
        while (queue.length) {
          const r = await Promise.resolve(queue.shift())
          if (!r) break
          try {
            probeResults.set(r.key, await probe(r.owner, r.repo, r.branch))
          } catch (err) {
            probeResults.set(r.key, { errors: [`探测失败：${err.message}`] })
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker))
    }

    // 索引里已声明的条目也做一次探测（在线时），这样「已核验」标记才有意义
    if (online && enabled) {
      const toProbe = indexEntries.filter((e) => !e.revoked && !probeResults.has(e.key)).slice(0, maxEntries)
      const queue = toProbe.slice()
      const worker = async () => {
        while (queue.length) {
          const e = await Promise.resolve(queue.shift())
          if (!e) break
          try {
            probeResults.set(e.key, await probe(e.owner, e.repo, e.branch || 'main', {
              packagePath: e.packagePath,
              previewPath: e.previewPath,
            }))
          } catch (err) {
            probeResults.set(e.key, { errors: [`探测失败：${err.message}`] })
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker))
    }

    const entries = mergeEntries(indexEntries, probeResults, rawRepos)
    return { entries, errors, online: online && enabled }
  }

  function viewOf(entries, meta) {
    const counts = { total: entries.length, installable: 0, compat: 0, listed: 0, dpsl: 0 }
    for (const e of entries) {
      if (e.dpsl) counts.dpsl++
      if (e.installable) counts.installable++
      else if (e.compat) counts.compat++
      else counts.listed++
    }
    return {
      ok: true,
      protocol: DPSL_PROTOCOL,
      galleryProtocol: GALLERY_PROTOCOL,
      ...meta,
      counts,
      entries,
    }
  }

  /** 列出（带缓存）。force=true 忽略缓存。 */
  async function listEntries({ force = false } = {}) {
    if (!enabled && !indexPath && !cachePath) {
      return viewOf([], { cachedAt: null, stale: false, online: false, errors: ['画廊已在配置里关闭（gallery.enabled=false）'] })
    }
    const cache = await readCache()
    const age = cache && cache.fetchedAt ? nowMs() - Date.parse(cache.fetchedAt) : Infinity
    if (!force && cache && age < cacheMs) {
      return viewOf(cache.entries, {
        cachedAt: cache.fetchedAt,
        stale: false,
        online: cache.online !== false,
        errors: asArray(cache.errors),
        cacheAgeMs: age,
      })
    }
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const built = await build()
        await writeCache({
          version: 1,
          fetchedAt: new Date().toISOString(),
          online: built.online,
          entries: built.entries,
          errors: built.errors.slice(0, 5),
        })
        return viewOf(built.entries, {
          cachedAt: new Date().toISOString(),
          stale: false,
          online: built.online,
          errors: built.errors,
          cacheAgeMs: 0,
        })
      } catch (err) {
        if (cache) {
          return viewOf(cache.entries, {
            cachedAt: cache.fetchedAt,
            stale: true,
            online: false,
            errors: [`刷新失败，回退到缓存：${err.message}`],
          })
        }
        return viewOf([], { cachedAt: null, stale: true, online: false, errors: [String((err && err.message) || err)] })
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  /** 拿一条缓存/索引里的条目（找不到返回 null）。 */
  async function getEntry(key) {
    const res = await listEntries()
    const k = String(key || '').toLowerCase()
    return res.entries.find((e) => e.key === k) || null
  }

  return {
    config: { ...cfg, topics, online, searchApi, rawBase, codeloadBase },
    topics,
    list: listEntries,
    get: getEntry,

    /** 现场探测一个仓库地址（用于界面里手填 owner/repo）。 */
    async probeRepo(input) {
      const parsed = parseRepoUrl(input)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      const cached = await getEntry(parsed.key)
      if (cached) return { ok: true, entry: cached, cached: true }
      let branch = 'main'
      // 猜默认分支：先 main 再 master
      let probeResult = await probe(parsed.owner, parsed.repo, 'main')
      if (!probeResult.petJson && !probeResult.compat) {
        const second = await probe(parsed.owner, parsed.repo, 'master')
        if (second.petJson || second.compat) { probeResult = second; branch = 'master' }
      }
      const entry = finalize(
        {
          key: parsed.key, owner: parsed.owner, repo: parsed.repo, repoUrl: parsed.url,
          name: parsed.repo, source: 'manual', branch,
        },
        probeResult,
      )
      return { ok: true, entry, cached: false }
    },

    /** 下载归档（内存里，带体积上限）。 */
    async fetchArchive({ owner, repo, branch = 'main', maxBytes }) {
      const cap = Number(maxBytes) > 0 ? Number(maxBytes) : Number(cfg.maxDownloadBytes) > 0 ? Number(cfg.maxDownloadBytes) : 96 * 1024 * 1024
      const branches = [branch, branch === 'main' ? 'master' : 'main']
      const tried = []
      for (const b of branches) {
        const url = `${codeloadBase}/${owner}/${repo}/tar.gz/refs/heads/${b}`
        const res = await getBytes(url, { timeout: Math.max(timeoutMs, 30000), maxBytes: cap })
        if (res.ok && res.bytes) {
          if (res.bytes.length > cap) {
            return { ok: false, error: `归档体积 ${res.bytes.length} 字节超过上限 ${cap}（可用 gallery.maxDownloadBytes 调整）`, tried }
          }
          return { ok: true, bytes: res.bytes, branch: b, url, source: 'codeload', transport: res.transport || 'fetch' }
        }
        tried.push({ url, status: res.status, error: res.error })
      }
      return { ok: false, error: `下载失败：${tried.map((t) => `${t.url} → HTTP ${t.status}${t.error ? ' · ' + t.error : ''}`).join('；')}`, tried }
    },

    /** 解包到目录（会先清空目标目录）。 */
    async extract(bytes, destDir) {
      const parsed = untarGz(bytes, { maxBytes: Number(cfg.maxExtractBytes) || 512 * 1024 * 1024 })
      if (!parsed.ok) return parsed
      await rm(destDir, { recursive: true, force: true })
      await mkdir(destDir, { recursive: true })
      const written = await writeEntries(parsed.entries, destDir)
      return { ok: true, ...written, skippedLinks: parsed.skipped }
    },

    _internals: { probe, build, mergeEntries, normalizeIndexEntry, listEntries },
  }
}
