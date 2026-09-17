#!/usr/bin/env node
// =============================================================================
// dsh-pet-forge · 主 CLI
// -----------------------------------------------------------------------------
// 所有子命令都输出**单个 JSON 对象**到 stdout，方便 agent 直接解析决策。
// 人类可读的说明放在 JSON 的 human / steps 字段里。
//
//   doctor                          环境自检（Node/sharp/生图配置/Blender/插件/TTS）
//   plan     --brief "..."          生成"该问用户什么"的建议清单（多轮询问用）
//   init     --pkg <dir> --name ..  只建宠物包骨架
//   build    --pkg <dir> --image .. 从本地图片构建（抠底→动画→图集→清单）
//   generate --pkg <dir> --brief .. 调生图模型 + build（一句话出宠物）
//   audio    --pkg <dir> [...]      生成/登记音效与 TTS 台词
//   blender-plan      --pkg <dir>   写 model/spec.json + model/build.py
//   blender-run       --pkg <dir>   无头执行 Blender 渲染
//   blender-assemble  --pkg <dir>   把渲染帧装配成图集并写清单
//   verify   --pkg <dir>            严格校验宠物包
//   inspect  --pkg <dir>            生成目视检查图
//   preview  --pkg <dir>            生成独立预览页
//   install  --pkg <dir>            注册进正在运行的 DSH 桌宠插件
//   uninstall --id <id>             从插件卸载
//   list                            列出已注册宠物
//   play     --id <id> --key <k>    让宿主试播音效
// =============================================================================

import { mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  loadImage, decodeImage, savePng, encodeImage, removeBackground, resize, composite,
  newImg, crop, trim, frameStats, extractPalette, dominantColor, darkestColor, sliceStrip,
} from './lib/imaging.mjs'
import { renderPetRows, composeAtlas, auditAtlas, ACTION_LIBRARY, RECOMMENDED_ACTIONS, ALL_ACTIONS } from './lib/anim.mjs'
import {
  SFX_PRESETS, synthSfx, writeWav, writeSfx, ttsToWav, ttsAvailable, listVoices, pickVoice, AUDIO_CATALOG, probeTts,
} from './lib/audio.mjs'
import {
  makeManifest, buildDefaultStates, writeManifest, readManifest, validatePackage,
  toPetView, slugify, STATE_ROWS, STATE_META, DEFAULT_ATLAS, SCHEMA, SKILL_VERSION,
} from './lib/manifest.mjs'
import {
  probeGenConfig, generateImage, generateToFile, buildCharacterPrompt, buildStripPrompt, ACTION_PROMPTS,
} from './lib/imagegen.mjs'
import {
  buildSpec as buildBlenderSpec, buildScript, runHeadless, findBlender, assembleFromRenders,
  BLENDER_ACTIONS, mcpRecipe,
} from './lib/blender.mjs'
import { writePreview } from './lib/preview.mjs'
import { registerPet, unregisterPet, listPets, playAudio, findLivePlugin, readLocalManifest } from './lib/install.mjs'
import { trySharp } from './lib/imaging.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(__dirname, '..')

// ---------------------------------------------------------------- 参数解析

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else { out[key] = next; i++ }
    } else out._.push(a)
  }
  return out
}

const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])

/** 输出结果并结束当前命令。
 *  用抛异常而不是 process.exit()：process.exit 可能截断还没 flush 的 stdout，
 *  导致 JSON 被切一半——那正是"输出看起来像乱码"的经典成因。 */
class Stop extends Error {}
function emit(obj) {
  process.exitCode = obj && obj.ok === false ? 1 : 0
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n')
  throw new Stop('stop')
}

const now = () => new Date().toISOString()

// ---------------------------------------------------------------- doctor

async function cmdDoctor(args) {
  const sharp = trySharp()
  const gen = probeGenConfig()
  const blender = findBlender()
  const live = await findLivePlugin(args.base)
  const tts = probeTts()
  const node = process.versions.node
  const nodeOk = Number(node.split('.')[0]) >= 18

  const checks = {
    node: { ok: nodeOk, value: node, hint: nodeOk ? '' : '需要 Node 18+' },
    skillRoot: { ok: existsSync(SKILL_ROOT), value: SKILL_ROOT },
    imageCore: { ok: true, value: '内置纯 Node PNG 编解码（零依赖）' },
    sharp: {
      ok: true,
      optional: true,
      value: sharp ? '可用（用于解码 jpg/webp 输入）' : '不可用',
      hint: sharp ? '' : '只会影响 jpg/webp 输入的解码；PNG 输入不受影响，生图默认返回 png/jpg，建议安装 sharp',
    },
    imageGen: { ok: gen.ok, value: gen.ok ? gen.hint : gen.hint, hint: gen.ok ? '' : '配置 dsh-eye 的 setup.ps1 或设置 DASHEYE_GEN_API_KEY' },
    blender: {
      ok: blender !== null,
      value: blender || '未找到',
      hint: blender ? '' : '3D 路线需要 Blender；也可通过 Blender MCP 在已打开的 Blender 里执行',
    },
    plugin: {
      ok: live.ok,
      value: live.ok ? `${live.base}（当前模式 ${live.state.mode}）` : live.error,
      hint: live.ok ? '' : '启动 `dsh web` 并确保已安装 dsh-ronaldo-pet 插件',
    },
    tts: {
      ok: tts.ok,
      value: tts.ok
        ? `可用（${tts.voices.length} 个语音：${tts.voices.map((v) => v.name).join(', ')}）`
        : `不可用（${tts.reason}）`,
      reason: tts.reason,
      hint: tts.hint,
      voices: tts.voices,
    },
  }
  const required = ['node', 'imageCore']
  const okCore = required.every((k) => checks[k].ok)

  emit({
    ok: okCore,
    command: 'doctor',
    at: now(),
    checks,
    human: [
      `Node ${node} · 图像内核 ${checks.imageCore.ok ? '可用' : '异常'}`,
      `生图：${checks.imageGen.ok ? '已配置' : '未配置'}`,
      `Blender：${blender ? '已找到' : '未找到'}`,
      `桌宠插件：${live.ok ? '在线' : '未运行'}`,
      `TTS 语音：${tts.ok ? '可用' : '不可用（可改用音效）'}`,
    ].join(' | '),
    routes: {
      image2d: checks.imageGen.ok ? 'ready' : 'need-api-key',
      image3d: blender ? 'headless-ready' : 'mcp-only-or-install-blender',
      tts: tts.ok ? 'ready' : 'unavailable-use-sfx-instead',
    },
  })
}

