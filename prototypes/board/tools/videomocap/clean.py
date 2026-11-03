#!/usr/bin/env python3
"""Raw single-camera pose (capture.py) → clean 3D motion of the body.

Accuracy comes from knowledge of the body, not from a bigger model. Each
step is a separate function with its own switch, so the evaluation can
measure what every step adds (evaluate.py):

1. confidence: points the model itself doubts are dropped;
2. outliers: one-frame jumps far from the local median are dropped;
3. gaps: dropped points are filled by interpolation (gaps longer than
   `max_gap` are reported);
4. smoothing: One Euro filter run forwards and backwards (no lag): calm
   points are smoothed hard, fast ones (a strike) keep their speed;
5. knees: a knee bent backwards is a depth mistake of one camera; the knee
   is mirrored in depth, which keeps its image position and bone lengths;
6. bone lengths: one length per bone for the whole clip, left equals right;
7. camera: where the body stands in the camera's space, from the image
   points and a focal length (default: a phone's 65° field of view);
8. image: each joint moves onto its ray through the image point, keeping
   its depth, as far as the model trusts the point;
9. feet: one camera flattens the foot in depth (7–11 cm from heel to toe
   instead of 21), which also tips it toes down; the foot gets its length
   from the shin, and a planted foot lies flat (step 12);
10. floor: up is the vanishing point of upright edges of the room (doors,
   walls, furniture) found in the video away from the person; without
   them up comes from the planted feet and the trunk;
11. root: the floor goes under the lowest sole; without image points the
   travel is taken from the planted feet (a planted foot does not slide);
12. contacts: planted feet are locked in place and laid flat, the leg
   follows by two-bone inverse kinematics.

Coordinates of the result: metres, y up, floor at y = 0, x and z as
MediaPipe gives them (x to the image right, z towards the camera).

    python3 clean.py take.raw.json -o take.clean.json
"""
import argparse, json, sys
import numpy as np

NAMES = ['nose', 'eyeInnerL', 'eyeL', 'eyeOuterL', 'eyeInnerR', 'eyeR', 'eyeOuterR', 'earL', 'earR', 'mouthL', 'mouthR',
         'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR', 'pinkyL', 'pinkyR', 'indexL', 'indexR', 'thumbL', 'thumbR',
         'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR', 'heelL', 'heelR', 'toeL', 'toeR']
I = {n: i for i, n in enumerate(NAMES)}
SIDES = ('L', 'R')
# Bones as (parent, child); the chain is walked from the pelvis outwards.
# 'pelvis' and 'neck' are the midpoints of the hips and the shoulders.
LIMBS = [(f'hip{s}', f'knee{s}') for s in SIDES] + [(f'knee{s}', f'ankle{s}') for s in SIDES] + \
        [(f'ankle{s}', f'heel{s}') for s in SIDES] + [(f'ankle{s}', f'toe{s}') for s in SIDES] + \
        [(f'shoulder{s}', f'elbow{s}') for s in SIDES] + [(f'elbow{s}', f'wrist{s}') for s in SIDES] + \
        [(f'wrist{s}', f'{d}{s}') for s in SIDES for d in ('pinky', 'index', 'thumb')]
HEAD = ['nose', 'eyeInnerL', 'eyeL', 'eyeOuterL', 'eyeInnerR', 'eyeR', 'eyeOuterR', 'earL', 'earR', 'mouthL', 'mouthR']

DEFAULTS = dict(
    min_conf=0.3,          # visibility below which a point is treated as missing
    outlier_m=0.08,        # a jump from the local median beyond this (and 4 MAD) is an outlier, metres
    max_gap=0.5,           # gaps longer than this many seconds are reported
    min_cutoff=1.2,        # One Euro: cut-off of a still point, Hz
    beta=0.8,              # One Euro: added cut-off per m/s of speed
    d_cutoff=1.0,          # One Euro: cut-off of the speed estimate, Hz
    contact_height=0.035,  # sole closer than this to the floor may be planted, metres
    contact_speed=0.35,    # and moving slower than this, m/s
    contact_min=0.08,      # shortest contact, seconds
    fov=65.0,              # field of view on the longer side of the frame, degrees (a phone's main camera)
    focal=0.0,             # focal length in pixels; 0 = from fov
    image_weight=1.0,      # how far joints move onto their image rays, times confidence
)


# ---------- loading ----------

