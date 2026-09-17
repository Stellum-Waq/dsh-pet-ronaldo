#!/usr/bin/env python
"""
第 2 步（真实现场背景才需要）：抽帧 + 人体分割 → 带 alpha 的 RGBA PNG 序列。

为什么不用色键：probe_video.py 判定为 scene 的素材，背景边缘颜色标准差几十，
没有任何一个阈值能把人和背景分开。这里改用 DeepLabV3（VOC 第 15 类 = person）
拿"人"的概率图，再映射成软 alpha —— 软边比二值 mask 干净得多，缩小到 224px 也不显锯齿。

输出直接喂给：
  forge.mjs video --frames-dir <这个目录> --no-key --fps <同样的 fps>

三个必须踩过的坑，都已在代码里处理（详见 references/pitfalls.md）：
  1. cv2.imwrite 在中文路径下静默失败 → 全部走 imencode 自己写字节
  2. torch 权重默认下到 ~/.cache/torch，在工作区沙箱里会 PermissionError
     → 默认把 TORCH_HOME 指到输出目录旁边
  3. 人顶天立地时，mask 同时贴住上下边缘，背景被切成左右两半，
     从 (0,0) 泛洪够不到另一半 → 右半边背景会被当成"内部空洞"补实，
     alpha 面积从 0.39 暴涨到 0.72。修法：泛洪前先把画布四周补一圈背景。

用法：
  python seg_frames.py --video "D:\\videos\\a.mp4" --out "D:\\pets\\_frames" --fps 12
"""
import argparse
import json
import os
import sys
import time

