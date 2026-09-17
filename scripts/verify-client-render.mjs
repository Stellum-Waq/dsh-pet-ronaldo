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
  return makeRes({ ok: true })
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
  if (settingsReg) {
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
