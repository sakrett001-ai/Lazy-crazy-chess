"""White pawn fitting study. Original equipment over the preserved CC0 human base.
Blender 4.5, metres, forward -Y; exports the same scene that is rendered.
"""
from pathlib import Path
import bpy, math, json, hashlib, sys, time
from mathutils import Vector, Matrix, Quaternion
from mathutils.bvhtree import BVHTree
ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT.parent/'human-base'
sys.path.insert(0,str(ROOT/'scripts'))
import pawn_pose
OUT=ROOT/'assets'; REVIEW=ROOT/'review'
OUT.mkdir(exist_ok=True); REVIEW.mkdir(exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(BASE/'assets/human-base.blend'))
scene=bpy.context.scene; rig=bpy.data.objects['HumanBase_Rig']; rig.name='WhitePawn_Rig'
rig.animation_data_clear()
for action in list(bpy.data.actions):bpy.data.actions.remove(action)
for ob in list(bpy.data.objects):
 if ob.type in {'LIGHT','CAMERA'} or ob.name.startswith('socket_') or ob.name in {'Studio floor','Training shorts'}:bpy.data.objects.remove(ob,do_unlink=True)
for p in rig.pose.bones:p.rotation_mode='QUATERNION';p.rotation_quaternion=Quaternion();p.location=(0,0,0);p.scale=(1,1,1)
scene.frame_set(0);bpy.context.view_layer.update()
body=bpy.data.objects['Human body'];body.name='BODY_Human'
body_bvh=BVHTree.FromPolygons([v.co.copy() for v in body.data.vertices],[list(p.vertices) for p in body.data.polygons])

def mat(name,color,metal=0,rough=.5):
 m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True
 p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*color,1);p.inputs['Metallic'].default_value=metal;p.inputs['Roughness'].default_value=rough
 return m
ivory=mat('Ivory enamel',(.72,.73,.66),.16,.31)
silver=mat('Cold brushed silver',(.50,.57,.62),.85,.31)
teal=mat('Deep teal enamel',(.025,.135,.16),.28,.31)
cloth=mat('Padded blue-grey linen',(.052,.081,.091),0,.88)
leather=mat('Dark leather',(.075,.055,.038),0,.8)
wood=mat('Ash wood shaft',(.24,.135,.061),0,.62)
hair=mat('Teal horsehair',(.018,.08,.095),0,.82)
black=mat('Joint recess',(.018,.022,.026),.1,.65)
skin=body.data.materials[0];skin.name='Human skin | neutral study';skin.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(.49,.315,.215,1)
skin.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=.68

# Independent rigid parts are skinned to one named bone. Garments reuse normalized body weights.
def rigid(ob,bone):
 g=ob.vertex_groups.new(name=bone);g.add(list(range(len(ob.data.vertices))),1,'REPLACE')
 mod=ob.modifiers.new('Rigid attachment '+bone,'ARMATURE');mod.object=rig;ob.parent=rig
 ob['attachment_bone']=bone
 return ob

def mesh(name,verts,faces,material,bone=None,bevel=0):
 me=bpy.data.meshes.new(name);me.from_pydata(verts,[],faces);me.update();ob=bpy.data.objects.new(name,me);scene.collection.objects.link(ob);me.materials.append(material)
 for p in me.polygons:p.use_smooth=True
 if bevel:
  mod=ob.modifiers.new('Rounded edges','BEVEL');mod.width=bevel;mod.segments=3
 if bone:rigid(ob,bone)
 return ob

def tube(name,points,radius,material,bone=None,res=10):
 # Explicit mesh rather than curves, transferable to glTF with local details intact.
 points=[Vector(p) for p in points];vs=[];fs=[]
 for i,p in enumerate(points):
  tangent=(points[min(i+1,len(points)-1)]-points[max(0,i-1)]).normalized()
  axis=Vector((0,0,1)) if abs(tangent.z)<.95 else Vector((1,0,0));u=tangent.cross(axis).normalized();v=tangent.cross(u).normalized()
  r=radius[i] if isinstance(radius,list) else radius
  for j in range(res):vs.append(p+(u*math.cos(j*2*math.pi/res)+v*math.sin(j*2*math.pi/res))*r)
 for i in range(len(points)-1):
  for j in range(res):a=i*res+j;b=i*res+(j+1)%res;fs.append((a,b,b+res,a+res))
 fs.append(tuple(reversed(range(res))));fs.append(tuple((len(points)-1)*res+j for j in range(res)))
 return mesh(name,vs,fs,material,bone)

