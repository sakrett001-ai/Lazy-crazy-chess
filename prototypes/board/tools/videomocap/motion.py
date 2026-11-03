#!/usr/bin/env python3
"""Clean 3D motion (clean.py) → the project's motion file, and the whole
way from a video in one command.

    python3 motion.py take.clean.json -o take.motion.json --name lunge --role strike
    python3 motion.py --video take.mp4 -o take.motion.json [--model heavy]

The motion file ("lazy-chess.motion", src/mocap/format.mjs) holds the
anatomical key points of src/mocap/profiles.mjs per frame; the board and the
motion lab retarget them onto the pawn's skeleton (src/mocap/retarget.mjs).
"""
import argparse, json, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import clean as C  # noqa: E402

# Order of src/mocap/profiles.mjs POINTS; spine is left out (MediaPipe has no
# lower-back point, the retargeter then uses the shoulders).
POINTS = ['pelvis', 'chest', 'neck', 'head', 'eyeL', 'eyeR', 'earL', 'earR', 'nose',
          'hipL', 'kneeL', 'ankleL', 'heelL', 'toeL', 'hipR', 'kneeR', 'ankleR', 'heelR', 'toeR',
          'shoulderL', 'elbowL', 'wristL', 'shoulderR', 'elbowR', 'wristR']
ROLES = ['stand', 'shift', 'march', 'step', 'approach', 'strike', 'struck', 'other']


def key_points(P):
    """Same derived points as fromMediaPipe in profiles.mjs."""
    g = lambda n: P[:, C.I[n]]
    out = {n: g(n) for n in POINTS if n in C.I}
    out['pelvis'] = (g('hipL') + g('hipR')) / 2
    out['neck'] = (g('shoulderL') + g('shoulderR')) / 2
    out['head'] = (g('earL') + g('earR')) / 2
    out['chest'] = out['pelvis'] + (out['neck'] - out['pelvis']) * 0.7
    for s in C.SIDES:
        out['toe' + s] = toe_base(g('toe' + s), g('heel' + s))
    return out


# MediaPipe's foot point is the tip of the toes; the motion file's toe (like a
# BVH ToeBase and the pawn's toe bone) is the ball of the foot, which lies at
# 74 % of the foot's length from the heel (ANSUR II medians: ball-of-foot
# length 20.0 cm, foot length 26.9 cm). Same as fromMediaPipe in profiles.mjs.
BALL = 0.26


def toe_base(tip, heel):
    return tip + (heel - tip) * BALL


# Neutral stance: one frame of the same person standing at ease. The
# retargeter turns the trunk, head and feet by the source's rotation away from
# it (src/mocap/retarget.mjs). Without it each bone copies the source's
# absolute line, and skeletons mark their points differently: the Bandai
# Namco skeleton's flat foot drops 40° from ankle to toe, the pawn's 18°, so
# the pawn stood on its toes with the heel raised 22° while the actor's foot
# was flat; its neck–spine line leans 6° back at ease, so a hand held straight
# over the head landed 8 cm forward of it. 'auto' takes the stillest frame
# with both knees straighter than 20°.
STRAIGHT_KNEE_DEG = 20.0


def neutral_frame(P, fps, choice='auto'):
    P = np.asarray(P, float)
    if choice is None:
        return None
    if choice != 'auto':
        i = int(choice)
        if not -len(P) <= i < len(P):
            raise ValueError(f'кадра {i} нет: в клипе {len(P)} кадров')
        return i % len(P)
    speed = np.zeros(len(P))
    if len(P) > 1:
        v = np.linalg.norm(np.diff(P, axis=0), axis=-1).mean(-1) * fps
        speed = np.r_[v[0], (v[:-1] + v[1:]) / 2, v[-1]] if len(P) > 2 else np.r_[v, v]
    bent = np.maximum(np.abs(C.knee_flexion(P, 'L')), np.abs(C.knee_flexion(P, 'R')))
    ok = bent < STRAIGHT_KNEE_DEG
    return int(np.argmin(np.where(ok, speed, np.inf))) if ok.any() else int(np.argmin(bent))


