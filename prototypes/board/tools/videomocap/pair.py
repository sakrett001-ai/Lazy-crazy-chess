#!/usr/bin/env python3
"""Two people in one video (a duel, a sparring bout): who is who in every frame.

MediaPipe can look for two poses at once, but on its own it fails a duel in
three ways, each fixed here by knowledge of the scene and of the body:

1. identity: the two skeletons come back in any order, and after an edit cut
   the camera may stand elsewhere, so "the one on the left" swaps sides.
   Each fighter keeps an appearance (colour of torso and thighs, HSV
   histogram) and a body (lengths of 12 bones in metres, which MediaPipe's
   world landmarks keep from frame to frame); a detection goes to the
   fighter it fits best by position, appearance and body. After a cut only
   appearance and body count.
2. merging: when the fighters close in, the model may draw one skeleton
   across both bodies (an arm of one, a leg of the other). Such a skeleton
   has bones of the wrong length and a box much wider than either fighter;
   it is rejected rather than given to anybody.
3. losing one: in contact the model often finds only one fighter. The other
   is looked for again in a crop around where it should be (its last box
   moved by its speed); a candidate that is really the other fighter is
   refused by position and appearance.

Frames where a fighter still has no plausible skeleton stay empty: clean.py
fills short gaps and reports long ones. Nothing is invented here.

    python3 capture.py duel.mp4 -o duel.raw.json --people 2
    → duel.A.raw.json, duel.B.raw.json (A is the fighter on the left when both
      are first seen)

The tracking itself (assign, plausible, Track) is plain numpy and is tested
on synthetic detections in test_pair.py; MediaPipe and OpenCV are only
needed to run it on a video.
"""
import numpy as np

# Bones whose length MediaPipe's world landmarks keep for one person:
# shoulders, hips, trunk sides, upper arms, forearms, thighs, shins.
BONES = [(11, 12), (23, 24), (11, 23), (12, 24), (11, 13), (13, 15), (12, 14), (14, 16),
         (23, 25), (25, 27), (24, 26), (26, 28)]
TRUNK = [11, 12, 23, 24]
MISS = 6.0

DEFAULTS = dict(
    max_bone_ratio=1.3,    # a body whose bones are this much longer or shorter (median) is someone else
    max_jump=0.9,          # centre farther than this many body heights from where it should be is not him
    appearance_weight=2.5, # cost of the appearance distance (0 same colours, 1 nothing alike)
    cut_colour=0.35,       # change of the whole image's colours above which a frame is an edit cut
    cut_change=10.0,       # mean grey change (0–255) of a small copy of the frame above which it is a cut,
    cut_ratio=10.0,        # also when it is this many times the clip's usual change (running median)
    lost_after=12,         # frames without a detection after which the position no longer counts
    min_conf=0.3,
)


def world_lengths(world):
    W = np.asarray(world, float)
    return np.array([np.linalg.norm(W[a] - W[b]) for a, b in BONES])


def centre(image):
    U = np.asarray(image, float)
    return U[TRUNK, :2].mean(0)


def box(image, vis=None, min_conf=0.3):
    U = np.asarray(image, float)[:, :2]
    if vis is not None:
        ok = np.asarray(vis, float) >= min_conf
        if ok.sum() >= 6:
            U = U[ok]
    lo, hi = U.min(0), U.max(0)
    return np.array([lo[0], lo[1], hi[0], hi[1]])


def height(image):
    """Body height in pixels from the trunk and the legs: steadier than the
    box, which a raised arm or a lunge stretches."""
    U = np.asarray(image, float)[:, :2]
    trunk = np.linalg.norm(U[[11, 12]].mean(0) - U[[23, 24]].mean(0))
    legs = np.mean([np.linalg.norm(U[23] - U[25]) + np.linalg.norm(U[25] - U[27]),
                    np.linalg.norm(U[24] - U[26]) + np.linalg.norm(U[26] - U[28])])
    return max(trunk + legs, 1.0)


