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


# The board's spear (white-pawn/src/loadout.mjs, poseAt). The hand is solved onto a grip point
# and the shaft onto a direction, both fixed in the trunk frame (shoulder line, spine05 → neck01),
# so on the board the tip follows the trunk, not the arm keys of an action. The clip carries the
# spear's aim, thrust and turn and the shield's swing and raise as its arms track; the board
# plays them through poseAt({phase, shield}), and the hit and every clearance are measured on
# this same spear.
SPEAR = {"guard": (-0.10, 0.8, 0.592), "aimed": (-0.15, 0.087, 0.985), "anchor": (-0.37, -0.23, 0.30),
         "advance": 0.14, "lift": 0.07,
         "length": 1.566,  # tipBind − gripBind along shaftAxisBind (GLB extras of WEAPON_spear)
         "butt": 1.004}    # the rest of its 2.57 m (lengthMetres) behind the grip
ARMS_ACTION = "Spear_Study"  # the left arm's keys at time 0: the shield square at the chest
ARM_FIELDS = ("aim", "thrust", "turn", "swing", "raise")


# ---------------------------------------------------------------------------------------
# Rig

LEG = ("upperleg01", "upperleg02", "lowerleg01", "lowerleg02", "foot")
OWN = {"root"} | {f"{b}.{s}" for b in LEG for s in "LR"}  # bones the solver sets itself
SPINE = (("spine05", 0.30, 0.05, 0.2), ("spine04", 0.25, 0.10, 0.2), ("spine03", 0.20, 0.20, 0.2),
         ("spine02", 0.15, 0.30, 0.2), ("spine01", 0.10, 0.35, 0.2))  # bone, bend, twist, side shares
NECK = (("neck01", 0.5), ("head", 0.5))
# Cervical range (AAOS; Norkin & White): rotation 70–80°, flexion 45°, extension 45°.
NECK_LIMITS = {"twist": math.radians(70), "flex": math.radians(45), "extend": math.radians(45)}


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
        self.toe_rest = {n: min(self.pb[f"toe{n}-1.L"].head.z, self.pb[f"toe{n}-1.R"].head.z) for n in (1, 3, 5)}
        # Gaze: straight ahead in the guard, kept in the head bone's frame; the neck's
        # turn is measured from this neutral against the chest.
        self.gaze_local = self.pb["head"].matrix.to_3x3().normalized().inverted() @ bl((0, 0, 1))
        self.neck_zero = (0.0, 0.0)
        self.neck_zero = self.neck_angles()

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

    def gaze(self):
        """Eye point and gaze direction, board frame."""
        eye = (self.head("eye.L") + self.head("eye.R")) / 2
        return eye, board(self.pb["head"].matrix.to_3x3().normalized() @ self.gaze_local).normalized()

    def trunk_frame(self):
        """The loadout's trunk frame: shoulder midpoint, left, up (spine05 → neck01) and
        forward, board frame."""
        left, right = self.head("upperarm01.L"), self.head("upperarm01.R")
        origin, x = (left + right) / 2, (left - right).normalized()
        up = self.head("neck01") - self.head("spine05")
        up = (up - x * up.dot(x)).normalized()
        return origin, x, up, x.cross(up).normalized()

    def neck_angles(self):
        """Head turn (left +) and bend (down +) against the chest, from the guard's neutral."""
        _, x, up, fwd = self.trunk_frame()
        g = self.gaze()[1]
        return (math.degrees(math.atan2(g.dot(x), g.dot(fwd))) - self.neck_zero[0],
                -math.degrees(math.asin(max(-1, min(1, g.dot(up))))) - self.neck_zero[1])

    def pose(self, plan, arms, target=None):
        """Solves one frame of the plan on the rig. target: the point the figure looks at
        (its own board frame), or None."""
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
        self.look(plan, target)
        self.arm_base = self.pb["upperarm01.L"].matrix.copy()
        self.shield_arm(plan["arms"])
        for s in "LR":
            self.leg(s, *targets[s])

    def look(self, plan, target):
        """The head's offsets from the plan plus a turn onto the target, weighted by the
        plan's look and kept within the neck's range (NECK_LIMITS)."""
        trunk, head = plan["trunk"], plan["head"]
        chest_rot = board_rot(plan["yaw"] + trunk["twist"], plan["pitch"] + trunk["bend"])
        saved = {name: self.pb[name].matrix.copy() for name, _ in NECK}

        def apply(twist, bend):
            for name, _ in NECK:
                self.set_matrix(name, saved[name])
            for name, share in NECK:
                local = board_rot(twist * share, bend * share)
                self.turn(name, chest_rot @ local @ chest_rot.inverted())

        twist, bend = head["twist"], head["bend"]
        w = head.get("look", 0.0) if target is not None else 0.0
        if w > 0:
            tw, bd = twist, bend
            for _ in range(4):  # Newton-like: the error in heading and elevation feeds back
                apply(tw, bd)
                eye, g = self.gaze()
                d = (Vector(target) - eye).normalized()
                dyaw = math.atan2(d.x, d.z) - math.atan2(g.x, g.z)
                dyaw = (dyaw + math.pi) % (2 * math.pi) - math.pi
                tw += dyaw
                bd -= math.asin(max(-1, min(1, d.y))) - math.asin(max(-1, min(1, g.y)))
                tw = max(-NECK_LIMITS["twist"], min(NECK_LIMITS["twist"], tw))
                bd = max(-NECK_LIMITS["extend"], min(NECK_LIMITS["flex"], bd))
            twist, bend = twist + w * (tw - twist), bend + w * (bd - bend)
        apply(twist, bend)

    def shield_arm(self, arms):
        """The loadout's shield turn: the left arm turned rigidly about the shoulder by the
        swing (about the trunk's up axis, + to the left) and the raise (shoulder flexion,
        about the trunk's left axis). The board solves the arm by IK onto the same turned
        grip and wrist, so the shield lands in the same place."""
        if not (arms["swing"] or arms["raise"]):
            return
        _, x, up, _ = self.trunk_frame()
        rot = Matrix.Rotation(arms["swing"], 3, bl(up)) @ Matrix.Rotation(-arms["raise"], 3, bl(x))
        self.turn("upperarm01.L", rot)

    def reshield(self, arms):
        """The shield turn again on the same pose, with other arms values."""
        self.set_matrix("upperarm01.L", self.arm_base)
        self.shield_arm(arms)

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

    def leg(self, s, target, heading, tilt, airborne, _depth=0):
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
        # Heel off: the toes stay flat on the board and bend at their base joints
        # (metatarsophalangeal extension, up to about 70° in toe-off and kneeling).
        back = tilt.inverted()
        for n in range(1, 6):
            self.turn(f"toe{n}-1.{s}", back)
        # A heel rise pivots on the ball of the foot, not on the ankle: lift the ankle by
        # whatever the tilt pushed the toe joints into the board, then solve again.
        sink = max(self.toe_rest[n] - self.pb[f"toe{n}-1.{s}"].head.z for n in (1, 3, 5))
        if sink > 0.001 and _depth < 3:
            return self.leg(s, target + Vector((0, 0, sink)), heading, tilt, airborne, _depth + 1)
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

    def board_spear(self, arms):
        """Grip, tip and butt of the spear as the board places them for this trunk and arms
        track (loadout.mjs, poseAt with phase {aim, thrust, turn})."""
        origin, x, up, fwd = self.trunk_frame()
        d = lambda v: x * v[0] + up * v[1] + fwd * v[2]
        aim, thrust = arms["aim"], arms["thrust"]
        axis = d(SPEAR["guard"]).lerp(d(SPEAR["aimed"]), aim).normalized()
        if arms["turn"]:
            axis = (Matrix.Rotation(arms["turn"], 3, up) @ axis).normalized()
        ax, ay, az = SPEAR["anchor"]
        grip = origin + d((ax, ay + SPEAR["lift"] * thrust, az)) + axis * SPEAR["advance"] * thrust
        return grip, grip + axis * SPEAR["length"], grip - axis * SPEAR["butt"]


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
    "neck_twist": (-70, 70), "neck_bend": (-45, 45),  # cervical rotation, flexion (+) and extension
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
    out["neck_twist"], out["neck_bend"] = pawn.neck_angles()
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

