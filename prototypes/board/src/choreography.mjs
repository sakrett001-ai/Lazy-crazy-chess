// Pawn takes pawn: the legal diagonal capture shown as a short fight with
// weight. The attacker turns and walks in on the diagonal, coils with its
// weight on the rear foot, feints at the defender's spear side and holds it
// for a readable moment. The defender swings its shield across to cover
// that side and so opens its other flank; the real thrust goes there with a
// lunge. The defender jolts, folds around the wound, its knees give way and
// it slumps to the board. The winner recoils, recovers and walks onto the
// square. No jumps or rolls.
//
// Everything here is an absolute function of time, so scrubbing backwards
// or replaying never accumulates error. Positions are board metres (x, z);
// a figure's local forward is +Z, its left +X, and its yaw follows three.js
// rotation.y. Body layers are the procedural layer of motion.mjs.
export const CAPTURE_DURATION=6.6;
export const HIT_TIME=3.45;
export const CAPTURE_PHASES=Object.freeze([
 {name:'turn',start:0,end:.5,label:'разворот на цель'},
 {name:'approach',start:.35,end:1.95,label:'сближение шагом'},
 {name:'coil',start:1.95,end:2.35,label:'замах, вес на заднюю ногу'},
 {name:'feint',start:2.35,end:2.6,label:'финт'},
 {name:'pause',start:2.6,end:3.05,label:'защитник уводит щит за финтом'},
 {name:'strike',start:3.05,end:HIT_TIME,label:'выпад в открытый бок'},
 {name:'impact',start:HIT_TIME,end:3.8,label:'попадание и отдача'},
 {name:'collapse',start:3.7,end:4.5,label:'ноги подкашиваются'},
 {name:'fall',start:4.35,end:5.1,label:'падение'},
 {name:'fade',start:5.3,end:5.9,label:'фигура снята с доски'},
 {name:'advance',start:5,end:CAPTURE_DURATION,label:'занятие клетки'}
]);

const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));
export const smooth=(t,a,b)=>{const u=clamp((t-a)/(b-a));return u*u*(3-2*u);};
const lerp=(a,b,u)=>a+(b-a)*u;
const bump=(t,a,b)=>t<=a||t>=b?0:Math.sin(Math.PI*(t-a)/(b-a));
export const wrapAngle=a=>{a=(a+Math.PI)%(2*Math.PI);if(a<0)a+=2*Math.PI;return a-Math.PI;};
export const lerpAngle=(a,b,u)=>a+wrapAngle(b-a)*u;
export const headingTo=(from,to)=>Math.atan2(to[0]-from[0],to[1]-from[1]);
// three.js rotation about Y applied to a local (x, z) offset.
export const rotate=([x,z],yaw)=>[x*Math.cos(yaw)+z*Math.sin(yaw),-x*Math.sin(yaw)+z*Math.cos(yaw)];
const unit=(a,b)=>{const l=Math.hypot(b[0]-a[0],b[1]-a[1]);return l>0?[(b[0]-a[0])/l,(b[1]-a[1])/l]:[0,1];};

// Sum of body layers; missing parts count as zero.
export function addLayers(...layers){
 const out={root:[0,0,0],pelvis:{yaw:0,roll:0,pitch:0},spine:{bend:0,side:0,twist:0},head:{bend:0,twist:0},feet:{L:{offset:[0,0,0],yaw:0,pitch:0},R:{offset:[0,0,0],yaw:0,pitch:0}}};
 for(const l of layers){if(!l)continue;
  if(l.root)for(let i=0;i<3;i++)out.root[i]+=l.root[i]||0;
  for(const part of ['pelvis','spine','head'])if(l[part])for(const k in l[part])out[part][k]=(out[part][k]||0)+l[part][k];
  for(const side of ['L','R']){const f=l.feet?.[side];if(!f)continue;const o=out.feet[side];if(f.offset)for(let i=0;i<3;i++)o.offset[i]+=f.offset[i]||0;o.yaw+=f.yaw||0;o.pitch+=f.pitch||0;}
 }
 return out;
}

