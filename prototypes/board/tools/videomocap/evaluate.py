#!/usr/bin/env python3
"""Accuracy of single-camera capture against a several-camera reference.

The reference is the same body triangulated from all calibrated cameras
(direct linear transform over the 2D points of every view). One camera
then has to guess what the others see: depth, the bend of a limb towards
the camera, the floor. The comparison shows how much each cleaning step
recovers.

    python3 evaluate.py --calib Calib.qca.txt --raw 'run/{cam}.heavy.raw.json' \
        --test 'run/{cam}.full.raw.json' --cams cam01,cam02,cam03,cam04 --out report.json

Calibration: Qualisys .qca.txt (as in the Pose2Sim demo, BSD-3-Clause).
Measures, all on 12 body joints (shoulders, elbows, wrists, hips, knees,
ankles):
- PA-MPJPE: per-frame error after the best rotation, shift and scale (shape
  of the pose), mm;
- MPJPE: error with the pelvis on the pelvis and one rotation for the whole
  clip (the camera is unknown but fixed), mm — depth mistakes stay in it;
- angles: knee, hip and elbow flexion, shoulder elevation, trunk lean from
  vertical, mean absolute error in degrees;
- up: error of the floor normal, degrees; travel: error of the pelvis path
  on the floor, cm; skate: drift of a foot the reference shows planted, cm;
  bones: variation of limb lengths, percent; jitter: mean joint
  acceleration, m/s²;
- foot: error of the heel→toe length, cm; pitch: error of the heel→toe
  line's angle to the floor, degrees (the retargeter turns the figure's foot
  by it, so a wrong pitch sinks the toes into the floor).
"""
import argparse, json, os, sys, xml.etree.ElementTree as ET
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import clean as C  # noqa: E402

JOINTS = ['shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR', 'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR']
J = [C.I[n] for n in JOINTS]


def read_qca(path):
    """Cameras of a Qualisys calibration as OpenCV K, D, R, t (world→camera),
    following Pose2Sim's conversion (rotation by π about the camera x axis)."""
    root = ET.parse(path).getroot()
    cams = {}
    for cam in root.findall('cameras/camera'):
        fov, it, tr = cam.find('fov_video'), cam.find('intrinsic'), cam.find('transform')
        g = lambda k: float(it.get(k))
        K = np.array([[g('focalLengthU') / 64, 0, g('centerPointU') / 64 - float(fov.get('left'))],
                      [0, g('focalLengthV') / 64, g('centerPointV') / 64 - float(fov.get('top'))], [0, 0, 1]])
        D = np.array([g('radialDistortion1'), g('radialDistortion2'), g('tangentalDistortion1'), g('tangentalDistortion2')]) / 64
        R = np.array([float(tr.get(f'r{i}{j}')) for i in (1, 2, 3) for j in (1, 2, 3)]).reshape(3, 3).T
        T = np.array([float(tr.get(k)) / 1000 for k in 'xyz'])
        R, T = R.T, -R.T @ T
        flip = np.diag([1, -1, -1.0])
        cams[cam.get('serial')] = dict(K=K, D=D, R=flip @ R, t=flip @ T)
    return cams


def triangulate(cams, raws, min_vis=0.5):
    """Reference points [T,33,3] in the calibration world (z up), NaN where
    fewer than two views see a point. Views whose reprojection is more than
    three times the median of the others are dropped once."""
    import cv2
    names = list(raws)
    T = min(len(raws[n]['frames']) for n in names)
    X = np.full((T, 33, 3), np.nan)
    errs = []
    for t in range(T):
        for j in range(33):
            obs = []
            for n in names:
                f = raws[n]['frames'][t]
                if f.get('world') and f['vis'][j] >= min_vis:
                    c = cams[n]
                    u = np.array(f['image'][j][:2], float)
                    un = cv2.undistortPoints(u.reshape(1, 1, 2), c['K'], c['D']).reshape(2)
                    obs.append((c, u, un, f['vis'][j]))
            if len(obs) < 2:
                continue

            def solve(o):
                A = []
                for c, u, un, w in o:
                    P = np.hstack([c['R'], c['t'][:, None]])
                    A += [w * (un[0] * P[2] - P[0]), w * (un[1] * P[2] - P[1])]
                x = np.linalg.svd(np.array(A))[2][-1]
                return x[:3] / x[3]

            def reproj(x, o):
                return np.array([np.linalg.norm(cv2.projectPoints(x.reshape(1, 3), cv2.Rodrigues(c['R'])[0], c['t'], c['K'], c['D'])[0].reshape(2) - u) for c, u, _, _ in o])

            x = solve(obs)
            e = reproj(x, obs)
            if len(obs) >= 3 and e.max() > 3 * np.median(e) and e.max() > 20:
                obs = [o for o, ei in zip(obs, e) if ei < e.max()]
                x = solve(obs)
                e = reproj(x, obs)
            X[t, j] = x
            errs.extend(e)
    return X, float(np.median(errs)), float(np.percentile(errs, 90))


