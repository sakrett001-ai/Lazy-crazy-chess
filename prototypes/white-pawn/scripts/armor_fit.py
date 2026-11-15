"""Armour that lies on the body instead of sinking into it.

Runs in bind space after the geometric modifiers are applied, before morphs.
Every plate here is rigid on one bone; the cloth and skin under it were
skinned on their own. Two mismatches make metal and cloth pass through each
other on the board: surfaces that already cross at rest (the ellipsoid toe
caps and knee cops half buried in the boot and leg) and cloth that bends
with other bones than the plate above it (a sleeve on the arm under a
pauldron, a boot on the foot under a greave on the shin).

1. Closed ellipsoid cops are replaced by shells built on the surface under
   them: the patch of boot or leggings the ellipsoid covered, lifted along
   its normals by a clearance plus a dome, so the plate's inner face never
   goes below the cloth at rest.
2. Every soft vertex (skin, padding, boots, hair) is cast outward from
   its bone; if a plate is within reach it is pushed in until it lies a
   layer clearance under the plate's inner face (padding closest, then skin),
   and a vertex already outside a plate is put back under it.
   The push spreads to neighbours with a decay, so no step shows at the edge.
   The face is left alone: helmet and face hang on the head's bones and move
   as one, and pushing brows and lids under the brim crumples them.
3. A covered vertex whose plate belongs to its own limb, or a limb plate
   covering the torso at its root (a pauldron over the shoulder), takes the
   plate's bone, fading out over a few rings past
   the plate's edge. Under a rigid plate the cloth then moves with the plate.
   Cloth just past the edge of a plate on another bone (a boot shaft below a
   greave, the back of the knee above it) leans on the plate's bone by
   distance, so the hem does not cut into it when the joint bends.
4. Mail is worn instead of the plates, not under them: it keeps its shape and
   copies the weights of the padding under it, so the two bend together. The
   padding is pushed only where it shows in the plate kit alone (the build's
   own split: the mail hides it, no plate does), so in the mail kit nothing
   that shows has moved toward the mail; and no deeper under the mail than
   DEEP, so the mail can still follow it and the split still finds the mail
   over it, however the push folds it.
"""
import bpy, bmesh, math
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

REACH = .035          # plate further than this from the cloth is not covering it
POKE = .03            # how far a vertex may be outside a plate and still be put back
CLEAR = {'mail': .0025, 'padding': .0045, 'hair': .004, 'base': .006}
SPREAD = (5, .6)      # push dilation: rings, decay per ring
FADE = (4, .7)        # weight fade past the plate edge
WALL = .012           # a vertex this close under a plate's outer face, with no inner face between, is inside the wall
NEAR = .035           # cloth this close to a plate edge on another bone leans on the plate's bone
GATE = 3              # rings over which the padding's push fades in from the mail's edge
MATCH = .03           # mail copies the weights of padding this close under it
DEEP = .014           # padding is pushed at most this far under the mail: within the split's NEAR of it, whatever the fold
SOFT = ('base', 'padding', 'mail', 'hair')
LEAVE = ('CLOTH_Waist belt', 'CLOTH_Leather girdle')  # leather worn over the plates


def _bone_of(ob, i):
    best, name = 0, None
    for g in ob.data.vertices[i].groups:
        if g.weight > best: best, name = g.weight, ob.vertex_groups[g.group].name
    return name


def _limb(bone):
    b = bone or ''
    side = b[-1] if b[-2:-1] == '.' else ''
    for k, g in (('upperarm', 'arm'), ('lowerarm', 'arm'), ('wrist', 'arm'), ('finger', 'arm'), ('metacarpal', 'arm'),
                 ('upperleg', 'leg'), ('lowerleg', 'leg'), ('foot', 'leg'), ('toe', 'leg')):
        if b.startswith(k): return g + side
    if b.startswith(('head', 'jaw', 'eye', 'tongue', 'teeth')): return 'head'
    return 'torso'


def related(soft_bone, plate_bone):
    a, b = _limb(soft_bone), _limb(plate_bone)
    if a == 'head' and soft_bone != 'head': return False  # eyes and jaw keep their own bones under the helmet
    if a == b: return True
    # a limb plate over the torso at the limb's root: the shoulder only. A tasset on the thigh
    # hangs below the breastplate's hem, and hip cloth on the thigh's bone would swing into it
    return a == 'torso' and plate_bone.startswith(('upperarm01', 'clavicle', 'shoulder'))


