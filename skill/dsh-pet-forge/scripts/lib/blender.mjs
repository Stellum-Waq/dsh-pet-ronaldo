// =============================================================================
// dsh-pet-forge · Blender 3D 建模与渲染
// -----------------------------------------------------------------------------
// 分工（很重要）：
//   · 本模块只负责**生成** Blender Python 脚本、**找** Blender、必要时**无头执行**、
//     以及把渲染出来的帧**装配**成图集。
//   · 真正在 Blender 里跑脚本有两种方式，由调用方（agent）按环境选择：
//       A. Blender MCP（推荐，用户开着 Blender + MCP 插件时）
//          → 调用 mcp__blender__execute_blender_code，传
//            `exec(open(r'<build.py>', encoding='utf-8').read())`
//       B. 无头执行（无需用户开 Blender）
//          → `node forge.mjs blender-run --pkg <宠物包>`
//     两条路产物完全一致（都写进 <包>/model/renders/），因此后面可以共用装配步骤。
//
// 生成的 3D 模型：程序化拼装的低多边形 chibi 小生物（身体/头/耳朵/眼睛/手脚/尾巴），
// 颜色取自 2D 主图提取的调色板，保证 3D 版和 2D 版观感一致。
// 动画不靠骨骼：每帧直接摆姿势后渲染（比建关键帧稳，也不依赖 rig 是否正确）。
// =============================================================================

import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { decodeImage, resize, composite, newImg, flipX, alphaBounds } from './imaging.mjs'
import { unionBounds, projectFrames, ACTION_TO_ROW } from './anim.mjs'

/** 3D 版支持的动作（行号与 2D 契约一致）。 */
export const BLENDER_ACTIONS = ['idle', 'runRight', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review']

/** 常见安装位置；可被 --blender 参数或 DSH_BLENDER_PATH 覆盖。 */
export function findBlender() {
  const explicit = process.env.DSH_BLENDER_PATH
  if (explicit && existsSync(explicit)) return explicit
  const roots = [
    'D:\\Program Files\\Blender Foundation',
    'C:\\Program Files\\Blender Foundation',
    'C:\\Program Files (x86)\\Blender Foundation',
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Blender Foundation'),
    'D:\\Blender',
    'C:\\Blender',
  ]
  const found = []
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    try {
      const entries = readdirSync(root, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const exe = join(root, e.name, 'blender.exe')
        if (existsSync(exe)) found.push(exe)
      }
    } catch { /* 忽略 */ }
  }
  if (found.length === 0) return null
  // 取版本号最大的那个
  found.sort((a, b) => {
    const va = (a.match(/(\d+)\.(\d+)/) || [0, 0, 0]).slice(1).map(Number)
    const vb = (b.match(/(\d+)\.(\d+)/) || [0, 0, 0]).slice(1).map(Number)
    return (vb[0] - va[0]) || (vb[1] - va[1])
  })
  return found[0]
}

/** 组装一份建模规格（写进 model/spec.json，供脚本与装配共用）。 */
export function buildSpec(opts) {
  return {
    schema: 'dsh-pet-blender/1',
    petId: opts.petId,
    name: opts.name || opts.petId,
    outDir: resolve(opts.outDir),
    renderDir: resolve(opts.renderDir || join(opts.outDir, 'renders')),
    cellW: opts.cellW ?? 192,
    cellH: opts.cellH ?? 208,
    // 比例（单位：Blender 米），模型高约 1.8
    proportions: {
      bodyRadius: opts.proportions?.bodyRadius ?? 0.52,
      headRadius: opts.proportions?.headRadius ?? 0.42,
      bodyCenterZ: opts.proportions?.bodyCenterZ ?? 0.62,
      headCenterZ: opts.proportions?.headCenterZ ?? 1.30,
      earHeight: opts.proportions?.earHeight ?? 0.34,
      earRadius: opts.proportions?.earRadius ?? 0.14,
      armLength: opts.proportions?.armLength ?? 0.30,
      footRadius: opts.proportions?.footRadius ?? 0.20,
      tailLength: opts.proportions?.tailLength ?? 0.45,
    },
    palette: opts.palette || ['#7ec8ff', '#a9dcff', '#5aa8e8', '#1e283c', '#ffffff'],
    actions: opts.actions || BLENDER_ACTIONS,
    frames: opts.frames || {},
    yawCount: opts.yawCount ?? 8,
    renderLookRows: opts.renderLookRows !== false,
    exportGlb: opts.exportGlb !== false,
    samples: opts.samples ?? 16,
  }
}

