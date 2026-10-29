"""Builds «пешка берёт пешку» on the pawn's own rig in headless Blender and writes it as
a pair of clips in the board's motion format (lazy-chess.motion, frame:'shared').

  python3 pawn_capture.py                      # clip + checks into ../../motions/
  python3 pawn_capture.py --aim                # also solve the approach and the turn
  python3 pawn_capture.py --render 0,1.9,3.45  # Cycles stills of the pair at these times

The body plan (capture_design.py) gives, per time, the pelvis, the trunk and head turns
and where each ankle stands. Here the plan is solved on the rig: the arms play the pawn's
own actions on the board's timing (Spear_Study for the attacker, Shield_Brace for the
defender, as src/choreography.mjs maps them), the pelvis and spine are set from the plan,
and each leg is solved by two-bone IK to its ankle with the knee over the toes, so a
planted foot stays exactly where it was put. The script then measures what an anatomist
would: joint angles against their ranges, soles against the board, planted feet against
sliding, the centre of mass against the base of support, and where the spear tip meets
the defender.

Needs the bpy module (pip install bpy; Blender 5.x). Runs on CPU; no GPU needed.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector, Quaternion
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import capture_design as design  # noqa: E402

GLB = os.path.normpath(os.path.join(HERE, "../../../white-pawn/assets/white-pawn.glb"))
ACTION_FPS = 24  # the actions in the GLB are keyed at 24 fps
SHOWN = ("BASE_base", "PADDING_padded", "PLATE_plate", "SHIELD_tower", "WEAPON_spear", "HELMET_on")  # board defaults (loadout.mjs)

# Board frame (x left, y up, z forward) to Blender's (x, y back... -z forward, z up).
C = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))
CT = C.transposed()


def bl(v):
    return C @ Vector(v)


def board(v):
    return CT @ Vector(v)


def board_rot(yaw=0.0, pitch=0.0, roll=0.0):
    """Rotation in the board frame: yaw to the left about +y, pitch forward about +x,
    roll to the right about +z. Returned in Blender's frame."""
    r = Matrix.Rotation(yaw, 3, "Y") @ Matrix.Rotation(pitch, 3, "X") @ Matrix.Rotation(roll, 3, "Z")
    return C @ r @ CT


def about(point, rot3):
    """4×4 rotation about a point (Blender frame)."""
    return Matrix.Translation(point) @ rot3.to_4x4() @ Matrix.Translation(-point)


# ---------------------------------------------------------------------------------------
# Actions

class ActionSampler:
    """Pose of every animated bone at a time in seconds, read straight from the action's
    curves (Blender 5 layered actions)."""

    def __init__(self, action):
        self.name = action.name
        self.end = action.frame_range[1] / ACTION_FPS
        bag = action.layers[0].strips[0].channelbag(action.slots[0])
        self.curves = {}
        for fc in bag.fcurves:
            path = fc.data_path
            if not path.startswith('pose.bones["'):
                continue
            bone = path[len('pose.bones["'):path.index('"]')]
            prop = path.rsplit(".", 1)[1]
            self.curves.setdefault(bone, {}).setdefault(prop, {})[fc.array_index] = fc

    def pose(self, seconds):
        f = max(0.0, min(self.end, seconds)) * ACTION_FPS
        out = {}
        for bone, props in self.curves.items():
            loc = Vector([props.get("location", {}).get(i).evaluate(f) if i in props.get("location", {}) else 0.0 for i in range(3)])
            q = props.get("rotation_quaternion")
            rot = Quaternion([q[i].evaluate(f) if q and i in q else (1.0 if i == 0 else 0.0) for i in range(4)])
            rot.normalize()
            out[bone] = (loc, rot)
        return out


def blend(a, b, w):
    if w <= 0:
        return a
    if w >= 1:
        return b
    out = {}
    for bone, (la, qa) in a.items():
        lb, qb = b.get(bone, (la, qa))
        if qa.dot(qb) < 0:
            qb = -qb
        out[bone] = (la.lerp(lb, w), qa.slerp(qb, w))
    return out


def piecewise(t, keys):
    """The board's action-time maps: keys [(t, action_time)], smooth between keys."""
    if t <= keys[0][0]:
        return keys[0][1]
    for (t0, v0), (t1, v1) in zip(keys, keys[1:]):
        if t < t1:
            return v0 + (v1 - v0) * design.smooth(t, t0, t1)
    return keys[-1][1]


SPEAR_KEYS = [(1.95, 0), (2.35, 1), (2.55, 1.5), (2.95, 1.42), (3.1, 1.05), (design.HIT_TIME, 1.95), (3.75, 2), (4.6, 4)]


# The board's spear (white-pawn/src/loadout.mjs, poseAt). The hand is solved onto a grip point
# and the shaft onto a direction, both fixed in the trunk frame (shoulder line, spine05 → neck01),
# so on the board the tip follows the trunk, not the arm keys of Spear_Study. The clip carries
# no arms; the hit and the shield clearance are measured on this spear.
SPEAR = {"guard": (-0.10, 0.8, 0.592), "aimed": (-0.15, 0.087, 0.985), "anchor": (-0.37, -0.23, 0.30),
         "advance": 0.14, "lift": 0.07,
         "length": 1.566}  # tipBind − gripBind along shaftAxisBind (GLB extras of WEAPON_spear)


