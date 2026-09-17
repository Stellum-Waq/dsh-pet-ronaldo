#!/usr/bin/env python
"""
第 1 步：读懂这个视频，并判定"该用色键还是该用人体分割"。

为什么先做这一步：forge.mjs 自带的 video 路线默认假设你拍的是幕布（绿幕/白墙），
它从画面边缘取色做连通域泛洪。真实房间、办公室、街景这类背景边缘颜色标准差动辄 50+，
色键必然抠坏 —— 但默认流程不会拦你，它会给你一个"看起来跑通了、实际一塌糊涂"的结果。
所以先用数据把这件事问清楚。

用法：
  python probe_video.py --video "D:\\videos\\cat.mp4" [--samples 20] [--out DIR]

输出：一段 JSON（stdout）+ 可选的抽样帧和联络图（--out 给目录时）。
判定结论在 verdict 字段：
  chroma-ok  边缘颜色很均匀 → 走 forge 原生色键（最快，且自带 despill）
  scene      边缘花 → 走人体分割（scripts/seg_frames.py），不要浪费时间调色键阈值
"""
import argparse
import json
import os
import sys

# Windows 上 Python 默认按控制台代码页（cp936）编码 stdout，而调用方按 UTF-8 解码，
# 于是 JSON 里的中文全变成乱码 —— 结果"看起来能跑"，但人读不懂、程序也可能解析错。
# 强制 UTF-8 输出，和 Node 的行为对齐。
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8")

try:
    import cv2
    import numpy as np
except ImportError as exc:  # pragma: no cover - 环境问题要说得明白
    print(json.dumps({
        "ok": False,
        "error": "需要 opencv-python 和 numpy：%s" % exc,
        "hint": "python -m pip install opencv-python numpy",
    }, ensure_ascii=False))
    sys.exit(2)


def imwrite_unicode(path, frame, quality=88):
    """cv2.imwrite 在 Windows 上遇到中文路径会**静默失败**（返回 False，不抛异常）。

    这是本流程最阴的一个坑：你以为帧写出来了，其实目录是空的，后面所有步骤都在
    对着空气干活。所以这里一律走 imencode + 自己写字节。
    """
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError("imencode 失败：" + path)
    with open(path, "wb") as fh:
        fh.write(buf.tobytes())
    return len(buf)


