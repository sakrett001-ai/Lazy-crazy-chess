"""Battle dents on the plate and helmet, carried by the `veteran` morph.

A recruit's armour is smooth; a veteran's carries the blows it has taken: round
dents from maces and pommels, long shallow creases where an edge skidded off.
Each dent pushes both walls of the shell along the outer normal at its centre,
so the plate keeps its thickness. The profile is a soft crater with a slight
raised lip, depth 4-8 mm: a mace or pommel leaves up to about a centimetre in
1-1.5 mm munition steel without tearing it, and anything shallower is lost at
the distance the board is seen from.

Centres are found by casting a ray from outside the body at the named plate,
so they stay on the surface if the plate shape changes. All dents sit well
inside the plate, away from rolled rims and rivets, which are separate objects.
"""
import math, bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree

# object, point on the body axis, direction outwards, radius (m), depth (m), stretch, stretch direction
DENTS = [
 ('ARMOR_Breastplate', (0, 0, 1.33), (.35, -1, .12), .034, .008, 1, None),
 ('ARMOR_Breastplate', (0, 0, 1.28), (-.42, -1, -.18), .024, .006, 1, None),
 ('ARMOR_Breastplate', (0, 0, 1.36), (.08, -1, .32), .018, .005, 3.2, (1, 0, -.35)),
 ('ARMOR_Backplate', (0, 0, 1.35), (-.3, 1, .1), .030, .007, 1, None),
 ('ARMOR_Pauldron L', (.19, -.02, 1.43), (.45, -.35, 1), .028, .007, 1, None),
 ('ARMOR_Pauldron R', (-.19, -.02, 1.43), (-.5, -.5, 1), .022, .005, 2.2, (0, 1, -.2)),
 ('ARMOR_Greave R', (-.18, 0, .33), (-.1, -1, 0), .024, .005, 1, None),
 ('ARMOR_Greave L', (.18, 0, .30), (.35, -1, 0), .020, .004, 1, None),
 ('ARMOR_Vambrace L', (.43, -.11, 1.18), (.3, -.6, .8), .020, .004, 1, None),
 ('HELMET_Ivory open helmet', (0, -.044, 1.685), (.7, -.25, .6), .028, .007, 1, None),
 ('HELMET_Ivory open helmet', (0, -.044, 1.685), (-.45, .25, .85), .022, .005, 2.6, (0, 1, .4)),
]
TARGETS = sorted({d[0] for d in DENTS})
MAX_CUTS = 2  # at most two cuts per edge around a dent


def _hits(ob, mine):
 """Dent centres on `ob` in world space, found by a ray from outside the body."""
 m = ob.matrix_world
 world = [m @ v.co for v in ob.data.vertices]
 bvh = BVHTree.FromPolygons(world, [list(p.vertices) for p in ob.data.polygons])
 out = []
 for _, axis, direction, radius, depth, stretch, along in mine:
  d = Vector(direction).normalized()
  hit, normal, _, _ = bvh.ray_cast(Vector(axis) + d*.6, -d, 1.2)
  if hit is None: raise RuntimeError('Dent misses ' + ob.name + ' along ' + str(direction))
  out.append((hit, radius, radius*stretch*1.4))
 return world, out


def subdivide(objects):
 """Subdivide only the faces around a dent whose mesh is too coarse to bend into it.

 A dent needs vertices about half its radius apart; where the plate is
 already that fine it is left alone, so the model grows only where it must.
 Returns one entry per dent: the edge length found and the cuts made."""
 report = []
 for ob in objects:
  mine = [d for d in DENTS if d[0] == ob.name]
  world, centres = _hits(ob, mine)
  bm = bmesh.new(); bm.from_mesh(ob.data); bm.edges.ensure_lookup_table()
  edges = set()
  for c, radius, reach in centres:
   near = [e for e in bm.edges if min((world[v.index]-c).length for v in e.verts) < reach]
   spacing = sorted(e.calc_length() for e in near)[len(near)//2] if near else radius
   cuts = max(0, min(MAX_CUTS, math.ceil(spacing/(radius/2)) - 1))
   report.append({'object': ob.name, 'edgeM': round(spacing, 4), 'cuts': cuts})
   if cuts:
    # Whole faces around the dent, so the cut never stops halfway across it.
    faces = {f for e in near for f in e.link_faces}
    edges |= {(e, cuts) for f in faces for e in f.edges}
  for cuts in sorted({k for _, k in edges}, reverse=True):
   chosen = [e for e, k in edges if k == cuts and e.is_valid]
   if chosen: bmesh.ops.subdivide_edges(bm, edges=chosen, cuts=cuts, use_grid_fill=True, smooth=0)
  bm.to_mesh(ob.data); bm.free(); ob.data.update()
 return report


def _profile(r):
 """Crater with a slight lip, r in units of the radius."""
 return math.exp(-3*r*r) - .12*math.exp(-((r-1.05)/.25)**2)


def veteran_offsets(ob):
 """Per-vertex displacement for the dents that fall on `ob` (bind space, local coordinates)."""
 mine = [d for d in DENTS if d[0] == ob.name]
 offsets = [Vector() for _ in ob.data.vertices]
 if not mine: return offsets, []
 m = ob.matrix_world; inv = m.inverted(); rot_inv = inv.to_3x3()
 world = [m @ v.co for v in ob.data.vertices]
 bvh = BVHTree.FromPolygons(world, [list(p.vertices) for p in ob.data.polygons])
 report = []
 for _, axis, direction, radius, depth, stretch, along in mine:
  axis = Vector(axis); d = Vector(direction).normalized()
  hit, normal, _, _ = bvh.ray_cast(axis + d*.6, -d, 1.2)
  if hit is None: raise RuntimeError('Dent misses ' + ob.name + ' along ' + str(direction))
  if normal.dot(d) < 0: normal = -normal
  t1 = Vector(along).normalized() if along else normal.orthogonal().normalized()
  t1 = (t1 - normal*t1.dot(normal)).normalized(); t2 = normal.cross(t1)
  moved = 0
  for i, p in enumerate(world):
   q = p - hit
   if abs(q.dot(normal)) > .03: continue  # only the wall pair at the dent, not the far side
   a, b = q.dot(t1)/stretch, q.dot(t2)
   r = math.sqrt(a*a + b*b)/radius
   if r > 1.6: continue
   offsets[i] += rot_inv @ (-normal*depth*_profile(r)); moved += 1
  report.append({'object': ob.name, 'centreM': [round(x, 4) for x in hit], 'radiusM': radius, 'depthM': depth, 'stretch': stretch, 'vertices': moved})
 return offsets, report
