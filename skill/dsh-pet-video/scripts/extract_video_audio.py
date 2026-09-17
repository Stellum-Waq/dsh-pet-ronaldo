#!/usr/bin/env python
"""
第 5.5 步：把**原视频的声音**切出来，按动作段配上去。

为什么需要它：dsh-pet-forge 的 video 路线只有 `--audio-from-video`，而那个参数
**依赖 ffmpeg**（走 `-vn -acodec libmp3lame`）。本机没有 ffmpeg 时，那条路直接断掉，
于是宠物只能配合成音效——和视频里的真实声音完全脱节。
这里用 PyAV（pip wheel 里自带 FFmpeg 库，不需要任何外部 exe）在进程内解码，
把音轨按动作段切开、淡入淡出、统一响度，写成 WAV。

映射规则（默认）：**动作段 ↔ 同名事件**，声音和动作同源，最忠实
    celebrate ← jumping 段      （完成时跳一下，配那一下的声音）
    failed    ← failed 段
    waiting   ← waiting 段
    working   ← running 段      （"正在干活"）
    boot      ← idle 段         （登场）
    click / dive ← 没有对应动作，用起音检测在全片里挑最"脆"的一小截

用法：
  # 1) 切好并写进 <pkg>/audio/
  python extract_video_audio.py --video "<视频>" --pkg "<宠物包>" `
         --segments "idle:0-1,waiting:1.2-2.2,review:2.4-3.4,running:4.7-5.7,failed:6.3-7.3,jumping:7.4-8.4" `
         --libs "<工作区>/pylibs"
  # 2) 用返回的 audioMap 注册（见 next 字段），再跑一次 --relabel 把标签写好看
  python extract_video_audio.py --pkg "<宠物包>" --relabel
"""
import argparse
import json
import os
import sys
import wave

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8")

# 动作 → 音频键。改这个表就能改映射，不用动代码。
DEFAULT_MAP = {
    "celebrate": "jumping",
    "failed": "failed",
    "waiting": "waiting",
    "working": "running",
    "boot": "idle",
}


def parse_segments(text):
    """'idle:0-1,waiting:1.2-2.2' → {'idle': (0.0, 1.0), ...}"""
    out = {}
    for item in str(text or "").split(","):
        item = item.strip()
        if not item:
            continue
        if ":" not in item:
            raise ValueError("看不懂的分段：%s（应为 动作:起-止）" % item)
        name, rng = item.split(":", 1)
        if "-" not in rng:
            raise ValueError("看不懂的时间段：%s（应为 起-止）" % rng)
        a, b = rng.split("-", 1)
        out[name.strip()] = (float(a), float(b))
    return out


def decode_mono(path, rate, libs=None):
    """用 PyAV 在进程内把音轨解成 mono float32。不需要 ffmpeg.exe。"""
    if libs:
        sys.path.insert(0, libs)
    try:
        import av
        import numpy as np
    except ImportError as exc:
        raise SystemExit(json.dumps({
            "ok": False,
            "error": "需要 PyAV 和 numpy：%s" % exc,
            "hint": "python -m pip install --target <工作区>/pylibs --no-cache-dir av numpy "
                    "（--target 装进工作区，避免往系统 site-packages 写）",
        }, ensure_ascii=False))

    container = av.open(path)
    streams = [s for s in container.streams if s.type == "audio"]
    if not streams:
        raise SystemExit(json.dumps({
            "ok": False,
            "error": "这段视频里没有音轨，抽不出原声",
            "hint": "只能继续用合成音效；或者干脆关掉这只宠物的声音。",
        }, ensure_ascii=False))

    stream = streams[0]
    src_rate = stream.rate or rate
    resampler = av.AudioResampler(format="s16", layout="mono", rate=rate)

    chunks = []

    def take(frames):
        for fr in (frames or []):
            arr = fr.to_ndarray()
            chunks.append(arr.reshape(-1))

    for frame in container.decode(stream):
        take(resampler.resample(frame))
    take(resampler.resample(None))     # 把重采样器里剩的冲出来
    container.close()

    if not chunks:
        raise SystemExit(json.dumps({"ok": False, "error": "解码出来是空的"}, ensure_ascii=False))
    pcm = np.concatenate(chunks).astype(np.float32) / 32768.0
    return pcm, int(src_rate), np


