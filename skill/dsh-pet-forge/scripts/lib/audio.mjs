// =============================================================================
// dsh-pet-forge · 音频生成器
// -----------------------------------------------------------------------------
// 两条路：
//   A. 程序化合成（零依赖、离线可用）：纯 Node 生成 16bit PCM WAV。
//      用于庆祝音效、报错音、点击音等——比"随便找个 mp3"更可控、无版权问题。
//   B. 语音合成 TTS（Windows SAPI）：把一句台词变成 wav，用于"对话完成播报"。
//      ⚠️ 中文/路径一律通过 **UTF-8 文件** 传给 PowerShell，绝不走命令行字符串，
//      否则必然乱码——这是本项目"sounds 变噪音 / 文件名变问号"的根因。
// =============================================================================

import { mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { existsSync, writeFileSync, readFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

// mkdirSync 的薄封装：失败也不抛（临时目录通常已存在）
function mkdirSyncSafe(dir) {
  try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
}

export const DEFAULT_SAMPLE_RATE = 22050

// ---------- WAV 容器 ----------

/** Float32 [-1,1] → 16bit PCM 单声道 WAV Buffer。 */
export function encodeWav(samples, sampleRate = DEFAULT_SAMPLE_RATE, channels = 1) {
  const frames = Math.floor(samples.length / channels)
  const dataSize = frames * channels * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0, 'latin1')
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8, 'latin1')
  buf.write('fmt ', 12, 'latin1')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)                       // PCM
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * channels * 2, 28)
  buf.writeUInt16LE(channels * 2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'latin1')
  buf.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < frames * channels; i++) {
    let v = samples[i]
    v = v < -1 ? -1 : v > 1 ? 1 : v
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
  }
  return buf
}

/** 写入 wav 文件。 */
export async function writeWav(samples, path, sampleRate = DEFAULT_SAMPLE_RATE) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, encodeWav(samples, sampleRate))
  return path
}

// ---------- 合成基元 ----------

const SR = DEFAULT_SAMPLE_RATE

/** 生成一段静音。 */
export function silence(seconds) {
  return new Float32Array(Math.max(1, Math.round(seconds * SR)))
}

/**
 * 单音。
 * @param {object} o { freq, dur, wave:'sine'|'square'|'saw'|'triangle'|'noise',
 *                     attack, release, gain, freqEnd, vibrato, vibratoHz }
 */
export function tone(o) {
  const dur = o.dur ?? 0.2
  const n = Math.max(1, Math.round(dur * SR))
  const out = new Float32Array(n)
  const a = Math.max(1, Math.round((o.attack ?? 0.01) * SR))
  const r = Math.max(1, Math.round((o.release ?? dur * 0.4) * SR))
  const gain = o.gain ?? 0.35
  const f0 = o.freq ?? 440
  const f1 = o.freqEnd ?? f0
  const wave = o.wave || 'sine'
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / n
    const freq = f0 + (f1 - f0) * t + (o.vibrato ? Math.sin((i / SR) * Math.PI * 2 * (o.vibratoHz ?? 6)) * o.vibrato : 0)
    phase += (Math.PI * 2 * freq) / SR
    let s
    switch (wave) {
      case 'square': s = Math.sin(phase) >= 0 ? 1 : -1; break
      case 'saw': s = ((phase / (Math.PI * 2)) % 1) * 2 - 1; break
      case 'triangle': {
        const p = (phase / (Math.PI * 2)) % 1
        s = p < 0.5 ? p * 4 - 1 : 3 - p * 4
        break
      }
      case 'noise': s = Math.random() * 2 - 1; break
      default: s = Math.sin(phase)
    }
    // 包络：attack 升起、release 落下（首尾都做，避免爆音）
    let env = 1
    if (i < a) env = i / a
    const tail = n - i
    if (tail < r) env = Math.min(env, tail / r)
    out[i] = s * env * gain
  }
  return out
}

