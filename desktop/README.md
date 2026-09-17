# 原生桌面宠物（Windows）

网页里的桌宠只有开着 `dsh web` 页面才看得见。这个模块把同一只宠物搬到**真正的桌面**上：
一个无边框、背景透明、永远置顶的原生窗口。**最小化甚至关掉浏览器它都还在**，
只要终端（`dsh`）还在运行就一直存在；终端一停，它会自己退出。

```
desktop/
├── DesktopPet.ps1      ← WPF 窗口本体（纯 ASCII，原因见下）
├── strings.zh.json     ← 全部中文界面文案（UTF-8，脚本显式读取）
├── Start.cmd           ← 手动启动（双击即可）
├── Stop.cmd            ← 关闭
└── README.md           ← 本文件
```

---

## 一、它是怎么起来的

**自动**：插件 Host 半（`host.js`）在 `apply()` 里调用 `startDesktopPet()`。
插件随 profile 加载，所以**终端一开始运行，桌宠立刻出现**，不需要任何额外操作。

**手动**：双击 `desktop/Start.cmd`，或

```powershell
powershell.exe -STA -ExecutionPolicy Bypass -File "<包目录>\desktop\DesktopPet.ps1" -Base http://127.0.0.1:3080
```

**关闭**：右键桌宠 → 退出桌宠；或 `Stop.cmd`；或直接关掉终端（它会自己走）。

---

## 二、交互

| 操作 | 行为 |
| --- | --- |
| **悬停** | 弹出提示框，显示**当前工作区** + **当前对话标题** + Agent 状态（干活中/思考中/等你回复/完成啦…） |
| **双击（快速点两下）** | 用 **Microsoft Edge** 打开 Harness 网页 |
| **单击** | 冒一句台词气泡 + 播放 `click` 音效 |
| **快速点三下** | 摔跤动画 + `dive` 音效（和网页里一样的彩蛋） |
| **拖动** | 移动位置，松手后记住（跨重启保留） |
| **滚轮** | 快速改大小 |
| **右键** | 菜单：打开网页 / 切换宠物 / 大小 / 置顶 / 复位 / 退出 |

**动作跟着 Agent 状态走**，和网页里完全一致：

| 宿主 mode | 桌宠动作 |
| --- | --- |
| `working`（在调工具） | 专注工作 |
| `review`（在思考） | 思考 |
| `waiting`（等你审批/回答） | 等待 |
| `celebrating`（对话完成） | 跳跃庆祝 + **宿主进程播庆祝音** |
| `failed`（出错） | 摔倒 + 报错音 |
| `idle` | 你设置的那个"平时行为" |

> 音效由**宿主进程**用系统播放器播出（不是浏览器、不是桌宠进程），
> 所以关掉网页也照样响，而且不会和网页端重复播放。

---

## 三、验证它真的显示出来了

原生窗口有个很坑的地方：**日志说"已加载"，屏幕上却可能什么都没有**。
反过来更坑的是：**它明明画得好好的，外部截图却看起来缺了一半**。

```powershell
node scripts\verify-desktop.mjs --base http://127.0.0.1:3080
```

它做的是**让桌宠自己证明**：

1. 在桌宠的日志目录写入 `desktop-pet-capture.txt` 作为触发器；
2. 桌宠看到后用 `RenderTargetBitmap` 渲染**自己当前的精灵**，写出
   `desktop-pet-frame.png`（`DesktopPet.ps1` 里的 `Invoke-SelfCapture`）；
3. 脚本把这张帧与图集**每一格**逐像素比对，报出最匹配的是哪一格、色差多少、
   角色占幅是否与该格一致。

判定：**色差 < 12 且占幅相符 = 整格被完整、正确地渲染**。

> ⚠️ **为什么不能用截图判断**（三条都实测踩过）：
> - `Graphics.CopyFromScreen`（BitBlt）**根本看不到**分层窗口
>   （`AllowsTransparency` 的 WPF 窗口是 `WS_EX_LAYERED`），会误报"没显示"；
> - `PrintWindow` 会把这层窗口和背后的画面拍平在一起，背景不干净 —— 我一度据此
>   得出"只显示了头部"的**错误**结论，并差点去改本来没问题的渲染代码；
> - 200% DPI 下，DPI-unaware 的探针进程会把窗口尺寸报成一半，
>   按那个尺寸分配位图只能抓到左上角四分之一，看起来就像"空的"。
>
> 自检抓帧没有中间商，颜色差就是事实（实测色差 0.14）。

---

## 四、为什么 `DesktopPet.ps1` 里一个中文都没有

Windows PowerShell 5.1 读取 `.ps1` 时，**没有 BOM 就按系统 ANSI 代码页解析**。
在中文 Windows（GBK）上，脚本里的中文会变成乱码——菜单项、气泡全成问号。
而本项目的工作区路径本身就叫 `D:\代码\桌宠`。

