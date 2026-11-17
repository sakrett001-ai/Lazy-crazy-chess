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
   One foot steps at a time: where the two feet's steps overlap, the later
   one waits until the other foot is down (or the earlier one goes sooner),
   shortened to STEP_TIME[0] at most, for a fencer has no flight between
   steps (in walking both feet are off the floor only in running; Perry &
   Burnfield, Gait Analysis, 2010, ch. 2). And each foot keeps its own
   side: given the direction the fighter faces, a stand of the left foot
   lies at least WIDTH_MIN left of the other foot, and the right one right
   of it; a stand that crosses over is moved outwards (one camera puts the
   feet on one line or crosses them by depth error; preferred step width in
   walking is about 0.13 m, Donelan, Kram & Kuo 2001).
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
WIDTH_MIN = 0.08     # m, least side distance between the ankles of the two stands (below the
                     # ≈0.13 m preferred step width of walking, Donelan, Kram & Kuo 2001)
HOLD_MIN = 0.1       # s, shortest stand between two steps of one foot
SHIFT_MAX = 0.2      # s, furthest a step is moved to let the other foot land (further, the foot
                     # lands where the recorded body is not yet or no longer: a wide stance)


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


def windows(seg, fps):
    """Steps of one foot as [u0, u1]: the last frame it stands before the
    step and the first it stands after. Each step is centred on the cut
    between two stretches and lasts by its length (STEP_SPEED, STEP_TIME)."""
    spans = [[a, b] for a, b, _ in seg]
    for i in range(len(seg) - 1):
        d = np.linalg.norm(seg[i + 1][2] - seg[i][2])
        n = int(round(np.clip(d / STEP_SPEED, *STEP_TIME) * fps))
        lo = int(round(seg[i][1] + 0.5 - n / 2))
        spans[i][1] = max(lo, spans[i][0] + 1)
        spans[i + 1][0] = min(lo + n, spans[i + 1][1] - 1)
    return [[spans[i][1], spans[i + 1][0]] for i in range(len(seg) - 1)]


def in_flight(w, t):
    return w[0] < t < w[1]


def one_at_a_time(win, T, fps, hold_s=HOLD_MIN, shift_s=SHIFT_MAX):
    """Steps of both feet {s: [[u0, u1]]} → the same with no frame where both
    feet are in the air. Steps are placed in time order; a step that overlaps
    the other foot's step moves to the nearest start where it does not (and
    keeps a stand of hold_s after its own previous step), shortened to
    STEP_TIME[0] if that brings it nearer. Returns the steps, how many
    frames still have both feet up (none, unless no room was found) and the
    steps [(s, i)] that found no room."""
    hold = max(1, int(round(hold_s * fps)))
    least = max(2, int(round(STEP_TIME[0] * fps)))
    far = int(round(shift_s * fps))
    order = sorted(((w[0] + w[1]) / 2, s, i) for s, ws in win.items() for i, w in enumerate(ws))
    out = {s: [list(w) for w in ws] for s, ws in win.items()}
    done = {s: [] for s in win}
    stuck = []
    for _, s, i in order:
        o = [x for x in win if x != s][0]
        u0, u1 = win[s][i]
        prev = out[s][i - 1][1] + hold if i else 1
        nxt = (win[s][i + 1][0] - hold) if i + 1 < len(win[s]) else T - 1
        best = None
        for n in range(u1 - u0, min(least, u1 - u0) - 1, -1):
            for shift in sorted(range(-far, far + 1), key=abs):
                a, b = u0 + shift + (u1 - u0 - n) // 2, u0 + shift + (u1 - u0 - n) // 2 + n
                if a < prev or b > nxt:
                    continue
                if any(a < q1 and q0 < b for q0, q1 in done[o]):
                    continue
                cost = abs(shift) + 0.5 * (u1 - u0 - n)
                if best is None or cost < best[0]:
                    best = (cost, a, b)
                break
        if best is not None:
            out[s][i] = [best[1], best[2]]
        else:
            stuck.append((s, i))
        done[s].append(tuple(out[s][i]))
    both = sum(1 for t in range(T) if all(any(in_flight(w, t) for w in out[x]) for x in out))
    return out, both, stuck


def foot_track(X, s, fps, L, seg=None, win=None):
    """Rebuilt ankle [T,3], heel and toe of one foot, its stands in frames and
    the stretches it was built from ([(t0, t1, place)], given or found). The
    steps' frames ([[u0, u1]], windows) may be given."""
    T = len(X)
    if seg is None:
        seg = stands(gauss(X[:, C.I['ankle' + s], :][:, [0, 2]], 1.0), fps)
    shin = L[(f'knee{s}', f'ankle{s}')]
    rise = C.FOOT_RISE * shin
    place = np.zeros((T, 2))
    lift = np.zeros(T)
    head = np.zeros((T, 3))
    plants = []
    # A stand holds from the end of the step into it to the start of the
    # step out.
    if win is None:
        win = windows(seg, fps)
    spans = [[win[i - 1][1] if i else 0, win[i][0] if i < len(win) else T - 1] for i in range(len(seg))]
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


