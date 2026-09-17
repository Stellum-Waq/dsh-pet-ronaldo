// =============================================================================
// dsh-pet-forge · 独立预览页生成器
// -----------------------------------------------------------------------------
// 生成一个**不依赖 DSH** 的 HTML：双击就能看动画、听音效、切换动作。
// 用途：
//   · 装进 DSH 之前先确认素材真的没问题（尤其"图有没有串帧""声音对不对"）
//   · 把宠物包发给别人时的开箱即用演示
// 清单 JSON 直接内联进 HTML —— 这样 file:// 打开也能跑（fetch 本地 json 会被浏览器拦）。
// =============================================================================

import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 转义成可安全放进 <script> 的 JSON。 */
function safeJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export function buildPreviewHtml(manifest) {
  const atlasFile = (manifest.atlas && manifest.atlas.file) || 'atlas.png'
  const states = manifest.states || {}
  const audio = manifest.audio || {}
  const atlas = manifest.atlas || {}
  const meta = {
    name: manifest.name || manifest.id,
    id: manifest.id,
    cols: atlas.cols || 8,
    rows: atlas.rows || 11,
    cellW: atlas.cellW || 192,
    cellH: atlas.cellH || 208,
    atlasFile,
    states,
    audio,
    yaw: manifest.yaw || null,
    phrases: manifest.phrases || [],
    divePhrases: manifest.divePhrases || [],
  }
  const labels = {
    idle: '待机', runRight: '向右跑', runLeft: '向左跑', waving: '挥手', jumping: '跳跃庆祝',
    failed: '摔倒', waiting: '等待', running: '专注工作', review: '思考', look: '视线跟随',
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(meta.name)} · 桌宠预览</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #10131a; color: #e8ecf4; display: flex; min-height: 100vh; flex-direction: column; }
  header { padding: 18px 24px; border-bottom: 1px solid #232838; display: flex; align-items: baseline; gap: 12px; }
  h1 { font-size: 18px; margin: 0; }
  .sub { color: #8d97ab; font-size: 12px; }
  main { flex: 1; display: grid; grid-template-columns: minmax(320px, 420px) 1fr; gap: 24px; padding: 24px; }
  @media (max-width: 860px) { main { grid-template-columns: 1fr; } }
  .stage { position: relative; display: flex; align-items: flex-end; justify-content: center;
           min-height: 340px; border-radius: 16px; padding: 24px;
           background-image: linear-gradient(45deg,#20242e 25%,transparent 25%),linear-gradient(-45deg,#20242e 25%,transparent 25%),
                             linear-gradient(45deg,transparent 75%,#20242e 75%),linear-gradient(-45deg,transparent 75%,#20242e 75%);
           background-size: 20px 20px; background-position: 0 0,0 10px,10px -10px,-10px 0; background-color: #181c25; }
  #sprite { image-rendering: pixelated; filter: drop-shadow(0 6px 12px rgba(0,0,0,.45)); }
  #bubble { position: absolute; left: 50%; transform: translateX(-50%); bottom: 78%; white-space: nowrap;
            background: #fff; color: #1a1d24; padding: 6px 12px; border-radius: 12px; font-size: 13px; display: none; }
  #bubble.show { display: block; }
  .col { display: flex; flex-direction: column; gap: 16px; }
  .card { background: #171b24; border: 1px solid #232838; border-radius: 12px; padding: 14px 16px; }
  .card h2 { font-size: 13px; margin: 0 0 10px; color: #9aa4b8; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
  button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid #2c3244; background: #1e2431;
           color: #dfe5f0; cursor: pointer; }
  button:hover { border-color: #3d465e; }
  button.active { background: #3b6ef0; border-color: #3b6ef0; color: #fff; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 12px; color: #b6bfd0; }
  .kv b { color: #7f8a9e; font-weight: 500; }
  .warn { color: #ffb454; font-size: 12px; margin-top: 8px; }
  input[type=range] { width: 220px; vertical-align: middle; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(meta.name)}</h1>
  <span class="sub">桌宠预览 · ${meta.cols}×${meta.rows} 图集 · 每格 ${meta.cellW}×${meta.cellH}px · id=${escapeHtml(String(meta.id))}</span>
</header>
<main>
  <div class="col">
    <div class="stage">
      <div id="bubble"></div>
      <div id="sprite"></div>
    </div>
    <div class="card">
      <h2>尺寸</h2>
      <input type="range" id="size" min="60" max="320" value="160">
      <span id="sizeVal">160px</span>
    </div>
  </div>
  <div class="col">
    <div class="card">
      <h2>动作</h2>
      <div class="row" id="states"></div>
    </div>
    <div class="card">
      <h2>音效</h2>
      <div class="row" id="audio"></div>
      <div class="warn" id="audioWarn"></div>
    </div>
    <div class="card">
      <h2>信息</h2>
      <div class="kv" id="info"></div>
    </div>
  </div>
</main>
<script id="pet-meta" type="application/json">${safeJson(meta)}</script>
<script>
(function () {
  var META = JSON.parse(document.getElementById('pet-meta').textContent);
  var LABELS = ${safeJson(labels)};
  var sprite = document.getElementById('sprite');
  var bubble = document.getElementById('bubble');
  var current = 'idle';
  var frame = 0;
  var timer = null;

  function framePos(col, row) {
    var cols = META.cols, rows = META.rows;
    var px = cols > 1 ? (col * 100 / (cols - 1)) : 0;
    var py = rows > 1 ? (row * 100 / (rows - 1)) : 0;
    return px + '% ' + py + '%';
  }
  function applySize(px) {
    sprite.style.width = px + 'px';
    sprite.style.height = Math.round(px * META.cellH / META.cellW) + 'px';
    sprite.style.backgroundSize = (META.cols * 100) + '% ' + (META.rows * 100) + '%';
  }
  function draw() {
    var st = META.states[current];
    if (!st) return;
    var row, col;
    if (st.angles) {
      var a = st.angles[Math.min(st.angles.length - 1, Math.max(0, window.__lookIndex || 0))];
      row = a.row; col = a.col;
    } else if (st.rows) {
      row = st.rows[0]; col = 0;
    } else {
      row = st.row; col = frame % (st.frames || 1);
    }
    sprite.style.backgroundPosition = framePos(col, row);
  }
  function play(name) {
    var st = META.states[name];
    if (!st) return;
    current = name;
    frame = 0;
    if (timer) clearInterval(timer);
    var fps = st.fps || 8;
    var frames = st.frames || (st.angles ? st.angles.length : 1);
    draw();
    if (frames > 1 && !st.angles) {
      timer = setInterval(function () { frame = (frame + 1) % frames; draw(); }, Math.round(1000 / fps));
    }
    var btns = document.querySelectorAll('#states button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].dataset.s === name);
  }
  function say(text) {
    bubble.textContent = text;
    bubble.classList.add('show');
    setTimeout(function () { bubble.classList.remove('show'); }, 2200);
  }

  sprite.style.backgroundImage = 'url("' + encodeURI(META.atlasFile) + '")';
  sprite.style.backgroundRepeat = 'no-repeat';
  applySize(160);
  document.getElementById('size').addEventListener('input', function (e) {
    applySize(Number(e.target.value));
    document.getElementById('sizeVal').textContent = e.target.value + 'px';
  });

  var statesBox = document.getElementById('states');
  Object.keys(META.states).forEach(function (key) {
    var b = document.createElement('button');
    b.textContent = LABELS[key] || key;
    b.dataset.s = key;
    b.onclick = function () {
      play(key);
      var st = META.states[key];
      if (st && st.aliasOf) say('（该动作未生成，回退到 ' + st.aliasOf + '）');
    };
    statesBox.appendChild(b);
  });

  // 环视图（3D 宠物）：鼠标在舞台上移动 → 切换朝向
  var stage = document.querySelector('.stage');
  stage.addEventListener('mousemove', function (e) {
    var st = META.states.review || null;
    var look = META.states.look;
    if (!look || !look.angles) return;
    var r = stage.getBoundingClientRect();
    var dx = e.clientX - (r.left + r.width / 2);
    var dy = e.clientY - (r.top + r.height / 2);
    var deg = Math.atan2(dx, -dy) * 180 / Math.PI;
    if (deg < 0) deg += 360;
    var n = look.angles.length;
    window.__lookIndex = Math.round(deg / (360 / n)) % n;
    if (current === 'look') draw();
  });
  stage.addEventListener('mouseleave', function () { window.__lookIndex = 0; if (current === 'look') draw(); });
  var lookBtn = statesBox.querySelector('[data-s="look"]');
  if (lookBtn) lookBtn.onclick = function () { play('look'); say('把鼠标移到宠物周围试试 👀'); };

  var audioBox = document.getElementById('audio');
  var keys = Object.keys(META.audio || {});
  if (keys.length === 0) document.getElementById('audioWarn').textContent = '这个宠物包没有音频。';
  keys.forEach(function (k) {
    var entry = META.audio[k];
    var file = typeof entry === 'string' ? entry : entry.file;
    var label = (entry && entry.label) || k;
    var b = document.createElement('button');
    b.textContent = '🔊 ' + label;
    b.onclick = function () {
      var a = new Audio(encodeURI(file));
      a.play().catch(function (err) {
        document.getElementById('audioWarn').textContent = '播放失败：' + err.message + '（浏览器可能要求先交互一次，或文件路径不对）';
      });
    };
    audioBox.appendChild(b);
  });

  var info = document.getElementById('info');
  var rows = [
    ['id', META.id],
    ['动作数', Object.keys(META.states).length],
    ['音效数', keys.length],
    ['环视角度', META.yaw ? META.yaw.count + ' 个（3D）' : '无（2D）'],
    ['图集', META.atlasFile + '  ' + (META.cols * META.cellW) + '×' + (META.rows * META.cellH)],
    ['版本', 'dsh-pet/2'],
  ];
  rows.forEach(function (r) {
    var d = document.createElement('div'); d.innerHTML = '<b>' + r[0] + '</b>';
    var v = document.createElement('div'); v.textContent = String(r[1]);
    info.appendChild(d); info.appendChild(v);
  });

  play('idle');
})();
</script>
</body>
</html>
`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

export async function writePreview(packageDir, manifest, fileName = 'preview.html') {
  await mkdir(packageDir, { recursive: true })
  const path = join(packageDir, fileName)
  await writeFile(path, buildPreviewHtml(manifest), 'utf8')
  return path
}
