"""Reproducible infantry catalogue from the preserved, fitted pawn.

Run with Blender 4.5 Python: python scripts/build_modular.py [--preview-only].
Geometry, physical UVs, morphs and the rendered scene share one source.
The original three authored clips remain; new weapon choreography is runtime IK.
"""
from pathlib import Path
import bpy, bmesh, math, json, hashlib, struct, subprocess, sys, time
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[1]
REPO=ROOT.parents[1]
OUT=ROOT/'assets'; REVIEW=ROOT/'review'; SURF=OUT/'surfaces'
SURF.mkdir(exist_ok=True); REVIEW.mkdir(exist_ok=True)
SOURCE='168ac90f50913c020037abe826b08e13ba2910e9'
baseline=OUT/'baseline-input.blend'
baseline.write_bytes(subprocess.check_output(['git','show',SOURCE+':prototypes/white-pawn/assets/white-pawn.blend'],cwd=REPO))
bpy.ops.wm.open_mainfile(filepath=str(baseline)); baseline.unlink()
scene=bpy.context.scene; rig=bpy.data.objects['WhitePawn_Rig']
sys.path.insert(0,str(ROOT/'scripts')); import pawn_pose
pawn_pose.configure(rig); pawn_pose.apply_pose('rest',0); bpy.context.view_layer.update()
frames=pawn_pose.equipment_frames()
info=json.loads(subprocess.check_output(['git','show',SOURCE+':prototypes/white-pawn/assets/model-info.json'],cwd=REPO))
MODEL=[o for o in scene.objects if o.type=='MESH' and not o.name.startswith('STUDIO_')]

def mat(name,color,metal=0,rough=.5):
 m=bpy.data.materials.get(name) or bpy.data.materials.new(name)
 m.use_nodes=True;m.diffuse_color=(*color,1);p=m.node_tree.nodes.get('Principled BSDF')
 p.inputs['Base Color'].default_value=(*color,1);p.inputs['Metallic'].default_value=metal;p.inputs['Roughness'].default_value=rough
 m['customizationSlot']=name;return m

padding=mat('padding',(.075,.115,.125),0,.9)
mail=mat('mail',(.36,.39,.42),1,.57)
skin=bpy.data.objects['BODY_Human'].data.materials[0];skin.name='skin';skin['customizationSlot']='skin'
hair=mat('hair',(.055,.027,.014),0,.82);beard=mat('beard',(.045,.022,.012),0,.88)

def normal_texture(name,height,size=256):
 # A tile is 40 mm; geometry UVs are in metres / .04.
 vals=[[height(x/size,y/size) for x in range(size)] for y in range(size)]
 pixels=[]
 for y in range(size):
  for x in range(size):
   dx=(vals[y][(x+1)%size]-vals[y][(x-1)%size])*size
   dy=(vals[(y+1)%size][x]-vals[(y-1)%size][x])*size
   n=Vector((-dx,-dy,1)).normalized();pixels.extend(((n.x+1)/2,(n.y+1)/2,(n.z+1)/2,1))
 image=bpy.data.images.new(name,width=size,height=size,alpha=False)
 image.colorspace_settings.name='Non-Color';image.pixels=pixels;image.filepath_raw=str(SURF/(name+'.png'));image.file_format='PNG';image.save();image.pack()
 return image

def quilt_height(x,y):
 # Diamond spacing 28.3 mm across the diagonal of a 40 mm square.
 d=min(abs(math.sin(math.pi*(x+y))),abs(math.sin(math.pi*(x-y))))
 return .022*(1-math.exp(-d*d/0.035))

def mail_height(x,y):
 # Four staggered links per 40 mm tile, outer diameter 11.2 mm.
 best=0
 for row in range(5):
  cy=row*.25
  for col in range(5):
   cx=col*.25+(.125 if row%2 else 0)
   dx=(x-cx+.5)%1-.5;dy=(y-cy+.5)%1-.5
   r=math.sqrt((dx/.94)**2+(dy/1.06)**2)
   best=max(best,.024*math.exp(-((r-.112)/.025)**2))
 return best