所以规则是：

- `DesktopPet.ps1` **只写 7-bit ASCII**（含注释）；
- 所有用户可见文字放 `strings.zh.json`（UTF-8），脚本用
  `Get-Content -Encoding UTF8 | ConvertFrom-Json` 显式读取；
- 日志也显式 `-Encoding UTF8` 写。

副作用是顺带支持了多语言：复制一份 `strings.en.json`，用 `-Strings` 指定即可。

同样的道理，宿主在 spawn 这个进程时也踩过**三个**坑，都写在 `host.js` 的注释里了：

1. **不要传 `windowsHide: true`** —— `powershell.exe` 会以 `0xC0000142`
   （`STATUS_DLL_INIT_FAILED`）直接退出。要隐藏控制台就用 PowerShell 自己的
   `-WindowStyle Hidden`。

2. **不要传 `detached: true`** —— 这个坑最阴：进程**看起来起来了**（能拿到 pid），
   但 PowerShell 会在 ~200ms 内**以退出码 0 干净地退出，且完全不执行脚本**，
   连第一行日志都写不出来、stderr 也是空的。原因是 Windows 下 detached 会给子进程
   一个**没有控制台**的环境，而 powershell.exe 是控制台程序，没控制台就直接走。
   而 Windows 上子进程**本来就不会随父进程退出**，所以根本不需要 detached。
   一行行复现在 `scripts/detached-probe.mjs`：

   ```
   裸 spawn                  → ✅ 存活，日志正常
   + cwd（中文路径）           → ✅ 存活
   + detached:true           → ❌ 208ms 退出 code=0
   + detached + windowsHide  → ❌  88ms 退出 code=0
   ```

3. **不要捕获子进程 stdout**（在沙箱工具进程里会 `EPERM`）。宿主只接管 stderr，
   而且撑过 3 秒后会 `unref()` 掉，免得那条管道拖住 `dsh web` 的退出。

因为"从普通 node 起得来、从 dsh web 起不来"这种事极难现场判断，宿主现在还做了两件事：

- **多种启动方式自动换招**：`shell + Start-Process` → `spawn`（不 detached）→
  `spawn + -WindowStyle Hidden` → `spawn + detached`。哪一种活下来就用哪一种。
- **把诊断落盘**：`%DSH_HOME%\storages\dsh-pet-forge\desktop-pet-spawn.log`
  记录每次尝试的完整命令行、退出码、存活毫秒数和 stderr；
  `/ronaldo-pet/desktop` 接口也能直接读到 `method` / `attempts` / `lastExit` / `lastStderr`。

所以下次"没看到桌宠"时，先看这两样，别再靠猜。

---

## 五、它怎么知道该显示哪只宠物

桌宠进程轮询两个接口：

- `GET /ronaldo-pet/state` —— 每 500ms，拿 `mode`（驱动动画）和
  `active` / `conversations` / `runningCount`（驱动悬停提示）
- `GET /ronaldo-pet/pets` —— 每 4s（第一只还没加载出来时每 500ms 重试），
  拿宠物列表与图集 URL

**选哪只的优先级**（从高到低）：

1. 命令行 `-PetId <id>`
2. 本机记住的选择（`desktop-pet.json` 里的 `petId`），但那只必须还在"显示中"
3. **宿主里的 ⭐ 默认宠物** —— 就是在网页 设置 → ⚽ 桌宠 里点「⭐ 设为默认」选的那只
   （`settings.defaultPet`）
4. 当前任何一只"显示中"的宠物
5. 兜底：任何一只已安装的

> 插件现在**同一时间只开一只**，所以正常情况下第 3 条就命中了：
> 在网页里点 ⭐ 之后，桌面窗口会在 4 秒内跟着切过去。

图集优先用 `sheet.desktopUrl`。为什么需要它：**WPF/WIC 默认解不了 WebP**，
而内置素材原本只有 `.webp`。所以仓库里额外生成了一份 `assets/spritesheet.png`
（`node scripts/build-assets.mjs`），网页仍用体积更小的 WebP，桌面端用 PNG。

### ⚠️ 图集 PNG 的 DPI 是个雷（"头特别大、身体没了"的真凶）

`ImageBrush.Viewbox` 用**绝对单位**时，坐标是**源图片的 DIP 尺寸**，而
`DIP = 像素 × 96 / DPI`。内置素材最初那份 PNG 是从 WebP 转出来的，带着
**density = 25.4** 的元数据 —— WPF 于是把 1536px 的图当成 **5805 DIP 宽**，
`Viewbox=(0,0,192,208)` 只框住了左上角约 3%，画面被极度放大：**只剩一个巨大的头**。

一行行复现在 `scripts/rtb-probe.mjs`：

```
ImageBrush + 原图 (dpi 25.4)   → （空）
ImageBrush + 强制 96dpi        → 50%x92%，色差 0.0
CroppedBitmap + 原图 (dpi 25.4) → 50%x92%，色差 0.0   ← 不受 DPI 影响
```

