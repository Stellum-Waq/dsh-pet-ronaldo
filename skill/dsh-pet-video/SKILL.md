---
name: dsh-pet-video
description: >
  把一段**视频**变成 DSH 桌面宠物（真人 / 宠物 / 玩偶 / 任何拍出来的主体都行）的完整工作流。
  覆盖：判断该走色键还是人体分割、抽帧与抠像、按运动量挑动作分段、
  把原视频的**声音**按动作切出来给宠物配音、绕开这条路线上踩过的坑
  （含两处上游已修好的退路 bug）、装配 / 注册 / 渲染验证。
  Use this skill whenever 用户说「把这个视频做成桌宠」「我有段视频/录像/绿幕素材/gif，能做桌宠吗」
  「用这段素材做个桌面宠物」「真人桌宠」「把这段舞蹈/搞笑视频变宠物」
  「视频转桌宠」，或提到 dsh-pet-video、video 路线、抠像、人体分割、frames-dir、
  或手上已经有视频/帧序列却想让它出现在 DSH 右下角或桌面上——
  即使没说"技能"两个字也要用本技能。
  音频相关同样要用：用户说「桌宠的声音不对/没适配」「要用原视频的声音」
  「给这只桌宠配音」「动作和声音对不上」「音效换成视频原声」「宠物叫得难听」时，
  读本技能的 references/audio.md——那里有事件↔音效的契约、无 ffmpeg 抽原声的办法，
  以及"近乎静音的片段被提 20+dB 会变成嘶声"这个坑的实测判据。
  它是 dsh-pet-forge 的**视频路线专精补充**：dsh-pet-forge 负责生图/3D/管理，
  本技能负责"素材已经有了、是拍出来的"这一类。
---

# dsh-pet-video · 把一段视频做成桌宠

用户手上有视频时，**不要绕道去生图**——视频里的真实动作就是最好的素材。
但视频路线上有几个真实的坑，默认流程踩上去会得到「看起来跑通了、其实一塌糊涂」的结果。
这个技能的职责就是把这条路一次走通。

## 和 dsh-pet-forge 的分工

| | 负责 |
|---|---|
| `dsh-pet-forge` | 生图（Tier A/B）、Blender 3D、**合成**音效、**注册/列表/卸载/预览**、分享到宠物社区 |
| **本技能** | 素材**已经是拍好的视频**时的：解码、抠像/分割、分段、**把原声切出来配音**、装配指令、渲染验证 |

四条路线（A 单图、B 多帧生图、C 3D、D 视频）的**产物是同一套宠物包**，
所以最后照样用 `dsh-pet-forge` 的 `install` / `list` / `share`。先读一遍
`dsh-pet-forge` 的 SKILL.md 再动手不会亏，尤其是契约（图集 8×11 · 192×208）和
"注册即校验"那两节。

---

## 第 0 步 · 先认清这台机器上的两个陷阱

### 陷阱一：`routes.video` 会说谎

跑 `dsh-pet-forge` 的 `doctor`，你会看到 `routes.video: need-ffmpeg-or-opencv`。
**先别急着装 ffmpeg。** 在 DSH 沙箱下这个探测**必然失败**，原因是：
探测用的是 Node 的 `child_process.spawnSync`（默认管道 stdio），而沙箱禁止子进程开管道，
每次都会 `EPERM`。装了 ffmpeg 也一样探不到——白白花掉一次下载。

自己确认真相（直接从 shell 跑，PowerShell 自己的管道不受影响）：

```powershell
python -c "import cv2; print(cv2.__version__)"
python -c "import torch, torchvision; print(torch.__version__, torchvision.__version__)"
```

有 OpenCV 或 torch 就够了。**你不需要 ffmpeg**——抽帧这件事本技能用 Python 自己做。

### 陷阱二：`--frames-dir` 和 `--no-key` 这两条退路（**上游已修，见下**）