def _outward(rig, bone, co):
    b = rig.data.bones.get(bone)
    if not b: return None
    h, t = b.head_local, b.tail_local
    d = t - h; s = max(0, min(1, (co - h).dot(d) / max(d.length_squared, 1e-9)))
    o = co - (h + d * s)
    return o.normalized() if o.length > 1e-6 else None


def _rigid_bone(ob):
    names = {g.index: g.name for g in ob.vertex_groups}
    for v in ob.data.vertices:
        for g in v.groups:
            if g.weight > .5: return names[g.group]


def _hard_tree(objects):
    verts, polys, owner = [], [], []
    for ob in objects:
        m, base, bone = ob.matrix_world, len(verts), _rigid_bone(ob)
        verts += [m @ v.co for v in ob.data.vertices]
        for p in ob.data.polygons:
            polys.append([base + i for i in p.vertices]); owner.append(bone)
    return BVHTree.FromPolygons(verts, polys), owner


def cop_shells(objects, rig, clear=.004, thick=.0025):
    """Ellipsoid cops → domed shells resting on the surface under them."""
    by = {o.name: o for o in objects}
    report = []
    import heavy_kit
    for name, under in heavy_kit.COPS:
        cop, surf = by.get(name), by.get(under)
        if not cop or not surf: continue
        bone = _rigid_bone(cop)
        cm = cop.matrix_world; cv = [cm @ v.co for v in cop.data.vertices]
        c = sum(cv, Vector()) / len(cv)
        radii = [max(abs((p - c)[k]) for p in cv) for k in range(3)]
        inside = lambda p, s=1.0: sum(((p - c)[k] / (radii[k] * s)) ** 2 for k in range(3)) <= 1
        sm = surf.matrix_world
        # the surface the ellipsoid sits on: outer faces of the cloth inside a slightly larger ellipsoid, on the cop's side of its bone
        side = 'L' if name.endswith('L') else 'R'
        keep = set()
        for p in surf.data.polygons:
            ws = [sm @ surf.data.vertices[i].co for i in p.vertices]
            ctr = sum(ws, Vector()) / len(ws)
            toe = 'Toe' in name
            if not inside(ctr, 1.5 if toe else 1.12): continue
            nw = sm.to_3x3() @ p.normal
            if nw.dot(ctr - c) < -.2 * (ctr - c).length: continue  # inner wall
            if toe and nw.z < -.3: continue  # the sole
            b = _bone_of(surf, p.vertices[0])
            if under.startswith('CLOTH_Underarm') and not (b or '').endswith('.' + side): continue
            keep.add(p.index)
        if not keep: report.append({'cop': name, 'faces': 0}); continue
        bm = bmesh.new(); bm.from_mesh(surf.data); bm.transform(sm)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in keep], context='FACES')
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
        dl = bm.verts.layers.deform.active
        if dl: bm.verts.layers.deform.remove(dl)  # the cloth's weights; the shell is rigid on the cop's bone
        if 'Toe' in name:  # the boot is coarse: subdivide so the dome and the edge read round
            bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=1, use_grid_fill=True, smooth=1.0)
        bm.normal_update()
        # soften the ragged boundary of the picked faces
        for _ in range(3):
            moved = {}
            for v in bm.verts:
                if v.is_boundary:
                    nb = [e.other_vert(v) for e in v.link_edges if e.is_boundary]
                    if len(nb) == 2: moved[v] = (v.co * 2 + nb[0].co + nb[1].co) / 4
            for v, p in moved.items(): v.co = p
        axis = sum((v.normal for v in bm.verts), Vector()).normalized()
        span = max(((v.co - c) - axis * (v.co - c).dot(axis)).length for v in bm.verts) or 1
        dome = min(radii) * (.15 if any(k in name for k in heavy_kit.FLAT) else .35)
        for v in bm.verts:
            r = ((v.co - c) - axis * (v.co - c).dot(axis)).length / span
            v.co += v.normal * (clear + dome * max(0, 1 - r * r))
        me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
        # keep the plate's own UV layer names: the cloth's extra layers would add a texture set to every plate
        want = [u.name for u in cop.data.uv_layers]
        for i, u in enumerate(list(me.uv_layers)):
            if i < len(want): u.name = want[i]
        for u in list(me.uv_layers):
            if u.name not in want: me.uv_layers.remove(u)
        for p in me.polygons: p.use_smooth = True
        mats = list(cop.data.materials)
        me.materials.clear()
        for m in mats: me.materials.append(m)
        for p in me.polygons: p.material_index = 0
        new = bpy.data.objects.new(name + ' shell', me)
        for coll in cop.users_collection: coll.objects.link(new)
        for k in cop.keys(): new[k] = cop[k]
        g = new.vertex_groups.new(name=bone); g.add(range(len(me.vertices)), 1.0, 'REPLACE')
        a = new.modifiers.new('rig', 'ARMATURE'); a.object = rig
        if len(me.vertices) > 160:  # the cloth under a cop is denser than the plates around it
            d = new.modifiers.new('lighter', 'DECIMATE'); d.ratio = 160 / len(me.vertices)
        s = new.modifiers.new('shell', 'SOLIDIFY'); s.thickness = thick; s.offset = 1; s.use_rim = True
        bpy.ops.object.select_all(action='DESELECT'); new.select_set(True); bpy.context.view_layer.objects.active = new
        for mod in list(new.modifiers):
            if mod.type != 'ARMATURE': bpy.ops.object.modifier_apply(modifier=mod.name)
        objects[objects.index(cop)] = new
        bpy.data.objects.remove(cop)
        new.name = name
        report.append({'cop': name, 'on': under, 'faces': len(keep), 'vertices': len(new.data.vertices)})
    return report


