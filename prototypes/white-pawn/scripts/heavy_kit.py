"""Heavy infantry kit: the recruit is a heavy foot soldier, the veteran grows
into a full man-at-arms (the silhouette study the owner chose: «Смешать»).

Runs on the baseline blend in bind space, before modifiers. The recruit's
pieces are the mesh itself. What only the veteran wears is the 'veteran'
shape key (influence 0 or 1, set by the loadout's experience): VETERAN maps
an object name to the operations that make its veteran shape, applied when
the morphs are built (veteran_shape). A piece only the veteran wears is
shrunk to a speck in the basis ('collapse') and opens to full size in the key.

Recruit: pauldrons ×1.15 with two lames, a broader breastplate with a 12 mm
medial ridge and 6 mm plate, a gorget 18 mm taller at the sides and back (not under the chin), couters over the elbows,
knee cops ×1.15. Veteran adds: pauldrons another ×1.06 with a third lame, a
haute-piece on the left (lead) pauldron against cuts at the neck, a 20 mm
ridge, a gorget 30 mm taller, larger couters and poleyns with wings lying on the outer side of the joint,
a nasal and longer cheek guards on the helmet.
"""
import bpy, bmesh, math
from mathutils import Vector, Matrix

VETERAN = {}  # object name → list of operations (see veteran_shape)
SPECK = .01
RIDGE_FOOT = 1.22  # the breastplate's medial ridge rises from here


def _about(p, s):
    s = Vector(s) if not isinstance(s, (int, float)) else Vector((s, s, s))
    return Matrix.Translation(p) @ Matrix.Diagonal((*s, 1)) @ Matrix.Translation(-p)


def veteran_shape(name, cos):
    """Veteran positions for an object's vertices (bind space), or None."""
    ops = VETERAN.get(name)
    if not ops: return None
    out = [c.copy() for c in cos]
    for op in ops:
        kind = op[0]
        if kind == 'about':
            m = _about(Vector(op[1]), op[2]); out = [m @ c for c in out]
        elif kind == 'lift':  # raise everything above z0, growing to h at z0+span (none under the chin)
            z0, span, h = op[1:]
            for c in out:
                if c.z > z0: c.z += h * min(1, (c.z - z0) / span) * chin_clear(c)
        elif kind == 'shift':
            out = [c + Vector(op[1]) for c in out]
        elif kind == 'ridge':  # push the front centre forward
            amt, half, z0 = op[1:]
            for c in out:
                if c.y < -.05: c.y -= amt * max(0, 1 - abs(c.x) / half) * min(1, max(0, (c.z - z0) / .1))
        elif kind == 'cheek':  # cheek guards reach lower at the back; the lower front corner rises clear of the collar
            z1, amt, lift = op[1:]
            for c in out:
                if c.z < z1:
                    back = _smooth01((c.y - CHEEK_FRONT) / .05)
                    c.z += (z1 - c.z) / .06 * (lift * (1 - back) - amt * back)
    return out


NECK_Y = -.025  # front-back centre of the gorget ring
CHEEK_FRONT = -.095  # the cheek guard's lower front corner (bind y)


def chin_clear(c):
    """How much of the gorget's rise a point takes: none at the front under the chin
    (the head bows into it in a guard), all of it from the sides round to the back."""
    a = math.degrees(math.atan2(abs(c.x), -(c.y - NECK_Y)))
    return _smooth01((a - 30) / 50)


def _smooth01(t):
    t = min(1, max(0, t)); return t * t * (3 - 2 * t)


def is_collapsed(name):
    return any(op[0] == 'collapse' for op in VETERAN.get(name, ()))


def collapse(cos):
    c = sum(cos, Vector()) / max(1, len(cos))
    return [c + (p - c) * SPECK for p in cos]


def _veteran(name, *ops):
    VETERAN.setdefault(name, []).extend(ops)


