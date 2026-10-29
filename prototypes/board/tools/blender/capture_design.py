"""A pawn takes a pawn: the body and arm plan of both figures on the board's capture
timeline (src/choreography.mjs: HIT_TIME = 3.45 s, CAPTURE_DURATION = 6.6 s). Plain
Python, no Blender: pawn_capture.py solves these controls on the pawn's rig.

Frame of the pair (the board's model frame): x to the attacker's left, y up, z forward.
The attacker starts at the origin facing +z; the defender stands one diagonal square
ahead (2.6 m * sqrt 2) facing back, -z.

Controls per figure and time: pelvis (position, yaw, pitch, roll), trunk (bend forward,
twist to the left, side bend to the left), head offsets on top of the gaze, each foot's
ankle position with its yaw and toe pitch, and the arms: the spear's aim, thrust and
turn and the shield's swing and raise about the shoulder (white-pawn/src/loadout.mjs,
poseAt). The legs are solved by IK to the feet, so a planted foot stays planted by
construction; the head is turned onto the opponent within the neck's range.

What happens (the defender is a fighter, not a target):
  0.0–1.1  both take guard: spear level at the opponent, shield square to the threat.
  0.35–1.9 the attacker closes in drill step; the defender settles behind its shield.
  1.2–1.9  the defender counter-thrusts with a short lunge as the attacker comes into reach; the point meets the attacker's
           shield and the shield beats it aside (the shaft rides up and out).
  2.35–2.8 the attacker feints at the defender's right; its shield follows the threat
           across the body, which is what opens its left flank.
  2.9–3.45 the attacker turns onto the open line and lunges: the point enters the flank.
  3.45–5.0 the defender is driven back two steps and goes down onto both knees, folding
           over the wound; its shield arm drops and the spear point sinks to the board.
  4.6–6.5  the attacker recovers, watches, and advances onto the square.

Smoothness: every transition is a quintic smootherstep (continuous velocity and
acceleration) or a C2 bump; phases overlap (the trunk follows the pelvis, the spear
follows the trunk), so no channel starts or stops with a jerk.

Anatomical limits the plan is checked against (adult ranges, AAOS / Norkin & White):
knee flexion 0–140°, hip flexion −20…120°, ankle dorsiflexion 35° under load and
plantar flexion 50°, trunk rotation up to 45°, lateral flexion 30°, forward flexion 80°,
neck rotation 70°, flexion 45° and extension 45°. Step and stance figures: quick-time
march 0.76 m at 2 steps/s; a fencing lunge advances the front foot 0.4–0.6 m with the
front shin near vertical and the rear leg straight.
"""

from __future__ import annotations

import math

SQUARE = 2.6
DISTANCE = SQUARE * math.sqrt(2)  # pawns take diagonally
HIT_TIME = 3.45
DURATION = 6.6
FPS = 30
FADE = (4.95, 5.45)  # the taken pawn fades out after its collapse (seconds)
COUNTER_TIME = 1.6689  # the defender's counter-thrust meets the attacker's shield (solved by --aim:
                     # the defender strikes as the attacker comes into its reach)

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
    """Quintic smootherstep: zero velocity and acceleration at both ends."""
    u = clamp((t - a) / (b - a))
    return u * u * u * (u * (u * 6 - 15) + 10)


def bump(t, a, b):
    """0 → 1 → 0 over [a, b], peak in the middle, with zero velocity and acceleration at
    both ends (64 u³ (1 − u)³)."""
    if t <= a or t >= b:
        return 0.0
    u = (t - a) / (b - a)
    return 64 * (u * (1 - u)) ** 3


def hold(t, a, b, c, d):
    """Rises over [a, b], holds, falls over [c, d]."""
    return smooth(t, a, b) * (1 - smooth(t, c, d))


HEEL_OFF = -0.35  # toe pitch at toe-off: the heel leaves the board in late stance


