"""Reproducible human anatomical study, Blender 4.5.3 / Python 3.11.
CC0 MakeHuman assets are data inputs. This script is original project code.
Source Y-up -> Blender Z-up -> exported glTF Y-up in metres.
"""
from pathlib import Path
from collections import defaultdict,Counter
import json,math,hashlib,time,sys
import numpy as np
import bpy
from mathutils import Vector,Quaternion
ROOT=Path(__file__).resolve().parents[1];SRC=ROOT/'source';OUT=ROOT/'assets';REVIEW=ROOT/'review'
OUT.mkdir(exist_ok=True);REVIEW.mkdir(exist_ok=True)
HEIGHT=1.8

def read_obj(path):
 verts=[];uv=[];faces=[];tex=[];groups=[];group=''
 for line in path.read_text().splitlines():
  s=line.split()
  if not s:continue
  if s[0]=='v':verts.append(list(map(float,s[1:4])))
  elif s[0]=='vt':uv.append(list(map(float,s[1:3])))
  elif s[0]=='g':group=s[1]
  elif s[0]=='f':
   f=[v.split('/') for v in s[1:]]
   faces.append([int(v[0])-1 for v in f]);tex.append([int(v[1])-1 if len(v)>1 and v[1] else 0 for v in f]);groups.append(group)
 return np.array(verts),uv,faces,tex,groups

manifest=json.loads((SRC/'manifest.json').read_text())
for entry in manifest['assets']:
 assert hashlib.sha256((SRC/entry['file']).read_bytes()).hexdigest()==entry['sha256'],entry['file']
base,uvs,faces,face_uvs,groups=read_obj(SRC/'base.obj');verts=base.copy()
MORPHS={f'{n}-male-young.target':1/3 for n in ('african','asian','caucasian')}
MORPHS['universal-male-young-maxmuscle-averageweight.target']=.28
for f,amount in MORPHS.items():
 for line in (SRC/f).read_text().splitlines():
  s=line.split()
  if len(s)==4 and s[0].isdigit():verts[int(s[0])]+=np.array(list(map(float,s[1:])))*amount
body_faces=[i for i,g in enumerate(groups) if g=='body'];body_ids=sorted({v for i in body_faces for v in faces[i]})
floor=float(verts[body_ids,1].min());scale=HEIGHT/float(np.ptp(verts[body_ids,1]))
def xyz(v):return Vector((float(v[0])*scale,-float(v[2])*scale,(float(v[1])-floor)*scale))

bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene;scene.unit_settings.system='METRIC';scene.render.fps=30;scene.frame_start=0;scene.frame_end=90
scene.world.color=(.23,.23,.23)
def material(name,col,rough=.58):
 m=bpy.data.materials.new(name);m.diffuse_color=(*col,1);m.use_nodes=True
 bs=m.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=(*col,1);bs.inputs['Roughness'].default_value=rough
 return m
clay=material('Warm anatomical clay',(.48,.39,.30),.66);cloth=material('Training shorts | charcoal',(.035,.045,.052),.88)

def mesh(name,coords,polygons,texcoords=None,face_tex=None,mat=None):
 ids=sorted({v for f in polygons for v in f});remap={v:i for i,v in enumerate(ids)}
 me=bpy.data.meshes.new(name);me.from_pydata([xyz(coords[i]) for i in ids],[],[[remap[v] for v in f] for f in polygons]);me.update()
 ob=bpy.data.objects.new(name,me);scene.collection.objects.link(ob)
 if mat:me.materials.append(mat)
 if texcoords is not None:
  layer=me.uv_layers.new(name='UVMap')
  for poly,tex in zip(me.polygons,face_tex):
   for loop,vi in zip(poly.loop_indices,tex):layer.data[loop].uv=texcoords[vi]
 for p in me.polygons:p.use_smooth=True
 return ob,ids

body,body_ids=mesh('Human body',verts,[faces[i] for i in body_faces],uvs,[face_uvs[i] for i in body_faces],clay)
data=json.loads((SRC/'default.mhskel').read_text());weight_data=json.loads((SRC/'default_weights.mhw').read_text())['weights']
arm=bpy.data.armatures.new('Human skeleton');rig=bpy.data.objects.new('HumanBase_Rig',arm);scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active=rig;rig.select_set(True);bpy.ops.object.mode_set(mode='EDIT')
def joint(n):return xyz(verts[data['joints'][n]].mean(axis=0))
for name,spec in data['bones'].items():
 b=arm.edit_bones.new(name);b.head=joint(spec['head']);b.tail=joint(spec['tail'])
 if (b.tail-b.head).length<.0001:b.tail.z+=.001
 b.align_roll(Vector((0,-1,0)))