def smoother(t, a, b):
    u = design.clamp((t - a) / (b - a))
    return u * u * u * (u * (u * 6 - 15) + 10)


def spear_phases(t):
    """Aim and thrust envelopes of loadoutPhases on the board's Spear_Study time."""
    if not SPEAR_KEYS[0][0] <= t < SPEAR_KEYS[-1][0]:
        return 0.0, 0.0
    st = piecewise(t, SPEAR_KEYS)
    envelope = lambda s, p, h, e: smoother(st, s, p) * (1 - smoother(st, h, e))
    return envelope(0.55, 1.2, 2.8, 3.75), envelope(1.25, 1.9, 2.1, 2.8)


def attacker_arms(actions, t):
    """Spear_Study on the board's timing (choreography.mjs, captureAt), Guard_Breath around it."""
    guard = actions["Guard_Breath"]
    if t < SPEAR_KEYS[0][0]:
        return guard.pose(t % 6)
    if t >= SPEAR_KEYS[-1][0]:
        late = guard.pose((t - SPEAR_KEYS[-1][0]) % 6)
        return blend(actions["Spear_Study"].pose(4.0), late, design.smooth(t, 4.6, 4.9))
    w = design.smooth(t, 1.95, 2.1)
    return blend(guard.pose(t % 6), actions["Spear_Study"].pose(piecewise(t, SPEAR_KEYS)), w)


def defender_arms(actions, t):
    guard = actions["Guard_Breath"]
    if t < 0.5:
        return guard.pose(t % 6)
    v = 1.0 * design.smooth(t, 0.5, 1.1)
    if t >= 2.4:
        v = 1 + design.smooth(t, 2.4, 2.8)
    if t >= 3.5:
        v = 2 + (0.3 - 2) * design.smooth(t, 3.5, 4.1)
    return blend(guard.pose(t % 6), actions["Shield_Brace"].pose(v), design.smooth(t, 0.5, 0.65))


# ---------------------------------------------------------------------------------------
# Rig

LEG = ("upperleg01", "upperleg02", "lowerleg01", "lowerleg02", "foot")
OWN = {"root"} | {f"{b}.{s}" for b in LEG for s in "LR"}  # bones the solver sets itself
SPINE = (("spine05", 0.30, 0.05, 0.2), ("spine04", 0.25, 0.10, 0.2), ("spine03", 0.20, 0.20, 0.2),
         ("spine02", 0.15, 0.30, 0.2), ("spine01", 0.10, 0.35, 0.2))  # bone, bend, twist, side shares
NECK = (("neck01", 0.5), ("head", 0.5))


