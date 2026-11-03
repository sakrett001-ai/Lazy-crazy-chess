"""Checks of the cleaning (clean.py) and the motion file (motion.py) on a
synthetic take: a person squats in front of a tilted camera, the pose comes
with noise, dropped frames and doubtful points, as MediaPipe gives it.
No video and no model are needed:

    python3 -m unittest test_clean.py
"""
import unittest

import numpy as np

import clean as C
import motion as M

FPS, T = 30.0, 90
SIZE = (1280, 720)
F = C.focal_length(SIZE, C.DEFAULTS['fov'])
PITCH = np.radians(18)                  # camera looks down 18°
CAM = np.array([0.3, 1.3, 3.6])         # camera position, y up, the person faces +z
THIGH, SHIN = 0.45, 0.43


def rotation():
    fwd = np.array([0, -np.sin(PITCH), -np.cos(PITCH)])
    right = np.array([1.0, 0, 0])
    down = np.cross(fwd, right)
    return np.stack([right, down, fwd])  # rows: camera x right, y down, z away


R = rotation()


def body(t):
    """33 landmarks (y up, metres) at time t: feet planted, a slow squat
    with a little sway. The person's left is +x."""
    phase = 2 * np.pi * t / 2.0
    drop = 0.15 * (1 - np.cos(phase)) / 2
    pel = np.array([0.04 * np.sin(phase / 2), 0.95 - drop, 0.0])
    p = {}
    for s, x in (('L', 1), ('R', -1)):
        p[f'hip{s}'] = pel + [0.1 * x, 0, 0]
        # a flat foot as clean.FOOT_FLAT has it: forward and up from the ankle in shares of the shin
        p[f'ankle{s}'] = np.array([0.12 * x, 0.09, 0.0])
        for part, (fwd, up) in C.FOOT_FLAT.items():
            p[f'{part}{s}'] = p[f'ankle{s}'] + np.array([0, up, fwd]) * SHIN
        knee, _ = C.two_bone_ik(p[f'hip{s}'], p[f'hip{s}'] + [0, -0.3, 0.1], p[f'ankle{s}'], THIGH, SHIN)
        p[f'knee{s}'] = knee
        up = pel + [0, 0, 0]
        p[f'shoulder{s}'] = up + [0.19 * x, 0.5, 0]
        p[f'elbow{s}'] = up + [0.23 * x, 0.22, 0.05 + 0.1 * np.sin(phase)]
        p[f'wrist{s}'] = up + [0.25 * x, -0.02, 0.15 + 0.15 * np.sin(phase)]
        for d, off in (('pinky', [0.02, -0.07, 0]), ('index', [0, -0.08, 0.02]), ('thumb', [-0.02, -0.05, 0.03])):
            p[f'{d}{s}'] = p[f'wrist{s}'] + np.array(off) * [x, 1, 1]
        p[f'ear{s}'] = pel + [0.07 * x, 0.66, -0.02]
        p[f'eye{s}'] = pel + [0.035 * x, 0.69, 0.08]
        p[f'eyeInner{s}'] = pel + [0.02 * x, 0.69, 0.085]
        p[f'eyeOuter{s}'] = pel + [0.05 * x, 0.69, 0.075]
        p[f'mouth{s}'] = pel + [0.025 * x, 0.6, 0.085]
    p['nose'] = pel + [0, 0.65, 0.11]
    return np.array([p[n] for n in C.NAMES], float), pel


def project(X):
    Xc = (X - CAM) @ R.T
    return np.stack([F * Xc[:, 0] / Xc[:, 2] + SIZE[0] / 2, F * Xc[:, 1] / Xc[:, 2] + SIZE[1] / 2], -1)


def scene_segments():
    """Upright edges of the room (door frames, shelves) away from the person."""
    segs = []
    for x, z in ((-2.2, -2.0), (-1.4, -3.0), (1.6, -2.5), (2.4, -1.5), (-0.9, -3.5), (1.0, -3.2)):
        a, b = project(np.array([[x, 0.2, z], [x, 2.2, z]]))
        segs.append([*a, *b])
    return segs


