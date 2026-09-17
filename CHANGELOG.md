# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [2.2.0] — 2026-09-18

**主题：手上有素材就别绕道生图 —— 导入一段视频（尤其绿幕），让里面真实的动作直接变成桌宠动作。**

### 新增

- **🎬 视频导入生成**（`forge.mjs video` + 设置里的「🎬 视频生成」面板）
  流水线：**抽帧 → 抠幕布 → 按动作切段 → 并集包围盒对齐落格 → 图集 + pet.json**。
  三条输入方式：① 一个视频 + `--segments "idle:0-2.5,waving:2.5-5"`（最准）；
  ② 每个动作一段视频 `--videos "idle=a.mp4,waving=b.mp4"`；
  ③ `--auto-segments` 自动切分（只当草稿，报告里附划分结果并要求核对）。
  另外 `--frames-dir` 可以直接喂已经抽好的 PNG 帧 —— **完全不需要解码器**。
- **两套解码引擎，自动挑**：
  - `ffmpeg`（PATH / 环境变量 / 常见安装位置）—— 最稳，还能 `--audio-from-video celebrate@5.2-6.4` 把视频原声抽成音效；
  - `python + OpenCV`（Anaconda 常见自带）—— OpenCV 内部自带一份 FFmpeg，抽帧够用。
  两个都没有时，`doctor` 与报错里会给出**可执行的安装命令**，而不是一句"失败了"。
- **自研色度键控**（不是把活丢给 ffmpeg 滤镜）：
  `--key auto` 从画面**边缘**取中位色当幕布色并给出置信度；Cb/Cr 色度平面双阈值
  （`--similarity` / `--blend` 羽化）+ **溢色抑制**（`--spill`，绿边去染）+ `--erode` 收边。
  报告里给 `avgTransparentRatio`：0.5~0.97 正常，**>0.97 直接报错**（说明把角色也抠了）。
- **两种自动切分策略**：`pauses`（在"夹在两段真实动作之间"的停顿处下刀，紧挨孤立尖峰时**吸附到尖峰**这个姿态边界上）
  与 `transitions`（没有停顿、动作硬切时按局部极大切）。切不动就如实退化成等分并标 `synthetic`；
  运动曲线是平台时标 `ambiguous`（"切点位置等于随机挑的"）。
- **对齐落格沿用两趟渲染**：全体帧共用并集包围盒 + 统一缩放（帧间位移精确保留、体型一致），
  `--loose failed` 可让大幅位移的动作单独算包围盒。
- **进度可见**：CLI 把 `[1/6]…[6/6]` 进度打到 **stderr**（stdout 永远只有一个 JSON），
  界面里的视频面板起后台任务后轮询显示实时日志。
- `doctor` 新增 `checks.videoEngines` 与 `routes.video`；`references/video.md` 是这条路的完整说明。

### 修复

- **视频路线的两条退路曾经是死代码，现已修好。** `dsh-pet-video` 技能此前专门教人
  "复制一份 forge 打补丁"来绕开它们，现在补在上游，那个步骤不再需要：
  - `forge.mjs` 判断"有没有 `--frames-dir`"时查的是 `args.framesDir`，而命令行解析器
    产出的键是带横线的 `frames-dir`，恒为 `undefined` —— 于是**探不到解码引擎的机器
    即使手里已经有抽好的帧，也会被判"导不了视频"**。现在两条退路都认。
  - `video.mjs` 先 `parseChromaColor(opts.key)` 再算 `noKey`，而
    `parseChromaColor('none')` 返回 `null` 会直接报错退出 —— CLI 的 `--no-key`
    恰好把 key 翻成 `'none'`，所以**"素材自带 alpha、不需要抠幕布"整条路走不通**。
    现在先算 `noKey`，`--no-key` 真的能跑通。
  `scripts/verify-video.mjs` 新增两条 **CLI 层**回归守住它们（原先只有库层测试，
  传的是 `noKey: true`，正好绕开了出问题的路径）。

