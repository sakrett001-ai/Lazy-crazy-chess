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

// The trunk frame of a cut, upright at ease. Skeletons mark the spine and
// neck differently: standing at ease, the Bandai Namco neck→spine line leans
// 6° back and 3° to the side, the pawn's stands upright (0.1°). The trunk
// turns from its own neutral (retarget.mjs), so a hand that the actor holds
// straight over the head landed 6° forward of it on the pawn: 8 cm at a hand
// raised 1.3 arm lengths. With the skeleton's neutral stance the frame is
// tilted back by that lean, so at ease its up axis is the world's up and the
// track means the same on any skeleton that stands upright at rest. Only the
// tilt is taken, not the heading.
export function cutFrame(neutral){
 if(!neutral)return trunkFrame;
 const w=normalize(dirToTrunk(trunkFrame(neutral),[0,1,0])),a=[0,1,0],k=cross(a,w),s=length(k),c=dot(a,w);
 const turn=v=>{if(s<1e-9)return v;const u=scale(k,1/s);return add(add(scale(v,c),scale(cross(u,v),s)),scale(u,dot(u,v)*(1-c)));};
 const E=[turn([1,0,0]),turn([0,1,0]),turn([0,0,1])];
 return p=>{const f=trunkFrame(p),world=v=>add(add(scale(f.x,v[0]),scale(f.up,v[1])),scale(f.forward,v[2]));
  return{origin:f.origin,x:world(E[0]),up:world(E[1]),forward:world(E[2])};};
}

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
// and most BVH skeletons mark the wrist (radiocarpal joint). The track puts
// the fighter's grip where the recorded grip would be, so the offset is the
// fighter's own: the pawn's grip lies 8.8 cm past its wrist along the forearm
// (10 cm in all, the rest across the palm), 16 % of its 54 cm arm. With 13 %
// (an ANSUR II hand, 19 cm, grip at 40 % of it) the pawn's wrists stood 1–2
// cm short of the recorded ones. The loadout then sets the wrists exactly
// (wx, wy, wz below); the palm still places the blade line.
const PALM=.16;
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
// one-handed cut: grip, axis and elbow pole per frame, and the middle of the
// recorded wrists (the weapon hand's wrist for a one-handed cut), which the
// loadout makes the fighter's wrists follow.
// options: hands 'two' | 'right'; pivot; shift (arm lengths from the hands'
// middle to the right-hand grip along the blade, 0.11 = 6.5 cm, half the
// greatsword's hand spacing); smooth (frames).
export function cutTrack(frames,{hands='two',pivot=BLADE_PIVOT,shift=.11,smooth:r=2,weapon=null,fps=30,neutral=null}={}){
 const arm=(armLength(frames,'R')+armLength(frames,'L'))/2,frameOf=cutFrame(neutral);
 let rows=frames.map(p=>{
  const f=frameOf(p),h=hands==='two'?mid(palm(p,'R',arm),palm(p,'L',arm)):palm(p,'R',arm);
  const g=scale(toTrunk(f,h),1/arm),axis=normalize(sub(g,pivot));
  // Elbow pole: where the recorded elbow stands off the shoulder–wrist line.
  const sh=p.shoulderR,line=sub(p.wristR,sh),pole=dirToTrunk(f,perp(sub(p.elbowR,sh),normalize(line)));
  const grip=add(g,scale(axis,shift)),wrists=scale(toTrunk(f,hands==='two'?mid(p.wristR,p.wristL):p.wristR),1/arm);
  return[...grip,...axis,...pole,...wrists];
 });
 rows=smoothed(rows,r).map(row=>{const a=normalize(row.slice(3,6)),pl=row.slice(6,9),n=length(pl)||1;return[...row.slice(0,3),...a,...pl.map(v=>v/n),...row.slice(9)];});
 let dynamics=null;
 if(weapon){const res=weaponDynamics(frames,rows,{...weapon,shift,arm,fps,frameOf});rows=res.rows;dynamics=res.stats;}
 return{action:'strike',fields:['gx','gy','gz','ax','ay','az','px','py','pz','wx','wy','wz'],data:rows.flat().map(v=>+v.toFixed(4)),...(dynamics?{dynamics}:{})};
}

