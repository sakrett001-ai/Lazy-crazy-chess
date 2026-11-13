import {qMul,qConj,qAxisAngle,qNormalize} from './math.mjs';

// How far the head turns against the chest. Normal active range of the
// cervical spine: flexion 50°, extension 60°, lateral bending 45°, rotation
// 80° each way (AMA Guides to the Evaluation of Permanent Impairment, 5th
// ed., 2000). A recorded head beyond them is a tracking error, not a pose: a
// camera that films the face in profile swaps the eyes and ears, and the
// head turned 180° back on the board. The angles are measured from the
// neutral stance, in the figure's frame (forward +Z, left +X, up +Y): yaw
// about up (to the left positive), pitch about left (chin down positive),
// roll about forward (applied in that order).
export const NECK=Object.freeze({yaw:80,flexion:50,extension:60,roll:45});
// Inside KNEE of each limit the head turns as recorded; beyond it the turn
// eases into the limit, so a head swinging out slows down instead of
// stopping dead on it.
export const KNEE=.85;

const D=180/Math.PI;
// Yaw, pitch, roll (degrees) of q = Ry(yaw)·Rx(pitch)·Rz(roll).
export function neckAngles(q){
 const [x,y,z,w]=q;
 const m02=2*(x*z+y*w),m22=1-2*(x*x+y*y),m12=2*(y*z-x*w),m10=2*(x*y+z*w),m11=1-2*(x*x+z*z);
 return{yaw:Math.atan2(m02,m22)*D,pitch:Math.asin(Math.max(-1,Math.min(1,-m12)))*D,roll:Math.atan2(m10,m11)*D};
}
export const fromNeckAngles=({yaw,pitch,roll})=>qMul(qMul(qAxisAngle([0,1,0],yaw/D),qAxisAngle([1,0,0],pitch/D)),qAxisAngle([0,0,1],roll/D));

// v eased into [-lo, hi]: unchanged within KNEE of the limit, then
// approaching it smoothly (tanh), with the same slope at the knee.
export function ease(v,lo,hi){
 const lim=v<0?lo:hi,a=Math.abs(v),k=KNEE*lim;
 if(a<=k)return v;
 return Math.sign(v)*(k+(lim-k)*Math.tanh((a-k)/(lim-k)));
}
// The head's turn against the chest (a rotation from the neutral) brought
// within the neck's range.
export function limitNeck(q){
 const a=neckAngles(q);
 if(Math.abs(a.yaw)<=KNEE*NECK.yaw&&a.pitch<=KNEE*NECK.flexion&&-a.pitch<=KNEE*NECK.extension&&Math.abs(a.roll)<=KNEE*NECK.roll)return q;
 return fromNeckAngles({yaw:ease(a.yaw,NECK.yaw,NECK.yaw),pitch:ease(a.pitch,NECK.extension,NECK.flexion),roll:ease(a.roll,NECK.roll,NECK.roll)});
}

// The trunk leads the turn onto a target, the neck follows: in a large turn
// of the gaze the eyes, head and trunk turn together, and the head on the
// trunk stays well inside its range (Land, Exp Brain Res 2004). A
// recording whose shoulders swing away from the
// opponent while the eyes hold it puts that whole turn on the neck: the
// pawn looked back over its shoulder with the head on its limit, and was
// dragged round by the shoulders. Past KNEE of the neck's rotation the
// chest turns back towards the head by the excess instead, as far as the
// trunk itself turns on the hips: TWIST, axial rotation of the
// thoracolumbar spine (the same 45° as skill.mjs), or the recorded twist if
// that is larger. Arguments and result are the turns of pelvis, chest and
// head from their rest, in the figure's frame.
// A recorded twist past TWIST is kept when it turns the chest towards the
// eyes (a blow wound up), but not against them: shoulders that the
// recording swings away from the head by more than the trunk turns put the
// pawn looking back over its shoulder (the shoulder line of a sword cut
// turns with the shoulder blades, not the spine alone). There the chest
// comes back to TWIST first, then by the neck's excess as above.
export const TWIST=45;
export function leadWithChest(dP,dC,dH){
 const q=qMul(qConj(dC),dH),a=neckAngles(q),k=KNEE*NECK.yaw;
 const twist=neckAngles(qMul(qConj(dP),dC)).yaw,away=Math.sign(twist)===-Math.sign(a.yaw);
 const over=away?Math.max(0,Math.abs(twist)-TWIST):0;
 if(Math.abs(a.yaw)<=k&&!over)return dC;
 const lim=away?TWIST:Math.max(TWIST,Math.abs(twist));
 let e=Math.sign(a.yaw)*(over+Math.max(0,Math.abs(a.yaw)-over-k));
 e=Math.max(-lim,Math.min(lim,twist+e))-twist;
 return qMul(dC,qAxisAngle([0,1,0],e/D));
}