def ellipsoid(name,center,scale,material,bone=None):
 bpy.ops.mesh.primitive_uv_sphere_add(segments=24,ring_count=12,location=center);ob=bpy.context.object;ob.name=name
 for v in ob.data.vertices:v.co=Vector((v.co.x*scale[0],v.co.y*scale[1],v.co.z*scale[2]))+Vector(center)
 ob.location=(0,0,0);ob.data.materials.append(material)
 for p in ob.data.polygons:p.use_smooth=True
 if bone:rigid(ob,bone)
 return ob

def garment(name,predicate,material,offset=.007):
 ids=set();polys=[]
 for f in body.data.polygons:
  c=f.center
  if predicate(c):polys.append(list(f.vertices));ids.update(f.vertices)
 ids=sorted(ids);remap={old:i for i,old in enumerate(ids)}
 ob=mesh(name,[body.data.vertices[i].co+body.data.vertices[i].normal*offset for i in ids],[[remap[v] for v in f] for f in polys],material)
 for g in body.vertex_groups:ob.vertex_groups.new(name=g.name)
 for ni,oi in enumerate(ids):
  for g in body.data.vertices[oi].groups:ob.vertex_groups[g.group].add([ni],g.weight,'REPLACE')
 arm=ob.modifiers.new('Body weights','ARMATURE');arm.object=rig;ob.parent=rig
 s=ob.modifiers.new('Tailored surface','SUBSURF');s.levels=1;s.render_levels=1
 so=ob.modifiers.new('Fabric thickness','SOLIDIFY');so.thickness=.002
 return ob
# A wrist plane retains every palm/finger face, including the thumb side.
# The short proximal allowance keeps the garment seam underneath the cuff.
hand_planes=[(rig.data.bones['wrist.'+s].head_local.copy(),
 (rig.data.bones['wrist.'+s].head_local-rig.data.bones['lowerarm01.'+s].head_local).normalized()) for s in ('L','R')]
def hands(c):return any((c-w).dot(axis)>-.018 and (c-w).length<.24 for w,axis in hand_planes)
body.data.update()
garment('CLOTH_Underarm and leggings',lambda c:.13<c.z<1.525 and not hands(c),cloth,.008)
garment('CLOTH_Leather boot tops',lambda c:.13<c.z<.28,leather,.009)
# Keep exposed skin only. Hidden skin under the garments would waste triangles and flicker.
import bmesh
bm=bmesh.new();bm.from_mesh(body.data)
remove=[f for f in bm.faces if (f.calc_center_median().z<1.51 and not hands(f.calc_center_median()))]
bmesh.ops.delete(bm,geom=remove,context='FACES');bm.to_mesh(body.data);bm.free();body.data.update()

def radial_surface(z,angle,clearance=.029):
 direction=Vector((math.sin(angle),-math.cos(angle),0))
 hit=body_bvh.ray_cast(Vector((0,0,z)),direction,.35)[0]
 if hit is None:hit=Vector((.18*direction.x,.15*direction.y,z))
 return hit+direction*clearance

def torso_ring(z,rx,ry,cy=.005,n=64,clearance=.029):
 return [radial_surface(z,j*2*math.pi/n,clearance) for j in range(n)]

def shell(name,rings,material,bone,thickness=.004):
 n=len(rings[0]);ob=mesh(name,[v for r in rings for v in r],[(i*n+j,i*n+(j+1)%n,(i+1)*n+(j+1)%n,(i+1)*n+j) for i in range(len(rings)-1) for j in range(n)],material)
 so=ob.modifiers.new('Plate thickness','SOLIDIFY');so.thickness=thickness
 be=ob.modifiers.new('Forged edge','BEVEL');be.width=.002;be.segments=2
 rigid(ob,bone)
 return ob
rings=[]
for k in range(10):
 ring=[]
 for j in range(64):
  a=j*2*math.pi/64
  topz=1.445-.140*abs(math.sin(a))**2
  ring.append(radial_surface(1.155+(topz-1.155)*k/9,a))
 rings.append(ring)