def synthetic_take(seed=0, segments=True):
    rng = np.random.default_rng(seed)
    frames, truth = [], []
    for k in range(T):
        X, pel = body(k / FPS)
        truth.append(X)
        if 40 <= k < 44:  # the person is lost for four frames
            frames.append({'t': k / FPS, 'world': None})
            continue
        hips = (X[C.I['hipL']] + X[C.I['hipR']]) / 2
        world = (X - hips) @ R.T                               # MediaPipe axes around the hips
        world += rng.normal(0, 0.012, world.shape)
        world[:, 2] += rng.normal(0, 0.03, len(world))         # depth is the noisiest
        for s in C.SIDES:                                      # one camera flattens the feet in depth
            a = world[C.I[f'ankle{s}'], 2]
            for part in ('heel', 'toe'):
                j = C.I[f'{part}{s}']
                world[j, 2] = a + 0.4 * (world[j, 2] - a)
        image = project(X) + rng.normal(0, 1.5, (33, 2))
        if k == 60:                                            # the model sees it there in the image too
            image[C.I['wristL']] += np.array([0.25, -0.3]) * F / 3.6
        vis = np.full(33, 0.95)
        if k % 17 == 5:                                        # a doubtful wrist, thrown off
            vis[C.I['wristR']] = 0.1
            world[C.I['wristR']] += [0.3, -0.2, 0.1]
        if k == 60:                                            # a sure but wrong jump of a wrist
            world[C.I['wristL']] += [0.25, 0.3, 0.0]
        frames.append({'t': k / FPS, 'world': world.tolist(),
                       'image': np.c_[image, np.zeros(33)].tolist(), 'vis': vis.tolist(), 'pres': vis.tolist()})
    raw = {'format': 'vmocap.raw', 'version': 1,
           'source': {'video': 'synthetic', 'fps': FPS, 'width': SIZE[0], 'height': SIZE[1]},
           'scene': {'segments': scene_segments() if segments else []},
           'landmarks': C.NAMES, 'frames': frames}
    return raw, np.array(truth)