def hist_distance(a, b):
    """Bhattacharyya distance of two normalised histograms: 0 alike, 1 disjoint."""
    if a is None or b is None:
        return 0.5
    return float(np.sqrt(max(0.0, 1.0 - np.sum(np.sqrt(a * b)))))


class Track:
    """One fighter: where he was, how fast he moved, his body and his colours."""

    def __init__(self, name):
        self.name = name
        self.c = None          # centre of the trunk, pixels
        self.v = np.zeros(2)   # pixels per frame
        self.h = None          # body height, pixels
        self.w = None          # box width, pixels
        self.lengths = []      # world bone lengths of accepted frames
        self.app = None        # appearance histogram (moving average)
        self.seen = None       # frame index of the last accepted detection
        self.pts = None        # image points of the last accepted detection

    def ref_lengths(self):
        return np.median(np.array(self.lengths[-60:]), 0) if self.lengths else None

    def predict(self, t):
        if self.c is None:
            return None
        # Works both ways in time: the walk back before the start uses it too.
        return self.c + self.v * min(abs(t - self.seen), 6)

    def accept(self, det, t):
        c = det['c']
        if self.c is not None and abs(t - self.seen) <= 3:
            self.v = 0.6 * self.v + 0.4 * (c - self.c) / max(abs(t - self.seen), 1)
        else:
            self.v = np.zeros(2)
        self.c, self.seen = c, t
        U = np.asarray(det['image'], float)[:, :2]
        if self.pts is None:
            self.pts = U.copy()
        else:  # a joint the model was not sure of keeps its last good place
            ok = np.asarray(det['vis'], float) >= DEFAULTS['min_conf']
            self.pts[ok] = U[ok]
        self.h = det['h'] if self.h is None else 0.8 * self.h + 0.2 * det['h']
        bw = det['box'][2] - det['box'][0]
        self.w = bw if self.w is None else 0.8 * self.w + 0.2 * bw
        self.lengths.append(det['len'])
        if det.get('app') is not None and not det.get('crowded'):
            self.app = det['app'] if self.app is None else 0.9 * self.app + 0.1 * det['app']


# Image bones measured against the trunk (mid-shoulders to mid-hips) of the
# same skeleton. One body seen from any side keeps them under these limits;
# a skeleton drawn across two bodies breaks one of them (a hip or an arm
# reaching over to the other fighter).
LIMBS_IMG = [(11, 13), (13, 15), (12, 14), (14, 16), (23, 25), (25, 27), (24, 26), (26, 28)]
MAX_LIMB_TRUNK = 1.6
MAX_WIDTH_TRUNK = 1.25


def anatomical(image):
    """Can this image skeleton be one human body?"""
    U = np.asarray(image, float)[:, :2]
    trunk = np.linalg.norm(U[[11, 12]].mean(0) - U[[23, 24]].mean(0))
    if trunk < 1:
        return False
    if np.linalg.norm(U[11] - U[12]) > MAX_WIDTH_TRUNK * trunk or np.linalg.norm(U[23] - U[24]) > MAX_WIDTH_TRUNK * trunk:
        return False
    return all(np.linalg.norm(U[a] - U[b]) <= MAX_LIMB_TRUNK * trunk for a, b in LIMBS_IMG)


def plausible(det, track, o=DEFAULTS):
    """Is this skeleton one body of this fighter's size? Refuses merged
    skeletons (bones of two people) and bodies of another build. Single
    world bones swing by a third from frame to frame (a forearm turned to
    the camera), so the body is judged by the median over the bones."""
    if not anatomical(det['image']):
        return False
    ref = track.ref_lengths()
    if ref is not None and len(track.lengths) >= 5:
        r = float(np.median(det['len'] / np.maximum(ref, 1e-6)))
        if r > o['max_bone_ratio'] or r < 1 / o['max_bone_ratio']:
            return False
    return True


