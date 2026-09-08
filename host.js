// =============================================================================
// C罗桌宠 · DSH bundle 插件（Host 半）
// 常驻：作为 profile bundle 加载，跨进程重启保留。
//
// 职责：
//   1. 读取内置素材（C罗精灵图 + SIU 提示音），经 webServer 注册 HTTP 路由
//   2. 轮询 agents 服务 + 监听 tools/execute、approval/request、agent/request-error
//      推导桌宠状态（idle / working / review / waiting / failed / celebrating）
//   3. 对话完成时由宿主进程用系统命令播放 SIU 提示音（全窗口可闻）
//   4. 提供 /ronaldo-pet/state 状态接口，以及 import-codex / import-image
//      自定义 spritesheet 导入接口（供客户端"统一管理"设置面板调用）
//
// 安装：见 README.md「安装」章节（dsh plugin --profile web add <本包>）
// =============================================================================

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const name = 'ronaldo-pet'

export const inject = ['timer', 'webServer']

const CONFIG = {
  spritePath: join(__dirname, 'assets', 'spritesheet.webp'),
  voicePath: join(__dirname, 'assets', 'siu.mp3'),
  pollMs: 500,
  celebrateMs: 4800,
  failedMs: 2600,
}

// Windows 用 WPF MediaPlayer 播放 mp3；macOS 改 afplay；Linux 改 ffplay
const playCommand = (path) => {
  const p = path.replace(/'/g, "''")
  return "powershell.exe -NoProfile -WindowStyle Hidden -Command \"Add-Type -AssemblyName presentationCore; $m = New-Object System.Windows.Media.MediaPlayer; $m.Open('" + p + "'); $m.Play(); Start-Sleep -Seconds 5; $m.Close()\""
}

// ---------- 通用 spritesheet 布局 / 状态行约定（自定义导入用） ----------
const defaultStates = (cols, rows, framesPerRow) => {
  const fr = (i) => (framesPerRow && framesPerRow[i] != null) ? framesPerRow[i] : cols
  return {
    idle: { row: 0, frames: fr(0), fps: 6 },
    runRight: { row: 1, frames: fr(1), fps: 12 },
    runLeft: { row: 2, frames: fr(2), fps: 12 },
    waving: { row: 3, frames: fr(3), fps: 8 },
    jumping: { row: 4, frames: fr(4), fps: 10 },
    failed: { row: 5, frames: fr(5), fps: 12 },
    waiting: { row: 6, frames: fr(6), fps: 5 },
    running: { row: 7, frames: fr(7), fps: 12 },
    review: { row: 8, frames: fr(8), fps: 6 },
    look: rows >= 11 ? { rows: [9, 10] } : null,
  }
}

const STATE_NAME_MAP = {
  'idle': 'idle', 'running-right': 'runRight', 'running-left': 'runLeft',
  'waving': 'waving', 'jumping': 'jumping', 'failed': 'failed',
  'waiting': 'waiting', 'running': 'running', 'review': 'review',
}
const STATE_FPS = { idle: 6, runRight: 12, runLeft: 12, waving: 8, jumping: 10, failed: 12, waiting: 5, running: 12, review: 6 }

const parseCodexRows = (rows) => {
  const states = {}
  const lookRows = []
  ;(rows || []).forEach((r) => {
    const key = r && r.state
    if (key === 'look-row-9' || key === 'look-row-10') { lookRows.push(r.row); return }
    const mapped = STATE_NAME_MAP[key]
    if (mapped) states[mapped] = { row: r.row, frames: r.frames || 1, fps: STATE_FPS[mapped] || 8 }
  })
  lookRows.sort((a, b) => a - b)
  if (lookRows.length >= 2) states.look = { rows: [lookRows[0], lookRows[1]] }
  else if (lookRows.length === 1) states.look = { rows: [lookRows[0], lookRows[0]] }
  return states
}

const mimeFor = (path) => {
  const p = (path || '').toLowerCase()
  if (p.endsWith('.webp')) return 'image/webp'
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg'
  if (p.endsWith('.gif')) return 'image/gif'
  if (p.endsWith('.png')) return 'image/png'
  return 'application/octet-stream'
}

const readBody = (req, cap = 2 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = []
  let size = 0
  req.on('data', (c) => {
    size += c.length
    if (size > cap) { reject(new Error('request body too large')); req.destroy(); return }
    chunks.push(c)
  })
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
  req.on('error', reject)
})