for name,spec in data['bones'].items():
 if spec['parent']:arm.edit_bones[name].parent=arm.edit_bones[spec['parent']]
bpy.ops.object.mode_set(mode='OBJECT');rig.show_in_front=True;arm.display_type='OCTAHEDRAL'

by_vertex=defaultdict(list)
for bone,entries in weight_data.items():
 for vi,w in entries:
  if w>0:by_vertex[vi].append((bone,w))
trimmed={}
for vi,entries in by_vertex.items():
 entries=sorted(entries,key=lambda e:e[1],reverse=True)[:4];total=sum(w for b,w in entries);trimmed[vi]=[(b,w/total) for b,w in entries]
def bind(ob,ids,explicit=None):
 used=defaultdict(list)
 for new,old in enumerate(ids):
  for bone,w in (explicit(old) if explicit else trimmed.get(old,[('root',1.)])):used[bone].append((new,w))
 for bone,entries in used.items():
  g=ob.vertex_groups.new(name=bone)
  for vi,w in entries:g.add([vi],w,'REPLACE')
 mod=ob.modifiers.new('Skin | four normalized influences','ARMATURE');mod.object=rig;mod.use_deform_preserve_volume=False;ob.parent=rig
 return ob
bind(body,body_ids)

# Select the clothing helper, then give each cut boundary a clean level hem.
short_faces=[faces[i] for i,g in enumerate(groups) if g=='helper-tights' and .705<(verts[faces[i],1].mean()-floor)*scale<1.005]
shorts,short_ids=mesh('Training shorts',verts,short_faces,mat=cloth)
edge_uses=Counter()
for p in shorts.data.polygons:
 for i in range(len(p.vertices)):
  a,b=p.vertices[i],p.vertices[(i+1)%len(p.vertices)];edge_uses[tuple(sorted((a,b)))]+=1
boundary={v for e,n in edge_uses.items() if n==1 for v in e}
for vi in boundary:
 v=shorts.data.vertices[vi];v.co.z=1.005 if v.co.z>.85 else .715
# A small separation is measured in metres, not a material illusion.
shorts.data.update()
for v in shorts.data.vertices:v.co+=v.normal*.004
bind(shorts,short_ids)

# The official high-poly eye proxy follows the changed head through barycentric mapping.
eye_base,eye_uv,eye_faces,eye_tex,_=read_obj(SRC/'high-poly.obj');eye_coords=[];offset_scale=np.ones(3);reading=False
for line in (SRC/'high-poly.mhclo').read_text().splitlines():
 s=line.split()
 if not s or s[0].startswith('#'):continue
 if s[0] in ('x_scale','y_scale','z_scale'):
  ax='xyz'.index(s[0][0]);offset_scale[ax]=abs(verts[int(s[1]),ax]-verts[int(s[2]),ax])/float(s[3])
 elif s[0]=='verts':reading=True
 elif reading and s[0].isdigit():
  if len(s)>=9:eye_coords.append((verts[list(map(int,s[:3]))]*np.array(list(map(float,s[3:6])))[:,None]).sum(axis=0)+np.array(list(map(float,s[6:9])))*offset_scale)
  elif len(s)==1:eye_coords.append(verts[int(s[0])])
 elif reading:break
