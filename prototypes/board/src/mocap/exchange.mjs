import {sampleClip,centerPoints} from './format.mjs';
import {lerp} from './math.mjs';

// Exchange of blows between two adjacent fighters, played from a recorded
// bout (role exchange, tools/duels/build.py). A cycle is the recording's
// «close in — strike and answer — part»: one clip for the attacker (side
// attack), one for the defender (side defend), each in its own fighter's
// frame. Neighbours that cannot take each other exchange forever: the
// roles swap every cycle and nobody wins (exchangeAt). A capture plays the
// same exchange and ends on the cycle where the blow landed unanswered
// (decisive): the taken figure loses the duel (board.mjs).
//
// Each figure stands on its own square. The bout was recorded closer than
// two squares are apart and further than they come at their closest, so the
// fighters' approach is scaled (exchangeLayout): the figures come as close
// as the fighters did, never into each other.

const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const smooth=(t,a,b)=>{const u=clamp((t-a)/(b-a),0,1);return u*u*(3-2*u);};
export const CROSSFADE=.3; // s, one cycle's end blended into the next one's start

// The pairs in a set of prepared clips: {attack,defend} for the endless
// exchange and for the decisive blow (either may be missing).
export function exchangePairs(clips){
 const pair=decisive=>{const attack=clips.find(c=>c.role==='exchange'&&c.side==='attack'&&!!c.decisive===decisive);
  const defend=attack&&clips.find(c=>c.name===attack.partner&&c.side==='defend');return defend?{attack,defend}:null;};
 return{exchange:pair(false),decisive:pair(true)};
}

// Forward travel of a clip's pelvis from its start (source units, +Z is
// towards the partner) and sideways drift, at time t.
export const travelAt=(clip,t)=>{const p=sampleClip(clip,t).pelvis,o=clip.frames[0].pelvis;return{forward:p[2]-o[2],side:p[0]-o[0]};};

// How a cycle fits two squares `distance` apart for a figure whose legs are
// k times the recording's: scale for the approach and the pelvis-to-pelvis
// gap over the cycle (board units). The recorded closest gap is kept.
// A given scale (the board's fit of the blow, board.mjs) replaces the one
// that keeps the recorded closest gap.
// The scale may also be a closing for one meeting ({base, more, meet,
// back: [t1, t2]}): up to the meeting the approach is scaled by base+more,
// so the pair stands closer where blow and defence meet; after it the extra
// closing is given back over back (a step out, Abzug), so the cycle ends
// where the base scale ends it and the next one starts without dragging the
// feet back (approachAt, plantShift).
export function approachAt(scale,clip,t){
 const F=travelAt(clip,t).forward;if(typeof scale==='number')return scale*F;
 const {base,more,meet,back}=scale;
 return base*F+more*travelAt(clip,Math.min(t,meet)).forward*(1-smooth(t,back[0],back[1]));
}
export function exchangeLayout(pair,k,distance,given=null){
 const {attack,defend}=pair,D=Math.max(attack.duration,defend.duration),gap0=(attack.events?.gap??distance/k);
 let close=0;for(let t=0;t<=D+1e-9;t+=1/30)close=Math.max(close,travelAt(attack,t).forward+travelAt(defend,t).forward);
 const closest=(gap0-close)*k,scale=given??(close>1e-6?clamp((distance-closest)/(close*k),0,1):1);
 const gapAt=t=>distance-k*(approachAt(scale,attack,t)+approachAt(scale,defend,t));
 let min=Infinity;for(let t=0;t<=D+1e-9;t+=1/30)min=Math.min(min,gapAt(t));
 return{scale,closest:min,recordedClosest:closest,gapAt};
}

// One figure's body in a cycle at local time t: key points centred on the
// pelvis (the holder is placed there) and the pelvis offset from the
// figure's square in its own frame, board units ({x,z}, z forward). Only
// the travel along the line is kept: sideways the recording drifts by up to
// half a metre in a cycle, mostly the single camera's depth (the bout runs
// across the camera at an angle), and two figures on their squares would
// walk off the line of the fight.
export function cyclePose(clip,t,k,scale){
 const p=sampleClip(clip,t);
 return{points:plantFeet(clip,t,scale,holdThrust(clip,t,centerPoints(p))),offset:{x:0,z:approachAt(scale,clip,t)*k}};
}