class Pawn:
    def __init__(self, arm, objects):
        self.arm = arm
        self.objects = objects
        self.pb = arm.pose.bones
        for pb in self.pb:
            pb.rotation_mode = "QUATERNION"
        if arm.animation_data:
            arm.animation_data.action = None
            for track in list(arm.animation_data.nla_tracks):
                arm.animation_data.nla_tracks.remove(track)

    def update(self):
        bpy.context.view_layer.update()

    def head(self, name):
        return board(self.pb[name].head)

    def reset(self, arms):
        for pb in self.pb:
            pb.location = (0, 0, 0)
            pb.rotation_quaternion = (1, 0, 0, 0)
            pb.scale = (1, 1, 1)
        for name, (loc, rot) in arms.items():
            if name in self.pb:
                self.pb[name].location = loc
                self.pb[name].rotation_quaternion = rot

    def calibrate(self, guard_pose):
        """The guard stance (Guard_Breath at 0, whole body) is the reference: the root's
        orientation, the feet's orientation and each leg bone's knee-forward direction."""
        self.reset({})
        self.update()
        self.ankle_angle = {s: self.shin_foot_angle(s) for s in "LR"}  # anatomical zero: bind pose
        # Shoulders as the trunk carries them (bind pose, in the top vertebra's frame):
        # the board turns the chest by the shoulder line and then puts the loadout's
        # arms, clavicles included, on top, so a shrug written into the clip would
        # be applied twice.
        top = self.pb["spine01"].matrix.inverted()
        self.shoulder_local = {s: top @ self.pb[f"upperarm01.{s}"].head for s in "LR"}
        self.reset(guard_pose)
        self.update()
        self.root_rot = self.pb["root"].matrix.to_3x3().normalized()
        self.ref = {}
        for s in "LR":
            hip, knee, ankle = (self.pb[f"upperleg01.{s}"].head, self.pb[f"lowerleg01.{s}"].head, self.pb[f"foot.{s}"].head)
            forward = bl((0, 0, 1))
            ref = {"foot": self.pb[f"foot.{s}"].matrix.to_3x3().normalized(),
                   "ball": board(self.pb[f"toe3-1.{s}"].head) - board(ankle),
                   "thigh": (knee - hip).length, "shin": (ankle - knee).length}
            for bone, a, b in ((f"upperleg01.{s}", hip, knee), (f"lowerleg01.{s}", knee, ankle)):
                axis = (b - a).normalized()
                f = (forward - axis * forward.dot(axis)).normalized()
                ref[bone] = self.pb[bone].matrix.to_3x3().normalized().inverted() @ f
            self.ref[s] = ref
        self.guard = self.points()
        self.toe_ground = min(self.pb["toe3-1.L"].head.z, self.pb["toe3-1.R"].head.z)

    def shin_foot_angle(self, s):
        shin = board(self.pb[f"lowerleg01.{s}"].head) - board(self.pb[f"foot.{s}"].head)
        foot = board(self.pb[f"toe3-1.{s}"].head) - board(self.pb[f"foot.{s}"].head)
        return math.degrees(shin.angle(foot))

    def set_matrix(self, name, m):
        self.pb[name].matrix = m
        self.update()

    def turn(self, name, rot3, point=None):
        pb = self.pb[name]
        self.set_matrix(name, about(pb.head.copy() if point is None else point, rot3) @ pb.matrix)

    def pose(self, plan, arms):
        """Solves one frame of the plan on the rig."""
        self.reset(arms)
        self.update()
        pelvis_rot = board_rot(plan["yaw"], plan["pitch"], plan["roll"])
        root = (pelvis_rot @ self.root_rot).to_4x4()
        root.translation = bl(plan["pelvis"])
        self.set_matrix("root", root)
        targets = {s: self.foot_target(s, plan["feet"][s], plan["yaw"]) for s in "LR"}
        self.drop = self.settle(targets)
        trunk = plan["trunk"]
        for name, bend, twist, side in SPINE:
            local = board_rot(trunk["twist"] * twist, trunk["bend"] * bend, -trunk["side"] * side)
            self.turn(name, pelvis_rot @ local @ pelvis_rot.inverted())
        chest_rot = board_rot(plan["yaw"] + trunk["twist"], plan["pitch"] + trunk["bend"])
        for name, share in NECK:
            local = board_rot(plan["head"]["twist"] * share, plan["head"]["bend"] * share)
            self.turn(name, chest_rot @ local @ chest_rot.inverted())
        for s in "LR":
            self.leg(s, *targets[s])

    def foot_target(self, s, foot, body_yaw):
        """Where the ankle goes and how the foot turns (Blender frame). The foot's yaw is
        its own heading in the figure's frame, not relative to the pelvis."""
        ref = self.ref[s]
        heading = board_rot(foot["yaw"])  # feet turn on their own: a planted foot keeps its heading
        tilt = Matrix.Rotation(-foot["pitch"], 3, heading @ Vector((1, 0, 0)))  # toe down for pitch < 0
        ankle = Vector(foot["pos"])
        if foot["pitch"] < 0:
            # Heel off with the toe down: the foot turns about the ball, so the ball stays
            # where the plan puts it (on the board until the lift raises it).
            ball = ankle + CT @ heading @ C @ ref["ball"]
            ankle = ball - CT @ tilt @ heading @ C @ ref["ball"]
        airborne = design.clamp((foot["pos"][1] - design.REST["ankleL"][1] - 0.01) / 0.03)  # lift, not heel-off
        return bl(ankle), heading, tilt, airborne

    def settle(self, targets):
        """Lowers the pelvis just enough that neither knee has to lock straight: a leg
        reaches at most 98.5 % of its length, as in walking, where the knee keeps about
        5° of flexion. Returns the drop in metres (reported by the checks)."""
        drop = 0.0
        for s, (target, *_rest) in targets.items():
            hip = self.pb[f"upperleg01.{s}"].head
            most = 0.985 * (self.ref[s]["thigh"] + self.ref[s]["shin"])
            h2 = (hip.x - target.x) ** 2 + (hip.y - target.y) ** 2
            if h2 < most * most:
                drop = max(drop, (hip.z - target.z) - math.sqrt(most * most - h2))
        if drop > 0:
            m = self.pb["root"].matrix.copy()
            m.translation.z -= drop
            self.set_matrix("root", m)
        return drop

    def leg(self, s, target, heading, tilt, airborne):
        ref = self.ref[s]
        hip = self.pb[f"upperleg01.{s}"].head.copy()
        # Two-bone IK with the knee in the plane of the foot's heading.
        l1, l2 = ref["thigh"], ref["shin"]
        reach = target - hip
        d = min(reach.length, (l1 + l2) * 0.9995)
        u = reach.normalized()
        pole = heading @ Vector((0, -1, 0))  # the knee goes over the toes
        p = (pole - u * pole.dot(u)).normalized()
        cos_a = max(-1.0, min(1.0, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)))
        knee = hip + l1 * (cos_a * u + math.sqrt(1 - cos_a * cos_a) * p)
        self.aim(f"upperleg01.{s}", hip, self.pb[f"lowerleg01.{s}"].head, knee, p, ref)
        start = self.pb[f"lowerleg01.{s}"].head.copy()
        self.aim(f"lowerleg01.{s}", start, self.pb[f"foot.{s}"].head, target, p, ref)
        m = (tilt @ heading @ ref["foot"]).to_4x4()
        m.translation = self.pb[f"foot.{s}"].head
        self.set_matrix(f"foot.{s}", m)
        # Clear of the board only once the toe is: at toe-off the toe stays down.
        airborne = min(airborne, design.clamp((self.pb[f"toe3-1.{s}"].head.z - self.toe_ground - 0.01) / 0.05))
        if airborne > 0:
            # A foot in the air hangs from the shin: it is not held dorsiflexed past 10°.
            excess = (self.ankle_angle[s] - self.shin_foot_angle(s)) - 10.0
            # ...but the toe keeps its swing clearance (about 1.5 cm in gait, Winter 1992).
            room = self.pb[f"toe3-1.{s}"].head.z - self.toe_ground - 0.015
            excess = min(excess * airborne, math.degrees(math.asin(design.clamp(room / 0.15, 0, 1))))
            airborne = 1.0
            if excess > 0:
                lateral = heading @ Vector((1, 0, 0))
                self.turn(f"foot.{s}", Matrix.Rotation(math.radians(excess * airborne), 3, lateral))

    def aim(self, name, a, b, target, pole, ref):
        """Turns bone `name` about a so the segment a→b points at target and its knee-forward
        axis lies toward the pole."""
        cur_axis = (b - a).normalized()
        cur_fwd = self.pb[name].matrix.to_3x3().normalized() @ ref[name]
        cur_fwd = (cur_fwd - cur_axis * cur_fwd.dot(cur_axis)).normalized()
        new_axis = (target - a).normalized()
        new_fwd = (pole - new_axis * pole.dot(new_axis)).normalized()
        frame = lambda x, y: Matrix((x, y, x.cross(y))).transposed()
        rot = frame(new_axis, new_fwd) @ frame(cur_axis, cur_fwd).transposed()
        self.turn(name, rot, a)

    def points(self):
        names = {"pelvis": "root", "spine": "spine04", "chest": "spine02", "neck": "neck01", "head": "head",
                 "eyeL": "eye.L", "eyeR": "eye.R"}
        for s in "LR":
            names.update({f"hip{s}": f"upperleg01.{s}", f"knee{s}": f"lowerleg01.{s}", f"ankle{s}": f"foot.{s}",
                          f"toe{s}": f"toe3-1.{s}", f"shoulder{s}": f"upperarm01.{s}", f"elbow{s}": f"lowerarm01.{s}",
                          f"wrist{s}": f"wrist.{s}"})
        out = {k: board(self.pb[v].head) for k, v in names.items()}
        if hasattr(self, "shoulder_local"):
            for s in "LR":
                out[f"shoulder{s}"] = board(self.pb["spine01"].matrix @ self.shoulder_local[s])
        return out

    def show_loadout(self):
        for o in self.objects:
            if o.type == "MESH":
                keep = any(o.name.startswith(n) for n in SHOWN)
                o.hide_render = not keep
                o.hide_set(not keep)

    def mesh_points(self, prefix):
        """World vertices of a skinned part, board frame, as an N×3 array."""
        return self.mesh_triangles(prefix)[0]

    def mesh_triangles(self, prefix):
        """World vertices (board frame, N×3) and triangles (M×3 vertex indices) of a skinned part."""
        obj = next(o for o in self.objects if o.name.startswith(prefix))
        dg = bpy.context.evaluated_depsgraph_get()
        ev = obj.evaluated_get(dg)
        mesh = ev.to_mesh()
        co = np.empty(len(mesh.vertices) * 3)
        mesh.vertices.foreach_get("co", co)
        mesh.calc_loop_triangles()
        tris = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int32)
        mesh.loop_triangles.foreach_get("vertices", tris)
        ev.to_mesh_clear()
        m = np.array(CT @ ev.matrix_world.to_3x3()), np.array(CT @ ev.matrix_world.translation)
        return co.reshape(-1, 3) @ m[0].T + m[1], tris.reshape(-1, 3)

    def board_spear(self, t):
        """Grip and tip of the spear as the board places them for this trunk at time t."""
        left, right = self.head("upperarm01.L"), self.head("upperarm01.R")
        origin, x = (left + right) / 2, (left - right).normalized()
        up = self.head("neck01") - self.head("spine05")
        up = (up - x * up.dot(x)).normalized()
        fwd = x.cross(up).normalized()
        d = lambda v: x * v[0] + up * v[1] + fwd * v[2]
        aim, thrust = spear_phases(t)
        axis = d(SPEAR["guard"]).lerp(d(SPEAR["aimed"]), aim).normalized()
        ax, ay, az = SPEAR["anchor"]
        grip = origin + d((ax, ay + SPEAR["lift"] * thrust, az)) + axis * SPEAR["advance"] * thrust
        return grip, grip + axis * SPEAR["length"]