const pyStr = (s) => JSON.stringify(String(s))

/**
 * 生成 Blender Python 脚本（纯 ASCII，路径通过 spec.json 传入以避免编码问题）。
 */
export function buildScript(spec) {
  return `# -*- coding: utf-8 -*-
# =============================================================================
# dsh-pet-forge 自动生成的 Blender 建模 + 渲染脚本
# 用法（两种都行）：
#   blender --background --factory-startup --python build.py
#   或在已开启 MCP 插件的 Blender 里执行：
#     exec(open(r"<本文件路径>", encoding="utf-8").read())
# 产物：spec.json 里 renderDir 下的 {action}_{frame:03d}.png 与 look_{i:02d}.png，
#       以及 model/pet.glb
# 本脚本不依赖用户已安装任何插件，--factory-startup 即可运行。
# =============================================================================
import bpy, json, math, os, sys

SPEC_PATH = ${pyStr(spec.__specPath || '')}

def load_spec():
    path = SPEC_PATH
    if not path:
        argv = sys.argv
        if "--" in argv:
            path = argv[argv.index("--") + 1]
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

SPEC = load_spec()
OUT = SPEC["outDir"]
RENDERS = SPEC["renderDir"]
os.makedirs(RENDERS, exist_ok=True)

CELL_W = int(SPEC.get("cellW", 192))
CELL_H = int(SPEC.get("cellH", 208))
P = SPEC.get("proportions", {})
PAL = SPEC.get("palette") or ["#7ec8ff", "#a9dcff", "#5aa8e8", "#1e283c", "#ffffff"]
YAW_COUNT = int(SPEC.get("yawCount", 8))
FRAMES = SPEC.get("frames", {})
ACTIONS = SPEC.get("actions") or ["idle"]

def hex_to_rgb(h):
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))

def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def col(i):
    rgb = hex_to_rgb(PAL[i % len(PAL)])
    return tuple(srgb_to_linear(v) for v in rgb) + (1.0,)

# ---------------------------------------------------------------- 清场
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ---------------------------------------------------------------- 渲染引擎
# ⚠️ 关键坑（实测）：EEVEE 需要真实的 GPU / OpenGL 上下文。
#    在 "blender --background" 下它只渲染出头两张，之后全部输出全透明图片
#    （不报错、不退出，只是静默产出空图）。所以无头渲染必须用 Cycles(CPU)。
#    交互式（MCP，用户在真 Blender 里跑）有上下文，仍然优先 EEVEE，因为它快得多。
#    （注意：本文件是 JS 模板字符串，Python 注释里不要出现反引号。）
def try_engine(names):
    for n in names:
        try:
            scene.render.engine = n
            return n
        except Exception:
            continue
    return scene.render.engine

want = str(SPEC.get("engine", "auto")).lower()
if want == "auto":
    want = "cycles" if bpy.app.background else "eevee"
if want == "cycles":
    engine_candidates = ["CYCLES"]
elif want == "workbench":
    engine_candidates = ["BLENDER_WORKBENCH"]
else:
    engine_candidates = ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"]

def configure_engine():
    eng = scene.render.engine
    if eng == "CYCLES":
        try:
            scene.cycles.device = "CPU"
            scene.cycles.samples = int(SPEC.get("samples", 32))
            scene.cycles.use_denoising = True
            scene.cycles.max_bounces = 4
            scene.cycles.transparent_max_bounces = 4
        except Exception:
            pass
    else:
        try:
            scene.eevee.taa_render_samples = int(SPEC.get("samples", 16))
        except Exception:
            pass
    return eng

engine = try_engine(engine_candidates)
scene.render.engine = engine
configure_engine()

scene.render.resolution_x = CELL_W
scene.render.resolution_y = CELL_H
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.film_transparent = True
try:
    scene.view_settings.view_transform = "Standard"
except Exception:
    pass
try:
    scene.view_settings.view_transform = "Standard"
except Exception:
    pass

# ---------------------------------------------------------------- 材质
def make_mat(name, color_index, rough=0.55):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = col(color_index)
        try:
            bsdf.inputs["Roughness"].default_value = rough
        except Exception:
            pass
    m.diffuse_color = col(color_index)
    return m

MAT_BODY = make_mat("pet_body", 0)
MAT_BELLY = make_mat("pet_belly", 1)
MAT_ACCENT = make_mat("pet_accent", 2)
MAT_DARK = make_mat("pet_dark", 3)
MAT_EYE = make_mat("pet_eye", 4 if len(PAL) > 4 else 4, rough=0.2)

# ---------------------------------------------------------------- 建模
parts = []

def add_sphere(name, loc, radius, mat, scale=(1, 1, 1), segments=32, rings=16):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=radius, location=loc)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = scale
    ob.data.materials.append(mat)
    bpy.ops.object.shade_smooth()
    parts.append(ob)
    return ob

def add_cone(name, loc, r1, r2, depth, mat, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=r1, radius2=r2, depth=depth, location=loc, rotation=rot)
    ob = bpy.context.active_object
    ob.name = name
    ob.data.materials.append(mat)
    bpy.ops.object.shade_smooth()
    parts.append(ob)
    return ob

BR = float(P.get("bodyRadius", 0.52))
HR = float(P.get("headRadius", 0.42))
BZ = float(P.get("bodyCenterZ", 0.62))
HZ = float(P.get("headCenterZ", 1.30))
EH = float(P.get("earHeight", 0.34))
ER = float(P.get("earRadius", 0.14))
AL = float(P.get("armLength", 0.30))
FR = float(P.get("footRadius", 0.20))
TL = float(P.get("tailLength", 0.45))

body = add_sphere("body", (0, 0, BZ), BR, MAT_BODY, scale=(1.0, 0.92, 0.95))
belly = add_sphere("belly", (0, -BR * 0.55, BZ - BR * 0.08), BR * 0.72, MAT_BELLY, scale=(0.85, 0.55, 0.85))
head = add_sphere("head", (0, 0, HZ), HR, MAT_BODY, scale=(1.0, 0.95, 0.92))
ear_l = add_cone("ear_l", (-HR * 0.62, 0, HZ + HR * 0.72), ER, ER * 0.12, EH, MAT_ACCENT, rot=(0.22, 0, 0))
ear_r = add_cone("ear_r", (HR * 0.62, 0, HZ + HR * 0.72), ER, ER * 0.12, EH, MAT_ACCENT, rot=(0.22, 0, 0))
eye_l = add_sphere("eye_l", (-HR * 0.36, -HR * 0.82, HZ + HR * 0.10), HR * 0.16, MAT_DARK, scale=(1, 0.6, 1.15), segments=16, rings=10)
eye_r = add_sphere("eye_r", (HR * 0.36, -HR * 0.82, HZ + HR * 0.10), HR * 0.16, MAT_DARK, scale=(1, 0.6, 1.15), segments=16, rings=10)
spark_l = add_sphere("spark_l", (-HR * 0.32, -HR * 0.95, HZ + HR * 0.18), HR * 0.05, MAT_EYE, segments=12, rings=8)
spark_r = add_sphere("spark_r", (HR * 0.40, -HR * 0.95, HZ + HR * 0.18), HR * 0.05, MAT_EYE, segments=12, rings=8)
arm_l = add_sphere("arm_l", (-BR * 1.02, 0, BZ + BR * 0.18), AL * 0.45, MAT_BODY, scale=(0.7, 0.7, 1.25), segments=16, rings=10)
arm_r = add_sphere("arm_r", (BR * 1.02, 0, BZ + BR * 0.18), AL * 0.45, MAT_BODY, scale=(0.7, 0.7, 1.25), segments=16, rings=10)
foot_l = add_sphere("foot_l", (-BR * 0.45, -BR * 0.08, FR * 0.72), FR, MAT_ACCENT, scale=(1.0, 1.35, 0.72))
foot_r = add_sphere("foot_r", (BR * 0.45, -BR * 0.08, FR * 0.72), FR, MAT_ACCENT, scale=(1.0, 1.35, 0.72))
tail = add_sphere("tail", (0, BR * 0.92, BZ + BR * 0.35), TL * 0.30, MAT_ACCENT, scale=(0.55, 1.5, 0.55), segments=16, rings=10)

# 根空物体：所有变换都作用在它上面，便于整体抬起/倾斜/旋转
bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
root = bpy.context.active_object
root.name = "pet_root"
for ob in parts:
    ob.parent = root
    ob.matrix_parent_inverse = root.matrix_world.inverted()

# ---------------------------------------------------------------- 灯光 + 相机
bpy.ops.object.light_add(type="AREA", location=(-2.4, -3.0, 3.4))
key = bpy.context.active_object
key.name = "key_light"
key.data.energy = 900
key.data.size = 3.0

bpy.ops.object.light_add(type="AREA", location=(2.8, -1.6, 1.6))
fill = bpy.context.active_object
fill.name = "fill_light"
fill.data.energy = 260
fill.data.size = 3.0

bpy.ops.object.light_add(type="AREA", location=(0.0, 3.2, 2.2))
rim = bpy.context.active_object
rim.name = "rim_light"
rim.data.energy = 320
rim.data.size = 2.5

bpy.ops.object.camera_add(location=(0, -6.0, 0.95))
cam = bpy.context.active_object
cam.name = "pet_cam"
cam.data.type = "ORTHO"
cam.data.ortho_scale = 2.35
cam.rotation_euler = (math.radians(90), 0, 0)
scene.camera = cam

# ---------------------------------------------------------------- 姿势表
TAU = math.pi * 2.0

def pose_idle(t, n):
    b = (1 - math.cos(TAU * t)) / 2.0
    return dict(lift=0.022 * b, tilt=0.0, squash=(1 - 0.010 * b, 1 + 0.018 * b),
                ear=0.0, arm=0.0, foot=0.0, spin=0.0)

def pose_run(t, n):
    s = math.sin(TAU * t)
    return dict(lift=abs(math.sin(TAU * t * 2)) * 0.05, tilt=-math.radians(7),
                squash=(1.0, 1.0), ear=s * 0.25, arm=s * 0.55, foot=s * 0.42, spin=0.0)

def pose_waving(t, n):
    s = math.sin(TAU * t)
    return dict(lift=abs(s) * 0.02, tilt=s * math.radians(3),
                squash=(1 + 0.02 * abs(s), 1 + 0.015 * abs(s)), ear=s * 0.2, arm=0.55 + s * 0.95, foot=0.0, spin=0.0)

def pose_jumping(t, n):
    up = math.sin(math.pi * t)
    land = max(0.0, (t - 0.75) / 0.25) if n > 1 else 0.0
    return dict(lift=0.30 * up, tilt=math.sin(TAU * t) * math.radians(6),
                squash=(1 - 0.06 * up + 0.12 * land, 1 + 0.10 * up - 0.14 * land),
                ear=-up * 0.5, arm=-up * 1.1, foot=up * 0.45, spin=0.0)

def pose_failed(t, n):
    fall = min(1.0, (t / 0.55) ** 3) if n > 1 else 1.0
    return dict(lift=-0.05 * fall, tilt=fall * math.radians(78),
                squash=(1.0, 1 - 0.04 * fall), ear=fall * 0.9, arm=fall * 0.8, foot=fall * 0.3, spin=0.0)

def pose_waiting(t, n):
    b = (1 - math.cos(TAU * t)) / 2.0
    s = math.sin(TAU * t)
    return dict(lift=0.03 * b, tilt=s * math.radians(2.5),
                squash=(1 - 0.008 * b, 1 + 0.022 * b), ear=s * 0.12, arm=0.0, foot=0.0, spin=0.0)

def pose_running(t, n):
    s = abs(math.sin(TAU * t))
    return dict(lift=0.075 * s, tilt=math.sin(TAU * t * 2) * math.radians(4),
                squash=(1 + 0.045 * s, 1 - 0.05 * s), ear=-s * 0.35, arm=s * 0.85, foot=s * 0.5, spin=0.0)

def pose_review(t, n):
    s = math.sin(TAU * t)
    return dict(lift=0.012 * abs(s), tilt=-math.radians(5) + s * math.radians(5),
                squash=(1.0, 1.0), ear=s * 0.3, arm=0.25, foot=0.0, spin=0.0)

POSE_FN = {
    "idle": pose_idle, "runRight": pose_run, "runLeft": pose_run, "waving": pose_waving,
    "jumping": pose_jumping, "failed": pose_failed, "waiting": pose_waiting,
    "running": pose_running, "review": pose_review,
}

def apply_pose(p, yaw=0.0):
    root.location = (0.0, 0.0, p["lift"])
    root.rotation_euler = (p["tilt"] * 0.35, 0.0, yaw + p["spin"])
    sx, sy = p["squash"]
    root.scale = (sx, sy, sy)
    for ob in (ear_l, ear_r):
        ob.rotation_euler = (0.22 + p["ear"] * 0.7, 0.0, 0.0)
    arm_l.rotation_euler = (p["arm"], 0.0, 0.0)
    arm_r.rotation_euler = (-p["arm"], 0.0, 0.0)
    arm_l.location = (-BR * 1.02, 0.0, BZ + BR * 0.18 + p["arm"] * 0.06)
    arm_r.location = (BR * 1.02, 0.0, BZ + BR * 0.18 + p["arm"] * 0.06)
    foot_l.location = (-BR * 0.45, -BR * 0.08 + p["foot"] * 0.16, FR * 0.72 + max(0.0, p["foot"]) * 0.09)
    foot_r.location = (BR * 0.45, -BR * 0.08 - p["foot"] * 0.16, FR * 0.72 + max(0.0, -p["foot"]) * 0.09)
    tail.rotation_euler = (0.0, 0.0, p["ear"] * 0.4)

def render_to(path):
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)

def png_has_content(path):
    """读回刚写出的 PNG，看有没有非透明像素。
    用来抓"引擎能跑但产出全透明图"这种静默失败——光看退出码是发现不了的。

    注意不要用 bpy.data.images["Render Result"]：在 --background 下它的 pixels
    经常还没填充，会误报"空"（实测如此）。读文件才可信。
    """
    try:
        if not os.path.exists(path):
            return None
        img = bpy.data.images.load(path, check_existing=False)
        try:
            px = img.pixels[:]
            for i in range(3, len(px), 4):
                if px[i] > 0.02:
                    return True
            return False
        finally:
            bpy.data.images.remove(img)
    except Exception:
        return None

report = {"engine": engine, "actions": {}, "yaw": 0, "renders": 0, "background": bool(bpy.app.background)}

# ---------------------------------------------------------------- 预检
# 先渲染一帧看看是不是空的；空的就切 Cycles 重来。
# 这样无论用户用的是无头模式还是 MCP，都不会悄悄产出一整包透明图。
apply_pose(pose_idle(0.0, 6))
pre_path = os.path.join(RENDERS, "_preflight.png")
try:
    render_to(pre_path)
    has = png_has_content(pre_path)
    report["preflight"] = {"engine": scene.render.engine, "hasContent": has}
    if has is False and scene.render.engine != "CYCLES":
        before = scene.render.engine
        switched = try_engine(["CYCLES"])
        scene.render.engine = switched
        configure_engine()
        render_to(pre_path)
        report["engineSwitch"] = {"from": before, "to": switched, "hasContent": png_has_content(pre_path)}
        report["engine"] = switched
except Exception as e:
    report["preflightError"] = str(e)
finally:
    try:
        os.remove(pre_path)
    except Exception:
        pass


# ---------------------------------------------------------------- 渲染动作
for action in ACTIONS:
    fn = POSE_FN.get(action)
    if fn is None:
        continue
    n = int(FRAMES.get(action, 6))
    n = max(1, min(8, n))
    for i in range(n):
        t = (i / float(n)) if n > 0 else 0.0
        p = fn(t, n)
        yaw = math.pi if action == "runLeft" else 0.0
        apply_pose(p, yaw)
        render_to(os.path.join(RENDERS, "%s_%03d.png" % (action, i)))
        report["renders"] += 1
    report["actions"][action] = n

# ---------------------------------------------------------------- 渲染环视（3D 特征）
if SPEC.get("renderLookRows", True) and YAW_COUNT > 0:
    base = pose_idle(0.0, 6)
    for i in range(YAW_COUNT):
        yaw = (TAU * i) / float(YAW_COUNT)
        apply_pose(base, yaw)
        render_to(os.path.join(RENDERS, "look_%02d.png" % i))
        report["renders"] += 1
    report["yaw"] = YAW_COUNT

# ---------------------------------------------------------------- 导出 GLB
glb_path = None
if SPEC.get("exportGlb", True):
    try:
        glb_path = os.path.join(OUT, "pet.glb")
        kw = dict(filepath=glb_path, export_format="GLB")
        try:
            bpy.ops.export_scene.gltf(export_apply=True, **kw)
        except TypeError:
            bpy.ops.export_scene.gltf(**kw)
    except Exception as e:
        glb_path = None
        report["glbError"] = str(e)

report["glb"] = glb_path
with open(os.path.join(OUT, "render-report.json"), "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print("PET_FORGE_RENDER_DONE " + json.dumps(report, ensure_ascii=False))
`
}

