import * as THREE from 'three';
import {PAWN} from './retarget.mjs';

// Planted feet on the board. The recording drives the legs by the
// directions of their bones (retarget.mjs), and the pawn's legs are not the
// fencer's: a foot that stands still in the recording creeps over the board
// as the knees bend, the holder turns with the aim and the clips cross-fade
// from one fighter to the other. A fencer's foot does not creep: it stands,
// or it steps.
//
// So each foot is held where it was put down, in the board's frame, and the
// leg reaches it by two-bone IK (thigh and shin keep their lengths, the knee
// stays in its own bending plane). It is let go only for a step: when the
// recording takes it further than STEP_HOLD from where it stands (a smaller
// lift is the camera's depth noise, not a step), or the leg cannot reach it.
// Then it travels to the recorded foot on a minimum-jerk curve (Flash &
// Hogan 1985), lifted if the recording drags it, and is put down again where
// the recorded foot comes down. The state is the figure's own, kept between
// frames by time (the board's clock): a jump in time or place starts over.
export const STEP_HOLD=.15;        // m on the board, shortest step a planted foot makes
export const DOWN=.02;             // m, a recorded foot this close to its rest height is on the floor
export const STEP_TIME=[.22,.4];   // s, catching up with the recorded foot
export const STEP_SPEED=1.3;       // m/s, mean foot speed of a fencing step
// s, time constant of the knee's bending plane. The recorded knee swings
// about the hip–ankle line by the camera's depth noise; with the foot held
// that swing alone shakes the knee by 2–4 cm a frame (ролик 516).
export const POLE_TAU=.12;
export const BENT=.15;             // knee this far off the hip–ankle line (share of the thigh) is trusted fully
export const LIFT=[.02,.08,.3];    // m, lowest and highest lift of a dragged step, lift per metre
export const REACH=.995;           // share of the leg's length a held foot may need; further, it steps
// Soft reach for a stepping foot (as game foot IK does): from SOFT of the
// leg's length on, the leg straightens ever more slowly and the moving ankle
// falls a few millimetres short, so the knee does not snap straight. A
// standing foot is reached exactly (it steps when the leg runs out).
export const SOFT=.94;
// rad, the knee's bending plane is kept this close to the hips' forward
// (45° hip rotation, AAOS, and 15° for the camera's error on the pelvis line,
// as HIP_ROT in tools/duels/build.py).
export const KNEE_TURN=Math.PI/3;
const RESET_TIME=.25,RESET_MOVE=.5;

const minJerk=u=>{u=Math.min(1,Math.max(0,u));return u*u*u*(10-15*u+6*u*u);};