def steady(X, fps, body_sigma=BODY_SIGMA, pelvis_sigma=PELVIS_SIGMA, left=None):
    """Frames [T,33,3] (y up, floor at 0) → (frames, plants {s: [(t0,t1)]},
    report). The whole body is smoothed, the feet planted, the legs solved.
    left: the fighter's left as a horizontal direction (they face the
    partner); given, each foot keeps its side (WIDTH_MIN)."""
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

    win = {s: None for s in C.SIDES}
    track = {s: foot_track(X, s, fps, L) for s in C.SIDES}
    segs = {s: track[s][3] for s in C.SIDES}
    moved, widened = 0, 0

    def reach():
        nonlocal moved
        changed = False
        for s in C.SIDES:
            A, _, plants, _ = track[s]
            l1, l2 = L[(f'hip{s}', f'knee{s}')], L[(f'knee{s}', f'ankle{s}')]
            H = Y[:, C.I['hip' + s]].copy()
            H[:, 1] -= DROP_MAX
            r = REACH * (l1 + l2)
            new = []
            for (a, b, p), (t0, t1) in zip(segs[s], plants):
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
        return changed

    def width():
        # Each stand keeps its side of the other foot, as the fighter faces:
        # a crossing stand moves outwards by half of what it lacks (the
        # other foot's stand moves the other half) until both are apart.
        nonlocal widened
        if left is None:
            return False
        side = np.asarray(left, float)[[0, 2]]
        side = side / np.linalg.norm(side)
        changed = False
        for s, sign in (('L', 1.0), ('R', -1.0)):
            o = 'R' if s == 'L' else 'L'
            other = track[o][0][:, [0, 2]]
            new = []
            for (a, b, p), (t0, t1) in zip(segs[s], track[s][2]):
                lack = WIDTH_MIN - float((sign * (p - other[t0:t1 + 1]) @ side).min())
                if lack > 0.003:
                    p = p + sign * side * (lack / 2 + 0.002)
                    changed = True
                    widened += 1
                new.append((a, b, p))
            segs[s] = new
        return changed

    def rebuild():
        for s in C.SIDES:
            track[s] = foot_track(X, s, fps, L, segs[s], win[s])

    for _ in range(12):
        changed = width()
        changed = reach() or changed
        if not changed:
            break
        rebuild()
    # One foot in the air at a time; the stands keep their places, the
    # steps their order.
    # A step with no room around the other foot's steps comes next to a
    # stand the foot hardly touched (shorter than PLANT_MIN once the steps
    # took their frames): that stand is dropped and the two steps become one.
    merged = 0
    while True:
        win, both, stuck = one_at_a_time({s: windows(segs[s], fps) for s in C.SIDES}, len(X), fps)
        drop = None

        def held(x, j):  # frames stand j of foot x holds between its steps
            return (win[x][j][0] if j < len(win[x]) else len(X) - 1) - (win[x][j - 1][1] if j else 0)
        for s, i in stuck:
            # The stands next to the stuck step, then those next to the other
            # foot's steps in its way.
            o = 'R' if s == 'L' else 'L'
            u0, u1 = win[s][i]
            near = [(s, j) for j in (i, i + 1)] + [(o, j) for k, (q0, q1) in enumerate(win[o]) if q0 < u1 and u0 < q1 for j in (k, k + 1)]
            near = [(x, j) for x, j in near if 0 < j < len(segs[x]) - 1 and held(x, j) / fps < PLANT_MIN]
            if near:
                drop = min(near, key=lambda c: held(*c))
                break
        if drop is None:
            break
        s, j = drop
        (a0, b0, p0), (a1, b1, _) = segs[s][j - 1], segs[s][j]
        segs[s] = segs[s][:j - 1] + [(a0, (a1 + b1) // 2, p0)] + segs[s][j + 1:]
        merged += 1
    rebuild()
    for _ in range(3):
        if not reach():
            break
        rebuild()
    feet = {s: (track[s][0], track[s][1]) for s in C.SIDES}
    plants = {s: track[s][2] for s in C.SIDES}
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
              'maxDropM': round(float(drop.max()), 3), 'standsMoved': moved, 'standsWidened': widened,
              'standsMerged': merged, 'bothFeetUpFrames': both, 'shortFrames': short}
    return Y, plants, report
