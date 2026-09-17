// =============================================================================
// 桌面宠物"生命周期"回归测试
//
//   node scripts/verify-desktop-lifecycle.mjs [--keep]
//
// 覆盖的是一个真实踩过的坑：宿主判断"桌宠还在不在跑"时只看 ChildProcess。
// shell 启动方式会留下一个**假的 proc 存根**（exitCode 永远 null、
// killed 永远 false），于是只要成功启动过一次，宿主就永久认为桌宠开着：
//   - 用户关掉桌宠之后再也不会被拉起；
//   - 网页端因为 displayMode:'auto' + desktopRunning=true 把网页那份也藏起来，
//     结果**两边都看不到宠物**。
//
// 所以这里专门验证"桌宠被外部杀掉之后，宿主必须承认它已经没了"。
//
// 测试自带一个 dev-server（临时端口 + 临时注册表），不会碰用户真实的 dsh web。
// =============================================================================

import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')
const KEEP = process.argv.includes('--keep')

let pass = 0
let fail = 0
const ok = (name, extra = '') => { pass++; console.log('  ok   ' + name + (extra ? '  — ' + extra : '')) }
const bad = (name, extra = '') => { fail++; console.log('  FAIL ' + name + (extra ? '  — ' + extra : '')) }
const check = (cond, name, extra = '') => (cond ? ok(name, extra) : bad(name, extra))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const realRegistry = join(homedir(), '.dsh', 'storages', 'dsh-pet-forge', 'registry.json')

async function freePort() {
  const net = await import('node:net')
  return await new Promise((res, rej) => {
    const s = net.createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })
}

const alive = (pid) => {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

async function getJson(url, init) {
  const res = await fetch(url, init)
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { _raw: text, _status: res.status } }
}

async function postJson(url, body) {
  return getJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
}