for material,image,strength in [(padding,normal_texture('quilt-normal',quilt_height),.75),(mail,normal_texture('mail-normal',mail_height),.72)]:
 nodes=material.node_tree.nodes;links=material.node_tree.links
 uv=nodes.new('ShaderNodeUVMap');uv.uv_map='Surface metres'
 tex=nodes.new('ShaderNodeTexImage');tex.image=image;tex.interpolation='Linear'
 normal=nodes.new('ShaderNodeNormalMap');normal.inputs['Strength'].default_value=strength
 links.new(uv.outputs['UV'],tex.inputs['Vector']);links.new(tex.outputs['Color'],normal.inputs['Color']);links.new(normal.outputs['Normal'],nodes.get('Principled BSDF').inputs['Normal'])

def physical_uv(ob):
 uv=ob.data.uv_layers.get('Surface metres') or ob.data.uv_layers.new(name='Surface metres')
 ob.data.uv_layers.active=uv;uv.active_render=True
 for face in ob.data.polygons:
  normal=face.normal;axis=max(range(3),key=lambda i:abs(normal[i]));axes=[i for i in range(3) if i!=axis]
  for li in face.loop_indices:
   p=ob.data.vertices[ob.data.loops[li].vertex_index].co;uv.data[li].uv=(p[axes[0]]/.04,p[axes[1]]/.04)

def rigid(ob,bone):
 g=ob.vertex_groups.new(name=bone);g.add(list(range(len(ob.data.vertices))),1,'REPLACE')
 mod=ob.modifiers.new('Rigid attachment '+bone,'ARMATURE');mod.object=rig;ob.parent=rig
 ob['attachment_bone']=bone;return ob

def mesh(name,vertices,faces,material,bone=None):
 me=bpy.data.meshes.new(name);me.from_pydata(vertices,[],faces);me.update()
 ob=bpy.data.objects.new(name,me);scene.collection.objects.link(ob);me.materials.append(material)
 for p in me.polygons:p.use_smooth=True
 if bone:rigid(ob,bone)
 MODEL.append(ob);return ob

def tube(name,points,radius,material,bone=None,res=12):
 points=[Vector(p) for p in points];vs=[];fs=[]
 for i,p in enumerate(points):
  tangent=(points[min(i+1,len(points)-1)]-points[max(0,i-1)]).normalized()
  aux=Vector((0,0,1)) if abs(tangent.z)<.95 else Vector((1,0,0));u=tangent.cross(aux).normalized();v=tangent.cross(u).normalized()
  r=radius[i] if isinstance(radius,list) else radius
  for j in range(res):vs.append(p+(u*math.cos(j*math.tau/res)+v*math.sin(j*math.tau/res))*r)
 for i in range(len(points)-1):
  for j in range(res):a=i*res+j;b=i*res+(j+1)%res;fs.append((a,b,b+res,a+res))
 fs += [tuple(reversed(range(res))),tuple((len(points)-1)*res+j for j in range(res))]
 return mesh(name,vs,fs,material,bone)

def posed_rigid(ob,bone):
 inv=(rig.pose.bones[bone].matrix@rig.data.bones[bone].matrix_local.inverted()).inverted()
 for v in ob.data.vertices:v.co=inv@v.co
 return rigid(ob,bone)

def duplicate(ob,name):
 result=ob.copy();result.data=ob.data.copy();result.name=name;scene.collection.objects.link(result);MODEL.append(result);return result

def subset(ob,name,predicate,material,offset=0):
 result=duplicate(ob,name)
 # Snapshot original normals before changing any adjacent vertex.
 normals=[v.normal.copy() for v in result.data.vertices]
 bm=bmesh.new();bm.from_mesh(result.data)
 remove=[f for f in bm.faces if not predicate(f.calc_center_median())]
 bmesh.ops.delete(bm,geom=remove,context='FACES');bm.to_mesh(result.data);bm.free();result.data.update()
 normals=[v.normal.copy() for v in result.data.vertices]
 for v,n in zip(result.data.vertices,normals):v.co+=n*offset
 result.data.materials.clear();result.data.materials.append(material);result.data.update();physical_uv(result)
 return result

