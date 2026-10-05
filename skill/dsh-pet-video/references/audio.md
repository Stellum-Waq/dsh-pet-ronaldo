# 音频：让宠物叫的是**原视频的声音**

视频路线的默认做法是配合成音效，于是宠物在动、声音却和视频毫无关系——
对"真人 / 真实录像"这类素材来说，这是最明显的出戏点。
这一篇讲清怎么把原声切出来、按动作配上去，以及路上会撞到什么。

---

## 一、事件 ↔ 音频键的契约

宠物不会"按动作播放音频"，它是**按事件**播的。宿主状态变化时查 `triggers`，
鼠标交互时查 `interactions`，值都是 `audio` 里的键名。

| 事件 | 什么时候触发 | 写在哪个表 |
|---|---|---|
| `celebrating` | 任务完成 | `triggers` |
| `failed` | 出错 | `triggers` |
| `waiting` | 停下来等你回复 / 审批 | `triggers` |
| `working` | 开始执行工具 | `triggers` |
| `boot` | 宠物第一次加载 | `triggers` + `interactions` |
| `click` | 单击宠物 | `interactions` |
| `tripleClick` | 快速连点三次 | `interactions` |

`dsh-pet-forge` 的 `audio` 命令会**按键名自动推导**这张表（`forge.mjs` 的
`triggerMap`）：键叫 `celebrate` 就自动挂到 `celebrating`，叫 `working` 就挂到 `working`，
`click` / `dive` / `boot` 分别挂到那三个交互事件。所以**键名不能乱起**——
叫 `mymusic` 的音频不会被任何事件触发，等于没接。

### 动作段 → 事件 的推荐映射

| 音频键 | 取哪一段 | 理由 |
|---|---|---|
| `celebrate` | `jumping` 段 | "完成时跳一下"，配那一下的声音最顺 |
| `failed` | `failed` 段 | 出错对应"蔫掉/退后"那段 |
| `waiting` | `waiting` 段 | 等你回复时本来就该是安静那段 |
| `working` | `running` 段 | `running` 就是"正在干活" |
| `boot` | `idle` 段 | 登场时人在待机 —— **但先看第四节，这一段经常不能要** |
| `click` / `dive` | 没有对应动作，用起音检测在全片里挑 | 见第三节 |

`review`（思考）没有对应事件，它的音频可以不用，或者留给 `boot` 当替代源。

---

## 二、解码：没有 ffmpeg 也能抽原声

`dsh-pet-forge` 的 `video` 命令有个 `--audio-from-video`，但它内部是
`ffmpeg -vn -acodec libmp3lame`。**没有 ffmpeg 就直接断掉**，
而它在 `--frames-dir` 模式下还会额外拒绝（那时压根没有视频文件）。

不要为了这个去装 ffmpeg。**PyAV 的 pip wheel 里自带 FFmpeg 库**，
在进程内解码，不需要任何外部 exe，也不受"Node/子进程管道被禁"的影响：

```powershell
python -m pip install --target "<工作区>\pylibs" --no-cache-dir av
```

两个细节值得注意：

- **必须 `--target` 装到工作区**。默认装到系统 `site-packages` 在工作区之外，沙箱会拒。
  之后脚本里 `sys.path.insert(0, "<工作区>/pylibs")` 即可。
- **不要用 `subprocess` 调外部的 ffmpeg.exe**。就算装了，沙箱下子进程管道同样可能被拒，
  而且多一个必须存在的二进制就多一处环境依赖。PyAV 是纯进程内的，最稳。

`extract_video_audio.py` 已经把这些都封好了。顺便：它用 `wave` 标准库写 WAV，
不依赖 scipy/librosa；重采样由 PyAV 的 `AudioResampler` 完成（源常见 48kHz → 输出 44.1kHz）。

---

## 三、切片、处理、挑"点击音"