- **技能安装改为可重复。** 新增 `scripts/install-skills.mjs`：把 `skill/` 下的技能
  同步到技能根 `~/.agents/skills`（`--check` 只看不写、`--link` 建链接供开发用）。
  以前是一次性手工复制的，结果仓库里改了 `SKILL.md`、装在别处的还是旧文本 ——
  实测踩过：模型读着旧说明去跑一个已经不需要的补丁步骤。
  同时把 `dsh-pet-video` 收进仓库一起分发（此前只存在于全局技能目录、没有版本管理）。

- **显式指定的插件地址不再回退到别的端口。** `--base` / `--explicitBase` 给了就只认它：
  之前失败后会继续试 `127.0.0.1:3080`，于是"到底把宠物注册进哪个 DSH 实例"变成不确定的 ——
  实测把冒烟测试的宠物注册进了用户**真正在用的**那台 DSH 里（脏数据只能手工清）。
  现在显式地址失败就明确失败：`指定的桌宠插件地址没有响应：…（显式指定时不会再去试别的端口）`。
- **宿主拉起视频任务时把"自己"的地址传给子进程**（`--base http://127.0.0.1:<本实例端口>`）。
  不传的话子进程会去猜端口，同样是"注册到别人家"的问题。
- **OpenCV 通道的中文路径**：`cv2.imwrite` 在 Windows 上写中文路径会**静默失败**（返回 False、文件不存在），
  而 `cv2.VideoCapture` 读中文路径又是好的。抽帧脚本统一改用
  `cv2.imencode(...).tofile()`（并在文件头注明原因），避免"抽出来是空的"这种查半天的问题。
- **Python 侧 stdout 强制 UTF-8**：Windows 上 Python 往管道写 stdout 默认用本地代码页（cp936），
  中文错误信息到了 Node 那边会变成"乱码 JSON"。现在 `sys.stdout.reconfigure(encoding='utf-8')`。
- 抽帧脚本里所有命令行参数先转数字再比较（`frame.shape[1] > max_width` 在参数是字符串时会 `TypeError`）。
- 顺带删掉 `SKILL.md` 里重复了两遍的"重启 dsh web"提示。

### 变更

- `pet.json` 的 `source.kind` 新增 `"video"`（记录视频路径、引擎、抠像参数、每段动作的时间区间）。
- 视频路线**不生成 `states.look`**（16 方向视线需要多角度素材）：不伪造、不假装，客户端会退回 idle。
- `package.json` 版本 2.2.0；`files` 增加 `lib/`、`gallery/`、`pet.json`（v2.1 起）。

## [2.1.0] — 2026-09-17

**主题：给桌宠一个"共享与发现"的渠道 —— 一份协议（DPSL-1.0）＋ 一个宠物社区窗口。**

一句话概括这版要解决的问题：用这个插件做出来的桌宠，**怎么才能被别人拿到**。
答案是：作者自愿按一份明确的协议把宠物包发布到自己公开的 GitHub 仓库，
插件去读、去展示、去提供下载与一键安装 —— 插件不托管素材，也不替任何作者上传。

### 新增

- **📜 DSH 桌宠开放共享协议 DPSL-1.0**（`docs/PET-SHARING-AGREEMENT.md`，含英文版）
  面向"小型创作资产 + 集中式索引"这个具体场景写的**收录与分发授权**，不是泛泛的开源许可：
  - **著作权仍归作者**，可随时撤回（改一行 `sharing.shared: false` 或删掉 `dsh-pet` 标签即失效）；
  - 授权范围窄到"收录 / 展示预览图 / 提供下载 / 本机安装"，**明确排除**商业销售、再许可、
    移除署名、商标与人格权使用、**用于训练模型**；
  - 接受方式是 `pet.json` 里的结构化 `sharing` 块（协议第 2.1 条），**不适用"沉默即同意"**；
  - 默认保守：默认不共享、默认不商用、默认可二创但必须署名 + 同样采用 DPSL；
  - **诚实条款**：已经下载到别人本机的副本无法远程召回，这件事写在正文第 9.4 条里，
    而不是含糊过去；AI 生图与同人素材的权利风险明确由发布者承担（第 8 条）。