// The figure's pelvis does not travel as the recorded one: the approach is
// scaled to the squares and the sideways drift is dropped (cyclePose). A
// foot standing in the recording (events.plants, tools/videomocap/footwork.py)
// would then slide over the board by the difference. While it stands, it is
// moved back by that difference since the stand began, so it keeps its place
// on the board; between stands the correction runs out smoothly, so a step
// lands where the recording put it. The knee follows by two-bone IK in the
// plane of the recorded knee.
const FOOT_POINTS=s=>['ankle'+s,'heel'+s,'toe'+s];
function plantShift(clip,t,scale){
 const plants=clip.events?.plants;if(!plants)return null;
 const gap=u=>{const {forward,side}=travelAt(clip,u);return[side,forward-approachAt(scale,clip,u)];};
 const out={};
 for(const s of ['L','R']){const list=plants[s]||[];let d=[0,0];
  for(let i=0;i<list.length;i++){const [a,b]=list[i];
   if(t<a){if(i>0){const [pa,pb]=list[i-1],ga=gap(pa),gb=gap(pb),w=1-smooth(t,pb,a);d=[(gb[0]-ga[0])*w,(gb[1]-ga[1])*w];}break;}
   if(t<=b){const ga=gap(a),gt=gap(t);d=[gt[0]-ga[0],gt[1]-ga[1]];break;}
   if(i===list.length-1){const ga=gap(a),gb=gap(b);d=[gb[0]-ga[0],gb[1]-ga[1]];}}
  out[s]=d;}
 return out;
}
function plantFeet(clip,t,scale,points){
 const shift=plantShift(clip,t,scale);if(!shift)return points;
 const out={...points};
 for(const s of ['L','R']){const [dx,dz]=shift[s];if(Math.abs(dx)+Math.abs(dz)<1e-6)continue;
  for(const n of FOOT_POINTS(s))if(points[n])out[n]=[points[n][0]+dx,points[n][1],points[n][2]+dz];
  const H=points['hip'+s],K=points['knee'+s],A=points['ankle'+s];if(!H||!K||!A)continue;
  out['knee'+s]=kneeFor(H,K,A,out['ankle'+s]);}
 return out;
}
// Knee for a hip and a moved ankle, thigh and shin keeping their lengths,
// bending in the plane of the given knee.
function kneeFor(H,K,A,goal){
 const sub=(u,v)=>u.map((x,i)=>x-v[i]),dot=(u,v)=>u[0]*v[0]+u[1]*v[1]+u[2]*v[2],len=u=>Math.hypot(...u);
 const l1=len(sub(K,H)),l2=len(sub(A,K)),d=sub(goal,H),dist=clamp(len(d),Math.abs(l1-l2)+1e-4,l1+l2-1e-4),axis=d.map(v=>v/(len(d)||1));
 let pole=sub(K,H);pole=sub(pole,axis.map(v=>v*dot(pole,axis)));const n=len(pole);if(n<1e-6)return K;pole=pole.map(v=>v/n);
 const c=clamp((l1*l1+dist*dist-l2*l2)/(2*l1*dist),-1,1),h=Math.sqrt(1-c*c);
 return H.map((x,i)=>x+axis[i]*l1*c+pole[i]*l1*h);
}

// The spear hangs from the trunk (loadout.mjs), and two metres of it turn a
// small turn of the shoulders into a wide sweep of the point: in the
// decisive cycle of ролик 516 the attacker's trunk turns 18° in one frame at
// the reach and 45° over 0,2 s, so the point would swipe 0,6 m a frame
// across the partner instead of going in. A swordsman can turn through his
// cut; a spearman holds the line of the thrust with his shoulders while the
// hips turn under them. So over the thrust the attacker's upper body keeps
// the yaw it has at the reach (the board aims the thrust by that pose),
// within the spine's twist over the hips (TWIST_MAX), eased in over the
// last HOLD_IN seconds before the reach and out after the recovery. Earlier
// the thrust is still drawn and the trunk turns with the step: holding it
// from the chamber twisted the shoulders 45° over the hips and swung the
// shield across the front leg.
const TWIST_MAX=50*Math.PI/180,HOLD_IN=.15;
const yawOf=(L,R)=>Math.atan2(-(R[2]-L[2]),R[0]-L[0]);
const wrapA=a=>Math.atan2(Math.sin(a),Math.cos(a));
const LOWER=/^(pelvis|hip|knee|ankle|heel|toe)/;
const reachYaws=new WeakMap();
function holdThrust(clip,t,points){
 const s=clip.events?.strike;if(clip.side!=='attack'||!s||!points.shoulderL||!points.hipL)return points;
 if(!reachYaws.has(clip)){const q=centerPoints(sampleClip(clip,s.reach));reachYaws.set(clip,yawOf(q.shoulderL,q.shoulderR));}
 const w=smooth(t,s.reach-HOLD_IN,s.reach)*(1-smooth(t,s.reach+.25,s.reach+.6));if(w<=0)return points;
 const sh=yawOf(points.shoulderL,points.shoulderR),hip=yawOf(points.hipL,points.hipR);
 const want=hip+clamp(wrapA(reachYaws.get(clip)-hip),-TWIST_MAX,TWIST_MAX),a=wrapA(want-sh)*w;
 if(Math.abs(a)<1e-6)return points;
 const c=Math.cos(a),n=Math.sin(a),o=points.pelvis,out={};
 // yawOf negates z: a turn by +a is x,z → (x cos a + z sin a, −x sin a + z cos a) about the pelvis.
 for(const [name,v] of Object.entries(points)){if(LOWER.test(name)){out[name]=v;continue;}
  const x=v[0]-o[0],z=v[2]-o[2];out[name]=[o[0]+x*c+z*n,v[1],o[2]-x*n+z*c];}
 return out;
}
// Two cycles' bodies blended. The points blend for the arms' measures; the
// body itself is blended pose against pose (fade, for bodyMotion): each clip
// is retargeted with its own fighter's calibration (ground, neutral stance),
// and a blend of points under one of them lifts the figure by the other's
// foot height at the swap of roles.
const blendPose=(a,b,w,clip)=>{if(w<=0)return{...a,fade:{clip,points:a.points,u:0}};if(w>=1)return b;const points={};for(const n of Object.keys(b.points))points[n]=lerp(a.points[n],b.points[n],w);
 return{points,offset:{x:a.offset.x+(b.offset.x-a.offset.x)*w,z:a.offset.z+(b.offset.z-a.offset.z)*w},fade:{clip,points:a.points,u:w}};};