def _smooth(x):
    x = max(0., min(1., x)); return x * x * (3 - 2 * x)


def trim_greaves(objects, rig, heel=.016, knee=.022):
    """Greaves cut like real ones: the hem rises over the heel and the top dips
    behind the knee, so ankle and knee can bend without the edge cutting the
    boot or the back of the knee. Shell and its rolled rims move together."""
    report = []
    for side in 'LR':
        top = rig.data.bones['lowerleg01.' + side].head_local; bot = rig.data.bones['foot.' + side].head_local
        axis = (top - bot).normalized(); length = (top - bot).length
        parts = [o for o in objects if o.name.startswith('ARMOR_Greave ' + side)]
        moved = 0
        for ob in parts:
            m = ob.matrix_world; mi = m.inverted()
            for v in ob.data.vertices:
                co = m @ v.co; a = (co - bot).dot(axis) / length  # 0 at the ankle, 1 at the knee
                r = co - bot - axis * (co - bot).dot(axis)
                if r.length < 1e-6: continue
                back = max(0., r.normalized().y) ** 1.5  # +y is behind the leg
                if not back: continue
                lift = heel * back * _smooth((.45 - a) / .3) - knee * back * _smooth((a - .55) / .3)
                if lift: v.co = mi @ (co + axis * lift); moved += 1
        report.append({'greave': side, 'parts': len(parts), 'vertices': moved})
    return report


def _lean(ob, i, k, bone):
    vg = ob.vertex_groups.get(bone) or ob.vertex_groups.new(name=bone)
    for g in ob.data.vertices[i].groups:
        g.weight *= 1 - k
    vg.add([i], k, 'ADD')


def _follow_padding(ob, pad_co, pad_k):
    """Mail is never worn with the plates, so it is not pushed under them; it
    lies on the padding, which is. Its vertices take the weights of the
    padding vertex nearest them, so in the mail kit the two layers bend alike
    and the padding does not come through the mail."""
    kd = KDTree(len(pad_co))
    for i, c in enumerate(pad_co): kd.insert(c, i)
    kd.balance()
    m = ob.matrix_world; moved = 0
    for i, v in enumerate(ob.data.vertices):
        hit = kd.find(m @ v.co)
        if hit[1] is None or hit[2] > MATCH: continue
        mine = {ob.vertex_groups[g.group].name: g.weight for g in v.groups if g.weight > 0}
        theirs = pad_k[hit[1]]
        if all(abs(mine.get(b, 0) - theirs.get(b, 0)) < 1e-3 for b in set(mine) | set(theirs)): continue
        for g in v.groups: g.weight = 0
        for b, w in theirs.items():
            (ob.vertex_groups.get(b) or ob.vertex_groups.new(name=b)).add([i], w, 'REPLACE')
        moved += 1
    return {'object': ob.name, 'vertices': len(ob.data.vertices), 'pushed': 0, 'maxPushMm': 0, 'reweighted': moved, 'follows': 'padding'}


