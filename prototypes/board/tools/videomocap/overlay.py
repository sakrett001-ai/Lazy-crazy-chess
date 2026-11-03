#!/usr/bin/env python3
"""Draw the captured stick figure over the video, for review.

    python3 overlay.py take.mp4 take.raw.json -o take.overlay.mp4 [--fps 30] [--height 760]

Each point is coloured by its confidence (green sure, red unsure); points
below 0.3 are not drawn, exactly as clean.py drops them.
"""
import argparse, json
import numpy as np

BONES = [('shoulderL', 'shoulderR'), ('hipL', 'hipR'), ('shoulderL', 'hipL'), ('shoulderR', 'hipR'),
         ('shoulderL', 'elbowL'), ('elbowL', 'wristL'), ('shoulderR', 'elbowR'), ('elbowR', 'wristR'),
         ('hipL', 'kneeL'), ('kneeL', 'ankleL'), ('ankleL', 'heelL'), ('heelL', 'toeL'), ('ankleL', 'toeL'),
         ('hipR', 'kneeR'), ('kneeR', 'ankleR'), ('ankleR', 'heelR'), ('heelR', 'toeR'), ('ankleR', 'toeR'),
         ('earL', 'eyeL'), ('eyeL', 'nose'), ('nose', 'eyeR'), ('eyeR', 'earR')]


def colour(c):
    c = float(np.clip((c - 0.3) / 0.6, 0, 1))
    return (40, int(80 + 175 * c), int(230 * (1 - c) + 25))  # BGR: red → green


def overlay(video, raw, out, fps=None, height=None, min_conf=0.3):
    import cv2
    names = raw['landmarks']
    idx = {n: i for i, n in enumerate(names)}
    frames = raw['frames']
    cap = cv2.VideoCapture(video)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or raw['source']['fps']
    fps = fps or src_fps
    writer, k, shown = None, 0, 0
    while True:
        ok, img = cap.read()
        if not ok or k >= len(frames):
            break
        if k >= shown * src_fps / fps - 1e-6:
            f = frames[k]
            if f.get('world'):
                pts = np.array(f['image'])[:, :2]
                conf = np.minimum(f['vis'], f['pres'])
                w = max(2, img.shape[0] // 300)
                for a, b in BONES:
                    i, j = idx[a], idx[b]
                    if conf[i] >= min_conf and conf[j] >= min_conf:
                        cv2.line(img, tuple(map(int, pts[i])), tuple(map(int, pts[j])), colour(min(conf[i], conf[j])), w, cv2.LINE_AA)
                for i, p in enumerate(pts):
                    if conf[i] >= min_conf:
                        cv2.circle(img, tuple(map(int, p)), w + 2, colour(conf[i]), -1, cv2.LINE_AA)
            if height:
                img = cv2.resize(img, (round(img.shape[1] * height / img.shape[0]) // 2 * 2, height), interpolation=cv2.INTER_AREA)
            if writer is None:
                writer = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*'mp4v'), fps, (img.shape[1], img.shape[0]))
            writer.write(img)
            shown += 1
        k += 1
    cap.release()
    if writer:
        writer.release()
    return shown


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('video')
    ap.add_argument('raw')
    ap.add_argument('-o', '--out', required=True)
    ap.add_argument('--fps', type=float)
    ap.add_argument('--height', type=int)
    a = ap.parse_args()
    n = overlay(a.video, json.load(open(a.raw)), a.out, a.fps, a.height)
    print(f'{n} кадров → {a.out}')


if __name__ == '__main__':
    main()
