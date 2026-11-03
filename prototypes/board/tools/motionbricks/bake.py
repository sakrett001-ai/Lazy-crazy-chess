"""Bake gaits for "living chess" with crowdbricks + MotionBricks (NVIDIA GPU only).

Runs each scenario on its own character in one crowd, records a take, and
writes three files into --out:

  take.cbt       the crowdbricks take (opens in crowdbricks/viewer too)
  skeleton.json  the SOMA skeleton: joint names, parents, reference pose
  motions.json   the clips for the board and the motion lab (take.py)

    PYTHONPATH=<motionbricks checkout>:<crowdbricks checkout> python bake.py --out out

Scenarios (one square of the board is 2.6 m):
  march        steady walk, 6 s after it settles
  step_square  from rest: walk one square and stop
  stand        rest stance
  shift        turn the feet 25° on the spot: a weight shift
  approach     walk to a point 3.2 m ahead and stop facing it
  combat_march the same walk in upstream's "combat" style

The gaits come from NVIDIA's sample motions: their licence allows internal
evaluation only, so the output must not be committed or published.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

from take import read_take, take_to_motion

SQUARE = 2.6
SLIDE = 0.45  # Stand's default: a walking character stops this far past the hand-over (s · speed)


def scenarios(gaits, Walk, Stand):
    """name -> (label, role, loop, seconds, start, driver factory, heading)."""
    east = (1.0, 0.0)
    return {
        "march": ("Строевой шаг", "march", False, 8.0, 1.5, lambda: Walk(gaits["walk"], heading=east), east),
        "step_square": ("Шаг на клетку и остановка", "step", False, 5.0, 0.0,
                        lambda: Walk(gaits["walk"], heading=east, distance=SQUARE - SLIDE, then=Stand(heading=east)), east),
        "stand": ("Стойка покоя", "stand", True, 6.0, 1.0, lambda: Stand(heading=east), east),
        "shift": ("Переминание", "shift", False, 4.0, 0.5,
                  lambda: Stand(heading=(math.cos(math.radians(25)), math.sin(math.radians(25)))), east),
        "approach": ("Подход к цели", "approach", False, 6.0, 0.0, None, east),
        "combat_march": ("Боевой шаг", "march", False, 8.0, 1.5, lambda: Walk(gaits["combat"], heading=east), east),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default="out")
    parser.add_argument("--only", nargs="*", help="только эти сценарии")
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--cache", default="trt-cache", help="кэш движка TensorRT (первый запуск собирает его несколько минут)")
    parser.add_argument("--fp32", action="store_true")
    args = parser.parse_args()

    import warp as wp

    from app.runtime.common.rig import load_rig_assets
    from crowdbricks import BatchGenerator, Crowd, GaitLibrary, Stand, Walk
    from crowdbricks.record import Recorder
    from motionbricks.model.contract import ModelRig

    wp.init()
    wp.set_device("cuda:0")
    assets = load_rig_assets(ModelRig.SOMA)
    chosen_names = args.only or ["march", "step_square", "stand", "shift", "approach", "combat_march"]
    generator = BatchGenerator(assets, batch=max(2, len(chosen_names)), capacity=len(chosen_names), fp16=not args.fp32, cache_dir=args.cache)
    gaits = GaitLibrary(assets, generator.stream)
    table = scenarios(gaits, Walk, Stand)
    unknown = [n for n in chosen_names if n not in table]
    if unknown:
        raise SystemExit("нет таких сценариев: " + ", ".join(unknown))
    crowd = Crowd(generator, gaits)
    recorder = Recorder(crowd, plans=False)

    clips, ends = [], {}
    for row, name in enumerate(chosen_names):
        label, role, loop, seconds, start, make, heading = table[name]
        spot = np.array([0.0, 8.0 * row])  # 8 m apart: no one walks into a neighbour
        if name == "approach":
            goal = spot + np.array([3.2, 0.0])
            driver = Walk(gaits["walk"], goal=goal, arrive=0.6, then=Stand(heading=heading))
        else:
            driver = make()
        slot = crowd.spawn(spot, heading=heading, driver=driver)
        clips.append({"slot": slot, "name": name, "label": label, "role": role, "loop": loop, "start": start, "end": start + seconds})
        ends[name] = start + seconds

    delta_time = 1.0 / 60.0
    while crowd.clock < max(ends.values()) + delta_time:
        recorder.capture(crowd.step(delta_time))

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    take_path = recorder.save(out / "take.cbt", extra={"lazy_chess": {"clips": clips}})
    skeleton = assets.model.skeleton
    (out / "skeleton.json").write_text(json.dumps({
        "joints": list(skeleton.joint_names),
        "parents": [int(skeleton.joint_parent(i)) for i in range(skeleton.num_joints)],
        "reference": skeleton.reference_local_transforms.numpy().reshape(-1, 7).round(6).tolist(),
    }))
    header, arrays = read_take(take_path)
    motion = take_to_motion(header, arrays, json.loads((out / "skeleton.json").read_text()), fps=args.fps)
    (out / "motions.json").write_text(json.dumps(motion, ensure_ascii=False, separators=(",", ":")))
    print(f"Готово: {out / 'motions.json'} — " + ", ".join(f"{c['name']} ({c['frames']} кадров)" for c in motion["clips"]))


if __name__ == "__main__":
    main()