# Underlayer has genuine loft. Smooth inherited anatomical bumps before adding
# mail; this is a fitted garment, not a skin texture.
under=bpy.data.objects['CLOTH_Underarm and leggings']
under.data.update()
bm=bmesh.new();bm.from_mesh(under.data)
verts=[v for v in bm.verts if 1.13<v.co.z<1.46 and abs(v.co.x)<.20]
for _ in range(6):bmesh.ops.smooth_vert(bm,verts=verts,factor=.35,use_axis_x=True,use_axis_y=True,use_axis_z=True)
bm.to_mesh(under.data);bm.free();under.data.update()
for ob in MODEL:
 if ob.name.startswith('CLOTH_') and any(m.name=='Padded blue-grey linen' for m in ob.data.materials):
  for slot in ob.material_slots:
   if slot.material and slot.material.name=='Padded blue-grey linen':slot.material=padding
  physical_uv(ob)
  for mod in ob.modifiers:
   if mod.type=='SOLIDIFY':mod.thickness=.004;mod.offset=-1

# Shirt/short sleeves and split skirt are separate fitted mail surfaces, weighted
# exactly like their padding. Their silhouette and hem thickness survive zoom.
mail_torso=subset(under,'MAIL_Shirt',lambda c:c.z>1.025,mail,.012)
for mod in mail_torso.modifiers:
 if mod.type=='SOLIDIFY':mod.thickness=.0035;mod.offset=-1
skirt=bpy.data.objects['CLOTH_Split padded hip skirt']
mail_skirt=subset(skirt,'MAIL_Split skirt',lambda c:True,mail,.014)
for mod in mail_skirt.modifiers:
 if mod.type=='SOLIDIFY':mod.thickness=.0035;mod.offset=-1
# A full leather girdle lies outside mail; the existing underlying belt is hidden
# by the outer one when mail is enabled.
mail_belt=duplicate(bpy.data.objects['CLOTH_Waist belt'],'MAIL_Outer belt')
for v in mail_belt.data.vertices:
 radial=Vector((v.co.x,v.co.y,0)).normalized();v.co+=radial*.022

# Hair and facial hair follow the head surface and leave the eyes/nose/mouth open.
body=bpy.data.objects['BODY_Human'];body.data.update()
hair_ob=subset(body,'HAIR_Cropped',lambda c:c.z>1.733 or (c.z>1.657 and c.y>.012) or (c.z>1.704 and abs(c.x)>.061),hair,.003)
for mod in hair_ob.modifiers:
 if mod.type=='SUBSURF':mod.levels=1;mod.render_levels=1
for kind,offset in [('stubble',.0009),('short',.006)]:
 ob=subset(body,'BEARD_'+kind,lambda c:1.563<c.z<1.66 and c.y<-.069 and abs(c.x)<.077 and not(1.610<c.z<1.636 and abs(c.x)<.033),beard,offset)
 ob['beardVariant']=kind

# Weapon geometry is made around the verified right grip in guard, then put back
# in bind space. Runtime IK uses the exact same frame metadata below.
g=Vector(frames['spear_grip']);axis=Vector(frames['spear_axis']).normalized()
u=axis.cross(Vector((0,1,0))).normalized();v=axis.cross(u).normalized()
metal=bpy.data.materials['weapon.metal'];wood=bpy.data.materials['weapon.wood'];leather=bpy.data.materials['weapon.grip']
binding=bpy.data.materials['weapon.binding'];weapon_points={}
def weapon_part(ob,variant):ob['equipmentSlot']='weapon';ob['equipmentVariant']=variant;return posed_rigid(ob,'wrist.R')
def blade(variant,start,length,width):
 a=g+axis*start;b=a+axis*(length*.74);tip=a+axis*length
 vs=[a-u*width,a+u*width,a+v*.005,a-v*.005,b-u*width*.7,b+u*width*.7,b+v*.004,b-v*.004,tip]
 fs=[(0,4,6,2),(2,6,5,1),(1,5,7,3),(3,7,4,0),(4,8,6),(6,8,5),(5,8,7),(7,8,4),(0,2,1,3)]
 weapon_part(mesh('WEAPON_'+variant+'_Blade',vs,fs,metal),variant)
 return tip
