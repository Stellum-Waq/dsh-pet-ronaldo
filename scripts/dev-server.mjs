#!/usr/bin/env node
// =============================================================================
// dsh-ronaldo-pet · 本地调试服务器
// -----------------------------------------------------------------------------
// 只加载 host.js（用桩 ctx 代替 cordis 运行时）并注册一个真实宠物包，
// 起一个独立端口的 HTTP 服务。
//
// 为什么需要：改插件要重启 `dsh web` 才生效，而重启会打断正在进行的会话。
// 有了它就能在不碰线上进程的前提下：
//   · 调试原生桌面宠物（把 DesktopPet.ps1 指向这个端口）
//   · 调前端（把页面里的 /ronaldo-pet/* 代理过来）
//   · 跑人工联调，看真实的 /state /pets /asset 响应
//
//   node scripts/dev-server.mjs [--port 3099] [--pkg <宠物包目录>] [--demo] [--no-desktop]
// =============================================================================

import http from 'node:http'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')

function argAfter(list, flag, def) {
  const i = list.indexOf(flag)
  return i >= 0 && list[i + 1] ? list[i + 1] : def
}
const args = process.argv.slice(2)
const PORT = Number(argAfter(args, '--port', '3099'))
const PKG = argAfter(args, '--pkg', '')
const DEMO = args.includes('--demo')
const NO_DESKTOP = args.includes('--no-desktop')
// --registry <路径>：用真实的宠物注册表（而不是临时文件），用来验证
// "重启 dsh web 之后界面里到底会不会出现这些宠物"。
const REGISTRY = argAfter(args, '--registry', '')

// ---------- 桩 webServer（exact + prefix，和真实实现同语义） ----------
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
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: 'dev-server: no route ' + p }))
  })
  return {
    server,
    host: '127.0.0.1',
    port: PORT,
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
    listen: () => new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(PORT))),
    close: () => new Promise((r) => server.close(r)),
  }
}

// ---------- 桩 agents / sessionTitle / workspaceRegistry ----------
function makeDemoServices() {
  const ws = {
    id: 'ws-demo-1',
    title: '桌宠',
    path: 'D:\\代码\\桌宠',
    sessionIds: ['session-demo-1', 'session-demo-2'],
  }
  const agents = [
    { id: 'session-demo-1', status: 'running', session: { id: 'session-demo-1' } },
    { id: 'session-demo-2', status: 'idle', session: { id: 'session-demo-2' } },
  ]
  const titles = new Map([
    ['session-demo-1', { title: '把桌宠做成原生桌面窗口', updatedAt: Date.now() - 5000 }],
    ['session-demo-2', { title: '封装 dsh-pet-forge 技能', updatedAt: Date.now() - 600000 }],
  ])
  return {
    agents: { list: () => agents },
    sessionTitle: { get: (session) => titles.get(String(session && session.id)) },
    workspaceRegistry: { list: () => [ws] },
  }
}

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-pet-dev-'))
  const webServer = makeWebServer()
  const shellCalls = []
  const demo = DEMO ? makeDemoServices() : {}

  const services = {
    fs: undefined,
    agents: demo.agents || { list: () => [] },
    sessionTitle: demo.sessionTitle,
    workspaceRegistry: demo.workspaceRegistry,
    shell: {
      resolve: (input) => ({ input }),
      run: async (spec) => { shellCalls.push(spec); console.log('[shell] 播放：', String(spec.input.command).slice(0, 120)); return { ok: true } },
    },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '' }) },
  }

  const timers = []
  const ctx = {
    webServer,
    get: (n) => services[n],
    interval: (fn, ms) => { const t = setInterval(fn, ms); timers.push(t); return () => clearInterval(t) },
    timeout: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t) },
    on: () => {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }

  const host = await import(pathToFileURL(join(REPO, 'host.js')).href)
  host.apply(ctx, {
    registryPath: REGISTRY || join(tmp, 'registry.json'),
    desktopPet: !NO_DESKTOP,
    desktopLog: join(tmp, 'desktop-pet.log'),
    pollMs: 500,
  })
  await webServer.listen()

  console.log('')
  console.log('  dsh-ronaldo-pet 调试服务器')
  console.log('  ─────────────────────────────────────────────')
  console.log('  基地址      http://127.0.0.1:' + PORT)
  console.log('  宠物注册表  ' + join(tmp, 'registry.json'))
  console.log('  桌面宠物日志 ' + join(tmp, 'desktop-pet.log'))
  console.log('  演示对话    ' + (DEMO ? '开（2 个假对话 + 1 个工作区）' : '关'))
  if (PKG && existsSync(join(PKG, 'pet.json'))) {
    console.log('  预注册宠物  ' + PKG)
  }
  console.log('')
  console.log('  手动跑桌面宠物：')
  console.log('    powershell.exe -STA -ExecutionPolicy Bypass -File "' + join(REPO, 'desktop', 'DesktopPet.ps1') + '" -Base http://127.0.0.1:' + PORT)
  console.log('')

  if (PKG && existsSync(join(PKG, 'pet.json'))) {
    const res = await fetch(`http://127.0.0.1:${PORT}/ronaldo-pet/pets/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: PKG }),
    })
    const data = await res.json()
    console.log(data.ok ? `  ✅ 已注册 ${data.pet.name}（${data.pet.id}）` : `  ❌ 注册失败：${data.error} ${JSON.stringify(data.errors || '')}`)
  }

  process.on('SIGINT', async () => {
    console.log('\n  正在关闭…')
    for (const t of timers) clearInterval(t)
    await webServer.close()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
