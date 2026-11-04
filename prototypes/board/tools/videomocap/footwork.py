"""Steady body and planted feet for a noisy single-camera recording.

One camera gets depth wrong most of all, and the feet worst: in ролик 516
the attacker's ankle wanders 10 cm from frame to frame and swings by half a
metre and back within 0.2 s, faster than any footwork. Played as recorded,
the figure trembles and its feet shuffle and slide over the floor, while a
fencer stands planted between steps.

So the feet are rebuilt from what footwork is: a foot stands still on the
floor, then steps to a new place, then stands still again.

1. plants: each ankle's path on the floor is cut into stretches where it
   stands (optimal partitioning: least squares around each stretch's
   median plus a cost for each new stretch, PLANT_COST), stretches shorter
   than PLANT_MIN are not stands, and a step shorter than STEP_MIN is no
   step: the foot stays where it was. A foot that goes out and back to the
   same place within SHUFFLE_MAX did not step either (a depth error).
2. steps: between two stands the foot travels on a minimum-jerk curve
   (Flash & Hogan 1985), lifted by a share of the step, within
   STEP_TIME; standing, it lies flat on the floor (clean.FOOT_FLAT).
3. body: the pelvis path and the body over it are smoothed in time
   (zero-lag Gaussian, BODY_SIGMA frames), bones keep their median lengths.
4. legs: each knee is solved by two-bone IK from the hip to the rebuilt
   ankle, bending in the plane of the recorded knee (smoothed). Where a
   planted foot is out of the leg's reach the pelvis comes down just enough
   (a fencer bends the knees), smoothly.

Returns the frames and, per foot, the stands in frames, so a player can keep
the feet planted when it moves the body (board: exchange.mjs).
"""
import numpy as np
import clean as C

BODY_SIGMA = 2.0     # frames, smoothing of the body (≈ 2.4 Hz at half power at 30 fps)
PELVIS_SIGMA = 2.5   # frames, smoothing of the pelvis path
PLANT_COST = 0.4     # m², cost of one more stretch. Splitting two stands of n₁ and n₂ frames d apart
                     # saves n₁n₂/(n₁+n₂)·d²: two 1 s stands split from 16 cm, two of 0.25 s from 32 cm.
                     # Ролик 516 stands scatter by 9–17 cm rms (depth): smaller steps are not told from it.
PLANT_MIN = 0.33     # s, shortest stand
STEP_MIN = 0.15      # m, shortest step; shorter, the foot stays (a fencing step is 0.3–0.5 m)
SHUFFLE_MAX = 0.7    # s, out and back to within STEP_MIN in less is no step
STEP_TIME = (0.2, 0.45)  # s, shortest and longest step
STEP_SPEED = 1.6     # m/s, mean foot speed of a step (fencing advance / lunge)
LIFT = (0.03, 0.10, 0.3)  # m, lowest and highest lift of a step, lift per metre of step
REACH = 0.995        # share of the leg's full length a planted leg may reach
DROP_MAX = 0.15      # m, deepest the pelvis comes down for a far foot (a fencing lunge)


def gauss(X, sigma):
    """Zero-lag Gaussian smoothing along the first axis, edges held."""
    if sigma <= 0:
        return X.copy()
    r = int(np.ceil(3 * sigma))
    w = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    w /= w.sum()
    P = np.pad(X, ((r, r),) + ((0, 0),) * (X.ndim - 1), mode='edge')
    return np.tensordot(w, np.stack([P[i:i + len(X)] for i in range(2 * r + 1)], 0), axes=([0], [0]))


def partition(Y, cost, least):
    """Optimal partitioning of a path Y [T,2] into stretches of at least
    `least` frames, each fitted by its mean: least squares + cost per stretch.
    Returns [(t0, t1), ...] inclusive."""
    T = len(Y)
    S1 = np.vstack([np.zeros((1, 2)), np.cumsum(Y, 0)])
    S2 = np.concatenate([[0.0], np.cumsum((Y ** 2).sum(1))])

    def sse(a, b):  # frames a..b-1
        n = b - a
        m = S1[b] - S1[a]
        return S2[b] - S2[a] - (m ** 2).sum() / n

    F = np.full(T + 1, np.inf)
    F[0] = -cost
    back = np.zeros(T + 1, int)
    for b in range(least, T + 1):
        for a in range(0, b - least + 1):
            if a != 0 and a < least:
                continue
            v = F[a] + cost + sse(a, b)
            if v < F[b]:
                F[b], back[b] = v, a
    if not np.isfinite(F[T]):
        return [(0, T - 1)]
    cuts, b = [], T
    while b > 0:
        a = back[b]
        cuts.append((a, b - 1))
        b = a
    return cuts[::-1]


