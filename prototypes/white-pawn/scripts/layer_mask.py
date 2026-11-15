"""Hide padding that is fully covered by mail or plate.

The quilted layer is skinned with the same weights as the mail and sits about
12 mm under it. Where an arm folds against the chest or the elbow and shoulder
bend, linear skinning lets the padding pass through the outer layer, which no
offset can prevent. Under an opaque closed outer layer that padding is never
seen, so the build splits it into its own mesh tagged with `hiddenUnder`; the
loadout hides it while that armour is worn. Padding within MARGIN of an outer
edge stays visible, so a hem, armhole or gap between plates still shows cloth.
"""
import bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

REACH = .035    # padding to the outer layer's inner wall is 8-22 mm in bind space
MARGIN = .03    # padding kept visible under the edge of the outer layer
NEAR = .016     # in an armpit crease the normal runs along the fold; the layer is 7-14 mm away
REST = 'fit_rest'  # padding positions before armor_fit pushed them under the plates


def _world_bvh(obs):
 verts, faces = [], []
 for ob in obs:
  m = ob.matrix_world
  base = len(verts)
  verts += [m @ v.co for v in ob.data.vertices]
  faces += [[base+i for i in p.vertices] for p in ob.data.polygons]
 return BVHTree.FromPolygons(verts, faces)


def _tris(p):
 v = list(p.vertices)
 return [(v[0], v[i], v[i+1]) for i in range(1, len(v)-1)]


SURE = .93      # the split decides inside these fractions of NEAR and REACH, so the audit's own
                # measurement of the exported triangles cannot land just past the line


def _covered(bvh, c, n):
 if bvh.find_nearest(c, NEAR * SURE)[0] is not None: return True
 return any(bvh.ray_cast(c + d*.0005, d, REACH * SURE)[0] is not None for d in (n, -n))


def _rest(padding):
 """Object-space vertex positions the split is decided on: before armor_fit's push, if it ran."""
 a = padding.data.attributes.get(REST)
 if a is None: return [v.co.copy() for v in padding.data.vertices]
 flat = [0.0] * (3 * len(padding.data.vertices)); a.data.foreach_get('vector', flat)
 return [Vector(flat[i:i+3]) for i in range(0, len(flat), 3)]


def _hits(padding, bvh, co):
 """Per face: the centre and every triangle centre, along that triangle's own normal, covered
 (the export triangulates quads)."""
 centers, hit = [], []
 for p in padding.data.polygons:
  vs = [co[i] for i in p.vertices]
  c = sum(vs, Vector()) / len(vs)
  n = Vector()
  for i in range(len(vs)): n += vs[i - 1].cross(vs[i])
  n = n.normalized() if n.length > 1e-12 else Vector((0, 0, 1))
  centers.append(c)
  points = [(c, n)]
  for tri in _tris(p):
   a, b, d = (co[v] for v in tri)
   tn = (b - a).cross(d - a)
   points.append(((a + b + d) / 3, tn.normalized() if tn.length > 1e-12 else n))
  hit.append(all(_covered(bvh, q, qn) for q, qn in points))
 return centers, hit


def covered_faces(padding, outer_obs):
 """Faces with the outer layer within NEAR, or within REACH along either normal side,
 eroded so that every face within MARGIN is covered as well. Padding pushed under the
 plates (armor_fit) is judged where it lay before, so pushing it deeper under a plate does
 not make it count as shown."""
 bvh = _world_bvh(outer_obs)
 m = padding.matrix_world
 centers, hit = _hits(padding, bvh, [m @ c for c in _rest(padding)])
 kd = KDTree(len(centers))
 for i, c in enumerate(centers): kd.insert(c, i)
 kd.balance()
 return [hit[i] and all(hit[j] for _, j, _ in kd.find_range(c, MARGIN)) for i, c in enumerate(centers)]


def crossed_faces(padding, outer_obs):
 """Faces the outer layer cuts through where the padding lies now: a plate's rolled edge
 over the cloth at an armhole. The plate is opaque there, so the cloth under it is hidden
 with that plate rather than drawn through it."""
 m = padding.matrix_world
 mine = BVHTree.FromPolygons([m @ v.co for v in padding.data.vertices], [list(p.vertices) for p in padding.data.polygons])
 out = [False] * len(padding.data.polygons)
 for i, _ in mine.overlap(_world_bvh(outer_obs)): out[i] = True
 return out


def _split(ob, keep, name):
 """Copy `ob` keeping only faces where keep[i] is true; returns None if empty."""
 if not any(keep): return None
 import bpy
 dup = ob.copy(); dup.data = ob.data.copy(); dup.name = name
 for c in ob.users_collection: c.objects.link(dup)
 bm = bmesh.new(); bm.from_mesh(dup.data); bm.faces.ensure_lookup_table()
 bmesh.ops.delete(bm, geom=[f for f in bm.faces if not keep[f.index]], context='FACES')
 bm.to_mesh(dup.data); bm.free(); dup.data.update()
 return dup


def apply(merged):
 """Split PADDING_padded by which outer layers cover it; returns new objects and a report."""
 by = {ob.name: ob for ob in merged}
 padding = by['PADDING_padded']
 layers = {'mail': [o for o in merged if o['equipmentSlot'] == 'mail'],
           'plate': [o for o in merged if o['equipmentSlot'] == 'plate']}
 cover = {k: covered_faces(padding, v) for k, v in layers.items()}
 crossed = crossed_faces(padding, layers['plate'])
 cover['plate'] = [a or b for a, b in zip(cover['plate'], crossed)]
 groups = {}
 for i in range(len(padding.data.polygons)):
  key = tuple(k for k in ('mail', 'plate') if cover[k][i])
  groups.setdefault(key, []).append(i)
 report = {'faces': len(padding.data.polygons), 'crossedByPlate': sum(crossed), 'reachMetres': REACH, 'nearMetres': NEAR, 'marginMetres': MARGIN, 'groups': {}}
 created = []
 count = len(padding.data.polygons)
 for key, ids in groups.items():
  if not key: continue
  keep = [False]*count
  for i in ids: keep[i] = True
  name = 'PADDING_padded_under_' + '_'.join(key)
  ob = _split(padding, keep, name)
  ob['equipmentSlot'] = 'padding'; ob['equipmentVariant'] = 'padded'; ob['hiddenUnder'] = ','.join(key)
  ob['defaultVisible'] = padding['defaultVisible'] and 'plate' not in key  # default kit wears plate
  created.append(ob); report['groups'][','.join(key)] = len(ids)
 exposed = [i in set(groups.get((), [])) for i in range(count)]
 bm = bmesh.new(); bm.from_mesh(padding.data); bm.faces.ensure_lookup_table()
 bmesh.ops.delete(bm, geom=[f for f in bm.faces if not exposed[f.index]], context='FACES')
 bm.to_mesh(padding.data); bm.free(); padding.data.update()
 report['groups']['exposed'] = sum(exposed)
 for ob in [padding] + created:
  a = ob.data.attributes.get(REST)
  if a is not None: ob.data.attributes.remove(a)
 return created, report
