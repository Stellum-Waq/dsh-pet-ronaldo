#!/usr/bin/env python
"""
第 7 步：确认桌宠**真的画在屏幕上了**，而且画的是**我们这一只**。

背景：插件自带 scripts/verify-desktop.mjs，它抓窗口 + 逐格比对，思路是对的，
但它第 102 行的取宠物逻辑是 `pets.find(p => p.id === (… ? p.id : p.id))` —— 恒真，
永远返回清单里**第一只**（内置的 C罗）。于是它拿别人的图集比对你的画面，
必然报"色差 23 偏大"，看起来像你的素材有问题，其实是它在比错对象。
实测：同一张抓帧，用错图集 diff=23.4 报警，用对图集 diff=2.16 完美匹配。

所以流程是：先跑插件的 verify-desktop.mjs 抓一帧（它会把帧落在仓库的
.forge-test/desktop-frame.png），再用本脚本拿**正确**的 atlas.png 重新比对。

用法：
  python verify_render.py --frame "<repo>\\.forge-test\\desktop-frame.png" \
                          --atlas "D:\\pets\\<id>\\atlas.png"
"""
import argparse
import json
import os
import sys

# Windows 上 Python 默认按控制台代码页（cp936）编码 stdout，调用方却按 UTF-8 解码，
# 中文 JSON 会变乱码。强制 UTF-8，和 Node 对齐。
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8")

try:
    import numpy as np
    from PIL import Image
except ImportError as exc:
    print(json.dumps({"ok": False, "error": "需要 pillow numpy：%s" % exc}, ensure_ascii=False))
    sys.exit(2)

# forge 图集契约固定值（列×行、格宽、格高）
CW, CH, COLS, ROWS = 192, 208, 8, 11


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frame", required=True, help="verify-desktop.mjs 抓下来的窗口帧")
    ap.add_argument("--atlas", required=True, help="我们自己的 atlas.png")
    ap.add_argument("--cell", default="192x208")
    ap.add_argument("--cols", type=int, default=COLS)
    ap.add_argument("--rows", type=int, default=ROWS)
    ap.add_argument("--pass-diff", type=float, default=12.0,
                    help="均差低于这个值就算匹配（插件自己也用 12）")
    args = ap.parse_args()

    cw, ch = (int(x) for x in args.cell.lower().split("x"))
    for p in (args.frame, args.atlas):
        if not os.path.isfile(p):
            print(json.dumps({"ok": False, "error": "文件不存在：%s" % p}, ensure_ascii=False))
            sys.exit(2)

    frame = Image.open(args.frame).convert("RGBA")
    atlas = Image.open(args.atlas).convert("RGBA")
    expect = (cw * args.cols, ch * args.rows)
    if atlas.size != expect:
        print(json.dumps({
            "ok": False,
            "error": "图集尺寸 %s 与网格契约 %s 不符（%d列×%d 宽, %d行×%d 高）"
                     % (atlas.size, expect, args.cols, cw, args.rows, ch),
        }, ensure_ascii=False))
        sys.exit(2)

    fw, fh = frame.size
    fa = np.asarray(frame).astype(np.int16)
    ys, xs = np.nonzero(np.asarray(frame)[:, :, 3] > 8)
    if len(xs) == 0:
        print(json.dumps({"ok": False, "error": "抓到的帧整个是透明的 —— 窗口里没有画任何东西",
                          "hint": "确认桌宠进程在跑：POST /ronaldo-pet/desktop {\"action\":\"status\"}"},
                         ensure_ascii=False))
        sys.exit(3)
    frame_pct = (xs.max() - xs.min() + 1) / fw * 100

    results = []
    for r in range(args.rows):
        for c in range(args.cols):
            cell = atlas.crop((c * cw, r * ch, (c + 1) * cw, (r + 1) * ch))
            ref = cell.resize((fw, fh), Image.LANCZOS)
            ra = np.asarray(ref).astype(np.int16)
            diff = float(np.abs(ra - fa).mean())
            a = np.asarray(cell)[:, :, 3]
            yy, xx = np.nonzero(a > 8)
            ref_pct = 0.0 if len(xx) == 0 else (xx.max() - xx.min() + 1) / cw * 100
            results.append({"row": r, "col": c, "diff": round(diff, 2),
                            "ref_width_pct": round(ref_pct, 1), "cell_empty": len(xx) == 0})
    results.sort(key=lambda x: x["diff"])
    best = results[0]

    size_ok = abs(frame_pct - best["ref_width_pct"]) <= 6
    ok = best["diff"] < args.pass_diff and size_ok

    print(json.dumps({
        "ok": ok,
        "frame": args.frame,
        "frame_size": [fw, fh],
        "captured_content_width_pct": round(frame_pct, 1),
        "atlas": {"file": args.atlas, "size": list(atlas.size),
                  "grid": "%dx%d 格 %dx%d" % (args.cols, args.rows, cw, ch)},
        "best_match": best,
        "size_agrees": size_ok,
        "top_matches": results[:5],
        "verdict": (
            "✅ 桌面窗口画的是本图集第 %d 行第 %d 列，色差 %.2f（<%.0f 视为一致），"
            "占幅 %.0f%% vs 该格 %.0f%% —— 整格被正确渲染"
            % (best["row"], best["col"], best["diff"], args.pass_diff,
               frame_pct, best["ref_width_pct"])
            if ok else
            "⚠️ 最佳匹配 第 %d 行第 %d 列，色差 %.2f，占幅 %.0f%% vs 该格 %.0f%%。"
            "色差偏大通常是缩放插值/半透明混合；占幅差太多则可能是显示尺寸或裁切问题。"
            % (best["row"], best["col"], best["diff"], frame_pct, best["ref_width_pct"])
        ),
        "note": "别用插件 verify-desktop.mjs 自己给的色差结论 —— 它固定拿清单里第一只宠物比对。",
    }, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