for variant in ('sword','greatsword'):
 two=variant=='greatsword';bottom=-.27 if two else -.12;guard=.115;tip=blade(variant,guard,1.095 if two else .745,.034 if two else .026)
 weapon_part(tube('WEAPON_'+variant+'_Grip',[g+axis*(bottom+.035),g+axis*(guard-.015)],.014,leather,res=16),variant)
 weapon_part(tube('WEAPON_'+variant+'_Pommel',[g+axis*bottom,g+axis*(bottom+.035)],[.025,.023],metal,res=16),variant)
 weapon_part(tube('WEAPON_'+variant+'_Guard',[g+axis*guard-u*(.13 if two else .105),g+axis*guard+u*(.13 if two else .105)],.011,metal,res=12),variant)
 for i in range(7 if two else 4):
  p=g+axis*(bottom+.05+i*.035);weapon_part(tube('WEAPON_'+variant+'_Binding',[p,p+axis*.003],.0144,binding),variant)
 weapon_points[variant]={'grip':g,'axis':axis,'tip':tip,'second':g-axis*.13 if two else None,'length':1.48 if two else .98}
variant='pike';bottom=g-axis*.90;top=g+axis*2.08
weapon_part(tube('WEAPON_pike_Shaft',[bottom,top],.015,wood,res=16),variant)
weapon_part(tube('WEAPON_pike_Ferrule',[bottom,bottom+axis*.12],[.014,.018],metal,res=16),variant)
weapon_part(tube('WEAPON_pike_Grip',[g-axis*.075,g+axis*.065],.016,leather,res=16),variant)
weapon_part(tube('WEAPON_pike_Forward grip',[g+axis*.31,g+axis*.45],.016,leather,res=16),variant)
tip=blade(variant,2.08,.22,.025)
weapon_points[variant]={'grip':g,'axis':axis,'tip':tip,'second':g+axis*.38,'length':3.2}
weapon_points['spear']={'grip':g,'axis':axis,'tip':g+axis*1.565,'second':None,'length':2.57}