// ---------------------------------------------------------------- plan（多轮询问的建议）

function cmdPlan(args) {
  const brief = String(args.brief || '').trim()
  const detail = String(args.detail || 'medium') // simple | medium | rich
  const actionSets = {
    simple: ['idle', 'running', 'review'],
    medium: ['idle', 'running', 'review', 'waiting', 'jumping', 'failed'],
    rich: ALL_ACTIONS.slice(),
  }
  const audioSets = {
    simple: ['celebrate', 'click'],
    medium: ['celebrate', 'failed', 'click'],
    rich: ['celebrate', 'failed', 'click', 'dive', 'working', 'waiting', 'boot'],
  }
  const recommended = { actions: actionSets[detail] || actionSets.medium, audio: audioSets[detail] || audioSets.medium }

  emit({
    ok: true,
    command: 'plan',
    at: now(),
    brief,
    suggestedPetName: brief ? brief.slice(0, 12) : '新宠物',
    suggestedSlug: slugify(brief || 'pet'),
    routes: [
      { id: 'A', name: '2D 单图程序化', cost: '1 次生图', quality: '稳定、离线可复现', when: '只要"一句话出宠物"，最快' },
      { id: 'B', name: '2D 多帧生图', cost: '每个动作 1 次生图', quality: '姿态最自然', when: '对动作真实度有要求' },
      { id: 'C', name: '3D Blender 建模', cost: '1 次生图（取色）+ Blender 渲染', quality: '真 3D 模型 + 环视 + 可导出 GLB', when: '用户明确要 3D' },
    ],
    actionCatalog: ALL_ACTIONS.map((k) => ({
      key: k,
      label: STATE_META[k].label,
      when: STATE_META[k].host,
      frames: STATE_META[k].frames,
      recommended: RECOMMENDED_ACTIONS.includes(k),
      note: ACTION_LIBRARY[k] ? ACTION_LIBRARY[k].hint : '',
    })),
    audioCatalog: AUDIO_CATALOG,
    tts: {
      available: probeTts().ok,
      reason: probeTts().reason,
      hint: probeTts().hint,
      suggestion: probeTts().ok
        ? (brief
            ? `可以为「${brief}」录一句完成台词，例如「${suggestCompletionLine(brief)}」`
            : '可以给宠物配一句完成时的语音')
        : '本机 TTS 语音引擎不可用：建议**不要**选语音，改用音效即可；若一定想要人声，可让用户提供一段 wav/mp3，用 file:<key>:<路径> 引入。',
      fallbackSuggestion: brief ? suggestCompletionLine(brief) : '',
    },
    recommended,
    detail,
    nextQuestions: [
      {
        id: 'style',
        question: '你想要什么画风/气质的宠物？',
        options: ['可爱卡通 chibi（推荐）', '像素风', '水墨/国风', '赛博朋克', '写实萌宠'],
      },
      {
        id: 'route',
        question: '要 2D 还是 3D？',
        options: ['2D 单图程序化（最快，推荐）', '2D 多帧生图（动作最像）', '3D Blender 建模（可环视/导出 GLB）'],
      },
      {
        id: 'actions',
        question: `要哪几套动作？（推荐组合：${recommended.actions.map((k) => STATE_META[k].label).join('、')}）`,
        multi: true,
        options: ALL_ACTIONS.map((k) => `${STATE_META[k].label}${RECOMMENDED_ACTIONS.includes(k) ? '（推荐）' : ''}`),
      },
      {
        id: 'audio',
        question: `要哪些音效？（推荐：${recommended.audio.join('、')}）`,
        multi: true,
        options: AUDIO_CATALOG.map((a) => `${a.label}${recommended.audio.includes(a.key) ? '（推荐）' : ''} — ${a.hint}`),
      },
      {
        id: 'tts',
        question: probeTts().ok
          ? '要不要配一句语音播报（任务完成时朗读）？'
          : '本机 TTS 语音引擎不可用（' + probeTts().reason + '），要不要改用你自己的录音？',
        options: probeTts().ok
          ? ['要，用系统 TTS 合成中文（推荐）', '不要，只用音效']
          : ['不要语音，只用音效（推荐）', '我自己提供一段 wav/mp3'],
        hint: probeTts().hint,
      },
      {
        id: 'size',
        question: '桌宠显示多大？',
        options: ['小 100px', '中 120px（推荐）', '大 160px'],
      },
    ],
  })
}

function suggestCompletionLine(brief) {
  const b = brief.replace(/\s+/g, '')
  if (/猫|喵/.test(b)) return '喵！搞定啦'
  if (/狗|汪|犬/.test(b)) return '汪！任务完成'
  if (/龙/.test(b)) return '吼——完成！'
  if (/机器人|机甲|赛博/.test(b)) return '任务已完成，系统正常'
  return '搞定啦，任务完成！'
}

// ---------------------------------------------------------------- 宠物包骨架

function pkgPaths(pkgDir) {
  return {
    root: pkgDir,
    manifest: join(pkgDir, 'pet.json'),
    atlas: join(pkgDir, 'atlas.png'),
    audioDir: join(pkgDir, 'audio'),
    sourceDir: join(pkgDir, 'source'),
    framesDir: join(pkgDir, 'source', 'frames'),
    modelDir: join(pkgDir, 'model'),
    renderDir: join(pkgDir, 'model', 'renders'),
    preview: join(pkgDir, 'preview.html'),
    report: join(pkgDir, 'forge-report.json'),
  }
}

async function ensurePkg(pkgDir, name) {
  const p = pkgPaths(pkgDir)
  for (const d of [p.root, p.audioDir, p.sourceDir, p.framesDir, p.modelDir]) await mkdir(d, { recursive: true })
  return p
}

// ---------------------------------------------------------------- 核心：从图片构建

/**
 * @param {object} o
 *   pkgDir, imagePath|imageBytes, name, actions, audioSpec, cellW/cellH/cols/rows,
 *   bgMode, bgTolerance, tier, stripImages {action: path}, ttsLines {key: text}
 */
