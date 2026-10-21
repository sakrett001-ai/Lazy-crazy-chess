"""Source-scene spear/shield clearance, sampled through aim and extension.

Run in the prepared bpy Python:
  python scripts/spear_shield_checks.py --asset assets/white-pawn.blend --out report.json

The check reads the actual evaluated shield face/rim and spear geometry. A
capsule enclosing the shaft/grip and a sphere enclosing the head are tested
against shield triangles. Positive clearance is conservative. This is not a
continuous collision test or a substitute for the independent final-GLB gate.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import closest_point_on_tri, intersect_ray_tri

import pawn_pose


def mesh_data(name):
    obj = bpy.data.objects[name]
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    try:
        mesh.calc_loop_triangles()
        vertices = [obj.matrix_world @ v.co for v in mesh.vertices]
        triangles = [tuple(t.vertices) for t in mesh.loop_triangles]
        return vertices, triangles
    finally:
        evaluated.to_mesh_clear()


def segment_distance(a, b, c, d):
    u, v, w = b-a, d-c, a-c
    aa, bb, cc, dd, ee = u.dot(u), u.dot(v), v.dot(v), u.dot(w), v.dot(w)
    denominator = aa*cc-bb*bb
    s = max(0., min(1., (bb*ee-cc*dd)/denominator)) if denominator > 1e-16 else 0.
    t = (bb*s+ee)/cc if cc > 1e-16 else 0.
    if t < 0:
        t, s = 0., max(0., min(1., -dd/aa))
    elif t > 1:
        t, s = 1., max(0., min(1., (bb-dd)/aa))
    return (w+u*s-v*t).length


def segment_triangle_distance(a, b, triangle):
    x, y, z = triangle
    direction = b-a
    hit = intersect_ray_tri(x, y, z, direction, a, True)
    if hit is not None and -1e-10 <= (hit-a).dot(direction)/direction.length_squared <= 1+1e-10:
        return 0.
    return min((a-closest_point_on_tri(a, x, y, z)).length,
               (b-closest_point_on_tri(b, x, y, z)).length,
               segment_distance(a, b, x, y), segment_distance(a, b, y, z),
               segment_distance(a, b, z, x))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--asset', type=Path,
                        default=Path(__file__).resolve().parents[1]/'assets/white-pawn.blend')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--samples', type=int, default=69)
    args = parser.parse_args()
    if args.samples < 2:
        parser.error('--samples must be at least 2')
    asset_sha = hashlib.sha256(args.asset.read_bytes()).hexdigest()
    pose_sha = hashlib.sha256(Path(pawn_pose.__file__).read_bytes()).hexdigest()
    bpy.ops.wm.open_mainfile(filepath=str(args.asset.resolve()))
    rig = next(obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE')
    rig.animation_data_clear()
    pawn_pose.configure(rig)
    pawn_pose.apply_pose()
    vertices, indices = [], []
    for name in ('SHIELD_Ivory face', 'SHIELD_Silver perimeter'):
        points, faces = mesh_data(name)
        offset = len(vertices)
        vertices.extend(points)
        indices.extend(tuple(i+offset for i in face) for face in faces)
    triangles = [tuple(vertices[i] for i in face) for face in indices]
    shield_bvh = BVHTree.FromPolygons(vertices, indices, all_triangles=True)
    shaft, _ = mesh_data('SPEAR_Ash shaft')
    assert len(shaft) == 32, 'Expected the two 16-vertex source shaft rings'
    a, b = sum(shaft[:16], Vector())/16, sum(shaft[16:], Vector())/16
    axis = (b-a).normalized()
    bound_points = list(shaft)
    for obj in bpy.context.scene.objects:
        if obj.name.startswith(('SPEAR_Leather grip', 'SPEAR_Grip binding')):
            bound_points.extend(mesh_data(obj.name)[0])
    radius = max(((point-a)-axis*(point-a).dot(axis)).length for point in bound_points)
    head, _ = mesh_data('SPEAR_Leaf-shaped steel head')
    center = sum(head, Vector())/len(head)
    head_radius = max((point-center).length for point in head)
    left = rig.matrix_world @ rig.pose.bones['wrist.L'].matrix
    right = rig.matrix_world @ rig.pose.bones['wrist.R'].matrix
    report = {'checked_at_utc': datetime.now(timezone.utc).isoformat(),
              'bpy_version': bpy.app.version_string, 'pose_sha256': pose_sha,
              'input_asset': str(args.asset), 'input_asset_sha256': asset_sha,
              'clip': 'Spear_Study', 'checked_interval_s': [.55, 2.8],
              'triangles': len(triangles), 'shaft_capsule_radius_m': radius,
              'head_sphere_radius_m': head_radius, 'samples': [],
              'scope': 'Evaluated source .blend geometry driven by current pose module. '
                       'Shaft/grip capsule and head sphere against actual shield face/rim '
                       'triangles. Sampled clearance, not continuous collision or final-GLB validation.'}
    started = time.monotonic()
    for i in range(args.samples):
        t = .55+2.25*i/(args.samples-1)
        pawn_pose.apply_pose('Spear_Study', t)
        current_left = rig.matrix_world @ rig.pose.bones['wrist.L'].matrix
        current_right = rig.matrix_world @ rig.pose.bones['wrist.R'].matrix
        # Both assemblies are rigidly bound to their respective wrist. Move
        # actual spear landmarks into the fixed evaluated shield mesh frame.
        relative = left @ current_left.inverted() @ current_right @ right.inverted()
        start, end, head_center = relative @ a, relative @ b, relative @ center
        distance = min(segment_triangle_distance(start, end, tri) for tri in triangles)
        report['samples'].append({'t': t, 'shaft_capsule_clearance_m': distance-radius,
                                  'head_sphere_clearance_m': shield_bvh.find_nearest(head_center)[3]-head_radius})
    report['min_shaft'] = min(report['samples'], key=lambda row: row['shaft_capsule_clearance_m'])
    report['min_head'] = min(report['samples'], key=lambda row: row['head_sphere_clearance_m'])
    report['seconds'] = time.monotonic()-started
    passed = (report['min_shaft']['shaft_capsule_clearance_m'] > .001
              and report['min_head']['head_sphere_clearance_m'] > .001)
    report['status'] = 'passed' if passed else 'failed'
    assert pose_sha == hashlib.sha256(Path(pawn_pose.__file__).read_bytes()).hexdigest(), 'Pose module changed during check'
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps({key: value for key, value in report.items() if key != 'samples'}, indent=2))
    if not passed:
        raise SystemExit('Spear bounds intersect or come within 1 mm of the shield')


if __name__ == '__main__':
    main()