// Smoothstep travel of length D over [a, a+T]: covered distance and the
// acceleration that tilts the body (forward on starting, back on braking).
export function travel(D,t,a,T){const u=clamp((t-a)/T);return{s:D*u*u*(3-2*u),accel:t<a||t>a+T?0:D*(6-12*u)/(T*T)};}

// Walking gait along a straight path of length D, driven by the distance
// already covered s, so a planted foot never slides whatever the easing of
// the body. Footfalls alternate at even step lengths and land ahead of the
// body; the trailing foot closes beside the other at the end. Returns the
// foot offsets along the path relative to the body, the foot lift, the
// vertical bob and the pelvis twist of the stride.
export function gait(D,s,{step=.62,lead='L',lift=.13}={}){
 const none={along:{L:0,R:0},lift:{L:0,R:0},bob:0,twist:0,swing:null};
 if(!(D>.05))return none;
 const n=Math.max(2,Math.round(D/step)),l=D/n,trail=lead==='L'?'R':'L';
 const land=j=>j>n?D:Math.min(D,Math.max(0,j*l-.3*l)),at=j=>Math.min(j,n)*l;
 const foot={L:0,R:0},up={L:0,R:0},fixed={L:false,R:false};let swing=null;
 for(let j=1;j<=n+1;j++){
  const side=j%2?lead:trail,from=j<=2?0:at(j-2),to=at(j),start=land(j-1),end=land(j);
  if(fixed[side])continue;
  if(s>=end){foot[side]=to;continue;}
  fixed[side]=true;
  if(s>start){const u=(s-start)/Math.max(1e-6,end-start);foot[side]=lerp(from,to,u*u*(3-2*u));up[side]=lift*Math.min(1,(to-from)/l)*Math.sin(Math.PI*u);swing=side;}
  else foot[side]=from;
 }
 const settle=smooth(s,0,.25*l)*(1-smooth(s,D-.35*l,D)),phase=Math.PI*s/l;
 // Lowest when weight passes from foot to foot, highest when the legs cross.
 return{along:{L:foot.L-s,R:foot.R-s},lift:up,bob:settle*(-.022+.018*Math.cos(2*phase)),twist:settle*.07*Math.sin(phase)*(lead==='L'?1:-1),swing};
}

// Body layer of a figure walking in world direction dir while facing yaw.
export function walkLayer(D,s,accel,dir,yaw,options){
 const g=gait(D,s,options),[lx,lz]=rotate(dir,-yaw);
 const foot=side=>({offset:[lx*g.along[side],g.lift[side],lz*g.along[side]],pitch:-.35*g.lift[side]});
 const lean=D>.05?clamp(.035*accel,-.12,.12)+.04*smooth(s,0,.3)*(1-smooth(s,D-.3,D)):0;
 return{root:[0,g.bob,0],pelvis:{yaw:g.twist},spine:{twist:-.8*g.twist,bend:lean},head:{twist:.4*g.twist},feet:{L:foot('L'),R:foot('R')}};
}

// Calm stance: slow weight shift between the feet and a look around, so a
// waiting figure is never a statue. offset de-synchronises the figures.
export function idleLayer(t,offset=0){
 const w=t*.55+offset*6.283,look=t*.21+offset*3.1;
 return{root:[.016*Math.sin(w),-.006+.005*Math.sin(2*w),0],pelvis:{roll:-.025*Math.sin(w)},spine:{side:.03*Math.sin(w),twist:.04*Math.sin(look*.7)},head:{twist:.16*Math.sin(look),bend:.04*Math.sin(look*1.3)}};
}

