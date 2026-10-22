/** Local synchronous pose cost; a benchmark, not an FPS or correctness claim. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {createLoadout} from '../src/loadout.mjs';
import {runtimeSource} from './runtime-source.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bytes=await readFile(path.join(root,'assets/white-pawn.glb')),source=await runtimeSource(root);
const hash=data=>createHash('sha256').update(data).digest('hex');
const loader=new GLTFLoader();loader.register(()=>({name:'CPU_NO_TEXTURES',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
const gltf=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
const model=gltf.scene,bones={},skeletons=new Set();
model.traverse(o=>{if(o.isBone)bones[o.name]=o;if(o.isSkinnedMesh)skeletons.add(o.skeleton);});
const rest=Object.values(bones).map(b=>({b,p:b.position.clone(),q:b.quaternion.clone(),s:b.scale.clone()}));
const update=()=>{model.updateMatrixWorld(true);for(const s of skeletons)s.update();};update();
const loadout=createLoadout({model,bones});let mixer=null;
function prepare(weaponType,action,time){
 mixer?.stopAllAction();mixer?.uncacheRoot(model);mixer=null;
 for(const {b,p,q,s}of rest){b.position.copy(p);b.quaternion.copy(q);b.scale.copy(s);}update();
 loadout.apply({weaponType,shieldType:'round'});
 const clip=gltf.animations.find(c=>c.name===action);
 if(clip){mixer=new THREE.AnimationMixer(model);const a=mixer.clipAction(clip);a.setLoop(THREE.LoopOnce,1);a.clampWhenFinished=true;a.play();mixer.setTime(time);}
}
function quantiles(values){values.sort((a,b)=>a-b);return{medianMs:values[Math.floor(values.length*.5)],p95Ms:values[Math.floor(values.length*.95)],maximumMs:values.at(-1)};}
const report={node:process.version,glbSha256:hash(bytes),runtimeSha256:hash(source),measuredAt:new Date().toISOString(),warmupPerWeapon:16,samplesPerWeapon:80,cases:[],scope:'Synchronous loadout.poseAt only: arm solve, morph and finger application. Excludes GLB loading, animation sampling/restoration and rendering. Process CPU time excludes scheduler waits; wall time includes shared host contention and garbage collection. This is not mobile-device or end-to-end FPS measurement.'};
for(const weaponType of ['spear','sword','pike','greatsword']){
 const wall=[],cpu=[];
 for(let i=0;i<96;i++){
  const action=i%3===0?'Guard_Breath':'Spear_Study',time=((i*37)%120)/30;prepare(weaponType,action,time);
  const beforeCPU=process.cpuUsage(),beforeWall=performance.now();loadout.poseAt(action,time);
  const elapsedWall=performance.now()-beforeWall,elapsedCPU=process.cpuUsage(beforeCPU);
  if(i>=16){wall.push(elapsedWall);cpu.push((elapsedCPU.user+elapsedCPU.system)/1000);}
 }
 report.cases.push({weaponType,wall:quantiles(wall),cpu:quantiles(cpu)});
}
report.runtimeUnchanged=hash(await runtimeSource(root))===report.runtimeSha256;
const output=process.env.PAWN_BENCHMARK_REPORT||path.join(root,'review/biomechanics-performance.json');
await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
if(!report.runtimeUnchanged)process.exitCode=1;
