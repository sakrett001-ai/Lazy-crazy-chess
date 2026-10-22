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
 a=doc['accessors'][index];dtype=np.dtype(dtypes[a['componentType']]);width=counts[a['type']]
 if 'bufferView' in a:
  v=doc['bufferViews'][a['bufferView']]
  result=np.ndarray((a['count'],width),dtype=dtype,buffer=binary,offset=v.get('byteOffset',0)+a.get('byteOffset',0),strides=(v.get('byteStride',width*dtype.itemsize),dtype.itemsize)).copy()
 else:
  result=np.zeros((a['count'],width),dtype=dtype)
 if 'sparse' in a:
  sparse=a['sparse'];indices=sparse['indices'];values=sparse['values'];iv=doc['bufferViews'][indices['bufferView']];vv=doc['bufferViews'][values['bufferView']]
  ids=np.frombuffer(binary,dtype=np.dtype(dtypes[indices['componentType']]),count=sparse['count'],offset=iv.get('byteOffset',0)+indices.get('byteOffset',0))
  assert len(ids)==0 or (int(ids[-1])<a['count'] and np.all(np.diff(ids.astype(np.int64))>0)),index
  replacements=np.ndarray((sparse['count'],width),dtype=dtype,buffer=binary,offset=vv.get('byteOffset',0)+values.get('byteOffset',0),strides=(vv.get('byteStride',width*dtype.itemsize),dtype.itemsize))
  result[ids]=replacements
 return result
for i,a in enumerate(doc['accessors']):assert np.isfinite(access(i)).all(),i
assert len(doc['skins'])>=1
skin=doc['skins'][0];weight_error=0;triangles=0;morph_names=set()
mesh_skins={node['mesh']:doc['skins'][node['skin']] for node in doc['nodes'] if 'mesh' in node and 'skin' in node}
for mi,m in enumerate(doc['meshes']):
 morph_names.update(m.get('extras',{}).get('targetNames',[]))
 for primitive in m['primitives']:
  attrs=primitive['attributes'];assert 'POSITION' in attrs
  if mi in mesh_skins:
   assert all(x in attrs for x in ['JOINTS_0','WEIGHTS_0'])
   w=access(attrs['WEIGHTS_0']);j=access(attrs['JOINTS_0']);weight_error=max(weight_error,float(abs(w.sum(axis=1)-1).max()))
   assert np.all(w>=0) and j.max()<len(mesh_skins[mi]['joints'])
  triangles+=doc['accessors'][primitive['indices']]['count']//3
assert weight_error<1e-5
assert {'lean','strong','veteran'}.issubset(morph_names),morph_names
expected={'Guard_Breath':6,'Shield_Brace':4,'Spear_Study':4};clips={}
for a in doc['animations']:
 end=0;endpoint_error=0;default_error=0
 for ch in a['channels']:
  s=a['samplers'][ch['sampler']];times=access(s['input']).ravel();values=access(s['output']);assert abs(times[0])<1e-7
  target=ch['target']
  if target['path']=='weights':values=values.reshape((len(times),-1))
  end=max(end,float(times[-1]));endpoint_error=max(endpoint_error,float(abs(values[0]-values[-1]).max()))
  if a['name']=='Guard_Breath':
   node=doc['nodes'][target['node']]
   fallback=doc['meshes'][node['mesh']].get('weights',[0]*values.shape[1]) if target['path']=='weights' else {'translation':[0,0,0],'rotation':[0,0,0,1],'scale':[1,1,1]}[target['path']]
   default_error=max(default_error,float(abs(np.array(node.get(target['path'],fallback))-values[0]).max()))
 assert abs(end-expected[a['name']])<1e-5 and endpoint_error<1e-5 and default_error<1e-7
 clips[a['name']]={'seconds':end,'endpoint_max_error':endpoint_error,'default_max_error':default_error}
assert set(clips)==set(expected)
# Independently import the exported result, including skinning and posed default nodes.
import bpy
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
# Bone display helpers are Blender UI objects, not meshes in the delivered GLB.
# Creating them adds a unit icosphere at the origin and corrupts scene bounds.
bpy.ops.import_scene.gltf(filepath=str(p),disable_bone_shape=True)
imported_meshes=[ob for ob in bpy.context.scene.objects if ob.type=='MESH']
exported_mesh_nodes=[node for node in doc['nodes'] if 'mesh' in node]
assert len(imported_meshes)==len(exported_mesh_nodes),(len(imported_meshes),len(exported_mesh_nodes))
deps=bpy.context.evaluated_depsgraph_get();points=[];catalog_points=[]
def default_visible(ob):
 while ob is not None:
  if ob.get('defaultVisible',True) is False or ob.get('defaultVisible',True)==0:return False
  ob=ob.parent
 return True
for ob in imported_meshes:
 ev=ob.evaluated_get(deps);me=ev.to_mesh();vertices=[tuple(ev.matrix_world@v.co) for v in me.vertices];catalog_points.extend(vertices)
 if default_visible(ob):points.extend(vertices)
 ev.to_mesh_clear()
points=np.array(points);lo=points.min(axis=0);hi=points.max(axis=0)
assert -.012<lo[2]<.04 and 2.35<hi[2]<3.0,(lo,hi)
catalog_points=np.array(catalog_points)
report={'status':'passed','sha256':hashlib.sha256(raw).hexdigest(),'glb_bytes':len(raw),'meshes':len(doc['meshes']),'material_primitives':sum(len(m['primitives']) for m in doc['meshes']),'triangles':triangles,'joints':len(skin['joints']),'weight_sum_max_error':weight_error,'morphTargets':sorted(morph_names),'clips':clips,'reimport_mesh_nodes':len(imported_meshes),'reimport_default_mesh_nodes':sum(default_visible(ob) for ob in imported_meshes),'reimport_bone_display_helpers':False,'reimport_bounds_z_up_metres':[lo.tolist(),hi.tolist()],'catalog_bounds_z_up_metres':[catalog_points.min(axis=0).tolist(),catalog_points.max(axis=0).tolist()],'scope':'File integrity; finite dense and sparse accessors; normalized weights; clip lengths, endpoints and default guard; posed Blender reimport with defaultVisible catalog selection and importer bone display helpers disabled. Not full collision, muscle, cloth or combat validation.'}
(ROOT/'assets/model-checks.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
