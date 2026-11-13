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
import footwork as W  # noqa: E402
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


# У бойцов, снятых сбоку, ноги на скрестном шаге заслоняют друг друга, и
# MediaPipe путает, какая из них левая: в ролике 516 метки ног атакующего
# меняются местами на кадре 156, и стопа «перелетает» на 1,2 м за кадр.
# Чистка (tools/videomocap, шаг lengths) уже выровняла кости, так что нога
# переставляется только целиком — колено вместе со стопой: переставив одни
# стопы, голень стала бы длиннее своей на полметра и колено выгнулось бы
# назад. Метки ставятся по непрерывности, с этого кадра и дальше: если
# переставленные ноги ближе к предыдущему кадру почти вдвое (LEG_SWAP) и
# скачок не мелкий (LEG_SWAP_MIN), метки меняются.
LEG_SWAP = 0.6
LEG_SWAP_MIN = 0.1  # м за кадр на точку
LEG = ['knee', 'ankle', 'heel', 'toe']


def steady_legs(X, ratio=LEG_SWAP, least=LEG_SWAP_MIN):
    """Left and right leg labels kept continuous, each leg swapped whole.
    Returns the corrected frames and the frames where the labels were swapped."""
    Lx, Rx = [C.I[n + 'L'] for n in LEG], [C.I[n + 'R'] for n in LEG]
    Y = X.copy()
    swaps = []
    for f in range(1, len(Y)):
        p, q = Y[f - 1], Y[f]
        keep = np.linalg.norm(q[Lx] - p[Lx], axis=1).sum() + np.linalg.norm(q[Rx] - p[Rx], axis=1).sum()
        cross = np.linalg.norm(q[Lx] - p[Rx], axis=1).sum() + np.linalg.norm(q[Rx] - p[Lx], axis=1).sum()
        if cross < ratio * keep and keep / (2 * len(LEG)) > least:
            Y[f:, Lx], Y[f:, Rx] = Y[f:, Rx].copy(), Y[f:, Lx].copy()
            swaps.append(f)
    return Y, swaps


# Колено — шарнир: оно сгибается вперёд по линии стопы, а бедро может лишь
# повернуть эту линию относительно таза — наружу до 45°, внутрь до 35–45°
# (нормы подвижности тазобедренного сустава, AAOS). Камера сбоку не видит
# глубины, и у поднятой ноги MediaPipe уводит колено вбок от этой плоскости
# (в ролике 516 у атакующего перед решающим ударом — на 70–90°): колено
# сгибается в сторону, чего сустав не умеет. Колено поворачивается вокруг
# линии «бедро — лодыжка» в пределы HIP_ROT от направления таза вперёд;
# длины бедра и голени и стопа не меняются. Сама линия таза у камеры сбоку
# идёт почти вдоль глубины и тоже оценена грубо (у бойцов 516 направление
# колена от неё — ±60° в 5–95 % кадров), поэтому к 45° нормы добавлен запас
# 15° на эту ошибку: правятся только колени, ушедшие вбок явно.
HIP_ROT = 60.0  # градусов: 45° нормы AAOS + 15° на ошибку линии таза


def unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-9)


def steady_knees(X, limit=HIP_ROT):
    """Each knee turned about its hip-ankle line into the hinge plane the hip
    rotation allows. Returns the corrected frames, the number of leg frames
    corrected and the largest correction, degrees."""
    Y = X.copy()
    lat = X[:, C.I['hipR']] - X[:, C.I['hipL']]
    count, most = 0, 0.0
    for s in 'LR':
        H, K, A = X[:, C.I['hip' + s]], X[:, C.I['knee' + s]], X[:, C.I['ankle' + s]]
        u = unit(A - H)
        f = unit(np.cross(lat, u))
        g = np.cross(u, f)
        base = H + u * np.sum((K - H) * u, axis=1, keepdims=True)
        off = K - base
        ang = np.degrees(np.arctan2(np.sum(off * g, axis=1), np.sum(off * f, axis=1)))
        corr = np.radians(np.clip(ang, -limit, limit) - ang)
        corr[np.linalg.norm(off, axis=1) < 0.01] = 0
        c, n = np.cos(corr)[:, None], np.sin(corr)[:, None]
        Y[:, C.I['knee' + s]] = base + off * c + np.cross(u, off) * n
        count += int((np.abs(corr) > 1e-6).sum())
        most = max(most, float(np.degrees(np.abs(corr)).max()))
    return Y, count, most


