# 动作设计参考

## 一、动作与 DSH 宿主状态的对应关系

宿主半（`host.js`）把 Agent 的运行情况归纳成 6 个 `mode`，客户端再映射到图集的行：

| 宿主 mode | 触发时机 | 动画状态 | 图集行 | 默认帧数 / fps |
| --- | --- | --- | ---: | --- |
| `idle` | 没有任何 Agent 在跑 | `idle` | 0 | 6 / 6 |
| `working` | 正在执行工具（`tools/execute` 在飞） | `running` | 7 | 6 / 12 |
| `review` | Agent 在跑但没在调工具（在思考/写回答） | `review` | 8 | 6 / 6 |
| `waiting` | 有 `approval/request` 或有 `ask_user_question` 在等 | `waiting` | 6 | 6 / 5 |
| `failed` | `agent/request-error` | `failed` | 5 | 8 / 12 |
| `celebrating` | 某 Agent 从 running 变 idle，且全局无 running、无等待、本轮没出错 | `jumping` | 4 | 5 / 10 |

另外这些状态**不由宿主触发**，而是**本地交互**：

| 交互 | 动画状态 | 图集行 |
| --- | --- | --- |
| 拖动宠物 | `runRight` / `runLeft`（按水平位移方向） | 1 / 2 |
| 鼠标悬停在宠物上 | `look` | 9 + 10（16 方向） |
| 1.5 秒内连点 3 次 | `failed` + 气泡 + `tripleClick` 音效 | 5 |
| 单击 | 气泡短语 + `click` 音效 | — |
| 双击 | 位置复位回右下角 | — |
| 没被上面任何一条命中 | 用户在设置里选的「平时行为」 | 任意 |

## 二、契约（不可随意改的部分）

| 项 | 值 |
| --- | --- |
| 网格 | 8 列 × 11 行 |
| 单格 | **不限分辨率**（内置素材 192 × 208 px） |
| 图集 | `列数 × 单格宽` × `行数 × 单格高`（内置素材 1536 × 2288 px） |
| 格式 | PNG（RGBA，8bit，非隔行） |
| 背景 | 全透明 |
| 未使用格 | **必须全透明** |
| 取帧 | CSS `background-position`，`background-size: 800% 1100%` |

> 行号就是状态，**不能压缩行数**。9 行图集没有 `look`（第 9/10 行），
> 客户端会自动降级成 idle 首帧，不会崩。

## 三、什么时候用哪个动作（给用户的建议口径）

| 动作 | 值得装吗 | 理由 |
| --- | --- | --- |
| `idle` | **必装** | 没有它就没有兜底动画 |
| `running` | **强烈建议** | Agent 干活时最长的时间段都在这个状态，"有灵性"主要靠它 |
| `review` | **强烈建议** | Agent 思考时也不会呆站着 |
| `waiting` | **强烈建议** | 需要用户审批/回答时，动作本身就是一个提示 |
| `jumping` | **建议** | 完成任务的正反馈，配合 `celebrate` 音效效果最好 |
| `failed` | **建议** | 出错时不冷场；同时兼任"连点三次"的彩蛋 |
| `runRight` / `runLeft` | 可选 | 只影响拖动时的手感；`runLeft` 默认由 `runRight` 水平镜像生成，**不用单独渲染** |
| `waving` | 可选 | 目前宿主不会自动触发，只在用户把「平时行为」设成挥手时才看得到 |
| `look` | 可选 | 悬停看光标，很讨喜；3D 路线下会变成"转头看你"，效果最强 |

**默认推荐组合（6 个）**：`idle, running, review, waiting, jumping, failed`。

## 四、程序化动画是怎么做出来的（Tier A）

`scripts/lib/anim.mjs` 里每个动作是一个 `params(i, n)` 函数，返回这一帧的变形参数：

```js
// 例：jumping —— 抛物线腾空 + 落地挤压
params: (i, n) => {
  const t = i / (n - 1)
  const up = Math.sin(Math.PI * t)
  const landing = t > 0.75 ? (t - 0.75) / 0.25 : 0
  return {
    dy: -22 * up,                              // 向上位移
    scaleY: 1 + 0.10 * up - 0.14 * landing,    // 腾空拉伸、落地压扁
    scaleX: 1 - 0.06 * up + 0.12 * landing,
    rotate: Math.sin(TAU * t) * 5,
  }
}
```

可用参数：

| 参数 | 含义 |
| --- | --- |
| `dx` / `dy` | 平移（工作画布像素） |
| `scaleX` / `scaleY` | 缩放（挤压拉伸） |
| `rotate` | 旋转（度），绕 `anchorX/anchorY` |
| `flipX` | 水平镜像 |
| `opacity` | 整体透明度 |
| `banded` + `splitY` + `upper` / `lower` | **分带变形**：上下半身用不同参数，接缝羽化混合 |
| `anchorX` / `anchorY` | 旋转/缩放的中心；默认是格子底边中点（脚底） |

**分带变形**是让跑步、挥手、思考看起来"有骨架"的关键：例如 `runRight` 让下半身
反相摆动、上半身前倾，比整身刚性位移自然得多。

## 五、加一个新动作

1. 在 `scripts/lib/anim.mjs` 的 `ACTION_LIBRARY` 里加一项，写好 `frames` / `fps` / `params`。
2. 如果它要占新的一行，同时更新三个地方（**必须一致**）：
   - `anim.mjs` 的 `ACTION_TO_ROW`
   - `manifest.mjs` 的 `STATE_ROWS` / `STATE_META`
   - `dsh-ronaldo-pet/docs/SPRITESHEET-CONTRACT.md`
3. 如果它要由新的宿主事件触发，在 `host.js` 的 `HOST_ANIM` 与客户端 `HOST_ANIM` 里加映射。
4. 跑 `node scripts/selftest.mjs`——它会遍历 `ACTION_LIBRARY` 自动覆盖新动作。

## 六、帧数与 fps 的取舍

- **帧数**：`cols` 是 8，所以一个动作最多 8 帧。少于 8 帧时后面几格留空即可
  （`states.<name>.frames` 决定播放几帧）。程序化动画里 6 帧已经足够顺滑。
- **fps**：宿主状态类动作建议 ≥ 6，奔跑/摔倒这类需要"快"的用 10–12；
  `waiting` 用 5 显得沉稳；`idle` 用 6 是呼吸的舒适区。
- 帧数 × (1/fps) 要能整除循环，否则会有"顿一下"的感觉。程序化动画用 `sin(2πt)` 天然无缝。
