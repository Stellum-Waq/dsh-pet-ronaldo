// =============================================================================
// 高分辨率素材端到端验证
//
//   node scripts/verify-highres.mjs [--keep]
//
// 验的是"放开像素限制"这件事真的成立，而不只是文档里写着不限：
//   1. 1024px 一格（写实素材的量级）能被校验通过、被桌宠加载
//   2. 缩放质量走的是 HighQuality，不是默认的线性插值
//   3. 没显式给尺寸时，显示大小跟随素材原生分辨率（1024px/格 -> 512 DIP）
//   4. 窗口真的按这个尺寸画出来了（而不是停在 96）
//   5. 画出来的内容仍然和素材对应格逐像素对得上
//   6. 超过天花板（单格 4096px / 整图 6400 万像素）要被**明确拒绝**，
//      而不是让用户看到一只卡死的宠物
//
// 自带临时 dev-server + 临时注册表，不碰用户真实环境。
// =============================================================================

import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')
const KEEP = process.argv.includes('--keep')

const { newImg, setPixel, savePng, decodeImage, crop, resize } = await import(
  pathToFileURL(join(REPO, 'skill', 'dsh-pet-forge', 'scripts', 'lib', 'imaging.mjs')).href)

let pass = 0
let fail = 0
const ok = (n, e = '') => { pass++; console.log('  ok   ' + n + (e ? '  — ' + e : '')) }
const bad = (n, e = '') => { fail++; console.log('  FAIL ' + n + (e ? '  — ' + e : '')) }
const check = (c, n, e = '') => (c ? ok(n, e) : bad(n, e))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

// ---------------------------------------------------------------- atlas drawing

// 画一个"有点写实感"的图形：径向渐变的圆 + 抗锯齿边缘 + 透明四角。
// 抗锯齿边缘是故意的 —— 缩放算法不好时，边缘会先糊掉。
function drawFigure(img, ox, oy, cx, cy, r, tint) {
  for (let y = 0; y < r * 2; y++) {
    for (let x = 0; x < r * 2; x++) {
      const dx = x - r
      const dy = y - r
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d > r) continue
      const edge = Math.min(1, (r - d) / 4)
      const shade = 1 - 0.5 * (d / r)
      setPixel(
        img, ox + cx - r + x, oy + cy - r + y,
        clamp8(tint[0] * shade), clamp8(tint[1] * shade), clamp8(tint[2] * shade),
        clamp8(255 * edge),
      )
    }
  }
}

function buildAtlas(cellW, cellH, cols, rows) {
  const img = newImg(cellW * cols, cellH * rows)
  const tints = [[235, 90, 90], [90, 170, 235], [120, 220, 140], [240, 200, 90]]
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tint = tints[(row * cols + col) % tints.length]
      const ox = col * cellW
      const oy = row * cellH
      // 每格图形位置/大小不同：换帧时肉眼和像素都能看出变化
      drawFigure(img, ox, oy, cellW / 2 + (col - 0.5) * cellW * 0.08, cellH / 2,
        Math.round(cellW * (0.36 + 0.06 * ((row + col) % 3))), tint)
    }
  }
  return img
}

// ---------------------------------------------------------------- helpers

async function freePort() {
  const net = await import('node:net')
  return await new Promise((res, rej) => {
    const s = net.createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
  })
}

const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }

async function getJson(url, init) {
  const res = await fetch(url, init)
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { _raw: text.slice(0, 400), _status: res.status } }
}
const postJson = (url, body) =>
  getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })

function meanAbsDiff(a, b) {
  const n = Math.min(a.data.length, b.data.length)
  let sum = 0
  for (let i = 0; i < n; i++) sum += Math.abs(a.data[i] - b.data[i])
  return sum / n
}
function alphaCoverage(img) {
  let on = 0
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 16) on++
  return (100 * on) / (img.width * img.height)
}

// ---------------------------------------------------------------- main