# Meshes and contact. The board shows these skinned parts (loadout.mjs defaults); the arms
# are left out of the body: the shield arm holds the shield by its enarmes, and the board
# solves both arms by IK onto its grips, so here they are only approximately where the
# board puts them. verify-capture.mjs checks the arms' bones against the shields on the
# board itself.
BODY = ("BASE_base", "PADDING_padded", "PLATE_plate", "HELMET_on")
ARM_BONES = ("clavicle", "shoulder01", "upperarm", "lowerarm", "wrist", "metacarpal", "finger")


def arm_vertices(obj):
    """Vertices of a skinned part that follow an arm bone more than anything else."""
    names = [g.name for g in obj.vertex_groups]
    out = np.zeros(len(obj.data.vertices), dtype=bool)
    for v in obj.data.vertices:
        if v.groups:
            g = max(v.groups, key=lambda e: e.weight)
            out[v.index] = names[g.group].startswith(ARM_BONES)
    return out


def body_tree(pawn, convert):
    """The visible body without its arms as a BVH tree (convert: own frame → wanted frame),
    and its lowest point."""
    if not hasattr(pawn, "arm_masks"):
        pawn.arm_masks = {p: arm_vertices(next(o for o in pawn.objects if o.name.startswith(p))) for p in BODY}
    verts, faces, base, lowest = [], [], 0, float("inf")
    for p in BODY:
        v, f = pawn.mesh_triangles(p)
        v = convert(v)
        lowest = min(lowest, float(v[:, 1].min()))
        verts.append(v)
        faces.append(f[~pawn.arm_masks[p][f].any(axis=1)] + base)
        base += len(v)
    return BVHTree.FromPolygons(np.vstack(verts).tolist(), np.vstack(faces).tolist()), lowest


