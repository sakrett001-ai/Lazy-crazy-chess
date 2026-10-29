import * as THREE from 'three';
import {createRetargeter,PAWN,PAWN_BONES,DRIVEN} from './retarget.mjs';

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
  }
  root.updateMatrixWorld(true);
  return pose;
 }
 return{apply,retarget};
}