async function buildFromImage(o) {
  const p = await ensurePkg(o.pkgDir, o.name)
  const steps = []
  const warnings = []

  const cw = Number(o.cellW) || DEFAULT_ATLAS.cellW
  const ch = Number(o.cellH) || DEFAULT_ATLAS.cellH
  const cols = Number(o.cols) || DEFAULT_ATLAS.cols
  const rows = Number(o.rows) || DEFAULT_ATLAS.rows
  const actions = o.actions && o.actions.length ? o.actions : RECOMMENDED_ACTIONS

  // 1) 载入主图
  let srcImg
  if (o.imageBytes) srcImg = await decodeImage(o.imageBytes)
  else srcImg = await loadImage(o.imagePath)
  steps.push({ step: 'load-image', width: srcImg.width, height: srcImg.height })

  // 备份主图（PNG，便于复现）
  await savePng(srcImg, join(p.sourceDir, 'base.png'))

  // 2) 抠底
  const { img: cut, report: bgReport } = removeBackground(srcImg, {
    mode: o.bgMode || 'auto',
    tolerance: o.bgTolerance !== undefined ? Number(o.bgTolerance) : 40,
    feather: 1,
    despill: true,
  })
  steps.push({ step: 'remove-background', ...bgReport })
  if (bgReport.mode === 'none' && o.requireCutout) {
    warnings.push('背景未能自动抠除，宠物可能带一块底色；建议改用纯白背景重绘，或指定 --bg-mode global/--bg-key。')
  }
  const cutStats = frameStats(cut)
  if (cutStats.empty) {
    throw new Error('抠底后画面几乎为空——主图可能整体被判为背景色。请调小 --bg-tolerance 或改用 --bg-mode none。')
  }
  await savePng(cut, join(p.sourceDir, 'cutout.png'))

  // 3) 渲染动作（Tier A）：两趟全局缩放，保证不裁切
  const { rowFrames, report: renderReport } = renderPetRows(cut, {
    cellW: cw, cellH: ch, cols,
    actions,
    framesOverride: o.framesOverride || {},
    looseActions: o.looseActions || ['failed'],
  })
  steps.push({ step: 'render-actions', actions: Object.keys(renderReport.actions), notes: renderReport.notes })

  // 4) Tier B：用生图条带覆盖部分动作
  const tierBUsed = []
  if (o.stripImages && Object.keys(o.stripImages).length > 0) {
    for (const [action, imgPath] of Object.entries(o.stripImages)) {
      const row = STATE_ROWS[action]
      if (row === undefined) { warnings.push(`条带动作 ${action} 没有对应行号，已忽略`); continue }
      try {
        const strip = await loadImage(imgPath)
        const { img: stripCut } = removeBackground(strip, { mode: o.bgMode || 'auto', tolerance: Number(o.bgTolerance ?? 40), feather: 1, despill: true })
        const n = Number(o.stripFrames || 4)
        const { frames: tiles, strategy } = sliceStrip(stripCut, n, { gapAware: true })
        // 每片规范化到同样的落位：用与 Tier A 相同的全局 bbox 思路不可行（尺寸不一），
        // 改为按统一高度归一，再水平居中放进格子（保持体型一致）
        const targetH = Math.round(ch * 0.86)
        const normalized = tiles.map((t) => {
          const tr = trim(t, 0)
          const k = targetH / tr.height
          const scaled = resize(tr, Math.max(1, Math.round(tr.width * k)), targetH)
          const cell = newImg(cw, ch)
          const x = Math.round((cw - scaled.width) / 2)
          const y = ch - Math.round(ch * 0.04) - scaled.height
          composite(cell, scaled, Math.max(0, x), Math.max(0, y))
          return cell
        })
        // 若某帧超宽（模型排版不准），退回 Tier A 的结果
        const tooWide = normalized.filter((f) => {
          let minX = cw, maxX = -1
          for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
            if (f.data[(y * cw + x) * 4 + 3] > 24) { if (x < minX) minX = x; if (x > maxX) maxX = x }
          }
          return maxX < 0 || minX <= 1 || maxX >= cw - 2
        })
        if (tooWide.length > normalized.length / 2) {
          warnings.push(`${action} 的生图条带切片后靠边（模型排版不准），已保留程序化版本`)
          continue
        }
        rowFrames[row] = normalized
        tierBUsed.push({ action, frames: normalized.length, strategy })
      } catch (err) {
        warnings.push(`${action} 条带处理失败，已保留程序化版本：${err.message}`)
      }
    }
    steps.push({ step: 'tier-b-strips', used: tierBUsed })
  }

  // 5) 合成图集
  const atlas = composeAtlas({ cols, rows, cellW: cw, cellH: ch, rowFrames })
  warnings.push(...atlas.warnings)
  const atlasBytes = encodeImage(atlas.img)
  await writeFile(p.atlas, atlasBytes)
  steps.push({ step: 'compose-atlas', bytes: atlasBytes.length, width: atlas.img.width, height: atlas.img.height })

  // 6) 图集审计
  const problems = auditAtlas(atlas.img, { cols, rows, cellW: cw, cellH: ch })
  if (problems.length > 0) warnings.push(...problems.map((x) => x.detail))
  steps.push({ step: 'audit-atlas', problems: problems.length })

  // 7) 音频
  const audioEntries = await buildAudio(p, o.audioSpec, o.name, steps, warnings)

  // 8) 清单
  const id = o.id || slugify(o.name || o.prompt || 'pet')
  const manifest = makeManifest({
    id,
    name: o.name || id,
    atlas: {
      file: 'atlas.png', cols, rows, cellW: cw, cellH: ch,
      // 缩放方式写进清单，桌面窗口和网页端都照它选重采样：
      // smooth = 高分辨率/写实（默认），pixelated = 像素风硬边。
      // 只在显式指定时写，免得给老包凭空加字段。
      ...(o.scaling ? { scaling: o.scaling } : {}),
    },
    states: buildDefaultStates({ cols, rows, cellW: cw, cellH: ch }, actions),
    behavior: o.behavior || 'idle',
    size: Number(o.size) || 120,
    source: {
      kind: o.sourceKind || 'image',
      prompt: o.prompt || '',
      image: o.imagePath ? basename(o.imagePath) : undefined,
      tier: tierBUsed.length > 0 ? 'A+B' : 'A',
      model: o.genModel,
    },
    audio: audioEntries.audio,
    triggers: audioEntries.triggers,
    interactions: audioEntries.interactions,
    phrases: o.phrases || [],
    divePhrases: o.divePhrases || [],
    tags: o.tags || [],
  })
  await writeManifest(p.root, manifest)
  steps.push({ step: 'write-manifest', id })

  // 9) 预览 + 报告
  const previewPath = await writePreview(p.root, manifest)
  steps.push({ step: 'preview', path: previewPath })

  return { p, manifest, steps, warnings, atlasBytes, previewPath }
}

