# 🐾 DSH 桌宠（dsh-ronaldo-pet）· v2

> **DeepSeek Harness（DSH）桌面宠物插件** —— 一只住在界面里、**同时也住在你电脑桌面上**的小家伙。
> 它盯着 Agent 干活：对话进行中专注工作、回合中思考、等待审批时期待地看你、出错时戏剧性摔倒；
> **对话完成时跳起来庆祝并全机播放提示音**。
>
> v2 的三个核心变化：
> 1. **原生桌面窗口** —— 最小化甚至关掉浏览器它都还在，只要终端还在运行就一直存在。
> 2. **一句话生成新宠物** —— 配套技能 [`dsh-pet-forge`](skill/dsh-pet-forge/SKILL.md)：生图模型 + Blender 3D 建模 + 动作/音效设计，全程自动。
> 3. **分辨率不限** —— 单格画多大都行（像素风、精细立绘、写实素材），显示时缩放。
>    多宠物注册表跨重启保留，每只独立音频、大小、行为、位置。
>
> **v2.2 新增：🎬 从视频生成** —— 手上有绿幕/纯色幕布拍的视频？不用生图，
> 直接抽帧 → 抠幕布 → 按时间段切开动作 → 合成图集，让视频里**真实的动作**变成桌宠动作。
> 详见下面「从视频生成」一节。
>
> **v2.1 新增：🌐 宠物社区** —— 用本插件做出来的桌宠，只要作者愿意按
> [**DPSL-1.0 开放共享协议**](docs/PET-SHARING-AGREEMENT.md) 发布到 GitHub，就会出现在插件内置的
> 「宠物社区」里，被别人搜索、预览、**一键安装**。插件负责问一次"愿不愿意共享"，并生成分享包；
> **上传永远由作者自己做**。详见下面「宠物社区」一节。

![动作一览](docs/preview.png)

> 上图是内置 C罗 的动作总表：待机 / 奔跑 / 挥手 / 庆祝跳 / 摔倒 / 等待 / 专注工作 / 思考。
> 用 `node skill/dsh-pet-forge/scripts/inspect.mjs assets/spritesheet.png --out out.png` 可以自己生成。

### 截图

| 待机 | 颠球（奔跑） | SIU 庆祝 |
| --- | --- | --- |
| ![待机](screenshots/demo-idle.png) | ![颠球](screenshots/demo-running.png) | ![庆祝](screenshots/demo-siu.png) |

> 这三张来自 [`demo/index.html`](demo/index.html)（纯静态的动画预览页，双击就能打开）。
> 清单见 [`screenshots.json`](screenshots.json)，插件市场抓取上架素材时会用到。

---

## ✨ 特性

### 渲染与交互

- **完整精灵动画**：8 列 × 11 行图集契约，含 idle / 奔跑 / 挥手 / 跳跃 / 摔倒 / 等待 / 专注 / 思考 / 16 方向视线
- **分辨率不限**：单格多大都行 —— 192px 像素风、1024px 精细立绘、乃至写实素材，显示时等比缩放。
  内置 C罗 是 192×208；作者按 2× 创作（显示宽度 = 单格宽 ÷ 2），写实素材不会一上来被缩成小图。
  `scaling: smooth / pixelated` 决定缩小走平滑重采样还是最近邻（像素风不被糊掉）
- **实时感知 Agent 状态**：Host 轮询 `agents` 服务，并监听 `tools/execute`、`approval/request`、`agent/request-error`，推导 工作 / 思考 / 等待 / 出错 / 空闲 / 完成 六种模式
- **可互动**：拖动、悬停看光标、快速连点三次摔倒、单击冒气泡
- **多宠物并排**：右下角一行站开，拖动后各自独立定位

### 🖥 原生桌面窗口（v2 新增）

无边框、背景透明、永远置顶的 WPF 窗口，**不依赖浏览器**：

