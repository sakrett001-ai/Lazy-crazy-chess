"""Check the actual thumb skin in the fitted guard, including an old-grip negative test.

Run with the existing bpy Python, for example:
  python prototypes/white-pawn/scripts/thumb_checks.py --out /tmp/thumb-checks.json

This checks a weighted hand surface patch, not whole-body or animation collisions.
The source .blend and repository assets are only read; the report is written to --out.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

import bpy
from mathutils import Quaternion, Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import intersect_ray_tri

import pawn_pose


def triangle_radius(points):
    """Minimum cylinder-axis distance over a triangle projected into its radial plane."""
    cross = lambda a, b: a.x * b.y - a.y * b.x
    signs = [cross(points[i], points[(i + 1) % 3]) for i in range(3)]
    if all(s >= 0 for s in signs) or all(s <= 0 for s in signs):
        return 0.0
    distances = []
    for i, a in enumerate(points):
        delta = points[(i + 1) % 3] - a
        u = max(0.0, min(1.0, -a.dot(delta) / max(1e-20, delta.length_squared)))
        distances.append((a + delta * u).length)
    return min(distances)


def edges_cross_triangle(a, b):
    for i, origin in enumerate(a):
        delta = a[(i + 1) % 3] - origin
        length = delta.length
        if length < 1e-12:
            continue
        point = intersect_ray_tri(*b, delta.normalized(), origin, True)
        if (point is not None and (point - origin).dot(delta) > 1e-10
                and (point - origin).length < length - 1e-7):
            return True
    return False


def measure_skin(body):
    evaluated = body.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    mesh.calc_loop_triangles()
    group_names = {g.index: g.name for g in body.vertex_groups}
    vertices = [body.matrix_world @ v.co for v in mesh.vertices]
    weights = [{group_names[g.group]: g.weight for g in v.groups} for v in mesh.vertices]
    results = {}
    try:
        for side, kind in [('R', 'spear'), ('L', 'shield')]:
            frame = pawn_pose.equipment_frames()[kind]
            center, axis = frame['point'], frame['axis']
            normal, forward = frame['palm_normal'], frame['forward']
            thumb_weight = [sum(w.get(f'finger1-{j}.{side}', 0) for j in (1, 2, 3))
                            for w in weights]
            distal_weight = [w.get(f'finger1-3.{side}', 0) for w in weights]
            radial = [Vector(((v-center).dot(normal), (v-center).dot(forward)))
                      for v in vertices]
            thumb = [tuple(t.vertices) for t in mesh.loop_triangles
                     if all(thumb_weight[i] > .25 for i in t.vertices)]
            other = [tuple(t.vertices) for t in mesh.loop_triangles
                     if all(thumb_weight[i] < .05 for i in t.vertices)
                     and all((vertices[i]-center).length < .15 for i in t.vertices)]
            distal = [i for i, w in enumerate(distal_weight) if w > .5]
            thumb_bvh = BVHTree.FromPolygons(vertices, thumb, all_triangles=True)
            other_bvh = BVHTree.FromPolygons(vertices, other, all_triangles=True)
            candidates = thumb_bvh.overlap(other_bvh)
            intersections = 0
            for i, j in candidates:
                a, b = [vertices[k] for k in thumb[i]], [vertices[k] for k in other[j]]
                intersections += bool(edges_cross_triangle(a, b) or edges_cross_triangle(b, a))
            nearest = [other_bvh.find_nearest(vertices[i])[3] for i in distal]
            min_radius = min(triangle_radius([radial[i] for i in tri]) for tri in thumb)
            results[side] = {
                'thumb_triangles': len(thumb),
                'opposing_hand_triangles': len(other),
                'distal_skin_vertices': len(distal),
                'handle_radius_m': .014,
                'minimum_thumb_triangle_radius_m': min_radius,
                'minimum_handle_gap_m': min_radius - .014,
                'thumb_vertices_inside_handle': sum(
                    radial[i].length < .014 for i, w in enumerate(thumb_weight) if w > .25),
                'thumb_hand_bvh_candidates': len(candidates),
                'thumb_hand_triangle_intersections': intersections,
                'distal_to_other_skin_min_m': min(nearest),
                'distal_axial_range_m': [min((vertices[i]-center).dot(axis) for i in distal),
                                         max((vertices[i]-center).dot(axis) for i in distal)],
            }
    finally:
        evaluated.to_mesh_clear()
    return results


def apply_subdivision_in_bind_space(body):
    """Use the same modifier order as build_pawn.py's GLB export preparation."""
    armatures = [m for m in body.modifiers if m.type == 'ARMATURE']
    for modifier in armatures:
        modifier.show_viewport = False
    bpy.ops.object.select_all(action='DESELECT')
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    for modifier in list(body.modifiers):
        if modifier.type == 'SUBSURF':
            bpy.ops.object.modifier_apply(modifier=modifier.name)
    for modifier in armatures:
        modifier.show_viewport = True
    bpy.context.view_layer.update()