# Голова у одной камеры, снимающей бойцов сбоку, оценена хуже всего тела:
# лицо видно в профиль, и MediaPipe путает, где глаза и уши, а их глубину
# берёт наугад. В ролике 516 голова атакующего по меткам повёрнута к груди
# на 110–180° и за кадр перескакивает на 171°: на доске она выворачивалась
# назад и болталась. Шея так не поворачивается: нормы подвижности шейного
# отдела — сгибание 50°, разгибание 60°, наклон вбок 45°, поворот 80° в
# каждую сторону (AMA Guides to the Evaluation of Permanent Impairment,
# 5-е изд., 2000). Направление головы поэтому берётся не из меток лица, а из
# того, что делает фехтовальщик: смотрит в глаза противнику (взгляд пары
# известен — оба в одной сцене), глаза держит ровно по горизонтали — голова
# стабилизирована по крену и против раскачки корпуса (Pozzo, Berthoz,
# Lefort, Exp Brain Res 1990). Поворот, наклон и крен головы относительно
# груди ограничиваются нормами (от стойки «вольно», от которой их мерит
# перенос на пешку) и сглаживаются, и точки лица (глаза, уши,
# нос, рот) ставятся по этой голове с пропорциями лица этого же бойца.
NECK_YAW = 80.0        # градусов, поворот головы к груди в каждую сторону
NECK_FLEX = 50.0       # градусов, наклон вперёд (подбородок к груди)
NECK_EXT = 60.0        # градусов, разгибание назад
NECK_ROLL = 45.0       # градусов, наклон вбок
HEAD_SIGMA = 2.0       # кадров
FACE = ['nose', 'eyeInnerL', 'eyeL', 'eyeOuterL', 'eyeInnerR', 'eyeR', 'eyeOuterR', 'earL', 'earR', 'mouthL', 'mouthR']


def chest_axes(X):
    """Chest frame as the retargeter has it (src/mocap/retarget.mjs, FRAMES.chest):
    left along the shoulder line, up from the chest to the neck, forward = left × up."""
    sl, sr = X[:, C.I['shoulderL']], X[:, C.I['shoulderR']]
    neck = (sl + sr) / 2
    pel = C.pelvis(X)
    chest = pel + (neck - pel) * 0.7
    left = unit(sl - sr)
    up = neck - chest
    up = unit(up - left * np.sum(up * left, axis=1, keepdims=True))
    return neck, left, up, np.cross(left, up)


def head_axes(yaw, pitch, roll, left, up, fwd):
    """Head forward, up and left from its yaw (to the left), pitch (forward,
    chin down) and roll (left ear down), degrees, against the chest frame."""
    y, p, r = (np.radians(a)[:, None] for a in (yaw, pitch, roll))
    f1 = fwd * np.cos(y) + left * np.sin(y)
    l1 = left * np.cos(y) - fwd * np.sin(y)
    f2 = f1 * np.cos(p) - up * np.sin(p)
    u2 = up * np.cos(p) + f1 * np.sin(p)
    u3 = u2 * np.cos(r) + l1 * np.sin(r)
    l3 = l1 * np.cos(r) - u2 * np.sin(r)
    return f2, u3, l3


def smooth(a, sigma):
    r = int(np.ceil(3 * sigma))
    w = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    return np.convolve(np.pad(a, r, mode='edge'), w / w.sum(), mode='valid')


def face_shape(X):
    """The fighter's face in head coordinates (forward, up, left from the ear
    midpoint), from the face's own proportions: ear-to-ear width (median over
    the clip, the steadiest face measure) and the share of each point."""
    w = float(np.median(np.linalg.norm(X[:, C.I['earL']] - X[:, C.I['earR']], axis=1)))
    # Face points in shares of the ear-to-ear width (an adult head: ears 15 cm
    # apart, eyes 6.3 cm apart and 9 cm before the ear line, nose tip 11 cm).
    s = {'nose': (0.75, -0.05, 0), 'eyeInner': (0.62, 0.05, 0.11), 'eye': (0.6, 0.05, 0.21), 'eyeOuter': (0.55, 0.05, 0.31),
         'ear': (0, 0, 0.5), 'mouth': (0.62, -0.4, 0.15)}
    out = {}
    for n in FACE:
        base, side = (n[:-1], n[-1]) if n[-1] in 'LR' and n != 'nose' else (n, '')
        f, u, l = s[base]
        out[n] = np.array([f, u, l if side == 'L' else -l if side == 'R' else 0.0]) * w
    return out


