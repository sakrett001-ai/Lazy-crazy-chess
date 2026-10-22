import * as THREE from 'three';

// Equipment and body shape are independent of material colours. The authored
// clips continue to drive the planted stance; only the two-handed arm chains
// are solved here after the viewer restores and samples that clip.
const normalize=value=>String(value||'').replace(/[._\-\s]/g,'').toLowerCase();
const V=values=>new THREE.Vector3().fromArray(values);
const twoHanded=new Set(['pike','greatsword']);
const weaponNames={spear:'копьё',sword:'меч',pike:'длинное копьё',greatsword:'двуручный меч'};
const shieldNames={tower:'ростовой щит',round:'круглый щит',heater:'треугольный щит',none:'без щита'};
const defaults={armorType:'plate',shieldType:'tower',weaponType:'spear',bodyBuild:'regular',experience:'recruit',beard:'none',helmet:'on'};
const smooth=(t,start,end)=>{const u=THREE.MathUtils.clamp((t-start)/(end-start),0,1);return u*u*u*(u*(u*6-15)+10);};
const envelope=(t,start,peak,hold,end)=>smooth(t,start,peak)*(1-smooth(t,hold,end));
export function loadoutPhases(action,time){return action==='Spear_Study'?{aim:envelope(time,.55,1.2,2.8,3.75),thrust:envelope(time,1.25,1.9,2.1,2.8)}:{aim:0,thrust:0};}

