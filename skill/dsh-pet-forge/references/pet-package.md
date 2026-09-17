# 宠物包格式（`pet.json`）

一个宠物包就是**一个自描述目录**。插件只认识 `pet.json`，其它素材路径全部相对包目录。

```
pets/cyber-cat/
├── pet.json              # 清单（唯一入口）
├── atlas.png             # 精灵图集（严格 1536×2288）
├── audio/                # 每只宠物独立的音频
│   ├── celebrate.wav
│   ├── failed.wav
│   └── click.wav
├── source/               # 可复现素材（诊断用，不参与渲染）
│   ├── prompt.txt
│   ├── generated.jpeg
│   ├── base.png
│   ├── cutout.png
│   └── frames/           # Tier B 的动作条带
├── model/                # 3D 路线产物
│   ├── spec.json
│   ├── build.py          # 生成的 Blender 脚本
│   ├── renders/          # 逐帧渲染 PNG
│   ├── pet.glb           # 真 3D 模型
│   └── render-report.json
├── preview.html          # 独立预览页（双击即看动画听音效）
├── inspect-sheet.png     # 目视检查图
└── forge-report.json     # 生成过程报告（steps / warnings）
```

---

## `pet.json` 全字段

```jsonc
{
  "schema": "dsh-pet/2",           // 必须
  "id": "cyber-cat",               // 必须，全局唯一（注册表的键）
  "name": "赛博猫",                 // 显示名
  "createdAt": "2026-09-17T…",
  "generator": { "skill": "dsh-pet-forge", "version": "1.0.0" },

  "source": {                       // 溯源信息，纯记录
    "kind": "image",                // image | blender | codex
    "prompt": "赛博朋克风格的机械猫…",
    "tier": "A",                    // A | A+B | 3D
    "model": "cogview-3-flash"
  },

  "atlas": {                        // 必须
    "file": "atlas.png",            //   相对包目录
    "desktopFile": "atlas.png",     //   可选：给原生窗口用的 PNG（WPF 解不了 WebP）
    "cols": 8, "rows": 11,
    "cellW": 192, "cellH": 208,     //   分辨率不限：1024x1152 之类都可以，显示时等比缩放
    "scaling": "smooth"             //   可选：smooth（高分辨率/写实，默认）| pixelated（像素风硬边）
  },

  "states": {                       // 必须，至少要有 idle
    "idle":     { "row": 0, "frames": 6, "fps": 6 },
    "runRight": { "row": 1, "frames": 6, "fps": 12 },
    "runLeft":  { "row": 2, "frames": 6, "fps": 12 },
    "waving":   { "row": 3, "frames": 6, "fps": 8 },
    "jumping":  { "row": 4, "frames": 6, "fps": 10 },
    "failed":   { "row": 5, "frames": 6, "fps": 12 },
    "waiting":  { "row": 6, "frames": 6, "fps": 5 },
    "running":  { "row": 7, "frames": 6, "fps": 12 },
    "review":   { "row": 8, "frames": 6, "fps": 6 },

    // 2D 16 方向视线：两行 × 8 列
    // "look": { "rows": [9, 10], "frames": 8 },

    // 3D 环视：每个角度一个格子
    // "look": { "angles": [{"row":9,"col":0}, …], "frames": 1, "fps": 1 }
  },

  "behavior": "idle",               // 没有宿主状态时的"平时行为"
  "size": 120,                      // 网页端默认像素尺寸
  "yaw": null,                      // 3D 才有：{ "count": 8, "rowsPerYaw": 1, "kind": "rows" }

  "audio": {                        // 每只宠物独立
    "celebrate": { "file": "audio/celebrate.wav", "label": "完成庆祝", "kind": "sfx" },
    "click":     { "file": "audio/click.wav",     "label": "点击",     "kind": "sfx" }
  },

  "triggers": {                     // 宿主事件 → 音效 key
    "celebrating": "celebrate",     //   对话完成
    "failed": "failed",             //   出错
    "waiting": "waiting",           //   等待审批
    "working": "working"            //   开始干活
  },

  "interactions": {                 // 浏览器内交互 → 音效 key
    "click": "click",               //   单击
    "tripleClick": "dive",          //   连点三次
    "boot": "boot"                  //   登场（每个页面生命周期一次）
  },

  "phrases": ["喵！", "需要我做什么？"],      // 单击气泡
  "divePhrases": ["别戳我啦！"],              // 连点三次气泡
  "tags": ["cyber", "cat"]
}
```