```powershell
python "<S>\scripts\extract_video_audio.py" `
  --video "<视频>" --pkg "<宠物包>" `
  --segments "idle:0-1,waiting:1.2-2.2,review:2.4-3.4,running:4.7-5.7,failed:6.3-7.3,jumping:7.4-8.4" `
  --libs "<工作区>\pylibs"
```

`--segments` **必须和装配时用的是同一串**，否则声音和动作对不上。

### 淡入淡出

连续音频（音乐/说话）被硬切一刀，边界会有"啪"的爆音。
默认 `--fade-ms 30` 做线性淡入淡出，几乎能消掉。

### 统一响度：按 RMS 而不是峰值

```python
gain = target_rms / rms            # target 默认 -20 dBFS
if peak * gain > 0.99:             # 峰值封顶，避免削波
    gain = 0.99 / peak
```

为什么不用峰值归一化：某一段只要有一个尖峰，整段就会被压得很轻，
六段之间的听感会差很远。按 RMS 对齐更接近"音量一致"的直觉。

### click / dive：用起音检测，不要固定位置

`click` 要靠一个**瞬态**才有"咔哒"的反馈感。随便截一段连续音乐，点下去会像"漏音"
而不是"回应"。

脚本用短时能量（10ms hop / 20ms 窗）算一阶差分，取最大值处当起音，
再往前留 50ms 免得把起音本身切掉。`click` 默认 0.35 秒，`dive` 0.7 秒。

> 实测这段素材里最脆的起音落在 6.98s，于是 `click` 和 `dive` 都取自那里，
> 和 `failed`(6.3-7.3) / `celebrate`(7.4-8.4) 的区间是重叠的 —— 这没问题，
> 全片才 8.4 秒，重叠是必然的；重要的是**它们各自听起来像个独立的小反馈**。

---

## 四、最容易翻车的地方：把"近乎静音"提上来 = 嘶声

统一响度会**放大**那些本身很小声的片段。如果某段在源视频里几乎是静音，
提几十 dB 之后你听到的不是内容，而是底噪。

这次就撞上了：`idle` 段（0–1s）的 RMS 是 **-42.8 dBFS**（比其它段小 22.8 dB），
要齐平就得提 **+22.8 dB**。

### 怎么判断"提上来的是内容还是噪声"

**不要用绝对阈值。** 试过：真实乐音的频谱平坦度约 `3e-5`，那段近乎静音的是 `0.154`——
两者差了**三个数量级**，但 `0.154` 低于任何"白噪声"的常识阈值（0.3~1.0），
用绝对阈值会把它误判成"没问题"。

正确做法是**相对比较**：拿"没有被提升的那些片段"的平坦度中位数当参照，
看被提升的那段高出多少倍。脚本的判据是 `> max(0.03, 参照 × 20)`。

实测结果：`0.1538` 是其它段（`0.00006`）的约 **2564 倍** → 判定为噪声样。
结论很明确：**这一段不能用来配音**。

### 撞上之后怎么办

按优先级：

1. **把这个事件映射到别的动作段**。`boot` 可以改取 `review` 段（本来就没有事件用它）
2. **干脆不给这个事件配音**（把键从 `audio` 里去掉）
3. 整体降低 `--target-rms-db`，让所有段都轻一点 —— 治标，仍然有嘶声

不要"先配上再说"。一只每次登场都嘶一声的宠物，比没有登场音更糟。

---

## 五、注册：用 `file:` 语法，但小心 `--replace`

切片只负责产出 WAV 和 `video-audio-map.json`。**注册交给 forge 自己的 audio 命令**，
这样触发器是按契约推导的，不会有偏差：

```powershell
node "<forge-local>\scripts\forge.mjs" audio --pkg "<宠物包>" --replace `
  --file "file:celebrate:<pkg>\audio\celebrate.wav,file:failed:...,file:waiting:...,file:working:...,file:click:...,file:dive:..."
```