def load_raw(raw):
    """Arrays from a vmocap.raw file: P [T,33,3] in y-up metres (x right,
    y up, z towards the camera), C [T,33] confidence, fps. Missing frames
    are NaN."""
    frames = raw['frames']
    T = len(frames)
    P = np.full((T, 33, 3), np.nan)
    C = np.zeros((T, 33))
    for t, f in enumerate(frames):
        if f.get('world'):
            w = np.asarray(f['world'], float)
            P[t] = w * np.array([1, -1, -1])
            vis = np.asarray(f.get('vis') or [1] * 33, float)
            pres = np.asarray(f.get('pres') or [1] * 33, float)
            C[t] = np.minimum(vis, np.maximum(pres, vis))  # presence never raises a doubtful visibility
    return P, C, float(raw['source']['fps'])


def load_image(raw):
    """Image landmarks [T,33,2] in pixels (NaN where missing) and the frame size."""
    frames = raw['frames']
    U = np.full((len(frames), 33, 2), np.nan)
    for t, f in enumerate(frames):
        if f.get('world') and f.get('image'):
            U[t] = np.asarray(f['image'], float)[:, :2]
    s = raw['source']
    return U, (float(s.get('width') or 0), float(s.get('height') or 0))


# ---------- 1–3: confidence, outliers, gaps ----------

def mask_low_confidence(P, C, min_conf):
    P = P.copy()
    P[C < min_conf] = np.nan
    return P


def _median_filter(x, k):
    T, h = len(x), k // 2
    out = np.empty_like(x)
    for t in range(T):
        out[t] = np.nanmedian(x[max(0, t - h):t + h + 1], axis=0)
    return out


def mask_outliers(P, outlier_m, k=7):
    """Drops points that jump away from their local median (k frames)."""
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', RuntimeWarning)
        med = _median_filter(P, k)
        d = np.linalg.norm(P - med, axis=2)
        mad = np.nanmedian(d, axis=0)
    bad = d > np.maximum(outlier_m, 4 * mad[None, :] * 1.4826)
    P = P.copy()
    P[bad] = np.nan
    return P, int(np.nansum(bad))


def fill_gaps(P, fps, max_gap):
    """Linear interpolation over missing frames, held at the clip ends.
    Returns the filled array and the longest gap per point, seconds."""
    P = P.copy()
    T = len(P)
    longest = np.zeros(P.shape[1])
    idx = np.arange(T)
    for j in range(P.shape[1]):
        ok = ~np.isnan(P[:, j, 0])
        if ok.sum() == 0:
            continue
        if ok.sum() < T:
            run, best = 0, 0
            for v in ok:
                run = 0 if v else run + 1
                best = max(best, run)
            longest[j] = best / fps
            for d in range(3):
                P[:, j, d] = np.interp(idx, idx[ok], P[ok, j, d])
    return P, longest


# ---------- 4: smoothing ----------

def _alpha(cutoff, fps):
    tau = 1.0 / (2 * np.pi * cutoff)
    return 1.0 / (1.0 + tau * fps)


def one_euro(x, fps, min_cutoff, beta, d_cutoff):
    """One Euro filter (Casiez, Roussel, Vogel 2012) over [T,N,3]; the
    speed of each point (norm of its 3D velocity) sets its cut-off."""
    y = np.empty_like(x)
    y[0] = x[0]
    dx = np.zeros(x.shape[1:])
    a_d = _alpha(d_cutoff, fps)
    for t in range(1, len(x)):
        raw_d = (x[t] - y[t - 1]) * fps
        dx = a_d * raw_d + (1 - a_d) * dx
        cutoff = min_cutoff + beta * np.linalg.norm(dx, axis=-1)
        a = _alpha(cutoff, fps)[..., None]
        y[t] = a * x[t] + (1 - a) * y[t - 1]
    return y


def smooth(P, fps, min_cutoff, beta, d_cutoff):
    """Zero-lag One Euro: mean of the forward and the backward pass."""
    if min_cutoff <= 0:
        return P
    f = one_euro(P, fps, min_cutoff, beta, d_cutoff)
    b = one_euro(P[::-1], fps, min_cutoff, beta, d_cutoff)[::-1]
    return (f + b) / 2


# ---------- helpers ----------

def unit(v):
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, 1e-9)


def pelvis(P):
    return (P[:, I['hipL']] + P[:, I['hipR']]) / 2


def neck(P):
    return (P[:, I['shoulderL']] + P[:, I['shoulderR']]) / 2