def cost(det, track, t, cut, o=DEFAULTS):
    """How badly a detection fits a fighter; inf when it cannot be him."""
    if not plausible(det, track, o):
        return np.inf
    total = o['appearance_weight'] * hist_distance(det.get('app'), track.app)
    ref = track.ref_lengths()
    if ref is not None:
        total += float(np.mean(np.abs(np.log(det['len'] / np.maximum(ref, 1e-6))))) * 3
    if not cut and track.c is not None and abs(t - track.seen) <= o['lost_after']:
        jump = np.linalg.norm(det['c'] - track.predict(t)) / max(track.h or det['h'], 1.0)
        if jump > o['max_jump'] * (1 + 0.15 * (abs(t - track.seen) - 1)):
            return np.inf
        total += jump * 2
    return total


def assign(dets, tracks, t, cut=False, o=DEFAULTS):
    """Best assignment of detections to the two fighters: a list of indices
    into dets (or None) per track. Two tracks, a handful of detections:
    every pairing is tried."""
    best, choice = np.inf, [None, None]
    n = len(dets)
    options = [None] + list(range(n))
    for i in options:
        for j in options:
            if i is not None and i == j:
                continue
            ci = cost(dets[i], tracks[0], t, cut, o) if i is not None else MISS
            cj = cost(dets[j], tracks[1], t, cut, o) if j is not None else MISS
            # An empty slot costs more than any fit that passed the gates:
            # a plausible skeleton near where the fighter should be is his.
            s = ci + cj
            if s < best:
                best, choice = s, [i, j]
    return choice


def appearance(bgr, image, bins=(18, 8)):
    """HSV histogram of the trunk and the thighs: what the fighter wears.
    Value (brightness) is left out so light changes matter less."""
    import cv2
    U = np.asarray(image, float)[:, :2].astype(np.int32)
    h, w = bgr.shape[:2]
    mask = np.zeros((h, w), np.uint8)
    polys = [U[[11, 12, 24, 23]], U[[23, 24, 26, 25]]]
    for p in polys:
        p = np.clip(p, [0, 0], [w - 1, h - 1])
        cv2.fillConvexPoly(mask, p, 255)
    if mask.sum() < 255 * 200:
        return None
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], mask, list(bins), [0, 180, 0, 256]).ravel()
    s = hist.sum()
    return hist / s if s > 0 else None


def frame_signature(bgr):
    """Colours of the whole frame and a small grey copy of it, for cut detection."""
    import cv2
    small = cv2.resize(bgr, (48, 64), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1, 2], None, [8, 4, 4], [0, 180, 0, 256, 0, 256]).ravel()
    return hist / max(hist.sum(), 1e-9), cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(float)


class CutDetector:
    """An edit cut: the picture changes at once far more than the people in
    it can move it. Moving people change a small copy of the frame by about
    one grey level per frame; a cut changes it by tens. A slow cross-fade
    is caught by the colours."""

    def __init__(self, o=DEFAULTS):
        self.o, self.prev, self.history = o, None, []

    def __call__(self, signature):
        hist, grey = signature
        if self.prev is None:
            self.prev = signature
            return False
        colour = hist_distance(hist, self.prev[0])
        change = float(np.abs(grey - self.prev[1]).mean())
        usual = float(np.median(self.history[-30:])) if len(self.history) >= 5 else 1.0
        cut = colour > self.o['cut_colour'] or change > max(self.o['cut_change'], self.o['cut_ratio'] * usual)
        if not cut:
            self.history.append(change)
        self.prev = signature
        return cut


