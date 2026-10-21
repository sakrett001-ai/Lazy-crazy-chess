"""Material-only migration of the verified pawn 0.2 to independent appearance slots.

Run with the existing Blender Python runtime. The GLB BIN chunk and all glTF
JSON except material definitions/references must remain byte/structurally equal.
The authored mesh, modifier, rig and action signature is also checked before
and after saving/reopening the .blend. This is preservation evidence, not a new
429-pose contact audit.
"""
from pathlib import Path
import array, copy, datetime, hashlib, json, struct, time
import bpy

ROOT=Path(__file__).resolve().parents[1]
ASSETS=ROOT/'assets'; REVIEW=ROOT/'review'
GLB=ASSETS/'white-pawn.glb'; BLEND=ASSETS/'white-pawn.blend'
SLOTS={
 'armor.main':((.50,.54,.58),1,.32),
 'armor.trim':((.60,.64,.67),1,.24),
 'shield.face':((.82,.82,.78),0,.42),
 'shield.trim':((.50,.57,.62),1,.27),
 'shield.emblem':((.025,.135,.16),.28,.31),
 'shield.wood':((.24,.135,.061),0,.62),
 'shield.leather':((.075,.055,.038),0,.8),
 'weapon.metal':((.50,.57,.62),1,.27),
 'weapon.wood':((.24,.135,.061),0,.62),
 'weapon.grip':((.075,.055,.038),0,.8),
 'weapon.binding':((.018,.022,.026),.1,.65),
}
SLOT_BASE={
 'armor.main':'Ivory enamel','armor.trim':'Cold brushed silver',
 'shield.face':'Ivory enamel','shield.trim':'Cold brushed silver',
 'shield.emblem':'Deep teal enamel','shield.wood':'Ash wood shaft',
 'shield.leather':'Dark leather','weapon.metal':'Cold brushed silver',
 'weapon.wood':'Ash wood shaft','weapon.grip':'Dark leather',
 'weapon.binding':'Joint recess',
}
def slot_for(object_name,material_name):
 if material_name in SLOTS:return material_name
 if object_name.startswith('SHIELD_'):
  return {'Ivory enamel':'shield.face','Cold brushed silver':'shield.trim','Deep teal enamel':'shield.emblem','Ash wood shaft':'shield.wood','Dark leather':'shield.leather'}.get(material_name)
 if object_name.startswith('SPEAR_'):
  return {'Cold brushed silver':'weapon.metal','Ash wood shaft':'weapon.wood','Dark leather':'weapon.grip','Joint recess':'weapon.binding'}.get(material_name)
 if object_name.startswith(('ARMOR_','HELMET_')):
  return {'Ivory enamel':'armor.main','Cold brushed silver':'armor.trim'}.get(material_name)
 return None
def sha(data):return hashlib.sha256(data).hexdigest()
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()
def glb_read(raw):
 magic,version,total=struct.unpack_from('<III',raw)
 assert magic==0x46546c67 and version==2 and total==len(raw)
 size,kind=struct.unpack_from('<II',raw,12);assert kind==0x4e4f534a
 doc=json.loads(raw[20:20+size]);offset=20+size
 bin_size,bin_kind=struct.unpack_from('<II',raw,offset);assert bin_kind==0x004e4942
 binary=raw[offset+8:];assert len(binary)==bin_size
 return doc,binary
def geometry_json(doc):
 clean=copy.deepcopy(doc);clean.pop('materials',None)
 for mesh in clean['meshes']:
  for primitive in mesh['primitives']:primitive.pop('material',None)
 return clean
def flat(value):
 if value is None or isinstance(value,(str,bool,int,float)):return value
 if isinstance(value,bpy.types.ID):return {'id':value.name,'type':value.bl_rna.identifier}
 try:return [flat(x) for x in value]
 except TypeError:return str(value)
def rna_properties(obj):
 result={}
 for prop in obj.bl_rna.properties:
  if prop.identifier in {'rna_type'} or prop.is_readonly or prop.type=='COLLECTION':continue
  try:result[prop.identifier]=flat(getattr(obj,prop.identifier))
  except (TypeError,ValueError,AttributeError):pass
 return result
