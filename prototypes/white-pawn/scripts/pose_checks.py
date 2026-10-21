"""Check source poses and visible sole skin before the integrated GLB build.

Run with the already prepared bpy Python. The independent GLB verifier remains
the export gate; these checks do not claim dynamics, balance or full collision.
"""
from pathlib import Path
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import random

import bpy
import numpy as np

import pawn_pose


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    base = Path(__file__).resolve().parents[2] / 'human-base/assets/human-base.blend'
    bpy.ops.wm.open_mainfile(filepath=str(base))
    rig = bpy.data.objects['HumanBase_Rig']
    rig.animation_data_clear()
    pawn_pose.configure(rig)
    pawn_pose.apply_pose()
    bones = rig.pose.bones
    reference = {b.name: np.array(b.matrix) for b in bones}
    body = bpy.data.objects['Human body']

    def skin():
        ev = body.evaluated_get(bpy.context.evaluated_depsgraph_get())
        mesh = ev.to_mesh()
        coords = np.empty(len(mesh.vertices)*3, dtype=np.float32)
        mesh.vertices.foreach_get('co', coords)
        ev.to_mesh_clear()
        return coords.reshape(-1, 3)

    sole_reference = skin()
    sole_indices = np.flatnonzero((sole_reference[:, 2] < .015)
                                 & (np.abs(sole_reference[:, 0]) > .14))
    assert len(sole_indices) > 40, 'The visible sole sample is missing'
    chains = [('upperleg01.'+s, 'lowerleg01.'+s, 'foot.'+s) for s in ('L', 'R')]
    chains += [('upperarm01.'+s, 'lowerarm01.'+s, 'wrist.'+s) for s in ('L', 'R')]
    lengths = {(a, b): (bones[a].head-bones[b].head).length
               for chain in chains for a, b in zip(chain, chain[1:])}
    report = {'runtime': bpy.app.version_string,
              'checked_at_utc': datetime.now(timezone.utc).isoformat(),
              'pose_sha256': hashlib.sha256(Path(pawn_pose.__file__).read_bytes()).hexdigest(),
              'input_asset': 'prototypes/human-base/assets/human-base.blend',
              'input_asset_sha256': hashlib.sha256(base.read_bytes()).hexdigest(),
              'pose_fps': 30,
              'skin_sole_fps': 10, 'sole_vertices': len(sole_indices), 'clips': {}}
    for kind, duration in [('Guard_Breath', 6), ('Shield_Brace', 4), ('Spear_Study', 4)]:
        maximum = dict(foot_matrix_error=0., visible_sole_drift_m=0.,
                       link_length_error_m=0., reach_error_m=0., wrist_bend_deg=0.)
        knee_ranges = {s: [180., 0.] for s in ('L', 'R')}
        samples = {}
        for frame in range(duration*30+1):
            t = frame/30
            frames = pawn_pose.apply_pose(kind, t)
            matrices = {b.name: np.array(b.matrix) for b in bones}
            samples[frame] = matrices
            for s in ('L', 'R'):
                name = 'foot.'+s
                maximum['foot_matrix_error'] = max(maximum['foot_matrix_error'],
                    float(np.max(np.abs(matrices[name]-reference[name]))))
                hip, knee, foot = (bones[n+'.'+s].head for n in ('upperleg01', 'lowerleg01', 'foot'))
                angle = 180.-math.degrees((hip-knee).angle(foot-knee))
                knee_ranges[s] = [min(knee_ranges[s][0], angle), max(knee_ranges[s][1], angle)]
            for (a, b), length in lengths.items():
                maximum['link_length_error_m'] = max(maximum['link_length_error_m'],
                    abs((bones[a].head-bones[b].head).length-length))
            maximum['reach_error_m'] = max(maximum['reach_error_m'],
                max(x['target_error_m'] for x in pawn_pose._SOLVES.values()))
            forearm = bones['wrist.R'].head-bones['lowerarm01.R'].head
            maximum['wrist_bend_deg'] = max(maximum['wrist_bend_deg'],
                math.degrees(forearm.angle(frames['spear']['forward'])))
            if frame % 3 == 0:
                delta = skin()[sole_indices]-sole_reference[sole_indices]
                maximum['visible_sole_drift_m'] = max(maximum['visible_sole_drift_m'],
                    float(np.linalg.norm(delta, axis=1).max()))
        endpoint_error = max(float(np.max(np.abs(samples[0][name]-samples[duration*30][name])))
                             for name in samples[0])
        seek_error = 0.
        rng = random.Random(211)
        order = list(range(duration*30+1))
        rng.shuffle(order)
        for frame in order[:17] + [duration*30, 0, 60, 15, 0]:
            pawn_pose.apply_pose(kind, frame/30)
            seek_error = max(seek_error, max(float(np.max(np.abs(np.array(b.matrix)-samples[frame][b.name])))
                                             for b in bones))
        assert endpoint_error < 1e-5, (kind, 'open clip', endpoint_error)
        assert seek_error < 1e-6, (kind, 'state accumulation', seek_error)
        assert maximum['link_length_error_m'] < 1e-5, (kind, 'link stretch', maximum)
        assert maximum['reach_error_m'] < 1e-5, (kind, 'unreachable target', maximum)
        assert maximum['foot_matrix_error'] < 1e-5, (kind, 'foot anchor drift', maximum)
        assert maximum['visible_sole_drift_m'] < .006, (kind, 'visible sole drift', maximum)
        report['clips'][kind] = dict(maximum, knee_flexion_deg=knee_ranges,
                                    pose_samples=duration*30+1,
                                    endpoint_matrix_error=endpoint_error,
                                    arbitrary_seek_matrix_error=seek_error)
    report['scope'] = 'Source rig/skin checks only. No mass model, complete self-collision or final-GLB claim.'
    report['completed_at_utc'] = datetime.now(timezone.utc).isoformat()
    report['status'] = 'passed'
    Path(args.out).write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
