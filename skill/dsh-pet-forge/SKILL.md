---
name: dsh-pet-forge
description: >
  一句话生成并导入 DeepSeek Harness（DSH）桌面宠物。内置生图模型调用、Blender 3D 建模、
  音频与动作设计，先多轮询问用户想要哪些动作/音效并给出推荐，再自动完成
  生图 → 抠底 → 动画 → 合成精灵图集 → 生成音效 → 校验 → 注册进桌宠插件的全流程。
  Use this skill whenever 用户说「做一只桌宠 / 生成桌宠 / 我要个桌面宠物 / 养个宠物」、
  「把这个形象做成桌宠」「用这张图做宠物」「要个 3D 桌宠」「桌宠换成 XX」，
  或提到 dsh-pet-forge、桌宠生成、宠物包、spritesheet、桌宠动作/音效、
  要给 DSH 右下角加一只会跟着 Agent 状态动的角色——即使没说"技能"两个字也要用本技能。
  也用于管理已有桌宠：列出、卸载、改动作/音效、校验素材、排查桌宠显示乱码。
user-invocable: true
---

# dsh-pet-forge · 一句话造一只桌宠

把「一句话」变成 DSH 里一只真的会动、会叫、跟着 Agent 状态切换动作的桌面宠物。

**你（模型）的职责**：替用户把选择做少、把推荐给足，然后**一口气把流程跑完**，
而不是让用户自己去配参数、自己去找图片路径、自己算网格尺寸。

---

## 零、先跑一次环境自检（**每次都用这个开头**）

```powershell
node "$env:USERPROFILE\.agents\skills\dsh-pet-forge\scripts\forge.mjs" doctor
```

返回的 JSON 里看三件事：

| 字段 | 含义 | 不满足时怎么办 |
| --- | --- | --- |
| `checks.imageGen.ok` | 生图模型是否配好 | 引导用户跑 dsh-eye 的 `scripts\setup.ps1`，或设 `DASHEYE_GEN_API_KEY` |
| `checks.blender.ok` | 找到没找到 blender.exe | 只是 3D 路线需要；2D 路线不受影响 |
| `checks.plugin.ok` | 桌宠插件是否在线 | 需要 `dsh web` 在跑，且已装 `dsh-ronaldo-pet` 插件 |

`doctor` 会把 `routes` 直接告诉你：`image2d: ready` 表示可以走 2D；`image3d: headless-ready`
表示 3D 也能跑。**先看这两个值再决定问用户什么。**

---

## 一、多轮询问（**必须做，不要跳过**）

用户说「给我做只赛博朋克猫」时，**不要**立刻埋头生成。先拿到建议清单：

```powershell
node "$env:USERPROFILE\.agents\skills\dsh-pet-forge\scripts\forge.mjs" plan --brief "赛博朋克猫" --detail medium
```

`plan` 返回 `nextQuestions`：每题的题干、候选项、以及**已经标好"（推荐）"的默认值**。
然后用 `ask_user_question` **一批问完**（DSH 的提问工具支持多题并列），例如：

```
questions: [
  { id:"style",  header:"画风",   question:"想要什么画风的宠物？",
    options:[{label:"可爱卡通 chibi（推荐）"},{label:"像素风"},{label:"水墨/国风"},{label:"赛博朋克"}] },
  { id:"route",  header:"2D / 3D", question:"要 2D 还是 3D？",
    options:[{label:"2D 单图程序化（最快，推荐）"}, {label:"2D 多帧生图（动作最像）"}, {label:"3D Blender 建模（可环视 / 导出 GLB）"}] },
  { id:"actions",header:"动作",   question:"要哪几套动作？", multi_select:true, options:[...plan.actionCatalog 里 recommended=true 的放前面...] },
  { id:"audio",  header:"音效",   question:"要哪些音效？",   multi_select:true, options:[...plan.audioCatalog...] },
  { id:"tts",    header:"语音",   question:"要不要配一句完成时朗读的台词？",
    options:[{label:"要，用系统 TTS 合成（推荐）"},{label:"不要，只用音效"}] },
  { id:"size",   header:"大小",   question:"显示多大？",
    options:[{label:"中 120px（推荐）"},{label:"小 100px"},{label:"大 160px"}] },
]
```

