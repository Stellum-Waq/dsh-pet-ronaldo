window.__ModuleLoader__.load({ id: "dsh-ronaldo-pet", factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  let react = require("react");

  const name = "dsh-ronaldo-pet";
  const inject = ["slots"];

  // 宿主状态模式 → 动画状态名
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
    { value: "runRight", label: "🏃 向右跑" },
    { value: "runLeft", label: "🏃 向左跑" },
    { value: "waving", label: "👋 挥手" },
    { value: "jumping", label: "🎉 跳跃" },
    { value: "failed", label: "😵 摔倒" },
    { value: "waiting", label: "⏳ 等待" },
    { value: "running", label: "⚡ 专注工作" },
    { value: "review", label: "🤔 思考" },
    { value: "look", label: "👀 注视光标" },
  ];
  const FALLBACK_PHRASES = ["你好呀！", "需要我做什么？", "我在这儿~"];
  const FALLBACK_DIVE = ["哎哟！", "别戳我啦！"];

  // ---------- 与宿主对话（同源 HTTP，见 host.js 的路由） ----------
  const rpc = (path, body) =>
    fetch("/ronaldo-pet/" + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    })
      .then((r) => r.json())
      .catch((err) => ({ ok: false, error: String((err && err.message) || err) }));

  // ---------- 轻量 store ----------
  let state = {
    pets: [],
    hostMode: "idle",
    revision: -1,
    settings: { audioMode: "primary", systemSound: true, defaultPet: null, displayMode: "auto", desktopSize: 0 },
    // 桌面原生窗口是否在跑 —— 在跑时网页默认不再显示同一只（避免两处重复出现）
    desktopRunning: false,
    hostOnline: false,
    lastError: null,
    loading: true,
  };
  let lastSeq = -1;
  const listeners = new Set();

  const getState = () => state;
  const subscribe = (fn) => {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  };
  const notify = () => {
    listeners.forEach((fn) => { try { fn(); } catch (e) { /* 单个订阅者出错不影响其它 */ } });
  };
  const setState = (patch) => { state = Object.assign({}, state, patch); notify(); };

  const patchPetLocal = (id, patch) => {
    state = Object.assign({}, state, {
      pets: state.pets.map((p) => (p.id === id ? Object.assign({}, p, patch) : p)),
    });
    notify();
  };

  // 拖动/改名这类高频操作：本地立即反映，网络写盘做防抖
  const pendingWrites = new Map();
  const patchPet = (id, patch, immediate) => {
    patchPetLocal(id, patch);
    const prev = pendingWrites.get(id);
    if (prev) clearTimeout(prev.timer);
    const send = () => {
      pendingWrites.delete(id);
      rpc("pets/update", { id, patch }).catch(() => {});
    };
    if (immediate) send();
    else pendingWrites.set(id, { timer: setTimeout(send, 500), patch });
  };

  const refreshPets = async () => {
    try {
      const res = await fetch("/ronaldo-pet/pets");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (!data || !data.ok) throw new Error((data && data.error) || "返回异常");
      setState({
        pets: mergeLocal(data.pets || []),
        revision: data.revision,
        settings: data.settings || state.settings,
        hostOnline: true,
        loading: false,
        lastError: null,
      });
    } catch (err) {
      setState({ hostOnline: false, loading: false, lastError: String((err && err.message) || err) });
    }
  };

  // 保留页面上尚未落盘的本地状态（拖动位置、改名），避免刷新被覆盖
  const mergeLocal = (incoming) => {
    const byId = new Map(state.pets.map((p) => [p.id, p]));
    return incoming.map((p) => {
      const local = byId.get(p.id);
      if (!local || pendingWrites.has(p.id)) return p;
      return p;
    });
  };

  const removePet = async (id) => {
    const pet = state.pets.find((p) => p.id === id);
    if (pet && pet.builtin && !window.confirm("确定要移除内置的「" + pet.name + "」吗？重启后不会自动恢复，可用设置里的按钮加回来。")) return;
    if (pet && !pet.builtin && !window.confirm("确定要移除「" + pet.name + "」吗？（只取消注册，不会删除磁盘上的宠物包）")) return;
    setState({ pets: state.pets.filter((p) => p.id !== id) });
    await rpc("pets/unregister", { id });
    refreshPets();
  };

  const useStore = () => {
    const pair = react.useState(0);
    const setTick = pair[1];
    react.useEffect(() => subscribe(() => setTick((t) => t + 1)), []);
    return getState();
  };

  // ---------- 取帧 ----------
  const framePos = (col, row, cols, rows) => {
    const px = cols > 1 ? (col * 100) / (cols - 1) : 0;
    const py = rows > 1 ? (row * 100) / (rows - 1) : 0;
    return px + "% " + py + "%";
  };

  const spriteStyle = (pet, size) => {
    const sheet = pet.sheet || {};
    const cols = sheet.cols || 8;
    const rows = sheet.rows || 11;
    const cellW = sheet.cellW || 192;
    const cellH = sheet.cellH || 208;
    // 分辨率和缩放无关：这里按格子数用百分比铺背景，素材画多大都能等比缩放。
    // 唯一的画质开关是 image-rendering —— 高分辨率/写实素材缩小时要用浏览器的
    // 平滑重采样，像素风素材则必须关掉（否则边缘被糊成一团）。
    // 作者在 pet.json 里用 sheet.scaling: "pixelated" | "smooth" 指定。
    const pixelated = sheet.scaling === "pixelated" || sheet.scaling === "nearest";
    return {
      width: size + "px",
      height: Math.round((size * cellH) / cellW) + "px",
      backgroundImage: sheet.url ? 'url("' + sheet.url + '")' : undefined,
      backgroundSize: cols * 100 + "% " + rows * 100 + "%",
      backgroundRepeat: "no-repeat",
      imageRendering: pixelated ? "pixelated" : "auto",
    };
  };

  /** 决定当前应显示哪一格（含 3D 环视 look.angles 支持）。 */
  const resolveCell = (pet, animName, frame, lookDir) => {
    const states = pet.states || {};
    if (animName === "look") {
      const lk = states.look;
      if (lk && Array.isArray(lk.angles) && lk.angles.length > 0) {
        // 3D 环视：16 档光标方向映射到 N 个渲染角度
        const idx = Math.round(((lookDir % 16) + 16) % 16 / 16 * lk.angles.length) % lk.angles.length;
        const a = lk.angles[idx] || lk.angles[0];
        return { row: a.row, col: a.col };
      }
      if (lk && Array.isArray(lk.rows) && lk.rows.length >= 2) {
        return lookDir < 8 ? { row: lk.rows[0], col: lookDir } : { row: lk.rows[1], col: lookDir - 8 };
      }
      const idle = states.idle || { row: 0 };
      return { row: idle.row || 0, col: 0 };
    }
    const st = states[animName] || states.idle || { row: 0, frames: 1 };
    return { row: st.row || 0, col: frame % (st.frames || 1) };
  };

  function PetSprite(props) {
    const pet = props.pet;
    const hostMode = props.hostMode;
    const docked = props.docked;
    const s0 = react.useState(0); const frame = s0[0]; const setFrame = s0[1];
    const h = react.useState(false); const hover = h[0]; const setHover = h[1];
    const l = react.useState(0); const lookDir = l[0]; const setLookDir = l[1];
    const d1 = react.useState(false); const dragging = d1[0]; const setDragging = d1[1];
    const d2 = react.useState("running"); const dragDir = d2[0]; const setDragDir = d2[1];
    const b = react.useState(null); const bubble = b[0]; const setBubble = b[1];
    const dv = react.useState(false); const diving = dv[0]; const setDiving = dv[1];
    const ct = react.useState([]); const clickTimes = ct[0]; const setClickTimes = ct[1];
    const dragRef = react.useRef(null);
    const bootRef = react.useRef(false);
    const audioRef = react.useRef({});

    const playSfx = react.useCallback((key) => {
      const entry = (pet.audio || {})[key];
      if (!entry || !entry.url) return;
      try {
        let a = audioRef.current[key];
        if (!a) { a = new window.Audio(entry.url); audioRef.current[key] = a; }
        a.currentTime = 0;
        a.play().catch(() => {});
      } catch (e) { /* 浏览器可能要求先交互 */ }
    }, [pet.audio]);

    // 登场音：每只宠物、每个页面生命周期只播一次
    react.useEffect(() => {
      if (bootRef.current) return;
      bootRef.current = true;
      const key = (pet.interactions || {}).boot;
      if (!key) return;
      const t = window.setTimeout(() => playSfx(key), 600);
      return () => window.clearTimeout(t);
    }, [pet.id, pet.interactions, playSfx]);

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

    const resolveAnim = () => {
      if (dragging) return dragDir || "running";
      if (diving) return "failed";
      const st = pet.states || {};
      const hasLook = st.look && (st.look.angles || st.look.rows);
      if (hover && hasLook) return "look";
      if (hostMode && hostMode !== "idle") return HOST_ANIM[hostMode] || "idle";
      return pet.behavior || "idle";
    };
    const anim = resolveAnim();
    const st = (pet.states || {})[anim] || (pet.states || {}).idle || { frames: 1, fps: 6 };
    const frameCount = anim === "look" ? 1 : (st.frames || 1);
    const fps = st.fps || 8;

    // 帧循环
    react.useEffect(() => {
      setFrame(0);
      if (frameCount <= 1) return undefined;
      let f = 0;
      const timer = window.setInterval(() => {
        f = (f + 1) % frameCount;
        setFrame(f);
      }, Math.max(40, Math.round(1000 / fps)));
      return () => window.clearInterval(timer);
    }, [anim, frameCount, fps, pet.id]);

    const onPointerDown = (e) => {
      if (typeof e.button === "number" && e.button !== 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      dragRef.current = { startX: e.clientX, startY: e.clientY, originLeft: rect.left, originTop: rect.top, moved: false };
      setDragging(true);
      setDragDir("running");
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    };
    const onPointerMove = (e) => {
      const d = dragRef.current;
      if (d !== null) {
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
        if (dx > 4) setDragDir("runRight");
        else if (dx < -4) setDragDir("runLeft");
        else setDragDir("running");
        patchPet(pet.id, { pos: { left: Math.round(d.originLeft + dx), top: Math.round(d.originTop + dy) } });
        return;
      }
      if (hover) {
        const rect = e.currentTarget.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = e.clientX - cx;
        const dy = e.clientY - cy;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
          let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
          if (deg < 0) deg += 360;
          setLookDir(Math.round(deg / 22.5) % 16);
        }
      }
    };
    const onPointerUp = (e) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (d !== null && d.moved) return;
      const now = Date.now();
      const recent = clickTimes.filter((t) => now - t < 1500);
      recent.push(now);
      setClickTimes(recent);
      const iv = pet.interactions || {};
      if (recent.length >= 3) {
        setClickTimes([]);
        setDiving(true);
        const phrases = (pet.divePhrases && pet.divePhrases.length) ? pet.divePhrases : FALLBACK_DIVE;
        setBubble(phrases[Math.floor(Math.random() * phrases.length)]);
        if (iv.tripleClick) playSfx(iv.tripleClick);
      } else {
        const phrases = (pet.phrases && pet.phrases.length) ? pet.phrases : FALLBACK_PHRASES;
        setBubble(phrases[Math.floor(Math.random() * phrases.length)]);
        if (iv.click) playSfx(iv.click);
      }
    };

    const cell = resolveCell(pet, anim, frame, lookDir);
    const size = props.size || pet.size || 120;
    const style = Object.assign(spriteStyle(pet, size), {
      backgroundPosition: framePos(cell.col, cell.row, pet.sheet.cols || 8, pet.sheet.rows || 11),
    });

    const wrapStyle = docked
      ? { position: "relative", pointerEvents: "auto" }
      : {
          position: "fixed",
          left: (pet.pos && pet.pos.left) + "px",
          top: (pet.pos && pet.pos.top) + "px",
          zIndex: 9991,
        };

    return react.createElement(
      "div",
      {
        className: "dp-pet",
        style: wrapStyle,
        title: pet.name + "（拖动移动 · 连点 3 次有惊喜）",
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerEnter: () => setHover(true),
        onPointerLeave: () => setHover(false),
        onPointerCancel: () => { dragRef.current = null; setDragging(false); },
        onDoubleClick: () => patchPet(pet.id, { pos: null }, true),
      },
      bubble !== null ? react.createElement("div", { className: "dp-bubble", key: "bubble" }, bubble) : null,
      react.createElement("div", { className: "dp-sprite", style }),
    );
  }

  // ---------- 打开页面就把桌面宠物拉起来 ----------
  //
  // 用户要的是"一运行 dsh 终端，桌宠就出现在桌面上"，而不是先点进设置面板再按
  // 「启动」。所以页面一加载就替用户发一次 start。
  //
  // 两个刻意的限制：
  //   1) 每次加载只发一次。宿主的启动方式本身有好几层回退（shell → spawn → …），
  //      重试是它的职责；这里反复调用只会把同一只宠物拉起好几遍。
  //   2) 用户显式按过「停止」之后就不再自动拉起（记在 localStorage 里）。
  //      否则关掉桌宠、刷新一下页面它又自己回来了。
  const DESKTOP_OPT_OUT_KEY = "dsh-pet-desktop-opt-out";
  let desktopAutoStartTried = false;

  function useDesktopAutoStart() {
    react.useEffect(() => {
      if (desktopAutoStartTried) return undefined;
      desktopAutoStartTried = true;
      try { if (window.localStorage.getItem(DESKTOP_OPT_OUT_KEY) === "1") return undefined; } catch (e) { /* 隐私模式：照常启动 */ }
      let alive = true;
      const go = async () => {
        try {
          const res = await fetch("/ronaldo-pet/desktop", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "start" }),
          });
          if (!alive || !res.ok) return;
          const j = await res.json().catch(() => null);
          if (j && j.running === true) setState({ desktopRunning: true });
        } catch (e) { /* 宿主还没监听端口，下次打开页面再说 */ }
      };
      // 稍微等一下：桌面宠物要把 base URL 传给宿主，宿主得先把端口监听起来
      const timer = window.setTimeout(go, 1500);
      return () => { alive = false; window.clearTimeout(timer); };
    }, []);
  }

  function Overlay() {
    const st = useStore();
    useDesktopAutoStart();
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
          // 桌面原生窗口的运行状态：影响"要不要在网页里再画一遍"
          const dr = !!(s.desktop && s.desktop.running);
          if (dr !== state.desktopRunning) setState({ desktopRunning: dr });
          // 注册表变了（比如刚用技能装了一只新宠物）→ 立刻拉取，无需刷新页面
          if (typeof s.revision === "number" && s.revision !== state.revision) refreshPets();
        } catch (e) { /* 宿主未就绪时保持空闲 */ }
      };
      sync();
      const timer = window.setInterval(sync, 500);
      return () => { alive = false; window.clearInterval(timer); };
    }, []);

    react.useEffect(() => {
      refreshPets();
      const timer = window.setInterval(() => { if (!state.hostOnline) refreshPets(); }, 5000);
      return () => window.clearInterval(timer);
    }, []);

    // 「显示位置」= auto 时，桌面原生窗口正在显示的那只就不在网页里再画一遍，
    // 否则同一只宠物会同时出现在网页右下角和电脑桌面上，看着像重复了。
    const defaultPetId = st.settings && st.settings.defaultPet;
    const desktopOwnsDefault = st.settings && st.settings.displayMode === "auto" && st.desktopRunning === true;
    const visible = st.pets.filter((p) =>
      p.visible !== false && !p.broken && !(desktopOwnsDefault && defaultPetId && p.id === defaultPetId),
    );
    const docked = visible.filter((p) => !p.pos);
    const floating = visible.filter((p) => p.pos);

    return react.createElement(
      "div",
      { className: "dp-overlay" },
      floating.map((p) => react.createElement(PetSprite, { key: p.id, pet: p, hostMode: st.hostMode, size: p.size })),
      react.createElement(
        "div",
        { className: "dp-dock", style: { display: docked.length ? "flex" : "none" } },
        docked.map((p) => react.createElement(PetSprite, { key: p.id, pet: p, hostMode: st.hostMode, size: p.size, docked: true })),
      ),
    );
  }

  // ---------- 设置面板 ----------
  function PetCard(props) {
    const pet = props.pet;
    const isDefault = props.isDefault === true;
    const sheet = pet.sheet || {};
    const info = sheet.cols ? sheet.cols + "×" + sheet.rows + " · " + sheet.cellW + "×" + sheet.cellH + "px" : "";
    const actions = Object.keys(pet.states || {});
    const audioKeys = Object.keys(pet.audio || {});
    const preview = react.createElement("div", {
      className: "dp-card-preview",
    }, react.createElement("div", {
      className: "dp-sprite",
      style: Object.assign(spriteStyle(pet, 56), { backgroundPosition: framePos(0, (pet.states && pet.states.idle && pet.states.idle.row) || 0, sheet.cols || 8, sheet.rows || 11) }),
    }));

    return react.createElement(
      "div",
      { className: "dp-card" + (isDefault ? " dp-card-default" : (pet.visible === false ? " dp-card-off" : "")) },
      preview,
      react.createElement(
        "div",
        { className: "dp-card-body" },
        pet.broken
          ? react.createElement("div", { className: "dp-import-msg dp-err" }, "⚠️ 该宠物包读取失败：" + (pet.error || "未知错误"))
          : null,
        react.createElement(
          "div",
          { className: "dp-row" },
          react.createElement("label", { className: "dp-label" }, isDefault ? "名字 · ⭐ 默认打开的桌宠" : "名字"),
          react.createElement("input", {
            className: "dp-input",
            value: pet.name || "",
            onChange: (e) => patchPet(pet.id, { name: e.target.value }),
          }),
        ),
        react.createElement(
          "div",
          { className: "dp-meta" },
          react.createElement("span", null, "id: " + pet.id),
          isDefault ? react.createElement("span", { className: "dp-tag dp-tag-default" }, "⭐ 默认") : null,
          pet.builtin ? react.createElement("span", { className: "dp-tag" }, "内置") : null,
          pet.yaw ? react.createElement("span", { className: "dp-tag" }, "3D 环视 ×" + (pet.yaw.count || 0)) : null,
          react.createElement("span", null, "动作: " + (actions.length ? actions.join("/") : "无")),
          react.createElement("span", null, "音效: " + (audioKeys.length ? audioKeys.join("/") : "无")),
          info ? react.createElement("span", null, "图集: " + info) : null,
        ),
        !pet.broken
          ? react.createElement(
              "div",
              { className: "dp-row" },
              react.createElement("label", { className: "dp-label" }, "平时行为"),
              react.createElement(
                "div",
                { className: "dp-seg" },
                BEHAVIOR_OPTIONS.filter((b) => !pet.states || pet.states[b.value] || b.value === "idle").map((bb) =>
                  react.createElement(
                    "button",
                    {
                      key: bb.value,
                      type: "button",
                      className: "dp-seg-btn" + (pet.behavior === bb.value ? " dp-seg-active" : ""),
                      onClick: () => patchPet(pet.id, { behavior: bb.value }, true),
                    },
                    bb.label,
                  ),
                ),
              ),
            )
          : null,
        react.createElement(
          "div",
          { className: "dp-row" },
          react.createElement("label", { className: "dp-label" }, "大小"),
          react.createElement(
            "div",
            { className: "dp-slider-wrap" },
            react.createElement("input", {
              type: "range",
              min: 60,
              max: 240,
              value: pet.size || 120,
              className: "dp-slider",
              onChange: (e) => patchPet(pet.id, { size: Number(e.target.value) }),
            }),
            react.createElement("span", { className: "dp-size-val" }, (pet.size || 120) + "px"),
          ),
        ),
        react.createElement(
          "div",
          { className: "dp-row dp-row-actions" },
          isDefault
            ? react.createElement("span", { className: "dp-default-badge" }, "⭐ 默认打开的桌宠")
            : react.createElement(
                "button",
                {
                  type: "button",
                  className: "dp-btn dp-btn-primary",
                  disabled: pet.broken === true,
                  title: "设为默认打开的桌宠（其它会自动收起，避免一次开太多只）",
                  onClick: () => props.onMakeDefault(pet.id),
                },
                "⭐ 设为默认",
              ),
          react.createElement(
            "button",
            { type: "button", className: "dp-btn" + (pet.visible === false ? " dp-btn-ghost" : ""), onClick: () => patchPet(pet.id, { visible: pet.visible === false }, true) },
            pet.visible === false ? "🙈 已隐藏" : "👁 显示中",
          ),
          react.createElement(
            "button",
            {
              type: "button",
              className: "dp-btn" + (pet.sound === false ? " dp-btn-ghost" : ""),
              onClick: () => patchPet(pet.id, { sound: pet.sound === false }, true),
              title: "宿主进程用系统播放器出声，不受浏览器静音影响",
            },
            pet.sound === false ? "🔇 静音" : "🔊 系统音开",
          ),
          react.createElement("button", { type: "button", className: "dp-btn", onClick: () => patchPet(pet.id, { pos: null }, true) }, "📍 复位"),
          react.createElement("button", { type: "button", className: "dp-btn dp-btn-danger", onClick: () => removePet(pet.id) }, "🗑 移除"),
        ),
        react.createElement("div", { className: "dp-path", title: pet.dir }, pet.dir || ""),
      ),
    );
  }

  const SKILL_HINT = [
    "一句话生成：在对话里说「用 dsh-pet-forge 帮我做一只 XX 桌宠」即可，",
    "技能会先问你画风 / 要哪些动作 / 要哪些音效，然后自动生图 → 合成图集 → 生成音效 → 注册进来。",
    "3D 路线会调用 Blender 建模并渲染环视帧，还能导出 model/pet.glb。",
  ].join("");

  // ---------- 原生桌面窗口 ----------
  function DesktopPanel() {
    const ds = react.useState(null); const info = ds[0]; const setInfo = ds[1];
    const bs = react.useState(false); const busy = bs[0]; const setBusy = bs[1];
    const ms = react.useState(null); const msg = ms[0]; const setMsg = ms[1];

    const refresh = react.useCallback(() => {
      rpc("desktop", { action: "status" }).then((r) => setInfo(r));
    }, []);

    react.useEffect(() => { refresh(); }, [refresh]);

    const setDesktopSize = react.useCallback((v) => {
      setBusy(true); setMsg("正在应用新尺寸…");
      rpc("settings", { patch: { desktopSize: v } }).then((r) => {
        setBusy(false);
        if (r && r.ok) { setMsg("✅ 尺寸已保存（桌面窗口会自动重开）"); } else { setMsg("❌ " + ((r && r.error) || "设置失败")); }
        setTimeout(refresh, 2500);
      });
    }, [refresh]);

    const setDisplayMode = react.useCallback((v) => {
      setBusy(true); setMsg(null);
      rpc("settings", { patch: { displayMode: v } }).then((r) => {
        setBusy(false);
        if (r && r.ok) {
          setInfo(Object.assign({}, info, { displayMode: v }));
          setMsg("✅ 已切换显示位置");
        } else { setMsg("❌ " + ((r && r.error) || "设置失败")); }
        setTimeout(refresh, 800);
      });
    }, [info, refresh]);

    const act = (action, extra) => {
      setBusy(true); setMsg(null);
      // 记住用户是不是"自己按过停止"：按过就别在下次打开页面时又自动把它拉起来。
      // （Overlay 里的 useDesktopAutoStart 会读这个标记）
      try {
        if (action === "stop") window.localStorage.setItem(DESKTOP_OPT_OUT_KEY, "1");
        if (action === "start") window.localStorage.removeItem(DESKTOP_OPT_OUT_KEY);
      } catch (e) { /* 隐私模式下忽略 */ }
      rpc("desktop", Object.assign({ action }, extra || {})).then((r) => {
        setBusy(false);
        if (r && r.ok) { setInfo(r); setMsg("✅ " + (action === "stop" ? "已关闭" : action === "start" ? "已启动" : "已更新")); }
        else { setMsg("❌ " + ((r && r.error) || "操作失败")); }
        setTimeout(refresh, 800);
      });
    };

    if (info === null) return react.createElement("div", { className: "dp-empty" }, "读取桌面窗口状态…");

    const running = info.running === true;
    const supported = info.supported !== false;
    const uptime = info.uptimeMs > 0 ? Math.round(info.uptimeMs / 1000) + " 秒" : "—";

    return react.createElement(
      "div",
      { className: "dp-import" },
      react.createElement("h3", { className: "dp-import-title" }, "🖥 原生桌面窗口"),
      react.createElement("p", { className: "dp-import-hint" },
        "把同一只宠物搬到真正的桌面上：无边框、背景透明、永远置顶。最小化甚至关掉网页它都还在，只要终端还在运行就一直存在。",
        react.createElement("br"),
        "· 悬停 → 显示当前工作区与对话名",
        react.createElement("br"),
        "· 双击 → 用 Edge 打开 Harness 网页",
        react.createElement("br"),
        "· 拖动移动 / 滚轮改大小 / 右键出菜单 / 单击冒台词 / 快速点三下摔跤",
      ),
      !supported
        ? react.createElement("div", { className: "dp-import-msg dp-err" }, "当前平台（" + info.platform + "）暂不支持原生桌面窗口，本功能仅实现了 Windows 版本。")
        : null,
      react.createElement(
        "div",
        { className: "dp-meta" },
        react.createElement("span", { className: running ? "dp-tag" : "dp-tag" }, running ? "运行中" : "未运行"),
        info.pid ? react.createElement("span", null, "PID: " + info.pid) : null,
        react.createElement("span", null, "已运行: " + uptime),
        react.createElement("span", null, "自启: " + (info.enabled ? "开" : "关")),
      ),
      react.createElement(
        "div",
        { className: "dp-row dp-row-actions" },
        react.createElement("button", {
          type: "button", className: "dp-btn dp-btn-primary", disabled: busy || !supported,
          onClick: () => act("start", running ? { restart: true } : {}),
        }, running ? "🔄 重启桌面窗口" : "▶ 启动桌面窗口"),
        react.createElement("button", {
          type: "button", className: "dp-btn", disabled: busy || !running,
          onClick: () => act("stop"),
        }, "⏹ 关闭"),
        react.createElement("button", {
          type: "button", className: "dp-btn" + (info.enabled ? "" : " dp-btn-ghost"), disabled: busy || !supported,
          onClick: () => act("enable", { enabled: !info.enabled }),
        }, info.enabled ? "🚀 开机自启：开" : "🚀 开机自启：关"),
        react.createElement("button", { type: "button", className: "dp-btn", disabled: busy, onClick: refresh }, "🔄 刷新"),
      ),
      react.createElement(
        "div",
        { className: "dp-row" },
        react.createElement("label", { className: "dp-label" },
          "桌面窗口大小：" + (info.size > 0 ? info.size + " DIP" : "自动（跟随素材分辨率）")),
        react.createElement(
          "div",
          { className: "dp-slider-wrap" },
          react.createElement("input", {
            // 上限放到 1024：写实/高分辨率素材按原来的 48..300 只能显示成一张小图。
            // 分辨率本身不设限，这里管的是"桌面上画多大"。
            type: "range", min: 32, max: 1024, step: 4,
            value: info.size > 0 ? info.size : 96,
            className: "dp-slider",
            disabled: busy,
            onChange: (e) => setInfo(Object.assign({}, info, { size: Number(e.target.value) })),
            onMouseUp: (e) => setDesktopSize(Number(e.target.value)),
            onTouchEnd: (e) => setDesktopSize(Number(e.target.value)),
            onKeyUp: (e) => setDesktopSize(Number(e.target.value)),
          }),
          react.createElement("button", {
            type: "button",
            className: "dp-btn dp-btn-ghost",
            disabled: busy || !(info.size > 0),
            onClick: () => setDesktopSize(0),
          }, "自动"),
        ),
        react.createElement("p", { className: "dp-import-hint" },
          "「自动」会让桌面宠物按素材每格的原生分辨率决定大小（作者按 2× 分辨率创作，"
          + "所以 1024px 一格会显示成 512 DIP，192px 一格显示成 96 DIP），写实素材因此不会变成一张小图。"
          + "它和网页里每只宠物的「大小」是两套：那个是页面元素的像素，这个（DIP）才是桌面窗口的。"
          + "在桌面上用滚轮或右键改大小，也会同步回这里。",
        ),
      ),
      react.createElement(
        "div",
        { className: "dp-row" },
        react.createElement("label", { className: "dp-label" }, "显示位置"),
        react.createElement(
          "div",
          { className: "dp-seg" },
          [
            { v: "auto", label: "🤖 智能：桌面在跑就只在桌面显示（推荐）" },
            { v: "both", label: "🔀 两处都显示" },
          ].map((o) => react.createElement("button", {
            key: o.v,
            type: "button",
            className: "dp-seg-btn" + ((info.displayMode || "auto") === o.v ? " dp-seg-active" : ""),
            disabled: busy,
            onClick: () => setDisplayMode(o.v),
          }, o.label)),
        ),
        react.createElement("p", { className: "dp-import-hint" },
          (info.displayMode || "auto") === "auto"
            ? "当前：桌面窗口开着时，网页右下角不再显示同一只（避免重复出现）；关掉桌面窗口后它自动回到网页。"
            : "当前：同一只宠物会同时出现在网页右下角和电脑桌面上。",
        ),
      ),
      msg !== null ? react.createElement("span", { className: "dp-import-msg" }, msg) : null,
      react.createElement("div", { className: "dp-path" }, "脚本：" + (info.script || "—") + (info.scriptExists === false ? "（❌ 不存在）" : "")),
      react.createElement("div", { className: "dp-path" }, "日志：" + (info.log || "—")),
      info.lastError
        ? react.createElement("div", { className: "dp-import-msg dp-err" }, "最近一次错误：" + info.lastError)
        : null,
      react.createElement("p", { className: "dp-import-hint" },
        "排查建议：如果状态显示「运行中」但屏幕上看不到宠物，在仓库里跑 ",
        react.createElement("code", null, "node scripts/verify-desktop.mjs --base " + location.origin),
        " —— 它会直接抓窗口内容并报告精灵有没有画出来。",
      ),
    );
  }

  function SettingsPage() {
    const st = useStore();
    const [tab, setTab] = react.useState("pets");
    const visibleCount = st.pets.filter((p) => p.visible !== false).length;

    react.useEffect(() => { refreshPets(); }, []);

    const makeDefault = async (id) => {
      await rpc("pets/update", { id, patch: { makeDefault: true } });
      refreshPets();
    };

    const defaultId = (st.settings && st.settings.defaultPet) || null;

    const petsTab = react.createElement(
      "div",
      null,
      react.createElement(
        "div",
        { className: "dp-toolbar" },
        react.createElement("button", {
          type: "button",
          className: "dp-btn",
          title: "把当前所有宠物都打开（同时养多只）",
          onClick: async () => {
            for (const p of st.pets) await rpc("pets/update", { id: p.id, patch: { visible: true } });
            refreshPets();
          },
        }, "全部打开"),
        react.createElement("button", {
          type: "button",
          className: "dp-btn",
          title: "只留默认的那只",
          onClick: async () => {
            for (const p of st.pets) await rpc("pets/update", { id: p.id, patch: { visible: p.id === defaultId } });
            refreshPets();
          },
        }, "只开默认"),
        react.createElement("button", { type: "button", className: "dp-btn", onClick: refreshPets }, "🔄 刷新"),
        react.createElement("span", { className: "dp-count" }, "共 " + st.pets.length + " 只 · 显示 " + visibleCount + " 只"),
      ),
      react.createElement("p", { className: "dp-import-hint" },
        "默认同一时间只开一只（⭐ 那只是「默认打开的桌宠」）。生成或注册新宠物时它会自动接管默认，"
        + "其它自动收起，免得右下角站一排。想同时养多只，点每只的「👁 显示中」或上面的「全部打开」。",
      ),
      react.createElement(
        "div",
        { className: "dp-row dp-row-actions dp-settings-line" },
        react.createElement("label", { className: "dp-label" }, "宿主提示音："),
        react.createElement("select", {
          className: "dp-input dp-select",
          value: (st.settings && st.settings.audioMode) || "primary",
          onChange: async (e) => {
            await rpc("settings", { patch: { audioMode: e.target.value } });
            refreshPets();
          },
        },
          react.createElement("option", { value: "primary" }, "只播第一只宠物（推荐，避免多宠物齐鸣）"),
          react.createElement("option", { value: "all" }, "所有宠物都播"),
        ),
        react.createElement("button", {
          type: "button",
          className: "dp-btn",
          onClick: async () => {
            await rpc("settings", { patch: { systemSound: !(st.settings && st.settings.systemSound) } });
            refreshPets();
          },
        }, (st.settings && st.settings.systemSound === false) ? "🔇 系统音已关" : "🔊 系统音已开"),
      ),
      st.pets.length === 0
        ? react.createElement("div", { className: "dp-empty" }, st.loading ? "加载中…" : "还没有宠物。用技能 dsh-pet-forge 一句话生成一只吧~")
        : react.createElement("div", { className: "dp-list" }, st.pets.map((p) => react.createElement(PetCard, { key: p.id, pet: p, isDefault: p.id === defaultId, onMakeDefault: makeDefault }))),
    );

    return react.createElement(
      "div",
      { className: "dp-settings" },
      react.createElement(
        "div",
        { className: "dp-head" },
        react.createElement("h2", { className: "dp-title" }, "⚽ 桌宠 · 统一管理"),
        react.createElement("p", { className: "dp-sub" },
          "支持多只宠物同时在场，各自独立动作、大小、位置与音效；设置跨重启保留（存在 DSH_HOME/storages/dsh-pet-forge/registry.json）。",
        ),
      ),
      st.hostOnline === false
        ? react.createElement("div", { className: "dp-import-msg dp-err" }, "⚠️ 宿主半未就绪：" + (st.lastError || "接口无响应") + "（请确认 dsh web 已加载 dsh-ronaldo-pet 插件）")
        : null,
      react.createElement(
        "div",
        { className: "dp-tabs" },
        react.createElement("button", { type: "button", className: "dp-tab" + (tab === "pets" ? " dp-tab-active" : ""), onClick: () => setTab("pets") }, "🐾 宠物（" + st.pets.length + "）"),
        react.createElement("button", { type: "button", className: "dp-tab" + (tab === "gallery" ? " dp-tab-active" : ""), onClick: () => setTab("gallery") }, "🌐 宠物社区"),
        react.createElement("button", { type: "button", className: "dp-tab" + (tab === "share" ? " dp-tab-active" : ""), onClick: () => setTab("share") }, "📤 分享到社区"),
        react.createElement("button", { type: "button", className: "dp-tab" + (tab === "video" ? " dp-tab-active" : ""), onClick: () => setTab("video") }, "🎬 视频生成"),
        react.createElement("button", { type: "button", className: "dp-tab" + (tab === "desktop" ? " dp-tab-active" : ""), onClick: () => setTab("desktop") }, "🖥 桌面窗口"),
        react.createElement("button", { type: "button", className: "dp-tab" + (tab === "forge" ? " dp-tab-active" : ""), onClick: () => setTab("forge") }, "✨ 生成新宠物"),
      ),
      tab === "pets"
        ? petsTab
        : tab === "gallery"
          ? react.createElement(GalleryPanel)
          : tab === "share"
            ? react.createElement(SharePanel)
            : tab === "video"
              ? react.createElement(VideoPanel)
              : tab === "desktop"
                ? react.createElement(DesktopPanel)
                : react.createElement(
                    "div",
                    { className: "dp-import" },
                    react.createElement("h3", { className: "dp-import-title" }, "✨ 用一句话生成桌宠"),
                    react.createElement("p", { className: "dp-import-hint" }, SKILL_HINT),
                    react.createElement("p", { className: "dp-import-hint" },
                      "手上已经有视频/绿幕素材？不用生图，直接走「🎬 视频生成」把里面真实的动作变成桌宠动作。"),
                    react.createElement("p", { className: "dp-import-hint" },
                      "生成完技能会问你一次「是否愿意把这个桌宠按 DPSL-1.0 共享到宠物社区」——"
                      + "选「愿意」的话，它会在这里（📤 分享到社区）帮你写好分享包。选「暂不共享」也完全不影响本地使用。"),
                    react.createElement("div", { className: "dp-import-divider" }, "— 或者手动导入已有素材 —"),
                    react.createElement(ImportPanel),
                  ),
    );
  }

  function ImportPanel() {
    const ds = react.useState(""); const imgPath = ds[0]; const setImgPath = ds[1];
    const cs = react.useState("8"); const cols = cs[0]; const setCols = cs[1];
    const rs = react.useState("11"); const rows = rs[0]; const setRows = rs[1];
    const ws = react.useState("192"); const cellW = ws[0]; const setCellW = ws[1];
    const hs = react.useState("208"); const cellH = hs[0]; const setCellH = hs[1];
    const ms = react.useState(null); const msg = ms[0]; const setMsg = ms[1];
    const bs = react.useState(false); const busy = bs[0]; const setBusy = bs[1];

    const doImageImport = () => {
      const p = imgPath.trim();
      if (!p) { setMsg("请输入 spritesheet 图片路径"); return; }
      setBusy(true); setMsg("导入中…");
      rpc("import-image", {
        path: p,
        cols: parseInt(cols, 10) || 8,
        rows: parseInt(rows, 10) || 11,
        cellW: parseInt(cellW, 10) || 192,
        cellH: parseInt(cellH, 10) || 208,
      }).then((res) => {
        setBusy(false);
        if (res && res.ok) {
          setMsg(res.warnings && res.warnings.length ? "✅ 已读取（" + res.warnings.join("；") + "）" : "✅ 图片已读取，可在「生成新宠物」里用技能打包成宠物");
        } else {
          setMsg("❌ " + ((res && res.error) || "未知错误"));
        }
      });
    };

    return react.createElement(
      "div",
      null,
      react.createElement("label", { className: "dp-label" }, "spritesheet 图片路径（本机绝对路径，需严格等于 列数×格宽 / 行数×格高）"),
      react.createElement("input", { className: "dp-input", value: imgPath, onChange: (e) => setImgPath(e.target.value), placeholder: "例如 D:\\pets\\my-pet.png" }),
      react.createElement(
        "div",
        { className: "dp-import-grid" },
        ["列数|" + cols + "|setCols", "行数|" + rows + "|setRows", "格宽|" + cellW + "|setCellW", "格高|" + cellH + "|setCellH"].map((spec) => {
          const parts = spec.split("|");
          const setters = { setCols, setRows, setCellW, setCellH };
          return react.createElement(
            "div",
            { key: parts[0], className: "dp-import-field" },
            react.createElement("label", { className: "dp-label" }, parts[0]),
            react.createElement("input", { className: "dp-input", value: parts[1], onChange: (e) => setters[parts[2]](e.target.value) }),
          );
        }),
      ),
      react.createElement(
        "div",
        { className: "dp-import-line" },
        react.createElement("button", { type: "button", className: "dp-btn dp-btn-primary", onClick: doImageImport, disabled: busy }, "校验图片"),
        msg !== null ? react.createElement("span", { className: "dp-import-msg" }, msg) : null,
      ),
      react.createElement("p", { className: "dp-import-hint" },
        "状态按行号约定：0=待机 · 1=右跑 · 2=左跑 · 3=挥手 · 4=跳跃(完成) · 5=摔倒(失败) · 6=等待 · 7=专注工作 · 8=思考 · 9-10=视线。",
      ),
      react.createElement("p", { className: "dp-import-hint" },
        "分辨率不限：格宽格高留空就会按图片尺寸自动推导（图片宽 ÷ 列数），"
        + "1024px 一格甚至写实素材都支持，桌面上等比缩放显示。上限是单格 4096px、整图 6400 万像素。",
      ),
    );
  }

  // ---------- 宠物社区（画廊）：收集 GitHub 上公开的桌宠并提供下载/安装渠道 ----------
  //
  // 契约 docs/GALLERY-CONTRACT.md ｜ 协议 docs/PET-SHARING-AGREEMENT.md（DPSL-1.0）
  // 三条原则直接体现在界面上：
  //   1. 「已按 DPSL-1.0 授权」才有「一键安装」；未授权的只能「兼容导入」或去仓库；
  //   2. 每条都显示作者署名 + 仓库链接（协议第 5.1、5.6 条）；
  //   3. 已核验 / 未核验 分开标 —— 没读到仓库里的 pet.json 就不假装它授权了。
  const GALLERY_SORT = [
    { value: "installable", label: "可安装优先" },
    { value: "stars", label: "star 最多" },
    { value: "updated", label: "最近更新" },
    { value: "name", label: "按名字" },
  ];

  const badgeOf = (e) => {
    if (e.installable === true) return { text: e.verified ? "DPSL-1.0 · 已核验" : "DPSL-1.0 · 索引声明", cls: "dp-badge dp-badge-ok" };
    if (e.compat) return { text: "未授权 · 可兼容导入", cls: "dp-badge dp-badge-warn" };
    return { text: "仅收录", cls: "dp-badge dp-badge-plain" };
  };

  const relTime = (iso) => {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const days = Math.round((Date.now() - t) / 86400000);
    if (days <= 0) return "今天";
    if (days === 1) return "昨天";
    if (days < 30) return days + " 天前";
    if (days < 365) return Math.round(days / 30) + " 个月前";
    return Math.round(days / 365) + " 年前";
  };

  function GalleryCard(props) {
    const e = props.entry;
    const installed = props.installed === true;
    const busy = props.busy === true;
    const fs = react.useState(false); const imgFailed = fs[0]; const setImgFailed = fs[1];
    const badge = badgeOf(e);
    const src = e.previewUrl || e.cardUrl;

    return react.createElement(
      "div",
      { className: "dp-gcard" + (installed ? " dp-gcard-installed" : "") },
      react.createElement(
        "div",
        { className: "dp-gcard-thumb" },
        src && !imgFailed
          ? react.createElement("img", { src: src, alt: e.name, loading: "lazy", onError: () => setImgFailed(true) })
          : react.createElement("span", { className: "dp-gcard-emoji" }, e.installable ? "🐾" : "📦"),
      ),
      react.createElement(
        "div",
        { className: "dp-gcard-body" },
        react.createElement(
          "div",
          { className: "dp-gcard-head" },
          react.createElement("span", { className: "dp-gcard-name", title: e.name }, e.name),
          react.createElement("span", { className: badge.cls }, badge.text),
          installed ? react.createElement("span", { className: "dp-badge dp-badge-ok" }, "✅ 已安装") : null,
        ),
        react.createElement(
          "div",
          { className: "dp-meta" },
          react.createElement("span", null, "作者 " + (e.author || e.owner)),
          e.stars ? react.createElement("span", null, "★ " + e.stars) : null,
          e.pushedAt || e.updatedAt ? react.createElement("span", null, "更新于 " + relTime(e.pushedAt || e.updatedAt)) : null,
          e.source ? react.createElement("span", null, e.source === "both" ? "索引+发现" : e.source === "index" ? "索引" : e.source === "manual" ? "手动" : "自动发现") : null,
        ),
        e.description ? react.createElement("p", { className: "dp-gcard-desc" }, e.description) : null,
        (e.tags || []).length
          ? react.createElement("div", { className: "dp-meta" }, (e.tags || []).slice(0, 6).map((t) => react.createElement("span", { key: t, className: "dp-tag" }, t)))
          : null,
        e.statement ? react.createElement("p", { className: "dp-gcard-statement", title: e.statement }, "“" + e.statement.slice(0, 96) + (e.statement.length > 96 ? "…" : "") + "”") : null,
        e.rights ? react.createElement("p", { className: "dp-import-hint" }, "素材权利：" + e.rights.slice(0, 120)) : null,
        (e.problems || []).length
          ? react.createElement("p", { className: "dp-import-hint dp-err" }, "⚠️ " + e.problems.slice(0, 2).join("；"))
          : null,
        react.createElement(
          "div",
          { className: "dp-row-actions" },
          e.installable
            ? react.createElement("button", { type: "button", className: "dp-btn dp-btn-primary", disabled: busy, onClick: () => props.onInstall(e, "dpsl") },
                busy ? "安装中…" : "⬇ 一键安装")
            : null,
          !e.installable && e.compat
            ? react.createElement("button", { type: "button", className: "dp-btn", disabled: busy, title: "没有 pet.json 授权声明：本机把它适配成宠物包（动作行映射为启发式）", onClick: () => props.onInstall(e, "compat") },
                busy ? "导入中…" : "⚠️ 兼容导入")
            : null,
          react.createElement("a", { className: "dp-btn", href: e.repoUrl, target: "_blank", rel: "noreferrer" }, "🔗 打开仓库"),
          react.createElement("button", { type: "button", className: "dp-btn", title: "复制 dsh plugin 安装命令", onClick: () => props.onCopy(e) }, "📋 安装命令"),
          e.contact ? react.createElement("a", { className: "dp-btn", href: e.contact, target: "_blank", rel: "noreferrer" }, "✉️ 联系作者") : null,
        ),
      ),
    );
  }

  function GalleryPanel() {
    const d = react.useState(null); const data = d[0]; const setData = d[1];
    const l = react.useState(true); const loading = l[0]; const setLoading = l[1];
    const m = react.useState(null); const msg = m[0]; const setMsg = m[1];
    const q = react.useState(""); const query = q[0]; const setQuery = q[1];
    const so = react.useState("installable"); const sort = so[0]; const setSort = so[1];
    const b = react.useState(null); const busyKey = b[0]; const setBusyKey = b[1];
    const mn = react.useState(""); const manual = mn[0]; const setManual = mn[1];

    const load = react.useCallback((refresh) => {
      setLoading(true);
      fetch("/ronaldo-pet/gallery" + (refresh ? "?refresh=1" : ""))
        .then((r) => r.json())
        .then((res) => {
          setLoading(false);
          if (!res || res.ok !== true) { setMsg("读取失败：" + ((res && res.error) || "返回异常")); return; }
          setData(res);
          if (refresh) {
            setMsg(res.online
              ? "✅ 已刷新：可直装 " + res.counts.installable + " · 可兼容导入 " + res.counts.compat + " · 仅收录 " + res.counts.listed
              : "⚠️ 没联上网，展示的是上次缓存（" + (res.cachedAt ? relTime(res.cachedAt) : "更早") + "）");
          }
        })
        .catch((err) => { setLoading(false); setMsg("读取失败：" + err.message); });
    }, []);

    react.useEffect(() => { load(false); }, [load]);

    const installedKeys = new Set((((data && data.installed) || [])).map((i) => i.key));

    const doInstall = (entry, mode) => {
      if (mode === "compat" && !window.confirm(
        "「" + entry.name + "」没有声明 DPSL-1.0 授权。\n\n"
        + "兼容导入会：下载它的图集 → 在你自己电脑上合成一份 pet.json（动作行映射是启发式的，可能不准）。\n"
        + "插件不做任何再分发，素材权属请自行确认。\n\n继续吗？")) return;
      setBusyKey(entry.key);
      setMsg((mode === "compat" ? "兼容导入" : "安装") + "「" + entry.name + "」中…（要下载仓库归档，稍等）");
      rpc("gallery/install", { key: entry.key, adapter: mode === "compat" ? "spritesheet-json" : undefined })
        .then((res) => {
          setBusyKey(null);
          if (res && res.ok) {
            setMsg("✅ 已" + (mode === "compat" ? "兼容导入" : "安装") + "「" + ((res.pet && res.pet.name) || entry.name) + "」"
              + (res.mode === "compat" ? "（动作映射为启发式；未映射动作会退化为待机）" : "")
              + (res.warnings && res.warnings.length ? " · " + res.warnings.join("；") : ""));
            refreshPets();
            load(false);
          } else {
            setMsg("❌ " + ((res && res.error) || "未知错误") + (res && res.hint ? "\nℹ️ " + res.hint : ""));
          }
        });
    };

    const addManual = () => {
      const v = manual.trim();
      if (!v) return;
      setBusyKey("__manual__");
      setMsg("探测 " + v + " …");
      rpc("gallery/probe", { repo: v }).then((res) => {
        setBusyKey(null);
        if (!res || !res.ok) { setMsg("❌ " + ((res && res.error) || "探测失败")); return; }
        const e = res.entry;
        setMsg("🔎 " + e.key + "：" + (e.installable ? "已按 DPSL-1.0 授权，可直接安装" : e.compat ? "未授权，可兼容导入" : "仅收录（不是本插件的宠物包格式）")
          + "。已插入列表顶部。");
        setData((prev) => prev ? Object.assign({}, prev, { entries: [e].concat((prev.entries || []).filter((x) => x.key !== e.key)) }) : prev);
        setManual("");
      });
    };

    const copyCmd = (entry) => {
      const cmd = "dsh plugin --profile web add " + entry.repoUrl;
      const done = () => setMsg("📋 已复制：" + cmd);
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(cmd).then(done, () => setMsg(cmd));
      else setMsg(cmd);
    };

    const entries = ((data && data.entries) || []).slice().sort((a, b2) => {
      if (sort === "stars") return (b2.stars || 0) - (a.stars || 0);
      if (sort === "updated") return Date.parse(b2.pushedAt || b2.updatedAt || 0) - Date.parse(a.pushedAt || a.updatedAt || 0);
      if (sort === "name") return String(a.name).localeCompare(String(b2.name), "zh");
      return Number(b2.installable) - Number(a.installable) || (b2.stars || 0) - (a.stars || 0);
    });
    const counts = (data && data.counts) || { total: 0, installable: 0, compat: 0, listed: 0 };

    return react.createElement(
      "div",
      { className: "dp-gallery" },
      react.createElement(
        "div",
        { className: "dp-toolbar" },
        react.createElement("button", { type: "button", className: "dp-btn", disabled: loading, onClick: () => load(true) }, loading ? "读取中…" : "🔄 刷新索引"),
        react.createElement("input", { className: "dp-input dp-gallery-search", value: query, placeholder: "搜名字 / 作者 / 标签…", onChange: (ev) => setQuery(ev.target.value) }),
        react.createElement("select", { className: "dp-input dp-select", value: sort, onChange: (ev) => setSort(ev.target.value) },
          GALLERY_SORT.map((o) => react.createElement("option", { key: o.value, value: o.value }, o.label))),
        reactElementCount(data, counts),
      ),
      react.createElement(
        "div",
        { className: "dp-notice" },
        react.createElement("strong", null, "这个窗口里的桌宠全部来自公开 GitHub 仓库"),
        "，插件只做「发现 → 展示 → 下载 → 本机安装」，不托管素材、不替任何人上传。",
        "「一键安装」只给已按 ",
        react.createElement("a", { href: "https://github.com/Stellum-Waq/dsh-pet-ronaldo/blob/master/docs/PET-SHARING-AGREEMENT.md", target: "_blank", rel: "noreferrer" }, "DPSL-1.0"),
        " 声明授权的仓库；安装时会重新校验仓库里当前的 pet.json —— 作者一撤回，这里立刻失效。",
      ),
      react.createElement(
        "div",
        { className: "dp-import-line" },
        react.createElement("input", {
          className: "dp-input dp-gallery-search",
          value: manual,
          placeholder: "手动添加：owner/repo 或 https://github.com/owner/repo",
          onChange: (ev) => setManual(ev.target.value),
          onKeyDown: (ev) => { if (ev.key === "Enter") addManual(); },
        }),
        react.createElement("button", { type: "button", className: "dp-btn", disabled: busyKey === "__manual__", onClick: addManual }, "🔎 探测并加入"),
        react.createElement("span", { className: "dp-import-hint" }, "自己没打 dsh-pet 标签的仓库，用这个口子直接看"),
      ),
      msg !== null ? react.createElement("div", { className: "dp-notice dp-notice-msg" }, msg) : null,
      (data && data.errors && data.errors.length)
        ? react.createElement("div", { className: "dp-notice dp-notice-warn" },
            "⚠️ 部分来源没抓到（不影响其余条目）：" + data.errors.slice(0, 3).join("；"))
        : null,
      data && data.online === false
        ? react.createElement("div", { className: "dp-notice dp-notice-warn" },
            "当前是离线/缓存模式：只展示内置索引与上次抓到的结果。想让插件联网抓取，检查网络或把 gallery.online 设回 true。")
        : null,
      entries.length === 0
        ? react.createElement("div", { className: "dp-empty" },
            loading ? "正在读取宠物社区…" : "还没有可展示的条目。点「刷新索引」试试；或手动填一个仓库地址。")
        : react.createElement("div", { className: "dp-gallery-grid" },
            (query
              ? entries.filter((e) => [e.name, e.key, e.author, e.description, (e.tags || []).join(" ")].filter(Boolean).join(" ").toLowerCase().includes(query.toLowerCase()))
              : entries
            ).map((e) => react.createElement(GalleryCard, {
              key: e.key, entry: e, busy: busyKey === e.key,
              installed: installedKeys.has(e.key),
              onInstall: doInstall, onCopy: copyCmd,
            }))),
    );
  }

  function reactElementCount(data, counts) {
    return react.createElement("span", { className: "dp-count" },
      (data ? data.counts.total : 0) + " 条 · 可直装 " + counts.installable + " · 兼容导入 " + counts.compat + " · 仅收录 " + counts.listed
      + (data && data.cachedAt ? " · 缓存于 " + relTime(data.cachedAt) : ""));
  }

  // ---------- 分享到社区（DPSL-1.0 的「询问 → 同意 → 生成分享包」） ----------
  function SharePanel() {
    const st = useStore();
    const pets = st.pets.filter((p) => !p.builtin);
    const p = react.useState(""); const petId = p[0]; const setPetId = p[1];
    const a = react.useState(""); const author = a[0]; const setAuthor = a[1];
    const r = react.useState(""); const repo = r[0]; const setRepo = r[1];
    const t = react.useState(""); const tags = t[0]; const setTags = t[1];
    const rt = react.useState(""); const rights = rt[0]; const setRights = rt[1];
    const rm = react.useState(true); const allowRemix = rm[0]; const setAllowRemix = rm[1];
    const ag = react.useState(false); const agreed = ag[0]; const setAgreed = ag[1];
    const b = react.useState(false); const busy = b[0]; const setBusy = b[1];
    const rs = react.useState(null); const result = rs[0]; const setResult = rs[1];
    const m = react.useState(null); const msg = m[0]; const setMsg = m[1];

    react.useEffect(() => { refreshPets(); }, []);
    react.useEffect(() => {
      if (!petId && pets.length) setPetId(pets[0].id);
    }, [pets.length]);

    const submit = () => {
      if (!petId) { setMsg("先选一只宠物"); return; }
      setBusy(true); setMsg("生成分享包…");
      rpc("gallery/share", {
        id: petId,
        accept: true,
        author: author.trim(),
        repo: repo.trim(),
        tags: tags.trim(),
        rights: rights.trim(),
        allowRemix: allowRemix,
      }).then((res) => {
        setBusy(false);
        if (res && res.ok) {
          setResult(res);
          setMsg("✅ 分享包已生成：" + (res.files || []).join("、") + "（宠物包里的 pet.json 已写入 sharing 块）");
        } else {
          setResult(null);
          setMsg("❌ " + ((res && res.error) || "未知错误"));
        }
      });
    };

    const steps = [
      "共享是可选的：不共享不影响任何本地功能，插件也不会反复追问你。",
      "著作权还是你的：DPSL-1.0 只授权插件收录、展示预览图、提供下载与一键安装。",
      "插件不会替你上传：它没有你的 GitHub 凭据，也不会替你执行 git push —— 推送永远由你自己来。",
      "可以随时撤回：把 pet.json 里 shared 改成 false，或删掉 dsh-pet 标签，索引最长 24 小时内失效。",
      "别人已经装到本机的副本收不回来（协议第 9.4 条如实说明这一点的存在）。",
    ];

    return react.createElement(
      "div",
      { className: "dp-share" },
      react.createElement("h3", { className: "dp-import-title" }, "📤 把桌宠共享到社区（按 DPSL-1.0）"),
      react.createElement(
        "div",
        { className: "dp-notice" },
        react.createElement("strong", null, "想不想让别人的插件也能一键装上你这只桌宠？"),
        react.createElement("ul", { className: "dp-share-list" }, steps.map((s2, i) => react.createElement("li", { key: i }, s2))),
        react.createElement("a", { href: "https://github.com/Stellum-Waq/dsh-pet-ronaldo/blob/master/docs/PET-SHARING-AGREEMENT.md", target: "_blank", rel: "noreferrer" }, "阅读协议全文 DPSL-1.0（中文）"),
      ),
      pets.length === 0
        ? react.createElement("div", { className: "dp-empty" }, "还没有可分享的宠物（内置 C罗 不算）。先用技能生成一只，或导入一份宠物包。")
        : react.createElement(
            "div",
            { className: "dp-share-form" },
            react.createElement("label", { className: "dp-label" }, "要分享哪只"),
            react.createElement("select", { className: "dp-input dp-select", value: petId, onChange: (ev) => { setPetId(ev.target.value); setResult(null); } },
              pets.map((x) => react.createElement("option", { key: x.id, value: x.id }, x.name + "（" + x.id + "）"))),
            react.createElement("label", { className: "dp-label" }, "作者署名（画廊会显著展示它）"),
            react.createElement("input", { className: "dp-input", value: author, placeholder: "昵称即可，不必写真名", onChange: (ev) => setAuthor(ev.target.value) }),
            react.createElement("label", { className: "dp-label" }, "GitHub 仓库地址（先把宠物包推上去，再填这里）"),
            react.createElement("input", { className: "dp-input", value: repo, placeholder: "https://github.com/you/your-pet", onChange: (ev) => setRepo(ev.target.value) }),
            react.createElement("label", { className: "dp-label" }, "标签（逗号分隔，便于别人筛选）"),
            react.createElement("input", { className: "dp-input", value: tags, placeholder: "像素风,猫,赛博朋克", onChange: (ev) => setTags(ev.target.value) }),
            react.createElement("label", { className: "dp-label" }, "素材权利说明（建议写：AI 生成 / 同人 / 音效来源）"),
            react.createElement("input", { className: "dp-input", value: rights, placeholder: "图集由生图模型生成；音效为程序合成", onChange: (ev) => setRights(ev.target.value) }),
            react.createElement(
              "label",
              { className: "dp-check" },
              react.createElement("input", { type: "checkbox", checked: allowRemix, onChange: (ev) => setAllowRemix(ev.target.checked) }),
              " 允许别人二创并公开分享（必须署名 + 同样采用 DPSL-1.0 + 不得商用）",
            ),
            react.createElement(
              "label",
              { className: "dp-check" },
              react.createElement("input", { type: "checkbox", checked: agreed, onChange: (ev) => setAgreed(ev.target.checked) }),
              " 我确认这个桌宠是我创作的（或我已获得素材分发授权），同意按 DPSL-1.0 收录进 DSH 桌宠社区",
            ),
            react.createElement(
              "div",
              { className: "dp-import-line" },
              react.createElement("button", { type: "button", className: "dp-btn dp-btn-primary", disabled: !agreed || busy, onClick: submit },
                busy ? "生成中…" : "📦 生成分享包"),
              react.createElement("span", { className: "dp-import-hint" }, agreed ? "" : "勾选上面的确认后按钮才会亮 —— 没同意之前，插件不会往你的宠物包里写任何东西"),
            ),
          ),
      msg !== null ? react.createElement("div", { className: "dp-notice dp-notice-msg" }, msg) : null,
      result && result.ok
        ? react.createElement(
            "div",
            { className: "dp-share-result" },
            react.createElement("h4", { className: "dp-import-title" }, "接下来三步"),
            react.createElement("ol", { className: "dp-share-list" }, (result.next.steps || []).map((s2, i) => react.createElement("li", { key: i }, s2))),
            react.createElement("p", { className: "dp-import-hint" }, "要加的话题（topic）："),
            react.createElement("code", { className: "dp-code" }, result.topic),
            react.createElement("p", { className: "dp-import-hint" }, "命令（在宠物包目录里执行；publish.ps1 已经把这些打包好了）："),
            react.createElement("pre", { className: "dp-code dp-code-block" }, (result.next.commands || []).join("\n")),
            react.createElement("p", { className: "dp-import-hint" }, "想顺便加进官方索引（可选，提 PR）："),
            react.createElement("pre", { className: "dp-code dp-code-block" }, JSON.stringify(result.next.indexEntry, null, 2)),
            react.createElement("p", { className: "dp-import-hint" }, "宠物包目录：" + result.pkg),
          )
        : null,
    );
  }

  // ---------- 从视频生成（抽帧 → 抠幕布 → 切动作 → 图集） ----------
  //
  // 这活是长任务（几十秒起），所以走宿主后端的后台 job：
  //   起任务 → 轮询 /ronaldo-pet/video/status?jobId= → 实时显示进度日志与结果。
  // 界面上把两件事说清楚：① 每个动作对应哪一段（自动切分只是草稿）；
  //                    ② 没有解码引擎时该怎么办（装 ffmpeg / opencv，或喂已抽好的帧）。
  function VideoPanel() {
    const p = react.useState(""); const path = p[0]; const setPath = p[1];
    const fr = react.useState(""); const framesDir = fr[0]; const setFramesDir = fr[1];
    const sg = react.useState(""); const segments = sg[0]; const setSegments = sg[1];
    const au = react.useState(""); const autoSegments = au[0]; const setAutoSegments = au[1];
    const nm = react.useState(""); const name = nm[0]; const setName = nm[1];
    const idv = react.useState(""); const petId = idv[0]; const setPetId = idv[1];
    const ky = react.useState("auto"); const key = ky[0]; const setKey = ky[1];
    const fs = react.useState("12"); const fps = fs[0]; const setFps = fs[1];
    const fm = react.useState("6"); const frames = fm[0]; const setFrames = fm[1];
    const sp = react.useState("0.16"); const similarity = sp[0]; const setSimilarity = sp[1];
    const er = react.useState("0"); const erode = er[0]; const setErode = er[1];
    const ao = react.useState(""); const audioFromVideo = ao[0]; const setAudioFromVideo = ao[1];
    const ins = react.useState(true); const install = ins[0]; const setInstall = ins[1];
    const ad = react.useState(false); const advanced = ad[0]; const setAdvanced = ad[1];
    const en = react.useState(null); const engines = en[0]; const setEngines = en[1];
    const ji = react.useState(null); const jobId = ji[0]; const setJobId = ji[1];
    const st = react.useState(null); const status = st[0]; const setStatus = st[1];
    const ms = react.useState(null); const msg = ms[0]; const setMsg = ms[1];
    const bs = react.useState(false); const busy = bs[0]; const setBusy = bs[1];

    const probe = react.useCallback((videoPath) => {
      setBusy(true);
      rpc("video/probe", { path: videoPath || undefined }).then((res) => {
        setBusy(false);
        if (!res || !res.ok) { setMsg("❌ " + ((res && res.error) || "探测失败")); return; }
        setEngines(res);
        if (res.video && res.video.ok) {
          setMsg("✅ 解码引擎：" + (res.engines.available.join(" + ") || "无")
            + " · 视频 " + res.video.width + "×" + res.video.height
            + " · " + Number(res.video.duration || 0).toFixed(2) + "s"
            + " · " + res.video.fps + "fps"
            + (res.video.hasAudio ? " · 有音轨" : ""));
        } else {
          setMsg("解码引擎：" + (res.engines.available.join(" + ") || "无")
            + (res.video && res.video.error ? "（读视频失败：" + res.video.error + "）" : ""));
        }
      });
    }, []);

    react.useEffect(() => { probe(); }, [probe]);

    // 轮询：只在有任务时开定时器，任务结束后自己停
    react.useEffect(() => {
      if (!jobId) return;
      let alive = true;
      const tick = async () => {
        const res = await fetch("/ronaldo-pet/video/status?jobId=" + encodeURIComponent(jobId)).then((r) => r.json()).catch((err) => ({ ok: false, error: String(err.message || err) }));
        if (!alive) return;
        setStatus(res);
        if (res && res.running === false) return;   // 不再排下一次
        if (alive) setTimeout(tick, 1500);
      };
      tick();
      return () => { alive = false; };
    }, [jobId]);

    const start = () => {
      if (!path.trim() && !framesDir.trim()) { setMsg("先填视频路径（或已抽好的帧目录）"); return; }
      setStatus(null);
      setBusy(true);
      rpc("video/build", {
        path: path.trim() || undefined,
        framesDir: framesDir.trim() || undefined,
        segments: segments.trim() || undefined,
        autoSegments: autoSegments.trim() || undefined,
        key: key.trim() || undefined,
        fps: fps.trim() || undefined,
        frames: frames.trim() || undefined,
        similarity: similarity.trim() || undefined,
        erode: erode.trim() || undefined,
        audioFromVideo: audioFromVideo.trim() || undefined,
        name: name.trim() || undefined,
        id: petId.trim() || undefined,
        install: install,
      }).then((res) => {
        setBusy(false);
        if (res && res.ok) {
          setJobId(res.jobId);
          setMsg("🎬 " + (res.human || "已开始生成") + "（宠物包目录：" + res.pkg + "）");
        } else {
          setMsg("❌ " + ((res && res.error) || "启动失败"));
        }
      });
    };

    const eng = engines && engines.engines;
    const noEngine = eng && eng.available.length === 0;
    const done = status && status.finished === true;
    const result = status && status.result;

    return react.createElement(
      "div",
      { className: "dp-share" },
      react.createElement("h3", { className: "dp-import-title" }, "🎬 从视频生成桌宠"),
      react.createElement("p", { className: "dp-import-hint" },
        "拍一段角色在纯色幕布（绿幕最好）前做动作的视频，这里会：抽帧 → 抠掉幕布 → 按时间段切开动作 → "
        + "对齐落格合成图集 → 直接注册。和「一句话生成」产出的是同一种宠物包。"),

      noEngine
        ? react.createElement("div", { className: "dp-notice dp-notice-warn" },
            react.createElement("strong", null, "这台机器没有视频解码引擎（导不了视频）"),
            react.createElement("div", { className: "dp-import-hint" }, "任选一条，装完回来点上面的「重新探测」："),
            react.createElement("ul", { className: "dp-share-list" },
              (eng.install || []).map((it, i) => react.createElement("li", { key: i }, it.label + "：" + it.cmd))),
            react.createElement("div", { className: "dp-import-hint" }, "都不装也行：用别的工具把视频抽成 PNG 帧，填在下面的「已抽好的帧目录」里。"))
        : null,

      react.createElement(
        "div",
        { className: "dp-share-form" },
        react.createElement("label", { className: "dp-label" }, "① 视频文件（本机绝对路径）"),
        react.createElement(
          "div",
          { className: "dp-import-line" },
          react.createElement("input", { className: "dp-input dp-gallery-search", value: path, placeholder: "D:\\videos\\my-pet-green.mp4", onChange: (e) => setPath(e.target.value) }),
          react.createElement("button", { type: "button", className: "dp-btn", disabled: busy, onClick: () => probe(path.trim()) }, "🔎 探测"),
          react.createElement("button", { type: "button", className: "dp-btn", disabled: busy, onClick: () => probe() }, "重新探测引擎"),
        ),
        react.createElement("label", { className: "dp-label" }, "② 每个动作在第几秒到第几秒（最准的做法；留空则自动切分）"),
        react.createElement("input", { className: "dp-input", value: segments, placeholder: "idle:0-2.5, waving:2.5-5, jumping:5-7.4", onChange: (e) => setSegments(e.target.value) }),
        react.createElement("label", { className: "dp-label" }, "或者：让它自己切几段（只在动作之间有停顿/硬切时才可靠）"),
        react.createElement("input", { className: "dp-input", value: autoSegments, placeholder: "留空 = 用上面的时间段；填 3 = 自动切成 3 段", onChange: (e) => setAutoSegments(e.target.value) }),
        react.createElement(
          "div",
          { className: "dp-import-grid" },
          react.createElement("div", { className: "dp-import-field" },
            react.createElement("label", { className: "dp-label" }, "宠物名字"),
            react.createElement("input", { className: "dp-input", value: name, placeholder: "绿幕猫", onChange: (e) => setName(e.target.value) })),
          react.createElement("div", { className: "dp-import-field" },
            react.createElement("label", { className: "dp-label" }, "id（英文，可留空）"),
            react.createElement("input", { className: "dp-input", value: petId, placeholder: "green-cat", onChange: (e) => setPetId(e.target.value) })),
          react.createElement("div", { className: "dp-import-field" },
            react.createElement("label", { className: "dp-label" }, "抽帧 fps"),
            react.createElement("input", { className: "dp-input", value: fps, onChange: (e) => setFps(e.target.value) })),
          react.createElement("div", { className: "dp-import-field" },
            react.createElement("label", { className: "dp-label" }, "每个动作取几帧"),
            react.createElement("input", { className: "dp-input", value: frames, onChange: (e) => setFrames(e.target.value) })),
        ),
        react.createElement(
          "label",
          { className: "dp-check" },
          react.createElement("input", { type: "checkbox", checked: advanced, onChange: (e) => setAdvanced(e.target.checked) }),
          " 高级：抠像参数 / 从视频抽音效 / 已抽好的帧目录",
        ),
        advanced
          ? react.createElement(
              "div",
              null,
              react.createElement(
                "div",
                { className: "dp-import-grid" },
                react.createElement("div", { className: "dp-import-field" },
                  react.createElement("label", { className: "dp-label" }, "幕布色（auto / 0x00FF00）"),
                  react.createElement("input", { className: "dp-input", value: key, onChange: (e) => setKey(e.target.value) })),
                react.createElement("div", { className: "dp-import-field" },
                  react.createElement("label", { className: "dp-label" }, "similarity 容差"),
                  react.createElement("input", { className: "dp-input", value: similarity, onChange: (e) => setSimilarity(e.target.value) })),
                react.createElement("div", { className: "dp-import-field" },
                  react.createElement("label", { className: "dp-label" }, "erode 收边"),
                  react.createElement("input", { className: "dp-input", value: erode, onChange: (e) => setErode(e.target.value) })),
                react.createElement("div", { className: "dp-import-field" },
                  react.createElement("label", { className: "dp-label" }, "抽视频音效（需 ffmpeg）"),
                  react.createElement("input", { className: "dp-input", value: audioFromVideo, placeholder: "celebrate@5.2-6.4", onChange: (e) => setAudioFromVideo(e.target.value) })),
              ),
              react.createElement("label", { className: "dp-label" }, "已抽好的 PNG 帧目录（没有解码器时用这个）"),
              react.createElement("input", { className: "dp-input", value: framesDir, placeholder: "D:\\frames\\my-pet", onChange: (e) => setFramesDir(e.target.value) }),
            )
          : null,
        react.createElement(
          "label",
          { className: "dp-check" },
          react.createElement("input", { type: "checkbox", checked: install, onChange: (e) => setInstall(e.target.checked) }),
          " 生成后直接注册进 DSH（右下角立刻出现）",
        ),
        react.createElement(
          "div",
          { className: "dp-import-line" },
          react.createElement("button", { type: "button", className: "dp-btn dp-btn-primary", disabled: busy || Boolean(jobId && status && status.running), onClick: start },
            jobId && status && status.running ? "生成中…" : "🎬 开始生成"),
          react.createElement("span", { className: "dp-import-hint" },
            eng ? "解码引擎：" + (eng.available.join(" + ") || "无") + (eng.ffmpeg ? "（" + eng.ffmpeg.path + "）" : eng.cv2 ? "（python + cv2 " + eng.cv2.version + "）" : "") : "…"),
        ),
      ),

      msg !== null ? react.createElement("div", { className: "dp-notice dp-notice-msg" }, msg) : null,

      status
        ? react.createElement(
            "div",
            { className: done ? "dp-share-result" : "dp-notice" },
            react.createElement("strong", null,
              status.running ? "⏳ 正在生成（可以关掉面板，任务会继续）"
                : status.succeeded ? "✅ 生成完成" : "❌ 生成失败"),
            result && result.human ? react.createElement("p", { className: "dp-import-hint" }, result.human) : null,
            status.error ? react.createElement("p", { className: "dp-import-msg dp-err" }, status.error) : null,
            result && result.error ? react.createElement("p", { className: "dp-import-msg dp-err" }, result.error) : null,
            result && result.warnings && result.warnings.length
              ? react.createElement("ul", { className: "dp-share-list" }, result.warnings.slice(0, 6).map((w, i) => react.createElement("li", { key: i }, "⚠️ " + w)))
              : null,
            result && result.chroma
              ? react.createElement("p", { className: "dp-import-hint" },
                  "抠像：幕布 " + result.chroma.key.r + "," + result.chroma.key.g + "," + result.chroma.key.b
                  + "（" + (result.chroma.keySource === "auto" ? "自动取样" : "手动指定") + "）"
                  + " · 平均抠掉 " + (result.chroma.avgTransparentRatio * 100).toFixed(1) + "%")
              : null,
            result && result.audit && result.audit.length
              ? react.createElement("p", { className: "dp-import-hint dp-err" }, "图集自检有 " + result.audit.length + " 处提醒（可能被裁切/跨格）")
              : null,
            result && result.samples && result.samples.length
              ? react.createElement("p", { className: "dp-import-hint" }, "肉眼复核用的样张：" + result.samples[0])
              : null,
            result && result.installed && result.installed.ok
              ? react.createElement("p", { className: "dp-import-msg" }, "已注册：看界面右下角或桌面上的原生窗口")
              : null,
            status.log && status.log.length
              ? react.createElement("pre", { className: "dp-code dp-code-block" }, status.log.slice(-8).join("\n"))
              : null,
          )
        : null,
    );
  }

  const CSS = [
    ".dp-overlay{position:fixed;inset:0;pointer-events:none;z-index:9990}",
    ".dp-dock{position:fixed;right:24px;bottom:16px;display:flex;align-items:flex-end;gap:10px;pointer-events:none;z-index:9991}",
    ".dp-pet{pointer-events:auto;cursor:grab;user-select:none;-webkit-user-select:none;display:flex;flex-direction:column;align-items:center;touch-action:none}",
    ".dp-pet:active{cursor:grabbing}",
    ".dp-sprite{display:block;filter:drop-shadow(0 4px 10px rgba(0,0,0,.22))}",
    ".dp-bubble{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:8px;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#222);border:1px solid var(--dsw-alias-border-l1,#e5e5e5);border-radius:12px;padding:6px 12px;font-size:13px;white-space:nowrap;box-shadow:0 8px 24px rgba(0,0,0,.14);animation:dp-rise .18s ease-out}",
    ".dp-bubble::after{content:'';position:absolute;top:100%;left:50%;transform:translateX(-50%);border:6px solid transparent;border-top-color:var(--dsw-alias-bg-overlay,#fff)}",
    "@keyframes dp-rise{from{opacity:0;transform:translateX(-50%) translateY(6px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}",
    ".dp-settings{padding:8px 4px 32px;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary,#222)}",
    ".dp-head{display:flex;flex-direction:column;gap:4px}",
    ".dp-title{margin:0;font-size:18px;font-weight:650}",
    ".dp-sub{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary,#666);line-height:1.5}",
    ".dp-tabs{display:flex;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e5e5);padding-bottom:2px}",
    ".dp-tab{padding:7px 14px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:13px;cursor:pointer;border-bottom:2px solid transparent}",
    ".dp-tab-active{color:var(--dsw-alias-brand-primary,#4f6ef7);border-bottom-color:var(--dsw-alias-brand-primary,#4f6ef7);font-weight:600}",
    ".dp-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:12px}",
    ".dp-count{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary,#666)}",
    ".dp-settings-line{margin-bottom:12px;align-items:center}",
    ".dp-select{padding:6px 8px}",
    ".dp-list{display:flex;flex-direction:column;gap:12px}",
    ".dp-empty{padding:40px 16px;text-align:center;color:var(--dsw-alias-label-secondary,#666);border:1px dashed var(--dsw-alias-border-l2,#ccc);border-radius:12px;font-size:13px}",
    ".dp-card{display:flex;gap:16px;padding:16px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e5e5);border-radius:12px}",
    ".dp-card-off{opacity:.62}",
    ".dp-card-default{border-color:var(--dsw-alias-brand-primary,#4f6ef7);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#4f6ef7) inset}",
    ".dp-tag-default{background:var(--dsw-alias-brand-primary,#4f6ef7);color:#fff;border-color:transparent;font-weight:600}",
    ".dp-default-badge{display:inline-flex;align-items:center;padding:7px 12px;border-radius:8px;font-size:13px;background:var(--dsw-alias-brand-primary,#4f6ef7);color:#fff;font-weight:600}",
    ".dp-card-preview{display:flex;align-items:center;justify-content:center;min-width:88px;min-height:96px;background:var(--dsw-alias-bg-layer-2,#f5f5f5);border-radius:10px;overflow:hidden}",
    ".dp-card-body{flex:1;display:flex;flex-direction:column;gap:10px;min-width:0}",
    ".dp-row{display:flex;flex-direction:column;gap:6px}",
    ".dp-label{font-size:12px;color:var(--dsw-alias-label-secondary,#666)}",
    ".dp-meta{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11px;color:var(--dsw-alias-label-secondary,#666)}",
    ".dp-tag{padding:1px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#eee);border:1px solid var(--dsw-alias-border-l1,#ddd)}",
    ".dp-path{font-size:11px;color:var(--dsw-alias-label-secondary,#888);word-break:break-all;font-family:ui-monospace,Consolas,monospace}",
    ".dp-input{padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d0d0d0);background:var(--dsw-alias-bg-layer-2,#fafafa);color:var(--dsw-alias-label-primary,#222);font-size:13px;min-width:0}",
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
    ".dp-import-line{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
    ".dp-import-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}",
    ".dp-import-field{display:flex;flex-direction:column;gap:6px}",
    ".dp-import-divider{font-size:12px;color:var(--dsw-alias-label-secondary,#666);text-align:center;margin:6px 0}",
    ".dp-import-msg{font-size:12px;color:var(--dsw-alias-state-success-primary,#2e9e44)}",
    ".dp-err{color:var(--dsw-alias-state-error-primary,#d64545)}",
    ".dp-import-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#666);line-height:1.6}",
    // ---- 宠物社区（画廊）----
    ".dp-gallery{display:flex;flex-direction:column;gap:12px}",
    ".dp-gallery-search{flex:1;min-width:200px}",
    ".dp-gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}",
    ".dp-gcard{display:flex;gap:12px;padding:12px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e5e5);border-radius:12px;transition:box-shadow .15s,border-color .15s}",
    ".dp-gcard:hover{box-shadow:0 6px 18px rgba(0,0,0,.07)}",
    ".dp-gcard-installed{border-color:var(--dsw-alias-state-success-primary,#2e9e44)}",
    ".dp-gcard-thumb{width:78px;height:90px;flex:0 0 78px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2,#f5f5f5);border-radius:10px;overflow:hidden}",
    ".dp-gcard-thumb img{max-width:100%;max-height:100%;object-fit:contain;image-rendering:auto}",
    ".dp-gcard-emoji{font-size:26px;opacity:.5}",
    ".dp-gcard-body{flex:1;display:flex;flex-direction:column;gap:6px;min-width:0}",
    ".dp-gcard-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px}",
    ".dp-gcard-name{font-size:14px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}",
    ".dp-gcard-desc{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#666);line-height:1.55;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}",
    ".dp-gcard-statement{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#777);font-style:italic;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".dp-badge{padding:1px 7px;border-radius:999px;font-size:11px;border:1px solid transparent;white-space:nowrap}",
    ".dp-badge-ok{background:rgba(46,158,68,.12);color:var(--dsw-alias-state-success-primary,#2e9e44);border-color:rgba(46,158,68,.35)}",
    ".dp-badge-warn{background:rgba(214,150,0,.14);color:#a5730a;border-color:rgba(214,150,0,.35)}",
    ".dp-badge-plain{background:var(--dsw-alias-bg-layer-2,#eee);color:var(--dsw-alias-label-secondary,#666);border-color:var(--dsw-alias-border-l1,#ddd)}",
    ".dp-notice{padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f5f5f5);border:1px solid var(--dsw-alias-border-l1,#e5e5e5);font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,#555)}",
    ".dp-notice a{color:var(--dsw-alias-brand-primary,#4f6ef7)}",
    ".dp-notice-msg{white-space:pre-wrap}",
    ".dp-notice-warn{background:rgba(214,150,0,.10);border-color:rgba(214,150,0,.3);color:#8a6209}",
    // ---- 分享到社区 ----
    ".dp-share{display:flex;flex-direction:column;gap:12px}",
    ".dp-share-list{margin:6px 0 0;padding-left:18px;font-size:12px;line-height:1.75}",
    ".dp-share-form{display:flex;flex-direction:column;gap:8px;padding:14px;background:var(--dsw-alias-bg-layer-2,#f5f5f5);border:1px solid var(--dsw-alias-border-l1,#e5e5e5);border-radius:12px}",
    ".dp-share-result{display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--dsw-alias-state-success-primary,#2e9e44);border-radius:12px;background:rgba(46,158,68,.06)}",
    ".dp-check{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary,#333);cursor:pointer}",
    ".dp-check input{margin-top:2px}",
    ".dp-code{font-family:ui-monospace,Consolas,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e5e5);border-radius:8px;padding:6px 9px;word-break:break-all}",
    ".dp-code-block{margin:0;padding:10px;white-space:pre-wrap;overflow:auto;max-height:240px;line-height:1.6}",
    "@media (max-width:720px){.dp-gallery-grid{grid-template-columns:1fr}.dp-tabs{flex-wrap:wrap}}",
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
      { name: "shell.overlay", id: "ronaldo-pet", order: 100, label: "桌宠" },
      () => react.createElement(Overlay),
    ));
  }

  exports.apply = apply;
  exports.inject = inject;
  exports.name = name;
  return module.exports;
}});
