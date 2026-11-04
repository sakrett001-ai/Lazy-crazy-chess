#!/usr/bin/env python3
"""Two raw takes of one duel (capture.py --people 2) → one clean scene of two
people and the strikes between them, for any engine.

    python3 duel.py duel.A.raw.json duel.B.raw.json -o duel.pair.json [--shot N] [--notes notes.json]

What makes two people one scene, not two clips side by side:

1. one shot: an edited video changes camera at a cut, so a scene is one shot
   between cuts (capture.py found them); the longest one by default;
2. one up: both people are cleaned with the same up, from the room's upright
   edges, or the mean of both bodies' up when the room has none;
3. one camera: each body stays where the camera saw it, so the distance
   between the fighters is measured, not set by hand (it is only as good as a
   single camera's depth: the report gives its spread);
4. one frame: the origin is the middle between the two fighters on the floor,
   x goes from A to B, y up, z = x × y; A faces +x, B faces −x;
5. strikes: every fast move of a hand or a foot towards the other person is
   a strike candidate with its start, moment of closest reach and end, the
   nearest part of the other body and how the other one answered (hands up —
   a parry or a block; trunk away — a step back). A camera sees no blade, so
   the source of a hand strike is a guess ('weapon'); --notes tells which
   ones were the shield, a push, a pommel, and whether each hit, was parried
   or missed. A kick is a strike with source 'leg'. A fast hand of the other
   one meeting the striker's arms during the strike is marked as its parry.

The file ("vmocap.pair") is plain metres and joint names, nothing about the
game it is used in.
"""
import argparse, json, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import clean as C  # noqa: E402

# Strike candidates: thresholds of wrist and toe speed. Measured on the
# clips of references/sources.md (one camera, after clean.py): a guard or a
# slow feint stays under them, the cuts and kicks there go over.
HAND_SPEED = 2.5      # m/s
FOOT_SPEED = 3.0      # m/s, the foot also has to leave the floor
MAX_SPEED = 16.0      # m/s; faster is a glitch of a lost point, not a limb
FOOT_LIFT = 0.2       # m above the floor
REACH = {'weapon': 1.0, 'leg': 0.0}  # blade beyond the hand, metres (a longsword's blade is 0.9–1.1 m)
REACHED = {'weapon': 0.5, 'leg': 0.35}  # closest distance counted as reaching the body; the blade is only a guess
TARGETS = {'head': ['nose', 'earL', 'earR'], 'trunk': ['shoulderL', 'shoulderR', 'hipL', 'hipR'],
           'armL': ['elbowL', 'wristL'], 'armR': ['elbowR', 'wristR'],
           'legL': ['kneeL', 'ankleL'], 'legR': ['kneeR', 'ankleR']}
ANSWER = 0.5          # s after the closest reach in which the other's answer is looked for
PARRY_SPEED = 2.0     # m/s of a hand that meets a strike
BACK_SPEED = 0.6      # m/s of a trunk that steps away


def shots_of(raw):
    p = raw.get('pair') or {}
    shots = p.get('shots') or [{'start': 0, 'end': len(raw['frames']) - 1, 'segments': (raw.get('scene') or {}).get('segments', [])}]
    return shots


def slice_raw(raw, shot):
    s0, s1 = shot['start'], shot['end']
    return {**raw, 'frames': raw['frames'][s0:s1 + 1], 'scene': {'segments': shot.get('segments', [])}}


def seen_mask(raw):
    return np.array([bool(f.get('world')) for f in raw['frames']])


def pick_shot(rawA, rawB, choice=None):
    shots = shots_of(rawA)
    if choice is not None:
        if not 0 <= choice < len(shots):
            raise SystemExit(f'Сцены {choice} нет: их {len(shots)}')
        return choice, shots[choice]
    a, b = seen_mask(rawA), seen_mask(rawB)
    both = [int((a[s['start']:s['end'] + 1] & b[s['start']:s['end'] + 1]).sum()) for s in shots]
    k = int(np.argmax(both))
    return k, shots[k]