### 询问规则（照做）

1. **每题都必须给推荐**，并把推荐项**放在第一个**、label 结尾加「（推荐）」。
2. **一次问完**。不要一问一答来回四五轮——那是在折磨用户。`ask_user_question` 一次能带多题。
3. **可以在提问前先给一段"我建议"**：一句话说清路线差别（快 / 像 / 真 3D），让用户能秒选。
4. **用户说"你决定"时**：走 `plan` 的 `recommended`，即
   - 动作：`idle + running + review + waiting + jumping + failed`（覆盖了 DSH 的全部宿主状态，
     这是**最有性价比**的一组；`waving`/`look` 属于锦上添花，`runLeft` 由 `runRight` 自动镜像、不用单独问）
   - 音效：`celebrate + failed + click`（完成、出错、点击三件套够用又不吵）
   - 路线：2D 单图程序化。3D 只在用户明确提"3D / 立体 / 能转"时才走。
5. **不要把技术参数丢给用户问**（列数、格宽、帧率、fps）。这些由契约固定为 8×11 · 192×208，
   用户不关心；`plan` 里也不该出现。只有用户主动说"我要自己画图集"时才暴露 `--cols/--rows/--cell`。

### 动作与音频的"建议话术"（可直接复述给用户）

- **动作**：`idle`（待机呼吸）是必选底线；`running`/`review`/`waiting` 对应 Agent
  「干活 / 思考 / 等你回复」三种状态，装了才"有灵性"；`jumping`（完成时跳）和 `failed`（出错时摔）
  是最出效果的两个情绪点。**推荐就这 6 个。**
- **音效**：`celebrate` 是"完成任务"的正反馈，强烈建议保留；`failed` 让报错不冷场；
  `click` 是点宠物的小反馈，成本极低。音效是**本机合成**的（纯 Node 生成 WAV），
  不额外调用任何 API，也不涉及版权。想更热闹再加 `dive`（连点三次）/`working`/`waiting`/`boot`。
- **语音（TTS）**：走 Windows SAPI 本机合成，给一句完成台词（如「喵！搞定啦」）。
  默认建议**要**，因为它让宠物"会说话"，而成本是零。

---

## 二、三条路线

| 路线 | 命令 | 成本 | 什么时候用 |
| --- | --- | --- | --- |
| **A · 2D 单图程序化** | `generate --tier A` | 1 次生图 | **默认**。最稳、最快、可复现 |
| **B · 2D 多帧生图** | `generate --tier B` | 每动作再 1 次生图 | 用户嫌动作"不够像"时；姿态更自然 |
| **C · 3D Blender** | `blender-plan` → 渲染 → `blender-assemble` | 1 次生图（取色）+ Blender 渲染 | 用户明确要 3D / 要能转视角 / 要 GLB |

三条路的产物**是同一套宠物包**（`pet.json` + `atlas.png` + `audio/`），
所以装进 DSH 之后的表现完全一致，用户后续也能随时换路线重做。

---

## 三、路线 A/B：一句话生成

```powershell
node "$env:USERPROFILE\.agents\skills\dsh-pet-forge\scripts\forge.mjs" generate `
  --pkg "D:\代码\桌宠\pets\cyber-cat" `
  --brief "赛博朋克风格的机械猫，霓虹蓝配色，大眼睛" `
  --name "赛博猫" `
  --style "可爱 chibi / 卡通吉祥物风格，粗描边，扁平上色" `
  --tier A `
  --actions idle,running,review,waiting,jumping,failed `
  --audio "sfx:celebrate,sfx:failed,sfx:click,tts:celebrate:喵！搞定啦" `
  --size 120
```

