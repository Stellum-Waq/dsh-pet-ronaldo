#!/usr/bin/env node
// =============================================================================
// 桌面宠物"到底画对了吗"验证器
// -----------------------------------------------------------------------------
// 结论先行：**不要**用整屏截图或 PrintWindow 判断。
//   · CopyFromScreen（BitBlt）根本看不到分层窗口（AllowsTransparency 的 WPF 窗口）
//   · PrintWindow 会把这层窗口拍平、和背后的东西混在一起，背景也不干净
//   · 200% DPI 下 DPI-unaware 的探针进程还会把窗口尺寸报成一半
// 这三样加起来，会让"其实画得好好的"变成"看起来缺了一半"，反之亦然。
//
// 可靠做法：让**桌宠自己**用 RenderTargetBitmap 渲染当前精灵并出图
// （DesktopPet.ps1 的 Invoke-SelfCapture），然后把这张图和图集里的对应格
// 逐像素比对。没有中间商，颜色差就是事实。
//
//   node scripts/verify-desktop.mjs [--base http://127.0.0.1:3080] [--keep]
// =============================================================================

import { mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')
const { decodeImage, crop, resize, alphaBounds } = await import(
  pathToFileURL(join(REPO, 'skill', 'dsh-pet-forge', 'scripts', 'lib', 'imaging.mjs')).href)

function argAfter(list, flag, def) {
  const i = list.indexOf(flag)
  return i >= 0 && list[i + 1] ? list[i + 1] : def
}
const args = process.argv.slice(2)
const BASE = argAfter(args, '--base', 'http://127.0.0.1:3080')
const KEEP = args.includes('--keep')
const OUT = resolve(argAfter(args, '--out', join(REPO, '.forge-test', 'desktop-frame.png')))

const post = (path, body) => fetch(BASE + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
}).then((r) => r.json())

const fail = (msg, extra = {}) => {
  console.log(JSON.stringify({ ok: false, error: msg, ...extra }, null, 2))
  process.exit(1)
}

