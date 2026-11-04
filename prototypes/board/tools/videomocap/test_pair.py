"""Checks of two-person capture (pair.py) and of the duel scene (duel.py,
motion.py --pair) on synthetic detections: no video and no model needed.

    python3 -m unittest test_pair.py

The cases are the three ways two people break single-person capture:
identity (who is who after they cross or after an edit cut), merging (one
skeleton takes joints of the other at contact) and losing one of them.
"""
import unittest

import numpy as np

import clean as C
import duel as D
import motion as M
import pair as PR
import test_clean as TC

FPS = 30.0
F, SIZE = TC.F, TC.SIZE


def rot_y(X, deg):
    t = np.radians(deg)
    R = np.array([[np.cos(t), 0, np.sin(t)], [0, 1, 0], [-np.sin(t), 0, np.cos(t)]])
    return X @ R.T


def person(t, x, facing, scale=1.0):
    """33 landmarks, y up: the squatting person of test_clean, turned to face
    `facing` degrees (0 = +z, 90 = +x) and stood at x."""
    X, _ = TC.body(t)
    return rot_y(X * scale, facing) + [x, 0, 0]


def project(X):
    return TC.project(X)


def det_of(X, t, app=None, vis=None):
    """A detection as pair.detection makes it from the model's output."""
    hips = (X[C.I['hipL']] + X[C.I['hipR']]) / 2
    world = ((X - hips) @ TC.R.T).tolist()
    image = np.c_[project(X), np.zeros(33)].tolist()
    v = list(vis) if vis is not None else [0.95] * 33
    d = PR.detection(world, image, v, v, t)
    d['app'] = app
    return d


def colour(k):
    h = np.full(144, 0.2 / 143)
    h[k] = 0.8
    return h / h.sum()


