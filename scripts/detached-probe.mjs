#!/usr/bin/env node
// =============================================================================
// 定位最后一个变量：宿主用了 spawn(..., { detached: true, cwd: __dirname })
// 而直连探针没传这两个。逐个加上去看谁把 powershell 弄死。
//
//   node scripts/detached-probe.mjs
// =============================================================================

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')
const SCRIPT = join(REPO, 'desktop', 'DesktopPet.ps1')

const tmp = await mkdtemp(join(tmpdir(), 'detached-probe-'))

const cases = [
  { name: '裸 spawn（已知可用）', opts: { stdio: ['ignore', 'ignore', 'pipe'] } },
  { name: '+ cwd=仓库（中文路径）', opts: { stdio: ['ignore', 'ignore', 'pipe'], cwd: REPO } },
  { name: '+ detached:true', opts: { stdio: ['ignore', 'ignore', 'pipe'], detached: true } },
  { name: '+ detached + cwd（宿主原样）', opts: { stdio: ['ignore', 'ignore', 'pipe'], detached: true, cwd: REPO } },
  { name: '+ detached + windowsHide', opts: { stdio: ['ignore', 'ignore', 'pipe'], detached: true, windowsHide: true } },
  { name: 'stdio:ignore + detached', opts: { stdio: 'ignore', detached: true, cwd: REPO } },
]

console.log('  组合'.padEnd(34) + '结果')
console.log('  ' + '-'.repeat(72))

for (const c of cases) {
  const log = join(tmp, 'log-' + Math.random().toString(36).slice(2, 8) + '.txt')
  const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', SCRIPT, '-Base', 'http://127.0.0.1:3080', '-Log', log]

  let proc
  try {
    proc = spawn('powershell.exe', args, c.opts)
  } catch (e) {
    console.log('  ' + c.name.padEnd(32) + '❌ spawn 抛异常：' + e.message)
    continue
  }
  let stderr = ''
  if (proc.stderr) proc.stderr.on('data', (b) => { stderr += String(b) })
  const t0 = Date.now()
  const res = await new Promise((res2) => {
    let done = false
    proc.on('exit', (code, signal) => { if (!done) { done = true; res2({ kind: 'exit', code, signal, ms: Date.now() - t0 }) } })
    proc.on('error', (e) => { if (!done) { done = true; res2({ kind: 'error', msg: e.message, ms: Date.now() - t0 }) } })
    setTimeout(() => {
      if (!done) { done = true; res2({ kind: 'alive', ms: Date.now() - t0 }) }
    }, 6000)
  })
  if (c.opts.detached) { try { proc.unref() } catch { /* ignore */ } }

  const wrote = existsSync(log)
  let desc
  if (res.kind === 'alive') desc = `✅ 存活 >6s，写日志=${wrote}`
  else if (res.kind === 'error') desc = `❌ spawn 错误：${res.msg}`
  else desc = `❌ ${res.ms}ms 退出 code=${res.code}，写日志=${wrote}${stderr.trim() ? ' stderr=' + stderr.trim().slice(0, 160) : ''}`
  console.log('  ' + c.name.padEnd(32) + desc)

  if (res.kind === 'alive') { try { proc.kill() } catch { /* ignore */ } }
  await new Promise((r) => setTimeout(r, 500))
}

await rm(tmp, { recursive: true, force: true })
