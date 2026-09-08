# ⚽ C罗桌宠（dsh-ronaldo-pet）

> **DeepSeek Harness（DSH）桌面宠物插件** —— 一只住在 Web 界面右下角的 **Cristiano Ronaldo 葡萄牙 7 号 chibi 吉祥物**。
> 它会盯着 Agent 干活：对话进行中颠球奔跑、回合中思考、等待审批时期待地看向你、出错时戏剧性假摔；**对话完成时跳起 SIU 庆祝并全机播放提示音**。
> 一条命令即可安装，随 profile 常驻加载，不需要把素材路径改成你本机的路径。

- 已在 **DSH `0.1.2-rc.1`**（`dsh web`）实测通过：Host 半正常加载、Client 半正常注入 `shell.overlay` 渲染、动画/状态接口正常。
- 通过 **bundle 插件**形态分发：`dsh plugin --profile web add github:Stellum-Waq/dsh-pet-ronaldo` 即可安装（详见下方安装）。

## ✨ 特性

- **完整 C罗动画**：8 列 × 11 行精灵图契约（每格 192×208），含 idle / 运球 / 挥手 / SIU 跳跃 / 假摔 / 等待 / 颠球 / 思考 / 16 方向视线
- **实时感知 Agent 状态**：Host 半轮询 `agents` 服务，并监听 `tools/execute`、`approval/request`、`agent/request-error` 事件推导 工作 / 思考 / 等待 / 出错 / 空闲 五种模式
- **对话完成全机可闻**：Host 进程用系统命令播放 SIU 提示音，任何窗口、任何会话完成任务都会响，与浏览器静音无关
- **可互动**：拖动运球（方向跟随）、悬停看向光标（16 方向）、快速连点 3 次假摔要球、点击冒气泡
- **统一管理 + 自定义导入**：设置面板（⚽ 桌宠）里可管理每只宠物的名字 / 大小 / 平时行为 / 显隐 / 位置，支持从 **codex 项目目录**（`final/spritesheet-extended.webp` + `pet_request.json`）一键导入，或手动指定任意 spritesheet 图片 + 行列/格宽格高/每行帧数
- **零配置**：素材（精灵图 + 提示音）随 npm 包/GitHub 仓库一起分发，`host.js` 默认相对包目录读取，安装后无需改动任何路径

## 🎮 状态 → 动作映射

| Agent 工作状态 | 桌宠动作 | 说明 |
| --- | --- | --- |
| 工作中（工具执行中） | 颠球（第 7 行） | 专注干活 |
| 回合中空闲 | 思考（第 8 行） | 审阅输出 |
| 等待回复 / 审批 | 等待（第 6 行） | 期待你回复 |
| 出错 | 假摔（第 5 行） | 戏剧性摔倒 |
| 空闲 | 呼吸待机（第 0 行） | 休息中 |
| **对话完成** | **SIU 跳跃（第 4 行）＋ 系统音** | 完成啦！ |
| 拖动 | 运球（第 1/2 行，方向跟随） | 带球奔跑 |
| 悬停 | 看向光标（第 9/10 行，16 方向） | 注视你 |
| 连点 3 次 | 假摔（第 5 行） | Penalty kick! |

## 🚀 安装

### 方式一：一条命令安装（推荐，DSH ≥ 0.1.1-rc.1）

本仓库是标准 **DSH bundle 插件**（`package.json` 声明 `dsh.bundle` + `dsh.client` + `cordis.patch.yml`），用官方插件 CLI 安装即可：

```bash
# 从 GitHub 安装（对外发布路径）
dsh plugin --profile web add github:Stellum-Waq/dsh-pet-ronaldo

# 进阶：固定版本/提交，避免后续 push 改变内容
dsh plugin --profile web add github:Stellum-Waq/dsh-pet-ronaldo#v1.2.0
```

然后**重启 `dsh web`**（在运行 `dsh web` 的终端 Ctrl+C，再重新执行 `dsh web`）。插件随 profile 常驻加载，Web 界面右下角出现 C罗。

> 本包是纯 JavaScript + 静态素材，**没有构建脚本**，所以从 GitHub 安装不需要 pnpm 的 `allowBuilds` 放行。
>
> 更换 profile 名即可装到其它 profile：`dsh plugin --profile <name> add github:Stellum-Waq/dsh-pet-ronaldo`。

**卸载：**

```bash
dsh plugin --profile web remove dsh-ronaldo-pet
```

### 方式二：本地路径安装（开发调试）

```bash
dsh plugin --profile web add D:\代码\桌宠\dsh-ronaldo-pet   # Windows
dsh plugin --profile web add /path/to/dsh-ronaldo-pet       # macOS / Linux
```

### 方式三：独立预览动画（无需 DSH）

```bash
cd dsh-ronaldo-pet
npx serve .      # 或 python3 -m http.server
# 打开 demo/index.html
```

### （遗留）方式四：旧版“动态插件”（cordis_define）

仓库的 `src/` 与 `scripts/build-package.mjs` 保留了早期版本的**动态插件**形态：通过 `cordis_define`（`kind: "new"`）把 `code.host`/`code.client` 运行时注入到**单个会话页面**，且 `src/host.js` 顶部 `CONFIG` 需要改成你本机的素材绝对路径。

该形态已不再是主流：默认 `dsh web` profile 不启用 runtime Cordis 工具，且会话级注入无法跨重启保留。**新用户请使用方式一/方式二**；`src/` 仅作为参考或进阶玩法保留。

