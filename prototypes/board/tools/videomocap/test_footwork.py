"""footwork.py: a noisy foot path is told into stands and real steps."""
import unittest
import numpy as np
import clean as C
import footwork as W
from test_clean import body, THIGH, SHIN


def walk(ankles, fps=30.0, seed=5, noise=0.0):
    """33 landmarks per frame: the synthetic body of test_clean (left +x,
    facing +z) with ankle paths ankles {s: [T,3]} (x, floor height, z) and
    the pelvis between them; knees by two-bone IK."""
    rng = np.random.default_rng(seed)
    base, pel0 = body(0.0)
    T = len(ankles['L'])
    out = []
    for t in range(T):
        X = base.copy()
        mid = (ankles['L'][t] + ankles['R'][t]) / 2
        shift = np.array([mid[0], 0, mid[2]]) - [pel0[0], 0, pel0[2]]
        X += shift
        for s in C.SIDES:
            a = np.array(ankles[s][t], float) + rng.normal(0, noise, 3) * [1, 0, 1]
            X[C.I['ankle' + s]] = a
            for part, (fwd, up) in C.FOOT_FLAT.items():
                X[C.I[part + s]] = a + np.array([0, up, fwd]) * SHIN
            hip = X[C.I['hip' + s]]
            X[C.I['knee' + s]], _ = C.two_bone_ik(hip, hip + [0, -0.3, 0.1], a, THIGH, SHIN)
        out.append(X)
    return np.array(out)


def path(points, fps=30.0):
    """Piecewise path [(t, x, z)] held between its points, moved linearly."""
    T = int(round(points[-1][0] * fps)) + 1
    t = np.arange(T) / fps
    ts, xs, zs = zip(*points)
    return np.stack([np.interp(t, ts, xs), np.full(T, 0.09), np.interp(t, ts, zs)], 1)


class StandsTest(unittest.TestCase):
    fps = 30.0

    def path(self, places, frames, noise, seed=3):
        rng = np.random.default_rng(seed)
        Y = np.concatenate([np.tile(p, (n, 1)) for p, n in zip(places, frames)])
        return Y + rng.normal(0, noise, Y.shape)

    def test_two_steps_through_depth_noise(self):
        # Two 40 cm steps, 1 s apart; 6 cm of noise per frame (one camera's depth).
        Y = self.path([[0, 0], [0.4, 0], [0.8, 0]], [30, 30, 30], 0.06)
        seg = W.stands(W.gauss(Y, 1.0), self.fps)
        self.assertEqual(len(seg), 3)
        for (a, b, p), want in zip(seg, [0, 0.4, 0.8]):
            self.assertAlmostEqual(p[0], want, delta=0.05)

    def test_noise_alone_makes_no_step(self):
        Y = self.path([[0, 0]], [90], 0.06)
        self.assertEqual(len(W.stands(W.gauss(Y, 1.0), self.fps)), 1)

    def test_out_and_back_is_no_step(self):
        # 25 cm out and straight back within 0.4 s: a depth error, not a step.
        Y = self.path([[0, 0], [0.25, 0], [0, 0]], [40, 12, 38], 0.01)
        self.assertEqual(len(W.stands(Y, self.fps)), 1)

    def test_min_jerk_starts_and_ends_at_rest(self):
        u = np.linspace(0, 1, 101)
        m = W.min_jerk(u)
        self.assertEqual((m[0], m[-1]), (0.0, 1.0))
        self.assertLess(m[1] - m[0], 1e-4)
        self.assertLess(m[-1] - m[-2], 1e-4)


class FeetTogetherTest(unittest.TestCase):
    fps = 30.0

    def lifted(self, Y, s, rise):
        return Y[:, C.I['ankle' + s], 1] > rise + 0.01

    def test_one_foot_in_the_air_at_a_time(self):
        # The recording steps both feet forward at once (an advance whose
        # second step one camera put early): the rebuilt feet step one by one.
        L = path([(0, 0.12, 0), (1.0, 0.12, 0), (1.3, 0.12, 0.4), (3, 0.12, 0.4)])
        R = path([(0, -0.12, 0.3), (1.05, -0.12, 0.3), (1.35, -0.12, 0.7), (3, -0.12, 0.7)])
        X = walk({'L': L, 'R': R})
        before = (L[:, 2] != L[0, 2]) & (L[:, 2] != L[-1, 2]) & (R[:, 2] != R[0, 2]) & (R[:, 2] != R[-1, 2])
        self.assertGreater(before.sum(), 3)
        Y, plants, rep = W.steady(X, self.fps, left=(1, 0, 0))
        rise = np.median(Y[:, C.I['ankleL'], 1])
        both = self.lifted(Y, 'L', rise) & self.lifted(Y, 'R', rise)
        self.assertEqual(int(both.sum()), 0, rep)
        self.assertEqual(rep['bothFeetUpFrames'], 0)
        self.assertEqual(rep['steps'], {'L': 1, 'R': 1})

    def test_windows_of_two_feet_never_overlap(self):
        win = {'L': [[10, 22], [40, 50]], 'R': [[14, 26], [44, 52]]}
        out, both, stuck = W.one_at_a_time(win, 80, self.fps)
        self.assertEqual((both, stuck), (0, []))
        for (a0, a1) in out['L']:
            for (b0, b1) in out['R']:
                self.assertFalse(a0 < b1 and b0 < a1, out)
        for s in out:  # each step moved no further than SHIFT_MAX, kept no shorter than STEP_TIME[0]
            for (u0, u1), (v0, v1) in zip(win[s], out[s]):
                self.assertLessEqual(abs((u0 + u1) - (v0 + v1)) / 2, W.SHIFT_MAX * self.fps + 1)
                self.assertGreaterEqual(v1 - v0, round(W.STEP_TIME[0] * self.fps))

    def test_each_foot_keeps_its_side(self):
        # One camera put the stance on one line and crossed it by 4 cm.
        L = path([(0, -0.02, 0.0), (2, -0.02, 0.0)])
        R = path([(0, 0.02, 0.35), (2, 0.02, 0.35)])
        X = walk({'L': L, 'R': R})
        Y, _, rep = W.steady(X, self.fps, left=(1, 0, 0))
        width = Y[:, C.I['ankleL'], 0] - Y[:, C.I['ankleR'], 0]
        self.assertEqual(W.WIDTH_MIN, 0.08)
        self.assertGreaterEqual(width.min(), 0.075, rep)
        Y0, _, _ = W.steady(X, self.fps)  # not told where the fighter faces: left as recorded
        self.assertLess((Y0[:, C.I['ankleL'], 0] - Y0[:, C.I['ankleR'], 0]).max(), 0)


if __name__ == '__main__':
    unittest.main()