export function createFootLock({bones,holder,retarget}){
 const norm=s=>String(s).replace(/[._\-\s]/g,'').toLowerCase(),map=new Map(Object.entries(bones).map(([n,b])=>[norm(n),b]));
 const bone=n=>map.get(norm(n));
 const legs=Object.fromEntries(['L','R'].map(s=>{const c=PAWN.legs[s];return[s,{thigh:bone(c.hip),shin:bone(c.knee),foot:bone(c.ankle),toe:bone(c.toe)}];}));
 const V=()=>new THREE.Vector3(),Q=()=>new THREE.Quaternion();
 const H=V(),K=V(),A=V(),T=V(),G=V(),axis=V(),pole=V(),k2=V(),u1=V(),u2=V(),hips=V(),fwd=V(),side=V(),dq=Q(),pq=Q(),wq=Q(),sq=Q(),inv=new THREE.Matrix4();
 let state=null;
 const reset=()=>{state=null;};
 // Leg of side s to world point G (ankle), foot turned to world quaternion
 // footQ (or left as it is). Returns how far short the ankle stays.
 function reach(s,goal,footQ,f=null,alpha=1,soft=false){
  const l=legs[s];
  l.thigh.getWorldPosition(H);l.shin.getWorldPosition(K);l.foot.getWorldPosition(A);
  const l1=H.distanceTo(K),l2=K.distanceTo(A),want=goal.distanceTo(H);
  const full=l1+l2,ds=SOFT*full;
  const d=Math.max(Math.abs(l1-l2)+1e-4,soft&&want>ds?ds+(full-ds)*(1-Math.exp(-(want-ds)/(full-ds))):Math.min(want,full*.9999));
  axis.subVectors(goal,H).normalize();
  // Bending plane: the recorded knee's, smoothed over POLE_TAU. A nearly
  // straight leg says little about it (the knee lies almost on the hip–ankle
  // line), so it is trusted by how far the knee stands off that line.
  pole.subVectors(K,H);pole.addScaledVector(axis,-pole.dot(axis));
  const trust=Math.min(1,pole.length()/(BENT*l1));
  if(pole.lengthSq()<1e-10){pole.set(0,0,1).applyQuaternion(holder.getWorldQuaternion(dq));pole.addScaledVector(axis,-pole.dot(axis));}
  pole.normalize();
  // A knee flexes forwards only: the plane is kept within KNEE_TURN of the
  // hips' forward about the hip–ankle line (as tools/duels/build.py keeps the
  // recorded knee), so a smoothed plane that lags a turning holder does not
  // swing the knee behind the leg.
  // The hips' line is smoothed as the plane is: the recorded pelvis turns by
  // the camera's noise too, and a limit that shakes would shake the knee.
  const keep=(p,again=false)=>{hips.subVectors(legs.L.thigh.getWorldPosition(u1),legs.R.thigh.getWorldPosition(u2)).normalize();
   if(f){if(again)hips.copy(f.hips);else if(f.hips)hips.copy(f.hips.lerp(hips,alpha).normalize());else f.hips=hips.clone();}
   fwd.crossVectors(axis,hips);if(fwd.lengthSq()<1e-10)return;fwd.normalize();side.crossVectors(fwd,axis);
   const a=Math.atan2(p.dot(side),p.dot(fwd)),c=Math.max(-KNEE_TURN,Math.min(KNEE_TURN,a));
   if(c!==a)p.copy(fwd).multiplyScalar(Math.cos(c)).addScaledVector(side,Math.sin(c));};
  keep(pole);
  if(f){
   if(f.pole){f.pole.lerp(pole,alpha*trust);f.pole.addScaledVector(axis,-f.pole.dot(axis));
    if(f.pole.lengthSq()>1e-8){pole.copy(f.pole.normalize());keep(pole,true);}}
   f.pole=pole.clone();
  }
  const c=Math.min(1,Math.max(-1,(l1*l1+d*d-l2*l2)/(2*l1*d))),h=Math.sqrt(1-c*c);
  k2.copy(H).addScaledVector(axis,l1*c).addScaledVector(pole,l1*h);
  turn(l.thigh,u1.subVectors(K,H).normalize(),u2.subVectors(k2,H).normalize());
  l.shin.getWorldPosition(K);l.foot.getWorldPosition(A);
  turn(l.shin,u1.subVectors(A,K).normalize(),u2.subVectors(goal,K).normalize());
  if(footQ){l.foot.parent.getWorldQuaternion(pq);l.foot.quaternion.copy(pq.invert().multiply(footQ)).normalize();l.foot.updateMatrixWorld(true);}
  l.foot.getWorldPosition(A);
  return want-d;
 }
 function turn(b,from,to){
  dq.setFromUnitVectors(from,to);b.getWorldQuaternion(wq);wq.premultiply(dq);
  b.parent.getWorldQuaternion(pq);b.quaternion.copy(pq.invert().multiply(wq)).normalize();b.updateMatrixWorld(true);
 }
 // The recorded foot of side s in the current pose (world): ankle, foot
 // turn, on the floor or not.
 function recorded(s){
  const l=legs[s];holder.updateMatrixWorld(true);inv.copy(holder.matrixWorld).invert();
  const ankle=l.foot.getWorldPosition(V()),toe=l.toe.getWorldPosition(V());
  const a=ankle.clone().applyMatrix4(inv),t=toe.applyMatrix4(inv);
  const down=Math.min(a.y-retarget.ankleHeight,t.y-retarget.toeHeight)<DOWN;
  return{ankle,quat:l.foot.getWorldQuaternion(Q()),down};
 }
 // Holds the feet of the pose just solved (holder at its board place).
 // now: the board's clock, s.
 function apply(now){
  holder.updateMatrixWorld(true);
  const at=holder.getWorldPosition(V());
  if(state&&(now<state.now-1e-9||now-state.now>RESET_TIME||at.distanceTo(state.at)>RESET_MOVE))state=null;
  const fresh=!state;if(fresh)state={now,at,feet:{}};
  const report={},alpha=fresh?1:1-Math.exp(-(now-state.now)/POLE_TAU);
  for(const s of ['L','R']){
   const r=recorded(s);let f=state.feet[s];
   if(!f)f=state.feet[s]={mode:r.down?'plant':'free',P:r.ankle.clone(),Q:r.quat.clone()};
   if(f.mode==='plant'){
    const flat=Math.hypot(r.ankle.x-f.P.x,r.ankle.z-f.P.z);
    const H0=legs[s].thigh.getWorldPosition(V()),l1=H0.distanceTo(legs[s].shin.getWorldPosition(V())),l2=legs[s].shin.getWorldPosition(V()).distanceTo(r.ankle);
    if(flat>STEP_HOLD||H0.distanceTo(f.P)>(l1+l2)*REACH){
     const d=f.P.distanceTo(r.ankle);
     f.mode='swing';f.t0=now;f.dur=Math.min(STEP_TIME[1],Math.max(STEP_TIME[0],d/STEP_SPEED));
     f.from=f.P.clone().sub(r.ankle);f.fromQ=f.Q.clone();f.lift=Math.min(LIFT[1],Math.max(LIFT[0],LIFT[2]*d));
    }
   }
   if(f.mode==='swing'){
    const u=(now-f.t0)/f.dur;
    if(u>=1){f.mode=r.down?'plant':'free';f.P.copy(r.ankle);f.Q.copy(r.quat);}
    else{const m=minJerk(u);G.copy(r.ankle).addScaledVector(f.from,1-m);
     // Never under both the spot it left and the recorded foot: a foot let
     // go while the recording lifts it would otherwise be pulled into the
     // board as the recording puts it down.
     G.y=Math.max(G.y,Math.min(f.P.y,r.ankle.y));if(r.down)G.y+=f.lift*Math.sin(Math.PI*u);
     reach(s,G,sq.copy(f.fromQ).slerp(r.quat,m),f,alpha,true);report[s]='swing';continue;}
   }
   if(f.mode==='free'){if(r.down){f.mode='plant';f.P.copy(r.ankle);f.Q.copy(r.quat);}
    else{G.copy(r.ankle);reach(s,G,r.quat,f,alpha,true);report[s]='free';continue;}} // in the air: the recorded foot and its turn, the knee in its smoothed plane
   reach(s,f.P,f.Q,f,alpha);report[s]='plant';
  }
  state.now=now;state.at=at;
  return report;
 }
 return{apply,reset,state:()=>state};
}