def authored_signature():
 """Exact authored data relevant to geometry and movement; excludes materials."""
 h=hashlib.sha256();counts={'objects':0,'vertices':0,'polygons':0,'bones':0,'fcurves':0}
 def add(value):h.update(canonical(value));h.update(b'\0')
 def values(collection,attr,width,typecode='f'):
  data=array.array(typecode,[0])*(len(collection)*width)
  collection.foreach_get(attr,data);h.update(data.tobytes());h.update(b'\0')
 for ob in sorted(bpy.context.scene.objects,key=lambda o:o.name):
  if ob.type not in {'MESH','ARMATURE'} or ob.name.startswith('STUDIO_'):continue
  counts['objects']+=1
  add({'name':ob.name,'type':ob.type,'matrix':flat(ob.matrix_world),'parent':ob.parent.name if ob.parent else None,
       'modifiers':[rna_properties(m) for m in ob.modifiers],
       'constraints':[rna_properties(c)for c in ob.constraints]})
  if ob.type=='MESH':
   mesh=ob.data;counts['vertices']+=len(mesh.vertices);counts['polygons']+=len(mesh.polygons)
   add([len(mesh.vertices),len(mesh.edges),len(mesh.loops),len(mesh.polygons)])
   values(mesh.vertices,'co',3);values(mesh.edges,'vertices',2,'i')
   values(mesh.loops,'vertex_index',1,'i');values(mesh.polygons,'loop_start',1,'i');values(mesh.polygons,'loop_total',1,'i')
   add([[p.use_smooth,p.material_index]for p in mesh.polygons])
   add([g.name for g in ob.vertex_groups]);add([[(g.group,g.weight)for g in v.groups]for v in mesh.vertices])
   if mesh.shape_keys:
    for key in mesh.shape_keys.key_blocks:add([key.name,key.value]);values(key.data,'co',3)
  else:
   for bone in ob.data.bones:
    counts['bones']+=1;add([bone.name,bone.parent.name if bone.parent else None,flat(bone.matrix_local),flat(bone.head_local),flat(bone.tail_local),bone.use_deform])
   for bone in ob.pose.bones:add([bone.name,flat(bone.matrix_basis),[rna_properties(c)for c in bone.constraints]])
   ad=ob.animation_data
   if ad:add({'action':ad.action.name if ad.action else None,'tracks':[[track.name,track.mute,[[s.name,s.action.name,s.frame_start,s.frame_end,s.action_frame_start,s.action_frame_end,s.scale,s.repeat]for s in track.strips]]for track in ad.nla_tracks]})
 for action in sorted(bpy.data.actions,key=lambda a:a.name):
  add(action.name)
  for fc in action.fcurves:
   counts['fcurves']+=1;add([fc.data_path,fc.array_index,fc.extrapolation,
    [[flat(k.co),flat(k.handle_left),flat(k.handle_right),k.interpolation,k.handle_left_type,k.handle_right_type]for k in fc.keyframe_points]])
 return h.hexdigest(),counts

old_info=json.loads((ASSETS/'model-info.json').read_text())
old_raw=GLB.read_bytes()
old_glb_sha=sha(old_raw);old_blend_sha=sha(BLEND.read_bytes())
if old_info.get('version') not in {'0.2.0','0.2.1'}:
 raise SystemExit('Material migration refused: expected model 0.2.0 or a verified 0.2.1 migration.')
if old_info.get('glb_sha256')!=old_glb_sha:
 raise SystemExit('Material migration refused: model-info.json does not match the current GLB.')
if old_info['version']=='0.2.1':
 # Re-running a completed migration must preserve the original source hashes.
 # Never replace inheritance evidence with a new report whose source is itself.
 try:existing=json.loads((REVIEW/'material-checks.json').read_text())
 except (OSError,ValueError):
  raise SystemExit('Material migration refused: model 0.2.1 needs its existing preservation proof.')
 if not (existing.get('status')=='passed' and existing.get('modelVersion')=='0.2.1'
         and existing.get('sourceModelVersion')=='0.2.0'
         and existing.get('glbSha256')==old_glb_sha
         and existing.get('blendSha256')==old_blend_sha):
  raise SystemExit('Material migration refused: preservation proof does not match the current assets.')
 print('Material migration already verified; assets, poster and original preservation proof left unchanged.',flush=True)
 raise SystemExit(0)
old_doc,binary=glb_read(old_raw)
old_json_sha=sha(canonical(geometry_json(old_doc)));binary_sha=sha(binary)
doc=copy.deepcopy(old_doc)
templates={m['name']:copy.deepcopy(m)for m in old_doc['materials']}
indices={m['name']:i for i,m in enumerate(doc['materials'])}
for slot,(color,metal,rough) in SLOTS.items():
 material=copy.deepcopy(templates.get(slot) or templates[SLOT_BASE[slot]])
 material['name']=slot;material.setdefault('extras',{})['customizationSlot']=slot
 material.setdefault('pbrMetallicRoughness',{}).update({'baseColorFactor':[*color,1],'metallicFactor':metal,'roughnessFactor':rough})
 if slot in indices:doc['materials'][indices[slot]]=material
 else:indices[slot]=len(doc['materials']);doc['materials'].append(material)
mapping=[]
for mesh in doc['meshes']:
 for primitive in mesh['primitives']:
  old_name=old_doc['materials'][primitive['material']]['name'];slot=slot_for(mesh['name'],old_name)
  if slot:primitive['material']=indices[slot]
  mapping.append({'mesh':mesh['name'],'sourceMaterial':old_name,'slot':slot or old_name})