/** 生成音频文件并返回清单片段。 */
async function buildAudio(p, audioSpec, petName, steps, warnings) {
  const audio = {}
  const triggers = {}
  const interactions = {}
  if (!audioSpec || audioSpec.length === 0) {
    // 默认：完成 + 点击，够用且不吵
    audioSpec = ['celebrate', 'click']
  }
  for (const item of audioSpec) {
    // 语法：sfx:celebrate | tts:celebrate:台词文本
    const parts = String(item).split(':')
    const kind = parts[0]
    if (kind === 'sfx') {
      const key = parts[1]
      if (!SFX_PRESETS[key]) { warnings.push(`未知音效 ${key}，可选：${Object.keys(SFX_PRESETS).join(',')}`); continue }
      const file = `audio/${key}.wav`
      await writeSfx(key, join(p.root, file))
      audio[key] = { file, label: SFX_PRESETS[key].label, kind: 'sfx' }
      continue
    }
    if (kind === 'tts') {
      const key = parts[1]
      const text = parts.slice(2).join(':')
      if (!text) { warnings.push(`tts 条目缺少台词文本：${item}`); continue }
      const probe = probeTts()
      if (!probe.ok) {
        warnings.push(
          `TTS 不可用，已跳过语音「${text}」：${probe.reason}。` +
          `建议改用音效（如 sfx:celebrate），或用 file:${key}:<你自己的 wav/mp3 绝对路径> 引入录音。` +
          (probe.hint ? `（${probe.hint}）` : '')
        )
        continue
      }
      const file = `audio/tts-${key}.wav`
      const res = await ttsToWav(text, join(p.root, file), { voice: pickVoice(text, probe.voices) })
      if (!res.ok) { warnings.push(`TTS 合成失败（${key}）：${res.error}`); continue }
      audio[key] = { file, label: `语音：${text.slice(0, 16)}`, kind: 'tts', voice: res.voice, text }
      continue
    }
    if (kind === 'file') {
      const key = parts[1]
      const srcPath = parts.slice(2).join(':')
      if (!srcPath || !existsSync(srcPath)) { warnings.push(`音频文件不存在：${srcPath}`); continue }
      const ext = srcPath.split('.').pop().toLowerCase()
      const file = `audio/${key}.${ext}`
      await mkdir(p.audioDir, { recursive: true })
      await writeFile(join(p.root, file), await readFile(srcPath))
      audio[key] = { file, label: parts[1], kind: 'file' }
      continue
    }
    warnings.push(`无法识别的音频条目：${item}（可用 sfx:<key> / tts:<key>:<台词> / file:<key>:<路径>）`)
  }

  // 事件 → 音效 映射（与插件约定的键名一致）
  const triggerMap = { celebrate: 'celebrating', failed: 'failed', waiting: 'waiting', working: 'working', boot: 'boot' }
  for (const [key, target] of Object.entries(triggerMap)) {
    if (audio[key]) triggers[target] = key
  }
  if (audio.click) interactions.click = 'click'
  if (audio.dive) interactions.tripleClick = 'dive'
  if (audio.boot) interactions.boot = 'boot'

  steps.push({ step: 'audio', keys: Object.keys(audio) })
  return { audio, triggers, interactions }
}

// ---------------------------------------------------------------- 子命令实现

async function cmdBuild(args) {
  const pkgDir = resolve(String(args.pkg || ''))
  if (!args.pkg) emit({ ok: false, error: '缺少 --pkg <宠物包目录>' })
  const imagePath = args.image ? resolve(String(args.image)) : null
  if (!imagePath || !existsSync(imagePath)) emit({ ok: false, error: `主图不存在：${imagePath}` })

  const audioSpec = list(args.audio)
  const res = await buildFromImage({
    pkgDir,
    imagePath,
    name: args.name,
    id: args.id,
    prompt: args.prompt,
    actions: list(args.actions).length ? list(args.actions) : null,
    audioSpec,
    cellW: args['cell-w'] || (args.cell ? String(args.cell).split('x')[0] : undefined),
    cellH: args['cell-h'] || (args.cell ? String(args.cell).split('x')[1] : undefined),
    scaling: args.scaling,
    cols: args.cols, rows: args.rows,
    bgMode: args['bg-mode'], bgTolerance: args['bg-tolerance'],
    size: args.size, behavior: args.behavior,
    requireCutout: true,
    tags: list(args.tags),
  })

  const v = await validatePackage(res.p.root, res.manifest)
  await writeFile(res.p.report, JSON.stringify({
    ok: v.ok, at: now(), steps: res.steps, warnings: res.warnings, validation: v,
  }, null, 2), 'utf8')

  emit({
    ok: v.ok,
    command: 'build',
    pkg: res.p.root,
    manifestId: res.manifest.id,
    name: res.manifest.name,
    atlas: { path: res.p.atlas, bytes: res.atlasBytes.length },
    actions: Object.keys(res.manifest.states),
    audio: Object.keys(res.manifest.audio),
    preview: res.previewPath,
    report: res.p.report,
    steps: res.steps,
    warnings: res.warnings,
    validation: { ok: v.ok, errors: v.errors, warnings: v.warnings },
    human: v.ok
      ? `已生成宠物「${res.manifest.name}」→ ${res.p.root}（${res.atlasBytes.length} 字节图集，${Object.keys(res.manifest.states).length} 个动作）`
      : `生成完成但校验未通过：${v.errors.join('；')}`,
    next: '接下来可以：node forge.mjs verify --pkg <dir> / inspect / preview / install',
  })
}

