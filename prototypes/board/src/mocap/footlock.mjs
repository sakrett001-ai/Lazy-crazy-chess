import * as THREE from 'three';
import {PAWN} from './retarget.mjs';
import {STILL} from './smoothness.mjs';

// Planted feet on the board. The recording drives the legs by the
// directions of their bones (retarget.mjs), and the pawn's legs are not the
// fencer's: a foot that stands still in the recording creeps over the board
// as the knees bend, the holder turns with the aim and the clips cross-fade
// from one fighter to the other. A fencer's foot does not creep: it stands,
// or it steps.
//
// So each foot is held where it was put down, in the board's frame, and the
// leg reaches it by two-bone IK (thigh and shin keep their lengths, the knee
// stays in its own bending plane). It is let go only for a step: as the
// recorded foot lifts and moves off (STEP_LIFTED), when the recording sets
// it down more than STEP_HOLD away and holds it there (a recorded foot that
// slides is followed once it stands again), or when the leg cannot reach
// it. A step lifts the foot in place first and sets it down in place last
// (OFF), so the sole does not skid over the floor at either end, and it
// lasts as long as the recorded foot is up. While a clip fades into the
// stance under it, the feet step onto that stance one at a time instead of
// sliding into it. A foot set down bears the weight MIN_STAND before it
// lifts again. The path is a minimum-jerk curve (Flash & Hogan 1985). The
// state is the figure's own, kept between frames by time (the board's
// clock): a jump in time or place starts over.
export const STEP_HOLD=.15;        // m on the board, shortest step a planted foot makes
export const DOWN=.02;             // m, a recorded foot this close to its rest height is on the floor
// s, a foot set down bears the weight this long before it lifts again:
// the shortest ground contact of a running stride is about 0.1 s (Weyand et
// al. 2000, J Appl Physiol 89: 1991–1999), a fencer's step stands longer.
export const MIN_STAND=.1;
export const STEP_LIFTED=.05;      // m, a recorded foot up and moving this far from where it stands is stepping
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
// Share of a step, from its start, by which the foot is up enough to aim
// (before: it lifts off its spot), and from which it is coming down and no
// longer aims (after: it stops over the spot it lands on). A planted foot
// does not slide; up to 3 cm is the micro-slip of normal gait (Liberty
// Mutual 2004, after Strandberg & Lanshammar 1981), more shows.
export const AIM=[.25,.7];
export const CAP=.85;              // share of a step it waits at while the recorded foot is still up and moving
// m/s, a recorded foot up and moving faster than this carries the step on
// (it is still stepping); one up but nearly still is only held off the
// floor by the camera's depth noise, and the step comes down.
export const CARRY=.3;
export const RELEASE=.95;          // clip weight under which the feet step onto the stance it fades into
export const SETTLE=.01;           // m, off that stance by more, a foot steps onto it
export const SKIM=.02;             // m, a foot carried along with the recording stays this far off the floor
export const OFF=.12;              // share of a step at each end with the foot rising or setting down in place
export const SKID=.03;             // m, most a foot on the floor may move at a lift-off or a landing
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
  const above=Math.min(a.y-retarget.ankleHeight,t.y-retarget.toeHeight);
  return{ankle,quat:l.foot.getWorldQuaternion(Q()),down:above<DOWN,above};
 }
 // The ankles of the pose as it is now (holder frame, the holder at rest),
 // for the stance a clip fades into.
 function capture(){holder.updateMatrixWorld(true);inv.copy(holder.matrixWorld).invert();return Object.fromEntries(['L','R'].map(s=>[s,legs[s].foot.getWorldPosition(V()).applyMatrix4(inv)]));}
 // A step of foot f from where it stands (f.P, f.Q) towards the recorded foot r.
 function launch(f,r,now){
  const d=f.P.distanceTo(r.ankle);
  f.mode='swing';f.u=0;f.dur=Math.min(STEP_TIME[1],Math.max(STEP_TIME[0],d/STEP_SPEED));
  f.P0=f.P.clone();f.F=r.ankle.clone();f.fromQ=f.Q.clone();f.lift=Math.min(LIFT[1],Math.max(LIFT[0],LIFT[2]*d));
 }
 // Holds the feet of the pose just solved (holder at its board place).
 // now: the board's clock, s.
 function apply(now,{hold=1,stance=null}={}){
  // A clip letting go of the legs (hold under RELEASE): each foot makes one
  // last step onto the recorded foot, now the stance the clip fades into,
  // and lands with it as it comes to rest.
  const letGo=hold<RELEASE;
  holder.updateMatrixWorld(true);
  const at=holder.getWorldPosition(V());
  if(state&&(now<state.now-1e-9||now-state.now>RESET_TIME||at.distanceTo(state.at)>RESET_MOVE))state=null;
  const fresh=!state;if(fresh)state={now,at,feet:{}};
  const report={},alpha=fresh?1:1-Math.exp(-(now-state.now)/POLE_TAU);
  for(const s of ['L','R']){
   const r=recorded(s);let f=state.feet[s];
   // Letting go, the foot is aimed at the stance the clip fades into, not
   // at the blend on the way there (it steps once, onto where it ends up).
   if(letGo&&stance?.[s]){r.ankle.copy(stance[s]).applyMatrix4(holder.matrixWorld);r.down=true;}
   // A foot found up is taken as in the carry of a step (it comes down as
   // any step does, where it is when the recorded foot is down).
   // A foot found up (the hold starting over) goes with the recorded foot
   // until that is down and has stopped, kept SKIM off the floor so that it
   // does not slide over it, then stands there.
   if(!f)f=state.feet[s]={mode:r.down?'plant':'skim',P:r.ankle.clone(),Q:r.quat.clone()};
   const last=f.R;f.R=r.ankle.clone();f.R0=last;
   if(f.mode==='skim'){const dt=Math.max(0,now-state.now),rv=dt>0&&last?Math.hypot(r.ankle.x-last.x,r.ankle.z-last.z)/dt:Infinity;
    if(r.down&&rv<CARRY){f.mode='plant';f.down=now;f.P.copy(r.ankle);f.Q.copy(r.quat);}
    else{G.copy(r.ankle);G.y+=Math.max(0,SKIM-Math.max(0,r.above));reach(s,G,r.quat,f,alpha,true);report[s]='skim';continue;}}
   if(f.mode==='plant'){
    const flat=Math.hypot(r.ankle.x-f.P.x,r.ankle.z-f.P.z);
    const H0=legs[s].thigh.getWorldPosition(V()),l1=H0.distanceTo(legs[s].shin.getWorldPosition(V())),l2=legs[s].shin.getWorldPosition(V()).distanceTo(r.ankle);
    // A step starts as the recorded foot lifts and moves off (not only once
    // it has gone STEP_HOLD away): started late, a step is short and lands
    // before the recorded one, and the rest is a second step.
    const dt=Math.max(0,now-state.now),rv=dt>0&&f.R0?Math.hypot(r.ankle.x-f.R0.x,r.ankle.z-f.R0.z)/dt:0;
    const settled=now-(f.down??-Infinity)>=MIN_STAND;
    // One foot at a time onto the stance: the other stands meanwhile.
    const other=state.feet[s==='L'?'R':'L'],alone=!letGo||!other||other.mode==='plant';
    // A recorded foot that slides along the floor is followed in one step
    // once it stands still again (STILL, as smoothness.mjs counts a standing
    // foot) or lifts, not chased while it still moves.
    const rest=letGo||!r.down||rv<STILL;
    if(settled&&((alone&&rest&&flat>(letGo?SETTLE:STEP_HOLD))||(!r.down&&rv>CARRY&&flat>STEP_LIFTED)||H0.distanceTo(f.P)>(l1+l2)*REACH)){
     launch(f,r,now);
    }
   }
   if(f.mode==='swing'){
    // A step lasts as long as the recorded foot is up: while it is, the
    // step does not come down past AIM[1] (it travels with it, lifted), and
    // it lands once the recorded foot is down again.
    const dt=Math.max(0,now-state.now),rv=dt>0&&f.R0?Math.hypot(r.ankle.x-f.R0.x,r.ankle.z-f.R0.z)/dt:0;
    f.u+=dt/f.dur;if(!r.down&&rv>CARRY)f.u=Math.min(f.u,CAP);
    const u=f.u;
    // The spot it comes down on follows the recorded foot only while the
    // foot is up (AIM): on the floor a foot does not slide, it lifts off
    // before it travels and stops before it is put down. The recorded foot
    // runs on a few centimetres after its own landing (the camera's depth
    // noise and the build's smoothing); those stay out of the step.
    const gate=r.down&&!letGo?minJerk(u/AIM[0])*(1-minJerk((u-AIM[1])/(1-AIM[1]))):minJerk(u/AIM[0]);
    if(u<1&&gate>0){f.F.x+=(r.ankle.x-f.F.x)*gate;f.F.z+=(r.ankle.z-f.F.z)*gate;}
    f.F.y=r.ankle.y;
    // Up first, then over: the foot rises off its spot before it travels
    // and comes straight down onto the spot it lands on (the ends, OFF of
    // the step, are the lift-off and the set-down).
    const m=minJerk((u-OFF)/(1-2*OFF));G.copy(f.P0).lerp(f.F,m);
    // Lifted on an arc over the floor it leaves and the floor it lands on
    // (never under the lower of the two), or as the recording lifts it.
    G.y=Math.max(G.y,Math.min(f.P0.y,f.F.y)+f.lift*Math.sin(Math.PI*Math.min(1,u)));
    if(u>=1){f.mode='plant';f.down=now;f.P.copy(G);f.Q.copy(r.quat);}
    else{reach(s,G,sq.copy(f.fromQ).slerp(r.quat,m),f,alpha,true);report[s]='swing';continue;}
   }
   reach(s,f.P,f.Q,f,alpha);report[s]='plant';
  }
  state.now=now;state.at=at;
  return report;
 }
 return{apply,reset,capture,state:()=>state};
}
