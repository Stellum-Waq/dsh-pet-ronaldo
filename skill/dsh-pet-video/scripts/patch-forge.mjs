#!/usr/bin/env node
/**
 * 第 0 步：把 dsh-pet-forge 复制一份到**工作区里**，并修掉两个挡住视频路线的 bug。
 *
 * 为什么要复制而不是直接改：官方 skill 装在 ~/.agents/skills/ 下，
 *   ① 它在工作区之外，沙箱下根本写不进去；
 *   ② 它是别人维护的，直接改会在下次更新时丢失/冲突。
 * 复制到工作区改副本，官方 skill 保持原样，出了问题也好回退。
 *
 * 修的这两个 bug（都是上游的，不是环境问题）：
 *
 *   1) forge.mjs 的 --frames-dir 退路是死代码
 *      源码：if (!args.framesDir && engines.available.length === 0) { 报错退出 }
 *      但 parseArgs 产出的键是 'frames-dir'（带横线），args.framesDir 恒为 undefined，
 *      所以这个"没有解码引擎也能用自己抽好的帧"的退路永远不会生效。
 *      后果：任何探不到解码引擎的机器（比如 DSH 沙箱下 Node 管道 stdio 被禁），
 *      整条视频路线直接判死，哪怕你手上已经有抽好的 PNG。
 *
 *   2) video.mjs 里 --no-key 永远走不通
 *      源码先 `parseChromaColor(opts.key)` 再判断 noKey，而 parseChromaColor('none')
 *      返回 null 直接报错退出。CLI 的 --no-key 恰恰会把 key 翻成 'none'。
 *      后果：没有幕布、必须用自带 alpha 的素材（也就是人体分割的产物）完全没法用。
 *
 * 用法：
 *   node patch-forge.mjs --dst "<工作区>/_work/forge-local"
 *   node patch-forge.mjs --dst ... --check      # 只看状态，不写文件
 */