// arms track for a strike whose weapon was recorded with the body: a pose
// lifted from a treatise plate (Lazy-skills-lab, skills/storyboard-motion)
// carries the blade itself, its line, edge and where each fist holds it.
// weapon: {fields, data} per frame, a (pommel end), d (axis to the point),
// e (edge), gR, gL (fractions of the length from a to the fists), in the
// clip's own units. Nothing is modelled: the blade is the recorded one. The
// grip is the middle of the recorded fists moved along the blade by shift,
// the fighter's own hand spacing, so the fighter's fists sit where the
// recorded ones were whatever its weapon's spacing. The edge is not in the
// track: the fighter's wrist turns the weapon by its own biomechanics, the
// edge along the knuckles, which is the storyboard's default (the plates'
// crossguards turn it 1–21° off that in the cut). The heavier weapon is not
// simulated either (weaponDynamics): the timing is the storyboard's own.
export function weaponTrack(frames,weapon,{shift=.11,smooth:r=0,neutral=null}={}){
 const arm=(armLength(frames,'R')+armLength(frames,'L'))/2,frameOf=cutFrame(neutral),F=weapon.fields.length,L=weapon.length;
 const col=(i,k)=>weapon.data[i*F+weapon.fields.indexOf(k)];
 if(weapon.data.length!==frames.length*F)throw Error('Оружие не совпадает с числом кадров клипа');
 let rows=frames.map((p,i)=>{
  const f=frameOf(p),a=['ax','ay','az'].map(k=>col(i,k)),d=normalize(['dx','dy','dz'].map(k=>col(i,k)));
  const held=['gR','gL'].map(k=>col(i,k)).filter(v=>v>=0),u=held.reduce((x,y)=>x+y,0)/held.length;
  const hands=add(a,scale(d,u*L)),axis=dirToTrunk(f,d),g=scale(toTrunk(f,hands),1/arm);
  const sh=p.shoulderR,line=sub(p.wristR,sh),pole=dirToTrunk(f,perp(sub(p.elbowR,sh),normalize(line)));
  const two=held.length>1,wrists=scale(toTrunk(f,two?mid(p.wristR,p.wristL):p.wristR),1/arm);
  return[...add(g,scale(axis,two?shift:0)),...axis,...pole,...wrists];
 });
 rows=smoothed(rows,r).map(row=>{const a=normalize(row.slice(3,6)),pl=row.slice(6,9),n=length(pl)||1;return[...row.slice(0,3),...a,...pl.map(v=>v/n),...row.slice(9)];});
 return{action:'strike',fields:['gx','gy','gz','ax','ay','az','px','py','pz','wx','wy','wz'],data:rows.flat().map(v=>+v.toFixed(4))};
}

