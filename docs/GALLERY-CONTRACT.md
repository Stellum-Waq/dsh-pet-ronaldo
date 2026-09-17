# 宠物社区 · 画廊契约（Gallery Contract v1）

> 面向三类读者：**想把自己的桌宠放上画廊的作者**、**想接入画廊的其它插件/工具**、**维护者自己**。
> 配套法律文本见 [`PET-SHARING-AGREEMENT.md`](PET-SHARING-AGREEMENT.md)（DPSL-1.0）。
>
> 实现位置：`host.js`（路由与安装）、`lib/gallery.mjs`（发现/下载/解包）、
> `skill/dsh-pet-forge/scripts/lib/share.mjs`（分享包生成）、`client/client.js`（界面窗口）。

---

## 1. 一句话

**作者自己把桌宠包 push 到公开 GitHub 仓库并打上 `dsh-pet` 标签；插件去读、去展示、去下载安装。**
插件不替任何人上传、不托管素材、不执行仓库里的脚本。

---

## 2. 发现：三种来源，合并去重

| 来源 | 机制 | 是否需要作者操作 | 离线可用 |
| --- | --- | --- | --- |
| **官方索引** | 本仓库 `gallery/index.json`，作者提 PR 加入 | 提一个 PR | ✅（包内置一份副本） |
| **自动发现** | GitHub 搜索 API `q=topic:dsh-pet` | 给仓库打个标签 | ❌（有缓存兜底） |
| **本地手动** | 界面里直接填仓库地址或本地目录 | 无 | ✅ |

合并规则：

1. 以 `owner/repo`（小写）为唯一键；
2. 官方索引条目的**说明性字段**优先（`name`/`author`/`tags`/`preview`/`statement` 等）；
3. 自动发现补充**动态字段**（`stars`/`updatedAt`/`pushedAt`）；
4. 同一仓库出现在两处时 `source: "both"`；
5. 索引里显式 `"revoked": true` 或 `"hidden": true` 的条目**永不展示**（黑名单，用于处理侵权与恶意内容）。

---

## 3. 条目判定：`dpsl` / `installable` / `compat`

插件对每个仓库做**两跳**探测（命中即停）：

```
第 1 跳：raw.githubusercontent.com/<owner>/<repo>/<branch>/pet.json
         ├─ 存在且 sharing.protocol = DPSL-1.0 且 shared = true 且 statement 非空
         │     → dpsl = true, installable = true, packagePath = <pet.json 所在相对目录>
         ├─ 存在但没有合法 sharing 块
         │     → dpsl = false, installable = false（清单可用，但作者未授权收录其素材）
         └─ 不存在 → 继续第 2 跳
第 2 跳：assets/spritesheet.json + assets/spritesheet.png
         → compat = "spritesheet-json"（可「兼容导入」，界面会明确提示状态映射是启发式的）
         都没有 → listed（仅收录：仓库链接 + 下载通道，不提供安装）
```

**只有 `installable: true` 的条目才给「一键安装」按钮。** 这是协议第 6.6 条在界面上的落地。

---

## 4. 官方索引格式（`gallery/index.json`）

```jsonc
{
  "protocol": "dsh-pet-gallery/1",
  "updatedAt": "2026-09-17T00:00:00.000Z",
  "entries": [
    {
      "key": "owner/repo",              // 必填，唯一键
      "repo": "https://github.com/owner/repo",
      "name": "宠物显示名",
      "author": "作者署名",
      "description": "一句话简介",
      "tags": ["像素风", "猫"],
      "protocol": "DPSL-1.0",           // 采用 DPSL 时填；否则省略 = 仅收录
      "license": "DPSL-1.0",
      "packagePath": "",                // pet.json 相对仓库根的目录，根目录填 ""
      "compat": "spritesheet-json",     // 可选：声明该仓库可用兼容导入（见 §6）
      "preview": "preview.png",         // 预览图相对路径
      "contact": "https://github.com/owner/repo/issues",
      "homepage": "https://...",        // 可选：演示页
      "addedAt": "2026-09-17T00:00:00.000Z",
      "revoked": false,                 // true = 撤回/下架，永不出现在界面
      "hidden": false,                  // true = 内部保留但不展示
      "note": ""                        // 可选的维护者备注
    }
  ]
}
```

