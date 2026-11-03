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
const travelAt=(clip,t)=>{const p=sampleClip(clip,t).pelvis,o=clip.frames[0].pelvis;return{forward:p[2]-o[2],side:p[0]-o[0]};};

// How a cycle fits two squares `distance` apart for a figure whose legs are
// k times the recording's: scale for the approach and the pelvis-to-pelvis
// gap over the cycle (board units). The recorded closest gap is kept.
export function exchangeLayout(pair,k,distance){
 const {attack,defend}=pair,D=Math.max(attack.duration,defend.duration),gap0=(attack.events?.gap??distance/k);
 let close=0;for(let t=0;t<=D+1e-9;t+=1/30)close=Math.max(close,travelAt(attack,t).forward+travelAt(defend,t).forward);
 const closest=(gap0-close)*k,scale=close>1e-6?clamp((distance-closest)/(close*k),0,1):1;
 const gapAt=t=>distance-scale*k*(travelAt(attack,t).forward+travelAt(defend,t).forward);
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
 const p=sampleClip(clip,t),{forward}=travelAt(clip,t);
 return{points:centerPoints(p),offset:{x:0,z:forward*k*scale}};
}
const blendPose=(a,b,w)=>{if(w<=0)return a;if(w>=1)return b;const points={};for(const n of Object.keys(b.points))points[n]=lerp(a.points[n],b.points[n],w);
 return{points,offset:{x:a.offset.x+(b.offset.x-a.offset.x)*w,z:a.offset.z+(b.offset.z-a.offset.z)*w}};};

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
 return{side,clip,local,cycle:n,...blendPose(tail,cur,smooth(local,0,CROSSFADE))};
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
export function exchangeArms(clip,t,{stop=1.95}={}){
 const s=clip.events?.strike;if(!s)return clip.side==='attack'?{action:'Spear_Study',time:0}:{action:'Shield_Brace',time:0};
 if(clip.side==='attack'){
  const chamber=Math.max(0,s.start-.25),drawn=s.start+.6*(s.reach-s.start);
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
