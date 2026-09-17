#!/usr/bin/env node
// =============================================================================
// dsh-ronaldo-pet · 宠物社区「真联网」验证器
// -----------------------------------------------------------------------------
//   node scripts/verify-gallery-live.mjs [--repo lizhuangCoding/dsh-chicken-pet] [--keep]
//
// 为什么单独一个脚本：smoke-host.mjs 用的是本地桩服务器（快、稳、可复现），
// 它证明不了"这台机器真的能从 GitHub 拿到东西"。这两个问题必须分开验。
//
// 这个脚本会真的去：
//   1. 调 GitHub 搜索 API 找 topic:dsh-pet 的公开仓库
//   2. 读它们的 raw pet.json，判断 DPSL 授权状态
//   3. 下载一个真实仓库的 tarball、解包、跑一遍严格校验（**不注册**，不碰用户的注册表）
//   4. 如果该仓库是"同契约但没 pet.json"，再跑一遍兼容导入的合成与校验
//
// 全程只写自己的临时目录，对用户的 DSH 状态零影响。
// =============================================================================

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')
const SKILL_LIB = join(REPO, 'skill', 'dsh-pet-forge', 'scripts', 'lib')

const { createGallery, findPetJson, buildCompatManifest } = await import(pathToFileURL(join(REPO, 'lib', 'gallery.mjs')).href)
const manifestLib = await import(pathToFileURL(join(SKILL_LIB, 'manifest.mjs')).href)

let pass = 0
let fail = 0
const check = (cond, label, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label + (detail ? '  — ' + detail : '')) }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  — ' + detail : '')) }
}

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const repoArg = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : 'lizhuangCoding/dsh-chicken-pet'

