import {sub,add,scale,mid,cross,normalize,length,distance,lerp} from './math.mjs';

// Strikes taken from a recording. The retargeter (retarget.mjs) carries the
// legs and trunk; this module reads the arms of the same key points and
// writes the clip's arms track for the loadout, so the weapon hand follows
// the recorded hand while the elbow, wrist, forearm twist and grip stay
// under the pawn's own biomechanics (white-pawn/src/biomechanics.mjs).
//
// Everything is measured in the recorded trunk frame (shoulder line, spine
// up, forward = left × up) and in the recorded arm's length, so the track is
// the same whatever the source's units, height and facing, and the pawn
// scales it by its own arm.

const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const perp=(v,axis)=>sub(v,scale(axis,dot(v,axis)));
const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
const smooth=u=>{u=clamp(u,0,1);return u*u*u*(u*(u*6-15)+10);};

export function trunkFrame(p){
 const x=normalize(sub(p.shoulderL,p.shoulderR));
 const up=normalize(perp(sub(p.neck,p.spine||p.pelvis),x));
 return{origin:mid(p.shoulderL,p.shoulderR),x,up,forward:cross(x,up)};
}
export const toTrunk=(f,v)=>{const d=sub(v,f.origin);return[dot(d,f.x),dot(d,f.up),dot(d,f.forward)];};
const dirToTrunk=(f,d)=>[dot(d,f.x),dot(d,f.up),dot(d,f.forward)];

// Mirror a recording left for right: a left-handed jab becomes the pawn's
// right-handed thrust. Reflects x and swaps the sides of every point.
export function mirrorFrames(frames){
 const swap=k=>k.endsWith('L')?k.slice(0,-1)+'R':k.endsWith('R')?k.slice(0,-1)+'L':k;
 return frames.map(o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[swap(k),[-v[0],v[1],v[2]]])));
}

// Moving average over ±r frames, with the ends held.
function smoothed(rows,r){
 if(r<1)return rows;
 return rows.map((_,i)=>{const lo=Math.max(0,i-r),hi=Math.min(rows.length-1,i+r),out=rows[i].map(()=>0);for(let j=lo;j<=hi;j++)rows[j].forEach((v,k)=>out[k]+=v/(hi-lo+1));return out;});
}

// Palm: the grip sits in the palm, past the wrist along the forearm. MediaPipe
// and most BVH skeletons mark the wrist (radiocarpal joint); the middle of a
// power grip lies about 8 cm further, 13 % of a 60 cm arm (ANSUR II hand
// length 19 cm, grip centre at 40 % of it).
const PALM=.13;
const palm=(p,s,arm)=>add(p['wrist'+s],scale(normalize(sub(p['wrist'+s],p['elbow'+s])),PALM*arm));
const armLength=(frames,s)=>{const n=Math.min(frames.length,30);let sum=0;for(let i=0;i<n;i++){const p=frames[i];sum+=distance(p['shoulder'+s],p['elbow'+s])+distance(p['elbow'+s],p['wrist'+s]);}return sum/n;};

// Blade models. The recording has no weapon: actors cut with empty hands,
// side by side, and the hand bones' own roll is not reliable enough to give
// the blade. The blade is therefore laid along the line from a pivot in the
// chest through the hands, the way a cut turns about the shoulders: in guard
// the point rises to the opponent's face, overhead it stands up, at the end
// of the cut it runs forward and down. The pivot is in arm lengths, trunk
// frame (about 45 cm under the shoulders, 6 cm behind them).
export const BLADE_PIVOT=Object.freeze([0,-.75,-.1]);

// arms track for a two-handed cut (bastard, greatsword, poleaxe) or a
// one-handed cut: grip, axis and elbow pole per frame.
// options: hands 'two' | 'right'; pivot; shift (arm lengths from the hands'
// middle to the right-hand grip along the blade, 0.11 = 6.5 cm, half the
// greatsword's hand spacing); smooth (frames).
export function cutTrack(frames,{hands='two',pivot=BLADE_PIVOT,shift=.11,smooth:r=2}={}){
 const arm=(armLength(frames,'R')+armLength(frames,'L'))/2;
 let rows=frames.map(p=>{
  const f=trunkFrame(p),h=hands==='two'?mid(palm(p,'R',arm),palm(p,'L',arm)):palm(p,'R',arm);
  const g=scale(toTrunk(f,h),1/arm),axis=normalize(sub(g,pivot));
  // Elbow pole: where the recorded elbow stands off the shoulder–wrist line.
  const sh=p.shoulderR,line=sub(p.wristR,sh),pole=dirToTrunk(f,perp(sub(p.elbowR,sh),normalize(line)));
  const grip=add(g,scale(axis,shift));
  return[...grip,...axis,...pole];
 });
 rows=smoothed(rows,r).map(row=>{const a=normalize(row.slice(3,6)),pl=row.slice(6,9),n=length(pl)||1;return[...row.slice(0,3),...a,...pl.map(v=>v/n)];});
 return{action:'strike',fields:['gx','gy','gz','ax','ay','az','px','py','pz'],data:rows.flat().map(v=>+v.toFixed(4))};
}

// arms track for a spear thrust: the recording times the thrust, the
// loadout's own aim and thrust lines place the spear (they keep the shaft
// clear of the shield). thrust follows the forward reach of the right hand
// from its guard to its farthest point; aim rises 0.25 s ahead of it and
// stays while the hand is out.
export function thrustTrack(frames,{fps=30,lead=.25,smooth:r=2}={}){
 const arm=armLength(frames,'R');
 const reach=frames.map(p=>{const f=trunkFrame(p);return toTrunk(f,p.wristR)[2]/arm;});
 const base=Math.min(...reach.slice(0,Math.max(1,Math.round(fps*.3)))),top=Math.max(...reach);
 let thrust=reach.map(v=>smooth((v-base)/Math.max(1e-6,top-base)));
 thrust=smoothed(thrust.map(v=>[v]),r).map(v=>v[0]);
 const shiftN=Math.round(lead*fps),aim=thrust.map((_,i)=>smooth(Math.max(...thrust.slice(i,Math.min(thrust.length,i+shiftN+1)))*1.6));
 return{action:'Spear_Study',fields:['aim','thrust'],data:thrust.flatMap((t,i)=>[+aim[i].toFixed(4),+t.toFixed(4)]),reach:{base:+base.toFixed(3),top:+top.toFixed(3)}};
}