def load_pawn():
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=GLB)
    objects = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in objects if o.type == "ARMATURE")
    for o in objects:  # helper meshes of the asset that are not part of the figure
        if o.type == "MESH" and o.parent is None:
            o.hide_render = True
            o.hide_set(True)
    return Pawn(arm, objects)


def place(pawn, origin, yaw):
    """Places a figure's armature object in the pair frame (board coordinates)."""
    m = board_rot(yaw).to_4x4()
    m.translation = bl((origin[0], 0, origin[1]))
    pawn.arm.matrix_world = m


# ---------------------------------------------------------------------------------------
# Measures

MASS = (  # segment masses as fractions of body mass (de Leva 1996, male)
    ("head", ("neck", "head"), 0.0694), ("trunk", ("pelvis", "neck"), 0.4346),
    ("thighL", ("hipL", "kneeL"), 0.1416), ("thighR", ("hipR", "kneeR"), 0.1416),
    ("shankL", ("kneeL", "ankleL"), 0.0433), ("shankR", ("kneeR", "ankleR"), 0.0433),
    ("footL", ("ankleL", "toeL"), 0.0137), ("footR", ("ankleR", "toeR"), 0.0137),
    ("upperL", ("shoulderL", "elbowL"), 0.0271), ("upperR", ("shoulderR", "elbowR"), 0.0271),
    ("foreL", ("elbowL", "wristL"), 0.0162), ("foreR", ("elbowR", "wristR"), 0.0162),
)
LIMITS = {  # degrees; adult active ranges (AAOS; Norkin & White, Measurement of Joint Motion)
    # Ankle: from the bind pose (standing, shin upright, sole flat); dorsiflexion under
    # body weight reaches about 35–45° (weight-bearing lunge test, Bennell et al. 1998),
    # 20° is the active range without load.
    # Hip rotation: internal 35°, external 45° (AAOS).
    "knee": (0, 140), "hip": (-20, 120), "hip_rot": (-35, 45), "ankle_dorsi": (-50, 35),
    "trunk_twist": (-45, 45), "trunk_side": (-30, 30), "trunk_bend": (-25, 80),
}


