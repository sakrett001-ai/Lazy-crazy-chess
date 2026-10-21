"""Read-only strap clearance audit of the authored scene, including complete anatomy.

Run with the asset-runtime Python that provides bpy. No .blend is saved.
--step 1 checks each animation frame; default6 is a development sample plus phase landmarks.
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse, json, hashlib, math
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--blend', type=Path, default=ROOT/'assets/white-pawn.blend')
parser.add_argument('--glb', type=Path, help='Associated export for provenance; defaults to standard asset only for the standard .blend')
parser.add_argument('--report', type=Path, default=ROOT/'review/geometry-checks.json')
parser.add_argument('--step', type=int, default=6)
parser.add_argument('--neutral-only', action='store_true')
parser.add_argument('--clip', action='append', choices=['Guard_Breath', 'Shield_Brace', 'Spear_Study'], help='Repeat to restrict development audit clips')
parser.add_argument('--frames', type=float, nargs='+', help='Explicit development frame subset; replaces step and phase samples')
args = parser.parse_args()
if args.step < 1: raise ValueError('--step must be positive')
if args.frames is not None and any(not math.isfinite(f) or f < 0 for f in args.frames): raise ValueError('--frames must be finite and nonnegative')
checked_at = datetime.now(timezone.utc).isoformat()
blend_sha256 = hashlib.sha256(args.blend.read_bytes()).hexdigest()
glb = args.glb
if glb is None and args.blend.resolve() == (ROOT/'assets/white-pawn.blend').resolve():
    glb = ROOT/'assets/white-pawn.glb'
glb_sha256 = hashlib.sha256(glb.read_bytes()).hexdigest() if glb is not None else None
bpy.ops.wm.open_mainfile(filepath=str(args.blend))
scene = bpy.context.scene
rig = next(o for o in scene.objects if o.type == 'ARMATURE' and o.name.startswith('WhitePawn'))
if rig.animation_data:
    for track in rig.animation_data.nla_tracks: track.mute = True
    rig.animation_data.action = None

# Hidden skin was removed from BODY_Human. Append an intact anatomical reference;
# testing the remaining skin alone would incorrectly certify buried equipment.
base = ROOT.parent/'human-base/assets/human-base.blend'
with bpy.data.libraries.load(str(base), link=False) as (source, target):
    target.objects = ['Human body']
full = target.objects[0]
full.name = 'AUDIT_Intact body reference'
scene.collection.objects.link(full)
full.parent = rig
for modifier in full.modifiers:
    if modifier.type == 'ARMATURE': modifier.object = rig

straps = [o for o in scene.objects if o.type == 'MESH' and (o.name.startswith('ARMOR_Shoulder leather strap') or o.name.startswith('SHIELD_Leather enarme'))]
if not straps: raise RuntimeError('No shoulder straps or shield enarmes found; cannot certify empty selection')
required = ['BODY_Human', 'CLOTH_Underarm and leggings', full.name]
for name in required:
    if name not in bpy.data.objects: raise RuntimeError('Missing clearance target: '+name)
armor_prefixes = ('ARMOR_Breastplate', 'ARMOR_Backplate', 'ARMOR_Gorget', 'ARMOR_Pauldron', 'ARMOR_Vambrace L', 'ARMOR_Silver Breastplate edge', 'ARMOR_Silver Backplate edge', 'ARMOR_Silver breastplate edge')
targets = [bpy.data.objects[n] for n in required] + [o for o in scene.objects if o.type == 'MESH' and o.name.startswith(armor_prefixes)]
objects = {o.name: o for o in straps + targets}

# Match the export's geometry-first, skinning-second modifier sequence in memory.
# The source file and original mesh data on disk remain untouched.
for obj in objects.values():
    armatures = [m for m in obj.modifiers if m.type == 'ARMATURE']
    for mod in armatures: mod.show_viewport = mod.show_render = False
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    for mod in list(obj.modifiers):
        if mod.type != 'ARMATURE': bpy.ops.object.modifier_apply(modifier=mod.name)
    for mod in armatures: mod.show_viewport = mod.show_render = True

def evaluated(obj, deps):
    ev = obj.evaluated_get(deps)
    mesh = ev.to_mesh()
    mesh.calc_loop_triangles()
    vertices = [ev.matrix_world @ v.co for v in mesh.vertices]
    triangles = [tuple(t.vertices) for t in mesh.loop_triangles]
    ev.to_mesh_clear()
    return vertices, triangles, BVHTree.FromPolygons(vertices, triangles, all_triangles=True)

def ray_inside(tree, point, direction):
    """Odd crossing parity; two independent rays must agree for a buried vertex."""
    origin = point.copy()
    hits = 0
    for _ in range(40):
        location, normal, index, distance = tree.ray_cast(origin, direction, 5)
        if location is None: break
        hits += 1
        origin = location + direction*1e-5
    return hits % 2 == 1

directions = [Vector((1,.237,.159)).normalized(), Vector((-.171,1,.219)).normalized()]
rows, buried, inside_vambrace, frames_checked = [], [], [], []
probe_checked = False
negative_control = None
phase_frames = {'Guard_Breath': [0, 140.7, 180], 'Shield_Brace': [0, 19.5, 49.5, 63, 111, 120], 'Spear_Study': [0, 16.5, 36, 37.5, 57, 63, 84, 112.5, 120]}
for clip in (args.clip or ('Guard_Breath', 'Shield_Brace', 'Spear_Study')):
    if clip not in bpy.data.actions: raise RuntimeError('Missing clip '+clip)
    action = bpy.data.actions[clip]
    rig.animation_data.action = action
    end = int(action.frame_range[1])
    samples = [0] if args.neutral_only else sorted(set(range(0,end+1,args.step)) | {f for f in phase_frames[clip] if f <= end} | {end})
    if args.frames is not None:
        if any(f > end for f in args.frames): raise ValueError('--frames exceeds '+clip+' frame range')
        samples = sorted(set(args.frames))
    for frame in samples:
        scene.frame_set(int(frame), subframe=frame-int(frame))
        bpy.context.view_layer.update()
        deps = bpy.context.evaluated_depsgraph_get()
        data = {name:evaluated(obj,deps) for name,obj in objects.items()}
        frames_checked.append({'clip':clip,'frame':frame,'seconds':frame/30})
        for strap in straps:
            sv, st, sb = data[strap.name]
            relevant = targets if strap.name.startswith('ARMOR_') else [o for o in targets if not o.name.startswith('ARMOR_Pauldron')]
            for target in relevant:
                tv, tt, tb = data[target.name]
                overlaps = sb.overlap(tb)
                if overlaps:
                    indices = sorted({i for i,j in overlaps})
                    verts = sorted({v for i in indices for v in st[i]})
                    center = sum((sv[i] for i in verts),Vector())/len(verts)
                    rows.append({'clip':clip,'frame':frame,'seconds':frame/30,'source':strap.name,'target':target.name,'trianglePairs':len(overlaps),'sourceHitTriangles':len(indices),'sourceTriangles':len(st),'regionCenterM':list(center)})
            # Detect fully buried strap islands too, which surface-overlap alone misses.
            body_tree = data[full.name][2]
            inside = []
            for i, point in enumerate(sv):
                near = body_tree.find_nearest(point)
                if near[0] is not None and near[3] > .001 and all(ray_inside(body_tree,point,d) for d in directions): inside.append(i)
            if inside: buried.append({'clip':clip,'frame':frame,'source':strap.name,'buriedVertexCount':len(inside),'exampleVertices':inside[:12]})
            # A band can be wholly in the air gap between skin and armor without
            # intersecting either. Check radial ordering against the actual vambrace.
            if strap.name.startswith('SHIELD_Leather enarme'):
                tree = data['ARMOR_Vambrace L'][2]
                elbow = rig.matrix_world @ rig.pose.bones['lowerarm01.L'].head
                wrist = rig.matrix_world @ rig.pose.bones['wrist.L'].head
                axis = wrist-elbow
                hidden, minimum_clearance = [], math.inf
                for i, point in enumerate(sv):
                    fraction = max(0,min(1,(point-elbow).dot(axis)/axis.length_squared))
                    origin = elbow+axis*fraction
                    radial = point-origin
                    if radial.length < 1e-6: continue
                    direction = radial.normalized()
                    ray_origin, outer_radius = origin.copy(), None
                    for _ in range(12):
                        hit = tree.ray_cast(ray_origin,direction,.2)
                        if hit[0] is None: break
                        radius = (hit[0]-origin).dot(direction)
                        if radius > .2: break
                        outer_radius = radius
                        ray_origin = hit[0]+direction*1e-5
                    if outer_radius is not None:
                        clearance = radial.length-outer_radius
                        minimum_clearance = min(minimum_clearance,clearance)
                        if clearance < -.001: hidden.append(i)
                if hidden: inside_vambrace.append({'clip':clip,'frame':frame,'source':strap.name,'target':'ARMOR_Vambrace L','verticesInsideOuterArmor':len(hidden),'minimumRadialClearanceM':minimum_clearance,'exampleVertices':hidden[:12]})
        if not probe_checked:
            # A triangle crossing an actual cloth face must be detected. This checks
            # that coordinates and the BVH test are live, not merely an empty query.
            vertices, triangles, tree = data['CLOTH_Underarm and leggings']
            tri = next(t for t in triangles if all(1.2 < vertices[i].z < 1.45 for i in t))
            a,b,c = [vertices[i] for i in tri]
            center = (a+b+c)/3
            normal = (b-a).cross(c-a).normalized()
            tangent = (b-a).normalized()
            probe = BVHTree.FromPolygons([center+normal*.01,center-normal*.01+tangent*.004,center-normal*.01-tangent*.004],[(0,1,2)],all_triangles=True)
            count = len(probe.overlap(tree))
            negative_control = {'name':'Deliberate probe through actual evaluated cloth is detected','passed':count>0,'trianglePairs':count}
            probe_checked = True
        if frame == samples[0] or frame == samples[-1] or frame % 30 == 0: print('GEOMETRY_FRAME',clip,frame,flush=True)

result = {
    'status':'failed' if rows or buried or inside_vambrace or not negative_control['passed'] else 'passed',
    'checkedAt':checked_at,
    'blendPath':str(args.blend),
    'blendSha256':blend_sha256,
    'glbPath':str(glb) if glb is not None else None,
    'glbSha256':glb_sha256,
    'baseBodySha256':hashlib.sha256(base.read_bytes()).hexdigest(),
    'sources':[o.name for o in straps], 'targets':[o.name for o in targets],
    'frames':frames_checked, 'overlaps':rows, 'buriedBodyVertices':buried, 'enarmesInsideVambrace':inside_vambrace,
    'negativeControl':negative_control,
    'scope':'Authored scene evaluated with export modifier ordering and intact base anatomy. Associated GLB hash is provenance, not a claim of evaluating that exported topology here. No disk model mutation. Tests straps against body, underclothes and armor; own rivets/backing/mounting studs are excluded. Enarmes must lie outside the actual vambrace radial surface where rays from the forearm axis hit it (1mm tolerance). Triangle intersections are not penetration volume. Two-ray interior checks assume closed local anatomy. Sampled frame audit does not prove continuous clearance or the outer ordering of every shoulder-strap segment; final front/back/side/detail renders remain required.'
}
args.report.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'status':result['status'],'poses':len(frames_checked),'intersectionRows':len(rows),'buriedRows':len(buried),'insideVambraceRows':len(inside_vambrace),'report':str(args.report)}))
if result['status'] != 'passed': raise SystemExit(1)