async function cmdGenerate(args) {
  if (!args.brief) emit({ ok: false, error: '缺少 --brief "<一句话描述>"' })
  const gen = probeGenConfig()
  if (!gen.ok) emit({ ok: false, error: gen.hint, command: 'generate' })

  const pkgDir = resolve(String(args.pkg || join(process.cwd(), 'pets', slugify(args.brief))))
  const p = await ensurePkg(pkgDir, args.name)
  const steps = []
  const warnings = []

  const subject = String(args.brief)
  const prompt = buildCharacterPrompt(subject, { style: args.style, palette: args.palette })
  await writeFile(join(p.sourceDir, 'prompt.txt'), prompt, 'utf8')
  steps.push({ step: 'character-prompt', prompt })

  const size = args['gen-size'] || '1024x1024'
  let genRes
  try {
    genRes = await generateImage(prompt, { size, timeoutMs: Number(args['gen-timeout'] || 180000) })
  } catch (err) {
    emit({
      ok: false,
      command: 'generate',
      error: String(err.message),
      code: err.code,
      prompt,
      hint: err.code === 'NO_API_KEY'
        ? '先配置生图 Key（dsh-eye 的 setup.ps1，或环境变量 DASHEYE_GEN_API_KEY）'
        : '可换模型/尺寸重试：--model / --gen-size 512x512',
    })
  }
  const basePath = join(p.sourceDir, `generated.${genRes.format}`)
  await writeFile(basePath, genRes.bytes)
  steps.push({ step: 'generate-image', path: basePath, bytes: genRes.bytes.length, model: genRes.model, format: genRes.format })

  // Tier B：按需为每个动作再生一条 4 帧条带
  const stripImages = {}
  const tier = String(args.tier || 'A').toUpperCase()
  const actions = list(args.actions).length ? list(args.actions) : RECOMMENDED_ACTIONS
  if (tier.includes('B')) {
    const stripActions = list(args['strip-actions']).length ? list(args['strip-actions']) : actions.filter((a) => a !== 'idle' && a !== 'look')
    for (const action of stripActions) {
      const desc = ACTION_PROMPTS[action]
      if (!desc) { warnings.push(`动作 ${action} 没有条带提示词，跳过 Tier B`); continue }
      const n = Number(args['strip-frames'] || 4)
      const sp = buildStripPrompt(subject, desc, n, { style: args.style })
      try {
        const r = await generateImage(sp, { size: args['gen-size-strip'] || '1024x1024', timeoutMs: Number(args['gen-timeout'] || 180000) })
        const sp2 = join(p.framesDir, `${action}-strip.${r.format}`)
        await writeFile(sp2, r.bytes)
        stripImages[action] = sp2
        steps.push({ step: `generate-strip:${action}`, path: sp2 })
      } catch (err) {
        warnings.push(`${action} 条带生图失败：${err.message}`)
      }
    }
  }

  const res = await buildFromImage({
    pkgDir,
    imagePath: basePath,
    name: args.name || args.brief,
    id: args.id,
    prompt: subject,
    actions,
    audioSpec: list(args.audio),
    stripImages,
    stripFrames: args['strip-frames'],
    cols: args.cols, rows: args.rows,
    bgMode: args['bg-mode'], bgTolerance: args['bg-tolerance'],
    size: args.size, behavior: args.behavior,
    genModel: genRes.model,
    tags: list(args.tags),
    requireCutout: true,
  })
  steps.push(...res.steps)
  warnings.push(...res.warnings)

  const v = await validatePackage(res.p.root, res.manifest)
  await writeFile(res.p.report, JSON.stringify({ ok: v.ok, at: now(), steps, warnings, validation: v }, null, 2), 'utf8')

  emit({
    ok: v.ok,
    command: 'generate',
    pkg: res.p.root,
    manifestId: res.manifest.id,
    name: res.manifest.name,
    prompt,
    tier,
    steps,
    warnings,
    validation: { ok: v.ok, errors: v.errors, warnings: v.warnings },
    preview: res.previewPath,
    next: '建议先 preview 目视确认，再 install 注册进 DSH',
  })
}

async function cmdAudio(args) {
  const pkgDir = resolve(String(args.pkg || ''))
  if (!existsSync(pkgDir)) emit({ ok: false, error: `宠物包不存在：${pkgDir}` })
  const p = pkgPaths(pkgDir)
  const steps = []
  const warnings = []

  if (args.list) {
    const voices = ttsAvailable() ? listVoices() : []
    emit({ ok: true, command: 'audio-list', sfx: AUDIO_CATALOG, tts: { available: ttsAvailable(), voices } })
  }

  const manifest = await readManifest(pkgDir)
  const spec = list(args.sfx).map((k) => `sfx:${k}`)
    .concat(list(args.tts).map((t) => `tts:${t.includes(':') ? t : 'celebrate:' + t}`))
    .concat(list(args.file))
  const result = await buildAudio(p, spec.length ? spec : list(args.add), manifest.name, steps, warnings)

  // 合并进现有清单（保留原有音效，除非 --replace）
  manifest.audio = args.replace ? result.audio : { ...(manifest.audio || {}), ...result.audio }
  manifest.triggers = { ...(manifest.triggers || {}), ...result.triggers }
  manifest.interactions = { ...(manifest.interactions || {}), ...result.interactions }
  await writeManifest(pkgDir, manifest)
  await writePreview(pkgDir, manifest)

  emit({
    ok: true,
    command: 'audio',
    pkg: pkgDir,
    audio: Object.keys(manifest.audio),
    triggers: manifest.triggers,
    interactions: manifest.interactions,
    steps,
    warnings,
    human: `音效已更新：${Object.keys(manifest.audio).join(', ') || '（无）'}`,
  })
}