# Windows 上 Python 默认按控制台代码页（cp936）编码 stdout，调用方却按 UTF-8 解码，
# 中文 JSON 会变乱码。强制 UTF-8，和 Node 对齐。
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", required=True, help="RGBA 帧输出目录")
    ap.add_argument("--fps", type=float, default=12.0,
                    help="抽帧帧率（默认 12）。这个值必须和后面 forge 的 --fps 一致，"
                         "否则 --segments 的时间点会整体错位")
    ap.add_argument("--model", default="mobilenet",
                    choices=["mobilenet", "resnet50"],
                    help="mobilenet 快（CPU 约 1.2s/帧）；resnet50 边缘更准但慢数倍")
    ap.add_argument("--ramp-lo", type=float, default=0.40, help="alpha 斜坡下沿（默认 0.40）")
    ap.add_argument("--ramp-hi", type=float, default=0.70, help="alpha 斜坡上沿（默认 0.70）")
    ap.add_argument("--dilate", type=int, default=1, help="去零星误检用的膨胀半径（默认 1）")
    ap.add_argument("--feather", type=float, default=0.8, help="边缘羽化 sigma（默认 0.8）")
    ap.add_argument("--flatten", default="none", choices=["none", "white", "green"],
                    help="把结果合成到纯色底而不是透明（配合 forge 原生色键用；默认透明）")
    ap.add_argument("--torch-home", default=None,
                    help="torch 权重缓存目录。默认放在 <out>/../torch-cache，"
                         "因为默认的 ~/.cache/torch 在工作区沙箱里写不进去")
    ap.add_argument("--keep-going", action="store_true",
                    help="个别帧没检测到人就跳过而不是整跑失败")
    args = ap.parse_args()

    # ⚠️ 必须在 import torch 之前设好：权重是从这个目录下载/读取的
    torch_home = args.torch_home or os.path.join(os.path.dirname(os.path.abspath(args.out)), "torch-cache")
    os.environ.setdefault("TORCH_HOME", torch_home)

    try:
        import cv2
        import numpy as np
        import torch
        from PIL import Image
        from torchvision.models.segmentation import (
            deeplabv3_mobilenet_v3_large, DeepLabV3_MobileNet_V3_Large_Weights,
            deeplabv3_resnet50, DeepLabV3_ResNet50_Weights,
        )
    except ImportError as exc:
        print(json.dumps({
            "ok": False,
            "error": "缺少依赖：%s" % exc,
            "hint": "python -m pip install opencv-python numpy pillow torch torchvision",
        }, ensure_ascii=False))
        sys.exit(2)

    if not os.path.isfile(args.video):
        print(json.dumps({"ok": False, "error": "视频不存在：%s" % args.video}, ensure_ascii=False))
        sys.exit(2)

    os.makedirs(args.out, exist_ok=True)
    for old in os.listdir(args.out):
        if old.lower().endswith(".png"):
            os.remove(os.path.join(args.out, old))

    torch.set_num_threads(max(2, min(8, os.cpu_count() or 4)))
    PERSON_CLS = 15  # VOC 里 person 就是 15

    if args.model == "resnet50":
        weights = DeepLabV3_ResNet50_Weights.DEFAULT
        model = deeplabv3_resnet50(weights=weights).eval()
    else:
        weights = DeepLabV3_MobileNet_V3_Large_Weights.DEFAULT
        model = deeplabv3_mobilenet_v3_large(weights=weights).eval()
    prep = weights.transforms()
    sys.stderr.write("[seg] 模型就绪（%s，权重缓存 %s）\n" % (args.model, torch_home))
    sys.stderr.flush()

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(json.dumps({"ok": False, "error": "打不开视频：%s" % args.video}, ensure_ascii=False))
        sys.exit(2)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    duration = (total / src_fps) if src_fps else 0.0

    n_out = int(duration * args.fps)
    if n_out <= 0:
        print(json.dumps({"ok": False, "error": "视频时长读不出来（fps=%s frames=%s）" % (src_fps, total)},
                         ensure_ascii=False))
        sys.exit(2)
    want = [int(round(k * src_fps / args.fps)) for k in range(n_out)]
    want_set = set(want)

    frames, i = {}, 0
    while True:
        ok, f = cap.read()
        if not ok:
            break
        if i in want_set:
            frames[i] = f
        i += 1
    cap.release()
    sys.stderr.write("[seg] %dx%d %.1ffps %.2fs → 目标 %d 帧 @ %.0ffps，已解码 %d\n"
                     % (W, H, src_fps, duration, n_out, args.fps, len(frames)))
    sys.stderr.flush()

    flat_bg = None
    if args.flatten == "white":
        flat_bg = np.array([255, 255, 255], dtype=np.float32)   # RGB
    elif args.flatten == "green":
        flat_bg = np.array([0, 177, 64], dtype=np.float32)

    stats, prev_a, t0, missed = [], None, time.time(), []
    for k, idx in enumerate(want):
        f = frames.get(idx)
        if f is None:
            continue
        rgb = cv2.cvtColor(f, cv2.COLOR_BGR2RGB)
        with torch.no_grad():
            logits = model(prep(Image.fromarray(rgb)).unsqueeze(0))["out"][0]
            prob = torch.softmax(logits, dim=0)[PERSON_CLS].numpy()
        # 概率图是低分辨率的，双线性升回原尺寸 —— 这一步本身就带来一点软边
        prob = cv2.resize(prob, (W, H), interpolation=cv2.INTER_LINEAR)
        alpha = np.clip((prob - args.ramp_lo) / max(1e-6, args.ramp_hi - args.ramp_lo),
                        0.0, 1.0).astype(np.float32)

        hard = (alpha > 0.5).astype(np.uint8)
        nlab, lab, st, _ = cv2.connectedComponentsWithStats(hard, connectivity=8)
        if nlab > 1:
            biggest = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
            keep = (lab == biggest).astype(np.uint8)
        else:
            keep = hard

        if keep.sum() < 50:
            missed.append({"k": k, "t": round(k / args.fps, 3)})
            if not args.keep_going:
                print(json.dumps({
                    "ok": False,
                    "error": "第 %d 帧没检测到人（t=%.2fs）。如果整段视频都这样，说明素材里主体不是人，"
                             "或者主体太小 —— 这条路只做人体分割。" % (k, k / args.fps),
                    "hint": "确实只有个别帧的话，加 --keep-going 跳过它们。",
                }, ensure_ascii=False))
                sys.exit(3)
            continue

        # —— 关键修复：先补一圈背景再泛洪，否则人顶到上下边缘时背景会被腰斩 ——
        pad = np.pad(keep, 1, mode="constant", constant_values=0)
        m2 = np.zeros((pad.shape[0] + 2, pad.shape[1] + 2), np.uint8)
        cv2.floodFill(pad, m2, (0, 0), 1)
        holes = (pad[1:-1, 1:-1] == 0).astype(np.uint8)

        a = alpha.copy()
        a[holes > 0] = 1.0        # 真内部空洞（腿间、腋下）补实
        if args.dilate > 0:
            near = cv2.dilate(keep, np.ones((3, 3), np.uint8), args.dilate)
            a = np.where(near > 0, a, 0.0)   # 只保留主体附近，去掉零星误检
        if args.feather > 0:
            a = cv2.GaussianBlur(a, (0, 0), args.feather)

        if flat_bg is not None:
            # 合成到纯色底：想走 forge 原生色键时用这个
            comp = rgb.astype(np.float32) * a[..., None] + flat_bg * (1.0 - a[..., None])
            out_img = Image.fromarray(comp.round().clip(0, 255).astype(np.uint8), "RGB")
        else:
            out_img = Image.fromarray(np.dstack([rgb, (a * 255).astype(np.uint8)]), "RGBA")
        out_img.save(os.path.join(args.out, "frame_%04d.png" % k))

        ys, xs = np.nonzero(a > 0.5)
        area = int(len(xs))
        motion = None if prev_a is None else round(float(np.abs(a - prev_a).mean()), 5)
        prev_a = a
        stats.append({
            "k": k, "src_index": idx, "t": round(k / args.fps, 4),
            "area": area, "frac": round(area / float(W * H), 4),
            "bbox": [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())] if area else None,
            "centroid": [round(float(xs.mean()), 1), round(float(ys.mean()), 1)] if area else None,
            "top": int(ys.min()), "bottom": int(ys.max()),
            "motion": motion,
        })
        if k % 20 == 0:
            sys.stderr.write("[seg] %3d/%d t=%.2fs area=%.3f (%.0fs)\n"
                             % (k, n_out, k / args.fps, area / float(W * H), time.time() - t0))
            sys.stderr.flush()

    if not stats:
        print(json.dumps({"ok": False, "error": "一帧都没产出"}, ensure_ascii=False))
        sys.exit(3)

    stats_path = os.path.join(os.path.dirname(os.path.abspath(args.out)), "seg-stats.json")
    with open(stats_path, "w", encoding="utf-8") as fh:
        json.dump({"fps": args.fps, "w": W, "h": H, "source": args.video, "frames": stats},
                  fh, ensure_ascii=False, indent=1)

    fr = [s["frac"] for s in stats]
    print(json.dumps({
        "ok": True,
        "video": args.video,
        "frames_dir": args.out,
        "count": len(stats),
        "fps": args.fps,
        "stats": stats_path,
        "steep": {"frac_min": round(min(fr), 4), "frac_med": round(float(np.median(fr)), 4),
                  "frac_max": round(max(fr), 4)},
        "skipped": missed,
        "elapsed_sec": round(time.time() - t0, 1),
        "next": "python plan_segments.py --stats \"%s\"" % stats_path,
    }, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