def build(rig):
    sc = bpy.context.scene
    O = bpy.data.objects

    def bone(n): return rig.matrix_world @ rig.data.bones[n].head_local

    def xform(ob, m): ob.data.transform(m); ob.data.update()

    def centre(ob):
        vs = [v.co for v in ob.data.vertices]; return sum(vs, Vector()) / len(vs)

    def skin(ob, bonename):
        g = ob.vertex_groups.new(name=bonename); g.add(range(len(ob.data.vertices)), 1.0, 'REPLACE')
        a = ob.modifiers.new('rig', 'ARMATURE'); a.object = rig
        return ob

    def dup(ob, m, name):
        n = ob.copy(); n.data = ob.data.copy(); n.name = name
        for c in ob.users_collection: c.objects.link(n)
        xform(n, m); return n

    def plate(name, verts, faces, like, thick=.004, bone_=None):
        me = bpy.data.meshes.new(name); me.from_pydata(verts, [], faces); me.update()
        ob = O.new(name, me)
        for c in like.users_collection: c.objects.link(ob)
        for m in like.data.materials: me.materials.append(m)
        s = ob.modifiers.new('s', 'SOLIDIFY'); s.thickness = thick; s.offset = 0
        b = ob.modifiers.new('b', 'BEVEL'); b.width = .0015; b.segments = 2
        for p in me.polygons: p.use_smooth = True
        if bone_: skin(ob, bone_)
        return ob

    def ellipsoid(name, c, radii, like, bone_):
        me = bpy.data.meshes.new(name); bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=12, radius=1)
        for v in bm.verts: v.co = Vector((v.co.x * radii[0], v.co.y * radii[1], v.co.z * radii[2])) + Vector(c)
        bm.to_mesh(me); bm.free()
        ob = O.new(name, me)
        for col in like.users_collection: col.objects.link(ob)
        for m in like.data.materials: me.materials.append(m)
        for p in me.polygons: p.use_smooth = True
        return skin(ob, bone_)

    made = []
    # Pauldrons: bigger, with lames down the arm; the veteran's grow again with a third lame.
    for side in 'LR':
        sgn = 1 if side == 'L' else -1
        sh = bone('upperarm01.' + side); el = bone('lowerarm01.' + side)
        down = (el - sh).normalized()
        piv = Vector((sgn * .10, -.02, 1.44))
        names = ['ARMOR_Pauldron ' + side, 'ARMOR_Pauldron rolled rim ' + side]
        for n in names: xform(O[n], _about(piv, (1.15, 1.15 * .95, 1.15)))
        pa, rim = O[names[0]], O[names[1]]
        k = 1.0
        for i in range(3):
            k *= .9
            c = centre(pa); off = down * (.05 * (i + 1) * 1.15) + Vector((sgn * .012 * (i + 1), 0, 0))
            m = Matrix.Translation(off) @ _about(c, (k, k, k * .8))
            for src, nm in ((pa, f'ARMOR_Pauldron lame {side}{i}'), (rim, f'ARMOR_Pauldron lame rim {side}{i}')):
                lame = dup(src, m, nm); names.append(nm); made.append(nm)
                d = lame.modifiers.new('lighter', 'DECIMATE'); d.ratio = .45  # half hidden under the plate above
                lame.modifiers.move(len(lame.modifiers) - 1, 0)
                if i == 2: _veteran(nm, ('collapse',))
        if side == 'L':
            # haute-piece: a standing guard on the pauldron's inner top edge
            z0 = max(v.co.z for v in pa.data.vertices) - .02
            # it stands off the neck and leans out, so a head bowed to that shoulder meets its face, not its edge
            xs = [sgn * x for x in (.15, .175, .21, .245, .27)]; hs = [.04, .07, .085, .075, .045]
            vs = []
            for x, h in zip(xs, hs):
                y = -.06 + .03 * abs(abs(x) - .2) / .07
                vs += [Vector((x, y, z0)), Vector((x + sgn * .25 * h, y + .012, z0 + h))]
            fs = [(2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1) for i in range(len(xs) - 1)]
            nm = 'ARMOR_Haute-piece ' + side
            plate(nm, vs, fs, pa, .004, 'upperarm01.' + side); names.append(nm); made.append(nm)
            _veteran(nm, ('collapse',))
        for n in names: _veteran(n, ('about', tuple(piv), 1.06))
    # Breastplate: broader, thicker, with a medial ridge; the veteran's ridge stands higher.
    torso = ['ARMOR_Breastplate', 'ARMOR_Backplate', 'ARMOR_Silver Breastplate edge', 'ARMOR_Silver Backplate edge',
             'ARMOR_Central silver ridge'] + [f'ARMOR_Breast rivet{s}' for s in ('', '.001', '.002', '.003', '.004', '.005')]
    for n in torso:
        if n in O: xform(O[n], _about(Vector((0, -.03, 1.30)), (1.06, 1.04, 1.0)))
    # the top fauld tucks under the broader breastplate's hem all round (the elbows pass there in a two-hand guard)
    for n in ('ARMOR_Fauld 0', 'ARMOR_Fauld edge 0'):
        if n in O: xform(O[n], _about(Vector((0, -.03, 1.10)), (.94, .94, 1.0)))
    bp = O['ARMOR_Breastplate']
    # the ridge rises above RIDGE_FOOT: below it the off hand rests on the plate in the ready stance
    for v in bp.data.vertices:
        if v.co.y < -.05: v.co.y -= .012 * max(0, 1 - abs(v.co.x) / .09) * min(1, max(0, (v.co.z - RIDGE_FOOT) / .1))
    bp.data.update()
    for m in bp.modifiers:
        if m.type == 'SOLIDIFY': m.thickness = .006
    r = O['ARMOR_Central silver ridge']
    for v in r.data.vertices: v.co.y -= .012 * min(1, max(0, (v.co.z - RIDGE_FOOT) / .1))
    r.data.update()
    _veteran('ARMOR_Breastplate', ('ridge', .008, .09, RIDGE_FOOT))
    _veteran('ARMOR_Central silver ridge', ('ridge', .008, 1, RIDGE_FOOT))
    # Gorget: taller; the veteran's taller again.
    for n in ('ARMOR_Gorget Front', 'ARMOR_Gorget Back'):
        ob = O[n]
        for v in ob.data.vertices:
            if v.co.z > 1.52: v.co.z += .018 * (v.co.z - 1.52) / .028 * chin_clear(v.co)
        ob.data.update(); _veteran(n, ('lift', 1.52, .046, .012))
    for n in ('ARMOR_Gorget rolled upper Front', 'ARMOR_Gorget rolled upper Back'):
        ob = O[n]
        for v in ob.data.vertices: v.co.z += .018 * chin_clear(v.co)
        ob.data.update(); _veteran(n, ('lift', 1.54, .001, .012))
    for n in ('ARMOR_Gorget side fastening -1', 'ARMOR_Gorget side fastening 1'):
        if n in O: _veteran(n, ('shift', (0, 0, .006)))
    # Couters (elbow cops, built as shells on the sleeve by armor_fit) and knee cops ×1.15.
    vam = O['ARMOR_Vambrace L']; knee_like = O['ARMOR_Knee L']
    for side in 'LR':
        sgn = 1 if side == 'L' else -1
        el = bone('lowerarm01.' + side)
        c = el + Vector((sgn * .01, .03, 0))
        nm = 'ARMOR_Couter ' + side
        ellipsoid(nm, c, (.05, .045, .05), vam, 'lowerarm01.' + side); made.append(nm)
        _veteran(nm, ('about', tuple(c), 1.16))
        # wings: plates on the outer side of the joint, built as shells on the sleeve and leg like the cops
        wc = c + Vector((sgn * .04, -.005, 0))
        nm = f'ARMOR_Couter wing {side}'
        ellipsoid(nm, wc, (.035, .05, .06), vam, 'lowerarm01.' + side); made.append(nm); _veteran(nm, ('collapse',))
        kn = O['ARMOR_Knee ' + side]; kc = centre(kn)
        xform(kn, _about(kc, 1.15)); _veteran(kn.name, ('about', tuple(kc), 1.12))
        nm = f'ARMOR_Poleyn wing {side}'
        ellipsoid(nm, kc + Vector((sgn * .055, .02, 0)), (.04, .05, .06), knee_like, 'lowerleg01.' + side)
        made.append(nm); _veteran(nm, ('collapse',))
    # Helmet: the veteran's carries a nasal and longer cheek guards.
    h = O['HELMET_Ivory open helmet']
    front = min(v.co.y for v in h.data.vertices)
    # the nasal stands clear of the nose: its foot is 10 mm in front of the nose tip
    body = O['BODY_Human']
    tip = min(v.co.y for v in body.data.vertices if 1.58 < v.co.z < 1.72 and abs(v.co.x) < .02)
    top, foot = min(front - .004, tip - .004), tip - .012
    plate('HELMET_Nasal', [Vector((-.009, top, 1.705)), Vector((.009, top, 1.705)),
                           Vector((.007, foot, 1.6)), Vector((-.007, foot, 1.6))], [(0, 1, 2, 3)], h, .004, 'head')
    made.append('HELMET_Nasal'); _veteran('HELMET_Nasal', ('collapse',))
    for n in ('HELMET_Cheek guard L', 'HELMET_Cheek guard R', 'HELMET_Cheek edge L', 'HELMET_Cheek edge R'):
        _veteran(n, ('cheek', 1.66, .008, .02))
    return made


# Cops the fitter rebuilds as shells on the surface under them.
COPS = [(f'ARMOR_{k} {s}', u.format(s=s)) for s in 'LR'
        for k, u in (('Toe cap', 'CLOTH_Boot {s}'), ('Knee', 'CLOTH_Underarm and leggings'), ('Couter', 'CLOTH_Underarm and leggings'),
                     ('Poleyn wing', 'CLOTH_Underarm and leggings'), ('Couter wing', 'CLOTH_Underarm and leggings'))]
FLAT = ('Toe', 'wing')  # cops with a low dome