def com(p):
    total = sum(m for _, _, m in MASS)
    acc = Vector((0, 0, 0))
    for _, (a, b), m in MASS:
        acc += (p[a] + p[b]) / 2 * m
    return acc / total


def frame_of(p):
    """Pelvis and chest frames from hips and shoulders: left, up, forward."""
    def basis(left, up):
        left = left.normalized()
        fwd = left.cross(up).normalized()
        return left, fwd.cross(left), fwd
    up = (p["neck"] - p["pelvis"]).normalized()
    pelvis = basis(p["hipL"] - p["hipR"], Vector((0, 1, 0)))
    chest = basis(p["shoulderL"] - p["shoulderR"], up)
    return pelvis, chest


def angles(pawn, p):
    out = {}
    _, (cl, cu, cf) = frame_of(p)
    # Pelvis frame from the root bone, relative to the guard stance (board axes there).
    r = CT @ pawn.pb["root"].matrix.to_3x3().normalized() @ pawn.root_rot.inverted() @ C
    pl, pu, pf = r.col[0], r.col[1], r.col[2]
    for s in "LR":
        thigh = (p[f"knee{s}"] - p[f"hip{s}"]).normalized()
        shin = (p[f"ankle{s}"] - p[f"knee{s}"]).normalized()
        flex = math.degrees(thigh.angle(shin))
        # Hyperextension shows as the knee bending backwards: shin ahead of the thigh line.
        bent_back = thigh.cross(shin).dot(pl) < -0.02
        out[f"knee{s}"] = -flex if bent_back else flex
        out[f"hip{s}"] = math.degrees(math.atan2(thigh.dot(pf), -thigh.dot(pu)))
        out[f"ankle{s}"] = pawn.ankle_angle[s] - pawn.shin_foot_angle(s)  # dorsiflexion from guard
        # Thigh rotation about its own axis (positive: the knee turns outwards). The knee's
        # front, from the plane of the bent knee, is compared with where the pelvis's forward
        # goes under the swing alone (the shortest turn from hanging straight down to the
        # thigh), so flexion and abduction do not count as rotation. Undefined with a nearly
        # straight knee.
        if flex > 25:
            front = -(shin - thigh * shin.dot(thigh)).normalized()
            ref = (-pu).rotation_difference(thigh) @ pf
            out_dir = thigh.cross(ref) if s == "R" else ref.cross(thigh)
            out[f"hip_rot{s}"] = math.degrees(math.atan2(front.dot(out_dir), front.dot(ref)))
    out["trunk_twist"] = math.degrees(math.atan2(cl.dot(pf), cl.dot(pl)))
    out["trunk_side"] = math.degrees(math.asin(max(-1, min(1, cu.dot(pl)))))
    out["trunk_bend"] = math.degrees(math.asin(max(-1, min(1, cu.dot(pf)))))
    return out