- **🌐 宠物社区（画廊）窗口**：设置 → ⚽ 桌宠 → 🌐 宠物社区
  - 条目卡片含**预览图、署名、仓库链接、star、更新时间、协议徽章**，可搜索、可按 star/更新时间排序；
  - **一键安装**：下载 → 解包 → 严格校验 → 注册（装完立刻出现在右下角与桌面）；
  - **⚠️ 兼容导入**：社区里同契约但缺 `pet.json` 的仓库，可由用户显式选择在**本机**适配
    （`assets/spritesheet.json` → 合成 `pet.json`，动作行映射为启发式并如实报告未映射项）；
  - **仅收录**：形态完全不同的桌宠项目只给链接与安装命令，界面上不把它伪装成可直装；
  - 手填任意 `owner/repo` 可探测后加入列表。
- **两路发现 + 离线兜底**：官方索引 `gallery/index.json`（可提 PR）与
  GitHub `topic:dsh-pet` 自动发现合并去重（`source: index | discovery | both`）；
  完全离线时用**包内置索引 + 本地缓存**（`$DSH_HOME/storages/dsh-pet-forge/gallery-cache.json`）。
  加进索引或被自动发现的仓库：`dsh-ronaldo-pet` 自己、`lizhuangCoding/dsh-chicken-pet`、
  `yukikazesl/dsh-pet-kyoko`、`ToBeWin/DSH-Pet-Companion`、`kongchengavg/dsh-pet-StatusLight`、
  `coldfish486/dsh-anime25d-pets`、`HarmlessFunny/dsh-pet-in-frame`。
- **📤 分享向导（问过才做）**：`forge.mjs share` 不带 `--accept` 时**只返回"该问用户什么"**，
  一个字节都不写；`--accept` 之后才在宠物包目录里生成：
  `pet.json` 的 `sharing` 块、协议全文 `DSH-PET-LICENSE.md`、
  `README.md`（已存在则不覆盖）/ `SHARING.md`、`.gitignore`、`publish.ps1` / `publish.sh`。
  同一件事在网页面板「📤 分享到社区」里也能做，**没勾"我确认…同意按 DPSL-1.0"之前按钮是禁用的**。
- **`forge.mjs gallery` 子命令**：`--refresh` 刷新索引、`--q` 过滤、
  `--probe owner/repo` 只看不装、`--install owner/repo [--compat]` 从社区安装。
- **仓库根目录多了一份 `pet.json`**：插件仓库自己也是一份按 DPSL-1.0 声明的宠物包，
  既是官方参考实现（照着写 `sharing` 块就行），也是画廊里第一个可一键安装的条目。
- **`gallery/` 目录**：官方索引 `index.json` + 提交说明 `README.md`（PR 模板级指引：能写什么、不能替谁声称授权）。

### 安全

- **不执行**仓库里的任何脚本、不装依赖；只读图集与 `pet.json`（`docs/GALLERY-CONTRACT.md` §5）。
- **解包防越界**：`../`、绝对路径、盘符、符号链接与硬链接全部丢弃，只写 `community/<owner>-<repo>/`；
  体积（默认 96MB 下载 / 512MB 解包）与文件数（4000）都有上限。
- **安装时重新校验**：以仓库里**当前**的 `pet.json` 为准 —— 作者把 `shared` 改成 `false`
  之后立刻装不了（协议第 2.3 条的代码实现）。没有 DPSL 声明的仓库直接 403。
- **二进制走 arrayBuffer**：tarball 一旦走 `res.text()` 就会按 UTF-8 解码成烂数据
  （"下载成功但解包失败"的经典成因）。

### 修复