// Attacker body without the walk: guard, coil, feint, lunge, recoil.
function attackerBody(t){
 const guard=smooth(t,0,.5)*(1-smooth(t,5.6,6.4));
 const coil=smooth(t,1.95,2.35)*(1-smooth(t,2.35,2.55));
 const feint=smooth(t,2.35,2.55)*(1-smooth(t,2.95,3.15));
 const lunge=smooth(t,3.05,HIT_TIME)*(1-smooth(t,3.8,4.45));
 const tau=t-HIT_TIME,recoil=tau>0?.045*(1-Math.exp(-tau/.035))*Math.exp(-tau/.2):0;
 // The lead (left) foot stamps on the feint, drives the lunge, then returns.
 const stamp=.1*smooth(t,2.35,2.52),drive=.17*smooth(t,3.05,3.35),back=(stamp+drive)*smooth(t,3.85,4.35);
 const footLift=.06*bump(t,2.35,2.52)+.08*bump(t,3.05,3.35)+.07*bump(t,3.85,4.35);
 return addLayers(
  {root:[0,-.045*guard,0],spine:{bend:.05*guard}},
  {root:[0,-.035*coil,-.08*coil],pelvis:{yaw:-.12*coil},spine:{twist:-.34*coil,bend:-.05*coil},head:{twist:.2*coil}},
  {root:[0,0,.05*feint],spine:{twist:.24*feint},head:{twist:-.1*feint}},
  {root:[0,-.06*lunge,.15*lunge-recoil],pelvis:{yaw:.12*lunge},spine:{bend:.03*lunge},head:{bend:-.04*lunge}},
  {feet:{L:{offset:[0,footLift,stamp+drive-back],pitch:-.4*footLift}}}
 );
}
// The attacker layer at the moment of impact. The spear reach used for
// aiming is measured on the model with this layer applied.
export const strikeLayer=()=>attackerBody(HIT_TIME);

// Defender hit at time tau after impact, struck from local direction hit
// (unit x, z). Jolt along the blow, fold around the wound, knees give way.
export function victimHitLayer(tau,hit){
 if(tau<=0)return null;
 const jolt=smooth(tau,0,.12)+.25*bump(tau,.08,.4),fold=smooth(tau,0,.2)+.2*bump(tau,.12,.5);
 // Knees buckle under gravity: slow at first, then fast.
 const sag=clamp((tau-.25)/.8)**2;
 const stagger=smooth(tau,.1,.4),stepLift=.07*bump(tau,.1,.4);
 return{root:[hit[0]*.1*jolt,-.38*sag,hit[1]*.1*jolt],spine:{bend:.32*fold+.22*sag,side:.22*fold,twist:.22*fold},head:{bend:.22*fold+.2*sag,twist:.1*fold},
  feet:{R:{offset:[hit[0]*.18*stagger,stepLift,hit[1]*.18*stagger],pitch:-.3*stepLift}}};
}

// reach: the spear tip at full extension with the strike layer, in the
// attacker's local frame, measured from the skinned model ({x, z}, metres).
export function planCapture({from,to,end=to,attackerYaw,victimYaw,reach,bite=.04}){
 const length=Math.hypot(to[0]-from[0],to[1]-from[1]);
 if(!(length>0))throw Error('Атакующий и цель на одной клетке');
 // The defender turns to face the attacker, then swings its shield across
 // to its right after the feint; the open flank is its left side.
 const face=lerpAngle(victimYaw,headingTo(to,from),.7),exposed=face-.75;
 const flankOffset=rotate([.19,-.05],exposed),flank=[to[0]+flankOffset[0],to[1]+flankOffset[1]];
 const d=unit(from,flank),tipTarget=[flank[0]+d[0]*bite,flank[1]+d[1]*bite];
 // Yaw the attacker so the off-centre spear tip lies on the line of attack.
 const strikeYaw=Math.atan2(d[0],d[1])-Math.atan2(reach.x,reach.z);
 const offset=rotate([reach.x,reach.z],strikeYaw);
 const strikePoint=[tipTarget[0]-offset[0],tipTarget[1]-offset[1]];
 const approachLength=Math.hypot(strikePoint[0]-from[0],strikePoint[1]-from[1]);
 return{from,to,end,d,face,flank,strikeYaw,strikePoint,tipTarget,attackerYaw,victimYaw,approachLength};
}

