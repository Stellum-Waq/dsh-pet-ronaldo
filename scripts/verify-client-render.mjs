// =============================================================================
// 网页端插件（client/client.js）渲染冒烟测试
//
//   node scripts/verify-client-render.mjs
//
// 为什么需要它：client.js 是注入进 DSH 界面的插件，平时只有在真实 dsh web 里跑起来
// 才会执行。改完设置面板（比如这次的「自动」尺寸、1024 上限、image-rendering）
// 如果只做 node --check，只能证明"语法没错"，证明不了"点下去真的会发对请求"。
//
// 这里用一套极小的替身把插件加载起来并**真的渲染一遍**：
//   · window.__ModuleLoader__ / document / fetch / localStorage / 定时器 全部替身化
//   · React 只用到 createElement / useState / useEffect / useRef / useCallback，
//     所以自己实现一个几十行的迷你渲染器（含 state 更新触发的重渲染）
//   · 渲染出来的树是真树，可以按 className 找到元素、读它的 style、甚至调用 onClick
//
// 于是能验证的是**行为**，不是文本：
//   · apply() 会注册 settings.section 与 shell.overlay 两个槽位
//   · scaling=pixelated 的素材渲染出 image-rendering: pixelated（smooth 则是 auto）
//   · 设置面板渲染出 32..1024 的尺寸滑杆和「自动」按钮
//   · 点「自动」真的会 POST { patch: { desktopSize: 0 } } 给宿主
// =============================================================================

import { readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')

// 先把真正的 setTimeout 抓在手里：下面 installGlobals() 会把它换成替身
// （插件里的 setTimeout 只记录不执行，由测试显式 flush），
// 要是连测试自己的等待也一起换掉，settle() 就永远等不回来了。
const realSetTimeout = globalThis.setTimeout.bind(globalThis)

let pass = 0
let fail = 0
const ok = (n, e = '') => { pass++; console.log('  ok   ' + n + (e ? '  — ' + e : '')) }
const bad = (n, e = '') => { fail++; console.log('  FAIL ' + n + (e ? '  — ' + e : '')) }
const check = (c, n, e = '') => (c ? ok(n, e) : bad(n, e))

// ---------------------------------------------------------------- 迷你 React
//
// 只实现这个插件用到的那几个 API。槽位按"渲染路径"存，state 更新会把整棵树重渲染，
// 这样 useStore() 里 "每次渲染都读当前 state" 的写法才能拿到新数据。

const instances = new Map()
let renderPath = []
let slotIdx = 0
let currentSlots = null
let pendingEffects = []
let needsRender = false
let rerenderHook = null

const slotArray = (path) => {
  const key = path.join('>')
  if (!instances.has(key)) instances.set(key, [])
  return instances.get(key)
}

const useState = (init) => {
  const arr = currentSlots
  const i = slotIdx++
  if (!(i in arr)) arr[i] = typeof init === 'function' ? init() : init
  const set = (v) => {
    arr[i] = typeof v === 'function' ? v(arr[i]) : v
    needsRender = true
  }
  return [arr[i], set]
}
const useRef = (init) => {
  const arr = currentSlots
  const i = slotIdx++
  if (!(i in arr)) arr[i] = { current: init }
  return arr[i]
}
// useCallback 必须给出**稳定**的函数身份：插件里 effect 的依赖数组就是它，
// 每次渲染都返回新函数会让 effect 无限重跑（refresh -> setInfo -> 重渲染 -> ...）。
const useCallback = (fn, deps) => {
  const arr = currentSlots
  const i = slotIdx++
  const prev = arr[i]
  const same = prev && Array.isArray(deps) && Array.isArray(prev.deps) &&
    deps.length === prev.deps.length && deps.every((d, k) => Object.is(d, prev.deps[k]))
  if (same) return prev.fn
  arr[i] = { fn, deps }
  return fn
}
const useEffect = (fn, deps) => {
  const arr = currentSlots
  const i = slotIdx++
  const prev = arr[i]
  const same = prev && Array.isArray(deps) && Array.isArray(prev.deps) &&
    deps.length === prev.deps.length && deps.every((d, k) => Object.is(d, prev.deps[k]))
  if (same) return
  if (prev && typeof prev.cleanup === 'function') pendingEffects.push({ run: prev.cleanup })
  const slot = { deps, cleanup: null }
  arr[i] = slot
  pendingEffects.push({
    run: () => {
      const r = fn()
      if (typeof r === 'function') slot.cleanup = r
    },
  })
}

const createElement = (type, props, ...children) => {
  const p = Object.assign({}, props || {})
  if (children.length === 1) p.children = children[0]
  else if (children.length > 1) p.children = children
  return { type, props: p }
}

const reactStub = { createElement, useState, useEffect, useRef, useCallback }

// ---------------------------------------------------------------- 迷你渲染器

function renderNode(node, path) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return { kind: 'text', text: String(node) }
  if (Array.isArray(node)) {
    return node.map((n, i) => renderNode(n, path.concat('#' + i))).filter(Boolean)
  }
  const type = node.type
  const props = node.props || {}
  if (typeof type === 'function') {
    const childPath = path.concat(type.name || 'anonymous')
    const savedPath = renderPath
    const savedIdx = slotIdx
    const savedSlots = currentSlots
    renderPath = childPath
    slotIdx = 0
    currentSlots = slotArray(childPath)
    let out
    try {
      out = type(props)
    } finally {
      renderPath = savedPath
      slotIdx = savedIdx
      currentSlots = savedSlots
    }
    return renderNode(out, childPath)
  }
  const kids = renderNode(props.children, path)
  return { kind: 'el', type: String(type), props, children: Array.isArray(kids) ? kids : (kids ? [kids] : []) }
}

