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


def _covered(bvh, c, n):
 if bvh.find_nearest(c, NEAR)[0] is not None: return True
 return any(bvh.ray_cast(c + d*.0005, d, REACH)[0] is not None for d in (n, -n))


def covered_faces(padding, outer_obs):
 """Faces with the outer layer within NEAR, or within REACH along either normal side,
 eroded so that every face within MARGIN is covered as well."""
 bvh = _world_bvh(outer_obs)
 m = padding.matrix_world; rot = m.to_3x3()
 centers, hit = [], []
 for p in padding.data.polygons:
  c = m @ p.center; n = (rot @ p.normal).normalized(); centers.append(c)
  # The face centre and every triangle centre must be covered: the export triangulates quads.
  points = [c] + [m @ (sum((padding.data.vertices[v].co for v in tri), Vector())/3) for tri in _tris(p)]
  hit.append(all(_covered(bvh, q, n) for q in points))
 kd = KDTree(len(centers))
 for i, c in enumerate(centers): kd.insert(c, i)
 kd.balance()
 return [hit[i] and all(hit[j] for _, j, _ in kd.find_range(c, MARGIN)) for i, c in enumerate(centers)]


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
 groups = {}
 for i in range(len(padding.data.polygons)):
  key = tuple(k for k in ('mail', 'plate') if cover[k][i])
  groups.setdefault(key, []).append(i)
 report = {'faces': len(padding.data.polygons), 'reachMetres': REACH, 'nearMetres': NEAR, 'marginMetres': MARGIN, 'groups': {}}
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
 return created, report