def to_yup(X):
    """Calibration world (z up) → y up."""
    return np.stack([X[..., 0], X[..., 2], -X[..., 1]], -1)


def procrustes(A, B, scale=True):
    """Best similarity transform of A onto B (rows are points)."""
    ma, mb = A.mean(0), B.mean(0)
    a, b = A - ma, B - mb
    U, S, Vt = np.linalg.svd(a.T @ b)
    d = np.sign(np.linalg.det(U @ Vt))
    Dm = np.diag([1, 1, d])
    R = U @ Dm @ Vt
    s = (S * np.diag(Dm)).sum() / (a ** 2).sum() if scale else 1.0
    return s * a @ R + mb


def angles(P, up):
    """Knee, hip, elbow flexion, shoulder elevation and trunk lean, degrees, [T,9]."""
    def ang(u, v):
        return np.degrees(np.arccos(np.clip((C.unit(u) * C.unit(v)).sum(-1), -1, 1)))
    g = lambda n: P[:, C.I[n]]
    trunk = C.neck(P) - C.pelvis(P)
    out = []
    for s in C.SIDES:
        out.append(ang(g(f'knee{s}') - g(f'hip{s}'), g(f'ankle{s}') - g(f'knee{s}')))
        out.append(ang(trunk, -(g(f'knee{s}') - g(f'hip{s}'))) * -1 + 180)
        out.append(ang(g(f'elbow{s}') - g(f'shoulder{s}'), g(f'wrist{s}') - g(f'elbow{s}')))
        out.append(ang(-trunk, g(f'elbow{s}') - g(f'shoulder{s}')))
    out.append(ang(trunk, np.broadcast_to(up, trunk.shape)))
    return np.stack(out, 1)


ANGLE_NAMES = ['knee L', 'hip L', 'elbow L', 'shoulder L', 'knee R', 'hip R', 'elbow R', 'shoulder R', 'trunk lean']


def metrics(E, ref, fps, up_est=None, up_true=None, contacts_ref=None):
    """E: estimate [T,33,3] y up; ref: reference [T,33,3] y up."""
    ok = ~np.isnan(ref[:, J, 0]).any(1)
    e, r = E[ok][:, J], ref[ok][:, J]
    pa = np.mean([np.linalg.norm(procrustes(e[t], r[t]) - r[t], axis=1).mean() for t in range(len(e))])
    er = e - ((e[:, 6] + e[:, 7]) / 2)[:, None]
    rr = r - ((r[:, 6] + r[:, 7]) / 2)[:, None]
    A, B = er.reshape(-1, 3), rr.reshape(-1, 3)
    U, S, Vt = np.linalg.svd(A.T @ B)
    Rm = U @ np.diag([1, 1, np.sign(np.linalg.det(U @ Vt))]) @ Vt
    mpjpe = np.linalg.norm(A @ Rm - B, axis=1).mean()
    a_est = angles(E[ok], np.array([0, 1, 0]))
    a_ref = angles(ref[ok], np.array([0, 1, 0]))
    ang_err = np.nanmean(np.abs(a_est - a_ref), 0)
    out = {'paMpjpe': round(pa * 1000, 1), 'mpjpe': round(mpjpe * 1000, 1),
           'angles': {n: round(float(v), 1) for n, v in zip(ANGLE_NAMES, ang_err)},
           'angleMean': round(float(ang_err[:8].mean()), 1), 'trunk': round(float(ang_err[8]), 1),
           'bones': C.bone_cv(E), 'jitter': round(float(np.linalg.norm(np.diff(E[:, J], 2, axis=0), axis=-1).mean() * fps * fps), 2)}
    if up_est is not None and up_true is not None:
        out['up'] = round(float(np.degrees(np.arccos(np.clip(np.dot(C.unit(up_est), C.unit(up_true)), -1, 1)))), 1)
    pe, pr = C.pelvis(E)[ok], C.pelvis(ref)[ok]
    de, dr = pe - pe[0], pr - pr[0]
    de[:, 1] = dr[:, 1] = 0
    # best heading about the vertical
    num = (de[:, 0] * dr[:, 2] - de[:, 2] * dr[:, 0]).sum()
    den = (de[:, 0] * dr[:, 0] + de[:, 2] * dr[:, 2]).sum()
    th = np.arctan2(-num, den)
    Ry = np.array([[np.cos(th), 0, np.sin(th)], [0, 1, 0], [-np.sin(th), 0, np.cos(th)]])
    out['travel'] = round(float(np.linalg.norm(de @ Ry.T - dr, axis=1).mean() * 100), 1)
    out['travelRef'] = round(float(np.linalg.norm(dr[-1]) * 100), 1)
    out['travelEst'] = round(float(np.linalg.norm(de[-1]) * 100), 1)
    def foot(P):
        v = P[ok][:, [C.I['toeL'], C.I['toeR']]] - P[ok][:, [C.I['heelL'], C.I['heelR']]]
        return np.linalg.norm(v, axis=-1), np.degrees(np.arctan2(-v[..., 1], np.hypot(v[..., 0], v[..., 2])))
    (le, pe_), (lr, pr_) = foot(E), foot(ref)
    out['foot'] = round(float(np.nanmean(np.abs(le - lr))) * 100, 1)
    out['pitch'] = round(float(np.nanmean(np.abs(pe_ - pr_))), 1)
    if contacts_ref:
        d = []
        for s, iv in contacts_ref.items():
            for t0, t1 in iv:
                a = E[t0:t1 + 1, C.I[f'ankle{s}']][:, [0, 2]]
                d.extend(np.linalg.norm(a - np.median(a, axis=0), axis=1))
        out['skate'] = round(float(np.mean(d)) * 100, 1) if d else None
    return out


