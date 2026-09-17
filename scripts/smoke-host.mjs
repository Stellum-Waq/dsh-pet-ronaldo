#!/usr/bin/env node
// =============================================================================
// dsh-ronaldo-pet · Host 半集成冒烟测试
// -----------------------------------------------------------------------------
// 在一个**独立进程 + 独立端口**里加载 host.js（用桩 ctx 代替 cordis 运行时），
// 然后真实地走一遍 HTTP 路由：
//   state / pets / asset 直出 / 注册 / 拒绝坏包 / 更新 / 设置 / 播放音效 / 卸载
//
// 为什么需要它：插件改动要重启 `dsh web` 才生效，但重启会打断正在进行的会话。
// 有了这个脚本，"接口是否真的通了"可以在不碰线上进程的前提下验证。
//
//   node scripts/smoke-host.mjs [--port 0] [--keep]
// =============================================================================

import http from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')
const SKILL = join(REPO, 'skill', 'dsh-pet-forge', 'scripts', 'lib')

// 动态 import：路径在运行时才知道（工作区路径含中文，必须走 file:// URL）
const imaging = await import(pathToFileURL(join(SKILL, 'imaging.mjs')).href)
const audioLib = await import(pathToFileURL(join(SKILL, 'audio.mjs')).href)
const manifestLib = await import(pathToFileURL(join(SKILL, 'manifest.mjs')).href)

const { newImg, setPixel, encodeImage } = imaging
const { encodeWav, synthSfx } = audioLib
const { makeManifest, writeManifest, buildDefaultStates } = manifestLib

let failures = 0
function check(label, cond, detail = '') {
  if (cond) console.log(`  ok   ${label}${detail ? '  — ' + detail : ''}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? '  — ' + detail : ''}`) }
}

// ---------- 桩：webServer ----------
function makeWebServer() {
  const exact = new Map()
  const prefixes = new Map()
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    if (exact.has(p)) return exact.get(p)(req, res)
    let best = null
    for (const [k, h] of prefixes) {
      if ((p === k || p.startsWith(k + '/')) && (!best || k.length > best[0].length)) best = [k, h]
    }
    if (best) return best[1](req, res)
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  const api = {
    server,
    // 真实的 DSH webServer 会把自己监听的端口挂在 .port 上（host.js 的 desktopBase() 依赖它），
    // 桩也必须给 —— 否则 desktopBase() 返回 null，从宿主拉起来的视频任务会去猜端口，
    // 结果把宠物注册到**另一个正在跑的 dsh 实例**上（这个坑真踩到过）。
    port: 0,
    register(route) {
      if (route.kind === 'exact') {
        if (exact.has(route.path)) throw new Error('duplicate exact route ' + route.path)
        exact.set(route.path, route.handler)
        return () => exact.delete(route.path)
      }
      if (prefixes.has(route.path)) throw new Error('duplicate prefix route ' + route.path)
      prefixes.set(route.path, route.handler)
      return () => prefixes.delete(route.path)
    },
    listen: (port) => new Promise((r) => server.listen(port, '127.0.0.1', () => { api.port = server.address().port; r(api.port) })),
    close: () => new Promise((r) => server.close(r)),
  }
  return api
}

// ---------- 桩：cordis ctx ----------
function makeCtx(webServer, calls) {
  const services = {
    fs: undefined,
    agents: { list: () => [] },
    shell: {
      resolve: (input) => ({ input }),
      run: async (spec) => { calls.shell.push(spec); return { ok: true } },
    },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '' }) },
  }
  const intervals = []
  return {
    webServer,
    get: (n) => services[n],
    interval: (fn, ms) => { const t = setInterval(fn, ms); intervals.push(t); return () => clearInterval(t) },
    timeout: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t) },
    on: () => {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    _stop: () => { for (const t of intervals) clearInterval(t) },
  }
}

// ---------- 造一个合法宠物包 ----------
function drawBlob(w, h, color) {
  const img = newImg(w, h)
  const cx = w / 2
  const cy = h / 2
  const r = Math.min(w, h) * 0.4
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) setPixel(img, x, y, color[0], color[1], color[2], 255)
    }
  }
  return img
}

async function makePetPackage(dir, opts = {}) {
  const cols = opts.cols || 8
  const rows = opts.rows || 11
  const cellW = opts.cellW || 32
  const cellH = opts.cellH || 32
  await mkdir(join(dir, 'audio'), { recursive: true })
  const atlas = newImg(cols * cellW, rows * cellH)
  // 第 0 行画点内容，其余保持透明（契约要求）
  for (let c = 0; c < cols; c++) {
    const blob = drawBlob(cellW, cellH, [60, 140 + c * 10, 220])
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        const si = (y * cellW + x) * 4
        if (blob.data[si + 3] === 0) continue
        const di = (y * (cols * cellW) + c * cellW + x) * 4
        atlas.data[di] = blob.data[si]
        atlas.data[di + 1] = blob.data[si + 1]
        atlas.data[di + 2] = blob.data[si + 2]
        atlas.data[di + 3] = blob.data[si + 3]
      }
    }
  }
  await writeFile(join(dir, 'atlas.png'), encodeImage(atlas))
  await writeFile(join(dir, 'audio', 'celebrate.wav'), encodeWav(synthSfx('celebrate')))

  const manifest = makeManifest({
    id: opts.id || 'smoke-pet',
    name: opts.name || '冒烟宠物',
    atlas: { file: 'atlas.png', cols, rows, cellW, cellH },
    states: buildDefaultStates({ cols, rows, cellW, cellH }, ['idle']),
    audio: { celebrate: { file: 'audio/celebrate.wav', label: '冒烟庆祝' } },
    triggers: { celebrating: 'celebrate' },
    interactions: { click: 'celebrate' },
  })
  if (opts.breakAtlas) {
    // 故意把图集换成尺寸不匹配的，验证宿主会拒绝
    manifest.atlas.cellW = cellW + 4
  }
  if (opts.dropAudio) delete manifest.audio
  await writeManifest(dir, manifest)
  return { dir, manifest }
}