/** 顺序拼接。 */
export function concat(...parts) {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Float32Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

/** 叠加混音（各轨从 t 秒处开始）。 */
export function mix(tracks) {
  let total = 0
  for (const t of tracks) total = Math.max(total, Math.round((t.at ?? 0) * SR) + t.buf.length)
  const out = new Float32Array(total)
  for (const t of tracks) {
    const off = Math.round((t.at ?? 0) * SR)
    const g = t.gain ?? 1
    for (let i = 0; i < t.buf.length; i++) out[off + i] += t.buf[i] * g
  }
  // 软限幅，防止叠加后削顶
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i])
  return out
}

/** 简易混响（梳状延迟），让短音效不那么"干"。 */
export function reverb(buf, { decay = 0.28, delays = [0.031, 0.057, 0.089] } = {}) {
  const out = Float32Array.from(buf)
  for (const d of delays) {
    const off = Math.round(d * SR)
    let g = decay
    for (let i = off; i < out.length; i++) {
      out[i] += out[i - off] * g
    }
    g *= decay
  }
  let peak = 0
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]))
  if (peak > 0.98) for (let i = 0; i < out.length; i++) out[i] = (out[i] / peak) * 0.98
  return out
}

// ---------- 音效预设 ----------

const NOTE = {
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0, B5: 987.77,
  C6: 1046.5, D6: 1174.66, E6: 1318.51, G6: 1567.98, C3: 130.81, E3: 164.81, G3: 196.0,
}

export const SFX_PRESETS = {
  celebrate: {
    label: '完成庆祝（上行琶音 + 亮铃）',
    hint: '对话/任务完成时播放，听起来"赢了"',
    build: () => reverb(concat(
      tone({ freq: NOTE.C5, dur: 0.11, wave: 'triangle', gain: 0.42, release: 0.06 }),
      tone({ freq: NOTE.E5, dur: 0.11, wave: 'triangle', gain: 0.42, release: 0.06 }),
      tone({ freq: NOTE.G5, dur: 0.11, wave: 'triangle', gain: 0.42, release: 0.06 }),
      tone({ freq: NOTE.C6, dur: 0.34, wave: 'triangle', gain: 0.5, release: 0.3 }),
      mix([
        { buf: tone({ freq: NOTE.C6, dur: 0.4, wave: 'sine', gain: 0.18, release: 0.36 }) },
        { buf: tone({ freq: NOTE.E6, dur: 0.4, wave: 'sine', gain: 0.12, release: 0.36 }) },
      ]),
    ), { decay: 0.3 }),
  },
  failed: {
    label: '出错（下行下滑音）',
    hint: 'Agent 报错时播放，沮丧但不刺耳',
    build: () => concat(
      tone({ freq: 420, freqEnd: 300, dur: 0.16, wave: 'saw', gain: 0.24, release: 0.1 }),
      silence(0.03),
      tone({ freq: 300, freqEnd: 150, dur: 0.36, wave: 'saw', gain: 0.26, release: 0.28 }),
    ),
  },
  click: {
    label: '点击（短促气泡音）',
    hint: '每次点宠物时的小反馈',
    build: () => tone({ freq: 880, freqEnd: 1320, dur: 0.075, wave: 'sine', gain: 0.3, release: 0.06 }),
  },
  dive: {
    label: '连点（俏皮的"哎哟"）',
    hint: '快速连点宠物时触发',
    build: () => concat(
      tone({ freq: 700, freqEnd: 1050, dur: 0.09, wave: 'triangle', gain: 0.32, release: 0.05 }),
      tone({ freq: 1050, freqEnd: 520, dur: 0.16, wave: 'triangle', gain: 0.3, release: 0.12 }),
    ),
  },
  working: {
    label: '开始工作（上扬提示）',
    hint: 'Agent 开始执行工具时',
    build: () => concat(
      tone({ freq: NOTE.G4, dur: 0.08, wave: 'sine', gain: 0.22, release: 0.05 }),
      tone({ freq: NOTE.C5, dur: 0.14, wave: 'sine', gain: 0.24, release: 0.1 }),
    ),
  },
  waiting: {
    label: '等待你回复（轻叩两下）',
    hint: '需要审批/输入时提醒，但不吵',
    build: () => concat(
      tone({ freq: 660, dur: 0.07, wave: 'sine', gain: 0.2, release: 0.05 }),
      silence(0.09),
      tone({ freq: 660, dur: 0.07, wave: 'sine', gain: 0.2, release: 0.05 }),
    ),
  },
  boot: {
    label: '宠物登场（开机音）',
    hint: '宠物第一次加载时',
    build: () => reverb(concat(
      tone({ freq: NOTE.C4, dur: 0.1, wave: 'triangle', gain: 0.3, release: 0.06 }),
      tone({ freq: NOTE.G4, dur: 0.1, wave: 'triangle', gain: 0.3, release: 0.06 }),
      tone({ freq: NOTE.C5, dur: 0.26, wave: 'triangle', gain: 0.36, release: 0.22 }),
    ), { decay: 0.24 }),
  },
}