def knee_flexion(P, s):
    """Signed knee flexion, degrees: positive when the knee bends forward
    (towards the toes), negative when bent backwards."""
    h, k, a = P[:, I[f'hip{s}']], P[:, I[f'knee{s}']], P[:, I[f'ankle{s}']]
    heel, toe = P[:, I[f'heel{s}']], P[:, I[f'toe{s}']]
    thigh, shin = unit(k - h), unit(a - k)
    angle = np.degrees(np.arccos(np.clip((thigh * shin).sum(-1), -1, 1)))
    leg = unit(a - h)
    fwd = toe - heel
    fwd = unit(fwd - (fwd * leg).sum(-1, keepdims=True) * leg)
    off = k - (h + a) / 2
    sign = np.sign((off * fwd).sum(-1))
    sign[sign == 0] = 1
    return angle * sign


# ---------- 5: knees ----------

def fix_knees(P, view=(0, 0, 1)):
    """A knee bent backwards is mirrored in depth: reflected across the
    plane through hip and ankle that contains the viewing direction. Its
    image position (orthographic view) and both bone lengths stay the same.
    If the leg lies in that plane, the knee is mirrored across the hip–ankle
    line instead."""
    P = P.copy()
    v = np.asarray(view, float)
    fixed = 0
    for s in SIDES:
        flex = knee_flexion(P, s)
        for t in np.where(flex < -5)[0]:
            h, k, a = P[t, I[f'hip{s}']], P[t, I[f'knee{s}']], P[t, I[f'ankle{s}']]
            n = np.cross(a - h, v)
            if np.linalg.norm(n) > 1e-6:
                n /= np.linalg.norm(n)
                k2 = k - 2 * np.dot(k - h, n) * n
            else:
                d = unit(a - h)
                p = h + np.dot(k - h, d) * d
                k2 = 2 * p - k
            old = P[t, I[f'knee{s}']].copy()
            P[t, I[f'knee{s}']] = k2
            if knee_flexion(P[t:t + 1], s)[0] < -5:  # depth mirror did not help: mirror across the leg line
                d = unit(a - h)
                p = h + np.dot(old - h, d) * d
                P[t, I[f'knee{s}']] = 2 * p - old
            fixed += 1
    return P, fixed


# ---------- 6: bone lengths ----------

def bone_lengths(P, C=None):
    """One length per bone: confidence-weighted median, left = right."""
    w = np.ones(P.shape[:2]) if C is None else C
    out = {}

    def wmedian(vals, weights):
        o = np.argsort(vals)
        cw = np.cumsum(weights[o])
        return float(vals[o][np.searchsorted(cw, cw[-1] / 2)])

    def length(a, b):
        return np.linalg.norm(P[:, I[a]] - P[:, I[b]], axis=-1), np.minimum(w[:, I[a]], w[:, I[b]]) + 1e-3

    for a, b in LIMBS:
        if a.endswith('L') and b.endswith('L'):
            la, wa = length(a, b)
            lb, wb = length(a[:-1] + 'R', b[:-1] + 'R')
            v = wmedian(np.concatenate([la, lb]), np.concatenate([wa, wb]))
            out[(a, b)] = out[(a[:-1] + 'R', b[:-1] + 'R')] = v
    hip_w, hw = length('hipL', 'hipR')
    sh_w, sw = length('shoulderL', 'shoulderR')
    out['hips'] = wmedian(hip_w, hw)
    out['shoulders'] = wmedian(sh_w, sw)
    torso = np.linalg.norm(neck(P) - pelvis(P), axis=-1)
    out['torso'] = wmedian(torso, np.minimum(hw, sw))
    return out


def enforce_lengths(P, L):
    """Walks the body from the pelvis outwards keeping every direction and
    setting every length. The head moves rigidly with the neck."""
    Q = P.copy()
    pv, nk = pelvis(P), neck(P)
    hips = unit(P[:, I['hipL']] - P[:, I['hipR']])
    Q[:, I['hipL']] = pv + hips * L['hips'] / 2
    Q[:, I['hipR']] = pv - hips * L['hips'] / 2
    nk2 = pv + unit(nk - pv) * L['torso']
    sh = unit(P[:, I['shoulderL']] - P[:, I['shoulderR']])
    Q[:, I['shoulderL']] = nk2 + sh * L['shoulders'] / 2
    Q[:, I['shoulderR']] = nk2 - sh * L['shoulders'] / 2
    for n in HEAD:
        Q[:, I[n]] = P[:, I[n]] + (nk2 - nk)
    for a, b in LIMBS:  # parents always come before children in LIMBS
        d = unit(P[:, I[b]] - P[:, I[a]])
        Q[:, I[b]] = Q[:, I[a]] + d * L[(a, b)]
    return Q


# ---------- 9: feet ----------