/** 找到 Blender 并用无头方式执行脚本。 */
export function runHeadless(opts) {
  const exe = opts.blenderPath || findBlender()
  if (!exe) {
    return {
      ok: false,
      error: '未找到 blender.exe。请用 --blender <路径> 指定，或设置 DSH_BLENDER_PATH 环境变量，' +
             '或改用 Blender MCP（见 SKILL.md「3D 路线」）。',
    }
  }
  const args = ['--background', '--factory-startup', '--python', opts.scriptPath, '--', opts.specPath]
  const reportPath = join(opts.outDir || dirname(opts.scriptPath), 'render-report.json')
  const hadReport = existsSync(reportPath)
  const before = hadReport ? safeMtime(reportPath) : 0

  // 尝试 1：捕获输出（诊断信息最全）。
  // 已知坑：本沙箱禁止捕获子进程输出（EPERM），且 windowsHide 会让进程 0xC0000142 退出。
  let r = spawnSync(exe, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 900000,
    maxBuffer: 32 * 1024 * 1024,
    cwd: opts.cwd,
  })
  let captured = !r.error
  if (r.error && (r.error.code === 'EPERM' || r.error.code === 'EACCES')) {
    // 尝试 2：放弃捕获输出，仅看文件系统产物判断成功
    r = spawnSync(exe, args, { stdio: 'ignore', timeout: opts.timeoutMs ?? 900000, cwd: opts.cwd })
    captured = false
  }

  // 成功判据以"渲染报告是否被刷新"为准——比退出码更贴近事实
  // （Blender 有时渲染完了仍以非 0 退出，有时吞掉错误后返回 0）
  const wroteReport = existsSync(reportPath) && (!hadReport || safeMtime(reportPath) > before)
  const ok = wroteReport || r.status === 0

  return {
    ok,
    blender: exe,
    status: r.status,
    captured,
    wroteReport,
    reportPath: wroteReport ? reportPath : null,
    stdout: captured ? (r.stdout || '').slice(-8000) : '(沙箱禁止捕获输出，已改用文件系统判据)',
    stderr: captured ? (r.stderr || '').slice(-8000) : '',
    error: ok ? undefined : (r.error ? `无法启动 Blender：${r.error.message}` : `Blender 退出码 ${r.status}，且未产出渲染报告`),
  }
}