const main = async () => {
  if (process.platform !== 'win32') {
    console.log('跳过：桌面宠物只有 Windows（WPF）版本')
    return
  }
  const script = join(REPO, 'desktop', 'DesktopPet.ps1')
  if (!existsSync(script)) {
    console.log('跳过：找不到 ' + script)
    return
  }

  const dir = await mkdtemp(join(tmpdir(), 'pet-lifecycle-'))
  const registryPath = join(dir, 'registry.json')

  // 用真实注册表的宠物列表，但把设置换成确定的测试值，免得影响用户界面。
  let reg = { version: 1, revision: 1, settings: {}, pets: [] }
  if (existsSync(realRegistry)) {
    try { reg = JSON.parse(await readFile(realRegistry, 'utf8')) } catch { /* 用默认 */ }
  }
  reg.settings = {
    ...(reg.settings || {}),
    defaultPet: (reg.pets && reg.pets[0] && reg.pets[0].id) || 'ronaldo',
    displayMode: 'auto',
    desktopSize: 96,
    systemSound: false,
    audioMode: 'off',
  }
  if (Array.isArray(reg.pets)) {
    for (const p of reg.pets) { p.visible = p.id === reg.settings.defaultPet; p.manualShow = false }
  }
  await writeFile(registryPath, JSON.stringify(reg, null, 2), 'utf8')

  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  console.log(`起一个临时 dev-server：${base}`)
  console.log(`注册表：${registryPath}\n`)

  const server = spawn(process.execPath, [
    join(REPO, 'scripts', 'dev-server.mjs'),
    '--port', String(port),
    '--demo',
    '--registry', registryPath,
  ], { cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'] })

  let petPid = 0
  const cleanup = async () => {
    // 先杀桌宠，再关 dev-server：反过来宿主可能来不及收尸
    if (petPid) spawnSync('taskkill', ['/PID', String(petPid), '/T', '/F'], { stdio: 'ignore' })
    try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
    try { server.kill() } catch { /* ignore */ }
    if (!KEEP) { try { await rm(dir, { recursive: true, force: true }) } catch { /* ignore */ } }
  }

  try {
    // ---- 等 dev-server 起来 ----
    let up = false
    for (let i = 0; i < 60; i++) {
      await sleep(250)
      try { const r = await fetch(base + '/ronaldo-pet/state'); if (r.ok) { up = true; break } } catch { /* retry */ }
    }
    check(up, 'dev-server 起来了')
    if (!up) return

    // ---- 1. 一开始必须是"没在跑" ----
    let st = await getJson(base + '/ronaldo-pet/desktop?action=status')
    check(st.running === false, '初始 running=false', `running=${st.running} pid=${st.pid}`)

    // ---- 2. 启动桌宠（故意连发两次，验证不会叠出第二只）----
    //
    //     网页端在很短时间内确实会发两次 start（页面加载自动拉起 + 用户点按钮），
    //     而上一只进程要几秒后才登记进 desktop.pid，中间 desktopRunning() 还是
    //     false —— 没有防重复的话就会拉出第二只，桌面上叠两只宠物。
    const started = await postJson(base + '/ronaldo-pet/desktop', { action: 'start' })
    check(started.ok === true, 'start 返回 ok', JSON.stringify(started).slice(0, 160))

    const second = await postJson(base + '/ronaldo-pet/desktop', { action: 'start' })
    check(second.ok === true && second.launching === true,
      '紧接着的第二次 start 被当成重复请求挡掉',
      `ok=${second.ok} launching=${second.launching} alreadyRunning=${second.alreadyRunning}`)

    let running = false
    for (let i = 0; i < 30; i++) {
      await sleep(500)
      st = await getJson(base + '/ronaldo-pet/desktop?action=status')
      if (st.running) { running = true; break }
    }
    check(running, '启动后 running=true', `pid=${st.pid} method=${st.method}`)
    if (!running) return

    petPid = Number(st.pid) || 0
    check(alive(petPid), '桌宠进程真的活着', `pid=${petPid}`)

    const state = await getJson(base + '/ronaldo-pet/state')
    check(state.desktop && state.desktop.running === true, '/state 也报告 running=true')

    // 宿主另有一条逻辑：进程"起来后不到 4 秒就退出"会被当成启动方式不好使，换个
    // 方式重试。那是另一件合理的事，但会盖住这里要测的行为，所以先让宠物活够。
    //
    // ⚠️ 基准必须从"观察到 running=true"算起，不能从 start 的 startedAt 算：
    //    startedAt 是第一次尝试（shell 方式）的时间，而真正的进程是后面换招
    //    spawn 出来的，中间可能差好几秒 —— 按 startedAt 等就会等不够。
    console.log('  ..   让宠物稳定跑 5.5 秒，避开"存活过短换招重试"')
    await sleep(5500)
    st = await getJson(base + '/ronaldo-pet/desktop?action=status')
    petPid = Number(st.pid) || 0
    check(alive(petPid), '5.5 秒后宠物还活着（没有被换招重试换掉）', `pid=${petPid}`)

    // 桌宠每启动一次都会在自己的日志里写一行 "starting:"，数一数就知道到底拉了几只。
    let starts = -1
    try {
      const spawnLogText = await readFile(join(dir, 'desktop-pet-spawn.log'), 'utf8')
      // shell 方式的命令行里 -Log 带引号，spawn 方式不带，两种都要认
      const m = spawnLogText.match(/-Log\s+'?([^'\s]+)'?/)
      if (m) {
        const petLog = await readFile(m[1].trim(), 'utf8')
        starts = (petLog.match(/starting:/g) || []).length
      }
    } catch { /* 读不到就算了，下面会标出来 */ }
    check(starts === 1, '连发两次 start 只真的拉起了 1 只桌宠', `日志里的 starting: 次数=${starts}`)

    // 宿主另有一条逻辑：进程"起来后不到 4 秒就退出"会被当成启动方式不好使，
    // 换个方式重试。那是另一件事，会盖住这里要测的行为，所以先让宠物活够。

    // ---- 3. 从外部杀掉桌宠：宿主绝不能把死掉的 pid 当成"还在跑" ----
    //
    //     这就是那个假存根 bug 的照妖镜。shell 启动方式成功后，
    //     verifyShellLaunch() 会塞一个 exitCode 永远为 null 的假 proc，
    //     修复前 desktopRunning() 只看它，于是**永远**返回 true：用户关掉桌宠
    //     后再也拉不起来，而网页端因为 displayMode:'auto' 把网页那份也藏掉，
    //     结果两边都看不到宠物。
    //
    //     注意：宿主对"活得太短就退出"的进程会换招重试，那是另一条（合理的）
    //     逻辑，所以这里不能断言"杀掉之后不许再拉起"，只能断言那个不变式：
    //     **一旦说 running，上报的 pid 就必须真的活着**。
    console.log(`  ..   外部杀掉桌宠 pid=${petPid}`)
    spawnSync('taskkill', ['/PID', String(petPid), '/T', '/F'], { stdio: 'ignore' })
    await sleep(1800)
    check(alive(petPid) === false, '桌宠进程确实被杀掉了', `pid=${petPid}`)

    st = await getJson(base + '/ronaldo-pet/desktop?action=status')
    if (st.running) {
      check(alive(Number(st.pid)), 'running=true 时上报的 pid 真的活着（不能是死 pid）',
        `pid=${st.pid}`)
      check(Number(st.pid) !== petPid, '没有继续把已杀掉的 pid 当成在跑', `killed=${petPid} now=${st.pid}`)
    } else {
      ok('杀掉之后立刻承认 running=false（没有假死）', `pid=${st.pid}`)
    }

    const state2 = await getJson(base + '/ronaldo-pet/state')
    const d2 = state2.desktop || {}
    if (d2.running) {
      check(alive(Number(d2.pid)), '/state 上报的 pid 也真的活着', `pid=${d2.pid}`)
    } else {
      ok('/state 也报告 running=false')
    }

    // ---- 4. 还必须能重新拉起来 ----
    if (st.running) {
      // 宿主已经自己换招重试成功了，先把这只收掉再测一次干净的 start
      await postJson(base + '/ronaldo-pet/desktop', { action: 'stop' })
      await sleep(1200)
      petPid = 0
    }
    const again = await postJson(base + '/ronaldo-pet/desktop', { action: 'start' })
    check(again.ok === true && again.alreadyRunning !== true, '重新 start 不会误判"已经在跑"',
      `ok=${again.ok} alreadyRunning=${again.alreadyRunning}`)

    let back = false
    for (let i = 0; i < 30; i++) {
      await sleep(500)
      st = await getJson(base + '/ronaldo-pet/desktop?action=status')
      if (st.running) { back = true; break }
    }
    const pid2 = Number(st.pid) || 0
    check(back, '重新启动了', `新 pid=${pid2}`)
    check(pid2 !== 0 && alive(pid2), '新进程真的活着', `pid=${pid2}`)
    petPid = pid2

    // ---- 5. stop 之后也要承认 ----
    await postJson(base + '/ronaldo-pet/desktop', { action: 'stop' })
    await sleep(1500)
    st = await getJson(base + '/ronaldo-pet/desktop?action=status')
    check(st.running === false, 'stop 之后 running=false', `running=${st.running}`)
    petPid = 0
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
  .catch((err) => {
    console.error('测试自身出错：', err)
    process.exit(1)
  })
