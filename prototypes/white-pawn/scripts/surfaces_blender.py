"""Материалы кузницы поверхностей на снаряжении пешки (Blender 4.5).

Карты берутся из prototypes/forge/maps (их печёт prototypes/forge/forge.py на CPU).
Каждому предмету снаряжения добавляется UV-слой «Surface wear» в метрах в
позе привязки; масштаб тайла задаёт узел Mapping, экспорт пишет его как
KHR_texture_transform. Геометрия, скелет и морфы не меняются.

Проекция зависит от предмета:
- оружие — цилиндр вокруг главной оси: волокна древка и риски шлифовки идут вдоль;
- щит — плоскость щита для лица и тыла: доски идут сверху вниз, кромки — по коробке;
- латы и шлем — проекция по доминирующей оси грани, как у кольчуги.
"""
from pathlib import Path
import json, math, sys
import bpy, bmesh
import numpy as np
from mathutils import Vector, Matrix

FORGE = Path(__file__).resolve().parents[2]/'forge'/'maps'
SURFACE_OF = {
 'armor.main': 'steel', 'armor.trim': 'steel', 'shield.trim': 'steel', 'weapon.metal': 'steel',
 'shield.face': 'paint', 'shield.emblem': 'paint',
 'shield.wood': 'wood', 'weapon.wood': 'wood',
 'shield.leather': 'leather', 'weapon.grip': 'leather', 'armor.leather': 'leather',
}
UV = 'Surface wear'


def _image(path, colorspace):
 image = bpy.data.images.load(str(path), check_existing=True)
 image.colorspace_settings.name = colorspace
 image.pack()
 return image


def _pca(points):
 c = sum(points, Vector())/len(points)
 m = [[0.]*3 for _ in range(3)]
 for p in points:
  d = p-c
  for i in range(3):
   for j in range(3): m[i][j] += d[i]*d[j]
 # Степенной метод для трёх осей по убыванию разброса.
 axes = []; mat = Matrix(m)
 for _ in range(3):
  v = Vector((1, .37, .11))
  for a in axes: v -= a*v.dot(a)
  for _ in range(60):
   v = mat@v
   for a in axes: v -= a*v.dot(a)
   if v.length < 1e-12: v = Vector((0, 0, 1)); break
   v.normalize()
  axes.append(v.normalized())
 return c, axes


def _box(p, n):
 axis = max(range(3), key=lambda i: abs(n[i])); a, b = [i for i in range(3) if i != axis]
 return p[a], p[b]


def _smoothed_normals(me, radius=.07):
 """Нормали вершин, усреднённые по соседству radius (вокселями, без scipy)."""
 cell = {}; key = lambda co: (math.floor(co.x/radius), math.floor(co.y/radius), math.floor(co.z/radius))
 for v in me.vertices:
  k = key(v.co); cell[k] = cell.get(k, Vector())+v.normal
 out = []
 for v in me.vertices:
  kx, ky, kz = key(v.co); acc = Vector()
  for dx in (-1, 0, 1):
   for dy in (-1, 0, 1):
    for dz in (-1, 0, 1):
     acc += cell.get((kx+dx, ky+dy, kz+dz), Vector())
  out.append(acc if acc.length > 1e-6 else v.normal.copy())
 return out


HINTS = {}


def _shield_axes(axes):
 front, up, side = axes[2], axes[0], axes[1]
 if 'shield_up' in HINTS and up.dot(HINTS['shield_up']) < 0: up = -up
 if 'shield_right' in HINTS and side.dot(HINTS['shield_right']) < 0: side = -side
 return front, up, side