def border_ring(frame, frac=0.02):
    """取画面四周一圈像素。角色在中间，边缘基本都是背景。"""
    h, w = frame.shape[:2]
    bw = max(4, int(min(h, w) * frac))
    return np.concatenate([
        frame[:bw, :, :].reshape(-1, 3),
        frame[-bw:, :, :].reshape(-1, 3),
        frame[:, :bw, :].reshape(-1, 3),
        frame[:, -bw:, :].reshape(-1, 3),
    ])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--samples", type=int, default=20, help="抽样帧数（默认 20）")
    ap.add_argument("--out", default=None, help="给了就顺便落抽样帧和联络图")
    ap.add_argument("--solid-std", type=float, default=12.0,
                    help="边缘颜色标准差低于这个值就认为背景是纯色幕布（默认 12）")
    args = ap.parse_args()

    if not os.path.isfile(args.video):
        print(json.dumps({"ok": False, "error": "视频不存在：%s" % args.video}, ensure_ascii=False))
        sys.exit(2)

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(json.dumps({"ok": False, "error": "打不开这个视频（编码不支持？）：%s" % args.video},
                         ensure_ascii=False))
        sys.exit(2)

    fps = cap.get(cv2.CAP_PROP_FPS) or 0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    duration = (total / fps) if fps else 0.0

    # 均匀抽 N 帧（用 grab 跳帧，不解码不需要的，快很多）
    step = max(1, total // max(1, args.samples))
    stats, kept = [], []
    idx = 0
    while True:
        if not cap.grab():
            break
        if idx % step == 0:
            ok, frame = cap.retrieve()
            if ok:
                ring = border_ring(frame).astype(np.int32)
                mean = ring.mean(axis=0)[::-1]          # BGR -> RGB
                per_channel_std = ring.std(axis=0)
                stats.append({
                    "t": round(idx / fps, 3) if fps else idx,
                    "ring_mean_rgb": [round(float(x), 1) for x in mean],
                    "ring_std": round(float(per_channel_std.mean()), 1),
                    # 角点最能暴露"背景其实一直在变"
                    "corners_rgb": [
                        [int(x) for x in frame[2, 2][::-1]],
                        [int(x) for x in frame[2, -3][::-1]],
                        [int(x) for x in frame[-3, 2][::-1]],
                        [int(x) for x in frame[-3, -3][::-1]],
                    ],
                })
                kept.append((idx, frame))
        idx += 1
    cap.release()

    if not stats:
        print(json.dumps({"ok": False, "error": "一帧都读不出来"}, ensure_ascii=False))
        sys.exit(2)

    stds = np.array([s["ring_std"] for s in stats], dtype=float)
    means = np.array([s["ring_mean_rgb"] for s in stats], dtype=float)
    # 用中位数而不是均值：单帧里有人走进边缘时，中位数不会被带跑
    ring_std = float(np.median(stds))
    # 各帧之间幕布颜色本身稳不稳
    frame_to_frame = float(means.std(axis=0).mean())

    solid = ring_std < args.solid_std and frame_to_frame < args.solid_std
    if solid:
        verdict = "chroma-ok"
        why = ("画面边缘颜色很稳（std %.1f，帧间 %.1f），是幕布/纯色墙。"
               "走 forge 原生色键，别绕道分割，色键更快且自带去白边。" % (ring_std, frame_to_frame))
        route = "forge-chroma"
    else:
        verdict = "scene"
        why = ("画面边缘又花又变（std %.1f，帧间 %.1f），是真实现场背景，不是幕布。"
               "色键在这种素材上一定会抠坏，直接走 scripts/seg_frames.py 做人体分割。"
               % (ring_std, frame_to_frame))
        route = "segmentation"

    out = {
        "ok": True,
        "video": args.video,
        "info": {
            "width": w, "height": h, "fps": round(fps, 4),
            "frames": total, "duration_sec": round(duration, 3),
            "orientation": "portrait" if h > w else ("square" if h == w else "landscape"),
        },
        "background": {
            "ring_std_median": round(ring_std, 1),
            "ring_mean_drift": round(frame_to_frame, 1),
            "solid_threshold": args.solid_std,
            "per_sample": stats,
        },
        "verdict": verdict,
        "route": route,
        "why": why,
    }

    if args.out:
        os.makedirs(args.out, exist_ok=True)
        from PIL import Image, ImageDraw
        jpgs = []
        for k, (i, frame) in enumerate(kept):
            p = os.path.join(args.out, "sample_%03d.jpg" % k)
            imwrite_unicode(p, frame)
            jpgs.append(p)
        # 联络图：一眼看完整段视频在干什么
        cols = 5
        cw, ch = 216, 384
        rows = (len(jpgs) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * cw, max(1, rows) * ch), (25, 25, 25))
        d = ImageDraw.Draw(sheet)
        for k, p in enumerate(jpgs):
            im = Image.open(p).convert("RGB").resize((cw, ch), Image.LANCZOS)
            x, y = (k % cols) * cw, (k // cols) * ch
            sheet.paste(im, (x, y))
            d.rectangle([x, y, x + cw - 1, y + ch - 1], outline=(255, 0, 255), width=1)
            d.text((x + 4, y + 4), "%.1fs" % stats[k]["t"], fill=(255, 255, 0))
        sheet_path = os.path.join(args.out, "contact-sheet.png")
        sheet.save(sheet_path)
        out["wrote"] = {"samples_dir": args.out, "count": len(jpgs), "contact_sheet": sheet_path}

    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