| 操作 | 行为 |
| --- | --- |
| 悬停 | 显示**当前工作区 + 当前对话标题** + Agent 状态 |
| **双击** | 用 **Microsoft Edge** 打开 Harness 网页 |
| 单击 | 冒台词气泡 + 点击音效 |
| 快速点三下 | 摔跤动画 + 音效 |
| 拖动 / 滚轮 | 移动（位置跨重启保留）/ 改大小（32～1024 DIP） |
| 右键 | 菜单：打开网页 / 切换宠物 / **平时行为（10 种）** / **大小（含"自动"）** / **系统音开关** / 置顶 / 复位 / **隐藏** / **设为默认** / 退出 |

> 右键菜单里的这些改动会**写回宿主**，和网页设置面板是同一份状态 —— 在桌面上改完，
> 网页里也是改过的样子。大小默认「自动」：跟随素材原生分辨率（单格宽 ÷ 2）。

- **终端一起来就出现**：插件随 profile 加载时自动拉起（`desktopPet: true` 可关）
- **终端一停就消失**：桌宠自己轮询宿主，宿主进程没了或 15 秒无响应就退出
- **透明处不挡鼠标**：按光标下方像素的 alpha 动态切换 `WS_EX_TRANSPARENT`。
  命中检测只取**当前那一格**的像素，高分辨率图集不会因此吃掉大量内存
- 详见 [`desktop/README.md`](desktop/README.md)

### 🎨 一句话生成宠物（配套技能）

`dsh-pet-forge` 技能把「做一只桌宠」压成一句话：

```powershell
# 1. 环境自检（生图模型 / Blender / 插件 / TTS 一次看清）
node "$env:USERPROFILE\.agents\skills\dsh-pet-forge\scripts\forge.mjs" doctor

# 2. 生成（会先问你画风/动作/音效，都有推荐）
node ...\forge.mjs generate --pkg "D:\代码\桌宠\pets\cyber-cat" --brief "赛博朋克风格的机械猫" `
  --tier A --actions idle,running,review,waiting,jumping,failed `
  --audio "sfx:celebrate,sfx:failed,sfx:click"

# 3. 校验 + 目视检查 + 注册（注册后界面右下角立刻出现，无需刷新）
node ...\forge.mjs verify --pkg <目录>
node ...\forge.mjs inspect --pkg <目录>
node ...\forge.mjs install --pkg <目录>
```

三条路线：

| 路线 | 成本 | 适用 |
| --- | --- | --- |
| **A · 2D 单图程序化** | 1 次生图 | 默认。最稳、可复现 |
| **B · 2D 多帧生图** | 每动作再 1 次生图 | 姿态更自然 |
| **C · 3D Blender** | 1 次生图（取色）+ Blender 渲染 | 要真 3D、能转视角、要 GLB |
| **D · 视频导入** | 0 次生图 | 已经有视频/绿幕素材，想让真实动作直接变桌宠动作 |

### 🎬 从视频生成：绿幕素材直接变桌宠（v2.2 新增）

手上有视频（尤其绿幕/纯色幕布拍的）？**不用生图**，让视频里真实的动作直接变成桌宠动作：

```powershell
# 一个视频 + 每个动作的时间段（最常用、最准）
node ...\forge.mjs video --pkg "D:\代码\桌宠\pets\my-cat" `
  --video "D:\videos\cat-green.mp4" `
  --segments "idle:0-2.5,waving:2.5-5,jumping:5-7.4" `
  --name "绿幕猫" --id my-cat --fps 12 --frames 6

# 每个动作一段视频（不用猜时间）
node ...\forge.mjs video --pkg <目录> --videos "idle=idle.mp4,waving=wave.mp4,jumping=jump.mp4"

# 让工具自己按运动切分（只当草稿，结果会在报告里念给你核对）
node ...\forge.mjs video --pkg <目录> --video <视频> --auto-segments 3