# Alternative shields: real thickness, rolled rim, timber back and retained
# fitted leather grip/enarmes. All surfaces meet the same forearm interface.
sg=Vector(frames['shield_grip']);sx=Vector(frames['shield_right']).normalized();sz=Vector(frames['shield_up']).normalized();sf=sx.cross(sz).normalized()
if sf.y>0:sf.negate()
shield_grip_parts=[o for o in MODEL if o.name.startswith(('SHIELD_Grip','SHIELD_Leather enarme','SHIELD_Strap mounting'))]
for variant in ('round','heater'):
 center=sg-sz*(.05 if variant=='round' else .12)+sx*.04+sf*.105
 def sh(x,z,depth=0):return center+sx*x+sz*z+sf*(depth+.055*(1-(x/.34)**2))
 outline=[(.36*math.sin(i*math.tau/64),.36*math.cos(i*math.tau/64)) for i in range(64)] if variant=='round' else [(-.31,.43),(.31,.43),(.30,.12),(.23,-.18),(0,-.48),(-.23,-.18),(-.30,.12)]
 n=len(outline);vs=[sh(0,0)]+[sh(x,z) for x,z in outline];fs=[(0,i+1,(i+1)%n+1) for i in range(n)]
 parts=[]
 front=mesh('SHIELD_'+variant+'_Face',vs,fs,bpy.data.materials['shield.face']);solid=front.modifiers.new('Timber core','SOLIDIFY');solid.thickness=.022;parts.append(front)
 parts.append(tube('SHIELD_'+variant+'_Rim',[sh(x,z,-.006) for x,z in outline]+[sh(*outline[0],-.006)],.012,bpy.data.materials['shield.trim']))
 parts.append(mesh('SHIELD_'+variant+'_Back',[p-sf*.024 for p in vs],[tuple(reversed(f)) for f in fs],bpy.data.materials['shield.wood']))
 parts.append(tube('SHIELD_'+variant+'_Crossbar',[sh(-.25,0,-.035),sh(.25,0,-.035)],.013,bpy.data.materials['shield.wood']))
 stripe=[sh(x,z,.003) for z in (-.25,.28) for x in (-.025,.025)]
 parts.append(mesh('SHIELD_'+variant+'_Stripe',stripe,[(0,1,3,2)],bpy.data.materials['shield.emblem']))
 for ob in parts:ob['equipmentSlot']='shield';ob['equipmentVariant']=variant;posed_rigid(ob,'wrist.L')
 for original in shield_grip_parts:
  ob=duplicate(original,'SHIELD_'+variant+'_'+original.name.removeprefix('SHIELD_'));ob['equipmentSlot']='shield';ob['equipmentVariant']=variant

def classify(ob):
 if 'equipmentSlot' in ob:return ob['equipmentSlot'],ob.get('equipmentVariant','')
 if ob.name.startswith('ARMOR_'):return 'plate','plate'
 if ob.name.startswith('HELMET_'):return 'helmet','on'
 if ob.name.startswith('SPEAR_'):return 'weapon','spear'
 if ob.name.startswith('SHIELD_'):return 'shield','tower'
 if ob.name.startswith('MAIL_'):return 'mail','mail'
 if ob.name.startswith('HAIR_'):return 'hair','short'
 if ob.name.startswith('BEARD_'):return 'beard',ob['beardVariant']
 if ob.name.startswith('CLOTH_') and any(m==padding for m in ob.data.materials):return 'padding','padded'
 return 'base','base'

def default_visible(slot,variant):return slot not in ('mail','hair','beard') and (slot!='weapon' or variant=='spear') and (slot!='shield' or variant=='tower')
for ob in MODEL:
 slot,variant=classify(ob);ob['equipmentSlot']=slot;ob['equipmentVariant']=variant;ob['defaultVisible']=default_visible(slot,variant)

# Apply geometric modifiers in bind space, then add morphs to the actual exported
# vertices. This keeps the skinned garment and plate envelopes together.
for ob in MODEL:
 for mod in ob.modifiers:
  if mod.type=='ARMATURE':mod.show_viewport=False;mod.show_render=False
 bpy.ops.object.select_all(action='DESELECT');ob.select_set(True);bpy.context.view_layer.objects.active=ob
 for mod in list(ob.modifiers):
  if mod.type!='ARMATURE':bpy.ops.object.modifier_apply(modifier=mod.name)
 for mod in ob.modifiers:
  if mod.type=='ARMATURE':mod.show_viewport=True;mod.show_render=True

def physique_delta(co):
 x,y,z=co;delta=Vector((0,0,0))
 # Torso and thighs, modest trained build rather than uniform scaling.
 if abs(x)<.24 and .80<z<1.53:
  chest=math.exp(-((z-1.385)/.13)**2);waist=math.exp(-((z-1.14)/.11)**2)
  delta.x=x*(.105*chest+.025*waist);delta.y=y*(.14*chest+.045*waist)
 # Arms: radial change around bone segments fades before wrists.
 for side in ('L','R'):
  for first,last,amount in [('upperarm01.','lowerarm01.',.12),('lowerarm01.','wrist.',.10),('upperleg01.','lowerleg01.',.08),('lowerleg01.','foot.',.055)]:
   a=rig.data.bones[first+side].head_local;b=rig.data.bones[last+side].head_local;d=b-a;t=(co-a).dot(d)/d.length_squared
   if .02<t<.98:
    radial=co-(a+d*t)
    if radial.length<(.12 if 'leg' in first else .095):
     delta+=radial*amount*math.sin(math.pi*t)**.6
 return delta