def stands(Y, fps, cost=PLANT_COST, least_s=PLANT_MIN, step_min=STEP_MIN, shuffle_s=SHUFFLE_MAX):
    """Stands of one foot: [(t0, t1, place[2])], merged where the step is too short."""
    least = max(2, int(round(least_s * fps)))
    seg = [(a, b, np.median(Y[a:b + 1], 0)) for a, b in partition(Y, cost, least)]
    changed = True
    while changed and len(seg) > 1:
        changed = False
        for i in range(len(seg) - 1):  # a step shorter than step_min: one stand
            if np.linalg.norm(seg[i][2] - seg[i + 1][2]) < step_min:
                a, b = seg[i][0], seg[i + 1][1]
                seg[i:i + 2] = [(a, b, np.median(Y[a:b + 1], 0))]
                changed = True
                break
        if changed:
            continue
        for i in range(1, len(seg) - 1):  # out and back quickly: no step
            a, b = seg[i - 1], seg[i + 1]
            if (seg[i][1] - seg[i][0] + 1) / fps < shuffle_s and np.linalg.norm(a[2] - b[2]) < step_min:
                seg[i - 1:i + 2] = [(a[0], b[1], np.median(Y[a[0]:b[1] + 1], 0))]
                changed = True
                break
    return seg


def min_jerk(u):
    u = np.clip(u, 0, 1)
    return u ** 3 * (10 - 15 * u + 6 * u ** 2)


def heading_of(X, s, a, b):
    """Median horizontal direction heel → toe over frames a..b (unit)."""
    d = X[a:b + 1, C.I['toe' + s]] - X[a:b + 1, C.I['heel' + s]]
    v = np.array([np.median(d[:, 0]), 0.0, np.median(d[:, 2])])
    n = np.linalg.norm(v)
    return v / n if n > 1e-6 else np.array([0.0, 0.0, 1.0])


def foot_track(X, s, fps, L, seg=None):
    """Rebuilt ankle [T,3], heel and toe of one foot, its stands in frames and
    the stretches it was built from ([(t0, t1, place)], given or found)."""
    T = len(X)
    if seg is None:
        seg = stands(gauss(X[:, C.I['ankle' + s], :][:, [0, 2]], 1.0), fps)
    shin = L[(f'knee{s}', f'ankle{s}')]
    rise = C.FOOT_RISE * shin
    place = np.zeros((T, 2))
    lift = np.zeros(T)
    head = np.zeros((T, 3))
    plants = []
    # Each step is centred on the cut between two stretches; a stand holds
    # from the end of the step into it to the start of the step out.
    spans = [[a, b] for a, b, _ in seg]
    for i in range(len(seg) - 1):
        d = np.linalg.norm(seg[i + 1][2] - seg[i][2])
        n = int(round(np.clip(d / STEP_SPEED, *STEP_TIME) * fps))
        lo = int(round(seg[i][1] + 0.5 - n / 2))
        spans[i][1] = max(lo, spans[i][0] + 1)
        spans[i + 1][0] = min(lo + n, spans[i + 1][1] - 1)
    heads = [heading_of(X, s, a, b) for a, b, _ in seg]
    for i, (a, b, p) in enumerate(seg):
        t0, t1 = spans[i]
        place[t0:t1 + 1] = p
        head[t0:t1 + 1] = heads[i]
        plants.append((t0, t1))
        if i + 1 < len(seg):
            u0, u1 = t1, spans[i + 1][0]
            q, d = seg[i + 1][2], np.linalg.norm(seg[i + 1][2] - p)
            h = np.clip(LIFT[2] * d, LIFT[0], LIFT[1])
            for t in range(u0 + 1, u1):
                u = (t - u0) / (u1 - u0)
                m = min_jerk(u)
                place[t] = p + (q - p) * m
                lift[t] = h * np.sin(np.pi * u)
                v = heads[i] * (1 - m) + heads[i + 1] * m
                head[t] = v / (np.linalg.norm(v) or 1.0)
    A = np.stack([place[:, 0], rise + lift, place[:, 1]], 1)
    parts = {}
    for part, (x, y) in C.FOOT_FLAT.items():
        parts[part] = A + (head * x + np.array([0, y, 0])) * shin
    return A, parts, plants, seg