// ---------- HTTP 助手 ----------
async function get(base, path, asBytes = false) {
  const res = await fetch(base + path)
  if (asBytes) return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers }
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, text, headers: res.headers }
}
async function post(base, path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

function readImageHeader(bytes) {
  const b = bytes
  if (b.length > 33 && b[0] === 0x89 && b[1] === 0x50) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), format: 'png' }
  }
  if (b.length > 30 && b.toString('latin1', 8, 12) === 'WEBP') {
    const f = b.toString('latin1', 12, 16)
    if (f === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)), format: 'webp' }
    if (f === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, format: 'webp' }
    if (f === 'VP8L') { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1, format: 'webp' } }
  }
  return null
}

// ---------- tar.gz 造包（用来验证"下载 → 解包"整条链路，也是 untarGz 的往返测试） ----------
//
// 故意手写 ustar：被测代码（lib/gallery.mjs 的 untarGz）也是手写的解析器，
// 用同一套规格下的"真"归档来跑，才能验出头部字段偏移、八进制尺寸、512 对齐这些坑。
function tarHeader(name, size) {
  const buf = Buffer.alloc(512)
  buf.write(name.slice(0, 99), 0, 100, 'utf8')
  buf.write('0000644\0', 100, 8, 'latin1')            // mode
  buf.write('0000000\0', 108, 8, 'latin1')            // uid
  buf.write('0000000\0', 116, 8, 'latin1')            // gid
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'latin1')
  buf.write('00000000000\0', 136, 12, 'latin1')       // mtime
  buf.write('        ', 148, 8, 'latin1')             // chksum（先填空格再算）
  buf.write('0', 156, 1, 'latin1')                    // typeflag = 普通文件
  buf.write('ustar\0', 257, 6, 'latin1')
  buf.write('00', 263, 2, 'latin1')
  let sum = 0
  for (let i = 0; i < 512; i++) sum += buf[i]
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1')
  return buf
}

function makeTarGz(files, opts = {}) {
  const top = opts.topDir === undefined ? 'pet-main' : opts.topDir
  const parts = []
  for (const [rel, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
    parts.push(tarHeader(top ? `${top}/${rel}` : rel, data.length))
    parts.push(data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

// ---------- GitHub 桩服务器 ----------
// 把"搜索 API / raw / codeload"三个地址指到本地，整条「发现 → 探测 → 下载 → 解包 → 校验 → 注册」
// 就能在没有外网的环境里被完整验证（也顺便让 gallery.searchApi/rawBase/codeloadBase 这几个
// 配置项有了存在理由：企业内网换成自己的镜像时走的是同一套代码）。
function makeGithubStub() {
  const routes = new Map()
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const hit = routes.get(u.pathname)
    if (!hit) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('stub: not found ' + u.pathname)
      return
    }
    const body = typeof hit.body === 'function' ? hit.body() : hit.body
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
    res.writeHead(hit.status || 200, { 'content-type': hit.type || 'application/json', 'content-length': String(bytes.length) })
    res.end(bytes)
  })
  return {
    server,
    set(path, body, opts = {}) { routes.set(path, { body, status: opts.status, type: opts.type }); return this },
    json(path, obj) { return this.set(path, JSON.stringify(obj)) },
    gz(path, buf) { return this.set(path, buf, { type: 'application/gzip' }) },
    // 真实的 DSH webServer 会把自己监听的端口挂在 .port 上（host.js 的 desktopBase() 依赖它），
    // 桩也要给 —— 否则视频任务拿到的是 http://127.0.0.1:0，子进程只会去猜别的端口。
    listen: (port) => new Promise((r) => server.listen(port, '127.0.0.1', () => { server.port = server.address().port; r(server.port) })),
    close: () => new Promise((r) => server.close(r)),
  }
}

/** 造一份能过校验的宠物包文件表（不落盘，直接喂给 tar）。 */
function petPackageFiles(opts = {}) {
  const cols = 8
  const rows = 11
  const cellW = 8
  const cellH = 8
  const atlas = newImg(cols * cellW, rows * cellH)
  for (let c = 0; c < cols; c++) {
    const blob = drawBlob(cellW, cellH, [90, 160, 240])
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        const si = (y * cellW + x) * 4
        if (blob.data[si + 3] === 0) continue
        const di = (y * (cols * cellW) + c * cellW + x) * 4
        for (let k = 0; k < 4; k++) atlas.data[di + k] = blob.data[si + k]
      }
    }
  }
  const manifest = makeManifest({
    id: opts.id || 'community-pet',
    name: opts.name || '社区宠物',
    atlas: { file: 'assets/atlas.png', cols, rows, cellW, cellH },
    states: buildDefaultStates({ cols, rows, cellW, cellH }, ['idle']),
    audio: {},
  })
  manifest.atlas.file = 'assets/atlas.png'
  if (opts.sharing !== undefined) manifest.sharing = opts.sharing
  return { 'pet.json': JSON.stringify(manifest, null, 2), 'assets/atlas.png': encodeImage(atlas) }
}

/** 造一份社区常见的 spritesheet.json + 图集（兼容导入用）。 */
function compatPackageFiles() {
  const cols = 8
  const cellW = 8
  const cellH = 8
  const rowsSpec = [
    { index: 0, name: 'idle', count: 6 },
    { index: 1, name: 'walk-right', count: 8 },
    { index: 2, name: 'walk-left', count: 8 },
    { index: 3, name: 'wave', count: 6 },
    { index: 4, name: 'jump', count: 8 },
    { index: 5, name: 'sad', count: 6 },
    { index: 6, name: 'wait', count: 6 },
    { index: 7, name: 'work', count: 6 },
    { index: 8, name: 'think', count: 6 },
    { index: 9, name: 'flap', count: 6 },
  ]
  const rows = Math.max(...rowsSpec.map((r) => r.index)) + 1
  const atlas = newImg(cols * cellW, rows * cellH)
  for (let c = 0; c < cols; c++) {
    const blob = drawBlob(cellW, cellH, [240, 200, 90])
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        const si = (y * cellW + x) * 4
        if (blob.data[si + 3] === 0) continue
        const di = (y * (cols * cellW) + c * cellW + x) * 4
        for (let k = 0; k < 4; k++) atlas.data[di + k] = blob.data[si + k]
      }
    }
  }
  return {
    'assets/spritesheet.json': JSON.stringify({ cols, cell: { w: cellW, h: cellH }, rows: rowsSpec }, null, 2),
    'assets/spritesheet.png': encodeImage(atlas),
  }
}