`--file` 的值是**逗号分隔**的，所以路径里不能有逗号。
另外 `--add` 和 `--file` 都走同一个解析器，`file:<键>:<绝对路径>` 三者不能少。

### ⚠️ `--replace` 只换 `audio`，不清 `triggers` / `interactions`

```js
manifest.audio = args.replace ? result.audio : { ...(manifest.audio||{}), ...result.audio }
manifest.triggers = { ...(manifest.triggers || {}), ...result.triggers }        // ← 永远是合并不是替换
manifest.interactions = { ...(manifest.interactions || {}), ...result.interactions }
```

所以上一轮留下的 `boot → boot` 会**继续留着**，哪怕新的 `audio` 里已经没有 `boot` 这个键了。
结果是一个指向不存在音频的悬挂触发器。

**注册完一定要检查一遍**：`triggers` / `interactions` 里每个值都必须能在 `audio` 里找到。
对不上的手动删掉（直接编辑 `pet.json`），然后再 `install` 一次。

### 最后一步：改标签

`file:` 注册出来的 `label` 就是键名本身（`celebrate`），在设置界面里看不出所以然。
跑一次 `--relabel` 把它换成来源说明：

```powershell
python "<S>\scripts\extract_video_audio.py" --pkg "<宠物包>" --relabel --libs "<工作区>\pylibs"
```

会写成 `原声·jumping（7.40–8.40s）`，并补上 `kind: "video-original"` 和 `source` 区间。

---

## 六、验收

```powershell
# 1) 包还合法、音效条数对
node <forge> verify --pkg <宠物包>

# 2) 逐个真的出声（这一步才是"到底响没响"的证据）
node <forge> play --id <id> --key celebrate
node <forge> play --id <id> --key failed
node <forge> play --id <id> --key waiting
node <forge> play --id <id> --key working
node <forge> play --id <id> --key click
node <forge> play --id <id> --key dive
```

`verify` 只看文件在不在、格式对不对，**不能证明有声音**——
必须用 `play` 让宿主真播一次。全部 `ok: true` 才算接完。

---

## 七、参数表（`extract_video_audio.py`）

| 参数 | 默认 | 说明 |
|---|---|---|
| `--segments` | 必填 | 与装配同一串，格式 `动作:起-止,...` |
| `--map` | 见第一节 | `音频键=动作段`。**给了就以它为准（整体替换，不是合并）**，所以可以用它去掉某一项（比如 `boot`） |
| `--fade-ms` | 30 | 淡入淡出毫秒数。爆音明显就调大 |
| `--target-rms-db` | **-16** | 统一响度目标。**这个值是量出来的，不要随手调**，见第九节 |
| `--click-sec` / `--dive-sec` | 0.35 / 0.7 | 交互音长度 |
| `--rate` | 44100 | 输出采样率（源 48k 会重采样） |
| `--libs` | — | PyAV 的位置（`pip --target` 装的那个目录） |
| `--relabel` | — | 只读回 `video-audio-map.json` 改标签，不重新切片 |

想彻底不要声音：直接不注册 `audio`，或在设置里关掉这只宠物的"系统音"。

---

## 八、触发地图：到底什么能触发什么

音效不是"按动作播"，而是**按事件**播。下面这张表是读源码得出来的，
不是猜的 —— 排查"没声音"时第一步就该对照它。

| 音效键 | 触发条件 | 实现位置 |
|---|---|---|
| `click` | **单击**宠物 | `DesktopPet.ps1:1728`（桌面）· `client.js:312`（网页） |
| `dive` | **快速连点三次**（2 次是开 Edge，3 次才是 dive） | `DesktopPet.ps1:1706` · `client.js:308` |
| `celebrate` | Agent **一轮对话成功跑完** | `host.js:825` |
| `failed` | Agent **一轮对话出错** | `host.js:836` |
| `waiting` | Agent **转为等你回复/审批**（只在"从不等→等"那一次跳变） | `host.js:816` |
| `boot` | 宠物加载时，**只有网页端会播**，桌面窗口不播 | `client.js:215` |
| `working` | ❌ **没有任何地方会触发它** | 无 |