shell('ARMOR_Breastplate',rings,ivory,'spine01')
for i,r in enumerate((rings[0],rings[-1])):tube('ARMOR_Silver breastplate edge '+str(i),r+[r[0]],.004,silver,'spine01')
# Narrow longitudinal chased line, deliberately no officer gilding or ornate insignia.
tube('ARMOR_Central silver ridge',[radial_surface(z,0,.027) for z in (1.16,1.24,1.33,1.44)],.0035,silver,'spine01')
for sign in (-1,1):
 for z in (1.21,1.32,1.39):ellipsoid('ARMOR_Breast rivet',(sign*.126,-.126,z),(.0045,.0045,.0045),silver,'spine01')
 # Shoulder straps bridge the collar to the back plate.
 tube('ARMOR_Shoulder leather strap',[(sign*.11,-.11,1.435),(sign*.13,-.02,1.507),(sign*.115,.102,1.44)],.018,leather,'spine01',res=8)
 # Rounded shoulder shell with a real open underside.
 center=rig.data.bones['upperarm01.'+('L' if sign==1 else 'R')].head_local
 vs=[];fs=[];n=32
 for k in range(9):
  phi=.08+1.55*k/8
  for j in range(n):
   a=j*2*math.pi/n;vs.append(center+Vector((.103*math.sin(phi)*math.cos(a),.105*math.sin(phi)*math.sin(a),.096*math.cos(phi)+.018)))
 for k in range(8):
  for j in range(n):fs.append((k*n+j,k*n+(j+1)%n,(k+1)*n+(j+1)%n,(k+1)*n+j))
 fs.append(tuple(reversed(range(n))))
 side='L' if sign==1 else 'R';ob=mesh('ARMOR_Pauldron '+side,vs,fs,ivory);s=ob.modifiers.new('Plate thickness','SOLIDIFY');s.thickness=.004;rigid(ob,'upperarm01.'+side)
 tube('ARMOR_Pauldron rolled rim '+side,vs[-n:]+[vs[-n]],.004,silver,'upperarm01.'+side)
# Fauld plates articulate with lower spine; leather waist band remains flexible.
for k,(z,rx,ry,bone) in enumerate([(1.11,.151,.154,'spine03'),(1.075,.158,.152,'spine04'),(1.04,.164,.153,'spine04')]):
 rs=[torso_ring(z-.024,rx,ry,clearance=.043-k*.006),torso_ring(z+.026,rx-.004,ry-.004,clearance=.043-k*.006)]
 shell('ARMOR_Fauld '+str(k),rs,ivory,bone);tube('ARMOR_Fauld edge '+str(k),rs[0]+[rs[0][0]],.003,silver,bone)