async function cmdBlenderPlan(args) {
  const pkgDir = resolve(String(args.pkg || ''))
  if (!existsSync(pkgDir)) emit({ ok: false, error: `宠物包不存在：${pkgDir}` })
  const p = pkgPaths(pkgDir)
  await mkdir(p.modelDir, { recursive: true })
  await mkdir(p.renderDir, { recursive: true })

  // 调色板：优先用已有主图提取，保证 3D 与 2D 观感一致
  let palette = list(args.palette)
  if (palette.length === 0) {
    const basePng = join(p.sourceDir, 'cutout.png')
    const altPng = join(p.sourceDir, 'base.png')
    const srcFile = existsSync(basePng) ? basePng : existsSync(altPng) ? altPng : null
    if (srcFile) {
      const img = await loadImage(srcFile)
      const pal = extractPalette(img, 5)
      palette = pal.map((x) => x.hex)
      if (palette.length < 5) palette = palette.concat(['#7ec8ff', '#1e283c', '#ffffff']).slice(0, 5)
    }
  }
  if (palette.length === 0) palette = ['#7ec8ff', '#a9dcff', '#5aa8e8', '#1e283c', '#ffffff']

  const actions = list(args.actions).length ? list(args.actions) : BLENDER_ACTIONS
  const spec = buildBlenderSpec({
    petId: args.id || basename(pkgDir),
    name: args.name || basename(pkgDir),
    outDir: p.modelDir,
    renderDir: p.renderDir,
    cellW: Number(args['cell-w'] || DEFAULT_ATLAS.cellW),
    cellH: Number(args['cell-h'] || DEFAULT_ATLAS.cellH),
    palette,
    actions,
    frames: parseFramesArg(args.frames),
    yawCount: Number(args.yaw || 8),
    renderLookRows: args['no-look'] !== true,
    exportGlb: args['no-glb'] !== true,
    samples: Number(args.samples || 16),
  })
  const specPath = join(p.modelDir, 'spec.json')
  await writeFile(specPath, JSON.stringify(spec, null, 2), 'utf8')

  const script = buildScript({ ...spec, __specPath: specPath })
  const scriptPath = join(p.modelDir, 'build.py')
  await writeFile(scriptPath, script, 'utf8')

  const blender = findBlender()
  emit({
    ok: true,
    command: 'blender-plan',
    pkg: pkgDir,
    spec: specPath,
    script: scriptPath,
    palette,
    yawCount: spec.yawCount,
    actions: spec.actions,
    blender: blender || '未找到',
    howToRun: {
      mcp: mcpRecipe(scriptPath),
      headless: `node "${join(SKILL_ROOT, 'scripts', 'forge.mjs')}" blender-run --pkg "${pkgDir}"`
        + (blender ? '' : ' --blender "<blender.exe 路径>"'),
    },
    next: '跑完渲染后再执行：forge.mjs blender-assemble --pkg <dir>',
  })
}

function parseFramesArg(v) {
  const out = {}
  if (typeof v === 'string') {
    for (const pair of v.split(',')) {
      const [k, n] = pair.split('=')
      if (k && n) out[k.trim()] = Number(n)
    }
  }
  return out
}

async function cmdBlenderRun(args) {
  const pkgDir = resolve(String(args.pkg || ''))
  const p = pkgPaths(pkgDir)
  const specPath = join(p.modelDir, 'spec.json')
  const scriptPath = join(p.modelDir, 'build.py')
  if (!existsSync(specPath) || !existsSync(scriptPath)) {
    emit({ ok: false, error: '还没有 model/spec.json 或 model/build.py，请先执行 blender-plan' })
  }
  const blender = args.blender ? String(args.blender) : findBlender()
  const r = runHeadless({
    blenderPath: blender,
    scriptPath,
    specPath,
    cwd: p.modelDir,
    timeoutMs: Number(args.timeout || 900000),
  })
  if (!r.ok) {
    emit({
      ok: false,
      command: 'blender-run',
      error: r.error,
      blender: r.blender,
      stderr: r.stderr,
      stdout: r.stdout,
      hint: '如果沙箱拒绝执行 blender.exe，请改用 Blender MCP（见 blender-plan 输出的 howToRun.mcp），' +
            '或用 sandbox_permissions: danger-full-access 重试该命令。',
    })
  }
  const reportPath = join(p.modelDir, 'render-report.json')
  const report = existsSync(reportPath) ? JSON.parse(await readFile(reportPath, 'utf8')) : null

  // 渲染完就顺手体检一遍：全透明帧往往意味着引擎没真正出图
  let empties = 0
  let checked = 0
  try {
    const asm = await assembleFromRenders(JSON.parse(await readFile(specPath, 'utf8')))
    empties = asm.emptyTotal
    checked = Object.values(asm.found).reduce((a, b) => a + b, 0)
  } catch (err) {
    // 装配失败不阻断这里，assemble 子命令会给出更详细的错误
  }

  emit({
    ok: empties === 0,
    command: 'blender-run',
    blender: r.blender,
    report,
    framesChecked: checked,
    emptyFrames: empties,
    warning: empties > 0
      ? `⚠️ ${empties}/${checked} 帧是全透明的：渲染引擎没有真正出图。` +
        `若报告里 preflight.hasContent 为 false，说明该引擎在无头模式下不可用（EEVEE 需要 GPU 上下文）。` +
        `脚本会自动切 Cycles 重试；仍失败请改用 Blender MCP（有真实 GPU 上下文）。`
      : undefined,
    next: `接下来装配：node forge.mjs blender-assemble --pkg "${pkgDir}"`,
  })
}

