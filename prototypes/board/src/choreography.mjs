// Pawn takes pawn: the legal diagonal capture shown as a short fight.
// The attacker comes in from the diagonal, feints, the defender turns its
// shield towards the feint, and the real thrust goes into the open flank.
// No jumps or rolls: turn, step, feint, thrust, fall, step in.
//
// Everything here is an absolute function of time, so scrubbing backwards
// or replaying never accumulates error. Positions are board metres (x, z);
// a figure's local forward is +Z and its yaw follows three.js rotation.y.
export const CAPTURE_DURATION=4.4;
export const CAPTURE_PHASES=Object.freeze([
 {name:'turn',start:0,end:.45,label:'разворот на цель'},
 {name:'approach',start:.25,end:1.25,label:'сближение по диагонали'},
 {name:'feint',start:1.25,end:1.85,label:'финт'},
 {name:'strike',start:1.85,end:2.3,label:'укол в открытый бок'},
 {name:'fall',start:2.3,end:3.3,label:'падение'},
 {name:'fade',start:3.3,end:3.9,label:'фигура снята с доски'},
 {name:'advance',start:3.4,end:4.4,label:'занятие клетки'}
]);
export const HIT_TIME=2.3;

const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));
const smooth=(t,a,b)=>{const u=clamp((t-a)/(b-a));return u*u*(3-2*u);};
const lerp=(a,b,u)=>a+(b-a)*u;
export const wrapAngle=a=>{a=(a+Math.PI)%(2*Math.PI);if(a<0)a+=2*Math.PI;return a-Math.PI;};
export const lerpAngle=(a,b,u)=>a+wrapAngle(b-a)*u;
export const headingTo=(from,to)=>Math.atan2(to[0]-from[0],to[1]-from[1]);
// three.js rotation about Y applied to a local (x, z) offset.
export const rotate=([x,z],yaw)=>[x*Math.cos(yaw)+z*Math.sin(yaw),-x*Math.sin(yaw)+z*Math.cos(yaw)];

// reach: the spear tip at full extension in the attacker's local frame,
// measured from the actual skinned model ({x, z} in metres).
export function planCapture({from,to,end=to,attackerYaw,victimYaw,reach,bite=.12}){
 const length=Math.hypot(to[0]-from[0],to[1]-from[1]);
 if(!(length>0))throw Error('Атакующий и цель на одной клетке');
 const d=[(to[0]-from[0])/length,(to[1]-from[1])/length];
 const tipTarget=[to[0]-d[0]*bite,to[1]-d[1]*bite];
 // Yaw the attacker so the off-centre spear tip lies on the line of attack.
 const strikeYaw=Math.atan2(d[0],d[1])-Math.atan2(reach.x,reach.z);
 const offset=rotate([reach.x,reach.z],strikeYaw);
 const strikePoint=[tipTarget[0]-offset[0],tipTarget[1]-offset[1]];
 const approachLength=Math.hypot(strikePoint[0]-from[0],strikePoint[1]-from[1]);
 return{from,to,end,d,strikeYaw,strikePoint,tipTarget,attackerYaw,victimYaw,approachLength,feintYaw:lerpAngle(victimYaw,headingTo(to,from),.28)};
}

export function captureAt(plan,t){
 t=clamp(t,0,CAPTURE_DURATION);
 const {from,to,end,strikePoint,strikeYaw,attackerYaw,victimYaw}=plan;
 // Attacker
 let pos=from.slice(),yaw=lerpAngle(attackerYaw,strikeYaw,smooth(t,0,.45)),action='Guard_Breath',time=t%6;
 const approach=smooth(t,.25,1.25);
 pos=[lerp(from[0],strikePoint[0],approach),lerp(from[1],strikePoint[1],approach)];
 if(t>=1.25&&t<1.6){action='Spear_Study';time=lerp(0,1.35,smooth(t,1.25,1.6));}
 else if(t>=1.6&&t<1.85){action='Spear_Study';time=lerp(1.35,.95,smooth(t,1.6,1.85));}
 else if(t>=1.85&&t<2.3){action='Spear_Study';time=lerp(.95,1.95,smooth(t,1.85,2.3));}
 else if(t>=2.3&&t<3.4){action='Spear_Study';time=lerp(1.95,4,smooth(t,2.3,3.4));}
 if(t>=3.4){
  const step=smooth(t,3.4,4.2);
  pos=[lerp(strikePoint[0],end[0],step),lerp(strikePoint[1],end[1],step)];
  yaw=lerpAngle(strikeYaw,attackerYaw,smooth(t,3.8,4.4));
 }
 // Victim: reacts to the feint, is struck in the flank, falls away.
 let vAction='Guard_Breath',vTime=t%6,vYaw=victimYaw;
 if(t>=1.4){vAction='Shield_Brace';vTime=lerp(0,1.2,smooth(t,1.4,1.85));vYaw=lerpAngle(victimYaw,plan.feintYaw,smooth(t,1.4,1.85));}
 const fallU=clamp((t-HIT_TIME)/.85);
 // Gravity-like acceleration, then a small settle on the board.
 const fall=t<HIT_TIME?0:fallU<1?1.47*fallU*fallU:1.47-.05*Math.sin(Math.PI*clamp((t-HIT_TIME-.85)/.15));
 const opacity=1-smooth(t,3.3,3.9);
 return{
  attacker:{position:pos,yaw,action,time},
  victim:{position:to.slice(),yaw:vYaw,action:vAction,time:vTime,fall,fallHeading:Math.atan2(plan.d[0],plan.d[1]),opacity,removed:t>=3.9},
  phase:CAPTURE_PHASES.filter(p=>t>=p.start&&t<p.end).map(p=>p.name)
 };
}