这两条退路以前都会被 `dsh-pet-forge` 的上游 bug 堵死：

1. `forge.mjs` 判断的是 `args.framesDir`，而命令行解析器产出的键是 `frames-dir`，
   恒为 `undefined` → 「自己抽好帧喂进去」这条退路**永远不会生效**，
   于是引擎探测一失败就整条路判死。
2. `video.mjs` 先 `parseChromaColor(opts.key)` 再判断 `noKey`，
   而 `parseChromaColor('none')` 返回 `null` 直接报错退出 →
   CLI 的 `--no-key`（它会把 key 翻成 `'none'`）**永远走不通**。
   而没有幕布、必须用自带 alpha 的素材（也就是人体分割的产物）恰好就要靠它。

> ✅ **两个 bug 都已修在 `dsh-pet-forge` 上游（v2.2.0 起）。**
> 正常情况下你**什么都不用做**，直接 `forge.mjs video …` 即可。
> `scripts/verify-video.mjs` 里有两条 CLI 回归专门守着它们：
> 「探不到任何解码引擎时 `--frames-dir` 依然可用」和「`--no-key` 真的走得通」。

只有在**更旧的 forge** 上、且 `doctor` 报 `这台机器没有可用的视频解码引擎`
而你手里明明已经有帧时，才需要退回打补丁的走法：

```powershell
node "<本技能>\scripts\patch-forge.mjs" --dst "<工作区>\_work\forge-local"
```

返回里的 `entry` 就是后面所有 forge 命令要用的路径。
补丁脚本会自己核对源码：如果已经是修好的版本，它会报
`补丁 1 打不上：forge.mjs 的 --frames-dir 判断已经被改过或删掉了` ——
看到这句就说明**不需要**它，直接用现成的 forge。

---

## 第 1 步 · 判断：色键，还是人体分割？

这是整条路上最重要的一个分叉，**用数据决定，不要凭感觉**：

```powershell
python "<本技能>\scripts\probe_video.py" --video "<视频>" --out "<工作区>\_work\probe"
```

看返回的 `verdict`：

| verdict | 含义 | 走法 |
|---|---|---|
| `chroma-ok` | 画面边缘颜色很稳（std < 12），是幕布/纯色墙 | 用 forge **原生色键**（`--key auto`），别绕道分割——色键更快，而且自带 `despill` 去白边 |
| `scene` | 边缘又花又变，是真实现场背景 | 走**人体分割**（第 2 步）。色键在这种素材上没有任何阈值能救 |

判断依据是画面四周一圈像素的颜色标准差。真实房间（办公室、家里、街景）动辄 50+，
绿幕通常在 10 以下。`--out` 还会顺带落一张联络图，**先看一眼**：
它决定了你后面是要"抠绿边"还是"把人从生活场景里摘出来"，两者的调参方向完全不同。

> 分割这条路**只做人体**（DeepLabV3 的 VOC person 类）。
> 主体是猫狗玩偶之类，要么用 `chroma-ok` 路线拍绿幕，要么走 `dsh-pet-forge` 的生图路线。

---

## 第 2 步 · 抽帧 + 抠像（`scene` 才需要）

```powershell
python "<本技能>\scripts\seg_frames.py" `
  --video "<视频>" --out "<工作区>\_work\frames" --fps 12 `
  --torch-home "<工作区>\_work\torch-cache"
```

产出 `<out>/frame_0000.png …`（带 alpha 的 RGBA）+ `<out>/../seg-stats.json`。

**`--fps` 是个契约**：这个值必须和后面 `forge video --fps` 完全一致，
否则 `--segments` 里的秒数会整体错位——切出来的动作全是错位的，而且不报错。

`--torch-home` 默认落在输出目录旁边，因为 torch 默认的 `~/.cache/torch` 在工作区沙箱里
写不进去（会 `PermissionError`）。第一次跑要下 42MB 权重，之后就快了。

