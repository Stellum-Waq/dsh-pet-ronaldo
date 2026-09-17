# 🐾 宠物社区 · 官方索引

这个目录只有一个作用：**让别人的桌宠能被插件找到**。

插件读取 `index.json`（本仓库的 raw 地址 + 包内内置副本，离线也能用），
并按 [`docs/GALLERY-CONTRACT.md`](../docs/GALLERY-CONTRACT.md) 的规则展示、下载、一键安装。

---

## 想把你的桌宠放进来？两条路

### 路线 1（推荐，零 PR）：打标签就行

1. 把你的宠物包推到一个**公开** GitHub 仓库；
2. 仓库根目录放 `pet.json`，写入 `sharing` 块（模板见
   [`docs/PET-SHARING-AGREEMENT.md` 附录 A](../docs/PET-SHARING-AGREEMENT.md)）：
   ```json
   "sharing": {
     "protocol": "DPSL-1.0",
     "shared": true,
     "author": "你的昵称",
     "repo": "https://github.com/你/你的仓库",
     "statement": "本桌宠包由我本人创作，或我已获得其全部素材的分发授权；我同意按 DPSL-1.0 收录进 DSH 桌宠社区。"
   }
   ```
3. 给仓库加上 topic **`dsh-pet`**（About → ⚙️ → Topics）。

插件下一次刷新索引时就会自动发现它，并给出「一键安装」按钮。
不想被收录时：把 `shared` 改成 `false`，或删掉 topic，最长 24 小时内消失。

> 用 `dsh-pet-forge` 技能生成宠物时，插件会问你一次「是否愿意共享到宠物社区」。
> 选「愿意」后跑 `node forge.mjs share --pkg <目录> --repo <你的仓库地址> --author <昵称>`，
> 它会自动写好 `sharing` 块、协议副本、README 与推送脚本。

### 路线 2：提 PR 加一行

即使仓库里没有 `pet.json`（或者形态完全不同、只是"DSH 宠物生态里的一个项目"），
也可以把条目加进 `index.json` 的 `entries` 数组。这类条目在界面上会显示为
**「仅收录」**：给仓库链接和下载通道，但不提供一键安装。

字段说明见 [`docs/GALLERY-CONTRACT.md` §4](../docs/GALLERY-CONTRACT.md)。
加之前请确认：

- [ ] JSON 合法（`node -e "JSON.parse(require('fs').readFileSync('gallery/index.json','utf8'))"`）
- [ ] `key` 是 `owner/repo`（小写），且没有重复项
- [ ] 仓库公开可访问，`repo` 指向真实地址
- [ ] **没有**替别人声称 DPSL 授权：只有作者本人才可以写 `protocol: "DPSL-1.0"`
- [ ] 同人/二创素材在 `note` 里写清楚权利人状况

---

## 维护者的两件事

**下架请求**：收到侵权或撤回请求时，把该条目的 `revoked` 设为 `true`（永久黑名单，插件不再展示），
并在 commit message 里记录 request 链接。协议承诺的时限是 **7 日内**。

**索引过期**：`updatedAt` 只是标记；插件真正依赖的是各仓库自己的 `pet.json`，
所以历史条目不会因为索引不更新而失效。

---

## 这个索引**不做**什么

- 不托管任何素材（预览图与宠物包都在作者自己的仓库里）；
- 不代替作者上传（插件没有你的凭据）；
- 不为第三方内容做合法性担保（见协议第 8 条）。