def shield_tree(pawn, convert):
    pts, tris = pawn.mesh_triangles("SHIELD_tower")
    pts = convert(pts)
    return BVHTree.FromPolygons(pts.tolist(), tris.tolist()), pts


class Shapes:
    """The shield, the body without its arms, and the spear segment of one solved pose, in
    the pair frame, as BVH trees."""

    def __init__(self, pawn, convert, spear):
        self.shield, self.shield_points = shield_tree(pawn, convert)
        self.body, self.lowest = body_tree(pawn, convert)
        self.shield_lowest = float(self.shield_points[:, 1].min())
        self.grip, self.tip, self.butt = spear


def crossing(tree, a, b):
    """Distance along a → b to the first surface of the tree, or None."""
    d = Vector(b) - Vector(a)
    hit = tree.ray_cast(Vector(a), d.normalized(), d.length)
    return hit[3] if hit[0] is not None else None


def segments_gap(p, q, a, b):
    """Closest distance between segments p–q and a–b."""
    p, q, a, b = (np.array(v) for v in (p, q, a, b))
    d1, d2, r = q - p, b - a, p - a
    A, E, F = d1 @ d1, d2 @ d2, d2 @ r
    C, B = d1 @ r, d1 @ d2
    den = A * E - B * B
    sc = np.clip((B * F - C * E) / den, 0, 1) if den > 1e-12 else 0.0
    tc = (B * sc + F) / E
    if tc < 0:
        tc, sc = 0.0, np.clip(-C / A, 0, 1)
    elif tc > 1:
        tc, sc = 1.0, np.clip((B - C) / A, 0, 1)
    return float(np.linalg.norm(p + d1 * sc - a - d2 * tc))


# The attacker's point is in the defender's body from the hit until the thrust is drawn
# back (capture_design.py: the thrust falls over 3.72–4.1 s).
HIT_WINDOW = (design.HIT_TIME - 0.1, 4.1)


def opacity(t):
    """The board's fade of the taken pawn (board.mjs smooth is the cubic smoothstep)."""
    u = design.clamp((t - design.FADE[0]) / (design.FADE[1] - design.FADE[0]))
    return 1 - u * u * (3 - 2 * u)


def contacts(t, A, D):
    """Every contact between the two figures and their equipment in one frame. The
    attacker's point may enter the defender's body only around the hit."""
    out = []
    seen = opacity(t) > 0.3  # the taken pawn counts while it is still clearly there
    pairs = [("щит атакующего", A.shield, "тело атакующего", A.body)]
    if seen:
        pairs += [("щит защитника", D.shield, "тело защитника", D.body), ("щит защитника", D.shield, "тело атакующего", A.body),
                  ("щит атакующего", A.shield, "тело защитника", D.body), ("щит атакующего", A.shield, "щит защитника", D.shield)]
    for na, ta, nb, tb in pairs:
        n = len(ta.overlap(tb))
        if n:
            out.append(f"{na} пересекает {nb} ({n} пар треугольников)")
    if opacity(t) > 0.3 and A.body.overlap(D.body):
        out.append("тела фигур пересекаются")
    hit_window = HIT_WINDOW[0] <= t <= HIT_WINDOW[1]
    for who, S, other in ((("копьё атакующего", A, D), ("копьё защитника", D, A)) if seen else (("копьё атакующего", A, D),)):
        if seen and crossing(other.shield, S.butt, S.tip) is not None:
            out.append(f"{who} проходит сквозь щит противника")
        if crossing(S.shield, S.butt, S.tip) is not None:
            out.append(f"{who} проходит сквозь свой щит")
        if crossing(S.body, S.butt, S.tip) is not None:
            out.append(f"{who} проходит сквозь своё тело")
        if seen and crossing(other.body, S.butt, S.tip) is not None and not (S is A and hit_window):
            out.append(f"{who} входит в тело противника")
        if min(S.tip.y, S.butt.y) < -0.005:
            out.append(f"{who} уходит в доску")
    if seen and segments_gap(A.butt, A.tip, D.butt, D.tip) < 0.03:
        out.append("древки копий проходят друг сквозь друга")
    for who, S in (("атакующий", A), ("защитник", D)) if seen else (("атакующий", A),):
        if S.lowest < -0.005:
            out.append(f"{who}: тело ниже доски на {-S.lowest * 100:.1f} см")
        if S.shield_lowest < -0.005:
            out.append(f"{who}: щит ниже доски на {-S.shield_lowest * 100:.1f} см")
    return out


def pair_point(v):
    """A point of the defender (solved at the origin facing +z) in the pair frame; the same
    map takes a pair point into the defender's frame."""
    return Vector((-v[0], v[1], design.DISTANCE - v[2]))


def to_pair_array(points):
    return np.column_stack((-points[:, 0], points[:, 1], design.DISTANCE - points[:, 2]))


def to_pair_points(points):
    return {k: pair_point(v) for k, v in points.items()}


# ---------------------------------------------------------------------------------------
# The pair