---

## 校验规则（**注册即校验**，不合格直接 422 拒绝）

`forge.mjs verify` 与插件的 `/ronaldo-pet/pets/register` 用的是同一套规则：

| 检查 | 不合格的后果 |
| --- | --- |
| `atlas.file` 存在，且是 PNG/WebP（读文件头判断，不看扩展名） | 拒绝 —— 文件头不匹配通常意味着编码被破坏 |
| **`图集宽 === cols×cellW` 且 `高 === rows×cellH`** | 拒绝 —— 尺寸不符会导致取帧错位（画面看起来就是乱码） |
| 每个 state 的行号在 `0..rows-1` 内 | 拒绝 |
| 每个 state 的 `frames` 在 `1..cols` 内 | 拒绝 |
| `states.idle` 存在 | 拒绝 —— 必须有兜底动画 |
| 音频文件存在 + 头部像 WAV/MP3/OGG | 缺失只警告（该音效自动禁用），头部不对则拒绝 |
| 所有相对路径不越出包目录 | 拒绝 —— 目录穿越防护 |
| `yaw.count × yaw.rowsPerYaw ≤ rows` | 拒绝 |

`verify` 还会额外做**逐格深度检查**：

- `emptyCells`：全透明的格子数（未使用的行属于正常）
- `suspiciousCells`：颜色数 < 3 的格子（可能是纯色块/坏帧）
- `unusedRowsWithContent`：**没有被 states 引用的行却有非透明像素** → 浪费体积，给出警告

---

## 图集契约（不可随意改）

| 项 | 值 |
| --- | --- |
| 网格 | 8 列 × 11 行 |
| 单格 | **不限分辨率**（内置素材 192 × 208 px） |
| 图集 | `列数 × 单格宽` × `行数 × 单格高`，内置素材 1536 × 2288 px |
| 格式 | PNG（RGBA，8bit，非隔行） |
| 背景 | 全透明 |
| 未使用格 | **必须全透明** |
| 取帧 | CSS `background-position`，`background-size: 800% 1100%` |

> 行号就是状态，**不能压缩行数**。9 行图集没有 `look`；客户端会自动降级成 idle 首帧，不会崩。

### 分辨率与缩放

单格分辨率不限，但图集实际尺寸必须**严格**等于 `列数×单格宽` × `行数×单格高`，
否则取帧错位（看起来像乱码）。契约里唯一不可协商的就是这一条。

两条约定：

1. **按 2× 创作**：显示宽度 = `单格宽 ÷ 2`。192px 一格 → 96 DIP，1024px 一格 → 512 DIP。
   这就是"自动尺寸"的依据，所以写实素材不会一上来被缩成看不清的小图。
   `forge.mjs generate --cell 1024x1152` 可以直接生成这个量级的素材。
2. **声明 `scaling`**：`smooth`（默认，适合高分辨率/写实/带抗锯齿边缘）或
   `pixelated`（像素风、硬边，不要插值糊掉）。命令行是 `--scaling pixelated`。

上限（防呆，不是创作限制）：单格 ≤ 4096px，图集总像素 ≤ 6400 万。
超了会在注册时被明确拒绝并说明原因。

---

## 手动做一个宠物包（不用技能）

最小可用形态：只要 `pet.json` + `atlas.png` 两个文件。

```jsonc
{
  "schema": "dsh-pet/2",
  "id": "my-pet",
  "name": "我的宠物",
  "atlas": { "file": "atlas.png", "cols": 8, "rows": 11, "cellW": 192, "cellH": 208 },
  "states": { "idle": { "row": 0, "frames": 6, "fps": 6 } }
}
```

把 `cellW`/`cellH` 换成任意分辨率都行（例如 `1024`/`1152`，图集就变成 8192×12672，
这已经接近 6400 万像素的上限，格数少一点才放得下）。

然后：

```powershell
node ...\forge.mjs verify  --pkg <目录>    # 先校验
node ...\forge.mjs install --pkg <目录>    # 再注册
```

`install` 会**再校验一次**，不合格绝不放行——坏素材进不了界面。
