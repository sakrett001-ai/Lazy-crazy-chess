#!/usr/bin/env python3
"""Поединок с видео (duel.py, vmocap.pair) → файл движений обмена ударами.

Из записи двоих берутся циклы «сближение — удар и ответ — разрыв». Каждый
цикл даёт два клипа: атакующего (side attack) и защитника (side defend),
оба с ролью exchange. gap — расстояние между тазами в начале цикла, м. Клипы пишутся в рамке своего бойца: таз в начале
цикла над началом координат, лицом к партнёру по +Z, y вверх, пол на 0
(frame 'shared' — доска не поворачивает их заново). Доска играет их на
месте каждой фигуры и сжимает сближение под расстояние между клетками.

В клипе лежат события в секундах от начала цикла: начало удара, касание
(reach), его конец, ответ защитника. Цикл с decisive: true — тот, где удар
дошёл без ответа: им взятие заканчивается.

    python3 tools/duels/build.py            # 516.pair.json → motions/duel-516.motion.json
"""
import json, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'videomocap'))
import clean as C  # noqa: E402
from motion import POINTS, key_points, neutral_frame  # noqa: E402

# Ролик 516: группа ВКонтакте @hemafansing, папка владельца «Расфехтовки»,
# 4,3–12,5 с исходного ролика (кадры записи 0–245 при 30 к/с). Два почти
# одинаковых цикла: на кадрах 38–118 укол A в голову (касание на 60) B
# парирует (63); на 118–205 удар A в голову доходит на 165 без ответа.
SOURCE = {'video': 'ВКонтакте @hemafansing, ролик 516 (папка «Расфехтовки»), 4,3–12,5 с',
          'license': 'учебное видео, платформа разрешает скачивание; поза — MediaPipe Pose (Apache-2.0)'}
CYCLES = [
    {'name': 'duel516.exchange', 'label': 'Обмен 516: укол и парирование', 'frames': (38, 118), 'strike': 4, 'parry': 5},
    {'name': 'duel516.decisive', 'label': 'Обмен 516: решающий удар', 'frames': (118, 205), 'strike': 11, 'decisive': True},
]


# Глубина у одной камеры шумит сильнее всего: весь человек целиком скачет
# вдоль оси камеры (ролик 516 — на линии бойцов), и таз за кадр уходит на
# 15–25 см, 5–7 м/с, хотя ни шаг, ни выпад с длинным мечом так не бегут.
# Поэтому путь таза по полу сглаживается и ограничивается по скорости, а всё
# тело сдвигается вместе с тазом (шум глубины сдвигает его целиком, стопы
# в опоре не скользят относительно таза). Предел — в длинах ноги в секунду,
# чтобы не зависеть от масштаба MediaPipe: 2,7 длины ноги в секунду — около
# 2,4 м/с у бойца ростом 180 см, верх шага-выпада.
ROOT_SIGMA = 1.5        # кадров, сглаживание пути таза
ROOT_MAX_SPEED = 2.7    # длин ноги в секунду


def leg_length(X):
    k = key_points(X)
    d = lambda a, b: np.linalg.norm(k[a] - k[b], axis=1)  # noqa: E731
    return float(np.median((d('hipL', 'kneeL') + d('kneeL', 'ankleL') + d('hipR', 'kneeR') + d('kneeR', 'ankleR')) / 2))


def steady_root(X, fps, sigma=ROOT_SIGMA, max_speed=ROOT_MAX_SPEED):
    """Pelvis path on the floor smoothed and speed-limited; the body moves with it.
    Returns the corrected frames and the largest shift, m."""
    P = C.pelvis(X)[:, [0, 2]]
    r = int(np.ceil(3 * sigma))
    w = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    w /= w.sum()
    Q = np.stack([np.convolve(np.pad(P[:, i], r, mode='edge'), w, mode='valid') for i in (0, 1)], 1)
    vmax = max_speed * leg_length(X) / fps
    V = np.diff(Q, axis=0)
    n = np.linalg.norm(V, axis=1, keepdims=True)
    V = V * np.minimum(1, vmax / np.maximum(n, 1e-9))
    S = np.vstack([Q[:1], Q[:1] + np.cumsum(V, axis=0)])
    # The speed limit shortens fast stretches; pull the path back onto the
    # smoothed one between them, never faster than the limit allows.
    for _ in range(50):
        E = Q - S
        step = np.diff(np.vstack([np.zeros((1, 2)), E]), axis=0) * 0.5
        T = S + np.cumsum(step, axis=0)
        V = np.diff(T, axis=0)
        n = np.linalg.norm(V, axis=1, keepdims=True)
        V = V * np.minimum(1, vmax / np.maximum(n, 1e-9))
        S = np.vstack([T[:1], T[:1] + np.cumsum(V, axis=0)])
    D = S - P
    Y = X.copy()
    Y[..., 0] += D[:, None, 0]
    Y[..., 2] += D[:, None, 1]
    return Y, float(np.abs(D).max())