def smooth_extra(times, need):
    """A per-frame correction made smooth: a running maximum over ±4 frames, then a
    ±3-frame Gaussian, never below what each frame needs. No corners, no jumps."""
    need = np.array(need)
    wide = np.array([need[max(0, i - 4):i + 5].max() for i in range(len(need))])
    k = np.exp(-0.5 * (np.arange(-9, 10) / 3.0) ** 2)
    k /= k.sum()
    out = np.maximum(np.convolve(np.pad(wide, 9, mode="edge"), k, mode="valid"), need)
    return {round(t * design.FPS): float(v) for t, v in zip(times, out) if v > 1e-4}


def bisect(ok, hi, steps=11):
    """Smallest e in [0, hi] with ok(e), assuming ok holds from some e on; hi if none."""
    if ok(0.0):
        return 0.0
    if not ok(hi):
        return hi
    lo = 0.0
    for _ in range(steps):
        mid = (lo + hi) / 2
        lo, hi = (lo, mid) if ok(mid) else (mid, hi)
    return hi


def first_ok(ok, hi, step=0.05, steps=6):
    """Smallest e in [0, hi] with ok(e) when ok holds only on a band (a shield raised too
    far meets the own helmet): scan up, then bisect down to the band's lower edge."""
    if ok(0.0):
        return 0.0
    lo, e = 0.0, step
    while e <= hi + 1e-9:
        if ok(e):
            for _ in range(steps):
                mid = (lo + e) / 2
                lo, e = (lo, mid) if ok(mid) else (mid, e)
            return e
        lo, e = e, e + step
    return hi


class Pair:
    def __init__(self, attacker, defender, actions, params):
        self.a, self.d, self.params = attacker, defender, dict(params)
        self.arms_pose = {k: v for k, v in actions[ARMS_ACTION].pose(0).items() if k.startswith(ARM_BONES)}
        # Corrections the fits add to the plan's arms, per figure and frame: the shield
        # raised forward clear of the own legs and the board, the spear turned out clear
        # of the own shield, its point lifted clear of the other shield, the board and
        # the own body.
        self.extra = {"a": {"raise": {}, "turn": {}, "lift": {}}, "d": {"raise": {}, "turn": {}, "lift": {}}}

    def arms(self, who, t, arms):
        e, i = self.extra[who], round(t * design.FPS)
        return {**arms, "raise": arms["raise"] + e["raise"].get(i, 0.0), "turn": arms["turn"] - e["turn"].get(i, 0.0),
                "aim": arms["aim"] - e["lift"].get(i, 0.0)}

    def plans(self, t):
        pa = design.attacker(t, **self.params)
        pd = design.defender_local(t, **self.params)
        return {**pa, "arms": self.arms("a", t, pa["arms"])}, {**pd, "arms": self.arms("d", t, pd["arms"])}

    def pose_attacker(self, t, target=None):
        pa = self.plans(t)[0]
        self.a.pose(pa, self.arms_pose, target)
        return pa

    def pose_defender(self, t, target=None):
        pd = self.plans(t)[1]
        self.d.pose(pd, self.arms_pose, None if target is None else pair_point(target))
        return pd

    def a_spear(self, pa):
        return self.a.board_spear(pa["arms"])

    def d_spear(self, pd):
        return tuple(pair_point(v) for v in self.d.board_spear(pd["arms"]))

    def fit_shields(self, times, clear=0.012):
        """Raises each shield forward (shoulder flexion) just enough that it clears the own
        legs and body, stepping and kneeling included, and the board."""
        top = {}
        for who, pawn in (("a", self.a), ("d", self.d)):
            need = []
            for t in times:
                plan = self.plans(t)[0 if who == "a" else 1]
                if who == "d" and t > design.FADE[1]:
                    need.append(need[-1] if need else 0.0)
                    continue
                pawn.pose(plan, self.arms_pose)
                body, _ = body_tree(pawn, lambda v: v)

                def ok(e):
                    pawn.reshield({**plan["arms"], "raise": plan["arms"]["raise"] + e})
                    tree, pts = shield_tree(pawn, lambda v: v)
                    return not tree.overlap(body) and float(pts[:, 1].min()) >= clear
                need.append(first_ok(ok, 0.7))
            self.extra[who]["raise"] = smooth_extra(times, need)
            top[who] = max(need)
        return top

    def fit_spears(self, times, clear=0.01):
        """Moves each spear only as far as it must: turned out to the right clear of the own
        shield, then its point lifted clear of the other figure's shield (a beat throws it
        up), of the board and of the own body. The attacker's point may stay in the
        defender's body around the hit."""
        need = {who: {"turn": [], "lift": []} for who in "ad"}
        for t in times:
            pa, pd = self.pose_attacker(t), None
            A_sh, _ = shield_tree(self.a, lambda v: v)
            A_body, _ = body_tree(self.a, lambda v: v)
            pd = self.pose_defender(t)
            D_sh, _ = shield_tree(self.d, to_pair_array)
            D_body, _ = body_tree(self.d, to_pair_array)
            seen = opacity(t) > 0.3
            for who, plan, own_sh, other_sh, own_body, spear in (
                    ("a", pa, A_sh, D_sh, A_body, self.a.board_spear),
                    ("d", pd, D_sh, A_sh, D_body, lambda arms: tuple(pair_point(v) for v in self.d.board_spear(arms)))):
                if who == "d" and t > design.FADE[1]:
                    need[who]["turn"].append(0.0)
                    need[who]["lift"].append(0.0)
                    continue
                arms = plan["arms"]

                def free_own(e):
                    g, tip, butt = spear({**arms, "turn": arms["turn"] - e})
                    return crossing(own_sh, butt, tip) is None
                turn = bisect(free_own, 0.8)

                def free(e):
                    g, tip, butt = spear({**arms, "turn": arms["turn"] - turn, "aim": arms["aim"] - e})
                    if seen and crossing(other_sh, butt, tip) is not None:
                        return False
                    if min(tip.y, butt.y) < clear or crossing(own_sh, butt, tip) is not None:
                        return False
                    return crossing(own_body, butt, tip) is None
                need[who]["turn"].append(turn)
                need[who]["lift"].append(bisect(free, 1.0))
        for who in "ad":
            for k in ("turn", "lift"):
                self.extra[who][k] = smooth_extra(times, need[who][k])
        return {who: {k: round(max(v), 3) for k, v in need[who].items()} for who in "ad"}