- `--pkg` 是宠物包目录（**建议放在当前工作区的 `pets/<名字>/` 下**，方便用户自己找得到）。
  不给 `--pkg` 时默认落到 `<当前目录>/pets/<slug>`。
- `--tier B` 会为 `--actions` 里除 `idle`/`look` 之外的每个动作**再调一次生图**拿 4 帧条带；
  条带排版不可靠时脚本会自动**退回程序化版本**并在 `warnings` 里说明，不会产出坏素材。
- 有现成图片时用 `build` 代替 `generate`：
  ```powershell
  node ...\forge.mjs build --pkg <目录> --image "D:\pics\my-cat.png" --actions idle,running,jumping
  ```

### 命令返回什么

JSON，重点看四个字段：
- `ok` —— 整个流程 + 校验是否通过
- `steps` —— 每一步做了什么（生图 / 抠底 / 渲染 / 合成 / 音频 / 清单），用于向用户汇报
- `warnings` —— **必须读**。例如"背景未能自动抠除""某动作条带靠边已退回程序化"
- `validation.errors` —— 非空就是失败，按提示改参数重跑

### 生成后**一定**要做目视确认

```powershell
node ...\forge.mjs inspect --pkg <目录> --rows 0,1,4,5     # 出放大检查图
node "$env:USERPROFILE\.agents\skills\dsh-eye\scripts\vision.mjs" "<目录>\inspect-sheet.png" "逐行检查：每格角色是否完整、有没有被裁切/串帧/白边" --mode ask
```

`inspect-sheet.png` 是**带棋盘底**的放大图，一眼能看出透明区域干不干净。
当前模型不能原生看图时，**必须**用 dsh-eye 的 `vision.mjs` 代看，然后如实把结论告诉用户。

---

## 四、路线 C：Blender 3D 建模

分三步，因为 Blender 有两种执行方式：

### 1) 生成脚本

```powershell
node ...\forge.mjs blender-plan --pkg <目录> --yaw 8
```

产物：
- `<包>/model/spec.json` —— 建模规格
- `<包>/model/build.py` —— 程序化建模 + 渲染脚本（低多边形 chibi：身体/头/耳朵/眼睛/手脚/尾巴，
  颜色取自 2D 主图提取的调色板，保证 3D 与 2D 观感一致）

返回里的 `howToRun` 给出两条执行方式。

### 2) 执行渲染（二选一）

**A. Blender MCP（用户在用 Blender 时优先）**

先探一下 MCP 通不通（随便调一个只读工具，例如 `mcp__blender__get_blendfile_summary_path_info`）。
通了就执行：

```
mcp__blender__execute_blender_code
code: exec(open(r"<包>\model\build.py", encoding="utf-8").read())
```

脚本会自己清场、建模、渲染全部帧到 `model/renders/`，并导出 `model/pet.glb`，
最后打印一行 `PET_FORGE_RENDER_DONE {...}` 作为成功标志。

**B. 无头执行（用户没开 Blender 时）**

```powershell
node ...\forge.mjs blender-run --pkg <目录>
```

> 沙箱可能拒绝执行 `blender.exe`，报 `Access is denied`。这时：
> **用同一条命令加 `sandbox_permissions: danger-full-access` 重试一次**（需要用户点同意），
> 或改走 MCP。

### 3) 装配

```powershell
node ...\forge.mjs blender-assemble --pkg <目录>
```

把 `model/renders/*.png` 装配成图集、写 `pet.json`、生成预览页。
渲染出来的**环视帧**会变成 `states.look.angles`——客户端会按鼠标角度切格，
于是桌宠会**真的转头看你**，这是 3D 路线独有的效果。

如果 `blender-assemble` 返回的 `missing` 里有动作，说明那一步渲染失败，看
`stdout`/`stderr`（或 MCP 报错），修好后重跑 `blender-run` 再装配。

---

## 五、音频与动作的后续调整（不用重做宠物）