rs=[torso_ring(1.008,.167,.151,clearance=.019),torso_ring(1.04,.165,.151,clearance=.019)]
shell('CLOTH_Waist belt',rs,leather,'spine05',.004)
# Bronze-free steel buckle.
tube('ARMOR_Belt buckle',[(-.022,-.154,1.009),(.022,-.154,1.009),(.022,-.154,1.039),(-.022,-.154,1.039),(-.022,-.154,1.009)],.003,silver,'spine05')
for side,sign in [('L',1),('R',-1)]:
 # Three overlapping thigh lames move with each upper leg.
 for k in range(3):
  z=1.00-k*.06;x=sign*.098
  vs=[(x-sign*.075,-.154,z),(x+sign*.075,-.154,z),(x+sign*.078,-.158,z-.073),(x-sign*.063,-.158,z-.073)]
  ob=mesh('ARMOR_Thigh lame '+side+str(k),vs,[(0,1,2,3)],ivory);so=ob.modifiers.new('Plate thickness','SOLIDIFY');so.thickness=.005;be=ob.modifiers.new('Soft corners','BEVEL');be.width=.008;be.segments=3;rigid(ob,'upperleg01.'+side)
  tube('ARMOR_Thigh edge '+side+str(k),[vs[3],vs[2]],.003,silver,'upperleg01.'+side)
 def limb_cuff(name,bone_name,p0,p1,r0,r1):
  a,b=Vector(p0),Vector(p1);d=(b-a).normalized();front=Vector((0,-1,0));u=(front-d*front.dot(d)).normalized();v=d.cross(u).normalized();rings=[]
  for t in [0,.06,.18,.32,.48,.64,.80,.94,1]:
   r=r0+(r1-r0)*t
   c=a.lerp(b,t);ring=[]
   for j in range(32):
    direction=u*math.cos(j*2*math.pi/32)+v*math.sin(j*2*math.pi/32)
    hit=body_bvh.ray_cast(c,direction,.14)[0]
    ring.append((hit if hit is not None else c+direction*r)+direction*.023)
   rings.append(ring)
  shell(name,rings,ivory,bone_name,.003)
  for j in (0,-1):tube(name+' rim '+str(j),rings[j]+[rings[j][0]],.003,silver,bone_name)
 arm_a=rig.data.bones['lowerarm01.'+side].head_local;arm_b=rig.data.bones['wrist.'+side].head_local
 limb_cuff('ARMOR_Vambrace '+side,'lowerarm01.'+side,arm_a.lerp(arm_b,.18),arm_a.lerp(arm_b,.83),.054,.039)
 knee=rig.data.bones['lowerleg01.'+side].head_local;ankle=rig.data.bones['foot.'+side].head_local
 limb_cuff('ARMOR_Greave '+side,'lowerleg01.'+side,knee.lerp(ankle,.10),knee.lerp(ankle,.80),.064,.047)
 ellipsoid('ARMOR_Knee '+side,knee+Vector((0,-.045,.008)),(.068,.035,.062),ivory,'lowerleg01.'+side)
 # Toe cap follows the human boot shape without extending to an ornamental point.
 foot=rig.data.bones['foot.'+side].tail_local
 # Rounded boot replaces individual anatomical toes; soles have real thickness.
 boot_rings=[]
 for z,rx,ry,cy in [(.012,.077,.151,-.072),(.028,.078,.151,-.072),(.065,.078,.146,-.070),(.11,.069,.125,-.053),(.155,.052,.065,-.006),(.205,.045,.050,0)]:
  boot_rings.append([Vector((foot.x+rx*math.sin(j*2*math.pi/32),cy-ry*math.cos(j*2*math.pi/32),z)) for j in range(32)])
 shell('CLOTH_Boot '+side,boot_rings,leather,'foot.'+side,.004)
 sole=[]
 for z in (.001,.024):
  sole.extend([(foot.x+.078*math.sin(j*2*math.pi/32),-.072-.151*math.cos(j*2*math.pi/32),z) for j in range(32)])
 sole_faces=[(j,(j+1)%32,(j+1)%32+32,j+32) for j in range(32)]+[tuple(reversed(range(32))),tuple(range(32,64))]
 mesh('CLOTH_Closed boot sole '+side,sole,sole_faces,black,'foot.'+side,bevel=.001)
 tube('CLOTH_Sole welt '+side,boot_rings[1]+[boot_rings[1][0]],.007,black,'foot.'+side)
 ellipsoid('ARMOR_Toe cap '+side,(foot.x,-.135,.078),(.075,.095,.034),ivory,'foot.'+side)

collar=[]
for z in [1.493,1.527]:
 collar.append([Vector((.069*math.sin(j*2*math.pi/48),-.025-.073*math.cos(j*2*math.pi/48),z)) for j in range(48)])
shell('CLOTH_Padded collar',collar,cloth,'neck01',.008)
tube('CLOTH_Collar piping',collar[-1]+[collar[-1][0]],.004,cloth,'neck01')

# Open-faced helmet: full dome, lower sides and back, clear human facial silhouette.
vs=[];fs=[];n=64;center=Vector((0,-.044,1.685))
for k in range(13):
 for j in range(n):
  a=j*2*math.pi/n;maxphi=1.28+.72*(1-math.cos(a))/2
  phi=.025+(maxphi-.025)*k/12
  vs.append(center+Vector((.103*math.sin(phi)*math.sin(a),-.125*math.sin(phi)*math.cos(a),.157*math.cos(phi))))
for k in range(12):
 for j in range(n):fs.append((k*n+j,k*n+(j+1)%n,(k+1)*n+(j+1)%n,(k+1)*n+j))