- **本机 Node 拉不到 GitHub**：这台机器把 `raw.githubusercontent.com` 解析到 `127.0.0.1`（本地代理），
  而 Node 自带的 CA 包认不出那张根证书，`fetch` 直接抛
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE`。现在画廊在 fetch 失败后会自动改用 `curl` 兜底
  （走 Windows Schannel，认系统证书），错误信息里也会提示 `NODE_OPTIONS=--use-system-ca`。
- `share` 生成的 `publish.ps1` 之前会把宠物名插进默认提交信息 —— 中文名会往脚本里插入非 ASCII 字节，
  而 PowerShell 5.1 读无 BOM 脚本按 ANSI 解析。现在默认提交信息固定为 ASCII（与 `DesktopPet.ps1` 同一条教训）。
- SKILL.md 里「重启 dsh web」那段警告重复了两遍，删掉一份。

### 变更

- `package.json` 的 `files` 增加 `lib/`、`gallery/`、`pet.json`（否则安装后画廊缺件）；
  `keywords` 增加 `dsh-pet`、`pet-gallery`、`dpsl`。
- `host.js` 的 `CONFIG` 新增 `gallery.*`（可整体关闭或只关联网：`config: { gallery: { online: false } }`）。
- `/pets/register` 的注册逻辑抽成了 `registerPackage()`，与 `/gallery/install` 共用同一条
  "注册即校验"路径；注册项新增 `origin` 字段（从社区装的宠物会带回 key / 仓库 / 协议 / 作者）。

## [2.0.0] — 2026-09-17

**主题：从"网页里的宠物"变成"电脑桌面上的宠物"，并且让作者想画多精细就画多精细。**

### 新增

- **原生桌面窗口**（`desktop/DesktopPet.ps1`，WPF + PowerShell 5.1）
  无边框、背景透明、永远置顶，**不依赖浏览器**：关掉或最小化网页它照样在。
  悬停显示当前工作区与对话名，Agent 状态变化时和网页版播放同一套动画与音效，
  双击用 Edge 打开 Harness 网页，连点三次摔跤，拖动移动（位置跨重启保留），
  滚轮 / 右键菜单改大小。
- **右键菜单与网页面板状态互通**
  打开网页 / 切换宠物 / 平时行为（10 种）/ 大小（含"自动"）/ 系统音开关 /
  置顶 / 复位 / 隐藏 / 设为默认 / 退出。改动会写回宿主，和网页设置面板是同一份状态。
- **`dsh-pet-forge` 技能**：一句话生成并导入新宠物。
  环境自检（生图模型 / Blender / 插件 / TTS）→ 多轮询问动作与音效（都带推荐）→
  生图 / 抠底 / Blender 3D 建模 / 动画 / 合成图集 / 生成音效 / 校验 / 注册。
- **分辨率不再受限**：单格画多大都可以（像素风、精细立绘、写实素材），显示时等比缩放。
  新增 `scaling: smooth | pixelated` 决定缩小走平滑重采样还是最近邻。
  配套两条约定：按 2× 创作（显示宽度 = 单格宽 ÷ 2）、以及 4096px / 6400 万像素的防呆上限。
- **显示尺寸上限从 320 DIP 放宽到 1024 DIP**，并新增「自动」尺寸
  （跟随素材原生分辨率），网页滑杆同步。
- 自定义 spritesheet 导入时可省略格宽格高：只填列数行数，按图片尺寸自动推导。

### 修复

- **桌宠永远朝正上方看（注视光标失效）**：`Update-LookDirFromCursor` 只被定义、
  任何地方都没有调用过，`LookDir` 一直停在初始值 0（0 = 正上方），所以不管光标在哪
  都是同一格。现在在解析 tick 里悬停时调用它，并在动画切换时同步 `AppliedLookDir`。
  实测：上 → 9/0、右 → 9/4、下 → 10/0、左 → 10/4（修复前全是 9/0）。
- **桌面窗口滚轮和菜单改大小完全没反应**：`Set-DesktopSize` 调用了只换图集的
  `Update-Sprite`，而不是真正改窗口尺寸的 `Apply-Size`。
- **拖动不跟手、手一快就断**：拖动期间从未调用鼠标捕获（网页版有
  `setPointerCapture`，桌面版漏了）。窗口永远比光标慢至少一帧，手一快光标就跑出
  窗口，`WM_MOUSEMOVE` / `WM_LBUTTONUP` 再也不来 —— 宠物卡在半路、按键还按着。
- **桌宠"消失"且再也起不来**：宿主把死进程当成还活着。shell 启动方式会留下一个
  `exitCode` 永远为 `null` 的假 proc 存根，`desktopRunning()` 只看它，于是永远返回
  `true`：关掉桌宠不会再拉起，而网页端因为 `displayMode: 'auto'` 把网页那份也藏起来，
  两边都看不到宠物。
- **桌面上叠出两三只宠物**：连着发两次 `start`（页面加载 + 点按钮）会各拉一只，
  因为第一只进程要几秒后才登记进 `desktop.pid`。加了启动守卫。
- **悬停提示每秒闪两三次**：命中检测取的是当前动画帧该像素的 alpha，而待机动画会换
  轮廓，同一像素这帧不透明下帧透明。加了迟滞（不透明像素才开，开了容忍 6 个透明 tick）。
- **桌面窗口不跟随素材分辨率**：`desktopSize` 为"自动"时，网页端的 `size` 字段
  （CSS 像素，与桌面无关）会漏进桌面尺寸计算，1024px 一格的素材被显示成 120 DIP。
- **高分辨率图集启动卡顿**：点击穿透的命中检测原本把**整张图集**复制成像素数组
  （4K 图集约 92 MB，在 UI 线程上），改为只按当前那一格裁剪取像素。
- `setPixel` / `getPixel` 未对坐标取整：传浮点会算出小数下标，`TypedArray[小数]`
  得到 `undefined`，于是整张图集**静默**变成全透明、完全不报错。

### 变更

- 桌面窗口大小设置语义变更：`0` 现在表示"自动"（旧的 `96` 仍是 96）。
  取值范围 `32～1024` DIP。
- `host.js` 默认 `settings.desktopSize` 由 `96` 改为 `0`（自动）。
  内置 C罗 单格 192px，自动值即 96 DIP，视觉上无变化。

### 测试

- `scripts/verify-desktop-lifecycle.mjs` — 桌面宠物生命周期 16 项：
  断言「只要说 running，上报的 pid 就必须真的活着」，覆盖启动 / 防重复 / 被杀后如实报告 / 重启 / 停止。
- `scripts/verify-desktop-interaction.ps1` + `scripts/lib/win32-probe.ps1` —
  真鼠标驱动验证拖动 / 滚轮 / 右键菜单；有人同时在用鼠标时如实报 `INCONCLUSIVE` 而不是 `FAIL`。
- `scripts/verify-highres.mjs` — 高分辨率端到端 21 项：
  1024px 一格的素材能注册、能加载、走高质量重采样、自动尺寸为 512 DIP、
  画面与素材逐像素一致（实测 `mean|d| = 0.17`），并且超过天花板会被明确拒绝。
- `scripts/verify-desktop.mjs` — 让桌宠自己 `RenderTargetBitmap` 出图，与图集对应格逐像素比对
  （整屏截图 / `PrintWindow` 看不到分层窗口，会得出错误结论）。
- `scripts/smoke-host.mjs` — Host HTTP 接口与注册表行为。
- `scripts/verify-client-render.mjs`（23 项）— 用一套极小的 React / DOM / fetch 替身把
  `client/client.js` 真的加载并**渲染一遍**，于是能验证行为而不只是语法：
  `scaling=pixelated` 渲染出 `image-rendering: pixelated`、`smooth` 是 `auto`、
  滑杆是 32～1024、点「自动」真的会 POST `desktopSize: 0`、页面加载后自动 start 一次。
  （网页端插件平时只有在真实 `dsh web` 里才会执行，改完只做 `node --check` 证明不了什么。）

### 已知限制

- 桌面窗口仅 Windows（WPF）。
- 写实到"真人"级别时，单格建议不超过 1024～2048px；更大分辨率在 32 位色深下
  会显著增加解码时间与内存占用（见契约文档的上限说明）。

## [1.2.1] — 更早

- 修复对话完成提示音静默失败；按平台选择播放器（`afplay` / `ffplay`）。

## [1.2.0]

- bundle 版补齐设置面板的多宠物管理与自定义 spritesheet 导入。

## [1.1.0]

- 现代化 bundle 插件发布，支持 `dsh plugin add` 一条命令安装。
