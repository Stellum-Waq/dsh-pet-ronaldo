#!/usr/bin/env node
// =============================================================================
// 启动参数探针：找出"Node spawn powershell.exe 后它 200ms 就 exit 0"的真凶。
//
// 背景：桌面宠物在 dsh web 里被拉起后立刻退出、连日志都没有。后来发现
// 用 child_process.spawn 时**在 dsh web 之外也能复现**，所以问题不在沙箱，
// 而在参数/调用方式本身。这个脚本把每种组合都跑一遍，看谁活下来。
//
//   node scripts/spawn-probe.mjs
// =============================================================================

import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = await mkdtemp(join(tmpdir(), 'spawn-probe-'))
const marker = join(tmp, 'alive.txt')
const script = join(tmp, 'probe.ps1')

// 纯 ASCII 探针脚本：启动后立刻写文件，再睡 8 秒
await writeFile(script, [
  '$ErrorActionPreference = "Continue"',
  'try { Add-Type -AssemblyName PresentationFramework } catch { }',
  `Set-Content -LiteralPath '${marker.replace(/'/g, "''")}' -Value ("alive pid=" + $PID) -Encoding ASCII`,
  'Start-Sleep -Seconds 8',
].join('\r\n'), 'ascii')

const cases = [
  { name: '最小：-Command', args: ['-NoProfile', '-Command', 'Start-Sleep -Seconds 8'], script: false },
  { name: '-File 裸', args: ['-NoProfile', '-File', script] },
  { name: '-File +STA', args: ['-NoProfile', '-STA', '-File', script] },
  { name: '-File +NonInteractive', args: ['-NoProfile', '-NonInteractive', '-File', script] },
  { name: '-File +WindowStyle Hidden', args: ['-NoProfile', '-WindowStyle', 'Hidden', '-File', script] },
  { name: '-File +ExecutionPolicy Bypass', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] },
  { name: '完整组合（宿主用的）', args: ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script] },
  { name: '完整组合 -WindowStyle 换 -NoLogo', args: ['-NoLogo', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script] },
]

console.log('探针脚本：' + script)
console.log('')
console.log('  组合'.padEnd(38) + '结果')
console.log('  ' + '-'.repeat(70))

for (const c of cases) {
  await rm(marker, { force: true })
  const args = c.args
  const proc = spawn('powershell.exe', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  proc.stderr.on('data', (b) => { if (stderr.length < 500) stderr += String(b) })
  const t0 = Date.now()
  const result = await new Promise((resolve) => {
    let settled = false
    proc.on('exit', (code, signal) => { if (!settled) { settled = true; resolve({ kind: 'exit', code, signal, ms: Date.now() - t0 }) } })
    proc.on('error', (err) => { if (!settled) { settled = true; resolve({ kind: 'error', err: err.message, ms: Date.now() - t0 }) } })
    setTimeout(() => {
      if (!settled) {
        settled = true
        try { proc.kill() } catch { /* ignore */ }
        resolve({ kind: 'alive', ms: Date.now() - t0 })
      }
    }, 2500)
  })
  await new Promise((r) => setTimeout(r, 300))
  const wrote = existsSync(marker)
  const desc = result.kind === 'alive'
    ? `✅ 存活（2.5s 内没退），脚本执行=${wrote}`
    : result.kind === 'error'
      ? `❌ spawn 失败：${result.err}`
      : `❌ ${result.ms}ms 就退出 code=${result.code}${stderr ? ' stderr=' + stderr.trim().slice(0, 120) : ''}，脚本执行=${wrote}`
  console.log('  ' + c.name.padEnd(36) + desc)
}

await rm(tmp, { recursive: true, force: true })
