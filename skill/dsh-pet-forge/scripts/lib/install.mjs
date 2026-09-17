// =============================================================================
// dsh-pet-forge · 与运行中的 DSH 桌宠插件通信
// -----------------------------------------------------------------------------
// 插件（dsh-ronaldo-pet）在宿主进程里开了一组 HTTP 路由，本模块负责把生成好的
// 宠物包注册进去、查询列表、卸载、试玩音效。
// 走 HTTP 而不是改配置文件的原因：注册后**立刻生效**，无需重启 dsh web。
// =============================================================================

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 候选基地址：环境变量优先，否则常见本地端口。 */
export function candidateBases(explicit) {
  const norm = (u) => String(u).replace(/\/+$/, '')
  // ⚠️ 显式给的地址就是"就是它"，**不再回退**到别的端口。
  // 回退过一次的后果：把"到底注册到哪个 DSH 实例"变成了不确定的 ——
  // 实测出现过一个进程按 --base http://127.0.0.1:0 启动、失败后自动改投 3080，
  // 于是把测试宠物注册进了用户真正在用的 DSH 里（脏数据要手工清）。
  if (explicit) return [norm(explicit)]
  const out = []
  if (process.env.DSH_WEB_URL) out.push(process.env.DSH_WEB_URL)
  if (process.env.DSH_PET_BASE) out.push(process.env.DSH_PET_BASE)
  out.push('http://127.0.0.1:3080')
  out.push('http://127.0.0.1:3000')
  return Array.from(new Set(out.map(norm)))
}

/**
 * 找到正在运行的桌宠插件。
 * 判定标准：GET <base>/ronaldo-pet/state 返回带 mode 字段的 JSON。
 */
export async function findLivePlugin(explicitBase) {
  const tried = []
  for (const base of candidateBases(explicitBase)) {
    try {
      const res = await fetch(`${base}/ronaldo-pet/state`, { signal: AbortSignal.timeout(2500) })
      if (!res.ok) { tried.push({ base, status: res.status }); continue }
      const data = await res.json()
      if (data && typeof data.mode === 'string') return { ok: true, base, state: data }
      tried.push({ base, status: 'unexpected-body' })
    } catch (err) {
      tried.push({ base, error: String(err && err.message || err) })
    }
  }
  return {
    ok: false,
    error: explicitBase
      ? `指定的桌宠插件地址没有响应：${explicitBase}（显式指定时不会再去试别的端口）`
      : '没有找到运行中的桌宠插件（DSH Web 未启动，或插件未加载）',
    tried,
    hint: explicitBase
      ? '确认这个地址上跑的就是目标 DSH 实例；不指定 --base 时会自动探测 127.0.0.1:3080 / 3000。'
      : '请确认 `dsh web` 正在运行且已安装 dsh-ronaldo-pet 插件；也可用 --base 指定地址。',
  }
}

async function rpc(base, path, body, timeout = 60000) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { ok: false, error: `响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 300)}` }
  }
}

/**
 * 注册一个宠物包目录。
 *
 * 默认注册后会**接管为"默认打开的宠物"**，其它宠物自动收起——这样生成完
 * 立刻就能在右下角看到它，而不会越攒越多。想只注册不上场就传 focus:false。
 * @param {object} [opts] { base, name, focus }
 */
export async function registerPet(packageDir, opts = {}) {
  const live = await findLivePlugin(opts.base)
  if (!live.ok) return live
  const body = { dir: packageDir, rename: opts.name }
  if (opts.focus === false) body.focus = false
  const result = await rpc(live.base, '/ronaldo-pet/pets/register', body)
  return { ...result, base: live.base }
}

/** 把某只设为"默认打开的宠物"（其它自动收起）。 */
export async function setDefaultPet(id, opts = {}) {
  const live = await findLivePlugin(opts.base)
  if (!live.ok) return live
  const result = await rpc(live.base, '/ronaldo-pet/pets/update', { id, patch: { makeDefault: true } })
  return { ...result, base: live.base }
}

