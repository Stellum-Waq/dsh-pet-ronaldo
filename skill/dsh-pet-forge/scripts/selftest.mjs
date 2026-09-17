#!/usr/bin/env node
// =============================================================================
// dsh-pet-forge · 自检脚本
// -----------------------------------------------------------------------------
// 不联网、不依赖外部素材也能跑：用程序化生成的测试角色验证
//   PNG 编解码往返 → 抠底 → 规范化落格 → 各动作渲染 → 图集合成 → 图集审计
// 全链路是否成立。任何一步失败都会以非 0 退出码结束，便于在 CI / 装机检查里用。
//
//   node scripts/selftest.mjs [--out <输出目录>]
// =============================================================================

import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { newImg, setPixel, removeBackground, frameStats, savePng, encodeImage } from './lib/imaging.mjs'
import { decodePng } from './lib/png.mjs'
import { renderPetRows, renderAction, composeAtlas, auditAtlas, ACTION_LIBRARY } from './lib/anim.mjs'
import { encodeWav, synthSfx, SFX_PRESETS, ttsAvailable, listVoices } from './lib/audio.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const outDir = resolve(argAfter(args, '--out') || join(__dirname, '..', '.selftest'))

function argAfter(list, flag) {
  const i = list.indexOf(flag)
  return i >= 0 ? list[i + 1] : undefined
}

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok   ${name}${detail ? '  — ' + detail : ''}`)
  } else {
    failures++
    console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`)
  }
}

/** 程序化画一只"测试史莱姆"：白色背景上一个圆身 + 两只眼 + 一对耳朵。 */
function drawTestCharacter(w = 512, h = 512) {
  const img = newImg(w, h, [255, 255, 255, 255])
  const cx = w / 2
  const bodyCy = h * 0.62
  const bodyR = w * 0.28
  const headCy = h * 0.38
  const headR = w * 0.22
  const inCircle = (x, y, ox, oy, r) => (x - ox) ** 2 + (y - oy) ** 2 <= r * r
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let col = null
      if (inCircle(x, y, cx, bodyCy, bodyR)) col = [110, 200, 255]
      if (inCircle(x, y, cx, headCy, headR)) col = [140, 220, 255]
      // 耳朵（两个小三角近似为圆）
      if (inCircle(x, y, cx - headR * 0.75, headCy - headR * 0.7, w * 0.055)) col = [95, 185, 245]
      if (inCircle(x, y, cx + headR * 0.75, headCy - headR * 0.7, w * 0.055)) col = [95, 185, 245]
      // 眼睛
      if (inCircle(x, y, cx - headR * 0.35, headCy + headR * 0.1, w * 0.032)) col = [30, 40, 60]
      if (inCircle(x, y, cx + headR * 0.35, headCy + headR * 0.1, w * 0.032)) col = [30, 40, 60]
      // 高光
      if (inCircle(x, y, cx - headR * 0.35 - 3, headCy + headR * 0.1 - 3, w * 0.011)) col = [255, 255, 255]
      if (inCircle(x, y, cx + headR * 0.35 - 3, headCy + headR * 0.1 - 3, w * 0.011)) col = [255, 255, 255]
      if (col) setPixel(img, x, y, col[0], col[1], col[2], 255)
    }
  }
  return img
}