def place_face(X, f, u, l, offset, shape):
    """Face points of each frame from the head axes; the ear midpoint sits at
    the neck plus `offset` (forward, up in the head frame)."""
    Y = X.copy()
    neck = (X[:, C.I['shoulderL']] + X[:, C.I['shoulderR']]) / 2
    head = neck + f * offset[0] + u * offset[1]
    for n, (a, b, c) in shape.items():
        Y[:, C.I[n]] = head + f * a + u * b + l * c
    return Y


def head_offset(X):
    """Ear midpoint from the neck in the chest frame (forward, up): median
    over the clip — where this fighter carries the head over the shoulders."""
    neck, left, up, fwd = chest_axes(X)
    d = (X[:, C.I['earL']] + X[:, C.I['earR']]) / 2 - neck
    return np.array([float(np.median(np.sum(d * fwd, axis=1))), float(np.median(np.sum(d * up, axis=1)))])


def neutral_head(N):
    """Yaw and pitch of the neutral stance's head (straight ahead over the
    hips, level: straight_head) against its chest, degrees. The retargeter
    measures every turn from the neutral, and the figure's head sits straight
    over its chest at rest, so the figure's neck turns by the recorded turn
    less this one: the limits apply to that."""
    neck, left, up, fwd = chest_axes(N)
    lat = N[:, C.I['hipL']] - N[:, C.I['hipR']]
    g = np.cross(unit(lat * [1, 0, 1]), [0.0, 1.0, 0.0])
    return (float(np.degrees(np.arctan2(np.sum(g * left), np.sum(g * fwd)))),
            float(-np.degrees(np.arcsin(np.clip(np.sum(g * up), -1, 1)))))


def steady_head(X, partner, zero=(0.0, 0.0), sigma=HEAD_SIGMA):
    """The head looking into the partner's eyes, eyes level, within the neck's
    range and smoothed. Returns the frames, the face's shape and offset (for
    the neutral stance) and the largest turn of the tracked face that was
    replaced against the chest, degrees."""
    neck, left, up, fwd = chest_axes(X)
    off = head_offset(X)
    head = neck + fwd * off[0] + up * off[1]
    eyes = (partner[:, C.I['eyeL']] + partner[:, C.I['eyeR']]) / 2
    g = unit(eyes - head)
    yaw = np.degrees(np.arctan2(np.sum(g * left, axis=1), np.sum(g * fwd, axis=1)))
    pitch = -np.degrees(np.arcsin(np.clip(np.sum(g * up, axis=1), -1, 1)))
    # Eyes level: the roll that brings the head's left axis to the horizontal.
    f0, u0, l0 = head_axes(yaw, pitch, np.zeros_like(yaw), left, up, fwd)
    roll = np.degrees(np.arctan2(-l0[:, 1], u0[:, 1]))
    y0, p0 = zero
    yaw = smooth(np.clip(yaw, y0 - NECK_YAW, y0 + NECK_YAW), sigma)
    pitch = smooth(np.clip(pitch, p0 - NECK_EXT, p0 + NECK_FLEX), sigma)
    roll = smooth(np.clip(roll, -NECK_ROLL, NECK_ROLL), sigma)
    f, u, l = head_axes(yaw, pitch, roll, left, up, fwd)
    tracked = unit(X[:, C.I['eyeL']] + X[:, C.I['eyeR']] - X[:, C.I['earL']] - X[:, C.I['earR']])
    was = np.degrees(np.arctan2(np.sum(tracked * left, axis=1), np.sum(tracked * fwd, axis=1)))
    shape = face_shape(X)
    return place_face(X, f, u, l, off, shape), shape, off, float(np.abs(wrap(was)).max())