ob=mesh('HELMET_Ivory open helmet',vs,fs,ivory);so=ob.modifiers.new('Helmet shell','SOLIDIFY');so.thickness=.004;rigid(ob,'head')
tube('HELMET_Silver rim',vs[-n:]+[vs[-n]],.004,silver,'head')
for side,sign in [('L',1),('R',-1)]:
 plate=[(sign*.099,-.08,1.70),(sign*.104,-.012,1.69),(sign*.09,-.02,1.60),(sign*.079,-.095,1.60)]
 ob=mesh('HELMET_Cheek guard '+side,plate,[(0,1,2,3)],ivory);so=ob.modifiers.new('Cheek thickness','SOLIDIFY');so.thickness=.004;rigid(ob,'head');tube('HELMET_Cheek edge '+side,plate+[plate[0]],.003,silver,'head')
 ellipsoid('HELMET_Rivet '+side,(sign*.106,-.044,1.687),(.004,.006,.006),silver,'head')
# A short practical crest is a color marker, deliberately modest for a rank-and-file pawn.
ellipsoid('HELMET_Plume socket',(0,-.026,1.844),(.022,.055,.014),silver,'head')
for i in range(13):
 x=(i-6)*.0027
 tube('HELMET_Horsehair '+str(i),[(x,-.04,1.845),(x,-.012,1.905),(x,.033,1.94),(x,.095,1.935),(x,.147,1.885)], [.0034,.004,.004,.003,.0007],hair if i%4 else teal,'head',res=7)

# Fit equipment in the posed world, then convert vertices back into bind space.
pawn_pose.configure(rig)
pawn_pose.apply_pose('rest',0)
bpy.context.view_layer.update()
frames=pawn_pose.equipment_frames()
def posed_rigid(ob,bone):
 deform=rig.pose.bones[bone].matrix@rig.data.bones[bone].matrix_local.inverted()
 inv=deform.inverted()
 for v in ob.data.vertices:v.co=inv@v.co
 rigid(ob,bone);return ob

# Equipment defined by explicit orthonormal frame returned by the grip solver.
g=Vector(frames['spear_grip']);axis=Vector(frames['spear_axis']).normalized();spear_bone=frames.get('spear_bone','wrist.R')
def spear_part(ob):return posed_rigid(ob,spear_bone)
shaft_bottom=g-axis*.98;shaft_top=g+axis*1.22
spear_part(tube('SPEAR_Ash shaft',[shaft_bottom,shaft_top],.0125,wood,res=16))
spear_part(tube('SPEAR_Leather grip',[g-axis*.075,g+axis*.065],.014,leather,res=16))
for k in range(10):
 p=g+axis*(-.073+k*.014)
 spear_part(tube('SPEAR_Grip binding '+str(k),[p,p+axis*.002],.0143,black,res=16))
spear_part(tube('SPEAR_Butt ferrule',[shaft_bottom-axis*.025,shaft_bottom+axis*.10],[.012,.017],silver,res=16))
spear_part(tube('SPEAR_Head socket',[shaft_top-axis*.075,shaft_top+axis*.055],[.021,.012],silver,res=16))
u=axis.cross(Vector((0,1,0))).normalized();v=axis.cross(u).normalized()
start=shaft_top+axis*.035;widest=start+axis*.11;tip=start+axis*.31
vs=[start+u*.012,start-u*.012,widest+u*.048,widest-u*.048,widest+v*.012,widest-v*.012,tip]
fs=[(0,2,4),(2,6,4),(6,3,4),(3,1,4),(1,0,4),(0,5,2),(2,5,6),(6,5,3),(3,5,1),(1,5,0)]
spear_part(mesh('SPEAR_Leaf-shaped steel head',vs,fs,silver))

# Shield: broad convex surface, folded metal rim, leather back, grip and two forearm straps.
sg=Vector(frames['shield_grip']);sx=Vector(frames.get('shield_right',(1,0,0))).normalized();sz=Vector(frames.get('shield_up',(0,0,1))).normalized();sf=sx.cross(sz).normalized()
# frame front must face out toward -Y.
if sf.y>0:sf.negate()
shield_bone=frames.get('shield_bone','wrist.L')
# Offset the face from the grip to clear the rounded vambrace and opposite hand.
center=sg-sz*.19+sx*.04+sf*.105
shield_parts=[]
def shield_part(ob):shield_parts.append(ob);return posed_rigid(ob,shield_bone)
def sh(x,z,depth=0):return center+sx*x+sz*z+sf*(depth+.055*(1-(x/.34)**2))
# Rounded capsule ends and slightly tapered lower third.
levels=[]
for i in range(41):
 z=-.66+1.33*i/40
 if z<-.43:w=.285*math.sqrt(max(.001,1-((z+.43)/.23)**2))
 elif z>.43:w=.31*math.sqrt(max(.001,1-((z-.43)/.24)**2))
 else:w=.285+(.31-.285)*(z+.43)/.86
 levels.append((z,w))