# 连解码器都没有？自己抽好 PNG 帧照样能跑
node ...\forge.mjs video --pkg <目录> --frames-dir "D:\frames\cat" --fps 12 --segments "idle:0-2,waving:2-4"
```

界面里也有：设置 → **⚽ 桌宠 → 🎬 视频生成**（填路径 → 开始生成 → 实时进度 → 直接注册）。

**流水线**：抽帧 → **抠幕布** → 按时间段/运动切动作 → 并集包围盒对齐落格 → 图集 + `pet.json`。
细节见 [`skill/dsh-pet-forge/references/video.md`](skill/dsh-pet-forge/references/video.md)。

| 抠像参数 | 默认 | 说明 |
| --- | --- | --- |
| `--key` | `auto` | 从画面**边缘**取中位色当幕布色；也可手填 `0x00FF00` / `green` / `blue` / `white` |
| `--similarity` | `0.16` | 色度距离内阈值（越小抠得越少） |
| `--blend` | `0.10` | 羽化带宽 |
| `--spill` | `0.6` | 绿边（溢色）抑制强度 |
| `--erode` | `0` | alpha 腐蚀半径，用来收掉残留的幕布边 |
| `--no-key` | — | 不抠像（素材自带透明通道时） |

**解码引擎（按顺序自动挑）**：

| 引擎 | 何时用 | 备注 |
| --- | --- | --- |
| **ffmpeg** | 装了就用 | 最稳，还能顺手用 `--audio-from-video celebrate@5.2-6.4` 抽视频原声当音效 |
| **python + OpenCV** | 没有 ffmpeg，但有 Anaconda / `opencv-python` | OpenCV 自带一份 FFmpeg，抽帧够用（不提供音轨） |
| **`--frames-dir`** | 两个都没有 | 用任何工具抽好 PNG 帧喂进来，抠像/切分/装配照样全都能跑 |

> ⚠️ 都缺时的报错会直接给出可执行的安装命令（`winget install Gyan.FFmpeg` / `pip install opencv-python`）。
> 顺带一提：**Blender 当不了解码器** —— 本机那个 5.2 构建没带 FFmpeg，编解码视频都不行。

抠不干净（残留绿边）的处理顺序：`--similarity 0.22` → `--erode 1` → `--spill 0.9` → 换更均匀的幕布重拍。
报告里的 `chroma.avgTransparentRatio` 会告诉你到底抠掉了多少（0.5~0.97 正常；>0.97 会直接报错，因为那把角色也抠了）。

### 🌐 宠物社区：收集 GitHub 上的桌宠，并提供下载渠道（v2.1 新增）

凡是**用本插件（或任何符合宠物包契约的方式）做出来、并发布到 GitHub 的桌宠**，
都可以按 [**DPSL-1.0 开放共享协议**](docs/PET-SHARING-AGREEMENT.md) 收录进插件内置的
「宠物社区」，在那里被搜索、预览、**一键安装**。

设置 → **⚽ 桌宠 → 🌐 宠物社区**：

- 每条都显示 **作者署名 + 仓库链接 + 预览图 + 协议徽章**，来源标为「索引」「自动发现」或「手动」；
- **一键安装**：下载 → 解包 → 严格校验 → 注册，装完立刻出现在右下角与桌面上；
- **⚠️ 兼容导入**：社区里有仓库用的是同一张图集契约但没有 `pet.json`（因此没有授权声明），
  可以在**你本机**把它适配成宠物包 —— 界面上明确标「未授权」，动作映射是启发式的；
- **仅收录**：形态完全不同的桌宠项目，只给仓库链接与安装命令，不假装能直装；
- 支持搜索、按 star / 更新时间排序、手动填任意 `owner/repo` 探测后加入。

发现方式是**两路合并**：本仓库的 [`gallery/index.json`](gallery/index.json)（可提 PR 加条目）
+ GitHub 上带 **`dsh-pet`** 标签的公开仓库自动发现。离线时用包内置索引与本地缓存兜底。

### 📤 共享是「问过才做」的（协议第 2.2 条）

生成完宠物后，技能会**问一次**：「要不要把它按 DPSL-1.0 发布到 GitHub，收录进宠物社区？」
选「愿意」才会生成分享包：

```powershell
node ...\forge.mjs share --pkg <目录>              # 只问不写：告诉 agent 该问你什么
node ...\forge.mjs share --pkg <目录> --accept `
  --author "你的昵称" --repo "https://github.com/you/your-pet" --tags "像素风,猫"
```