# A flat planted foot: heel and toe from the ankle along the foot (forward)
# and up, as shares of the shin (knee→ankle). Medians over the planted frames
# of the Pose2Sim record, MediaPipe's own points triangulated from four
# calibrated cameras: heel→toe 21 cm there, while one camera gives 7–11 cm.
# ANSUR II gives the foot (skin to skin, longer than MediaPipe's points) as
# 0.68 of the shin; these points give 0.60.
FOOT_FLAT = {'heel': (-0.14, -0.16), 'toe': (0.46, -0.20)}
FOOT_SHARE = {part: float(np.hypot(*xy)) for part, xy in FOOT_FLAT.items()}
FOOT_RISE = -min(y for _, y in FOOT_FLAT.values())  # ankle above the lowest point of a flat foot


def foot_lengths(L):
    """Bone lengths with the feet set from the shin."""
    L = dict(L)
    for s in SIDES:
        shin = L[(f'knee{s}', f'ankle{s}')]
        for part, share in FOOT_SHARE.items():
            L[(f'ankle{s}', f'{part}{s}')] = shin * share
    return L


# ---------- 10: floor ----------

def estimate_up(P, C=None):
    """Up direction from the feet. A planted foot's heel→toe line and the
    line between two planted ankles both lie in the floor; up is the
    direction least present in them (smallest eigenvector). The torso axis
    settles the one direction the feet cannot (all lines parallel)."""
    lines, weights = [], []
    for t in range(len(P)):
        low = {s: min(P[t, I[f'heel{s}'], 1], P[t, I[f'toe{s}'], 1]) for s in SIDES}
        bottom = min(low.values())
        for s in SIDES:
            if low[s] - bottom < 0.03:
                d = P[t, I[f'toe{s}']] - P[t, I[f'heel{s}']]
                if np.linalg.norm(d) > 0.05:
                    lines.append(unit(d)); weights.append(1.0)
        if abs(low['L'] - low['R']) < 0.03:
            d = P[t, I['ankleL']] - P[t, I['ankleR']]
            if np.linalg.norm(d) > 0.15:
                lines.append(unit(d)); weights.append(2.0)
    body = unit((neck(P) - pelvis(P)).mean(0))
    if len(lines) < 5:
        return body
    D = np.array(lines)
    M = (D * np.array(weights)[:, None]).T @ D / sum(weights)
    vals, vecs = np.linalg.eigh(M - 0.05 * np.outer(body, body))
    up = vecs[:, 0]
    return up if np.dot(up, body) > 0 else -up


def rotation_to(a, b):
    """Rotation matrix turning unit vector a onto unit vector b."""
    a, b = unit(np.asarray(a, float)), unit(np.asarray(b, float))
    v, c = np.cross(a, b), float(np.dot(a, b))
    if c < -0.999999:
        return np.diag([1, -1, -1.0])
    k = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + k + k @ k / (1 + c)


# ---------- camera: where the body is, from the image ----------
# The world landmarks give the shape of the body around the pelvis but not
# where it stands. With the image landmarks and a focal length the pelvis
# is placed in the camera's space: the shift t that makes the shape project
# onto the image points (linear least squares, per frame). Over a static
# camera the travel is then simply the pelvis path; which way is up comes
# from upright edges of the room (vertical_from_lines), the body only
# narrows the choice.

def focal_length(size, fov_deg):
    """Focal length in pixels for a horizontal-or-vertical field of view
    `fov_deg` on the longer side of the frame."""
    return max(size) / 2 / np.tan(np.radians(fov_deg) / 2)


def to_mp(P):
    """y-up (x right, y up, z towards the camera) ↔ MediaPipe / OpenCV
    camera axes (x right, y down, z away from the camera). Own inverse."""
    return P * np.array([1, -1, -1])


def solve_translation(Pc, U, W, f, c):
    """Camera-space shift of the body per frame. Pc [T,N,3] body around the
    pelvis in camera axes, U [T,N,2] pixels, W [T,N] weights."""
    T = len(Pc)
    t_out = np.zeros((T, 3))
    for t in range(T):
        ok = ~np.isnan(U[t, :, 0]) & (W[t] > 0)
        if ok.sum() < 4:
            t_out[t] = t_out[t - 1] if t else [0, 0, 3]
            continue
        X, u, w = Pc[t, ok], U[t, ok] - c, W[t, ok]
        A = np.zeros((2 * len(X), 3)); b = np.zeros(2 * len(X))
        A[0::2, 0] = f; A[0::2, 2] = -u[:, 0]; b[0::2] = u[:, 0] * X[:, 2] - f * X[:, 0]
        A[1::2, 1] = f; A[1::2, 2] = -u[:, 1]; b[1::2] = u[:, 1] * X[:, 2] - f * X[:, 1]
        sw = np.repeat(np.sqrt(w), 2)
        t_out[t] = np.linalg.lstsq(A * sw[:, None], b * sw, rcond=None)[0]
    return t_out


