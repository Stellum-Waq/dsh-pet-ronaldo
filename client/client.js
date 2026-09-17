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
        react.createElement("button", { type: "button", className: "dp-tab" + (tab === "desktop" ? " dp-tab-active" : ""), onClick: () => setTab("desktop") }, "🖥 桌面窗口"),
        react.createElement("button", { type: "button", className: "dp-tab" + (tab === "forge" ? " dp-tab-active" : ""), onClick: () => setTab("forge") }, "✨ 生成新宠物"),
      ),
      tab === "pets"
        ? petsTab
        : tab === "desktop"
          ? react.createElement(DesktopPanel)
          : react.createElement(
              "div",
              { className: "dp-import" },
              react.createElement("h3", { className: "dp-import-title" }, "✨ 用一句话生成桌宠"),
              react.createElement("p", { className: "dp-import-hint" }, SKILL_HINT),
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