```powershell
# 看有哪些内置音效可选 / 系统装了哪些 TTS 语音
node ...\forge.mjs audio --list

# 给已存在的宠物加音效（会合并进 pet.json，不覆盖原有的）
node ...\forge.mjs audio --pkg <目录> --sfx celebrate,failed,working
node ...\forge.mjs audio --pkg <目录> --add "tts:celebrate:任务完成，休息一下"
node ...\forge.mjs audio --pkg <目录> --add "file:click:D:\sounds\pop.mp3"   # 用户自己的音频

# 整包替换（丢掉原有音效）
node ...\forge.mjs audio --pkg <目录> --sfx celebrate,click --replace
```

音频条目语法：

| 语法 | 含义 |
| --- | --- |
| `sfx:<key>` | 本机合成音效，`key` 见 `AUDIO_CATALOG`（7 种） |
| `tts:<key>:<台词>` | 用系统 TTS 合成台词（Windows） |
| `file:<key>:<绝对路径>` | 复制用户自己的 wav/mp3/ogg |

事件映射（写进 `pet.json` 的 `triggers` / `interactions`）：
`celebrating→celebrate`（完成）、`failed→failed`（出错）、`waiting→waiting`（等回复）、
`working→working`；`click→click`（点击）、`tripleClick→dive`（连点三次）、`boot→boot`（登场）。

---

## 六、装进 DSH（**收尾必做**）

```powershell
node ...\forge.mjs install --pkg <目录>
```

它会先**再校验一遍**宠物包，不合格直接拒绝（`ok:false` + `errors`），合格才 POST 到
运行中的插件。注册后：

- 桌宠**立刻出现在界面右下角**（客户端每 500ms 轮询宿主 revision，变了就自动拉取），
  **不需要刷新页面**；桌面上的**原生窗口也会跟着切**；
- **同一时间只开一只**：新注册的宠物会自动接管 ⭐「默认打开的桌宠」，其它自动收起。
  这是刻意的——不然生成几次之后右下角就站了一排。用户随时可以点别的宠物的
  「⭐ 设为默认」切换，或点「👁 显示中」同时养多只（手动打开过的会被记住，
  之后切换默认不会再被自动收起）；
- 设置 → ⚽ 桌宠 里可以改默认宠物、名字、大小、平时行为、系统音、显示/隐藏、复位、移除。

只想注册不上场（不抢默认位）：

```powershell
node ...\forge.mjs install --pkg <目录> --no-focus
```

其它管理命令：

```powershell
node ...\forge.mjs list                        # 列出已注册宠物
node ...\forge.mjs uninstall --id <id>         # 卸载（只取消注册，不删文件）
node ...\forge.mjs play --id <id> --key celebrate   # 让宿主试播某个音效（验证"到底出没出声"）
node ...\forge.mjs verify --pkg <目录>          # 严格校验（含逐格空帧/杂色/未用行检查）
node ...\forge.mjs preview --pkg <目录>         # 生成独立预览页，双击即可看动画听音效
```

**给用户交付时，把这三样告诉他**：装好了（看右下角或桌面）、宠物包目录、
以及"想换回原来那只就点设置里的「⭐ 设为默认」"。

> ⚠️ 插件的 Host/Client 代码改了之后需要**重启 `dsh web`** 才生效（注册表数据不用重启）。
> 装新宠物**不需要**重启。

> ⚠️ 插件的 Host/Client 代码改了之后需要**重启 `dsh web`** 才生效（注册表数据不用重启）。
> 装新宠物**不需要**重启。

---

## 七、原生桌面窗口（Windows）

> 用户说「桌宠只在网页里」「关了网页就没了」「要显示在电脑桌面上」「桌面宠物」时，
> 说的是这个功能——**它属于插件本身，不需要生成新宠物**。先检查有没有开。

宿主半自带一个独立的 WPF 窗口进程：无边框、透明、置顶，**不依赖浏览器**。
终端一起来就自动拉起，终端一停就自己退出。