def match_image(Xc, U, W, f, c, strength=1.0):
    """Moves every camera-space point onto the ray of its image point at the
    same depth, by its confidence: the image position of a joint is more
    certain than the model's guess of it."""
    ray = np.concatenate([(U - c) / f, np.ones(U.shape[:2] + (1,))], -1)
    on_ray = ray * Xc[..., 2:3]
    w = np.clip(W * strength, 0, 1)[..., None]
    out = Xc + w * (np.nan_to_num(on_ray, nan=0) - Xc) * (~np.isnan(U[..., :1]))
    return out


def vertical_from_lines(segments, f, c, prior, max_off=35.0, tol=1.0, tries=600):
    """Up direction of a tilted camera from upright scene edges (capture.py):
    the 3D lines all point up, so the planes through the camera and each
    segment share one direction. RANSAC over pairs, only directions within
    `max_off` degrees of `prior` (the body's own up, camera axes y down) are
    accepted, so floor rails running away from the camera cannot win.
    Returns (up in camera axes, inliers, segments) or None."""
    if not segments or len(segments) < 6:
        return None
    s = np.asarray(segments, float)
    p1 = np.c_[s[:, 0] - c[0], s[:, 1] - c[1], np.full(len(s), f)]
    p2 = np.c_[s[:, 2] - c[0], s[:, 3] - c[1], np.full(len(s), f)]
    n = unit(np.cross(p1, p2))
    w = np.hypot(s[:, 2] - s[:, 0], s[:, 3] - s[:, 1])
    prior = unit(np.asarray(prior, float))
    rng = np.random.default_rng(0)
    best, lim = None, np.sin(np.radians(tol))
    for _ in range(tries):
        i, j = rng.choice(len(n), 2, replace=False)
        d = np.cross(n[i], n[j])
        if np.linalg.norm(d) < 1e-6:
            continue
        d = unit(d)
        if np.dot(d, prior) < 0:
            d = -d
        if np.dot(d, prior) < np.cos(np.radians(max_off)):
            continue
        inl = np.abs(n @ d) < lim
        score = w[inl].sum()
        if best is None or score > best[0]:
            best = (score, inl, d)
    if best is None or best[1].sum() < 6:
        return None
    inl = best[1]
    vals, vecs = np.linalg.eigh((n[inl] * w[inl, None]).T @ n[inl])
    d = vecs[:, 0]
    if np.dot(d, best[2]) < 0:
        d = -d
    if np.dot(d, prior) < np.cos(np.radians(max_off)):
        d = best[2]
    return d, int(inl.sum()), len(n)


# ---------- 11–12: root and contacts ----------

FOOT = {s: [f'ankle{s}', f'heel{s}', f'toe{s}'] for s in SIDES}


def sole_height(P, s, rise=None):
    """Height of the sole: the lower of heel and toe; with rise ({side:
    metres}), the ankle's height less that of a flat foot (FOOT_FLAT), which
    does not depend on the foot's pitch that one camera gets wrong."""
    if rise:
        return P[:, I[f'ankle{s}'], 1] - rise[s]
    return np.minimum(P[:, I[f'heel{s}'], 1], P[:, I[f'toe{s}'], 1])


def place_root(P, fps, contact_height, contact_speed, rise=None):
    """Pelvis-centred frames → frames on the floor. Height: the lowest sole
    touches y = 0. Travel: the feet near the floor are assumed planted, the
    body moves by the opposite of their motion relative to the pelvis; with
    no foot planted the last travel speed is kept."""
    T = len(P)
    Q = P - pelvis(P)[:, None, :]
    low = np.minimum(sole_height(Q, 'L', rise), sole_height(Q, 'R', rise))
    Q[:, :, 1] -= low[:, None]
    rel = {s: Q[:, I[f'ankle{s}']] for s in SIDES}
    root = np.zeros((T, 3))
    root[:, 1] = -low
    vel = np.zeros(3)
    for t in range(1, T):
        step, wsum = np.zeros(3), 0.0
        for s in SIDES:
            h = sole_height(Q[t - 1:t + 1], s, rise).max()
            if h < contact_height * 2:
                w = 1.0 - h / (contact_height * 2)
                d = -(rel[s][t] - rel[s][t - 1])
                d[1] = 0
                if np.linalg.norm(d) * fps < contact_speed * 3:
                    step += w * d; wsum += w
        if wsum > 0:
            vel = step / wsum * fps
        root[t, [0, 2]] = root[t - 1, [0, 2]] + vel[[0, 2]] / fps
    return Q + np.array([root[:, 0], np.zeros(T), root[:, 2]]).T[:, None, :], root