参数怎么调、每个旋钮的方向，见 [`references/tuning.md`](references/tuning.md)。
先别动默认值，QA 看过（第 3 步）再决定。

---

## 第 3 步 · 目视确认（**不能跳**）

```powershell
python "<本技能>\scripts\qa_frames.py" --frames "<工作区>\_work\frames" --n 8
```

然后**必须**把生成的检查图交给视觉模型看（当前模型能直接看图就直接看，
否则用 dsh-eye 的 `vision.mjs`）。重点问三件事：
人的轮廓完整吗？头/手/腿有没有被切？有没有残留背景？

为什么非看不可：alpha 面积这类数字**看不出**"少一条腿"或"右边半张桌子被吃进来"。
真实踩过的例子——人顶天立地时 mask 同时贴住上下边缘，背景被腰斩成左右两半，
从 `(0,0)` 泛洪够不到另一半，于是右半背景被当成"内部空洞"补实，
面积从 0.39 暴涨到 0.72。数字异常是看得见的，但如果你只看"跑通了"就交付，
用户拿到的是半张桌子。（`seg_frames.py` 已经修好了这个，但**别的毛病还是要靠眼睛**。）

数字上的体检：`qa_frames.py` 会报 `suspect_frames`（面积偏离中位数太多的帧）。
有的话回第 2 步调参，别硬着头皮往下走。

---

## 第 4 步 · 挑动作分段

```powershell
python "<本技能>\scripts\plan_segments.py" --stats "<工作区>\_work\seg-stats.json" `
  --window 1.0 --frames "<工作区>\_work\frames"
```

它会用**免费可得的信号**做分配（运动量、主体高低、主体占幅、主体"由远及近"的趋势）：

| 动作 | 挑什么 | 为什么 |
|---|---|---|
| `running` | 运动量最大 | "正在干活"就该是最忙的那段 |
| `failed` | 主体最小/最远 | 退缩、蔫掉、走远，视觉上就是"出错了" |
| `jumping` | 主体由远及近/由蹲到起 | 画面里人越来越大 = 朝你冲过来，最像"完成时跳一下" |
| `idle` | 剩下里最平静 | 待机不该打扰你 |
| `waiting` | 剩下里第二平静 | 等回复，也不该闹 |
| `review` | 剩下里动作最多 | 思考时带点小动作最好 |

返回值里的 `segments` 就是可以直接粘贴的字符串。

**但它只是草稿。** 自动分配只懂"运动特征像"，不懂内容语义——
它可能把"鞠躬"派给 `jumping`。所以：**把 `segments` 念给用户核对，或者自己对着联络图看一眼。**
用户说"你决定"时才可以跳过核对（此时要在交付时说明你切在哪、依据是什么）。

---

## 第 5 步 · 一次性问完（别一问一答）

用 `ask_user_question` **一次**问完，每题的推荐项放第一个并在 label 结尾写「（推荐）」：

1. **分段方案**：整段当主循环 + 我挑片段派生其他状态（推荐）／我给你时间点／自动切分给我看结果
2. **状态数**：这直接决定每段多长。素材只有 T 秒、要 6 个状态，每段就只有 T/6 秒。
   素材短（< 10 秒）时要主动说清这个取舍，让用户在"全状态覆盖"和"每段更自然"之间选。
3. **音效**：`celebrate` / `failed` / `click` 三件套是性价比最高的；`dive`（连点三次）、
   `boot`（登场）、`waiting` 锦上添花
4. **大小**：真人素材建议大一点（224px 左右）。小尺寸下真人的脸基本看不清，
   而两足人形在竖屏里比例又细又高，太小会像一根牙签
5. **名字**

顺手交代一句本机限制：**TTS 不一定可用**（`doctor` 的 `checks.tts` 说不行就是不行的，
本机合成失败时不要许诺"会说话的宠物"，改用音效）。

---

## 第 6 步 · 生成 + 音效

```powershell
# 6a. 装配（注意用的是第 0 步那个**副本**的 forge.mjs）
node "<工作区>\_work\forge-local\scripts\forge.mjs" video `
  --pkg "<工作区>\pets\<id>" `
  --frames-dir "<工作区>\_work\frames" `
  --no-key --fps 12 --frames 8 `
  --segments "idle:0-1,waiting:1.2-2.2,review:2.4-3.4,running:4.7-5.7,failed:6.3-7.3,jumping:7.4-8.4" `
  --name "<名字>" --id <id> --size 224 --behavior idle
```