assert len(eye_coords)==len(eye_base)
eye_mat=material('Eyes | brown',(.8,.8,.8),.3);texture=eye_mat.node_tree.nodes.new('ShaderNodeTexImage');texture.image=bpy.data.images.load(str(SRC/'brown_eye.png'));texture.image.pack()
eye_mat.node_tree.links.new(texture.outputs['Color'],eye_mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
eye_mat.node_tree.links.new(texture.outputs['Alpha'],eye_mat.node_tree.nodes.get('Principled BSDF').inputs['Alpha'])
eye_mat.surface_render_method='DITHERED'
eyes,eye_ids=mesh('Eyes',np.array(eye_coords),eye_faces,eye_uv,eye_tex,eye_mat);bind(eyes,eye_ids,lambda i:[('eye.L' if eye_coords[i][0]>0 else 'eye.R',1.)])
for ob in (body,shorts):
 sub=ob.modifiers.new('Surface | level one','SUBSURF');sub.levels=1;sub.render_levels=1
solid=shorts.modifiers.new('Fabric edge','SOLIDIFY');solid.thickness=.0015

# Attachment frames remain initial helpers; actual grips require the future weapon mesh.
for name,bone,offset in [('socket_weapon_R','wrist.R',(0,-.025,0)),('socket_shield_L','lowerarm02.L',(0,0,0)),('socket_head','head',(0,0,0)),('socket_back','spine01',(0,.09,0))]:
 ob=bpy.data.objects.new(name,None);scene.collection.objects.link(ob);ob.empty_display_size=.025;ob.parent=rig;ob.parent_type='BONE';ob.parent_bone=bone;ob.location=offset;ob['status']='Initial attachment helper; fit with actual equipment'

def reset_pose():
 for p in rig.pose.bones:p.rotation_mode='QUATERNION';p.rotation_quaternion=Quaternion();p.location=(0,0,0);p.scale=(1,1,1)
def rot(name,axis,degrees):
 p=rig.pose.bones[name];local_axis=p.bone.matrix_local.to_3x3().inverted()@Vector(axis);p.rotation_quaternion=p.rotation_quaternion@Quaternion(local_axis,math.radians(degrees))

# Finger flexion axes are anatomical palm transverse axes, rather than scene Z.
hand_axes={};thumb_axes={}
for side,sign in [('L',1),('R',-1)]:
 wrist=arm.bones['wrist.'+side].head_local
 index=arm.bones['finger2-1.'+side].head_local;little=arm.bones['finger5-1.'+side].head_local
 palm_normal=(index-wrist).cross(little-wrist).normalized()
 if palm_normal.x*sign>0:palm_normal.negate()
 across=(index-little).normalized();direction=(arm.bones['finger3-1.'+side].tail_local-arm.bones['finger3-1.'+side].head_local).normalized()
 if across.cross(direction).dot(palm_normal)<0:across.negate()
 hand_axes[side]=across
 center=(index+little+wrist)/3
 for j in range(1,4):
  b=arm.bones[f'finger1-{j}.{side}'];d=(b.tail_local-b.head_local).normalized();toward=(center-b.head_local).normalized();a=d.cross(toward)
  if a.length<.01:a=across.copy()
  thumb_axes[(side,j)]=a.normalized()

def apply_pose(kind,amount):
 reset_pose()
 if kind=='elbows':
  for side in ('L','R'):rot('lowerarm01.'+side,(1,0,0),-85*amount)
 elif kind=='ready':
  for side,sign in [('L',1),('R',-1)]:
   rot('upperarm01.'+side,(0,1,0),sign*30*amount);rot('upperarm01.'+side,(1,0,0),-14*amount);rot('lowerarm01.'+side,(1,0,0),-72*amount);rot('wrist.'+side,(0,0,1),sign*8*amount)
  rot('spine03',(0,0,1),-4*amount);rot('head',(0,0,1),4*amount)
  for side in ('L','R'):
   for finger in range(2,6):
    for j,angle in [(1,22),(2,26),(3,12)]:rot(f'finger{finger}-{j}.{side}',hand_axes[side],angle*amount)
   for j,angle in [(1,8),(2,14),(3,9)]:rot(f'finger1-{j}.{side}',thumb_axes[(side,j)],angle*amount)
 elif kind=='hands':
  for side in ('L','R'):
   for finger in range(2,6):
    for j,angle in [(1,45),(2,52),(3,25)]:rot(f'finger{finger}-{j}.{side}',hand_axes[side],angle*amount)
   for j,angle in [(1,17),(2,28),(3,18)]:rot(f'finger1-{j}.{side}',thumb_axes[(side,j)],angle*amount)

clips=[]
for name,kind in [('Elbow_Flex','elbows'),('Ready_Study','ready'),('Hand_Close','hands')]:
 action=bpy.data.actions.new(name);action.use_fake_user=True;rig.animation_data_create();rig.animation_data.action=action
 for frame,amount in [(0,0),(30,1),(60,1),(90,0)]:
  apply_pose(kind,amount)
  for p in rig.pose.bones:p.keyframe_insert('rotation_quaternion',frame=frame,group=p.name)
 clips.append(action);rig.animation_data.action=None;track=rig.animation_data.nla_tracks.new();track.name=name;track.strips.new(name,0,action).name=name;track.mute=True
reset_pose();scene.frame_set(0)
scene['Project']='Lazy Crazy Chess | human base 0.1';scene['ModelSource']='MakeHuman Community CC0; source/manifest.json';scene['Scope']='Anatomical base and deformation studies, not production combat or corrective muscle simulation'
rig['height_metres']=HEIGHT;rig['body_profile']='Adult male; average build; moderate musculature';rig['morphs_json']=json.dumps(MORPHS);rig['source_revision']=manifest['revision']
model_objects=list(scene.objects)
bpy.ops.object.select_all(action='DESELECT')
for ob in model_objects:ob.select_set(True)
bpy.context.view_layer.objects.active=rig
for t in rig.animation_data.nla_tracks:t.mute=False
bpy.ops.export_scene.gltf(filepath=str(OUT/'human-base.glb'),export_format='GLB',use_selection=True,export_apply=True,export_yup=True,export_animations=True,export_animation_mode='NLA_TRACKS',export_force_sampling=True,export_frame_range=False,export_skins=True,export_all_influences=False,export_extras=True,export_cameras=False,export_lights=False)
for t in rig.animation_data.nla_tracks:t.mute=True
rig.animation_data.action=None;reset_pose();scene.frame_set(0)

floor_mat=material('Studio floor',(.09,.105,.11),.85);bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.002));floor_ob=bpy.context.object;floor_ob.name='Studio floor';floor_ob.data.materials.append(floor_mat)
def area(name,pos,power,size):
 d=bpy.data.lights.new(name,'AREA');d.energy=power;d.shape='DISK';d.size=size;o=bpy.data.objects.new(name,d);scene.collection.objects.link(o);o.location=pos;o.rotation_euler=(Vector((0,0,1))-o.location).to_track_quat('-Z','Y').to_euler()