## ⚙️ 配置

bundle 版的所有可调项集中在 `host.js` 顶部 `CONFIG`：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `spritePath` | `<包目录>/assets/spritesheet.webp` | 内置 C罗 精灵图（相对包目录，装好即用） || `voicePath` | `<包目录>/assets/siu.mp3` | SIU 提示音（相对包目录，装好即用） |
| `pollMs` | `500` | Agent 状态轮询间隔 |
| `celebrateMs` | `4800` | 庆祝动画时长 |
| `failedMs` | `2600` | 失败动画时长 |

- 想换你自己的素材：把同名文件覆盖到 `<包目录>/assets/` 下即可（或直接改 `spritePath`/`voicePath` 指向其它文件）。
- 自定义导入：打开 DSH **设置 → ⚽ 桌宠**，可从 codex 项目目录一键导入精灵图（读取 `final/spritesheet-extended.webp`/`final/spritesheet.webp` 与 `pet_request.json`），或手动填写任意 spritesheet 图片的绝对路径 + 行列/格宽格高/每行帧数；导入的宠物会出现在右下角并同样跟随 Agent 状态动画。
- **提示音平台差异**：默认用 Windows 的 `powershell` + WPF MediaPlayer 播放。macOS 可把 `playCommand` 改成 `afplay`，Linux 可改成 `ffplay`/`paplay`（见 `host.js`）。
- 想彻底静音：把 `host.js` 里的 `playSystemVoice()` 调用注掉即可。
- 这些配置同时支持通过 bundle patch 行传入（例如给插件行加 `config: { pollMs: 800 }`），默认值即上表。

## 📁 项目结构

```
dsh-ronaldo-pet/
├── host.js               # bundle 插件 Node/Host 半（读 assets + webServer 路由 + agents 状态机 + 系统音 + 导入 RPC）
├── client/client.js      # bundle 插件浏览器/Client 半（window.__ModuleLoader__ 工厂 → shell.overlay + settings.section）
├── cordis.patch.yml      # bundle patch（insert 插件行：id=ronaldo-pet）
├── package.json          # bundle 插件包元数据（dsh.bundle / dsh.client / exports ./client）
├── assets/
│   ├── spritesheet.webp  # 内置 C罗 8×11 精灵图（1536×2288，每格 192×208）
│   └── siu.mp3           # SIU 提示音
├── src/
│   ├── host.js           # （遗留）旧版动态插件 Host 半：素材走本机绝对路径 CONFIG
│   └── client.js         # （遗留）旧版动态插件 Client 半（bundle 版功能同源的参考实现）
├── demo/index.html       # 独立动画演示页（无需 DSH）
├── docs/
│   └── SPRITESHEET-CONTRACT.md   # 精灵图契约
├── scripts/
│   ├── build-package.mjs # （遗留）生成 cordis_define 安装载荷
│   └── validate.mjs      # 仓库完整性校验
├── LICENSE
└── README.md
```

仓库完整性自检：`node scripts/validate.mjs`

## ❓ 常见问题

**为什么推荐 bundle 版而不是旧动态插件版？**
bundle 版是当前 DSH 的正式插件形态：`dsh plugin add` 一条命令装好、随 profile 启动自动常驻、跨重启保留，且素材随包分发、**不用改任何本机路径**。旧动态插件是会话级注入且需要手动维护本机素材路径。

**桌宠会出现在所有会话里吗？**
会。bundle 版把桌宠注册进 **`shell.overlay`**（root 级浮动层，位于所有会话页面之上），全应用可见——不是旧动态插件那种只绑单会话。完成提示音本来就是宿主进程系统级播放，任何窗口/会话完成任务都会响。

**为什么用轮询而不是纯事件监听？**
实测部分部署里部分事件不流经插件所在总线，轮询 `agents` 服务是最可靠的跨部署兜底；事件监听（`tools/execute`、`approval/request`、`agent/request-error`）用于更细粒度地推导工作/等待/出错模式。

**拖拽位置会记住吗？**
bundle 版把桌宠位置保存在页面内存中（切换/刷新页面后回到右下角）。想要跨重启记忆位置属于后续迭代方向。

**macOS / Linux 能跑吗？**
能。渲染与状态联动完全跨平台；只有“系统提示音”依赖本机播放命令，按上文「配置」把 `playCommand` 换成 `afplay`（macOS）或 `ffplay`/`paplay`（Linux）即可。

**自定义精灵图 / 多宠物管理在哪里？**
就在 bundle 版内置：打开 DSH **设置 → ⚽ 桌宠** 面板，可导入 codex 项目目录或任意 spritesheet 图片，命名、大小、平时行为、显隐、位置统一管理；导入的宠物与内置 C罗 一样跟随 Agent 状态动画。（`src/` 下的旧版动态插件保留了同源的参考实现。）

## ⚠️ 素材版权声明

- `assets/siu.mp3` 为网络公开的二创梗语音片段，版权归原作者所有，**仅供个人学习交流使用**，请勿用于商业用途。
- `assets/spritesheet.webp` 为粉丝二创像素形象，沿用 Codex 桌宠素材契约制作。
- 若您是权利人且不希望相关内容被展示，请联系删除。

## 📄 License

代码以 [MIT License](LICENSE) 开源。素材文件（`assets/`）仅限个人学习交流，遵循上一条声明。