约定：

- 顶层键以 `_` 开头的对象（如 `_example`）**被忽略**，可用来放注释性示例；
- `entries` 之外的多余字段被忽略，便于以后扩展；
- `key` 大小写不敏感，插件内部统一转小写；
- 条目顺序即默认展示顺序（界面还会按 star / 更新时间排序，用户可切）。

### 提交方式（二选一）

```powershell
# A. 提 PR：在 gallery/index.json 的 entries 里加一项（保持 JSON 合法、字段按上表）
# B. 什么都不做：只要仓库有 pet.json（DPSL-1.0 声明）+ dsh-pet 标签，自动发现就能收录
```

---

## 5. 安装流水线（一键安装）

```
key/repo
  → 解析 owner/repo 与默认分支（main → master 兜底，均失败则报错并提示手动填分支）
  → GET https://codeload.github.com/<owner>/<repo>/tar.gz/refs/heads/<branch>
     （体积上限默认 96MB，超出即中止）
  → zlib.gunzipSync + 内置 ustar 解析（支持 GNU 'L' 长名与 pax 'x' 头）
  → 路径消毒：拒绝绝对路径、盘符、`..`、符号链接与硬链接（只接受普通文件与目录）
  → 落到 $DSH_HOME/storages/dsh-pet-forge/community/<owner>-<repo>/
  → 定位 pet.json（packagePath → 根目录 → 最浅的 pet.json，深度 ≤ 3）
  → validateManifest（图集尺寸 = 列×格宽 / 行×格高 等硬性校验）
     ├─ 不合格 → 422，附 errors/warnings，保留已解包文件供作者自查
     └─ 合格 → 注册进宠物注册表（默认接管为「默认打开的宠物」，可用 focus:false 关掉）
  → 注册表记录来源：origin = { kind:"community", key, repoUrl, protocol, author, installedAt }
```

**不做的事**（安全边界，也是协议第 5、10 条承诺的一部分）：

- ❌ 不执行仓库里的任何脚本（`publish.ps1`、`postinstall`、`*.cmd`…）；
- ❌ 不安装依赖、不调用 `npm`；
- ❌ 不修改素材与清单（只读取）；
- ❌ 不写入宠物包目录以外的路径（除 `community/` 与注册表）。

---

## 6. 兼容导入（compat）

部分社区仓库用的是**同一张精灵图契约的变体**（例如 `assets/spritesheet.json` 描述每行是什么动作），
但它们并没有 `pet.json`，因此没有 DPSL 授权。插件对这类仓库提供**兼容导入**：

- 由 `spritesheet.json` 的 `cell/cols/rows[].name` 合成一份本地 `pet.json`（写在 `community/<key>/` 内，**不改上游仓库**）；
- 行名映射表（启发式，界面会提示可能不准）：

| 上游行名 | 映射到契约状态 |
| --- | --- |
| `idle` | `idle` |
| `walk-right` / `run-right` | `runRight` |
| `walk-left` / `run-left` | `runLeft` |
| `wave` / `waving` | `waving` |
| `jump` / `celebrate` | `jumping` |
| `sad` / `failed` / `oops` | `failed` |
| `wait` / `waiting` | `waiting` |
| `work` / `working` | `running` |
| `think` / `review` | `review` |
| `look` | `look` |
| 其它（`sleep`、`peck`、`dribble`…） | 不映射（保持 `aliasOf: idle`） |

- 合成后的清单 `source` 字段会写明 `{ kind: "compat", repo, adapter: "spritesheet-json" }`，
  界面上这套宠物会带「⚠️ 兼容导入」标记，作者可随时用自己仓库里的正式 `pet.json` 覆盖。

---

## 7. HTTP 接口（Host 半）

全部挂在 `/ronaldo-pet/gallery*`：

