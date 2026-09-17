# 排障手册

按"症状 → 定位命令 → 根因"组织。**先跑 `doctor`**，它能一次排除掉一半的问题：

```powershell
node "$env:USERPROFILE\.agents\skills\dsh-pet-forge\scripts\forge.mjs" doctor
```

---

## A. 环境类

### `未配置生图 API Key`
已检查：命令行参数 → 环境变量 → `~/.dsh-eye.json` → Windows 注册表用户环境。

```powershell
# 让用户跑 dsh-eye 的配置向导
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.agents\skills\dsh-eye\scripts\setup.ps1"
```
或临时指定：`--api-key sk-xxx --base-url https://… --model …`

> ⚠️ 安全沙箱会**隐藏密钥类环境变量**。环境里看不到 `DASHEYE_API_KEY` 是正常的，
> 脚本会自己去读用户级配置，不要因此判定"没配"。

### `TTS 不可用`
`doctor` 里 `checks.tts.ok` 为 false 时会给出具体原因。本机实测过一种典型情况：
`GetInstalledVoices()` 能列出 `Microsoft Huihui` / `Zira`，但 `SelectVoice`/`Speak`
一律报 *"No voice installed on the system or none available with the current security setting"*。
**注册表里有语音条目，语音引擎却选不出来** —— 这是系统层面的问题，不是本技能的 bug。

处理：**改用音效**（`sfx:celebrate` 等），或让用户提供一段 wav/mp3 用
`file:<key>:<绝对路径>` 引入。`probeTts()` 做的就是"真跑一次合成"，
而不是只看枚举结果——避免给出错误的可用性判断。

### `blender.exe` 找不到 / Access denied
1. `--blender "<路径>"`，或设 `DSH_BLENDER_PATH`
2. Access denied 是沙箱拒绝执行；用 `sandbox_permissions: danger-full-access` 重试一次
3. 用户在开着 Blender + MCP 插件时，优先走 MCP（见 SKILL.md 第四节）

---

## B. 生成类

### `抠底后画面几乎为空`
主图整体被判成背景色了。

| 处理 | 命令 |
| --- | --- |
| 调小容差 | `--bg-tolerance 20` |
| 干脆不抠 | `--bg-mode none`（保留原图，适合已有透明背景的 PNG） |
| 换个图 | 重新生图，brief 里强调"纯白背景" |

### `背景不纯，已跳过抠底`
`borderStats()` 发现边框颜色标准差 > 18（渐变、阴影、场景背景）。
按上面的表处理，或重新生图。

### 宠物边缘有一圈白边
抠底后残留在半透明像素里的背景色。管线里已经默认做了 **despill**（反预乘去背景色）。
如果仍然明显：`--bg-tolerance` 调大一点让边缘更"薄"，或让用户提供已经抠好的 PNG。

### Tier B 条带被丢弃
`warnings` 里会写「某动作的生图条带切片后靠边…已保留程序化版本」。
说明生图模型没按等宽排版。处理：
- 减少帧数：`--strip-frames 3`
- 只对关键动作用 B：`--strip-actions jumping,failed`
- 接受 Tier A 的质量（本来就不差）

---

## C. 校验类

### `图集尺寸与网格不符`
```
图集尺寸与网格不符：实际 1536×2288，按 8×11 格 · 200×208px 应为 1600×2288。
```
报错里已经给出了"实际"和"应为"，**照抄修正 `--cell-w/--cell-h`** 即可。
这个检查存在的意义是：尺寸不符 = 取帧错位 = 玩家看到的"乱码"。

### `states.xxx 行号 N 超出 0..10`
手工改 `pet.json` 时把行号写错了，或 `rows` 改小但没同步状态表。

### `unusedRowsWithContent`（verify 的警告）
有行没被 `states` 引用却有像素。客户端不会显示它，属浪费体积。
一般无害；想清理就把那些行重渲染为透明。

---

## D. 安装/显示类

### `没有找到运行中的桌宠插件`
`dsh web` 没在跑，或插件没被加载。