def motion_file(P, fps, *, name, label=None, role='other', loop=False, source=None, report=None, neutral='auto'):
    pts = key_points(np.asarray(P, float))
    data = np.stack([pts[n] for n in POINTS], 1).round(4).reshape(-1).tolist()
    clip = {'name': name, 'label': label or name, 'role': role, 'loop': bool(loop), 'fps': fps, 'frames': len(P), 'data': data}
    ni = neutral_frame(P, fps, neutral)
    src = {'kind': 'video', 'name': (source or {}).get('video', name),
           'license': 'зависит от видео; поза — MediaPipe Pose (Apache-2.0)',
           'note': 'Одна камера: поза очищена tools/videomocap (сглаживание, длины костей, пол по линиям сцены, путь таза по изображению, опорные стопы).'}
    if report:
        src['quality'] = {k: report[k] for k in ('floorFrom', 'tiltDeg', 'missingShare', 'boneCV', 'skateBefore', 'skateAfter', 'contacts', 'focalPx') if k in report}
    out = {'format': 'lazy-chess.motion', 'version': 1, 'source': src, 'points': POINTS, 'clips': [clip]}
    if ni is not None:
        out['neutral'] = np.stack([pts[n][ni] for n in POINTS]).round(4).reshape(-1).tolist()
        src['neutralFrame'] = ni
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('clean', nargs='?')
    ap.add_argument('--video')
    ap.add_argument('-o', '--out', required=True)
    ap.add_argument('--name')
    ap.add_argument('--label')
    ap.add_argument('--role', default='other', choices=ROLES)
    ap.add_argument('--loop', action='store_true')
    ap.add_argument('--model', default='heavy', choices=['lite', 'full', 'heavy'])
    ap.add_argument('--model-path')
    ap.add_argument('--rotate', type=int, default=0)
    ap.add_argument('--fov', type=float, default=C.DEFAULTS['fov'], help='угол обзора камеры по длинной стороне кадра, градусы')
    ap.add_argument('--keep', help='папка, куда сохранить сырые и очищенные точки')
    ap.add_argument('--neutral', default='auto', help="кадр, где человек стоит вольно: номер, auto (самый спокойный кадр с прямыми ногами) или none")
    a = ap.parse_args()
    if a.video:
        import capture
        raw = capture.capture(a.video, a.model, a.model_path, a.rotate)
        P, fps, report = C.clean(raw, fov=a.fov)
        source = raw['source']
        if a.keep:
            os.makedirs(a.keep, exist_ok=True)
            base = os.path.join(a.keep, os.path.splitext(os.path.basename(a.video))[0])
            json.dump(raw, open(base + '.raw.json', 'w'), separators=(',', ':'))
            json.dump(C.write_clean(P, fps, report, source), open(base + '.clean.json', 'w'), separators=(',', ':'))
    elif a.clean:
        c = json.load(open(a.clean))
        P, fps, report, source = np.asarray(c['frames']), c['fps'], c.get('report'), c.get('source')
    else:
        ap.error('нужен очищенный файл или --video')
    name = a.name or os.path.splitext(os.path.basename(a.video or a.clean))[0].split('.')[0]
    out = motion_file(P, fps, name=name, label=a.label, role=a.role, loop=a.loop, source=source, report=report,
                      neutral=None if a.neutral == 'none' else a.neutral)
    json.dump(out, open(a.out, 'w'), ensure_ascii=False, separators=(',', ':'))
    q = out['source'].get('quality', {})
    print(f"{name}: {len(P)} кадров, {fps:g} к/с; пол — {q.get('floorFrom')}, наклон камеры {q.get('tiltDeg')}°, "
          f"скольжение стоп {q.get('skateBefore')} → {q.get('skateAfter')} см; "
          f"нейтральная стойка — кадр {out['source'].get('neutralFrame', 'нет')} → {a.out}")


if __name__ == '__main__':
    main()