for ob in MODEL:
 slot=ob['equipmentSlot']
 if slot in ('shield','weapon','hair','beard','helmet'):continue
 ob.shape_key_add(name='Basis')
 for key,sign in [('lean',-.72),('strong',1)]:
  target=ob.shape_key_add(name=key)
  for i,p in enumerate(target.data):p.co=ob.data.vertices[i].co+physique_delta(ob.data.vertices[i].co)*sign
 if ob.name.startswith('BODY_'):
  target=ob.shape_key_add(name='veteran')
  for i,p in enumerate(target.data):
   c=ob.data.vertices[i].co.copy()
   if 1.58<c.z<1.74 and c.y<-.04:
    cheek=math.exp(-((c.z-1.665)/.032)**2);c.x*=1-.035*cheek;c.y+=.0018*cheek
   p.co=c

# Merge per slot/variant only. Common morph names are preserved by Blender join.
groups={}
for ob in MODEL:groups.setdefault((ob['equipmentSlot'],ob['equipmentVariant']),[]).append(ob)
merged=[]
for (slot,variant),parts in groups.items():
 bpy.ops.object.select_all(action='DESELECT')
 for ob in parts:ob.select_set(True)
 bpy.context.view_layer.objects.active=parts[0]
 if len(parts)>1:bpy.ops.object.join()
 ob=bpy.context.object;ob.name=slot.upper()+'_'+variant;ob['equipmentSlot']=slot;ob['equipmentVariant']=variant;ob['defaultVisible']=default_visible(slot,variant)
 merged.append(ob)

def gltf_vector(p):return [p.x,p.z,-p.y]
for ob in merged:
 slot,variant=ob['equipmentSlot'],ob['equipmentVariant']
 if slot=='weapon':
  frame=weapon_points[variant];inv=(rig.pose.bones['wrist.R'].matrix@rig.data.bones['wrist.R'].matrix_local.inverted()).inverted()
  ob['gripBind']=gltf_vector(inv@frame['grip']);ob['shaftAxisBind']=gltf_vector(inv.to_3x3()@frame['axis']);ob['tipBind']=gltf_vector(inv@frame['tip']);ob['lengthMetres']=frame['length']
  if frame['second'] is not None:ob['secondGripBind']=gltf_vector(inv@frame['second'])
 if slot=='shield':
  inv=(rig.pose.bones['wrist.L'].matrix@rig.data.bones['wrist.L'].matrix_local.inverted()).inverted()
  ob['gripBind']=gltf_vector(inv@sg);ob['handleAxisBind']=gltf_vector(inv.to_3x3()@Vector(frames['shield_handle_axis']))

# Save the exact catalogue before export. Default visibility is app metadata;
# Blender render selection below uses the same settings.
for ob in merged:ob.hide_render=not ob['defaultVisible'];ob.hide_viewport=False
scene.render.threads_mode='FIXED';scene.render.threads=2
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'white-pawn.blend'),compress=True)

def configure_render(kind='plate',build='regular',experience='recruit'):
 for ob in merged:
  slot=ob['equipmentSlot'];variant=ob['equipmentVariant']
  ob.hide_render=not (slot in ('base','padding') or (slot=='plate' and kind=='plate') or (slot=='mail' and kind=='mail') or (slot in ('helmet','shield','weapon') and ob['defaultVisible']))
  if ob.data.shape_keys:
   for k in ob.data.shape_keys.key_blocks:
    if k.name!='Basis':k.value=1 if k.name==build or k.name==experience else 0

