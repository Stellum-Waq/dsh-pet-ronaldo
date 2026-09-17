# 端到端流程 · 一页纸

从"我有一个视频"到"桌面上有一只宠物"的完整路径。
每一步都写清了**判据**（什么情况下走哪条分支）和**产出**（下一步吃什么）。

```
┌─ 0. 环境        patch-forge.mjs ──────────────► 一个有补丁的 forge 副本
│                                                  （后面全用它）
├─ 1. 读视频      probe_video.py ───────────────► verdict: chroma-ok / scene
│                                                    │
│         ┌──────────────────────────────────────────┴───────────────┐
│         │ chroma-ok                                    scene       │
│         ▼                                                          ▼
│   走 forge 原生色键                                    seg_frames.py
│   （跳过第 2、3 步）                                   └─► RGBA 帧 + seg-stats.json
│                                                              │
├─ 3. 目视 QA     qa_frames.py ────────────────────────────────┤ 不合格就回第 2 步调参
│                                                              ▼
├─ 4. 分段        plan_segments.py ──────────────────────► segments 草稿 + 分镜图
│                                                              │
├─ 5. 问用户      ask_user_question（一次问完 5 题）◄────────────┘
│                                                              │
├─ 6. 装配        forge video --frames-dir … --no-key ──────────┤
│                 音频：extract_video_audio.py 切原声 ──────────┤
│                 forge audio --file …（必须单独跑）            │
│                 装配时带 --behavior idle                      ▼
├─ 7. 安装验证    forge install
│                 verify + 逐个 play（证明真的有声音）
│                 verify-desktop.mjs（抓帧）→ verify_render.py（比对）
│                                                              │
└─ 8. 交付        如实说明三个限制 + 问一次要不要共享 ───────────┘
```

---

## 命令速查

把 `<W>` 换成工作区、`<S>` 换成本技能目录、`<P>` 换成宠物的插件目录。

```powershell
# 0 · 复制并修补 forge（只需一次，之后都用这个副本）
node "<S>\scripts\patch-forge.mjs" --dst "<W>\_work\forge-local"

# 1 · 读视频 + 判定路线
python "<S>\scripts\probe_video.py" --video "<视频>" --out "<W>\_work\probe"

# 2 · 抽帧 + 人体分割（只有 verdict=scene 才需要）
python "<S>\scripts\seg_frames.py" --video "<视频>" --out "<W>\_work\frames" `
       --fps 12 --torch-home "<W>\_work\torch-cache"

# 3 · 抠像目视检查（不可跳过）
python "<S>\scripts\qa_frames.py" --frames "<W>\_work\frames" --n 8
#    → 把出来的图交给视觉模型看

# 4 · 动作分段草稿
python "<S>\scripts\plan_segments.py" --stats "<W>\_work\seg-stats.json" `
       --window 1.0 --frames "<W>\_work\frames"

# 6 · 装配
node "<W>\_work\forge-local\scripts\forge.mjs" video `
  --pkg "<W>\pets\<id>" --frames-dir "<W>\_work\frames" `
  --no-key --fps 12 --frames 8 --segments "<第4步的 segments>" `
  --name "<名字>" --id <id> --size 224 --behavior idle

# 6 · 音频。首选：切原视频的声音（不需要 ffmpeg，PyAV 进程内解码）
python -m pip install --target "<W>\pylibs" --no-cache-dir av    # 仅首次
python "<S>\scripts\extract_video_audio.py" --video "<视频>" --pkg "<W>\pets\<id>" `
  --segments "<和第 6 步装配一字不差的那串>" --libs "<W>\pylibs"
node "<W>\_work\forge-local\scripts\forge.mjs" audio --pkg "<W>\pets\<id>" --replace `
  --file "file:celebrate:<pkg>\audio\celebrate.wav,file:failed:...,file:waiting:...,file:working:...,file:click:...,file:dive:..."
python "<S>\scripts\extract_video_audio.py" --pkg "<W>\pets\<id>" --relabel --libs "<W>\pylibs"

# 6 · 备选：合成音效（素材本身没声音时）
node "<W>\_work\forge-local\scripts\forge.mjs" audio --pkg "<W>\pets\<id>" `
  --sfx celebrate,failed,click,dive,boot,waiting

# 6 · 严格校验（确认音频真的进去了）
node "<W>\_work\forge-local\scripts\forge.mjs" verify --pkg "<W>\pets\<id>"

# 6 · 逐个试播（verify 只证明文件在，不证明有声音）
node "<W>\_work\forge-local\scripts\forge.mjs" play --id <id> --key celebrate
# failed / waiting / working / click / dive 都要过一遍

# 7 · 安装
node "<W>\_work\forge-local\scripts\forge.mjs" install --pkg "<W>\pets\<id>"

# 7 · 证明它真的画出来了
node "<P>\scripts\verify-desktop.mjs" --base http://127.0.0.1:3080
python "<S>\scripts\verify_render.py" `
  --frame "<P>\.forge-test\desktop-frame.png" --atlas "<W>\pets\<id>\atlas.png"