def check(name, frames, pawn_angles, ground, static, supports):
    """frames: [(t, points)]; returns a report with every violation."""
    issues, worst = [], {}
    prev = None
    for (t, p), a in zip(frames, pawn_angles):
        for key, v in a.items():
            lim = LIMITS["ankle_dorsi" if key.startswith("ankle") else key.rstrip("LR") if key[-1] in "LR" else key]
            worst[key] = (min(worst.get(key, (v, v))[0], v), max(worst.get(key, (v, v))[1], v))
            if not lim[0] - 0.5 <= v <= lim[1] + 0.5:
                issues.append(f"{name} {t:.2f}s: {key} {v:.0f}° вне {lim[0]}…{lim[1]}°")
        for s in "LR":
            if p[f"toe{s}"].y < ground["toe"] - 0.01 or p[f"ankle{s}"].y < ground["ankle"] - 0.01:
                issues.append(f"{name} {t:.2f}s: стопа {s} ниже доски")
        if prev is not None:
            for s in "LR":
                down = p[f"toe{s}"].y < ground["toe"] + 0.006 and prev[f"toe{s}"].y < ground["toe"] + 0.006
                slide = math.hypot(p[f"toe{s}"].x - prev[f"toe{s}"].x, p[f"toe{s}"].z - prev[f"toe{s}"].z)
                if down and slide > 0.006:
                    issues.append(f"{name} {t:.2f}s: опорная стопа {s} скользит на {slide * 100:.1f} см за кадр")
        if static(t):
            c = com(p)
            feet = [p[k] for s in supports(t) for k in (f"ankle{s}", f"toe{s}")]
            lo_x, hi_x = min(v.x for v in feet) - 0.08, max(v.x for v in feet) + 0.08
            lo_z, hi_z = min(v.z for v in feet) - 0.10, max(v.z for v in feet) + 0.06
            if not (lo_x <= c.x <= hi_x and lo_z <= c.z <= hi_z):
                issues.append(f"{name} {t:.2f}s: центр масс вне площади опоры")
        prev = p
    return {"issues": issues, "ranges": {k: [round(v[0]), round(v[1])] for k, v in worst.items()}}


# ---------------------------------------------------------------------------------------

def solve_pair(attacker, defender, actions, times, strike):
    a_frames, d_frames, a_ang, d_ang, tips, drops, drops_d, clearance = [], [], [], [], [], [], [], []
    for t in times:
        attacker.pose(design.attacker(t, **strike), attacker_arms(actions, t))
        pa = attacker.points()
        a_frames.append((t, pa))
        a_ang.append(angles(attacker, pa))
        grip, tip = attacker.board_spear(t)
        tips.append(tip)
        drops.append(attacker.drop)
        defender.pose(design.defender_local(t), defender_arms(actions, t))
        pd = defender.points()
        d_frames.append((t, pd))
        if 2.4 <= t <= 3.9:
            # The spear, from the hand to the tip, may meet the shield (the feint is blocked,
            # the strike slides past its edge) but never pass through it.
            points, tris = defender.mesh_triangles("SHIELD_tower")
            shield = to_pair_array(points)
            clearance.append((t, segment_distance(shield, grip, tip), segment_crosses(shield, tris, grip, tip)))
        d_ang.append(angles(defender, pd))
        drops_d.append(defender.drop)
    return a_frames, d_frames, a_ang, d_ang, tips, (max(drops), max(drops_d)), clearance


def segment_crosses(points, tris, a, b):
    """Whether the segment a–b passes through the triangle surface."""
    tree = BVHTree.FromPolygons([tuple(p) for p in points.tolist()], tris.tolist())
    d = Vector(b) - Vector(a)
    return tree.ray_cast(Vector(a), d.normalized(), d.length)[0] is not None


def segment_distance(points, a, b):
    """Smallest distance from a point cloud to the segment a–b."""
    a, b = np.array(a), np.array(b)
    ab = b - a
    u = np.clip((points - a) @ ab / ab.dot(ab), 0, 1)
    return float(np.min(np.linalg.norm(points - (a + u[:, None] * ab), axis=1)))


def to_pair_array(points):
    return np.column_stack((-points[:, 0], points[:, 1], design.DISTANCE - points[:, 2]))


def to_pair_points(points):
    """Defender points (solved in its own frame at the origin facing +z) in the pair frame."""
    c, s = math.cos(math.pi), math.sin(math.pi)
    out = {}
    for k, v in points.items():
        out[k] = Vector((c * v.x + s * v.z, v.y, design.DISTANCE - s * v.x + c * v.z))
    return out


def hit_error(attacker, defender, actions, strike):
    """Spear tip and its target at the hit. The target is the defender's open flank, as
    choreography.mjs aims: its left side below the ribs, 0.19 m out from the trunk axis and 0.05 m back,
    with a 0.04 m bite towards the spine."""
    t = design.HIT_TIME
    attacker.pose(design.attacker(t, **strike), attacker_arms(actions, t))
    tip = attacker.board_spear(t)[1]
    defender.pose(design.defender_local(t), defender_arms(actions, t))
    d = defender.points()
    left, _, fwd = frame_of(d)[1]  # the trunk is turned away with the shield
    flank = d["spine"].lerp(d["chest"], 0.3) + left * 0.19 - fwd * 0.05  # below the ribs
    inward = Vector((d["spine"].x - flank.x, 0, d["spine"].z - flank.z)).normalized()
    target = to_pair_points({"x": flank + inward * 0.04})["x"]
    return tip, target