def assign_uv(ob):
 me = ob.data
 uv = me.uv_layers.get(UV) or me.uv_layers.new(name=UV)
 slot = ob.get('equipmentSlot', '')
 points = [v.co.copy() for v in me.vertices]
 c, axes = _pca(points) if slot in ('weapon', 'shield') else (None, None)
 smooth = _smoothed_normals(me)
 # Ремни: одна UV на вершину, без швов. Просмотр узнаёт лямки щита по числу
 # вершин петли (src/loadout.mjs), шов развёртки сломал бы это узнавание.
 strap = {i for i, s in enumerate(ob.material_slots) if s.material and SURFACE_OF.get(s.material.name) == 'leather'}
 if slot == 'weapon':
  # Радиус развёртки один на всё древко: с радиусом каждой грани соседние
  # грани получали разные UV и делили каждую вершину.
  axis, e1, e2 = axes
  ext1 = max(abs((p-c).dot(e1)) for p in points); ext2 = max(abs((p-c).dot(e2)) for p in points)
  blade = ext2 < .35*ext1
  rs = sorted(math.hypot((p-c).dot(e1), (p-c).dot(e2)) for p in points)
  radius = max(.004, rs[len(rs)//2])
 for face in me.polygons:
  n = face.normal
  if face.material_index in strap:
   for li in face.loop_indices:
    vi = me.loops[li].vertex_index; uv.data[li].uv = _box(me.vertices[vi].co, smooth[vi])
   continue
  # Ось box-проекции берём по нормали, сглаженной на 7 см: области проекции
  # крупные и связные, шов развёртки идёт редкой линией, а не по каждой
  # заклёпке (на кирасе это 14 тыс. лишних вершин в GLB).
  sn = sum((smooth[i] for i in face.vertices), Vector())
  if sn.length > 1e-6: n_box = sn
  else: n_box = n
  if slot == 'weapon':
   if abs(n.dot(axis)) < .7 and not blade:
    mid = face.center-c; r = radius
    ref = math.atan2(mid.dot(e2), mid.dot(e1))
   else: r = None
  elif slot == 'shield':
   front, up, side = _shield_axes(axes)
   flat = abs(n.dot(front)) > .5
  for li in face.loop_indices:
   p = me.vertices[me.loops[li].vertex_index].co
   if slot == 'weapon' and blade:
    # Клинок плоский: проекция на его плоскость, одна UV на вершину, без швов.
    d = p-c; uv.data[li].uv = (d.dot(e1), d.dot(axis))
   elif slot == 'weapon' and r is not None:
    d = p-c; ang = math.atan2(d.dot(e2), d.dot(e1))
    ang = ref+((ang-ref+math.pi) % math.tau)-math.pi  # без разрыва внутри грани
    uv.data[li].uv = (ang*r, d.dot(axis))
   elif slot == 'shield' and flat:
    d = p-c; uv.data[li].uv = (d.dot(side), d.dot(up))
   else:
    uv.data[li].uv = _box(p, n_box)
 return uv


def build_material(mat, surface, info, offset=(0, 0)):
 tile = info['tile_mm']/1000; folder = FORGE/surface
 nodes = mat.node_tree.nodes; links = mat.node_tree.links
 bsdf = nodes.get('Principled BSDF')
 tint = tuple(bsdf.inputs['Base Color'].default_value)[:3]
 for node in list(nodes):
  if node.type not in ('BSDF_PRINCIPLED', 'OUTPUT_MATERIAL'): nodes.remove(node)
 uvnode = nodes.new('ShaderNodeUVMap'); uvnode.uv_map = UV
 mapping = nodes.new('ShaderNodeMapping'); mapping.vector_type = 'POINT'
 mapping.inputs['Scale'].default_value = (1/tile, 1/tile, 1)
 mapping.inputs['Location'].default_value = (offset[0], offset[1], 0)
 links.new(uvnode.outputs['UV'], mapping.inputs['Vector'])
 def tex(name, space):
  t = nodes.new('ShaderNodeTexImage'); t.image = _image(folder/name, space); t.interpolation = 'Linear'
  links.new(mapping.outputs['Vector'], t.inputs['Vector']); return t
 color = tex('base_color.jpg', 'sRGB'); orm = tex('orm.jpg', 'Non-Color'); normal = tex('normal.jpg', 'Non-Color')
 # Цвет фракции — множитель карты (glTF baseColorFactor), карта несёт износ.
 mean = info['mean_color']
 factor = tuple(min(1., t/max(m, 1e-3)) for t, m in zip(tint, mean))
 mix = nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'
 mix.inputs['Factor'].default_value = 1; mix.inputs[7].default_value = (*factor, 1)
 links.new(color.outputs['Color'], mix.inputs[6]); links.new(mix.outputs[2], bsdf.inputs['Base Color'])
 sep = nodes.new('ShaderNodeSeparateColor')
 links.new(orm.outputs['Color'], sep.inputs['Color'])
 links.new(sep.outputs['Green'], bsdf.inputs['Roughness']); links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
 nm = nodes.new('ShaderNodeNormalMap'); nm.uv_map = UV; nm.inputs['Strength'].default_value = 1
 links.new(normal.outputs['Color'], nm.inputs['Color']); links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
 mat['forgeSurface'] = surface; mat['forgeTileMetres'] = tile
 mat['forgeMeanColor'] = list(mean); mat['forgeMeanRoughness'] = info['mean_roughness']
 return mat


def shield_outline(ob, front, side, up, c):
 """Контур лицевой стороны щита в плоскости щита, мм."""
 face_index = ob.material_slots.find(SHIELD_FACE)
 bm = bmesh.new(); bm.from_mesh(ob.data)
 sides = {}
 for f in bm.faces:
  if f.material_index != face_index: continue
  k = f.normal.dot(front)
  if abs(k) > .5: sides.setdefault(k > 0, []).append(f)
 faces = max(sides.values(), key=lambda fs: sum(f.calc_area() for f in fs)); fs = set(faces)
 edges = [e for f in faces for e in f.edges if sum(1 for g in e.link_faces if g in fs) == 1]
 nxt = {}
 for e in edges:
  a, b = e.verts; nxt.setdefault(a, []).append(b); nxt.setdefault(b, []).append(a)
 loops = []; seen = set()
 for start in nxt:
  if start in seen: continue
  loop = [start]; seen.add(start); prev = None; cur = start
  while True:
   cand = [v for v in nxt[cur] if v is not prev and v not in seen]
   if not cand: break
   prev, cur = cur, cand[0]; loop.append(cur); seen.add(cur)
  loops.append(loop)
 loop = max(loops, key=len)
 pts = [((v.co-c).dot(side)*1000, (v.co-c).dot(up)*1000) for v in loop]
 bm.free(); return pts


def build_shield_face(ob, manifest, wear):
 """Своя карта лица щита: износ кромки, следы уколов, грязь снизу."""
 sys.path.insert(0, str(FORGE.parent))
 import fields, forge
 c, axes = _pca([v.co.copy() for v in ob.data.vertices])
 front, up, side = _shield_axes(axes)
 pts = shield_outline(ob, front, side, up, c)
 lo = np.min(pts, 0)-25; hi = np.max(pts, 0)+25; span = float(max(hi-lo))
 outline = [(x-lo[0], y-lo[1]) for x, y in pts]
 variant = ob['equipmentVariant']; size = 1024 if span > 1000 else 512
 h, rgb, rough, metal = fields.shield_face(size, span, outline, seed=13+len(variant), wear=wear)
 folder = FORGE/('shield-'+variant); folder.mkdir(exist_ok=True)
 from PIL import Image
 Image.fromarray(forge.srgb(rgb)).save(folder/'base_color.jpg', quality=88, subsampling=0)
 Image.fromarray(forge.normal_map(h, span/size)).save(folder/'normal.jpg', quality=85, subsampling=0)
 orm = np.stack([np.full(rough.shape, 255, np.uint8), np.round(rough*255).astype(np.uint8), np.round(metal*255).astype(np.uint8)], -1)
 Image.fromarray(orm).save(folder/'orm.jpg', quality=85, subsampling=0)
 inside = fields.polygon_distance(*[a*span for a in fields.grid(size)], outline) > 0
 info = {'tile_mm': span, 'mean_color': [float(x) for x in rgb[inside].mean(0)], 'mean_roughness': float(rough[inside].mean()),
         'size': size, 'wear': wear, 'origin_mm': [float(lo[0]), float(lo[1])]}
 base = bpy.data.materials[SHIELD_FACE]
 mat = base.copy(); mat.name = SHIELD_FACE+'.'+variant; mat['customizationSlot'] = SHIELD_FACE
 for slot in ob.material_slots:
  if slot.material == base: slot.material = mat
 build_material(mat, 'shield-'+variant, info, offset=(-lo[0]/span, -lo[1]/span))
 return info


SHIELD_FACE = 'shield.face'


def apply(objects, wear=.5, hints=None):
 HINTS.update(hints or {})
 manifest = json.loads((FORGE/'manifest.json').read_text())
 done = set(); report = {'objects': [], 'materials': {}}
 for ob in objects:
  if ob.type != 'MESH' or ob.get('equipmentSlot') in (None, 'base', 'padding', 'mail', 'hair', 'beard'): continue
  # Ремни снаряжения получают свою копию кожи: исходную делит тело (обувь).
  for s in ob.material_slots:
   if s.material and s.material.name == 'Dark leather':
    s.material = bpy.data.materials.get('armor.leather') or s.material.copy()
    s.material.name = 'armor.leather'; s.material['customizationSlot'] = 'armor.leather'
  names = {s.material.name for s in ob.material_slots if s.material}
  if not names & SURFACE_OF.keys(): continue
  assign_uv(ob); report['objects'].append(ob.name)
  if ob.get('equipmentSlot') == 'shield' and SHIELD_FACE in names:
   report.setdefault('shields', {})[ob['equipmentVariant']] = build_shield_face(ob, manifest, wear)
   names = {s.material.name for s in ob.material_slots if s.material}
  for name in names & SURFACE_OF.keys():
   if name in done: continue
   surface = SURFACE_OF[name]; build_material(bpy.data.materials[name], surface, manifest['surfaces'][surface])
   done.add(name); report['materials'][name] = surface
 return report
