/** Bounded audit of actual skinned/morphed garment patches and thumb surfaces. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import * as THREE from '../../human-base/node_modules/three/build/three.module.js';
import {GLTFLoader} from '../../human-base/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import {createLoadout} from '../src/loadout.mjs';
import {runtimeSource} from './runtime-source.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const input=path.resolve(process.env.PAWN_GLB||path.join(root,'assets/white-pawn.glb'));
const output=path.resolve(process.env.PAWN_GEOMETRY_REPORT||path.join(root,'review/geometry-checks.json'));
const bytes=await readFile(input),runtimeBytes=await runtimeSource(root);
const hash=value=>createHash('sha256').update(value).digest('hex');
const limits={layerClearanceM:.0005,bindPairDistanceM:.045,thumbSurfaceDistanceM:.014,handFrameErrorM:.01,soleDriftM:.006,soleFloorGapM:.008,minimumRegionProbes:5,minimumAnatomicalWeight:.5,radialNormalAlignment:.3,maximumAxialNormalAlignment:.7,intersectionEpsilonM:1e-8};
const report={status:'running',glbSha256:hash(bytes),runtimeSha256:hash(runtimeBytes),auditSha256:hash(await readFile(fileURLToPath(import.meta.url))),limits,cases:[],checks:[],failures:[],negativeControls:[],unassessed:[],scope:'Finite intersection gate for selected padding triangles against actual active mail/plate triangles, evaluated after skinning and morphs. Exported skin weights and bind-space radial/axial normals select garment walls; hems, steep folds, ambiguous anatomy and unmatched patches remain unassessed. Pairing and source patches are fixed from undeformed POSITION and inverse-bind joints independently of the measured gap. Signed tracked gaps are diagnostics: negative values without an actual intersection are inconclusive for layer ordering because patches can slide or fold. Thumb tests establish nearest surface reach only. This is not whole-body collision freedom, all-surface clearance, continuous collision detection, cloth simulation, thumb opposition, penetration volume, dynamic stability or a full animation sweep. Hidden torso skin is absent in this model and is not assessed.'};
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
function evaluated(meshList,bindSpace=false){return meshList.flatMap(mesh=>{
 const positions=Array.from({length:mesh.geometry.attributes.position.count},(_,i)=>bindSpace?V().fromBufferAttribute(mesh.geometry.attributes.position,i).applyMatrix4(mesh.matrixWorld):vertex(mesh,i));
 return topology.get(mesh).map((ids,index)=>{
  const p=ids.map(i=>positions[i]),tri=new THREE.Triangle(...p),center=tri.getMidpoint(V()),normal=tri.getNormal(V());
  return{mesh,index,ids,p,center,normal,area:tri.getArea(),radius:Math.max(...p.map(x=>x.distanceTo(center)))};
 });});}
function bonePoint(name){const b=boneMap.get(norm(name));return b?.getWorldPosition(V());}
function bindBonePoint(name){
 for(const mesh of meshes.filter(m=>m.isSkinnedMesh)){
  const i=mesh.skeleton.bones.findIndex(b=>norm(b.name)===norm(name));
  if(i>=0)return V().setFromMatrixPosition(mesh.skeleton.boneInverses[i].clone().invert()).applyMatrix4(mesh.bindMatrixInverse).applyMatrix4(mesh.matrixWorld);
 }return null;
}
const segments=[['torso','spine05','neck01'],['armL','upperarm01.L','lowerarm01.L'],['armL','lowerarm01.L','wrist.L'],['armR','upperarm01.R','lowerarm01.R'],['armR','lowerarm01.R','wrist.R'],['hipL','upperleg01.L','lowerleg01.L'],['hipR','upperleg01.R','lowerleg01.R']];
let regionSegments=null;
function anatomicalPatch(face){
 // Bent arms can pass nearer a chest surface than the spine does. Classify
 // anatomy from exported skin weights before choosing a medial axis; nearest
 // bone alone can mistake the inward torso wall for an outward arm wall.
 // Use undeformed bind-space geometry: an articulated elbow fold can reverse
 // a local radial direction, while the authored inner/outer wall identity stays fixed.
 const p=face.center;if(p.y<.88||p.y>1.49)return{reason:'outside-height-domain'};
 const weights={torso:0,armL:0,armR:0,hipL:0,hipR:0},g=face.mesh.geometry;let total=0;
 if(!face.mesh.isSkinnedMesh)return{reason:'no-exported-skin-weights'};
 for(const i of face.ids)for(let k=0;k<4;k++){
  const name=norm(face.mesh.skeleton.bones[g.attributes.skinIndex.getComponent(i,k)]?.name),weight=g.attributes.skinWeight.getComponent(i,k);total+=weight;
  const side=name.endsWith('l')?'L':name.endsWith('r')?'R':null;
  const group=side&&/^(upperarm|lowerarm|wrist|hand|finger)/.test(name)?'arm'+side:side&&/^(pelvis|upperleg|lowerleg|foot)/.test(name)?'hip'+side:/^(spine|breast|neck|clavicle|head)/.test(name)?'torso':null;
  if(group)weights[group]+=weight;
 }
 const [region,weight]=Object.entries(weights).sort((a,b)=>b[1]-a[1])[0];
 if(!total||weight/total<=limits.minimumAnatomicalWeight)return{reason:'ambiguous-or-unrecognized-anatomical-weights',weights,total};
 if((region.startsWith('hip')&&p.y>1.1)||(region==='torso'&&p.y<1.12))return{reason:'outside-region-height-domain',region};
 regionSegments??=segments.map(([region,start,end])=>[region,bindBonePoint(start),bindBonePoint(end)]);
 let best=null;
 for(const [group,a,b]of regionSegments){
  if(group!==region||!a||!b)continue;
  const axis=b.clone().sub(a).normalize(),t=p.clone().sub(a).dot(axis),radial=p.clone().sub(a).addScaledVector(axis,-t),distance=radial.length();
  if(!best||distance<best.distance)best={region,distance,outward:face.normal.dot(radial.normalize()),axial:Math.abs(face.normal.dot(axis)),anatomicalWeight:weight/total};
 }
 if(!best)return{reason:'missing-anatomical-axis',region};
 if(best.axial>=limits.maximumAxialNormalAlignment)return{...best,reason:'axial-hem-or-steep-fold'};
 return best;
}
function classifyWall(face){
 if(face.anatomical===undefined)face.anatomical=anatomicalPatch(face);
 const a=face.anatomical;
 return a.reason?a.reason:a.outward>=limits.radialNormalAlignment?'outward-wall':a.outward<=-limits.radialNormalAlignment?'inward-wall':'tangential-wall';
}
function selectionSummary(faces){
 const result={};for(const face of faces){const reason=classifyWall(face);result[reason]??={faces:0,areaM2:0};result[reason].faces++;result[reason].areaM2+=face.area;}return result;
}
function regionOf(face){return classifyWall(face)==='outward-wall'?face.anatomical.region:null;}
function pairPatches(innerFaces,outerFaces,label){
 report.selectionDomains??=[];report.selectionDomains.push({layer:label,padding:selectionSummary(innerFaces),outerGarment:selectionSummary(outerFaces),scope:'Wall/region classification is independent of signed clearance. Excluded faces and unmatched attempts carry no separation conclusion.'});
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
    if(classifyWall(outer)!=='inward-wall'||outer.anatomical.region!==region)continue;
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
  report.unassessed.push({layer:label,region,unpairedAttemptedPatches:missing,reason:'No interior facing same-anatomy wall patch within45mm; includes region seams, joint-weight differences, holes and hems. No clearance conclusion for this patch.'});
 }
 return result;
}
function posedPatch(pair){
 const p=pair.inner.ids.map(i=>vertex(pair.inner.mesh,i)),q=pair.outer.ids.map(i=>vertex(pair.outer.mesh,i));
 const tri=new THREE.Triangle(...p),center=tri.getMidpoint(V()),normal=tri.getNormal(V());
 const outer=q[0].clone().multiplyScalar(pair.bary[0]).addScaledVector(q[1],pair.bary[1]).addScaledVector(q[2],pair.bary[2]);
 const delta=outer.clone().sub(center),clearanceM=delta.dot(normal);
 return{clearanceM,lateralDistanceM:delta.clone().addScaledVector(normal,-clearanceM).length(),normal,center,outer,p,radius:Math.max(...p.map(point=>point.distanceTo(center)))};
}
function triangleIntersectionPoints(p,q){
 const epsilon=limits.intersectionEpsilonM,hits=[];
 const add=point=>{if(!hits.some(hit=>hit.distanceToSquared(point)<=epsilon*epsilon))hits.push(point.clone());};
 for(const [a,b]of[[p,q],[q,p]])for(let i=0;i<3;i++){
  const start=a[i],delta=a[(i+1)%3].clone().sub(start),length=delta.length();if(length<=epsilon)continue;
  const ray=new THREE.Ray(start,delta.multiplyScalar(1/length)),hit=ray.intersectTriangle(...b,false,V());
  if(hit&&hit.distanceTo(start)<=length+epsilon)add(hit);
 }
 // Ray/triangle intersection excludes parallel rays. Handle coplanar overlap
 // explicitly so the gate also detects coincident exported surfaces.
 const normal=new THREE.Triangle(...p).getNormal(V());
 if(normal.lengthSq()&&q.every(point=>Math.abs(point.clone().sub(p[0]).dot(normal))<=epsilon)){
  for(const [a,b]of[[p,q],[q,p]])for(const point of a){
   const bary=new THREE.Triangle(...b).getBarycoord(point,V());if(bary&&Math.min(bary.x,bary.y,bary.z)>=-1e-8)add(point);
  }
  const drop=[Math.abs(normal.x),Math.abs(normal.y),Math.abs(normal.z)].indexOf(Math.max(Math.abs(normal.x),Math.abs(normal.y),Math.abs(normal.z))),axes=[0,1,2].filter(i=>i!==drop),cross=(a,b)=>a[0]*b[1]-a[1]*b[0];
  for(let i=0;i<3;i++)for(let j=0;j<3;j++){
   const a=p[i],b=p[(i+1)%3],c=q[j],d=q[(j+1)%3],ab=axes.map(k=>b.getComponent(k)-a.getComponent(k)),cd=axes.map(k=>d.getComponent(k)-c.getComponent(k)),ac=axes.map(k=>c.getComponent(k)-a.getComponent(k)),den=cross(ab,cd);
   if(Math.abs(den)<=epsilon*epsilon)continue;const t=cross(ac,cd)/den,u=cross(ac,ab)/den;
   if(t>=-1e-8&&t<=1+1e-8&&u>=-1e-8&&u<=1+1e-8)add(a.clone().lerp(b,THREE.MathUtils.clamp(t,0,1)));
  }
 }
 return hits;
}
function localSurfaceDiagnostic(result,outerFaces){
 const intersections=[];let nearest={distanceM:Infinity};
 for(const face of outerFaces){
  if(face.area<1e-12)continue;const centerDistance=result.center.distanceTo(face.center);
  if(centerDistance<=result.radius+face.radius+limits.intersectionEpsilonM){
   const points=triangleIntersectionPoints(result.p,face.p);if(points.length)intersections.push({mesh:face.mesh.name,triangle:face.index,pointsWorld:points.map(p=>p.toArray())});
  }
  if(centerDistance-face.radius>nearest.distanceM)continue;
  triangle.set(...face.p);triangle.closestPointToPoint(result.center,near);const distanceM=near.distanceTo(result.center);
  if(distanceM<nearest.distanceM)nearest={distanceM,mesh:face.mesh.name,triangle:face.index,pointWorld:near.toArray()};
 }
 return{intersections,nearestPaddingCenterToSurface:nearest};
}
function posedDetails(result){return{...patchId(result.pair),paddingWorld:result.center.toArray(),outerWallWorld:result.outer.toArray(),paddingNormal:result.normal.toArray(),lateralDistanceM:result.lateralDistanceM,bindDistanceM:result.pair.bindDistanceM};}
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
function soleRefs(side){
 const refs=[];
 for(const mesh of meshes.filter(m=>m.isSkinnedMesh&&tag(m,'equipmentSlot')==='base')){
  const g=mesh.geometry;
  for(let i=0;i<g.attributes.position.count;i++){
   let w=0;for(let k=0;k<4;k++){const b=mesh.skeleton.bones[g.attributes.skinIndex.getComponent(i,k)];if(norm(b?.name)===norm('foot.'+side))w+=g.attributes.skinWeight.getComponent(i,k);}
   if(w>.95)refs.push({mesh,index:i});
  }
 }
 const floor=Math.min(...refs.map(r=>vertex(r.mesh,r.index).y));
 return refs.filter(r=>vertex(r.mesh,r.index).y<floor+.006);
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
 const identity=new THREE.Matrix4().elements,identityFrame=matrix=>matrix.elements.every((value,i)=>Math.abs(value-identity[i])<1e-6);
 check('Layer meshes use the audited identity bind/world frame',[...padding,...mail,...plate].every(mesh=>mesh.isSkinnedMesh&&[mesh.matrixWorld,mesh.bindMatrix,mesh.bindMatrixInverse].every(identityFrame)),{scope:'The current exported bind POSITION and inverse-bind joint origins must share an identity frame; transformed assets require adapted pairing.'});
 const inner=evaluated(padding,true),pairs={mail:pairPatches(inner,evaluated(mail,true),'padding/mail'),plate:pairPatches(inner,evaluated(plate,true),'padding/plate')};
 for(const [layer,list]of Object.entries(pairs)){
  const counts=Object.fromEntries(['torso','armL','armR','hipL','hipR'].map(region=>[region,list.filter(p=>p.region===region).length]));
  check(layer+': local bind patch coverage',Object.values(counts).every(count=>count>=limits.minimumRegionProbes),{count:list.length,regions:counts});
 }
 const thumbs=Object.fromEntries(['L','R'].map(side=>[side,thumbRefs(side)]));
 check('Thumb skin vertices exist on both hands',thumbs.L.length>10&&thumbs.R.length>10,{L:thumbs.L.length,R:thumbs.R.length});
 const soles=Object.fromEntries(['L','R'].map(side=>[side,soleRefs(side)]));
 const planted=Object.fromEntries(['L','R'].map(side=>[side,soles[side].map(r=>vertex(r.mesh,r.index))]));
 check('Actual sole surfaces exist',soles.L.length>10&&soles.R.length>10,{L:soles.L.length,R:soles.R.length});
 for(const bodyBuild of ['lean','regular','strong'])for(const config of configs){
  sample({...config,bodyBuild,experience:'recruit',helmet:'on',beard:'none'},config.action,config.time);
  const id=bodyBuild+'/'+config.id,caseResult={...config,id,bodyBuild,layers:[],thumbs:[]};
  const active=config.armorType==='mail'?pairs.mail:config.armorType==='plate'?pairs.plate:[];
  if(active.length){
   const results=active.map(pair=>({pair,...posedPatch(pair)})),outerFaces=evaluated(config.armorType==='mail'?mail:plate);
   const finitePoints=points=>points.every(point=>point.toArray().every(Number.isFinite)),outerValidation={nonfiniteTriangles:outerFaces.filter(face=>!finitePoints(face.p)||!Number.isFinite(face.area)).length,unassessedDegenerateTriangles:outerFaces.filter(face=>Number.isFinite(face.area)&&face.area<1e-12).length};
   const worst=results.reduce((a,b)=>a.clearanceM<b.clearanceM?a:b),intersectionPatches=[],inconclusivePatches=[],invalidSourcePatches=[];
   for(const result of results){
    if(!finitePoints(result.p)||new THREE.Triangle(...result.p).getArea()<1e-12){invalidSourcePatches.push({...posedDetails(result),reason:'Nonfinite or degenerate posed source triangle cannot support the intersection gate.'});continue;}
    const diagnostic=localSurfaceDiagnostic(result,outerFaces);
    if(diagnostic.intersections.length)intersectionPatches.push({...posedDetails(result),trackedGapM:result.clearanceM,...diagnostic});
    else if(!Number.isFinite(result.clearanceM)||result.clearanceM<limits.layerClearanceM)inconclusivePatches.push({...posedDetails(result),trackedGapM:result.clearanceM,...diagnostic,reason:'Tracked gap does not establish layer ordering after sliding/folding; actual sampled triangle has no detected intersection.'});
   }
   check(id+': sampled garment triangles do not intersect',intersectionPatches.length===0&&invalidSourcePatches.length===0&&outerValidation.nonfiniteTriangles===0,{probes:results.length,invalidSourcePatches:invalidSourcePatches.length,outerValidation,intersectingPaddingTriangles:intersectionPatches.length,inconclusiveTrackedPatches:inconclusivePatches.length,minTrackedGapM:worst.clearanceM,worstTrackedPatch:posedDetails(worst)});
   caseResult.layers.push({probes:results.length,minTrackedGapM:worst.clearanceM,worstTrackedPatch:posedDetails(worst),intersectionPatches,inconclusivePatches,invalidSourcePatches,outerValidation});
  }
  const state=loadout.summary();
  const frame=loadout.measure();
  check(id+': hand attachment frames meet targets',frame.rightGripErrorM<=limits.handFrameErrorM&&(!state.twoHanded||frame.leftGripErrorM<=limits.handFrameErrorM),{rightM:frame.rightGripErrorM,leftM:frame.leftGripErrorM,reachErrors:frame.reachErrors});
  for(const side of ['L','R']){
   const positions=soles[side].map(r=>vertex(r.mesh,r.index)),drift=Math.max(...positions.map((p,i)=>p.distanceTo(planted[side][i]))),floor=Math.min(...positions.map(p=>p.y));
   check(id+': '+side+' actual sole stays planted',drift<=limits.soleDriftM&&floor>=-.004&&floor<=limits.soleFloorGapM,{maxDriftM:drift,minYM:floor});
  }
  for(const side of ['R','L']){
   const weaponHand=side==='R'||state.twoHanded;
   if(!weaponHand&&state.effectiveShield==='none')continue;
   const handles=weaponHand?selected('weapon',state.weaponType,['weapon.grip','weapon.wood']):selected('shield',state.effectiveShield,['shield.leather']);
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
 // Move a real exported outer triangle across the selected padding triangle.
 // Two vertices straddle the padding plane; their connecting edge crosses the
 // triangle centroid, giving a geometric intersection independent of gap sign.
 const source=pair.inner.ids.map(i=>vertex(pair.inner.mesh,i)),center=new THREE.Triangle(...source).getMidpoint(V()),normal=new THREE.Triangle(...source).getNormal(V()),crossing=[center.clone().addScaledVector(normal,-.005),center.clone().addScaledVector(normal,.005),source[0].clone().lerp(source[1],.5)];
 for(let j=0;j<3;j++){const local=worldToPosition(pair.outer.mesh,pair.outer.ids[j],crossing[j]);attribute.setXYZ(pair.outer.ids[j],local.x,local.y,local.z);}attribute.needsUpdate=true;
 const controlOuter=pair.outer.ids.map(i=>vertex(pair.outer.mesh,i)),intersectionPoints=triangleIntersectionPoints(source,controlOuter);
 for(const [i,x,y,z]of saved)attribute.setXYZ(i,x,y,z);attribute.needsUpdate=true;
 report.negativeControls.push({name:'Move actual mail triangle across padding triangle',passed:intersectionPoints.length>0,intersectionPointsWorld:intersectionPoints.map(p=>p.toArray()),patch:patchId(pair)});
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
