#!/usr/bin/env node
// =============================================================================
// 验证「图集 DPI 会毁掉 ImageBrush 取帧」这个假设。
//
// 线索：探针打印出 assets/spritesheet.png 的 dpi = 25.4（而不是 96）。
//   ImageBrush.Viewbox 用 Absolute 单位时，坐标是「源图片的 DIP 尺寸」，
//   而 DIP = 像素 * 96 / DPI。DPI=25.4 时，1536px 的图在 WPF 眼里宽 5805 DIP，
//   于是 Viewbox=(0,0,192,208) 只框住了左上角 3% —— 画面被极度放大，
//   看起来就是"头特别大、身体没了"。
//
// 做法：同一张图分别按原 DPI 和强制 96 DPI 渲染，比较结果。
//   强制 96 DPI 的办法：用本技能自带的纯 Node PNG 编码器重新编码（不写 pHYs 块）。
//
//   node scripts/rtb-probe.mjs
// =============================================================================

import { execFileSync } from 'node:child_process'
import { mkdtemp, copyFile, readFile, writeFile } from 'node:fs/promises'
import { writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')
const { decodeImage, encodeImage, crop, resize, alphaBounds } = await import(
  pathToFileURL(join(REPO, 'skill', 'dsh-pet-forge', 'scripts', 'lib', 'imaging.mjs')).href)

const tmp = await mkdtemp(join(tmpdir(), 'rtb-probe-'))
const sheetRaw = join(tmp, 'sheet-raw.png')     // 原样（dpi 25.4）
const sheet96 = join(tmp, 'sheet-96.png')       // 重新编码，无 pHYs => WPF 视为 96dpi
await copyFile(join(REPO, 'assets', 'spritesheet.png'), sheetRaw)
await writeFile(sheet96, encodeImage(await decodeImage(await readFile(sheetRaw))))

const CW = 192, CH = 208, ROW = 0, COL = 0

const ps = `
param([string]$Sheet, [string]$Tag, [int]$W, [int]$H, [string]$OutDir)
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$atlas = New-Object System.Windows.Media.Imaging.BitmapImage
$atlas.BeginInit()
$atlas.UriSource = New-Object System.Uri($Sheet)
$atlas.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
$atlas.EndInit()
Write-Output ("[$Tag] atlas px=" + $atlas.PixelWidth + "x" + $atlas.PixelHeight +
  "  dpi=" + [Math]::Round($atlas.DpiX,1) +
  "  在WPF眼里的DIP尺寸=" + [Math]::Round($atlas.Width,0) + "x" + [Math]::Round($atlas.Height,0))

function Save-Visual($visual, [int]$w, [int]$h, $file) {
  [void]$visual.Measure((New-Object System.Windows.Size($w, $h)))
  [void]$visual.Arrange((New-Object System.Windows.Rect(0, 0, $w, $h)))
  [void]$visual.UpdateLayout()
  $rtb = New-Object System.Windows.Media.Imaging.RenderTargetBitmap -ArgumentList @($w, $h, 96.0, 96.0, [System.Windows.Media.PixelFormats]::Pbgra32)
  $rtb.Render($visual)
  $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
  $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create([System.Windows.Media.Imaging.BitmapSource]$rtb))
  $fs = [System.IO.File]::Create($file)
  $enc.Save($fs)
  $fs.Close()
}

function New-CellVisual([string]$kind) {
  $grid = New-Object System.Windows.Controls.Grid
  $grid.Width = $W; $grid.Height = $H
  $el = $null
  if ($kind -eq 'brush') {
    $el = New-Object System.Windows.Shapes.Rectangle
    $b = New-Object System.Windows.Media.ImageBrush
    $b.ImageSource = $atlas
    $b.Stretch = [System.Windows.Media.Stretch]::Fill
    $b.ViewboxUnits = [System.Windows.Media.BrushMappingMode]::Absolute
    $b.Viewbox = New-Object System.Windows.Rect((${COL} * ${CW}), (${ROW} * ${CH}), ${CW}, ${CH})
    $el.Fill = $b
  } elseif ($kind -eq 'cropped') {
    $el = New-Object System.Windows.Controls.Image
    $el.Stretch = [System.Windows.Media.Stretch]::Fill
    $cb = New-Object System.Windows.Media.Imaging.CroppedBitmap
    $cb.BeginInit()
    $cb.Source = $atlas
    $cb.SourceRect = New-Object System.Windows.Int32Rect((${COL} * ${CW}), (${ROW} * ${CH}), ${CW}, ${CH})
    $cb.EndInit()
    $el.Source = $cb
  } else {
    $el = New-Object System.Windows.Shapes.Rectangle
    $el.Fill = [System.Windows.Media.Brushes]::Red
  }
  $el.Width = $W; $el.Height = $H
  [void]$grid.Children.Add($el)
  return $grid
}

foreach ($kind in @('solid','brush','cropped')) {
  $v = New-CellVisual $kind
  Save-Visual $v $W $H (Join-Path $OutDir ("$Tag-$kind.png"))
}
Write-Output "[$Tag] done"
`
const psFile = join(tmp, 'probe.ps1')
writeFileSync(psFile, ps, 'ascii')

for (const [tag, sheet] of [['raw', sheetRaw], ['dpi96', sheet96]]) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', psFile, '-Sheet', sheet, '-Tag', tag, '-W', '129', '-H', '140', '-OutDir', tmp], { encoding: 'utf8', timeout: 180000 })
  process.stdout.write(out)
}

const ref = crop(await decodeImage(await readFile(sheet96)), COL * CW, ROW * CH, CW, CH)
const refB = alphaBounds(ref, 8)
console.log(`\n参考：格 row${ROW} col${COL} 角色 ${refB.width}x${refB.height}（占格 ${(refB.width / CW * 100).toFixed(0)}% x ${(refB.height / CH * 100).toFixed(0)}%）`)

console.log('\n  用例'.padEnd(20) + '尺寸      角色占比（应≈49% x 91%）   与参考色差')
console.log('  ' + '-'.repeat(76))
for (const f of readdirSync(tmp).filter((x) => x.endsWith('.png') && (x.startsWith('raw-') || x.startsWith('dpi96-'))).sort()) {
  const img = await decodeImage(await readFile(join(tmp, f)))
  const b = alphaBounds(img, 8)
  const scaled = resize(ref, img.width, img.height)
  let d = 0
  for (let i = 0; i < scaled.data.length; i += 4) {
    d += Math.abs(scaled.data[i] - img.data[i]) + Math.abs(scaled.data[i + 1] - img.data[i + 1]) +
      Math.abs(scaled.data[i + 2] - img.data[i + 2]) + Math.abs(scaled.data[i + 3] - img.data[i + 3])
  }
  const avg = (d / (scaled.data.length / 4) / 4).toFixed(1)
  const pct = b ? `${(b.width / img.width * 100).toFixed(0)}% x ${(b.height / img.height * 100).toFixed(0)}%` : '（空）'
  console.log('  ' + f.replace('.png', '').padEnd(18) + `${img.width}x${img.height}`.padEnd(10) + pct.padEnd(30) + avg)
}
console.log('\n（"dpi96-brush" 若突然接近参考，就证实了 DPI 假设）')
console.log('临时目录：' + tmp)
