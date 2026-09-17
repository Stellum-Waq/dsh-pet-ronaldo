#!/usr/bin/env python
"""
第 3 步：从运动量剖面里挑出"哪一段适合当哪个动作"，并给出可直接粘贴的 --segments。

为什么不能随便切：一段 8 秒的视频切成 6 份，如果乱切，会出现
「出手时人在发呆」「待机时人在剧烈挥手」这种一眼假的错配。
运动量（帧间 alpha 差）、主体在画面里的高低（top）和大小（frac）都是免费可得的信号，
用它们做分配，比肉眼猜稳得多。

分配规则（按优先级抢窗口，互不重叠）：
  running  运动量最大          —— "正在干活"就该是最忙的那段
  failed   主体最小/最远        —— 退缩、蔫掉、走远，视觉上就是"出错了"
  jumping  主体由远及近/由蹲到起 —— 画面里人越来越大 = 朝你冲过来，最像"完成时跳一下"
  idle     剩下里最平静的        —— 待机必须是最不打扰的
  waiting  剩下里第二平静的      —— 等回复，也不该闹
  review   剩下的里最忙的        —— 思考，有点小动作最好

用法：
  python plan_segments.py --stats <seg-stats.json> [--window 1.0] [--frames DIR]
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
except ImportError:
    print(json.dumps({"ok": False, "error": "需要 numpy"}, ensure_ascii=False))
    sys.exit(2)


def smooth(x, k=5):
    if len(x) < k or k <= 1:
        return x
    return np.convolve(x, np.ones(k) / k, mode="same")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stats", required=True, help="seg_frames.py 产出的 seg-stats.json")
    ap.add_argument("--window", type=float, default=1.0, help="每个动作的片段时长（秒，默认 1.0）")
    ap.add_argument("--step", type=float, default=0.25, help="窗口滑动步长（秒）")
    ap.add_argument("--frames", default=None, help="RGBA 帧目录，给了就顺便出一张分镜图")
    ap.add_argument("--out", default=None, help="分镜图输出路径")
    args = ap.parse_args()

    with open(args.stats, encoding="utf-8") as fh:
        st = json.load(fh)
    frames = st["frames"]
    fps = float(st["fps"])
    if not frames:
        print(json.dumps({"ok": False, "error": "stats 里没有帧"}, ensure_ascii=False))
        sys.exit(2)

    N = len(frames)
    motion = smooth(np.array([f["motion"] or 0.0 for f in frames], dtype=float), 7)
    frac = np.array([f["frac"] for f in frames], dtype=float)
    top = np.array([f["top"] for f in frames], dtype=float)
    height = np.array([(f["bottom"] - f["top"]) for f in frames], dtype=float)
    fsm = smooth(frac, 7)

    wf = max(2, int(round(args.window * fps)))
    ws = max(1, int(round(args.step * fps)))

    cands = []
    for s in range(0, max(1, N - wf + 1), ws):
        e = min(N, s + wf)
        if e - s < 2:
            continue
        # 主体"生长速度"：窗口内 frac 的线性趋势，正=朝镜头逼近/站起来
        ys = fsm[s:e]
        trend = float(np.polyfit(np.arange(len(ys)), ys, 1)[0]) if len(ys) >= 3 else 0.0
        cands.append({
            "s": s, "e": e,
            "from": round(s / fps, 2), "to": round(e / fps, 2),
            "motion": float(motion[s:e].mean()),
            "frac": float(fsm[s:e].mean()),
            "top": float(top[s:e].mean()),
            "height": float(height[s:e].mean()),
            "trend": trend,
        })
    if not cands:
        print(json.dumps({"ok": False, "error": "视频太短，切不出 --window=%.2fs 的窗口" % args.window},
                         ensure_ascii=False))
        sys.exit(2)

    def overlaps(c, chosen):
        return any(not (c["e"] <= o["s"] or c["s"] >= o["e"]) for o in chosen)

    # 中位运动量：用来把"平静"和"活跃"分开。
    # 为什么需要它：只看 frac 的增长趋势会被噪声骗 —— 最平静的那段稍微涨一点点，
    # 就会被判成"朝你冲过来"，把最好的待机片段抢走。跳跃必须同时是个"有动作"的时刻。
    med_motion = float(np.median([c["motion"] for c in cands]))

    chosen, plan = [], {}
    picks = [
        # (动作, 排序键, 取最大还是最小, 理由模板, 附加筛选)
        ("running", lambda c: c["motion"], True, "运动量最大（%.4f）—— 干活时最忙", None),
        ("failed", lambda c: c["frac"], False, "主体在画面里最小/最远（占幅 %.3f）—— 退缩、蔫掉", None),
        ("jumping", lambda c: c["trend"], True, "主体由远及近/由蹲到起（增长 %.5f/s）—— 朝你冲过来",
         lambda c: c["motion"] >= med_motion),
        ("idle", lambda c: c["motion"], False, "剩下里最平静（%.4f）—— 待机不该打扰你", None),
        ("waiting", lambda c: c["motion"], False, "剩下里第二平静（%.4f）—— 等你回复", None),
        ("review", lambda c: c["motion"], True, "剩下里动作最多（%.4f）—— 思考时带点小动作", None),
    ]
    for action, key, take_max, why, where in picks:
        pool = [c for c in cands if not overlaps(c, chosen)]
        if where is not None:
            narrowed = [c for c in pool if where(c)]
            # 筛完一个都不剩就退回不筛，宁可给个中庸的片段，也不要漏掉一个状态
            pool = narrowed or pool
        if not pool:
            break
        pool.sort(key=key, reverse=take_max)
        c = pool[0]
        chosen.append(c)
        plan[action] = {"from": c["from"], "to": c["to"],
                        "why": why % (c["trend"] if action == "jumping" else
                                      (c["frac"] if action == "failed" else c["motion"])),
                        "motion": round(c["motion"], 5), "frac": round(c["frac"], 4),
                        "top": round(c["top"], 1), "trend": round(c["trend"], 6)}

    # 按时间排好，方便用户对着原片核对
    ordered = sorted(plan.items(), key=lambda kv: kv[1]["from"])
    segments_str = ",".join("%s:%g-%g" % (a, v["from"], v["to"]) for a, v in ordered)

    print("时间  运动量    占比   顶部")
    for i in range(0, N, max(1, N // 24)):
        print("%5.2fs %7.4f %6.3f %5d" % (i / fps, motion[i], frac[i], top[i]))

    out = {
        "ok": True,
        "fps": fps,
        "duration": round(N / fps, 3),
        "window": args.window,
        "plan": {a: plan[a] for a, _ in ordered},
        "segments": segments_str,
        "candidates": [
            {"from": c["from"], "to": c["to"], "motion": round(c["motion"], 5),
             "frac": round(c["frac"], 4), "top": round(c["top"], 1), "trend": round(c["trend"], 6)}
            for c in sorted(cands, key=lambda c: c["from"])
        ],
        "note": ("这是数据推出来的草稿，不是最终答案。务必把 segments 念给用户核对，"
                 "或者对着原片看一眼：自动分配只会挑「运动特征像」，不懂内容语义。"),
    }

    if args.frames and os.path.isdir(args.frames):
        try:
            from PIL import Image, ImageDraw
            names = sorted(f for f in os.listdir(args.frames) if f.lower().endswith(".png"))
            cw, ch = 90, 160
            cols = 12
            rows = (len(names) + cols - 1) // cols
            sheet = Image.new("RGB", (cols * cw, max(1, rows) * ch), (16, 16, 16))
            d = ImageDraw.Draw(sheet)
            for i, nm in enumerate(names):
                im = Image.open(os.path.join(args.frames, nm)).convert("RGBA")
                bg = Image.new("RGBA", im.size, (58, 58, 58, 255))
                comp = Image.alpha_composite(bg, im).convert("RGB").resize((cw, ch), Image.LANCZOS)
                x, y = (i % cols) * cw, (i // cols) * ch
                sheet.paste(comp, (x, y))
                d.rectangle([x, y, x + cw - 1, y + ch - 1], outline=(90, 90, 90), width=1)
                if i % cols == 0:
                    d.rectangle([x, y, x + 26, y + 13], fill=(0, 0, 0))
                    d.text((x + 3, y + 2), "%.1fs" % (i / fps), fill=(255, 220, 0))
            # 把每个动作的区间标在分镜图上，一眼看出切得对不对
            for action, v in ordered:
                c0 = int(v["from"] * fps / cols)
                d.text((max(0, c0) * cw + 30, 4), action, fill=(0, 255, 128))
            path = args.out or os.path.join(os.path.dirname(os.path.abspath(args.stats)), "storyboard.png")
            sheet.save(path)
            out["storyboard"] = path
        except Exception as exc:  # 画图失败不该影响主结果
            out["storyboard_error"] = str(exc)

    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
