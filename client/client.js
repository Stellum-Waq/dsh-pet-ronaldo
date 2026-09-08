window.__ModuleLoader__.load({ id: "dsh-ronaldo-pet", factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  let react = require("react");

  const name = "dsh-ronaldo-pet";
  const inject = ["slots"];

  // 内置 C罗：8 列 × 11 行精灵图契约（192×208 每格），见 docs/SPRITESHEET-CONTRACT.md
  const CODE_STATES = {
    idle: { row: 0, frames: 6, fps: 6 },
    runRight: { row: 1, frames: 8, fps: 12 },
    runLeft: { row: 2, frames: 8, fps: 12 },
    waving: { row: 3, frames: 4, fps: 8 },
    jumping: { row: 4, frames: 5, fps: 10 },
    failed: { row: 5, frames: 8, fps: 12 },
    waiting: { row: 6, frames: 6, fps: 5 },
    running: { row: 7, frames: 6, fps: 12 },
    review: { row: 8, frames: 6, fps: 6 },
    look: { rows: [9, 10] },
  };
  // 宿主状态模式 → 动画行
  const HOST_ANIM = {
    idle: "idle",
    working: "running",
    review: "review",
    waiting: "waiting",
    failed: "failed",
    celebrating: "jumping",
  };
  const BEHAVIOR_OPTIONS = [
    { value: "idle", label: "😌 待机" },
    { value: "runRight", label: "🏃 右跑运球" },
    { value: "runLeft", label: "🏃 左跑运球" },
    { value: "waving", label: "👋 挥手" },
    { value: "jumping", label: "🎉 SIU 跳跃" },
    { value: "failed", label: "😵 摔倒" },
    { value: "waiting", label: "⏳ 等待" },
    { value: "running", label: "⚽ 颠球" },
    { value: "review", label: "🤔 思考" },
    { value: "look", label: "👀 注视" },
  ];
  const PHRASES = ["SIUUUUU! 🎉", "进球啦！⚽", "完美的终结！", "Vamos!", "这就是 7 号！"];
  const DIVE_PHRASES = ["Penalty kick! ⚽", "给我点球！Penalty!", "点球！裁判！"];

  // 与宿主对话的 HTTP 小助手（同源，见 host.js 的路由）
  const rpc = (action, args) =>
    fetch("/ronaldo-pet/" + action, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args || {}),
    }).then((res) => res.json().catch(() => ({ ok: false, error: "响应解析失败" })));

  // ---------- 轻量 store（多宠物 + 宿主状态） ----------
  let state = {
    pets: [
      {
        id: "p1",
        name: "C罗",
        size: 120,
        visible: true,
        pos: null,
        behavior: "look",
        sheet: { uri: "/ronaldo-pet/spritesheet.webp", cols: 8, rows: 11, cellW: 192, cellH: 208 },
        states: CODE_STATES,
      },
    ],
    hostMode: "idle",
  };
  let nextId = 2;
  let lastSeq = -1;
  const listeners = new Set();

  const getState = () => state;
  const subscribe = (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
  const notify = () => { listeners.forEach((fn) => { try { fn(); } catch (e) {} }); };
  const setState = (patch) => { state = Object.assign({}, state, patch); notify(); };
  const updatePet = (id, patch) => { state = Object.assign({}, state, { pets: state.pets.map((p) => p.id === id ? Object.assign({}, p, patch) : p) }); notify(); };
  const removePet = (id) => { state = Object.assign({}, state, { pets: state.pets.filter((p) => p.id !== id) }); notify(); };
  const setAllVisible = (v) => { state = Object.assign({}, state, { pets: state.pets.map((p) => Object.assign({}, p, { visible: v })) }); notify(); };
  const addImportedPet = (data) => {
    const n = nextId; nextId += 1;
    const pet = {
      id: "p" + n,
      name: (data && data.name) || ("宠物" + n),
      size: 120,
      visible: true,
      pos: null,
      behavior: "idle",
      sheet: (data && data.sheet) || { uri: null, cols: 8, rows: 11, cellW: 192, cellH: 208 },
      states: (data && data.states) || {},
    };
    state = Object.assign({}, state, { pets: state.pets.concat([pet]) });
    notify();
  };

  const useStore = () => {
    const pair = react.useState(0);
    const setTick = pair[1];
    react.useEffect(() => subscribe(() => setTick((t) => t + 1)), []);
    return getState();
  };

  const framePos = (col, row, cols, rows) => (col * 100 / (cols - 1)) + "% " + (row * 100 / (rows - 1)) + "%";

  function PetSpriteRenderer(props) {
    const pet = props.pet;
    const mode = props.mode || "idle";
    const lookDir = (((props.lookDir || 0) % 16) + 16) % 16;
    const size = props.size || pet.size || 120;
    const sheet = pet.sheet || {};
    const states = pet.states || {};
    const cols = sheet.cols || 8;
    const rows = sheet.rows || 11;
    const cellW = sheet.cellW || 192;
    const cellH = sheet.cellH || 208;
    const uri = sheet.uri;
    const pair = react.useState(0);
    const frame = pair[0];
    const setFrame = pair[1];
    react.useEffect(() => {
      if (mode === "look") { setFrame(0); return undefined; }
      const st = states[mode];
      if (!st || !st.frames) { setFrame(0); return undefined; }
      setFrame(0);
      let f = 0;
      const timer = window.setInterval(() => { f = (f + 1) % st.frames; setFrame(f); }, Math.round(1000 / (st.fps || 8)));
      return () => window.clearInterval(timer);
    }, [mode, states]);
    let col;
    let row;
    if (mode === "look") {
      const lk = states.look;
      if (lk && lk.rows && lk.rows.length >= 2) {
        if (lookDir < 8) { row = lk.rows[0]; col = lookDir; } else { row = lk.rows[1]; col = lookDir - 8; }
      } else {
        const st = states.idle || { row: 0 };
        row = st.row; col = 0;
      }
    } else {
      const st = states[mode] || states.idle || { row: 0, frames: 1 };
      row = st.row; col = frame % (st.frames || 1);
    }
    const style = {
      width: size + "px",
      height: Math.round(size * cellH / cellW) + "px",
      backgroundImage: uri ? "url(" + uri + ")" : undefined,
      backgroundSize: (cols * 100) + "% " + (rows * 100) + "%",
      backgroundRepeat: "no-repeat",
      backgroundPosition: framePos(col, row, cols, rows),
    };
    return react.createElement("div", { className: "dp-ronaldo", style: style });
  }

  function PetSprite(props) {
    const pet = props.pet;
    const hostMode = props.hostMode;
    const h = react.useState(false); const hover = h[0]; const setHover = h[1];
    const l = react.useState(0); const lookDir = l[0]; const setLookDir = l[1];
    const d1 = react.useState(false); const dragging = d1[0]; const setDragging = d1[1];
    const d2 = react.useState("running"); const dragDir = d2[0]; const setDragDir = d2[1];
    const b = react.useState(null); const bubble = b[0]; const setBubble = b[1];
    const dv = react.useState(false); const diving = dv[0]; const setDiving = dv[1];
    const ct = react.useState([]); const clickTimes = ct[0]; const setClickTimes = ct[1];
    const dragRef = react.useRef(null);

    react.useEffect(() => {
      if (bubble === null) return undefined;
      const t = window.setTimeout(() => setBubble(null), 2600);
      return () => window.clearTimeout(t);
    }, [bubble]);
    react.useEffect(() => {
      if (!diving) return undefined;
      const t = window.setTimeout(() => setDiving(false), 2500);
      return () => window.clearTimeout(t);
    }, [diving]);

    const resolveMode = () => {
      if (dragging) return dragDir || "running";
      if (diving) return "failed";
      if (hover && pet.states && pet.states.look) return "look";
      if (hostMode && hostMode !== "idle") return HOST_ANIM[hostMode] || "idle";
      return pet.behavior || "idle";
    };
    const mode = resolveMode();

    const onPointerDown = (e) => {
      if (typeof e.button === "number" && e.button !== 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      dragRef.current = { id: pet.id, startX: e.clientX, startY: e.clientY, originLeft: rect.left, originTop: rect.top, moved: false };
      setDragging(true);
      setDragDir("running");
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
    };
    const onPointerMove = (e) => {
      const d = dragRef.current;
      if (d !== null && d.id === pet.id) {
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
        if (dx > 4) setDragDir("runRight");
        else if (dx < -4) setDragDir("runLeft");
        else setDragDir("running");
        const left = d.originLeft + dx;
        const top = d.originTop + dy;
        updatePet(pet.id, { pos: { left: Math.round(left), top: Math.round(top) } });
        return;
      }
      if (hover) {
        const rect = e.currentTarget.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = e.clientX - cx;
        const dy = e.clientY - cy;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
          let deg = Math.atan2(dx, -dy) * 180 / Math.PI;
          if (deg < 0) deg += 360;
          setLookDir(Math.round(deg / 22.5) % 16);
        }
      }
    };
    const onPointerUp = (e) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) {}
      if (d === null || !d.moved) {
        const now = Date.now();
        const recent = clickTimes.filter((t) => now - t < 1500);
        recent.push(now);
        setClickTimes(recent);
        if (recent.length >= 3) {
          setClickTimes([]);
          setDiving(true);
          setBubble(DIVE_PHRASES[Math.floor(Math.random() * DIVE_PHRASES.length)]);
        } else {
          setBubble(PHRASES[Math.floor(Math.random() * PHRASES.length)]);
        }
      }
    };
    const onPointerEnter = () => setHover(true);
    const onPointerLeave = () => setHover(false);
    const onPointerCancel = () => { dragRef.current = null; setDragging(false); };

    const style = {
      position: "fixed",
      left: pet.pos ? pet.pos.left + "px" : undefined,
      top: pet.pos ? pet.pos.top + "px" : undefined,
      right: pet.pos ? undefined : 24,
      bottom: pet.pos ? undefined : 16,
      zIndex: 9991,
    };
    return react.createElement("div", {
      className: "dp-pet",
      style: style,
      title: pet.name,
      onPointerDown: onPointerDown,
      onPointerMove: onPointerMove,
      onPointerUp: onPointerUp,
      onPointerEnter: onPointerEnter,
      onPointerLeave: onPointerLeave,
      onPointerCancel: onPointerCancel,
    },
      bubble !== null ? react.createElement("div", { className: "dp-bubble", key: "bubble" }, bubble) : null,
      react.createElement(PetSpriteRenderer, { pet: pet, mode: mode, lookDir: lookDir }),
    );
  }

  function Overlay() {
    const st = useStore();
    react.useEffect(() => {
      let alive = true;
      const sync = async () => {
        try {
          const res = await fetch("/ronaldo-pet/state");
          if (!alive || !res.ok) return;
          const s = await res.json();
          const seq = typeof s.seq === "number" ? s.seq : 0;
          if (seq !== lastSeq) {
            lastSeq = seq;
            setState({ hostMode: String(s.mode || "idle") });
          }
        } catch (e) { /* 宿主未就绪时保持空闲 */ }
      };
      sync();
      const timer = window.setInterval(sync, 400);
      return () => { alive = false; window.clearInterval(timer); };
    }, []);
    const visible = st.pets.filter((p) => p.visible);
    return react.createElement("div", { className: "dp-overlay" },
      visible.map((p) => react.createElement(PetSprite, { key: p.id, pet: p, hostMode: st.hostMode }))
    );
  }

  function ImportPanel() {
    const ds = react.useState(""); const dir = ds[0]; const setDir = ds[1];
    const ips = react.useState(""); const imgPath = ips[0]; const setImgPath = ips[1];
    const cs = react.useState("8"); const cols = cs[0]; const setCols = cs[1];
    const rs = react.useState("11"); const rows = rs[0]; const setRows = rs[1];
    const ws = react.useState("192"); const cellW = ws[0]; const setCellW = ws[1];
    const hs = react.useState("208"); const cellH = hs[0]; const setCellH = hs[1];
    const fs = react.useState(""); const frames = fs[0]; const setFrames = fs[1];
    const ms = react.useState(null); const msg = ms[0]; const setMsg = ms[1];
    const bs = react.useState(false); const busy = bs[0]; const setBusy = bs[1];

    const doCodexImport = () => {
      const d = dir.trim();
      if (!d) { setMsg("请输入 codex 项目目录路径"); return; }
      setBusy(true); setMsg("导入中…");
      rpc("import-codex", { dir: d }).then((res) => {
        setBusy(false);
        if (res && res.ok) { addImportedPet(res); setMsg("✅ 导入成功：" + (res.name || "宠物")); }
        else { setMsg("❌ 导入失败：" + (res && res.error ? res.error : "未知错误")); }
      });
    };
    const doImageImport = () => {
      const p = imgPath.trim();
      if (!p) { setMsg("请输入 spritesheet 图片路径"); return; }
      const c = parseInt(cols, 10) || 8;
      const r = parseInt(rows, 10) || 11;
      const cw = parseInt(cellW, 10) || 192;
      const ch = parseInt(cellH, 10) || 208;
      let fpr = null;
      if (frames.trim()) fpr = frames.split(",").map((x) => parseInt(x, 10) || 0);
      setBusy(true); setMsg("导入中…");
      rpc("import-image", { path: p, cols: c, rows: r, cellW: cw, cellH: ch, framesPerRow: fpr }).then((res) => {
        setBusy(false);
        if (res && res.ok) { addImportedPet({ name: "宠物", sheet: res.sheet, states: res.states }); setMsg("✅ 导入成功"); }
        else { setMsg("❌ 导入失败：" + (res && res.error ? res.error : "未知错误")); }
      });
    };

    return react.createElement("div", { className: "dp-import" },
      react.createElement("h3", { className: "dp-import-title" }, "📥 导入宠物"),
      react.createElement("div", { className: "dp-import-row" },
        react.createElement("label", { className: "dp-label" }, "方式一：从 codex 项目目录导入（自动读取 final/spritesheet-extended.webp + pet_request.json）"),
        react.createElement("div", { className: "dp-import-line" },
          react.createElement("input", { className: "dp-input", value: dir, onChange: (e) => setDir(e.target.value), placeholder: "例如 D:\\代码\\codex-project" }),
          react.createElement("button", { type: "button", className: "dp-btn dp-btn-primary", onClick: doCodexImport, disabled: busy }, "导入目录")
        )
      ),
      react.createElement("div", { className: "dp-import-divider" }, "— 或手动指定 spritesheet —"),
      react.createElement("div", { className: "dp-import-row" },
        react.createElement("label", { className: "dp-label" }, "spritesheet 图片路径（本机绝对路径）"),
        react.createElement("input", { className: "dp-input", value: imgPath, onChange: (e) => setImgPath(e.target.value), placeholder: "例如 D:\\pets\\my-pet.png" })
      ),
      react.createElement("div", { className: "dp-import-grid" },
        react.createElement("div", { className: "dp-import-field" }, react.createElement("label", { className: "dp-label" }, "列数"), react.createElement("input", { className: "dp-input", value: cols, onChange: (e) => setCols(e.target.value) })),
        react.createElement("div", { className: "dp-import-field" }, react.createElement("label", { className: "dp-label" }, "行数"), react.createElement("input", { className: "dp-input", value: rows, onChange: (e) => setRows(e.target.value) })),
        react.createElement("div", { className: "dp-import-field" }, react.createElement("label", { className: "dp-label" }, "格宽 px"), react.createElement("input", { className: "dp-input", value: cellW, onChange: (e) => setCellW(e.target.value) })),
        react.createElement("div", { className: "dp-import-field" }, react.createElement("label", { className: "dp-label" }, "格高 px"), react.createElement("input", { className: "dp-input", value: cellH, onChange: (e) => setCellH(e.target.value) }))
      ),
      react.createElement("div", { className: "dp-import-row" },
        react.createElement("label", { className: "dp-label" }, "每行帧数（可选，逗号分隔，如 6,8,8,4,5,8,6,6,6；留空 = 每行满帧）"),
        react.createElement("input", { className: "dp-input", value: frames, onChange: (e) => setFrames(e.target.value), placeholder: "留空 = 每行满帧" })
      ),
      react.createElement("div", { className: "dp-import-line" },
        react.createElement("button", { type: "button", className: "dp-btn dp-btn-primary", onClick: doImageImport, disabled: busy }, "导入图片"),
        msg !== null ? react.createElement("span", { className: "dp-import-msg" }, msg) : null
      ),
      react.createElement("p", { className: "dp-import-hint" }, "状态按行号约定：0=待机 · 1=右跑 · 2=左跑 · 3=挥手 · 4=跳跃(成功) · 5=摔倒(失败) · 6=等待 · 7=颠球(对话中) · 8=思考 · 9-10=视线(可选)。")
    );
  }

  function PetCard(props) {
    const pet = props.pet;
    const info = pet.sheet ? (pet.sheet.cols + "×" + pet.sheet.rows + " · " + pet.sheet.cellW + "×" + pet.sheet.cellH + "px") : "";
    return react.createElement("div", { className: "dp-card" },
      react.createElement("div", { className: "dp-card-preview" }, react.createElement(PetSpriteRenderer, { pet: pet, mode: "idle", size: 60 })),
      react.createElement("div", { className: "dp-card-body" },
        react.createElement("div", { className: "dp-row" },
          react.createElement("label", { className: "dp-label" }, "名字"),
          react.createElement("input", { className: "dp-input", value: pet.name, onChange: (e) => updatePet(pet.id, { name: e.target.value }), placeholder: "给宠物起个名字" })
        ),
        react.createElement("div", { className: "dp-row" },
          react.createElement("label", { className: "dp-label" }, "平时行为"),
          react.createElement("div", { className: "dp-seg" },
            BEHAVIOR_OPTIONS.map((bb) => react.createElement("button", {
              key: bb.value,
              type: "button",
              className: "dp-seg-btn" + (pet.behavior === bb.value ? " dp-seg-active" : ""),
              onClick: () => updatePet(pet.id, { behavior: bb.value }),
            }, bb.label))
          )
        ),
        react.createElement("div", { className: "dp-row" },
          react.createElement("label", { className: "dp-label" }, "大小" + (info ? "  ·  布局 " + info : "")),
          react.createElement("div", { className: "dp-slider-wrap" },
            react.createElement("input", { type: "range", min: 60, max: 220, value: pet.size, className: "dp-slider", onChange: (e) => updatePet(pet.id, { size: Number(e.target.value) }) }),
            react.createElement("span", { className: "dp-size-val" }, pet.size + "px")
          )
        ),
        react.createElement("div", { className: "dp-row dp-row-actions" },
          react.createElement("button", { type: "button", className: "dp-btn" + (pet.visible ? "" : " dp-btn-ghost"), onClick: () => updatePet(pet.id, { visible: !pet.visible }) }, pet.visible ? "👁 显示中" : "🙈 已隐藏"),
          react.createElement("button", { type: "button", className: "dp-btn", onClick: () => updatePet(pet.id, { pos: null }) }, "📍 复位"),
          react.createElement("button", { type: "button", className: "dp-btn dp-btn-danger", onClick: () => removePet(pet.id) }, "🗑 删除")
        )
      )
    );
  }

  function SettingsPage() {
    const st = useStore();
    const visibleCount = st.pets.filter((p) => p.visible).length;
    return react.createElement("div", { className: "dp-settings" },
      react.createElement("div", { className: "dp-head" },
        react.createElement("h2", { className: "dp-title" }, "⚽ C罗桌宠 · 统一管理"),
        react.createElement("p", { className: "dp-sub" }, "内置葡萄牙 7 号 C罗；支持导入自定义 spritesheet 精灵图（codex 项目一键导入），命名、大小、行为、显隐、位置统一管理。对话中颠球，完成 SIU 庆祝 + 提示音，出错摔倒。")
      ),
      react.createElement(ImportPanel),
      react.createElement("div", { className: "dp-toolbar" },
        react.createElement("button", { type: "button", className: "dp-btn", onClick: () => setAllVisible(true) }, "全部显示"),
        react.createElement("button", { type: "button", className: "dp-btn", onClick: () => setAllVisible(false) }, "全部隐藏"),
        react.createElement("span", { className: "dp-count" }, "共 " + st.pets.length + " 只 · 显示 " + visibleCount + " 只")
      ),
      react.createElement("div", { className: "dp-list" },
        st.pets.length === 0
          ? react.createElement("div", { className: "dp-empty" }, "还没有宠物，在上方导入一个吧~")
          : st.pets.map((p) => react.createElement(PetCard, { key: p.id, pet: p }))
      )
    );
  }

  const CSS = [
    ".dp-overlay{position:fixed;inset:0;pointer-events:none;z-index:9990}",
    ".dp-pet{position:fixed;pointer-events:auto;cursor:grab;user-select:none;-webkit-user-select:none;z-index:9991;display:flex;flex-direction:column;align-items:center;touch-action:none}",
    ".dp-pet:active{cursor:grabbing}",
    ".dp-ronaldo{display:block;filter:drop-shadow(0 4px 8px rgba(0,0,0,.18))}",
    ".dp-bubble{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:8px;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#222);border:1px solid var(--dsw-alias-border-l1,#e5e5e5);border-radius:12px;padding:6px 12px;font-size:13px;white-space:nowrap;box-shadow:0 8px 24px rgba(0,0,0,.14);animation:dp-rise .18s ease-out}",
    ".dp-bubble::after{content:'';position:absolute;top:100%;left:50%;transform:translateX(-50%);border:6px solid transparent;border-top-color:var(--dsw-alias-bg-overlay,#fff)}",
    "@keyframes dp-rise{from{opacity:0;transform:translateX(-50%) translateY(6px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}",
    ".dp-settings{padding:8px 4px 32px;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary,#222)}",
    ".dp-head{display:flex;flex-direction:column;gap:4px}",
    ".dp-title{margin:0;font-size:18px;font-weight:650}",
    ".dp-sub{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary,#666);line-height:1.5}",
    ".dp-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
    ".dp-count{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary,#666)}",
    ".dp-list{display:flex;flex-direction:column;gap:12px}",
    ".dp-empty{padding:40px 16px;text-align:center;color:var(--dsw-alias-label-secondary,#666);border:1px dashed var(--dsw-alias-border-l2,#ccc);border-radius:12px;font-size:13px}",
    ".dp-card{display:flex;gap:16px;padding:16px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e5e5);border-radius:12px}",
    ".dp-card-preview{display:flex;align-items:center;justify-content:center;min-width:88px;min-height:88px;background:var(--dsw-alias-bg-layer-2,#f5f5f5);border-radius:10px;overflow:hidden}",
    ".dp-card-body{flex:1;display:flex;flex-direction:column;gap:12px}",
    ".dp-row{display:flex;flex-direction:column;gap:6px}",
    ".dp-label{font-size:12px;color:var(--dsw-alias-label-secondary,#666)}",
    ".dp-input{padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d0d0d0);background:var(--dsw-alias-bg-layer-2,#fafafa);color:var(--dsw-alias-label-primary,#222);font-size:13px}",
    ".dp-input:focus{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:1px;border-color:transparent}",
    ".dp-seg{display:flex;flex-wrap:wrap;gap:6px}",
    ".dp-seg-btn{padding:6px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d0d0d0);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#222);font-size:12px;cursor:pointer}",
    ".dp-seg-active{background:var(--dsw-alias-brand-primary,#4f6ef7);border-color:transparent;color:#fff}",
    ".dp-slider-wrap{display:flex;align-items:center;gap:10px}",
    ".dp-slider{flex:1;accent-color:var(--dsw-alias-brand-primary,#4f6ef7)}",
    ".dp-size-val{font-size:12px;color:var(--dsw-alias-label-secondary,#666);min-width:44px;text-align:right}",
    ".dp-row-actions{flex-direction:row;flex-wrap:wrap;gap:8px;margin-top:2px}",
    ".dp-btn{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d0d0d0);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#222);font-size:13px;cursor:pointer;transition:opacity .15s}",
    ".dp-btn:hover{opacity:.85}",
    ".dp-btn:disabled{opacity:.5;cursor:not-allowed}",
    ".dp-btn-primary{background:var(--dsw-alias-brand-primary,#4f6ef7);border-color:transparent;color:#fff}",
    ".dp-btn-danger{color:var(--dsw-alias-state-error-primary,#d64545)}",
    ".dp-btn-ghost{opacity:.55}",
    ".dp-import{display:flex;flex-direction:column;gap:10px;padding:14px;background:var(--dsw-alias-bg-layer-2,#f5f5f5);border:1px solid var(--dsw-alias-border-l1,#e5e5e5);border-radius:12px}",
    ".dp-import-title{margin:0;font-size:14px;font-weight:650}",
    ".dp-import-row{display:flex;flex-direction:column;gap:6px}",
    ".dp-import-line{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
    ".dp-import-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}",
    ".dp-import-field{display:flex;flex-direction:column;gap:6px}",
    ".dp-import-divider{font-size:12px;color:var(--dsw-alias-label-secondary,#666);text-align:center;margin:2px 0}",
    ".dp-import-msg{font-size:12px;color:var(--dsw-alias-state-success-primary,#2e9e44)}",
    ".dp-import-hint{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary,#666);line-height:1.5}",
  ].join("");

  function apply(ctx) {
    const styleEl = document.createElement("style");
    styleEl.id = "dsh-ronaldo-pet-styles";
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
    ctx.effect(() => () => { styleEl.remove(); });

    ctx.slots.inject("settings.section", () => ctx.slots.register(
      { name: "settings.section", id: "ronaldo-pet", order: 30, label: "⚽ 桌宠" },
      () => react.createElement(SettingsPage),
    ));
    ctx.slots.inject("shell.overlay", () => ctx.slots.register(
      { name: "shell.overlay", id: "ronaldo-pet", order: 100, label: "C罗桌宠" },
      () => react.createElement(Overlay),
    ));
  }

  exports.apply = apply;
  exports.inject = inject;
  exports.name = name;
  return module.exports;
}});