def shared_up(rawA, rawB, opts):
    """One up for both: the room's lines when they were found for either
    person (the same lines, so the same answer), else the mean body up."""
    ups, scene = [], []
    for raw in (rawA, rawB):
        _, _, rep = C.clean(raw, **opts)
        ups.append((np.array(rep['up']), rep['found']))
        if 'sceneUp' in rep:
            scene.append(np.array(rep['sceneUp']))
    if scene:
        return C.unit(np.mean(scene, 0)), 'scene lines'
    v = sum(u * n for u, n in ups)
    return C.unit(v), 'both bodies'


def pelvis_floor(P):
    p = C.pelvis(P)
    return p[:, [0, 2]]


def to_pair_frame(PA, PB):
    """Origin between the two on the floor, x from A to B, y up, z = x × y."""
    a, b = pelvis_floor(PA), pelvis_floor(PB)
    d = np.median(b - a, 0)
    x = d / max(np.linalg.norm(d), 1e-9)
    o = np.median((a + b) / 2, 0)
    # (x, z) in the camera's floor plane → new x along d, new z = x × y.
    ex = np.array([x[0], 0.0, x[1]])
    ez = np.cross(ex, [0.0, 1.0, 0.0])
    R = np.stack([ex, [0.0, 1.0, 0.0], ez])
    shift = np.array([o[0], 0.0, o[1]])
    return [(P - shift) @ R.T for P in (PA, PB)]


def speed(X, fps):
    v = np.gradient(X, axis=0) * fps
    return np.linalg.norm(v, axis=-1), v


def peaks(s, thr):
    """Frames where the speed tops out over thr (the first frame of a flat top)."""
    return [t for t in range(1, len(s) - 1) if s[t] >= thr and s[t] > s[t - 1] and s[t] >= s[t + 1]]


def span(s, t, floor, frac=0.3):
    """The move around a speed peak: while the speed stays over a share of
    the peak and over `floor` (half the strike threshold)."""
    edge = max(s[t] * frac, floor)
    lo = hi = t
    while lo > 0 and s[lo - 1] > edge:
        lo -= 1
    while hi < len(s) - 1 and s[hi + 1] > edge:
        hi += 1
    return lo, hi


def nearest_part(points, Q):
    """The part of the other body nearest to any of `points`, and how near."""
    points = np.atleast_2d(points)
    best, part = np.inf, None
    for name, joints in TARGETS.items():
        d = float(np.linalg.norm(points[:, None] - Q[[C.I[j] for j in joints]][None], axis=-1).min())
        if d < best:
            best, part = d, name
    return part, float(best)


def blade(P, t, side, n=6):
    """Points of a blade guessed from the hand: along the forearm, from the
    wrist to REACH beyond it. A camera sees no blade, so this is the reach of
    the strike, not where the steel was."""
    w, e = P[t, C.I[f'wrist{side}']], P[t, C.I[f'elbow{side}']]
    return w + C.unit(w - e) * REACH['weapon'] * np.linspace(0, 1, n)[:, None]


def answer(Q, t0, fps, away):
    """How the other one answered within ANSWER s: hands fast (a parry or
    a block) and/or the trunk moving away (a step back)."""
    t1 = min(len(Q) - 1, t0 + int(round(ANSWER * fps)))
    if t1 <= t0:
        return {}
    hs = np.maximum(speed(Q[:, C.I['wristL']], fps)[0], speed(Q[:, C.I['wristR']], fps)[0])
    tv = speed(C.pelvis(Q), fps)[1]
    back = (tv[:, [0, 2]] @ away)
    out = {}
    h = t0 + int(np.argmax(hs[t0:t1 + 1]))
    if hs[h] > PARRY_SPEED:
        out['hands'] = {'at': h, 'speed': round(float(hs[h]), 2)}
    b = t0 + int(np.argmax(back[t0:t1 + 1]))
    if back[b] > BACK_SPEED:
        out['stepBack'] = {'at': b, 'speed': round(float(back[b]), 2)}
    return out