def angle(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    return np.degrees(np.arccos(np.clip(a @ b / np.linalg.norm(a) / np.linalg.norm(b), -1, 1)))


class CleanTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw, cls.truth = synthetic_take()
        cls.P, cls.fps, cls.report = C.clean(cls.raw)

    def test_every_frame_is_filled(self):
        self.assertEqual(self.P.shape, (T, 33, 3))
        self.assertFalse(np.isnan(self.P).any())
        self.assertEqual(self.report['found'], T - 4)

    def test_bones_keep_their_length(self):
        self.assertGreater(C.bone_cv(C.load_raw(self.raw)[0][~np.isnan(C.load_raw(self.raw)[0][:, 0, 0])]), 2)
        self.assertLess(C.bone_cv(self.P), 0.5)
        L = self.report['boneLengths']
        self.assertAlmostEqual(L['hipL-kneeL'], THIGH, delta=0.03)
        self.assertAlmostEqual(L['kneeL-ankleL'], SHIN, delta=0.03)
        self.assertEqual(L['hipL-kneeL'], L['hipR-kneeR'])

    def test_feet_get_their_length_and_lie_flat(self):
        raw_feet = C.load_raw(self.raw)[0]
        ok = ~np.isnan(raw_feet[:, 0, 0])
        heel_toe = lambda P, s: np.linalg.norm(P[:, C.I[f'toe{s}']] - P[:, C.I[f'heel{s}']], axis=-1)
        true = heel_toe(self.truth, 'L').mean()
        self.assertLess(np.median(heel_toe(raw_feet[ok], 'L')), true - 0.04)  # the take is flattened
        for s in C.SIDES:
            self.assertAlmostEqual(np.median(heel_toe(self.P, s)), true, delta=0.02)
            # planted and flat: toe and heel at their true heights, so the foot is not pitched
            for part in ('heel', 'toe'):
                h = np.median(self.P[:, C.I[f'{part}{s}'], 1])
                self.assertAlmostEqual(h, self.truth[0, C.I[f'{part}{s}'], 1], delta=0.025, msg=part + s)

    def test_knees_bend_forward(self):
        for s in C.SIDES:
            flex = C.knee_flexion(self.P, s)
            self.assertGreater(flex.min(), -1, s)
            true = C.knee_flexion(self.truth, s)
            self.assertLess(np.abs(flex - true).mean(), 8, s)

    def test_floor_from_scene_lines(self):
        self.assertEqual(self.report['floorFrom'], 'scene lines')
        true_up = (R @ [0, 1, 0]) * [1, -1, -1]   # world up in the camera's y-up axes
        self.assertLess(angle(self.report['up'], true_up), 2.5)
        self.assertAlmostEqual(self.report['tiltDeg'], np.degrees(PITCH), delta=2.5)

    def test_planted_feet_stay(self):
        for s in C.SIDES:
            covered = sum(b - a for a, b in self.report['contacts'][s])  # seconds
            self.assertGreater(covered, 0.8 * T / FPS, s)
        self.assertLess(self.report['skateAfter'], 0.3)
        self.assertLess(self.report['skateAfter'], self.report['skateBefore'])
        soles = np.minimum(C.sole_height(self.P, 'L'), C.sole_height(self.P, 'R'))
        self.assertLess(np.abs(np.percentile(soles, 50)), 0.02)

    def test_pelvis_path(self):
        pel = C.pelvis(self.P)
        true = C.pelvis(self.truth)
        drop, true_drop = np.ptp(pel[:, 1]), np.ptp(true[:, 1])
        self.assertAlmostEqual(drop, true_drop, delta=0.04)
        self.assertLess(np.abs((pel[:, 1] - pel[:, 1].mean()) - (true[:, 1] - true[:, 1].mean())).mean(), 0.03)

    def test_wrong_wrist_is_thrown_off(self):
        k = 5
        wrist = self.P[k, C.I['wristR']] - C.pelvis(self.P)[k]
        true = self.truth[k, C.I['wristR']] - C.pelvis(self.truth)[k]
        self.assertLess(np.linalg.norm(wrist - true), 0.12)

    def test_sure_jump_is_thrown_off(self):
        k = 60
        wrist = self.P[k, C.I['wristL']] - C.pelvis(self.P)[k]
        true = self.truth[k, C.I['wristL']] - C.pelvis(self.truth)[k]
        self.assertLess(np.linalg.norm(wrist - true), 0.06)
        self.assertGreaterEqual(self.report['outliers'], 1)


class KneeTest(unittest.TestCase):
    def test_backward_knee_is_mirrored_forward(self):
        P = np.array([body(k / FPS)[0] for k in range(10)])
        good = P.copy()
        for t in range(0, 10, 2):  # every other frame the knee is mirrored behind the hip–ankle line
            h, k, a = P[t, C.I['hipL']], P[t, C.I['kneeL']], P[t, C.I['ankleL']]
            d = C.unit(a - h)
            P[t, C.I['kneeL']] = 2 * (h + np.dot(k - h, d) * d) - k
        self.assertLess(C.knee_flexion(P, 'L')[::2].max(), -5)
        fixed, n = C.fix_knees(P)
        self.assertEqual(n, 5)
        self.assertGreater(C.knee_flexion(fixed, 'L').min(), 5)
        self.assertLess(np.abs(fixed[:, C.I['kneeL']] - good[:, C.I['kneeL']]).max(), 1e-6)


class FloorTest(unittest.TestCase):
    def test_toes_pitched_down_are_turned_up_to_the_floor(self):
        P = np.array([body(0)[0], body(0)[0]])
        A = P[1, C.I['ankleL']].copy()
        th = np.radians(40)  # toes down about the person's left-right axis
        R = np.array([[1, 0, 0], [0, np.cos(th), -np.sin(th)], [0, np.sin(th), np.cos(th)]])
        for part in ('heel', 'toe'):
            j = C.I[f'{part}L']
            P[1, j] = A + R @ (P[1, j] - A)
        self.assertLess(P[1, C.I['toeL'], 1], -0.03)
        fixed, n = C.feet_above_floor(P)
        self.assertEqual(n, 1)
        self.assertGreater(fixed[1, C.I['toeL'], 1], -1e-6)
        self.assertLess(fixed[1, C.I['toeL'], 1], 0.005)  # just enough, not more
        for part in ('heel', 'toe'):
            j = C.I[f'{part}L']
            self.assertAlmostEqual(np.linalg.norm(fixed[1, j] - A), np.linalg.norm(P[1, j] - A), places=6)
        self.assertTrue(np.allclose(fixed[0], P[0]))

    def test_cleaned_feet_stay_above_the_floor(self):
        P, _, _ = C.clean(synthetic_take()[0])
        for s in C.SIDES:
            self.assertGreater(C.sole_height(P, s).min(), -1e-6)


class FallbackTest(unittest.TestCase):
    def test_without_scene_lines_the_body_gives_up(self):
        raw, _ = synthetic_take(seed=1, segments=False)
        P, _, report = C.clean(raw)
        self.assertEqual(report['floorFrom'], 'body')
        self.assertFalse(np.isnan(P).any())

    def test_without_image_points(self):
        raw, _ = synthetic_take(seed=2, segments=False)
        for f in raw['frames']:
            f.pop('image', None)
        P, _, report = C.clean(raw)
        self.assertNotIn('focalPx', report)
        self.assertLess(C.bone_cv(P), 0.5)


class MotionFileTest(unittest.TestCase):
    def test_motion_file_layout(self):
        raw, _ = synthetic_take()
        P, fps, report = C.clean(raw)
        out = M.motion_file(P, fps, name='squat', role='stand', source=raw['source'], report=report)
        clip = out['clips'][0]
        self.assertEqual(out['format'], 'lazy-chess.motion')
        self.assertEqual(out['points'], M.POINTS)
        self.assertEqual(len(clip['data']), T * len(M.POINTS) * 3)
        self.assertEqual(out['source']['quality']['floorFrom'], 'scene lines')
        pts = np.array(clip['data']).reshape(T, len(M.POINTS), 3)
        pelvis = pts[:, M.POINTS.index('pelvis')]
        self.assertLess(np.abs(pelvis - C.pelvis(P)).max(), 1e-3)

    def test_neutral_stance_is_written(self):
        raw, _ = synthetic_take()
        P, fps, report = C.clean(raw)
        out = M.motion_file(P, fps, name='squat', source=raw['source'], report=report)
        i = out['source']['neutralFrame']
        bent = np.maximum(np.abs(C.knee_flexion(P, 'L')), np.abs(C.knee_flexion(P, 'R')))
        # The squat never straightens past 24°: the least bent frame stands in.
        self.assertGreater(bent.min(), M.STRAIGHT_KNEE_DEG)
        self.assertEqual(i, int(np.argmin(bent)))
        # Three frames walking past with dead straight legs, then three still
        # ones with the knees bent 10°: the still stance is the neutral.
        flat = np.r_[P[:1].repeat(6, 0), P]
        for k in range(6):
            flat[k] += [0.15 * k if k < 3 else 0.45, 0, 0]
            for s in C.SIDES:
                h, a = flat[k, C.I['hip' + s]], flat[k, C.I['ankle' + s]]
                fwd = flat[k, C.I['toe' + s]] - flat[k, C.I['heel' + s]]
                fwd[1] = 0
                flat[k, C.I['knee' + s]] = (h + a) / 2 + (0 if k < 3 else 0.04) * fwd / np.linalg.norm(fwd)
        bent6 = np.abs(C.knee_flexion(flat[:6], 'L'))
        self.assertTrue((bent6[:3] < 1).all() and (bent6[3:] > 5).all() and (bent6[3:] < M.STRAIGHT_KNEE_DEG).all(), bent6)
        self.assertIn(M.neutral_frame(flat, fps), (4, 5), 'the still straight-legged stance')
        pts = np.array(out['clips'][0]['data']).reshape(T, len(M.POINTS), 3)
        self.assertEqual(len(out['neutral']), len(M.POINTS) * 3)
        self.assertLess(np.abs(np.array(out['neutral']).reshape(-1, 3) - pts[i]).max(), 1e-3)
        self.assertEqual(M.motion_file(P, fps, name='squat', neutral=5)['source']['neutralFrame'], 5)
        self.assertNotIn('neutral', M.motion_file(P, fps, name='squat', neutral=None))


if __name__ == '__main__':
    unittest.main()
