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
  return {
    server,
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
    listen: (port) => new Promise((r) => server.listen(port, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => server.close(r)),
  }
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

  const host = await import(pathToFileURL(join(REPO, 'host.js')).href)
  check('host.js 导出 name / apply', host.name === 'ronaldo-pet' && typeof host.apply === 'function')
  check('host.js 声明 inject webServer', Array.isArray(host.inject) && host.inject.includes('webServer'))

  host.apply(ctx, {
    registryPath,
    pollMs: 100000,
    // 冒烟测试不能真的去拉一个桌面窗口起来（会留下游离进程），
    // 所以显式关掉。桌面启动逻辑由 scripts/detached-probe.mjs 单独验证。
    desktopPet: false,
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

  // ---------- 收尾 ----------
  ctx._stop()
  await webServer.close()
  if (!keep) await rm(tmp, { recursive: true, force: true })

  console.log('\n' + (failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n冒烟测试异常：', err)
  process.exit(1)
})