def fade(buf, np, ms, rate):
    """线性淡入淡出。截断处的爆音几乎全靠这个消掉。"""
    n = int(rate * ms / 1000.0)
    n = max(1, min(n, len(buf) // 2))
    if n <= 1:
        return buf
    ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
    out = buf.copy()
    out[:n] *= ramp
    out[-n:] *= ramp[::-1]
    return out


def normalize(buf, np, target_rms_db=-20.0, peak_ceiling=0.99):
    """按 RMS 统一响度，再用峰值封顶。

    为什么不用纯峰值归一化：某段只要有一个尖峰，整段就会被压得很轻，
    六段之间的听感会差很多。按 RMS 对齐更接近"音量一致"的直觉。
    """
    if len(buf) == 0:
        return buf, 0.0
    rms = float(np.sqrt(np.mean(buf.astype(np.float64) ** 2)))
    peak = float(np.max(np.abs(buf)))
    if rms <= 1e-9 or peak <= 1e-9:
        return buf, 0.0
    target = 10 ** (target_rms_db / 20.0)
    gain = target / rms
    if peak * gain > peak_ceiling:
        gain = peak_ceiling / peak
    return (buf * gain).astype(np.float32), float(20 * np.log10(max(gain, 1e-9)))


def quiet_level_db(buf, np, rate):
    """用短时能量的第 5 百分位估"这段有多安静"，纯做参考。

    注意它**不是**噪声底：音乐里的弱奏会被算进来，所以拿它当"嘶声判据"是错的
    （试过，会给所有片段都报假警）。真正的风险信号是下面的"要不要大幅提升"。
    低于 -100 dBFS 直接当数字静音，返回 None，免得报出 -180 这种没法解读的怪数。
    """
    hop = max(1, int(rate * 0.01))
    win = max(hop, int(rate * 0.02))
    if len(buf) < win * 3:
        return None
    n = 1 + (len(buf) - win) // hop
    e = np.array([np.sqrt(np.mean(buf[i * hop:i * hop + win].astype(np.float64) ** 2))
                  for i in range(n)])
    v = float(np.percentile(e, 5))
    if v <= 1e-5:
        return None
    return float(20 * np.log10(v))


def spectral_flatness(buf, np, rate, nfft=1024):
    """0 ≈ 纯乐音/人声，1 ≈ 白噪声。

    用来回答一个具体问题：一段"很小声的内容"被提升几十 dB 之后，
    露出的是真的音乐，还是底噪？只看 RMS 分不出来，看频谱平坦度就能分。
    """
    if len(buf) < nfft * 2:
        return None
    win = np.hanning(nfft)
    hop = nfft // 2
    n = 1 + (len(buf) - nfft) // hop
    if n <= 0:
        return None
    vals = []
    for i in range(0, n, max(1, n // 50)):
        seg = buf[i * hop:i * hop + nfft]
        if len(seg) < nfft:
            break
        S = np.abs(np.fft.rfft(seg * win)) ** 2 + 1e-12
        vals.append(float(np.exp(np.mean(np.log(S))) / np.mean(S)))
    return float(np.mean(vals)) if vals else None


def write_wav(path, buf, rate, np):
    data = (np.clip(buf, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(data.tobytes())


def onset_pick(pcm, np, rate, want_sec, search_from=0.0):
    """找全片里最"脆"的一个起音，从它前面一点开始截 want_sec 秒。

    为什么不用固定位置：click 要靠一个瞬态才有"咔哒"的反馈感，
    随便截一段连续的音乐/说话，点下去会像"漏音"而不是"回应"。
    """
    hop = max(1, int(rate * 0.01))
    win = max(hop, int(rate * 0.02))
    start = int(search_from * rate)
    seg = pcm[start:]
    if len(seg) < win * 3:
        return search_from, search_from + want_sec
    n = 1 + (len(seg) - win) // hop
    energy = np.empty(n, dtype=np.float64)
    for i in range(n):
        f = seg[i * hop:i * hop + win]
        energy[i] = float(np.sqrt(np.mean(f.astype(np.float64) ** 2)))
    onset = np.diff(energy)
    best = int(np.argmax(onset)) if len(onset) else 0
    t = start / rate + (best * hop) / rate
    t = max(0.0, t - 0.05)                       # 稍微提前一点，别把起音切掉
    total = len(pcm) / rate
    if t + want_sec > total:
        t = max(0.0, total - want_sec)
    return t, t + want_sec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pkg", required=True, help="宠物包目录（WAV 写进它的 audio/）")
    ap.add_argument("--video", default=None, help="源视频（--relabel 模式不需要）")
    ap.add_argument("--segments", default=None, help="和 forge 同格式：idle:0-1,waiting:1.2-2.2")
    ap.add_argument("--map", default=None,
                    help="动作→音频键，默认 " + ",".join("%s=%s" % kv for kv in DEFAULT_MAP.items()))
    ap.add_argument("--click-sec", type=float, default=0.35)
    ap.add_argument("--dive-sec", type=float, default=0.7)
    ap.add_argument("--fade-ms", type=float, default=30.0)
    ap.add_argument("--target-rms-db", type=float, default=-20.0)
    ap.add_argument("--rate", type=int, default=44100)
    ap.add_argument("--libs", default=None, help="PyAV 所在目录（pip --target 装的位置）")
    ap.add_argument("--relabel", action="store_true",
                    help="读回上次生成的 audio-map.json，把 pet.json 里的标签写清楚")
    args = ap.parse_args()

    pkg = os.path.abspath(args.pkg)
    if not os.path.isdir(pkg):
        print(json.dumps({"ok": False, "error": "宠物包不存在：%s" % pkg}, ensure_ascii=False))
        sys.exit(2)

    if args.libs:
        sys.path.insert(0, args.libs)
    import numpy as np

    map_path = os.path.join(pkg, "audio", "video-audio-map.json")

    # ---- 只改标签 ----
    if args.relabel:
        if not os.path.isfile(map_path):
            print(json.dumps({"ok": False, "error": "没有 audio-map.json，先正常跑一次"}, ensure_ascii=False))
            sys.exit(2)
        with open(map_path, encoding="utf-8") as fh:
            amap = json.load(fh)
        man_path = os.path.join(pkg, "pet.json")
        with open(man_path, encoding="utf-8") as fh:
            man = json.load(fh)
        changed = []
        for key, info in amap["clips"].items():
            if key in (man.get("audio") or {}):
                man["audio"][key]["label"] = info["label"]
                man["audio"][key]["kind"] = "video-original"
                man["audio"][key]["source"] = {"from": info["from"], "to": info["to"],
                                               "segment": info.get("segment")}
                changed.append(key)
        with open(man_path, "w", encoding="utf-8") as fh:
            json.dump(man, fh, ensure_ascii=False, indent=2)
        print(json.dumps({"ok": True, "relabeled": changed,
                          "human": "已把 %d 个音效的标签改成原声来源说明" % len(changed)},
                         ensure_ascii=False, indent=1))
        return

    if not args.video or not args.segments:
        print(json.dumps({"ok": False, "error": "需要 --video 和 --segments（或只用 --relabel）"},
                         ensure_ascii=False))
        sys.exit(2)
    if not os.path.isfile(args.video):
        print(json.dumps({"ok": False, "error": "视频不存在：%s" % args.video}, ensure_ascii=False))
        sys.exit(2)

    segs = parse_segments(args.segments)
    mapping = dict(DEFAULT_MAP)
    if args.map:
        for pair in args.map.split(","):
            if "=" in pair:
                k, v = pair.split("=", 1)
                mapping[k.strip()] = v.strip()

    pcm, src_rate, _ = decode_mono(args.video, args.rate, args.libs)
    total = len(pcm) / args.rate

    audio_dir = os.path.join(pkg, "audio")
    os.makedirs(audio_dir, exist_ok=True)

    clips, warnings = {}, []

    def cut(key, t0, t1, why):
        t0 = max(0.0, min(t0, total))
        t1 = max(t0, min(t1, total))
        if t1 - t0 < 0.05:
            warnings.append("%s 的区间太短（%.2f~%.2f），跳过" % (key, t0, t1))
            return
        buf = pcm[int(t0 * args.rate):int(t1 * args.rate)]
        if len(buf) == 0:
            warnings.append("%s 没切到样本，跳过" % key)
            return
        quiet_before = quiet_level_db(buf, np, args.rate)
        flatness = spectral_flatness(buf, np, args.rate)
        buf = fade(buf, np, args.fade_ms, args.rate)
        buf, gain_db = normalize(buf, np, args.target_rms_db)
        path = os.path.join(audio_dir, "%s.wav" % key)
        write_wav(path, buf, args.rate, np)
        rms = float(np.sqrt(np.mean(buf.astype(np.float64) ** 2)))
        # 风险提示统一放到所有片段都切完之后再判定：判断"被提上来的到底是内容还是噪声"
        # 要看这个片段的频谱平坦度**相对其它片段**高多少，绝对阈值不可靠
        # （实测：真实乐音 ~3e-5，而近乎静音+底噪的那段是 0.15 —— 两者差三个数量级，
        #   但 0.15 本身低于任何"白噪声"的常识阈值 0.3~1.0，用绝对阈值会误判成"没问题"）。
        clips[key] = {
            "file": "audio/%s.wav" % key,
            "path": path,
            "from": round(t0, 3), "to": round(t1, 3),
            "seconds": round(t1 - t0, 3),
            "segment": why,
            "gain_db": round(gain_db, 2),
            "peak_dbfs": round(20 * float(np.log10(max(float(np.max(np.abs(buf))), 1e-9))), 2),
            "rms_dbfs": round(20 * float(np.log10(max(rms, 1e-9))), 2),
            "quiet_level_before_db": None if quiet_before is None else round(quiet_before, 2),
            "spectral_flatness": None if flatness is None else round(flatness, 5),
            "label": "原声·%s（%.2f–%.2fs）" % (why, t0, t1),
        }

    for key, seg_name in mapping.items():
        if seg_name not in segs:
            warnings.append("映射里的动作「%s」不在 --segments 里，跳过 %s" % (seg_name, key))
            continue
        t0, t1 = segs[seg_name]
        cut(key, t0, t1, seg_name)

    # click / dive 用起音检测挑，不占动作段
    ct0, ct1 = onset_pick(pcm, np, args.rate, args.click_sec)
    cut("click", ct0, ct1, "起音最脆的一截")
    dt0, dt1 = onset_pick(pcm, np, args.rate, args.dive_sec, search_from=0.3)
    cut("dive", dt0, dt1, "起音最脆的一截（加长）")

    amap = {
        "source_video": args.video,
        "decoded": {"sample_rate": args.rate, "source_rate": src_rate,
                    "duration_sec": round(total, 3)},
        "mapping": mapping,
        "clips": clips,
    }

    # ---- 事后统一判定"大幅提升"的风险 ----
    # 参照系取"没有被提升的那些片段"的平坦度中位数，再看被提升的那段高出多少。
    refs = [v["spectral_flatness"] for v in clips.values()
            if v["gain_db"] <= 12 and v.get("spectral_flatness")]
    ref = float(np.median(refs)) if refs else None
    for key, v in clips.items():
        if v["gain_db"] <= 12:
            continue
        flat = v.get("spectral_flatness")
        if ref and flat and flat > max(0.03, ref * 20):
            warnings.append(
                "%s 在源视频里几乎是静音（比其它段小 %.1f dB），为了齐平提了 %.1f dB。"
                "而它的频谱平坦度 %.4f 是其它段（%.5f）的约 %.0f 倍 —— **噪声样**，"
                "提上来更可能是嘶声而不是内容。建议把 %s 映射到别的动作段，"
                "或者干脆不给这个事件配音。"
                % (key, v["gain_db"], v["gain_db"], flat, ref, flat / ref,
                   [k for k, s in mapping.items() if s == v["segment"]] or ["它"]))
        elif ref:
            warnings.append(
                "%s 比其它段小 %.1f dB，提了 %.1f dB 才齐平。频谱平坦度 %.4f"
                "（其它段 %.5f）差别不大，提上来的应该还是内容，听一下确认即可。"
                % (key, v["gain_db"], v["gain_db"], flat or 0.0, ref))
        else:
            warnings.append("%s 提了 %.1f dB 才齐平，听一下确认是否有嘶声。"
                            % (key, v["gain_db"]))

    with open(map_path, "w", encoding="utf-8") as fh:
        json.dump(amap, fh, ensure_ascii=False, indent=1)

    specs = ",".join("file:%s:%s" % (k, v["path"]) for k, v in clips.items())
    print(json.dumps({
        "ok": True,
        "pkg": pkg,
        "video": args.video,
        "decoded": amap["decoded"],
        "clips": {k: {kk: vv for kk, vv in v.items() if kk != "path"} for k, v in clips.items()},
        "warnings": warnings,
        "map": map_path,
        "next": 'node <forge-local>/scripts/forge.mjs audio --pkg "%s" --replace --file "%s"'
                % (pkg, specs),
        "note": ("注册完再跑一次带 --relabel 的本脚本，把标签换成原声来源说明。"
                 "用的是 --replace：既然全换成原声，就不该留着旧的合成音效。"),
    }, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
