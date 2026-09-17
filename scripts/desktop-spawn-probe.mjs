#!/usr/bin/env node
// =============================================================================
// 对照实验：为什么"真脚本 + 真路径"起不来，而"临时 ASCII 探针脚本"能起来？
//
// 假设 H1：中文路径（D:\代码\桌宠\...）经 Node spawn 传给 powershell 时坏掉
// 假设 H2：DesktopPet.ps1 自己在很早的地方就退出了
//
// 做法：把 desktop/ 整个复制到一个**纯 ASCII 路径**，分别用两种路径各起一次，
// 看日志文件有没有被写出来、进程活了多久。
//
//   node scripts/desktop-spawn-probe.mjs
// =============================================================================

import { spawn } from 'node:child_process'
import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')
const REAL_DESKTOP = join(REPO, 'desktop')

const tmp = await mkdtemp(join(tmpdir(), 'pet-ascii-'))
const asciiDesktop = join(tmp, 'desktop')
await cp(REAL_DESKTOP, asciiDesktop, { recursive: true })

async function tryLaunch(label, scriptPath, logPath) {
  console.log('\n=== ' + label + ' ===')
  console.log('  脚本: ' + scriptPath)
  console.log('  日志: ' + logPath)

  const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', scriptPath, '-Base', 'http://127.0.0.1:3080', '-Log', logPath]

  const proc = spawn('powershell.exe', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  proc.stderr.on('data', (b) => { stderr += String(b) })
  const t0 = Date.now()
  const res = await new Promise((resolveP) => {
    let done = false
    proc.on('exit', (code, signal) => { if (!done) { done = true; resolveP({ kind: 'exit', code, signal, ms: Date.now() - t0 }) } })
    proc.on('error', (e) => { if (!done) { done = true; resolveP({ kind: 'error', msg: e.message, ms: Date.now() - t0 }) } })
    setTimeout(() => {
      if (!done) {
        done = true
        try { proc.kill() } catch { /* ignore */ }
        resolveP({ kind: 'alive', ms: Date.now() - t0 })
      }
    }, 6000)
  })

  if (res.kind === 'alive') console.log('  ✅ 存活超过 6 秒（脚本能跑）')
  else if (res.kind === 'error') console.log('  ❌ spawn 失败：' + res.msg)
  else console.log(`  ❌ ${res.ms}ms 就退出  code=${res.code} signal=${res.signal}`)
  if (stderr.trim()) console.log('  stderr: ' + stderr.trim().slice(0, 400))

  if (existsSync(logPath)) {
    const text = await readFile(logPath, 'utf8')
    console.log('  📄 日志（' + text.split(/\r?\n/).filter(Boolean).length + ' 行）：')
    for (const line of text.split(/\r?\n/).filter(Boolean).slice(0, 12)) console.log('     ' + line)
  } else {
    console.log('  📄 日志文件不存在 → 脚本在写第一行日志之前就结束了')
  }
}

// A：真实（中文）路径
await tryLaunch('A. 中文路径（仓库里的原脚本）', join(REAL_DESKTOP, 'DesktopPet.ps1'), join(tmp, 'log-zh.txt'))

// B：纯 ASCII 路径（同样的脚本内容）
await tryLaunch('B. ASCII 路径（同一份脚本复制过去）', join(asciiDesktop, 'DesktopPet.ps1'), join(tmp, 'log-ascii.txt'))

console.log('\n临时目录：' + tmp)