# Joints that a merged skeleton borrows from the other body: legs and arms.
SHAREABLE = [11, 12, 23, 24, 13, 14, 15, 16, 25, 26, 27, 28, 29, 30, 31, 32]
LIMB_SEGMENTS = [(11, 13), (13, 15), (12, 14), (14, 16), (23, 25), (25, 27), (24, 26), (26, 28), (27, 31), (28, 32)]
SHARED_RADIUS = 0.06   # body heights: a joint this close to the other body's limb lies on it
BORROW_JUMP = 0.12     # body heights: and jumped this far since its owner last had it
# Farthest a joint can travel between two frames, in body heights per frame
# at 30 frames a second: a hand in a cut up to about 15 m/s (0.28 of a 1.75 m
# body per frame), a foot in a lunge or a kick about 8 m/s (0.15). While the
# two bodies overlap, a joint that jumps farther was taken from the other one.
MAX_STEP = {11: 0.12, 12: 0.12, 23: 0.12, 24: 0.12, 13: 0.22, 14: 0.22, 15: 0.3, 16: 0.3, 25: 0.15, 26: 0.15, 27: 0.18, 28: 0.18,
            29: 0.18, 30: 0.18, 31: 0.2, 32: 0.2}


def _to_segment(p, a, b):
    ab = b - a
    k = np.clip(np.dot(p - a, ab) / max(np.dot(ab, ab), 1e-9), 0, 1)
    return float(np.linalg.norm(p - (a + k * ab)))


def untangle(da, db, ta, tb, i, min_conf=0.3, fps=30.0):
    """In contact one skeleton may take a leg or an arm of the other body.
    A joint that lies on a limb of the other skeleton and jumped there from
    where its owner last had it is the borrowed one; it is marked unsure
    (visibility 0) so clean.py fills it from its neighbours in time instead
    of keeping the other body's limb. A skeleton that had to give up a
    trunk joint is spread over both bodies: it is dropped whole (its
    centre would mislead the tracking). Returns (joints given up, which of
    the two to drop)."""
    lost, drop = 0, [False, False]
    for side, (d, own, od) in enumerate(((da, ta, db), (db, tb, da))):
        if own.pts is None:
            continue
        U, V = np.asarray(d['image'], float)[:, :2], np.asarray(od['image'], float)[:, :2]
        ov = np.asarray(od['vis'], float)
        r = SHARED_RADIUS * np.mean([da['h'], db['h']])
        crowded = overlap(da['box'], db['box']) > 0.15
        frames = max(abs(i - own.seen), 1) * 30.0 / fps
        for j in SHAREABLE:
            if d['vis'][j] < min_conf:
                continue
            jump = np.linalg.norm(U[j] - own.pts[j]) / max(own.h, 1)
            if jump < BORROW_JUMP:
                continue
            if crowded and jump > MAX_STEP[j] * frames:
                d['vis'][j] = 0.0; lost += 1
                drop[side] = drop[side] or j in TRUNK
                continue
            if any(ov[x] >= min_conf and ov[y] >= min_conf and _to_segment(U[j], V[x], V[y]) < r for x, y in LIMB_SEGMENTS):
                d['vis'][j] = 0.0; lost += 1
                drop[side] = drop[side] or j in TRUNK
    return lost, drop


def distinct(da, db):
    """Two detections of two people, not the model finding one person twice."""
    apart = np.linalg.norm(da['c'] - db['c']) / max(min(da['h'], db['h']), 1.0)
    return apart > 0.35 and overlap(da['box'], db['box']) < 0.5


def overlap(a, b):
    x0, y0, x1, y1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    area = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return inter / max(area, 1e-9)


def detection(world, image, vis, pres, t, bgr=None, min_conf=0.3):
    d = {'world': world, 'image': image, 'vis': vis, 'pres': pres, 't': t,
         'len': world_lengths(world), 'c': centre(image), 'box': box(image, vis, min_conf), 'h': height(image)}
    if bgr is not None:
        d['app'] = appearance(bgr, image)
    return d


