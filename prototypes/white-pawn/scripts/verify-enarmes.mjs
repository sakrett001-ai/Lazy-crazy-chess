/** Independent actual-surface audit of the two shield forearm loops. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {runtimeSource} from './runtime-source.mjs';
import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {createLoadout} from '../src/loadout.mjs';
const V=()=>new T.Vector3(),norm=s=>s.replace(/[._\-\s]/g,'').toLowerCase();
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),quick=process.argv.includes('--quick'),output=path.join(root,'review',quick?'enarme-quick.json':'enarme-checks.json'),hash=x=>createHash('sha256').update(x).digest('hex'),sourceBytes=await runtimeSource(root);
const file=await readFile(path.join(root,'assets/white-pawn.glb')); 
const loader=new GLTFLoader();loader.register(()=>({name:'NO_TEXTURE',loadTexture:()=>Promise.resolve(new T.Texture())}));
const gltf=await loader.parseAsync(file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength),'');
const model=gltf.scene,bones={},map=new Map(),skeletons=new Set();model.traverse(o=>{if(o.isBone){bones[o.name]=o;map.set(norm(o.name),o)}if(o.isSkinnedMesh)skeletons.add(o.skeleton)});
const B=name=>map.get(norm(name)),P=name=>B(name).getWorldPosition(V()),Q=name=>B(name).getWorldQuaternion(new T.Quaternion());
const initial=Object.values(bones).map(b=>({b,p:b.position.clone(),q:b.quaternion.clone(),s:b.scale.clone()}));
const update=()=>{model.updateMatrixWorld(true);for(const s of skeletons)s.update()};
update();const loadout=createLoadout({model,bones});let mixer=null;
function sample(shield,build,action,t){mixer?.stopAllAction();mixer?.uncacheRoot(model);mixer=null;for(const {b,p,q,s}of initial){b.position.copy(p);b.quaternion.copy(q);b.scale.copy(s)}update();loadout.apply({weaponType:'sword',shieldType:shield,bodyBuild:build,armorType:'plate'});if(action!=='rest'){mixer=new T.AnimationMixer(model);let a=mixer.clipAction(gltf.animations.find(c=>c.name===action));a.setLoop(T.LoopOnce,1);a.clampWhenFinished=true;a.play();mixer.setTime(t)}loadout.poseAt(action,t);update()}

const tag=(o,k)=>{for(;o;o=o.parent)if(o.userData?.[k]!==undefined)return o.userData[k]};const meshes=[];model.traverse(o=>{if(o.isSkinnedMesh&&tag(o,'equipmentSlot')==='shield'&&o.material.name==='shield.leather')meshes.push(o)});
function components(mesh){const g=mesh.geometry,n=g.attributes.position.count,ids=Array.from({length:n},(_,i)=>i),root=i=>{while(ids[i]!==i)i=ids[i];return i},join=(i,j)=>{ids[root(j)]=root(i)},pts=new Map();for(let i=0;i<n;i++){const key=V().fromBufferAttribute(g.attributes.position,i).toArray().map(x=>Math.round(x*1e6)).join(',');if(pts.has(key))join(i,pts.get(key));else pts.set(key,i)}const fs=[];for(let i=0;i<g.index.count;i+=3){const f=[g.index.getX(i),g.index.getX(i+1),g.index.getX(i+2)];join(f[0],f[1]);join(f[0],f[2]);fs.push(f)}const groups=new Map();for(let i=0;i<n;i++){const id=root(i);if(!groups.has(id))groups.set(id,{mesh,indices:[],faces:[]});groups.get(id).indices.push(i)}for(const f of fs)groups.get(root(f[0])).faces.push(f);return[...groups.values()]}
let evaluatedVertices=new Map();
const comps=meshes.flatMap(components),vertex=(m,i)=>{let cache=evaluatedVertices.get(m);if(!cache){cache=new Map();evaluatedVertices.set(m,cache);}if(!cache.has(i))cache.set(i,m.getVertexPosition(i,V()).applyMatrix4(m.matrixWorld));return cache.get(i);};

const straps=comps.filter(c=>c.indices.length===76);
const plateFaces=[];model.traverse(m=>{if(!m.isSkinnedMesh||tag(m,'equipmentSlot')!=='plate')return;const g=m.geometry;for(let i=0;i<g.index.count;i+=3){const f=[g.index.getX(i),g.index.getX(i+1),g.index.getX(i+2)];let sum=0;for(const j of f)for(let k=0;k<4;k++)if(/^lowerarm0[12]l$/.test(norm(m.skeleton.bones[g.attributes.skinIndex.getComponent(j,k)].name)))sum+=g.attributes.skinWeight.getComponent(j,k);if(sum>1.5)plateFaces.push({mesh:m,f})}});

function crossings(p,q){for(const [a,b]of [[p,q],[q,p]])for(let i=0;i<3;i++){const d=a[(i+1)%3].clone().sub(a[i]),length=d.length();if(length<1e-9)continue;const h=new T.Ray(a[i],d.multiplyScalar(1/length)).intersectTriangle(...b,false,V());if(h&&h.distanceTo(a[i])>1e-8&&h.distanceTo(a[i])<length-1e-8)return true}return false}
const shieldTopology=[];model.traverse(m=>{if(!m.isSkinnedMesh||tag(m,'equipmentSlot')!=='shield'||!['shield.face','shield.wood','shield.trim'].includes(m.material.name))return;for(let i=0;i<m.geometry.index.count;i+=3)shieldTopology.push({mesh:m,variant:tag(m,'equipmentVariant'),f:[0,1,2].map(j=>m.geometry.index.getX(i+j))});});
const originals=new Map(straps.map(c=>[c,{positions:c.indices.map(i=>V().fromBufferAttribute(c.mesh.geometry.attributes.position,i)),mounts:[0,1,36,37,38,39,74,75]}]));
const snapshot=variant=>straps.filter(c=>tag(c.mesh,'equipmentVariant')===variant).flatMap(c=>c.indices.flatMap(i=>[...V().fromBufferAttribute(c.mesh.geometry.attributes.position,i).toArray(),...V().fromBufferAttribute(c.mesh.geometry.attributes.normal,i).toArray()]));
function measure(variant){
 evaluatedVertices=new Map();
 const armour=plateFaces.map(({mesh,f})=>{const p=f.map(i=>vertex(mesh,i));return{p,box:new T.Box3().setFromPoints(p)}});let intersections=0,shieldIntersections=0,bracerShieldIntersections=0,nonfinite=0,mountDrift=0,normalError=0,boundsFailures=0;const examples=[];
 const shield=shieldTopology.filter(t=>t.variant===variant).map(({mesh,f})=>{const p=f.map(i=>vertex(mesh,i));return{p,box:new T.Box3().setFromPoints(p)}});
 const armourBox=new T.Box3();for(const a of armour)armourBox.union(a.box);const shieldNearArmour=shield.filter(b=>b.box.intersectsBox(armourBox));
 for(const a of armour)for(const b of shieldNearArmour)if(a.box.intersectsBox(b.box)&&crossings(a.p,b.p))bracerShieldIntersections++;
 for(const c of straps.filter(c=>tag(c.mesh,'equipmentVariant')===variant)){
  const g=c.mesh.geometry,points=new Map(c.indices.map(i=>[i,vertex(c.mesh,i)])),whole=new T.Box3().setFromPoints([...points.values()]),candidates=armour.filter(a=>a.box.intersectsBox(whole)),shieldCandidates=shield.filter(a=>a.box.intersectsBox(whole));
  for(const p of points.values())if(!p.toArray().every(Number.isFinite))nonfinite++;
  const old=originals.get(c),wi=c.mesh.skeleton.bones.indexOf(B('wrist.L'));
  for(const j of old.mounts){const expected=old.positions[j].clone().applyMatrix4(c.mesh.bindMatrix).applyMatrix4(c.mesh.skeleton.boneInverses[wi]).applyMatrix4(B('wrist.L').matrixWorld).applyMatrix4(c.mesh.bindMatrixInverse).applyMatrix4(c.mesh.matrixWorld);mountDrift=Math.max(mountDrift,expected.distanceTo(points.get(c.indices[j])));}
  for(const i of c.indices){const p=V().fromBufferAttribute(g.attributes.position,i),n=V().fromBufferAttribute(g.attributes.normal,i);normalError=Math.max(normalError,Math.abs(n.length()-1));if(!n.toArray().every(Number.isFinite))nonfinite++;if(!g.boundingBox?.containsPoint(p)||!g.boundingSphere||p.distanceTo(g.boundingSphere.center)>g.boundingSphere.radius+1e-6)boundsFailures++;}
  const mountIndices=new Set(old.mounts.map(j=>c.indices[j]));
  for(const f of c.faces){const p=f.map(i=>points.get(i)),box=new T.Box3().setFromPoints(p);if(!f.some(i=>mountIndices.has(i)))for(const b of shieldCandidates)if(box.intersectsBox(b.box)&&crossings(p,b.p))shieldIntersections++;for(const a of candidates)if(box.intersectsBox(a.box)&&crossings(p,a.p)){intersections++;if(examples.length<3)examples.push(new T.Triangle(...p).getMidpoint(V()).toArray());}}
 }
 return{intersections,shieldIntersections,bracerShieldIntersections,nonfinite,mountDriftM:mountDrift,maximumNormalLengthError:normalError,boundsFailures,examples};
}
const report={status:'running',runtimeSha256:hash(sourceBytes),glbSha256:hash(file),auditSha256:hash(await readFile(fileURLToPath(import.meta.url))),coverage:{shields:['tower','round','heater'],bodyBuilds:['regular','lean','strong'],actions:quick?['rest','Shield_Brace']:['rest','Guard_Breath','Shield_Brace','Spear_Study'],frameCount:0,caseCount:0,quick,sampleRateHz:quick?null:10},checks:[],cases:[],negativeControls:[],failures:[],scope:'Actual skinned enarme triangles vs plate triangles weighted to the left forearm, plus both loop and bracer triangles vs shield.face/wood/trim, all 3 shield types and body morphs. Loop/board testing excludes only triangles adjoining the 8 original mount vertices, which intentionally attach inside the wood. Finite triangle-edge crossings, fixed shield mount vertices, deterministic POSITION/NORMAL seek, finite unit normals and local geometry bounds. This is a bounded routing correction for two leather loops, not cloth dynamics, whole-body collision, tension simulation or a minimum-gap certificate.'};
const check=(name,passed,details={})=>{report.checks.push({name,passed:!!passed,...details});if(!passed)report.failures.push(name);};
try{
 const topology=report.coverage.shields.map(variant=>({variant,bands:straps.filter(c=>tag(c.mesh,'equipmentVariant')===variant).length,bandTriangles:straps.filter(c=>tag(c.mesh,'equipmentVariant')===variant).map(c=>c.faces.length),shieldMaterials:Object.fromEntries(['shield.face','shield.wood','shield.trim'].map(name=>[name,shieldTopology.filter(t=>t.variant===variant&&t.mesh.material.name===name).length]))}));
 check('Actual collision surfaces are present for every shield',plateFaces.length>0&&topology.every(t=>t.bands===2&&t.bandTriangles.every(n=>n===148)&&Object.values(t.shieldMaterials).every(n=>n>0)),{plateTriangles:plateFaces.length,topology});
 for(const shield of report.coverage.shields)for(const build of report.coverage.bodyBuilds)for(const action of report.coverage.actions){
  const clip=gltf.animations.find(c=>c.name===action);if(action!=='rest'&&!clip)throw Error('Missing clip '+action);
  const duration=clip?.duration||0,times=action==='rest'?[0]:quick?[2.47]:[...new Set([...Array.from({length:Math.floor(duration*10)+1},(_,i)=>i/10),duration,...(action==='Shield_Brace'?[2.47]:action==='Spear_Study'?[1.36]:[])])].sort((a,b)=>a-b);
  const result={id:[shield,build,action].join('/'),shield,build,action,frames:times.length,maximumIntersections:0,maximumShieldIntersections:0,maximumBracerShieldIntersections:0,maximumMountDriftM:0,maximumNormalLengthError:0,nonfinite:0,boundsFailures:0,examples:[]};
  for(const time of times){sample(shield,build,action,time);const m=measure(shield);report.coverage.frameCount++;result.maximumIntersections=Math.max(result.maximumIntersections,m.intersections);result.maximumShieldIntersections=Math.max(result.maximumShieldIntersections,m.shieldIntersections);result.maximumBracerShieldIntersections=Math.max(result.maximumBracerShieldIntersections,m.bracerShieldIntersections);result.maximumMountDriftM=Math.max(result.maximumMountDriftM,m.mountDriftM);result.maximumNormalLengthError=Math.max(result.maximumNormalLengthError,m.maximumNormalLengthError);result.nonfinite+=m.nonfinite;result.boundsFailures+=m.boundsFailures;if((m.intersections||m.shieldIntersections||m.bracerShieldIntersections)&&result.examples.length<3)result.examples.push({time,...m});}
  report.cases.push(result);report.coverage.caseCount++;check(result.id,result.maximumIntersections===0&&result.maximumShieldIntersections===0&&result.maximumBracerShieldIntersections===0&&result.maximumMountDriftM<1e-6&&result.maximumNormalLengthError<1e-5&&!result.nonfinite&&!result.boundsFailures,result);
 }
 for(const shield of report.coverage.shields){sample(shield,'strong','Shield_Brace',2.47);const first=snapshot(shield);sample(shield,'strong','rest',0);sample(shield,'strong','Shield_Brace',.9);sample(shield,'strong','Shield_Brace',2.47);const next=snapshot(shield),error=Math.max(...next.map((v,i)=>Math.abs(v-first[i])));check(shield+': reverse seek reproduces actual POSITION and NORMAL',error<1e-7,{maxComponentError:error});}
 sample('round','regular','Shield_Brace',2.47);const corrected=measure('round');
 for(const c of straps.filter(c=>tag(c.mesh,'equipmentVariant')==='round'))for(const [j,i]of c.indices.entries()){const p=originals.get(c).positions[j];c.mesh.geometry.attributes.position.setXYZ(i,p.x,p.y,p.z);}
 const forced=measure('round');report.negativeControls.push({name:'Restore original wrist-bound strap geometry in the new arm pose',passed:corrected.intersections===0&&forced.intersections>0,beforeIntersections:corrected.intersections,afterIntersections:forced.intersections,examples:forced.examples});check('Original wrist-bound strap negative control',report.negativeControls[0].passed);
 check('Runtime unchanged during audit',hash(await runtimeSource(root))===report.runtimeSha256);check('Audit unchanged during run',hash(await readFile(fileURLToPath(import.meta.url)))===report.auditSha256);check('GLB unchanged during audit',hash(await readFile(path.join(root,'assets/white-pawn.glb')))===report.glbSha256);report.status=report.failures.length?'failed':'passed';
}catch(error){report.status='error';report.failure=error.stack;report.failures.push(error.message);}
finally{mixer?.stopAllAction();await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,runtimeSha256:report.runtimeSha256,coverage:report.coverage,failures:report.failures,maximumIntersections:Math.max(0,...report.cases.map(c=>c.maximumIntersections)),maximumShieldIntersections:Math.max(0,...report.cases.map(c=>c.maximumShieldIntersections)),maximumBracerShieldIntersections:Math.max(0,...report.cases.map(c=>c.maximumBracerShieldIntersections)),maximumMountDriftM:Math.max(0,...report.cases.map(c=>c.maximumMountDriftM)),negativeControls:report.negativeControls,output},null,2));if(report.status!=='passed')process.exitCode=1;}