```powershell
# 查状态
node ...\forge.mjs doctor        # 看 routes / plugin
# 或直接问宿主
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3080/ronaldo-pet/desktop `
  -ContentType application/json -Body '{"action":"status"}'
```

| 用户诉求 | 处理 |
| --- | --- |
| 「没看到桌面宠物」 | 先 `status`。`running:false` → `{"action":"start"}`；`supported:false` → 非 Windows，如实告知只有 Windows 版 |
| 「关了网页桌宠就没了」 | 说明：原生窗口要**插件 Host 半**是 v2 才有；旧版需要 `dsh plugin --profile web add <本地路径>` 再**重启 `dsh web`** |
| 「它挡住我点别的东西」 | 不用改：透明像素处鼠标会穿透（按 alpha 动态切 `WS_EX_TRANSPARENT`）；真觉得烦可以关掉（见下） |
| 「拖起来卡」 | 让用户带 `-SlowTickMs 25` 重启桌面窗口，日志里会打出哪一类 tick 超时；常见元凶是工具提示 Popup 在拖动期间反复开关 |
| 「不要桌面上的那个，只要网页里的」 | `{"action":"enable","enabled":false}`，或在插件 config 里 `desktopPet: false` |

**验证它真的画出来了**（日志说"已加载"不等于屏幕上有东西）：

```powershell
node <包目录>\scripts\verify-desktop.mjs --base http://127.0.0.1:3080
```

它用 `PrintWindow` 抓窗口自身内容并统计高饱和像素占比。
⚠️ **不要用整屏截图判断**：`CopyFromScreen`（BitBlt）看不到分层窗口，
实测会误报"桌宠没显示"。

排查顺序：`verify-desktop` → 桌面窗口日志 `%DSH_HOME%\storages\dsh-pet-forge\desktop-pet.log`
（找 `atlas load failed` / `atlas decoded to 1x1` / `SLOW`）→ `desktop/README.md` 的排障表。

**新增宠物后桌面窗口会自动切过去**（它每 4 秒拉一次宠物列表，默认显示最近安装的非内置宠物）。
要让某只固定显示：右键菜单里选，或用 `-PetId <id>` 启动。

---

## 八、为什么这个流程不会出现"图片乱码"

这是本技能最花心思的地方。**四道闸**：

1. **不经过任何文本管道传二进制。**
   图片全程走 Node `Buffer` 读写磁盘，或由插件 HTTP 路由**直出字节**。
   绝不把图片塞进 JSON / base64 / PowerShell 字符串 / 命令行参数——
   那些路径会因为编码（GBK↔UTF-8）和控制台代码页把字节改坏，且中文路径首当其冲。

2. **自研 PNG 编解码器，输出确定。**
   `scripts/lib/png.mjs` 是纯 Node 实现（只用内置 `zlib`），不依赖任何原生模块。
   同样的像素永远产出同样的字节，不受 sharp/libvips 版本或平台二进制是否存在影响。
   sharp 只用于"读 jpg/webp 输入"这一个可选场景。

3. **两趟渲染 + 严格落格。**
   先把所有动作在放大画布上跑一遍，量出**全体帧的并集包围盒**，再算统一的缩放与落位，
   最后把每一帧映射进严格 `192×208` 的格子。
   这样"跳跃抬太高被切掉头""摔倒转太狠伸出格子"这类问题在**算法层面**就不可能发生。
   `inspect.mjs` 会把每格边缘的非透明像素数报出来（`edge-bleed`），`verify` 也会查。

4. **注册即校验。**
   插件在 `/ronaldo-pet/pets/register` 里重新读图集文件头，
   要求 `宽 === 列数×格宽 && 高 === 行数×格高`，并要求状态行号在范围内、必须有 `idle`。
   不合格的包返回 422 并说明原因，**坏素材根本进不了界面**。

另外两个容易被忽略但很要命的细节，也已经处理：

- **透明边缘去白边（despill）**：抠底后半透明边缘会残留背景色，看起来像一圈脏描边。
  `removeBackground` 会对 alpha∈(0,255) 的像素做反预乘，把背景色成分减掉。
- **抠底保护角色内部**：用连通域泛洪而不是全局色键，
  所以白色眼白、白肚皮不会被一起抠掉（除非显式用 `--bg-mode global`）。

---

## 九、常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `未配置生图 API Key` | 没配 dsh-eye | 跑 dsh-eye 的 `scripts\setup.ps1`，或设 `DASHEYE_GEN_API_KEY` |
| `生成的图片格式无法识别` | 端点返回了非图片内容 | 换 `--gen-size 1024x1024`，或检查 base-url/model |
| `图集尺寸与网格不符` | 图片被当 spritesheet 用了 | 那是 `import-image` 的场景；生成流程不会走到这里 |
| 宠物有一块底色 | 生图给了渐变/场景背景 | 提示词里已强制纯白背景；仍不行就 `--bg-tolerance 60` 或 `--bg-mode global` |
| `背景不纯，已跳过抠底` | 边框颜色标准差过大 | 重新生图（更强调纯白背景），或用户提供已抠好的 PNG |
| 抠底后画面几乎为空 | 容差太大把角色也抠了 | `--bg-tolerance 20`，或 `--bg-mode none` 保留原图 |
| `blender.exe` Access denied | 沙箱拒绝 | 同一命令加 `sandbox_permissions: danger-full-access` 重试；或走 MCP |
| 3D 渲染出来是一堆全透明图 | **EEVEE 在无头模式下没有 GPU 上下文**，只出前两帧就静默产空图 | 脚本已自动改：无头一律走 Cycles，并会先渲染一帧预检、发现空图就切换引擎。`blender-run` 会报 `emptyFrames`，非 0 就是没真出图 |
| 3D 跳跃/摔倒被裁掉头或腿 | Blender 直接按格渲染，姿势会顶出画面 | 装配时会用"全体帧并集包围盒 + 统一缩放"重新落位（和 2D 同一套算法），保证不裁切 |
| MCP 连不上 Blender | 没开 Blender 或没 Start Server | 让用户在 Blender 里开 MCP 插件的 server，或改走 `blender-run` |
| 装完没看到宠物 | 插件 Host 半还是旧的 | **重启 `dsh web`**；然后 `list` 确认注册成功 |
| 有动作没声音 | 宿主 shell 服务不可用 | `play --id <id> --key celebrate` 验证；确认没在设置里关"系统音" |
| 预览页没声音 | 浏览器要求先有一次用户交互 | 先点一下页面再点音效按钮 |

---

## 十、给用户的"一句话"到底能说多短

以下每句话都应该能触发本技能并把流程跑完：

- 「给我做一只赛博朋克猫」
- 「把 D:\pics\my-dog.png 做成桌宠」
- 「我要个 3D 的龙，能转头看我那种」
- 「桌宠换成一只像素风史莱姆，要会叫」
- 「我现在的桌宠有点吵，把音效去掉」
- 「桌宠只在网页里有，我要它显示在电脑桌面上」（→ 见第七节，属于插件功能而非生成流程）
- 「拖动桌宠有点卡」（→ 见第七节，带 `-SlowTickMs` 重启并把日志给我）

**判断顺序**：先 `doctor` → 再 `plan` 出建议 → 用 `ask_user_question` 一次问完 →
按选择 `generate` / `build` / `blender-*` → `inspect` 目视确认 → `install` → 汇报。

参考文档（按需读，不要一开始全读）：
- `references/actions.md` —— 每个动作的语义、DSH 宿主状态如何触发、怎么加新动作
- `references/audio.md` —— 音效设计细节、TTS 支持的语言/语音选择、自定义音频
- `references/prompts.md` —— 生图提示词工程（怎么写才抠得干净、动作才像）
- `references/troubleshooting.md` —— 更细的排障树与调试命令
- `references/pet-package.md` —— 宠物包格式（`pet.json` 全字段）与图集契约