```powershell
# 确认已装
dsh plugin --profile web list
# 独立调试（不碰线上进程）
node <包目录>\scripts\dev-server.mjs --port 3099 --pkg <宠物包> --demo
```

### 注册成功但界面没出现新宠物
- 客户端每 500ms 比对宿主 `revision`，变了就自动拉取——正常情况下**无需刷新**
- 若刷新也不出现：设置 → ⚽ 桌宠 看有没有那条记录；`forge.mjs list` 确认注册表
- 记录里有但标着"读取失败"：宠物包被移动/删除了

### 宠物包位置一定要固定
注册表存的是**包目录的绝对路径**。把宠物包挪走会让它失效。
移动后重新 `install` 一次即可。

---

## E. 原生桌面窗口

### 状态显示运行中但屏幕上看不到
```powershell
node <包目录>\scripts\verify-desktop.mjs --base http://127.0.0.1:3080
```
- `PASS` → 真的在显示，可能是被全屏应用盖住了（切一下窗口）
- `NOWINDOW` → 进程没起来，看 **`desktop-pet-spawn.log`** 和 `desktop-pet.log`
- `FAIL`（窗口在但内容是空的）→ 图集没加载成功，日志里找 `atlas load failed` / `atlas decoded to 1x1`

> ⚠️ **别用整屏截图判断**：`CopyFromScreen`（BitBlt）看不到分层窗口
> （`AllowsTransparency` 的 WPF 窗口是 `WS_EX_LAYERED`），会误报"没显示"。
> 本项目的验证器用 `PrintWindow`，走窗口自己的渲染路径。

### 桌宠"起来了又瞬间没了"（**最阴的一个**）

症状：`/ronaldo-pet/desktop` 显示 `running:false` / `pid:null`，
`desktop-pet.log` **完全不存在**（连第一行都没有），`stderr` 也是空的。

根因：宿主用 `child_process.spawn` 时传了 **`detached: true`**。
Windows 下 detached 会给子进程一个**没有控制台**的环境，而 `powershell.exe` 是
控制台程序 —— 没控制台就直接退出：**退出码 0**、约 200ms、脚本一行都不执行。
（`windowsHide: true` 更早就会让它以 `0xC0000142` 挂掉。）

一行行复现：`node scripts/detached-probe.mjs`

```
裸 spawn                  → ✅ 存活，日志正常
+ cwd（中文路径）           → ✅ 存活
+ detached:true           → ❌ 208ms 退出 code=0
+ detached + windowsHide  → ❌  88ms 退出 code=0
```

现在宿主**不传 detached**（Windows 上子进程本来就不会随父进程退出，不需要它），
并准备了四套启动方式自动换招：`shell+Start-Process` → `spawn` → `spawn+-WindowStyle Hidden`
→ `spawn+detached`。要知道实际用了哪招、失败在哪：

```
%DSH_HOME%\storages\dsh-pet-forge\desktop-pet-spawn.log
```

里面有每次尝试的完整命令行、退出码、存活毫秒数、stderr。
接口 `/ronaldo-pet/desktop`（`action:"status"`）也能直接读到
`method` / `attempts` / `lastExit` / `lastStderr`。

### 拖动卡顿
带性能看门狗重启，日志会打出哪一类 tick 超时：

```powershell
powershell.exe -STA -ExecutionPolicy Bypass -File "<包>\desktop\DesktopPet.ps1" `
  -Base http://127.0.0.1:3080 -SlowTickMs 25