- `--no-key` 是关键：告诉它"alpha 我自己已经做好了，别动"，跳过它自己的抠像
- `--behavior idle` 不能漏：视频路线**没有 `states.look`**（16 方向转头需要多角度素材或 3D），
  而底层默认值是 `'look'`。不显式指定的话，`pet.json` 里会写上一个假装存在的能力。
  客户端会降级到 idle 首帧、不会崩，但它是在描述一只并不存在的宠物
- `--frames 8` = 每个动作取 8 帧（图集一行 8 格，这是上限）。
  真实的播放帧率由 `playFpsFor` 按「帧数 ÷ 片段时长」算，所以 1.0 秒的片段取 8 帧 ≈ 8fps 回放，接近原速
- 想看它到底切到了哪几帧：`<pkg>\video-samples\<动作>_0.png` 就是每段头两帧

```powershell
# 6b. 音频（**必须单独跑**）。首选：切原视频的声音，让宠物叫的是它自己的声音
python "<S>\scripts\extract_video_audio.py" `
  --video "<视频>" --pkg "<工作区>\pets\<id>" `
  --segments "<和第 6a 步一字不差的那串>" `
  --libs "<工作区>\pylibs"

# 注册（用 forge 自己的 audio 命令，触发器才会按契约推导）
node "<工作区>\_work\forge-local\scripts\forge.mjs" audio --pkg "<工作区>\pets\<id>" --replace `
  --file "file:celebrate:<pkg>\audio\celebrate.wav,file:failed:...,file:waiting:...,file:working:...,file:click:...,file:dive:..."

# 把 label 换成"原声·jumping（7.40–8.40s）"这种可读的来源说明
python "<S>\scripts\extract_video_audio.py" --pkg "<工作区>\pets\<id>" --relabel --libs "<工作区>\pylibs"
```

为什么优先用原声：视频路线默认配合成音效，于是**宠物在动、声音却和视频毫无关系**。
对真人/真实录像这类素材，这是最明显的出戏点。分段和声音同源，才是"这只宠物"该有的声音。

前提是先装解码器（**不需要 ffmpeg**）：

```powershell
python -m pip install --target "<工作区>\pylibs" --no-cache-dir av
```

PyAV 的 wheel 里自带 FFmpeg 库，进程内解码，不需要外部 exe——
`dsh-pet-forge` 那个 `--audio-from-video` 依赖真的 ffmpeg，本机没有就直接断，
而沙箱又可能连子进程管道都不给，所以别走那条路。

细节（事件↔键名的契约、响度统一、点击音的起音检测、
**以及"几乎静音的片段被提 20+dB 会变成嘶声"这个坑**）见
[`references/audio.md`](references/audio.md)。**动手前先读它**，那里有实测数据。

> ⚠️ 两个静默失败，都会被 `verify` 抓到：
> ① `video` 命令**不支持** `--audio`（源码里硬编码 `audio: undefined`），传了不报错、直接丢；
> ② `audio --replace` **只换 `audio`，不清 `triggers`/`interactions`**，
> 所以上一轮留下的键会继续挂着，变成指向不存在音频的悬挂触发器。
> 注册完务必核对：两张表里每个值都要能在 `audio` 里找到。

不想用原声（素材本身没声音、或声音不适合当音效）时，退回合成音效：