def solve_pair(pair, times, shapes=True):
    """Solves every frame: both figures with their gaze on each other, angles, spears and
    (shapes) every contact. Returns the frames and the measures."""
    out = {"a_frames": [], "d_frames": [], "a_ang": [], "d_ang": [], "tips": [], "d_tips": [], "arms_a": [], "arms_d": [],
           "gaze": [], "contacts": [], "drops": [0.0, 0.0], "bite": []}
    d_eye = Vector((0.0, 1.65, design.DISTANCE - 0.12))
    for t in times:
        pa = pair.pose_attacker(t, d_eye)
        a_points = pair.a.points()
        a_eye, a_gaze = pair.a.gaze()
        out["a_frames"].append((t, a_points))
        out["a_ang"].append(angles(pair.a, a_points))
        a_spear = pair.a_spear(pa)
        out["drops"][0] = max(out["drops"][0], pair.a.drop)
        A = Shapes(pair.a, lambda v: v, a_spear) if shapes else None
        pd = pair.pose_defender(t, a_eye)
        d_points = pair.d.points()
        eye_l, gaze_l = pair.d.gaze()
        d_eye, d_gaze = pair_point(eye_l), Vector((-gaze_l.x, gaze_l.y, -gaze_l.z))
        out["d_frames"].append((t, to_pair_points(d_points)))
        out["d_ang"].append(angles(pair.d, d_points))
        d_spear = pair.d_spear(pd)
        out["drops"][1] = max(out["drops"][1], pair.d.drop)
        out["tips"].append(a_spear[1])
        out["d_tips"].append(d_spear[1])
        out["arms_a"].append([pa["arms"][k] for k in ARM_FIELDS])
        out["arms_d"].append([pd["arms"][k] for k in ARM_FIELDS])
        out["gaze"].append((t, math.degrees(a_gaze.angle(d_eye - a_eye)), math.degrees(d_gaze.angle(a_eye - d_eye))))
        if shapes:
            D = Shapes(pair.d, to_pair_array, d_spear)
            out["contacts"].append((t, contacts(t, A, D)))
            if HIT_WINDOW[0] <= t <= HIT_WINDOW[1]:
                depth = crossing(D.body, A.grip, A.tip)
                out["bite"].append((t, None if depth is None else (A.tip - A.grip).length - depth))
    return out


# ---------------------------------------------------------------------------------------
# Aiming: the plan's free numbers are solved on the rig

def shield_frame(cloud, towards):
    """Centre of a shield's front face, the face's normal towards a point, the horizontal
    axis across the face and the axis up the face, pair frame. cloud: N×3 vertices."""
    c = cloud.mean(axis=0)
    n = np.linalg.svd(cloud - c, full_matrices=False)[2][2]
    if (np.array(towards) - c) @ n < 0:
        n = -n
    front = c + n * float(np.max((cloud - c) @ n))
    face = Vector(n.tolist())
    lateral = face.cross(Vector((0, 1, 0))).normalized()
    return Vector(front.tolist()), face, lateral, lateral.cross(face).normalized()


def guard_error(pair):
    """The defender's guard: its spear's heading onto the attacker's chest (radians)."""
    t = 1.5
    pa = pair.pose_attacker(t)
    chest = pair.a.points()["chest"]
    pd = pair.pose_defender(t)
    grip, tip, _ = pair.d_spear(pd)
    d, want = tip - grip, chest - grip
    e = math.atan2(d.x, d.z) - math.atan2(want.x, want.z)
    return Vector(((e + math.pi) % (2 * math.pi) - math.pi, 0.0))  # mathutils needs two


