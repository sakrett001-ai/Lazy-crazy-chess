import * as THREE from 'three';
import {createArmBiomechanics} from './biomechanics.mjs';
import {createGrip} from './grip.mjs';
import {createFullBodyMotion} from './full-body.mjs';
import {TWO_HANDED,WEAPON_NAMES,RUNTIME_WEAPONS,gripRadiusOf,attachRuntimeWeapons} from './weapons.mjs';

// Equipment and body shape are independent of material colours. The authored
// clips supply the planted stance. The thrust redistributes its drive through
// knees and thorax; arms are reconstructed in anatomical frames afterwards.
const normalize=value=>String(value||'').replace(/[._\-\s]/g,'').toLowerCase();
const V=values=>new THREE.Vector3().fromArray(values);
const twoHanded=TWO_HANDED,weaponNames=WEAPON_NAMES;
const shieldNames={tower:'ростовой щит',round:'круглый щит',heater:'треугольный щит',none:'без щита'};
const defaults={armorType:'plate',shieldType:'tower',weaponType:'spear',bodyBuild:'regular',experience:'recruit',beard:'none',helmet:'on'};
const smooth=(t,start,end)=>{const u=THREE.MathUtils.clamp((t-start)/(end-start),0,1);return u*u*u*(u*(u*6-15)+10);};
const envelope=(t,start,peak,hold,end)=>smooth(t,start,peak)*(1-smooth(t,hold,end));
export function loadoutPhases(action,time){return action==='Spear_Study'?{aim:envelope(time,.55,1.2,2.8,3.75),thrust:envelope(time,1.25,1.9,2.1,2.8)}:{aim:0,thrust:0};}