def straight_head(X, shape, offset):
    """A standing frame looking straight ahead over the hips, eyes level: the
    neutral stance the retargeter measures every head turn from. The figure's
    own rest looks that way (forward over the hips, level), so a head the
    recording turns by some angle from it turns the figure's head by the same."""
    lat = X[:, C.I['hipL']] - X[:, C.I['hipR']]
    l = unit(lat * [1, 0, 1])
    u = np.tile([0.0, 1.0, 0.0], (len(X), 1))
    f = np.cross(l, u)
    return place_face(X, f, u, l, offset, shape)


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
    lo, hi, shift, twist, swaps, knees, feet, plants = min(c['frames'][0] for c in CYCLES), max(c['frames'][1] for c in CYCLES) + 1, {}, {}, {}, {}, {}, {}
    for n in ('A', 'B'):
        full[n] = full[n].copy()
        Y, swaps[n] = steady_legs(full[n][lo:hi])
        swaps[n] = [lo + f for f in swaps[n]]
        Y, bad, most = steady_twist(Y)
        twist[n] = (bad, most)
        Y, kn, kmost = steady_knees(Y)
        knees[n] = (kn, kmost)
        full[n][lo:hi] = Y
        full[n][lo:hi], shift[n] = steady_root(full[n][lo:hi], fps)
        # Steady body and planted feet (footwork.py): without them the
        # figure trembles and its feet shuffle over the floor.
        full[n][lo:hi], stands, feet[n] = W.steady(full[n][lo:hi], fps)
        # The legs re-solved to the planted feet bend in the knees' smoothed
        # plane; it is kept within the hip's rotation again.
        full[n][lo:hi], _, _ = steady_knees(full[n][lo:hi])
        plants[n] = {s: [(lo + a, lo + b) for a, b in v] for s, v in stands.items()}
    # The heads last: they look at the partner's eyes, which must be placed first.
    # The neutral stance is chosen on the body before the heads change: the
    # limits are measured from it.
    faces, heads, pick = {}, {}, {n: neutral_frame(full[n], fps) for n in full}
    body = {n: full[n].copy() for n in full}
    for n, other in (('A', 'B'), ('B', 'A')):
        full[n][lo:hi], shape, off, heads[n] = steady_head(body[n][lo:hi], body[other][lo:hi], neutral_head(body[n][pick[n]:pick[n] + 1]))
        faces[n] = (shape, off)
    neutral = {}
    for n, X in full.items():
        i = pick[n]
        N = straight_head(X[i:i + 1], *faces[n])
        neutral[n] = (i, np.stack([key_points(N)[k][0] for k in POINTS]).round(4).reshape(-1).tolist())
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
            # Stands of each foot within the cycle, seconds: the board keeps
            # these feet where they stand while it fits the approach.
            own = {s: [[sec(max(t0, a)), sec(min(t1, b))] for t0, t1 in plants[who][s] if t1 >= a and t0 <= b and min(t1, b) > max(t0, a)] for s in C.SIDES}
            events = {'strike': strike, 'gap': gap, 'plants': own}
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
           'legs': {'swapRatio': LEG_SWAP, 'swappedAt': swaps},
           'knees': {'hipRotationDegrees': HIP_ROT, 'correctedLegFrames': {n: v[0] for n, v in knees.items()},
                     'maxCorrectionDegrees': {n: round(v[1], 1) for n, v in knees.items()}},
           'feet': {'bodySigmaFrames': W.BODY_SIGMA, 'pelvisSigmaFrames': W.PELVIS_SIGMA, 'plantCost': W.PLANT_COST, 'plantMinSeconds': W.PLANT_MIN,
                    'steps': {n: v['steps'] for n, v in feet.items()}, 'maxDropM': {n: v['maxDropM'] for n, v in feet.items()},
                    'standsMoved': {n: v['standsMoved'] for n, v in feet.items()}, 'shortFrames': {n: v['shortFrames'] for n, v in feet.items()}},
           'head': {'yawDegrees': NECK_YAW, 'flexionDegrees': NECK_FLEX, 'extensionDegrees': NECK_EXT, 'rollDegrees': NECK_ROLL,
                    'sigmaFrames': HEAD_SIGMA, 'gaze': 'partner eyes, eyes level',
                    'trackedFaceTurnMaxDegrees': {n: round(v, 1) for n, v in heads.items()}},
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