vs=[];fs=[];cols=16
for z,w in levels:
 for j in range(cols+1):vs.append(sh(-w+2*w*j/cols,z))
for i in range(len(levels)-1):
 for j in range(cols):a=i*(cols+1)+j;fs.append((a,a+1,a+cols+2,a+cols+1))
ob=mesh('SHIELD_Ivory face',vs,fs,ivory);so=ob.modifiers.new('Layered shield thickness','SOLIDIFY');so.thickness=.022;shield_part(ob)
outline=[sh(-w,z,-.011) for z,w in levels]+[sh(w,z,-.011) for z,w in reversed(levels)];shield_part(tube('SHIELD_Silver perimeter',outline+[outline[0]],.015,silver,res=12))
# Underlying dark lining and horizontal reinforcing ribs at the rear.
vsback=[p-sf*.027 for p in vs];shield_part(mesh('SHIELD_Leather backing',vsback,list(reversed(fs)),leather))
for z in (-.43,.02,.43):shield_part(tube('SHIELD_Back crossbar',[sh(-.24,z,-.032),sh(.24,z,-.032)],.014,wood,res=10))
# Thin blue centre stripe, same convex surface, no floating crest.
stripe=[]
for z in [-.58,-.25,.1,.45,.60]:stripe.extend([sh(-.032,z,.004),sh(.032,z,.004)])
shield_part(mesh('SHIELD_Teal enamel stripe',stripe,[(i*2,i*2+1,i*2+3,i*2+2) for i in range(4)],teal))
for z in (-.43,.02,.43):
 for sign in (-1,1):shield_part(ellipsoid('SHIELD_Rivet',sh(sign*.245,z,.015),(.006,.006,.006),silver))
# Handle is centred exactly at the fitted left palm; straps remain visibly rooted in shield.
handle_axis=Vector(frames.get('shield_handle_axis',sz)).normalized()
shield_part(tube('SHIELD_Grip',[sg-handle_axis*.065,sg+handle_axis*.065],.014,leather,res=16))
for sign in (-1,1):
 endpoint=sg+handle_axis*(sign*.064)
 shield_part(tube('SHIELD_Grip bracket',[endpoint,sh((endpoint-center).dot(sx),(endpoint-center).dot(sz),-.034)],.009,silver,res=10))
# Broad enarmes curve around the forearm. Every end meets the shield backing.
forearm_axis=Vector(frames.get('shield_forearm_axis',(1,0,0))).normalized()
transverse=(sz-forearm_axis*sz.dot(forearm_axis)).normalized()
for i,p in enumerate(frames.get('shield_strap_centers',[])):
 p=Vector(p);radius=.069
 arc=[p+transverse*(radius*math.cos(j*math.pi/12))-sf*(radius*math.sin(j*math.pi/12)) for j in range(13)]
 def rear_mount(q):return sh((q-center).dot(sx),(q-center).dot(sz),-.035)
 path=[rear_mount(arc[0])]+arc+[rear_mount(arc[-1])]
 band=[]
 for q in path:band.extend([q-forearm_axis*.018,q+forearm_axis*.018])
 ob=mesh('SHIELD_Leather enarme '+str(i),band,[(j*2,j*2+1,j*2+3,j*2+2) for j in range(len(path)-1)],leather)
 so=ob.modifiers.new('Strap leather thickness','SOLIDIFY');so.thickness=.004
 shield_part(ob)
 for q in (path[0],path[-1]):shield_part(ellipsoid('SHIELD_Strap mounting stud',q-sf*.004,(.007,.007,.007),silver))