COUNTER_GAP = 0.03  # the counter-thrust's point stops this far off the attacker's shield
FEINT_TIME = 2.8    # the feint holds and the defender's shield has arrived
FEINT_GAP = 0.06    # the feint's point stops this far short of that shield's face


def counter_error(pair):
    """The counter-thrust at COUNTER_TIME: its point on the attacker's shield, across and
    up the face from the centre, and in front of the face less COUNTER_GAP."""
    t = pair.params["counter_time"]
    pair.pose_attacker(t)
    cloud = pair.a.mesh_points("SHIELD_tower")
    pd = pair.pose_defender(t)
    grip, tip, _ = pair.d_spear(pd)
    front, face, lateral, up = shield_frame(cloud, grip)
    r = tip - front
    return Vector((r @ lateral, r @ up - 0.05, r @ face - COUNTER_GAP))


def feint_error(pair):
    """Where the feint's point stands against the arriving shield: across its face from
    the centre, and in front of its face less FEINT_GAP."""
    t = FEINT_TIME
    pa = pair.pose_attacker(t)
    grip, tip, _ = pair.a_spear(pa)
    pair.pose_defender(t)
    front, face, lateral, _ = shield_frame(to_pair_array(pair.d.mesh_points("SHIELD_tower")), grip)
    return Vector(((tip - front) @ lateral, (tip - front) @ face - FEINT_GAP))


BITE = 0.05  # the point goes this far past the armour at the hit


def hit_error(pair):
    """Spear tip less its target at the hit. The target is the defender's open flank, as
    choreography.mjs aims: its left side below the ribs (the line 0.19 m out from the
    trunk axis and 0.05 m back, towards the spine), BITE past the surface there."""
    t = design.HIT_TIME
    pa = pair.pose_attacker(t)
    tip = pair.a_spear(pa)[1]
    pair.pose_defender(t)
    d = pair.d.points()
    left, _, fwd = frame_of(d)[1]
    flank = d["spine"].lerp(d["chest"], 0.3) + left * 0.19 - fwd * 0.05
    inward = Vector((d["spine"].x - flank.x, 0, d["spine"].z - flank.z)).normalized()
    # The surface of the armoured flank along that line, then BITE into it.
    body, _ = body_tree(pair.d, lambda v: v)
    start = flank - inward * 0.4
    hit = body.ray_cast(start, inward, 0.8)
    surface = hit[0] if hit[0] is not None else flank
    return tip - pair_point(surface + inward * BITE)


def newton(pair, error, keys, tol=0.004):
    """Newton steps on the named parameters of the plan until the error vanishes."""
    e = error(pair)
    for _ in range(8):
        if e.length < tol:
            break
        h = 0.01
        base = dict(pair.params)
        cols = []
        for k in keys:
            pair.params = {**base, k: base[k] + h}
            cols.append((error(pair) - e) / h)
        pair.params = base
        J = np.array([list(c) for c in cols]).T
        step = np.linalg.lstsq(J, np.array(list(e)), rcond=None)[0]
        for k, v in zip(keys, step):
            lo, hi = BOUNDS[k]
            pair.params[k] = min(hi, max(lo, pair.params[k] - max(-0.3, min(0.3, float(v)))))
        e = error(pair)
    return e.length


def aim(pair):
    """Solves the free numbers of the plan on the rig in turn: the defender's guard onto
    the attacker, its counter-thrust onto the attacker's shield, the attacker's feint
    onto the defender's shield and its strike into the open flank. The approach moves
    everything after it, so the loop repeats until all four hold."""
    for i in range(5):
        g = newton(pair, guard_error, ("guard_yaw",), tol=0.01)
        c = newton(pair, counter_error, ("counter_time", "counter_yaw", "counter_bend"))
        f = newton(pair, feint_error, ("feint_yaw", "feint_reach"))
        h = newton(pair, hit_error, ("approach", "strike_yaw", "strike_bend"))
        g, c, f = guard_error(pair).length, counter_error(pair).length, feint_error(pair).length
        print(f"  круг {i + 1}: защита {math.degrees(g):.1f}°, контрвыпад {c * 100:.1f} см, финт {f * 100:.1f} см, "
              f"удар {h * 100:.1f} см")
        if g < 0.01 and max(c, f, h) < 0.005:
            break
    return pair.params


# ---------------------------------------------------------------------------------------
# Smoothness and gaze

def smoothness(times, series):
    """Angular velocity and acceleration of every joint angle (degrees per s and s²), by
    central differences at the clip's rate. Returns the peaks per joint."""
    keys = [k for k in series[0] if all(k in s for s in series)]
    dt = times[1] - times[0]
    out = {}
    for k in keys:
        x = np.array([s[k] for s in series])
        v = np.gradient(x, dt)
        a = np.zeros_like(x)
        a[1:-1] = (x[2:] - 2 * x[1:-1] + x[:-2]) / dt ** 2
        i = int(np.argmax(np.abs(a)))
        out[k] = {"v": round(float(np.max(np.abs(v)))), "a": round(float(np.abs(a[i]))), "at": round(times[i], 2)}
    return out