/** 生成一个音效，返回 Float32Array。 */
export function synthSfx(name) {
  const preset = SFX_PRESETS[name]
  if (!preset) throw new Error(`未知音效：${name}（可选：${Object.keys(SFX_PRESETS).join(', ')}）`)
  return preset.build()
}

/** 生成音效并写文件，返回路径。 */
export async function writeSfx(name, path) {
  return writeWav(synthSfx(name), path)
}

// ---------- TTS（Windows SAPI） ----------

export function ttsAvailable() {
  return process.platform === 'win32'
}

/** 列出已安装语音。
 *  ⚠️ 沙箱下"捕获子进程 stdout"会被拒绝（管道受限），所以让 PowerShell 把结果
 *  **写进文件**、stdio 设为 ignore，再由 Node 读文件。这是本项目通用的绕坑姿势。 */
export function listVoices() {
  if (!ttsAvailable()) return []
  const dir = join(tmpdir(), `petforge-voices-${process.pid}`)
  const outFile = join(dir, 'voices.txt')
  const scriptFile = join(dir, 'voices.ps1')
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$lines = @()',
    'foreach ($v in $s.GetInstalledVoices()) { $lines += ($v.VoiceInfo.Name + "|" + $v.VoiceInfo.Culture.Name) }',
    `Set-Content -LiteralPath '${outFile.replace(/'/g, "''")}' -Value $lines -Encoding UTF8`,
    '$s.Dispose()',
  ].join('\r\n')
  try {
    mkdirSyncSafe(dir)
    writeFileSync(scriptFile, script, 'ascii')
    // ⚠️ 两个坑（实测）：
    //  1. windowsHide:true 会让 powershell.exe 以 0xC0000142(STATUS_DLL_INIT_FAILED) 退出；
    //  2. encoding/管道捕获在本沙箱下直接 EPERM。
    // 因此统一用 stdio:'ignore' 且不加 windowsHide，结果一律走文件传递。
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
      stdio: 'ignore', timeout: 20000,
    })
    if (!existsSync(outFile)) return []
    return readFileSync(outFile, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.replace(/^\uFEFF/, '').trim())
      .filter(Boolean)
      .map((line) => {
        const i = line.lastIndexOf('|')
        return i < 0 ? { name: line, culture: '' } : { name: line.slice(0, i), culture: line.slice(i + 1) }
      })
  } catch {
    return []
  }
}

/**
 * 生成 SAPI 合成脚本（纯 ASCII）。
 * 关键：文本与路径全部通过 **UTF-8 JSON 文件** 传递，PS 脚本本身不含中文，
 *       从根上避免中文经命令行/管道变成乱码。
 * 沙箱坑：不能捕获子进程 stdout（EPERM），也不能传 windowsHide（0xC0000142），
 *         所以结果一律写进 result JSON 文件。
 */