def apply_old_thumb_grip(rig):
    """Restore the rejected palm-center heuristic only for the negative control."""
    for side in ('R', 'L'):
        bones = rig.data.bones
        center = (bones['finger2-1.'+side].head_local
                  + bones['finger5-1.'+side].head_local
                  + bones['wrist.'+side].head_local) / 3
        for joint, angle in enumerate((28.90, 63.23, 13.17), 1):
            bone = bones[f'finger1-{joint}.{side}']
            direction = (bone.tail_local-bone.head_local).normalized()
            axis = direction.cross((center-bone.head_local).normalized()).normalized()
            local_axis = bone.matrix_local.to_3x3().inverted() @ axis
            rig.pose.bones[bone.name].rotation_quaternion = Quaternion(local_axis, math.radians(angle))
    bpy.context.view_layer.update()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--motion-peaks', action='store_true',
                        help='Also check the two action peaks with export-order skinning')
    args = parser.parse_args()
    prototype = Path(__file__).resolve().parents[1]
    base = prototype.parent / 'human-base/assets/human-base.blend'
    bpy.ops.wm.open_mainfile(filepath=str(base))
    rig, body = bpy.data.objects['HumanBase_Rig'], bpy.data.objects['Human body']
    rig.animation_data_clear()
    pawn_pose.configure(rig)
    pawn_pose.apply_pose('rest', 0)
    after_skin = measure_skin(body)
    apply_subdivision_in_bind_space(body)
    before_skin = measure_skin(body)
    apply_old_thumb_grip(rig)
    negative = measure_skin(body)
    pawn_pose.apply_pose('rest', 0)
    motion_peaks = {}
    if args.motion_peaks:
        for kind, t in [('Shield_Brace', 1.8), ('Spear_Study', 1.9)]:
            pawn_pose.apply_pose(kind, t)
            motion_peaks[kind] = {'time_s': t, 'hands': measure_skin(body)}
        pawn_pose.apply_pose('rest', 0)
    failures = []
    for order, measurements in [('subdivision_after_skin', after_skin),
                                ('export_subdivision_before_skin', before_skin)]:
        for side, result in measurements.items():
            if not -.00002 <= result['minimum_handle_gap_m'] <= .004:
                failures.append(f'{order}/{side}: handle gap outside -0.02 to 4 mm')
            if result['thumb_vertices_inside_handle'] or result['thumb_hand_triangle_intersections']:
                failures.append(f'{order}/{side}: thumb penetrates handle or hand patch')
    for side, result in negative.items():
        if result['thumb_hand_triangle_intersections'] == 0:
            failures.append(f'negative/{side}: the old folded grip was not detected')
    for kind, sample in motion_peaks.items():
        for side, result in sample['hands'].items():
            if result['minimum_handle_gap_m'] < -.00002 or result['minimum_handle_gap_m'] > .004:
                failures.append(f'{kind}/{side}: handle gap outside -0.02 to 4 mm')
            if result['thumb_vertices_inside_handle'] or result['thumb_hand_triangle_intersections']:
                failures.append(f'{kind}/{side}: thumb penetrates handle or hand patch')
    report = {
        'status': 'failed' if failures else 'passed',
        'bpy_version': bpy.app.version_string,
        'checked_at_utc': datetime.now(timezone.utc).isoformat(),
        'pose_sha256': hashlib.sha256(Path(pawn_pose.__file__).read_bytes()).hexdigest(),
        'input_asset': 'prototypes/human-base/assets/human-base.blend',
        'input_asset_sha256': hashlib.sha256(base.read_bytes()).hexdigest(),
        'pose': 'rest',
        'subdivision_after_skin': after_skin,
        'export_subdivision_before_skin': before_skin,
        'negative_old_grip': negative,
        'motion_peaks': motion_peaks,
        'failures': failures,
        'scope': ('Weighted thumb triangles (>0.25) against non-thumb hand triangles (<0.05), '
                  'excluding the adjoining web transition. Exact triangle-edge intersection '
                  'checks and triangle distance to a conservative infinite 14 mm cylinder. '
                  'Not whole-body, armor, continuous-motion or final-GLB validation.'),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'out': str(args.out), 'failures': failures}))
    if failures:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