class PairTest(unittest.TestCase):
    def follow(self, frames, cuts=()):
        """Runs assign + untangle the way capture_pair does over given detections."""
        tracks = [PR.Track('A'), PR.Track('B')]
        out = [[], []]
        for i, dets in enumerate(frames):
            if tracks[0].c is None:
                dets = sorted(dets, key=lambda d: d['c'][0])
                for k in (0, 1):
                    tracks[k].accept(dets[k], i)
                    out[k].append(dets[k])
                continue
            choice = PR.assign(dets, tracks, i, i in cuts)
            picked = [dets[choice[k]] if choice[k] is not None else None for k in (0, 1)]
            for k in (0, 1):
                if picked[k] is not None:
                    tracks[k].accept(picked[k], i)
                out[k].append(picked[k])
        return out

    def test_identity_kept_when_order_shuffles_and_one_is_lost(self):
        rng = np.random.default_rng(1)
        frames = []
        for i in range(60):
            t = i / FPS
            a = det_of(person(t, -0.9 + 0.01 * i, 90), t, colour(3))
            b = det_of(person(t, 0.9 - 0.01 * i, -90), t, colour(40))
            dets = [a, b]
            if 25 <= i < 30:
                dets = [b]  # A hidden behind B for five frames
            rng.shuffle(dets)
            frames.append(dets)
        A, B = self.follow(frames)
        for i in range(60):
            if A[i] is not None:
                self.assertEqual(int(np.argmax(A[i]['app'])), 3, f'кадр {i}: A стал B')
            self.assertEqual(int(np.argmax(B[i]['app'])), 40, f'кадр {i}: B стал A')
        self.assertTrue(all(A[i] is None for i in range(25, 30)))

    def test_cut_identity_by_clothes(self):
        """After a cut the camera stands on the other side: B is now on the
        left. Position means nothing across a cut, clothes decide."""
        frames = []
        for i in range(40):
            t = i / FPS
            xa, xb = (-0.9, 0.9) if i < 20 else (0.9, -0.9)
            frames.append([det_of(person(t, xa, 90), t, colour(3)), det_of(person(t, xb, -90), t, colour(40))])
        A, B = self.follow(frames, cuts={20})
        self.assertTrue(all(int(np.argmax(A[i]['app'])) == 3 for i in range(40)))
        self.assertTrue(all(int(np.argmax(B[i]['app'])) == 40 for i in range(40)))

    def test_cut_detector(self):
        rng = np.random.default_rng(2)
        base = rng.uniform(0, 255, (64, 48))
        cuts = PR.CutDetector(PR.DEFAULTS)
        hist = np.full(128, 1 / 128)
        found = []
        for i in range(50):
            g = base + rng.normal(0, 1, base.shape) + (80 if i >= 30 else 0) * np.sin(np.arange(48) / 3)[None, :]
            if cuts((hist, g)):
                found.append(i)
        self.assertEqual(found, [30])

    def test_borrowed_wrist_hidden(self):
        """At contact the model puts A's wrist on B's forearm."""
        t = 0.0
        a, b = person(t, -0.35, 90), person(t, 0.35, -90)
        ta, tb = PR.Track('A'), PR.Track('B')
        ta.accept(det_of(a, t), 0)
        tb.accept(det_of(b, t), 0)
        a2 = a.copy()
        a2[C.I['wristR']] = (b[C.I['elbowL']] + b[C.I['wristL']]) / 2
        da, db = det_of(a2, 1 / FPS), det_of(b, 1 / FPS)
        lost, drop = PR.untangle(da, db, ta, tb, 1, fps=FPS)
        self.assertGreaterEqual(lost, 1)
        self.assertEqual(da['vis'][C.I['wristR']], 0.0)
        self.assertEqual(drop, [False, False])
        self.assertTrue(all(v > 0 for v in db['vis']))

    def test_borrowed_trunk_drops_skeleton(self):
        t = 0.0
        a, b = person(t, -0.35, 90), person(t, 0.35, -90)
        ta, tb = PR.Track('A'), PR.Track('B')
        ta.accept(det_of(a, t), 0)
        tb.accept(det_of(b, t), 0)
        a2 = a.copy()
        for j in ('shoulderR', 'hipR'):
            a2[C.I[j]] = b[C.I[j.replace('R', 'L')]]  # half of A's trunk sits on B
        da, db = det_of(a2, 1 / FPS), det_of(b, 1 / FPS)
        da['vis'], db['vis'] = list(da['vis']), list(db['vis'])
        _, drop = PR.untangle(da, db, ta, tb, 1, fps=FPS)
        self.assertEqual(drop, [True, False])

    def test_merged_skeleton_is_not_a_body(self):
        """Legs of one person and arms of the other reaching across: limbs far
        too long for the trunk they hang from."""
        a, b = person(0, -0.6, 90), person(0, 0.6, -90)
        m = a.copy()
        for j in ('elbowL', 'wristL', 'elbowR', 'wristR'):
            m[C.I[j]] = b[C.I[j]]
        self.assertTrue(PR.anatomical(project(a)))
        self.assertFalse(PR.anatomical(project(m)))

    def test_duplicate_at_start_refused(self):
        a = det_of(person(0, -0.6, 90), 0)
        b = det_of(person(0, 0.6, -90), 0)
        twin = det_of(person(0, -0.6, 90) + [0.01, 0, 0], 0)
        self.assertTrue(PR.distinct(a, b))
        self.assertFalse(PR.distinct(a, twin))

    def test_walk_back_predicts_backwards(self):
        tr = PR.Track('A')
        for i, x in ((10, 100.0), (9, 104.0), (8, 108.0)):  # time runs backwards, x grows
            tr.accept({'c': np.array([x, 0.0]), 'image': np.zeros((33, 3)), 'vis': [1] * 33, 'h': 300.0,
                       'box': [0, 0, 50, 300], 'len': np.ones(12)}, i)
        self.assertGreater(tr.predict(7)[0], 108.0)


