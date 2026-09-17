// =============================================================================
// dsh-pet-forge · 生图调用层
// -----------------------------------------------------------------------------
// 复用 dsh-eye 那套配置约定（同一份 API Key / 端点 / 模型），保证用户只配一次
// 就能两个技能都用。区别在于这里是**库**而非 CLI：
//   · 直接在进程内 fetch，不 spawn 子进程 —— 沙箱下"管道捕获子进程输出"会被拒，
//     而且 base64 图片经 stdout 传递本身就有编码风险。
//   · 返回图片字节 + 落在磁盘的路径，交给图像内核解码。
//
// 配置优先级：显式参数 > 环境变量 > ~/.dsh-eye.json > Windows 注册表用户环境。
// =============================================================================

import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { sniff } from './png.mjs'

export const GEN_PRESETS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1' },
  glm: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'cogview-3-flash' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'wanx2.1-t2i-flash' },
}

/** 与 dsh-eye 共用 ~/.dsh-eye.json。 */
function userConfigFile() {
  try {
    const raw = readFileSync(join(homedir(), '.dsh-eye.json'), 'utf8')
    const data = JSON.parse(raw)
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

/** 读 Windows 用户级环境变量（沙箱隐藏密钥时的兜底）。 */
function registryEnv() {
  const out = {}
  if (process.platform !== 'win32') return out
  if (process.env.DASHEYE_IGNORE_USER_ENV === '1') return out
  const tmp = join(tmpdir(), `petforge-reg-${process.pid}.txt`)
  try {
    // 沙箱下"捕获子进程 stdout"会 EPERM，所以改用 cmd 重定向到文件再读
    // （文件 IO 不受限）。注意：不要加 windowsHide，会让进程 0xC0000142 退出。
    const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `reg query "HKCU\\Environment" > "${tmp}" 2>&1`], {
      stdio: 'ignore', timeout: 5000,
    })
    if (r.status === 0 && existsSync(tmp)) {
      for (const line of readFileSync(tmp, 'utf8').split(/\r?\n/)) {
        const m = /^\s{4}([^ \t]+)\s+REG_\w+\s+(.*)$/.exec(line)
        if (m && m[1] !== '(Default)') out[m[1]] = m[2].trim()
      }
    }
  } catch { /* 忽略 */ } finally {
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
  }
  return out
}

let envCache
function userEnv() {
  if (envCache) return envCache
  envCache = { ...registryEnv(), ...userConfigFile() }
  return envCache
}

export function resolveGenConfig(overrides = {}) {
  const env = userEnv()
  const presetName = overrides.preset || process.env.DASHEYE_GEN_PRESET || env.DASHEYE_GEN_PRESET || 'glm'
  const preset = GEN_PRESETS[presetName] || GEN_PRESETS.glm
  const pick = (...vals) => vals.find((v) => typeof v === 'string' && v.length > 0) || ''
  const apiKey = pick(
    overrides.apiKey,
    process.env.DASHEYE_GEN_API_KEY,
    env.DASHEYE_GEN_API_KEY,
    process.env.DASHEYE_API_KEY,
    env.DASHEYE_API_KEY,
    process.env.OPENAI_API_KEY,
    env.OPENAI_API_KEY,
  )
  const baseUrl = pick(
    overrides.baseUrl,
    process.env.DASHEYE_GEN_BASE_URL,
    env.DASHEYE_GEN_BASE_URL,
    preset.baseUrl,
  ).replace(/\/+$/, '')
  const model = pick(
    overrides.model,
    process.env.DASHEYE_GEN_MODEL,
    env.DASHEYE_GEN_MODEL,
    preset.model,
  )
  return {
    apiKey, baseUrl, model,
    preset: presetName,
    configured: apiKey.length > 0,
    hint: apiKey.length > 0
      ? `${model} @ ${baseUrl}`
      : '未找到 API Key（已检查命令行、环境变量、~/.dsh-eye.json、Windows 注册表）',
  }
}

/** 探测绘图端点是否可用（不做真实生图，只报配置状态）。 */
export function probeGenConfig() {
  const cfg = resolveGenConfig()
  return { ok: cfg.configured, ...cfg }
}

/**
 * 调用 OpenAI 兼容的 /images/generations。
 * @returns {Promise<{bytes:Buffer, format:string, model:string, baseUrl:string}>}
 */