def detect_contacts(P, fps, contact_height, contact_speed, contact_min, rise=None):
    """Contact intervals per foot: sole near the floor and slow, with one
    frame of hysteresis, shorter intervals dropped. {s: [(t0,t1),...]}"""
    out = {}
    for s in SIDES:
        h = sole_height(P, s, rise)
        a = P[:, I[f'ankle{s}']]
        v = np.zeros(len(P))
        v[1:] = np.linalg.norm(np.diff(a[:, [0, 2]], axis=0), axis=1) * fps
        v[0] = v[1] if len(v) > 1 else 0
        on = (h < contact_height) & (v < contact_speed)
        on = np.convolve(on.astype(float), np.ones(3) / 3, 'same') > 0.5
        intervals, t0 = [], None
        for t, c in enumerate(list(on) + [False]):
            if c and t0 is None:
                t0 = t
            elif not c and t0 is not None:
                if (t - t0) / fps >= contact_min:
                    intervals.append((t0, t - 1))
                t0 = None
        out[s] = intervals
    return out


def two_bone_ik(hip, knee, ankle_target, l1, l2):
    """Knee for a hip and a new ankle target, bending in the plane of the
    current knee (its pole)."""
    d = ankle_target - hip
    dist = np.clip(np.linalg.norm(d), 1e-6, l1 + l2 - 1e-6)
    axis = d / np.linalg.norm(d)
    ankle = hip + axis * dist
    cos_a = np.clip((l1 ** 2 + dist ** 2 - l2 ** 2) / (2 * l1 * dist), -1, 1)
    pole = knee - hip
    pole = pole - np.dot(pole, axis) * axis
    if np.linalg.norm(pole) < 1e-6:
        pole = np.cross(axis, [1, 0, 0])
    pole = pole / np.linalg.norm(pole)
    return hip + axis * l1 * cos_a + pole * l1 * np.sqrt(1 - cos_a ** 2), ankle


def lock_contacts(P, contacts, L, blend=3, flat=False):
    """Holds each planted foot at its median place; the knee is solved by
    two-bone IK, the step in and out blends over `blend` frames. With flat,
    the planted foot also lies flat (FOOT_FLAT) along its median heading."""
    P = P.copy()
    T = len(P)
    for s, intervals in contacts.items():
        shin = L[(f'knee{s}', f'ankle{s}')]
        for t0, t1 in intervals:
            target = np.median(P[t0:t1 + 1, I[f'ankle{s}']], axis=0)
            target[1] = max(target[1], 0.0)
            along = P[t0:t1 + 1, I[f'toe{s}']] - P[t0:t1 + 1, I[f'heel{s}']]
            fwd = np.array([np.median(along[:, 0]), 0.0, np.median(along[:, 2])])
            fwd = fwd / (np.linalg.norm(fwd) or 1.0)
            for t in range(max(0, t0 - blend), min(T, t1 + blend + 1)):
                w = 1.0 if t0 <= t <= t1 else 1 - (t0 - t if t < t0 else t - t1) / (blend + 1)
                a_old = P[t, I[f'ankle{s}']].copy()
                goal = a_old + w * (target - a_old)
                knee, ankle = two_bone_ik(P[t, I[f'hip{s}']], P[t, I[f'knee{s}']], goal,
                                          L[(f'hip{s}', f'knee{s}')], L[(f'knee{s}', f'ankle{s}')])
                shift = ankle - a_old
                P[t, I[f'knee{s}']] = knee
                for n in FOOT[s]:
                    P[t, I[n]] = P[t, I[n]] + shift
                if flat:
                    for part, (x, y) in FOOT_FLAT.items():
                        j = I[f'{part}{s}']
                        laid = ankle + (fwd * x + np.array([0, y, 0])) * shin
                        P[t, j] = P[t, j] + w * (laid - P[t, j])
    return P


