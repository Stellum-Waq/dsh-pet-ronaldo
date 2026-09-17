# 音频设计参考

## 一、两条音源

| 来源 | 命令 | 特点 |
| --- | --- | --- |
| **本机合成**（推荐） | `--sfx <key>` | 纯 Node 生成 16bit PCM WAV，零依赖、零 API 成本、无版权问题、可复现 |
| **系统 TTS** | `--add "tts:<key>:<台词>"` | Windows SAPI 合成人声，让宠物"会说话" |
| **用户自己的音频** | `--add "file:<key>:<绝对路径>"` | 复制进宠物包（wav / mp3 / ogg） |

全部产物放在 `<宠物包>/audio/`，路径写进 `pet.json` 的 `audio` 字段。

## 二、内置音效清单

| key | 名字 | 声音设计 | 建议触发点 |
| --- | --- | --- | --- |
| `celebrate` | 完成庆祝 | C5→E5→G5→C6 上行琶音 + 高八度亮铃 + 短混响 | **任务完成**（`celebrating`） |
| `failed` | 出错 | 420→300Hz、300→150Hz 两段下滑锯齿波 | 出错（`failed`） |
| `click` | 点击 | 880→1320Hz 的 75ms 气泡音 | 单击宠物 |
| `dive` | 连点 | 700→1050→520Hz 的俏皮两连音 | 连点 3 次 |
| `working` | 开始工作 | G4→C5 两音上扬 | 开始执行工具（`working`） |
| `waiting` | 等待回复 | 660Hz 轻叩两下，间隔 90ms | 需要审批/输入（`waiting`） |
| `boot` | 登场 | C4→G4→C5 + 混响 | 宠物第一次加载 |

### 声音设计的几条原则

- **完成音要"上行"**。人对上行音程的直觉是"成功/开放"，下行是"失败/闭合"。
  所以 `celebrate` 用大调琶音，`failed` 用下滑音。
- **音效要短**。桌宠音效是**打断性**提示，超过 1.2 秒就会烦人。
  内置音效最长的是 `celebrate`（约 1.07s），其余都在 0.5s 内。
- **首尾必须淡入淡出**。`tone()` 自带 attack/release 包络，避免波形突变造成"啪"的爆音。
- **叠加后要软限幅**。`mix()` 末尾过一遍 `tanh`，防止多轨相加削顶成方波。
- **别用噪声当主音**。方波/锯齿波只用于"出错"这类需要粗糙感的场景，而且增益压到 0.25 左右。

## 三、TTS（Windows SAPI）

```powershell
node ...\forge.mjs audio --pkg <目录> --add "tts:celebrate:喵！任务搞定啦"
node ...\forge.mjs audio --list          # 顺便看已安装的语音
```

### 语言与语音选择

`pickVoice()` 的规则：
1. 台词含中日韩汉字 → 优先挑 `culture` 以 `zh` 开头的语音；
2. 否则挑 `en` 开头的；
3. 都没有就用第一个。

所以**中文台词要有效果，系统里得装了中文语音**（Windows 设置 → 时间和语言 → 语音 →
添加语音，装"中文（简体，中国）"）。没装时会用英文语音硬读中文，听起来会很怪，
这时要么装语音，要么把台词改成英文。

### 为什么不会乱码（重点）

TTS 的台词里全是中文，路径里也可能有中文（比如 `D:\代码\桌宠\...`）。
本项目的做法是：

1. 把 `{text, out, voice, rate, volume}` 写成 **UTF-8 无 BOM 的 JSON 文件**；
2. PowerShell 脚本本身保持**纯 ASCII**，只做
   `Get-Content -LiteralPath '<json>' -Raw -Encoding UTF8 | ConvertFrom-Json`；
3. 用 `powershell.exe -File <脚本>` 执行，**不把任何中文放到命令行上**。

反面教材（会踩的坑）：

- `powershell -Command "say('中文')"` —— 命令行按系统代码页编码，中文必坏；
- 用 `>` 重定向中文输出 —— 重定向默认 UTF-16LE，下游按 UTF-8 读就全是乱码；
- 把 wav 以 base64 塞进 JSON 传 —— 体积翻 33%，还有被中间层改写编码的风险。

## 四、事件映射

`pet.json` 里两个字段把音效接到行为上：

```json
{
  "triggers":     { "celebrating": "celebrate", "failed": "failed", "waiting": "waiting", "working": "working" },
  "interactions": { "click": "click", "tripleClick": "dive", "boot": "boot" }
}
```

- `triggers` 由**宿主进程**播放（系统级播放器，任何窗口、任何会话都听得见，**与浏览器静音无关**）。
- `interactions` 由**浏览器**播放（需要用户已与页面交互过，否则会被自动播放策略拦下）。

## 五、多宠物时的音量管理

设置 → ⚽ 桌宠 里有两个开关：

| 开关 | 取值 | 说明 |
| --- | --- | --- |
| 宿主提示音 · 播放范围 | `primary`（默认） | 只有**第一只**带对应音效的可见宠物会响，避免三只宠物同时叫 |
| | `all` | 所有可见宠物都响 |
| 每只宠物的 🔊 按钮 | 开 / 关 | 单只静音（`sound: false`），跨重启保留 |

## 六、验证声音到底出没出来

```powershell
node ...\forge.mjs play --id <宠物id> --key celebrate
```

成功返回 `{"ok": true, "human": "已交给宿主进程播放…"}`。

如果 `ok: true` 但没声音，按顺序查：

1. **平台播放器**：Windows 走 WPF `MediaPlayer`（见 `host.js` 的 `playCommand`），
   macOS 走 `afplay`，Linux 走 `ffplay`（没装就改 `paplay`）。
2. **命令嵌套**：Windows 上**不要**再包一层 `powershell.exe -Command "…$m…"`——
   外层 pwsh 会先把双引号里的 `$m` 插值吃掉，内层脚本直接语法错误，
   表现为"动画在跳、声音没有"的静默失败。`smoke-host.mjs` 里有一条断言专门防这个回归。
3. **文件本身**：`ffplay <wav>` 或双击播放试试。
4. **是不是被静音了**：设置里的"系统音已开/已关"、以及单只宠物的 🔊 按钮。