现在的做法是**双保险**：

1. 桌面端改用 `Image` + `CroppedBitmap`：`SourceRect` 按**像素**裁剪，
   无论图集带什么 DPI 元数据都不会错 —— 对第三方宠物包也免疫；
2. `scripts/build-assets.mjs` 显式 `withMetadata({ density: 96 })`，
   素材本身也不再带脏元数据。

---

## 六、透明处不挡鼠标（click-through）

窗口是矩形的，但角色不是。角落里那些全透明像素如果还吃鼠标事件，就会很烦人。

做法：桌宠进程自带一份图集的 BGRA 像素副本，每 60ms 用 `GetCursorPos` +
`GetWindowRect` 算出光标落在哪一格像素上，读它的 alpha：

- alpha ≤ 16 → 给窗口加上 `WS_EX_TRANSPARENT`，鼠标事件穿透到下面的窗口；
- alpha > 16 → 清掉该标志，正常接收拖动/点击。

`GetCursorPos` 和 `GetWindowRect` 用的是同一个坐标系，所以**天然免疫 DPI 缩放**
的换算问题（这比在 WPF 的 DIP 坐标和物理像素之间来回换算可靠得多）。

---

## 七、宿主接口

宿主半暴露了一个控制口：

```powershell
# 查状态
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3080/ronaldo-pet/desktop -ContentType application/json -Body '{"action":"status"}'

# 启动 / 重启 / 停止
... -Body '{"action":"start"}'
... -Body '{"action":"start","restart":true,"size":180}'
... -Body '{"action":"stop"}'

# 关掉"开机自启"（下次插件加载不会再拉起）
... -Body '{"action":"enable","enabled":false}'
```

也可以在插件行的 config 里关掉：`desktopPet: false`。

---

## 八、排障

| 现象 | 原因 / 处理 |
| --- | --- |
| 终端起来了但没看到桌宠 | 先跑 `node scripts\verify-desktop.mjs --base <地址>`。`NOWINDOW` = 进程没起来 → 看 `%DSH_HOME%\storages\dsh-pet-forge\desktop-pet-spawn.log`（里面有每次尝试的命令行、退出码、存活时间）和 `desktop-pet.log` |
| 日志里出现 `exit code=0 lived=2xxms` | **子进程被 `detached` 坑了**（没控制台就不跑），换招链会自动跳过，不该再出现；若出现说明所有招都失败，把 spawn 日志发出来 |
| 窗口有了但一片空白 | 图集没加载成功。日志里找 `atlas load failed` / `atlas decoded to 1x1` |
| **只看到一个大脑袋、身体没了** | 图集 PNG 带了非 96 的 DPI，`ImageBrush.Viewbox` 按 DIP 取帧就会这样。当前版本已改用按像素裁剪的 `CroppedBitmap`，并且 `build-assets.mjs` 会写死 96 DPI；用 `node scripts/rtb-probe.mjs` 可以复现/回归 |
| 觉得太大 / 太小 | 网页 设置 → ⚽ 桌宠 → 🖥 桌面窗口 拖滑杆（或桌面上滚轮 / 右键 → 大小）。这是**独立于网页端**的尺寸（DIP），默认 96 |
| **网页和桌面重复出现同一只** | 设置 → 🖥 桌面窗口 → 显示位置：默认「智能」，桌面窗口在跑时网页就不再画同一只；想两边都要就切「两处都显示」 |
| 有窗口、有动作、没声音 | 声音是**宿主**播的，不是桌宠播的。用 `forge.mjs play --id <id> --key celebrate` 单独验证 |
| 双击没开浏览器 | 日志里看 `edge resolved:` 那一行；没有的话说明没找到 `msedge.exe`，会退回默认浏览器 |
| 关不掉 | `desktop\Stop.cmd`，或任务管理器结束 `powershell.exe`（命令行里带 `DesktopPet.ps1` 的那个） |
| 位置跑到屏幕外了 | 右键 → 复位到右下角；或删掉 `%DSH_HOME%\storages\dsh-pet-forge\desktop-pet.json` |
| 想换回网页版独占 | 设置 → ⚽ 桌宠 → 🖥 桌面窗口 → 关闭；或 `{"action":"enable","enabled":false}` |

日志位置（都在 `%DSH_HOME%\storages\dsh-pet-forge\`）：

| 文件 | 内容 |
| --- | --- |
| `desktop-pet.log` | 桌宠自己的运行日志（窗口位置、图集加载、悬停内容、慢 tick） |
| `desktop-pet-spawn.log` | **启动诊断**：每次尝试的方式、完整命令行、退出码、存活毫秒、stderr |
| `desktop-pet.pid` | shell 方式启动时记下的进程号 |
| `desktop-pet.json` | 窗口位置/大小/选中的宠物（`posUnit: physical`） |
