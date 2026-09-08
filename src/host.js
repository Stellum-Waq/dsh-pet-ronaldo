// =============================================================================
// C罗桌宠 · DSH 动态插件（Host 半）
// 用于 DSH 的 cordis_define 工具：code.host 字段
//
// 职责：
//   1. 读取本地素材（内置 C罗精灵图 + SIU 提示音），经 webServer 注册 HTTP 路由
//   2. 轮询 agents 服务 + 监听 tools/execute、approval/request、agent/request-error
//      推导桌宠状态（idle / working / review / waiting / failed / celebrating）
//   3. 对话完成时由宿主进程用系统命令播放 SIU 提示音（全窗口可闻）
//   4. 提供 pet-state 状态 RPC，以及 import-codex / import-image 宠物导入 RPC
//
// 安装：见 README.md「安装」章节
// =============================================================================

// ===== 配置区（按需修改） =====
const CONFIG = {
  // 内置 C罗精灵图路径（8 列 × 11 行、每格 192×208 的 WebP）
  spritePath: 'D:/代码/桌宠/dsh-ronaldo-pet/assets/spritesheet.webp',
  // SIU 提示音路径（mp3）
  voicePath: 'D:/代码/桌宠/dsh-ronaldo-pet/assets/siu.mp3',
  // 状态轮询间隔（毫秒）
  pollMs: 500,
  // 庆祝动画持续时长（毫秒）
  celebrateMs: 4800,
  // 失败动画持续时长（毫秒）
  failedMs: 2600,
}