import { cp, readFile, writeFile, access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

function argAfter(argv, flag, def) {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}

const argv = process.argv.slice(2)
const CHECK = argv.includes('--check')
const SRC = resolve(argAfter(argv, '--src', join(homedir(), '.agents', 'skills', 'dsh-pet-forge')))
const DST = resolve(argAfter(argv, '--dst', join(process.cwd(), '_work', 'forge-local')))

const out = { ok: false, src: SRC, dst: DST, check: CHECK, patches: [] }
const fail = (error, extra = {}) => {
  console.log(JSON.stringify({ ...out, error, ...extra }, null, 2))
  process.exit(1)
}

if (!existsSync(join(SRC, 'scripts', 'forge.mjs'))) {
  fail(`找不到 dsh-pet-forge 源码：${SRC}`, {
    hint: '用 --src 指定 skill 目录（里面应有 scripts/forge.mjs）',
  })
}

// ---------------------------------------------------------------- 复制
if (!CHECK) {
  try {
    // cp 的 recursive 会把 scripts/ references/ templates/ 一起带过来，
    // share 命令要用到 templates/，所以整份复制，别只挑 scripts。
    await cp(SRC, DST, { recursive: true, force: true })
    out.copied = true
  } catch (err) {
    fail(`复制失败：${err.message}`, { hint: '确认 --dst 在工作区里（沙箱只允许写工作区）' })
  }
} else if (!existsSync(DST)) {
  fail(`--check 模式但目标还不存在：${DST}`)
}

// ---------------------------------------------------------------- 打补丁
const FORGE = join(DST, 'scripts', 'forge.mjs')
const VIDEO = join(DST, 'scripts', 'lib', 'video.mjs')

function applyPatch(name, text, steps) {
  // alreadyWhen 可以是字符串或数组：同一处修复可能有几种等价写法
  //（比如手工改的副本和本脚本改的副本，语义一样、文本不同），
  // 不认全就会把"已经修好了"误报成"打不上"。
  const isDone = steps.some((s) => {
    if (!s.alreadyWhen) return false
    const markers = Array.isArray(s.alreadyWhen) ? s.alreadyWhen : [s.alreadyWhen]
    return markers.some((m) => text.includes(m))
  })
  if (isDone) {
    out.patches.push({ name, status: 'already-applied' })
    return text
  }
  let next = text
  for (const step of steps) {
    if (!next.includes(step.find)) {
      out.patches.push({
        name,
        status: 'NOT-FOUND',
        missing: step.find.slice(0, 90),
        why: step.why || '上游源码可能已经变了',
      })
      return null
    }
    next = step.replace === null
      ? next.split(step.find).join('')
      : next.split(step.find).join(step.replace)
  }
  out.patches.push({ name, status: CHECK ? 'needs-patch' : 'applied' })
  return next
}

let forgeText = await readFile(FORGE, 'utf8')

// --- 补丁 1：--frames-dir 的键名
const forgePatched = applyPatch('frames-dir-key', forgeText, [{
  find: 'if (!args.framesDir && engines.available.length === 0) {',
  replace: 'if (!args[\'frames-dir\'] && engines.available.length === 0) {',
  // 打过补丁之后的形态。没有这个标记的话，对一份已经打过补丁的副本再跑 --check
  // 会找不到原文、误报 NOT-FOUND（把"已经好了"说成"打不上"）。
  alreadyWhen: "args['frames-dir'] && engines.available.length === 0",
  why: 'parseArgs 产出的键是 frames-dir，不是 framesDir',
}])
if (forgePatched === null) {
  fail('补丁 1 打不上：forge.mjs 的 --frames-dir 判断已经被改过或删掉了', { patches: out.patches })
}
if (!CHECK && forgePatched !== forgeText) await writeFile(FORGE, forgePatched, 'utf8')
forgeText = forgePatched

// --- 补丁 2：noKey 必须先于 parseChromaColor
let videoText = await readFile(VIDEO, 'utf8')
const videoPatched = applyPatch('no-key-ordering', videoText, [
  {
    // 借一个哨兵变量把判断提前，避免大段重排
    find: "let keySpec = parseChromaColor(opts.key === undefined ? 'auto' : opts.key)",
    replace: "const __noKey = opts.noKey === true || opts.key === 'none' || opts.key === false\n"
           + "  let keySpec = __noKey ? null : parseChromaColor(opts.key === undefined ? 'auto' : opts.key)",
    // 两种等价形态都认：本脚本改的带 __noKey；手工改的没有哨兵变量，
    // 但一定带着 `!noKey && keySpec === null` 这个守卫。
    alreadyWhen: ['__noKey', '!noKey && keySpec === null'],
    why: "parseChromaColor('none') 返回 null，会在判断 noKey 之前就报错退出",
  },
  {
    find: "if (keySpec === null) return { ...report, error: `无法理解的幕布颜色",
    replace: "if (!__noKey && keySpec === null) return { ...report, error: `无法理解的幕布颜色",
    why: '跳过抠像时 keySpec 本来就是 null，不该报错',
  },
  {
    find: "const noKey = opts.noKey === true || opts.key === 'none' || opts.key === false",
    replace: 'const noKey = __noKey',
    why: '复用上面算好的判断，两处不能各算一份',
  },
])
if (videoPatched === null) {
  fail('补丁 2 打不上：video.mjs 的抠像判断已经被改过', { patches: out.patches })
}
if (!CHECK && videoPatched !== videoText) await writeFile(VIDEO, videoPatched, 'utf8')

out.ok = out.patches.every((p) => p.status !== 'NOT-FOUND')
out.entry = join(DST, 'scripts', 'forge.mjs')
out.human = CHECK
  ? `检查完成：${out.patches.map((p) => p.name + '=' + p.status).join(' · ')}`
  : `✅ forge 副本已就绪：${out.entry}（${out.patches.map((p) => p.name + '=' + p.status).join(' · ')}）`
out.note = '后面所有 forge 命令都要用这个副本的路径，不要用 ~/.agents/skills 下的原件。'
console.log(JSON.stringify(out, null, 2))