# Поворот плеч против таза у одной камеры, снимающей бойцов сбоку, — самая
# плохо видимая величина: линия плеч лежит вдоль оси камеры, и её глубину
# MediaPipe оценивает наугад. В ролике 516 за 0,4 с плечи атакующего
# «обходят» вокруг корпуса на 250°, хотя таз поворачивается всего на 40°:
# так позвоночник не скручивается, на доске копьё разворачивалось назад.
# Скрутка грудного и поясничного отделов вместе — до 40–50° в каждую
# сторону (справочные амплитуды осевого вращения: грудной ~35°, поясничный
# ~5–10°), так что кадры со скруткой больше 90° — ошибка оценки, а не поза:
# их скрутка берётся между соседними надёжными кадрами, затем вся скрутка
# ограничивается TWIST_MAX и сглаживается. Верх тела (голова, плечи, руки)
# поворачивается вокруг вертикали через таз на поправку.
TWIST_MAX = 50.0     # градусов, предел скрутки плеч относительно таза
TWIST_REJECT = 90.0  # градусов, больше — ошибка оценки
TWIST_SIGMA = 2.0    # кадров
UPPER = [i for i, n in enumerate(C.NAMES) if not n.startswith(('hip', 'knee', 'ankle', 'heel', 'foot', 'toe'))]


def wrap(a):
    return (a + 180.0) % 360.0 - 180.0


def steady_twist(X, max_twist=TWIST_MAX, reject=TWIST_REJECT, sigma=TWIST_SIGMA):
    """Shoulder line kept within the spine's twist over the hips. Returns the
    corrected frames, the number of frames taken as estimation errors and the
    largest correction, degrees."""
    yaw = lambda a, b: np.degrees(np.arctan2(-(X[:, b, 2] - X[:, a, 2]), X[:, b, 0] - X[:, a, 0]))  # noqa: E731
    d = wrap(yaw(C.I['shoulderL'], C.I['shoulderR']) - yaw(C.I['hipL'], C.I['hipR']))
    ok = np.abs(d) <= reject
    idx = np.arange(len(d))
    want = np.interp(idx, idx[ok], d[ok]) if ok.any() else np.zeros_like(d)
    want = np.clip(want, -max_twist, max_twist)
    r = int(np.ceil(3 * sigma))
    w = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    want = np.convolve(np.pad(want, r, mode='edge'), w / w.sum(), mode='valid')
    rot = np.radians(wrap(want - d))
    Y = X.copy()
    o = C.pelvis(X)
    for f in range(len(X)):
        c, s = np.cos(rot[f]), np.sin(rot[f])
        v = X[f, UPPER] - o[f]
        # yaw() measures angles with z negated: a turn by +a there is x,z → (x cos a + z sin a, −x sin a + z cos a)
        Y[f, UPPER, 0] = o[f, 0] + v[:, 0] * c + v[:, 2] * s
        Y[f, UPPER, 2] = o[f, 2] - v[:, 0] * s + v[:, 2] * c
    return Y, int((~ok).sum()), float(np.degrees(np.abs(rot)).max())


def own_frame(X, facing):
    """Pair frame (x from A to B) → the fighter's frame: facing +x (A) or -x (B) onto +Z."""
    th = np.radians(-90.0 if facing > 0 else 90.0)
    R = np.array([[np.cos(th), 0, np.sin(th)], [0, 1, 0], [-np.sin(th), 0, np.cos(th)]])
    o = C.pelvis(X[:1])[0] * [1, 0, 1]
    return (X - o) @ R.T


