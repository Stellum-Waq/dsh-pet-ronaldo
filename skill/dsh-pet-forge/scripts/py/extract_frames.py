#!/usr/bin/env python
# =============================================================================
# dsh-pet-forge · 视频抽帧（OpenCV 引擎）
# -----------------------------------------------------------------------------
# 为什么有这个文件：Node 没有内置的视频解码器，而 ffmpeg 不一定装了。
# 但「机器上有 Anaconda / python + opencv-python」是很常见的情况，而 OpenCV 自带
# 一份 FFmpeg 用于 VideoCapture —— 于是用它当第二条抽帧通道。
#
#   python extract_frames.py probe   <video>
#   python extract_frames.py extract <video> <outDir> <fps> <start> <end> <maxWidth> [<maxFrames>]
#
# 两种模式都只往 stdout 打**一个 JSON 对象**，便于 Node 侧解析。
#
# ⚠️ 踩过的坑（实测 OpenCV 4.13 / Windows）：
#   · cv2.VideoCapture(中文路径)   → 可用
#   · cv2.imwrite(中文路径)        → **失败**（返回 False，且文件不存在）
#   · cv2.imencode(...).tofile(中文路径) → 可用  ✅ 所以本脚本一律走 imencode+tofile
#   · 输入视频里的中文/空格路径同理，别用 imread，用 np.fromfile + imdecode
# =============================================================================
import json
import os
import sys

# ⚠️ 另一个坑：Windows 上 Python 往**管道**写 stdout 时用的是本地代码页（cp936），
# 中文会变成 GBK 字节，Node 侧按 UTF-8 解出来就是"乱码 JSON"。
# 所以这里强制 UTF-8，别指望环境变量 —— 调用方（Node）不会替我们设。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover - 老 Python 没有 reconfigure
    pass


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(msg):
    emit({"ok": False, "engine": "cv2", "error": str(msg)})
    sys.exit(0)  # 用 0 退出：错误信息走 JSON，别让调用方把 stderr 当崩溃


def load_cv2():
    try:
        import cv2  # noqa
        return cv2
    except Exception as exc:  # pragma: no cover - 环境问题
        fail("这台机器上的 python 没有 opencv-python（%s）" % exc)


def probe(video):
    cv2 = load_cv2()
    if not os.path.exists(video):
        fail("视频文件不存在：%s" % video)
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        fail("OpenCV 打不开这个视频（编解码器不支持，或文件损坏）：%s" % video)
    fps = float(cap.get(cv2.CAP_PROP_FPS)) or 0.0
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 0
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 0
    fourcc = int(cap.get(cv2.CAP_PROP_FOURCC)) or 0
    codec = "".join([chr((fourcc >> (8 * i)) & 0xFF) for i in range(4)]).strip("\x00")
    # 旋转元数据：手机竖拍常见，OpenCV 默认会自动转，这里报出来便于排查
    try:
        rotation = float(cap.get(cv2.CAP_PROP_ORIENTATION_META))
    except Exception:
        rotation = 0.0
    cap.release()
    duration = (frames / fps) if fps > 0 else 0.0
    emit({
        "ok": True,
        "engine": "cv2",
        "cv2": cv2.__version__,
        "video": video,
        "width": width,
        "height": height,
        "fps": round(fps, 4),
        "frames": frames,
        "duration": round(duration, 4),
        "codec": codec,
        "rotation": rotation,
        "hasAudio": None,  # OpenCV 不暴露音轨信息，音频请用 ffmpeg 通道
    })


