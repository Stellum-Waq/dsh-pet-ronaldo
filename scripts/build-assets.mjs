#!/usr/bin/env node
// =============================================================================
// 生成桌面版（原生窗口）用的 PNG 素材。
// -----------------------------------------------------------------------------
// 为什么需要：网页版用的是 WebP（体积小），但**原生桌面窗口走的是 WPF/WIC 解码器**，
// WPF 默认不支持 WebP（除非系统装了 WebpImageExtension）。所以内置素材要同时提供
// 一份 PNG，桌面窗口优先取 PNG，网页仍取 WebP。
//
//   node scripts/build-assets.mjs
// =============================================================================

import { readFile, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const ASSETS = join(REPO, 'assets')

const { trySharp } = await import(pathToFileURL(join(REPO, 'skill', 'dsh-pet-forge', 'scripts', 'lib', 'imaging.mjs')).href)
const { encodeImage, loadImage } = await import(pathToFileURL(join(REPO, 'skill', 'dsh-pet-forge', 'scripts', 'lib', 'imaging.mjs')).href)

async function main() {
  const webpPath = join(ASSETS, 'spritesheet.webp')
  const pngPath = join(ASSETS, 'spritesheet.png')
  if (!existsSync(webpPath)) {
    console.error('缺少 ' + webpPath)
    process.exit(1)
  }
  const srcSize = (await stat(webpPath)).size
  const sharp = trySharp()
  let bytes
  let how
  let srcDensity = null
  if (sharp) {
    // ⚠️ 必须显式写 density: 96。
    // 源 WebP 的 density 元数据是 25.4，sharp 默认会原样带进 PNG 的 pHYs 块；
    // 而 WPF 会按 DPI 换算图片的 DIP 尺寸（DIP = 像素 * 96 / DPI）：
    // 25.4 DPI 时 1536px 的图被当成 5805 DIP 宽，任何按 DIP 取帧的写法
    // （ImageBrush.Viewbox 这类）都只会框到左上角约 3% —— 宠物被放大到只剩个头。
    // 桌面端已经改用按像素取帧的 CroppedBitmap 免疫了这个坑，
    // 但素材本身也不该带这种脏元数据，尤其是别人拿去做别的渲染时。
    try { srcDensity = (await sharp(webpPath).metadata()).density } catch { /* 忽略 */ }
    bytes = await sharp(webpPath).png({ compressionLevel: 9, effort: 10, palette: false }).withMetadata({ density: 96 }).toBuffer()
    how = 'sharp'
  } else {
    // 退路：本技能自带的 PNG 编码器（它本来就不写 pHYs，等价于 96dpi）
    const img = await loadImage(webpPath)
    bytes = encodeImage(img)
    how = 'pure-node'
  }
  await writeFile(pngPath, bytes)
  console.log(`✅ 生成 ${pngPath}`)
  console.log(`   WebP ${(srcSize / 1024 / 1024).toFixed(2)} MB → PNG ${(bytes.length / 1024 / 1024).toFixed(2)} MB（编码器：${how}）`)
  if (srcDensity && Math.abs(srcDensity - 96) > 1) {
    console.log(`   ⚠️ 源文件 density = ${srcDensity}（非 96），已强制改写为 96，避免 WPF 按 DPI 误算尺寸`)
  }
}

main().catch((err) => {
  console.error(String(err && err.message || err))
  process.exit(1)
})
