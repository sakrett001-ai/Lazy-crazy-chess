#!/usr/bin/env python3
"""Video → raw pose landmarks on the processor (MediaPipe Pose Landmarker).

Writes `vmocap.raw` JSON: for every frame the 33 world landmarks (metres,
origin between the hips, x right, y down, z away from the camera), the 33
image landmarks in pixels, and the visibility / presence of each point.
Nothing is smoothed here: cleaning is clean.py, so the raw file can be
cleaned again with other settings without running the model.

    python3 capture.py video.mp4 -o take.raw.json [--model heavy|full|lite]
    python3 capture.py duel.mp4 -o duel.raw.json --people 2   # → duel.A.raw.json, duel.B.raw.json

No graphics card is needed. The model file is downloaded once from Google's
public address into ~/.cache/vmocap (or pass --model-path).
"""
import argparse, json, os, sys, time, urllib.request
import numpy as np

MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_{0}/float16/latest/pose_landmarker_{0}.task'
NAMES = ['nose', 'eyeInnerL', 'eyeL', 'eyeOuterL', 'eyeInnerR', 'eyeR', 'eyeOuterR', 'earL', 'earR', 'mouthL', 'mouthR',
         'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR', 'pinkyL', 'pinkyR', 'indexL', 'indexR', 'thumbL', 'thumbR',
         'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR', 'heelL', 'heelR', 'toeL', 'toeR']


def model_path(name, explicit=None):
    if explicit:
        return explicit
    cache = os.path.join(os.path.expanduser('~'), '.cache', 'vmocap')
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, f'pose_landmarker_{name}.task')
    if not os.path.exists(path):
        print(f'Скачиваю модель {name}…', file=sys.stderr)
        urllib.request.urlretrieve(MODEL_URL.format(name), path + '.part')
        os.replace(path + '.part', path)
    return path


def scene_segments(video, boxes, turn=None, count=5, max_tilt=40, min_len=0.05, keep=300, span=None):
    """Long, roughly upright straight edges of the scene (walls, doors,
    furniture) from `count` frames, away from the people. Their common
    vanishing point tells where up is for a camera that is tilted (clean.py).
    `boxes` maps a frame to one box or a list of boxes (two people);
    `span` (first, last frame) keeps to one shot of an edited video.
    Returns [[x1,y1,x2,y2],...] in pixels."""
    import cv2
    cap = cv2.VideoCapture(video)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    first, last = span if span else (0, max(total - 1, 0))
    picks = sorted(set(int(round(i)) for i in np.linspace(first, last, count)))
    lsd = cv2.createLineSegmentDetector()
    segs = []
    for i in picks:
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, img = cap.read()
        if not ok:
            continue
        if turn is not None:
            img = cv2.rotate(img, turn)
        g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        found = lsd.detect(g)[0]
        if found is None:
            continue
        box = boxes.get(i)
        many = [] if box is None else (box if np.ndim(box) == 2 else [box])
        for x1, y1, x2, y2 in found.reshape(-1, 4):
            if np.hypot(x2 - x1, y2 - y1) < min_len * max(g.shape):
                continue
            if np.degrees(np.arctan2(abs(x2 - x1), abs(y2 - y1))) > max_tilt:
                continue
            if any(b[0] < (x1 + x2) / 2 < b[2] and b[1] < (y1 + y2) / 2 < b[3] for b in many):
                continue
            segs.append([round(float(v), 1) for v in (x1, y1, x2, y2)])
    cap.release()
    segs.sort(key=lambda s: -np.hypot(s[2] - s[0], s[3] - s[1]))
    return segs[:keep]


def capture(video, model='heavy', path=None, rotate=0, max_frames=None, every=1):
    import cv2
    import mediapipe as mp
    from mediapipe.tasks.python import vision
    from mediapipe.tasks.python.core.base_options import BaseOptions

    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise SystemExit(f'Видео не открывается: {video}')
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    options = vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model_path(model, path)),
        running_mode=vision.RunningMode.VIDEO, num_poses=1,
        min_pose_detection_confidence=0.5, min_pose_presence_confidence=0.5, min_tracking_confidence=0.5)
    marker = vision.PoseLandmarker.create_from_options(options)
    turn = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}.get(rotate)
    frames, i, started, size = [], 0, time.time(), None
    while True:
        ok, bgr = cap.read()
        if not ok or (max_frames and len(frames) >= max_frames):
            break
        if i % every:
            i += 1
            continue
        if turn is not None:
            bgr = cv2.rotate(bgr, turn)
        h, w = bgr.shape[:2]
        size = (w, h)
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
        t = i / fps
        result = marker.detect_for_video(image, int(round(t * 1000)))
        if result.pose_world_landmarks:
            world = [[round(p.x, 5), round(p.y, 5), round(p.z, 5)] for p in result.pose_world_landmarks[0]]
            img = result.pose_landmarks[0]
            image_pts = [[round(p.x * w, 2), round(p.y * h, 2), round(p.z * w, 2)] for p in img]
            vis = [round(p.visibility or 0.0, 3) for p in img]
            pres = [round(p.presence or 0.0, 3) for p in img]
            frames.append({'t': round(t, 5), 'world': world, 'image': image_pts, 'vis': vis, 'pres': pres})
        else:
            frames.append({'t': round(t, 5), 'world': None})
        i += 1
    cap.release()
    marker.close()
    elapsed = time.time() - started
    found = sum(1 for f in frames if f['world'])
    boxes = {}
    for k, f in enumerate(frames):
        if f['world']:
            xy = np.array(f['image'])[:, :2]
            lo, hi = xy.min(0), xy.max(0)
            pad = (hi - lo) * 0.15
            boxes[k * every] = [*(lo - pad), *(hi + pad)]
    segments = scene_segments(video, boxes, turn) if found else []
    return {
        'format': 'vmocap.raw', 'version': 1,
        'source': {'video': os.path.basename(video), 'fps': fps / every, 'width': size[0] if size else 0,
                   'height': size[1] if size else 0, 'model': f'MediaPipe Pose Landmarker {model} (Apache-2.0)',
                   'frames': len(frames), 'found': found, 'seconds': round(elapsed, 2),
                   'fpsProcessed': round(len(frames) / max(elapsed, 1e-6), 1)},
        'scene': {'segments': segments},
        'landmarks': NAMES, 'frames': frames}