async function cmdBlenderAssemble(args) {
  const pkgDir = resolve(String(args.pkg || ''))
  const p = pkgPaths(pkgDir)
  const specPath = join(p.modelDir, 'spec.json')
  if (!existsSync(specPath)) emit({ ok: false, error: '缺少 model/spec.json，请先执行 blender-plan' })
  const spec = JSON.parse(await readFile(specPath, 'utf8'))

  const asm = await assembleFromRenders(spec)
  const cols = Number(args.cols || DEFAULT_ATLAS.cols)
  const rows = Number(args.rows || DEFAULT_ATLAS.rows)
  const atlas = composeAtlas({ cols, rows, cellW: spec.cellW, cellH: spec.cellH, rowFrames: asm.rowFrames })
  const atlasBytes = encodeImage(atlas.img)
  await writeFile(p.atlas, atlasBytes)

  const problems = auditAtlas(atlas.img, { cols, rows, cellW: spec.cellW, cellH: spec.cellH })

  // 空帧是最要命的静默失败：渲染器退出码是 0，图集也"合法"，但宠物是隐形的。
  if (asm.emptyTotal > 0) {
    asm.warnings.unshift(
      `有 ${asm.emptyTotal} 帧渲染结果为全透明（例如 ${asm.emptyFrames.slice(0, 4).join(', ')}）。` +
      `最常见原因：渲染引擎在无头模式下没有真正出图（EEVEE 需要 GPU 上下文，无头请用 Cycles）。` +
      `重跑 blender-run 即可，脚本会先做预检并自动切到 Cycles。`
    )
  }

  // 3D 的 look：每帧一格
  const states = buildDefaultStates({ cols, rows, cellW: spec.cellW, cellH: spec.cellH },
    Object.keys(asm.found).filter((k) => k !== 'look'))
  if (asm.lookAngles && asm.lookAngles.length > 0) {
    states.look = { angles: asm.lookAngles, frames: 1, fps: 1, label: '环视（3D）' }
  }

  const manifestPath = p.manifest
  const existing = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : null
  const manifest = makeManifest({
    id: existing?.id || args.id || basename(pkgDir),
    name: existing?.name || args.name || basename(pkgDir),
    atlas: { file: 'atlas.png', cols, rows, cellW: spec.cellW, cellH: spec.cellH },
    states,
    behavior: existing?.behavior || 'idle',
    size: existing?.size ?? 120,
    source: {
      kind: 'blender',
      tier: '3D',
      palette: spec.palette,
      glb: existsSync(join(p.modelDir, 'pet.glb')) ? 'model/pet.glb' : undefined,
    },
    audio: existing?.audio || {},
    triggers: existing?.triggers || {},
    interactions: existing?.interactions || {},
  })
  manifest.yaw = asm.lookAngles && asm.lookAngles.length ? { count: asm.lookAngles.length, rowsPerYaw: 0, kind: 'rows' } : null
  await writeManifest(pkgDir, manifest)
  const previewPath = await writePreview(pkgDir, manifest)

  const v = await validatePackage(pkgDir, manifest)
  emit({
    ok: v.ok,
    command: 'blender-assemble',
    pkg: pkgDir,
    found: asm.found,
    missing: asm.missing,
    lookAngles: asm.lookAngles ? asm.lookAngles.length : 0,
    glb: existsSync(join(p.modelDir, 'pet.glb')) ? join(p.modelDir, 'pet.glb') : null,
    atlas: { path: p.atlas, bytes: atlasBytes.length },
    auditProblems: problems.length,
    warnings: [...asm.warnings, ...atlas.warnings, ...problems.map((x) => x.detail)],
    validation: { ok: v.ok, errors: v.errors, warnings: v.warnings },
    preview: previewPath,
    next: '建议 preview 目视确认，再 install 注册进 DSH',
  })
}

async function cmdVerify(args) {
  const pkgDir = resolve(String(args.pkg || ''))
  if (!existsSync(pkgDir)) emit({ ok: false, error: `宠物包不存在：${pkgDir}` })
  const local = await readLocalManifest(pkgDir)
  if (!local.ok) emit({ ok: false, ...local })

  const v = await validatePackage(pkgDir, local.manifest)
  const extra = { actions: {}, audio: {} }

  if (v.ok && v.info.atlas) {
    // 逐格深度检查（只有尺寸对得上才有意义）
    const img = await loadImage(v.info.atlas.abs)
    const { cols, rows, cellW, cellH } = local.manifest.atlas
    let emptyCells = 0
    let suspicious = 0
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = crop(img, c * cellW, r * cellH, cellW, cellH)
        const st = frameStats(cell)
        if (st.empty) emptyCells++
        else if (st.distinctColors < 3) suspicious++
      }
    }
    // 未在 states 里引用的行应该全透明
    const usedRows = new Set()
    for (const st of Object.values(local.manifest.states || {})) {
      if (st.rows) for (const r of st.rows) usedRows.add(r)
      if (st.row !== undefined) usedRows.add(st.row)
      if (st.angles) for (const a of st.angles) usedRows.add(a.row)
    }
    const strayRows = []
    for (let r = 0; r < rows; r++) {
      if (usedRows.has(r)) continue
      let dirty = 0
      for (let y = r * cellH; y < (r + 1) * cellH; y++) {
        for (let x = 0; x < cols * cellW; x++) {
          if (img.data[(y * img.width + x) * 4 + 3] > 8) dirty++
        }
      }
      if (dirty > 0) strayRows.push({ row: r, nonTransparentPixels: dirty })
    }
    extra.grid = { emptyCells, suspiciousCells: suspicious, unusedRowsWithContent: strayRows }
    extra.palette = extractPalette(img, 6).map((p) => p.hex)
    extra.dominant = dominantColor(img).hex
    extra.darkest = darkestColor(img).hex
    if (strayRows.length > 0) {
      v.warnings.push(`有 ${strayRows.length} 个未被 states 引用的行仍含非透明像素（客户端不会显示，属浪费体积）`)
    }
  }

  emit({
    ok: v.ok,
    command: 'verify',
    pkg: pkgDir,
    id: local.manifest.id,
    name: local.manifest.name,
    errors: v.errors,
    warnings: v.warnings,
    info: {
      atlas: v.info.atlas ? { file: v.info.atlas.file, width: v.info.atlas.width, height: v.info.atlas.height, bytes: v.info.atlas.bytes } : null,
      audio: Object.fromEntries(Object.entries(v.info.audio || {}).map(([k, x]) => [k, { file: x.file, format: x.format, bytes: x.bytes }])),
    },
    extra,
    human: v.ok
      ? `✅ 「${local.manifest.name}」校验通过（图集 ${v.info.atlas.width}×${v.info.atlas.height}，${(v.info.atlas.bytes / 1024).toFixed(0)} KB，${Object.keys(v.info.audio || {}).length} 个音效）`
      : `❌ 校验失败：${v.errors.join('；')}`,
  })
}