class DuelTest(unittest.TestCase):
    """A thrusts at B's head, B parries; then B kicks A's knee."""

    @classmethod
    def setUpClass(cls):
        T = 60
        A, B = [], []
        for i in range(T):
            t = i / FPS
            a = person(0, -0.8, 90)
            b = person(0, 0.8, -90)
            # Thrust: A's right wrist goes from the hip to B's face, frames 14–20.
            k = np.clip((i - 14) / 6, 0, 1) if i <= 20 else np.clip(1 - (i - 20) / 10, 0, 1)
            sh, face = a[C.I['shoulderR']], b[C.I['nose']]
            hand = a[C.I['wristR']] * (1 - k) + (sh + (face - sh) * 0.4) * k
            a[C.I['elbowR']] = (sh + hand) / 2 + [0, -0.05, 0]
            a[C.I['wristR']] = hand
            # B's hands rise fast to meet it, frames 18–22.
            if 18 <= i <= 22:
                for s in 'LR':
                    b[C.I[f'wrist{s}']] += [0, 0.12 * (i - 17), 0]
            if i > 22:
                for s in 'LR':
                    b[C.I[f'wrist{s}']] += [0, 0.6, 0]
            # Kick: B's right foot from the floor to A's left knee, frames 35–41.
            if 35 <= i <= 47:
                q = np.clip((i - 35) / 6, 0, 1) if i <= 41 else np.clip(1 - (i - 41) / 6, 0, 1)
                move = (a[C.I['kneeL']] + [0.08, 0, 0] - b[C.I['toeR']]) * q  # the toe ends at A's knee
                for j in ('kneeR', 'ankleR', 'heelR', 'toeR'):
                    b[C.I[j]] = b[C.I[j]] + move * (0.5 if j == 'kneeR' else 1.0)
            A.append(a)
            B.append(b)
        cls.PA, cls.PB = D.to_pair_frame(np.array(A), np.array(B))
        seen = {'A': np.ones(T, bool), 'B': np.ones(T, bool)}
        cls.events = D.strikes({'A': cls.PA, 'B': cls.PB}, FPS, seen)

    def test_frame(self):
        pa, pb = C.pelvis(self.PA), C.pelvis(self.PB)
        self.assertLess(pa[0, 0], 0)
        self.assertGreater(pb[0, 0], 0)
        self.assertAlmostEqual(float(np.linalg.norm(pb[0] - pa[0])), 1.6, places=2)
        self.assertAlmostEqual(float((pa[0, 0] + pb[0, 0]) / 2), 0.0, places=3)
        left = self.PA[0, C.I['hipL']] - self.PA[0, C.I['hipR']]
        forward = np.cross(left, [0, 1, 0])  # left × up points where the body faces
        self.assertGreater(forward[0], 0.9 * np.linalg.norm(forward))

    def test_thrust_found_with_parry(self):
        th = [e for e in self.events if e['by'] == 'A' and e['limb'] == 'hands']
        self.assertEqual(len(th), 1, th)
        e = th[0]
        self.assertEqual(e['target'], 'head')
        self.assertTrue(e['reached'])
        self.assertTrue(e['sourceGuessed'])
        self.assertIn('hands', e['answer'])
        self.assertLessEqual(e['start'], 16)
        self.assertTrue(18 <= e['reach'] <= 21)
        parry = [x for x in self.events if x['by'] == 'B' and x['limb'] == 'hands']
        self.assertEqual([(x['kind'], x['answers']) for x in parry], [('parry', e['id'])])

    def test_kick_is_a_strike_of_the_leg(self):
        k = [e for e in self.events if e['by'] == 'B' and e['source'] == 'leg']
        self.assertEqual(len(k), 1, k)
        self.assertEqual((k[0]['limb'], k[0]['kind']), ('footR', 'kick'))
        self.assertIn(k[0]['target'], ('legL', 'legR'))
        self.assertTrue(k[0]['reached'])

    def test_notes_tell_the_shield(self):
        ev = D.apply_notes([dict(e) for e in self.events], {str(self.events[0]['id']): {'source': 'shield', 'kind': 'bash', 'outcome': 'blocked'}})
        e = next(x for x in ev if x['id'] == self.events[0]['id'])
        self.assertEqual((e['source'], e['kind'], e['outcome'], e['sourceGuessed']), ('shield', 'bash', 'blocked', False))

    def test_pair_motion_file(self):
        pair = {'fps': FPS, 'source': {'video': 'synthetic', 'firstFrame': 0},
                'people': {'A': {'frames': self.PA.tolist()}, 'B': {'frames': self.PB.tolist()}}, 'distance': {'median': 1.6}}
        out = M.pair_motion_file(pair, by='A', first=5, last=30, name='thrust')
        strike, struck = out['clips']
        self.assertEqual((strike['role'], struck['role']), ('strike', 'struck'))
        self.assertEqual((strike['partner'], struck['partner']), ('thrust.struck', 'thrust.strike'))
        self.assertEqual(strike['frame'], 'shared')
        J = len(out['points'])
        X = np.array(strike['data']).reshape(-1, J, 3)
        Y = np.array(struck['data']).reshape(-1, J, 3)
        pel = out['points'].index('pelvis')
        self.assertTrue(np.allclose(X[0, pel, [0, 2]], 0, atol=1e-3))
        # The striker faces +Z, the struck one stands 1.6 m ahead of him.
        self.assertAlmostEqual(float(Y[0, pel, 2]), 1.6, places=2)
        self.assertAlmostEqual(float(Y[0, pel, 0]), 0.0, places=2)
        self.assertIn('neutral', strike)
        self.assertIn('neutral', struck)


if __name__ == '__main__':
    unittest.main()