FEINT_TIME = 2.8   # the feint holds and the shield has arrived
FEINT_GAP = 0.03   # the tip stops this far short of the shield's face


def feint_error(attacker, defender, actions, strike):
    """Where the feint's tip stands against the arriving shield: across its face from the
    centre, and in front of its face less FEINT_GAP."""
    t = FEINT_TIME
    attacker.pose(design.attacker(t, **strike), attacker_arms(actions, t))
    grip, tip = attacker.board_spear(t)
    defender.pose(design.defender_local(t), defender_arms(actions, t))
    front, face, lateral = shield_frame(defender, grip)
    return Vector(((tip - front) @ lateral, (tip - front) @ face - FEINT_GAP))


def shield_frame(defender, towards):
    """Centre of the shield's front face, the face's normal towards a point and the
    horizontal axis across the face, in the pair frame."""
    cloud = to_pair_array(defender.mesh_points("SHIELD_tower"))
    c = cloud.mean(axis=0)
    n = np.linalg.svd(cloud - c, full_matrices=False)[2][2]
    if (np.array(towards) - c) @ n < 0:
        n = -n
    front = c + n * float(np.max((cloud - c) @ n))
    face = Vector(n.tolist())
    lateral = face.cross(Vector((0, 1, 0))).normalized()
    return Vector(front.tolist()), face, lateral


def newton(error, strike, keys):
    """Newton steps on the named parameters of the plan until the error vanishes."""
    strike = dict(strike)
    for _ in range(8):
        e = error(strike)
        if e.length < 0.005:
            break
        h = 0.01
        cols = [(error({**strike, k: strike[k] + h}) - e) / h for k in keys]
        step = Matrix(cols).transposed().inverted() @ e
        for k, v in zip(keys, step):
            strike[k] -= v
    return strike, e.length


def aim(attacker, defender, actions, strike):
    """The feint (turn and stamp) and the strike (approach, turn and bend) are solved in
    turn, since the stamp moves the foot the lunge starts from."""
    def hit(s):
        tip, target = hit_error(attacker, defender, actions, s)
        return tip - target
    feint = lambda s: feint_error(attacker, defender, actions, s)
    for _ in range(4):
        strike, fe = newton(feint, strike, ("feint_yaw", "feint_step"))
        strike, he = newton(hit, strike, ("approach", "strike_yaw", "strike_bend"))
        fe = feint(strike).length
        print(f"  финт {fe * 100:.1f} см, удар {he * 100:.1f} см: " + ", ".join(f"{k} {v:.4f}" for k, v in strike.items()))
        if max(fe, he) < 0.005:
            break
    return strike


def clip(name, label, role, frames, partner):
    return {"name": name, "label": label, "role": role, "loop": False, "fps": design.FPS, "frame": "shared",
            "partner": partner, "frames": [{k: [round(c, 4) for c in v] for k, v in p.items()} for _, p in frames]}


