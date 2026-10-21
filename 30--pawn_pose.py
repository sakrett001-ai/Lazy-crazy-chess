"""Deterministic fitted poses for the first white pawn (metres, Blender Z-up).

The body uses the unchanged MakeHuman rig. Limbs are solved from anatomical
shoulder/elbow/wrist landmarks, and weapons follow the same palm frames.
These solo studies do not implement chess captures or paired combat.
"""
import math
import bpy
from mathutils import Vector, Quaternion, Matrix

_RIG = None
_REST = {}
_HAND = {}
_FOOT_TARGETS = {}
_LEFT_GUARD = None
_SOLVES = {}
# Authored local rotations for the unchanged MakeHuman thumb chain (w,x,y,z).
# Unlike the previous curl-to-palm heuristic, these oppose the thumb across
# the cylinder and keep its distal skin outside the palm. They are pose
# offsets, not anatomical joint angles; the source thumb is already curved.
_THUMB_GRIP_R = (
    (.987224996, -.032383014, .019823313, -.154742315),
    (.964804769, -.220435858, .137705535, -.039961629),
    (.863410830, .361466289, -.053641222, -.347831130),
)


def configure(rig):
    global _RIG, _REST, _HAND, _FOOT_TARGETS, _LEFT_GUARD
    _RIG = rig
    _LEFT_GUARD = None
    _REST = {b.name: b.matrix_local.copy() for b in rig.data.bones}
    # The complete sole keeps its bind orientation. The small stagger is part
    # of the guard, not an unannounced step halfway through a clip.
    _FOOT_TARGETS = {
        side: rig.data.bones['foot.' + side].head_local.copy()
              + Vector((0, -.10 if side == 'L' else .10, 0))
        for side in ('L', 'R')
    }
    _HAND = {}
    for side, sign in [('L', 1), ('R', -1)]:
        bones = rig.data.bones
        wrist = bones['wrist.' + side].head_local
        index = bones['finger2-1.' + side].head_local
        little = bones['finger5-1.' + side].head_local
        across = (index - little).normalized()
        forward = bones['finger3-1.' + side].head_local - wrist
        forward = (forward - across * forward.dot(across)).normalized()
        flex = across * (-1 if side == 'L' else 1)
        normal = flex.cross(forward).normalized()
        _HAND[side] = dict(across=across, forward=forward, flex=flex,
                           normal=normal)
    apply_pose('rest', 0.)
    reset_pose()
    return rig


def reset_pose():
    for p in _RIG.pose.bones:
        p.rotation_mode = 'QUATERNION'
        p.rotation_quaternion = Quaternion()
        p.location = (0, 0, 0)
        p.scale = (1, 1, 1)
    bpy.context.view_layer.update()


def _rot(name, axis, degrees):
    p = _RIG.pose.bones[name]
    local = p.bone.matrix_local.to_3x3().inverted() @ Vector(axis)
    p.rotation_quaternion = p.rotation_quaternion @ Quaternion(local, math.radians(degrees))


def _world_quaternion(name, quaternion):
    p = _RIG.pose.bones[name]
    matrix = quaternion.to_matrix().to_4x4()
    matrix.translation = p.head.copy()
    p.matrix = matrix
    bpy.context.view_layer.update()


def _aim(name, current_vector, desired_vector):
    p = _RIG.pose.bones[name]
    delta = current_vector.normalized().rotation_difference(desired_vector.normalized())
    _world_quaternion(name, delta @ p.matrix.to_quaternion())


def _arm(side, target, pole):
    """Two anatomical links, keeping each original split segment intact."""
    _two_link('upperarm01.' + side, 'lowerarm01.' + side,
              'wrist.' + side, target, pole)


def _two_link(upper, lower, end, target, pole):
    """Reach with rotations only; record any unreachable target explicitly."""
    pb = _RIG.pose.bones
    shoulder = pb[upper].head.copy()
    elbow = pb[lower].head.copy()
    wrist = pb[end].head.copy()
    l1, l2 = (elbow - shoulder).length, (wrist - elbow).length
    direction = Vector(target) - shoulder
    distance = min(max(direction.length, abs(l1 - l2) + .002), l1 + l2 - .002)
    direction.normalize()
    projected = Vector(pole) - direction * Vector(pole).dot(direction)
    projected.normalize()
    along = (l1*l1 - l2*l2 + distance*distance) / (2*distance)
    height = math.sqrt(max(0, l1*l1 - along*along))
    wanted_elbow = shoulder + direction*along + projected*height
    wanted_wrist = shoulder + direction*distance
    _aim(upper, elbow - shoulder, wanted_elbow - shoulder)
    elbow = pb[lower].head.copy()
    wrist = pb[end].head.copy()
    _aim(lower, wrist - elbow, wanted_wrist - elbow)
    _SOLVES[end] = {'target_error_m': (pb[end].head - Vector(target)).length,
                   'reach_m': (Vector(target) - shoulder).length,
                   'link_sum_m': l1 + l2}