def padded_box(image, pad=0.15):
    xy = np.array(image)[:, :2]
    lo, hi = xy.min(0), xy.max(0)
    p = (hi - lo) * pad
    return [*(lo - p), *(hi + p)]


def capture_two(video, model='heavy', path=None, rotate=0, max_frames=None):
    """Two people (a duel): one raw file per person, each in the usual
    vmocap.raw layout plus `pair` (partner, edit cuts, shots, how many frames
    were found again in a crop or dropped as a merged skeleton). See pair.py."""
    import cv2
    import pair
    started = time.time()
    A, B, info = pair.capture_pair(video, model_path(model, path), rotate, max_frames)
    turn = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}.get(rotate)
    # Shots between edit cuts: each has its own camera, so its own scene lines.
    bounds = [0] + info['cuts'] + [info['frames']]
    shots = []
    for s0, s1 in zip(bounds[:-1], bounds[1:]):
        if s1 - s0 < 2:
            continue
        boxes = {}
        for k in range(s0, s1):
            b = [padded_box(f['image']) for f in (A[k], B[k]) if f['world']]
            if b:
                boxes[k] = b
        segs = scene_segments(video, boxes, turn, span=(s0, s1 - 1)) if boxes else []
        shots.append({'start': s0, 'end': s1 - 1, 'segments': segs})
    longest = max(shots, key=lambda s: s['end'] - s['start']) if shots else {'segments': []}
    elapsed = round(time.time() - started, 2)
    raws = []
    for name, frames, other in (('A', A, 'B'), ('B', B, 'A')):
        found = sum(1 for f in frames if f['world'])
        raws.append({
            'format': 'vmocap.raw', 'version': 1,
            'source': {'video': os.path.basename(video), 'fps': info['fps'], 'width': info['size'][0], 'height': info['size'][1],
                       'model': f'MediaPipe Pose Landmarker {model} (Apache-2.0)', 'frames': len(frames), 'found': found,
                       'seconds': elapsed, 'fpsProcessed': round(len(frames) / max(elapsed, 1e-6), 1)},
            'scene': {'segments': longest['segments']},
            'pair': {'person': name, 'partner': other, 'cuts': info['cuts'], 'shots': shots,
                     'recovered': info['recovered'][name], 'merged': info['merged'], 'untangled': info['untangled'],
                     'both': info['both'], 'started': info['started']},
            'landmarks': NAMES, 'frames': frames})
    return raws


def pair_paths(out):
    stem = out[:-len('.raw.json')] if out.endswith('.raw.json') else os.path.splitext(out)[0]
    return f'{stem}.A.raw.json', f'{stem}.B.raw.json'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('video')
    ap.add_argument('-o', '--out', required=True)
    ap.add_argument('--model', default='heavy', choices=['lite', 'full', 'heavy'], help='heavy точнее, full и lite быстрее')
    ap.add_argument('--model-path')
    ap.add_argument('--rotate', type=int, default=0, choices=[0, 90, 180, 270], help='повернуть кадр перед распознаванием')
    ap.add_argument('--every', type=int, default=1, help='брать каждый N-й кадр')
    ap.add_argument('--max-frames', type=int)
    ap.add_argument('--people', type=int, default=1, choices=[1, 2], help='2 — поединок: два файла, A (слева при первом появлении обоих) и B')
    a = ap.parse_args()
    if a.people == 2:
        for path, raw in zip(pair_paths(a.out), capture_two(a.video, a.model, a.model_path, a.rotate, a.max_frames)):
            with open(path, 'w') as f:
                json.dump(raw, f, separators=(',', ':'))
            s, p = raw['source'], raw['pair']
            print(f"{s['video']} {p['person']}: {s['found']}/{s['frames']} кадров, найден в обрезке {p['recovered']}; "
                  f"оба в кадре {p['both']}, склеек {len(p['cuts'])}, слитых скелетов отброшено {p['merged']} → {path}")
        return
    raw = capture(a.video, a.model, a.model_path, a.rotate, a.max_frames, a.every)
    with open(a.out, 'w') as f:
        json.dump(raw, f, separators=(',', ':'))
    s = raw['source']
    print(f"{s['video']}: {s['found']}/{s['frames']} кадров с человеком, {s['fpsProcessed']} к/с на процессоре → {a.out}")


if __name__ == '__main__':
    main()