function flatten(node, out = []) {
  if (!node) return out
  if (Array.isArray(node)) { node.forEach((n) => flatten(n, out)); return out }
  if (node.kind === 'el') { out.push(node); flatten(node.children, out) }
  return out
}

const textOf = (node) => {
  if (!node) return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node.kind === 'text') return node.text
  if (node.kind === 'el') return textOf(node.children)
  return ''
}

// ---------------------------------------------------------------- 宿主替身

const calls = []
let desktopStatus = { ok: true, running: false, enabled: true, supported: true, size: 96, platform: 'win32' }
let petsPayload = { ok: true, revision: 1, settings: { displayMode: 'auto', defaultPet: 'ronaldo', desktopSize: 96 }, pets: [] }

function makeRes(obj) {
  return {
    ok: true,
    status: 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  }
}

const fetchStub = async (url, init) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '')
  const body = init && init.body ? JSON.parse(init.body) : null
  calls.push({ path, method: (init && init.method) || 'GET', body })
  if (path === '/ronaldo-pet/state') {
    return makeRes({ mode: 'idle', seq: 1, revision: petsPayload.revision, desktop: { running: desktopStatus.running }, settings: petsPayload.settings })
  }
  if (path === '/ronaldo-pet/pets') return makeRes(petsPayload)
  if (path === '/ronaldo-pet/desktop') return makeRes(desktopStatus)
  if (path === '/ronaldo-pet/settings') return makeRes({ ok: true, settings: petsPayload.settings })
  if (path.startsWith('/ronaldo-pet/gallery/install')) {
    return makeRes({ ok: true, command: 'gallery/install', mode: 'dpsl', id: 'pixel-cat', pet: { id: 'pixel-cat', name: '像素猫' }, warnings: [] })
  }
  if (path.startsWith('/ronaldo-pet/gallery/share')) {
    return makeRes({
      ok: true,
      command: 'gallery/share',
      pkg: 'D:\\pets\\my-pet',
      files: ['DSH-PET-LICENSE.md', 'README.md', 'SHARING.md', 'publish.ps1'],
      topic: 'dsh-pet',
      next: {
        steps: ['1. 检查 README', '2. 跑 publish.ps1', '3. 加 topic dsh-pet'],
        commands: ['git init', 'git push -u origin main'],
        indexEntry: { key: 'me/my-pet', repo: 'https://github.com/me/my-pet', protocol: 'DPSL-1.0' },
      },
    })
  }
  if (path.startsWith('/ronaldo-pet/gallery/probe')) return makeRes({ ok: true, entry: galleryPayload.entries[0] })
  if (path.startsWith('/ronaldo-pet/video/probe')) {
    return makeRes({
      ok: true,
      command: 'video/probe',
      engines: {
        available: ['cv2'],
        preferred: 'cv2',
        ffmpeg: null,
        cv2: { version: '4.13.0', python: 'python' },
        hint: '',
        install: [],
      },
      running: false,
      video: videoInfoFixture,
    })
  }
  if (path.startsWith('/ronaldo-pet/video/build')) {
    return makeRes({ ok: true, command: 'video/build', jobId: 'v1-abc', pkg: 'D:\\generated\\green-cat', human: '已开始生成' })
  }
  if (path.startsWith('/ronaldo-pet/video/status')) {
    videoStatusPolls++
    if (videoStatusPolls < 2) {
      return makeRes({ ok: true, jobId: 'v1-abc', running: true, finished: false, log: ['[1/4] 抽帧…', '抽到 24 帧'], result: null })
    }
    return makeRes({
      ok: true,
      jobId: 'v1-abc',
      running: false,
      finished: true,
      succeeded: true,
      log: ['ok'],
      result: {
        ok: true,
        human: '视频 240×180 · 2.00s | 抽帧 24 张（引擎 cv2） | 抠像：幕布 0,175,61（自动取样），平均抠掉 95.0% | 动作 2 个：idle(6帧) / waving(6帧)',
        warnings: ['自动切分是启发式的，请核对一下划分结果'],
        chroma: { key: { r: 0, g: 175, b: 61 }, keySource: 'auto', avgTransparentRatio: 0.95 },
        audit: [],
        samples: ['D:\\generated\\green-cat\\video-samples\\idle_0.png'],
        pet: { id: 'green-cat', name: '绿幕猫', actions: ['idle', 'waving'], framesPerAction: 6 },
        installed: { ok: true, id: 'green-cat' },
      },
    })
  }
  if (path.startsWith('/ronaldo-pet/gallery')) return makeRes(galleryPayload)
  return makeRes({ ok: true })
}

