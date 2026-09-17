# 坑的现场记录

每条都按同一结构写：**症状 → 根因 → 怎么一眼定位 → 怎么修**。
这些都不是"理论上的风险"，是实际把一段视频做成桌宠的全过程中真实撞到并修掉的。

---

## 1. 沙箱下 Node 的管道 stdio 被禁 → 解码引擎探测必然失败

**症状**

`dsh-pet-forge` 的 `doctor` 报 `route.video: need-ffmpeg-or-opencv`，
`checks.videoEngines.value` 是「一个都没有」。但 `python -c "import cv2"` 明明能跑。

**根因**

沙箱禁止子进程打开命名管道。Node 的 `child_process.spawnSync` 默认 `stdio: 'pipe'`，
于是任何"起个子进程读它 stdout"的探测都直接 `EPERM`。
`lib/video.mjs` 的 `findFfmpeg` / `findPython` / `probeCv2` 全都走这条路。

**一眼定位**

```powershell
node -e "const{spawnSync}=require('child_process');const r=spawnSync('python',['--version'],{encoding:'utf8'});console.log(r.error&&r.error.message, r.status)"
# → spawnSync python EPERM
```

**修**

两件事，缺一不可：

1. **别装 ffmpeg**。装了也探不到，纯浪费一次下载。
   直接用 Python 抽帧（`scripts/seg_frames.py`），它不经过 Node 的子进程管道。
2. **让 forge 走 `--frames-dir`**，但那需要先修坑 2（否则那条路是死代码）。

> 附带影响：PowerShell 里 `$x = node ...` 或 `... | Select-String` 这类
> **捕获子进程输出**的写法同样会 `Access is denied`（报 `Program 'node.exe' failed to run`）。
> 解决办法很简单：**让命令直接把输出打到控制台，不要接管道、不要赋给变量**。

---

## 2. `--frames-dir` 是死代码（上游 bug）

**症状**

明明给了 `--frames-dir`，仍然报「这台机器没有可用的视频解码引擎，导不了视频」。

**根因**

`forge.mjs`：

```js
if (!args.framesDir && engines.available.length === 0) {   // ← args.framesDir
```

但 `parseArgs` 产出的键是 `frames-dir`（**带横线**，第 1254 行就是用
`args['frames-dir']` 取的）。`args.framesDir` 恒为 `undefined`，
所以这个"没有解码引擎也能用现成帧"的退路**永远不会生效**。

**一眼定位**

```powershell
Select-String -Path "<forge>\scripts\forge.mjs" -Pattern "framesDir|frames-dir"
```

会看到同一份代码里两种写法并存。

**修**

`patch-forge.mjs` 补丁 `frames-dir-key`：`!args.framesDir` → `!args['frames-dir']`。

---

## 3. `--no-key` 永远走不通（上游 bug）

**症状**

```
error: 无法理解的幕布颜色：none（用 auto / 0x00FF00 / green / 蓝幕 blue 都行）
```

**根因**

`lib/video.mjs` 里的顺序错了：

```js
let keySpec = parseChromaColor(opts.key === undefined ? 'auto' : opts.key)
if (keySpec === null) return { ...report, error: `无法理解的幕布颜色：${opts.key}…` }
const noKey = opts.noKey === true || opts.key === 'none' || opts.key === false   // ← 太晚了
```

而 `parseChromaColor('none')` 命中不了任何分支（不是命名色、不是 6/3 位 hex、不是三元组），
返回 `null` → 直接报错退出。偏偏 `forge.mjs` 的 `--no-key` 就是把 key 翻成 `'none'`：

```js
key: args['no-key'] === true ? 'none' : args.key
```

**修**

`patch-forge.mjs` 补丁 `no-key-ordering`：把 `noKey` 的计算提到 `parseChromaColor` **之前**，
并让 `keySpec === null` 的报错只在 `!noKey` 时触发。

> 为什么这个 bug 卡得特别死：**任何没有幕布的素材都过不去**。
> 而"真实现场背景"恰恰是视频路线最常见的输入（家里、办公室、随手拍）。
> 换句话说，不改它，这条路只能处理绿幕素材。

---

## 4. `cv2.imwrite` 在非 ASCII 路径上静默失败

**症状**