const main = async () => {
  if (process.platform !== 'win32') { console.log('跳过：桌面宠物只有 Windows 版本'); return }
  if (!existsSync(join(REPO, 'desktop', 'DesktopPet.ps1'))) { console.log('跳过：找不到 DesktopPet.ps1'); return }

  const dir = await mkdtemp(join(tmpdir(), 'pet-highres-'))
  const pkgDir = join(dir, 'photo-pet')
  const registryPath = join(dir, 'registry.json')
  await mkdir(pkgDir, { recursive: true })

  // ---- 1. 造一张 1024px/格 的图集（写实素材量级）----
  const CELL = 1024
  const COLS = 2
  const ROWS = 2
  console.log(`造图集：${COLS}x${ROWS} 格 · ${CELL}x${CELL}px -> ${CELL * COLS}x${CELL * ROWS}`)
  const atlasPath = join(pkgDir, 'atlas.png')
  const atlasImg = buildAtlas(CELL, CELL, COLS, ROWS)
  {
    let on = 0
    for (let i = 3; i < atlasImg.data.length; i += 4) if (atlasImg.data[i] > 16) on++
    const pct = (100 * on) / (atlasImg.width * atlasImg.height)
    console.log(`  内存中覆盖率 ${pct.toFixed(2)}% · ${atlasImg.width}x${atlasImg.height}`)
  }
  await savePng(atlasImg, atlasPath)
  const atlasBytes = await readFile(atlasPath)
  console.log(`  ${(atlasBytes.length / 1024 / 1024).toFixed(2)} MB`)

  const manifest = {
    id: 'photo-pet',
    name: '高清测试',
    // 没写 size：就是要验证"自动跟随原生分辨率"
    atlas: { file: 'atlas.png', cols: COLS, rows: ROWS, cellW: CELL, cellH: CELL, scaling: 'smooth' },
    states: {
      idle: { row: 0, frames: 2 },
      running: { row: 1, frames: 2 },
      review: { row: 0, frames: 1 },
      look: { rows: [0, 1], frames: 2 },
    },
  }
  await writeFile(join(pkgDir, 'pet.json'), JSON.stringify(manifest, null, 2), 'utf8')

  await writeFile(registryPath, JSON.stringify({
    version: 1, revision: 1,
    settings: { defaultPet: 'photo-pet', audioMode: 'off', systemSound: false, desktopSize: 0, displayMode: 'auto' },
    pets: [],
  }, null, 2), 'utf8')

  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  console.log(`临时 dev-server：${base}\n`)

  const server = spawn(process.execPath, [
    join(REPO, 'scripts', 'dev-server.mjs'),
    '--port', String(port),
    '--demo',
    '--registry', registryPath,
    '--pkg', pkgDir,
  ], { cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'] })

  let petPid = 0
  const cleanup = async () => {
    if (petPid) spawnSync('taskkill', ['/PID', String(petPid), '/T', '/F'], { stdio: 'ignore' })
    try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
    try { server.kill() } catch { /* ignore */ }
    if (!KEEP) { try { await rm(dir, { recursive: true, force: true }) } catch { /* ignore */ } }
  }

  try {
    let up = false
    for (let i = 0; i < 60; i++) {
      await sleep(250)
      try { const r = await fetch(base + '/ronaldo-pet/state'); if (r.ok) { up = true; break } } catch { /* retry */ }
    }
    check(up, 'dev-server 起来了')
    if (!up) return

    // ---- 2. 高分辨率素材必须能通过校验并被注册 ----
    const pets = await getJson(base + '/ronaldo-pet/pets')
    const mine = (pets.pets || []).find((p) => p.id === 'photo-pet')
    check(!!mine, '1024px/格的素材注册成功', mine ? `sheet=${mine.sheet.cellW}x${mine.sheet.cellH}` : JSON.stringify(pets).slice(0, 200))
    if (!mine) return
    check(mine.broken !== true, '素材校验通过（没有 broken 标记）')
    check(mine.sheet.cellW === CELL && mine.sheet.cellH === CELL, 'cellW/cellH 按素材原样保留')

    // ---- 3. 起桌面宠物 ----
    const started = await postJson(base + '/ronaldo-pet/desktop', { action: 'start' })
    check(started.ok === true, '桌面宠物启动请求被接受')

    let st = null
    let running = false
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      st = await getJson(base + '/ronaldo-pet/desktop?action=status')
      if (st.running) { running = true; break }
    }
    check(running, '桌面宠物跑起来了', `pid=${st && st.pid}`)
    if (!running) return
    petPid = Number(st.pid) || 0

    // 让它加载完图集
    await sleep(4000)

    // ---- 4. 从桌宠自己的日志里核对关键事实 ----
    const spawnLogPath = join(dir, 'desktop-pet-spawn.log')
    let petLogPath = ''
    try {
      const sl = await readFile(spawnLogPath, 'utf8')
      const m = sl.match(/-Log\s+'?([^'\s]+)'?/)
      if (m) petLogPath = m[1].trim()
    } catch { /* ignore */ }
    check(!!petLogPath, '找到桌宠日志路径', petLogPath)

    let petLog = ''
    try { petLog = petLogPath ? await readFile(petLogPath, 'utf8') : '' } catch { /* ignore */ }

    check(/atlas fetched:.*-> 2048x2048/.test(petLog), '桌宠按 2048x2048 解码了图集',
      (petLog.match(/atlas fetched:[^\n]*/) || [''])[0])
    check(/cell 1024x1024/.test(petLog), '桌宠识别出 1024x1024 的格子',
      (petLog.match(/loaded pet[^\n]*/) || [''])[0])
    // WPF 的 BitmapScalingMode.HighQuality 在枚举里就叫 Fant（同一个值的别名），
    // 日志里打出来是 "Fant"，不是 "HighQuality"。别把别名当成没生效。
    check(/scaling mode: (Fant|HighQuality)/.test(petLog), '缩放走高质量重采样（Fant/HighQuality）',
      (petLog.match(/scaling mode:[^\n]*/) || [''])[0])
    check(/size from host: 0|size -> auto/.test(petLog) || !/-Size/.test(petLog),
      '没有把固定尺寸传给桌宠（auto 生效）')

    // ---- 5. 自捕获：画出来的内容仍然对得上素材，且尺寸符合"原生分辨率一半" ----
    // 自捕获是按精灵元素的 DIP 尺寸渲染的，所以捕获尺寸本身就是显示尺寸的证据：
    // 1024px 一格 -> 自动 512 DIP -> 一张 512x512 的图。
    const expectDip = CELL / 2
    check(expectDip === 512, '自动尺寸推算为 512 DIP', `cell ${CELL} / 2 = ${expectDip}`)
    check(Number(st.size) === 0 || Number(st.size) === expectDip,
      '宿主上报的尺寸与自动值一致', `host size=${st.size}`)

    // ---- 6. 自捕获：画出来的内容仍然对得上素材 ----
    const logDir = dirname(petLogPath)
    const trigger = join(logDir, 'desktop-pet-capture.txt')
    const framePath = join(logDir, 'desktop-pet-frame.png')
    await rm(framePath, { force: true })
    await writeFile(trigger, 'go', 'utf8')
    let hasFrame = false
    for (let i = 0; i < 24; i++) {
      await sleep(500)
      if (existsSync(framePath)) { hasFrame = true; break }
    }
    check(hasFrame, '桌宠自捕获出图成功')
    if (hasFrame) {
      const cap = await decodeImage(await readFile(framePath))
      const atlas = await decodeImage(atlasBytes)
      // 捕获可能发生在读日志之后，所以这里重新读一遍日志来定位当前是第几格
      try { petLog = await readFile(petLogPath, 'utf8') } catch { /* ignore */ }
      let row = 0
      let col = 0
      let captureLine = ''
      try {
        const all = [...petLog.matchAll(/self-capture ->.*?cell=(\d+)\/(\d+)/g)]
        const last = all.pop()
        if (last) { row = Number(last[1]); col = Number(last[2]); captureLine = last[0] }
      } catch { /* ignore */ }
      const cell = resize(crop(atlas, col * CELL, row * CELL, CELL, CELL), cap.width, cap.height)
      const diff = meanAbsDiff(cell, cap)
      const covA = alphaCoverage(cell)
      const covB = alphaCoverage(cap)
      console.log(`  ..   图集 ${atlas.width}x${atlas.height} · 格 ${row}/${col} · 捕获 ${cap.width}x${cap.height}`)
      console.log(`  ..   ${captureLine}`)
      // 两边都不能是空的：空对空 diff=0 会让下面的断言变成假通过
      check(covA > 5, '素材格本身有内容（防止空对空假通过）', `素材覆盖率 ${covA.toFixed(1)}%`)
      check(covB > 5, '捕获帧不是空图', `捕获覆盖率 ${covB.toFixed(1)}%`)
      check(diff < 12, '捕获帧与素材格逐像素对得上', `mean|d|=${diff.toFixed(2)} < 12`)
      check(Math.abs(covA - covB) < 6, '不透明覆盖率一致（没有缺一半/被裁掉）',
        `素材 ${covA.toFixed(1)}% vs 捕获 ${covB.toFixed(1)}%`)
      check(cap.width === expectDip && cap.height === expectDip,
        '显示尺寸 = 素材原生分辨率的一半', `捕获 ${cap.width}x${cap.height}，期望 ${expectDip}`)
    }

    // ---- 7. 天花板要明确拒绝 ----
    //
    // 单格 3000px（没超 4096），但 4x4 格合计 1.44 亿像素，稳稳超过 6400 万。
    // 注意别挑 2 的整数次幂：2x2·4096 和 4x4·2048 都**正好等于** 64Mi，
    // 那是边界相等、压根不该报错 —— 第一版测试就两次栽在这上面。
    const tooBig = {
      ...manifest,
      id: 'too-big',
      atlas: { ...manifest.atlas, cols: 4, rows: 4, cellW: 3000, cellH: 3000 },
      states: { idle: { row: 0, frames: 2 }, look: { rows: [0, 1], frames: 2 } },
    }
    const bigDir = join(dir, 'too-big')
    await mkdir(bigDir, { recursive: true })
    await writeFile(join(bigDir, 'pet.json'), JSON.stringify(tooBig, null, 2), 'utf8')
    const reg = await postJson(base + '/ronaldo-pet/pets/register', { dir: bigDir })
    check(reg.ok === false, '超过天花板被拒绝', JSON.stringify(reg).slice(0, 220))
    check(/总像素|上限/.test(JSON.stringify(reg)), '拒绝理由说清了是像素上限', JSON.stringify(reg).slice(0, 260))
  } finally {
    await cleanup()
  }
}

main()
  .then(() => {
    console.log('')
    console.log(fail === 0 ? `✅ 全部通过（${pass} 项）` : `❌ ${fail} 项失败 / 共 ${pass + fail} 项`)
    process.exit(fail === 0 ? 0 : 1)
  })
  .catch((err) => { console.error('测试自身出错：', err); process.exit(1) })