def swing_shape(t, t0, t1):
    """Progress, lift and toe pitch of one drill-step swing. The leg is carried forward
    first and the foot comes down last: it reaches its place by 85 % of the swing, the
    lift peaks at about 60 % and the sole lands flat (строевой шаг: the foot is raised
    15–20 cm and set down on the whole sole)."""
    u = clamp((t - t0) / (t1 - t0))
    if u <= 0 or u >= 1:
        return (0.0 if u <= 0 else 1.0), 0.0, 0.0
    progress = smooth(u, 0.18, 0.85)  # toe-off first, then the leg is carried forward
    lift = bump(u ** 1.4, 0, 1)
    pitch = HEEL_OFF * (1 - smooth(u, 0.0, 0.45))  # the foot levels out in the air
    return progress, lift, pitch


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
            if t > t0 - 0.3 * (t1 - t0):
                pitch[foot] = min(pitch[foot], HEEL_OFF * smooth(t, t0 - 0.3 * (t1 - t0), t0))
            continue
        p, l, k = swing_shape(t, t0, t1)
        z[foot] = z0 + (z1 - z0) * p
        lift[foot] = h * l
        pitch[foot] = k
    return z, lift, pitch


# ---------------------------------------------------------------------------------------
# The attacker. pawn_capture.py --aim solves APPROACH, STRIKE_YAW and STRIKE_BEND so the
# board's spear tip meets the open flank at HIT_TIME, and FEINT_YAW and FEINT_REACH so the
# feint's point stops just short of the defender's arriving shield.
APPROACH = 1.2003
LUNGE = 0.55      # lead foot advance in the lunge (fencing lunge: 0.4–0.6 m)
STRIKE_YAW = 0.0866  # extra turn of the body to the left at the hit, radians
STRIKE_BEND = 0.0106  # trunk bend at the hit against the pelvis tilt: sets the tip height, radians
FEINT_YAW = 0.2503   # turn of the body to the left in the feint, radians
FEINT_STEP = 0.08    # the feint's stamp: the lead foot lifts and stamps a little forward
FEINT_REACH = 0.85   # how far the feint's thrust goes, as a share of the full thrust
MARCH_LIFT = 0.15
CHAMBER = 0.10  # pelvis back over the rear leg before the lunge, metres
LEAD_TURN = 0.5  # share of the body's turn the lead foot takes
MARCH_RAISE = 0.0  # shield raised while marching so the knee clears its lower edge, radians
ADVANCE = (4.6, 6.5)  # the advance onto the square, once the defender is down


def attacker_swings(approach):
    early = leapfrog(0.0, approach, 0.35, 1.9, MARCH_LIFT)
    late = leapfrog(approach, DISTANCE - approach, ADVANCE[0], ADVANCE[1], 0.10)
    return early, late