# All clips share exactly the same guard. No animation of disconnected props.
clips=[];scene.render.fps=30
for name,duration in [('Guard_Breath',6),('Shield_Brace',4),('Spear_Study',4)]:
 action=bpy.data.actions.new(name);rig.animation_data_create();rig.animation_data.action=action
 for frame in range(0,duration*30+1,2):
  pawn_pose.apply_pose(name,frame/30)
  for p in rig.pose.bones:
   p.keyframe_insert('rotation_quaternion',frame=frame,group=p.name);p.keyframe_insert('location',frame=frame,group=p.name)
 rig.animation_data.action=None;track=rig.animation_data.nla_tracks.new();track.name=name;track.strips.new(name,0,action).name=name;track.mute=True;clips.append(name)
pawn_pose.apply_pose('rest',0);scene.frame_set(0);bpy.context.view_layer.update()
scene.frame_start=0;scene.frame_end=180
# Keep fully separate authored pieces in Blender; combine compatible meshes only for GLB.
# This reduces calls while preserving one shared rig and independent outfit slots.
model_objects=[o for o in scene.objects if o.type=='MESH']
export_clones=[]
for original in model_objects:
 ob=original.copy();ob.data=original.data.copy();scene.collection.objects.link(ob)
 ob.name='EXPORT_'+original.name
 # Apply geometric modifiers in bind space, retaining vertex weights.
 for mod in ob.modifiers:
  if mod.type=='ARMATURE':mod.show_viewport=False;mod.show_render=False
 bpy.ops.object.select_all(action='DESELECT');ob.select_set(True);bpy.context.view_layer.objects.active=ob
 for mod in list(ob.modifiers):
  if mod.type!='ARMATURE':bpy.ops.object.modifier_apply(modifier=mod.name)
 for mod in ob.modifiers:
  if mod.type=='ARMATURE':mod.show_viewport=True;mod.show_render=True
 export_clones.append(ob)
groups={}
for ob in export_clones:
 category=ob.name.removeprefix('EXPORT_').split('_')[0]
 groups.setdefault(category,[]).append(ob)
merged=[]
for category,parts in groups.items():
 bpy.ops.object.select_all(action='DESELECT')
 for ob in parts:ob.select_set(True)
 bpy.context.view_layer.objects.active=parts[0]
 if len(parts)>1:bpy.ops.object.join()
 ob=bpy.context.object;ob.name=category+'_Assembly';merged.append(ob)
bpy.ops.object.select_all(action='DESELECT');rig.select_set(True)
for ob in merged:ob.select_set(True)
bpy.context.view_layer.objects.active=rig
for tr in rig.animation_data.nla_tracks:tr.mute=False
bpy.ops.export_scene.gltf(filepath=str(OUT/'white-pawn.glb'),export_format='GLB',use_selection=True,export_apply=True,export_yup=True,export_animations=True,export_animation_mode='NLA_TRACKS',export_force_sampling=True,export_frame_range=False,export_skins=True,export_all_influences=False,export_extras=True,export_cameras=False,export_lights=False)
for ob in merged:bpy.data.objects.remove(ob,do_unlink=True)
for tr in rig.animation_data.nla_tracks:tr.mute=True
rig.animation_data.action=None;pawn_pose.apply_pose('rest',0);scene.frame_set(0);bpy.context.view_layer.update()
# glTF defaults normally expose the bind pose. Use the existing clip's first sample
# so opening the bare GLB shows exactly the fitted guard, without viewer-specific tricks.
import struct
raw=(OUT/'white-pawn.glb').read_bytes();json_len=struct.unpack_from('<I',raw,12)[0]
doc=json.loads(raw[20:20+json_len]);bin_offset=20+json_len
binary=raw[bin_offset+8:]
clip=next(a for a in doc['animations'] if a['name']=='Guard_Breath')
for channel in clip['channels']:
 target=channel['target'];path=target['path']
 if path not in ('translation','rotation','scale'):continue
 sampler=clip['samplers'][channel['sampler']];accessor=doc['accessors'][sampler['output']];view=doc['bufferViews'][accessor['bufferView']]
 assert accessor['componentType']==5126
 count=4 if path=='rotation' else 3
 offset=view.get('byteOffset',0)+accessor.get('byteOffset',0)
 if sampler.get('interpolation')=='CUBICSPLINE':offset+=count*4
 value=list(struct.unpack_from('<'+'f'*count,binary,offset))
 node=doc['nodes'][target['node']];node.pop('matrix',None);node[path]=value