def path_smoothness(times, path):
    """Peak speed and acceleration of a point's path (m/s, m/s²)."""
    p = np.array([list(v) for v in path])
    dt = times[1] - times[0]
    v = np.linalg.norm(np.gradient(p, dt, axis=0), axis=1)
    a = np.linalg.norm(p[2:] - 2 * p[1:-1] + p[:-2], axis=1) / dt ** 2
    i = int(np.argmax(a))
    return {"v": round(float(v.max()), 2), "a": round(float(a[i]), 1), "at": round(times[i + 1], 2)}


# Limits for "a jerk": a sharp joint reversal in human movement stays under about
# 20 000 °/s² even in kicking and throwing (Putnam 1993; Fleisig et al. 1996 for the
# elbow and shoulder of a pitch). A drill step, a lunge and a fall stay far below; a
# frame above this is a corner in the curve, not a movement.
JERK = 20000.0
GAZE_LIMIT = 15.0  # degrees between the gaze and the line to the opponent's eyes


def clip(name, label, role, frames, partner):
    return {"name": name, "label": label, "role": role, "loop": False, "fps": design.FPS, "frame": "shared",
            "partner": partner, "frames": [{k: [round(c, 4) for c in v] for k, v in p.items()} for _, p in frames]}


def motion_file(a_frames, d_frames, arms_a, arms_d):
    points = ["pelvis", "spine", "chest", "neck", "head", "eyeL", "eyeR", "hipL", "kneeL", "ankleL", "toeL",
              "hipR", "kneeR", "ankleR", "toeR", "shoulderL", "elbowL", "wristL", "shoulderR", "elbowR", "wristR"]
    clips = [clip("pawn-capture-strike", "Пешка берёт пешку: атакующий", "strike", a_frames, "pawn-capture-struck"),
             clip("pawn-capture-struck", "Пешка берёт пешку: защитник", "struck", d_frames, "pawn-capture-strike")]
    out = []
    for c, arms in zip(clips, (arms_a, arms_d)):
        data = []
        for f in c.pop("frames"):
            for p in points:
                data += f[p]
        extra = {"arms": {"action": ARMS_ACTION, "fields": list(ARM_FIELDS),
                          "data": [round(v, 4) for row in arms for v in row]}}
        if c["role"] == "struck":
            extra["fade"] = list(design.FADE)
        out.append({**c, "frames": len(data) // (3 * len(points)), "data": data, **extra})
    return {"format": "lazy-chess.motion", "version": 1,
            "source": {"kind": "blender", "name": "Пешка берёт пешку (Blender, скелет пешки)",
                       "license": "собственная работа проекта, как и модель пешки",
                       "note": "tools/blender/pawn_capture.py: план тела и рук capture_design.py, ноги — IK, взгляд — на противника в пределах шеи"},
            "points": points, "clips": out}


def render(pair, times, out_dir):
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
    pair.a.show_loadout()
    pair.d.show_loadout()
    paths = []
    for t in times:
        pair.pose_attacker(t, Vector((0.0, 1.65, design.DISTANCE - 0.12)))
        pair.pose_defender(t, pair.a.gaze()[0])
        scene.render.filepath = os.path.join(out_dir, f"blender-{t:.2f}.png")
        bpy.ops.render.render(write_still=True)
        paths.append(scene.render.filepath)
    return paths


PARAMS = ("approach", "strike_yaw", "strike_bend", "feint_yaw", "feint_reach", "guard_yaw", "counter_time",
          "counter_yaw", "counter_bend")
# Where each solved number may go: a drill approach, a fencing stamp and lunge, turns the
# trunk and pelvis can take, and a counter while the attacker is still closing in.
BOUNDS = {"approach": (0.8, 1.5), "strike_yaw": (-0.3, 0.6), "strike_bend": (-0.2, 0.35), "feint_yaw": (0.0, 0.7),
          "feint_reach": (0.05, 0.85), "guard_yaw": (-0.3, 0.45), "counter_time": (1.3, 2.2), "counter_yaw": (-0.35, 0.35),
          "counter_bend": (-0.15, 0.35)}


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=os.path.join(HERE, "out"), help="кадры и черновики")
    ap.add_argument("--motions", default=os.path.normpath(os.path.join(HERE, "../../motions")), help="куда положить клип и отчёт проверок")
    ap.add_argument("--aim", action="store_true", help="подобрать защиту, контрвыпад, финт и удар")
    ap.add_argument("--render", default="", help="времена кадров Cycles через запятую, например 0,1.9,3.45")
    args = ap.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)
    os.makedirs(args.motions, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    attacker = load_pawn()
    defender = load_pawn()
    actions = {a.name.split(".")[0]: ActionSampler(a) for a in bpy.data.actions if a.name in ("Guard_Breath", "Spear_Study")}
    guard = actions["Guard_Breath"].pose(0)
    for pawn in (attacker, defender):
        pawn.calibrate(guard)
    place(attacker, (0, 0), 0)
    place(defender, (0, 0), 0)  # solved at the origin; the pair frame turns it around

    pair = Pair(attacker, defender, actions, {k: getattr(design, k.upper()) for k in PARAMS})
    if args.aim:
        aim(pair)
        print("\n".join(f"{k.upper()} = {pair.params[k]:.4f}" for k in PARAMS))
    hit = hit_error(pair)
    errors = {"guard_deg": math.degrees(guard_error(pair)[0]), "counter_cm": counter_error(pair).length * 100,
              "feint_cm": feint_error(pair).length * 100, "hit_cm": hit.length * 100}

    times = design.frames()
    fitted = {"shield_raise": pair.fit_shields(times)}
    fitted["spear"] = pair.fit_spears(times)
    print("Поправки рук:", fitted)
    hit = hit_error(pair)
    errors["hit_cm"] = hit.length * 100
    r = solve_pair(pair, times)
    g = attacker.guard
    ground = {"toe": min(g["toeL"].y, g["toeR"].y), "ankle": min(g["ankleL"].y, g["ankleR"].y)}
    a_static = lambda t: 1.95 <= t <= 3.0 or 4.4 <= t <= 4.6 or t <= 0.3
    d_static = lambda t: t <= design.HIT_TIME
    both = lambda t: "LR"
    smooth_a, smooth_d = smoothness(times, r["a_ang"]), smoothness(times, r["d_ang"])
    gaze_a = [(t, a) for t, a, _ in r["gaze"] if t <= design.FADE[1]]
    gaze_d = [(t, d) for t, _, d in r["gaze"] if t <= design.HIT_TIME]
    report = {
        "params": {k: round(v, 4) for k, v in pair.params.items()},
        "aim": {k: round(v, 2) for k, v in errors.items()},
        "hit": {"miss_cm": round(math.hypot(hit.x, hit.z) * 100, 1), "height_cm": round(hit.y * 100, 1),
                "bite_cm": [[round(t, 3), None if b is None else round(b * 100, 1)] for t, b in r["bite"]]},
        "attacker": check("атакующий", r["a_frames"], r["a_ang"], ground, a_static, both),
        "defender": check("защитник", r["d_frames"], r["d_ang"], ground, d_static, both),
        "gaze_deg": {"attacker_max": round(max(a for _, a in gaze_a), 1), "defender_max": round(max(d for _, d in gaze_d), 1)},
        "smoothness": {"attacker": smooth_a, "defender": smooth_d,
                       "spear_tip": {"attacker": path_smoothness(times, r["tips"]), "defender": path_smoothness(times, r["d_tips"])}},
        "arm_fits_rad": fitted,
        "pelvis_settle_cm": {"attacker": round(r["drops"][0] * 100, 1), "defender": round(r["drops"][1] * 100, 1)},
        "contacts": [[round(t, 3), c] for t, c in r["contacts"] if c],
    }
    with open(os.path.join(args.motions, "pawn-capture.motion.json"), "w") as f:
        json.dump(motion_file(r["a_frames"], r["d_frames"], r["arms_a"], r["arms_d"]), f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(args.motions, "pawn-capture.checks.json"), "w") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    issues = report["attacker"]["issues"] + report["defender"]["issues"]
    issues += [f"{t:.2f}s: {c}" for t, cs in r["contacts"] for c in cs]
    issues += [f"атакующий {t:.2f}s: взгляд мимо защитника на {a:.0f}°" for t, a in gaze_a if a > GAZE_LIMIT]
    issues += [f"защитник {t:.2f}s: взгляд мимо атакующего на {d:.0f}°" for t, d in gaze_d if d > GAZE_LIMIT]
    for who, sm in (("атакующий", smooth_a), ("защитник", smooth_d)):
        issues += [f"{who}: рывок в {k} {v['a']}°/с² в {v['at']}s" for k, v in sm.items() if v["a"] > JERK]
    for k, v in errors.items():
        if (k == "guard_deg" and abs(v) > 1.0) or (k != "guard_deg" and v > 1.0):
            issues.append(f"наведение {k}: {v:.1f}")
    print(f"Попадание: промах {report['hit']['miss_cm']} см по горизонтали, {report['hit']['height_cm']} см по высоте; "
          f"наведение {report['aim']}")
    print("Взгляд, наибольшее отклонение:", report["gaze_deg"])
    print("Диапазоны, атакующий:", report["attacker"]["ranges"])
    print("Диапазоны, защитник:", report["defender"]["ranges"])
    top = lambda sm: sorted(((v["a"], k, v["at"]) for k, v in sm.items()), reverse=True)[:4]
    print("Ускорения суставов, атакующий:", top(smooth_a), " защитник:", top(smooth_d))
    print("Копья:", report["smoothness"]["spear_tip"])
    print(f"Замечаний: {len(issues)}")
    for line in issues[:60]:
        print("  " + line)
    if args.render:
        place(defender, (0, design.DISTANCE), math.pi)
        for p in render(pair, [float(x) for x in args.render.split(",") if x], args.out):
            print("кадр:", p)
    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]))