def _stance(translation):
    root = _REST['root'].copy()
    root.translation += Vector(translation)
    _RIG.pose.bones['root'].matrix = root
    bpy.context.view_layer.update()
    for side, sign in [('L', 1), ('R', -1)]:
        _two_link('upperleg01.' + side, 'lowerleg01.' + side,
                  'foot.' + side, _FOOT_TARGETS[side], (sign*.06, -1, 0))
        _world_quaternion('foot.' + side, _REST['foot.' + side].to_quaternion())


def _wrist(side, shaft_axis, hand_forward):
    """Keep anatomical index/little axis aligned with the handle."""
    a = Vector(shaft_axis).normalized()
    f = Vector(hand_forward)
    f = (f - a*f.dot(a)).normalized()
    rest = _HAND[side]
    source = Matrix((rest['across'], rest['forward'], rest['across'].cross(rest['forward']))).transposed()
    target = Matrix((a, f, a.cross(f))).transposed()
    delta = target @ source.transposed()
    q = delta.to_quaternion() @ _REST['wrist.' + side].to_quaternion()
    _world_quaternion('wrist.' + side, q)


def _grip(side):
    # Fit against the actual skinned hand surface, including thumb and MCP transitions.
    # Offsets are constrained to natural flexion; the source fingers are already curved.
    # A 28 mm handle keeps the palm supported without hyperextending the knuckles.
    hand = _HAND[side]
    angles = {2: (24.24, 52.18, 28.91), 3: (35.74, 63.39, 30.01),
              4: (33.56, 56.73, 32.29), 5: (22.08, 49.69, 26.00)}
    for finger in range(2, 6):
        for joint, angle in enumerate(angles[finger], 1):
            _rot(f'finger{finger}-{joint}.{side}', hand['flex'], angle)
    for j, values in enumerate(_THUMB_GRIP_R, 1):
        w, x, y, z = values
        if side == 'L':
            y, z = -y, -z
        _RIG.pose.bones[f'finger1-{j}.{side}'].rotation_quaternion = Quaternion((w, x, y, z)).normalized()


def _smooth(t, start, end):
    u = max(0., min(1., (t-start)/(end-start)))
    return u*u*u*(u*(u*6.-15.)+10.)


def _envelope(t, start, peak, hold, end):
    return _smooth(t, start, peak) * (1.-_smooth(t, hold, end))


def phase_state(kind, t):
    """Named absolute-time phases shared by posing and diagnostic sampling."""
    t = max(0., float(t))
    if kind == 'Shield_Brace':
        return dict(prepare=_envelope(t, .20, .65, 1.05, 1.65),
                    brace=_envelope(t, .65, 1.65, 2.10, 3.70), aim=0., thrust=0.)
    if kind == 'Spear_Study':
        return dict(prepare=_envelope(t, .20, .65, 1.25, 1.90), brace=0.,
                    aim=_envelope(t, .55, 1.20, 2.80, 3.75),
                    thrust=_envelope(t, 1.25, 1.90, 2.10, 2.80))
    return dict(prepare=0., brace=0., aim=0., thrust=0.)


def _shield_arm(brace):
    """Move the whole forearm; retain the enarmes' relative wrist frame.

    The shield yaws slightly, rather than hinging its bottom out. Both arm
    links retain their original length and the forearm/handle form one unit.
    """
    global _LEFT_GUARD
    pb = _RIG.pose.bones
    if _LEFT_GUARD is None:
        _arm('L', (.10, -.24, 1.14), (1., -.8, -.15))
        shield_right = pb['lowerarm01.L'].head - pb['wrist.L'].head
        shield_right.z = 0.
        _wrist('L', (0, 0, 1), -shield_right.normalized())
        _LEFT_GUARD = dict(
            upper=pb['lowerarm01.L'].head-pb['upperarm01.L'].head,
            forearm_q=pb['lowerarm01.L'].matrix.to_quaternion(),
            wrist_q=pb['wrist.L'].matrix.to_quaternion())
        return
    direction = _LEFT_GUARD['upper'] + Vector((-.015*brace, -.025*brace, .005*brace))
    direction.normalize()
    _aim('upperarm01.L', pb['lowerarm01.L'].head-pb['upperarm01.L'].head, direction)
    turn = Quaternion((0, 0, 1), math.radians(12.*brace))
    _world_quaternion('lowerarm01.L', turn @ _LEFT_GUARD['forearm_q'])
    _world_quaternion('wrist.L', turn @ _LEFT_GUARD['wrist_q'])