def steady(X, fps, body_sigma=BODY_SIGMA, pelvis_sigma=PELVIS_SIGMA):
    """Frames [T,33,3] (y up, floor at 0) → (frames, plants {s: [(t0,t1)]},
    report). The whole body is smoothed, the feet planted, the legs solved."""
    X = np.asarray(X, float)
    L = C.foot_lengths(C.bone_lengths(X))
    pv = C.pelvis(X)
    pv_s = gauss(pv, pelvis_sigma)
    Y = gauss(X - pv[:, None, :], body_sigma) + pv_s[:, None, :]
    Y = C.enforce_lengths(Y, L)
    # Reach: the pelvis comes down where a planted foot is out of the leg's
    # reach, by DROP_MAX at most (a lunge); a stand still out of reach then is
    # moved towards the hip as a whole, so the foot does not slide in it.
    def need_of(H, A, l1, l2, drop):
        r = REACH * (l1 + l2)
        flat = np.linalg.norm((H - A)[:, [0, 2]], axis=1)
        return (H[:, 1] - A[:, 1]) - np.sqrt(np.maximum(r ** 2 - flat ** 2, 0)), flat, r

    feet, plants, segs, moved = {}, {}, {}, 0
    for s in C.SIDES:
        A, parts, plants[s], segs[s] = foot_track(X, s, fps, L)
        l1, l2 = L[(f'hip{s}', f'knee{s}')], L[(f'knee{s}', f'ankle{s}')]
        for _ in range(3):
            H = Y[:, C.I['hip' + s]].copy()
            H[:, 1] -= DROP_MAX
            r = REACH * (l1 + l2)
            new, changed = [], False
            for (a, b, p), (t0, t1) in zip(segs[s], plants[s]):
                d = A[t0:t1 + 1] - H[t0:t1 + 1]
                flat = np.linalg.norm(d[:, [0, 2]], axis=1)
                room = np.sqrt(np.maximum(r ** 2 - d[:, 1] ** 2, 0))
                excess = float((flat - room).max())
                if excess > 1e-3:
                    toward = H[t0:t1 + 1, [0, 2]].mean(0) - p
                    p = p + toward / (np.linalg.norm(toward) or 1.0) * min(excess + 0.005, np.linalg.norm(toward))
                    changed = True
                    moved += 1
                new.append((a, b, p))
            segs[s] = new
            if not changed:
                break
            A, parts, plants[s], segs[s] = foot_track(X, s, fps, L, segs[s])
        feet[s] = (A, parts)
    drop = np.zeros(len(Y))
    for s in C.SIDES:
        l1, l2 = L[(f'hip{s}', f'knee{s}')], L[(f'knee{s}', f'ankle{s}')]
        need, _, _ = need_of(Y[:, C.I['hip' + s]], feet[s][0], l1, l2, 0)
        drop = np.maximum(drop, need)
    drop = np.clip(drop, 0, DROP_MAX)
    # Spread each drop over the frames around it, never less than needed.
    k = int(np.ceil(3 * body_sigma))
    wide = np.array([drop[max(0, t - k):t + k + 1].max() for t in range(len(drop))])
    drop = np.maximum(gauss(wide, body_sigma), drop)
    upper = [i for i, n in enumerate(C.NAMES) if not n.startswith(('knee', 'ankle', 'heel', 'toe'))]
    Y[:, upper, 1] -= drop[:, None]
    short = 0
    for s in C.SIDES:
        A, parts = feet[s]
        l1, l2 = L[(f'hip{s}', f'knee{s}')], L[(f'knee{s}', f'ankle{s}')]
        pole = gauss(Y[:, C.I['knee' + s]] - Y[:, C.I['hip' + s]], body_sigma)
        for t in range(len(Y)):
            hip = Y[t, C.I['hip' + s]]
            knee, ankle = C.two_bone_ik(hip, hip + pole[t], A[t], l1, l2)
            if np.linalg.norm(ankle - A[t]) > 0.005:
                short += 1
            shift = ankle - A[t]
            Y[t, C.I['knee' + s]] = knee
            Y[t, C.I['ankle' + s]] = ankle
            for part in ('heel', 'toe'):
                Y[t, C.I[part + s]] = parts[part][t] + shift
    steps = {s: len(plants[s]) - 1 for s in C.SIDES}
    report = {'bodySigmaFrames': body_sigma, 'pelvisSigmaFrames': pelvis_sigma, 'steps': steps,
              'plants': {s: [[int(a), int(b)] for a, b in plants[s]] for s in C.SIDES},
              'maxDropM': round(float(drop.max()), 3), 'standsMoved': moved, 'shortFrames': short}
    return Y, plants, report