def attacker(t, approach=APPROACH, strike_yaw=STRIKE_YAW, strike_bend=STRIKE_BEND,
             feint_yaw=FEINT_YAW, feint_step=FEINT_STEP, lunge=LUNGE, march_raise=MARCH_RAISE,
             counter_time=COUNTER_TIME, feint_reach=FEINT_REACH, **_):
    rest_l, rest_r = REST["ankleL"], REST["ankleR"]
    early, late = attacker_swings(approach)
    z, lift, pitch = feet_at(t, early + late, 0.0)
    for f in "LR":  # offsets from the rest stance
        z[f] -= STANCE if f == "L" else 0.0
    # Feint: the lead foot stamps; lunge: it drives forward; recovery: it returns
    # before the advance onto the square (late swings start from the recovered stance).
    stamp = feint_step * smooth(t, 2.33, 2.52)
    drive = lunge * smooth(t, 3.06, 3.36)
    back = (stamp + drive) * smooth(t, 3.9, 4.4)
    lead = stamp + drive - back
    z["L"] += lead
    # The foot is lifted a little longer than it travels, so it never slides on the board.
    lift["L"] += 0.05 * bump(t, 2.33, 2.52) + 0.07 * bump(t, 3.03, 3.40) + 0.05 * bump(t, 3.85, 4.45)
    # Rear heel rises as the rear leg straightens in the lunge; the ball stays down.
    lunge_u = hold(t, 3.05, 3.42, 3.85, 4.45)
    # The lead foot turns towards the thrust while it is in the air (stamp, drive, return),
    # taking half the body's turn so the front hip is not wound in.
    lead_yaw = LEAD_TURN * (feint_yaw * hold(t, 2.33, 2.52, 3.04, 3.36)
                            + (0.45 + strike_yaw) * smooth(t, 3.04, 3.36)) * (1 - smooth(t, 3.85, 4.45))
    feet = {
        "L": {"pos": (rest_l[0], rest_l[1] + lift["L"], rest_l[2] + z["L"]), "yaw": lead_yaw, "pitch": pitch["L"]},
        "R": {"pos": (rest_r[0], rest_r[1] + lift["R"], rest_r[2] + z["R"]), "yaw": 0.0, "pitch": pitch["R"] - 0.5 * lunge_u},
    }
    mid_z = (z["L"] + z["R"]) / 2
    guard = smooth(t, 0, 0.5) * (1 - smooth(t, 5.9, 6.5))
    coil = hold(t, 1.95, 2.35, 2.33, 2.55)
    feint = hold(t, 2.35, 2.55, 2.95, 3.15)
    # Before the lunge the weight goes back onto the rear leg; the tip comes back clear of
    # the shield before it goes round its edge.
    chamber = hold(t, 2.85, 3.02, 3.04, 3.3)
    # The body turns from the feint onto the strike line while it draws back, before the
    # drive: the tip goes round the shield's edge first and then in. The pelvis leads, the
    # trunk follows it 40 ms later.
    line_u = hold(t, 2.9, 3.15, 3.85, 4.45)
    line_t = hold(t, 2.94, 3.19, 3.9, 4.5)
    # The feint's turn is taken in the coil, so the thrust then goes straight in.
    turn = hold(t, 2.05, 2.35, 2.9, 3.15)
    tau = t - HIT_TIME
    recoil = 0.04 * bump(tau, 0, 0.35)  # the shaft meets the body: a short check backwards
    sway, bob = 0.0, 0.0
    for foot, t0, t1, _, _, _ in early + late:
        sway += 0.03 * (-1 if foot == "L" else 1) * bump(t, t0, t1)  # over the stance foot
        bob += -0.015 * bump(t, t0 - 0.04, t0 + 0.16)  # loading response after each landing
    pelvis = (
        sway * (1 - lunge_u),
        REST["pelvis"][1] - 0.04 * guard - 0.035 * coil - 0.05 * lunge_u + bob,
        REST["pelvis"][2] + mid_z - 0.08 * coil + 0.05 * feint - CHAMBER * chamber + 0.12 * lead - recoil,  # pelvis ~60 % of the lead foot
    )
    # Arms. The spear comes to the aim as the attacker sets for the attack and goes back
    # to the guard once the defender is down; the feint is a part thrust, the strike a
    # full one that follows the lunge's drive by 50 ms (the shaft lags the body).
    aim = hold(t, 1.9, 2.3, 4.0, 4.5)
    thrust = feint_reach * hold(t, 2.35, 2.55, 2.9, 3.1) + hold(t, 3.1, 3.42, 3.72, 4.1)
    # The shield meets the counter-thrust and beats it outwards (to the attacker's left),
    # then comes back square; while marching it rides higher so the knee clears it.
    ct = counter_time
    swing = 0.30 * hold(t, ct - 0.02, ct + 0.14, ct + 0.16, ct + 0.45)
    march = hold(t, 0.25, 0.5, 1.75, 2.0) + hold(t, ADVANCE[0] - 0.15, ADVANCE[0] + 0.1, ADVANCE[1] - 0.1, ADVANCE[1] + 0.05)
    raise_ = march_raise * march + 0.06 * hold(t, ct - 0.2, ct, ct + 0.1, ct + 0.4)
    # The gaze stays on the defender until it is gone, then goes ahead.
    look = 1 - smooth(t, FADE[1], FADE[1] + 0.4)
    return {
        "pelvis": pelvis,
        # In the lunge the pelvis opens to the left (the right hip drives through) and
        # tilts forward, which keeps the extended rear hip within its range; the trunk
        # turns back against it so the chest, and the spear, stay on the line.
        "yaw": -0.06 * coil + feint_yaw * turn + (0.45 + strike_yaw) * line_u,
        "pitch": 0.10 * lunge_u,
        "roll": 0.0,
        "trunk": {"bend": 0.05 * guard - 0.04 * coil + strike_bend * lunge_u,
                  "twist": -0.15 * coil + 0.12 * feint - 0.30 * line_t, "side": 0.0},
        "head": {"bend": 0.0, "twist": 0.0, "look": look},
        "arms": {"aim": aim, "thrust": thrust, "turn": 0.0, "swing": swing, "raise": raise_},
        "feet": feet,
    }