def strikes(people, fps, seen):
    """Strike candidates of each person against the other (see the module text)."""
    names = list(people)
    events = []
    for a, b in ((names[0], names[1]), (names[1], names[0])):
        P, Q = people[a], people[b]
        both = seen[a] & seen[b]
        to_b = C.pelvis(Q)[:, [0, 2]] - C.pelvis(P)[:, [0, 2]]
        for limb, joints, source in (('hands', ['wristL', 'wristR'], 'weapon'), ('footL', ['toeL'], 'leg'), ('footR', ['toeR'], 'leg')):
            S = np.stack([speed(P[:, C.I[j]], fps)[0] for j in joints], 0)
            side = np.argmax(S, 0)
            s = S.max(0)
            thr = HAND_SPEED if source == 'weapon' else FOOT_SPEED
            taken = []
            for t in sorted(peaks(np.where(s > MAX_SPEED, 0, s), thr), key=lambda t: -s[t]):
                if not both[t]:
                    continue
                lo, hi = span(s, t, thr / 2)
                if any(lo <= b1 and b0 <= hi for b0, b1 in taken):
                    continue  # the same move, a smaller peak of it
                taken.append((lo, hi))
                if source == 'leg':
                    foot = P[lo:hi + 1, C.I[joints[0]]]
                    if foot[:, 1].max() < FOOT_LIFT:
                        continue  # a step, not a kick
                    reach = [P[k, C.I[joints[0]]] for k in range(lo, hi + 1)]
                else:
                    sides = 'LR'
                    reach = [blade(P, k, sides[side[k]]) for k in range(lo, hi + 1)]
                # The moment of reach is where the limb stops: look a little past the move.
                hi2 = min(len(P) - 1, hi + int(round(0.1 * fps)))
                if source == 'leg':
                    reach += [P[k, C.I[joints[0]]] for k in range(hi + 1, hi2 + 1)]
                else:
                    reach += [blade(P, k, sides[side[k]]) for k in range(hi + 1, hi2 + 1)]
                dist = [nearest_part(r, Q[lo + k]) for k, r in enumerate(reach)]
                k = int(np.argmin([d for _, d in dist]))
                closest = lo + k
                # Towards the other: the reaching point gets closer to the other body.
                if dist[0][1] - dist[k][1] < 0.1:
                    continue
                away = C.unit(to_b[closest]) if np.linalg.norm(to_b[closest]) > 1e-6 else np.array([1.0, 0.0])
                ev = {'by': a, 'at': b, 'limb': limb, 'source': source, 'sourceGuessed': source == 'weapon',
                      'start': lo, 'reach': closest, 'end': hi,
                      'speed': round(float(s[t]), 2), 'target': dist[k][0], 'closest': round(dist[k][1], 3),
                      'reached': bool(dist[k][1] <= REACHED[source]),
                      'answer': answer(Q, closest, fps, away), 'outcome': None,
                      'kind': 'kick' if source == 'leg' else None}
                if source == 'weapon':
                    ev['hand'] = 'LR'[side[t]]
                events.append(ev)
    events.sort(key=lambda e: e['reach'])
    for i, e in enumerate(events):
        e['id'] = i + 1
    # A hand move that meets the other's arms while the other is striking is
    # the answer to that strike: a parry or a bind, not an attack of its own.
    window = int(round(ANSWER * fps))
    for e in events:
        if e['source'] != 'weapon' or not e['reached'] or not e['target'].startswith('arm'):
            continue
        met = [f for f in events if f['by'] == e['at'] and f['start'] <= e['reach'] <= f['reach'] + window]
        if met:  # the strike that came closest, nearest in time
            f = min(met, key=lambda f: (not f['reached'], abs(f['reach'] - e['reach'])))
            e['kind'], e['answers'] = 'parry', f['id']
    return events


def apply_notes(events, notes):
    """notes: {"3": {"source": "shield", "kind": "bash", "outcome": "parried"}, ...}
    or a list of such objects with "id"; a note may also add a strike
    ({"id": "extra-1", "by": "A", ...}) the speeds missed."""
    items = notes.items() if isinstance(notes, dict) else ((n.get('id'), n) for n in notes)
    byid = {str(e['id']): e for e in events}
    for k, n in items:
        e = byid.get(str(k))
        if e is None:
            e = {'id': k, 'added': True}
            events.append(e)
        e.update({x: v for x, v in n.items() if x != 'id'})
        if 'source' in n:
            e['sourceGuessed'] = False
    events.sort(key=lambda e: e.get('reach', 0))
    return events