// 播放命令（Windows）：直接给 PowerShell 语句，由 ctx.shell / ctx.bash 侧执行。
// 不要包成 powershell.exe -Command "…$m…"，外层 PowerShell 会先把 $m 插值吃掉导致静默失败。
const playCommand = (path) => {
  const p = path.replace(/'/g, "''")
  return "Add-Type -AssemblyName presentationCore; $m = New-Object System.Windows.Media.MediaPlayer; $m.Open('" + p + "'); $m.Play(); Start-Sleep -Seconds 5; $m.Close()"
}

return {
  inject: ['timer'],
  apply(ctx) {
    const fs = ctx.get('fs')
    const webServer = ctx.get('webServer')
    if (fs === undefined || webServer === undefined) {
      console.error('[ronaldo-pet] fs or webServer service is unavailable')
      return
    }

    // ---------- base64 编码（用于导入的 data URI） ----------
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const bytesToBase64 = (bytes) => {
      const parts = []
      const len = bytes.length
      for (let i = 0; i < len; i += 3) {
        const b0 = bytes[i]
        const b1 = i + 1 < len ? bytes[i + 1] : 0
        const b2 = i + 2 < len ? bytes[i + 2] : 0
        const n = (b0 << 16) | (b1 << 8) | b2
        parts.push(B64[(n >> 18) & 63], B64[(n >> 12) & 63])
        parts.push(i + 1 < len ? B64[(n >> 6) & 63] : '=')
        parts.push(i + 2 < len ? B64[n & 63] : '=')
      }
      return parts.join('')
    }
    const mimeFor = (path) => {
      const p = (path || '').toLowerCase()
      if (p.endsWith('.webp')) return 'image/webp'
      if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg'
      if (p.endsWith('.gif')) return 'image/gif'
      return 'image/png'
    }

    // ---------- 默认状态映射（通用 spritesheet 导入用，8 行约定） ----------
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
    const STATE_NAME_MAP = { 'idle': 'idle', 'running-right': 'runRight', 'running-left': 'runLeft', 'waving': 'waving', 'jumping': 'jumping', 'failed': 'failed', 'waiting': 'waiting', 'running': 'running', 'review': 'review' }
    const STATE_FPS = { idle: 6, runRight: 12, runLeft: 12, waving: 8, jumping: 10, failed: 12, waiting: 5, running: 12, review: 6 }
    const parseCodexRows = (rows) => {
      const states = {}
      const lookRows = []
      ;(rows || []).forEach((r) => {
        const key = r.state
        if (key === 'look-row-9' || key === 'look-row-10') { lookRows.push(r.row); return }
        const mapped = STATE_NAME_MAP[key]
        if (mapped) states[mapped] = { row: r.row, frames: r.frames || 1, fps: STATE_FPS[mapped] || 8 }
      })
      lookRows.sort((a, b) => a - b)
      if (lookRows.length >= 2) states.look = { rows: [lookRows[0], lookRows[1]] }
      else if (lookRows.length === 1) states.look = { rows: [lookRows[0], lookRows[0]] }
      return states
    }

    // ---------- 内置素材加载 + webServer 路由 ----------
    let spriteBytes = null
    let voiceBytes = null
    let disposed = false
    const routeDisposers = []

    const registerAssetRoutes = () => {
      if (spriteBytes !== null) {
        routeDisposers.push(webServer.register({
          kind: 'exact',
          path: '/ronaldo-pet/spritesheet.webp',
          handler: (req, res) => {
            res.writeHead(200, {
              'Content-Type': 'image/webp',
              'Content-Length': String(spriteBytes.length),
              'Cache-Control': 'public, max-age=86400',
            })
            res.end(spriteBytes)
          },
        }))
      }
      if (voiceBytes !== null) {
        routeDisposers.push(webServer.register({
          kind: 'exact',
          path: '/ronaldo-pet/siu.mp3',
          handler: (req, res) => {
            res.writeHead(200, {
              'Content-Type': 'audio/mpeg',
              'Content-Length': String(voiceBytes.length),
              'Cache-Control': 'public, max-age=86400',
            })
            res.end(voiceBytes)
          },
        }))
      }
    }

    const loadAssets = async () => {
      try {
        const t = await fs.resolve(CONFIG.spritePath)
        spriteBytes = await fs.readBytes(t, undefined, 30 * 1024 * 1024)
        console.log('[ronaldo-pet] spritesheet loaded:', spriteBytes.length, 'bytes')
      } catch (err) {
        console.error('[ronaldo-pet] failed to load spritesheet:', err)
      }
      try {
        const t = await fs.resolve(CONFIG.voicePath)
        voiceBytes = await fs.readBytes(t, undefined, 16 * 1024 * 1024)
        console.log('[ronaldo-pet] voice loaded:', voiceBytes.length, 'bytes')
      } catch (err) {
        console.error('[ronaldo-pet] failed to load voice:', err)
      }
      if (!disposed) registerAssetRoutes()
    }
    const assetsReady = loadAssets()

    // ---------- 状态机（轮询 agents 服务驱动） ----------
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
      const shell = ctx.get('shell')
      if (shell === undefined) return
      try {
        const sp = ctx.get('sandboxPolicy')
        const sandboxPolicy = sp !== undefined ? sp.resolve({ mode: 'danger-full-access' }) : { mode: 'danger-full-access', workspaceRoot: '' }
        const spec = shell.resolve({ command: playCommand(CONFIG.voicePath), sandboxPolicy })
        shell.run(spec).catch(() => {})
      } catch (err) {
        console.error('[ronaldo-pet] failed to start voice playback:', err)
      }
    }

    const celebrate = () => {
      if (celebrating) {
        if (celebrateTimer) celebrateTimer()
        celebrateTimer = ctx.timeout(() => { celebrateTimer = null; celebrating = false; deriveMode(currentRunningCount()) }, CONFIG.celebrateMs)
        return
      }
      celebrating = true
      setMode('celebrating')
      playSystemVoice()
      celebrateTimer = ctx.timeout(() => { celebrateTimer = null; celebrating = false; deriveMode(currentRunningCount()) }, CONFIG.celebrateMs)
    }

    const showFailed = () => {
      if (celebrating) return
      setMode('failed')
      if (failTimer) failTimer()
      failTimer = ctx.timeout(() => { failTimer = null; deriveMode(currentRunningCount()) }, CONFIG.failedMs)
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

    ctx.effect(() => () => {
      disposed = true
      for (const d of routeDisposers) d()
      if (celebrateTimer) celebrateTimer()
      if (failTimer) failTimer()
      if (recentToolTimer) recentToolTimer()
    })

    const agentsService = ctx.get('agents')
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
            if (f !== undefined) { turnFlags.delete(agent) }
          }
        }
      }
      deriveMode(runningNow.size)
    }
    const stopPolling = ctx.interval(poll, CONFIG.pollMs)
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

    // ---------- client RPC ----------
    harness.handle('pet-state', async () => {
      await assetsReady
      const host = webServer.host === '0.0.0.0' ? '127.0.0.1' : webServer.host
      const base = 'http://' + host + ':' + webServer.port
      return {
        mode,
        seq,
        spriteUrl: spriteBytes !== null ? base + '/ronaldo-pet/spritesheet.webp' : null,
        voiceUrl: voiceBytes !== null ? base + '/ronaldo-pet/siu.mp3' : null,
      }
    })

    harness.handle('import-codex', async (args) => {
      const dir = ((args && args.dir) || '').replace(/[\\/]+$/, '')
      try {
        const ss = await fs.resolve(dir + '/final/spritesheet-extended.webp')
        const bytes = await fs.readBytes(ss, undefined, 30 * 1024 * 1024)
        const uri = 'data:image/webp;base64,' + bytesToBase64(bytes)
        let layout = { cols: 8, rows: 11, cellW: 192, cellH: 208 }
        let states = defaultStates(8, 11, null)
        let name = '新宠物'
        try {
          const pr = await fs.resolve(dir + '/pet_request.json')
          const text = await fs.readText(pr, undefined)
          const data = JSON.parse(text)
          if (data.atlas) layout = { cols: data.atlas.columns || 8, rows: data.atlas.rows || 11, cellW: data.atlas.cell_width || 192, cellH: data.atlas.cell_height || 208 }
          if (data.display_name) name = data.display_name
          if (data.rows) { const parsed = parseCodexRows(data.rows); if (Object.keys(parsed).length > 0) states = parsed }
        } catch (e2) { /* 目录里没有 pet_request.json，用默认布局 */ }
        return { ok: true, name, sheet: { uri, cols: layout.cols, rows: layout.rows, cellW: layout.cellW, cellH: layout.cellH }, states }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    })

    harness.handle('import-image', async (args) => {
      const path = (args && args.path) || ''
      const cols = (args && args.cols) || 8
      const rows = (args && args.rows) || 11
      const cellW = (args && args.cellW) || 192
      const cellH = (args && args.cellH) || 208
      const framesPerRow = (args && args.framesPerRow) || null
      try {
        const t = await fs.resolve(path)
        const bytes = await fs.readBytes(t, undefined, 30 * 1024 * 1024)
        const uri = 'data:' + mimeFor(path) + ';base64,' + bytesToBase64(bytes)
        return { ok: true, sheet: { uri, cols, rows, cellW, cellH }, states: defaultStates(cols, rows, framesPerRow) }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    })
  },
}