jb=json.dumps(doc,separators=(',',':')).encode();jb+=b' '*((-len(jb))%4)
contents=struct.pack('<III',0x46546c67,2,12+8+len(jb)+8+len(binary))+struct.pack('<II',len(jb),0x4e4f534a)+jb+struct.pack('<II',len(binary),0x004e4942)+binary
(OUT/'white-pawn.glb').write_bytes(contents)

# Studio light and six views use these exact meshes and fitted rig.
floor_mat=mat('Studio slate',(.045,.058,.064),0,.8)
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.003));bpy.context.object.name='STUDIO_Floor';floor_ob=bpy.context.object;floor_ob.data.materials.append(floor_mat)
world=bpy.data.worlds.new('Pawn studio world');scene.world=world;world.use_nodes=True;world.node_tree.nodes['Background'].inputs[0].default_value=(.27,.31,.35,1);world.node_tree.nodes['Background'].inputs[1].default_value=.4

def area(name,pos,power,size,color):
 d=bpy.data.lights.new(name,'AREA');d.energy=power;d.shape='DISK';d.size=size;d.color=color;o=bpy.data.objects.new(name,d);scene.collection.objects.link(o);o.location=pos;o.rotation_euler=(Vector((0,0,1))-o.location).to_track_quat('-Z','Y').to_euler()
area('Key',(-3,-4,5),520,4,(.9,.95,1));area('Fill',(3,-2,2.5),240,3,(1,.94,.85));area('Rim',(2,3,4),650,3,(.76,.86,1))
cam=bpy.data.objects.new('Review camera',bpy.data.cameras.new('Review camera'));scene.collection.objects.link(cam);scene.camera=cam;cam.data.type='ORTHO'
def camera(pos,target=(0,0,1.32),scale=3.0):cam.location=pos;cam.rotation_euler=(Vector(target)-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=scale
scene.render.engine='CYCLES';scene.cycles.samples=24;scene.cycles.use_denoising=True;scene.render.resolution_x=960;scene.render.resolution_y=1200;scene.render.resolution_percentage=100;scene.view_settings.view_transform='AgX';scene.render.image_settings.file_format='PNG'
camera((3,-6,2.5));bpy.data.orphans_purge(do_recursive=True);bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'white-pawn.blend'),compress=True)
render_times={}
def render(name):
 start=time.monotonic();scene.render.filepath=str(REVIEW/name);bpy.ops.render.render(write_still=True);render_times[name]=round(time.monotonic()-start,2)
render('neutral.png')
# Faster contact sheets do not change model geometry.
scene.render.resolution_x=720;scene.render.resolution_y=900;scene.cycles.samples=16
floor_ob.hide_render=True
for name,pos in [('front',(0,-6,1.2)),('back',(0,6,1.2)),('left',(6,0,1.2)),('right',(-6,0,1.2)),('top',(0,-.01,7)),('bottom',(0,-.01,-7))]:
 camera(pos);render('model-'+name+'.png')
floor_ob.hide_render=False
for name,t in [('Shield_Brace',1.7),('Spear_Study',1.65)]:
 pawn_pose.apply_pose(name,t);bpy.context.view_layer.update();camera((3,-6,2.5));render('model-'+name+'.png')
pawn_pose.apply_pose('rest',0);bpy.context.view_layer.update()
for name,p in [('spear-grip',Vector(frames['spear_grip'])),('shield-grip',Vector(frames['shield_grip']))]:
 camera(p+Vector((-1,-2,.45)),p,.38);render('model-'+name+'.png')
report={'version':'0.1.0','base_glb_sha256':hashlib.sha256((BASE/'assets/human-base.glb').read_bytes()).hexdigest(),'glb_sha256':hashlib.sha256((OUT/'white-pawn.glb').read_bytes()).hexdigest(),'clips':clips,'durations':{'Guard_Breath':6,'Shield_Brace':4,'Spear_Study':4},'frames':{k:v for k,v in frames.items() if k not in ('spear','shield')},'render_seconds':render_times,'scope':'First equipped white pawn; fitted grip and solo motion studies. No chess logic or paired combat.','limits':['No cloth/horsehair simulation','Full board LOD remains future work','Armor is fantasy equipment, not a historical replica']}
(OUT/'model-info.json').write_text(json.dumps(report,indent=2,default=lambda x:list(x))+'\n');print('PAWN_REPORT',json.dumps(report,default=lambda x:list(x)))