def feet_above_floor(P):
    """Turns a foot about its ankle, in the foot's own vertical plane, just
    enough that neither heel nor toe is below the floor. One camera tips the
    swinging foot toes down; the retargeter would push the figure's toes
    into the ground. Returns the points and the number of feet turned."""
    P, n = P.copy(), 0
    for s in SIDES:
        a, parts = I[f'ankle{s}'], (I[f'heel{s}'], I[f'toe{s}'])
        for t in range(len(P)):
            A = P[t, a]
            low = min(parts, key=lambda j: P[t, j, 1])
            if P[t, low, 1] >= 0 or A[1] <= 0:
                continue
            r = P[t, low] - A
            h = np.hypot(r[0], r[2])
            if h < 1e-6:
                continue
            k = np.cross([0, 1.0, 0], [r[0] / h, 0, r[2] / h])  # horizontal axis across the point's direction
            # angle that brings this point up to the floor: turn r (length ρ) to height -A_y
            rho = np.linalg.norm(r)
            now = np.arctan2(r[1], h)
            want = -np.arcsin(min(1.0, A[1] / rho))
            ang = now - want  # negative: the point goes up
            c, sn = np.cos(ang), np.sin(ang)
            for j in parts:  # Rodrigues about k through the ankle, the same turn for the whole foot
                v = P[t, j] - A
                P[t, j] = A + v * c + np.cross(k, v) * sn + k * np.dot(k, v) * (1 - c)
            n += 1
    return P, n


# ---------- the whole pipeline ----------

ALL_STEPS = ['confidence', 'outliers', 'gaps', 'smooth', 'knees', 'lengths', 'camera', 'image', 'feet', 'floor', 'root', 'contacts']


def clean(raw, **opts):
    """The whole pipeline. Returns (points [T,33,3] y up on the floor, fps,
    report). Steps can be switched off with steps=[...] to measure them."""
    o = {**DEFAULTS, **opts}
    steps = set(o.get('steps') or ALL_STEPS)
    P, C, fps = load_raw(raw)
    U, size = load_image(raw)
    report = {'frames': len(P), 'fps': fps, 'found': int((~np.isnan(P[:, 0, 0])).sum())}
    if report['found'] < 2:
        raise ValueError('На видео не найден человек')
    use_camera = 'camera' in steps and size[0] > 0 and not np.isnan(U).all()
    if 'confidence' in steps:
        P = mask_low_confidence(P, C, o['min_conf'])
        U = U.copy(); U[C < o['min_conf']] = np.nan
    if 'outliers' in steps:
        before = np.isnan(P[..., 0])
        P, report['outliers'] = mask_outliers(P, o['outlier_m'])
        U = U.copy(); U[np.isnan(P[..., 0]) & ~before] = np.nan  # the image point of a thrown-off joint is just as wrong
    report['missingShare'] = round(float(np.isnan(P[:, :, 0]).mean()), 4)
    P, longest = fill_gaps(P, fps, o['max_gap'])
    report['longGaps'] = {NAMES[j]: round(float(g), 2) for j, g in enumerate(longest) if g > o['max_gap']}
    if use_camera:
        U3, _ = fill_gaps(np.concatenate([U, np.zeros(U.shape[:2] + (1,))], -1), fps, 1e9)
        U = U3[..., :2]
        body_m = np.median(np.linalg.norm(neck(P) - (P[:, I['ankleL']] + P[:, I['ankleR']]) / 2, axis=-1))
        body_px = np.nanmedian(np.linalg.norm((U[:, I['shoulderL']] + U[:, I['shoulderR']]) / 2 - (U[:, I['ankleL']] + U[:, I['ankleR']]) / 2, axis=-1))
        px_per_m = body_px / max(body_m, 1e-6)
    if 'smooth' in steps:
        P = smooth(P, fps, o['min_cutoff'], o['beta'], o['d_cutoff'])
        if use_camera:
            U = smooth(np.concatenate([U / px_per_m, np.zeros(U.shape[:2] + (1,))], -1), fps, o['min_cutoff'], o['beta'], o['d_cutoff'])[..., :2] * px_per_m
    if 'knees' in steps:
        P, report['kneesFixed'] = fix_knees(P)
    L = bone_lengths(P, C)
    rise = None
    if 'feet' in steps:
        L = foot_lengths(L)
        rise = {s: FOOT_RISE * L[(f'knee{s}', f'ankle{s}')] for s in SIDES}
    report['boneCV'] = bone_cv(P)
    if 'lengths' in steps:
        P = enforce_lengths(P, L)
    floor = None
    if use_camera:
        f = o.get('focal') or focal_length(size, o['fov'])
        c = np.array(size) / 2
        report['focalPx'] = round(float(f), 1)
        W = np.where(np.isnan(C), 0, C)
        Pc = to_mp(P - pelvis(P)[:, None, :])
        t = solve_translation(Pc, U, W, f, c)
        if 'smooth' in steps:  # depth of a single camera is its noisiest number
            t = smooth(t[:, None, :], fps, o['min_cutoff'] / 2, o['beta'], o['d_cutoff'])[:, 0]
        Xc = Pc + t[:, None, :]
        if 'image' in steps:
            Xc = match_image(Xc, U, W, f, c, o['image_weight'])
        P = to_mp(Xc)
        if 'lengths' in steps:
            P = enforce_lengths(P, L)
        if 'floor' in steps:
            body_up = to_mp(unit((neck(P) - pelvis(P)).mean(0)))
            lines = vertical_from_lines((raw.get('scene') or {}).get('segments'), f, c, body_up)
            if lines is not None:
                floor = to_mp(lines[0])
                report['sceneLines'] = {'inliers': lines[1], 'segments': lines[2]}
    up, report['floorFrom'] = np.array([0, 1.0, 0]), 'camera'
    if 'floor' in steps:
        if floor is not None:
            up, report['floorFrom'] = floor, 'scene lines'
        else:
            up, report['floorFrom'] = estimate_up(P - pelvis(P)[:, None, :], C), 'body'
    R = rotation_to(up, [0, 1, 0])
    P = P @ R.T
    report['up'] = [round(float(v), 4) for v in up]
    report['tiltDeg'] = round(float(np.degrees(np.arccos(np.clip(up[1], -1, 1)))), 2)
    if use_camera and 'root' in steps:
        P[:, :, 1] -= np.percentile(np.minimum(sole_height(P, 'L', rise), sole_height(P, 'R', rise)), 5)
    elif 'root' in steps:
        P, _ = place_root(P, fps, o['contact_height'], o['contact_speed'], rise)
    else:
        P = P - pelvis(P)[:, None, :]
        P[:, :, 1] -= np.minimum(sole_height(P, 'L', rise), sole_height(P, 'R', rise)).min()
    contacts = detect_contacts(P, fps, o['contact_height'], o['contact_speed'], o['contact_min'], rise)
    report['skateBefore'] = foot_skate(P, contacts)
    if 'contacts' in steps:
        P = lock_contacts(P, contacts, L, flat='feet' in steps)
        if 'feet' in steps:
            P, report['feetTurned'] = feet_above_floor(P)
    report['contacts'] = {s: [[round(a / fps, 3), round(b / fps, 3)] for a, b in v] for s, v in contacts.items()}
    report['skateAfter'] = foot_skate(P, contacts)
    report['boneLengths'] = {f'{k[0]}-{k[1]}' if isinstance(k, tuple) else k: round(v, 4) for k, v in L.items()}
    report['confidence'] = [round(float(c), 3) for c in C.mean(1)]
    report['steps'] = [s for s in ALL_STEPS if s in steps]
    return P, fps, report