// The motion for the pawn's pose (actors.mjs solve) of a body from
// exchangeAt or the capture: the clip's own pose, or during a crossfade the
// previous clip's pose blended into this one's. weight: the recording's share;
// look(points): the head turned to the partner.
export function bodyMotion(body,weight,look=p=>p,arms){
 const own={clip:body.clip,points:look(body.cur||body.points),weight};
 if(!body.fade)return{...own,arms};
 return{blend:[{clip:body.fade.clip,points:look(body.fade.points),weight},{...own,weight:weight*body.fade.u}],arms};
}

// The endless exchange: which side a figure plays now and its body.
// role is the board's fencing role (behavior.mjs): lead attacks in even
// cycles, follow in odd ones, solo (its opponent busy elsewhere) every one.
// A cycle lasts the clip minus the crossfade; its first CROSSFADE seconds
// blend the previous cycle's tail (the other side's, if they swapped).
export function exchangeAt(pair,role,clock,k,scale){
 const L=Math.min(pair.attack.duration,pair.defend.duration)-CROSSFADE,n=Math.floor(clock/L),local=clock-n*L;
 const sideOf=i=>role==='solo'||(role==='lead'?i%2===0:i%2!==0)?'attack':'defend';
 const side=sideOf(n),clip=pair[side],cur=cyclePose(clip,local,k,scale);
 if(local>=CROSSFADE)return{side,clip,local,cycle:n,...cur};
 const prev=pair[sideOf(n-1)],tail=cyclePose(prev,local+L,k,scale);
 return{side,clip,local,cycle:n,cur:cur.points,...blendPose(tail,cur,smooth(local,0,CROSSFADE),prev)};
}

// Piecewise eased keys [[t,value],...]: the value at t, held at the ends.
export function keyed(keys,t){
 if(t<=keys[0][0])return keys[0][1];
 for(let i=1;i<keys.length;i++)if(t<keys[i][0]){const [t0,v0]=keys[i-1],[t1,v1]=keys[i];return v0+(v1-v0)*smooth(t,t0,t1);}
 return keys.at(-1)[1];
}

// The loadout's arms timed to the recording. The attacker's spear
// (Spear_Study: 0 guard, 1 drawn back, about 1.95 at full reach, 4 back
// in guard) chambers as the recorded strike starts, is out at the recorded
// reach and stops at `stop` (the partner's shield, or flesh for a decisive
// blow), then comes back to guard. The defender's shield (Shield_Brace:
// 0 guard, 1 braced) is up by the answer, or late on a decisive blow.
// press: the thrust pressed on the partner's shield after the reach
// ([[t, Spear_Study time], …], board.mjs pressOn): the spear goes no further
// out than that, and comes back along the line of the thrust (drawn back,
// then guard) instead of round through the recovery, so the point leaves the
// shield the way it came; it is drawn back by the time the trunk lets go of
// the thrust's line (holdThrust), so the turn of the shoulders does not
// sweep the point across the shield. reach: when the point meets the shield. When the
// pair is still closing at the recorded reach, the whole thrust (chamber,
// extension, reach) comes that much later, with the recorded speed: a
// thrust is timed to the measure; it does not stop out in the air and wait
// for the shield, nor creep onto it.
const pressAt=(table,t)=>{if(!table?.length||t<table[0][0])return Infinity;
 for(let i=1;i<table.length;i++)if(t<=table[i][0]){const [t0,u0]=table[i-1],[t1,u1]=table[i];return u0+(u1-u0)*(t-t0)/(t1-t0);}
 return Infinity;};