# Remove unused old material definitions while retaining primitive order and buffers.
used=sorted({p['material'] for m in doc['meshes'] for p in m['primitives']})
remap={old:i for i,old in enumerate(used)};doc['materials']=[doc['materials'][i]for i in used]
for mesh in doc['meshes']:
 for primitive in mesh['primitives']:primitive['material']=remap[primitive['material']]
assert canonical(geometry_json(doc))==canonical(geometry_json(old_doc))
jb=json.dumps(doc,separators=(',',':')).encode();jb+=b' '*((-len(jb))%4)
new_raw=struct.pack('<III',0x46546c67,2,12+8+len(jb)+8+len(binary))+struct.pack('<II',len(jb),0x4e4f534a)+jb+struct.pack('<II',len(binary),0x004e4942)+binary
assert glb_read(new_raw)[1]==binary

bpy.ops.wm.open_mainfile(filepath=str(BLEND))
scene=bpy.context.scene;before_signature,counts=authored_signature()
original_assignments=[(ob,i,m.name)for ob in scene.objects if ob.type=='MESH' for i,m in enumerate(ob.data.materials)if m]
blend_materials={m.name:m for m in bpy.data.materials}
new_materials={}
for slot,(color,metal,rough) in SLOTS.items():
 material=blend_materials.get(slot)
 if material is None:material=blend_materials[SLOT_BASE[slot]].copy();material.name=slot
 material.diffuse_color=(*color,1);material.use_nodes=True
 shader=material.node_tree.nodes.get('Principled BSDF');assert shader
 shader.inputs['Base Color'].default_value=(*color,1);shader.inputs['Metallic'].default_value=metal;shader.inputs['Roughness'].default_value=rough
 material['customizationSlot']=slot;new_materials[slot]=material
for ob,i,name in original_assignments:
 slot=slot_for(ob.name,name)
 if slot:ob.data.materials[i]=new_materials[slot]
after_signature,after_counts=authored_signature()
assert before_signature==after_signature and counts==after_counts
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND),compress=True)
bpy.ops.wm.open_mainfile(filepath=str(BLEND))
reopened_signature,reopened_counts=authored_signature()
assert before_signature==reopened_signature and counts==reopened_counts
GLB.write_bytes(new_raw)
scene=bpy.context.scene;scene.render.filepath=str(REVIEW/'neutral.png')
start=time.monotonic();bpy.ops.render.render(write_still=True);render_seconds=round(time.monotonic()-start,2)
report={
 'status':'passed','checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'kind':'material-only migration, preserving prior geometry and animation',
 'sourceModelVersion':old_info['version'],'modelVersion':'0.2.1',
 'sourceGlbSha256':old_glb_sha,'glbSha256':sha(GLB.read_bytes()),
 'sourceBlendSha256':old_blend_sha,'blendSha256':sha(BLEND.read_bytes()),
 'glbBinarySha256Before':binary_sha,'glbBinarySha256After':sha(glb_read(GLB.read_bytes())[1]),
 'glbNonMaterialJsonSha256Before':old_json_sha,'glbNonMaterialJsonSha256After':sha(canonical(geometry_json(glb_read(GLB.read_bytes())[0]))),
 'authoredSignatureBefore':before_signature,'authoredSignatureAfter':after_signature,'authoredSignatureAfterReopen':reopened_signature,
 'authoredCounts':counts,'materialAssignments':mapping,
 'slots':{name:{'linearBaseColor':[*color,1],'metallic':metal,'roughness':rough}for name,(color,metal,rough)in SLOTS.items()},
 'tests':['GLB BIN chunk exactly preserved','All glTF JSON outside materials and primitive material references preserved','Authored meshes, modifiers, vertex weights, bones, poses and actions unchanged before/after/save-reopen','Independent material slots assigned by equipment category','Default shield face remains white dielectric while armor and helmet are steel'],
 'limits':['This preserves the geometry of the input model; it is not a rerun of the 429-pose contact audit.','Material presets change appearance only, not armor construction or weapon reach.'],
}
(REVIEW/'material-checks.json').write_text(json.dumps(report,indent=2)+'\n')
info=json.loads((ASSETS/'model-info.json').read_text());info['version']='0.2.1';info['glb_sha256']=report['glbSha256'];info['render_seconds']['neutral.png']=render_seconds
info['material_revision']={'slots':list(SLOTS),'proof':'../review/material-checks.json','preserves_glb_geometry_of':old_glb_sha}
(ASSETS/'model-info.json').write_text(json.dumps(info,indent=2)+'\n')
print('MATERIAL_REPORT',json.dumps({k:v for k,v in report.items()if k not in {'materialAssignments','slots'}}),flush=True)
