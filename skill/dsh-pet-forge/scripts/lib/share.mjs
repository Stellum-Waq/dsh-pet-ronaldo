// =============================================================================
// dsh-pet-forge · DPSL-1.0 分享包生成器
// -----------------------------------------------------------------------------
// 这是「协议」在代码侧的落点。两个调用方共用同一份实现：
//   · 技能 CLI ：node forge.mjs share --pkg <目录> [--repo <url>] [--accept]
//   · 插件 Host：POST /ronaldo-pet/gallery/share
//
// 职责：
//   1. 校验并规范化仓库地址（owner/repo）
//   2. 生成/更新 pet.json 里的 sharing 块（协议唯一认可的"同意"方式）
//   3. 落一份协议副本、README、SHARING.md、发布脚本与 .gitignore
//   4. 给出「要加的 topic / git 命令 / 索引条目片段」这些收尾动作
//
// ⚠️ 关键约定：**没有用户明确同意（accept:true）时什么都不写。**
//    分享是可选动作，插件从不替作者决定，也不替作者上传（协议第 2.2、10.1 条）。
// =============================================================================

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const DPSL_PROTOCOL = 'DPSL-1.0'
export const PET_TOPIC = 'dsh-pet'
export const LICENSE_FILE = 'DSH-PET-LICENSE.md'
export const AGREEMENT_URL =
  'https://github.com/Stellum-Waq/dsh-pet-ronaldo/blob/master/docs/PET-SHARING-AGREEMENT.md'

export const DEFAULT_STATEMENT =
  '本桌宠包由我本人创作，或我已获得其全部素材的分发授权；' +
  '我同意按 DPSL-1.0 将其收录进 DSH 桌宠社区（宠物社区 / 画廊），' +
  '并同意插件按其条款展示预览图、提供下载与一键安装。'

// ---------------------------------------------------------------------------
// 仓库地址
// ---------------------------------------------------------------------------

/**
 * 把各种写法的仓库地址规范化成 { owner, repo, key, url }。
 * 接受：owner/repo · https://github.com/owner/repo(.git) · git@github.com:owner/repo.git
 * 拒绝：非 GitHub、含子路径（除非是 /tree/<branch> 这种粘贴结果，会自动剥掉）
 */
export function parseRepoUrl(input) {
  let s = String(input || '').trim()
  if (!s) return { ok: false, error: '仓库地址为空' }
  s = s.replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '')
  let m = s.match(/^git@github\.com:([^/]+)\/(.+)$/i)
  if (m) return finish(m[1], m[2], s)
  m = s.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/.*)?$/i)
  if (m) return finish(m[1], m[2], s)
  m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  if (m) return finish(m[1], m[2], s)
  return { ok: false, error: `无法识别的仓库地址：${input}（需要 owner/repo 或 https://github.com/owner/repo）` }
}

function finish(owner, repo, raw) {
  const o = String(owner).trim()
  const r = String(repo).trim().replace(/\.git$/, '')
  if (!o || !r) return { ok: false, error: `无法识别的仓库地址：${raw}` }
  if (o.includes(' ') || r.includes(' ')) return { ok: false, error: `仓库地址含空格：${raw}` }
  return { ok: true, owner: o, repo: r, key: (o + '/' + r).toLowerCase(), url: `https://github.com/${o}/${r}` }
}

// ---------------------------------------------------------------------------
// sharing 块
// ---------------------------------------------------------------------------

/** 组一个 sharing 块（字段含义见协议附录 B）。 */
export function makeSharingBlock(opts = {}) {
  const parsed = parseRepoUrl(opts.repo || '')
  const block = {
    protocol: DPSL_PROTOCOL,
    shared: true,
    author: String(opts.author || '').trim() || '匿名作者',
    repo: parsed.ok ? parsed.url : String(opts.repo || '').trim(),
    license: String(opts.license || DPSL_PROTOCOL),
    tags: Array.isArray(opts.tags) ? opts.tags.slice(0, 8) : [],
    allowRemix: opts.allowRemix !== false,
    allowCommercial: opts.allowCommercial === true,
    attribution: String(opts.attribution || opts.author || '').trim(),
    submittedAt: new Date().toISOString(),
    statement: String(opts.statement || '').trim() || DEFAULT_STATEMENT,
  }
  if (opts.preview) block.preview = String(opts.preview)
  if (opts.packagePath !== undefined) block.packagePath = String(opts.packagePath || '')
  if (opts.contact) block.contact = String(opts.contact)
  if (opts.rights) block.rights = String(opts.rights)
  return block
}