def bone_cv(P):
    """Mean coefficient of variation of limb lengths, percent."""
    cv = []
    for a, b in LIMBS[:12]:
        l = np.linalg.norm(P[:, I[a]] - P[:, I[b]], axis=-1)
        cv.append(np.std(l) / max(np.mean(l), 1e-9))
    return round(float(np.mean(cv)) * 100, 2)


def foot_skate(P, contacts):
    """Mean horizontal drift of a planted ankle from its median place, cm."""
    d = []
    for s, intervals in contacts.items():
        for t0, t1 in intervals:
            a = P[t0:t1 + 1, I[f'ankle{s}']][:, [0, 2]]
            d.extend(np.linalg.norm(a - np.median(a, axis=0), axis=1))
    return round(float(np.mean(d)) * 100, 2) if d else None


def write_clean(P, fps, report, source):
    return {'format': 'vmocap.clean', 'version': 1, 'source': source, 'fps': fps, 'landmarks': NAMES,
            'frames': np.round(P, 4).tolist(), 'report': report}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('raw')
    ap.add_argument('-o', '--out', required=True)
    ap.add_argument('--steps', help='через запятую: ' + ','.join(ALL_STEPS))
    for k, v in DEFAULTS.items():
        ap.add_argument('--' + k.replace('_', '-'), type=float, default=v)
    a = ap.parse_args()
    raw = json.load(open(a.raw))
    opts = {k: getattr(a, k) for k in DEFAULTS}
    if a.steps:
        opts['steps'] = a.steps.split(',')
    P, fps, report = clean(raw, **opts)
    json.dump(write_clean(P, fps, report, raw['source']), open(a.out, 'w'), separators=(',', ':'))
    print(json.dumps({k: report[k] for k in ('frames', 'found', 'missingShare', 'outliers', 'kneesFixed', 'boneCV', 'tiltDeg', 'skateBefore', 'skateAfter', 'contacts') if k in report}, ensure_ascii=False))


if __name__ == '__main__':
    main()