def duel(rawA, rawB, shot=None, notes=None, **opts):
    k, sh = pick_shot(rawA, rawB, shot)
    A, B = slice_raw(rawA, sh), slice_raw(rawB, sh)
    seen = {'A': seen_mask(A), 'B': seen_mask(B)}
    if seen['A'].sum() < 2 or seen['B'].sum() < 2:
        raise SystemExit('В этой сцене нет обоих бойцов')
    up, up_from = shared_up(A, B, opts)
    PA, fps, repA = C.clean(A, up=up, up_from=up_from, **opts)
    PB, _, repB = C.clean(B, up=up, up_from=up_from, **opts)
    PA, PB = to_pair_frame(PA, PB)
    gap = np.linalg.norm(pelvis_floor(PB) - pelvis_floor(PA), axis=-1)[seen['A'] & seen['B']]
    people = {'A': PA, 'B': PB}
    events = strikes(people, fps, seen)
    if notes:
        events = apply_notes(events, notes)
    p = rawA.get('pair') or {}
    keep = ('floorFrom', 'tiltDeg', 'missingShare', 'longGaps', 'boneCV', 'skateBefore', 'skateAfter', 'contacts')
    return {
        'format': 'vmocap.pair', 'version': 1,
        'source': {**rawA['source'], 'shot': k, 'firstFrame': sh['start'], 'lastFrame': sh['end'], 'cuts': p.get('cuts', [])},
        'fps': fps, 'landmarks': C.NAMES,
        'axes': {'units': 'm', 'y': 'up, floor at 0', 'x': 'from A to B', 'z': 'x × y', 'origin': 'between the two on the floor',
                 'facing': {'A': '+x', 'B': '-x'}},
        'people': {n: {'frames': np.round(P, 4).tolist(), 'seen': seen[n].astype(int).tolist(),
                       'report': {x: r[x] for x in keep if x in r}}
                   for n, P, r in (('A', PA, repA), ('B', PB, repB))},
        'distance': {'median': round(float(np.median(gap)), 3), 'min': round(float(gap.min()), 3), 'max': round(float(gap.max()), 3)} if len(gap) else None,
        'strikes': events,
        'report': {'up': [round(float(v), 4) for v in up], 'upFrom': up_from,
                   'recovered': {'A': (rawA.get('pair') or {}).get('recovered'), 'B': (rawB.get('pair') or {}).get('recovered')},
                   'mergedDropped': p.get('merged'), 'bothSeen': int((seen['A'] & seen['B']).sum()), 'frames': len(PA)}}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('a')
    ap.add_argument('b')
    ap.add_argument('-o', '--out', required=True)
    ap.add_argument('--shot', type=int, help='номер сцены между склейками (по умолчанию — где оба видны дольше всего)')
    ap.add_argument('--notes', help='JSON с пометками ударов: источник (weapon, shield, leg…), вид, исход')
    ap.add_argument('--fov', type=float, default=C.DEFAULTS['fov'])
    a = ap.parse_args()
    notes = json.load(open(a.notes)) if a.notes else None
    out = duel(json.load(open(a.a)), json.load(open(a.b)), a.shot, notes, fov=a.fov)
    json.dump(out, open(a.out, 'w'), ensure_ascii=False, separators=(',', ':'))
    d, r = out['distance'], out['report']
    kinds = {}
    for e in out['strikes']:
        kinds[e.get('source')] = kinds.get(e.get('source'), 0) + 1
    print(f"сцена {out['source']['shot']} (кадры {out['source']['firstFrame']}–{out['source']['lastFrame']}): "
          f"оба видны в {r['bothSeen']} из {r['frames']}; верх — {r['upFrom']}; "
          f"дистанция {d['median'] if d else '—'} м ({d['min'] if d else '—'}–{d['max'] if d else '—'}); "
          f"ударов-кандидатов {len(out['strikes'])} {kinds} → {a.out}")


if __name__ == '__main__':
    main()