async function main() {
  console.log('dsh-pet-forge 自检')
  console.log('输出目录：' + outDir)
  await mkdir(outDir, { recursive: true })

  // ---------- 1. PNG 往返 ----------
  console.log('\n[1] PNG 编解码往返')
  const src = drawTestCharacter()
  const enc = encodeImage(src)
  const dec = decodePng(enc)
  check('尺寸一致', dec.width === src.width && dec.height === src.height, `${dec.width}×${dec.height}`)
  let diff = 0
  for (let i = 0; i < dec.data.length; i++) if (dec.data[i] !== src.data[i]) diff++
  check('像素零差异（无损）', diff === 0, `差异字节 ${diff}`)
  check('体积合理', enc.length < src.width * src.height * 4 * 0.5, `${(enc.length / 1024).toFixed(1)} KB`)
  await writeFile(join(outDir, '0-source.png'), enc)

  // ---------- 2. 抠底 ----------
  console.log('\n[2] 背景移除')
  const { img: cut, report: bgReport } = removeBackground(src, { mode: 'auto', tolerance: 40, feather: 1 })
  const st = frameStats(cut)
  check('识别为纯色背景并抠除', bgReport.mode === 'flood', JSON.stringify(bgReport.mode))
  check('已有透明像素', st.semiRatio + (1 - st.coverage) > 0, `coverage=${st.coverage.toFixed(3)}`)
  // 角色本体不该被抠掉（中心点仍不透明）
  const ci = ((cut.height / 2 | 0) * cut.width + (cut.width / 2 | 0)) * 4
  check('角色中心未被误删', cut.data[ci + 3] > 200, `alpha=${cut.data[ci + 3]}`)
  await savePng(cut, join(outDir, '1-cutout.png'))

  // ---------- 4. 全部动作渲染（两趟统一缩放） ----------
  console.log('\n[4] 全部动作渲染 + 两趟全局缩放')
  const t0 = Date.now()
  const { rowFrames, report } = renderPetRows(cut, {
    cellW: 192, cellH: 208, cols: 8,
    actions: Object.keys(ACTION_LIBRARY),
  })
  const elapsed = Date.now() - t0
  check('渲染出全动作', Object.keys(rowFrames).length >= 10, `${Object.keys(rowFrames).length} 行 / ${elapsed}ms`)
  let sizeBad = 0
  for (const frames of Object.values(rowFrames)) {
    for (const f of frames) if (f.width !== 192 || f.height !== 208) sizeBad++
  }
  check('每一帧都严格 192×208', sizeBad === 0, sizeBad ? `${sizeBad} 帧越界` : '')
  const scales = Object.values(report.actions).map((a) => a.scale)
  check('统一缩放系数一致（loose 动作除外）', (() => {
    const strict = Object.entries(report.actions).filter(([, a]) => !a.loose).map(([, a]) => a.scale)
    return new Set(strict.map((s) => s.toFixed(3))).size === 1
  })(), `系数 ${[...new Set(scales.map((s) => s.toFixed(3)))].join(', ')}`)

  // ---------- 5. 图集合成 ----------
  console.log('\n[5] 图集合成')
  const atlas = composeAtlas({ cols: 8, rows: 11, cellW: 192, cellH: 208, rowFrames })
  check('无合成告警', atlas.warnings.length === 0, atlas.warnings.join('; '))
  check('图集尺寸 1536×2288', atlas.img.width === 1536 && atlas.img.height === 2288, `${atlas.img.width}×${atlas.img.height}`)
  const atlasBytes = encodeImage(atlas.img)
  await writeFile(join(outDir, 'atlas.png'), atlasBytes)
  check('图集可无损回读', (() => {
    const b = decodePng(atlasBytes)
    if (b.width !== 1536 || b.height !== 2288) return false
    for (let i = 0; i < b.data.length; i += 997) if (b.data[i] !== atlas.img.data[i]) return false
    return true
  })())
  console.log(`       （图集 ${(atlasBytes.length / 1024).toFixed(1)} KB）`)

  // ---------- 6. 图集审计 ----------
  console.log('\n[6] 图集审计（防裁切 / 防串帧）')
  const problems = auditAtlas(atlas.img, { cols: 8, rows: 11, cellW: 192, cellH: 208 })
  check('未检出边缘裁切或串帧', problems.length === 0, problems.slice(0, 3).map((p) => p.detail).join(' | '))

  // ---------- 7. 未使用行必须全透明 ----------
  console.log('\n[7] 未使用格全透明（契约要求）')
  const sparse = renderPetRows(cut, { cellW: 192, cellH: 208, cols: 8, actions: ['idle'], looseActions: [] })
  const sparseAtlas = composeAtlas({ cols: 8, rows: 11, cellW: 192, cellH: 208, rowFrames: sparse.rowFrames })
  let dirty = 0
  for (let row = 1; row < 11; row++) {
    for (let y = row * 208; y < (row + 1) * 208; y++) {
      for (let x = 0; x < 1536; x++) {
        if (sparseAtlas.img.data[(y * 1536 + x) * 4 + 3] !== 0) dirty++
      }
    }
  }
  check('只渲染 idle 时其余行完全透明', dirty === 0, `非透明像素 ${dirty}`)
  check('idle 行确实有内容', (() => {
    for (let y = 0; y < 208; y++) for (let x = 0; x < 1536; x++) {
      if (sparseAtlas.img.data[(y * 1536 + x) * 4 + 3] > 8) return true
    }
    return false
  })())

  // ---------- 8. 音频 ----------
  console.log('\n[8] 音频合成')
  for (const [key, preset] of Object.entries(SFX_PRESETS)) {
    const samples = preset.build()
    const wav = encodeWav(samples)
    const ok = wav.length > 44 && wav.toString('latin1', 0, 4) === 'RIFF' && wav.toString('latin1', 8, 12) === 'WAVE'
    check(`${key} 生成合法 WAV`, ok, `${(wav.length / 1024).toFixed(1)} KB / ${(samples.length / 22050).toFixed(2)}s`)
    if (key === 'celebrate') await writeFile(join(outDir, 'celebrate.wav'), wav)
  }
  console.log('      TTS 可用：' + (ttsAvailable() ? '是' : '否（仅 Windows）'))
  if (ttsAvailable()) {
    const voices = listVoices()
    console.log('      已安装语音：' + (voices.length ? voices.map((v) => `${v.name}(${v.culture})`).join(', ') : '（读取失败，不影响主流程）'))
  }

  console.log('\n' + (failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`))
  console.log('产物在：' + outDir)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n自检异常：', err)
  process.exit(1)
})
