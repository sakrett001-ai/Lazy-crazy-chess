"""Validate the delivered GLB structure, closed clips and posed import. No full collision claim."""
from pathlib import Path
import struct,json,hashlib
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
p=ROOT/'assets/white-pawn.glb';raw=p.read_bytes()
magic,version,length=struct.unpack_from('<III',raw)
assert magic==0x46546c67 and version==2 and length==len(raw)
n=struct.unpack_from('<I',raw,12)[0];doc=json.loads(raw[20:20+n]);binary=raw[28+n:]
counts={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16};dtypes={5120:'i1',5121:'u1',5122:'<i2',5123:'<u2',5125:'<u4',5126:'<f4'}
def access(index):
 a=doc['accessors'][index];v=doc['bufferViews'][a['bufferView']];dtype=np.dtype(dtypes[a['componentType']]);width=counts[a['type']]
 return np.ndarray((a['count'],width),dtype=dtype,buffer=binary,offset=v.get('byteOffset',0)+a.get('byteOffset',0),strides=(v.get('byteStride',width*dtype.itemsize),dtype.itemsize))
for i,a in enumerate(doc['accessors']):assert np.isfinite(access(i)).all(),i
assert len(doc['skins'])==1
skin=doc['skins'][0];weight_error=0;triangles=0
for m in doc['meshes']:
 for primitive in m['primitives']:
  attrs=primitive['attributes'];assert all(x in attrs for x in ['POSITION','JOINTS_0','WEIGHTS_0'])
  w=access(attrs['WEIGHTS_0']);j=access(attrs['JOINTS_0']);weight_error=max(weight_error,float(abs(w.sum(axis=1)-1).max()))
  assert np.all(w>=0) and j.max()<len(skin['joints'])
  triangles+=doc['accessors'][primitive['indices']]['count']//3
assert weight_error<1e-5
expected={'Guard_Breath':6,'Shield_Brace':4,'Spear_Study':4};clips={}
for a in doc['animations']:
 end=0;endpoint_error=0;default_error=0
 for ch in a['channels']:
  s=a['samplers'][ch['sampler']];times=access(s['input']).ravel();values=access(s['output']);assert abs(times[0])<1e-7
  end=max(end,float(times[-1]));endpoint_error=max(endpoint_error,float(abs(values[0]-values[-1]).max()))
  if a['name']=='Guard_Breath':
   target=ch['target'];default_error=max(default_error,float(abs(np.array(doc['nodes'][target['node']][target['path']])-values[0]).max()))
 assert abs(end-expected[a['name']])<1e-5 and endpoint_error<1e-5 and default_error<1e-7
 clips[a['name']]={'seconds':end,'endpoint_max_error':endpoint_error,'default_max_error':default_error}
assert set(clips)==set(expected)
# Independently import the exported result, including skinning and posed default nodes.
import bpy
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(p))
deps=bpy.context.evaluated_depsgraph_get();points=[]
for ob in bpy.context.scene.objects:
 if ob.type=='MESH' and any(m.type=='ARMATURE' for m in ob.modifiers):
  ev=ob.evaluated_get(deps);me=ev.to_mesh();points.extend(tuple(ob.matrix_world@v.co) for v in me.vertices);ev.to_mesh_clear()
points=np.array(points);lo=points.min(axis=0);hi=points.max(axis=0)
assert -.012<lo[2]<.04 and 2.35<hi[2]<3.0,(lo,hi)
report={'status':'passed','sha256':hashlib.sha256(raw).hexdigest(),'glb_bytes':len(raw),'meshes':len(doc['meshes']),'material_primitives':sum(len(m['primitives']) for m in doc['meshes']),'triangles':triangles,'joints':len(skin['joints']),'weight_sum_max_error':weight_error,'clips':clips,'reimport_bounds_z_up_metres':[lo.tolist(),hi.tolist()],'scope':'File integrity; finite accessors; normalized weights; clip lengths, endpoints and default guard; posed Blender reimport. Not full collision, muscle, cloth or combat validation.'}
(ROOT/'assets/model-checks.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
