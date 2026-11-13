"""Feather plume for the pawn's helmet.

Replaces the flat strip of thirteen horsehair tubes with seven trimmed quill
feathers rising from the existing socket and arching back. Each feather has a
tapering rachis and a two-sided vane: bare quill at the root, the widest vane
a little past the middle, a rounded tip. The vane is cupped, its barbs lean
towards the tip and it splits in a few places, as a worn feather does. A
normal map carries the barbs themselves (about 0.8 mm apart).

Coordinates are the pawn's bind space in metres (x left, -y forward, z up);
every part is rigid on the head bone, like the rest of the helmet.
"""
import math, random
from mathutils import Vector

SOCKET = Vector((0, -.026, 1.852))
# (lateral spread, rise, reach back, length scale, ivory?) for each feather
FEATHERS = [(-.062, .070, .165, .84, True), (-.042, .084, .185, .92, False), (-.020, .096, .198, .98, True),
            (0, .104, .206, 1.0, False), (.020, .096, .198, .98, True), (.042, .084, .185, .92, False),
            (.062, .070, .165, .84, True)]
ROWS = 40          # segments along a feather
QUILL = .12        # bare root, fraction of the length
HALF_WIDTH = .026  # widest half-vane, metres
BARB_TEXTURE_LENGTH = .02  # one normal-map tile along the feather, metres


def _bezier(p, t):
 a, b, c, d = p; s = 1-t
 return a*s**3 + b*3*s*s*t + c*3*s*t*t + d*t**3


def spine(spread, rise, back, scale):
 """Up out of the socket, over and back, drooping at the tip."""
 a = SOCKET + Vector((spread*.15, -.006*scale, 0))
 b = a + Vector((spread*.35, -.012, rise*.95))*scale
 c = a + Vector((spread*.8, back*.48, rise*1.12))*scale
 d = a + Vector((spread*1.15, back, rise*-.05))*scale
 return [_bezier((a, b, c, d), i/ROWS) for i in range(ROWS+1)]


def half_width(t):
 if t < QUILL: return 0.
 u = (t-QUILL)/(1-QUILL)
 return HALF_WIDTH*math.sin(math.pi*min(1., u**.75))**.8*(1-.15*u)


def build(mesh, tube, rig_bone, materials, seed=7):
 """Create the feathers; returns the objects. `mesh`/`tube` are the build's helpers."""
 rng = random.Random(seed); made = []
 for k, (spread, rise, back, scale, ivory) in enumerate(FEATHERS):
  pts = spine(spread, rise, back, scale)
  material = materials['ivory' if ivory else 'teal']
  lengths = [0.]
  for i in range(1, len(pts)): lengths.append(lengths[-1]+(pts[i]-pts[i-1]).length)
  total = lengths[-1]
  twist = rng.uniform(-.25, .25)
  splits = {side: set(rng.sample(range(int(ROWS*.35), ROWS-3), 3)) for side in (-1, 1)}
  vs, fs, uv = [], [], []
  across = (-1, -.5, 0, .5, 1)
  for i, p in enumerate(pts):
   t = i/ROWS
   tangent = (pts[min(i+1, ROWS)]-pts[max(i-1, 0)]).normalized()
   lateral = Vector((1, 0, 0)); lateral = (lateral-tangent*lateral.dot(tangent)).normalized()
   face = tangent.cross(lateral).normalized()  # vane normal, roughly up and back
   ang = twist*t+(spread*4)
   lateral, face = lateral*math.cos(ang)+face*math.sin(ang), face*math.cos(ang)-lateral*math.sin(ang)
   w = half_width(t)
   for s in across:
    side = 1 if s > 0 else -1
    r = abs(s)*w
    if s:
     # A split parts the barbs over three rows; the edge is finely ragged where the barb tips end.
     r *= min((1-.32*abs(s)*max(0, 1-abs(i-j)/1.6)) for j in splits[side]) if splits[side] else 1
     if abs(s) == 1: r *= 1-.09*((i*7+k*3) % 3)/2
    # Barbs lean toward the tip and curl down away from the rachis.
    q = p + lateral*(s*(r/abs(s)) if s else 0) + tangent*(abs(s)*w*.35) - face*(s*s*w*.6)
    vs.append(q); uv.append(((s+1)/2, lengths[i]/BARB_TEXTURE_LENGTH))
  n = len(across)
  for i in range(ROWS):
   for j in range(n-1):
    a = i*n+j; fs.append((a, a+1, a+1+n, a+n))
  ob = mesh('HELMET_Plume feather '+str(k), vs, fs, material, rig_bone)
  layer = ob.data.uv_layers.new(name='Surface metres'); ob.data.uv_layers.active = layer; layer.active_render = True
  for poly in ob.data.polygons:
   for li in poly.loop_indices: layer.data[li].uv = uv[ob.data.loops[li].vertex_index]
  made.append(ob)
  radius = [max(.0004, .0017*(1-i/ROWS)**.9) for i in range(ROWS+1)]
  # The rachis rides on the upper face of the vane.
  ridge = [p+(pts[min(i+1, ROWS)]-pts[max(i-1, 0)]).normalized().cross(Vector((1, 0, 0))).normalized()*radius[i]*.6 for i, p in enumerate(pts)]
  made.append(tube('HELMET_Plume quill '+str(k), ridge, radius, material, rig_bone, res=6))
 return made


def barb_height(x, y):
 """Barbs 0.83 mm apart in a 20 mm tile, running from the rachis (x=.5) toward the tip."""
 phase = 24*y - 6*abs(x-.5)*2
 return .012*(.5+.5*math.sin(math.tau*phase))**1.5