def _world_tree(obs):
    vs, fs = [], []
    for ob in obs:
        b = len(vs); vs += [ob.matrix_world @ v.co for v in ob.data.vertices]
        fs += [[b + i for i in p.vertices] for p in ob.data.polygons]
    return BVHTree.FromPolygons(vs, fs)


def layer_mask_rest():
    import layer_mask
    return layer_mask.REST


def _under_mail(ob, mail, plates, nbr):
    """Per vertex 0..1: 1 on padding that is shown only in the plate kit (the build's
    own split, layer_mask: the mail hides it and the plates do not), fading to 0 over
    GATE rings toward padding that shows in the mail kit or hides under a plate."""
    import layer_mask
    nf = len(ob.data.polygons)
    by_mail = layer_mask.covered_faces(ob, mail) if mail else [False] * nf
    by_plate = layer_mask.covered_faces(ob, plates) if plates else [False] * nf
    covered = [a and not b for a, b in zip(by_mail, by_plate)]
    n = len(ob.data.vertices); inside = [False] * n
    for p, c in zip(ob.data.polygons, covered):
        if c:
            for i in p.vertices: inside[i] = True
    for p, c in zip(ob.data.polygons, covered):
        if not c:
            for i in p.vertices: inside[i] = False  # a vertex on a shown face stays put
    ring = [0 if not inside[i] else None for i in range(n)]
    front = [i for i in range(n) if ring[i] == 0]
    r = 0
    while front and r < GATE:
        r += 1; nxt = []
        for i in front:
            for j in nbr[i]:
                if ring[j] is None: ring[j] = r; nxt.append(j)
        front = nxt
    return [1.0 if g is None else min(1.0, g / GATE) for g in ring]


