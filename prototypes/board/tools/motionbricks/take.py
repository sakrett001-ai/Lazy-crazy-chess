"""crowdbricks take (CBT1) -> motion file of "living chess" (lazy-chess.motion v1).

Needs only numpy: runs anywhere, no GPU. bake.py writes the take, the SOMA
skeleton (skeleton.json) and calls this on a GPU machine; this file alone
converts a take you already have.

    python take.py out/take.cbt out/skeleton.json -o out/motions.json

A take holds, per recorded step, the root position (world, Z up, metres) and
the local rotations of the 30 model joints (int16 quaternions xyzw * 32767).
The other joints keep the skeleton's reference rotation. Forward kinematics
gives every joint's position; the anatomical key points are written out and
the page works out the up axis, facing and scale itself.
"""

from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

import numpy as np

FORMAT = "lazy-chess.motion"
# SOMA calls the thigh "Leg" and the knee "Shin" (src/mocap/profiles.mjs).
SOMA_POINTS = {
    "pelvis": "Hips", "spine": "Spine1", "chest": "Chest", "neck": "Neck1", "head": "Head",
    "eyeL": "LeftEye", "eyeR": "RightEye",
    "hipL": "LeftLeg", "kneeL": "LeftShin", "ankleL": "LeftFoot", "toeL": "LeftToeBase",
    "hipR": "RightLeg", "kneeR": "RightShin", "ankleR": "RightFoot", "toeR": "RightToeBase",
    "shoulderL": "LeftArm", "elbowL": "LeftForeArm", "wristL": "LeftHand",
    "shoulderR": "RightArm", "elbowR": "RightForeArm", "wristR": "RightHand",
}
REQUIRED = ("pelvis", "hipL", "kneeL", "ankleL", "toeL", "hipR", "kneeR", "ankleR", "toeR", "shoulderL", "shoulderR", "neck", "head")
# Order of points in the file: the same as POINTS in profiles.mjs.
POINT_ORDER = ("pelvis", "spine", "chest", "neck", "head", "eyeL", "eyeR", "earL", "earR", "nose",
               "hipL", "kneeL", "ankleL", "heelL", "toeL", "hipR", "kneeR", "ankleR", "heelR", "toeR",
               "shoulderL", "elbowL", "wristL", "shoulderR", "elbowR", "wristR")
SAMPLE_LICENSE = ("NVIDIA Sample Data Evaluation License: только внутренняя оценка; "
                  "не публиковать и не распространять производные")


def read_take(path: str | Path) -> tuple[dict, dict[str, np.ndarray]]:
    """Header and arrays of a CBT1 take (crowdbricks/record.py)."""
    raw = Path(path).read_bytes()
    if raw[:4] != b"CBT1":
        raise ValueError(f"{path}: это не take crowdbricks (нет метки CBT1)")
    (size,) = struct.unpack("<I", raw[4:8])
    header = json.loads(raw[8:8 + size])
    body = memoryview(raw)[8 + size:]

    def read(entry: dict) -> np.ndarray:
        dtype = np.dtype(entry["dtype"])
        return np.frombuffer(body[entry["offset"]:entry["offset"] + entry["length"] * dtype.itemsize], dtype=dtype)

    frames, capacity, joints = header["frames"], header["capacity"], len(header["model_joints"])
    arrays = {
        "times": read(header["times"]),
        "alive": read(header["alive"]).reshape(frames, capacity),
        "positions": read(header["positions"]).reshape(frames, capacity, 3),
        "rotations": read(header["rotations"]).reshape(frames, capacity, joints, 4).astype(np.float32) / 32767.0,
    }
    return header, arrays