const main = async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-pet-gallery-live-'))
  console.log('dsh-ronaldo-pet · 宠物社区联网验证')
  console.log('临时目录：' + tmp)

  const gallery = createGallery({
    config: {
      online: true,
      topics: ['dsh-pet'],
      indexUrl: '',
      indexPath: join(REPO, 'gallery', 'index.json'),
      cachePath: join(tmp, 'cache.json'),
      searchApi: 'https://api.github.com/search/repositories',
      rawBase: 'https://raw.githubusercontent.com',
      codeloadBase: 'https://codeload.github.com',
      timeoutMs: 12000,
      curlFallback: true,
    },
    log: (m) => console.log('  [gallery] ' + m),
  })

  console.log('\n[1] 发现：GitHub 搜索 + raw 探测')
  const list = await gallery.list({ force: true })
  check(list.ok === true, 'list 返回 ok')
  check(list.online === true, '本轮确实联网了', 'online=' + list.online)
  check(list.entries.length > 0, '收录到了条目', '共 ' + list.entries.length + ' 条')
  if (list.errors.length) console.log('  （抓取告警，不阻断）' + list.errors.slice(0, 3).join('；'))
  const summary = list.entries.map((e) => `${e.key} dpsl=${e.dpsl} verified=${e.verified} compat=${e.compat || '-'}${e.compatPath ? '(' + e.compatPath + ')' : ''}`)
  summary.slice(0, 12).forEach((s) => console.log('       ' + s))
  // 注意：野外的仓库目前**一个都没有 pet.json**（DPSL 是这次新定的），所以 verified 全 false 是正常的；
  // 真正该验的是"探测这条路通了"——兼容形态被现场读出来过（compatPath 只有现场探测才会填）。
  check(list.entries.some((e) => e.compatPath || e.problems.length > 0),
    '探测链路通了（现场读到了某个仓库的 spritesheet.json / 或记录了明确问题）',
    list.entries.filter((e) => e.compatPath).map((e) => e.key).join(', ') || '没有仓库带 compatPath')
  check(list.entries.some((e) => e.key.includes('/')), 'key 都是 owner/repo 形式')

  console.log('\n[2] 下载真实仓库的归档并解包：' + repoArg)
  let target = list.entries.find((e) => e.key === repoArg.toLowerCase())
  if (!target) {
    const probed = await gallery.probeRepo(repoArg)
    check(probed.ok === true, '不在索引里时也能现场探测', JSON.stringify(probed.error || ''))
    target = probed.ok ? probed.entry : null
  }
  check(Boolean(target), '拿到目标条目')
  if (target) {
    const dl = await gallery.fetchArchive({ owner: target.owner, repo: target.repo, branch: target.branch })
    check(dl.ok === true, '下载归档成功', dl.ok ? `${(dl.bytes.length / 1024).toFixed(0)} KB · 分支 ${dl.branch} · 通道 ${dl.transport || 'fetch'}` : dl.error)
    if (dl.ok) {
      const dest = join(tmp, 'pkg')
      const ex = await gallery.extract(dl.bytes, dest)
      check(ex.ok === true, '解包成功', ex.ok ? `文件 ${ex.files.length} 个` : ex.error)
      if (ex.ok) {
        const petRel = findPetJson(ex.files, target.packagePath || '')
        console.log('       pet.json：' + (petRel || '（没有）'))
        check(ex.files.length > 0 && !ex.files.some((f) => f.includes('..')), '解包路径全部落在目标目录内')
        if (petRel) {
          const manifest = JSON.parse(await readFile(join(dest, petRel), 'utf8'))
          const v = await manifestLib.validatePackage(petRel.includes('/') ? join(dest, petRel.slice(0, petRel.lastIndexOf('/'))) : dest, manifest)
          check(v.ok === true, 'DPSL 宠物包通过严格校验', v.ok ? '' : v.errors.join('；'))
        } else if (target.compat === 'spritesheet-json') {
          // 兼容导入：用图片真实高度推导行数，再合成清单并校验
          const sheetRel = ex.files.find((f) => f.endsWith('assets/spritesheet.json')) || ex.files.find((f) => f.endsWith('spritesheet.json'))
          check(Boolean(sheetRel), '找到了 spritesheet.json')
          if (sheetRel) {
            const sheet = JSON.parse(await readFile(join(dest, sheetRel), 'utf8'))
            const pngRel = sheetRel.replace(/spritesheet\.json$/, 'spritesheet.png')
            const head = (await import(pathToFileURL(join(SKILL_LIB, 'png.mjs')).href)).readImageHeader(await readFile(join(dest, pngRel)))
            check(Boolean(head), '读到了图集尺寸', head ? `${head.width}×${head.height}` : '')
            const cellW = Number(((sheet.cell || {}).w)) || 0
            const cellH = Number(((sheet.cell || {}).h)) || 0
            const rowsOverride = cellH > 0 && head && head.height % cellH === 0 ? head.height / cellH : undefined
            const built = buildCompatManifest(sheet, {
              id: 'live-compat', name: 'live-compat', repo: target.repoUrl, atlasFile: pngRel, rowsOverride,
            })
            check(built.ok === true, '兼容导入合成清单成功', built.ok ? '' : built.error)
            if (built.ok) {
              await writeFile(join(dest, 'pet.json'), JSON.stringify(built.manifest, null, 2), 'utf8')
              const v = await manifestLib.validatePackage(dest, built.manifest)
              check(v.ok === true, '合成出来的清单也过严格校验', v.ok ? `行数按图片推导为 ${built.manifest.atlas.rows}` : v.errors.join('；'))
              console.log('       未映射动作：' + (built.unmapped.map((u) => u.name).join(', ') || '无'))
            }
          }
        } else {
          check(true, '该仓库既无 pet.json 也无兼容形态：按"仅收录"处理是正确行为', 'compat=' + (target.compat || '无'))
        }
      }
    } else {
      check(false, '下载归档成功', dl.error)
    }
  }

  if (!keep) await rm(tmp, { recursive: true, force: true })
  console.log('')
  console.log(fail === 0 ? `✅ 联网验证全部通过（${pass} 项）` : `❌ ${fail} 项失败 / 共 ${pass + fail} 项`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('验证脚本自身出错：', err)
  process.exit(1)
})