def capture_pair(video, model_file, rotate=0, max_frames=None, o=None, log=None):
    """Runs the model over the video and follows both fighters. Returns
    (frames_A, frames_B, info) with frames in the vmocap.raw layout."""
    import cv2
    import mediapipe as mp
    from mediapipe.tasks.python import vision
    from mediapipe.tasks.python.core.base_options import BaseOptions

    o = {**DEFAULTS, **(o or {})}
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise SystemExit(f'Видео не открывается: {video}')
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    def make(mode):
        return vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=model_file), running_mode=mode, num_poses=2,
            min_pose_detection_confidence=0.4, min_pose_presence_confidence=0.4, min_tracking_confidence=0.5))
    video_marker, crop_marker = make(vision.RunningMode.VIDEO), make(vision.RunningMode.IMAGE)
    turn = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}.get(rotate)

    def run(marker, bgr, ts=None, offset=(0, 0), scale=(1.0, 1.0)):
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        r = marker.detect_for_video(image, ts) if ts is not None else marker.detect(image)
        h, w = bgr.shape[:2]
        out = []
        for k in range(len(r.pose_landmarks)):
            im = r.pose_landmarks[k]
            pts = [[round(offset[0] + p.x * w * scale[0], 2), round(offset[1] + p.y * h * scale[1], 2), round(p.z * w * scale[0], 2)] for p in im]
            world = [[round(p.x, 5), round(p.y, 5), round(p.z, 5)] for p in r.pose_world_landmarks[k]]
            out.append((world, pts, [round(p.visibility or 0.0, 3) for p in im], [round(p.presence or 0.0, 3) for p in im]))
        return out

    def separate(picked, tr, i):
        """Joints one skeleton borrowed from the other are hidden; a skeleton
        whose trunk sits on the other body is dropped (merged at contact)."""
        if picked[0] is None or picked[1] is None:
            return picked, [False, False]
        for d in picked:
            d['vis'] = list(d['vis'])
        lost, drop = untangle(picked[0], picked[1], tr[0], tr[1], i, o['min_conf'], fps)
        info['untangled'] += lost
        info['merged'] += sum(drop)
        return [None if drop[k] else picked[k] for k in (0, 1)], drop

    def settle(picked, tr, i, bgr, cut):
        """The pair for one frame: untangled, a lost fighter looked for again in
        a crop, and the found one checked against the other once more."""
        picked, drop = separate(picked, tr, i)
        found = [False, False]
        for k in (0, 1):
            if picked[k] is None and not drop[k] and bgr is not None:
                d = recover(bgr, tr[k], tr[1 - k], picked[1 - k], i, i / fps, run, crop_marker, cut, o)
                if d is not None:
                    picked[k], found[k] = d, True
        if any(found):
            picked, _ = separate(picked, tr, i)
        for k in (0, 1):
            if found[k] and picked[k] is not None:
                info['recovered'][tr[k].name] += 1
        return picked

    tracks = [Track('A'), Track('B')]
    frames = [[], []]
    info = {'cuts': [], 'recovered': {'A': 0, 'B': 0}, 'rejected': 0, 'untangled': 0, 'merged': 0, 'found': {'A': 0, 'B': 0}, 'both': 0, 'started': None}
    pending = []  # frames before both fighters were first seen
    cuts, i, size = CutDetector(o), 0, None
    while True:
        ok, bgr = cap.read()
        if not ok or (max_frames and i >= max_frames):
            break
        if turn is not None:
            bgr = cv2.rotate(bgr, turn)
        H, Wd = bgr.shape[:2]
        size = (Wd, H)
        t = round(i / fps, 5)
        cut = cuts(frame_signature(bgr))
        if cut:
            info['cuts'].append(i)
        dets = [detection(*d, t, bgr, o['min_conf']) for d in run(video_marker, bgr, int(round(i / fps * 1000)))]
        if len(dets) == 2 and overlap(dets[0]['box'], dets[1]['box']) > 0.25:
            for d in dets:
                d['crowded'] = True  # colours of two overlapping bodies mix: do not learn them
        if tracks[0].c is None:
            if len(dets) == 2 and distinct(dets[0], dets[1]) and all(plausible(d, tr, o) for d, tr in zip(dets, tracks)):
                dets.sort(key=lambda d: d['c'][0])
                for k in (0, 1):
                    tracks[k].accept(dets[k], i)
                    frames[k].append(dets[k])
                info['started'] = i
            else:
                pending.append((i, t, dets))
                for k in (0, 1):
                    frames[k].append(None)
            i += 1
            continue
        choice = assign(dets, tracks, i, cut, o)
        info['rejected'] += sum(1 for k, d in enumerate(dets) if k not in choice)
        picked = [dets[choice[k]] if choice[k] is not None else None for k in (0, 1)]
        picked = settle(picked, tracks, i, bgr, cut)
        for k in (0, 1):
            if picked[k] is not None:
                tracks[k].accept(picked[k], i)
            frames[k].append(picked[k])
        i += 1
    # Frames before the start: walk back from the first frame with both,
    # by position and appearance, as if the video ran backwards. A fighter
    # the model did not see is looked for again in a crop, as on the way forward.
    if info['started'] is not None and pending:
        back = [Track('A'), Track('B')]
        for k in (0, 1):
            d0 = frames[k][info['started']]
            back[k].app, back[k].lengths = tracks[k].app, list(tracks[k].lengths)
            back[k].accept(d0, info['started'])
            back[k].v = np.zeros(2)
        later_cut = [c for c in info['cuts'] if c <= info['started']]
        for idx, t, dets in reversed(pending):
            if later_cut and idx < later_cut[-1]:
                break  # another shot: nothing ties these people to A and B
            choice = assign(dets, back, idx, False, o)
            picked = [dets[choice[k]] if choice[k] is not None else None for k in (0, 1)]
            bgr = None
            if picked[0] is None or picked[1] is None:
                cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
                ok, bgr = cap.read()
                if ok and turn is not None:
                    bgr = cv2.rotate(bgr, turn)
            picked = settle(picked, back, idx, bgr if bgr is not None else None, False)
            for k in (0, 1):
                if picked[k] is not None:
                    back[k].accept(picked[k], idx)
                    frames[k][idx] = picked[k]
    cap.release()
    video_marker.close(); crop_marker.close()
    out = []
    for k in (0, 1):
        fr = []
        for idx, d in enumerate(frames[k]):
            t = round(idx / fps, 5)
            if d is None:
                fr.append({'t': t, 'world': None})
            else:
                fr.append({'t': t, 'world': d['world'], 'image': d['image'], 'vis': d['vis'], 'pres': d['pres'],
                           **({'recovered': True} if d.get('recovered') else {})})
                info['found'][tracks[k].name] += 1
        out.append(fr)
    info['both'] = sum(1 for a, b in zip(*out) if a['world'] and b['world'])
    info['fps'], info['size'], info['frames'] = fps, size, len(out[0])
    return out[0], out[1], info


