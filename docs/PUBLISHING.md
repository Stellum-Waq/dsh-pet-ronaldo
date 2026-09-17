# 发布与上架

这份文档是给**维护者**看的：怎么把当前版本发到 GitHub，以及怎么让它出现在 DSH 插件市场里。
每一步都可以直接复制执行。

---

## 0. 当前状态（每次发布前先确认）

```powershell
cd D:\代码\桌宠\dsh-ronaldo-pet
git status --short          # 应该是干净的
git log --oneline -1        # 看当前版本提交
git log --oneline origin/master..HEAD   # 本地领先远端几个提交
```

> ⚠️ **这台机器上 git 的凭据已失效。** 2026-09 的状态：
> `git push` 报 `Invalid username or token. Password authentication is not supported for Git operations.`
> 也就是推送会被拒。先按第 1 步重新登录，否则后面所有步骤都到不了 GitHub。

---

## 1. 重新登录 GitHub（只需一次）

Git Credential Manager 已经装好了，直接调它：

```powershell
& "C:\Program Files\Git\mingw64\bin\git-credential-manager.exe" github login
```

会弹出浏览器让你授权，登录完凭据就存进 Windows 凭据管理器，之后 `git push` 不再问。

**没有 `gh` CLI。** 想用 `gh repo edit --add-topic` 之类的命令，先装：

```powershell
winget install --id GitHub.cli
gh auth login
```

不装也行 —— 第 3 步可以全部在网页上点。

---

## 2. 发到 GitHub

```powershell
cd D:\代码\桌宠\dsh-ronaldo-pet

# b) 推送提交和 tag
git push origin master
git push origin --tags          # 会把 v2.0.0 一并推上去
```

然后建一个 Release（网页上：Releases → Draft a new release → 选 `v2.0.0`）：

- **标题**：`v2.0.0 — 原生桌面窗口 + 分辨率不限的素材创作`
- **正文**：直接复制 [`CHANGELOG.md`](../CHANGELOG.md) 里 `[2.0.0]` 那一节

---

## 3. 上架到插件市场

DSH **没有唯一的官方插件市场**，社区有好几个，机制分两类。全做一遍也就几分钟。

### 3.1 一类：靠 GitHub topic 自动抓取（先做这个，覆盖面最大）