def apply_pose(kind='rest', t=0.):
    if _RIG is None:
        raise RuntimeError('Call configure(rig) first')
    reset_pose()
    _SOLVES.clear()
    breath = math.sin(math.pi*2*max(0, min(6, t))/6) if kind == 'Guard_Breath' else 0.
    phase = phase_state(kind, t)
    brace, thrust, aim, prepare = (phase[k] for k in ('brace', 'thrust', 'aim', 'prepare'))
    shift = Vector((.012*brace, .020*prepare-.100*brace-.085*thrust,
                    -.040-.018*prepare-.006*brace+.004*thrust))
    _stance(shift)
    _rot('spine03', (1, 0, 0), -1.0 - 3.0*brace - 2.0*thrust + .8*prepare)
    _rot('spine02', (0, 0, 1), -4.0*aim - 3.0*thrust)
    _rot('spine01', (1, 0, 0), -.4*breath)
    _rot('head', (1, 0, 0), 1.0 + 1.5*brace)
    bpy.context.view_layer.update()
    _shield_arm(brace)
    spear_axis = Vector((0, -math.sin(math.radians(85)*aim), math.cos(math.radians(85)*aim)))
    right = Vector((-.325-.025*aim, -.245+.085*aim, 1.13-.040*aim+.002*breath))
    # During the drive the aim is already held: wrist, grip and tip advance
    # together along one fixed shaft direction, supported by the pelvis.
    right += spear_axis*(.220*thrust)
    right_pole = Vector((-.7, .4, -1.5)).lerp(Vector((-1., .1, 1.2)), aim)
    _arm('R', right, right_pole)
    forward = Vector((1, 0, 0)).cross(spear_axis).lerp(Vector((.28, 0, -.96)), aim)
    _wrist('R', spear_axis, forward)
    _grip('L')
    _grip('R')
    bpy.context.view_layer.update()
    return equipment_frames()


def _hand_frame(side):
    pb = _RIG.pose.bones
    rest = _HAND[side]
    deformation = pb['wrist.' + side].matrix @ _REST['wrist.' + side].inverted()
    direction = deformation.to_3x3() @ rest['forward']
    normal = deformation.to_3x3() @ rest['normal']
    axis = deformation.to_3x3() @ rest['across']
    # Average knuckle line is stable under grip flex and transforms with wrist.
    knuckles = [_RIG.data.bones[f'finger{i}-1.{side}'].head_local for i in range(2, 6)]
    center = sum(knuckles, Vector()) / 4
    center = deformation @ center + normal * .038 + direction * -.020
    return dict(point=center, axis=axis.normalized(), forward=direction.normalized(),
                palm_normal=normal.normalized(), bone='wrist.' + side)


def equipment_frames():
    spear = _hand_frame('R')
    shield = _hand_frame('L')
    shield_right = -shield['forward']
    shield_up = shield['axis']
    shield['normal'] = shield_right.cross(shield_up).normalized()
    # Central point of the curved leather backing in build_pawn.py:
    # nominal .105 depth + .055 convex crown - .027 backing recess.
    shield['back_center'] = (shield['point'] - shield_up*.19
                             + shield_right*.04 + shield['normal']*.133)
    shield['grip_point'] = shield['point'].copy()
    shield['handle_axis'] = shield['axis'].copy()
    spear['shaft_radius'] = .0125
    spear['leather_radius'] = .014
    spear['shaft_below_grip'] = 1.00
    spear['shaft_above_grip'] = 1.32
    elbow = _RIG.pose.bones['lowerarm01.L'].head.copy()
    wrist = _RIG.pose.bones['wrist.L'].head.copy()
    forearm_axis = (wrist - elbow).normalized()
    strap_centers = [elbow.lerp(wrist, f) for f in (.35, .65)]
    return {'spear': spear, 'shield': shield,
            'spear_grip': spear['point'], 'spear_axis': spear['axis'], 'spear_bone': 'wrist.R',
            'shield_grip': shield['point'], 'shield_right': shield_right,
            'shield_up': shield_up, 'shield_handle_axis': shield['axis'],
            'shield_bone': 'wrist.L', 'shield_forearm_axis': forearm_axis,
            'shield_strap_centers': strap_centers}


def measure_contacts():
    """Joint center radii around each shaft; not a full skin collision test."""
    result = {}
    for side, kind in [('R', 'spear'), ('L', 'shield')]:
        f = _hand_frame(side)
        distances = []
        for i in range(2, 6):
            for j in range(1, 4):
                p = _RIG.pose.bones[f'finger{i}-{j}.{side}'].tail
                d = p - f['point']
                distances.append((d - f['axis']*d.dot(f['axis'])).length)
        result[kind] = {'joint_distance_min_m': min(distances), 'joint_distance_max_m': max(distances),
                        'grip_point': list(f['point']), 'axis': list(f['axis'])}
    return result