def _qmul(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    ax, ay, az, aw = np.moveaxis(a, -1, 0)
    bx, by, bz, bw = np.moveaxis(b, -1, 0)
    return np.stack([aw * bx + ax * bw + ay * bz - az * by,
                     aw * by - ax * bz + ay * bw + az * bx,
                     aw * bz + ax * by - ay * bx + az * bw,
                     aw * bw - ax * bx - ay * by - az * bz], axis=-1)


def _qrot(q: np.ndarray, v: np.ndarray) -> np.ndarray:
    u, w = q[..., :3], q[..., 3:4]
    t = 2.0 * np.cross(u, v)
    return v + w * t + np.cross(u, t)


def forward_kinematics(skeleton: dict, root: np.ndarray, local: np.ndarray, model_joints: list[int]) -> np.ndarray:
    """World positions [frames, joints, 3]. root: [frames, 3] position of joint 0; local:
    [frames, len(model_joints), 4] local rotations of the model joints."""
    parents = skeleton["parents"]
    reference = np.asarray(skeleton["reference"], dtype=np.float64).reshape(-1, 7)
    count, frames = len(parents), root.shape[0]
    rotation = np.tile(reference[:, 3:], (frames, 1, 1))
    rotation[:, model_joints] = local
    rotation /= np.linalg.norm(rotation, axis=-1, keepdims=True)
    world_q = np.zeros((frames, count, 4))
    world_p = np.zeros((frames, count, 3))
    done = [False] * count

    def solve(j: int) -> None:
        if done[j]:
            return
        parent = parents[j]
        if parent < 0:
            world_q[:, j] = rotation[:, j]
            world_p[:, j] = root if j == 0 else reference[j, :3]
        else:
            solve(parent)
            world_q[:, j] = _qmul(world_q[:, parent], rotation[:, j])
            offset = root if j == 0 else np.broadcast_to(reference[j, :3], (frames, 3))
            world_p[:, j] = world_p[:, parent] + _qrot(world_q[:, parent], offset)
        done[j] = True

    for j in range(count):
        solve(j)
    return world_p


def key_points(skeleton: dict, world: np.ndarray) -> dict[str, np.ndarray]:
    index = {name: i for i, name in enumerate(skeleton["joints"])}
    missing = [p for p in REQUIRED if SOMA_POINTS[p] not in index]
    if missing:
        raise ValueError("в скелете нет суставов для точек: " + ", ".join(missing))
    return {p: world[:, index[j]] for p, j in SOMA_POINTS.items() if j in index}


def clip_entry(name: str, points: dict[str, np.ndarray], *, label: str, role: str, loop: bool, fps: float) -> dict:
    used = [p for p in POINT_ORDER if p in points]
    frames = len(points["pelvis"])
    data = np.stack([points[p] for p in used], axis=1).reshape(-1)
    return {"used": used, "clip": {"name": name, "label": label, "role": role, "loop": bool(loop), "fps": fps,
                                   "frames": int(frames), "data": [round(float(v), 4) for v in data]}}


def take_to_motion(header: dict, arrays: dict, skeleton: dict, *, fps: float = 30.0) -> dict:
    """Motion file from a take: one clip per scenario in header["lazy_chess"]["clips"]
    ({slot, name, label, role, loop, start, end} in seconds), or one clip per character."""
    times = arrays["times"]
    scenarios = header.get("lazy_chess", {}).get("clips") or [
        {"slot": int(s), "name": f"character-{int(s)}", "label": f"Персонаж {int(s)}", "role": "other", "loop": False}
        for s in np.flatnonzero(arrays["alive"].any(axis=0))]
    entries = []
    for scenario in scenarios:
        slot = scenario["slot"]
        start, end = scenario.get("start", 0.0), scenario.get("end", float(times[-1]))
        # Resample the recorded steps to an even frame rate.
        alive = np.flatnonzero(arrays["alive"][:, slot] & (times >= start - 1e-6) & (times <= end + 1e-6))
        if len(alive) < 2:
            raise ValueError(f"сценарий {scenario['name']}: персонаж не записан")
        t = times[alive]
        grid = np.arange(t[0], t[-1] + 1e-9, 1.0 / fps)
        world = forward_kinematics(skeleton, arrays["positions"][alive, slot].astype(np.float64),
                                   arrays["rotations"][alive, slot].astype(np.float64), header["model_joints"])
        points = key_points(skeleton, world)
        points = {p: np.stack([np.interp(grid, t, v[:, axis]) for axis in range(3)], axis=1) for p, v in points.items()}
        entries.append(clip_entry(scenario["name"], points, label=scenario.get("label", scenario["name"]),
                                  role=scenario.get("role", "other"), loop=scenario.get("loop", False), fps=fps))
    used = [p for p in POINT_ORDER if all(p in e["used"] for e in entries)]
    clips = []
    for e in entries:
        c = dict(e["clip"])
        if e["used"] != used:  # keep only the points every clip has
            keep = [e["used"].index(p) for p in used]
            data = np.asarray(c["data"]).reshape(c["frames"], len(e["used"]), 3)[:, keep]
            c["data"] = [round(float(v), 4) for v in data.reshape(-1)]
        clips.append(c)
    return {"format": FORMAT, "version": 1,
            "source": {"kind": "motionbricks", "name": "MotionBricks + crowdbricks, скелет SOMA", "license": SAMPLE_LICENSE,
                       "note": "Запечено на машине с GPU NVIDIA; не коммитить и не выкладывать."},
            "points": used, "clips": clips}


def main() -> None:
    parser = argparse.ArgumentParser(description="take crowdbricks (CBT1) → файл движений живых шахмат")
    parser.add_argument("take")
    parser.add_argument("skeleton", help="skeleton.json, который пишет bake.py")
    parser.add_argument("-o", "--out", default="motions.json")
    parser.add_argument("--fps", type=float, default=30.0)
    args = parser.parse_args()
    header, arrays = read_take(args.take)
    skeleton = json.loads(Path(args.skeleton).read_text())
    motion = take_to_motion(header, arrays, skeleton, fps=args.fps)
    Path(args.out).write_text(json.dumps(motion, ensure_ascii=False, separators=(",", ":")))
    print(f"{args.out}: {len(motion['clips'])} клипов: " + ", ".join(c["name"] for c in motion["clips"]))


if __name__ == "__main__":
    main()
