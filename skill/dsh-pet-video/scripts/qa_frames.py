#!/usr/bin/env python
"""
第 4 步：抠像目视检查。生成一张"棋盘格底"的放大图，交给视觉模型看。

为什么必须看：alpha 面积这种数字指标**看不出**"人少了一条腿"或"右半边背景被吃进来"。
这次就吃过这个亏 —— 面积从 0.39 涨到 0.72，数字异常明显，但如果只看到"跑通了"就交付，
用户拿到的是半张桌子。棋盘格底能把透明区域和残留背景一眼分开。

用法：
  python qa_frames.py --frames "D:\\pets\\_frames" --out "D:\\pets\\matte-check.png" --n 8

然后**一定要**把生成的图交给视觉模型确认（当前模型能直接看图就直接看）：
  node <dsh-eye>/scripts/vision.mjs "<out.png>" "上排=抠像贴在棋盘格上,下排=alpha遮罩。
    人的轮廓完整吗?头/手/腿有没有被切?有没有残留背景?" --mode ask
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
    from PIL import Image, ImageDraw
except ImportError as exc:
    print(json.dumps({"ok": False, "error": "需要 pillow 和 numpy：%s" % exc,
                      "hint": "python -m pip install pillow numpy"}, ensure_ascii=False))
    sys.exit(2)


def checker(h, w, s=14):
    yy, xx = np.mgrid[0:h, 0:w]
    c = (((yy // s) + (xx // s)) % 2).astype(np.uint8)
    return np.where(c[..., None] == 0, np.uint8(64), np.uint8(104)).repeat(3, axis=2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", required=True, help="RGBA 帧目录")
    ap.add_argument("--out", default=None, help="检查图输出路径")
    ap.add_argument("--n", type=int, default=8, help="抽几帧来看（默认 8）")
    ap.add_argument("--cols", type=int, default=4)
    args = ap.parse_args()

    names = sorted(f for f in os.listdir(args.frames) if f.lower().endswith(".png"))
    if not names:
        print(json.dumps({"ok": False, "error": "目录里没有 PNG：%s" % args.frames}, ensure_ascii=False))
        sys.exit(2)

    step = max(1, len(names) // max(1, args.n))
    picks = names[::step][:args.n]

    # 先做数值体检：面积抖动过大通常意味着某几帧抠坏了
    areas, sizes = [], set()
    for nm in names:
        im = Image.open(os.path.join(args.frames, nm))
        sizes.add(im.size)
        a = np.asarray(im.convert("RGBA"))[:, :, 3]
        areas.append(int((a > 8).sum()) / float(a.size))
    areas = np.array(areas)
    med = float(np.median(areas))
    outliers = [names[i] for i, v in enumerate(areas) if med > 0 and (v > med * 1.6 or v < med * 0.55)]

    cw, ch = 200, 356
    rows = 2
    cols = min(args.cols, len(picks))
    rows_n = (len(picks) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cw, rows * rows_n * ch), (18, 18, 18))
    d = ImageDraw.Draw(sheet)
    for k, nm in enumerate(picks):
        im = Image.open(os.path.join(args.frames, nm)).convert("RGBA")
        bg = Image.fromarray(checker(im.height, im.width)).convert("RGBA")
        comp = Image.alpha_composite(bg, im).convert("RGB").resize((cw, ch), Image.LANCZOS)
        am = Image.fromarray(np.asarray(im)[:, :, 3], "L").convert("RGB").resize((cw, ch), Image.LANCZOS)
        x, y = (k % cols) * cw, (k // cols) * ch
        sheet.paste(comp, (x, y))
        sheet.paste(am, (x, y + rows_n * ch))
        d.rectangle([x, y, x + cw - 1, y + 2 * rows_n * ch - 1], outline=(255, 0, 255), width=1)
        d.text((x + 4, y + 4), nm, fill=(255, 255, 0))
        d.text((x + 4, y + rows_n * ch + 4), "alpha", fill=(0, 255, 128))

    out = args.out or os.path.join(os.path.dirname(os.path.abspath(args.frames)), "matte-check.png")
    sheet.save(out)

    print(json.dumps({
        "ok": True,
        "sheet": out,
        "size": list(sheet.size),
        "picked": picks,
        "frame_sizes": [list(s) for s in sizes],
        "alpha_frac": {"min": round(float(areas.min()), 4), "median": round(med, 4),
                       "max": round(float(areas.max()), 4)},
        "suspect_frames": outliers[:20],
        "layout": "上排=抠像贴在棋盘格上（棋盘格=透明），下排=alpha 遮罩（白=人）",
        "next": ('把上面这张图交给视觉模型确认：node <dsh-eye>/scripts/vision.mjs "%s" '
                 '"逐格检查：人是否完整、有无裁切、有无残留背景" --mode ask' % out),
    }, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
