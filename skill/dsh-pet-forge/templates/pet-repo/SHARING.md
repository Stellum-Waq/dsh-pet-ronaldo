# 把这个桌宠收录进 DSH 桌宠社区

本仓库已按 **DPSL-1.0** 声明授权（见 `pet.json` 的 `sharing` 块与 `DSH-PET-LICENSE.md`）。

## 收录怎么发生

插件不去猜、也不去爬你的电脑 —— 它按下面两条路找到你：

1. **自动发现**：仓库是**公开**的，且打了 topic **`{{topic}}`** → 插件检索到后读取本仓库根目录的 `pet.json`，
   校验通过即给出「一键安装」。
2. **官方索引**（可选）：把下面这一项加进
   [gallery/index.json](https://github.com/Stellum-Waq/dsh-pet-ronaldo/blob/master/gallery/index.json)（提 PR）。

```json
{{indexEntryJson}}
```

## 一键安装时插件会做什么（以及不会做什么）

**会**：下载本仓库的 tarball → 解包到 `storages/dsh-pet-forge/community/` → 读 `pet.json` →
按契约严格校验（图集尺寸必须等于 列×格宽 / 行×格高）→ 注册进宠物注册表。

**不会**：不执行本仓库里的任何脚本、不安装依赖、不修改素材、不写入该目录以外的路径。

## 撤回

任选其一即可，插件每次刷新都会重新判定：

- `pet.json` 里 `"shared": false`（或删掉整个 `sharing` 块）
- 移除 `{{topic}}` topic
- 仓库转私有 / 删除
- 提 Issue（标题含 `[withdraw]`），或在索引里把该项 `revoked` 设为 `true`

官方索引条目的移除时限为 **7 日内**；自动发现的条目随条件移除即刻失效，本地缓存最长 24 小时。
**注意**：别人已经下载到本机的副本无法远程召回（协议第 9.4 条如实说明）。

## 字段速查

| 字段 | 当前值 |
| --- | --- |
| `protocol` | `{{protocol}}` |
| `author` | {{author}} |
| `repo` | {{repo}} |
| `preview` | {{preview}} |
| `tags` | {{tagList}} |

完整字段表见 [协议附录 B]({{agreementUrl}})。