const DPSL_SHARING = (repo, author) => ({
  protocol: 'DPSL-1.0',
  shared: true,
  author,
  repo,
  license: 'DPSL-1.0',
  statement: '本桌宠包由我本人创作，或我已获得其全部素材的分发授权；我同意按 DPSL-1.0 收录进 DSH 桌宠社区。',
  tags: ['像素风'],
  allowRemix: true,
  allowCommercial: false,
})


async function main() {
  const args = process.argv.slice(2)
  const keep = args.includes('--keep')
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-pet-smoke-'))
  const registryPath = join(tmp, 'registry.json')
  const petDir = join(tmp, 'pets', 'smoke-pet')
  const badDir = join(tmp, 'pets', 'bad-pet')

  console.log('dsh-ronaldo-pet · Host 冒烟测试')
  console.log('临时目录：' + tmp)
  console.log('注册表：' + registryPath)

  const webServer = makeWebServer()
  const calls = { shell: [] }
  const ctx = makeCtx(webServer, calls)

  // ---------- GitHub 桩：画廊的三个外部地址全指到本地 ----------
  const stub = makeGithubStub()
  const stubPort = await stub.listen(0)
  const stubBase = `http://127.0.0.1:${stubPort}`
  const installDir = join(tmp, 'community')

  const nowIso = new Date().toISOString()
  const repoItem = (full, desc, stars, topics) => ({
    full_name: full,
    html_url: 'https://github.com/' + full,
    description: desc,
    topics,
    stargazers_count: stars,
    default_branch: 'main',
    updated_at: nowIso,
    pushed_at: nowIso,
    license: null,
  })
  stub.set('/search/repositories', JSON.stringify({
    total_count: 4,
    items: [
      repoItem('alice/pixel-cat', '一只像素猫', 12, ['dsh-pet', 'pixel-art']),
      repoItem('bob/no-license-pet', '有图集但没有 pet.json', 3, ['dsh-pet']),
      repoItem('carol/withdrawn-pet', '作者已把 shared 改成 false', 1, ['dsh-pet']),
      repoItem('dave/drifted-pet', 'raw 上是授权版，归档里是撤回版（模拟漂移）', 0, ['dsh-pet']),
    ],
  }))

  // 官方索引（远端）：alice 同时出现在索引与自动发现里 -> source=both
  stub.json('/raw/seed/index.json', {
    protocol: 'dsh-pet-gallery/1',
    updatedAt: nowIso,
    entries: [
      {
        key: 'alice/pixel-cat',
        repo: 'https://github.com/alice/pixel-cat',
        name: '索引里的像素猫',
        author: 'Alice',
        description: '来自官方索引的条目',
        tags: ['像素风', '猫'],
        protocol: 'DPSL-1.0',
        license: 'DPSL-1.0',
        packagePath: '',
        addedAt: nowIso,
      },
    ],
  })
  // 包内置索引（本地种子）：一条被 revoked 的黑名单条目，必须永不出现
  const seedIndexPath = join(tmp, 'seed-index.json')
  await writeFile(seedIndexPath, JSON.stringify({
    protocol: 'dsh-pet-gallery/1',
    updatedAt: nowIso,
    entries: [
      {
        key: 'mallory/evil-pet',
        repo: 'https://github.com/mallory/evil-pet',
        name: '被拉黑的条目',
        protocol: 'DPSL-1.0',
        revoked: true,
      },
    ],
  }), 'utf8')

  // raw：各仓库的 pet.json / spritesheet.json
  stub.json('/raw/alice/pixel-cat/main/pet.json',
    JSON.parse(petPackageFiles({ id: 'pixel-cat', name: '像素猫', sharing: DPSL_SHARING('https://github.com/alice/pixel-cat', 'Alice') })['pet.json']))
  stub.set('/raw/bob/no-license-pet/main/pet.json', 'not found', { status: 404, type: 'text/plain' })
  stub.json('/raw/bob/no-license-pet/main/assets/spritesheet.json',
    JSON.parse(compatPackageFiles()['assets/spritesheet.json']))
  stub.json('/raw/carol/withdrawn-pet/main/pet.json', JSON.parse(
    petPackageFiles({ id: 'withdrawn', sharing: Object.assign(DPSL_SHARING('https://github.com/carol/withdrawn-pet', 'Carol'), { shared: false }) })['pet.json']))
  stub.json('/raw/dave/drifted-pet/main/pet.json', JSON.parse(
    petPackageFiles({ id: 'drifted', sharing: DPSL_SHARING('https://github.com/dave/drifted-pet', 'Dave') })['pet.json']))

  // codeload：归档内容
  stub.gz('/codeload/alice/pixel-cat/tar.gz/refs/heads/main',
    makeTarGz(petPackageFiles({ id: 'pixel-cat', name: '像素猫', sharing: DPSL_SHARING('https://github.com/alice/pixel-cat', 'Alice') }), { topDir: 'pixel-cat-main' }))
  stub.gz('/codeload/bob/no-license-pet/tar.gz/refs/heads/main',
    makeTarGz(compatPackageFiles(), { topDir: 'no-license-pet-main' }))
  stub.gz('/codeload/dave/drifted-pet/tar.gz/refs/heads/main',
    makeTarGz(petPackageFiles({ id: 'drifted', sharing: Object.assign(DPSL_SHARING('https://github.com/dave/drifted-pet', 'Dave'), { shared: false }) }), { topDir: 'drifted-pet-main' }))
  // 恶意归档：一个 ../ 越界文件 + 一个绝对路径文件，都必须不落地
  const evilFiles = petPackageFiles({ id: 'evil', sharing: DPSL_SHARING('https://github.com/mallory/evil-pet', 'Mallory') })
  const evilTar = (() => {
    const parts = []
    for (const [rel, content] of Object.entries(evilFiles)) {
      const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
      parts.push(tarHeader('evil-pet-main/' + rel, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512))
    }
    for (const bad of ['../escaped.txt', '/tmp/absolute-escaped.txt', 'evil-pet-main/a/../../escaped2.txt']) {
      const data = Buffer.from('pwned', 'utf8')
      parts.push(tarHeader(bad, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512))
    }
    parts.push(Buffer.alloc(1024))
    return gzipSync(Buffer.concat(parts))
  })()
  stub.gz('/codeload/mallory/evil-pet/tar.gz/refs/heads/main', evilTar)

  const host = await import(pathToFileURL(join(REPO, 'host.js')).href)
  check('host.js 导出 name / apply', host.name === 'ronaldo-pet' && typeof host.apply === 'function')
  check('host.js 声明 inject webServer', Array.isArray(host.inject) && host.inject.includes('webServer'))

  host.apply(ctx, {
    registryPath,
    pollMs: 100000,
    // 冒烟测试不能真的去拉一个桌面窗口起来（会留下游离进程），
    // 所以显式关掉。桌面启动逻辑由 scripts/detached-probe.mjs 单独验证。
    desktopPet: false,
    // 画廊：三个外部地址全指向桩服务器，cacheMs=1 让每次都真的重抓
    gallery: {
      enabled: true,
      online: true,
      indexUrl: `${stubBase}/raw/seed/index.json`,
      indexPath: seedIndexPath,
      cachePath: join(tmp, 'gallery-cache.json'),
      installDir,
      searchApi: `${stubBase}/search/repositories`,
      rawBase: `${stubBase}/raw`,
      codeloadBase: `${stubBase}/codeload`,
      cacheMs: 1,
      timeoutMs: 6000,
      curlFallback: false,
    },
    // 视频生成：产物写进临时目录（默认落在 DSH_HOME，冒烟测试绝不能碰用户的真实目录）
    video: { generateDir: join(tmp, 'generated') },
  })
  const port = await webServer.listen(0)
  const base = `http://127.0.0.1:${port}`
  // 等注册表加载完（boot 是异步的）
  await new Promise((r) => setTimeout(r, 300))

  // ---------- 1. state ----------
  console.log('\n[1] GET /ronaldo-pet/state')
  const st = await get(base, '/ronaldo-pet/state')
  check('返回 200 且是 JSON', st.status === 200 && st.json && typeof st.json.mode === 'string', 'mode=' + (st.json && st.json.mode))
  check('带 revision / petCount', typeof st.json.revision === 'number' && typeof st.json.petCount === 'number', `revision=${st.json.revision} pets=${st.json.petCount}`)

  // ---------- 2. pets 列表（内置 C罗） ----------
  console.log('\n[2] GET /ronaldo-pet/pets（内置宠物）')
  const pets1 = await get(base, '/ronaldo-pet/pets')
  check('返回 ok 与数组', pets1.json && pets1.json.ok === true && Array.isArray(pets1.json.pets))
  const ronaldo = pets1.json.pets.find((p) => p.id === 'ronaldo')
  check('内置 C罗 在场', Boolean(ronaldo), ronaldo ? ronaldo.name : '(缺失)')
  check('内置宠物带图集 URL 与状态表', Boolean(ronaldo && ronaldo.sheet && ronaldo.sheet.url && ronaldo.states && ronaldo.states.idle))
  check('内置宠物带音效 URL', Boolean(ronaldo && ronaldo.audio && ronaldo.audio.celebrate && ronaldo.audio.celebrate.url))

  // 内置宠物的 DPSL 声明写在插件仓库根目录的 pet.json 里，所以这里必须把它挡回去，
  // 免得用户点了「分享」却把声明写进插件自己的安装目录
  const builtinShareGuard = await post(base, '/ronaldo-pet/gallery/share', { id: 'ronaldo', accept: true, author: 'x', repo: 'https://github.com/x/y' })
  check('内置宠物不能被当成"待分享的自制宠物"', builtinShareGuard.status === 400 && /内置/.test(String(builtinShareGuard.json.error)),
    'HTTP ' + builtinShareGuard.status + ' ' + String(builtinShareGuard.json.error))

  // ---------- 3. 素材直出 ----------
  console.log('\n[3] GET /ronaldo-pet/asset/... 素材直出')
  const sheet = await get(base, ronaldo.sheet.url, true)
  const head = readImageHeader(sheet.bytes)
  check('图集返回 200 + 图片内容类型', sheet.status === 200 && /image\//.test(sheet.headers.get('content-type')), sheet.headers.get('content-type'))
  check(
    '图集尺寸严格等于 8×11 · 192×208',
    head && head.width === 8 * 192 && head.height === 11 * 208,
    head ? `${head.width}×${head.height}` : '头部无法解析',
  )
  const audio = await get(base, ronaldo.audio.celebrate.url, true)
  check('音频返回 200 + audio/mpeg', audio.status === 200 && /audio\//.test(audio.headers.get('content-type')), audio.headers.get('content-type'))
  check('音频内容以 ID3/帧同步开头', audio.bytes.length > 1000)

  const escape = await get(base, '/ronaldo-pet/asset/ronaldo/../../../../etc/passwd', true)
  check('目录穿越被拦住', escape.status === 404 || escape.status === 400, 'HTTP ' + escape.status)

  // ---------- 4. 注册合法宠物包 ----------
  console.log('\n[4] POST /ronaldo-pet/pets/register（合法包）')
  const good = await makePetPackage(petDir, { id: 'smoke-pet', name: '冒烟宠物' })
  const reg = await post(base, '/ronaldo-pet/pets/register', { dir: petDir })
  check('注册成功', reg.status === 200 && reg.json && reg.json.ok === true, JSON.stringify(reg.json && reg.json.error || ''))
  check('返回宠物视图含动作与音效', Boolean(reg.json && reg.json.pet && reg.json.pet.states && reg.json.pet.audio.celebrate))
  const pets2 = await get(base, '/ronaldo-pet/pets')
  check('列表里出现了新宠物', pets2.json.pets.some((p) => p.id === 'smoke-pet'), '共 ' + pets2.json.pets.length + ' 只')

  const newSheet = await get(base, reg.json.pet.sheet.url, true)
  const newHead = readImageHeader(newSheet.bytes)
  check('新宠物图集可直出且尺寸正确', newHead && newHead.width === 8 * 32 && newHead.height === 11 * 32, newHead ? `${newHead.width}×${newHead.height}` : '解析失败')
  const newAudio = await get(base, reg.json.pet.audio.celebrate.url, true)
  check('新宠物音效可直出', newAudio.status === 200 && newAudio.bytes.length > 100)

  // ---------- 5. 拒绝坏包 ----------
  console.log('\n[5] POST /ronaldo-pet/pets/register（尺寸不匹配的坏包）')
  await makePetPackage(badDir, { id: 'bad-pet', breakAtlas: true })
  const bad = await post(base, '/ronaldo-pet/pets/register', { dir: badDir })
  check('被拒绝（422）', bad.status === 422, 'HTTP ' + bad.status)
  check('给出可读的中文原因', Boolean(bad.json && Array.isArray(bad.json.errors) && /尺寸/.test(bad.json.errors.join(''))), (bad.json && bad.json.errors && bad.json.errors[0]) || '')
  const pets3 = await get(base, '/ronaldo-pet/pets')
  check('坏包没有进列表', !pets3.json.pets.some((p) => p.id === 'bad-pet'))

  // 缺 pet.json 的目录
  const emptyDir = join(tmp, 'pets', 'empty')
  await mkdir(emptyDir, { recursive: true })
  const noJson = await post(base, '/ronaldo-pet/pets/register', { dir: emptyDir })
  check('缺 pet.json 被拒绝（400）', noJson.status === 400, 'HTTP ' + noJson.status)

  // ---------- 6. 更新与持久化 ----------
  console.log('\n[6] POST /ronaldo-pet/pets/update 与注册表落盘')
  const upd = await post(base, '/ronaldo-pet/pets/update', { id: 'smoke-pet', patch: { name: '改名了', size: 200, visible: false, pos: { left: 12, top: 34 } } })
  check('更新成功', upd.status === 200 && upd.json.ok === true)
  check('字段真的改了', upd.json.pet.name === '改名了' && upd.json.pet.size === 200 && upd.json.pet.visible === false && upd.json.pet.pos.left === 12)
  await new Promise((r) => setTimeout(r, 200))
  const onDisk = JSON.parse(await readFile(registryPath, 'utf8'))
  check('注册表已写入磁盘', existsSync(registryPath) && Array.isArray(onDisk.pets))
  check('磁盘上保留了改名与位置', onDisk.pets.some((p) => p.id === 'smoke-pet' && p.name === '改名了' && p.pos && p.pos.left === 12))
  check('越界尺寸被夹紧', (await post(base, '/ronaldo-pet/pets/update', { id: 'smoke-pet', patch: { size: 99999 } })).json.pet.size === 400)

  // ---------- 7. 设置 ----------
  console.log('\n[7] POST /ronaldo-pet/settings')
  const set = await post(base, '/ronaldo-pet/settings', { patch: { audioMode: 'all', systemSound: false } })
  check('设置可更新', set.json.ok === true && set.json.settings.audioMode === 'all' && set.json.settings.systemSound === false)
  const badSet = await post(base, '/ronaldo-pet/settings', { patch: { audioMode: '乱写的' } })
  check('非法值被忽略', badSet.json.settings.audioMode === 'all')

  // ---------- 8. 播放音效（走桩 shell） ----------
  console.log('\n[8] POST /ronaldo-pet/play')
  const play = await post(base, '/ronaldo-pet/play', { id: 'smoke-pet', key: 'celebrate' })
  check('播放调用成功', play.json.ok === true, play.json.human || play.json.error)
  check('确实下发了宿主播放命令', calls.shell.length === 1)
  const cmd = calls.shell.length ? String(calls.shell[0].input.command) : ''
  check(
    'Windows 命令是单层 PowerShell（没有嵌套 powershell.exe，避免 $m 被插值吃掉）',
    process.platform !== 'win32' || (cmd.includes('MediaPlayer') && !/powershell(\.exe)?\s+-Command/i.test(cmd)),
    cmd.slice(0, 90) + (cmd.length > 90 ? '…' : ''),
  )
  const playMissing = await post(base, '/ronaldo-pet/play', { id: 'smoke-pet', key: '不存在的音效' })
  check('未知音效返回 404 且列出可用项', playMissing.status === 404 && /可用/.test(playMissing.json.error || ''))

  // ---------- 9. 旧接口兼容 ----------
  console.log('\n[9] 旧接口 /import-image 兼容')
  const legacy = await post(base, '/ronaldo-pet/import-image', { path: join(petDir, 'atlas.png'), cols: 8, rows: 11, cellW: 32, cellH: 32 })
  check('合法图片通过并返回状态表', legacy.json.ok === true && legacy.json.states && legacy.json.states.idle)
  const legacyBad = await post(base, '/ronaldo-pet/import-image', { path: join(petDir, 'atlas.png'), cols: 8, rows: 11, cellW: 99, cellH: 99 })
  check('尺寸不匹配被拒绝（422）', legacyBad.status === 422, legacyBad.json.error || '')

  // ---------- 10. 卸载 ----------
  console.log('\n[10] POST /ronaldo-pet/pets/unregister')
  const un = await post(base, '/ronaldo-pet/pets/unregister', { id: 'smoke-pet' })
  check('卸载成功', un.json.ok === true)
  const pets4 = await get(base, '/ronaldo-pet/pets')
  check('列表里已消失', !pets4.json.pets.some((p) => p.id === 'smoke-pet'))
  // 注意：内置宠物的移除测试放在最后（[12]），因为 [11] 还要用 ronaldo 当默认宠物，
  // 提前删掉会让 [11] 的断言失真。

  // ---------- 11. 默认宠物（同一时间只开一只） ----------
  console.log('\n[11] 默认宠物：同一时间只开一只')
  const visibleIds = async () => {
    const r = await get(base, '/ronaldo-pet/pets')
    return { ids: r.json.pets.filter((p) => p.visible).map((p) => p.id), def: r.json.settings.defaultPet }
  }

  const reg2 = await post(base, '/ronaldo-pet/pets/register', { dir: petDir })
  check('注册返回 focused 标记', reg2.json.focused === true, 'focused=' + reg2.json.focused)
  let vis = await visibleIds()
  check('新注册的宠物自动成为默认', vis.def === 'smoke-pet', '默认=' + vis.def)
  check('其它宠物被自动收起（不会站一排）', vis.ids.length === 1 && vis.ids[0] === 'smoke-pet', '显示中: ' + vis.ids.join(', '))

  const reg3 = await post(base, '/ronaldo-pet/pets/register', { dir: petDir, focus: false })
  check('focus:false 返回 focused=false', reg3.json.focused === false)
  vis = await visibleIds()
  check('focus:false 时该宠物被收起', !vis.ids.includes('smoke-pet'), '显示中: ' + vis.ids.join(', '))
  check('focus:false 不改动默认宠物', vis.def === 'smoke-pet', '默认=' + vis.def)

  // manualShow：手动打开过的，之后切默认不会被误收起
  await post(base, '/ronaldo-pet/pets/update', { id: 'smoke-pet', patch: { visible: true } })
  await post(base, '/ronaldo-pet/pets/update', { id: 'ronaldo', patch: { makeDefault: true } })
  vis = await visibleIds()
  check('切默认后新默认显示', vis.ids.includes('ronaldo'), '显示中: ' + vis.ids.join(', '))
  check('手动打开过的宠物不会被误收起', vis.ids.includes('smoke-pet'), '显示中: ' + vis.ids.join(', '))

  await new Promise((r) => setTimeout(r, 250))
  const disk3 = JSON.parse(await readFile(registryPath, 'utf8'))
  check('defaultPet 已落盘', disk3.settings.defaultPet === 'ronaldo', '磁盘默认=' + disk3.settings.defaultPet)
  check('manualShow 已落盘', (disk3.pets.find((p) => p.id === 'smoke-pet') || {}).manualShow === true)

  await post(base, '/ronaldo-pet/settings', { patch: { defaultPet: 'smoke-pet' } })
  vis = await visibleIds()
  check('/settings 也能设置默认宠物', vis.def === 'smoke-pet', '默认=' + vis.def)

  // ---------- 12. 移除内置宠物 ----------
  console.log('\n[12] 移除内置宠物')
  check('卸载内置宠物成功', (await post(base, '/ronaldo-pet/pets/unregister', { id: 'ronaldo' })).json.ok === true)
  await new Promise((r) => setTimeout(r, 250))
  const onDisk2 = JSON.parse(await readFile(registryPath, 'utf8'))
  check('builtinRemoved 已落盘（重启不会强行加回来）', onDisk2.settings.builtinRemoved === true)

  // ---------- 13. 宠物社区（画廊）：发现 / 下载 / 安装 / 撤回 / 分享 ----------
  console.log('\n[13] 宠物社区（画廊）')
  const gal = await get(base, '/ronaldo-pet/gallery')
  check('GET /gallery 返回 200 + 条目数组', gal.status === 200 && gal.json.ok === true && Array.isArray(gal.json.entries),
    '总 ' + (gal.json && gal.json.entries ? gal.json.entries.length : 0) + ' 条')
  check('协议标识与话题正确', gal.json.protocol === 'DPSL-1.0' && gal.json.agreement.topic === 'dsh-pet')
  const byKey = new Map(gal.json.entries.map((e) => [e.key, e]))
  check('搜索发现 + 官方索引都被收录', byKey.has('alice/pixel-cat') && byKey.has('bob/no-license-pet') && byKey.has('carol/withdrawn-pet'))
  const alice = byKey.get('alice/pixel-cat')
  check('alice：已核验 DPSL-1.0 且可一键安装', alice.verified === true && alice.dpsl === true && alice.installable === true)
  check('alice：来源标为「索引+发现」', alice.source === 'both', 'source=' + alice.source)
  check('alice：作者取自仓库里的 pet.json（协议第 5.1 条署名）', alice.author === 'Alice', 'author=' + alice.author)
  const bob = byKey.get('bob/no-license-pet')
  check('bob：没有 pet.json -> 不可直装，但识别出可兼容导入', bob.installable === false && bob.compat === 'spritesheet-json')
  const carol = byKey.get('carol/withdrawn-pet')
  check('carol：shared=false -> 视为撤回，不给安装', carol.dpsl === false && carol.installable === false)
  check('被拉黑的条目（revoked）永不出现在列表里', !byKey.has('mallory/evil-pet'))
  check('计数与条目一致',
    gal.json.counts.total === gal.json.entries.length && gal.json.counts.installable >= 2,
    JSON.stringify(gal.json.counts))

  // 13.1 一键安装（DPSL 直装：下载 → 解包 → 校验 → 注册）
  const inst = await post(base, '/ronaldo-pet/gallery/install', { key: 'alice/pixel-cat' })
  check('直装成功（200 + mode=dpsl）', inst.status === 200 && inst.json.ok === true && inst.json.mode === 'dpsl',
    JSON.stringify(inst.json.error || ''))
  check('安装结果带回许可证与署名', Boolean(inst.json.license && inst.json.license.protocol === 'DPSL-1.0' && inst.json.attribution === 'Alice'))
  check('解包目录落在 community/ 下', existsSync(join(installDir, 'alice-pixel-cat', 'pet.json')), inst.json.extractedTo)
  const petsAfterInstall = await get(base, '/ronaldo-pet/pets')
  const installedPet = petsAfterInstall.json.pets.find((p) => p.id === inst.json.id)
  check('宠物已注册且带上社区来源 origin', Boolean(installedPet && installedPet.origin && installedPet.origin.key === 'alice/pixel-cat'),
    JSON.stringify(installedPet && installedPet.origin))
  check('已安装标记出现在画廊列表的 installed 里',
    (await get(base, '/ronaldo-pet/gallery')).json.installed.some((i) => i.key === 'alice/pixel-cat'))

  // 13.2 协议闸：没授权的仓库不给直装
  const denied = await post(base, '/ronaldo-pet/gallery/install', { key: 'bob/no-license-pet' })
  check('未声明 DPSL -> 403 拒绝直装', denied.status === 403 && denied.json.ok === false, 'HTTP ' + denied.status)
  check('拒绝时给出可操作的 hint', typeof denied.json.hint === 'string' && denied.json.hint.length > 10)
  const denied2 = await post(base, '/ronaldo-pet/gallery/install', { key: 'carol/withdrawn-pet' })
  check('作者已撤回 -> 同样拒绝', denied2.status === 403)

  // 13.3 兼容导入（显式选择才走）
  const compat = await post(base, '/ronaldo-pet/gallery/install', { key: 'bob/no-license-pet', adapter: 'spritesheet-json' })
  check('兼容导入成功（mode=compat）', compat.status === 200 && compat.json.mode === 'compat',
    JSON.stringify(compat.json.error || compat.json.errors || ''))
  check('兼容导入合成出了 pet.json', existsSync(join(installDir, 'bob-no-license-pet--compat', 'pet.json')))
  check('兼容导入会报告未映射的动作', Array.isArray(compat.json.unmapped) && compat.json.unmapped.length === 1 && compat.json.unmapped[0].name === 'flap',
    JSON.stringify(compat.json.unmapped))
  check('兼容导入的列表项带着"未授权"警示', (compat.json.warnings || []).some((w) => w.includes('未声明 DPSL-1.0')))
  const compatPet = (await get(base, '/ronaldo-pet/pets')).json.pets.find((p) => p.id === compat.json.id)
  check('兼容导入的宠物 origin 标为 community-compat', Boolean(compatPet && compatPet.origin && compatPet.origin.kind === 'community-compat'))

  // 13.4 安装时重新校验（协议第 2.3 条）：索引/探测说授权，归档里已撤回
  const drift = await post(base, '/ronaldo-pet/gallery/install', { key: 'dave/drifted-pet' })
  check('归档里的 pet.json 已撤回 -> 403 中止安装', drift.status === 403, 'HTTP ' + drift.status + ' ' + JSON.stringify(drift.json.error || ''))
  check('中止原因指向 sharing 块', JSON.stringify(drift.json.detail || []).includes('shared') || String(drift.json.error).includes('DPSL'))

  // 13.5 安全边界：越界路径的归档不落地
  const evil = await post(base, '/ronaldo-pet/gallery/install', { key: 'mallory/evil-pet' })
  check('恶意归档不会写到 installDir 之外（../ 与绝对路径都被丢弃）',
    !existsSync(join(installDir, 'escaped.txt')) && !existsSync(join(tmp, 'escaped.txt')) && !existsSync(join(installDir, 'escaped2.txt')))
  check('恶意归档里的正常文件仍然可用', evil.status === 200 || evil.status === 403 || evil.status === 422, 'HTTP ' + evil.status)

  // 13.6 手动填地址探测
  const probe = await post(base, '/ronaldo-pet/gallery/probe', { repo: 'alice/pixel-cat' })
  check('probe 能认出已收录的仓库', probe.status === 200 && probe.json.ok === true && probe.json.entry.key === 'alice/pixel-cat')
  const probeBad = await post(base, '/ronaldo-pet/gallery/probe', { repo: '不是地址' })
  check('probe 对非法地址给出明确错误', probeBad.status === 400 && /无法识别/.test(probeBad.json.error))

  // 13.7 分享：没同意就一个字节都不写（协议第 2.2 条）
  const sharePkg = join(tmp, 'pets', 'share-pet')
  await makePetPackage(sharePkg, { id: 'share-pet', name: '分享测试宠' })
  const beforePet = await readFile(join(sharePkg, 'pet.json'), 'utf8')
  const noConsent = await post(base, '/ronaldo-pet/gallery/share', { dir: sharePkg })
  check('未同意 -> 400 且 needsConsent=true', noConsent.status === 400 && noConsent.json.needsConsent === true)
  check('未同意 -> pet.json 一个字节都没改', (await readFile(join(sharePkg, 'pet.json'), 'utf8')) === beforePet)
  check('未同意 -> 没有写出任何分享文件', !existsSync(join(sharePkg, 'DSH-PET-LICENSE.md')))

  const share = await post(base, '/ronaldo-pet/gallery/share', {
    dir: sharePkg, accept: true, author: '冒烟作者', repo: 'https://github.com/smoke/share-pet', tags: '像素风,测试',
    rights: '图集程序生成',
  })
  check('同意后生成分享包成功', share.status === 200 && share.json.ok === true, JSON.stringify(share.json.error || ''))
  check('写入了协议副本 / README / SHARING / 推送脚本',
    ['DSH-PET-LICENSE.md', 'README.md', 'SHARING.md', 'publish.ps1', 'publish.sh', '.gitignore']
      .every((f) => (share.json.files || []).includes(f)),
    (share.json.files || []).join(','))
  const sharedPet = JSON.parse(await readFile(join(sharePkg, 'pet.json'), 'utf8'))
  check('pet.json 里的 sharing 块合法且可被校验', sharedPet.sharing.protocol === 'DPSL-1.0' && sharedPet.sharing.shared === true)
  check('sharing 里记住了署名 / 仓库 / 话题', sharedPet.sharing.author === '冒烟作者' && sharedPet.sharing.repo === 'https://github.com/smoke/share-pet' && share.json.topic === 'dsh-pet')
  check('给出了可直接粘贴的索引条目', share.json.next.indexEntry.key === 'smoke/share-pet' && share.json.next.indexEntry.protocol === 'DPSL-1.0')
  check('分享包里的协议副本是全文（不是占位）',
    (await readFile(join(sharePkg, 'DSH-PET-LICENSE.md'), 'utf8')).includes('DSH 桌宠开放共享协议'))
  check('publish.ps1 保持纯 ASCII（PS 5.1 读无 BOM 脚本会按 ANSI 解析）',
    !/[^\x00-\x7F]/.test(await readFile(join(sharePkg, 'publish.ps1'), 'utf8')))
  await post(base, '/ronaldo-pet/pets/register', { dir: sharePkg, focus: false })
  const shareAgain = await post(base, '/ronaldo-pet/gallery/share', { id: 'share-pet', accept: true, author: '冒烟作者', repo: 'https://github.com/smoke/share-pet' })
  check('按已注册的 id 也能分享（复用注册表里的目录）', shareAgain.status === 200 && shareAgain.json.pkg === sharePkg,
    'HTTP ' + shareAgain.status + ' ' + JSON.stringify(shareAgain.json.pkg || shareAgain.json.error))
  const missingShare = await post(base, '/ronaldo-pet/gallery/share', { id: '不存在的宠物', accept: true, author: 'x', repo: 'https://github.com/x/y' })
  check('按不存在的 id 分享 -> 404 且说明清楚', missingShare.status === 404 && /未注册/.test(String(missingShare.json.error)))

  // 13.8 本地目录安装（离线可用）
  const localDir = join(tmp, 'pets', 'local-pet')
  await makePetPackage(localDir, { id: 'local-pet', name: '本地宠物' })
  const localInst = await post(base, '/ronaldo-pet/gallery/install', { dir: localDir })
  check('本地目录安装（离线路径）成功', localInst.status === 200 && localInst.json.mode === 'local')

  // ---------- 14. 从视频生成（GUI 入口：探测引擎 → 起后台任务 → 轮询 → 注册） ----------
  console.log('\n[14] 从视频生成宠物（后台任务）')
  const vids = await post(base, '/ronaldo-pet/video/probe', {})
  check('GET 探测引擎返回 200', vids.status === 200 && vids.json.ok === true)
  const avail = (vids.json.engines && vids.json.engines.available) || []
  check('报出了可用的解码引擎', Array.isArray(avail), 'engines=' + JSON.stringify(avail))
  if (avail.length === 0) {
    check('没有引擎时给出可执行的安装建议', Array.isArray(vids.json.engines.install) && vids.json.engines.install.length >= 2,
      JSON.stringify((vids.json.engines.install || []).map((i) => i.cmd)))
  } else {
    // 造一段 2 秒的绿幕 mp4（只有 python+cv2 能无中生有写视频；没有它就跳过这一段）
    const genScript = join(tmp, 'gen_video.py')
    await writeFile(genScript, [
      'import cv2, numpy as np, os, sys, math',
      'out = sys.argv[1]',
      'W, H, N, FPS = 240, 180, 24, 12',
      'vw = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))',
      'for f in range(N):',
      '    img = np.zeros((H, W, 3), np.uint8)',
      '    img[:, :] = (64, 177, 0)',
      '    t = f / FPS',
      '    bob = math.sin(f * 0.5) * 3 if t < 1 else -abs(math.sin((t - 1) * math.pi * 2)) * 24',
      '    cx, cy = int(W * 0.5 + math.sin(f * 0.4) * 20), int(H * 0.62 + bob)',
      '    cv2.circle(img, (cx, cy), 26, (40, 140, 240), -1)',
      '    cv2.circle(img, (cx, cy - 24), 13, (220, 90, 40), -1)',
      '    vw.write(img)',
      'vw.release()',
      'print("OK")',
    ].join('\n'), 'utf8')
    const pyExe = (vids.json.engines.cv2 && vids.json.engines.cv2.python) || 'python'
    const gen = spawnSync(pyExe, [genScript, join(tmp, 'smoke-green.mp4')], { encoding: 'utf8', windowsHide: true })
    const hasVideo = existsSync(join(tmp, 'smoke-green.mp4'))

    if (!hasVideo) {
      check(true, '（跳过端到端）造测试视频的 python 不可用', String(gen.stderr || '').slice(0, 80))
    } else {
      const probed = await post(base, '/ronaldo-pet/video/probe', { path: join(tmp, 'smoke-green.mp4') })
      check('探测能读出视频元信息', probed.json.video && probed.json.video.ok === true,
        probed.json.video ? `${probed.json.video.width}×${probed.json.video.height} ${probed.json.video.duration}s` : '')

      const noPath = await post(base, '/ronaldo-pet/video/build', {})
      check('没给视频路径时拒绝起任务', noPath.status === 400 && /缺少 path/.test(String(noPath.json.error)))

      const start = await post(base, '/ronaldo-pet/video/build', {
        path: join(tmp, 'smoke-green.mp4'),
        segments: 'idle:0-1,waving:1-2',
        pkg: join(tmp, 'generated', 'video-smoke'),
        name: '视频冒烟宠',
        id: 'video-smoke',
        fps: 12,
        frames: 4,
        install: true,
      })
      check('起后台任务成功（返回 jobId）', start.status === 200 && typeof start.json.jobId === 'string', JSON.stringify(start.json.error || ''))
      const jobId = start.json.jobId

      let view = null
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        const s = await get(base, '/ronaldo-pet/video/status?jobId=' + encodeURIComponent(jobId))
        view = s.json
        if (view && view.running === false) break
      }
      check('任务能在 60 秒内结束', view && view.running === false, view ? `running=${view.running} exit=${view.exitCode}` : '没有状态')
      check('任务成功（跑完抽帧→抠像→装配→校验）', view && view.succeeded === true,
        view && view.result ? String(view.result.human || '').slice(0, 110) : String((view && view.error) || '').slice(0, 160))
      if (view && view.result) {
        check('结果里带抠像统计与动作清单', Boolean(view.result.chroma && view.result.pet && view.result.pet.actions.length),
          JSON.stringify((view.result.pet || {}).actions))
        check('产物落盘（pet.json + atlas.png）',
          existsSync(join(tmp, 'generated', 'video-smoke', 'pet.json')) && existsSync(join(tmp, 'generated', 'video-smoke', 'atlas.png')))
        check('能看到进度日志', Array.isArray(view.log) && view.log.length > 0, (view.log || []).slice(-1)[0] || '')
      }
      const petsAfterVideo = await get(base, '/ronaldo-pet/pets')
      check('install:true 时宠物已注册进界面', petsAfterVideo.json.pets.some((p) => p.id === 'video-smoke'),
        '共 ' + petsAfterVideo.json.pets.length + ' 只')

      const statusAll = await get(base, '/ronaldo-pet/video/status')
      check('任务列表能查到刚跑完的任务', statusAll.json.jobs && statusAll.json.jobs.some((j) => j.jobId === jobId))
    }
  }

  // ---------- 收尾 ----------
  ctx._stop()
  await webServer.close()
  await stub.close()
  if (!keep) await rm(tmp, { recursive: true, force: true })

  console.log('\n' + (failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n冒烟测试异常：', err)
  process.exit(1)
})