export function exchangeArms(clip,t,{stop=1.95,press=null,reach=null}={}){
 const s=clip.events?.strike;if(!s)return clip.side==='attack'?{action:'Spear_Study',time:0}:{action:'Shield_Brace',time:0};
 if(clip.side==='attack'){
  const chamber=Math.max(0,s.start-.25),drawn=s.start+.6*(s.reach-s.start);
  if(press){const d=Math.max(0,(reach??s.reach)-s.reach);return{action:'Spear_Study',time:Math.min(keyed([[chamber+d,0],[drawn+d,Math.min(1,stop)],[s.reach+d,stop],[s.reach+d+.15,stop],[s.reach+d+.6,1],[s.reach+1.35,0]],t),pressAt(press,t))};}
  return{action:'Spear_Study',time:keyed([[chamber,0],[drawn,Math.min(1,stop)],[s.reach,stop],[s.reach+.25,stop],[s.reach+.95,4]],t)};
 }
 const answer=clip.events.parry?.at??s.reach;
 if(clip.decisive)return{action:'Shield_Brace',time:keyed([[s.start,0],[s.reach+.15,.55]],t)};
 return{action:'Shield_Brace',time:keyed([[Math.max(0,s.start-.3),0],[Math.min(answer,s.reach)-.08,1],[answer+.45,1],[answer+1.1,.2]],t)};
}

// The spear is aimed in the trunk's frame (loadout.mjs), so a fighter who
// leans into the blow would point it down by the lean, into the floor or
// the partner's feet. The recording's lean forward from its own stance is
// taken out of the aim while the spear is levelled (aim near 1): aim runs
// from the raised guard (0) to the level line (1), 48.5° apart on the pawn.
const GUARD_RISE=48.5*Math.PI/180;
export function trunkLean(points,neutral){
 const pitch=p=>{const u=[p.neck[0]-p.chest[0],p.neck[1]-p.chest[1],p.neck[2]-p.chest[2]];return Math.atan2(u[2],u[1]);};
 return neutral?.neck&&neutral?.chest&&points.neck&&points.chest?pitch(points)-pitch(neutral):0;
}
export function levelSpear(phase,lean){
 const aim=Math.max(0,phase.aim-lean/GUARD_RISE*Math.min(1,phase.aim));
 return{...phase,aim};
}

// The loadout's shield hangs from the trunk, the recording's legs do not:
// in a deep forward stance the front knee comes up and forward into the
// lower edge of a big shield. A fighter carries the shield up and out over
// the knee then. The knee's advance over its own stance (pelvis-centred,
// board units: k is the figure's legs over the recording's) lifts the shield
// straight up the trunk and extends the elbow by as much, within the arm.
export const SHIELD_LIFT_MAX=.2,SHIELD_REACH_MAX=.55;
const kneeAhead=(points,neutral)=>Math.max(...['L','R'].map(s=>{const p=points['knee'+s],n=neutral?.['knee'+s];return p&&n?Math.max(0,(p[2]-n[2])*.8+(p[1]-n[1])):0;}));
const clearOf=a=>({lift:Math.min(SHIELD_LIFT_MAX,1.2*a),reach:Math.min(SHIELD_REACH_MAX,2.5*a)});
export function shieldClear(points,neutral,k){return clearOf(kneeAhead(points,neutral)*k);}
// The same over a clip at time t, carried early and let down late: the
// shield rises before the knee arrives and does not chase every step. Each
// recorded frame's clearance holds over SHIELD_WINDOW seconds around it,
// fading to nothing at the window's edge, so the shield moves at most
// SHIELD_LIFT_MAX per SHIELD_WINDOW.
export const SHIELD_WINDOW=.35;
const clearances=new WeakMap();
export function shieldAt(clip,t,k){
 if(!clearances.has(clip))clearances.set(clip,clip.frames.map(f=>kneeAhead(centerPoints(f),clip.neutral)));
 const A=clearances.get(clip),dt=1/clip.fps,lo=Math.max(0,Math.ceil((t-SHIELD_WINDOW)/dt)),hi=Math.min(A.length-1,Math.floor((t+SHIELD_WINDOW)/dt));
 let lift=0,reach=0;
 for(let j=lo;j<=hi;j++){const w=1-Math.abs(j*dt-t)/SHIELD_WINDOW,c=clearOf(A[j]*k);lift=Math.max(lift,c.lift*w);reach=Math.max(reach,c.reach*w);}
 return{lift,reach};
}