export function captureAt(plan,t){
 t=clamp(t,0,CAPTURE_DURATION);
 const {from,to,end,strikePoint,strikeYaw,attackerYaw,victimYaw,face,d}=plan;
 // Attacker: position and heading.
 let yaw=lerpAngle(attackerYaw,strikeYaw,smooth(t,0,.5)),pos,walk=null;
 const inDir=unit(from,strikePoint),inLen=plan.approachLength,outDir=unit(strikePoint,end),outLen=Math.hypot(end[0]-strikePoint[0],end[1]-strikePoint[1]);
 if(t<5){const m=travel(inLen,t,.35,1.6);pos=[from[0]+inDir[0]*m.s,from[1]+inDir[1]*m.s];walk=walkLayer(inLen,m.s,m.accel,inDir,yaw);}
 else{const m=travel(outLen,t,5,1.4);pos=[strikePoint[0]+outDir[0]*m.s,strikePoint[1]+outDir[1]*m.s];yaw=lerpAngle(strikeYaw,attackerYaw,smooth(t,5.7,6.6));walk=walkLayer(outLen,m.s,m.accel,outDir,yaw);}
 let action='Guard_Breath',time=t%6;
 const spear=[[1.95,0],[2.35,1],[2.55,1.5],[2.95,1.42],[3.1,1.05],[HIT_TIME,1.95],[3.75,2],[4.6,4]];
 if(t>=spear[0][0]&&t<spear.at(-1)[0]){action='Spear_Study';const i=spear.findIndex(([at])=>at>t);const [t0,v0]=spear[i-1],[t1,v1]=spear[i];time=lerp(v0,v1,smooth(t,t0,t1));}
 else if(t>=spear.at(-1)[0])time=(t-spear.at(-1)[0])%6;
 const layer=addLayers(attackerBody(t),walk);
 // Defender: turns to face the attacker and raises the shield, follows the
 // feint with the shield, is struck, buckles and falls along the blow.
 let vAction='Guard_Breath',vTime=t%6;
 const vYaw=lerpAngle(victimYaw,face,smooth(t,.4,1.1));
 if(t>=.5){vAction='Shield_Brace';vTime=lerp(0,1,smooth(t,.5,1.1));if(t>=2.4)vTime=lerp(1,2,smooth(t,2.4,2.8));if(t>=3.5)vTime=lerp(2,.3,smooth(t,3.5,4.1));}
 const guard=smooth(t,.5,1.1),cover=smooth(t,2.42,2.8),tau=t-HIT_TIME,untwist=smooth(tau,0,.3);
 const hit=rotate(d,-vYaw);
 const vLayer=addLayers(
  {root:[0,-.05*guard,0],spine:{bend:.06*guard}},
  {root:[-.06*cover,0,0],pelvis:{yaw:-.3*cover*(1-.5*untwist)},spine:{twist:-.75*cover*(1-.6*untwist)},head:{twist:-.25*cover*(1-untwist)},feet:{R:{offset:[-.09*cover,.06*bump(t,2.42,2.7),0]}}},
  victimHitLayer(tau,hit)
 );
 const fallU=clamp((t-4.35)/.6);
 // Gravity-like acceleration, then a small settle on the board.
 const fall=t<4.35?0:fallU<1?1.42*fallU*fallU:1.42-.05*Math.sin(Math.PI*clamp((t-4.95)/.15));
 const opacity=1-smooth(t,5.3,5.9);
 return{
  attacker:{position:pos,yaw,action,time,layer},
  victim:{position:to.slice(),yaw:vYaw,action:vAction,time:vTime,layer:vLayer,fall,fallHeading:Math.atan2(d[0],d[1]),opacity,removed:t>=5.9},
  phase:CAPTURE_PHASES.filter(p=>t>=p.start&&t<p.end).map(p=>p.name)
 };
}
