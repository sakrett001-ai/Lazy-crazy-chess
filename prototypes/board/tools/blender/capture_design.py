"""A pawn takes a pawn: the body plan of both figures on the board's capture
timeline (src/choreography.mjs: CAPTURE_PHASES, HIT_TIME = 3.45 s,
CAPTURE_DURATION = 6.6 s). Plain Python, no Blender: pawn_capture.py solves
these controls on the pawn's rig.

Frame of the pair (the board's model frame): x to the attacker's left, y up,
z forward. The attacker starts at the origin facing +z; the defender stands
one diagonal square ahead (2.6 m * sqrt 2) facing back, -z.

Controls per figure and time: pelvis (position, yaw, pitch, roll), trunk
(bend forward, twist to the left, side bend to the left), head, and each
foot's ankle position with its yaw and toe pitch. The legs are solved by IK
to the feet, so a planted foot stays planted by construction.

Anatomical limits the plan is checked against (adult ranges, AAOS / Norkin &
White): knee flexion 0–140°, hip flexion −20…120°, ankle dorsiflexion 20° and
plantar flexion 50°, trunk rotation up to 45°, lateral flexion 30°, forward
flexion 80°. Step and stance figures: quick-time march 0.76 m at 2 steps/s;
a fencing lunge advances the front foot 0.4–0.6 m with the front shin near
vertical and the rear leg straight.
"""

from __future__ import annotations

import math

SQUARE = 2.6
DISTANCE = SQUARE * math.sqrt(2)  # pawns take diagonally
HIT_TIME = 3.45
DURATION = 6.6
FPS = 30

# The pawn's rest stance (guard, left foot forward), model frame, metres:
# from white-pawn.glb (tests/pawn-rest.mjs).
REST = {
    "pelvis": (0.0, 0.909, -0.066),
    "ankleL": (0.206, 0.074, 0.116),
    "ankleR": (-0.206, 0.074, -0.084),
}
STANCE = REST["ankleL"][2] - REST["ankleR"][2]  # lead foot this far ahead (0.2 m)


def clamp(v, a=0.0, b=1.0):
    return min(b, max(a, v))


def smooth(t, a, b):
    u = clamp((t - a) / (b - a))
    return u * u * (3 - 2 * u)


def bump(t, a, b):
    return 0.0 if t <= a or t >= b else math.sin(math.pi * (t - a) / (b - a))


def swing_shape(t, t0, t1):
    """Progress, lift and toe pitch of one drill-step swing. The leg is carried forward
    first and the foot comes down last: it reaches its place by 85 % of the swing, the
    lift peaks at about 60 % and the sole lands flat (строевой шаг: the foot is raised
    15–20 cm and set down on the whole sole)."""
    u = clamp((t - t0) / (t1 - t0))
    if u <= 0 or u >= 1:
        return (0.0 if u <= 0 else 1.0), 0.0, 0.0
    progress = smooth(u, 0.18, 0.85)  # toe-off first, then the leg is carried forward
    lift = math.sin(math.pi * u ** 1.4)
    pitch = HEEL_OFF * (1 - smooth(u, 0.0, 0.45))  # the foot levels out in the air
    return progress, lift, pitch


HEEL_OFF = -0.35  # toe pitch at toe-off: the heel leaves the board in late stance


def leapfrog(start_rear, distance, t0, t1, lift, overlap=0.06):
    """Drill steps from the guard stance (left foot STANCE ahead) that carry the stance
    `distance` forward. The left foot leads off, as in the drill manual; the swings
    alternate, each landing one even step past the other foot, and the last one closes
    to the guard stagger. Returns [(foot, t0, t1, z0, z1, lift)]."""
    pos = {"L": start_rear + STANCE, "R": start_rear}
    final = {"L": start_rear + distance + STANCE, "R": start_rear + distance}
    n = 3
    while distance / (n - 1) > 0.8:  # a drill step is 0.7–0.8 m (Строевой устав ВС РФ)
        n += 2
    step = distance / (n - 1)
    span = (t1 - t0) / n
    swings, foot = [], "L"
    for i in range(n):
        other = "R" if foot == "L" else "L"
        land = final[foot] if i >= n - 2 else pos[other] + step
        swings.append((foot, t0 + i * span, t0 + (i + 1) * span + overlap, pos[foot], land, lift))
        pos[foot] = land
        foot = other
    return swings


def feet_at(t, swings, start_rear):
    z = {"L": start_rear + STANCE, "R": start_rear}
    lift = {"L": 0.0, "R": 0.0}
    pitch = {"L": 0.0, "R": 0.0}
    for foot, t0, t1, z0, z1, h in swings:
        if t < t0:
            # Terminal stance: the heel rises over the last third of the step before
            # this swing, so the ankle is not forced past its dorsiflexion range.
            pitch[foot] = min(pitch[foot], HEEL_OFF * smooth(t, t0 - 0.3 * (t1 - t0), t0)) if t > t0 - 0.3 * (t1 - t0) else pitch[foot]
            continue
        p, l, k = swing_shape(t, t0, t1)
        z[foot] = z0 + (z1 - z0) * p
        lift[foot] = h * l
        pitch[foot] = k
    return z, lift, pitch