/**
 * 校验一个 sharing 块是否构成"按 DPSL-1.0 授权收录"。
 * 协议第 2.1 条的机器可读版本：protocol + shared + statement 三者齐备。
 */
export function validateSharing(sharing) {
  const errors = []
  const warnings = []
  if (!sharing || typeof sharing !== 'object') {
    return { ok: false, dpsl: false, shared: false, errors: ['没有 sharing 块：视为未采用 DPSL-1.0'], warnings }
  }
  const protocol = String(sharing.protocol || '')
  const dpsl = protocol === DPSL_PROTOCOL
  if (!dpsl) errors.push(`sharing.protocol 为 ${protocol || '(缺失)'}，不是 ${DPSL_PROTOCOL}`)
  const shared = sharing.shared === true
  if (!shared) errors.push('sharing.shared 不是 true（视为未同意收录 / 已撤回）')
  if (!String(sharing.statement || '').trim()) errors.push('sharing.statement 为空（协议第 2.1 条要求作者声明）')
  if (!String(sharing.author || '').trim()) errors.push('sharing.author 为空（画廊必须能署名）')
  const repo = parseRepoUrl(sharing.repo || '')
  if (!repo.ok) errors.push(`sharing.repo 非法：${sharing.repo || '(缺失)'}`)
  if (String(sharing.license || '') && String(sharing.license).split('+')[0].trim() !== DPSL_PROTOCOL) {
    warnings.push(`sharing.license 为 ${sharing.license}，画廊按 DPSL-1.0 解释评分与展示`)
  }
  if (sharing.allowCommercial === true) warnings.push('作者允许商业使用（画廊不会替你开启，这里是读取到的值）')
  return { ok: errors.length === 0, dpsl, shared, repo: repo.ok ? repo : null, errors, warnings }
}

// ---------------------------------------------------------------------------
// 模板
// ---------------------------------------------------------------------------

const TEMPLATE_DIR = resolve(__dirname, '..', '..', 'templates', 'pet-repo')

async function readTemplate(name) {
  const p = join(TEMPLATE_DIR, name)
  if (!existsSync(p)) return null
  try {
    return await readFile(p, 'utf8')
  } catch {
    return null
  }
}

const fill = (text, vars) =>
  String(text).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])))