```

---

## 每步的判据

### 第 1 步：`verdict` 怎么读

| verdict | 判据（边缘颜色标准差中位数） | 走法 |
|---|---|---|
| `chroma-ok` | < 12 且帧间漂移也小 | forge 原生色键 `--key auto`。**别绕道分割**——色键更快，而且自带 `despill` 去白边，边缘比语义分割干净 |
| `scene` | ≥ 12 | 人体分割。这种素材色键没有任何阈值能救 |

分界线上的素材（std 十几）自己看一眼联络图再定：只要边缘能看到**成片的纯色**，色键就还能试；
边缘是杂乱的纹理，直接分割。

### 第 3 步：什么算"不合格"

- **面积离群帧**：`qa_frames.py` 的 `suspect_frames` 非空 → 回第 2 步
- **视觉模型说**人有缺失、有残留背景 → 回第 2 步
- 面积中位数**异常大**（比如 > 0.6）：先怀疑第 5 号坑（泛洪吃背景），
  看 `seg-stats.json` 里 `bbox` 的 `x_max` 是不是一直贴着画面右边
- 面积中位数**异常小**（比如 < 0.08）：主体太小或没检测到，这套分割不适合这个素材

### 第 4 步：什么时候必须人工介入

自动分配只懂"运动特征像"，不懂语义。**必须核对**的情形：

- 用户给了明确的时间点 → 完全按用户的，不要用自动结果
- 自动把某个**平静**片段派给了 `jumping`（看 `why` 里的 trend 值）→ 手动改
- 视频里有明显语义（鞠躬、挥手、摔跤）而自动分配明显错配 → 手动改
- 用户说"你决定" → 可以用自动结果，但交付时要说明切在哪、依据是什么

### 第 7 步：怎么算"真的画出来了"

`verify_render.py` 的两个数字：

- `best_match.diff < 12` —— 画面对上了图集的某一格
- `size_agrees == true` —— 占幅和参考格相差 ≤ 6%

两个都满足才算通过。注意 `best_match.row` 应该是你**实际用到的行号之一**
（本流程通常只用 0 / 4 / 5 / 6 / 7 / 8），如果匹配到 1/2/3/9/10 行，
说明画面和预期不符，要查。

---

## 交付前自检清单

- [ ] `verify --pkg` 返回 `ok: true`，且 `info.audio` 条数与注册的一致（没被静默丢掉）
- [ ] `triggers` / `interactions` 里**每个值都能在 `audio` 里找到**（没有悬挂键）
- [ ] 每个音频都 `play --id <id> --key <k>` 真播过一次（`verify` 不证明有声音）
- [ ] 用原声时：没有"近乎静音被提 20+dB"的片段（工具会 warning，别忽略）
- [ ] `pet.json` 的 `behavior` 是 `idle`（不是 `look`）
- [ ] `pet.json` 的 `states` 里，用到的行号都在 0–8，`idle` 一定存在
- [ ] `verify_render.py` 通过（diff < 12 且 size_agrees）
- [ ] `GET /ronaldo-pet/asset/<id>/atlas.png` 返回 200 + image/png，字节数与本地一致
- [ ] `list` 里 `settings.defaultPet` 是**这只**（可能被人改过，见坑 11）
- [ ] 已如实说明：没有 `look`、分割质量边界、源视频裁切会被继承
- [ ] 真人素材：若用户要分享，提醒先取得当事人同意
- [ ] 问过**一次**要不要共享到宠物社区（没得到"愿意"就不要往包里写任何东西）

---

## 一次真实跑通的参数（竖屏真人 · 8.4 秒 · 办公室背景）

留作量级参考，不是要照抄：

| 项 | 值 |
|---|---|
| 源 | 720×1280 竖屏 · 30fps · 8.43s · 253 帧 · 固定机位 |
| 背景判定 | 边缘 std ≈ 52–56 → `scene`（真实现场） |
| 分割 | DeepLabV3-mobilenet · 101 帧 @12fps · CPU 约 51s |
| alpha 覆盖率 | 0.211 – 0.456（中位 0.371） |
| 分段 | 6 个动作 × 1.0s，各取 8 帧 → 8fps 回放，接近原速 |
| 图集 | 1536×2288（8列×11行 · 192×208）· 871 KB |
| 包体 | 约 3.6 MB |
| 权重下载 | 42 MB（仅首次） |

耗时构成（CPU，无线程池调优）：分割 ≈ 51s，装配 ≈ 40s，其余都是秒级。
