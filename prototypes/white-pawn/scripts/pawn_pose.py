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
_LEFT_WRIST_LOCAL = None


def configure(rig):
    global _RIG, _REST, _HAND, _LEFT_WRIST_LOCAL
    _RIG = rig
    _LEFT_WRIST_LOCAL = None
    _REST = {b.name: b.matrix_local.copy() for b in rig.data.bones}
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
        center = (index + little + wrist) / 3
        thumbs = {}
        for j in range(1, 4):
            b = bones[f'finger1-{j}.{side}']
            direction = (b.tail_local - b.head_local).normalized()
            toward = (center - b.head_local).normalized()
            axis = direction.cross(toward)
            thumbs[j] = axis.normalized() if axis.length > .01 else flex.copy()
        _HAND[side] = dict(across=across, forward=forward, flex=flex,
                           normal=normal, thumb_axes=thumbs)
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
    pb = _RIG.pose.bones
    shoulder = pb['upperarm01.' + side].head.copy()
    elbow = pb['lowerarm01.' + side].head.copy()
    wrist = pb['wrist.' + side].head.copy()
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
    _aim('upperarm01.' + side, elbow - shoulder, wanted_elbow - shoulder)
    elbow = pb['lowerarm01.' + side].head.copy()
    wrist = pb['wrist.' + side].head.copy()
    _aim('lowerarm01.' + side, wrist - elbow, wanted_wrist - elbow)


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
    for j, angle in [(1, 28.90), (2, 63.23), (3, 13.17)]:
        _rot(f'finger1-{j}.{side}', hand['thumb_axes'][j], angle)


def _pulse(t, start=.25, peak=1.6, hold=2.0, end=3.75):
    def smooth(u):
        u = max(0, min(1, u))
        return u*u*(3-2*u)
    if t <= peak:
        return smooth((t-start)/(peak-start))
    if t <= hold:
        return 1.
    return 1-smooth((t-hold)/(end-hold))


def apply_pose(kind='rest', t=0.):
    global _LEFT_WRIST_LOCAL
    if _RIG is None:
        raise RuntimeError('Call configure(rig) first')
    reset_pose()
    breath = math.sin(math.pi*2*max(0, min(6, t))/6) if kind == 'Guard_Breath' else 0.
    brace = _pulse(t) if kind == 'Shield_Brace' else 0.
    thrust = _pulse(t, .25, 1.75, 2.0, 3.75) if kind == 'Spear_Study' else 0.
    _rot('spine03', (1, 0, 0), -1.0 - 2.1*brace - 1.2*thrust)
    _rot('spine01', (1, 0, 0), -.4*breath)
    _rot('head', (1, 0, 0), 1.0 + 1.5*brace)
    bpy.context.view_layer.update()
    left = Vector((.10, -.24 - .055*brace, 1.14 + .025*brace + .002*breath))
    right = Vector((-.325, -.245 - .100*thrust, 1.13 - .050*thrust + .002*breath))
    _arm('L', left, (1., -.8, -.15))
    # Raising the elbow while lowering the wrist keeps the hand aligned with
    # the forearm as the spear is presented; no isolated wrist droop.
    right_pole = Vector((-.7, .4, -1.5)).lerp(Vector((-1., .2, .2)), thrust)
    _arm('R', right, right_pole)
    spear_axis = Vector((0, -math.sin(math.radians(45)*thrust), math.cos(math.radians(45)*thrust)))
    _wrist('R', spear_axis, Vector((1, 0, 0)).cross(spear_axis))
    shield_right = _RIG.pose.bones['lowerarm01.L'].head - _RIG.pose.bones['wrist.L'].head
    shield_right.z = 0
    shield_right.normalize()
    if _LEFT_WRIST_LOCAL is None:
        _wrist('L', (0, 0, 1), -shield_right)
        _LEFT_WRIST_LOCAL = _RIG.pose.bones['wrist.L'].rotation_quaternion.copy()
    else:
        _RIG.pose.bones['wrist.L'].rotation_quaternion = _LEFT_WRIST_LOCAL.copy()
        bpy.context.view_layer.update()
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
    shield['back_center'] = shield['point'] - shield_up*.19 + shield['normal']*.075
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