def motion_file(a_frames, d_frames):
    points = ["pelvis", "spine", "chest", "neck", "head", "eyeL", "eyeR", "hipL", "kneeL", "ankleL", "toeL",
              "hipR", "kneeR", "ankleR", "toeR", "shoulderL", "elbowL", "wristL", "shoulderR", "elbowR", "wristR"]
    clips = [clip("pawn-capture-strike", "Пешка берёт пешку: атакующий", "strike", a_frames, "pawn-capture-struck"),
             clip("pawn-capture-struck", "Пешка берёт пешку: защитник", "struck", d_frames, "pawn-capture-strike")]
    out = []
    for c in clips:
        data = []
        for f in c.pop("frames"):
            for p in points:
                data += f[p]
        out.append({**c, "frames": len(data) // (3 * len(points)), "data": data})
    return {"format": "lazy-chess.motion", "version": 1,
            "source": {"kind": "blender", "name": "Пешка берёт пешку (Blender, скелет пешки)",
                       "license": "собственная работа проекта, как и модель пешки",
                       "note": "tools/blender/pawn_capture.py: план тела capture_design.py, ноги — IK, руки — действия пешки"},
            "points": points, "clips": out}


def render(attacker, defender, actions, times, strike, out_dir):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 24
    scene.render.resolution_x, scene.render.resolution_y = 960, 540
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("Board") if not scene.world else scene.world
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.62, 0.64, 0.68, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.6
    bpy.ops.mesh.primitive_plane_add(size=12, location=bl((0, 0, design.DISTANCE / 2)))
    floor = bpy.context.active_object
    mat = bpy.data.materials.new("Board")
    mat.diffuse_color = (0.42, 0.36, 0.28, 1)
    floor.data.materials.append(mat)
    floor.location.z = 0.0
    sun = bpy.data.lights.new("Sun", "SUN")
    sun.energy = 3.5
    sun_obj = bpy.data.objects.new("Sun", sun)
    sun_obj.rotation_euler = (math.radians(50), 0, math.radians(35))
    scene.collection.objects.link(sun_obj)
    cam_data = bpy.data.cameras.new("Cam")
    cam_data.lens = 40
    cam = bpy.data.objects.new("Cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    eye = bl((-5.6, 1.7, design.DISTANCE / 2 + 0.2))
    cam.location = eye
    look = bl((0, 1.0, design.DISTANCE / 2)) - eye
    cam.rotation_euler = look.to_track_quat("-Z", "Y").to_euler()
    attacker.show_loadout()
    defender.show_loadout()
    paths = []
    for t in times:
        attacker.pose(design.attacker(t, **strike), attacker_arms(actions, t))
        defender.pose(design.defender_local(t), defender_arms(actions, t))
        scene.render.filepath = os.path.join(out_dir, f"blender-{t:.2f}.png")
        bpy.ops.render.render(write_still=True)
        paths.append(scene.render.filepath)
    return paths


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=os.path.join(HERE, "out"), help="кадры и черновики")
    ap.add_argument("--motions", default=os.path.normpath(os.path.join(HERE, "../../motions")), help="куда положить клип и отчёт проверок")
    ap.add_argument("--aim", action="store_true", help="подобрать подход и поворот под попадание в бок")
    ap.add_argument("--render", default="", help="времена кадров Cycles через запятую, например 0,1.9,3.45")
    args = ap.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)
    os.makedirs(args.motions, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    attacker = load_pawn()
    defender = load_pawn()
    actions = {a.name.split(".")[0]: ActionSampler(a) for a in bpy.data.actions if a.name in ("Guard_Breath", "Spear_Study", "Shield_Brace")}
    guard = actions["Guard_Breath"].pose(0)
    for pawn in (attacker, defender):
        pawn.calibrate(guard)
    place(attacker, (0, 0), 0)
    place(defender, (0, 0), 0)  # solved at the origin; the pair frame turns it around

    strike = {"approach": design.APPROACH, "strike_yaw": design.STRIKE_YAW, "strike_bend": design.STRIKE_BEND,
              "feint_yaw": design.FEINT_YAW, "feint_step": design.FEINT_STEP}
    if args.aim:
        strike = aim(attacker, defender, actions, strike)
        print("\n".join(f"{k.upper()} = {v:.4f}" for k, v in strike.items()))
    tip, target = hit_error(attacker, defender, actions, strike)

    times = design.frames()
    a_frames, d_frames, a_ang, d_ang, tips, drops, clearance = solve_pair(attacker, defender, actions, times, strike)
    d_frames = [(t, to_pair_points(p)) for t, p in d_frames]
    g = attacker.guard
    ground = {"toe": min(g["toeL"].y, g["toeR"].y), "ankle": min(g["ankleL"].y, g["ankleR"].y)}
    a_static = lambda t: 1.95 <= t <= 3.0 or 4.4 <= t <= 4.6 or t <= 0.3
    d_static = lambda t: t <= design.HIT_TIME
    both = lambda t: "LR"
    report = {
        **{k: round(v, 4) for k, v in strike.items()},
        "hit": {"tip": [round(v, 3) for v in tip], "target": [round(v, 3) for v in target],
                "miss_cm": round(math.hypot(tip.x - target.x, tip.z - target.z) * 100, 1),
                "height_cm": round((tip.y - target.y) * 100, 1)},
        "attacker": check("атакующий", a_frames, a_ang, ground, a_static, both),
        "defender": check("защитник", d_frames, d_ang, ground, d_static, both),
        "shield_clearance_cm": round(min(c for _, c, _ in clearance) * 100, 1),
        "shield_contact_s": [round(t, 2) for t, c, _ in clearance if c < 0.01],
        "pelvis_settle_cm": {"attacker": round(drops[0] * 100, 1), "defender": round(drops[1] * 100, 1)},
        "end": {"attacker_pelvis": [round(v, 3) for v in a_frames[-1][1]["pelvis"]],
                "defender_square": [0, 0, round(design.DISTANCE, 3)]},
        "tip_path": [[round(t, 3)] + [round(v, 3) for v in p] for t, p in zip(times, tips)],
    }
    with open(os.path.join(args.motions, "pawn-capture.motion.json"), "w") as f:
        json.dump(motion_file(a_frames, d_frames), f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(args.motions, "pawn-capture.checks.json"), "w") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    issues = report["attacker"]["issues"] + report["defender"]["issues"]
    issues += [f"{t:.2f}s: копьё проходит сквозь щит защитника" for t, _, crossed in clearance if crossed]
    print(f"Попадание: промах {report['hit']['miss_cm']} см по горизонтали, {report['hit']['height_cm']} см по высоте")
    print("Диапазоны, атакующий:", report["attacker"]["ranges"])
    print("Диапазоны, защитник:", report["defender"]["ranges"])
    print(f"Замечаний: {len(issues)}")
    for line in issues[:40]:
        print("  " + line)
    if args.render:
        place(defender, (0, design.DISTANCE), math.pi)
        times = [float(x) for x in args.render.split(",") if x]
        for p in render(attacker, defender, actions, times, strike, args.out):
            print("кадр:", p)
    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]))