### 三个必须知道的细节

**① `working` 是死键。** `playEvent()` 在整份 `host.js` 里只有三个调用点：
`waiting`、`celebrating`、`failed`。宿主状态机**会把动画切到 `working`**（干活时的动画），
但从来不发对应的音频事件。所以把音频接到 `working` 上等于没接——
注册进去不报错、也永远不会响。

**② 桌面窗口的 `click` / `dive` 是写死的键名。**
`DesktopPet.ps1` 里是 `Play-Sound 'click'`、`Play-Sound 'dive'`，
**不读 `manifest.interactions`**。改 `interactions` 只影响网页端；
桌面窗口认的还是这两个名字。给音效起名时别改这两个键。

**③ `boot` 只在网页端播。** 桌面窗口没有 boot 的分支。

### 四道闸：触发类音效为什么会静音

`playEvent()` 里任何一条不满足都会静音，而且**全部是静默的**：

1. `settings.systemSound === false` → 直接 return
2. 该宠物 `visible === false` **或** `sound === false` → 跳过（是 `continue`，不是 break）
3. `audioMode === 'primary'` → **只有列表里第一只**满足条件的宠物会响，然后 `return`。
   所以"另一只可见、且也有同名触发器"时可能被它抢走
4. 宿主状态机真的切到了那个状态

排查顺序：先 `GET /ronaldo-pet/pets` 看 `settings.systemSound` 和目标宠物的
`visible` / `sound` / `triggers`，再确认事件真的发生过（桌面日志里
`hover ON | <宠物名> - <状态>` 会显示当前状态）。

---

## 九、响度：拿插件**自己的音效**当基准

这是最容易做错的一步。第一版按 `--target-rms-db -20` 归一化，
理由是"统一响度、避免削波"——听起来很合理，**但结果是宠物几乎听不见**。

因为没有拿参照物去量。把插件自带的合成音效拉出来一比就露馅了：

| | peak dBFS | RMS dBFS | crest |
|---|---|---|---|
| 插件合成 `celebrate` | −3.7 | **−16.8** | 13.1 |
| 插件合成 `click` | −10.5 | **−17.7** | 7.2 |
| 插件合成 `dive` | −9.9 | **−18.1** | 8.2 |
| 插件合成 `failed` | −11.7 | **−20.1** | 8.4 |
| 第一版切的 `celebrate` | −6.1 | **−20.0** | 13.9 |
| 第二版切的 `celebrate` | −0.1 | **−14.0** | 13.9 |

**插件自带音效的 RMS 落在 −16.8 ~ −20 之间。** 要跟它们齐平，目标应该是 **−16**；
想更稳一点（下面那条原因）用 **−14**。

### 还有一层：桌面窗口的音量固定是 50%

`DesktopPet.ps1` 的 `Play-Sound` 创建 `MediaPlayer` 之后**从来没设过 `Volume`**，
而 WPF `MediaPlayer.Volume` 的默认值是 **0.5**。可以直接验证：

```powershell
Add-Type -AssemblyName PresentationCore
(New-Object System.Windows.Media.MediaPlayer).Volume   # -> 0.5
```

网页端用的是 `new Audio(url)`，音量 1.0。**两边差 6 dB。**

所以按 −16 归一化，桌面窗口的实际听感只有 −22 dBFS 左右。
把目标提到 **−14** 正好补掉这 6 dB，且峰值仍在 −0.1 dBFS 以内不削波
（高 crest 的片段会被峰值封顶，RMS 落在 −14 ~ −16.6，一致性够用）。