async function main() {
  // ---- 1. 宿主与桌宠状态 ----
  let status
  try {
    status = await post('/ronaldo-pet/desktop', { action: 'status' })
  } catch (err) {
    fail('连不上桌宠插件（' + BASE + '）', { hint: '确认 dsh web 在跑，且装了 dsh-ronaldo-pet' })
  }
  if (!status || status.ok !== true) fail('宿主 /desktop 返回异常', { status })

  const logPath = status.log
  if (!logPath) fail('宿主没有给出桌宠日志路径，无法定位自检输出目录')
  const logDir = dirname(logPath)
  const trigger = join(logDir, 'desktop-pet-capture.txt')
  const framePath = join(logDir, 'desktop-pet-frame.png')

  if (status.running !== true) {
    fail('桌面宠物没在运行（running=false）', {
      method: status.method, attempts: status.attempts,
      lastError: status.lastError, lastExit: status.lastExit,
      spawnLog: status.spawnLog,
      hint: '看 spawnLog 里每次尝试的命令行与退出码；控制台里可用 action:"start" 拉起来',
    })
  }

  // ---- 2. 让桌宠自己渲染一帧 ----
  await mkdir(logDir, { recursive: true })
  try { await rm(framePath, { force: true }) } catch { /* 无所谓 */ }
  await writeFile(trigger, 'capture\n', 'ascii')

  let got = false
  const t0 = Date.now()
  while (Date.now() - t0 < 12000) {
    await new Promise((r) => setTimeout(r, 600))
    if (existsSync(framePath)) { got = true; break }
  }
  if (!got) {
    fail('桌宠没有在 12 秒内产出自检帧', {
      trigger, expected: framePath,
      hint: '确认桌宠版本支持自检抓帧（DesktopPet.ps1 里的 Invoke-SelfCapture），或看 desktop-pet.log',
    })
  }
  // 等一下确保写盘完成
  await new Promise((r) => setTimeout(r, 400))
  await mkdir(dirname(OUT), { recursive: true })
  await copyFile(framePath, OUT)

  const frame = await decodeImage(await readFile(framePath))
  const frameBounds = alphaBounds(frame, 8)

  // ---- 3. 取当前宠物的图集，找最匹配的一格 ----
  let pets = []
  try {
    const r = await fetch(BASE + '/ronaldo-pet/pets', { signal: AbortSignal.timeout(6000) }).then((x) => x.json())
    pets = r.pets || []
  } catch { /* 下面会报 */ }
  const pet = pets.find((p) => p.id === (status.displayMode && pets.length ? p.id : p.id)) || pets[0]
  if (!pet) fail('拿不到宠物清单，无法比对')

  const atlasUrl = BASE + (pet.sheet.desktopUrl || pet.sheet.url)
  const atlas = await decodeImage(Buffer.from(await fetch(atlasUrl).then((r) => r.arrayBuffer())))
  const CW = pet.sheet.cellW, CH = pet.sheet.cellH, cols = pet.sheet.cols, rows = pet.sheet.rows

  const candidates = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if ((c + 1) * CW > atlas.width || (r + 1) * CH > atlas.height) continue
      const ref = resize(crop(atlas, c * CW, r * CH, CW, CH), frame.width, frame.height)
      let d = 0
      for (let i = 0; i < ref.data.length; i += 4) {
        d += Math.abs(ref.data[i] - frame.data[i]) + Math.abs(ref.data[i + 1] - frame.data[i + 1]) +
          Math.abs(ref.data[i + 2] - frame.data[i + 2]) + Math.abs(ref.data[i + 3] - frame.data[i + 3])
      }
      const rb = alphaBounds(ref, 8)
      candidates.push({
        row: r, col: c,
        diff: Number((d / (ref.data.length / 4) / 4).toFixed(2)),
        refContentPct: rb ? Number((rb.width / ref.width * 100).toFixed(0)) : 0,
      })
    }
  }
  candidates.sort((a, b) => a.diff - b.diff)
  const best = candidates[0]

  const frameContentPct = frameBounds ? Number((frameBounds.width / frame.width * 100).toFixed(0)) : 0
  const sizeOk = Math.abs(frameContentPct - best.refContentPct) <= 6
  const ok = best.diff < 12 && sizeOk

  const out = {
    ok,
    base: BASE,
    desktop: {
      running: status.running, pid: status.pid, method: status.method,
      sizeDip: status.size, displayMode: status.displayMode,
    },
    pet: { id: pet.id, name: pet.name, atlas: { cols, rows, cellW: CW, cellH: CH } },
    capturedFrame: {
      path: OUT,
      size: { width: frame.width, height: frame.height },
      contentPct: frameContentPct,
      contentBounds: frameBounds,
    },
    bestMatch: best,
    topMatches: candidates.slice(0, 5),
    human: ok
      ? `✅ 桌宠画的是图集第 ${best.row} 行第 ${best.col} 列，色差 ${best.diff}（<12 视为一致），` +
        `角色占幅 ${frameContentPct}%（该格应为 ${best.refContentPct}%）—— 整格被完整、正确地渲染出来`
      : sizeOk
        ? `⚠️ 能匹配到第 ${best.row} 行第 ${best.col} 列，但色差 ${best.diff} 偏大 —— 可能有缩放插值或颜色偏差`
        : `❌ 帧内角色占幅 ${frameContentPct}%，而最匹配的那格应为 ${best.refContentPct}% —— 精灵很可能被裁切或缩放错了`,
  }
  if (!KEEP) { try { await rm(trigger, { force: true }) } catch { /* ignore */ } }

  console.log(JSON.stringify(out, null, 2))
  process.exit(ok ? 0 : 1)
}

main().catch((err) => fail(String(err && err.message || err)))
