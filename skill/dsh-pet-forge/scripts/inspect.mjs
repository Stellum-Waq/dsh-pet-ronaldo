#!/usr/bin/env node
// =============================================================================
// dsh-pet-forge · 图集目视检查工具
// -----------------------------------------------------------------------------
// 把图集里的帧按"放大 + 棋盘底"重排成一张检查图，方便人和视觉模型确认：
//   · 每格是否恰好一个完整角色（没有缺头/断腿/串帧）
//   · 透明边缘是否干净（没有白边残留）
//   · 各动作之间体型是否一致
//
// 既可当 CLI 用，也可当库用（`inspectAtlas`）——forge.mjs 走库调用，
// 因为沙箱禁止捕获子进程输出（管道 EPERM）。
//
//   node scripts/inspect.mjs <atlas.png> [--out sheet.png] [--rows 0,1,4] [--zoom 2]
// =============================================================================

import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { decodeImage, newImg, composite, resize, encodeImage, crop, alphaBounds } from './lib/imaging.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

function argAfter(list, flag) {
  const i = list.indexOf(flag)
  return i >= 0 ? list[i + 1] : undefined
}

/**
 * 生成检查图。
 * @param {string} atlasPath
 * @param {object} o { out, cols, cellW, cellH, zoom, rows }
 * @returns {Promise<{path:string, width:number, height:number, rows:number[], perCell:Array}>}
 */
export async function inspectAtlas(atlasPath, o = {}) {
  const cols = Number(o.cols || 8)
  const cellW = Number(o.cellW || 192)
  const cellH = Number(o.cellH || 208)
  const zoom = Number(o.zoom || 2)
  const out = resolve(o.out || join(dirname(resolve(atlasPath)), 'inspect-sheet.png'))

  const atlas = await decodeImage(await readFile(atlasPath))
  const totalRows = Math.floor(atlas.height / cellH)
  const rows = Array.isArray(o.rows)
    ? o.rows
    : o.rows ? String(o.rows).split(',').map((s) => Number(s.trim())).filter(Number.isInteger)
      : Array.from({ length: totalRows }, (_, i) => i)

  const gap = 6 * zoom
  const scalW = Math.round(cellW * zoom)
  const scalH = Math.round(cellH * zoom)
  const sheetW = cols * scalW + (cols + 1) * gap
  const sheetH = rows.length * scalH + (rows.length + 1) * gap
  const sheet = newImg(sheetW, sheetH)

  // 棋盘底：让透明区域可见，一眼看出边缘有没有脏像素
  const checker = 8 * zoom
  for (let y = 0; y < sheetH; y++) {
    for (let x = 0; x < sheetW; x++) {
      const on = ((x / checker) | 0) + ((y / checker) | 0)
      const v = on % 2 === 0 ? 205 : 232
      const i = (y * sheetW + x) * 4
      sheet.data[i] = v; sheet.data[i + 1] = v; sheet.data[i + 2] = v; sheet.data[i + 3] = 255
    }
  }

  // 顺带算一下每格的落位，方便判断"角色是否在格子里偏心/贴边"
  const perCell = []
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri]
    if (row < 0 || row >= totalRows) continue
    for (let c = 0; c < cols; c++) {
      const cell = crop(atlas, c * cellW, row * cellH, cellW, cellH)
      const b = alphaBounds(cell, 8)
      perCell.push({
        row, col: c,
        empty: b === null,
        bounds: b,
        touchesEdge: b !== null && (b.x <= 0 || b.y <= 0 || b.x + b.width >= cellW || b.y + b.height >= cellH),
      })
      const scaled = resize(cell, scalW, scalH)
      composite(sheet, scaled, gap + c * (scalW + gap), gap + ri * (scalH + gap))
    }
  }

  await writeFile(out, encodeImage(sheet))
  return { path: out, width: sheetW, height: sheetH, rows, perCell }
}

async function main() {
  const args = process.argv.slice(2)
  const atlasPath = args.find((a) => !a.startsWith('--'))
  if (!atlasPath) {
    console.error('用法：node scripts/inspect.mjs <atlas.png> [--out sheet.png] [--rows 0,1,4] [--zoom 2] [--cols 8 --cell-w 192 --cell-h 208]')
    process.exit(2)
  }
  const r = await inspectAtlas(atlasPath, {
    out: argAfter(args, '--out'),
    cols: argAfter(args, '--cols'),
    cellW: argAfter(args, '--cell-w'),
    cellH: argAfter(args, '--cell-h'),
    zoom: argAfter(args, '--zoom'),
    rows: argAfter(args, '--rows'),
  })
  const bad = r.perCell.filter((c) => c.touchesEdge)
  console.log(r.path)
  console.log(`行 ${r.rows.join(',')} × 列 ${r.perCell.length / Math.max(1, r.rows.length)} · 放大后 ${r.width}×${r.height}`)
  console.log(bad.length
    ? `⚠️ ${bad.length} 格贴到格子边缘（可能被裁切）：` + bad.slice(0, 8).map((c) => `r${c.row}c${c.col}`).join(' ')
    : '✅ 没有格子贴边（无裁切迹象）')
}

// 只有直接执行时才跑 CLI（被 import 时不跑）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(String(err && err.message || err))
    process.exit(1)
  })
}