`--accept` 之后会在**宠物包目录里**（也就是将来 push 上去的仓库内容）写入：

| 文件 | 作用 |
| --- | --- |
| `pet.json` 的 `sharing` 块 | 协议**唯一**认可的"同意"方式（含署名、仓库、声明、二创/商用开关） |
| `DSH-PET-LICENSE.md` | 协议全文副本 |
| `README.md` / `SHARING.md` | 署名、素材权利说明、怎么撤回；已存在的 README 不会被覆盖 |
| `publish.ps1` / `publish.sh` | 一键 init + commit + push 的脚本 —— **由你自己跑** |

装进界面里也一样：设置 → **📤 分享到社区**，勾选"我确认…同意按 DPSL-1.0"之前按钮是禁用的。

**协议四条底线**（完整条款见 [`docs/PET-SHARING-AGREEMENT.md`](docs/PET-SHARING-AGREEMENT.md)）：

1. **著作权归作者**，DPSL 是许可不是转让；**随时可撤回**（改一行 `shared: false` 或删标签即失效）；
2. 插件只被授权**收录、展示、下载、本机安装** —— 不得商业销售、不得再许可、不得用于训练模型；
3. 插件**不会替你上传任何东西**（它没有你的 GitHub 凭据），也**不执行**仓库里的任何脚本；
4. 做不到的事直接写在正文里：**已经被别人下载到本机的副本收不回来**（第 9.4 条）。

机器可读的格式与流程（索引格式、安装流水线、安全边界、缓存与配置）见
[`docs/GALLERY-CONTRACT.md`](docs/GALLERY-CONTRACT.md)。

### 🗂 统一管理

**默认只开一只。** 同一时间只显示 ⭐「默认打开的桌宠」，其它自动收起——
不会因为生成了几只就站一排。想同时养多只，点各自的「👁 显示中」即可
（手动打开过的会被记住，之后切换默认不会再被自动收起）。开箱即用是 **C罗**。

设置 → **⚽ 桌宠**：

- **🐾 宠物**：**⭐ 设为默认**、改名、大小、平时行为、系统音开关、显示/隐藏、复位、移除；
  全部跨重启保留。工具栏有「全部打开」「只开默认」两个一键操作
- **🖥 桌面窗口**：启停 / 重启 / 自启开关 / 日志路径
- **✨ 生成新宠物**：技能用法说明 + 手动导入 spritesheet（带尺寸校验）

**新生成/新注册的宠物会自动接管默认位**（这样生成完立刻就能看到它），其它宠物自动收起。
只想注册不上场：`forge install --pkg <目录> --no-focus`，然后在设置里手动打开或设为默认。

默认窗口读的是宿主的 `settings.defaultPet`，所以网页里点了 ⭐ 之后，
**桌面上的原生窗口也会跟着切换**（它每 4 秒拉一次宠物列表）。

老版本升级上来时，注册表里没有 `defaultPet` 字段，首次加载会自动收敛成"只留一只"
（内置 C罗，没有就取第一只），避免升级后右下角突然站一排。

---

## 🚀 安装

```bash
# 从 GitHub 安装
dsh plugin --profile web add github:Stellum-Waq/dsh-pet-ronaldo

# 本地开发（改代码即时生效，profile 里是软链接）
dsh plugin --profile web add D:\代码\桌宠\dsh-ronaldo-pet
```

然后**重启 `dsh web`**。插件随 profile 常驻加载，界面右下角出现宠物，**桌面右下角出现原生窗口**。