function safeMtime(path) {
  try { return statSync(path).mtimeMs } catch { return 0 }
}

/**
 * 把 model/renders/ 下的 PNG 装配成标准图集行。
 *
 * ⚠️ 为什么这里还要做一次"并集包围盒 + 统一缩放"：
 *   Blender 是**直接按 192×208 渲染**的，跳跃（抬高 0.3m）和摔倒（旋转 78°）
 *   会把模型顶出画面边缘，产生"跳起来缺头""摔倒半个身子没了"的裁切。
 *   2D 路线在 anim.mjs 里已经用两趟渲染解决了同一问题，这里复用同一套算法，
 *   于是两条路线的产物都满足同一个不裁切保证。
 *
 * @returns {{rowFrames:Object, found:Object, missing:string[], warnings:string[],
 *            lookAngles:Array, emptyFrames:string[], emptyTotal:number, fit:Object}}
 */
export async function assembleFromRenders(spec) {
  const renderDir = spec.renderDir
  if (!existsSync(renderDir)) throw new Error(`渲染目录不存在：${renderDir}（3D 渲染还没跑过？）`)
  const files = await readdir(renderDir)
  const found = {}
  const missing = []
  const warnings = []
  const emptyFrames = []
  let emptyTotal = 0

  /** 载入一帧原始渲染图（保持 Blender 的原始取景，缩放统一在最后一步做）。 */
  const loadRaw = async (file) => {
    const img = await decodeImage(await readFile(join(renderDir, file)))
    if (img.width !== spec.cellW || img.height !== spec.cellH) {
      warnings.push(`${file} 尺寸 ${img.width}×${img.height} ≠ 格子 ${spec.cellW}×${spec.cellH}，已缩放`)
      const scaled = resize(img, spec.cellW, spec.cellH)
      const cell = newImg(spec.cellW, spec.cellH)
      composite(cell, scaled, 0, 0)
      return cell
    }
    return img
  }

  // ---- 第一步：把所有渲染帧读进内存，记录各自的落点 ----
  const slots = [] // { row, col, img }
  for (const action of spec.actions || BLENDER_ACTIONS) {
    const prefix = `${action}_`
    const list = files.filter((f) => f.startsWith(prefix) && f.endsWith('.png')).sort()
    if (list.length === 0) { missing.push(action); continue }
    const row = ACTION_TO_ROW[action]
    if (row === undefined) continue
    let col = 0
    for (const f of list) {
      const img = await loadRaw(f)
      if (alphaBounds(img, 8) === null) {
        emptyTotal++
        if (emptyFrames.length < 12) emptyFrames.push(f)
      }
      slots.push({ row, col, img, file: f })
      col++
    }
    found[action] = list.length
  }

  // runLeft：没有单独渲染就用 runRight 镜像（省一半渲染，左右完全对称）
  const hasRunLeft = slots.some((s) => s.row === 2)
  if (!hasRunLeft && found.runRight) {
    const right = slots.filter((s) => s.row === 1).sort((a, b) => a.col - b.col)
    for (const s of right) slots.push({ row: 2, col: s.col, img: flipX(s.img), file: s.file + '(mirrored)' })
    found.runLeft = right.length
  }

  // 环视帧：每个角度一格，从第 9 行开始排
  const lookFiles = files.filter((f) => /^look_\d+\.png$/.test(f)).sort()
  const lookSlots = []
  if (lookFiles.length > 0) {
    let row = 9
    let col = 0
    for (const f of lookFiles) {
      const img = await loadRaw(f)
      if (alphaBounds(img, 8) === null) {
        emptyTotal++
        if (emptyFrames.length < 12) emptyFrames.push(f)
      }
      lookSlots.push({ row, col, img, file: f })
      col++
      if (col >= 8) { col = 0; row++ }
    }
    found.look = lookFiles.length
  } else {
    missing.push('look')
  }

  // ---- 第二步：全体帧的并集包围盒 → 统一缩放与落位 ----
  const all = slots.concat(lookSlots)
  const bbox = unionBounds(all.map((s) => s.img))
  const fit = { bbox, scale: 1 }
  const projectOpts = {
    cellW: spec.cellW,
    cellH: spec.cellH,
    padX: Math.round(spec.cellW * (spec.padX ?? 0.04)),
    topPad: Math.round(spec.cellH * (spec.topPad ?? 0.04)),
    footPad: Math.round(spec.cellH * (spec.footPad ?? 0.05)),
    maxScale: 1.35,
  }

  const rowFrames = {}
  const lookAngles = []
  if (bbox === null) {
    warnings.push('所有渲染帧都是空的，无法装配')
    return { rowFrames, found, missing, warnings, lookAngles, emptyFrames, emptyTotal, fit }
  }
  fit.scale = Math.min(
    (projectOpts.cellW - projectOpts.padX * 2) / bbox.width,
    (projectOpts.cellH - projectOpts.topPad - projectOpts.footPad) / bbox.height,
    projectOpts.maxScale,
  )

  const byRow = new Map()
  for (const s of slots) {
    if (!byRow.has(s.row)) byRow.set(s.row, [])
    byRow.get(s.row).push(s)
  }
  const projected = new Map()
  for (const [row, list] of byRow) {
    list.sort((a, b) => a.col - b.col)
    const cells = projectFrames(list.map((s) => s.img), bbox, projectOpts)
    rowFrames[row] = []
    // 保持列位置（前面可能有空洞）
    for (let i = 0; i < list.length; i++) rowFrames[row][list[i].col] = cells[i]
    for (let i = 0; i < list.length; i++) projected.set(list[i], cells[i])
  }
  if (lookSlots.length > 0) {
    const cells = projectFrames(lookSlots.map((s) => s.img), bbox, projectOpts)
    for (let i = 0; i < lookSlots.length; i++) {
      const s = lookSlots[i]
      if (!rowFrames[s.row]) rowFrames[s.row] = []
      rowFrames[s.row][s.col] = cells[i]
      lookAngles.push({ row: s.row, col: s.col })
    }
  }

  fit.rendered = { rows: rowFrames ? Object.keys(rowFrames).length : 0, cells: all.length }
  return { rowFrames, found, missing, warnings, lookAngles, emptyFrames, emptyTotal, fit }
}

/** 生成给 agent 看的 MCP 调用配方（SKILL.md 里也会写一遍）。 */
export function mcpRecipe(scriptPath) {
  return {
    tool: 'mcp__blender__execute_blender_code',
    code: `exec(open(r"${scriptPath}", encoding="utf-8").read())`,
    note: '需要 Blender 已启动并在 MCP 插件里 Start Server（localhost:9876）。执行前请确保前置条件工具能连上。',
  }
}