function sapiScript(jobPath, resultPath) {
  const q = (p) => p.replace(/'/g, "''")
  return [
    '$ErrorActionPreference = "Stop"',
    '$res = [ordered]@{ ok = $false; voice = ""; error = "" }',
    'try {',
    '  Add-Type -AssemblyName System.Speech',
    `  $job = Get-Content -LiteralPath '${q(jobPath)}' -Raw -Encoding UTF8 | ConvertFrom-Json`,
    '  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '  if ($job.voice -and $job.voice.Length -gt 0) { try { $s.SelectVoice($job.voice) } catch { } }',
    '  $s.Rate = [int]$job.rate',
    '  $s.Volume = [int]$job.volume',
    '  $s.SetOutputToWaveFile($job.out)',
    '  $s.Speak($job.text)',
    '  $s.SetOutputToNull()',
    '  try { $res.voice = $s.Voice.VoiceInfo.Name } catch { }',
    '  $s.Dispose()',
    '  $res.ok = $true',
    '} catch {',
    '  $res.ok = $false',
    '  $res.error = $_.Exception.Message',
    '}',
    `$res | ConvertTo-Json -Compress | Set-Content -LiteralPath '${q(resultPath)}' -Encoding UTF8`,
  ].join('\r\n')
}

function spawnSapi(scriptPath, timeoutMs) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    stdio: 'ignore', timeout: timeoutMs,
  })
}