def fit(objects, rig):
    import heavy_kit
    # pieces only the veteran wears are a speck in the basis (heavy_kit): nothing lies under them
    hard = [o for o in objects if o['equipmentSlot'] in ('plate', 'helmet') and len(o.data.polygons)
            and not heavy_kit.is_collapsed(o.name)]
    soft = [o for o in objects if o['equipmentSlot'] in SOFT and o.name not in LEAVE and len(o.data.vertices)]
    tree, owner = _hard_tree(hard)
    mail = [o for o in objects if o['equipmentSlot'] == 'mail' and len(o.data.polygons)]
    plates = [o for o in hard if o['equipmentSlot'] == 'plate']
    mtree = _world_tree(mail)
    # the face's own bones hang under 'head': helmet and face move as one, so the face keeps its shape
    face = {b.name for b in rig.data.bones if b.name == 'head' or any(q.name == 'head' for q in b.parent_recursive)}
    report = []
    soft.sort(key=lambda o: o['equipmentSlot'] == 'mail')  # mail last: it copies the padding under it
    pad_co, pad_k = [], []  # every padding vertex after the fit: bind position, (weight, bone)
    for ob in soft:
        me, m = ob.data, ob.matrix_world
        if ob['equipmentSlot'] == 'mail':
            report.append(_follow_padding(ob, pad_co, pad_k)); continue
        mi = m.inverted().to_3x3(); clear = CLEAR[ob['equipmentSlot']]
        n = len(me.vertices)
        push = [0.0] * n; dirs = [None] * n; cover = [None] * n
        outer = [True] * n; bones = [_bone_of(ob, i) for i in range(n)]
        for i, v in enumerate(me.vertices):
            co = m @ v.co; o = _outward(rig, bones[i], co)
            if o is None or bones[i] in face or _limb(bones[i]) == 'head': continue
            dirs[i] = o; outer[i] = (m.to_3x3() @ v.normal).dot(o) > -.1
            loc, nrm, fi, d = tree.ray_cast(co + o * 1e-4, o, REACH)
            if loc is not None and nrm.dot(o) < 0:
                # under a plate: its inner face is d away
                push[i] = max(0, clear - d); cover[i] = owner[fi]
                continue
            if loc is not None and d < WALL:
                # inside a plate's wall (the outer face seen from within): go to its inner face
                loc2, nrm2, fi2, d2 = tree.ray_cast(co - o * 1e-4, -o, WALL)
                if loc2 is not None and nrm2.dot(o) < 0:
                    push[i] = d2 + clear; cover[i] = owner[fi]
                    continue
            # outside a plate? look inward for its outer face, then its inner one
            loc, nrm, fi, d = tree.ray_cast(co - o * 1e-4, -o, POKE)
            if loc is not None and nrm.dot(o) > 0:
                loc2, nrm2, fi2, d2 = tree.ray_cast(loc - o * 1e-4, -o, .02)
                inner = d + (d2 if loc2 is not None and nrm2.dot(o) < 0 else .003)
                push[i] = inner + clear; cover[i] = owner[fi]
        # inner walls of solidified cloth follow the nearest outer wall vertex
        kd = KDTree(n)
        for i, v in enumerate(me.vertices):
            if outer[i]: kd.insert(v.co, i)
        kd.balance()
        for i, v in enumerate(me.vertices):
            if not outer[i]:
                hit = kd.find(v.co)
                if hit[1] is not None and hit[2] < .02:
                    j = hit[1]; push[i] = max(push[i], push[j]); cover[i] = cover[i] or cover[j]
                    dirs[i] = dirs[i] or dirs[j]
        nbr = [[] for _ in range(n)]
        for e in me.edges:
            a, b = e.vertices; nbr[a].append(b); nbr[b].append(a)
        rings, decay = SPREAD
        for _ in range(rings):
            nxt = push[:]
            for i in range(n):
                if nbr[i]: nxt[i] = max(push[i], sum(push[j] for j in nbr[i]) / len(nbr[i]) * decay)
            push = nxt
        if ob['equipmentSlot'] == 'padding':
            # padding is worn under the plates or under the mail, never both. Where a plate
            # covers it the split hides it in the plate kit (and it may stay where it is);
            # where it shows in the mail kit it must not move toward the mail. So it is
            # pushed only where it shows in the plate kit alone: past the plates' edges, under the mail.
            gate = _under_mail(ob, mail, plates, nbr)
            push = [p * g for p, g in zip(push, gate)]
            # and no deeper under the mail than the mail can follow it (MATCH, DEEP)
            for i, v in enumerate(me.vertices):
                if push[i] > 1e-5 and dirs[i] is not None:
                    hit = mtree.ray_cast(m @ v.co, dirs[i], .08)
                    push[i] = 0. if hit[0] is None else min(push[i], max(0., DEEP - hit[3]))  # not under the mail: stays
        rest = [m @ v.co for v in me.vertices]  # where the mail found this padding
        if ob['equipmentSlot'] == 'padding':
            # the split into shown and hidden padding is decided where the mail found it (layer_mask)
            a = me.attributes.get(layer_mask_rest()) or me.attributes.new(layer_mask_rest(), 'FLOAT_VECTOR', 'POINT')
            a.data.foreach_set('vector', [x for v in me.vertices for x in v.co])
        pushed = 0
        for i, v in enumerate(me.vertices):
            if push[i] > 1e-5 and dirs[i] is not None:
                v.co -= mi @ (dirs[i] * push[i]); pushed += 1
        # weights: covered vertices take their plate's bone, fading past the edge
        k = [1.0 if cover[i] and related(bones[i], cover[i]) else 0.0 for i in range(n)]
        target = [cover[i] if k[i] else None for i in range(n)]
        # near a plate edge that bends on another bone (a boot shaft under the
        # greave's hem, the back of the knee under its top): lean on that bone
        for i, v in enumerate(me.vertices):
            if k[i]: continue
            loc, nrm, fi, d = tree.find_nearest(m @ v.co, NEAR)
            if loc is None or owner[fi] == bones[i] or not related(bones[i], owner[fi]): continue
            k[i], target[i] = .9 * (1 - d / NEAR), owner[fi]
        rings, decay = FADE
        for _ in range(rings):
            nk, nt = k[:], target[:]
            for i in range(n):
                for j in nbr[i]:
                    if k[j] * decay > nk[i] and related(bones[i], target[j]):
                        nk[i], nt[i] = k[j] * decay, target[j]
            k, target = nk, nt
        moved = 0
        for i in range(n):
            if k[i]: _lean(ob, i, k[i], target[i]); moved += 1
            if ob['equipmentSlot'] == 'padding':
                pad_co.append(rest[i])
                pad_k.append({ob.vertex_groups[g.group].name: g.weight for g in me.vertices[i].groups if g.weight > 0})
        deepest = {}
        for i in range(n):
            if push[i] > 1e-5 and cover[i]: deepest[cover[i]] = max(deepest.get(cover[i], 0), round(push[i] * 1000, 1))
        r = {'object': ob.name, 'vertices': n, 'pushed': pushed, 'maxPushMm': round(max(push) * 1000, 1), 'reweighted': moved,
             'maxPushMmByPlateBone': deepest}
        report.append(r)
    return report