脚本打印 `saved: 17`，`glob` 却找到 0 个文件，目录是空的。
**不抛异常、不返回错误**，`imwrite` 只是返回 `False`，而没人检查它。

**根因**

OpenCV 的 `imwrite` 在 Windows 上不处理 Unicode 路径。路径里有中文就写不出去。
中文用户几乎必然踩到（工作目录叫 `D:\代码\桌宠\`）。

**一眼定位**

```powershell
python -c "import cv2,numpy as np;print(cv2.imwrite(r'D:\代码\test.jpg', np.zeros((8,8,3),np.uint8)))"
# → False，而 D:\test.jpg 能写成功
```

**修**

一律走 `imencode` + 自己写字节：

```python
ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
with open(path, "wb") as fh:      # Python 的 open 处理 Unicode 路径没问题
    fh.write(buf.tobytes())
```

写文件优先用 PIL（Pillow 对 Unicode 路径是正常的），只有解码/编码需要 cv2。

---

## 5. 人顶天立地 → 泛洪补洞把半边背景吃进 alpha

**症状**

alpha 覆盖率从 0.39 突然变成 0.72，`bbox` 一直贴着画面右边（`x_max = 719`）。
肉眼看合成图：人物右边连着一整块背景。

**根因**

补内部空洞的标准做法是「从 `(0,0)` 泛洪背景，剩下为 0 的就是空洞」。
但这段视频是**竖屏、人几乎占满画面高度**，mask 同时贴住了上边缘和下边缘——
背景因此被切成**左半和右半两块**。从 `(0,0)` 出发只能淹到左半，
**右半从来不是"被背景连通的"**，于是整块右半背景被判定成"内部空洞"补实了。

**一眼定位**

```python
# 打印而不是猜：看 keep 的 bbox 是不是贴住了上下边缘
ys, xs = np.nonzero(keep)
print(xs.min(), ys.min(), xs.max(), ys.max(), keep.mean())
# → 105 0 614 1279 0.39    ← 上下都到边了，就是这个坑
```

再用 `debug` 打印 `holes` 的面积：正常应该接近 0（只有腿间/腋下那点），
出现 0.3+ 就说明泛洪没铺满背景。

**修**

**泛洪前先把画布四周补一圈背景**，让背景重新连通：

```python
pad = np.pad(keep, 1, mode="constant", constant_values=0)
m2 = np.zeros((pad.shape[0] + 2, pad.shape[1] + 2), np.uint8)
cv2.floodFill(pad, m2, (0, 0), 1)
holes = (pad[1:-1, 1:-1] == 0).astype(np.uint8)
```

补的这一圈只有 1 像素，但足以让左右两半背景在**图像外面**绕过去连成一体。

---

## 6. torch 权重缓存目录在工作区外

**症状**

```
PermissionError [WinError 5] 拒绝访问。: 'C:\Users\<你>/.cache\torch'
```

**根因**

torchvision 的预训练权重默认下到 `~/.cache/torch`，在工作区沙箱之外，写不进去。

**修**

在**导入 torch 之前**设好环境变量（权重下载时才读它）：

```python
os.environ.setdefault("TORCH_HOME", os.path.join(<工作区>, "torch-cache"))
```

`seg_frames.py` 默认就把缓存放在输出目录旁边，也可以用 `--torch-home` 指定。
权重 42MB（mobilenet）只在第一次下载。

---

## 7. Python JSON 里的中文变乱码

**症状**

Node 脚本输出的中文正常，Python 脚本输出的中文全是 `����`。
JSON 结构是好的，只有非 ASCII 内容坏了。

**根因**

Node 默认用 UTF-8 写 stdout；**Python 在 Windows 上默认用控制台代码页（cp936/GBK）**。
于是字节是 GBK，而调用方（harness / 终端）按 UTF-8 解码 → 乱码。
`json.dumps(..., ensure_ascii=False)` 把这个风险放大，因为它真的去输出了原始中文。

**一眼定位**

```powershell
python -c "import sys,locale;print(sys.stdout.encoding, locale.getpreferredencoding())"
# → cp936 cp936
```

**修**

每个脚本开头强制 UTF-8：

```python
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8")
```

（备选：`json.dumps(..., ensure_ascii=True)` 把所有中文转成 `\uXXXX`。
绝对安全但人读不了，只在极端情况下用。）

---

## 8. `video` 命令静默丢掉 `--audio`

**症状**

构建命令里明明带了 `--audio "sfx:celebrate,..."`，`verify` 却报「**0 个音效**」，
`pet.json` 里 `audio` 是空对象。**不报错、不警告。**

**根因**

`forge.mjs` 的 video 分支把 audio 硬编码掉了：

```js
audio: undefined,     // ← 无论命令行传什么都扔
```

（大概是因为视频路线本来设计成用 `--audio-from-video` 从视频抽音轨，
但走 `--frames-dir` 时没有视频，就干脆不接了。）

**修**

**音效必须单独跑一次**：

```powershell
node <forge> audio --pkg <pkg> --sfx celebrate,failed,click,dive,boot,waiting
```

然后**务必**用 `verify --pkg` 确认 `info.audio` 非空——这次就是靠 verify 才发现的。

---

## 9. `verify-desktop.mjs` 永远比第一只宠物

**症状**

窗口抓帧成功、确实有内容，但报「色差 23.4 偏大 —— 可能有缩放插值或颜色偏差」。
看着像素材颜色有问题。

**根因**

```js
const pet = pets.find((p) => p.id === (status.displayMode && pets.length ? p.id : p.id)) || pets[0]
```

`p.id === p.id` **恒真**，`find` 直接返回数组第一项——
也就是内置的 C罗，而不是你刚装的那只。于是它拿别人的图集逐格比对你的画面。

**一眼定位**

看它输出里的 `pet.id`。如果显示的不是你刚做的宠物 id，这个"色差"就毫无意义。

顺带一个佐证：它的 `topMatches` 里出现了 `refContentPct: 0` 的格子
（"参考图这一格是空的"）——而我们这只宠物的 `idle` 行是满 8 帧的。
说明它读的根本不是我们的图集。

**修**

用 `scripts/verify_render.py` 拿**正确的** `atlas.png` 重比。
实测同一张抓帧：

| 比对的图集 | 最佳匹配 | 均差 | 结论 |
|---|---|---|---|
| C罗（错的） | row 7 col 5 | **23.4** | 误报"颜色偏差" |
| 本宠物（对的） | row 7 col 5 | **2.16** | 完美匹配，占幅 43% 也对得上 |

---

## 10. `behavior` 默认是 `look`，但视频路线没有 `look`

**症状**

`pet.json` 里 `"behavior": "look"`，但 `states` 里没有 `look`（视频路线只有单机位，
做不出 16 方向转头）。客户端会降级到 idle 首帧、不会崩，但这是"假装有"。

**根因**

`lib/video.mjs` 的默认值是 `behavior: opts.behavior || 'look'`，
而 `lib/manifest.mjs` 的默认值是 `'idle'`。视频路线继承了前者。

**修**

在装配命令上显式加 `--behavior idle`（`video` 命令接受这个参数，直接写进 `pet.json`，
不用事后手工改文件）。已改过的包也可以直接编辑 `pet.json` 的 `behavior` 字段再 `install`。
不管用哪种方式，**交付时都要如实说明**这只宠物没有 `look`——不要含糊过去。

---

## 11. 默认宠物会在你验证期间被换掉

**症状**

`install` 返回 `focused: true, defaultPet: <你的>`，几分钟后再查 `list`，
`defaultPet` 变成了别的、你这只 `visible: false`。

**根因**

不是 bug。宠物面板是活的——用户可能正在界面上点「⭐ 设为默认」或拖动宠物
（桌面日志里能看到 `hover` / `mousedown` / `dragging` 事件）。
你自己跑 `verify-desktop` 期间，用户完全可能已经把默认切回去了。

**修**

交付前查一次当前默认：

```powershell
node <forge> list        # 看 settings.defaultPet 和每只的 visible
```

如果新宠物没在显示，再跑一次 `install --pkg` 抢回默认位（会问用户），
或者直接告诉用户去设置里点「⭐ 设为默认」。
**不要把"装好了"当成"正在显示"**——这两件事会脱钩。

---

## 12. 没有 ffmpeg 时，原声完全抽不出来

**症状**

想让宠物叫原视频的声音，但 `dsh-pet-forge` 唯一相关的入口 `--audio-from-video`
用不了：它内部是 `ffmpeg -vn -acodec libmp3lame`。
本机没有 ffmpeg，而且走 `--frames-dir` 时**连视频文件都不在**，那条路更是无从谈起。

**根因**

这条路把"抽音轨"这件事整个外包给了 ffmpeg。没有 ffmpeg = 完全没有替代方案，
于是宠物只能配合成音效，和视频里的真实声音脱节。

**修**

**不要为此装 ffmpeg。** PyAV 的 pip wheel 里**自带 FFmpeg 库**，可以进程内解码：

```powershell
python -m pip install --target "<工作区>\pylibs" --no-cache-dir av
```

- 必须用 `--target` 装进工作区：默认装到系统 `site-packages` 在工作区之外，沙箱会拒
- 脚本里 `sys.path.insert(0, "<工作区>/pylibs")` 之后 `import av` 即可
- 别用 `subprocess` 去调外部 ffmpeg.exe —— 沙箱下子进程管道同样可能被拒，
  而且多一个必须存在的二进制就多一处环境依赖

`scripts/extract_video_audio.py` 已经封装好（`--libs` 指定那个目录）。

---

## 13. `audio --replace` 不清 `triggers`，留下悬挂键

**症状**

用 `--replace` 把音效整批换成原声之后，`pet.json` 里已经没有 `boot` 这个音频了，
但 `triggers` 里**还挂着** `"boot": "boot"`，`interactions` 里也有一份 ——
指向一个不存在的音频键。

**根因**

```js
manifest.audio = args.replace ? result.audio : { ...(manifest.audio||{}), ...result.audio }
manifest.triggers = { ...(manifest.triggers || {}), ...result.triggers }          // ← 永远合并
manifest.interactions = { ...(manifest.interactions || {}), ...result.interactions }
```

`--replace` 只作用于 `audio` 这一张表，另外两张永远是与旧值合并。
上一轮注册过 `boot`，这一轮就算不再提供，它也会留下来。

**修**

注册完**核对一次**：`triggers` / `interactions` 里每个值都必须能在 `audio` 里找到。
对不上的直接编辑 `pet.json` 删掉，然后重新 `install`。
同时把磁盘上已经没人引用的音频文件也删掉，免得下次排查时被误导。

---

## 14. 统一响度把"近乎静音"提上来 = 嘶声

**症状**

把各段音频统一到同一响度之后，某一个音效听起来是一声"嘶——"的底噪，
而不是内容。触发它的那一刻明显很脏。

**根因**

源视频的响度分布很不均匀。这次的素材里，`idle` 段（0–1s）的 RMS 是 **-42.8 dBFS**，
比其它段小 22.8 dB；要"齐平"就得提 **+22.8 dB**。
而那一秒实际上几乎是静音 + 底噪，提上来放大的就是噪声本身。

**一眼定位**

量**频谱平坦度**（`extract_video_audio.py` 会报 `spectral_flatness`）：
0 附近是乐音/人声，1 附近是白噪声。

**但绝对阈值会骗你。** 实测：真实乐音的平坦度约 `3e-5`，
而那段近乎静音的是 `0.154` —— 两者差 **三个数量级**，
可 `0.154` 低于任何"白噪声"的常识阈值（0.3~1.0）。
先用绝对阈值 0.35 判，结果把它判成了"偏乐音，没问题"，**误报**。

正确判据是**相对比较**：拿"没有被提升的那些片段"的平坦度中位数当参照，
看被提升的那段高出多少倍。脚本现在用 `> max(0.03, 参照 × 20)`。
换成相对判据之后，同一条数据给出 `0.1538` 是其它段（`0.00006`）的约 **2564 倍**
→ 干净利落地判成噪声样。

> 这个教训是通用的：**当一个指标只有"相对"才有意义时，绝对阈值几乎总是会误判。**
> 前面 `plan_segments` 的 `jumping` 分配（用中位运动量做筛选）、
> 这里的高斯平坦度，都是同一个道理。

**修**

按优先级：

1. 把这个事件**映射到别的动作段**（`boot` 可以改取 `review` 段，那里本来没有事件用）
2. **干脆不给这个事件配音**——一只每次登场都嘶一声的宠物，比没有登场音更糟
3. 整体调低 `--target-rms-db`（治标，嘶声仍在）

**不要"先配上再说"。**