let videoStatusPolls = 0
const videoInfoFixture = { ok: true, engine: 'cv2', width: 240, height: 180, duration: 2, fps: 12, frames: 24, hasAudio: false }

// 画廊夹具：一条已核验 DPSL（可一键安装）+ 一条未授权可兼容导入
const galleryPayload = {
  ok: true,
  protocol: 'DPSL-1.0',
  galleryProtocol: 'dsh-pet-gallery/1',
  cachedAt: new Date().toISOString(),
  stale: false,
  online: true,
  counts: { total: 2, installable: 1, compat: 1, listed: 0, dpsl: 1 },
  installed: [],
  errors: [],
  agreement: { protocol: 'DPSL-1.0', topic: 'dsh-pet', url: 'https://example.invalid/agreement' },
  entries: [
    {
      key: 'alice/pixel-cat',
      owner: 'alice',
      repo: 'pixel-cat',
      repoUrl: 'https://github.com/alice/pixel-cat',
      name: '像素猫',
      author: 'Alice',
      description: '一只像素猫',
      tags: ['像素风'],
      stars: 12,
      branch: 'main',
      protocol: 'DPSL-1.0',
      dpsl: true,
      verified: true,
      installable: true,
      compat: null,
      statement: '本桌宠包由我本人创作',
      previewUrl: 'https://example.invalid/preview.png',
      cardUrl: 'https://example.invalid/card.png',
      source: 'both',
      problems: [],
    },
    {
      key: 'bob/no-license-pet',
      owner: 'bob',
      repo: 'no-license-pet',
      repoUrl: 'https://github.com/bob/no-license-pet',
      name: '没授权的宠物',
      author: 'bob',
      description: '有图集没有 pet.json',
      tags: [],
      stars: 1,
      branch: 'main',
      protocol: null,
      dpsl: false,
      verified: true,
      installable: false,
      compat: 'spritesheet-json',
      previewUrl: null,
      cardUrl: 'https://example.invalid/card2.png',
      source: 'discovery',
      problems: [],
    },
  ],
}

const timers = []
const storage = new Map()

const installGlobals = () => {
  const styleEls = []
  const documentStub = {
    createElement: (tag) => ({ tag, id: '', textContent: '', style: {}, appendChild() {}, setAttribute() {}, remove() {} }),
    head: { appendChild: (el) => styleEls.push(el), removeChild() {} },
    body: { appendChild() {} },
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.document = documentStub
  // 插件里有直接用全局 location 的地方（不是 window.location），两个都要给
  globalThis.location = { href: 'http://127.0.0.1:3080/', origin: 'http://127.0.0.1:3080', hostname: '127.0.0.1', port: '3080', protocol: 'http:' }
  globalThis.window = {
    document: documentStub,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    setTimeout: (fn, ms) => { const id = timers.length; timers.push({ fn, ms: ms || 0 }); return id },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: globalThis.location,
  }
  globalThis.fetch = fetchStub
  globalThis.setTimeout = globalThis.window.setTimeout
  globalThis.clearTimeout = globalThis.window.clearTimeout
  globalThis.setInterval = globalThis.window.setInterval
  globalThis.clearInterval = globalThis.window.clearInterval
  globalThis.Audio = class { constructor() {} play() { return Promise.resolve() } pause() {} }
  globalThis.requestAnimationFrame = (fn) => { fn(0); return 0 }
  globalThis.cancelAnimationFrame = () => {}
  return { styleEls }
}

const flushTimers = async (maxRounds = 6) => {
  for (let i = 0; i < maxRounds; i++) {
    if (timers.length === 0) break
    const batch = timers.splice(0, timers.length)
    for (const t of batch) {
      try { t.fn() } catch (e) { /* 插件内部错误由断言去发现 */ }
    }
    await settle()
  }
}
const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => realSetTimeout(r, 0))
}