```powershell
node "<工作区>\_work\forge-local\scripts\forge.mjs" audio --pkg "<工作区>\pets\<id>" `
  --sfx celebrate,failed,click,dive,boot,waiting
```

```powershell
# 6c. 确认它真的进去了
node "<工作区>\_work\forge-local\scripts\forge.mjs" verify --pkg "<工作区>\pets\<id>"
```

`verify` 的 `info.audio` 条数要和你注册的一致，`human` 里会写「N 个音效」。
显示「0 个音效」就是第 6b 步没生效（多半是你以为 `--audio` 管用）。
顺便看一眼 `pet.json` 的 `behavior` 是 `idle` —— 这是最后一道"别假装有能力"的检查。

**`verify` 只证明文件在、格式对，不证明有声音。**
最后一定要逐个 `play` 让宿主真播一次：

```powershell
node "<工作区>\_work\forge-local\scripts\forge.mjs" play --id <id> --key celebrate
# failed / waiting / working / click / dive 都要过一遍，全部 ok:true 才算接完
```

---

## 第 7 步 · 安装 + 证明它真的在屏幕上

```powershell
node "<工作区>\_work\forge-local\scripts\forge.mjs" install --pkg "<工作区>\pets\<id>"
```

注册成功后桌宠会出现在界面右下角和桌面原生窗口上，**不需要刷新页面**。

**「日志说加载成功」不等于「屏幕上有东西」**，要做一次像素级确认：

```powershell
# 7a. 让插件抓一帧窗口内容（会写到工作区外，沙箱可能拒绝 → 按提示授权一次即可）
node "<dsh-ronaldo-pet>\scripts\verify-desktop.mjs" --base http://127.0.0.1:3080
```

```powershell
# 7b. **用我们自己的图集**重新比对
python "<本技能>\scripts\verify_render.py" `
  --frame "<dsh-ronaldo-pet>\.forge-test\desktop-frame.png" `
  --atlas "<工作区>\pets\<id>\atlas.png"
