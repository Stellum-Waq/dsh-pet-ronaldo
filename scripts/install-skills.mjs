#!/usr/bin/env node
// =============================================================================
// 把本仓库 skill/ 下的技能安装到 DSH 的技能目录
//
//   node scripts/install-skills.mjs                # 全部安装（复制）
//   node scripts/install-skills.mjs --check        # 只看会做什么，不写
//   node scripts/install-skills.mjs --link         # 建符号链接（开发用：改仓库即时生效）
//   node scripts/install-skills.mjs --only dsh-pet-video
//
// 为什么需要它：技能原先是一次性手工拷进 ~/.agents/skills 的，于是仓库里改了
// SKILL.md、装在别处的还是老版本 —— 实测踩过：仓库里已经修好的说明，
// 模型读到的仍是旧文本，照着旧说明去跑已经不需要的补丁步骤。
//
// 目标目录：**~/.agents/skills**（技能根；可用 DSH_SKILLS_DIR 覆盖）。
// ⚠️ 不是 $DSH_HOME/agents/skills —— DSH_HOME 是 ~/.dsh，技能不在它下面。
// =============================================================================

import { cp, mkdir, readdir, rm, stat, lstat, symlink, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')
const SRC = join(REPO, 'skill')

const argv = process.argv.slice(2)
const CHECK = argv.includes('--check')
const LINK = argv.includes('--link')
const onlyIdx = argv.indexOf('--only')
const ONLY = onlyIdx >= 0 ? argv[onlyIdx + 1] : null

// 目标目录：技能根是 **~/.agents/skills**（不是 $DSH_HOME/agents/skills ——
// DSH_HOME 指的是 ~/.dsh，技能却不在它下面；这里搞错过一次，把技能装进了
// ~/.dsh/agents/skills 这个没人扫描的目录）。可用 DSH_SKILLS_DIR 覆盖。
const destRoot = process.env.DSH_SKILLS_DIR || join(homedir(), '.agents', 'skills')

/** 技能目录 = 直接子目录里带 SKILL.md 的那些。 */
const listSkills = async () => {
  const out = []
  for (const e of await readdir(SRC, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const dir = join(SRC, e.name)
    if (!existsSync(join(dir, 'SKILL.md'))) continue
    out.push({ name: e.name, dir })
  }
  return out
}

/** 从 SKILL.md 的 frontmatter 里读 name/description，用于打印与校验。 */
const readFrontmatter = async (dir) => {
  try {
    const text = await readFile(join(dir, 'SKILL.md'), 'utf8')
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (!m) return { name: null, hasFrontmatter: false }
    const name = /^name:\s*(.+)$/m.exec(m[1])
    return { name: name ? name[1].trim() : null, hasFrontmatter: true }
  } catch {
    return { name: null, hasFrontmatter: false }
  }
}

const typeOf = async (p) => {
  try {
    const st = await lstat(p)
    if (st.isSymbolicLink()) return 'symlink'
    if (st.isDirectory()) return 'dir'
    return 'file'
  } catch {
    return 'missing'
  }
}

const main = async () => {
  const skills = await listSkills()
  if (skills.length === 0) {
    console.log('skill/ 下没有找到任何技能（需要 <技能>/SKILL.md）')
    process.exit(1)
  }
  const picked = ONLY ? skills.filter((s) => s.name === ONLY) : skills
  if (picked.length === 0) {
    console.log(`没有名为 ${ONLY} 的技能。现有：` + skills.map((s) => s.name).join(', '))
    process.exit(1)
  }

  console.log('源    ：' + SRC)
  console.log('目标  ：' + destRoot + (LINK ? '   [符号链接模式]' : '   [复制模式]'))
  if (CHECK) console.log('模式  ：--check，只看不写')
  console.log('')

  if (!CHECK) await mkdir(destRoot, { recursive: true })

  let changed = 0
  for (const s of picked) {
    const dest = join(destRoot, s.name)
    const fm = await readFrontmatter(s.dir)
    const before = await typeOf(dest)

    // frontmatter 的 name 必须和目录名一致，否则技能加载器会对不上
    const warn = []
    if (!fm.hasFrontmatter) warn.push('SKILL.md 缺少 frontmatter')
    if (fm.name && fm.name !== s.name) warn.push(`frontmatter name=${fm.name} 与目录名不一致`)

    const verb = before === 'missing' ? 'install' : 'replace'
    console.log(`  ${verb.padEnd(8)} ${s.name.padEnd(18)} (原来是 ${before})` + (warn.length ? '   ⚠ ' + warn.join('；') : ''))

    if (CHECK) continue
    if (before !== 'missing') await rm(dest, { recursive: true, force: true })
    if (LINK) {
      try {
        await symlink(s.dir, dest, 'junction')
      } catch (err) {
        console.log(`     符号链接失败（${err.code || err.message}），退回复制`)
        await cp(s.dir, dest, { recursive: true })
      }
    } else {
      await cp(s.dir, dest, { recursive: true })
    }
    changed++
  }

  console.log('')
  if (CHECK) {
    console.log(`--check 完成：会处理 ${picked.length} 个技能，没有写任何东西。`)
    return
  }
  console.log(`完成：${changed} 个技能已就位。`)
  console.log('技能目录是按 rank 扫描的，安装后**不需要重启** dsh web；新会话即可读到。')
}

main().catch((err) => {
  console.error('安装失败：', err && err.stack || err)
  process.exit(1)
})