def recover(bgr, track, other, other_det, i, t, run, marker, cut, o):
    """Looks for a lost fighter again in a crop around where he should be."""
    if track.c is None or cut or abs(i - track.seen) > o['lost_after']:
        return None
    H, W = bgr.shape[:2]
    c, h = track.predict(i), track.h
    half_w, half_h = max(track.w or 0, 0.6 * h) * 0.9, h * 0.95
    x0, y0 = int(max(0, c[0] - half_w)), int(max(0, c[1] - half_h * 1.1))
    x1, y1 = int(min(W, c[0] + half_w)), int(min(H, c[1] + half_h * 0.9))
    if x1 - x0 < 40 or y1 - y0 < 80:
        return None
    crop = bgr[y0:y1, x0:x1]
    best, best_cost = None, np.inf
    for world, pts, vis, pres in run(marker, crop, offset=(x0, y0)):
        d = detection(world, pts, vis, pres, t, bgr, o['min_conf'])
        if other_det is not None and np.linalg.norm(d['c'] - other_det['c']) < 0.3 * max(other.h or h, 1):
            continue  # the other fighter, seen again in the crop
        k = cost(d, track, i, False, o)
        if other.app is not None and track.app is not None and d.get('app') is not None:
            if hist_distance(d['app'], other.app) + 0.05 < hist_distance(d['app'], track.app):
                continue  # dressed like the other one
        if k < best_cost:
            best, best_cost = d, k
    if best is not None:
        best['recovered'] = True
    return best