// Weight of the weapon. The blade model above is where the fighter wants the
// weapon; the hands can only turn it as hard as they can push. The weapon is
// a rigid body turning about the middle of the hands (pivot), with its mass
// and moment of inertia from its own geometry (white-pawn/src/weapons.mjs).
// The hands ask for the torque that would follow the wanted line exactly
// (inertia, gravity and the pull of the moving hands) plus a correction
// towards it, and the request is capped by what two hands on the haft can
// give: a couple of hand forces across the hand spacing and both wrists. A
// light blade stays on the line; a heavy head cannot be turned that fast, so
// it hangs back as the hands start down (a longer windup) and runs on past
// the line when they stop (the blow carries into the target). Only the
// weapon's direction changes: the hands' middle stays on the recording, and
// so does the body.
//
// The limits are model parameters, chosen, not measured on a fighter: 200 N
// across the haft per hand, 10 N·m per wrist (the order of measured maximum
// wrist flexion moments), a correction settling in about a quarter second.
export const GRIP_LIMITS=Object.freeze({handForceN:200,wristTorqueNm:10,settleHz:4,damping:.7});
export const ARM_M=.54;  // the pawn's arm, shoulder to wrist: upper arm 26.2 cm, forearm 27.8 cm (biomechanics calibration)
export function weaponDynamics(frames,rows,{massKg,inertiaKgM2,centreS,pivotS,spacingM,shift,arm,fps=30,limits=GRIP_LIMITS,substeps=24,frameOf=trunkFrame}){
 const n=rows.length,dt=1/fps,unit=ARM_M/arm,g=[0,-9.81,0];
 const world=(f,v)=>add(add(scale(f.x,v[0]),scale(f.up,v[1])),scale(f.forward,v[2]));
 const F=frames.map(frameOf);
 // Wanted direction and the hands' middle (metres, pawn scale) per frame.
 const D=rows.map((row,i)=>normalize(world(F[i],row.slice(3,6))));
 let H=rows.map((row,i)=>scale(add(F[i].origin,scale(world(F[i],sub(row.slice(0,3),scale(row.slice(3,6),shift))),arm)),unit));
 H=smoothed(H,3);
 const diff=(rowsOf,i)=>{const a=rowsOf[Math.max(0,i-1)],b=rowsOf[Math.min(n-1,i+1)],k=(Math.min(n-1,i+1)-Math.max(0,i-1))*dt;return scale(sub(b,a),1/k);};
 const W=D.map((d,i)=>cross(d,diff(D,i)));                   // wanted angular velocity
 const Wd=W.map((_,i)=>diff(W,i)),V=H.map((_,i)=>diff(H,i)),A=V.map((_,i)=>diff(V,i));
 const r=centreS-pivotS,I=inertiaKgM2,omega=2*Math.PI*limits.settleHz,k=I*omega*omega,c=2*limits.damping*Math.sqrt(k*I);
 const cap=limits.handForceN*spacingM+2*limits.wristTorqueNm;
 const perpTo=(v,d)=>sub(v,scale(d,dot(v,d)));
 const rotate=(d,w,h)=>{const a=length(w)*h;if(a<1e-12)return d;const u=normalize(w),c=Math.cos(a),s=Math.sin(a);return normalize(add(add(scale(d,c),scale(cross(u,d),s)),scale(u,dot(u,d)*(1-c))));};
 const slerpDir=(a,b,t)=>normalize(lerp(a,b,t));
 let d=D[0],w=W[0],maxLag=0,lagAt=0,saturated=0,peakDemand=0,lead=0,leadAt=0;
 const out=[];
 for(let i=0;i<n;i++){
  if(i>0)for(let s=1;s<=substeps;s++){
   const t=s/substeps,dw=slerpDir(D[i-1],D[i],t),ww=lerp(W[i-1],W[i],t),aw=lerp(Wd[i-1],Wd[i],t),ah=lerp(A[i-1],A[i],t);
   const load=cross(scale(d,r),scale(sub(g,ah),massKg));          // gravity and the hands' pull
   const ax=cross(d,dw),sinE=length(ax),err=sinE>1e-9?scale(normalize(ax),Math.atan2(sinE,dot(d,dw))):[0,0,0];
   let tau=add(add(sub(scale(perpTo(aw,d),I),load),scale(err,k)),scale(perpTo(sub(ww,w),d),c));
   const mag=length(tau);peakDemand=Math.max(peakDemand,mag);
   if(mag>cap){tau=scale(tau,cap/mag);saturated++;}
   const alpha=scale(add(tau,load),1/I);
   w=perpTo(add(w,scale(alpha,dt/substeps)),d);d=rotate(d,w,dt/substeps);
  }
  // Off the line: + ahead of it in the recent direction of travel (the blow
  // running on), − hanging back behind it.
  const recent=W.slice(Math.max(0,i-8),i+1).reduce(add,[0,0,0]),off=Math.asin(clamp(dot(cross(D[i],d),normalize(recent)),-1,1))*180/Math.PI;
  if(off>lead){lead=off;leadAt=i;}if(-off>maxLag){maxLag=-off;lagAt=i;}
  const f=F[i],axis=[dot(d,f.x),dot(d,f.up),dot(d,f.forward)],hm=sub(rows[i].slice(0,3),scale(rows[i].slice(3,6),shift));
  out.push([...add(hm,scale(axis,shift)),...axis,...rows[i].slice(6)]);
 }
 return{rows:out,stats:{massKg:+massKg.toFixed(3),inertiaKgM2:+I.toFixed(3),capNm:+cap.toFixed(1),peakDemandNm:+peakDemand.toFixed(1),saturatedShare:+(saturated/((n-1)*substeps)).toFixed(3),behindDeg:+maxLag.toFixed(1),behindFrame:lagAt,aheadDeg:+lead.toFixed(1),aheadFrame:leadAt}};
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