# Approach and lunge; pawn_capture.py --aim solves APPROACH, STRIKE_YAW and STRIKE_BEND so
# the board's spear tip meets the open flank at HIT_TIME and prints the values to put here.
APPROACH = 1.193
LUNGE = 0.42      # lead foot advance in the lunge (fencing lunge: 0.4–0.6 m)
STRIKE_YAW = 0.2177  # extra turn of the body to the left at the hit, radians
STRIKE_BEND = 0.0554  # trunk bend at the hit against the pelvis tilt: sets the tip height, radians
# The feint threatens the defender's open right side; its shield swings across to meet the
# tip, which opens the left flank for the strike. --aim solves both so the tip stops just
# short of the arriving shield.
FEINT_YAW = 0.4081   # turn of the body to the left in the feint, radians
FEINT_STEP = 0.0988  # lead foot stamp in the feint, metres
MARCH_LIFT = 0.15
CHAMBER = 0.10  # pelvis back over the rear leg before the lunge, metres
LEAD_TURN = 0.5  # share of the body's turn the lead foot takes


def attacker_swings(approach):
    early = leapfrog(0.0, approach, 0.35, 1.9, MARCH_LIFT)
    late = leapfrog(approach, DISTANCE - approach, 4.45, 6.5, 0.10)
    return early, late


def attacker(t, approach=APPROACH, strike_yaw=STRIKE_YAW, strike_bend=STRIKE_BEND,
             feint_yaw=FEINT_YAW, feint_step=FEINT_STEP, lunge=LUNGE):
    rest_l, rest_r = REST["ankleL"], REST["ankleR"]
    early, late = attacker_swings(approach)
    z, lift, pitch = feet_at(t, early + late, 0.0)
    for f in "LR":  # offsets from the rest stance
        z[f] -= STANCE if f == "L" else 0.0
    # Feint: the lead foot stamps; lunge: it drives forward; recovery: it returns
    # before the advance onto the square (late swings start from the recovered stance).
    stamp = feint_step * smooth(t, 2.35, 2.52)
    drive = lunge * smooth(t, 3.05, 3.38)
    back = (stamp + drive) * smooth(t, 3.85, 4.4)
    lead = stamp + drive - back
    z["L"] += lead
    lift["L"] += 0.05 * bump(t, 2.35, 2.52) + 0.07 * bump(t, 3.05, 3.36) + 0.05 * bump(t, 3.85, 4.4)
    # Rear heel rises as the rear leg straightens in the lunge; the ball stays down.
    lunge_u = smooth(t, 3.05, 3.42) * (1 - smooth(t, 3.85, 4.4))
    # The lead foot turns towards the thrust while it is in the air (stamp, drive, return),
    # taking half the body's turn so the front hip is not wound in.
    lead_yaw = LEAD_TURN * (feint_yaw * smooth(t, 2.35, 2.52) * (1 - smooth(t, 3.05, 3.36))
                            + (0.45 + strike_yaw) * smooth(t, 3.05, 3.36)) * (1 - smooth(t, 3.85, 4.4))
    feet = {
        "L": {"pos": (rest_l[0], rest_l[1] + lift["L"], rest_l[2] + z["L"]), "yaw": lead_yaw, "pitch": pitch["L"]},
        "R": {"pos": (rest_r[0], rest_r[1] + lift["R"], rest_r[2] + z["R"]), "yaw": 0.0, "pitch": pitch["R"] - 0.5 * lunge_u},
    }
    mid_z = (z["L"] + z["R"]) / 2
    guard = smooth(t, 0, 0.5) * (1 - smooth(t, 5.9, 6.5))
    coil = smooth(t, 1.95, 2.35) * (1 - smooth(t, 2.35, 2.55))
    feint = smooth(t, 2.35, 2.55) * (1 - smooth(t, 2.95, 3.15))
    # Before the lunge the weight goes back onto the rear leg; the tip comes back clear of
    # the shield before it goes round its edge.
    chamber = smooth(t, 2.85, 3.02) * (1 - smooth(t, 3.05, 3.3))
    # The body turns from the feint onto the strike line while it draws back, before the
    # drive: the tip goes round the shield's edge first and then in.
    line_u = smooth(t, 2.9, 3.15) * (1 - smooth(t, 3.85, 4.4))
    # The feint's turn is taken in the coil, so the thrust then goes straight in.
    turn = smooth(t, 2.05, 2.35) * (1 - smooth(t, 2.9, 3.15))
    tau = t - HIT_TIME
    recoil = 0.04 * (1 - math.exp(-tau / 0.035)) * math.exp(-tau / 0.2) if tau > 0 else 0.0
    sway, bob = 0.0, 0.0
    for foot, t0, t1, _, _, _ in early + late:
        sway += 0.03 * (-1 if foot == "L" else 1) * bump(t, t0, t1)  # over the stance foot
        bob += -0.015 * bump(t, t0 - 0.04, t0 + 0.12)  # loading response after each landing
    pelvis = (
        sway * (1 - lunge_u),
        REST["pelvis"][1] - 0.04 * guard - 0.035 * coil - 0.05 * lunge_u + bob,
        REST["pelvis"][2] + mid_z - 0.08 * coil + 0.05 * feint - CHAMBER * chamber + 0.12 * lead - recoil,  # pelvis ~60 % of the lead foot
    )
    return {
        "pelvis": pelvis,
        # In the lunge the pelvis opens to the left (the right hip drives through) and
        # tilts forward, which keeps the extended rear hip within its range; the trunk
        # turns back against it so the chest, and the spear, stay on the line.
        "yaw": -0.06 * coil + feint_yaw * turn + (0.45 + strike_yaw) * line_u,
        "pitch": 0.10 * lunge_u,
        "roll": 0.0,
        "trunk": {"bend": 0.05 * guard - 0.04 * coil + strike_bend * lunge_u, "twist": -0.15 * coil + 0.12 * feint - 0.30 * line_u, "side": 0.0},
        "head": {"bend": -0.03 * lunge_u, "twist": 0.12 * coil - 0.06 * feint + 0.10 * lunge_u},
        "feet": feet,
    }


