# ⚽ C罗桌宠（dsh-ronaldo-pet）

> DeepSeek Harness（DSH）桌面宠物插件 —— 一只住在 Web 界面右下角的 **Cristiano Ronaldo 葡萄牙 7 号 chibi 吉祥物**。
> 它会盯着 Agent 干活：对话进行中它颠球奔跑，对话完成时跳起 **SIU** 庆祝并全机播放提示音，出错时戏剧性摔倒假摔。还支持导入你自己的 spritesheet 精灵图，统一管理多只宠物。

![C罗桌宠](docs/SPRITESHEET-CONTRACT.md)

## ✨ 特性

- **完整 C罗动画**：严格沿用 Codex 桌宠精灵图契约（8 列 × 11 行、每格 192×208），含 idle / 运球 / 挥手 / SIU 跳跃 / 假摔 / 等待 / 颠球 / 思考 / 16 方向视线
- **实时感知 Agent 状态**：宿主轮询 `agents` 服务，配合 `tools/execute`、`approval/request`、`agent/request-error` 事件推导工作 / 思考 / 等待 / 出错 / 空闲五种模式
- **对话完成全机可闻**：宿主进程用系统命令播放 SIU 提示音，任何窗口、任何会话完成任务都会响，与浏览器静音无关
- **可互动**：拖动运球（方向跟随）、悬停看向光标、快速连点 3 次假摔要球、点击冒气泡
- **统一管理 + 自定义导入**：设置面板里可导入任意 spritesheet 精灵图（支持 codex 项目目录一键导入），命名、大小、行为、显隐、位置统一管理

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

### 方式一：DSH 动态插件（推荐，已实测）

1. 克隆仓库：

   ```bash
   git clone https://github.com/Stellum-Waq/dsh-pet-ronaldo.git
   ```

2. 修改 `src/host.js` 顶部 `CONFIG` 中的素材路径（指向本机实际路径）：

   ```js
   const CONFIG = {
     spritePath: '/你的/路径/dsh-ronaldo-pet/assets/spritesheet.webp',
     voicePath:  '/你的/路径/dsh-ronaldo-pet/assets/siu.mp3',
     // 其他按需
   }
   ```

   > 声音默认用 Windows 的 `powershell` + WPF MediaPlayer 播放。macOS 可改成 `afplay`，Linux 可改成 `ffplay`。

3. 生成一键安装载荷：

   ```bash
   node scripts/build-package.mjs -    # 输出 JSON 载荷到终端
   ```

4. 把载荷粘贴给 DSH 的 `cordis_define` 工具（`kind: "new"` 创建；后续更新用 `kind: "existing"` + 返回的 `pluginId`），然后用 `cordis_run` 激活，Web 界面右下角即出现 C罗。

### 方式二：DSH bundle 插件（常驻，跨重启保留）

本仓库同时提供了正式 bundle 插件结构（`package.json` + `cordis.patch.yml` + `host.js` + `client/client.js`）：

1. 安装依赖并加入 profile：

   ```bash
   cd ~/.dsh/profiles/web
   npm install <本仓库路径>     # 或发布到 npm 后 npm install dsh-ronaldo-pet
   ```

2. 在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 中加入 `"dsh-ronaldo-pet"`：

   ```json
   {
     "dsh": { "profile": { "bundles": [ "dsh-ronaldo-pet" ] } }
   }
   ```

3. 重启 DSH，插件随 profile 常驻加载（素材从 `assets/` 相对路径读取，无需改 CONFIG）。

### 方式三：直接预览动画（无需 DSH）

```bash
cd dsh-ronaldo-pet
npx serve .      # 或 python3 -m http.server
# 打开 demo/index.html
```

## ⚙️ 配置

所有可调项集中在 `src/host.js` 顶部 `CONFIG`（动态插件版）或 `host.js` 顶部 `CONFIG`（bundle 版）：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `spritePath` | 本机 C罗精灵图路径 | 8×11 精灵图 |
| `voicePath` | 本机 SIU 音频路径 | 完成提示音 |
| `pollMs` | `500` | Agent 状态轮询间隔 |
| `celebrateMs` | `4800` | 庆祝动画时长 |
| `failedMs` | `2600` | 失败动画时长 |

## 📁 项目结构

```
dsh-ronaldo-pet/
├── host.js               # bundle 插件 Host 半（常驻，用 node:fs 读素材）
├── client/client.js      # bundle 插件 Client 半（window.__ModuleLoader__ 格式）
├── src/
│   ├── host.js           # 动态插件 Host 半（webServer 素材路由 + agents 轮询 + 系统音 + 导入 RPC）
│   └── client.js         # 动态插件 Client 半（通用管理 + 精灵图渲染 + 交互）
├── assets/
│   ├── spritesheet.webp  # 8×11 精灵图（1536×2288）
│   └── siu.mp3           # SIU 提示音
├── demo/index.html       # 独立动画演示页（无需 DSH）
├── docs/
│   └── SPRITESHEET-CONTRACT.md   # 精灵图契约
├── scripts/
│   ├── build-package.mjs # 生成 cordis_define 安装载荷
│   └── validate.mjs      # 仓库完整性校验
├── cordis.patch.yml      # bundle patch（insert 插件行）
├── package.json          # bundle 插件包元数据
├── LICENSE
└── README.md
```

校验：`node scripts/validate.mjs`

## ❓ 常见问题

**为什么桌宠只在某一个窗口里？**
动态插件是会话级绑定：桌宠界面只注入到激活它的会话页面。但完成音由宿主进程系统级播放，**任何窗口、任何会话完成任务本机都会响**。若要让桌宠形象出现在所有窗口，请使用「方式二：bundle 插件」。

**为什么用轮询而不是事件监听？**
实测部分部署里 `agent/status` 等事件不流经动态插件所在总线，轮询 `agents` 服务是最可靠的跨部署方案。

**导入的精灵图没有 16 方向视线怎么办？**
第 9–10 行是可选的。若你的精灵图只有 9 行（8×9），视线功能自动降级为待机首帧；`每行帧数` 留空即按「每行满帧 = 列数」处理。

## ⚠️ 素材版权声明

- `assets/siu.mp3` 为网络公开的二创梗语音片段，版权归原作者所有，**仅供个人学习交流使用**，请勿用于商业用途。
- `assets/spritesheet.webp` 为粉丝二创像素形象，沿用 Codex 桌宠素材契约制作。
- 若您是权利人且不希望相关内容被展示，请联系删除。

## 📄 License

代码以 [MIT License](LICENSE) 开源。素材文件（`assets/`）仅限个人学习交流，遵循上一条声明。