| 方法 | 路径 | 请求 | 说明 |
| --- | --- | --- | --- |
| GET | `/gallery` | `?refresh=1&q=<关键词>` | 返回合并后的条目列表 + 缓存状态 |
| POST | `/gallery/refresh` | `{}` | 强制重抓（索引 + GitHub 搜索） |
| POST | `/gallery/install` | `{key}` 或 `{repo}` 或 `{dir}` | 下载/解包/校验/注册；`{adapter:"spritesheet-json"}` 走兼容导入 |
| POST | `/gallery/share` | `{id}` 或 `{dir}` + `{accept:true, …}` | 生成分享包（写入 `sharing` 块 + 协议文件 + 发布脚本） |

`GET /gallery` 的响应：

```jsonc
{
  "ok": true,
  "protocol": "DPSL-1.0",
  "galleryProtocol": "dsh-pet-gallery/1",
  "cachedAt": "2026-09-17T…",
  "stale": false,                 // 缓存是否过期
  "online": true,                 // 本轮是否成功联网
  "counts": { "total": 7, "installable": 1, "compat": 1, "listed": 5 },
  "installed": ["owner/repo"],    // 已从社区安装过的 key
  "entries": [ { /* 见 §3 字段 */ } ],
  "errors": []                    // 抓取失败的原因（不阻断展示）
}
```

---

## 8. 缓存与配置

| 配置键（`host.js` 的 `CONFIG.gallery`） | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关掉后界面只显示本地手动条目 |
| `topics` | `["dsh-pet"]` | 参与自动发现的 GitHub topic |
| `indexUrl` | 本仓库 `gallery/index.json` 的 raw 地址 | 官方索引远端地址 |
| `indexPath` | `<包目录>/gallery/index.json` | 包内置索引（离线种子） |
| `cachePath` | `$DSH_HOME/storages/dsh-pet-forge/gallery-cache.json` | 本地缓存 |
| `installDir` | `$DSH_HOME/storages/dsh-pet-forge/community` | 社区宠物解包目录 |
| `cacheMs` | 21600000（6 小时） | 缓存有效期 |
| `online` | `true` | `false` = 只读本地种子与缓存（完全离线） |
| `curlFallback` | `true` | fetch 失败（尤其证书问题）时改用 `curl` 取；见 §11 |
| `curlPath` | `curl` | curl 可执行文件 |
| `token` | 空 | 可选：GitHub token（搜索 API 未认证时有速率限制）。也读 `DSH_PET_GITHUB_TOKEN` / `GITHUB_TOKEN` |
| `maxEntries` | 60 | 单次最多收录条目数（防搜索结果过大） |
| `maxDownloadBytes` | 100663296（96MB） | 单个归档体积上限 |
| `maxExtractBytes` | 536870912（512MB） | 解包后总量上限 |
| `searchApi` | `https://api.github.com/search/repositories` | 自动发现的搜索端点 |
| `rawBase` | `https://raw.githubusercontent.com` | 读 `pet.json` / 预览图 |
| `codeloadBase` | `https://codeload.github.com` | 下载归档 |

> 后三项是为了**可测试**与**可镜像**：把三个地址指向本地桩服务器，就能在没有网络的环境里
> 跑完整的「发现 → 下载 → 解包 → 校验 → 注册」链路（`scripts/smoke-host.mjs` 就是这么测的），
> 企业内网也可以换成自己的 GitHub 镜像。

缓存文件结构：`{ version, fetchedAt, online, entries: [...] }`。
撤回（协议第 9 条）在每次刷新时重新判定：条件不满足的条目直接不再出现，本地缓存最长 24 小时失效。

---

## 9. 分享包（`/gallery/share`）

**前提**：调用方必须传 `accept: true`，即用户在界面上明确选了「愿意共享」。
未传或为 `false` → `400 { error: "需要用户明确同意（accept: true）" }`。

生成物（写入宠物包目录，也就是将来 push 上去的仓库内容）：