```
已知的成本点（都已优化）：
- 拖动时用 `SetWindowPos` 而不是 WPF 的 `Window.Left/Top`（后者每次触发完整布局）
- 拖动期间**完全跳过** hover 检测与提示框开合（Popup 的创建/销毁很贵）
- 缓存窗口句柄，不在每次调用里 `New-Object WindowInteropHelper`
- 右键菜单只在宠物列表**真的变了**时才重建

### 窗口位置错乱 / 拖完自己跳
本机可能是高 DPI（实测 200%）。已改为**全程只用 Win32 坐标系**
（`GetCursorPos` / `GetWindowRect` / `SetWindowPos` / `Screen.WorkingArea` 同一空间），
WPF 的 DIP 只在无法调用 Win32 时降级使用。位置以 `posUnit: "physical"` 存盘，
旧的无标记数据会被忽略（而不是恢复到一个错的位置）。

### 关不掉
`desktop\Stop.cmd`，或任务管理器结束命令行里带 `DesktopPet.ps1` 的 `powershell.exe`。
宿主插件卸载时也会 `taskkill /T /F` 收掉它。

---

## F. 3D 路线

### 渲染出来是一堆全透明图
**最典型的静默失败**：退出码 0、图集"合法"，但宠物是隐形的。

根因：**EEVEE 需要真实 GPU/OpenGL 上下文**。在 `blender --background` 下它只渲染出
头两张，之后全部输出全透明图。已修复：
- 无头模式一律用 **Cycles(CPU)**
- 渲染前先做**预检**：渲一帧 → 读回 PNG 看有没有非透明像素 → 空了就自动切 Cycles 重来
- `blender-run` 会返回 `emptyFrames`；非 0 就是没真出图

> 预检**必须读写出的文件**，不能读 `bpy.data.images["Render Result"]`——
> 后台模式下它的 `pixels` 经常还没填充，会误报"空"（实测踩过）。

### 跳跃/摔倒被裁掉头或腿
Blender 是**直接按单格分辨率渲染**的（默认 192×208，高分辨率素材按你给的 `--cell`），
姿势会顶出画面。
装配时 (`blender-assemble`) 会用**全体帧的并集包围盒 + 统一缩放**重新落位，
和 2D 路线同一套算法，保证不裁切。如果 `auditProblems` 仍非 0，
把相机放宽一点：`blender-plan --ortho-scale 2.6`（或调小动作幅度）。

### 控制台输出是 `(沙箱禁止捕获输出，已改用文件系统判据)`
沙箱下捕获子进程 stdout 会 `EPERM`。`runHeadless` 会自动降级为
`stdio:'ignore'`，并用 `render-report.json` 是否被刷新来判断成败
（比退出码更贴近事实：Blender 有时渲染完了仍以非 0 退出）。

---

## G. 调试利器速查

| 工具 | 用途 |
| --- | --- |
| `forge.mjs doctor` | 一次看清 Node/sharp/生图/Blender/插件/TTS |
| `forge.mjs plan --brief "…"` | 生成给用户看的选择题（带推荐） |
| `forge.mjs verify --pkg <目录>` | 严格校验 + 逐格体检 + 调色板 |
| `forge.mjs inspect --pkg <目录> --rows 0,4,5` | 出放大检查图（带棋盘底） |
| `forge.mjs preview --pkg <目录>` | 独立 HTML，双击即看动画听音效 |
| `forge.mjs play --id <id> --key celebrate` | 验证音效到底出没出声 |
| `scripts/selftest.mjs` | 图像/动画/音频内核离线自检 |
| `scripts/smoke-host.mjs` | Host 路由集成冒烟（30 项断言） |
| `scripts/dev-server.mjs` | 独立端口调试服务器（不碰线上进程） |
| `scripts/verify-desktop.mjs` | 桌面窗口"真的画出来了吗" |
| `desktop/DesktopPet.ps1 -SlowTickMs 25` | 桌面窗口卡顿定位 |

### 用视觉模型复核素材

当前模型不能原生看图时，用 dsh-eye 代看：

```powershell
node "$env:USERPROFILE\.agents\skills\dsh-eye\scripts\vision.mjs" "<目录>\inspect-sheet.png" `
  "这是N行8列的宠物动画帧检查表（棋盘格是透明背景）。逐行检查每格角色是否完整，有没有被裁切/串帧/白边" --mode ask
```

**这一步不要省。** `auditAtlas` 只能查"贴边/串帧"这类几何问题，
"角色是不是缺了条腿""脸是不是糊了"只有看图才知道。
