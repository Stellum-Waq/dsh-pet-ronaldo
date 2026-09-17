# 从视频生成桌宠（video 路线）

> 用户说「我拍了一段视频，能不能直接变成桌宠」「绿幕素材能抠出来做桌宠吗」时看这里。
>
> 命令入口：`node forge.mjs video --pkg <目录> --video <视频> …`
> 实现：`scripts/lib/video.mjs`（抽帧/抠像/切分/装配）+ `scripts/py/extract_frames.py`（OpenCV 抽帧）

---

## 0. 一句话原理

**抽帧 → 抠幕布 → 按动作切段 → 并集包围盒对齐落格 → 图集 + pet.json**。
产物和 `generate` / `blender-*` 完全一样，所以 `verify` / `inspect` / `install` / `share` 全都照用。

---

## 1. 先看有没有解码器

```powershell
node forge.mjs doctor     # 看 checks.videoEngines 与 routes.video
```

| 情况 | `routes.video` | 说明 |
| --- | --- | --- |
| 有 ffmpeg | `ready` | 最稳，还能顺手从视频里抽音效（`--audio-from-video`） |
| 只有 python+OpenCV | `ready` | 本机有 Anaconda 时常见；OpenCV 自带一份 FFmpeg，够抽帧 |
| 都没有 | `need-ffmpeg-or-opencv` | 给出三条出路：装 ffmpeg / 装 opencv-python / 自己抽好帧用 `--frames-dir` |

两个引擎的差别：

| | ffmpeg | python+OpenCV |
| --- | --- | --- |
| 抽帧 | ✅ | ✅ |
| 抽音轨 | ✅ | ❌（OpenCV 不暴露音频） |
| 缩放/转码 | ✅ | ✅（只做缩小） |
| 依赖 | 一个 exe | python + `opencv-python` |

> ⚠️ 本机踩过的坑：**Blender 不能当视频解码器**。这台开发机的 Blender 5.2 构建里
> `image_settings.file_format` 的枚举里**没有 `FFMPEG`**（即编译时没带 FFmpeg），
> 所以 VSE 既编不了也解不了视频。别打它的主意。

---

## 2. 三种输入方式

### ① 一个视频 + 时间段（最常用）

```powershell
node forge.mjs video --pkg "D:\代码\桌宠\pets\my-cat" `
  --video "D:\videos\cat-green.mp4" `
  --segments "idle:0-2.5,waving:2.5-5,jumping:5-7.4" `
  --name "绿幕猫" --id my-cat