| 文件 | 说明 |
| --- | --- |
| `pet.json` | **就地**补上/更新 `sharing` 块（协议标识、署名、仓库地址、声明文本…） |
| `DSH-PET-LICENSE.md` | 协议副本（从插件 `docs/PET-SHARING-AGREEMENT.md` 复制） |
| `README.md` | 仅在**不存在**时生成；已存在则保持原样并追加说明到 `SHARING.md` |
| `SHARING.md` | 收录说明：协议摘要、字段含义、如何撤回、预览图放哪 |
| `publish.ps1` / `publish.sh` | 一键初始化仓库并推送的脚本（**由用户自己运行**，插件不代跑） |
| `.gitignore` | 忽略临时产物（`share-kit` 之类） |

响应里会给出：写入的文件列表、要加的 topic、`git` 命令、以及可直接粘进 `gallery/index.json` 的条目片段。

---

## 10. 撤回清单（作者侧）

1. `pet.json` 里 `sharing.shared = false`（或删掉 `sharing` 块） → 自动发现立即不再收录；
2. 移掉 `dsh-pet` 标签 → 同上；
3. 仓库转私有/删除 → 同上；
4. 要更快、更彻底：提 Issue（标题含 `[withdraw]`）或在索引里 PR 把 `revoked` 设为 `true`（同时进黑名单）。

---

## 11. 磨过的坑（维护者笔记）

**① Node 认不出本地代理的证书。**
这台开发机把 `raw.githubusercontent.com` 解析到 `127.0.0.1`（本地代理），Windows 证书store 里有那张根证书、
但 Node 自带的 CA 包里没有，于是 `fetch` 直接抛：

```
fetch failed | cause: UNABLE_TO_VERIFY_LEAF_SIGNATURE unable to verify the first certificate
```

实测同一环境里 `curl.exe`（走 Windows Schannel，认系统证书）一次就通。所以画廊的取数层是
**fetch 优先 → 失败换 curl 再试一次**，并把 `transport: 'fetch' | 'curl'` 写进结果便于排查；
错误信息里会提示 `NODE_OPTIONS=--use-system-ca`（Node 22+）。

**② tarball 绝不能走 `res.text()`。**
`text()` 按 UTF-8 解码二进制，拿到的是"看着像文本的烂数据"，表现为"下载成功但解包失败"。
必须 `arrayBuffer()` → `Buffer`。

**③ 归档行数要按图片实际高度推导。**
社区变体（`assets/spritesheet.json`）里的 `rows` 数组经常只是"列出来的动作数"，与图集真实行数不一致
（实测 `lizhuangCoding/dsh-chicken-pet`：单格 192×208、图集 1536×4160 → 真实 20 行）。
用 json 里的数字会写出错的行号，注册校验会以"行号超出范围"报错。所以兼容导入用 `图片高 ÷ 单格高`。

**④ 分享生成的 `publish.ps1` 必须保持纯 ASCII。**
把宠物名（可能是中文）插进脚本里，就是给 PowerShell 5.1 埋雷 —— 它读无 BOM 脚本按 ANSI 解析，中文变乱码。
所以模板里默认提交信息固定为 ASCII，中文说明放 `SHARING.md`。（和 `DesktopPet.ps1` 是同一条教训。）

---

## 12. 怎么验证

| 脚本 | 验什么 | 要不要联网 |
| --- | --- | --- |
| `node scripts/smoke-host.mjs` | 全套 Host 路由，画廊用**本地桩服务器**跑完「发现 → 探测 → 下载 → 解包 → 校验 → 注册 → 撤回拦截 → 恶意归档」，还验证"没同意就不写文件" | ❌ 不需要 |
| `node scripts/verify-gallery-live.mjs` | 真去 GitHub 搜 `topic:dsh-pet`、读 raw、下一个真仓库的 tarball、解包、跑严格校验（**不注册**，不碰用户注册表） | ✅ 需要 |
| `node scripts/verify-client-render.mjs` | 网页面板：画廊卡片徽章、一键安装真的 POST key、分享按钮在勾选前禁用、勾选后 POST `accept:true` | ❌ 不需要 |

> 这组脚本的分工是刻意的：**桩测试证明逻辑对，联网测试证明"这台机器真的能拿到东西"**。
> 两个问题混在一个脚本里，一旦网络抽风就分不清是代码坏了还是网坏了。