# ---------------------------------------------------------------------------------------
# The defender, in its own frame: at the origin facing +z, the attacker ahead. Its left
# is +x, so the attacker's feint at its right side comes from -x. --aim solves GUARD_YAW
# so the guard's spear lies on the attacker, and COUNTER_TIME, COUNTER_YAW and
# COUNTER_BEND so the counter-thrust's point stops on the attacker's shield: the
# defender lunges a short step as the attacker comes into its reach.
GUARD_YAW = 0.2634
COUNTER_STEP = 0.2
COUNTER_YAW = -0.0088
COUNTER_BEND = 0.0425
FEINT_SWING = -0.3  # across to its right, as far as the shield goes in front of the chest (raised clear of the thighs) without meeting the trunk or its own spear
KNEEL = {"pelvis_y": 0.575, "pelvis_z": 0.16, "pitch": -1.3}  # on both knees, toes tucked


def defender_local(t, guard_yaw=GUARD_YAW, counter_step=COUNTER_STEP, counter_yaw=COUNTER_YAW,
                   counter_bend=COUNTER_BEND, counter_time=COUNTER_TIME, **_):
    rest_l, rest_r = REST["ankleL"], REST["ankleR"]
    guard = smooth(t, 0.5, 1.1)
    # Approach: settles lower behind the shield as the attacker closes.
    settle = smooth(t, 1.3, 1.75)
    # Counter-thrust: a short lunge off the lead foot, the point on the attacker's shield
    # at COUNTER_TIME; the beat throws the shaft up and out, the foot comes back.
    ct = counter_time
    step = counter_step * hold(t, ct - 0.38, ct - 0.06, ct + 0.12, ct + 0.45)
    lunge = hold(t, ct - 0.36, ct - 0.04, ct + 0.1, ct + 0.45)
    thrust = hold(t, ct - 0.32, ct - 0.01, ct + 0.0, ct + 0.3)
    beaten = smooth(t, ct, ct + 0.22)  # the shaft is knocked up and out and stays high
    knocked = bump(t, ct, ct + 0.55)    # the push of the beat on the shoulders
    # Feint: the shield follows the threat across to the right from 120 ms after it
    # starts (reaction time), the shoulders go a little with it.
    cover = smooth(t, 2.47, 2.75)
    cover_t = smooth(t, 2.52, 2.82)
    tau = t - HIT_TIME
    # The blow: the body is driven back and folds over the wound in its left flank.
    jolt = smooth(tau, 0, 0.14)
    fold = smooth(tau, 0.02, 0.25) + 0.2 * bump(tau, 0.1, 0.5)
    back_r = smooth(tau, 0.1, 0.4)     # the rear foot steps back under the push
    back_l = smooth(tau, 0.35, 0.65)   # then the lead foot follows
    kneel = smooth(tau, 0.55, 1.2)     # the knees give and come to the board
    slump = smooth(tau, 0.9, 1.6)
    push = (-0.25, -0.97)  # back and to its right, away from the thrust
    foot_l = (rest_l[0],
              rest_l[1] + 0.04 * bump(t, ct - 0.38, ct - 0.06) + 0.035 * bump(t, ct + 0.12, ct + 0.45) + 0.05 * bump(tau, 0.35, 0.65),
              rest_l[2] + step + push[1] * 0.30 * back_l)
    foot_r = (rest_r[0] + push[0] * 0.12 * back_r, rest_r[1] + 0.06 * bump(tau, 0.1, 0.4),
              rest_r[2] + push[1] * 0.35 * back_r)
    stand = (
        push[0] * (0.10 * jolt + 0.03 * back_r),
        REST["pelvis"][1] - 0.05 * guard - 0.03 * settle - 0.03 * lunge,
        REST["pelvis"][2] + 0.6 * step + 0.04 * settle + push[1] * (0.10 * jolt + 0.05 * back_r + 0.22 * back_l),
    )
    down = (stand[0], KNEEL["pelvis_y"], KNEEL["pelvis_z"] + push[1] * 0.3)
    pelvis = tuple(a + (b - a) * kneel for a, b in zip(stand, down))
    look = 1 - smooth(tau, 0.0, 0.15)  # after the blow the head goes with the body
    off = 1 - smooth(tau, 0, 0.4)
    down_arm = smooth(tau, 0.65, 1.3)
    return {
        "pelvis": pelvis,
        "yaw": guard_yaw * guard + counter_yaw * lunge - 0.08 * cover * off,
        "pitch": 0.08 * kneel,
        "roll": 0.0,
        "trunk": {"bend": 0.06 * guard + 0.03 * settle + counter_bend * lunge + 0.32 * fold + 0.25 * slump - 0.1 * kneel,
                  "twist": -0.12 * knocked - 0.12 * cover_t * off + 0.12 * fold,
                  "side": 0.18 * fold},
        "head": {"bend": 0.25 * fold + 0.3 * slump, "twist": 0.1 * fold, "look": look},
        "arms": {
            # Level on the attacker in the guard; the counter-thrust; knocked high by the
            # beat; after the blow the point sinks to the board ahead and to the right.
            "aim": smooth(t, 0.55, 1.1) * (1 - 0.55 * beaten) + 1.0 * smooth(tau, 0.3, 1.3),
            "thrust": thrust,
            # The point goes out to its right as it sinks, off the line the attacker
            # advances along once it is down.
            "turn": -0.12 * knocked - 0.8 * smooth(tau, 0.3, 1.3),
            # Square to the attacker in the guard (against the body's turn), across to the
            # right with the feint; after the blow the arm sags and the shield comes back
            # in front of the body, away from the spear in the left flank, and rests on
            # the board as the knees go down (the fit keeps its edge out of the board).
            "swing": -0.6 * guard_yaw * guard + (FEINT_SWING + 0.6 * guard_yaw) * cover + (-0.25 - FEINT_SWING) * down_arm * cover,
            "raise": 0.08 * settle * off - 0.2 * smooth(tau, 0.1, 0.8),
        },
        "feet": {
            # As the knees go down the heels come up and the toes tuck under.
            "L": {"pos": foot_l, "yaw": 0.0, "pitch": KNEEL["pitch"] * kneel - 0.25 * bump(tau, 0.35, 0.65)},
            # The rear heel comes off the board in the low guard and the lunge, so the
            # rear ankle stays within its dorsiflexion range (the weight on the ball).
            "R": {"pos": foot_r, "yaw": 0.0,
                  "pitch": KNEEL["pitch"] * kneel - 0.3 * bump(tau, 0.1, 0.4) - (0.18 * guard + 0.3 * lunge) * (1 - kneel)},
        },
    }


def defender(t, **params):
    """The defender at (0, DISTANCE) facing -z, in the pair's frame."""
    return to_pair(defender_local(t, **params), (0.0, DISTANCE), math.pi)


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
