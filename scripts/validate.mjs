// C罗桌宠 · 仓库完整性校验
// 用法：node scripts/validate.mjs
// 检查：素材存在且格式正确、bundle 插件元数据（package.json dsh.bundle / dsh.client /
// exports ./client）正确、host/client 源码结构完整、精灵图尺寸符合 8×11 契约
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
const ok = (cond, msg) => {
  console.log((cond ? '  ✔ ' : '  ✘ ') + msg)
  if (!cond) failed++
}

// ---------- 素材 ----------
const spritePath = join(root, 'assets', 'spritesheet.webp')
const voicePath = join(root, 'assets', 'siu.mp3')
ok(existsSync(spritePath), 'assets/spritesheet.webp 存在')
ok(existsSync(voicePath), 'assets/siu.mp3 存在')

if (existsSync(spritePath)) {
  const buf = readFileSync(spritePath)
  const isWebp = buf.length > 32 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP'
  ok(isWebp, 'spritesheet.webp 是合法 WebP（RIFF/WEBP 头）')
  if (isWebp) {
    const vp8x = buf.indexOf(Buffer.from('VP8X'))
    if (vp8x > 0 && buf.length > vp8x + 10) {
      const w = buf.readUIntLE(vp8x + 4, 3) + 1
      const h = buf.readUIntLE(vp8x + 7, 3) + 1
      ok(w === 1536 && h === 2288, `spritesheet.webp 尺寸为 1536×2288（实测 ${w}×${h}，契约要求 8 列 × 11 行、每格 192×208）`)
    }
  }
}
if (existsSync(voicePath)) {
  const buf = readFileSync(voicePath)
  const isMp3 = buf.length > 3 && (buf.slice(0, 3).toString('ascii') === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))
  ok(isMp3, 'siu.mp3 是合法 MP3（ID3/MPEG 头）')
  ok(buf.length > 8 * 1024, `siu.mp3 大小合理（${buf.length} bytes）`)
}

// ---------- bundle 插件元数据（dsh plugin add 安装依赖这些字段） ----------
let pkg = null
const pkgPath = join(root, 'package.json')
ok(existsSync(pkgPath), 'package.json 存在')
if (existsSync(pkgPath)) {
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    ok(true, 'package.json 是合法 JSON')
  } catch (err) {
    ok(false, `package.json 是合法 JSON（${err.message}）`)
  }
  if (pkg) {
    ok(pkg.name === 'dsh-ronaldo-pet', `package name 为 dsh-ronaldo-pet（实际 ${pkg.name}）`)
    ok(!!pkg.version, `package version 存在（${pkg.version}）`)
    const bundlePatch = pkg?.dsh?.bundle?.patch
    ok(typeof bundlePatch === 'string' && existsSync(join(root, bundlePatch)), `dsh.bundle.patch 指向存在的文件（${bundlePatch}）`)
    ok(pkg?.dsh?.client?.platform === 'web', 'dsh.client.platform 为 web')
    ok(Array.isArray(pkg?.dsh?.client?.inject), 'dsh.client.inject 为数组')
    const clientExport = pkg?.exports?.['./client']
    ok(typeof clientExport === 'string' && existsSync(join(root, clientExport)), `exports["./client"] 指向存在的文件（${clientExport}）`)
    const mainExport = pkg?.exports?.['.']
    ok(typeof mainExport === 'string' && existsSync(join(root, mainExport)), `exports["."] 指向存在的文件（${mainExport}）`)
    const engines = pkg?.engines
    ok(typeof engines?.node === 'string', 'engines.node 声明存在')
  }
}

// ---------- bundle host / client ----------
for (const [name, mustContain] of [
  ['host.js', ['export const name', 'export const inject', 'export function apply', '/ronaldo-pet/state', 'spritesheet.webp', 'import-codex', 'import-image']],
  ['client/client.js', ['__ModuleLoader__', 'shell.overlay', 'settings.section', 'ronaldo-pet', 'exports.apply', 'import-codex', 'import-image', 'ImportPanel']],
  ['cordis.patch.yml', ['insert', 'ronaldo-pet', "name: 'dsh-ronaldo-pet'"]],
]) {
  const p = join(root, name)
  ok(existsSync(p), `${name} 存在`)
  if (existsSync(p)) {
    const src = readFileSync(p, 'utf-8')
    for (const token of mustContain) ok(src.includes(token), `${name} 包含关键片段 ${token}`)
  }
}

// ---------- （遗留）旧版动态插件源码 ----------
for (const [name, mustContain] of [
  ['src/host.js', ['cordis_define', 'webServer', 'agentsService']],
  ['src/client.js', ['cordis_define', 'shell.overlay', 'CODE_STATES', 'PetSpriteRenderer']],
]) {
  const p = join(root, name)
  ok(existsSync(p), `${name} 存在`)
  if (existsSync(p)) {
    const src = readFileSync(p, 'utf-8')
    for (const token of mustContain) ok(src.includes(token), `${name} 包含关键片段 ${token}`)
  }
}

// ---------- 周边文件 ----------
for (const [name, token] of [
  ['demo/index.html', 'spritesheet'],
  ['docs/SPRITESHEET-CONTRACT.md', '192'],
  ['LICENSE', 'MIT'],
]) {
  const p = join(root, name)
  ok(existsSync(p), `${name} 存在`)
  if (existsSync(p) && !readFileSync(p, 'utf-8').includes(token)) {
    ok(false, `${name} 内容异常（缺少片段 ${token}）`)
  }
}

console.log(failed === 0 ? '\n✅ 校验通过' : `\n❌ ${failed} 项校验失败`)
process.exit(failed === 0 ? 0 : 1)