/** 找协议全文（插件仓库内）。找不到就返回 null，调用方退回模板里的"通知版"。 */
export function findAgreementText(pluginRoot) {
  const candidates = []
  if (pluginRoot) candidates.push(join(pluginRoot, 'docs', 'PET-SHARING-AGREEMENT.md'))
  // 技能被单独复制到 ~/.agents/skills 时，向上找两层可能命中插件仓库
  candidates.push(resolve(__dirname, '..', '..', '..', '..', 'docs', 'PET-SHARING-AGREEMENT.md'))
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

// ---------------------------------------------------------------------------
// 分享包
// ---------------------------------------------------------------------------

/**
 * 生成分享包。**调用前必须拿到用户的明确同意**（opts.accept === true）。
 *
 * @returns {Promise<object>} 结构化结果；ok:false 时 error 说明原因
 */
export async function buildShareKit(pkgDir, opts = {}) {
  const dir = resolve(String(pkgDir || ''))
  if (!pkgDir) return { ok: false, error: '缺少宠物包目录（--pkg）' }
  if (opts.accept !== true) {
    return {
      ok: false,
      needsConsent: true,
      error: '需要用户明确同意后才能生成分享包（协议第 2.2 条：默认不共享）',
      ask: '请先询问作者：是否愿意把这个桌宠按 DPSL-1.0 发布到 GitHub 并收录进 DSH 桌宠社区？' +
           '作者同意后带上 --accept（CLI）或 accept:true（HTTP）再调用一次。',
      options: ['愿意共享（accept:true）', '暂不共享（不写任何文件）', '稍后再说（不写任何文件）'],
    }
  }
  const petJsonPath = join(dir, 'pet.json')
  if (!existsSync(petJsonPath)) {
    return { ok: false, error: `该目录下没有 pet.json：${dir}` }
  }
  let manifest
  try {
    manifest = JSON.parse(await readFile(petJsonPath, 'utf8'))
  } catch (err) {
    return { ok: false, error: `pet.json 解析失败：${err.message}` }
  }

  const parsedRepo = parseRepoUrl(opts.repo || '')
  const warnings = []
  if (opts.repo && !parsedRepo.ok) {
    return { ok: false, error: parsedRepo.error }
  }
  if (!opts.repo) {
    warnings.push('没有提供 --repo：sharing.repo 先留空，推到 GitHub 后请补上（画廊靠它核对署名与来源）')
  }

  const preview = opts.preview || detectPreview(dir)
  const sharing = makeSharingBlock({
    ...opts,
    repo: parsedRepo.ok ? parsedRepo.url : '',
    preview,
    packagePath: opts.packagePath !== undefined ? opts.packagePath : '',
    tags: Array.isArray(opts.tags) && opts.tags.length ? opts.tags : (manifest.tags || []),
  })
  const check = validateSharing(sharing)
  if (opts.repo && !check.ok) return { ok: false, error: '生成的 sharing 块不合法：' + check.errors.join('；') }

  manifest.sharing = sharing
  await writeFile(petJsonPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  // 索引条目先算出来：SHARING.md 模板里要嵌入它，用户可以直接粘进 gallery/index.json
  const indexEntry = {
    key: parsedRepo.ok ? parsedRepo.key : 'owner/repo',
    repo: sharing.repo || 'https://github.com/owner/repo',
    name: manifest.name || manifest.id,
    author: sharing.author,
    description: (opts.description || manifest.description || `${manifest.name || manifest.id} · DSH 桌宠`).slice(0, 200),
    tags: sharing.tags || [],
    protocol: DPSL_PROTOCOL,
    license: sharing.license || DPSL_PROTOCOL,
    packagePath: sharing.packagePath || '',
    preview: sharing.preview,
    contact: sharing.contact,
    addedAt: new Date().toISOString(),
    revoked: false,
    hidden: false,
  }

  const vars = {
    name: manifest.name || manifest.id,
    id: manifest.id,
    author: sharing.author,
    repo: sharing.repo || '(把你的仓库地址填在这里)',
    indexEntryJson: JSON.stringify(indexEntry, null, 2),
    protocol: DPSL_PROTOCOL,
    agreementUrl: AGREEMENT_URL,
    topic: PET_TOPIC,
    preview: preview || 'preview.png',
    statement: sharing.statement,
    rights: sharing.rights || '',
    tagList: (sharing.tags || []).join(', '),
    cols: (manifest.atlas && manifest.atlas.cols) || 8,
    rows: (manifest.atlas && manifest.atlas.rows) || 11,
    cellW: (manifest.atlas && manifest.atlas.cellW) || 192,
    cellH: (manifest.atlas && manifest.atlas.cellH) || 208,
    atlasFile: (manifest.atlas && manifest.atlas.file) || 'atlas.png',
  }

  const written = []
  const skipped = []

  // 协议副本：优先用插件仓库里的全文；拿不到就写模板里的"通知版"（含 canonical URL）
  const pluginRoot = opts.pluginRoot || process.env.DSH_PET_PLUGIN_ROOT || null
  const agreementSrc = findAgreementText(pluginRoot)
  const licensePath = join(dir, LICENSE_FILE)
  if (agreementSrc) {
    const head = `<!-- 本文件是 DPSL-1.0 协议全文副本，来源于 ${AGREEMENT_URL} -->\n\n`
    await writeFile(licensePath, head + (await readFile(agreementSrc, 'utf8')), 'utf8')
    written.push(LICENSE_FILE)
  } else {
    const tpl = await readTemplate(LICENSE_FILE)
    if (tpl) {
      await writeFile(licensePath, fill(tpl, vars), 'utf8')
      written.push(LICENSE_FILE)
    } else {
      warnings.push('没找到协议文本模板，未写出 ' + LICENSE_FILE)
    }
  }

  // README：只在不存在时生成，绝不覆盖作者已有的说明
  const readmePath = join(dir, 'README.md')
  const readmeTpl = await readTemplate('README.md')
  if (!existsSync(readmePath)) {
    if (readmeTpl) {
      await writeFile(readmePath, fill(readmeTpl, vars), 'utf8')
      written.push('README.md')
    }
  } else {
    skipped.push('README.md（已存在，保持原样）')
  }

  const sharingTpl = await readTemplate('SHARING.md')
  if (sharingTpl) {
    await writeFile(join(dir, 'SHARING.md'), fill(sharingTpl, vars), 'utf8')
    written.push('SHARING.md')
  }

  const gitignoreTpl = await readTemplate('gitignore')
  const gitignorePath = join(dir, '.gitignore')
  if (gitignoreTpl && !existsSync(gitignorePath)) {
    await writeFile(gitignorePath, fill(gitignoreTpl, vars), 'utf8')
    written.push('.gitignore')
  } else if (existsSync(gitignorePath)) {
    skipped.push('.gitignore（已存在，保持原样）')
  }

  for (const [tplName, outName] of [['publish.ps1', 'publish.ps1'], ['publish.sh', 'publish.sh']]) {
    const tpl = await readTemplate(tplName)
    if (!tpl) continue
    const out = join(dir, outName)
    if (existsSync(out)) { skipped.push(`${outName}（已存在，未覆盖）`); continue }
    await writeFile(out, fill(tpl, vars), 'utf8')
    written.push(outName)
  }

  const indexEntrySnippet = indexEntry

  return {
    ok: true,
    command: 'share',
    pkg: dir,
    petId: manifest.id,
    petName: manifest.name || manifest.id,
    sharing,
    files: written,
    skipped,
    warnings,
    previewFile: preview,
    topic: PET_TOPIC,
    next: {
      steps: [
        '1. 检查刚生成的 README.md / SHARING.md，确认署名与素材权利说明写得对',
        '2. 跑 publish.ps1（或 publish.sh）初始化仓库并推送 —— 插件不会替你 push',
        `3. 到 GitHub 仓库页给仓库加 topic：${PET_TOPIC}（About → ⚙️ → Topics）`,
        '4. 回插件「设置 → ⚽ 桌宠 → 🌐 宠物社区」点刷新，看到自己那只就说明收录成功',
      ],
      commands: [
        'git init',
        'git add -A',
        'git commit -m "pet: ' + (manifest.name || manifest.id) + ' (DPSL-1.0)"',
        'git branch -M main',
        'git remote add origin ' + (sharing.repo || '<你的仓库地址>'),
        'git push -u origin main',
      ],
      topic: PET_TOPIC,
      indexEntry: indexEntrySnippet,
      indexPrHint: '可选：把 indexEntry 这一项加进 dsh-ronaldo-pet 的 gallery/index.json（提 PR），可让收录不依赖 topic 自动发现。',
    },
  }
}

/** 在宠物包里找一个像样的预览图。 */
export function detectPreview(dir) {
  const candidates = [
    'preview.png', 'preview.webp', 'preview.jpg',
    'docs/preview.png', 'assets/preview.png', 'screenshots/preview.png',
    // 动作总表比原始图集好看得多，所以排在 atlas.png 之前
    'inspect-sheet.png', 'docs/preview.webp',
    'atlas.png', 'assets/atlas.png',
  ]
  for (const c of candidates) {
    if (existsSync(join(dir, c))) return c
  }
  return null
}