const sendJson = (res, status, body) => {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(data)),
    'Cache-Control': 'no-store',
  })
  res.end(data)
}

export function apply(ctx, config = {}) {
  const cfg = Object.assign({}, CONFIG, config || {})
  const webServer = ctx.webServer

  // 优先使用 DSH 沙箱感知的 fs 服务（尊重用户工作区策略），缺失时退回 node:fs
  const fsService = typeof ctx.get === 'function' ? ctx.get('fs') : undefined
  const readMaybe = async (path, maxBytes = 30 * 1024 * 1024) => {
    if (fsService !== undefined && typeof fsService.resolve === 'function' && typeof fsService.readBytes === 'function') {
      const t = await fsService.resolve(path)
      return await fsService.readBytes(t, undefined, maxBytes)
    }
    return await readFile(path)
  }

  let spriteBytes = null
  let voiceBytes = null
  let disposed = false
  const routeDisposers = []

  let mode = 'idle'
  let seq = 0
  let celebrating = false
  let celebrateTimer = null
  let failTimer = null
  let toolsInFlight = 0
  let recentTool = false
  let recentToolTimer = null
  let waitingCount = 0

  const turnFlags = new WeakMap()
  const lastStatus = new WeakMap()
  const observedAgents = new Set()

  const flagsOf = (agent) => {
    let f = turnFlags.get(agent)
    if (f === undefined) { f = { worked: false, errored: false }; turnFlags.set(agent, f) }
    return f
  }
  const lastStatusEntries = () => {
    const out = []
    for (const agent of observedAgents) {
      const s = lastStatus.get(agent)
      if (s !== undefined) out.push([agent, s])
    }
    return out
  }
  const currentRunningCount = () => {
    let n = 0
    for (const e of lastStatusEntries()) if (e[1] === 'running') n++
    return n
  }
  const setMode = (next) => {
    if (next === mode) return
    if (celebrating && next !== 'celebrating') return
    mode = next
    seq++
  }
  const deriveMode = (runningCount) => {
    if (celebrating) return
    let next
    if (waitingCount > 0) next = 'waiting'
    else if (runningCount > 0) next = (toolsInFlight > 0 || recentTool) ? 'working' : 'review'
    else next = 'idle'
    setMode(next)
  }

  const playSystemVoice = () => {
    const shell = typeof ctx.get === 'function' ? ctx.get('shell') : undefined
    if (shell === undefined) return
    try {
      const sp = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined
      const sandboxPolicy = sp !== undefined ? sp.resolve({ mode: 'danger-full-access' }) : { mode: 'danger-full-access', workspaceRoot: '' }
      const spec = shell.resolve({ command: playCommand(cfg.voicePath), sandboxPolicy })
      shell.run(spec).catch(() => {})
    } catch (err) {
      console.error('[ronaldo-pet] failed to start voice playback:', err)
    }
  }

  const celebrate = () => {
    if (celebrating) {
      if (celebrateTimer) celebrateTimer()
      celebrateTimer = ctx.timeout(() => { celebrateTimer = null; celebrating = false; deriveMode(currentRunningCount()) }, cfg.celebrateMs)
      return
    }
    celebrating = true
    setMode('celebrating')
    playSystemVoice()
    celebrateTimer = ctx.timeout(() => { celebrateTimer = null; celebrating = false; deriveMode(currentRunningCount()) }, cfg.celebrateMs)
  }

  const showFailed = () => {
    if (celebrating) return
    setMode('failed')
    if (failTimer) failTimer()
    failTimer = ctx.timeout(() => { failTimer = null; deriveMode(currentRunningCount()) }, cfg.failedMs)
  }

  const markToolSettled = (wasQuestion) => {
    toolsInFlight = Math.max(0, toolsInFlight - 1)
    if (wasQuestion) waitingCount = Math.max(0, waitingCount - 1)
    if (toolsInFlight === 0) {
      if (recentToolTimer) recentToolTimer()
      recentToolTimer = ctx.timeout(() => { recentToolTimer = null; recentTool = false; deriveMode(currentRunningCount()) }, 2500)
    }
    deriveMode(currentRunningCount())
  }

  // ---------- HTTP 路由 ----------
  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/state',
    handler: (req, res) => {
      sendJson(res, 200, {
        mode,
        seq,
        spriteUrl: spriteBytes !== null ? '/ronaldo-pet/spritesheet.webp' : null,
        voiceUrl: voiceBytes !== null ? '/ronaldo-pet/siu.mp3' : null,
      })
    },
  }))

  const registerAssetRoutes = () => {
    if (spriteBytes !== null) {
      routeDisposers.push(webServer.register({
        kind: 'exact',
        path: '/ronaldo-pet/spritesheet.webp',
        handler: (req, res) => {
          res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': String(spriteBytes.length), 'Cache-Control': 'public, max-age=86400' })
          res.end(spriteBytes)
        },
      }))
    }
    if (voiceBytes !== null) {
      routeDisposers.push(webServer.register({
        kind: 'exact',
        path: '/ronaldo-pet/siu.mp3',
        handler: (req, res) => {
          res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(voiceBytes.length), 'Cache-Control': 'public, max-age=86400' })
          res.end(voiceBytes)
        },
      }))
    }
  }

  // 自定义 spritesheet 导入（供客户端设置面板调用）
  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/import-codex',
    handler: async (req, res) => {
      try {
        const args = JSON.parse(await readBody(req) || '{}')
        const dir = String((args && args.dir) || '').replace(/[\\/]+$/, '')
        if (!dir) return sendJson(res, 400, { ok: false, error: '缺少 codex 项目目录路径' })
        let target = join(dir, 'final', 'spritesheet-extended.webp')
        let bytes
        try {
          bytes = await readMaybe(target)
        } catch (e1) {
          try {
            target = join(dir, 'final', 'spritesheet.webp')
            bytes = await readMaybe(target)
          } catch (e2) {
            return sendJson(res, 404, { ok: false, error: '未找到 final/spritesheet-extended.webp 或 final/spritesheet.webp（' + dir + '）' })
          }
        }
        const uri = 'data:image/webp;base64,' + Buffer.from(bytes).toString('base64')
        let layout = { cols: 8, rows: 11, cellW: 192, cellH: 208 }
        let states = defaultStates(8, 11, null)
        let name = '新宠物'
        try {
          const pr = join(dir, 'pet_request.json')
          const text = await readMaybe(pr, 1024 * 1024)
          const data = JSON.parse(String(text))
          if (data && data.atlas) {
            layout = {
              cols: data.atlas.columns || 8,
              rows: data.atlas.rows || 11,
              cellW: data.atlas.cell_width || 192,
              cellH: data.atlas.cell_height || 208,
            }
          }
          if (data && data.display_name) name = data.display_name
          if (data && data.rows) { const parsed = parseCodexRows(data.rows); if (Object.keys(parsed).length > 0) states = parsed }
        } catch (e2) { /* 目录里没有 pet_request.json，用默认布局 */ }
        return sendJson(res, 200, { ok: true, name, sheet: { uri, cols: layout.cols, rows: layout.rows, cellW: layout.cellW, cellH: layout.cellH }, states })
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err && err.message || err) })
      }
    },
  }))

  routeDisposers.push(webServer.register({
    kind: 'exact',
    path: '/ronaldo-pet/import-image',
    handler: async (req, res) => {
      try {
        const args = JSON.parse(await readBody(req) || '{}')
        const p = String((args && args.path) || '').trim()
        if (!p) return sendJson(res, 400, { ok: false, error: '缺少 spritesheet 图片路径' })
        const cols = Math.max(1, parseInt(args && args.cols, 10) || 8)
        const rows = Math.max(1, parseInt(args && args.rows, 10) || 11)
        const cellW = Math.max(1, parseInt(args && args.cellW, 10) || 192)
        const cellH = Math.max(1, parseInt(args && args.cellH, 10) || 208)
        let framesPerRow = null
        if (args && args.framesPerRow != null) {
          const list = Array.isArray(args.framesPerRow) ? args.framesPerRow : String(args.framesPerRow).split(',').map((x) => parseInt(x, 10) || 0)
          if (list.length > 0) framesPerRow = list
        }
        const bytes = await readMaybe(p)
        const uri = 'data:' + mimeFor(p) + ';base64,' + Buffer.from(bytes).toString('base64')
        return sendJson(res, 200, { ok: true, sheet: { uri, cols, rows, cellW, cellH }, states: defaultStates(cols, rows, framesPerRow) })
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err && err.message || err) })
      }
    },
  }))

  const loadAssets = async () => {
    try {
      spriteBytes = await readMaybe(cfg.spritePath)
      console.log('[ronaldo-pet] spritesheet loaded:', spriteBytes.length, 'bytes')
    } catch (err) {
      console.error('[ronaldo-pet] failed to load spritesheet:', err)
    }
    try {
      voiceBytes = await readMaybe(cfg.voicePath)
      console.log('[ronaldo-pet] voice loaded:', voiceBytes.length, 'bytes')
    } catch (err) {
      console.error('[ronaldo-pet] failed to load voice:', err)
    }
    if (!disposed) registerAssetRoutes()
  }
  loadAssets()

  ctx.effect(() => () => {
    disposed = true
    for (const d of routeDisposers) d()
    if (celebrateTimer) celebrateTimer()
    if (failTimer) failTimer()
    if (recentToolTimer) recentToolTimer()
  })

  // ---------- Agent 状态机（轮询 + 事件） ----------
  const agentsService = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  const poll = () => {
    if (agentsService === undefined) return
    let list
    try { list = agentsService.list() } catch (err) { return }
    if (!Array.isArray(list)) return
    const runningNow = new Set()
    for (const agent of list) {
      let status = 'idle'
      try { status = agent && agent.status === 'running' ? 'running' : 'idle' } catch (err) { status = 'idle' }
      if (status === 'running') runningNow.add(agent)
      const prev = lastStatus.get(agent)
      lastStatus.set(agent, status)
      if (agent && prev === undefined) observedAgents.add(agent)
      if (prev === 'running' && status === 'idle') {
        if (runningNow.size === 0 && waitingCount === 0) {
          const f = turnFlags.get(agent)
          if (f === undefined || !f.errored) celebrate()
          if (f !== undefined) turnFlags.delete(agent)
        }
      }
    }
    deriveMode(runningNow.size)
  }
  const stopPolling = ctx.interval(poll, cfg.pollMs)
  ctx.effect(() => stopPolling)

  ctx.on('approval/request', (req, next) => {
    waitingCount++
    deriveMode(currentRunningCount())
    let p
    try { p = Promise.resolve(next()) } catch (err) { waitingCount = Math.max(0, waitingCount - 1); deriveMode(currentRunningCount()); throw err }
    p.then(
      () => { waitingCount = Math.max(0, waitingCount - 1); deriveMode(currentRunningCount()) },
      () => { waitingCount = Math.max(0, waitingCount - 1); deriveMode(currentRunningCount()) },
    )
    return p
  })

  ctx.on('tools/execute', (exec, next) => {
    let isQuestion = false
    if (exec && exec.agent) flagsOf(exec.agent).worked = true
    if (exec && typeof exec.name === 'string' && exec.name === 'ask_user_question') { isQuestion = true; waitingCount++ }
    toolsInFlight++
    recentTool = true
    if (recentToolTimer) { recentToolTimer(); recentToolTimer = null }
    deriveMode(currentRunningCount())
    let p
    try { p = Promise.resolve(next()) } catch (err) { markToolSettled(isQuestion); throw err }
    p.then(
      () => markToolSettled(isQuestion),
      () => markToolSettled(isQuestion),
    )
    return p
  })

  ctx.on('agent/request-error', (payload, next) => {
    if (payload && payload.agent) flagsOf(payload.agent).errored = true
    showFailed()
    return next()
  })
}