async function cmdInspect(args) {
  const pkgDir = resolve(String(args.pkg || ''))
  const manifest = await readManifest(pkgDir)
  const a = manifest.atlas
  // 走库调用而不是 spawn 子进程：沙箱禁止捕获子进程输出（管道 EPERM）
  const { inspectAtlas } = await import('./inspect.mjs')
  const out = args.out ? resolve(String(args.out)) : join(pkgDir, 'inspect-sheet.png')
  const r = await inspectAtlas(join(pkgDir, a.file), {
    out,
    cols: a.cols,
    cellW: a.cellW,
    cellH: a.cellH,
    zoom: Number(args.zoom || 2),
    rows: args.rows ? String(args.rows) : undefined,
  })
  const edge = r.perCell.filter((c) => c.touchesEdge)
  const empty = r.perCell.filter((c) => c.empty)
  emit({
    ok: edge.length === 0,
    command: 'inspect',
    sheet: r.path,
    size: { width: r.width, height: r.height },
    rows: r.rows,
    cells: r.perCell.length,
    emptyCells: empty.length,
    edgeTouchingCells: edge.map((c) => `r${c.row}c${c.col}`),
    hint: edge.length === 0
      ? '没有格子贴边，说明没有被裁切。建议再用视觉模型确认一次：node "<dsh-eye>/scripts/vision.mjs" "' + r.path + '" "逐行检查每格角色是否完整，有无裁切/串帧/白边" --mode ask'
      : '⚠️ 有格子贴到边缘，可能被裁切：' + edge.slice(0, 8).map((c) => `r${c.row}c${c.col}`).join(' '),
    human: edge.length === 0
      ? `✅ 检查图已生成：${r.path}（${r.perCell.length} 格，无贴边）`
      : `⚠️ 检查图已生成：${r.path}（${edge.length} 格贴边）`,
  })
}

async function cmdPreview(args) {
  const pkgDir = resolve(String(args.pkg || ''))
  const manifest = await readManifest(pkgDir)
  const path = await writePreview(pkgDir, manifest)
  emit({ ok: true, command: 'preview', pkg: pkgDir, preview: path, human: `预览页：${path}` })
}

async function cmdInstall(args) {
  const pkgDir = resolve(String(args.pkg || ''))
  const local = await readLocalManifest(pkgDir)
  if (!local.ok) emit({ ok: false, ...local })
  const v = await validatePackage(pkgDir, local.manifest)
  if (!v.ok) {
    emit({
      ok: false,
      command: 'install',
      error: '宠物包未通过校验，拒绝注册（避免把坏素材灌进界面）',
      errors: v.errors,
      hint: '先修好问题，或跑 forge.mjs verify --pkg <dir> 看详情',
    })
  }
  const res = await registerPet(pkgDir, { name: args.name, base: args.base, focus: args['no-focus'] !== true })
  emit({
    ...res,
    command: 'install',
    pkg: pkgDir,
    id: local.manifest.id,
    warnings: v.warnings,
    human: res.ok
      ? (res.focused === false
          ? `✅ 已注册「${local.manifest.name}」（保持隐藏，没有抢默认位）。想让它出现：设置 → ⚽ 桌宠 →「⭐ 设为默认」。`
          : `✅ 已注册「${local.manifest.name}」并设为默认打开的桌宠（其它宠物已自动收起）。看界面右下角，或桌面上的原生窗口。`)
      : `❌ 注册失败：${res.error || '未知错误'}`,
    next: res.ok && res.focused !== false
      ? '想同时养多只：设置 → ⚽ 桌宠 → 点其它宠物的「👁 显示中」'
      : undefined,
  })
}

async function cmdUninstall(args) {
  if (!args.id) emit({ ok: false, error: '缺少 --id <宠物id>' })
  emit({ ...(await unregisterPet(String(args.id), { base: args.base })), command: 'uninstall' })
}

async function cmdList(args) {
  emit({ ...(await listPets({ base: args.base })), command: 'list' })
}

async function cmdPlay(args) {
  if (!args.id || !args.key) emit({ ok: false, error: '需要 --id <宠物id> --key <音效key>' })
  emit({ ...(await playAudio(String(args.id), String(args.key), { base: args.base })), command: 'play' })
}

// ---------------------------------------------------------------- 入口

const USAGE = `dsh-pet-forge · 桌宠生成器

  doctor                             环境自检
  plan --brief "..." [--detail medium]  生成多轮询问建议（动作/音频/路线）
  generate --pkg <dir> --brief "..."  一句话生成（生图 + 合成 + 校验）
       [--tier A|B] [--actions a,b] [--audio sfx:celebrate,tts:celebrate:台词]
       [--style "..."] [--size 120] [--cols 8 --rows 11 --cell 192x208] [--scaling smooth|pixelated]
  build --pkg <dir> --image <png>     从本地图片构建
  audio --list | --pkg <dir> --sfx k1,k2 | --add tts:celebrate:台词
  blender-plan --pkg <dir> [--yaw 8]    生成 Blender 脚本与规格
  blender-run  --pkg <dir> [--blender <>]  无头渲染
  blender-assemble --pkg <dir>          装配渲染结果成图集
  verify --pkg <dir>                   严格校验
  inspect --pkg <dir> [--rows 0,1,4]   生成目视检查图
  preview --pkg <dir>                  生成独立预览页
  install --pkg <dir> [--name <>] [--no-focus]  注册进运行中的 DSH
       （默认会接管为"默认打开的桌宠"并收起其它；--no-focus 只注册不上场）
  uninstall --id <id> | list | play --id <id> --key <k>

所有命令输出单个 JSON 对象，便于自动化。
`

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const args = parseArgs(argv.slice(1))
  if (!cmd || cmd === 'help' || cmd === '--help' || args.help) {
    process.stdout.write(USAGE)
    process.exit(0)
  }
  const handlers = {
    doctor: cmdDoctor,
    plan: cmdPlan,
    build: cmdBuild,
    generate: cmdGenerate,
    audio: cmdAudio,
    'blender-plan': cmdBlenderPlan,
    'blender-run': cmdBlenderRun,
    'blender-assemble': cmdBlenderAssemble,
    verify: cmdVerify,
    inspect: cmdInspect,
    preview: cmdPreview,
    install: cmdInstall,
    uninstall: cmdUninstall,
    list: cmdList,
    play: cmdPlay,
  }
  const h = handlers[cmd]
  if (!h) emit({ ok: false, error: `未知子命令：${cmd}`, usage: USAGE.split('\n').filter((l) => l.trim().startsWith(cmd) === false).slice(0, 3) })
  try {
    await h(args)
  } catch (err) {
    if (err instanceof Stop) return
    emit({
      ok: false,
      command: cmd,
      error: String(err && err.message || err),
      stack: args.debug ? String(err && err.stack || '') : undefined,
    })
  }
}

main()
