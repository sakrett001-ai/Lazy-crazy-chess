import {qMul,qAxisAngle} from './math.mjs';

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