export function createLoadout({model,bones={}}){
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
  let grip,axis,tip,second=null;
  if(Array.isArray(data.gripBind)&&Array.isArray(data.shaftAxisBind||data.handleAxisBind)){
   const bindGrip=V(data.gripBind),bindAxis=V(data.shaftAxisBind||data.handleAxisBind).normalize();
   grip=skinPoint(mesh,bindGrip,side);axis=skinPoint(mesh,bindGrip.clone().add(bindAxis),side).sub(grip).normalize();
   tip=Array.isArray(data.tipBind)?skinPoint(mesh,V(data.tipBind),side):grip.clone().addScaledVector(axis,1);
   if(Array.isArray(data.secondGripBind))second=skinPoint(mesh,V(data.secondGripBind),side);
  }else{
   // Exact guard frames from the preserved baseline's authored equipment.
   const guardGrip=V(side==='R'?[-.28447413444519043,1.1486186981201172,.334890753030777]:[.00598069466650486,1.1586185693740845,.21028414368629456]);
   const wrist=bone('wrist.'+side),calibration=initialWristFrames?.[side];
   const transform=calibration?wrist.matrixWorld.clone().multiply(calibration.clone().invert()):new THREE.Matrix4();
   grip=guardGrip.applyMatrix4(transform);axis=new THREE.Vector3(0,1,0).transformDirection(transform);tip=grip.clone().addScaledVector(axis,side==='R'?1.63:0);
  }
  return{grip,axis,tip,second,mesh,object};
 }
 const initialWristFrames=Object.fromEntries(['L','R'].map(side=>[side,bone('wrist.'+side).matrixWorld.clone()]));
 const handReference=Object.fromEntries(['L','R'].map(side=>{
  const wrist=bone('wrist.'+side),frame=frameFor(side==='R'?weapons.get('spear'):shields.get('tower'),side);
  const grip=frame?.grip||V(side==='R'?[-.28447413444519043,1.1486186981201172,.334890753030777]:[.00598069466650486,1.1586185693740845,.21028414368629456]);
  return[side,{gripLocal:wrist.worldToLocal(grip.clone()),quaternion:wrist.getWorldQuaternion(new THREE.Quaternion()),axis:frame?.axis||new THREE.Vector3(0,1,0)}];
 }));
 const feet=Object.fromEntries(['L','R'].map(side=>[side,bone('foot.'+side).getWorldPosition(new THREE.Vector3())]));
 let current={...defaults},lastAction='rest',lastTime=0,reachErrors={};
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
   else if(slot==='padding'||slot==='base'||slot==='body')object.visible=true;
   else if(slot==='helmet')object.visible=current.helmet!=='off';
   else if(slot==='hair')object.visible=current.helmet==='off';
   else if(slot==='facialHair'||slot==='beard')object.visible=variant===current.beard&&current.beard!=='none';
  }
  applyMorphs();update();return summary();
 }
 function worldQuaternion(joint,quaternion){
  const parent=joint.parent.getWorldQuaternion(new THREE.Quaternion());
  joint.quaternion.copy(parent.invert().multiply(quaternion)).normalize();update();
 }
 function aim(joint,from,to){
  const delta=new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(),to.clone().normalize());
  worldQuaternion(joint,delta.multiply(joint.getWorldQuaternion(new THREE.Quaternion())));
 }
 function solveArm(side,target,pole){
  const upper=bone('upperarm01.'+side),lower=bone('lowerarm01.'+side),end=bone('wrist.'+side);
  const shoulder=upper.getWorldPosition(new THREE.Vector3()),elbow=lower.getWorldPosition(new THREE.Vector3()),wrist=end.getWorldPosition(new THREE.Vector3());
  const a=elbow.distanceTo(shoulder),b=wrist.distanceTo(elbow),direction=target.clone().sub(shoulder),reach=direction.length();
  const distance=THREE.MathUtils.clamp(reach,Math.abs(a-b)+.002,a+b-.002);direction.normalize();
  const bend=pole.clone().addScaledVector(direction,-pole.dot(direction));
  if(bend.lengthSq()<1e-8)bend.set(side==='L'?1:-1,0,0).addScaledVector(direction,-direction.x*(side==='L'?1:-1));
  bend.normalize();const along=(a*a-b*b+distance*distance)/(2*distance),height=Math.sqrt(Math.max(0,a*a-along*along));
  const wantedElbow=shoulder.clone().addScaledVector(direction,along).addScaledVector(bend,height),wantedWrist=shoulder.clone().addScaledVector(direction,distance);
  aim(upper,elbow.clone().sub(shoulder),wantedElbow.clone().sub(shoulder));
  const nextElbow=lower.getWorldPosition(new THREE.Vector3()),nextWrist=end.getWorldPosition(new THREE.Vector3());
  aim(lower,nextWrist.sub(nextElbow),wantedWrist.clone().sub(nextElbow));
  reachErrors[side]={targetErrorM:end.getWorldPosition(new THREE.Vector3()).distanceTo(target),reachM:reach,linkSumM:a+b};
 }
 function handGrip(side){return bone('wrist.'+side).localToWorld(handReference[side].gripLocal.clone());}
 function orientHand(side,axis){
  const reference=handReference[side];
  return new THREE.Quaternion().setFromUnitVectors(reference.axis,axis).multiply(reference.quaternion).normalize();
 }
 function placeHand(side,grip,axis){
  const quaternion=orientHand(side,axis),offset=handReference[side].gripLocal.clone().applyQuaternion(quaternion);
  const target=grip.clone().sub(offset),pole=new THREE.Vector3(side==='L'?1:-1,-.45,-.25);
  solveArm(side,target,pole);worldQuaternion(bone('wrist.'+side),quaternion);
 }
 function poseAt(action='rest',time=0){
  lastAction=action;lastTime=Number.isFinite(time)?Math.max(0,time):0;reachErrors={};
  applyMorphs();update();
  if(twoHanded.has(current.weaponType)){
   const phase=loadoutPhases(action,lastTime),isPike=current.weaponType==='pike';
   const guardAxis=new THREE.Vector3(0,isPike?.25:.9,isPike?.9682458366:.4358898944);
   const axis=guardAxis.lerp(new THREE.Vector3(0,.075,.9971835338),phase.aim).normalize();
   const grip=new THREE.Vector3(isPike?.015:-.02,isPike?1.15:1.16,isPike?.085:.32).addScaledVector(axis,(isPike?.09:.13)*phase.thrust);
   if(action==='Guard_Breath')grip.y+=.003*Math.sin(Math.PI*2*Math.min(lastTime,6)/6);
   placeHand('R',grip,axis);
   // The second hand follows the actual skinned weapon attachment. It is not
   // advanced independently from the shaft during the thrust.
   const frame=frameFor(weapons.get(current.weaponType));
   const second=frame.second||frame.grip.clone().addScaledVector(frame.axis,isPike?.38:-.13);
   placeHand('L',second,frame.axis);
   update();
  }
  return summary();
 }
 function availableActions(){return['rest','Guard_Breath',...(summary().effectiveShield==='none'?[]:['Shield_Brace']),'Spear_Study'];}
 function captions(){
  const state=summary(),weapon=weaponNames[current.weaponType],shield=shieldNames[state.effectiveShield];
  return{rest:`Стойка · ${weapon}, ${shield}`,Guard_Breath:'Дыхание в стойке · снаряжение следует за телом',Shield_Brace:'Упор щитом · вынос руки с опорой ногами и корпуса',Spear_Study:`Учебный укол · ${weapon} остриём вперёд${state.twoHanded?', обе руки удерживают оружие':''}`};
 }
 function measure(){
  update();const frame=frameFor(weapons.get(current.weaponType)),state=summary(),right=handGrip('R'),left=handGrip('L');
  const second=state.twoHanded?(frame.second||frame.grip.clone().addScaledVector(frame.axis,current.weaponType==='pike'?.38:-.13)):null;
  return{action:lastAction,time:lastTime,weapon:current.weaponType,effectiveShield:state.effectiveShield,handGripWorld:{R:right.toArray(),L:left.toArray()},weaponGripWorld:{R:frame.grip.toArray(),L:second?.toArray()||null},rightGripErrorM:right.distanceTo(frame.grip),leftGripErrorM:second?left.distanceTo(second):null,axis:frame.axis.toArray(),tip:frame.tip.toArray(),footDriftM:Object.fromEntries(['L','R'].map(side=>[side,bone('foot.'+side).getWorldPosition(new THREE.Vector3()).distanceTo(feet[side])])),reachErrors:JSON.parse(JSON.stringify(reachErrors)),scope:'Attachment frames and wrist/foot joints; not a skin collision or anatomical comfort proof.'};
 }
 return{apply,poseAt,summary,availableActions,captions,measure,dispose(){}};
}
