"""footwork.py: a noisy foot path is told into stands and real steps."""
import unittest
import numpy as np
import footwork as W


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


if __name__ == '__main__':
    unittest.main()