area('Key',(-3,-4,4.5),450,4);area('Fill',(3,-1,2.5),180,3);area('Rim',(1,3,3),400,2.5)
cd=bpy.data.cameras.new('Review camera');cam=bpy.data.objects.new('Review camera',cd);scene.collection.objects.link(cam);scene.camera=cam;cd.type='ORTHO'
def camera(pos,target=(0,0,.92),ortho=2.05):
 cam.location=pos;cam.rotation_euler=(Vector(target)-cam.location).to_track_quat('-Z','Y').to_euler();cd.ortho_scale=ortho
camera((2.65,-5.8,2.05))
scene.render.engine='CYCLES';scene.cycles.samples=24;scene.cycles.use_denoising=True;scene.render.resolution_x=900;scene.render.resolution_y=1100;scene.render.resolution_percentage=100;scene.view_settings.view_transform='AgX';scene.render.image_settings.file_format='PNG'
bpy.ops.object.select_all(action='DESELECT');body.select_set(True);bpy.context.view_layer.objects.active=body
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'human-base.blend'))
render_times={}
def render(file):
 start=time.monotonic();scene.render.filepath=str(REVIEW/file);bpy.ops.render.render(write_still=True);render_times[file]=round(time.monotonic()-start,3)
render('neutral.png')
# Review each extreme directly from the same rig and mesh used in the exported model.
for kind in ('elbows','ready','hands'):
 apply_pose(kind,1);bpy.context.view_layer.update();render('model-'+kind+'.png')
# Close view of the finger test, before and after, for inspection.
reset_pose();bpy.context.view_layer.update();camera((.2,-2,1.75),(0,-.06,1.68),.31);render('model-face.png')
for amount in (0,1):
 apply_pose('hands',amount);bpy.context.view_layer.update();camera((1.15,-1.4,1.3),(.54,-.30,1.06),.31);render('model-hand-'+str(amount)+'.png')
reset_pose();bpy.context.view_layer.update();camera((2.65,-5.8,2.05))
report={'height_metres':HEIGHT,'body_control_vertices':len(body.data.vertices),'body_control_faces':len(body.data.polygons),'bones':len(arm.bones),'clips':[a.name for a in clips],'clip_duration_seconds':3,'bpy':bpy.app.version_string,'source_revision':manifest['revision'],'asset_license':'CC0-1.0','asset_author':'MakeHuman Community','glb_bytes':(OUT/'human-base.glb').stat().st_size,'sha256':hashlib.sha256((OUT/'human-base.glb').read_bytes()).hexdigest(),'render_seconds':render_times,'renderer':'Cycles CPU, 24 samples, 900 x 1100','limits':['Technical deformation studies only; no combat actions','No corrective joint shapes or collision solver','Attachment helper frames require equipment fitting','Generic adult anatomy; not a replica of a measured person'],'finger_axes':{s:list(v) for s,v in hand_axes.items()}}
(OUT/'model-info.json').write_text(json.dumps(report,indent=2)+'\n');print('MODEL_REPORT',json.dumps(report))