/** 卸载（只从注册表移除，不删文件）。 */
export async function unregisterPet(id, opts = {}) {
  const live = await findLivePlugin(opts.base)
  if (!live.ok) return live
  const result = await rpc(live.base, '/ronaldo-pet/pets/unregister', { id })
  return { ...result, base: live.base }
}

/** 列出已注册宠物。 */
export async function listPets(opts = {}) {
  const live = await findLivePlugin(opts.base)
  if (!live.ok) return live
  const res = await fetch(`${live.base}/ronaldo-pet/pets`, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
  const data = await res.json()
  return { ...data, base: live.base }
}

/** 让宿主进程试播某个音效（用于验证"声音到底出没出来"）。 */
export async function playAudio(petId, key, opts = {}) {
  const live = await findLivePlugin(opts.base)
  if (!live.ok) return live
  const result = await rpc(live.base, '/ronaldo-pet/play', { id: petId, key })
  return { ...result, base: live.base }
}

/** 读本地宠物包里的 pet.json（注册前先自检用）。 */
export async function readLocalManifest(packageDir) {
  const file = join(packageDir, 'pet.json')
  if (!existsSync(file)) return { ok: false, error: `宠物包缺少 pet.json：${file}` }
  try {
    return { ok: true, manifest: JSON.parse(await readFile(file, 'utf8')) }
  } catch (err) {
    return { ok: false, error: `pet.json 解析失败：${err.message}` }
  }
}

// ---------------------------------------------------------------------------
// 宠物社区（画廊）：契约见 docs/GALLERY-CONTRACT.md
// ---------------------------------------------------------------------------

/** 画廊缓存路径（插件不在线时直接读它，至少能列出上次抓到的条目）。 */
export function galleryCachePath() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  return join(home, 'storages', 'dsh-pet-forge', 'gallery-cache.json')
}

/**
 * 列出社区宠物。
 * @param {object} [opts] { base, refresh, q }
 */
export async function galleryList(opts = {}) {
  const live = await findLivePlugin(opts.base)
  if (!live.ok) {
    // 插件没跑：退回读缓存，别让 agent 直接扑空
    try {
      const cache = JSON.parse(await readFile(galleryCachePath(), 'utf8'))
      return {
        ok: true,
        hostOffline: true,
        fromCache: true,
        cachedAt: cache.fetchedAt || null,
        entries: Array.isArray(cache.entries) ? cache.entries : [],
        hint: '插件未运行，展示的是上次缓存。启动 `dsh web` 后可 get /ronaldo-pet/gallery 拿实时结果。',
      }
    } catch {
      return { ...live, hostOffline: true }
    }
  }
  const url = `${live.base}/ronaldo-pet/gallery${opts.refresh ? '?refresh=1' : ''}`
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
  const data = await res.json()
  return { ...data, base: live.base }
}

/** 从社区安装一只宠物（走插件 Host，它负责下载/解包/校验/注册）。 */
export async function galleryInstall(target, opts = {}) {
  const live = await findLivePlugin(opts.base)
  if (!live.ok) return live
  const body = {}
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(target)) || /^https?:\/\//.test(String(target))) body.key = String(target)
  else body.dir = String(target)
  if (opts.dir) { body.dir = opts.dir; delete body.key }
  if (opts.adapter) body.adapter = opts.adapter
  if (opts.name) body.rename = opts.name
  if (opts.focus === false) body.focus = false
  const result = await rpc(live.base, '/ronaldo-pet/gallery/install', body, 180000)
  return { ...result, base: live.base }
}

/** 生成分享包（DPSL-1.0）。没有 accept:true 时插件侧不会写任何文件。 */
export async function galleryShare(opts = {}) {
  const live = await findLivePlugin(opts.base)
  if (!live.ok) return live
  const body = {
    accept: opts.accept === true,
    dir: opts.dir,
    id: opts.id,
    author: opts.author,
    repo: opts.repo,
    tags: opts.tags,
    preview: opts.preview,
    rights: opts.rights,
    statement: opts.statement,
    contact: opts.contact,
    description: opts.description,
    allowRemix: opts.allowRemix,
    allowCommercial: opts.allowCommercial,
  }
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k]
  const result = await rpc(live.base, '/ronaldo-pet/gallery/share', body)
  return { ...result, base: live.base }
}
