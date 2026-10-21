"""Validate exported bytes and reimport GLB in Blender without rewriting it.
Checks data integrity and measured rest geometry, not anatomical/weapon collisions.
"""
from pathlib import Path
import json, struct, hashlib
import numpy as np
import bpy
ROOT=Path(__file__).resolve().parents[1];path=ROOT/'assets/human-base.glb';raw=path.read_bytes()
magic,version,total=struct.unpack_from('<III',raw)
assert magic==0x46546C67 and version==2 and total==len(raw)
size,kind=struct.unpack_from('<II',raw,12);assert kind==0x4E4F534A
gltf=json.loads(raw[20:20+size]);binary=raw[28+size:]
types={5120:'i1',5121:'u1',5122:'<i2',5123:'<u2',5125:'<u4',5126:'<f4'};components={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}
def array(index):
 a=gltf['accessors'][index];v=gltf['bufferViews'][a['bufferView']];dtype=np.dtype(types[a['componentType']]);c=components[a['type']];offset=v.get('byteOffset',0)+a.get('byteOffset',0)
 return np.ndarray((a['count'],c),dtype=dtype,buffer=binary,offset=offset,strides=(v.get('byteStride',dtype.itemsize*c),dtype.itemsize)).copy()
for i,a in enumerate(gltf['accessors']):
 if 'bufferView' in a:assert np.isfinite(array(i)).all(),i
mesh_results=[]
for mesh in gltf['meshes']:
 for p in mesh['primitives']:
  pos=array(p['attributes']['POSITION']);weights=array(p['attributes']['WEIGHTS_0']);joint_ids=array(p['attributes']['JOINTS_0'])
  assert (weights>=0).all() and (weights<=1.0001).all()
  assert np.max(np.abs(weights.sum(axis=1)-1))<2e-5
  assert joint_ids.max()<len(gltf['skins'][0]['joints'])
  mesh_results.append({'name':mesh['name'],'vertices':len(pos),'triangles':int(gltf['accessors'][p['indices']]['count']/3),'weight_sum_max_error':float(np.max(np.abs(weights.sum(axis=1)-1)))})
clips=[]
for anim in gltf['animations']:
 times=np.concatenate([array(s['input']).flatten() for s in anim['samplers']]);assert abs(times.min())<1e-5 and abs(times.max()-3)<1e-5
 endpoint_error=0
 for sampler in anim['samplers']:
  out=array(sampler['output']);endpoint_error=max(endpoint_error,float(np.max(np.abs(out[0]-out[-1]))))
 assert endpoint_error<1e-4
 clips.append({'name':anim['name'],'duration_seconds':float(times.max()),'endpoint_max_error':endpoint_error,'channels':len(anim['channels'])})
assert {a['name'] for a in clips}=={'Elbow_Flex','Ready_Study','Hand_Close'}
assert len(gltf['skins'])==1 and len(gltf['skins'][0]['joints'])==163
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(path))
rigs=[ob for ob in bpy.context.scene.objects if ob.type=='ARMATURE'];assert len(rigs)==1
rig=rigs[0];assert len(rig.data.bones)==163
if rig.animation_data:
 rig.animation_data.action=None
 for t in rig.animation_data.nla_tracks:t.mute=True
for p in rig.pose.bones:p.matrix_basis.identity()
bpy.context.view_layer.update()
body=bpy.data.objects.get('Human body');assert body is not None
positions=np.array([(body.matrix_world@v.co)[:] for v in body.data.vertices]);assert np.isfinite(positions).all()
bounds=[positions.min(axis=0).tolist(),positions.max(axis=0).tolist()];height=float(np.ptp(positions[:,2]));assert abs(height-1.8)<.005
report={'glb_sha256':hashlib.sha256(raw).hexdigest(),'bpy':bpy.app.version_string,'glb_reimport':'passed, no re-export','bones':len(rig.data.bones),'rest_height_metres':height,'rest_bounds_blender_z_up_metres':bounds,'meshes':mesh_results,'clips':clips,'finite_accessors':True,'scope':'Byte integrity, finite geometry, normalized four-joint skinning, clip endpoints/duration and Blender reimport. Not a collision or muscle deformation proof.'}
(ROOT/'assets/model-checks.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