function readSapiResult(resultPath, spawnResult) {
  if (!existsSync(resultPath)) {
    const hint = spawnResult.status === 3221225794
      ? 'PowerShell 进程初始化失败（0xC0000142）；请确认 spawn 时没有传 windowsHide'
      : spawnResult.status === null ? '可能是沙箱禁止了子进程，或执行被中断' : `退出码 ${spawnResult.status}`
    return { ok: false, error: `PowerShell 未产出结果文件：${hint}` }
  }
  try {
    // PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 BOM，必须剥掉再解析
    return JSON.parse(readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (err) {
    return { ok: false, error: `结果文件解析失败：${err.message}` }
  }
}

/**
 * 用系统 TTS 把一句话合成成 wav。
 * @returns {Promise<{ok:boolean, path?:string, error?:string, voice?:string}>}
 */
export async function ttsToWav(text, outPath, opts = {}) {
  if (!ttsAvailable()) return { ok: false, error: 'TTS 仅在 Windows（SAPI）上可用' }
  const dir = join(tmpdir(), `petforge-tts-${Date.now()}-${process.pid}`)
  await mkdir(dir, { recursive: true })
  const jobPath = join(dir, 'job.json')
  const scriptPath = join(dir, 'say.ps1')
  const resultPath = join(dir, 'result.json')

  await writeFile(jobPath, JSON.stringify({
    text: String(text),
    out: String(outPath),
    voice: opts.voice || '',
    rate: opts.rate ?? 0,
    volume: opts.volume ?? 100,
  }), 'utf8')
  await writeFile(scriptPath, sapiScript(jobPath, resultPath), 'ascii')

  try {
    const spawnResult = spawnSapi(scriptPath, 60000)
    if (spawnResult.error) return { ok: false, error: `无法启动 PowerShell：${spawnResult.error.message}` }
    const result = readSapiResult(resultPath, spawnResult)
    if (!result.ok) return { ok: false, error: String(result.error || 'SAPI 合成失败') }
    if (!existsSync(outPath)) return { ok: false, error: 'TTS 未产生输出文件' }
    const st = await stat(outPath)
    if (st.size < 1024) return { ok: false, error: `TTS 输出过小（${st.size} 字节），可能未合成成功` }
    return { ok: true, path: outPath, voice: result.voice || undefined, bytes: st.size }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  } finally {
    try { await rm(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/** 同步版（只给探针用，避免 plan/doctor 变成异步）。 */
export function ttsToWavSync(text, outPath, opts = {}) {
  if (!ttsAvailable()) return { ok: false, error: 'TTS 仅在 Windows（SAPI）上可用' }
  const dir = join(tmpdir(), `petforge-tts-probe-${process.pid}`)
  const jobPath = join(dir, 'job.json')
  const scriptPath = join(dir, 'say.ps1')
  const resultPath = join(dir, 'result.json')
  try {
    mkdirSyncSafe(dir)
    writeFileSync(jobPath, JSON.stringify({
      text: String(text), out: String(outPath), voice: opts.voice || '', rate: 0, volume: 100,
    }), 'utf8')
    writeFileSync(scriptPath, sapiScript(jobPath, resultPath), 'ascii')
    const spawnResult = spawnSapi(scriptPath, 30000)
    if (spawnResult.error) return { ok: false, error: `无法启动 PowerShell：${spawnResult.error.message}` }
    const result = readSapiResult(resultPath, spawnResult)
    if (!result.ok) return { ok: false, error: String(result.error || 'SAPI 合成失败') }
    if (!existsSync(outPath)) return { ok: false, error: 'TTS 未产生输出文件' }
    const size = statSyncSafe(outPath)
    if (size < 512) return { ok: false, error: `TTS 输出过小（${size} 字节）` }
    return { ok: true, path: outPath, voice: result.voice || undefined, bytes: size }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

function statSyncSafe(p) {
  try { return statSync(p).size } catch { return 0 }
}

let ttsProbeCache = null

/**
 * **真实**探测 TTS 是否可用。
 *
 * 为什么不能只看 `GetInstalledVoices()`：本机实测就出现过
 * "语音枚举得到 Microsoft Huihui / Zira，但 SelectVoice/Speak 一律报
 *  'No voice installed on the system or none available with the current security setting'"。
 * 也就是说注册表里有语音、引擎却选不出来。只有真跑一次合成才知道能不能用。
 *
 * @returns {{ok:boolean, available:boolean, voices:Array, reason:string, hint:string, probe?:object}}
 */
export function probeTts() {
  if (ttsProbeCache) return ttsProbeCache
  if (!ttsAvailable()) {
    ttsProbeCache = {
      ok: false, available: false, voices: [], reason: '当前系统不是 Windows，SAPI 不可用',
      hint: 'macOS 可用 `say -o out.aiff` + `afconvert`，Linux 可用 `espeak-ng`；也可用 file:<key>:<路径> 提供现成音频',
    }
    return ttsProbeCache
  }
  const voices = listVoices()
  const probePath = join(tmpdir(), `petforge-tts-probe-${process.pid}.wav`)
  const r = ttsToWavSync('ok', probePath)
  try { rmSync(probePath, { force: true }) } catch { /* ignore */ }
  ttsProbeCache = {
    ok: r.ok === true,
    available: r.ok === true,
    voices,
    reason: r.ok ? '' : String(r.error || '未知原因'),
    hint: r.ok
      ? ''
      : (/none available with the current security setting|未安装语音/i.test(String(r.error || ''))
          ? '系统注册表里有语音条目，但语音引擎在当前用户/会话下无法加载。可尝试：设置 → 时间和语言 → 语音 → 管理语音，重新安装中文语音包；' +
            '或改用音效（sfx:）代替语音，或用自己的音频（file:<key>:<绝对路径>）。'
          : 'TTS 合成失败，可改用音效或自带音频。'),
    probe: r,
  }
  return ttsProbeCache
}

/** 智能选语音：中文文本优先中文语音。 */
export function pickVoice(text, voices) {
  if (!voices || voices.length === 0) return ''
  const wantsChinese = /[\u4e00-\u9fff]/.test(text)
  if (wantsChinese) {
    const zh = voices.find((v) => v.culture && v.culture.toLowerCase().startsWith('zh'))
    if (zh) return zh.name
  }
  const en = voices.find((v) => v.culture && v.culture.toLowerCase().startsWith('en'))
  return (en || voices[0]).name
}

/** 需要联网吗？不需要——TTS 与合成全在本机。 */
export const AUDIO_CATALOG = Object.entries(SFX_PRESETS).map(([key, v]) => ({
  key, label: v.label, hint: v.hint,
}))