安装配套技能：

```powershell
Copy-Item -Recurse -Force .\skill\dsh-pet-forge "$env:USERPROFILE\.agents\skills\"
```

卸载：

```bash
dsh plugin --profile web remove dsh-ronaldo-pet
```

---

## ⚙️ 配置

所有可调项集中在 `host.js` 顶部 `CONFIG`，也可以通过 bundle patch 行传入：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `spritePath` / `voicePath` | `<包目录>/assets/…` | 内置 C罗 的素材 |
| `pollMs` | `500` | Agent 状态轮询间隔 |
| `celebrateMs` / `failedMs` | `4800` / `2600` | 庆祝 / 失败动画时长 |
| `registryPath` | `$DSH_HOME/storages/dsh-pet-forge/registry.json` | 多宠物注册表 |
| `desktopPet` | `true` | 是否随插件启动原生桌面窗口 |
| `desktopScript` / `desktopLog` | `<包目录>/desktop/DesktopPet.ps1` · `$DSH_HOME/storages/dsh-pet-forge/desktop-pet.log` | 桌面窗口脚本与日志 |

宠物社区（`CONFIG.gallery`，完整说明见 [`docs/GALLERY-CONTRACT.md` §8](docs/GALLERY-CONTRACT.md)）：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` / `online` | `true` / `true` | 总开关 / 是否联网抓取（`false` = 只用内置索引与缓存） |
| `topics` | `["dsh-pet"]` | 自动发现用的 GitHub topic |
| `indexUrl` / `indexPath` | 本仓库 `gallery/index.json` 的 raw 地址 / 包内置副本 | 官方索引（远端 + 离线种子） |
| `cachePath` / `cacheMs` | `$DSH_HOME/…/gallery-cache.json` / 6 小时 | 本地缓存 |
| `installDir` | `$DSH_HOME/storages/dsh-pet-forge/community` | 社区宠物解包目录 |
| `searchApi` / `rawBase` / `codeloadBase` | `api.github.com` / `raw.githubusercontent.com` / `codeload.github.com` | 可换成镜像；测试里被指向本地桩服务器 |
| `curlFallback` | `true` | Node 认不出本地代理证书时改用 curl 取（详见 `lib/gallery.mjs` 顶部注释） |
| `token` | 空 | 可选：GitHub token（未认证时搜索 API 有速率限制） |
| `maxEntries` / `maxDownloadBytes` | 60 / 96MB | 防呆上限 |

例：给插件行加 `config: { desktopPet: false, pollMs: 800, gallery: { online: false } }`。

从视频生成（`CONFIG.video`）：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `ffmpegPath` / `pythonPath` | 空 | 留空自动探测（PATH、环境变量 `DSH_PET_FFMPEG`、常见安装位置） |
| `defaultFps` / `defaultFrames` | `12` / `6` | 抽帧帧率 / 每个动作取几帧 |
| `maxFrames` | `400` | 单次抽帧上限（防呆） |
| `generateDir` | `$DSH_HOME/storages/dsh-pet-forge/generated` | 界面里生成的宠物包落在哪 |

---

## 🔌 HTTP 接口（技能与调试用）

全部挂在 `/ronaldo-pet/*`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state` | 当前模式、注册表版本、**当前工作区/对话**、桌面窗口状态 |
| GET | `/pets` | 宠物列表（含图集 URL、状态表、音效 URL） |
| GET | `/asset/<id>/<相对路径>` | 素材直出（PNG/WebP/WAV/MP3/GLB） |
| POST | `/pets/register` | 注册宠物包 `{dir}` —— **注册即校验**，不合格返回 422 |
| POST | `/pets/unregister` | 卸载 `{id}`（只取消注册，不删文件） |
| POST | `/pets/update` | 改 `{id, patch:{name,size,visible,behavior,sound,pos}}` |
| POST | `/settings` | 宿主提示音策略 `{patch:{audioMode,systemSound}}` |
| POST | `/play` | 让宿主进程试播音效 `{id,key}` |
| POST | `/desktop` | 原生窗口控制 `{action:status\|start\|stop\|enable}` |

宠物社区（画廊，见 [`docs/GALLERY-CONTRACT.md`](docs/GALLERY-CONTRACT.md)）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/gallery` | 合并后的社区条目（`?refresh=1` 强制重抓，`?q=` 过滤） |
| POST | `/gallery/refresh` | 强制重抓索引 + GitHub 自动发现 |
| POST | `/gallery/probe` | 只看一个仓库 `{repo}`，不下载 |
| POST | `/gallery/install` | `{key\|repo\|dir}`（`adapter:"spritesheet-json"` 走兼容导入）→ 下载/解包/校验/注册 |
| POST | `/gallery/share` | `{id\|dir, accept:true, author, repo, …}` → 生成分享包（**没有 `accept:true` 就不写任何文件**） |

从视频生成（GUI 用；抽帧是长任务，所以起后台 job 轮询）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/video/probe` | 探测解码引擎（ffmpeg / python+OpenCV）+ 读取视频元信息 |
| POST | `/video/build` | `{path\|framesDir, segments, key, fps, frames, install}` → 起后台任务，返回 `{jobId}` |
| GET | `/video/status` | `?jobId=` 看某个任务（含实时进度日志与结果）；不带参数则列出最近任务 |

---

## 📁 项目结构

```
dsh-ronaldo-pet/
├── host.js                    # bundle 插件 Node/Host 半：状态机 + 注册表 + 资源路由 + 桌面窗口管理 + 宠物社区路由
├── client/client.js           # bundle 插件浏览器/Client 半：shell.overlay + settings.section（含宠物社区 / 分享面板）
├── lib/gallery.mjs            # 宠物社区：索引抓取 + GitHub 发现 + tar.gz 解包 + 兼容导入 + curl 兜底
├── gallery/                   # 官方索引（index.json，可提 PR）与提交说明
├── pet.json                   # 插件仓库自己也是一份 DPSL-1.0 声明的宠物包（官方参考实现）├── cordis.patch.yml           # bundle patch（插入插件行）
├── package.json               # bundle 插件元数据
├── assets/
│   ├── spritesheet.webp/.png  # 内置 C罗 图集（WebP 给网页 / PNG 给 WPF）
│   └── siu.mp3
├── desktop/                   # 🖥 原生桌面窗口
│   ├── DesktopPet.ps1         #   WPF 窗口（纯 ASCII，中文走 strings.zh.json）
│   ├── strings.zh.json        #   全部界面文案
│   ├── Start.cmd / Stop.cmd
│   └── README.md
├── skill/dsh-pet-forge/       # 🎨 配套技能（一句话生成宠物 + 视频导入 + 分享 / 社区）
│   ├── SKILL.md
│   ├── references/            #   actions / audio / prompts / video / troubleshooting / pet-package
│   ├── templates/pet-repo/    #   分享包模板（README / 协议通知 / SHARING / publish 脚本 / .gitignore）
│   └── scripts/
│       ├── forge.mjs          #   主 CLI（doctor/plan/generate/video/verify/install/share/gallery/…）
│       ├── selftest.mjs       #   离线自检（不联网也能跑）
│       ├── inspect.mjs        #   图集目视检查图
│       ├── py/extract_frames.py  #   视频抽帧（OpenCV 引擎，中文路径安全）
│       └── lib/               #   png / imaging / anim / audio / manifest / imagegen / blender / install / share / video
├── scripts/
│   ├── smoke-host.mjs         # Host 路由集成冒烟测试（含画廊与视频任务全链路）
│   ├── verify-video.mjs       # 🎬 视频流水线验证器（抠像质量 / 动作切分 / 落格对齐 / 端到端）
│   ├── verify-gallery-live.mjs # 🌐 宠物社区联网验证（搜 GitHub + 下真仓库 + 解包校验）
│   ├── verify-desktop.mjs     # 桌面窗口"真的显示出来了吗"验证器
│   ├── dev-server.mjs         # 独立端口的本地调试服务器
│   └── build-assets.mjs       # 从 WebP 生成桌面端 PNG
├── docs/
│   ├── PET-SHARING-AGREEMENT.md      # 📜 共享协议 DPSL-1.0（中文规范版）
│   ├── PET-SHARING-AGREEMENT.en.md   # 📜 英文版
│   ├── GALLERY-CONTRACT.md           # 🔌 画廊机器可读契约（索引 / 安装 / 安全边界）
│   └── SPRITESHEET-CONTRACT.md
└── demo/index.html
```

自检：

```powershell
node scripts\smoke-host.mjs                        # Host 路由（画廊 + 视频任务全链路，本地桩，不联网）
node scripts\verify-client-render.mjs              # 网页面板（画廊卡片 / 分享向导 / 视频生成面板）
node scripts\verify-video.mjs                      # 视频→桌宠（抠像质量、切分、落格；有引擎时跑真视频端到端）
node scripts\verify-gallery-live.mjs               # 宠物社区"真联网"验证（搜 GitHub + 下真仓库 + 解包校验）
node scripts\verify-desktop.mjs --base http://127.0.0.1:3080   # 桌面窗口真的显示了吗
node skill\dsh-pet-forge\scripts\selftest.mjs     # 图像/动画/音频内核
```

---

## 🧩 精灵图契约（8 列 × 11 行）

网格固定，**单格分辨率不限**：画多大都行，显示时等比缩放。要求只有一条 ——
图集实际尺寸必须严格等于 `列数×单格宽` × `行数×单格高`（这条闸保证取帧不错位）。

| 行 | 状态 | 用途 |
| ---: | --- | --- |
| 0 | idle | 待机呼吸 |
| 1 / 2 | runRight / runLeft | 拖动时奔跑 |
| 3 | waving | 挥手 |
| 4 | jumping | **对话完成** |
| 5 | failed | **出错 / 连点三次** |
| 6 | waiting | 等待审批 |
| 7 | running | 专注工作 |
| 8 | review | 思考 |
| 9 / 10 | look | 视线（2D：16 方向；3D：环视角度） |

分辨率与缩放的完整说明（2× 创作约定、`scaling` 字段、4096px / 6400 万像素上限）
见 [`docs/SPRITESHEET-CONTRACT.md`](docs/SPRITESHEET-CONTRACT.md)。

---

## ❓ 常见问题

**桌宠会出现在所有会话里吗？**
会。网页版注册进 `shell.overlay`（root 级浮动层，全应用可见）；桌面窗口是独立进程，跟浏览器无关。

**关掉浏览器桌宠还在吗？**
在。桌面窗口是独立进程，只要 `dsh` 终端还在运行就一直存在。关掉终端它会自己退出（15 秒内）。

**桌宠会挡住我点别的东西吗？**
不会。透明像素处鼠标事件会穿透到下面的窗口（按 alpha 动态切换 `WS_EX_TRANSPARENT`）。

**有动作但没声音？**
声音是**宿主进程**播的（`/ronaldo-pet/play` 可单独验证），与浏览器静音无关。检查设置里是否关了「系统音」，或该宠物的 🔊 按钮。

**状态显示"运行中"但屏幕上看不到宠物？**
跑 `node scripts\verify-desktop.mjs --base <地址>`。它会直接抓窗口内容并报告精灵有没有画出来——比肉眼看可靠。（注意：整屏截图 `CopyFromScreen` 看不到分层窗口，这是踩过的坑。）

**macOS / Linux 能跑吗？**
网页版完全能跑（`host.js` 的 `playCommand()` 已按平台选择播放器）。**原生桌面窗口目前只有 Windows（WPF）实现**，其它平台会在设置里显示"不支持"。

**为什么 `DesktopPet.ps1` 里一个中文都没有？**
PowerShell 5.1 读取无 BOM 的 `.ps1` 会按系统 ANSI 代码页解析，中文会变乱码（而工作区路径本身就叫 `D:\代码\桌宠`）。所以脚本保持纯 ASCII，文案全放 `strings.zh.json`（UTF-8 显式读取）。详见 `desktop/README.md`。（`share` 生成的 `publish.ps1` 同理。）

**宠物社区刷不出来 / 一直说"没联上网"？**
先看 `GET /ronaldo-pet/gallery` 的 `errors`。最常见的原因是本机把 `raw.githubusercontent.com` 之类域名指到了本地代理，
而 Node 自带的 CA 包认不出那张根证书（报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`）——插件会自动改用 `curl` 兜底；
也可以用 `NODE_OPTIONS=--use-system-ca` 启动 `dsh`（Node 22+）。实在不行把 `gallery.online` 设为 `false`，只用内置索引。

**我在画廊里点了「兼容导入」，这样合法吗？**
那是**你自己**从作者仓库下载、并在**你自己电脑上**适配成的宠物包，插件不做再分发。
界面上把它和"已按 DPSL-1.0 授权"的条目分得很清楚，就是不想让人误以为它被授权了。素材权属请自行确认。

**作者撤回之后，我本机已经装的那只怎么办？**
会留着。撤回只能保证索引里不再出现（官方索引 7 日内、自动发现随条件失效），
**没有任何协议能远程召回已经下载到别人电脑上的文件**（协议第 9.4 条把这件事写明了）。

**我能不能把自己做的宠物放进去？**
能，见上面「宠物社区」与「共享是问过才做的」两节。最短路径：`pet.json` 加 `sharing` 块 + 仓库打 `dsh-pet` 标签。

**我有视频，但插件说没有解码引擎？**
装一个就行：`winget install Gyan.FFmpeg`（推荐）或 `python -m pip install opencv-python`。
两个都不想装的话，用别的工具把视频抽成 PNG 帧，走 `forge.mjs video --frames-dir <帧目录>` —— 抠像、切分、装配都不需要解码器。

**视频抠出来还有绿边/绿点？**
调 `--similarity 0.22`（背景有渐变）、`--erode 1`（收掉残留一圈）、`--spill 0.9`（边缘发绿）。
还是不行就是幕布本身不匀（褶皱/反光/阴影）—— 换块布重拍比调参数有效得多。

**视频生成的宠物不会转头看我？**
对，视频只有一个角度，做不了 16 方向视线（`look`）。要"真的转头看我"，走 3D 路线（`blender-*`）。

---

## ⚠️ 素材版权声明

- `assets/siu.mp3` 为网络公开的二创梗语音片段，版权归原作者所有，**仅供个人学习交流使用**。
  ⚠️ 它**不在** DPSL-1.0 的授权范围内，也没有写进仓库根 `pet.json` 的 `audio` 字段 ——
  也就是说画廊装出来的那只 C罗 不带这个音频。
- `assets/spritesheet.webp` 为粉丝二创像素形象，沿用 Codex 桌宠素材契约制作。
- 用 `dsh-pet-forge` 生成的宠物：图集来自生图模型，请自行确认所用模型的服务条款。
- 若您是权利人且不希望相关内容被展示，请联系删除。

## 📄 License

- **代码**以 [MIT License](LICENSE) 开源。
- **桌宠素材与"收录进宠物社区"这件事**按 [DSH 桌宠开放共享协议 DPSL-1.0](docs/PET-SHARING-AGREEMENT.md)
  授权（仓库根 `pet.json` 的 `sharing` 块就是这份声明；英文版见
  [`docs/PET-SHARING-AGREEMENT.en.md`](docs/PET-SHARING-AGREEMENT.en.md)）。
- `assets/` 里的第三方素材（如 `siu.mp3`）不适用上面两条，见上一节。
