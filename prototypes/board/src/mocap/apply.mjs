import * as THREE from 'three';
import {createRetargeter,PAWN,PAWN_BONES,DRIVEN} from './retarget.mjs';
import {qMul,qConj,qSlerp,qAxisAngle} from './math.mjs';
import {createNeckFollower,limitNeck} from './neck.mjs';

// Puts retargeted key points on a pawn's three.js bones. Runs while the
// pawn's holder sits at the origin unturned (actors.mjs solves every pose
// there), so world space is the figure's model space.
const Q=()=>new THREE.Quaternion(),V=()=>new THREE.Vector3();
export function createMocapDriver({bones,holder}){
 const norm=s=>String(s).replace(/[._\-\s]/g,'').toLowerCase(),map=new Map(Object.entries(bones).map(([n,b])=>[norm(n),b]));
 const bone=n=>{const b=map.get(norm(n));if(!b)throw Error('В модели нет кости '+n);return b;};
 holder.updateMatrixWorld(true);
 const inverse=holder.matrixWorld.clone().invert(),inverseQ=holder.getWorldQuaternion(Q()).invert();
 const pos={},quat={};
 for(const n of PAWN_BONES){pos[n]=bone(n).getWorldPosition(V()).applyMatrix4(inverse).toArray();quat[n]=inverseQ.clone().multiply(bone(n).getWorldQuaternion(Q())).toArray();}
 const retarget=createRetargeter({pos,quat});
 const affected=[...DRIVEN,...PAWN.between].map(bone),root=bone(PAWN.root);
 const between=PAWN.between.map(n=>[bone(n),bone(n).quaternion.clone()]);
 const saved=affected.map(()=>Q()),savedRoot=V(),target=Q(),parentQ=Q(),p=V();
 // src: key points of one frame (format.mjs sampleClip); clip: its
 // prepared clip; weight: 0 keeps the current pose, 1 is the clip's pose.
 function apply(src,clip,weight=1){
  if(!(weight>0))return null;
  affected.forEach((b,i)=>saved[i].copy(b.quaternion));savedRoot.copy(root.position);
  for(const [b,q]of between)b.quaternion.copy(q);
  const pose=retarget.pose(src,clip);
  root.parent.updateMatrixWorld(true);
  root.position.copy(root.parent.worldToLocal(p.fromArray(pose.root)));
  for(const name of DRIVEN){
   const b=bone(name);b.parent.updateWorldMatrix(true,false);
   target.fromArray(pose.world[name]);b.quaternion.copy(b.parent.getWorldQuaternion(parentQ).invert().multiply(target)).normalize();
   b.updateMatrixWorld(true);
  }
  if(weight<1){
   affected.forEach((b,i)=>b.quaternion.slerpQuaternions(saved[i],b.quaternion.clone(),weight));
   root.position.lerpVectors(savedRoot,root.position.clone(),weight);
   // Each end stands on the floor, but blended joint by joint a bent stance
   // and a straight one sink the feet between them: the pelvis comes down
   // in a straight line while the legs straighten along arcs. The blend
   // never puts the lowest ankle or toe under its rest height.
   root.updateMatrixWorld(true);
   let low=Infinity;
   for(const s of ['L','R']){const c=PAWN.legs[s];
    low=Math.min(low,bone(c.ankle).getWorldPosition(p).y-retarget.ankleHeight,bone(c.toe).getWorldPosition(p).y-retarget.toeHeight);}
   if(low<0){const w=root.getWorldPosition(V());w.y-=low;root.position.copy(root.parent.worldToLocal(w));}
  }
  root.updateMatrixWorld(true);
  return pose;
 }
 // The head on the neck brought to the neck's own pace through time
 // (neck.mjs, createNeckFollower), after the clips and the body layer have
 // posed it: the chest stays, the neck bones share the head's turn as the
 // retarget shares it. now: the board's clock; null (a pose solved only to
 // be measured) leaves the head as posed and the follower as it was.
 const chest=bone(PAWN.spine.at(-1)),neckBones=PAWN.neck.map(bone),headBone=bone(PAWN.head),follower=createNeckFollower();
 const wq=b=>b.getWorldQuaternion(Q()).toArray(),turn=(b,n)=>qMul(wq(b),qConj(quat[n]));
 // yaw: the figure's own heading on the board (rad). The head is held in
 // the board's frame, so a figure turning in place does not add its own turn
 // to the head's pace.
 function steady(now,yaw=0){
  if(now==null)return;
  root.parent.updateMatrixWorld(true);
  const Y=qAxisAngle([0,1,0],yaw||0),dC=turn(chest,PAWN.spine.at(-1)),dH=turn(headBone,PAWN.head),h=qMul(qConj(Y),follower.step(qMul(Y,dH),now));
  if(Math.abs(h[0]*dH[0]+h[1]*dH[1]+h[2]*dH[2]+h[3]*dH[3])>1-1e-12)return;
  const m=limitNeck(qMul(qConj(dC),h));
  const set=(b,name,d)=>{b.parent.updateWorldMatrix(true,false);target.fromArray(qMul(d,quat[name]));b.quaternion.copy(b.parent.getWorldQuaternion(parentQ).invert().multiply(target)).normalize();b.updateMatrixWorld(true);};
  neckBones.forEach((b,i)=>set(b,PAWN.neck[i],qMul(dC,qSlerp([0,0,0,1],m,(i+1)/(neckBones.length+1)))));
  set(headBone,PAWN.head,qMul(dC,m));
 }
 return{apply,steady,retarget};
}
