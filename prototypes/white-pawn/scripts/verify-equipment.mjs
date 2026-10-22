/** CPU acceptance of exported, skinned GLB surfaces. No browser or authored pose module. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import * as THREE from '../../human-base/node_modules/three/build/three.module.js';
import {GLTFLoader} from '../../human-base/node_modules/three/examples/jsm/loaders/GLTFLoader.js';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const input=path.resolve(process.env.PAWN_GLB||path.join(root,'assets/white-pawn.glb'));
const output=path.resolve(process.env.PAWN_EQUIPMENT_REPORT||path.join(root,'review/equipment-checks.json'));
const bytes=await readFile(input),sha=createHash('sha256').update(bytes).digest('hex');
const limits={footDriftM:.006,floorPenetrationM:.004,soleFloorGapM:.008,pelvisOutsideSupportM:.02,seekSurfaceM:1e-6,seekQuaternionRad:1e-6,endpointM:1e-5,spearElevationDeg:20,spearAdvanceM:.08,spearLateralRatio:.6,spearAttackRotationDeg:12,spearBackwardStepM:.003,shieldBandAdvanceM:.025,shieldVertexAdvanceM:.015};
const phases={Spear_Study:{ready:1.25,attack:1.9},Shield_Brace:{ready:.65,attack:1.65}};
const loader=new GLTFLoader();
// Pixels are irrelevant to CPU skinning; retaining material names and every original accessor.
loader.register(()=>({name:'CPU_ACCEPTANCE_NO_TEXTURE_PIXELS',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
const gltf=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
const scene=gltf.scene,meshes=[],bones=new Map();
scene.traverse(o=>{if(o.isSkinnedMesh)meshes.push(o);if(o.isBone)bones.set(o.name,o);});
const report={status:'running',glbSha256:sha,glbPath:input,limits,phases,checks:[],failures:[],negativeControls:[],scope:'Exported GLB positions, weights, inverse bind matrices and animation tracks evaluated with Three CPU skinning. No renderer. Pelvis projection is only a geometric hip-midpoint/sole-hull proxy, not center of mass or dynamic stability. Does not establish garment/body clearance, thumb opposition, joint comfort or continuous collision freedom.'};
function check(name,ok,details={}){const item={name,passed:!!ok,...details};report.checks.push(item);if(!ok)report.failures.push(name);return ok;}
function update(){scene.updateMatrixWorld(true);for(const m of meshes)m.skeleton.update();}
function vertex(ref){return ref.mesh.getVertexPosition(ref.index,new THREE.Vector3()).applyMatrix4(ref.mesh.matrixWorld);}
function refsFor(mesh){return Array.from({length:mesh.geometry.attributes.position.count},(_,index)=>({mesh,index}));}
const mean=points=>points.reduce((s,p)=>s.add(p),new THREE.Vector3()).multiplyScalar(1/points.length);
const positions=refs=>refs.map(vertex);
const center=refs=>mean(positions(refs));
const id=ref=>`${ref.mesh.name}:${ref.index}`;
let sampler=null;
function clip(name){sampler?.dispose();const c=gltf.animations.find(x=>x.name===name);if(!c)throw Error(`Missing clip ${name}`);const mixer=new THREE.AnimationMixer(scene),action=mixer.clipAction(c);sampler={duration:c.duration,seek(time){mixer.stopAllAction();action.reset();action.setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;action.play();mixer.setTime(Math.max(0,Math.min(c.duration,time)));update();},dispose(){mixer.stopAllAction();mixer.uncacheRoot(scene);}};sampler.seek(0);return sampler;}
function inheritedTag(mesh,key){for(let o=mesh;o;o=o.parent)if(o.userData?.[key]!==undefined)return o.userData[key];return undefined;}
function onlyMesh(prefix,material){
 const slot=prefix==='SPEAR_'?'weapon':prefix==='SHIELD_'?'shield':null,variant=prefix==='SPEAR_'?'spear':prefix==='SHIELD_'?'tower':null;
 const matches=meshes.filter(m=>m.material.name===material&&(inheritedTag(m,'equipmentSlot')===slot?inheritedTag(m,'equipmentVariant')===variant:m.name.startsWith(prefix)));
 if(matches.length!==1)throw Error(`Expected one ${prefix}/${material}, found ${matches.map(m=>m.name).join(',')}`);return matches[0];
}
function quaternionState(){return [...bones].map(([name,b])=>({name,value:b.getWorldQuaternion(new THREE.Quaternion()).toArray()}));}
function quaternionError(a,b){return Math.max(...a.map((x,i)=>{const qa=new THREE.Quaternion().fromArray(x.value).normalize(),qb=new THREE.Quaternion().fromArray(b[i].value).normalize();return qa.angleTo(qb);}));}
function surfaceError(a,b){return Math.max(...a.map((p,i)=>p.distanceTo(b[i])));}
const normName=n=>n.replace(/[._-]/g,'').toLowerCase();
function bone(name){const b=[...bones.values()].find(b=>normName(b.name)===normName(name));if(!b)throw Error(`Missing bone ${name}`);return b;}
function weightTo(ref,boneName){const g=ref.mesh.geometry,s=g.attributes.skinIndex,w=g.attributes.skinWeight;let sum=0;for(let j=0;j<4;j++)if(normName(ref.mesh.skeleton.bones[s.getComponent(ref.index,j)]?.name||'')===normName(boneName))sum+=w.getComponent(ref.index,j);return sum;}
function footAnchors(side){const all=meshes.flatMap(m=>refsFor(m)).filter(r=>weightTo(r,`foot${side}`)>.95);if(!all.length)throw Error(`No rigid foot${side} surface`);const floor=Math.min(...all.map(r=>vertex(r).y));const refs=all.filter(r=>vertex(r).y<floor+.006);if(refs.length<12)throw Error(`Too few foot${side} sole vertices: ${refs.length}`);return{refs,floor};}
function footDrift(anchors,baseline){let max=0,worst=null,minY=Infinity;anchors.forEach((r,i)=>{const p=vertex(r),d=p.distanceTo(baseline[i]);minY=Math.min(minY,p.y);if(d>max){max=d;worst=id(r);}});return{maxDriftM:max,worstVertex:worst,minY};}
function supportMargin(soleRefs){
 const pts=positions(soleRefs).map(p=>[p.x,p.z]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
 const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
 const chain=list=>{const out=[];for(const p of list){while(out.length>=2&&cross(out.at(-2),out.at(-1),p)<=0)out.pop();out.push(p);}return out;};
 const lower=chain(pts),upper=chain([...pts].reverse()),hull=[...lower.slice(0,-1),...upper.slice(0,-1)];
 if(hull.length<3)throw Error('Sole support hull is degenerate');
 const hip=mean(['upperleg01L','upperleg01R'].map(n=>bone(n).getWorldPosition(new THREE.Vector3()))),p=[hip.x,hip.z];
 const margin=Math.min(...hull.map((a,i)=>{const b=hull[(i+1)%hull.length];return cross(a,b,p)/Math.hypot(b[0]-a[0],b[1]-a[1]);}));
 return{signedMarginM:margin,hipMidpointXZ:p,hullXZ:hull};
}
function shaftState(anchors){const lo=center(anchors.low),hi=center(anchors.high);return{axis:hi.clone().sub(lo).normalize(),tip:center(anchors.tip),grip:center(anchors.grip)};}
function thrustMetrics(a,b){const axis=a.axis.clone().add(b.axis).normalize(),delta=b.tip.clone().sub(a.tip),advance=delta.dot(axis),lateral=delta.clone().addScaledVector(axis,-advance).length();return{advanceM:advance,forwardAdvanceM:delta.z,lateralM:lateral,lateralRatio:lateral/Math.max(advance,1e-9),readyElevationDeg:Math.asin(Math.min(1,Math.abs(a.axis.y)))*180/Math.PI,attackElevationDeg:Math.asin(Math.min(1,Math.abs(b.axis.y)))*180/Math.PI,readyForwardAxis:a.axis.z,attackForwardAxis:b.axis.z,shaftRotationDeg:a.axis.angleTo(b.axis)*180/Math.PI};}
const thrustPass=m=>m.advanceM>=limits.spearAdvanceM&&m.forwardAdvanceM>=limits.spearAdvanceM&&m.lateralRatio<=limits.spearLateralRatio&&m.readyElevationDeg<=limits.spearElevationDeg&&m.attackElevationDeg<=limits.spearElevationDeg&&m.readyForwardAxis>.8&&m.attackForwardAxis>.8;
function shieldMetrics(a,b,bandIndices){const advances=b.map((p,i)=>p.z-a[i].z),bands=Object.fromEntries(Object.entries(bandIndices).map(([name,ids])=>[name,ids.reduce((s,i)=>s+advances[i],0)/ids.length]));return{bandAdvanceM:bands,minVertexAdvanceM:Math.min(...advances),forwardVertexFraction:advances.filter(x=>x>=limits.shieldVertexAdvanceM).length/advances.length,centroidAdvanceM:advances.reduce((a,b)=>a+b,0)/advances.length};}
const shieldPass=m=>Object.values(m.bandAdvanceM).every(v=>v>=limits.shieldBandAdvanceM)&&m.forwardVertexFraction>=.95;
function mutateBoneWorld(b,rotation,pivot,desiredPivot){const oldP=b.position.clone(),oldQ=b.quaternion.clone();const parentQ=b.parent.getWorldQuaternion(new THREE.Quaternion()),worldQ=b.getWorldQuaternion(new THREE.Quaternion());b.quaternion.copy(parentQ.clone().invert().multiply(rotation.clone().multiply(worldQ)));update();if(pivot&&desiredPivot){const now=center(pivot),delta=desiredPivot.clone().sub(now),world=b.getWorldPosition(new THREE.Vector3()).add(delta);b.position.copy(b.parent.worldToLocal(world));update();}return()=>{b.position.copy(oldP);b.quaternion.copy(oldQ);update();};}

try{
 clip('Guard_Breath');
 const feet=Object.fromEntries(['L','R'].map(s=>[s,footAnchors(s)]));
 const guardFoot=Object.fromEntries(Object.entries(feet).map(([s,f])=>[s,positions(f.refs)]));
 const shaftRefs=refsFor(onlyMesh('SPEAR_','weapon.wood')),shaftYs=shaftRefs.map(r=>vertex(r).y),minS=Math.min(...shaftYs),maxS=Math.max(...shaftYs);
 const metalRefs=refsFor(onlyMesh('SPEAR_','weapon.metal')),maxTip=Math.max(...metalRefs.map(r=>vertex(r).y));
 const spear={low:shaftRefs.filter((r,i)=>shaftYs[i]<minS+1e-5),high:shaftRefs.filter((r,i)=>shaftYs[i]>maxS-1e-5),tip:metalRefs.filter(r=>vertex(r).y>maxTip-1e-5),grip:refsFor(onlyMesh('SPEAR_','weapon.grip'))};
 const shield=refsFor(onlyMesh('SHIELD_','shield.face')),shieldYs=shield.map(r=>vertex(r).y),lo=Math.min(...shieldYs),hi=Math.max(...shieldYs),h=hi-lo;
 const bands={upper:[],middle:[],lower:[]};shieldYs.forEach((y,i)=>{const t=(y-lo)/h;if(t>.8)bands.upper.push(i);if(t>.4&&t<.6)bands.middle.push(i);if(t<.2)bands.lower.push(i);});
 report.anchors={feet:Object.fromEntries(Object.entries(feet).map(([s,f])=>[s,{count:f.refs.length,floorM:f.floor,examples:f.refs.slice(0,4).map(id)}])),spear:{low:spear.low.length,high:spear.high.length,tip:spear.tip.map(id),grip:spear.grip.length},shield:{count:shield.length,bands:Object.fromEntries(Object.entries(bands).map(([k,v])=>[k,v.length]))}};
 const representative=[...feet.L.refs,...feet.R.refs,...spear.low,...spear.high,...spear.tip,...shield.filter((r,i)=>i%23===0)];
 for(const animation of gltf.animations){
  clip(animation.name);const initial=positions(representative),worst={L:{maxDriftM:0,minY:Infinity,maxSoleFloorGapM:-Infinity},R:{maxDriftM:0,minY:Infinity,maxSoleFloorGapM:-Infinity}};let support={signedMarginM:Infinity},maxQuaternionNormError=0;
  for(let frame=0;frame<=Math.round(animation.duration*30);frame++){sampler.seek(frame/30);for(const side of ['L','R']){const result=footDrift(feet[side].refs,guardFoot[side]);worst[side].minY=Math.min(worst[side].minY,result.minY);worst[side].maxSoleFloorGapM=Math.max(worst[side].maxSoleFloorGapM,result.minY);if(result.maxDriftM>worst[side].maxDriftM)worst[side]={...worst[side],...result,time:frame/30,frame,minY:worst[side].minY};}const m=supportMargin([...feet.L.refs,...feet.R.refs]);if(m.signedMarginM<support.signedMarginM)support={...m,time:frame/30,frame};for(const b of bones.values())maxQuaternionNormError=Math.max(maxQuaternionNormError,Math.abs(b.quaternion.length()-1));}
  for(const side of ['L','R'])check(`${animation.name}: planted ${side} sole surface`,worst[side].maxDriftM<=limits.footDriftM&&worst[side].minY>=-limits.floorPenetrationM&&worst[side].maxSoleFloorGapM<=limits.soleFloorGapM,worst[side]);
  check(`${animation.name}: sampled quaternion norms`,Number.isFinite(maxQuaternionNormError)&&maxQuaternionNormError<1e-5,{maxNormError:maxQuaternionNormError});
  check(`${animation.name}: pelvis projection support proxy`,support.signedMarginM>=-limits.pelvisOutsideSupportM,{...support,note:'Hip-joint midpoint projected onto actual sole hull; up to20mm outside allowed. This is not a center-of-mass or dynamic balance model.'});
  sampler.seek(animation.duration);const endpoint=surfaceError(initial,positions(representative));check(`${animation.name}: surface endpoint returns`,endpoint<=limits.endpointM,{maxErrorM:endpoint});
  const target=animation.duration*.371;sampler.seek(target);const expected=positions(representative),expectedQ=quaternionState();let maxSurface=0,maxQ=0;
  for(const t of [animation.duration,0,animation.duration*.91,animation.duration*.12,target,animation.duration*.71]){sampler.seek(t);sampler.seek(target);maxSurface=Math.max(maxSurface,surfaceError(expected,positions(representative)));maxQ=Math.max(maxQ,quaternionError(expectedQ,quaternionState()));}
  check(`${animation.name}: arbitrary seek is deterministic`,maxSurface<=limits.seekSurfaceM&&maxQ<=limits.seekQuaternionRad,{maxSurfaceErrorM:maxSurface,maxQuaternionAngleRad:maxQ});
 }
 clip('Spear_Study');sampler.seek(phases.Spear_Study.ready);const spearReady=shaftState(spear);sampler.seek(phases.Spear_Study.attack);const spearAttack=shaftState(spear),thrust=thrustMetrics(spearReady,spearAttack);check('Spear: axial attack after horizontal preparation',thrustPass(thrust),thrust);
 const phaseTimes=[phases.Spear_Study.ready,...Array.from({length:Math.floor(phases.Spear_Study.attack*30)-Math.ceil(phases.Spear_Study.ready*30)+1},(_,i)=>(Math.ceil(phases.Spear_Study.ready*30)+i)/30),phases.Spear_Study.attack];
 let priorTip=spearReady.tip.clone(),maxElevation=0,maxRotation=0,minAxialStep=Infinity;
 for(const time of phaseTimes){sampler.seek(time);const s=shaftState(spear);maxElevation=Math.max(maxElevation,Math.asin(Math.min(1,Math.abs(s.axis.y)))*180/Math.PI);maxRotation=Math.max(maxRotation,spearReady.axis.angleTo(s.axis)*180/Math.PI);minAxialStep=Math.min(minAxialStep,s.tip.clone().sub(priorTip).dot(spearReady.axis));priorTip.copy(s.tip);}
 check('Spear: attack phase stays horizontal and advances without reversal',maxElevation<=limits.spearElevationDeg&&maxRotation<=limits.spearAttackRotationDeg&&minAxialStep>=-limits.spearBackwardStepM,{samples:phaseTimes.length,maxElevationDeg:maxElevation,maxShaftRotationDeg:maxRotation,minAxialStepM:minAxialStep});
 clip('Shield_Brace');sampler.seek(phases.Shield_Brace.ready);const shieldReady=positions(shield);sampler.seek(phases.Shield_Brace.attack);const shieldAttack=positions(shield),push=shieldMetrics(shieldReady,shieldAttack,bands);check('Shield: upper middle and lower face advance together',shieldPass(push),push);
 // Negative controls modify an actual imported skeleton, then re-skin actual exported vertices.
 clip('Guard_Breath');const baseline=positions(feet.L.refs),foot=bone('footL'),savedFoot=foot.position.clone();foot.position.x+=.05;update();const displaced=footDrift(feet.L.refs,baseline);foot.position.copy(savedFoot);update();report.negativeControls.push({name:'50mm foot-bone displacement is rejected by sole vertices',passed:displaced.maxDriftM>limits.footDriftM,observedDriftM:displaced.maxDriftM});
 clip('Spear_Study');sampler.seek(phases.Spear_Study.attack);const current=shaftState(spear),vertical=new THREE.Quaternion().setFromUnitVectors(current.axis,new THREE.Vector3(0,1,0)),restoreSpear=mutateBoneWorld(bone('wristR'),vertical);const verticalAttack=shaftState(spear),badThrust=thrustMetrics(spearReady,verticalAttack);restoreSpear();report.negativeControls.push({name:'Verticalized exported spear is rejected',passed:!thrustPass(badThrust)&&badThrust.attackElevationDeg>80,observed:badThrust});
 clip('Shield_Brace');sampler.seek(phases.Shield_Brace.ready);const upperRefs=bands.upper.map(i=>shield[i]),upperStart=center(upperRefs);const restoreShield=mutateBoneWorld(bone('wristL'),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),-.4),upperRefs,upperStart);const hinged=shieldMetrics(shieldReady,positions(shield),bands);restoreShield();report.negativeControls.push({name:'Shield hinged about upper edge is rejected',passed:!shieldPass(hinged)&&Math.abs(hinged.bandAdvanceM.upper)<1e-5,observed:hinged});
 for(const c of report.negativeControls)if(!c.passed)report.failures.push(`Negative control: ${c.name}`);
 check('All imported bone quaternions are finite and unit length',[...bones.values()].every(b=>[b.quaternion.x,b.quaternion.y,b.quaternion.z,b.quaternion.w].every(Number.isFinite)&&Math.abs(b.quaternion.length()-1)<1e-5));
 report.status=report.failures.length?'failed':'passed';
}catch(error){report.status='error';report.failure=error.stack;}
finally{sampler?.dispose();await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,sha256:sha,failures:report.failures,failure:report.failure,report:output},null,2));if(report.status!=='passed')process.exitCode=1;}