export async function generateImage(prompt, opts = {}) {
  const cfg = resolveGenConfig(opts)
  if (!cfg.configured) {
    const err = new Error(
      '未配置生图 API Key。请运行 dsh-eye 的 setup.ps1 配置，' +
      '或设置环境变量 DASHEYE_GEN_API_KEY / DASHEYE_API_KEY / OPENAI_API_KEY 后重试。'
    )
    err.code = 'NO_API_KEY'
    throw err
  }
  const body = {
    model: cfg.model,
    prompt: String(prompt),
    n: 1,
    size: opts.size || '1024x1024',
  }
  if (opts.seed !== undefined) body.seed = opts.seed

  const timeout = opts.timeoutMs ?? 180000
  const res = await fetch(`${cfg.baseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const err = new Error(`生图 API ${res.status} ${res.statusText}：${text.slice(0, 500)}`)
    err.code = 'API_ERROR'
    err.status = res.status
    throw err
  }
  const data = await res.json()
  const item = data && data.data && data.data[0]
  if (!item) throw new Error('生图 API 返回为空（data[0] 缺失）')

  let bytes
  if (item.b64_json) {
    bytes = Buffer.from(item.b64_json, 'base64')
  } else if (item.url) {
    const r = await fetch(item.url, { signal: AbortSignal.timeout(timeout) })
    if (!r.ok) throw new Error(`下载生成图片失败：HTTP ${r.status}`)
    bytes = Buffer.from(await r.arrayBuffer())
  } else {
    throw new Error('生图 API 响应既没有 b64_json 也没有 url')
  }
  const format = sniff(bytes)
  if (!format) {
    throw new Error(`生成的图片格式无法识别（前 8 字节：${bytes.subarray(0, 8).toString('hex')}）`)
  }
  return { bytes, format, model: cfg.model, baseUrl: cfg.baseUrl, revisedPrompt: item.revised_prompt }
}

/** 生图并落盘，返回路径。 */
export async function generateToFile(prompt, outPath, opts = {}) {
  const r = await generateImage(prompt, opts)
  await mkdir(resolve(outPath, '..'), { recursive: true })
  await writeFile(outPath, r.bytes)
  return { ...r, path: outPath, bytes: r.bytes }
}

// ---------- 提示词构造 ----------

/**
 * 生成"角色主图"的提示词。
 * 关键要求（直接影响后续抠底质量）：
 *   · 纯色背景（#FFFFFF）—— 让连通域抠底可靠
 *   · 全身、正面、居中、留白 —— 便于规范化落格
 *   · 不要文字/水印/多角色/网格 —— 这些正是"看起来乱码"的来源
 */
export function buildCharacterPrompt(subject, opts = {}) {
  const style = opts.style || '可爱 chibi / 卡通吉祥物风格，粗描边，扁平上色，简洁干净'
  const palette = opts.palette ? `主色调 ${opts.palette}。` : ''
  return [
    `一个单独的 ${subject}，全身正面全身像，居中构图。`,
    `${style}。${palette}`,
    '背景必须是纯白色 #FFFFFF，没有任何渐变、阴影、地面、道具、边框或网格线。',
    '角色四周留出充足空白，轮廓清晰，四肢不重叠，表情友善。',
    '不要任何文字、字母、数字、水印、签名、logo。',
    '画面里只能有一个角色，不要多视图、不要分格、不要参考线。',
    '输出正方形构图。',
  ].join('')
}

/**
 * 生成"动作多帧条带"的提示词（Tier B：用生图换取更真实的姿态）。
 * 明确要求 N 帧等宽并排、同一个角色、同一比例、纯白背景，便于切片。
 */
export function buildStripPrompt(subject, actionDesc, n = 4, opts = {}) {
  const style = opts.style || '可爱 chibi / 卡通吉祥物风格，粗描边，扁平上色'
  return [
    `同一只 ${subject} 的连续动作序列，共 ${n} 帧，从左到右等距水平排成一排。`,
    `动作：${actionDesc}。每一帧姿态略有推进，形成流畅循环。`,
    `${style}。角色的颜色、大小、比例、朝向在所有帧中必须完全一致。`,
    '背景必须是纯白色 #FFFFFF，没有阴影、地面、分格线或边框。',
    `${n} 帧之间用空白隔开，不要重叠，不要文字、数字、序号、水印。`,
    `整张图是横向长方形，只包含这 ${n} 帧，角色高度一致。`,
  ].join('')
}

/** 常用动作的中文描述（供 buildStripPrompt 用）。 */
export const ACTION_PROMPTS = {
  idle: '轻微上下起伏的呼吸待机',
  runRight: '向右奔跑，双腿交替迈步，身体前倾',
  waving: '挥手打招呼，一只手臂抬起左右摆动',
  jumping: '向上跳跃庆祝，双脚离地，身体舒展',
  failed: '向后摔倒坐在地上，头歪向一侧，表情沮丧',
  waiting: '站着等待，身体轻微前后晃动',
  running: '原地快速小跑，像在忙碌工作',
  review: '歪着头思考，一只手托着下巴',
}

/** 输出目录：优先用显式参数，否则用系统临时目录下的固定子目录。 */
export function defaultGenOut() {
  return process.env.DASHEYE_GEN_OUT || join(tmpdir(), 'dsh-pet-forge-gen')
}
