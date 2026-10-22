/** Bounded audit of actual skinned/morphed garment patches and thumb surfaces. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import * as THREE from '../../human-base/node_modules/three/build/three.module.js';
import {GLTFLoader} from '../../human-base/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import {createLoadout} from '../src/loadout.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const input=path.resolve(process.env.PAWN_GLB||path.join(root,'assets/white-pawn.glb'));
const output=path.resolve(process.env.PAWN_GEOMETRY_REPORT||path.join(root,'review/geometry-checks.json'));
const bytes=await readFile(input),runtimeSource=await readFile(path.join(root,'src/loadout.mjs'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const limits={layerClearanceM:.0005,bindPairDistanceM:.045,thumbSurfaceDistanceM:.014,minimumRegionProbes:5};
const report={status:'running',glbSha256:hash(bytes),runtimeSha256:hash(runtimeSource),limits,cases:[],checks:[],failures:[],negativeControls:[],unassessed:[],scope:'Finite selected surface patches of padding against mail/plate, evaluated from actual exported triangles after skinning and morphs, plus nearest thumb-surface distance to actual selected handles. Pairing is fixed in the neutral bind pose independently of the measured clearance sign. This is not whole-body collision freedom, cloth simulation, thumb opposition, penetration volume, dynamic stability or a full animation sweep. Hidden torso skin is absent in this model and is not assessed.'};
const check=(name,passed,details={})=>{report.checks.push({name,passed:!!passed,...details});if(!passed)report.failures.push(name);};
const norm=value=>String(value||'').replace(/[._\-\s]/g,'').toLowerCase();
const loader=new GLTFLoader();
loader.register(()=>({name:'CPU_GEOMETRY_NO_TEXTURE_PIXELS',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
const gltf=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
const model=gltf.scene,meshes=[],bones={};
model.traverse(o=>{if(o.isMesh)meshes.push(o);if(o.isBone)bones[o.name]=o;});
const boneMap=new Map(Object.entries(bones).map(([name,bone])=>[norm(name),bone]));
const skeletons=[...new Set(meshes.filter(m=>m.isSkinnedMesh).map(m=>m.skeleton))];
const rest=Object.values(bones).map(b=>({b,p:b.position.clone(),q:b.quaternion.clone(),s:b.scale.clone()}));
function update(){model.updateMatrixWorld(true);skeletons.forEach(s=>s.update());}
function restore(){for(const {b,p,q,s}of rest){b.position.copy(p);b.quaternion.copy(q);b.scale.copy(s);}update();}
function tag(mesh,key){for(let o=mesh;o;o=o.parent)if(o.userData?.[key]!==undefined)return o.userData[key];return undefined;}
function selected(slot,variant,materials){return meshes.filter(m=>tag(m,'equipmentSlot')===slot&&(!variant||tag(m,'equipmentVariant')===variant)&&(!materials||materials.includes(m.material.name)));}
const materialMeshes=(slot,names)=>selected(slot,null,names);
const loadout=createLoadout({model,bones});
let sampler=null;
function sample(config,action,time){
 sampler?.stopAllAction();sampler?.uncacheRoot(model);sampler=null;restore();loadout.apply(config);
 if(action!=='rest'){
  const clip=gltf.animations.find(c=>c.name===action);if(!clip)throw Error('Missing clip '+action);
  sampler=new THREE.AnimationMixer(model);const a=sampler.clipAction(clip);a.setLoop(THREE.LoopOnce,1);a.clampWhenFinished=true;a.play();sampler.setTime(time);
 }
 loadout.poseAt(action,time);update();
}
const V=()=>new THREE.Vector3(),triangle=new THREE.Triangle(),near=V();
function vertex(mesh,index){return mesh.getVertexPosition(index,V()).applyMatrix4(mesh.matrixWorld);}
function triangleIndices(mesh){const g=mesh.geometry,count=g.index?g.index.count:g.attributes.position.count;const result=[];for(let i=0;i<count;i+=3)result.push(g.index?[g.index.getX(i),g.index.getX(i+1),g.index.getX(i+2)]:[i,i+1,i+2]);return result;}
const topology=new Map(meshes.map(mesh=>[mesh,triangleIndices(mesh)]));
function evaluated(meshList){return meshList.flatMap(mesh=>{
 const positions=Array.from({length:mesh.geometry.attributes.position.count},(_,i)=>vertex(mesh,i));
 return topology.get(mesh).map((ids,index)=>{
  const p=ids.map(i=>positions[i]),tri=new THREE.Triangle(...p),center=tri.getMidpoint(V()),normal=tri.getNormal(V());
  return{mesh,index,ids,p,center,normal,area:tri.getArea(),radius:Math.max(...p.map(x=>x.distanceTo(center)))};
 });});}
function bonePoint(name){const b=boneMap.get(norm(name));return b?.getWorldPosition(V());}
const segments=[['torso','spine05','neck01'],['armL','upperarm01.L','lowerarm01.L'],['armL','lowerarm01.L','wrist.L'],['armR','upperarm01.R','lowerarm01.R'],['armR','lowerarm01.R','wrist.R'],['hipL','upperleg01.L','lowerleg01.L'],['hipR','upperleg01.R','lowerleg01.R']];
function regionOf(face){
 // Sample fabric-covered torso, upper arms and hip skirt, away from hems,
 // palms and the open collar. Normals select the real outside padding wall.
 const p=face.center;if(p.y<.88||p.y>1.49)return null;
 let best=null;
 for(const [region,start,end]of segments){
  const a=bonePoint(start),b=bonePoint(end);if(!a||!b)continue;
  const axis=b.clone().sub(a),t=THREE.MathUtils.clamp(p.clone().sub(a).dot(axis)/axis.lengthSq(),0,1),center=a.addScaledVector(axis,t),radial=p.clone().sub(center),distance=radial.length();
  if(face.normal.dot(radial.normalize())<.3)continue;
  if((region.startsWith('hip')&&p.y>1.1)||(region==='torso'&&p.y<1.12))continue;
  if(!best||distance<best.distance)best={region,distance};
 }
 return best?.region||null;
}
function pairPatches(innerFaces,outerFaces,label){
 const byRegion=new Map();
 for(const face of innerFaces){if(face.area<1e-8)continue;const region=regionOf(face);if(region){if(!byRegion.has(region))byRegion.set(region,[]);byRegion.get(region).push(face);}}
 const result=[];
 for(const [region,faces]of byRegion){
  const attempts=48,chosen=new Set();let missing=0;
  for(let n=0;n<attempts;n++){
   const inner=faces[Math.min(faces.length-1,Math.floor((n+.5)*faces.length/attempts))];
   if(chosen.has(inner))continue;chosen.add(inner);
   let best=null;
   for(const outer of outerFaces){
    // A thick outer garment's inner-facing triangle is the physical boundary.
    if(outer.area<1e-8||outer.normal.dot(inner.normal)>-.15)continue;
    if(outer.center.distanceToSquared(inner.center)>(limits.bindPairDistanceM+outer.radius)**2)continue;
    triangle.set(...outer.p);triangle.closestPointToPoint(inner.center,near);
    const distance=near.distanceTo(inner.center);
    if(distance>limits.bindPairDistanceM||best&&distance>=best.distance)continue;
    const bary=triangle.getBarycoord(near,V());
    // Reject boundary matches to nearby holes/hems rather than invent a gap.
    if(Math.min(bary.x,bary.y,bary.z)<.002)continue;
    best={outer,distance,bary:bary.toArray()};
   }
   if(!best){missing++;continue;}
   result.push({label,region,inner:{mesh:inner.mesh,index:inner.index,ids:inner.ids},outer:{mesh:best.outer.mesh,index:best.outer.index,ids:best.outer.ids},bary:best.bary,bindDistanceM:best.distance});
  }
  report.unassessed.push({layer:label,region,unpairedAttemptedPatches:missing,reason:'No interior facing local patch within45mm; no clearance conclusion for this patch.'});
 }
 return result;
}
function posedPatch(pair){
 const p=pair.inner.ids.map(i=>vertex(pair.inner.mesh,i)),q=pair.outer.ids.map(i=>vertex(pair.outer.mesh,i));
 const tri=new THREE.Triangle(...p),center=tri.getMidpoint(V()),normal=tri.getNormal(V());
 const outer=q[0].clone().multiplyScalar(pair.bary[0]).addScaledVector(q[1],pair.bary[1]).addScaledVector(q[2],pair.bary[2]);
 return{clearanceM:outer.clone().sub(center).dot(normal),normal,center,outer};
}
function patchId(pair){return{layer:pair.label,region:pair.region,innerMesh:pair.inner.mesh.name,innerTriangle:pair.inner.index,outerMesh:pair.outer.mesh.name,outerTriangle:pair.outer.index,barycentric:pair.bary};}
function thumbRefs(side){
 const result=[];
 for(const mesh of meshes.filter(m=>m.isSkinnedMesh&&m.material.name==='skin')){
  const g=mesh.geometry;
  for(let i=0;i<g.attributes.position.count;i++){
   let weight=0;for(let k=0;k<4;k++){const b=mesh.skeleton.bones[g.attributes.skinIndex.getComponent(i,k)];if(norm(b?.name).startsWith('finger1')&&norm(b?.name).endsWith(side.toLowerCase()))weight+=g.attributes.skinWeight.getComponent(i,k);}
   if(weight>.55)result.push({mesh,index:i});
  }
 }
 return result;
}
function thumbContact(refs,handleMeshes){
 const faces=evaluated(handleMeshes);let min=Infinity,best=null;
 for(const ref of refs){const p=vertex(ref.mesh,ref.index);for(const face of faces){if(p.distanceTo(face.center)-face.radius>min)continue;triangle.set(...face.p);triangle.closestPointToPoint(p,near);const d=near.distanceTo(p);if(d<min){min=d;best={thumbMesh:ref.mesh.name,thumbVertex:ref.index,handleMesh:face.mesh.name,handleTriangle:face.index,thumbWorld:p.toArray(),handleWorld:near.toArray()};}}}
 return{distanceM:min,...best,scope:'Nearest actual thumb vertex to handle triangle; establishes reach only, not complete opposition or absence of penetration.'};
}
function worldToPosition(mesh,index,world){
 const m=new THREE.Matrix4();if(mesh.isSkinnedMesh){const skin=new THREE.Matrix4();skin.elements.fill(0);const g=mesh.geometry;
  for(let k=0;k<4;k++){const b=g.attributes.skinIndex.getComponent(index,k),w=g.attributes.skinWeight.getComponent(index,k);const bm=new THREE.Matrix4().multiplyMatrices(mesh.skeleton.bones[b].matrixWorld,mesh.skeleton.boneInverses[b]);for(let j=0;j<16;j++)skin.elements[j]+=bm.elements[j]*w;}
  m.copy(mesh.matrixWorld).multiply(mesh.bindMatrixInverse).multiply(skin).multiply(mesh.bindMatrix);
 }else m.copy(mesh.matrixWorld);
 return world.clone().applyMatrix4(m.invert());
}
const configs=[
 {id:'plate-rest',armorType:'plate',weaponType:'spear',shieldType:'tower',action:'rest',time:0},
 {id:'mail-brace',armorType:'mail',weaponType:'spear',shieldType:'tower',action:'Shield_Brace',time:1.65},
 {id:'mail-sword',armorType:'mail',weaponType:'sword',shieldType:'round',action:'Spear_Study',time:1.9},
 {id:'padded-rest',armorType:'padded',weaponType:'sword',shieldType:'heater',action:'rest',time:0},
 {id:'mail-pike',armorType:'mail',weaponType:'pike',shieldType:'none',action:'Spear_Study',time:1.9},
 {id:'plate-greatsword',armorType:'plate',weaponType:'greatsword',shieldType:'none',action:'Spear_Study',time:1.9}
];
try{
 sample({armorType:'mail',weaponType:'spear',shieldType:'tower',bodyBuild:'regular'},'rest',0);
 const padding=materialMeshes('padding',['padding']),mail=materialMeshes('mail',['mail']),plate=materialMeshes('plate',['armor.main','armor.trim']);
 check('Required physical layer meshes exist',padding.length>0&&mail.length>0&&plate.length>0,{padding:padding.length,mail:mail.length,plate:plate.length});
 const inner=evaluated(padding),pairs={mail:pairPatches(inner,evaluated(mail),'padding/mail'),plate:pairPatches(inner,evaluated(plate),'padding/plate')};
 for(const [layer,list]of Object.entries(pairs)){
  const counts=Object.fromEntries(['torso','armL','armR','hipL','hipR'].map(region=>[region,list.filter(p=>p.region===region).length]));
  check(layer+': local bind patch coverage',counts.torso>=limits.minimumRegionProbes&&list.length>=20,{count:list.length,regions:counts});
 }
 const thumbs=Object.fromEntries(['L','R'].map(side=>[side,thumbRefs(side)]));
 check('Thumb skin vertices exist on both hands',thumbs.L.length>10&&thumbs.R.length>10,{L:thumbs.L.length,R:thumbs.R.length});
 for(const bodyBuild of ['lean','regular','strong'])for(const config of configs){
  sample({...config,bodyBuild,experience:'recruit',helmet:'on',beard:'none'},config.action,config.time);
  const id=bodyBuild+'/'+config.id,caseResult={id,bodyBuild,...config,layers:[],thumbs:[]};
  const active=config.armorType==='mail'?pairs.mail:config.armorType==='plate'?pairs.plate:[];
  if(active.length){
   const results=active.map(pair=>({pair,...posedPatch(pair)}));
   const worst=results.reduce((a,b)=>a.clearanceM<b.clearanceM?a:b);
   check(id+': sampled physical layer separation',results.every(r=>Number.isFinite(r.clearanceM)&&r.clearanceM>=limits.layerClearanceM),{probes:results.length,minClearanceM:worst.clearanceM,worst:patchId(worst.pair)});
   caseResult.layers.push({probes:results.length,minClearanceM:worst.clearanceM,worst:patchId(worst.pair)});
  }
  const state=loadout.summary();
  for(const side of ['R','L']){
   const weaponHand=side==='R'||state.twoHanded;
   if(!weaponHand&&state.effectiveShield==='none')continue;
   const handles=weaponHand?selected('weapon',state.weaponType,['weapon.grip','weapon.wood']):selected('shield',state.effectiveShield,['shield.leather','shield.wood']);
   const contact=thumbContact(thumbs[side],handles);
   check(id+': '+side+' thumb reaches actual handle',Number.isFinite(contact.distanceM)&&contact.distanceM<=limits.thumbSurfaceDistanceM,{...contact});
   caseResult.thumbs.push({side,...contact});
  }
  report.cases.push(caseResult);console.log('GEOMETRY_CASE',id);
 }
 // Negative controls change the exported POSITION attributes, then reskin them.
 sample({armorType:'mail',weaponType:'spear',shieldType:'tower',bodyBuild:'regular'},'rest',0);
 const pair=pairs.mail.find(p=>p.region==='torso');if(!pair)throw Error('No torso patch for negative control');
 const before=posedPatch(pair),attribute=pair.outer.mesh.geometry.attributes.position;
 const saved=pair.outer.ids.map(i=>[i,attribute.getX(i),attribute.getY(i),attribute.getZ(i)]);
 for(const i of pair.outer.ids){const p=worldToPosition(pair.outer.mesh,i,vertex(pair.outer.mesh,i).addScaledVector(before.normal,-.06));attribute.setXYZ(i,p.x,p.y,p.z);}attribute.needsUpdate=true;
 const changed=posedPatch(pair);for(const [i,x,y,z]of saved)attribute.setXYZ(i,x,y,z);attribute.needsUpdate=true;
 report.negativeControls.push({name:'Move actual mail triangle inward60mm',passed:changed.clearanceM<0,beforeM:before.clearanceM,afterM:changed.clearanceM,patch:patchId(pair)});
 for(const control of report.negativeControls)check('Negative control: '+control.name,control.passed,control);
 report.status=report.failures.length?'failed':'passed';
}catch(error){report.status='error';report.failure=error.stack;}
finally{
 sampler?.stopAllAction();sampler?.uncacheRoot(model);loadout.dispose();
 await writeFile(output,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({status:report.status,glbSha256:report.glbSha256,runtimeSha256:report.runtimeSha256,cases:report.cases.length,checks:report.checks.length,failures:report.failures,failure:report.failure,output},null,2));
 if(report.status!=='passed')process.exitCode=1;
}