def render(name,kind='plate',build='regular'):
 configure_render(kind,build);scene.render.resolution_x=720;scene.render.resolution_y=900;scene.cycles.samples=16
 scene.render.filepath=str(REVIEW/name);bpy.ops.render.render(write_still=True)

if '--preview-only' in sys.argv:
 render('modular-mail.png','mail');render('modular-padded.png','padded');print('MODULAR_PREVIEW_READY');raise SystemExit

bpy.ops.object.select_all(action='DESELECT');rig.select_set(True)
for ob in merged:ob.select_set(True);ob.hide_render=False
bpy.context.view_layer.objects.active=rig
for tr in rig.animation_data.nla_tracks:tr.mute=False
bpy.ops.export_scene.gltf(filepath=str(OUT/'white-pawn.glb'),export_format='GLB',use_selection=True,export_apply=False,export_yup=True,export_animations=True,export_animation_mode='NLA_TRACKS',export_force_sampling=True,export_frame_range=False,export_skins=True,export_all_influences=False,export_extras=True,export_cameras=False,export_lights=False,export_morph=True)
for tr in rig.animation_data.nla_tracks:tr.mute=True
rig.animation_data.action=None;pawn_pose.apply_pose('rest',0);scene.frame_set(0);bpy.context.view_layer.update()
# Keep standalone GLB default joint transforms at the first guard sample.
raw=(OUT/'white-pawn.glb').read_bytes();jl=struct.unpack_from('<I',raw,12)[0];doc=json.loads(raw[20:20+jl]);binary=raw[28+jl:]
clip=next(a for a in doc['animations'] if a['name']=='Guard_Breath')
for channel in clip['channels']:
 target=channel['target'];path=target['path']
 if path not in ('translation','rotation','scale'):continue
 sample=clip['samplers'][channel['sampler']];accessor=doc['accessors'][sample['output']];view=doc['bufferViews'][accessor['bufferView']];n=4 if path=='rotation' else 3
 offset=view.get('byteOffset',0)+accessor.get('byteOffset',0)+(n*4 if sample.get('interpolation')=='CUBICSPLINE' else 0)
 node=doc['nodes'][target['node']];node.pop('matrix',None);node[path]=list(struct.unpack_from('<'+'f'*n,binary,offset))
jb=json.dumps(doc,separators=(',',':')).encode();jb+=b' '*((-len(jb))%4)
raw=struct.pack('<III',0x46546c67,2,28+len(jb)+len(binary))+struct.pack('<II',len(jb),0x4e4f534a)+jb+struct.pack('<II',len(binary),0x004e4942)+binary
(OUT/'white-pawn.glb').write_bytes(raw)
render('neutral.png');render('modular-mail.png','mail');render('modular-padded.png','padded')
info.update(version='0.3.0',glb_sha256=hashlib.sha256(raw).hexdigest(),source_commit=SOURCE,modular={'slots':sorted(groups),'bodyTargets':['lean','strong'],'experienceTarget':'veteran','surfaceTileMetres':.04,'mailOuterDiameterMetres':.0112,'quiltDiagonalSpacingMetres':.028284,'catalogueDownload':True,'runtimeWeaponIKBaked':False},limits=['Fantasy infantry equipment, not historical replica','New weapon IK is evaluated in the browser, not baked into the three original GLB clips','Catalogue GLB contains all variants; selected appearance is saved separately in JSON','No cloth simulation or full-board LOD'])
(OUT/'model-info.json').write_text(json.dumps(info,indent=2,default=list)+'\n')
report={'status':'built','glbSha256':info['glb_sha256'],'bytes':len(raw),'meshes':len(doc['meshes']),'groups':[{k:ob[k] for k in ('equipmentSlot','equipmentVariant','defaultVisible')} for ob in merged],'sourceCommit':SOURCE}
(REVIEW/'modular-asset-build.json').write_text(json.dumps(report,indent=2)+'\n');print('MODULAR_ASSET_READY',json.dumps(report))