def build(pair):
    fps = pair['fps']
    strikes = {s['id']: s for s in pair['strikes']}
    full = {n: np.asarray(pair['people'][n]['frames'], float) for n in ('A', 'B')}
    # Only the bout's own frames: the track's first frames (the person found
    # by the detector) may jump by metres and would drag the whole path.
    lo, hi, shift, twist = min(c['frames'][0] for c in CYCLES), max(c['frames'][1] for c in CYCLES) + 1, {}, {}
    for n in ('A', 'B'):
        full[n] = full[n].copy()
        Y, bad, most = steady_twist(full[n][lo:hi])
        full[n][lo:hi], twist[n] = Y, (bad, most)
        full[n][lo:hi], shift[n] = steady_root(full[n][lo:hi], fps)
    neutral = {}
    for n, X in full.items():
        i = neutral_frame(X, fps)
        neutral[n] = (i, np.stack([key_points(X[i:i + 1])[k][0] for k in POINTS]).round(4).reshape(-1).tolist())
    clips = []
    for cyc in CYCLES:
        a, b = cyc['frames']
        s = strikes[cyc['strike']]
        attacker, defender = s['by'], s['at']
        sec = lambda f: round((f - a) / fps, 3)  # noqa: E731
        strike = {'start': sec(s['start']), 'reach': sec(s['reach']), 'end': sec(max(s['end'], s['reach'])), 'target': s['target'], 'reached': s['reached']}
        parry = strikes.get(cyc.get('parry'))
        pa, pb = C.pelvis(full['A'][a:a + 1])[0], C.pelvis(full['B'][a:a + 1])[0]
        gap = round(float(np.hypot(pb[0] - pa[0], pb[2] - pa[2])), 3)  # pelvis to pelvis at the cycle's start, m
        for who, side in ((attacker, 'attack'), (defender, 'defend')):
            X = own_frame(full[who][a:b + 1], +1 if who == 'A' else -1)
            pts = key_points(X)
            events = {'strike': strike, 'gap': gap}
            if parry:
                events['parry'] = {'at': sec(parry['reach']), 'start': sec(parry['start'])}
            clips.append({'name': f"{cyc['name']}.{side}", 'label': f"{cyc['label']}: {'атакующий' if side == 'attack' else 'защитник'}",
                          'role': 'exchange', 'side': side, 'partner': f"{cyc['name']}.{'defend' if side == 'attack' else 'attack'}",
                          'person': who, 'loop': False, 'fps': fps, 'frames': len(X), 'frame': 'shared',
                          **({'decisive': True} if cyc.get('decisive') else {}), 'events': events,
                          'sourceFrames': [a, b], 'neutral': neutral[who][1],
                          'data': np.stack([pts[k] for k in POINTS], 1).round(4).reshape(-1).tolist()})
    src = {'kind': 'video', 'name': SOURCE['video'], 'license': SOURCE['license'],
           'note': 'Одна камера, двое: tools/videomocap (pair.py — кто есть кто, duel.py — общая сцена и удары). Расстояние между бойцами — по глубине камеры, без эталона.',
           'distance': pair.get('distance'), 'neutralFrames': {n: v[0] for n, v in neutral.items()},
           'root': {'sigmaFrames': ROOT_SIGMA, 'maxSpeedLegsPerSecond': ROOT_MAX_SPEED, 'maxShift': {n: round(v, 3) for n, v in shift.items()}},
           'twist': {'maxDegrees': TWIST_MAX, 'rejectDegrees': TWIST_REJECT, 'sigmaFrames': TWIST_SIGMA,
                     'rejectedFrames': {n: v[0] for n, v in twist.items()}, 'maxCorrectionDegrees': {n: round(v[1], 1) for n, v in twist.items()}}}
    return {'format': 'lazy-chess.motion', 'version': 1, 'source': src, 'points': POINTS, 'neutral': clips[0]['neutral'], 'clips': clips}


def main():
    root = os.path.dirname(os.path.dirname(HERE))
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '516.pair.json')
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(root, 'motions', 'duel-516.motion.json')
    f = build(json.load(open(src)))
    json.dump(f, open(out, 'w'), ensure_ascii=False, separators=(',', ':'))
    for c in f['clips']:
        print(f"{c['name']}: {c['frames']} кадров, {c['person']}, удар {c['events']['strike']}")
    print('→', out)


if __name__ == '__main__':
    main()
