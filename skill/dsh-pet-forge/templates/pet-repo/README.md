# {{name}} · DSH 桌宠

> 按 [DSH 桌宠开放共享协议 **DPSL-1.0**]({{agreementUrl}}) 收录进 **DSH 桌宠社区（宠物社区 / 画廊）**。
> 作者：**{{author}}** · 宠物 id：`{{id}}`

![预览]({{preview}})

---

## 这是什么

一只跑在 [DeepSeek Harness](https://github.com/Stellum-Waq/dsh-pet-ronaldo) 里的桌宠：
网页右下角与原生桌面窗口都会显示，并跟随 Agent 状态切换动作
（专注工作 / 思考 / 等待审批 / 出错摔倒 / 对话完成庆祝）。

本仓库是一个**自描述的宠物包**：插件读取根目录的 `pet.json`，按清单契约加载图集与音效。

## 安装

```bash
# 插件本身（已装过就跳过）
dsh plugin --profile web add github:Stellum-Waq/dsh-pet-ronaldo

# 本宠物：在插件里打开「设置 → ⚽ 桌宠 → 🌐 宠物社区」，找到「{{name}}」点「一键安装」
```

也可以让技能直接装：

```powershell
node "$env:USERPROFILE\.agents\skills\dsh-pet-forge\scripts\forge.mjs" install --pkg .
```

## 素材契约

| 项 | 值 |
| --- | --- |
| 图集文件 | `{{atlasFile}}` |
| 网格 | {{cols}} 列 × {{rows}} 行 |
| 单格 | {{cellW}} × {{cellH}} px |
| 总尺寸 | {{cols}}×{{cellW}} × {{rows}}×{{cellH}} = 图集必须严格等于这个尺寸 |

行号约定见 [SPRITESHEET-CONTRACT](https://github.com/Stellum-Waq/dsh-pet-ronaldo/blob/master/docs/SPRITESHEET-CONTRACT.md)。
**尺寸与网格不符会导致取帧错位**，插件注册时会直接拒绝（这是有意的防呆）。

## 授权与署名（重要）

{{statement}}

- 采用的协议：[DPSL-1.0]({{agreementUrl}})（全文副本见 [`DSH-PET-LICENSE.md`](DSH-PET-LICENSE.md)）
- 允许二创：{{allowRemix}} · 允许商用：{{allowCommercial}}
- 素材权利说明：{{rights}}
- 撤回方式：把 `pet.json` 里 `sharing.shared` 改为 `false`，或删掉 `dsh-pet` 标签（协议第 9 条）

## 标签

{{tagList}}

---

*本仓库由 `dsh-pet-forge` 的 `share` 命令生成分享包骨架，作者可随意修改本文件。*