| 场景 | `--target-rms-db` |
|---|---|
| 想和插件自带音效齐平 | `-16` |
| 想盖过桌面窗口那 6 dB 衰减（推荐） | `-14` |
| 用户嫌吵 | `-18` ~ `-20`，但别更低 |

---

## 十、"没声音"怎么查：先分清是哪一层

音频链上有**三个互相独立的播放器**，出问题的表现都是"没声音"，但排查方式完全不同：

| 谁在播 | 播什么 | 音量 | 怎么验证 |
|---|---|---|---|
| **宿主进程**（`host.js` 的 `playFile`） | `triggers`（celebrate/failed/waiting/working） | 1.0 | `forge play --id <id> --key <k>` |
| **桌面窗口**（`DesktopPet.ps1`） | `click` / `dive` | **0.5（没设）** | 连点三下，看日志有没有 `click -> dive (3x)` |
| **网页客户端**（`client.js`） | `click` / `dive` / `boot` | 1.0 | 在网页里点宠物 |

### 坑：宿主播放器读的是**本地文件路径**，沙箱下会失败

`host.js` 的 `playCommand()` 生成的是：

```
Add-Type -AssemblyName presentationCore; $m = New-Object System.Windows.Media.MediaPlayer;
$m.Open('<绝对路径>'); $m.Play(); Start-Sleep -Seconds 5; $m.Close()
```

实测（同机同文件）：

| `Open()` 的形式 | 沙箱下 | 完整权限下 |
|---|---|---|
| 本地路径字符串 | ❌ `HRESULT 0xC00D11D2` | ✅ 正常播完 |
| `file:///` URI（含百分号转义） | ❌ 同上 | ✅ 正常播完 |
| **`http://127.0.0.1:3080/ronaldo-pet/asset/...`** | ✅ **正常播完** | ✅ 正常播完 |

**WPF MediaPlayer 在受限进程里读不了本地文件**（媒体栈在另外的进程里，
不受调用方的文件授权覆盖），但走本地 HTTP 服务就没事。
桌面窗口恰恰是用 `$Base + $entry.url` 拼 **http URL** 播的，所以桌面那条路是稳的。

诊断时注意：`playFile()` 是 `shell.run(spec).catch(...)` 派发出去的，**没有 await**。
所以 `/ronaldo-pet/play` 返回 `ok: true` 只代表"命令发出去了"，**不代表真的出声**。
它请求的是 `danger-full-access`，如果这次提权没被批准（无人应答时 fail-closed），
播放就会静默失败。

### 坑：桌面窗口按 key 缓存播放器，覆盖音频文件会让它永久静音

`Play-Sound` 把 `MediaPlayer` 按 key 存进 `$script:AudioCache`，
而且**没有挂 `MediaFailed` 处理器**。于是：

- 缓存里的播放器一旦失效，之后每次 `Play()` 都无声，**日志里一条错都没有**
- 在宠物**正在运行**时**原地覆盖同名 wav**，缓存里的播放器正好会失效

**这就是"日志明明显示 `click -> dive (3x)`，却一点声音都没有"的成因。**

改完音频后一定让桌面窗口重新加载宠物：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3080/ronaldo-pet/desktop `
  -ContentType application/json -Body '{"action":"start","restart":true}'
```

（`AudioCache` 在 `Load-Pet` 里清空，所以重启进程或切换宠物都能生效。）

更普遍的一课：**换了音频文件就要让播放端重新打开它**，
而"日志没报错"在这种缓存场景下完全不能证明有声音。

---

## 十一、音频改动的收尾流程

1. 生成 / 替换 wav
2. 注册（`forge audio --file … --replace`）
3. 修标签（`--relabel`）
4. **核对 `triggers` / `interactions` 没有指向不存在音频的悬挂键**（第五节）
5. `forge verify --pkg` + 逐个 `forge play --key <k>`
6. **重启桌面窗口**，让它重新打开新的音频文件
7. 让用户实际点一下确认（"没报错"不等于"有声"）