多数市场（如 [`TheYoungChen/dsh-plugin-market`](https://github.com/TheYoungChen/dsh-plugin-market)、
[`dsh-market/dsh-market`](https://github.com/dsh-market/dsh-market)、
[`LivXue/dsh-plugin-shop`](https://github.com/LivXue/dsh-plugin-shop)）是**扫描带 `dsh-plugin`
topic 的 GitHub 仓库**来建立索引的。所以"上架"本质上就是给仓库加一个 topic。

**网页操作**（约 30 秒）：

1. 打开 <https://github.com/Stellum-Waq/dsh-pet-ronaldo>
2. 右侧 About 栏 → 齿轮 ⚙️（Edit repository details）
3. **Topics** 里加上：`dsh-plugin`
   （建议一并加：`deepseek-harness`、`desktop-pet`、`cordis`）
4. 顺手把 **Description** 设成下面 3.4 的一句话简介
5. Save changes

**命令行**（装了 `gh` 的话）：

```powershell
gh repo edit Stellum-Waq/dsh-pet-ronaldo --add-topic dsh-plugin,deepseek-harness,desktop-pet,cordis
gh repo edit Stellum-Waq/dsh-pet-ronaldo --description "DSH 桌宠：网页右下角 + 独立原生桌面窗口的宠物，附一句话生成新宠物的技能"
```

> `package.json` 的 `keywords` 里已经放了 `dsh-plugin`，npm 侧的关键字检索也能命中。

### 3.2 二类：收录类列表，需要提 PR

- [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
- [`dshworks/awesome-dsh-plugins`](https://github.com/dshworks/awesome-dsh-plugins)
- [`hackerFish/awesome-dsh-plugin`](https://github.com/hackerFish/awesome-dsh-plugin)

流程都一样：**先读仓库的 `CONTRIBUTING.md`**（各家的格式要求不同，别照抄别家），
fork → 在列表里加一行 → 提 PR。

> 本机连不上 `raw.githubusercontent.com`（DNS 解析到内网地址），所以**没能读到各家的
> CONTRIBUTING 原文**。提 PR 前请自己打开确认一次格式，第 3.4 节给的是通用条目。

### 3.3 还有一类：把 npm 包当成安装源

部分市场直接给 `dsh plugin add <包名>` 用，走 npm 分发：

```powershell
npm login
npm publish --access public
```

本机 `npm whoami` 目前是 `ENEEDAUTH`（未登录），要发 npm 得先 `npm login`。

### 3.4 可直接粘贴的条目

**一句话简介**（用于仓库 Description / 市场卡片，68 字符左右）：

```
DSH 桌宠：网页右下角 + 独立原生桌面窗口的宠物，附一句话生成新宠物的技能
```

**长描述**（用于市场详情页 / awesome 列表条目的说明）：

```
DSH 桌宠（dsh-ronaldo-pet）。一只住在 DeepSeek Harness 里的精灵宠物，并且能离开浏览器
活在电脑桌面上：原生 WPF 窗口、无边框、背景透明、永远置顶，关掉或最小化网页也照样在。
随 Agent 状态切换动作（专注工作 / 思考 / 等待审批 / 出错摔倒），对话完成时跳跃庆祝并
全机播放提示音；悬停显示当前工作区与对话名，双击用 Edge 打开 Harness 网页，连点三次摔跤，
拖动搬走，滚轮改大小，右键出菜单（切换宠物 / 平时行为 / 系统音 / 置顶 / 隐藏 / 设为默认）。
素材分辨率不限：192px 的像素风、1024px 的精细立绘乃至写实素材都支持，显示时等比缩放。
内置多宠物注册表、每宠物独立音频、注册即校验（严格防图片错位）。
配套 dsh-pet-forge 技能可一句话生成并导入新宠物：生图模型 + Blender 3D 建模 + 动作/音效设计。
```

**awesome 列表用的行**（按各家格式调整链接与标点）：

```markdown
- [dsh-ronaldo-pet](https://github.com/Stellum-Waq/dsh-pet-ronaldo) — 桌宠插件：网页右下角 + 独立原生桌面窗口。随 Agent 状态动、对话完成庆祝、悬停看工作区、双击开网页；素材分辨率不限（写实素材也支持）；附 `dsh-pet-forge` 技能可一句话生成新宠物。
```

**安装命令**（市场卡片通常要展示）：

```
dsh plugin add https://github.com/Stellum-Waq/dsh-pet-ronaldo
```

**标签**：`dsh-plugin` `deepseek-harness` `desktop-pet` `pet` `cordis` `blender` `sprite`

---

## 4. 发布前自检

四套测试全绿再发：

```powershell
cd D:\代码\桌宠\dsh-ronaldo-pet
node scripts\smoke-host.mjs                     # Host 接口与注册表
node scripts\verify-desktop-lifecycle.mjs       # 桌面宠物生命周期（16 项）
node scripts\verify-highres.mjs                 # 高分辨率素材端到端（21 项）
node scripts\verify-client-render.mjs           # 网页端插件渲染（23 项）
node skill\dsh-pet-forge\scripts\selftest.mjs   # 技能自检
```

交互那套需要桌面上真有一只宠物在跑，而且**测的时候别动鼠标**
（有人抢光标时它会如实报 `INCONCLUSIVE`，不是失败）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-desktop-interaction.ps1 `
  -LogPath "$env:USERPROFILE\.dsh\storages\dsh-pet-forge\desktop-pet.log"
```

---

## 5. 版本号怎么定

语义化版本：

- **major**：桌面窗口、技能、素材契约这类大功能或行为不兼容（v1 → v2 就是这一类）
- **minor**：向后兼容的新功能（新动作、新菜单项）
- **patch**：修 bug

发版时三处要同步改，别漏：

1. `package.json` 的 `"version"`
2. `CHANGELOG.md` 新增一节
3. `git tag -a vX.Y.Z -m "..."`
