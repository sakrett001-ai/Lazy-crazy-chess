/** Actual skinned torso contact and independently measured whole-body thrust regression. */
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {runtimeSource} from './runtime-source.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),repo=path.resolve(root,'../..');
const quick=process.argv.includes('--quick'),baseline=process.argv.includes('--baseline'),baselineCommit='f7f3fd8787d6bc3f5a13942ef806a720225fdb8d';
const output=process.env.PAWN_BODY_CONTACT_REPORT||path.join(root,'review',baseline?'body-contact-baseline-041.json':quick?'body-contact-quick.json':'body-contact-checks.json');
const hash=b=>createHash('sha256').update(b).digest('hex');
const oldFile=name=>execFileSync('git',['show',baselineCommit+':prototypes/white-pawn/'+name],{cwd:repo,maxBuffer:64*1024*1024});
const bytes=baseline?oldFile('assets/white-pawn.glb'):await readFile(path.join(root,'assets/white-pawn.glb'));
let createLoadout,runtimeBytes,tempSource;
if(baseline){
 tempSource=path.join(root,'scripts','.body-baseline-source-'+process.pid);await mkdir(tempSource,{recursive:true});const parts=[];
 for(const name of ['src/loadout.mjs','src/biomechanics.mjs','src/grip.mjs']){const b=oldFile(name);parts.push(Buffer.from(name+'\n'),b,Buffer.from('\n'));await writeFile(path.join(tempSource,path.basename(name)),b);}
 runtimeBytes=Buffer.concat(parts);({createLoadout}=await import(pathToFileURL(path.join(tempSource,'loadout.mjs')).href));
}else{runtimeBytes=await runtimeSource(root);({createLoadout}=await import(pathToFileURL(path.join(root,'src/loadout.mjs')).href));}
const limits={containmentToleranceM:.001,minimumRightHandAdvanceRelativeChestM:.06,minimumRightElbowExtensionDeg:10,minimumCombinedElbowExtensionDeg:10,minimumTwoHandElbowExtensionDeg:0,minimumRearKneeExtensionDeg:2,minimumFrontKneeFlexChangeDeg:2,minimumTorsoPitchChangeDeg:2,maximumFootDriftM:.006};
const weapons=['spear','sword','pike','greatsword'],bodyBuilds=['lean','regular','strong'];
const report={status:'running',baseline,sourceCommit:baseline?baselineCommit:null,glbSha256:hash(bytes),runtimeSha256:hash(runtimeBytes),auditSha256:hash(await readFile(fileURLToPath(import.meta.url))),limits,coverage:{quick,sampleRateHz:30,weapons,bodyBuilds,armorTypes:['plate','mail','padded'],actions:['Spear_Study'],shields:['tower'],caseCount:0,frameCount:0},bodyClearancePassed:false,wholeBodyContributionPassed:false,checks:[],cases:[],contributionCases:[],negativeControls:[],failures:[],scope:'Actual CPU-skinned finite weapon triangles (all materials, including grip, bindings and pommel) and left/right hand skin triangles versus weight-classified actual torso skin, padding and active armor triangles. AABB/grid is broad phase only; failures require finite edge/triangle crossings or vertices inside the padding torso envelope derived by ray intersections with actual triangles. Hidden torso skin is absent below clothing, so the volume between the front/back padding walls is the conservative body envelope. Intended hand/handle contact is excluded by testing only torso targets. Sampling is 30 Hz, not continuous collision detection. Motion criteria are avatar regression limits, not population biomechanics norms or force/balance validation. The action is a compact standing thrust with fixed foot contacts, not a stepping lunge.'};
const check=(name,passed,details={})=>{report.checks.push({name,passed:!!passed,...details});if(!passed)report.failures.push(name);};
const V=()=>new THREE.Vector3(),Q=()=>new THREE.Quaternion(),deg=THREE.MathUtils.radToDeg,norm=s=>String(s||'').replace(/[._\-\s]/g,'').toLowerCase();
const loader=new GLTFLoader();loader.register(()=>({name:'CPU_BODY_CONTACT',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
const gltf=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),''),model=gltf.scene,bones={},meshes=[];
model.traverse(o=>{if(o.isBone)bones[o.name]=o;if(o.isSkinnedMesh)meshes.push(o);});
const lookup=new Map(Object.entries(bones).map(([n,b])=>[norm(n),b])),bone=n=>{const b=lookup.get(norm(n));if(!b)throw Error('Missing bone '+n);return b;};
const rest=Object.values(bones).map(b=>({b,p:b.position.clone(),q:b.quaternion.clone(),s:b.scale.clone()})),skeletons=[...new Set(meshes.map(m=>m.skeleton))];
function update(){model.updateMatrixWorld(true);for(const s of skeletons)s.update();}
function restore(){for(const {b,p,q,s}of rest){b.position.copy(p);b.quaternion.copy(q);b.scale.copy(s);}update();}
const point=b=>b.getWorldPosition(V());
function tag(o,key){for(;o;o=o.parent)if(o.userData?.[key]!==undefined)return o.userData[key];}
update();
function weight(m,i,predicate){let n=0;for(let j=0;j<4;j++){const w=m.geometry.attributes.skinWeight.getComponent(i,j),b=m.skeleton.bones[m.geometry.attributes.skinIndex.getComponent(i,j)];if(b&&predicate(norm(b.name)))n+=w;}return n;}
const topology=new Map(meshes.map(m=>{const g=m.geometry,count=g.index?g.index.count:g.attributes.position.count,faces=[];for(let i=0;i<count;i+=3)faces.push({index:i/3,ids:[0,1,2].map(j=>g.index?g.index.getX(i+j):i+j)});return[m,faces];}));
function descriptor(m,faces,kind){
 // Exported GLB repeats vertices at material/normal seams. Canonicalization
 // includes skin weights so only mathematically identical skinned points merge.
 const canonical=new Map(),map=new Map(),ids=[];for(const f of faces)for(const i of f.ids)if(!map.has(i)){const g=m.geometry,key=[0,1,2].map(k=>g.attributes.position.getComponent(i,k)).concat(...[0,1,2,3].map(k=>[g.attributes.skinIndex.getComponent(i,k),g.attributes.skinWeight.getComponent(i,k)]),...(g.morphAttributes.position||[]).map(a=>[0,1,2].map(k=>a.getComponent(i,k)))).join('/');let j=canonical.get(key);if(j===undefined){j=ids.length;canonical.set(key,j);ids.push(i);}map.set(i,j);}
 return{mesh:m,kind,ids,faces:faces.map(f=>({index:f.index,ids:f.ids.map(i=>map.get(i))}))};
}
const torso=[],hands={L:[],R:[]},weaponParts=new Map();
for(const m of meshes){
 const slot=tag(m,'equipmentSlot'),variant=tag(m,'equipmentVariant'),all=topology.get(m),g=m.geometry;
 if(slot==='weapon'){if(!weaponParts.has(variant))weaponParts.set(variant,[]);weaponParts.get(variant).push(descriptor(m,all,'weapon'));}
 if(m.material.name==='skin')for(const side of ['L','R']){const faces=all.filter(f=>f.ids.every(i=>weight(m,i,n=>/^(wrist|hand|finger)/.test(n)&&n.endsWith(side.toLowerCase()))>.5));if(faces.length)hands[side].push(descriptor(m,faces,'hand'+side));}
 if(['base','padding','plate','mail'].includes(slot)&&(slot!=='base'||m.material.name==='skin')){
  const faces=all.filter(f=>{const y=f.ids.reduce((s,i)=>s+g.attributes.position.getY(i),0)/3;return y>.99&&y<1.49&&f.ids.reduce((s,i)=>s+weight(m,i,n=>/^(spine|breast|neck|clavicle)/.test(n)),0)/3>.6;});
  if(faces.length)torso.push(descriptor(m,faces,slot));
 }
}
// Sole vertices are actual exported skin/leather geometry with predominant foot
// weights. Track their positions, not only ankle origins: a foot can rotate
// around a fixed ankle and still lose contact.
const soleSamples=Object.fromEntries(['L','R'].map(side=>{const entries=[];for(const m of meshes.filter(m=>tag(m,'equipmentSlot')==='base'))for(let i=0;i<m.geometry.attributes.position.count;i++)if(weight(m,i,n=>n==='foot'+side.toLowerCase())>.95)entries.push({m,i,p:m.getVertexPosition(i,V()).applyMatrix4(m.matrixWorld)});if(!entries.length)throw Error('No sole vertices '+side);const floor=Math.min(...entries.map(e=>e.p.y));return[side,entries.filter(e=>e.p.y<=floor+.006)];}));
const soles=()=>Object.fromEntries(['L','R'].map(side=>[side,soleSamples[side].map(({m,i})=>m.getVertexPosition(i,V()).applyMatrix4(m.matrixWorld))]));
const loadout=createLoadout({model,bones});let mixer=null,clip=null;
function begin(config){mixer?.stopAllAction();mixer?.uncacheRoot(model);mixer=null;restore();loadout.apply({...config,shieldType:'tower',beard:'none',helmet:'on',experience:'recruit'});clip=gltf.animations.find(c=>c.name==='Spear_Study');if(!clip)throw Error('Missing Spear_Study');return clip.duration;}
function sample(time){mixer?.stopAllAction();mixer?.uncacheRoot(model);mixer=null;restore();mixer=new THREE.AnimationMixer(model);const a=mixer.clipAction(clip);a.setLoop(THREE.LoopOnce,1);a.clampWhenFinished=true;a.play();mixer.setTime(time);loadout.poseAt('Spear_Study',time);update();}
function evaluated(d){const points=d.ids.map(i=>d.mesh.getVertexPosition(i,V()).applyMatrix4(d.mesh.matrixWorld)),faces=d.faces.map(f=>{const p=f.ids.map(i=>points[i]);return{mesh:d.mesh.name,kind:d.kind,index:f.index,p,box:new THREE.Box3().setFromPoints(p)};});return{...d,points,faces,box:new THREE.Box3().setFromPoints(points)};}
const cell=.05,epsilon=1e-7;
function keys(box,xy=false){const result=[];for(let x=Math.floor(box.min.x/cell);x<=Math.floor(box.max.x/cell);x++)for(let y=Math.floor(box.min.y/cell);y<=Math.floor(box.max.y/cell);y++)if(xy)result.push(x+','+y);else for(let z=Math.floor(box.min.z/cell);z<=Math.floor(box.max.z/cell);z++)result.push(x+','+y+','+z);return result;}
function grid(faces,xy=false){const map=new Map();for(let i=0;i<faces.length;i++)for(const k of keys(faces[i].box,xy)){if(!map.has(k))map.set(k,[]);map.get(k).push(i);}return map;}
function crossing(a,b){for(const [edges,face]of[[a,b],[b,a]])for(let i=0;i<3;i++){const d=edges[(i+1)%3].clone().sub(edges[i]),len=d.length();if(len<epsilon)continue;const hit=new THREE.Ray(edges[i],d.multiplyScalar(1/len)).intersectTriangle(...face,false,V());if(hit){const s=hit.distanceTo(edges[i]);if(s>epsilon&&s<len-epsilon)return hit;}}return null;}
function contact(config){
 const targets=torso.filter(d=>d.kind==='base'||d.kind==='padding'||d.kind===config.armorType).map(evaluated),objects=[...weaponParts.get(config.weaponType),...hands.L,...hands.R].map(evaluated);
 const faces=targets.flatMap(p=>p.faces),bounds=new THREE.Box3();for(const p of targets)bounds.union(p.box);const cells=grid(faces),padding=targets.filter(p=>p.kind==='padding').flatMap(p=>p.faces),rayCells=grid(padding,true);
 let candidates=0,intersectionPairs=0,containedVertices=0,maximumContainmentDepthM=0,nonfinite=0;const intersections=[],contained=[];
 for(const object of objects){for(const p of object.points)if(![p.x,p.y,p.z].every(Number.isFinite))nonfinite++;
  if(!object.box.intersectsBox(bounds))continue;
  for(const a of object.faces){if(!a.box.intersectsBox(bounds))continue;const ids=new Set(keys(a.box.clone().intersect(bounds)).flatMap(k=>cells.get(k)||[]));for(const id of ids){const b=faces[id];if(!a.box.intersectsBox(b.box))continue;candidates++;const hit=crossing(a.p,b.p);if(hit){intersectionPairs++;if(intersections.length<8)intersections.push({object:a.kind,mesh:a.mesh,triangle:a.index,torsoMesh:b.mesh,torsoTriangle:b.index,pointWorld:hit.toArray()});}}}
  for(const p of object.points){if(!bounds.containsPoint(p))continue;const ids=rayCells.get(Math.floor(p.x/cell)+','+Math.floor(p.y/cell))||[],zs=[],ray=new THREE.Ray(V().set(p.x,p.y,bounds.min.z-.1),V().set(0,0,1));
   for(const id of ids){const f=padding[id];if(p.x<f.box.min.x-epsilon||p.x>f.box.max.x+epsilon||p.y<f.box.min.y-epsilon||p.y>f.box.max.y+epsilon)continue;const hit=ray.intersectTriangle(...f.p,false,V());if(hit)zs.push(hit.z);}
   if(zs.length<2)continue;const lo=Math.min(...zs),hi=Math.max(...zs);if(hi-lo<.04)continue;const depth=Math.min(p.z-lo,hi-p.z);if(depth>limits.containmentToleranceM){containedVertices++;maximumContainmentDepthM=Math.max(maximumContainmentDepthM,depth);if(contained.length<8)contained.push({object:object.kind,mesh:object.mesh.name,pointWorld:p.toArray(),rayBackZ:lo,rayFrontZ:hi,depthM:depth});}
  }
 }
 return{intersectionPairs,containedVertices,maximumContainmentDepthM,candidates,nonfinite,intersections,contained,weaponTriangles:objects.filter(o=>o.kind==='weapon').reduce((s,o)=>s+o.faces.length,0),handTriangles:Object.fromEntries(['L','R'].map(side=>[side,objects.filter(o=>o.kind==='hand'+side).reduce((s,o)=>s+o.faces.length,0)])),torsoTriangles:faces.length};
}
function pose(){const p=n=>point(bone(n)),chest=p('upperarm01.L').add(p('upperarm01.R')).multiplyScalar(.5),up=p('neck01').sub(p('spine05')).normalize(),forward=p('upperarm01.L').sub(p('upperarm01.R')).normalize().cross(up).normalize();const flex=(a,b,c)=>deg(p(b).sub(p(a)).angleTo(p(c).sub(p(b))));return{hand:p('wrist.R'),chest,hip:p('spine05'),forward,torsoPitchDeg:deg(Math.atan2(up.z,up.y)),elbowFlexDeg:flex('upperarm01.R','lowerarm01.R','wrist.R'),leftElbowFlexDeg:flex('upperarm01.L','lowerarm01.L','wrist.L'),kneeFlexDeg:Object.fromEntries(['L','R'].map(s=>[s,flex('upperleg01.'+s,'lowerleg01.'+s,'foot.'+s)])),feet:Object.fromEntries(['L','R'].map(s=>[s,p('foot.'+s)]))};}
function contribution(ready,peak,maximumFootDriftM=0,weaponType='greatsword'){const axis=ready.forward,rightHandAdvanceRelativeChestM=peak.hand.clone().sub(ready.hand).sub(peak.chest.clone().sub(ready.chest)).dot(axis),rightElbowExtensionDeg=ready.elbowFlexDeg-peak.elbowFlexDeg,leftElbowExtensionDeg=ready.leftElbowFlexDeg-peak.leftElbowFlexDeg,totalElbowExtensionDeg=rightElbowExtensionDeg+leftElbowExtensionDeg,frontKneeFlexChangeDeg=peak.kneeFlexDeg.L-ready.kneeFlexDeg.L,rearKneeExtensionDeg=ready.kneeFlexDeg.R-peak.kneeFlexDeg.R,torsoPitchChangeDeg=peak.torsoPitchDeg-ready.torsoPitchDeg;return{readyTime:1.25,peakTime:1.9,rightHandAdvanceRelativeChestM,rightHandAdvanceRelativeHipM:peak.hand.clone().sub(ready.hand).sub(peak.hip.clone().sub(ready.hip)).dot(axis),rightElbowExtensionDeg,leftElbowExtensionDeg,totalElbowExtensionDeg,frontKneeFlexChangeDeg,rearKneeExtensionDeg,torsoPitchChangeDeg,maximumFootDriftM,passed:rightHandAdvanceRelativeChestM>=limits.minimumRightHandAdvanceRelativeChestM&&(['pike','greatsword'].includes(weaponType)?rightElbowExtensionDeg>=limits.minimumTwoHandElbowExtensionDeg&&leftElbowExtensionDeg>=limits.minimumTwoHandElbowExtensionDeg&&totalElbowExtensionDeg>=limits.minimumCombinedElbowExtensionDeg:rightElbowExtensionDeg>=limits.minimumRightElbowExtensionDeg)&&rearKneeExtensionDeg>=limits.minimumRearKneeExtensionDeg&&frontKneeFlexChangeDeg>=limits.minimumFrontKneeFlexChangeDeg&&torsoPitchChangeDeg>=limits.minimumTorsoPitchChangeDeg&&maximumFootDriftM<=limits.maximumFootDriftM};}
function record(config){const duration=begin(config),id=[config.weaponType,config.bodyBuild,config.armorType,'Spear_Study'].join('/'),times=quick?[0,1.25,1.59,1.9,4]:Array.from({length:Math.round(duration*30)+1},(_,i)=>Math.min(duration,i/30));const c={id,...config,action:'Spear_Study',duration,samples:times.length,maximumIntersectionPairs:0,intersectingFrames:0,maximumContainedVertices:0,containedFrames:0,maximumContainmentDepthM:0,nonfinite:0,examples:[]};let footStart=null,maximumFootDriftM=0;
 for(const time of times){sample(time);const m=contact(config),s=pose();const currentSoles=soles();if(!footStart)footStart=currentSoles;for(const side of ['L','R'])for(let i=0;i<currentSoles[side].length;i++)maximumFootDriftM=Math.max(maximumFootDriftM,currentSoles[side][i].distanceTo(footStart[side][i]));report.coverage.frameCount++;c.maximumIntersectionPairs=Math.max(c.maximumIntersectionPairs,m.intersectionPairs);c.maximumContainedVertices=Math.max(c.maximumContainedVertices,m.containedVertices);c.maximumContainmentDepthM=Math.max(c.maximumContainmentDepthM,m.maximumContainmentDepthM);c.intersectingFrames+=Number(m.intersectionPairs>0);c.containedFrames+=Number(m.containedVertices>0);c.nonfinite+=m.nonfinite;c.weaponTriangles=m.weaponTriangles;c.handTriangles=m.handTriangles;c.torsoTriangles=m.torsoTriangles;if((m.intersectionPairs||m.containedVertices)&&c.examples.length<3)c.examples.push({time,...m});}
 report.cases.push(c);report.coverage.caseCount++;check(id+': no torso contact',c.maximumIntersectionPairs===0&&c.maximumContainedVertices===0&&c.nonfinite===0&&c.weaponTriangles>0&&c.handTriangles.L>0&&c.handTriangles.R>0&&c.torsoTriangles>0);
 if(config.armorType==='plate'){sample(1.25);const ready=pose();sample(1.9);const peak=pose(),m=contribution(ready,peak,maximumFootDriftM,config.weaponType);report.contributionCases.push({id,...config,...m});check(id+': arms torso and legs contribute',m.passed,m);}
 console.error(JSON.stringify({id,intersections:c.maximumIntersectionPairs,inside:c.maximumContainedVertices,depthM:c.maximumContainmentDepthM,example:c.examples[0]}));
}
try{
 const requested=(process.env.PAWN_BODY_CONTACT_CASE||'greatsword/regular/plate').split('/');const fixtures=quick?[{weaponType:requested[0],bodyBuild:requested[1],armorType:requested[2]}]:weapons.flatMap(weaponType=>bodyBuilds.map(bodyBuild=>({weaponType,bodyBuild,armorType:'plate'}))).concat(['mail','padded'].flatMap(armorType=>bodyBuilds.map(bodyBuild=>({weaponType:'greatsword',bodyBuild,armorType}))));
 for(const config of fixtures)record(config);
 report.bodyClearancePassed=report.cases.every(c=>c.maximumIntersectionPairs===0&&c.maximumContainedVertices===0&&c.nonfinite===0);
 report.wholeBodyContributionPassed=report.contributionCases.every(c=>c.passed);
 const config={weaponType:'greatsword',bodyBuild:'regular',armorType:'plate'};begin(config);sample(1.9);const before=contact(config),wrist=bone('wrist.R'),beforeWrist=point(wrist),target=point(bone('spine02')).add(V().set(0,0,.04));wrist.position.copy(wrist.parent.worldToLocal(target.clone()));update();const forced=contact(config),afterWrist=point(wrist);report.negativeControls.push({name:'Moved imported weapon and hand enter torso',passed:(baseline||(before.intersectionPairs===0&&before.containedVertices===0))&&afterWrist.distanceTo(beforeWrist)>.05&&(forced.intersectionPairs>0||forced.containedVertices>0),movementM:afterWrist.distanceTo(beforeWrist),beforeIntersectionPairs:before.intersectionPairs,beforeContainedVertices:before.containedVertices,afterIntersectionPairs:forced.intersectionPairs,afterContainedVertices:forced.containedVertices,beforeWristWorld:beforeWrist.toArray(),afterWristWorld:afterWrist.toArray(),intersections:forced.intersections,contained:forced.contained});
 sample(1.25);const ready=pose(),rootBone=bone('root');rootBone.position.add(V().set(0,0,.15));update();const translated=contribution(ready,pose());report.negativeControls.push({name:'Pelvis-only translated ready pose is rejected',translationM:.15,movementM:.15,...translated,contributionPassed:translated.passed,passed:!translated.passed&&Math.abs(translated.rightHandAdvanceRelativeChestM)<1e-6&&Math.abs(translated.rightElbowExtensionDeg)<1e-6&&Math.abs(translated.frontKneeFlexChangeDeg)<1e-6});
 check('Physical negative controls detect torso contact and pelvis-only movement',report.negativeControls.every(c=>c.passed));
 check('Audit source remains unchanged during run',hash(await readFile(fileURLToPath(import.meta.url)))===report.auditSha256);
 if(!baseline){check('Runtime source remains unchanged during run',hash(await runtimeSource(root))===report.runtimeSha256);check('GLB remains unchanged during run',hash(await readFile(path.join(root,'assets/white-pawn.glb')))===report.glbSha256);}
 report.status=report.failures.length?'failed':'passed';
}catch(e){report.status='error';report.failure=e.stack;report.failures.push(e.message);}
finally{mixer?.stopAllAction();if(tempSource)await rm(tempSource,{recursive:true,force:true});await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,coverage:report.coverage,contributionCases:report.contributionCases,negativeControls:report.negativeControls.map(c=>({name:c.name,passed:c.passed})),failures:report.failures,report:output},null,2));if(report.status!=='passed')process.exitCode=1;}