def extract(video, out_dir, target_fps, start, end, max_width, max_frames):
    cv2 = load_cv2()
    import numpy as np

    if not os.path.exists(video):
        fail("视频文件不存在：%s" % video)
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        fail("OpenCV 打不开这个视频：%s" % video)

    src_fps = float(cap.get(cv2.CAP_PROP_FPS)) or 0.0
    src_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 0
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 0
    if src_fps <= 0:
        src_fps = 25.0  # 有些容器不报 fps，给个保守默认，别让它除零

    # 命令行传进来的全是字符串：一律先转数字再比较，
    # 否则 `frame.shape[1] > max_width` 这种比较会直接 TypeError（踩过）。
    target_fps = float(target_fps or 0)
    start = float(start or 0)
    end = float(end or 0)
    max_width = int(float(max_width or 0))
    max_frames = int(float(max_frames or 400))

    target = target_fps if target_fps > 0 else src_fps
    start = max(0.0, start)
    duration = src_frames / src_fps if src_frames > 0 else 0.0
    end = end if end > 0 else duration
    if duration > 0:
        end = min(end, duration)
    if end <= start:
        fail("时间区间非法：start=%s end=%s（视频时长 %s 秒）" % (start, end, round(duration, 2)))

    start_idx = int(round(start * src_fps))
    end_idx = int(round(end * src_fps)) if duration > 0 else 10 ** 9

    # 采样点：按"时间轴等间隔"换算成帧号，避免 fps 换算的累积漂移。
    # 不用 cap.set() 逐帧 seek：H.264 的随机访问点很粗，逐段 seek 会拿到重复帧。
    wanted = []
    t = start
    while t < end - 1e-9 and len(wanted) <= max_frames:
        idx = int(round(t * src_fps))
        if not wanted or idx != wanted[-1]:
            wanted.append(idx)
        t += 1.0 / target

    if len(wanted) > max_frames:
        fail(
            "按 %.2f fps 从 %s 秒里要抽 %d 帧，超过上限 %s。"
            "请降低 --fps、缩短区间，或用更大的 --max-frames。"
            % (target, round(end - start, 2), len(wanted), max_frames)
        )

    os.makedirs(out_dir, exist_ok=True)
    cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, wanted[0]))
    next_want = 0
    read_idx = max(0, wanted[0])
    files = []
    while next_want < len(wanted):
        ok, frame = cap.read()
        if not ok or frame is None:
            break
        if read_idx == wanted[next_want]:
            if max_width and frame.shape[1] > max_width:
                scale = float(max_width) / frame.shape[1]
                frame = cv2.resize(
                    frame,
                    (int(max_width), max(1, int(round(frame.shape[0] * scale)))),
                    interpolation=cv2.INTER_AREA,
                )
            name = "f_%05d.png" % next_want
            path = os.path.join(out_dir, name)
            ok_enc, buf = cv2.imencode(".png", frame)
            if not ok_enc:
                fail("PNG 编码失败（第 %d 帧）" % next_want)
            buf.tofile(path)  # ← 中文路径唯一可行的写法，别换成 imwrite
            files.append({"path": path, "t": round(read_idx / src_fps, 4), "index": read_idx})
            next_want += 1
        read_idx += 1
    cap.release()

    if not files:
        fail("一帧都没抽到（区间 %s~%s 秒可能落在视频之外）" % (start, end))

    emit({
        "ok": True,
        "engine": "cv2",
        "cv2": cv2.__version__,
        "video": video,
        "outDir": out_dir,
        "srcFps": round(src_fps, 4),
        "srcFrames": src_frames,
        "srcWidth": width,
        "srcHeight": height,
        "duration": round(duration, 4),
        "targetFps": round(target, 4),
        "range": [start, round(end, 4)],
        "count": len(files),
        "files": files,
    })


def main():
    argv = sys.argv[1:]
    if len(argv) < 2:
        fail("用法：extract_frames.py probe <video> | extract <video> <outDir> <fps> <start> <end> <maxWidth> [<maxFrames>]")
    mode = argv[0]
    if mode == "probe":
        probe(argv[1])
    elif mode == "extract":
        if len(argv) < 7:
            fail("extract 需要 7 个参数：<video> <outDir> <fps> <start> <end> <maxWidth> <maxFrames>")
        extract(
            argv[1], argv[2], argv[3], argv[4], argv[5], argv[6],
            argv[7] if len(argv) > 7 else "400",
        )
    else:
        fail("未知模式：%s" % mode)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # 任何意外都变成 JSON，别让 Node 侧只看到 stderr
        fail("未预期的错误：%r" % (exc,))