```

### ② 每个动作一段视频（最准）

```powershell
node forge.mjs video --pkg <目录> --videos "idle=idle.mp4,waving=wave.mp4,jumping=jump.mp4"
```

### ③ 自动切分（视频里动作之间有明显停顿）

```powershell
node forge.mjs video --pkg <目录> --video <视频> --auto-segments 3 --actions idle,waving,jumping
```

自动切分有**两套策略**，按素材自动选：

| 策略 | 触发条件 | 做法 |
| --- | --- | --- |
| `pauses` 停顿型 | 存在"夹在两段真实动作之间"的能量低谷 | 在停顿处下刀；若停顿紧挨着孤立尖峰（姿态边界），吸附到尖峰上 |
| `transitions` 转折型 | 没有停顿，动作是硬切/一轮一轮做的 | 在**局部极大**（姿态边界）处下刀 |
| `equal` 等分 | 上面都不成立 | 等分，并标 `synthetic: true` 提醒"划分可能不准" |
| `flat` 平台 | 运动曲线是平台（整段匀速） | 挑最强的位置，标 `ambiguous: true`，明确说"位置等于随机" |

**自动切分只当草稿**：报告里一定会附上划分结果和一句"要精确就显式给 `--segments`"。

### ④ 已经抽好帧了

```powershell
node forge.mjs video --pkg <目录> --frames-dir "D:\frames\cat" --fps 12 --segments "idle:0-2,waving:2-4"
```

`--frames-dir` 里的帧按文件名排序，第 i 帧的时间 = `i / --fps`。

---

## 3. 抠幕布（chroma key）

```powershell
--key auto          # 默认：从画面**边缘**取中位色当幕布色（角色在中间，边缘基本都是幕布）
--key 0x00FF00      # 手填：#00ff00 / 0f0 / green / chroma / blue / 240,140,40 都认
--no-key            # 不抠（素材本身就带透明通道，或后面要手动处理）
--similarity 0.16   # 内阈值：越小抠得越少
--blend 0.10        # 羽化带
--spill 0.6         # 绿边（溢色）抑制强度
--erode 0           # alpha 腐蚀半径，用来收掉残留的一圈幕布边
```

阈值语义（在 Cb/Cr 色度平面上算距离，和 ffmpeg 的 `chromakey` 同思路）：

```
d = 像素色度到幕布色度的距离 / 255
d ≤ similarity            → 全透明
similarity < d < sim+blend → 羽化（线性过渡）
d ≥ sim+blend             → 保留，并做溢色抑制
```

**报告里看三个数**（`chroma`）：

| 字段 | 正常范围 | 异常说明 |
| --- | --- | --- |
| `avgTransparentRatio` | 0.5 ~ 0.97 | < 0.05 → 背景可能不是纯色幕布（警告）；> 0.97 → **直接报错**：幕布色选错，或角色在画面里太小（<3%） |
| `avgSemiRatio` | < 0.05 | 太大说明羽化带太宽，边缘会发虚 |
| `keySource` | `auto` / `explicit` | 手填的颜色会标 `explicit` |

抠不干净怎么办（按顺序试）：

1. `--similarity 0.22`（背景有渐变/阴影）；
2. `--erode 1`（残留一圈幕布边的经典解法）；
3. `--spill 0.9`（边缘发绿）；
4. 换一块**更均匀**的幕布重拍 —— 布料的褶皱、反光和阴影是抠不干净的头号原因。

> 抠像在**我们自己的 JS**里做（不是交给 ffmpeg 的滤镜），这样两个引擎结果一致、
> 也能在 `scripts/verify-video.mjs` 里离线复现。ffmpeg 只负责"把帧吐出来"。

---

## 4. 落格与对齐（为什么不会缺头断腿）

沿用 `anim.mjs` 那套**两趟渲染**：

1. 把所有动作的帧量出**并集包围盒**（`unionBounds`）；
2. 全体帧共用这一个包围盒与**统一次缩放**，再投进严格 `cellW×cellH` 的格子（`projectFrames`）。

好处：帧间相对位移被精确保留（跳跃真的会往上跳），而体型在所有动作里一致。
`--loose failed,jumping` 可以把某些"大幅位移"的动作单独算包围盒 —— 否则摔倒时甩出去半个身位，
会把所有动作一起缩小。

格子尺寸默认 `8×11 · 192×208`，`--cols/--rows/--cell 256x256` 可改。

---

## 5. 顺手抽视频原声当音效（需要 ffmpeg）

```powershell
--audio-from-video celebrate@5.2-6.4     # 第 5.2~6.4 秒的音频 → audio/celebrate.mp3
```

会写进 `pet.json` 的 `audio`，安装后"对话完成"就会播这段原声。

---

## 6. 出问题先看这几个产物

| 产物 | 用途 |
| --- | --- |
| `video-frames/` | 抽出来的**原帧**（没抠过）—— 判断"是抽帧错了还是抠像错了" |
| `video-samples/` | 每个动作头两帧**抠完落格**的样子 —— 直接看抠像边缘干不干净 |
| `inspect-sheet.png` | `forge.mjs inspect --pkg <目录>` 生成，带棋盘底的动作总表 |
| 报告的 `audit` | 图集自检：每格边缘有没有非透明像素（跨格串帧的典型症状） |
| 报告的 `steps` / `warnings` | 用了哪个引擎、抽了多少帧、切分策略、要不要人工复核 |

**一定要做目视确认**（这是本技能的老规矩）：`inspect` 之后用 dsh-eye 的 `vision.mjs` 看图，
确认"每格一个完整角色、边缘没有绿边、动作行没错位"，再把结论告诉用户。

---

## 7. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `没有可用的视频解码引擎` | 既没 ffmpeg 也没 opencv | `winget install Gyan.FFmpeg`，或 `pip install opencv-python`，或 `--frames-dir` |
| `python 抽帧没有返回 JSON` | python 侧异常 | 直接跑 `python scripts\py\extract_frames.py probe <视频>` 看输出（它**总是**输出一个 JSON） |
| 中文路径相关的怪问题 | Windows 上 `cv2.imwrite` **不支持中文路径** | 脚本已经统一改用 `imencode(...).tofile()`；自己写脚本时别用 `imwrite` |
| 抽出来的帧是黑的/重复的 | H.264 随机访问点很粗 | 不要逐段 seek；已经在一次顺序解码里按时间采样 |
| 宠物是"绿底小人" | 没抠像（`--no-key`）或抠得不够 | 看报告 `chroma`，调 `--similarity` |
| 动作被切错 | 自动切分只是草稿 | 用 `--segments` 显式给时间段（最可靠） |
| 某一帧缺头/缺腿 | 该动作位移特别大 | 加进 `--loose`（单独算包围盒） |
| 帧数太多、很慢 | 目标 fps 太高 | 降 `--fps`（8~12 够用）或缩短 `--start/--end` |