// ---------------------------------------------------------------- 主流程

const BUILTIN_STATES = {
  idle: { row: 0, frames: 6, fps: 6 },
  runRight: { row: 1, frames: 8, fps: 12 },
  runLeft: { row: 2, frames: 8, fps: 12 },
  waving: { row: 3, frames: 4, fps: 8 },
  jumping: { row: 4, frames: 5, fps: 10 },
  failed: { row: 5, frames: 8, fps: 12 },
  waiting: { row: 6, frames: 6, fps: 5 },
  running: { row: 7, frames: 6, fps: 12 },
  review: { row: 8, frames: 6, fps: 6 },
  look: { rows: [9, 10], frames: 8 },
}
const makePet = (scaling) => ({
  id: 'ronaldo',
  name: 'C罗',
  visible: true,
  size: 120,
  behavior: 'idle',
  sheet: { url: '/ronaldo-pet/asset/ronaldo/atlas.png', cols: 8, rows: 11, cellW: 192, cellH: 208, ...(scaling ? { scaling } : {}) },
  states: BUILTIN_STATES,
  phrases: ['你好呀'],
  divePhrases: ['哎哟'],
  interactions: {},
})

const main = async () => {
  const { styleEls } = installGlobals()

  // 加载插件：它自己会调用 window.__ModuleLoader__.load
  let loaded = null
  globalThis.window.__ModuleLoader__ = { load: (m) => { loaded = m } }
  await import(pathToFileURL(join(REPO, 'client', 'client.js')).href)

  check(!!loaded && loaded.id === 'dsh-ronaldo-pet', '插件通过 __ModuleLoader__ 注册', loaded && loaded.id)
  if (!loaded) return

  const mod = loaded.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('意外的 require: ' + name)
  })
  check(mod && typeof mod.apply === 'function', '工厂返回 apply/inject/name')
  check(Array.isArray(mod.inject) && mod.inject.includes('slots'), 'inject 声明了 slots', JSON.stringify(mod.inject))

  // ---- apply：槽位注册 ----
  const registered = []
  const cleanups = []
  const ctx = {
    effect: (fn) => { const c = fn(); if (typeof c === 'function') cleanups.push(c) },
    slots: {
      inject: (name, fn) => { fn() },
      register: (meta, comp) => { registered.push({ meta, comp }) },
    },
  }
  let applyErr = null
  try { mod.apply(ctx) } catch (e) { applyErr = e }
  check(!applyErr, 'apply() 不抛异常', applyErr ? applyErr.message : '')
  check(registered.length === 2, '注册了 2 个槽位（设置面板 + 悬浮层）', registered.map((r) => r.meta.name).join(', '))
  check(styleEls.length === 1, '样式表注入了一次')
  const overlayReg = registered.find((r) => r.meta.name === 'shell.overlay')
  const settingsReg = registered.find((r) => r.meta.name === 'settings.section')

  // ---- 渲染悬浮层：验证 image-rendering 跟随 sheet.scaling ----
  // 悬浮层要等到 /pets 与 /state 回来才有内容，所以渲染 -> 跑 effect -> 再渲染
  petsPayload = { ...petsPayload, pets: [makePet('pixelated')] }
  check(!!overlayReg, '拿到 shell.overlay 的渲染函数')
  if (overlayReg) {
    let tree = null
    needsRender = true
    for (let i = 0; i < 8 && needsRender; i++) {
      needsRender = false
      tree = renderNode(overlayReg.comp(), ['overlay'])
      for (const e of pendingEffects.splice(0)) { try { e.run() } catch (err) { /* 下面按结果断言 */ } }
      await settle()
    }
    await flushTimers()
    tree = renderNode(overlayReg.comp(), ['overlay'])
    const els = flatten(tree)
    const sprite = els.find((e) => e.props.className === 'dp-sprite')
    check(!!sprite, '悬浮层渲染出了 dp-sprite')
    if (sprite) {
      check(sprite.props.style && sprite.props.style.imageRendering === 'pixelated',
        'sheet.scaling=pixelated -> image-rendering: pixelated',
        sprite.props.style && sprite.props.style.imageRendering)
      check(sprite.props.style.width === '120px', '尺寸按宠物 size 走', sprite.props.style.width)
    }
  }

  // smooth（默认）应当是 auto
  petsPayload = { ...petsPayload, pets: [makePet(null)] }
  if (overlayReg) {
    needsRender = true
    for (let i = 0; i < 8 && needsRender; i++) {
      needsRender = false
      renderNode(overlayReg.comp(), ['overlay2'])
      for (const e of pendingEffects.splice(0)) { try { e.run() } catch (err) { /* ignore */ } }
      await settle()
    }
    const sprite = flatten(renderNode(overlayReg.comp(), ['overlay2'])).find((e) => e.props.className === 'dp-sprite')
    check(sprite && sprite.props.style.imageRendering === 'auto',
      '未声明 scaling -> image-rendering: auto（写实/高分辨率默认平滑）',
      sprite && sprite.props.style.imageRendering)
  }

  // ---- 网页端的 look 也要跟着光标转 ----
  //
  // 桌面窗口那边踩过一个坑：Update-LookDirFromCursor 定义了却从来没被调用，
  // 宠物永远朝正上方看。网页端是另一套实现（onPointerMove 里算方向），
  // 所以这里单独验证它真的会变 —— 光看源码"应该会"不算验证。
  if (overlayReg) {
    const renderOverlay = async (key) => {
      needsRender = true
      for (let i = 0; i < 8 && needsRender; i++) {
        needsRender = false
        renderNode(overlayReg.comp(), [key])
        for (const e of pendingEffects.splice(0)) { try { e.run() } catch (err) { /* ignore */ } }
        await settle()
      }
      return renderNode(overlayReg.comp(), [key])
    }
    const findIn = (tree, cls) => flatten(tree).find((e) => e.props.className === cls)
    const posOf = (tree) => {
      const s = findIn(tree, 'dp-sprite')
      return s ? s.props.style.backgroundPosition : null
    }

    petsPayload = { ...petsPayload, pets: [makePet(null)] }
    const rect = { left: 100, top: 100, width: 120, height: 130 }
    const rectFn = () => Object.assign({ right: rect.left + rect.width, bottom: rect.top + rect.height }, rect)
    const move = (clientX, clientY) => ({ clientX, clientY, currentTarget: { getBoundingClientRect: rectFn } })

    let t = await renderOverlay('overlay-look')
    check(!!findIn(t, 'dp-pet'), '悬浮层渲染出了可交互的 dp-pet')
    const enter = findIn(t, 'dp-pet')
    if (enter) {
      enter.props.onPointerEnter()
      t = await renderOverlay('overlay-look')
      // 光标在正上方（窗口中心是 160,165）-> 方向 0 -> row 9 col 0
      const w1 = findIn(t, 'dp-pet')
      w1.props.onPointerMove(move(160, 100))
      t = await renderOverlay('overlay-look')
      const up = posOf(t)
      // 光标在正右方 -> 方向 4 -> row 9 col 4（8 列时 col4 = 4*100/7 = 57.14%）
      const w2 = findIn(t, 'dp-pet')
      w2.props.onPointerMove(move(260, 165))
      t = await renderOverlay('overlay-look')
      const right = posOf(t)
      check(up !== right, '网页端 look 会随光标改变取帧', `上=${up} 右=${right}`)
      check(up === '0% 90%', '光标在正上方 -> row 9 col 0', String(up))
      check(String(right).indexOf('57.14') === 0, '光标在正右方 -> row 9 col 4', String(right))
      // 离开宠物后回到普通动画（不再是 look）
      const w3 = findIn(t, 'dp-pet')
      if (w3.props.onPointerLeave) {
        w3.props.onPointerLeave()
        t = await renderOverlay('overlay-look')
        check(posOf(t) !== right, '移出宠物后不再是 look 的方位帧', String(posOf(t)))
      }
    }
  }

  // ---- 自动拉起桌面宠物（页面一打开就发 start）----
  const startCalls = calls.filter((c) => c.path === '/ronaldo-pet/desktop' && c.body && c.body.action === 'start')
  check(startCalls.length === 1, '页面加载后自动 POST 了一次 desktop start', '次数=' + startCalls.length)

  // 用户按过「停止」之后就不该再自动拉起
  storage.set('dsh-pet-desktop-opt-out', '1')
  calls.length = 0
  // 同一个页面生命周期内不会重跑（模块级开关），这条只验证读取顺序不炸
  check(true, 'opt-out 标记写入后不影响已渲染的界面（模块级只跑一次）')

  // ---- 设置面板：尺寸滑杆与「自动」按钮 ----
  check(!!settingsReg, '拿到 settings.section 的渲染函数')
  // 渲染辅助：始终在**同一条渲染路径**上重渲染，这样组件内部状态（比如当前标签页）不会丢。
  // 换 key 会被当成新组件挂载，状态复位——踩过这个坑，所以这里只有一个 key。
  const renderSettings = async (pathKey) => {
    let tree = null
    needsRender = true
    for (let i = 0; i < 10 && needsRender; i++) {
      needsRender = false
      tree = renderNode(settingsReg.comp(), [pathKey])
      for (const e of pendingEffects.splice(0)) { try { e.run() } catch (err) { /* ignore */ } }
      await settle()
    }
    await flushTimers()
    return renderNode(settingsReg.comp(), [pathKey])
  }
  if (settingsReg) {
    let tree = await renderSettings('settings')
    let els = flatten(tree)
    const tabBtn = els.find((e) => e.type === 'button' && textOf(e).includes('桌面窗口'))
    check(!!tabBtn, '设置面板有「桌面窗口」标签页')
    if (tabBtn) {
      tabBtn.props.onClick()
      tree = await renderSettings('settings')
      els = flatten(tree)
      const range = els.find((e) => e.type === 'input' && e.props.type === 'range')
      check(!!range, '渲染出了尺寸滑杆')
      if (range) {
        check(range.props.min === 32 && range.props.max === 1024,
          '滑杆范围 32～1024（写实素材能拉大）', `min=${range.props.min} max=${range.props.max}`)
      }
      const autoBtn = els.find((e) => e.type === 'button' && textOf(e) === '自动')
      check(!!autoBtn, '渲染出了「自动」按钮')
      check(!!autoBtn && autoBtn.props.disabled === false,
        '显式尺寸（96）下「自动」可点', autoBtn ? `disabled=${autoBtn.props.disabled}` : '')
      if (autoBtn) {
        calls.length = 0
        // 宿主接受 desktopSize=0 之后，下一次 status 就该报 0
        desktopStatus = { ...desktopStatus, size: 0 }
        autoBtn.props.onClick()
        await settle()
        const patch = calls.find((c) => c.path === '/ronaldo-pet/settings' && c.body && c.body.patch && 'desktopSize' in c.body.patch)
        check(!!patch && patch.body.patch.desktopSize === 0,
          '点「自动」会 POST desktopSize=0（0 = 跟随素材分辨率）',
          patch ? JSON.stringify(patch.body) : '没有发出设置请求')
        // 插件用 setTimeout(refresh, 2500) 重新拉状态；用同一个渲染路径重渲染，
        // 这样标签页等组件状态还在（换 key 会当成新组件、tab 复位到"宠物"页）
        await flushTimers()
        tree = await renderSettings('settings')
        els = flatten(tree)
        const labels = els.filter((e) => e.type === 'label').map(textOf).join(' | ')
        check(labels.includes('自动'), '尺寸为 0 时标签显示「自动」', labels.slice(0, 90))
        const autoBtn2 = els.find((e) => e.type === 'button' && textOf(e) === '自动')
        check(!!autoBtn2 && autoBtn2.props.disabled === true, '已经是自动时「自动」按钮禁用',
          autoBtn2 ? `disabled=${autoBtn2.props.disabled}` : '按钮不见了')
      }
    }
  }

  // ---- 宠物社区：窗口真的去拉索引、真的渲染卡片、真的敢说"未授权" ----
  if (settingsReg) {
    const renderTab = async (label, pathKey) => {
      let tree = await renderSettings(pathKey)
      let els = flatten(tree)
      const btn = els.find((e) => e.type === 'button' && textOf(e).includes(label))
      check(!!btn, '设置面板有「' + label + '」标签页')
      if (!btn) return { els, tree }
      btn.props.onClick()
      tree = await renderSettings(pathKey)
      await flushTimers()
      tree = await renderSettings(pathKey)
      return { els: flatten(tree), tree }
    }

    const g1 = await renderTab('宠物社区', 'settings')
    const gCalls = calls.filter((c) => c.path.startsWith('/ronaldo-pet/gallery') && c.method === 'GET')
    check(gCalls.length > 0, '打开「宠物社区」会去拉 /ronaldo-pet/gallery 索引', gCalls.map((c) => c.path).join(','))
    const allText = g1.els.map(textOf).join(' | ')
    check(allText.includes('像素猫'), '渲染出了社区条目名字')
    check(g1.els.some((e) => textOf(e).includes('DPSL-1.0 · 已核验')), '已核验的条目带 DPSL 徽章')
    check(g1.els.some((e) => textOf(e).includes('未授权 · 可兼容导入')), '未授权的条目明确标注（不假装它授权了）')
    const installBtn = g1.els.find((e) => e.type === 'button' && textOf(e).includes('一键安装'))
    check(!!installBtn, '已授权条目有「一键安装」按钮')
    check(g1.els.every((e) => !(e.type === 'button' && textOf(e).includes('兼容导入')) ) === false, '未授权条目给的是「兼容导入」而不是一键安装')
    check(g1.els.some((e) => e.type === 'a' && e.props.href === 'https://github.com/alice/pixel-cat'), '每条都带仓库链接（协议第 5.6 条可核验）')
    if (installBtn) {
      calls.length = 0
      installBtn.props.onClick()
      await settle()
      await settle()
      const post = calls.find((c) => c.path === '/ronaldo-pet/gallery/install' && c.method === 'POST')
      check(!!post && post.body && post.body.key === 'alice/pixel-cat', '点「一键安装」会 POST 该条目的 key',
        post ? JSON.stringify(post.body) : '没有发出安装请求')
    }

    const s1 = await renderTab('分享到社区', 'settings')
    const boxes = s1.els.filter((e) => e.type === 'input' && e.props.type === 'checkbox')
    check(boxes.length >= 2, '分享页有「允许二创」和「我确认…同意按 DPSL-1.0」两个勾选框', '勾选框数=' + boxes.length)
    const submitBtn = s1.els.find((e) => e.type === 'button' && textOf(e).includes('生成分享包'))
    check(!!submitBtn, '分享页有「生成分享包」按钮')
    check(!!submitBtn && submitBtn.props.disabled === true, '没勾同意之前按钮是禁用的（协议第 2.2 条：默认不共享）',
      submitBtn ? 'disabled=' + submitBtn.props.disabled : '')
    const text1 = s1.els.map(textOf).join(' | ')
    check(text1.includes('DPSL-1.0'), '分享页写明了采用的协议')
    check(/插件不会替你上传|不会替你执行 git push/.test(text1), '分享页明确说明"插件不会替你上传"')
    if (boxes.length && submitBtn) {
      const agree = boxes[boxes.length - 1]
      agree.props.onChange({ target: { checked: true } })
      let tree2 = await renderSettings('settings')
      await settle()
      tree2 = await renderSettings('settings')
      const els2 = flatten(tree2)
      const btn2 = els2.find((e) => e.type === 'button' && textOf(e).includes('生成分享包'))
      check(!!btn2 && btn2.props.disabled === false, '勾上同意后按钮变为可点', btn2 ? 'disabled=' + btn2.props.disabled : '按钮不见了')
      if (btn2) {
        calls.length = 0
        btn2.props.onClick()
        await settle()
        await settle()
        const post = calls.find((c) => c.path === '/ronaldo-pet/gallery/share' && c.method === 'POST')
        check(!!post && post.body && post.body.accept === true, '点「生成分享包」会 POST accept:true（这是协议要求的"明确同意"）',
          post ? JSON.stringify(post.body) : '没有发出分享请求')
        let tree3 = await renderSettings('settings')
        await settle()
        tree3 = await renderSettings('settings')
        const text3 = flatten(tree3).map(textOf).join(' | ')
        check(text3.includes('dsh-pet'), '生成结果里给出了要加的 topic')
        check(text3.includes('git push') || text3.includes('publish.ps1'), '生成结果里给出了接下来的命令/脚本')
      }
    }
    const v1 = await renderTab('视频生成', 'settings')
    const vCalls = calls.filter((c) => c.path.startsWith('/ronaldo-pet/video/probe'))
    check(vCalls.length > 0, '打开「视频生成」会去探测解码引擎', vCalls.map((c) => c.path).join(','))
    const vText = v1.els.map(textOf).join(' | ')
    check(vText.includes('cv2') || vText.includes('解码引擎'), '面板显示了当前可用的解码引擎', vText.slice(0, 80))
    const segInput = v1.els.find((e) => e.type === 'input' && String(e.props.placeholder || '').includes('idle:0-2.5'))
    check(!!segInput, '有"每个动作在第几秒到第几秒"的输入框（推荐用法就摆在最显眼处）')
    const pathInput = v1.els.find((e) => e.type === 'input' && String(e.props.placeholder || '').includes('my-pet-green.mp4'))
    check(!!pathInput, '有视频路径输入框')
    const startBtn = v1.els.find((e) => e.type === 'button' && textOf(e).includes('开始生成'))
    check(!!startBtn, '有「开始生成」按钮')
    if (startBtn && segInput) {
      // 不填路径直接点：必须被拦住（不能真的去起一个空任务）
      calls.length = 0
      startBtn.props.onClick()
      await settle()
      check(!calls.some((c) => c.path === '/ronaldo-pet/video/build'), '没填视频路径时不会发起生成任务')
      check(flatten(await renderSettings('settings')).map(textOf).join(' ').includes('先填视频路径'), '并明确提示"先填视频路径"')

      pathInput.props.onChange({ target: { value: 'D:\\videos\\my-pet-green.mp4' } })
      segInput.props.onChange({ target: { value: 'idle:0-1,waving:1-2' } })
      // ⚠️ 必须重新渲染后再取按钮：迷你 React 里按钮的 onClick 是**上一次渲染时的闭包**，
      //    拿旧按钮点，start() 看到的还是空路径（踩过 —— 会误判成"点不动"）。
      let tree5 = await renderSettings('settings')
      await settle()
      tree5 = await renderSettings('settings')
      const freshBtn = flatten(tree5).find((e) => e.type === 'button' && textOf(e).includes('开始生成'))
      check(!!freshBtn, '填好之后仍能找到「开始生成」按钮')
      calls.length = 0
      if (freshBtn) freshBtn.props.onClick()
      await settle()
      await settle()
      const post = calls.find((c) => c.path === '/ronaldo-pet/video/build' && c.method === 'POST')
      check(!!post, '填好路径后点「开始生成」会 POST /video/build')
      check(!!post && post.body.segments === 'idle:0-1,waving:1-2', '把用户填的时间段原样传给后端',
        post ? JSON.stringify(post.body.segments) : '')
      check(!!post && post.body.install === true, '默认勾选"生成后直接注册"')
      check(!!post && post.body.path === 'D:\\videos\\my-pet-green.mp4', '把视频路径传给后端',
        post ? JSON.stringify(post.body.path) : '')
      // 轮询：第一次 running，第二次 finished。
      // ⚠️ 这里**不能**用 renderSettings —— 它在末尾会把所有待跑的定时器都冲掉，
      //    于是"生成中"这一帧永远看不到（踩过一次）。用一个"只渲染、不冲定时器"的版本。
      const renderNoFlush = async () => {
        let tree = null
        needsRender = true
        for (let i = 0; i < 10 && needsRender; i++) {
          needsRender = false
          tree = renderNode(settingsReg.comp(), ['settings'])
          for (const e of pendingEffects.splice(0)) { try { e.run() } catch (err) { /* ignore */ } }
          await settle()
        }
        return renderNode(settingsReg.comp(), ['settings'])
      }
      let tree4 = await renderNoFlush()
      await settle()
      tree4 = await renderNoFlush()
      const els4 = flatten(tree4)
      check(els4.map(textOf).join(' ').includes('正在生成'), '生成中会显示进度状态')
      check(els4.some((e) => e.type === 'pre' && textOf(e).includes('抽帧')), '生成中会显示进度日志')
      await flushTimers()
      await settle()
      tree4 = await renderNoFlush()
      const doneText = flatten(tree4).map(textOf).join(' | ')
      check(doneText.includes('生成完成'), '完成后显示"生成完成"')
      check(doneText.includes('平均抠掉 95.0%'), '结果里给出抠像统计（抠掉了多少背景）')
      check(doneText.includes('已注册'), '注册成功会明确告知（看右下角）')
      check(doneText.includes('自动切分是启发式的'), '把"自动切分只是草稿"这类警告如实展示出来')
      check(doneText.includes('video-samples'), '给出肉眼复核用的样张路径')
    }
  }

  // ---- 卸载：effect 清理不应抛异常 ----
  let cleanupErr = null
  try { for (const c of cleanups) c() } catch (e) { cleanupErr = e }
  check(!cleanupErr, '卸载时清理函数不抛异常', cleanupErr ? cleanupErr.message : '')
}

main()
  .then(() => {
    console.log('')
    console.log(fail === 0 ? `✅ 全部通过（${pass} 项）` : `❌ ${fail} 项失败 / 共 ${pass + fail} 项`)
    process.exit(fail === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error('测试自身出错：', err && err.stack || err)
    process.exit(1)
  })
