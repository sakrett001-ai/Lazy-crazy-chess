import * as THREE from 'three';

// Feet on uneven ground. Every motion of the board (clips, the procedural
// layer, held feet, strikes) is solved as on a flat floor at the holder's
// height; this is the last pass of a pose and puts that pose on the field.
//
// The holder goes down to the lower of the two grounds under the feet, so
// no leg ever has to reach further than on the flat; the foot over higher
// ground is raised by the difference with two-bone IK (thigh and shin keep
// their lengths, the knee stays in the plane it bends in), and a planted
// foot turns its sole to the slope. A foot in the air keeps its own height
// above the ground under it, so a step over a hummock clears it as it
// cleared the flat. A falling figure is only set on the ground under its
// feet: the fall itself turns about them (actors.mjs).
const V=()=>new THREE.Vector3(),Q=()=>new THREE.Quaternion(),UP=new THREE.Vector3(0,1,0);
const SIDES=['L','R'];
// m above its standing height, a sole this high is in the air: no tilt.
export const PLANTED=[.015,.07];
export const TILT_MAX=.17; // rad, most a sole turns to the slope (~10°)

export function createGrounding({bones,holder}){
 const norm=s=>String(s).replace(/[._\-\s]/g,'').toLowerCase(),map=new Map(Object.entries(bones).map(([n,b])=>[norm(n),b]));
 const bone=n=>{const b=map.get(norm(n));if(!b)throw Error('В модели нет кости '+n);return b;};
 const legs=Object.fromEntries(SIDES.map(s=>[s,{thigh:bone('upperleg01.'+s),shin:bone('lowerleg01.'+s),foot:bone('foot.'+s),toe:bone('toe3-1.'+s)}]));
 const H=V(),K=V(),A=V(),T=V(),u=V(),pole=V(),K2=V(),A2=V(),d1=V(),d2=V(),q=Q(),pq=Q(),fq=Q(),tq=Q(),n=V(),inv=new THREE.Matrix4(),local=V();
 // Ankle height above the floor in the rest pose, in the holder's frame.
 holder.updateMatrixWorld(true);inv.copy(holder.matrixWorld).invert();
 const rest=Math.min(...SIDES.map(s=>legs[s].foot.getWorldPosition(V()).applyMatrix4(inv).y));
 const flat=s=>({ankle:legs[s].foot.getWorldPosition(V()).applyMatrix4(inv).y,toe:legs[s].toe.getWorldPosition(V()).applyMatrix4(inv).y});
 let last={base:0,lift:{L:0,R:0},grounds:{L:0,R:0},flat:{L:flat('L'),R:flat('R')}};
 function setWorldQ(b,wq){b.parent.getWorldQuaternion(pq);b.quaternion.copy(pq.invert().multiply(wq)).normalize();b.updateMatrixWorld(true);}
 // Raise one ankle by dy (world metres) keeping the knee's bending plane,
 // then give the foot its world rotation footQ.
 function raise(side,dy,footQ){
  const l=legs[side];
  l.thigh.getWorldPosition(H);l.shin.getWorldPosition(K);l.foot.getWorldPosition(A);
  const l1=H.distanceTo(K),l2=K.distanceTo(A);
  T.copy(A);T.y+=dy;
  u.subVectors(T,H);const d=THREE.MathUtils.clamp(u.length(),Math.abs(l1-l2)+1e-3,(l1+l2)*.9995);u.normalize();
  pole.subVectors(K,H);pole.addScaledVector(u,-pole.dot(u));
  if(pole.lengthSq()<1e-8){holder.getWorldDirection(pole);pole.addScaledVector(u,-pole.dot(u));}
  pole.normalize();
  const along=(l1*l1-l2*l2+d*d)/(2*d),height=Math.sqrt(Math.max(0,l1*l1-along*along));
  K2.copy(H).addScaledVector(u,along).addScaledVector(pole,height);A2.copy(H).addScaledVector(u,d);
  d1.subVectors(K,H).normalize();d2.subVectors(K2,H).normalize();
  setWorldQ(l.thigh,q.setFromUnitVectors(d1,d2).multiply(l.thigh.getWorldQuaternion(Q())));
  l.shin.getWorldPosition(K);l.foot.getWorldPosition(A);
  d1.subVectors(A,K).normalize();d2.subVectors(A2,K2).normalize();
  setWorldQ(l.shin,q.setFromUnitVectors(d1,d2).multiply(l.shin.getWorldQuaternion(Q())));
  setWorldQ(l.foot,footQ);
 }
 // ground: {height(x,z), normal(x,z)}; fall: the holder's fall angle.
 function apply(ground,{fall=0}={}){
  holder.updateMatrixWorld(true);
  inv.copy(holder.matrixWorld).invert();
  const before={L:flat('L'),R:flat('R')};
  if(fall>.01){const y=ground.height(holder.position.x,holder.position.z);holder.position.y+=y;holder.updateMatrixWorld(true);last={base:y,rel:0,lift:{L:0,R:0},grounds:{L:y,R:y},flat:before,fall:true};return last;}
  const feet=Object.fromEntries(SIDES.map(s=>{const p=legs[s].foot.getWorldPosition(V());return[s,{p,h:ground.height(p.x,p.z),air:local.copy(p).applyMatrix4(inv).y-rest,q:legs[s].foot.getWorldQuaternion(Q())}];}));
  const base=Math.min(feet.L.h,feet.R.h);
  holder.position.y+=base;holder.updateMatrixWorld(true);
  const lift={};
  for(const s of SIDES){const f=feet[s],dy=f.h-base;lift[s]=dy;
   // Planted share of the foot: its sole turns to the slope by that share.
   const w=1-THREE.MathUtils.smoothstep(f.air,PLANTED[0],PLANTED[1]);
   const [nx,ny,nz]=ground.normal(f.p.x,f.p.z);n.set(nx,ny,nz);
   const angle=Math.min(TILT_MAX,UP.angleTo(n))*w;
   tq.identity();if(angle>1e-5){const axis=V().crossVectors(UP,n).normalize();tq.setFromAxisAngle(axis,angle);}
   fq.copy(tq).multiply(f.q);
   if(dy>1e-5||angle>1e-5)raise(s,dy,fq);
  }
  last={base,rel:base-ground.height(holder.position.x,holder.position.z),lift,grounds:{L:feet.L.h,R:feet.R.h},flat:before,fall:false};
  return last;
 }
 // A figure moved without a new pose (calm figures are re-posed every few
 // frames) keeps its last pose on the field: the holder follows the ground
 // under it by the last pose's height above that ground.
 function follow(ground,{fall=0}={}){holder.position.y+=ground.height(holder.position.x,holder.position.z)+(fall>.01?0:last.rel||0);holder.updateMatrixWorld(true);}
 // The pose on the field against the same pose on the flat (m), per foot:
 // ankle and toe height above the ground under each, less their height
 // above the flat floor. 0 is a foot standing on the field exactly as it
 // stood on the flat; below 0 it sinks, above 0 it floats. air: the ankle's
 // height above its rest height on the flat (0 planted, > 0 in a step).
 function gaps(ground){
  holder.updateMatrixWorld(true);
  return Object.fromEntries(SIDES.map(s=>{const a=legs[s].foot.getWorldPosition(V()),t=legs[s].toe.getWorldPosition(V()),f=last.flat[s];
   return[s,{ankle:a.y-ground.height(a.x,a.z)-f.ankle,toe:t.y-ground.height(t.x,t.z)-f.toe,air:f.ankle-rest,fall:!!last.fall}];}));
 }
 return{apply,follow,gaps,rest,last:()=>last};
}