```

为什么 7b 不能省：`verify-desktop.mjs` 里取宠物的那行是
`pets.find(p => p.id === (… ? p.id : p.id))`——恒真，永远返回清单里**第一只**。
于是它拿别人的图集比你的画面，必然报"色差 23 偏大"，看着像你的素材坏了，
其实是它比错了对象。实测同一张抓帧：用错图集 diff=**23.4** 报警，用对图集 diff=**2.16** 完美匹配。

判据：diff < 12 且占幅与参考格相差 ≤ 6% 就算真的画出来了。

顺手还可以确认网页侧：
`GET /ronaldo-pet/asset/<id>/atlas.png` 应该返回 **HTTP 200 + image/png**，
字节数和本地 `atlas.png` 一致（对哈希最稳）。

---

## 必须如实告诉用户的三件事

不要为了让交付显得漂亮而隐瞒：

1. **没有 `look`（16 方向转头看光标）**。单机位视频只有一个角度，做不了。
   需要的话得走 `dsh-pet-forge` 的 3D 路线。别在报告里假装有。
2. **分割是语义分割，不是专业 alpha matting**。224px 下够看，细看边缘不如绿幕干净。
   而且**源视频怎么裁的，宠物就怎么裁**——如果原片把人顶天立地切了，
   宠物继承这个构图（`seg-stats.json` 里 `top≈0` / `bottom≈高度` 就是这个信号）。
3. **真人素材涉及肖像权**。做成自己用没问题；一旦要**分享/发布到宠物社区**，
   必须提醒用户先取得当事人同意。这一点在问"要不要共享"的时候一起说。

---

## 常见坑速查表

| 现象 | 真正的原因 | 处理 |
|---|---|---|
| `routes.video: need-ffmpeg-or-opencv` | 沙箱禁了 Node 管道 stdio，探测必然失败 | **别装 ffmpeg**，用 `python -c "import cv2"` 自己确认 |
| `这台机器没有可用的视频解码引擎`（哪怕有 cv2） | `args.framesDir` 键名 bug —— **已在 forge v2.2.0 修复** | 升级 forge；确属旧版才跑 `patch-forge.mjs` 用副本 |
| `无法理解的幕布颜色：none` | `parseChromaColor` 早于 `noKey` 判断 | 同上，副本已修 |
| 帧目录是空的，但脚本说"成功" | `cv2.imwrite` 在**非 ASCII 路径**上静默失败 | 脚本已改用 `imencode` + 自己写字节；自己写脚本时记住这条 |
| JSON 里中文全是乱码 | Python 按 cp936 编码 stdout，调用方按 UTF-8 解码 | 脚本已在开头 `reconfigure(encoding="utf-8")` |
| `PermissionError: ~/.cache/torch` | 权重缓存目录在工作区外 | `--torch-home` 指进工作区 |
| alpha 面积突然翻倍 | mask 贴住上下边缘导致背景被腰斩，泛洪够不到另一半 | `seg_frames.py` 已修（泛洪前补一圈背景）；自己写时记住 |
| 某个动作的片段明显错位 | `--fps` 和 `--fps-dir` 抽帧时用的 fps 不一致 | 两处必须相同 |
| `verify` 里 `0 个音效` | `video` 命令不支持 `--audio`，静默丢弃 | 用 `audio` 命令单独加 |
| 音效注册了但事件没声 | `audio --replace` 不清 `triggers`，留下悬挂键 | 核对两张表的值都在 `audio` 里，删掉孤儿 |
| 某个音效是一声"嘶" | 那一段在源视频里近乎静音，统一响度把它提了几十 dB | 换映射到别的动作段，或干脆不给这个事件配音（`references/audio.md` 第四节） |
| 报"色差 23 偏大" | `verify-desktop.mjs` 永远比第一只宠物 | 用 `verify_render.py` 比正确的图集 |
| 桌宠不显示新做的这只 | 期间默认宠物被切成别的了 | `install --pkg` 再跑一次（会抢回默认位），或设置里「⭐ 设为默认」 |
| 宠物边缘有一圈脏色 | 软 alpha 的半透明边缘混进了原始背景色 | `--ramp-lo 0.45`（收紧 matte）；或 `--flatten white` 后改用 forge 原生色键 |

---

## 参考文档（按需读，别一上来全读）

- [`references/workflow.md`](references/workflow.md) —— 完整端到端流程图与每步的判据、命令速查
- [`references/audio.md`](references/audio.md) —— **原声音频**：事件契约、PyAV 解码、切片与响度、静音段陷阱、注册与验收
- [`references/pitfalls.md`](references/pitfalls.md) —— 每个坑的现场记录：症状、根因、定位方法、修法
- [`references/tuning.md`](references/tuning.md) —— 抠像、分段、音频的参数怎么调、往哪个方向调

## 脚本

| 脚本 | 作用 |
|---|---|
| `scripts/patch-forge.mjs` | **仅旧版 forge 才需要**：复制 dsh-pet-forge 到工作区并修掉两个上游 bug（幂等；源码已修好时会报 `NOT-FOUND` 而不是硬改） |
| `scripts/probe_video.py` | 读元信息 + 判定 `chroma-ok` / `scene`，可选落联络图 |
| `scripts/seg_frames.py` | 抽帧 + DeepLabV3 人体分割 → RGBA 帧 + `seg-stats.json` |
| `scripts/plan_segments.py` | 运动量剖面 → 动作分配草稿 + `segments` 字符串 + 分镜图 |
| `scripts/qa_frames.py` | 抠像检查图（棋盘格底 + alpha 遮罩）+ 面积离群帧 |
| `scripts/extract_video_audio.py` | 切原声：按动作段切片 + 淡入淡出 + 统一响度 + 起音挑点击音 + 风险体检 |
| `scripts/verify_render.py` | 用**正确**的图集比对窗口抓帧，取代会比错对象的那个脚本 |