// extraWeapons: runtime weapons to add (weapons.mjs: bastard, warhammer). The
// pawn workshop keeps its GLB catalogue; the board's bishop and rook ask for
// their own.
export function createLoadout({model,bones={},extraWeapons=[]}){
 if(extraWeapons.length)attachRuntimeWeapons(THREE,{model,types:extraWeapons});
 const lookup=new Map(),meshes=[],entries=[];
 model.traverse(object=>{if(object.isBone)lookup.set(normalize(object.name),object);if(object.isMesh)meshes.push(object);});
 for(const [name,bone]of Object.entries(bones))lookup.set(normalize(name),bone);
 const bone=name=>{const result=lookup.get(normalize(name));if(!result)throw Error('Отсутствует кость: '+name);return result;};
 const skeletons=[...new Set(meshes.filter(mesh=>mesh.isSkinnedMesh).map(mesh=>mesh.skeleton))];
 function update(){model.updateMatrixWorld(true);for(const skeleton of skeletons)skeleton.update();}
 update();
 function tag(object){
  const data=object.userData||{};
  if(data.equipmentSlot)return{slot:data.equipmentSlot,variant:data.equipmentVariant||''};
  // The baseline remains loadable while its modular asset is being rebuilt.
  if(object.name==='SPEAR_Assembly')return{slot:'weapon',variant:'spear'};
  if(object.name==='SHIELD_Assembly')return{slot:'shield',variant:'tower'};
  return null;
 }
 model.traverse(object=>{const data=tag(object);if(data)entries.push({object,...data});});
 const weapons=new Map(entries.filter(entry=>entry.slot==='weapon').map(entry=>[entry.variant,entry.object]));
 const shields=new Map(entries.filter(entry=>entry.slot==='shield').map(entry=>[entry.variant,entry.object]));
 const firstMesh=object=>{let found=null;object?.traverse(child=>{if(!found&&child.isSkinnedMesh)found=child;});return found;};
 function skinPoint(mesh,point,side='R'){
  if(!mesh?.isSkinnedMesh)return point.clone().applyMatrix4(mesh?.matrixWorld||new THREE.Matrix4());
  const index=mesh.skeleton.bones.indexOf(bone('wrist.'+side));
  if(index<0)throw Error('Нет привязки оружия к кисти '+side);
  return point.clone().applyMatrix4(mesh.bindMatrix).applyMatrix4(mesh.skeleton.boneInverses[index]).applyMatrix4(mesh.skeleton.bones[index].matrixWorld).applyMatrix4(mesh.bindMatrixInverse).applyMatrix4(mesh.matrixWorld);
 }
 function frameFor(object,side='R'){
  if(!object)return null;
  const mesh=firstMesh(object),data=object.userData||{};
  let grip,axis,tip,second=null,points=null;
  if(Array.isArray(data.gripBind)&&Array.isArray(data.shaftAxisBind||data.handleAxisBind)){
   const bindGrip=V(data.gripBind),bindAxis=V(data.shaftAxisBind||data.handleAxisBind).normalize();
   grip=skinPoint(mesh,bindGrip,side);axis=skinPoint(mesh,bindGrip.clone().add(bindAxis),side).sub(grip).normalize();
   tip=Array.isArray(data.tipBind)?skinPoint(mesh,V(data.tipBind),side):grip.clone().addScaledVector(axis,1);
   if(Array.isArray(data.secondGripBind))second=skinPoint(mesh,V(data.secondGripBind),side);
   if(Array.isArray(data.clearanceBind))points=data.clearanceBind.map(q=>[skinPoint(mesh,V(q.slice(0,3)),side),q[3]]);
  }else{
   // Exact guard frames from the preserved baseline's authored equipment.
   const guardGrip=V(side==='R'?[-.28447413444519043,1.1486186981201172,.334890753030777]:[.00598069466650486,1.1586185693740845,.21028414368629456]);
   const wrist=bone('wrist.'+side),calibration=initialWristFrames?.[side];
   const transform=calibration?wrist.matrixWorld.clone().multiply(calibration.clone().invert()):new THREE.Matrix4();
   grip=guardGrip.applyMatrix4(transform);axis=new THREE.Vector3(0,1,0).transformDirection(transform);tip=grip.clone().addScaledVector(axis,side==='R'?1.63:0);
  }
  return{grip,axis,tip,second,points,mesh,object};
 }
 // The plate's outer envelope around the body (m): chest 17, head with
 // helmet 14, thigh 9 cm, the same capsules the strike checks use.
 const ARMOUR=[['spine05','neck01',.17],['neck03','head',.14],['upperleg01.L','lowerleg01.L',.09],['upperleg01.R','lowerleg01.R',.09]];
 function armourClearance(){
  const f=frameFor(weapons.get(current.weaponType));if(!f||!f.points)return{clearance:Infinity,push:new THREE.Vector3()};
  let clearance=Infinity,push=new THREE.Vector3();
  for(const[a,b,r]of ARMOUR){const A=bone(a).getWorldPosition(new THREE.Vector3()),B=bone(b).getWorldPosition(new THREE.Vector3()),AB=B.clone().sub(A);
   for(const[p,w]of f.points){const near=A.clone().addScaledVector(AB,THREE.MathUtils.clamp(p.clone().sub(A).dot(AB)/AB.lengthSq(),0,1)),d=p.distanceTo(near)-r-w;
    if(d<clearance){clearance=d;push=p.clone().sub(near).normalize();}}}
  return{clearance,push};
 }
 const initialWristFrames=Object.fromEntries(['L','R'].map(side=>[side,bone('wrist.'+side).matrixWorld.clone()]));
 const handReference=Object.fromEntries(['L','R'].map(side=>{
  const wrist=bone('wrist.'+side),frame=frameFor(side==='R'?weapons.get('spear'):shields.get('tower'),side);
  const grip=frame?.grip||V(side==='R'?[-.28447413444519043,1.1486186981201172,.334890753030777]:[.00598069466650486,1.1586185693740845,.21028414368629456]);
  return[side,{gripLocal:wrist.worldToLocal(grip.clone()),quaternion:wrist.getWorldQuaternion(new THREE.Quaternion()),axis:frame?.axis||new THREE.Vector3(0,1,0)}];
 }));
 const feet=Object.fromEntries(['L','R'].map(side=>[side,bone('foot.'+side).getWorldPosition(new THREE.Vector3())]));
 const armBiomechanics=createArmBiomechanics({model,bones,handReference,update});
 const fullBodyMotion=createFullBodyMotion({model,bones,update});
 let current={...defaults},lastAction='rest',lastTime=0,reachErrors={},wristMissM=null;
 const diagonalGripAngle=35*Math.PI/180;
 const toolAxisLocal=side=>handReference[side].axisLocal.clone().multiplyScalar(Math.cos(diagonalGripAngle)).addScaledVector(handReference[side].forwardLocal,Math.sin(diagonalGripAngle)).normalize();
 // The catalogue GLB retains its original transverse handles. In the viewer
 // rigid weapon vertices, normals and attachment metadata share this one
 // wrist-local rebind, giving the fist a diagonal power grip.
 for(const object of weapons.values()){
  if(object.userData.runtimeDiagonalGripDegrees===35||!object.userData.gripBind||!object.userData.shaftAxisBind)continue;
  const oldAxis=handReference.R.axisLocal,newAxis=toolAxisLocal('R'),rotation=new THREE.Quaternion().setFromUnitVectors(oldAxis,newAxis);
  const pivot=handReference.R.gripLocal,local=new THREE.Matrix4().makeRotationFromQuaternion(rotation);
  local.setPosition(pivot.clone().sub(pivot.clone().applyQuaternion(rotation)));
  let metadataTransform=null;
  object.traverse(mesh=>{if(!mesh.isSkinnedMesh)return;
   const index=mesh.skeleton.bones.indexOf(bone('wrist.R')),toWrist=mesh.skeleton.boneInverses[index].clone().multiply(mesh.bindMatrix);
   const transform=toWrist.clone().invert().multiply(local).multiply(toWrist);
   metadataTransform??=transform;mesh.geometry=mesh.geometry.clone();mesh.geometry.applyMatrix4(transform);
   mesh.geometry.computeBoundingBox();mesh.geometry.computeBoundingSphere();
  });
  if(metadataTransform){const data=object.userData,g=V(data.gripBind),axis=V(data.shaftAxisBind).add(g).applyMatrix4(metadataTransform);
   data.gripBind=g.applyMatrix4(metadataTransform).toArray();data.shaftAxisBind=axis.sub(g).normalize().toArray();
   for(const key of ['tipBind','secondGripBind'])if(data[key])data[key]=V(data[key]).applyMatrix4(metadataTransform).toArray();
   if(data.clearanceBind)data.clearanceBind=data.clearanceBind.map(q=>[...V(q.slice(0,3)).applyMatrix4(metadataTransform).toArray(),q[3]]);
   data.runtimeDiagonalGripDegrees=35;
  }
 }
 // Only the catalogue's two leather enarmes deform. Their eight shield-side
 // mount vertices remain wrist-bound; the 17-sample loops route around the
 // real vambrace envelope instead of inheriting an incompatible wrist bend.
 function createEnarmeFitter(){
  const ancestor=(object,key)=>{for(;object;object=object.parent)if(object.userData?.[key]!==undefined)return object.userData[key];};
  const components=mesh=>{
   const g=mesh.geometry,n=g.attributes.position.count,parent=Array.from({length:n},(_,i)=>i),find=i=>{while(parent[i]!==i)i=parent[i];return i;},join=(a,b)=>{parent[find(b)]=find(a);},positions=new Map();
   for(let i=0;i<n;i++){const key=new THREE.Vector3().fromBufferAttribute(g.attributes.position,i).toArray().map(v=>Math.round(v*1e6)).join(',');if(positions.has(key))join(i,positions.get(key));else positions.set(key,i);}
   for(let i=0;i<g.index.count;i+=3){join(g.index.getX(i),g.index.getX(i+1));join(g.index.getX(i),g.index.getX(i+2));}
   const groups=new Map();for(let i=0;i<n;i++){const id=find(i);if(!groups.has(id))groups.set(id,[]);groups.get(id).push(i);}return[...groups.values()];
  };
  const bands=[];
  for(const mesh of meshes){
   if(!mesh.isSkinnedMesh||ancestor(mesh,'equipmentSlot')!=='shield'||mesh.material.name!=='shield.leather')continue;
   const loops=components(mesh).filter(indices=>indices.length===76);if(loops.length!==2)throw Error('Unexpected shield enarme topology: '+mesh.name);
   mesh.geometry=mesh.geometry.clone();mesh.geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);mesh.geometry.attributes.normal.setUsage(THREE.DynamicDrawUsage);
   for(const indices of loops){if(indices.some((id,j)=>id!==indices[0]+j))throw Error('Unordered shield enarme topology: '+mesh.name);
    bands.push({mesh,variant:ancestor(mesh,'equipmentVariant'),indices,original:indices.map(i=>new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position,i))});
   }
  }
  if(!bands.length)return()=>{};
  const forearm=bone('lowerarm01.L'),wrist=bone('wrist.L'),origin=forearm.getWorldPosition(new THREE.Vector3()),axis=wrist.getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
  const across=bone('finger2-1.L').getWorldPosition(new THREE.Vector3()).sub(bone('finger5-1.L').getWorldPosition(new THREE.Vector3()));across.addScaledVector(axis,-across.dot(axis)).normalize();
  const back=axis.clone().cross(across),initialInverse=forearm.getWorldQuaternion(new THREE.Quaternion()).invert(),localAxis=axis.clone().applyQuaternion(initialInverse),localAcross=across.clone().applyQuaternion(initialInverse),localBack=back.clone().applyQuaternion(initialInverse);
  const step=.005,start=-.05,profile=Array(80).fill(.055);
  // Triangle radial bounds are conservative. Include all body morphs once;
  // the 55 mm minimum continues the open wrist end of the bracer envelope.
  for(const mesh of meshes){
   if(!mesh.isSkinnedMesh||ancestor(mesh,'equipmentSlot')!=='plate')continue;
   const g=mesh.geometry,faces=[];
   for(let i=0;i<g.index.count;i+=3){const ids=[g.index.getX(i),g.index.getX(i+1),g.index.getX(i+2)];let influence=0;
    for(const id of ids)for(let k=0;k<4;k++)if(/^lowerarm0[12]l$/.test(normalize(mesh.skeleton.bones[g.attributes.skinIndex.getComponent(id,k)].name)))influence+=g.attributes.skinWeight.getComponent(id,k);
    if(influence>1.5)faces.push(ids);
   }
   if(!faces.length)continue;
   const saved=mesh.morphTargetInfluences?.slice(),unique=[...new Set(faces.flat())];
   for(const build of ['regular','lean','strong']){
    for(const [name,index]of Object.entries(mesh.morphTargetDictionary||{}))if(['lean','strong'].includes(normalize(name)))mesh.morphTargetInfluences[index]=normalize(name)===build?1:0;
    const points=new Map(unique.map(i=>{const p=mesh.getVertexPosition(i,new THREE.Vector3()).applyMatrix4(mesh.matrixWorld).sub(origin),z=p.dot(axis);return[i,{z,r:p.addScaledVector(axis,-z).length()}];}));
    for(const face of faces){const p=face.map(i=>points.get(i)),lo=Math.max(0,Math.floor((Math.min(...p.map(v=>v.z))-start)/step)),hi=Math.min(profile.length-1,Math.ceil((Math.max(...p.map(v=>v.z))-start)/step)),radius=Math.max(...p.map(v=>v.r));for(let j=lo;j<=hi;j++)profile[j]=Math.max(profile[j],radius);}
   }
   if(saved)mesh.morphTargetInfluences.splice(0,saved.length,...saved);
  }
  const envelope=profile.map((r,i)=>Math.max(r,profile[Math.max(0,i-1)],profile[Math.min(profile.length-1,i+1)]));
  const radiusAt=z=>{const t=THREE.MathUtils.clamp((z-start)/step,0,envelope.length-1.000001),i=Math.floor(t);return THREE.MathUtils.lerp(envelope[i],envelope[i+1],t-i);};
  const skinMatrix=mesh=>{const index=mesh.skeleton.bones.indexOf(wrist);return mesh.matrixWorld.clone().multiply(mesh.bindMatrixInverse).multiply(wrist.matrixWorld).multiply(mesh.skeleton.boneInverses[index]).multiply(mesh.bindMatrix);};
  return variant=>{
   if(variant==='none')return;
   const rotation=forearm.getWorldQuaternion(new THREE.Quaternion()),a=localAxis.clone().applyQuaternion(rotation),x=localAcross.clone().applyQuaternion(rotation),y=localBack.clone().applyQuaternion(rotation),e=forearm.getWorldPosition(new THREE.Vector3()),changed=new Set();
   for(const band of bands){if(band.variant!==variant)continue;const {mesh,indices,original}=band,g=mesh.geometry,skin=skinMatrix(mesh),inverse=skin.clone().invert();
    for(let surface=0;surface<2;surface++)for(let edge=0;edge<2;edge++){
     const offset=surface*38+edge,m0=original[offset].clone().applyMatrix4(skin).sub(e),m1=original[offset+36].clone().applyMatrix4(skin).sub(e),z0=m0.dot(a),z1=m1.dot(a),angle=Math.atan2(m0.dot(y),m0.dot(x)),end=Math.atan2(m1.dot(y),m1.dot(x)),sweep=(end-angle+2*Math.PI)%(2*Math.PI);
     for(let j=0;j<17;j++){const u=j/16,z=THREE.MathUtils.lerp(z0,z1,u),theta=angle+sweep*u,radius=radiusAt(z)+.008+surface*.004;
      const p=e.clone().addScaledVector(a,z).addScaledVector(x,radius*Math.cos(theta)).addScaledVector(y,radius*Math.sin(theta)).applyMatrix4(inverse);g.attributes.position.setXYZ(indices[offset+2*(j+1)],p.x,p.y,p.z);
     }
    }
    changed.add(mesh);
   }
   for(const mesh of changed){mesh.geometry.attributes.position.needsUpdate=true;mesh.geometry.computeVertexNormals();mesh.geometry.computeBoundingBox();mesh.geometry.computeBoundingSphere();}
  };
 }
 const fitEnarmes=createEnarmeFitter();
 const gripController=createGrip({model,bones,frames:()=>gripFrames()});
 function summary(){return{...current,selectedShield:current.shieldType,effectiveShield:twoHanded.has(current.weaponType)?'none':current.shieldType,twoHanded:twoHanded.has(current.weaponType)};}
 function applyMorphs(){
  for(const mesh of meshes){
   if(!mesh.morphTargetDictionary||!mesh.morphTargetInfluences)continue;
   for(const [name,index]of Object.entries(mesh.morphTargetDictionary)){
    const key=normalize(name);
    if(['lean','bodylean','buildlean'].includes(key))mesh.morphTargetInfluences[index]=current.bodyBuild==='lean'?1:0;
    if(['strong','bodystrong','buildstrong'].includes(key))mesh.morphTargetInfluences[index]=current.bodyBuild==='strong'?1:0;
    if(['veteran','faceveteran','experienceveteran'].includes(key))mesh.morphTargetInfluences[index]=current.experience==='veteran'?1:0;
   }
  }
 }
 function apply(settings={}){
  current={...defaults,...settings};const state=summary();
  if(!weapons.has(current.weaponType))throw Error('В модели отсутствует вариант оружия: '+current.weaponType);
  if(state.effectiveShield!=='none'&&!shields.has(state.effectiveShield))throw Error('В модели отсутствует вариант щита: '+state.effectiveShield);
  for(const {object,slot,variant}of entries){
   if(slot==='weapon')object.visible=variant===current.weaponType;
   else if(slot==='shield')object.visible=variant===state.effectiveShield;
   else if(slot==='armor'||slot==='plate')object.visible=current.armorType==='plate';
   else if(slot==='mail')object.visible=current.armorType==='mail';
   // Padding split off under an opaque outer layer is hidden while that layer is worn.
   else if(slot==='padding')object.visible=!String(object.userData?.hiddenUnder||'').split(',').includes(current.armorType);
   else if(slot==='base'||slot==='body')object.visible=true;
   else if(slot==='helmet')object.visible=current.helmet!=='off';
   else if(slot==='hair')object.visible=current.helmet==='off';
   else if(slot==='facialHair'||slot==='beard')object.visible=variant===current.beard&&current.beard!=='none';
  }
  applyMorphs();update();return summary();
 }
 function handGrip(side){return bone('wrist.'+side).localToWorld(handReference[side].gripLocal.clone());}
 // body: false when a motion clip already drives the legs and trunk; the
 // thrust's body layer would then lower and lean the figure a second time.
 // phase: {aim,thrust,turn} in place of the action's own envelopes (a clip
 // that times the spear itself); aim above 1 lowers the point below the
 // aimed line, turn swings the shaft about the trunk's up axis (+ left).
 // shield: {swing,raise,reach,lift} moves the shield hand: reach extends the
 // elbow about its own axis, then the hand turns about the shoulder in the
 // trunk frame: swing about the trunk's up axis (+ to the left, outwards),
 // raise as shoulder flexion (+ forwards and up); lift then carries it up the
 // trunk, metres, the shield's face kept.
 function poseAt(action='rest',time=0,{body=true,phase:given=null,shield:turn=null,hand=null}={}){
  lastAction=action;lastTime=Number.isFinite(time)?Math.max(0,time):0;reachErrors={};wristMissM=null;
  applyMorphs();update();
  {
   const phase=given||loadoutPhases(action,lastTime),isPike=current.weaponType==='pike',isGreatsword=current.weaponType==='greatsword'||RUNTIME_WEAPONS[current.weaponType]?.guard==='greatsword';
   if(body)fullBodyMotion.apply(action,phase);
   // Torso-relative anchors and elbow directions follow pelvis/torso motion;
   // a world-space target used to drag the pike hand through the chest.
   const left=bone('upperarm01.L').getWorldPosition(new THREE.Vector3()),right=bone('upperarm01.R').getWorldPosition(new THREE.Vector3());
   const origin=left.clone().add(right).multiplyScalar(.5),x=left.clone().sub(right).normalize();
   const up=bone('neck01').getWorldPosition(new THREE.Vector3()).sub(bone('spine05').getWorldPosition(new THREE.Vector3()));
   up.addScaledVector(x,-up.dot(x)).normalize();const forward=x.clone().cross(up).normalize();
   const direction=v=>x.clone().multiplyScalar(v[0]).addScaledVector(up,v[1]).addScaledVector(forward,v[2]);
   const guard=isPike?[.55,.12,.826]:isGreatsword?[.12,.3,.947]:[-.10,.8,.592];
   const aimed=isPike?[.55,.075,.832]:isGreatsword?[.12,.075,.99]:[-.15,.087,.985];
   const axis=direction(guard).lerp(direction(aimed),phase.aim).normalize();
   if(phase.turn)axis.applyAxisAngle(up,phase.turn);
   // The greatsword's rear hand and pommel need space in front of the armour.
   // The pike has a different hand spacing and therefore its own guard line.
   const anchor=isPike?[-.25,-.29,.16]:isGreatsword?[-.05,-.22,.44]:[-.37,-.23,.30];
   // The fuller breastplate also needs more pommel clearance in the folded
   // guard. The additional space tapers away as both arms extend.
   if(isGreatsword&&current.bodyBuild==='strong')anchor[2]+=.030*(1-phase.thrust);
   anchor[1]+=(isPike?.03:.07)*phase.thrust;
   // The round shield's wider rim passes the sword guard during the brace.
   // Move the weapon hand 15 mm outward, with unchanged clip endpoints.
   if(action==='Shield_Brace'&&current.weaponType==='sword'&&summary().effectiveShield==='round')anchor[0]-=.015*envelope(lastTime,.4,.9,3.2,3.7);
   const grip=origin.clone().add(direction(anchor)).addScaledVector(axis,(isPike?.106:isGreatsword?.13:.14)*phase.thrust);
   if(action==='Guard_Breath')grip.addScaledVector(up,.003*Math.sin(Math.PI*2*Math.min(lastTime,6)/6));
   let pole=direction([-1,-.55,.45]);
   // hand: a strike led by a recorded hand (board/src/mocap/strike.mjs). Grip
   // in the trunk frame in arm lengths from the middle of the shoulders, blade
   // axis and elbow pole as trunk directions. The arm is still solved by the
   // same biomechanics: elbow and wrist limits, forearm twist, diagonal grip.
   if(hand){
    const arm=armBiomechanics.calibration().R.lengthsM,length=arm[0]+arm[1];
    grip.copy(origin).add(direction(hand.grip.map(v=>v*length)));
    axis.copy(direction(hand.axis)).normalize();
    if(hand.pole&&Math.hypot(...hand.pole)>1e-3)pole=direction(hand.pole).normalize();
   }
   reachErrors.R=armBiomechanics.solve('R',grip,axis,pole,toolAxisLocal('R'));
   if(twoHanded.has(current.weaponType)){
   // The second hand follows the actual skinned weapon attachment. It is not
   // advanced independently from the shaft during the thrust.
   const frame=frameFor(weapons.get(current.weaponType));
   const second=frame.second||frame.grip.clone().addScaledVector(frame.axis,isPike?.38:-.13);
   reachErrors.L=armBiomechanics.solve('L',second,frame.axis,direction([1,-.55,.45]),toolAxisLocal('L'));
   // A recorded hand is the actor's, and the fighter's arms and plate set the
   // limits. The pawn's elbow does not straighten past 8°, so an arm the actor
   // stretched out overhead left the hand up to 4 cm short of the grip; with
   // the trunk upright the hammer's shaft over the head came 3 cm into the
   // helmet. The whole weapon moves, its direction kept: towards the shoulder
   // of the hand that falls short, out of the plate along its nearest normal.
   // A recorded strike also gives the middle of the recorded wrists. Where
   // the wrists land depends on the fighter's own hand (the grip sits 10 cm
   // past the wrist, partly across the palm) and on the hand spacing along
   // the grip, so the weapon moves along with the hands until the middle of
   // the fighter's wrists stands where the recording's does, within the same
   // limits (wristMissM: what is left).
   if(hand){
    const arm=armBiomechanics.calibration().R.lengthsM,length=arm[0]+arm[1];
    const missOf=k=>reachErrors[k]?.reachErrorM??0,miss=()=>Math.max(missOf('R'),missOf('L'));
    const secondOf=f=>f.second||f.grip.clone().addScaledVector(f.axis,isPike?.38:-.13);
    const solveBoth=at=>{
     reachErrors.R=armBiomechanics.solve('R',at,axis,pole,toolAxisLocal('R'));
     reachErrors.L=armBiomechanics.solve('L',secondOf(frameFor(weapons.get(current.weaponType))),frameFor(weapons.get(current.weaponType)).axis,direction([1,-.55,.45]),toolAxisLocal('L'));
     update();return{reach:miss(),...armourClearance()};
    };
    const settle=from=>{
     const at=from.clone();let s=solveBoth(at);
     for(let i=0;i<8&&(s.reach>.004||s.clearance<.004);i++){
      if(s.reach>.004){
       const side=missOf('L')>missOf('R')?'L':'R',f=frameFor(weapons.get(current.weaponType)),held=side==='R'?f.grip:secondOf(f);
       at.addScaledVector(bone('upperarm01.'+side).getWorldPosition(new THREE.Vector3()).sub(held).normalize(),missOf(side)+.002);
      }else at.addScaledVector(s.push,.006-s.clearance);
      s=solveBoth(at);
     }
     return{at,state:s};
    };
    const ok=s=>s.reach<=.005&&s.clearance>=0;
    let best=settle(grip);
    if(hand.wrists){
     const target=origin.clone().add(direction(hand.wrists.map(v=>v*length)));
     const wrists=()=>bone('wrist.R').getWorldPosition(new THREE.Vector3()).add(bone('wrist.L').getWorldPosition(new THREE.Vector3())).multiplyScalar(.5);
     const base=best,baseMiss=wrists().distanceTo(target);
     let at=base.at.clone();
     for(let pass=0;pass<2;pass++){at.add(target.clone().sub(wrists()));const s=settle(at);at=s.at;best=s;}
     if(!ok(best.state)&&ok(base.state)||wrists().distanceTo(target)>baseMiss){best=settle(base.at);}
     wristMissM=+wrists().distanceTo(target).toFixed(4);
    }
    grip.copy(best.at);
   }
   }else if(summary().effectiveShield!=='none'){
    const shield=frameFor(shields.get(summary().effectiveShield),'L');
    // The strong torso's breastplate projects farther forward. Fit the whole
    // shield/hand assembly to that build; its fingers must clear the plate.
    if(current.bodyBuild==='strong')shield.grip.addScaledVector(forward,.025);
    const wrist=bone('wrist.L').getWorldQuaternion(new THREE.Quaternion());
    if(turn&&turn.reach){
     // Elbow extension about the elbow's own axis: the shield goes out from the
     // chest before it turns across it.
     const p=n=>bone(n).getWorldPosition(new THREE.Vector3()),sh=p('upperarm01.L'),el=p('lowerarm01.L'),wr=p('wrist.L');
     const q=new THREE.Quaternion().setFromAxisAngle(el.clone().sub(sh).cross(wr.clone().sub(el)).normalize(),-turn.reach);
     shield.grip.sub(el).applyQuaternion(q).add(el);shield.axis.applyQuaternion(q);wrist.premultiply(q);
    }
    if(turn&&(turn.swing||turn.raise)){
     const shoulder=bone('upperarm01.L').getWorldPosition(new THREE.Vector3());
     const q=new THREE.Quaternion().setFromAxisAngle(up,turn.swing||0).multiply(new THREE.Quaternion().setFromAxisAngle(x,-(turn.raise||0)));
     shield.grip.sub(shoulder).applyQuaternion(q).add(shoulder);shield.axis.applyQuaternion(q);wrist.premultiply(q);
    }
    // lift carries the hand straight up the trunk with the shield's face kept.
    if(turn&&turn.lift)shield.grip.addScaledVector(up,turn.lift);
    reachErrors.L=armBiomechanics.solve('L',shield.grip,shield.axis,direction([1,-.55,.45]),undefined,wrist);
   }
   update();
  }
  fitEnarmes(summary().effectiveShield);
  gripController.apply({weaponType:current.weaponType,effectiveShield:summary().effectiveShield});
  update();
  return summary();
 }
 function availableActions(){return['rest','Guard_Breath',...(summary().effectiveShield==='none'?[]:['Shield_Brace']),'Spear_Study'];}
 function captions(){
  const state=summary(),weapon=weaponNames[current.weaponType],shield=shieldNames[state.effectiveShield];
  return{rest:`Стойка · ${weapon}, ${shield}`,Guard_Breath:'Дыхание в стойке · снаряжение следует за телом',Shield_Brace:'Упор щитом · согласованное движение руки, ног и корпуса',Spear_Study:`Учебный укол · ${weapon} остриём вперёд${state.twoHanded?', обе руки удерживают оружие':''}`};
 }
 function measure(){
  update();const frame=frameFor(weapons.get(current.weaponType)),state=summary(),right=handGrip('R'),left=handGrip('L');
  const second=state.twoHanded?(frame.second||frame.grip.clone().addScaledVector(frame.axis,current.weaponType==='pike'?.38:-.13)):null;
  const shield=state.effectiveShield!=='none'?frameFor(shields.get(state.effectiveShield),'L'):null;
  return{shieldGripWorld:shield?.grip.toArray()||null,shieldAxis:shield?.axis.toArray()||null,weaponGripAngleDeg:35,action:lastAction,time:lastTime,weapon:current.weaponType,effectiveShield:state.effectiveShield,handGripWorld:{R:right.toArray(),L:left.toArray()},weaponGripWorld:{R:frame.grip.toArray(),L:second?.toArray()||null},rightGripErrorM:right.distanceTo(frame.grip),leftGripErrorM:second?left.distanceTo(second):null,axis:frame.axis.toArray(),tip:frame.tip.toArray(),clearance:frame.points?.map(([p,r])=>[...p.toArray(),r])||null,footDriftM:Object.fromEntries(['L','R'].map(side=>[side,bone('foot.'+side).getWorldPosition(new THREE.Vector3()).distanceTo(feet[side])])),reachErrors:JSON.parse(JSON.stringify(reachErrors)),wristMissM,scope:'Attachment frames and wrist/foot joints; not a skin collision or anatomical comfort proof.'};
 }
 function gripFrames(){return Object.fromEntries(['R','L'].map(side=>[side,{gripLocal:handReference[side].gripLocal.toArray(),axisLocal:(side==='R'||summary().twoHanded?toolAxisLocal(side):handReference[side].axisLocal).toArray(),anatomicalAxisLocal:handReference[side].axisLocal.toArray(),weaponGripAngleDeg:side==='R'||summary().twoHanded?35:0,forwardLocal:handReference[side].forwardLocal.toArray(),wristBone:bone('wrist.'+side).name,radiusM:gripRadiusOf(current.weaponType),active:side==='R'||summary().twoHanded||summary().effectiveShield!=='none'}]));}
 return{apply,poseAt,summary,availableActions,captions,measure,gripFrames,grip:gripController,biomechanics:()=>({R:armBiomechanics.measure('R'),L:armBiomechanics.measure('L'),calibration:armBiomechanics.calibration()}),dispose(){}};
}
