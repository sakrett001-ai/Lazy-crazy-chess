/** Finite intersections of rendered weapon surfaces with the active shield. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {createLoadout} from '../src/loadout.mjs';
import {runtimeSource} from './runtime-source.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),quick=process.argv.includes('--quick');
const output=process.env.PAWN_WEAPON_CLEARANCE_REPORT||path.join(root,'review',quick?'weapon-clearance-quick.json':'weapon-clearance-checks.json');
const hash=x=>createHash('sha256').update(x).digest('hex'),bytes=await readFile(path.join(root,'assets/white-pawn.glb'));
const sourceBytes=await runtimeSource(root),epsilon=1e-8;
const report={status:'running',glbSha256:hash(bytes),runtimeSha256:hash(sourceBytes),auditSha256:hash(await readFile(fileURLToPath(import.meta.url))),coverage:{sampleRateHz:10,weapons:['spear','sword'],shields:['tower','round','heater'],weaponMaterials:['weapon.metal','weapon.wood'],shieldMaterials:['shield.face','shield.wood','shield.trim'],bodyBuilds:['lean','regular','strong'],actions:['rest','Guard_Breath','Shield_Brace','Spear_Study'],frameCount:0,caseCount:0,quick},checks:[],cases:[],negativeControls:[],failures:[],scope:'Actual skinned triangle intersections between weapon.metal/weapon.wood surfaces and shield.face/shield.wood/shield.trim surfaces. Includes the physical rim and wooden rear bracing, excludes shield grip, leather enarmes and painted emblem. AABB broad phase followed by finite edge/triangle intersections; positive crossings are recorded in world coordinates. Tests lean, regular and strong physiques at10Hz plus the reported1.36s sword frame. This is not continuous collision detection, minimum-clearance certification, coplanar contact classification, inside-volume testing, whole-body collision or a physical combat simulation.'};
const check=(name,passed,details={})=>{report.checks.push({name,passed:!!passed,...details});if(!passed)report.failures.push(name);};
const V=()=>new THREE.Vector3(),Q=()=>new THREE.Quaternion(),norm=s=>String(s||'').replace(/[._\-\s]/g,'').toLowerCase();
const loader=new GLTFLoader();loader.register(()=>({name:'CPU_NO_TEXTURES',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
const gltf=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),''),model=gltf.scene,bones={},meshes=[];
model.traverse(o=>{if(o.isBone)bones[o.name]=o;if(o.isSkinnedMesh)meshes.push(o);});
const lookup=new Map(Object.entries(bones).map(([name,b])=>[norm(name),b])),bone=n=>lookup.get(norm(n));
const rest=Object.values(bones).map(b=>({b,p:b.position.clone(),q:b.quaternion.clone(),s:b.scale.clone()}));
const skeletons=[...new Set(meshes.map(m=>m.skeleton))];
function update(){model.updateMatrixWorld(true);for(const s of skeletons)s.update();}
function restore(){for(const {b,p,q,s}of rest){b.position.copy(p);b.quaternion.copy(q);b.scale.copy(s);}update();}
function tag(o,key){for(;o;o=o.parent)if(o.userData?.[key]!==undefined)return o.userData[key];}
const selected=(slot,variant,materials)=>meshes.filter(m=>tag(m,'equipmentSlot')===slot&&tag(m,'equipmentVariant')===variant&&materials.includes(m.material.name));
const topology=new Map(meshes.map(m=>{const g=m.geometry,count=g.index?g.index.count:g.attributes.position.count,faces=[];for(let i=0;i<count;i+=3)faces.push([0,1,2].map(j=>g.index?g.index.getX(i+j):i+j));return[m,faces];}));
const loadout=createLoadout({model,bones});
let mixer=null,clip=null;
function begin(weaponType,shieldType,bodyBuild,action){mixer?.stopAllAction();mixer?.uncacheRoot(model);mixer=null;restore();loadout.apply({weaponType,shieldType,bodyBuild,armorType:'plate'});clip=gltf.animations.find(c=>c.name===action)||null;return clip?.duration||0;}
function sample(action,time){mixer?.stopAllAction();mixer?.uncacheRoot(model);mixer=null;restore();if(clip){mixer=new THREE.AnimationMixer(model);const a=mixer.clipAction(clip);a.setLoop(THREE.LoopOnce,1);a.clampWhenFinished=true;a.play();mixer.setTime(time);}loadout.poseAt(action,time);update();}
function evaluated(mesh){
 const points=Array.from({length:mesh.geometry.attributes.position.count},(_,i)=>mesh.getVertexPosition(i,V()).applyMatrix4(mesh.matrixWorld));
 const faces=topology.get(mesh).map((ids,index)=>{const p=ids.map(i=>points[i]);return{mesh:mesh.name,index,p,box:new THREE.Box3().setFromPoints(p)};});
 return{mesh,faces,points,box:new THREE.Box3().setFromPoints(points)};
}
function crossings(a,b){
 const hits=[];
 for(const [edges,face]of[[a,b],[b,a]])for(let i=0;i<3;i++){
  const d=edges[(i+1)%3].clone().sub(edges[i]),length=d.length();if(length<=epsilon)continue;
  const hit=new THREE.Ray(edges[i],d.multiplyScalar(1/length)).intersectTriangle(...face,false,V());
  if(hit&&hit.distanceTo(edges[i])>epsilon&&hit.distanceTo(edges[i])<length-epsilon&&!hits.some(p=>p.distanceTo(hit)<epsilon))hits.push(hit);
 }
 return hits;
}
function measure(weaponType,shieldType){
 const weapon=selected('weapon',weaponType,report.coverage.weaponMaterials).map(evaluated),shield=selected('shield',shieldType,report.coverage.shieldMaterials).map(evaluated);
 const hits=[];let candidates=0,nonfinite=0,weaponTriangles=0,shieldTriangles=0;
 for(const part of [...weapon,...shield])for(const p of part.points)if(![p.x,p.y,p.z].every(Number.isFinite))nonfinite++;
 for(const w of weapon){weaponTriangles+=w.faces.length;for(const s of shield){if(!w.box.intersectsBox(s.box))continue;
  const shieldFaces=s.faces.filter(f=>f.box.intersectsBox(w.box));
  for(const a of w.faces){if(!a.box.intersectsBox(s.box))continue;for(const b of shieldFaces){if(!a.box.intersectsBox(b.box))continue;candidates++;const points=crossings(a.p,b.p);if(points.length)hits.push({weaponMesh:a.mesh,weaponTriangle:a.index,shieldMesh:b.mesh,shieldTriangle:b.index,pointsWorld:points.map(p=>p.toArray())});}}
 }}
 for(const s of shield)shieldTriangles+=s.faces.length;
 return{weaponTriangles,shieldTriangles,candidates,nonfinite,intersectionPairs:hits.length,intersections:hits.slice(0,12)};
}
function recordCase(weaponType,shieldType,bodyBuild,action,times){
 begin(weaponType,shieldType,bodyBuild,action);const id=[weaponType,shieldType,bodyBuild,action].join('/'),result={id,weaponType,shieldType,bodyBuild,action,samples:times.length,maximumIntersections:0,intersectingFrames:0,nonfinite:0,candidates:0,examples:[]};
 for(const time of times){sample(action,time);const m=measure(weaponType,shieldType);report.coverage.frameCount++;result.maximumIntersections=Math.max(result.maximumIntersections,m.intersectionPairs);result.nonfinite+=m.nonfinite;result.candidates+=m.candidates;result.weaponTriangles=m.weaponTriangles;result.shieldTriangles=m.shieldTriangles;if(m.intersectionPairs){result.intersectingFrames++;if(result.examples.length<3)result.examples.push({time,...m});}}
 report.cases.push(result);report.coverage.caseCount++;check(id+': weapon does not cross shield surfaces',result.maximumIntersections===0&&result.nonfinite===0&&result.weaponTriangles>0&&result.shieldTriangles>0,{samples:times.length,maximumIntersections:result.maximumIntersections,intersectingFrames:result.intersectingFrames});return result;
}
try{
 if(quick)for(const bodyBuild of report.coverage.bodyBuilds)recordCase('sword','round',bodyBuild,'Spear_Study',[1.36]);
 else for(const weaponType of report.coverage.weapons)for(const shieldType of report.coverage.shields)for(const bodyBuild of report.coverage.bodyBuilds)for(const action of report.coverage.actions){
  const duration=begin(weaponType,shieldType,bodyBuild,action),times=Array.from({length:Math.round(duration*10)+1},(_,i)=>Math.min(duration,i/10));if(action==='Spear_Study')times.push(1.36);times.sort((a,b)=>a-b);recordCase(weaponType,shieldType,bodyBuild,action,times);
 }
 // Move the actual imported right wrist, its skinned hand and rigidly bound
 // sword through a real face triangle; no virtual-cylinder substitution.
 begin('sword','round','regular','rest');sample('rest',0);
 const front=evaluated(selected('shield','round',['shield.face'])[0]);
 const face=front.faces.reduce((best,f)=>new THREE.Triangle(...f.p).getArea()>new THREE.Triangle(...best.p).getArea()?f:best);
 const triangle=new THREE.Triangle(...face.p),center=triangle.getMidpoint(V()),normal=triangle.getNormal(V());
 const before=measure('sword','round'),wrist=bone('wrist.R'),parent=wrist.parent,axis=V().fromArray(loadout.measure().axis),world=wrist.getWorldQuaternion(Q()),beforeWrist=wrist.getWorldPosition(V());
 wrist.quaternion.copy(parent.getWorldQuaternion(Q()).invert().multiply(Q().setFromUnitVectors(axis,normal)).multiply(world));update();
 const grip=V().fromArray(loadout.measure().weaponGripWorld.R),target=center.clone().addScaledVector(normal,-.30),currentWrist=wrist.getWorldPosition(V());
 wrist.position.copy(parent.worldToLocal(currentWrist.add(target.sub(grip))));update();
 const forced=measure('sword','round');
 const afterWrist=wrist.getWorldPosition(V());
 report.negativeControls.push({name:'Imported sword hand is moved through the actual shield face',passed:before.intersectionPairs===0&&forced.nonfinite===0&&forced.intersectionPairs>0&&afterWrist.distanceTo(beforeWrist)>.05,beforeIntersectionPairs:before.intersectionPairs,afterIntersectionPairs:forced.intersectionPairs,beforeWristWorld:beforeWrist.toArray(),afterWristWorld:afterWrist.toArray(),faceCenterWorld:center.toArray(),intersections:forced.intersections});
 if(report.negativeControls.some(c=>!c.passed))report.failures.push('Actual moved sword negative control');
 check('Audit source remains unchanged during the run',hash(await readFile(fileURLToPath(import.meta.url)))===report.auditSha256);
 check('Runtime source remains unchanged during the run',hash(await runtimeSource(root))===report.runtimeSha256);
 check('GLB remains unchanged during the run',hash(await readFile(path.join(root,'assets/white-pawn.glb')))===report.glbSha256);
 report.status=report.failures.length?'failed':'passed';
}catch(error){report.status='error';report.failure=error.stack;report.failures.push(error.message);}
finally{mixer?.stopAllAction();await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,coverage:report.coverage,failures:report.failures,cases:report.cases.map(c=>({id:c.id,max:c.maximumIntersections,frames:c.intersectingFrames})),negativeControls:report.negativeControls.map(c=>({name:c.name,passed:c.passed,afterIntersectionPairs:c.afterIntersectionPairs})),report:output},null,2));if(report.status!=='passed')process.exitCode=1;}
