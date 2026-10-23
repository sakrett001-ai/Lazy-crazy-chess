/** Actual skinned grip surfaces against the active equipment's bind metadata. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {createLoadout} from '../src/loadout.mjs';
import {runtimeSource} from './runtime-source.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),output=process.env.PAWN_GRIP_REPORT||path.join(root,'review/grip-checks.json');
const hash=x=>createHash('sha256').update(x).digest('hex'),bytes=await readFile(path.join(root,'assets/white-pawn.glb'));
const limits={minimumPatchVertices:50,maximumContactGapM:.0045,maximumContactQ10GapM:.0085,minimumSurfaceGapM:-.00025,minimumFingerWrapDeg:65,minimumThumbOppositionDeg:75,minimumPipDeg:34.5,maximumPipDeg:110,minimumDipDeg:10,maximumDipDeg:80,maximumDipAheadOfPipDeg:5,maximumMetacarpalLengthErrorM:1e-7,minimumPadVertices:20,maximumPadGapM:.002,maximumPadQ10GapM:.003,maximumPadMedianGapM:.0045,maximumTipGapM:.0055,maximumTipQ10GapM:.009,maximumTipOutward:-.1};
const report={status:'running',date:new Date().toISOString(),glbSha256:hash(bytes),runtimeSha256:hash(await runtimeSource(root)),auditSha256:hash(await readFile(fileURLToPath(import.meta.url))),limits,coverage:{weapons:['spear','sword','pike','greatsword'],sides:['L','R'],shields:['tower','round','heater'],radiiM:[.014,.016],frameCount:0,bodyBuilds:['lean','regular','strong']},scope:'Dominant-weight skin vertices of all five fingers and three phalanges on both hands, measured against actual equipment attachment cylinders. Fixed source-local distal palmar pads, terminal caps, inward terminal direction, metacarpal lengths, contact spread, thumb opposition and circumferential wrap are checked over sampled full motion intervals and reverse seeks. Selected thumb-vs-hand triangles and cylinder surface triangles receive a separate finite check. This does not assert whole-body collision freedom, contact forces, grasp strength, or unsampled continuous collision freedom.',checks:[],negativeControls:[],cases:[],surfaceCases:[],failures:[]};
const check=(name,passed,details={})=>{report.checks.push({name,passed:!!passed,...details});if(!passed)report.failures.push(name);};
const N=s=>String(s||'').replace(/[._\-\s]/g,'').toLowerCase(),V=()=>new THREE.Vector3();
const loader=new GLTFLoader();loader.register(()=>({name:'CPU_NO_TEXTURES',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
const gltf=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),''),model=gltf.scene,bones={},meshes=[],equipment=[];
model.traverse(o=>{if(o.isBone)bones[o.name]=o;if(o.isSkinnedMesh)meshes.push(o);if(o.userData?.equipmentSlot)equipment.push(o);});
const map=new Map(Object.entries(bones).map(([name,b])=>[N(name),b])),bone=name=>map.get(N(name));
const rest=Object.values(bones).map(b=>({b,p:b.position.clone(),q:b.quaternion.clone(),s:b.scale.clone()})),skeletons=[...new Set(meshes.map(m=>m.skeleton))];
function update(){model.updateMatrixWorld(true);skeletons.forEach(s=>s.update());}
function restore(){for(const {b,p,q,s}of rest){b.position.copy(p);b.quaternion.copy(q);b.scale.copy(s);}update();}
const loadout=createLoadout({model,bones});
if(!loadout.grip)throw Error('The runtime must expose its actual grip controller');
function frame(slot,variant,side){
 const o=equipment.find(o=>o.userData.equipmentSlot===slot&&o.userData.equipmentVariant===variant);if(!o)throw Error('Missing '+slot+'/'+variant);
 let mesh;o.traverse(c=>{if(!mesh&&c.isSkinnedMesh)mesh=c;});const data=o.userData,index=mesh.skeleton.bones.indexOf(bone('wrist.'+side));
 const transform=mesh.matrixWorld.clone().multiply(mesh.bindMatrixInverse).multiply(bone('wrist.'+side).matrixWorld).multiply(mesh.skeleton.boneInverses[index]).multiply(mesh.bindMatrix);
 const grip=new THREE.Vector3().fromArray(data.gripBind).applyMatrix4(transform),axis=new THREE.Vector3().fromArray(data.shaftAxisBind||data.handleAxisBind).transformDirection(transform);
 return{grip,axis,second:data.secondGripBind?new THREE.Vector3().fromArray(data.secondGripBind).applyMatrix4(transform):null};
}
function actualFrames(){const state=loadout.summary(),weapon=frame('weapon',state.weaponType,'R'),r=state.weaponType==='pike'?.016:.014,result={R:{...weapon,radiusM:r}};
 if(state.twoHanded)result.L={grip:weapon.second,axis:weapon.axis,radiusM:r};else if(state.effectiveShield!=='none')result.L={...frame('shield',state.effectiveShield,'L'),radiusM:.014};return result;
}
function assess(measured){const problems=[];let minGap=Infinity,maxContactGap=-Infinity,maxQ10=-Infinity,minWrap=Infinity,minOpposition=Infinity;
 for(const [side,hand]of Object.entries(measured)){
  for(const finger of hand.fingers){for(const p of finger.phalanges){minGap=Math.min(minGap,p.minGapM);if(p.vertices<limits.minimumPatchVertices)problems.push(side+' patch coverage');if(!Number.isFinite(p.minGapM+p.q10GapM)||p.minGapM<limits.minimumSurfaceGapM||p.verticesInside)problems.push(side+' shaft penetration');if(p.joint>=2){maxContactGap=Math.max(maxContactGap,p.minGapM);maxQ10=Math.max(maxQ10,p.q10GapM);if(p.minGapM>limits.maximumContactGapM||p.q10GapM>limits.maximumContactQ10GapM)problems.push(side+' phalanx contact');}}
   if(finger.pad.vertices<limits.minimumPadVertices||finger.pad.minGapM>limits.maximumPadGapM||finger.pad.q10GapM>limits.maximumPadQ10GapM||finger.pad.medianGapM>limits.maximumPadMedianGapM)problems.push(side+' distal palmar pad contact');
   if(finger.finger>1){if(finger.tip.minGapM>limits.maximumTipGapM||finger.tip.q10GapM>limits.maximumTipQ10GapM||finger.tipOutward>limits.maximumTipOutward)problems.push(side+' terminal closure');if(finger.pipDeg<limits.minimumPipDeg||finger.pipDeg>limits.maximumPipDeg||finger.dipDeg<limits.minimumDipDeg||finger.dipDeg>limits.maximumDipDeg||finger.dipDeg-finger.pipDeg>limits.maximumDipAheadOfPipDeg)problems.push(side+' phalanx hinge range');minWrap=Math.min(minWrap,finger.wrapDeg);if(finger.wrapDeg<limits.minimumFingerWrapDeg)problems.push(side+' wrap');}
  }
  for(const [index,meta]of hand.metacarpals.entries()){if(Math.abs(meta.lengthM-meta.restLengthM)>limits.maximumMetacarpalLengthErrorM||meta.rootShiftM>limits.maximumMetacarpalLengthErrorM)problems.push(side+' metacarpal length');if(meta.cupDeg>[0,0,10,20][index]+.001)problems.push(side+' metacarpal cupping');}
  const thumb=new THREE.Vector3().fromArray(hand.fingers[0].phalanges[1].contactDirection),opposing=V();for(const f of hand.fingers.slice(1))opposing.add(new THREE.Vector3().fromArray(f.phalanges[1].contactDirection));
  const opposition=THREE.MathUtils.radToDeg(thumb.angleTo(opposing.normalize()));minOpposition=Math.min(minOpposition,opposition);if(opposition<limits.minimumThumbOppositionDeg)problems.push(side+' thumb opposition');
 }
 return{passed:!problems.length,problems:[...new Set(problems)],minGapM:minGap,maxContactGapM:maxContactGap,maxContactQ10GapM:maxQ10,minWrapDeg:minWrap,minThumbOppositionDeg:minOpposition};
}

function triangleCrosses(a,b){
 for(const [p,q]of[[a,b],[b,a]])for(let i=0;i<3;i++){
  const d=p[(i+1)%3].clone().sub(p[i]),length=d.length();if(length<1e-9)continue;
  const hit=new THREE.Ray(p[i],d.multiplyScalar(1/length)).intersectTriangle(...q,false,V());
  if(hit&&hit.distanceTo(p[i])>1e-8&&hit.distanceTo(p[i])<length-1e-8)return true;
 }return false;
}
function projectedTriangleRadius(points,axis,center){
 const u=axis.clone().cross(Math.abs(axis.y)<.9?new THREE.Vector3(0,1,0):new THREE.Vector3(1,0,0)).normalize(),v=axis.clone().cross(u),p=points.map(x=>{const d=x.clone().sub(center);return new THREE.Vector2(d.dot(u),d.dot(v));});
 const cross=(a,b)=>a.x*b.y-a.y*b.x,signs=p.map((x,i)=>cross(x,p[(i+1)%3]));if(signs.every(x=>x>=0)||signs.every(x=>x<=0))return 0;
 return Math.min(...p.map((a,i)=>{const d=p[(i+1)%3].clone().sub(a),t=THREE.MathUtils.clamp(-a.dot(d)/Math.max(1e-20,d.lengthSq()),0,1);return a.clone().addScaledVector(d,t).length();}));
}
function finiteSurfaces(side,handle){
 const thumb=[],other=[],fingerFaces=[];let minimumCylinderGapM=Infinity;const skin=meshes.filter(m=>m.material?.name==='skin');
 for(const mesh of skin){const g=mesh.geometry,points=[],weights=[];
  for(let i=0;i<g.attributes.position.count;i++){
   let tw=0,fw=0;for(let k=0;k<4;k++){const name=N(mesh.skeleton.bones[g.attributes.skinIndex.getComponent(i,k)]?.name),w=g.attributes.skinWeight.getComponent(i,k);if(name.endsWith(side.toLowerCase())&&name.startsWith('finger')){fw+=w;if(name.startsWith('finger1'))tw+=w;}}
   points.push(mesh.getVertexPosition(i,V()).applyMatrix4(mesh.matrixWorld));weights.push({tw,fw});
  }
  const count=g.index?g.index.count:g.attributes.position.count;
  for(let i=0;i<count;i+=3){const ids=[0,1,2].map(j=>g.index?g.index.getX(i+j):i+j),p=ids.map(j=>points[j]);if(!p.every(x=>x.distanceTo(handle.grip)<.15))continue;
   const face={p,box:new THREE.Box3().setFromPoints(p)};
   if(ids.every(j=>weights[j].tw>.25))thumb.push(face);else if(ids.every(j=>weights[j].tw<.05))other.push(face);
   if(ids.every(j=>weights[j].fw>.5)){fingerFaces.push(face);minimumCylinderGapM=Math.min(minimumCylinderGapM,projectedTriangleRadius(p,handle.axis,handle.grip)-handle.radiusM);}
  }
 }
 const cell=.01,grid=new Map(),cells=box=>{const keys=[];for(let x=Math.floor(box.min.x/cell);x<=Math.floor(box.max.x/cell);x++)for(let y=Math.floor(box.min.y/cell);y<=Math.floor(box.max.y/cell);y++)for(let z=Math.floor(box.min.z/cell);z<=Math.floor(box.max.z/cell);z++)keys.push(x+','+y+','+z);return keys;};
 other.forEach((f,i)=>cells(f.box).forEach(key=>{if(!grid.has(key))grid.set(key,[]);grid.get(key).push(i);}));
 let candidates=0,intersectionPairs=0;const affected=new Set();thumb.forEach((t,i)=>{const indices=new Set(cells(t.box).flatMap(key=>grid.get(key)||[]));for(const j of indices){const o=other[j];if(!t.box.intersectsBox(o.box))continue;candidates++;if(triangleCrosses(t.p,o.p)){intersectionPairs++;affected.add(i);}}});
 return{side,radiusM:handle.radiusM,thumbTriangles:thumb.length,opposingHandTriangles:other.length,fingerTriangles: fingerFaces.length,minimumCylinderGapM,candidates,intersectionPairs,intersectingThumbTriangles:affected.size};
}

let mixer=null,activeClip=null;
function setup(config,action){mixer?.stopAllAction();mixer?.uncacheRoot(model);mixer=null;restore();loadout.apply(config);activeClip=action==='rest'?null:gltf.animations.find(c=>c.name===action);return activeClip?.duration||0;}
function sample(action,time){
 // A fresh mixer avoids PropertyMixer's previous-value cache skipping a track
 // after an external deterministic rest restore.
 mixer?.stopAllAction();mixer?.uncacheRoot(model);mixer=null;restore();
 if(activeClip){mixer=new THREE.AnimationMixer(model);const a=mixer.clipAction(activeClip);a.setLoop(THREE.LoopOnce,1);a.clampWhenFinished=true;a.play();mixer.setTime(time);}
 loadout.poseAt(action,time);update();return loadout.grip.measure(actualFrames());
}
function poseSnapshot(){update();const values=Object.values(bones).flatMap(b=>b.matrixWorld.elements.slice());for(const mesh of meshes.filter(m=>m.material?.name==='skin'||m.material?.name==='weapon.grip'))for(let i=0;i<mesh.geometry.attributes.position.count;i+=97){const p=mesh.getVertexPosition(i,V()).applyMatrix4(mesh.matrixWorld);values.push(p.x,p.y,p.z);}return values;}
try{
 for(const bodyBuild of report.coverage.bodyBuilds)for(const weaponType of report.coverage.weapons){
  const config={bodyBuild,weaponType,armorType:'plate',shieldType:'tower'},actions=['rest','Guard_Breath','Spear_Study',...(['pike','greatsword'].includes(weaponType)?[]:['Shield_Brace'])];
  for(const action of actions){const duration=setup(config,action),count=action==='rest'?1:41,row={bodyBuild,weaponType,action,samples:count,passed:true,minGapM:Infinity,maxContactGapM:-Infinity,maxContactQ10GapM:-Infinity,minWrapDeg:Infinity,minThumbOppositionDeg:Infinity};
   for(let i=0;i<count;i++){const time=count===1?0:duration*i/(count-1),m=assess(sample(action,time));report.coverage.frameCount++;row.passed&&=m.passed;row.minGapM=Math.min(row.minGapM,m.minGapM);row.maxContactGapM=Math.max(row.maxContactGapM,m.maxContactGapM);row.maxContactQ10GapM=Math.max(row.maxContactQ10GapM,m.maxContactQ10GapM);row.minWrapDeg=Math.min(row.minWrapDeg,m.minWrapDeg);row.minThumbOppositionDeg=Math.min(row.minThumbOppositionDeg,m.minThumbOppositionDeg);if(!m.passed&&!row.firstFailure)row.firstFailure={time,...m};}
   const target=duration*.397;sample(action,target);const first=poseSnapshot();sample(action,duration*.93);sample(action,duration*.07);sample(action,target);const repeated=poseSnapshot(),delta=Math.max(...first.map((v,i)=>Math.abs(v-repeated[i])));row.reverseSeekErrorM=delta;row.passed&&=delta<1e-7;report.cases.push(row);check(bodyBuild+'/'+weaponType+'/'+action,row.passed,row.firstFailure||{});
  }
 }
 for(const shieldType of report.coverage.shields)for(const weaponType of ['spear','sword'])for(const action of ['rest','Shield_Brace']){const duration=setup({bodyBuild:'regular',weaponType,armorType:'plate',shieldType},action);for(const t of [0,.5,1]){const measured=sample(action,duration*t),result=assess(measured);report.coverage.frameCount++;check('actual shield attachment/'+shieldType+'/'+weaponType+'/'+action+'/'+t,result.passed,result);}}
 for(const weaponType of ['sword','pike']){setup({bodyBuild:'regular',weaponType,armorType:'plate',shieldType:'tower'},'Spear_Study');sample('Spear_Study',1.59);for(const [side,handle]of Object.entries(actualFrames())){const result=finiteSurfaces(side,handle);report.surfaceCases.push(result);check('finite skin surfaces/'+weaponType+'/'+side,result.thumbTriangles>100&&result.fingerTriangles>1000&&result.intersectionPairs===0&&result.minimumCylinderGapM>=limits.minimumSurfaceGapM,result);}}
 setup({bodyBuild:'regular',weaponType:'greatsword',armorType:'plate',shieldType:'none'},'Spear_Study');sample('Spear_Study',1.59);const baseline=assess(loadout.grip.measure(actualFrames()));
 const frameR=actualFrames().R;
 for(let f=2;f<=5;f++)for(let j=1;j<=3;j++){const b=bone(`finger${f}-${j}.R`),axis=frameR.axis.clone().applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion()).invert());b.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(axis,-THREE.MathUtils.degToRad(j===1?35:45)));update();}
 const opened=assess(loadout.grip.measure(actualFrames()));report.negativeControls.push({name:'Deliberately opened right fingers lose shaft contact',passed:baseline.passed&&!opened.passed&&opened.problems.some(p=>p.startsWith('R')),problems:opened.problems,maxContactGapM:opened.maxContactGapM});
 sample('Spear_Study',1.59);const distalMiddle=bone('finger3-3.R'),middleDirection=distalMiddle.getWorldPosition(V()).sub(bone('finger3-2.R').getWorldPosition(V())).normalize(),distalDirection=new THREE.Vector3(0,1,0).applyQuaternion(distalMiddle.getWorldQuaternion(new THREE.Quaternion())),distalAxis=middleDirection.cross(distalDirection).normalize().applyQuaternion(distalMiddle.getWorldQuaternion(new THREE.Quaternion()).invert());
 distalMiddle.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(distalAxis,-THREE.MathUtils.degToRad(40)));update();const openTip=assess(loadout.grip.measure(actualFrames()));report.negativeControls.push({name:'An opened distal joint is rejected by fixed palmar pad or terminal closure',passed:baseline.passed&&!openTip.passed&&openTip.problems.some(p=>p==='R distal palmar pad contact'||p==='R terminal closure'),problems:openTip.problems});
 sample('Spear_Study',1.59);const leftWrist=bone('wrist.L'),beforeLeft=leftWrist.getWorldPosition(V()),move=actualFrames().L.axis.clone().cross(new THREE.Vector3(0,1,0)).normalize().multiplyScalar(.025);
 leftWrist.position.copy(leftWrist.parent.worldToLocal(beforeLeft.clone().add(move)));update();
 const shifted=assess(loadout.grip.measure(actualFrames()));report.negativeControls.push({name:'An actual left wrist displaced25mm off the twohanded handle is rejected',passed:baseline.passed&&!shifted.passed,problems:shifted.problems});
 sample('Spear_Study',1.59);const leftThumb=bone('finger1-1.L'),thumbContact=loadout.grip.measure(actualFrames()).L.fingers[0].phalanges[1].contactDirection,thumbShift=new THREE.Vector3().fromArray(thumbContact).multiplyScalar(-.07);
 leftThumb.position.copy(leftThumb.parent.worldToLocal(leftThumb.getWorldPosition(V()).add(thumbShift)));update();
 const invertedThumb=assess(loadout.grip.measure(actualFrames()));report.negativeControls.push({name:'A deliberately misplaced actual left CMC on the opposite side loses thumb opposition',passed:baseline.passed&&!invertedThumb.passed&&invertedThumb.problems.includes('L thumb opposition'),problems:invertedThumb.problems,minThumbOppositionDeg:invertedThumb.minThumbOppositionDeg});
 if(report.negativeControls.some(c=>!c.passed))report.failures.push('negative controls');
 check('Audited runtime unchanged during sampling',hash(await runtimeSource(root))===report.runtimeSha256);
 check('Audited model unchanged during sampling',hash(await readFile(path.join(root,'assets/white-pawn.glb')))===report.glbSha256);
 check('Audit source unchanged during sampling',hash(await readFile(fileURLToPath(import.meta.url)))===report.auditSha256);
 report.status=report.failures.length?'failed':'passed';
}catch(error){report.status='failed';report.failures.push(error.message);}
await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,coverage:report.coverage,failures:report.failures,cases:report.cases.filter(c=>!c.passed).slice(0,4),negativeControls:report.negativeControls}));if(report.status!=='passed')process.exitCode=1;