// How fast the head turns on the neck. Healthy adults turning the head
// about 60° as fast as they can reach 348 ± 92°/s at the peak (Röijezon et
// al., BMC Musculoskelet Disord 2010, 11:222); the mean is the cap. A turn
// of that size and peak speed with minimum jerk lasts T = 1.875·A/V and
// accelerates at most 5.77·A/T²: the cap on the change of that speed. The
// head-in-space is what the body controls and the neck follows it (Land,
// Exp Brain Res 2004), so a recording or a board turn that asks for more
// (a head flipped by tracking, shoulders whipping back after a blow) is
// followed at the neck's own pace instead of in one jump.
export const NECK_SPEED=348;
const SWEEP=61.5,SWEEP_TIME=1.875*SWEEP/NECK_SPEED;
export const NECK_ACCEL=5.77*SWEEP/SWEEP_TIME**2;
const qLog=q=>{const [x,y,z,w]=q[3]<0?q.map(v=>-v):q,s=Math.hypot(x,y,z);if(s<1e-9)return[2*x,2*y,2*z];const a=2*Math.atan2(s,w)/s;return[x*a,y*a,z*a];};
const qExp=v=>{const a=Math.hypot(...v);if(a<1e-9)return qNormalize([v[0]/2,v[1]/2,v[2]/2,1]);const s=Math.sin(a/2)/a;return[v[0]*s,v[1]*s,v[2]*s,Math.cos(a/2)];};
const clampLen=(v,m)=>{const l=Math.hypot(...v);return l>m?v.map(x=>x*m/l):v;};
// The head's turn on the neck through time: step(target, now) returns the
// turn reached at now, following target (a rotation from the neutral) with
// the speed and acceleration above. A second call at the same now redoes
// that step (the board may pose a figure twice in a frame); a pause longer
// than GAP, or time going back, starts it over at the target.
export const GAP=.25;
export function createNeckFollower(){
 let q=null,w=[0,0,0],last=null,prev=null,before=null;
 const V=NECK_SPEED/D,A=NECK_ACCEL/D;
 return{reset(){q=null;},step(target,now){
  if(q!==null&&now===last&&before)({q,w,last,prev}=before);
  if(q===null||!(now>last)||now-last>GAP){q=target;w=[0,0,0];prev=target;last=now;before=null;return q;}
  before={q,w,last,prev};
  const dt=now-last;last=now;
  const vt=qLog(qMul(qConj(prev),target)).map(x=>x/dt);prev=target;
  // The target's own motion this frame, and what is left to close beyond
  // it (with braking in time to stop on it).
  const r=qLog(qMul(qConj(q),target)).map((x,i)=>x-vt[i]*dt),e=Math.hypot(...r),b=e>1e-9?Math.min(Math.sqrt(2*A*e),e/dt)/e:0;
  const want=clampLen(vt.map((x,i)=>x+r[i]*b),V);
  w=clampLen(w.map((x,i)=>x+clampLen(want.map((y,j)=>y-w[j]),A*dt)[i]),V);
  q=qNormalize(qMul(q,qExp(w.map(x=>x*dt))));
  return q;
 }};
}