def baseline(raw):
    """What the board's browser path did before: world landmarks, moving
    average over 2 frames each side, nothing else."""
    P, Cf, fps = C.load_raw(raw)
    P, _ = C.fill_gaps(P, fps, 1e9)
    T, out = len(P), np.empty_like(P)
    for t in range(T):
        out[t] = P[max(0, t - 2):t + 3].mean(0)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--calib', required=True)
    ap.add_argument('--raw', required=True, help="шаблон пути к сырым файлам для эталона, {cam} — имя камеры")
    ap.add_argument('--test', required=True, help="шаблон пути к сырым файлам проверяемой модели")
    ap.add_argument('--cams', required=True)
    ap.add_argument('--out')
    ap.add_argument('--ablate', action='store_true', help='замерить вклад каждого шага')
    a = ap.parse_args()
    cams = read_qca(a.calib)
    names = a.cams.split(',')
    ref_raw = {n: json.load(open(a.raw.format(cam=n))) for n in names}
    X, rep_med, rep_p90 = triangulate(cams, ref_raw)
    ref = to_yup(X)
    fps = float(ref_raw[names[0]]['source']['fps'])
    up_world = np.array([0, 1.0, 0])
    # reference contacts: sole within 5 cm of its lowest level and slow
    refc = ref.copy()
    for j in range(33):
        ok = ~np.isnan(refc[:, j, 0])
        if ok.any() and not ok.all():
            for d in range(3):
                refc[:, j, d] = np.interp(np.arange(len(refc)), np.where(ok)[0], refc[ok, j, d])
    floor = np.nanpercentile(np.minimum(C.sole_height(refc, 'L'), C.sole_height(refc, 'R')), 5)
    refc[:, :, 1] -= floor
    contacts_ref = C.detect_contacts(refc, fps, 0.05, 0.3, 0.08)
    report = {'reference': {'cameras': names, 'reprojectionPx': {'median': round(rep_med, 1), 'p90': round(rep_p90, 1)},
                            'contacts': {s: [[round(x / fps, 3), round(y / fps, 3)] for x, y in v] for s, v in contacts_ref.items()},
                            'travelCm': round(float(np.linalg.norm((C.pelvis(refc)[-1] - C.pelvis(refc)[0])[[0, 2]]) * 100), 1)},
              'cameras': {}}
    variants = {'raw': None, 'baseline': None, 'clean': []}
    if a.ablate:
        full = list(C.ALL_STEPS)
        for s in ['smooth', 'knees', 'lengths', 'camera', 'image', 'feet', 'floor', 'root', 'contacts', 'outliers']:
            variants['clean-no-' + s] = [x for x in full if x != s]
    for n in names:
        raw = json.load(open(a.test.format(cam=n)))
        cam = cams[n]
        up_cam = cam['R'] @ np.array([0, 0, 1.0])
        up_true = up_cam * np.array([1, -1, -1])
        row = {}
        for v, steps in variants.items():
            if v == 'raw':
                P, _, _ = C.load_raw(raw)
                P, _ = C.fill_gaps(P, fps, 1e9)
                row[v] = metrics(P, ref, fps, contacts_ref=contacts_ref)
            elif v == 'baseline':
                row[v] = metrics(baseline(raw), ref, fps, contacts_ref=contacts_ref)
            else:
                P, _, rep = C.clean(raw, **({'steps': steps} if steps else {}))
                row[v] = metrics(P, ref, fps, up_est=np.array(rep['up']), up_true=up_true, contacts_ref=contacts_ref)
        report['cameras'][n] = row
    keys = ['paMpjpe', 'mpjpe', 'angleMean', 'trunk', 'up', 'travel', 'skate', 'bones', 'jitter', 'foot', 'pitch']
    summary = {}
    for v in variants:
        summary[v] = {k: round(float(np.mean([report['cameras'][n][v][k] for n in names if report['cameras'][n][v].get(k) is not None])), 1)
                      for k in keys if any(report['cameras'][n][v].get(k) is not None for n in names)}
    report['summary'] = summary
    if a.out:
        json.dump(report, open(a.out, 'w'), ensure_ascii=False, indent=1)
    print(json.dumps(report['reference'], ensure_ascii=False))
    print(f"{'вариант':<18}" + ''.join(f'{k:>10}' for k in keys))
    for v, m in summary.items():
        print(f'{v:<18}' + ''.join(f"{m.get(k, ''):>10}" for k in keys))


if __name__ == '__main__':
    main()
