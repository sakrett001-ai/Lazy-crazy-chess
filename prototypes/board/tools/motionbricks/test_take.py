"""Checks of take.py on a synthetic take (no GPU, no MotionBricks):

    python -m unittest test_take.py
"""

import json
import math
import shutil
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np

from take import FORMAT, forward_kinematics, read_take, take_to_motion

# A small SOMA-named skeleton, Z up, facing +X, metres.
JOINTS = [("Hips", -1, (0, 0, .95)), ("Spine1", 0, (0, 0, .12)), ("Chest", 1, (0, 0, .2)), ("Neck1", 2, (0, 0, .2)), ("Head", 3, (0, 0, .12)),
          ("LeftLeg", 0, (0, .1, -.05)), ("LeftShin", 5, (0, 0, -.45)), ("LeftFoot", 6, (0, 0, -.42)), ("LeftToeBase", 7, (.14, 0, -.06)),
          ("RightLeg", 0, (0, -.1, -.05)), ("RightShin", 9, (0, 0, -.45)), ("RightFoot", 10, (0, 0, -.42)), ("RightToeBase", 11, (.14, 0, -.06)),
          ("LeftArm", 2, (0, .19, .15)), ("RightArm", 2, (0, -.19, .15))]
SKELETON = {"joints": [j[0] for j in JOINTS], "parents": [j[1] for j in JOINTS],
            "reference": [[*j[2], 0, 0, 0, 1] for j in JOINTS]}


def axis_angle(axis, angle):
    s = math.sin(angle / 2)
    return [axis[0] * s, axis[1] * s, axis[2] * s, math.cos(angle / 2)]


def write_take(path, frames=60, dt=1 / 60, extra=None):
    """A take in crowdbricks' layout: one character walks +X while its left thigh swings."""
    model = list(range(len(JOINTS)))
    times = np.arange(frames, dtype=np.float32) * dt
    alive = np.ones((frames, 1), np.uint8)
    positions = np.zeros((frames, 1, 3), np.float32)
    positions[:, 0, 0] = 1.2 * times
    positions[:, 0, 2] = .95
    rotations = np.zeros((frames, 1, len(model), 4), np.float32)
    rotations[..., 3] = 1
    swing = 0.5 * np.sin(2 * math.pi * times)
    for f, a in enumerate(swing):
        # Thigh forward = rotation about -Y (Z up, X forward): the knee moves to +X.
        rotations[f, 0, 5] = axis_angle((0, -1, 0), a)
    quantized = np.clip(np.round(rotations * 32767), -32767, 32767).astype(np.int16)
    blobs, offset = [], 0

    def add(array):
        nonlocal offset
        data = np.ascontiguousarray(array).tobytes()
        entry = {"offset": offset, "length": int(array.size), "dtype": str(array.dtype)}
        blobs.append(data + b"\0" * ((-len(data)) % 4))
        offset += len(blobs[-1])
        return entry

    header = {"format": "crowdbricks.take", "version": 1, "frames": frames, "capacity": 1, "model_joints": model,
              "times": add(times), "alive": add(alive), "positions": add(positions), "rotations": add(quantized), "batches": [], "world": {}}
    if extra:
        header.update(extra)
    raw = json.dumps(header).encode()
    raw += b" " * ((-len(raw)) % 4)
    Path(path).write_bytes(b"CBT1" + struct.pack("<I", len(raw)) + raw + b"".join(blobs))
    return swing


class TakeTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)

    def test_reads_the_take(self):
        write_take(self.dir / "t.cbt")
        header, arrays = read_take(self.dir / "t.cbt")
        self.assertEqual(arrays["rotations"].shape, (60, 1, len(JOINTS), 4))
        self.assertAlmostEqual(float(arrays["positions"][30, 0, 0]), 1.2 * 30 / 60, places=5)
        with self.assertRaises(ValueError):
            (self.dir / "bad.cbt").write_bytes(b"XXXX0000")
            read_take(self.dir / "bad.cbt")

    def test_forward_kinematics_swings_the_knee(self):
        swing = write_take(self.dir / "t.cbt")
        header, arrays = read_take(self.dir / "t.cbt")
        world = forward_kinematics(SKELETON, arrays["positions"][:, 0].astype(float), arrays["rotations"][:, 0].astype(float), header["model_joints"])
        hip, knee = world[:, 5], world[:, 6]
        for f in (0, 15, 45):
            expected = hip[f] + .45 * np.array([math.sin(swing[f]), 0, -math.cos(swing[f])])
            np.testing.assert_allclose(knee[f], expected, atol=2e-4)
        # Bones keep their lengths.
        np.testing.assert_allclose(np.linalg.norm(knee - hip, axis=1), .45, atol=1e-4)
        self.assertAlmostEqual(float(world[0, 0, 2]), .95, places=5)

    def test_motion_file_by_scenario(self):
        extra = {"lazy_chess": {"clips": [{"slot": 0, "name": "march", "label": "Строевой шаг", "role": "march", "loop": False, "start": .2, "end": .8}]}}
        write_take(self.dir / "t.cbt", extra=extra)
        header, arrays = read_take(self.dir / "t.cbt")
        motion = take_to_motion(header, arrays, SKELETON, fps=30)
        self.assertEqual(motion["format"], FORMAT)
        clip = motion["clips"][0]
        self.assertEqual((clip["name"], clip["role"]), ("march", "march"))
        self.assertIn(clip["frames"], (18, 19))  # 0.2..0.8 s at 30 fps
        self.assertEqual(len(clip["data"]), clip["frames"] * len(motion["points"]) * 3)
        self.assertIn("NVIDIA", motion["source"]["license"])
        for p in ("pelvis", "hipL", "kneeL", "ankleL", "toeL", "neck", "head", "shoulderL"):
            self.assertIn(p, motion["points"])

    @unittest.skipUnless(shutil.which("node"), "нет node")
    def test_the_page_reads_and_retargets_it(self):
        write_take(self.dir / "t.cbt")
        header, arrays = read_take(self.dir / "t.cbt")
        (self.dir / "m.json").write_text(json.dumps(take_to_motion(header, arrays, SKELETON)))
        board = Path(__file__).resolve().parents[2]
        script = f"""
import {{readFile}} from 'node:fs/promises';
import {{readMotionSource}} from '{(board / 'src/mocap/library.mjs').as_uri()}';
const s=readMotionSource('m.json',await readFile('{(self.dir / 'm.json').as_posix()}','utf8'));const c=s.clips[0];
console.log(JSON.stringify({{n:c.count,leg:c.leg,travel:c.travel,head:c.frames[0].head}}));
"""
        out = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, check=True).stdout
        clip = json.loads(out)
        self.assertGreater(clip["n"], 20)
        self.assertAlmostEqual(clip["leg"], .87, delta=.01)
        # Z up turned to Y up and +X walking turned to +Z forward.
        self.assertGreater(clip["head"][1], 1.0)
        self.assertGreater(clip["travel"][2], .9)
        self.assertLess(abs(clip["travel"][0]), .05)


if __name__ == "__main__":
    unittest.main()
