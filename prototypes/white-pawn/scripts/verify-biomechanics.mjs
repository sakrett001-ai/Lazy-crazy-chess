/** CPU acceptance of imported joint frames; independent of runtime diagnostics. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import * as THREE from '../../human-base/node_modules/three/build/three.module.js';
import {GLTFLoader} from '../../human-base/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import {runtimeSource} from './runtime-source.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),repo=path.resolve(root,'../..');
const baseline=process.argv.includes('--baseline'),baselineCommit='2027392830ac69b765d854de1ba5ae9badf3c2e7';
const output=path.resolve(process.env.PAWN_BIOMECHANICS_REPORT||path.join(root,'review',baseline?'biomechanics-baseline-2027392.json':'biomechanics-checks.json'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const oldFile=name=>execFileSync('git',['show',baselineCommit+':prototypes/white-pawn/'+name],{cwd:repo,maxBuffer:64*1024*1024});
const bytes=baseline?oldFile('assets/white-pawn.glb'):await readFile(path.resolve(process.env.PAWN_GLB||path.join(root,'assets/white-pawn.glb')));
const oldRuntime=baseline?oldFile('src/loadout.mjs'):null;
const runtimeBytes=baseline?Buffer.concat([Buffer.from('src/loadout.mjs\n'),oldRuntime,Buffer.from('\n')]):await runtimeSource(root);
let createLoadout;
if(baseline){
 const source=oldRuntime.toString().replace("from 'three'",`from '${new URL('../../human-base/node_modules/three/build/three.module.js',import.meta.url).href}'`);
 ({createLoadout}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64')));
}else ({createLoadout}=await import(pathToFileURL(path.join(root,'src/loadout.mjs')).href));

// Project operating envelope for the demonstration, not population ROM norms.
const limits={minimumElbowFlexDeg:-5,maximumElbowFlexDeg:150,hingePlaneErrorDeg:20,wristBendDeg:35,wristAxialTwistDeg:8,forearmPronationDeg:90,linkLengthErrorM:.0005,gripFrameErrorM:.015,frameJointStepM:.06,frameJointTurnDeg:18,finiteQuaternionNormError:1e-5};
const weapons=['spear','sword','pike','greatsword'],bodyBuilds=['lean','regular','strong'],actions=['rest','Guard_Breath','Shield_Brace','Spear_Study'];
const report={status:'running',glbSha256:hash(bytes),runtimeSha256:hash(runtimeBytes),auditSha256:hash(await readFile(fileURLToPath(import.meta.url))),baseline,sourceCommit:baseline?baselineCommit:null,limits,coverage:{sampleRateHz:30,caseCount:0,frameCount:0,weapons,bodyBuilds,actions},calibration:{},cases:[],checks:[],negativeControls:[],failures:[],scope:'Sampled imported bone positions and rotations, inverse-bind anatomical frames, and exported rigid handle anchors. Signed elbow flexion uses a hinge normal derived from bind upper-arm and forearm landmark vectors; wrist bending uses the bind forearm axis transported through the wrist, relative to the current forearm. Residual axial wrist twist is swing-twist decomposed relative to the actual distal forearm lowerarm02 and its inverse-bind neutral wrist orientation. Legitimate forearm pronation is therefore excluded from wrist twist. Contact anchors do not establish finger closure, thumb opposition or skin clearance. No shoulder scapular contact, full ROM coupling, muscle force, dynamic balance, continuous collision or garment clearance claim.'};
const check=(name,passed,details={})=>{report.checks.push({name,passed:!!passed,...details});if(!passed)report.failures.push(name);};
const V=()=>new THREE.Vector3(),Q=()=>new THREE.Quaternion();
const norm=value=>String(value||'').replace(/[._\-\s]/g,'').toLowerCase(),deg=THREE.MathUtils.radToDeg;
const loader=new GLTFLoader();loader.register(()=>({name:'CPU_BIOMECHANICS_NO_TEXTURE_PIXELS',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
const gltf=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
const model=gltf.scene,bones={},lookup=new Map(),meshes=[];
model.traverse(o=>{if(o.isBone){bones[o.name]=o;lookup.set(norm(o.name),o);}if(o.isMesh)meshes.push(o);});
const bone=name=>{const b=lookup.get(norm(name));if(!b)throw Error('Missing bone '+name);return b;};
const skeletons=[...new Set(meshes.filter(m=>m.isSkinnedMesh).map(m=>m.skeleton))];
const initial=Object.values(bones).map(b=>({b,p:b.position.clone(),q:b.quaternion.clone(),s:b.scale.clone()}));
function update(){model.updateMatrixWorld(true);for(const s of skeletons)s.update();}
function restore(){for(const {b,p,q,s}of initial){b.position.copy(p);b.quaternion.copy(q);b.scale.copy(s);}update();}
function bindMatrix(b){for(const s of skeletons){const i=s.bones.indexOf(b);if(i>=0)return s.boneInverses[i].clone().invert();}throw Error('Missing inverse bind matrix '+b.name);}
const point=b=>b.getWorldPosition(V()),rotation=b=>b.getWorldQuaternion(Q()).normalize(),bindPoint=b=>V().setFromMatrixPosition(bindMatrix(b));
update();
const arm=Object.fromEntries(['L','R'].map(side=>{
 const upper=bone('upperarm01.'+side),lower=bone('lowerarm01.'+side),distal=bone('lowerarm02.'+side),wrist=bone('wrist.'+side),middle=bone('finger3-1.'+side);
 const a=bindPoint(lower).sub(bindPoint(upper)),f=bindPoint(wrist).sub(bindPoint(lower)),hinge=a.clone().cross(f);
 if(hinge.length()<.0001)throw Error('Bind elbow landmarks cannot define anatomical bend sign: '+side);
 const bindUpperQ=Q().setFromRotationMatrix(bindMatrix(upper)).normalize(),bindLowerQ=Q().setFromRotationMatrix(bindMatrix(lower)).normalize(),bindWristQ=Q().setFromRotationMatrix(bindMatrix(wrist)).normalize(),bindDistalQ=Q().setFromRotationMatrix(bindMatrix(distal)).normalize();
 const hingeLocal=hinge.normalize().applyQuaternion(bindUpperQ.clone().invert());
 const wristDistalLocal=f.clone().normalize().applyQuaternion(bindWristQ.clone().invert());
 const palmLocal=bindPoint(middle).sub(bindPoint(wrist)).normalize().applyQuaternion(bindWristQ.clone().invert());
 const neutralWristRelative=bindDistalQ.clone().invert().multiply(bindWristQ);
 const neutralDistalRelative=bindLowerQ.clone().invert().multiply(bindDistalQ),distalAxisLocal=f.clone().normalize().applyQuaternion(bindDistalQ.clone().invert());
 const data={side,upper,lower,distal,wrist,hingeLocal,wristDistalLocal,palmLocal,neutralWristRelative,neutralDistalRelative,distalAxisLocal,upperLengthM:a.length(),forearmLengthM:f.length()};
 report.calibration[side]={upperBone:upper.name,lowerBone:lower.name,distalForearmBone:distal.name,wristBone:wrist.name,upperLengthM:a.length(),forearmLengthM:f.length(),hingeNormalUpperLocal:hingeLocal.toArray(),neutralDistalWristLocal:wristDistalLocal.toArray(),neutralWristRelative:neutralWristRelative.toArray(),neutralDistalRelative:neutralDistalRelative.toArray(),distalAxisLocal:distalAxisLocal.toArray(),bindFlexDeg:deg(a.angleTo(f)),source:'Exported inverse-bind joint origins and rotations; no calibration from current animated guard and no assumed local +Y bone axis.'};
 return[side,data];
}));
function assembly(slot,variant){let result;model.traverse(o=>{if(o.userData?.equipmentSlot===slot&&o.userData?.equipmentVariant===variant)result=o;});if(!result)throw Error('Missing assembly '+slot+'/'+variant);return result;}
function meshOf(object){let result;object.traverse(o=>{if(o.isSkinnedMesh&&!result)result=o;});if(!result)throw Error('Missing skinned assembly mesh');return result;}
function attachedPoint(object,values,side){const mesh=meshOf(object),wrist=arm[side].wrist,i=mesh.skeleton.bones.indexOf(wrist);if(i<0)throw Error('No wrist binding for '+object.name);return V().fromArray(values).applyMatrix4(mesh.bindMatrix).applyMatrix4(mesh.skeleton.boneInverses[i]).applyMatrix4(wrist.matrixWorld).applyMatrix4(mesh.bindMatrixInverse).applyMatrix4(mesh.matrixWorld);}
const handAnchors=Object.fromEntries(['L','R'].map(side=>{const object=assembly(side==='R'?'weapon':'shield',side==='R'?'spear':'tower');if(!Array.isArray(object.userData.gripBind))throw Error('Missing exported gripBind');return[side,arm[side].wrist.worldToLocal(attachedPoint(object,object.userData.gripBind,side))];}));
const loadout=createLoadout({model,bones});
let mixer=null,activeClip=null,active=null;
function freshMixer(){mixer?.stopAllAction();mixer?.uncacheRoot(model);mixer=activeClip?new THREE.AnimationMixer(model):null;active=mixer?.clipAction(activeClip)||null;}
function begin(config,action){mixer?.stopAllAction();mixer?.uncacheRoot(model);mixer=null;restore();loadout.apply(config);activeClip=gltf.animations.find(c=>c.name===action)||null;freshMixer();return activeClip?.duration||0;}
function sample(action,time){
 // PropertyMixer caches its previous output. Restoring bones behind an existing
 // mixer can make unchanged tracks skip reapplication and invent discontinuities.
 // Explicit deactivation/reactivation calls PropertyMixer.saveOriginalState,
 // which resets both accumulation buffers. A fresh-mixer comparison is below.
 mixer?.stopAllAction();restore();
 if(active){active.reset();active.setLoop(THREE.LoopOnce,1);active.clampWhenFinished=true;active.play();mixer.setTime(time);}
 loadout.poseAt(action,time);update();
}
function axialTwistDeg(delta,axis){
 const projection=delta.x*axis.x+delta.y*axis.y+delta.z*axis.z,length=Math.hypot(projection,delta.w);
 // At a 180deg swing twist is indeterminate, so fail conservatively.
 const angle=length<1e-10?180:deg(2*Math.atan2(projection/length,delta.w/length));
 return THREE.MathUtils.euclideanModulo(angle+180,360)-180;
}
function measureArm(side){
 const r=arm[side],shoulder=point(r.upper),elbow=point(r.lower),wrist=point(r.wrist),a=elbow.clone().sub(shoulder),f=wrist.clone().sub(elbow);
 const hinge=r.hingeLocal.clone().applyQuaternion(rotation(r.upper)).normalize(),cross=a.clone().normalize().cross(f.clone().normalize());
 const elbowFlexDeg=deg(Math.atan2(hinge.dot(cross),a.clone().normalize().dot(f.clone().normalize())));
 const hingePlaneErrorDeg=deg(Math.asin(THREE.MathUtils.clamp(Math.abs(f.clone().normalize().dot(hinge)),0,1)));
 const neutralDistal=r.wristDistalLocal.clone().applyQuaternion(rotation(r.wrist)).normalize();
 const expected=rotation(r.distal).multiply(r.neutralWristRelative),delta=expected.invert().multiply(rotation(r.wrist)).normalize();
 const expectedDistal=rotation(r.lower).multiply(r.neutralDistalRelative),distalDelta=expectedDistal.invert().multiply(rotation(r.distal)).normalize();
 return{elbowFlexDeg,hingePlaneErrorDeg,wristBendDeg:deg(neutralDistal.angleTo(f)),wristAxialTwistDeg:axialTwistDeg(delta,r.wristDistalLocal),forearmPronationDeg:axialTwistDeg(distalDelta,r.distalAxisLocal),rawPalmForearmDeg:deg(r.palmLocal.clone().applyQuaternion(rotation(r.wrist)).angleTo(f)),upperLengthErrorM:Math.abs(a.length()-r.upperLengthM),forearmLengthErrorM:Math.abs(f.length()-r.forearmLengthM),shoulder:shoulder.toArray(),elbow:elbow.toArray(),wrist:wrist.toArray(),hingeWorld:hinge.toArray()};
}
function snapshot(weapon){
 const arms={L:measureArm('L'),R:measureArm('R')},object=assembly('weapon',weapon),two=['pike','greatsword'].includes(weapon);
 const gripR=attachedPoint(object,object.userData.gripBind,'R'),gripL=two?attachedPoint(object,object.userData.secondGripBind,'R'):null;
 const actual=Object.fromEntries(['L','R'].map(side=>[side,arm[side].wrist.localToWorld(handAnchors[side].clone())]));
 const joints=Object.fromEntries(['L','R'].flatMap(side=>['upperarm01.','lowerarm01.','lowerarm02.','wrist.','upperleg01.','lowerleg01.','foot.'].map(prefix=>{const b=bone(prefix+side);return[b.name,{p:point(b).toArray(),q:rotation(b).toArray(),rawNormError:Math.abs(b.getWorldQuaternion(Q()).length()-1)}];})));
 const numeric=Object.values(joints).flatMap(j=>[...j.p,...j.q]),finite=numeric.every(Number.isFinite),quaternionNormError=Math.max(...Object.values(joints).map(j=>j.rawNormError));
 return{arms,joints,finite,quaternionNormError,gripFrameErrorM:{R:actual.R.distanceTo(gripR),L:gripL?actual.L.distanceTo(gripL):null}};
}
function step(a,b){let jointStepM=0,jointTurnDeg=0,joint=null;for(const [name,v]of Object.entries(a.joints)){const distance=V().fromArray(v.p).distanceTo(V().fromArray(b.joints[name].p));if(distance>jointStepM){jointStepM=distance;joint=name;}jointTurnDeg=Math.max(jointTurnDeg,deg(Q().fromArray(v.q).angleTo(Q().fromArray(b.joints[name].q))));}return{jointStepM,jointTurnDeg,joint};}
function rotateWorld(b,q){const current=rotation(b),parent=rotation(b.parent);b.quaternion.copy(parent.invert().multiply(q).multiply(current)).normalize();update();}
try{
 for(const bodyBuild of bodyBuilds)for(const weaponType of weapons)for(const action of actions){
  if(action==='Shield_Brace'&&['pike','greatsword'].includes(weaponType))continue;
  const config={bodyBuild,weaponType,shieldType:'tower',armorType:'plate',helmet:'on',beard:'none',experience:'recruit'},duration=begin(config,action),id=[bodyBuild,weaponType,action].join('/');
  const n=Math.round(duration*30),result={id,bodyBuild,weaponType,action,duration,samples:n+1,minimumElbowFlexDeg:Infinity,maximumElbowFlexDeg:-Infinity,maximumHingePlaneErrorDeg:0,maximumWristBendDeg:0,maximumWristAxialTwistDeg:0,maximumForearmPronationDeg:0,maximumLinkLengthErrorM:0,maximumGripFrameErrorM:0,maximumJointStepM:0,maximumJointTurnDeg:0,maximumQuaternionNormError:0,finite:true,worst:{}};
  let previous=null;
  for(let i=0;i<=n;i++){
   const time=n?Math.min(duration,i/30):0;sample(action,time);const s=snapshot(weaponType);report.coverage.frameCount++;result.finite&&=s.finite;result.maximumQuaternionNormError=Math.max(result.maximumQuaternionNormError,s.quaternionNormError);
   for(const [side,a]of Object.entries(s.arms)){
    result.minimumElbowFlexDeg=Math.min(result.minimumElbowFlexDeg,a.elbowFlexDeg);result.maximumElbowFlexDeg=Math.max(result.maximumElbowFlexDeg,a.elbowFlexDeg);
    for(const [key,value]of [['maximumHingePlaneErrorDeg',a.hingePlaneErrorDeg],['maximumWristBendDeg',a.wristBendDeg],['maximumWristAxialTwistDeg',Math.abs(a.wristAxialTwistDeg)],['maximumForearmPronationDeg',Math.abs(a.forearmPronationDeg)],['maximumLinkLengthErrorM',Math.max(a.upperLengthErrorM,a.forearmLengthErrorM)],['maximumGripFrameErrorM',s.gripFrameErrorM[side]||0]])if(value>result[key]){result[key]=value;result.worst[key]={side,time,frame:i,measured:a};}
   }
   if(previous){const d=step(previous,s);for(const [key,value]of [['maximumJointStepM',d.jointStepM],['maximumJointTurnDeg',d.jointTurnDeg]])if(value>result[key]){result[key]=value;result.worst[key]={time,frame:i,...d};}}previous=s;
  }
  report.cases.push(result);report.coverage.caseCount++;
  check(id+': elbow direction and range',result.minimumElbowFlexDeg>=limits.minimumElbowFlexDeg&&result.maximumElbowFlexDeg<=limits.maximumElbowFlexDeg,{minimumDeg:result.minimumElbowFlexDeg,maximumDeg:result.maximumElbowFlexDeg});
  check(id+': hinge plane',result.maximumHingePlaneErrorDeg<=limits.hingePlaneErrorDeg,{maximumDeg:result.maximumHingePlaneErrorDeg});
  check(id+': anatomical neutral wrist',result.maximumWristBendDeg<=limits.wristBendDeg,{maximumDeg:result.maximumWristBendDeg});
  check(id+': no residual axial wrist twist',result.maximumWristAxialTwistDeg<=limits.wristAxialTwistDeg,{maximumDeg:result.maximumWristAxialTwistDeg});
  check(id+': forearm pronation range',result.maximumForearmPronationDeg<=limits.forearmPronationDeg,{maximumDeg:result.maximumForearmPronationDeg});
  check(id+': rigid segment lengths',result.maximumLinkLengthErrorM<=limits.linkLengthErrorM,{maximumErrorM:result.maximumLinkLengthErrorM});
  check(id+': exported grip frame coincidence',result.maximumGripFrameErrorM<=limits.gripFrameErrorM,{maximumErrorM:result.maximumGripFrameErrorM,note:'Anchor coincidence only; the separate surface-grip audit must establish actual finger contact.'});
  check(id+': adjacent 30Hz frames',result.maximumJointStepM<=limits.frameJointStepM&&result.maximumJointTurnDeg<=limits.frameJointTurnDeg,{maximumStepM:result.maximumJointStepM,maximumTurnDeg:result.maximumJointTurnDeg});
  check(id+': finite normalized skeleton',result.finite&&result.maximumQuaternionNormError<=limits.finiteQuaternionNormError,{maximumNormError:result.maximumQuaternionNormError});
  sample(action,duration*.371);const reused=snapshot(weaponType);freshMixer();sample(action,duration*.371);const isolated=snapshot(weaponType),difference=step(reused,isolated);
  check(id+': sampler matches isolated fresh mixer',difference.jointStepM<1e-7&&difference.jointTurnDeg<.0001,{maximumPositionErrorM:difference.jointStepM,maximumAngleErrorDeg:difference.jointTurnDeg});
 }
 const config={bodyBuild:'regular',weaponType:'spear',shieldType:'tower',armorType:'plate'};begin(config,'Guard_Breath');sample('Guard_Breath',0);
 let before,after,a;
 for(const side of ['L','R']){sample('Guard_Breath',0);before=snapshot('spear');a=before.arms[side];rotateWorld(arm[side].lower,new THREE.Quaternion().setFromAxisAngle(V().fromArray(a.hingeWorld),THREE.MathUtils.degToRad(-35-a.elbowFlexDeg)));after=snapshot('spear');report.negativeControls.push({name:'Imported '+side+' lower-arm rotation produces a rejected backward elbow',passed:after.arms[side].elbowFlexDeg<limits.minimumElbowFlexDeg,observedDeg:after.arms[side].elbowFlexDeg});}
 sample('Guard_Breath',0);a=measureArm('R');rotateWorld(arm.R.wrist,new THREE.Quaternion().setFromAxisAngle(V().fromArray(a.hingeWorld),THREE.MathUtils.degToRad(110)));after=snapshot('spear');
 report.negativeControls.push({name:'Imported wrist gross bend is rejected in anatomical bind frame',passed:after.arms.R.wristBendDeg>limits.wristBendDeg,observedDeg:after.arms.R.wristBendDeg});
 sample('Guard_Breath',0);before=snapshot('spear');const forearmAxis=V().fromArray(before.arms.R.wrist).sub(V().fromArray(before.arms.R.elbow)).normalize();rotateWorld(arm.R.wrist,new THREE.Quaternion().setFromAxisAngle(forearmAxis,THREE.MathUtils.degToRad(75)));after=snapshot('spear');
 report.negativeControls.push({name:'75deg wrist twist about actual forearm is rejected independently of wrist bend',passed:Math.abs(after.arms.R.wristAxialTwistDeg)>limits.wristAxialTwistDeg&&Math.abs(before.arms.R.wristBendDeg-after.arms.R.wristBendDeg)<.0001,before:before.arms.R,after:after.arms.R});
 sample('Guard_Breath',0);before=snapshot('spear');const distalAxis=V().fromArray(before.arms.R.wrist).sub(V().fromArray(before.arms.R.elbow)).normalize();rotateWorld(arm.R.distal,new THREE.Quaternion().setFromAxisAngle(distalAxis,THREE.MathUtils.degToRad(130-before.arms.R.forearmPronationDeg)));after=snapshot('spear');
 report.negativeControls.push({name:'130deg distal forearm pronation is rejected without mislabelling it wrist twist',passed:Math.abs(after.arms.R.forearmPronationDeg)>limits.forearmPronationDeg&&Math.abs(before.arms.R.wristAxialTwistDeg-after.arms.R.wristAxialTwistDeg)<.0001,before:before.arms.R,after:after.arms.R});
 sample('Guard_Breath',0);arm.R.lower.position.addScaledVector(arm.R.lower.position.clone().normalize(),.05);update();after=snapshot('spear');
 report.negativeControls.push({name:'50mm imported arm-segment extension is rejected',passed:after.arms.R.upperLengthErrorM>limits.linkLengthErrorM,observedErrorM:after.arms.R.upperLengthErrorM});
 sample('Guard_Breath',0);before=snapshot('spear');const rootPosition=model.position.clone();model.position.x+=.25;update();after=snapshot('spear');const jump=step(before,after);model.position.copy(rootPosition);update();
 report.negativeControls.push({name:'250mm rigid whole-character teleport is rejected without changing bone lengths',passed:jump.jointStepM>limits.frameJointStepM&&Object.values(after.arms).every(a=>a.upperLengthErrorM<limits.linkLengthErrorM&&a.forearmLengthErrorM<limits.linkLengthErrorM),observed:jump});
 for(const c of report.negativeControls)if(!c.passed)report.failures.push('Negative control: '+c.name);
 report.status=report.failures.length?'failed':'passed';
}catch(error){report.status='error';report.failure=error.stack;}
finally{mixer?.stopAllAction();await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,baseline,coverage:report.coverage,failures:report.failures,failure:report.failure,report:output},null,2));if(report.status!=='passed'&&!baseline)process.exitCode=1;}