def defender_local(t):
    """The defender in its own frame: at the origin facing +z, the attacker ahead."""
    rest_l, rest_r = REST["ankleL"], REST["ankleR"]
    guard = smooth(t, 0.5, 1.1)
    # The cover answers the attacker's coil (from 1.95 s, about 0.25 s visual reaction), so
    # the shield is across before the feint's tip arrives instead of sweeping into the shaft.
    cover = smooth(t, 2.2, 2.55)
    cover_step = smooth(t, 2.22, 2.44)  # the right foot steps back inside its lift
    tau = t - HIT_TIME
    untwist = smooth(tau, 0.4, 0.9)  # the shield side turns back only once the spear is out
    jolt = smooth(tau, 0, 0.12) + 0.25 * bump(tau, 0.08, 0.4) if tau > 0 else 0.0
    fold = smooth(tau, 0, 0.2) + 0.2 * bump(tau, 0.12, 0.5) if tau > 0 else 0.0
    sag = clamp((tau - 0.25) / 0.8) ** 2 if tau > 0 else 0.0
    stagger = smooth(tau, 0.12, 0.36)
    # Local frame of the defender: x its left, z its forward (towards the attacker).
    # The blow comes from the front-right... the open flank is its left side, so the push
    # goes back and to its right.
    push = (-0.35, -0.94)
    foot_r = (rest_r[0] - 0.09 * cover_step + push[0] * 0.13 * stagger, rest_r[1] + 0.06 * bump(t, 2.2, 2.48) + 0.07 * bump(tau, 0.1, 0.4), rest_r[2] + push[1] * 0.13 * stagger)
    local = {
        "pelvis": (-0.06 * cover + push[0] * (0.13 * jolt + 0.08 * sag), REST["pelvis"][1] - 0.05 * guard - 0.36 * sag, REST["pelvis"][2] + push[1] * (0.13 * jolt + 0.08 * sag)),
        "yaw": -0.3 * cover * (1 - 0.5 * untwist),
        "pitch": 0.1 * sag,
        "roll": 0.0,
        "trunk": {"bend": 0.06 * guard + 0.32 * fold + 0.22 * sag, "twist": -0.45 * cover * (1 - 0.6 * untwist) + 0.15 * fold, "side": 0.2 * fold},
        "head": {"bend": 0.22 * fold + 0.2 * sag, "twist": -0.25 * cover * (1 - untwist) + 0.1 * fold},
        "feet": {
            # As the knees give way the heels come up and the body drops onto the balls.
            "L": {"pos": rest_l, "yaw": 0.0, "pitch": -0.6 * sag},
            "R": {"pos": foot_r, "yaw": 0.0, "pitch": -0.3 * bump(tau, 0.1, 0.4) - 0.6 * sag},
        },
    }
    return local


def defender(t):
    """The defender at (0, DISTANCE) facing -z, in the pair's frame."""
    return to_pair(defender_local(t), (0.0, DISTANCE), math.pi)


def to_pair(local, origin, yaw):
    """A figure's local plan placed at origin (x, z) and turned by yaw about +y."""
    c, s = math.cos(yaw), math.sin(yaw)
    turn = lambda p: (origin[0] + c * p[0] + s * p[2], p[1], origin[1] - s * p[0] + c * p[2])
    out = dict(local)
    out["pelvis"] = turn(local["pelvis"])
    out["yaw"] = local["yaw"] + yaw
    out["feet"] = {f: {**v, "pos": turn(v["pos"]), "yaw": v["yaw"] + yaw} for f, v in local["feet"].items()}
    return out


def frames(fps=FPS):
    count = int(round(DURATION * fps)) + 1
    return [i / fps for i in range(count)]
