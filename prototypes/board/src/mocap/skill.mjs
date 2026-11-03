import {sub,add,scale,mid,lerp,length,dot,cross,normalize} from './math.mjs';
import {GRIP_LIMITS} from './strike.mjs';

// Skill of a fighter in a strike taken from a recording (strike.mjs).
//
// One recording, three fighters: the same blow as a recruit, as the fighter
// of the recording and as a veteran. The recording is an actor's ordinary
// ("normal") blow, so it stands in the middle. The open data set has its
// strikes in that one manner only, so the levels are a model over the
// recording, not separate recordings. Every change keeps the body on the
// recording's own path and only reshapes it:
//
// - time: the windup, the blow and the return to guard are slower or faster
//   (the recruit also slows at the top of the windup before committing);
// - the windup: the hands travel farther from the guard (recruit) or less
//   far (veteran) on the way to the top; at the moment of the blow they are
//   back on the recording, so the blow lands where it landed;
// - the trunk: the turn of the shoulders against the hips is smaller for the
//   recruit, who "freezes" the degrees of freedom he does not yet control
//   (Bernstein 1967) and strikes with the arms; the veteran turns a little
//   more, within 45° (axial rotation of the thoracolumbar spine);
// - the weapon: the hands hold and stop the weapon harder (strike.mjs,
//   weaponDynamics), so the recruit's heavy head lags and runs on, the
//   veteran's stays on its line;
// - the spear: the recruit aims long before the thrust, the veteran late.
//
// The numbers are model parameters set by eye and kept modest, not measured
// on fighters. Skill is a number from 0 (recruit) to 1 (veteran); 0.5 is the
// recording as it is.

export const LEVELS=Object.freeze([
 Object.freeze({id:'recruit',label:'Новобранец',skill:0}),
 Object.freeze({id:'fighter',label:'Боец',skill:.5}),
 Object.freeze({id:'veteran',label:'Ветеран',skill:1})
]);

// Values at skill 0, 0.5 and 1.
export const ANCHORS=Object.freeze({
 windup:[1.35,1,.8],          // duration of the windup, × recording
 pause:[.6,0,0],              // slowing at the top of the windup (share of the pace lost at its deepest)
 strike:[1.15,1,.92],         // duration of the blow, top of the windup to the end of the follow-through
 recover:[1.45,1,.75],        // duration of the return to guard
 reach:[1.2,1,.8],            // how far the hands travel from the guard in the windup
 twist:[.55,1,1.1],           // turn of the shoulders against the hips
 handForceN:[140,200,280],    // hand force across the haft (strike.mjs GRIP_LIMITS)
 wristTorqueNm:[8,10,12],     // each wrist
 aimLead:[.45,.25,.12]        // spear: seconds the aim rises ahead of the thrust
});
const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
const smooth=u=>{u=clamp(u,0,1);return u*u*(3-2*u);};
export function skillParams(skill){
 const s=clamp(+skill,0,1),at=([a,b,c])=>s<=.5?a+(b-a)*s/.5:b+(c-b)*(s-.5)/.5;
 return Object.fromEntries(Object.entries(ANCHORS).map(([k,v])=>[k,at(v)]));
}
export const levelOf=id=>LEVELS.find(l=>l.id===id);

const armLength=(frames,s)=>{const n=Math.min(frames.length,30);let sum=0;for(let i=0;i<n;i++){const p=frames[i];sum+=length(sub(p['shoulder'+s],p['elbow'+s]))+length(sub(p['elbow'+s],p['wrist'+s]));}return sum/n;};
const handOf=(p,hands)=>hands==='two'?mid(p.wristR,p.wristL):p.wristR;

// Phases of a strike from the speed of the striking hand(s), in frames:
//   a — the windup starts, b — the top of the windup (the hands turn round
//   and slow down before the blow), c — the hands are fastest (the blow),
//   d — the follow-through ends (the hands slow down again).
// Before a the fighter stands in guard, after d he returns to it.
export function strikePhases(frames,fps,{hands='two'}={}){
 const n=frames.length,arm=(armLength(frames,'R')+armLength(frames,'L'))/2;
 const H=frames.map(p=>scale(handOf(p,hands),1/arm));
 let sp=H.map((_,i)=>length(sub(H[Math.min(n-1,i+1)],H[Math.max(0,i-1)]))*fps/((Math.min(n-1,i+1)-Math.max(0,i-1))||1));
 sp=sp.map((_,i)=>{let s=0,k=0;for(let j=Math.max(0,i-2);j<=Math.min(n-1,i+2);j++){s+=sp[j];k++;}return s/k;});
 const c=sp.indexOf(Math.max(...sp)),W=Math.round(.6*fps);
 // The top: the slowest moment in the 0.6 s before the blow, where the
 // hands turn round (or, in a circling windup, change course).
 let b=c;for(let i=Math.max(0,c-W);i<c;i++)if(sp[i]<sp[b])b=i;
 // The end of the follow-through: the first frame after the blow under 10 %
 // of its speed, or the first slowest moment if the hands turn back sooner
 // (a jab pulled back at once).
 let d=c;while(d<n-1&&sp[d]>=.1*sp[c]&&!(d>c&&sp[d+1]>sp[d]))d++;
 // The windup starts where the hands leave the guard: the last frame before
 // the windup's fastest one that is still under 12 % of that speed.
 let top=0;for(let i=0;i<=b;i++)if(sp[i]>sp[top])top=i;
 let a=top;while(a>0&&sp[a]>.12*sp[top])a--;
 if(sp[top]<.1*sp[c])a=b;                      // no windup to speak of (a jab)
 return{a,b,c,d,speed:sp,peak:sp[c],arm};
}

// The hands travel farther (k > 1) or less far (k < 1) from the guard during
// the windup. In the trunk frame of each frame, every arm point moves away
// from (or towards) where the hands stood when the windup began; the change
// grows from nothing at a to all of it at b and fades back to nothing at the
// blow c, so the blow lands on the recording's own line.
export function scaleWindup(frames,phases,k){
 if(Math.abs(k-1)<1e-9)return frames;
 const {a,b,c}=phases;if(!(b>a)||!(c>b))return frames;
 const frameOf=p=>{const x=normalize(sub(p.shoulderL,p.shoulderR)),u0=sub(p.neck,p.spine||p.pelvis),up=normalize(sub(u0,scale(x,dot(u0,x))));return{o:mid(p.shoulderL,p.shoulderR),x,up,f:cross(x,up)};};
 const to=(F,v)=>{const d=sub(v,F.o);return[dot(d,F.x),dot(d,F.up),dot(d,F.f)];},from=(F,l)=>add(F.o,add(add(scale(F.x,l[0]),scale(F.up,l[1])),scale(F.f,l[2])));
 const keys=['elbowL','elbowR','wristL','wristR'];
 const g=frames[a],Fg=frameOf(g),guard=Object.fromEntries(keys.map(q=>[q,to(Fg,g[q])]));
 return frames.map((p,i)=>{
  const w=i<=a||i>=c?0:i<=b?smooth((i-a)/(b-a)):1-smooth((i-b)/(c-b));
  if(w<=0)return p;
  const F=frameOf(p),m=1+(k-1)*w,out={...p};
  for(const q of keys){const l=to(F,p[q]);out[q]=from(F,add(guard[q],scale(sub(l,guard[q]),m)));}
  return out;
 });
}

// Turn of the shoulder line against the hip line about the vertical, in
// radians, wrapped to ±π. Positive turns the left shoulder forward.
const yawOf=v=>Math.atan2(v[0],v[2]);
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
export const shoulderTurn=p=>wrap(yawOf(sub(p.shoulderL,p.shoulderR))-yawOf(sub(p.hipL,p.hipR)));
const UPPER=['chest','neck','head','eyeL','eyeR','earL','earR','nose','shoulderL','shoulderR','elbowL','elbowR','wristL','wristR'];
// The shoulders turn against the hips k times as far as on the recording,
// counted from the first frame's turn and never beyond maxDeg. The upper body
// turns as one piece about the vertical through the lower spine; the arms
// turn with it, so the hands keep their path relative to the trunk.
// The source must stand Y up (BVH, the project's motion files).
export function scaleTwist(frames,k,{maxDeg=45}={}){
 if(Math.abs(k-1)<1e-9)return frames;
 const t0=shoulderTurn(frames[0]),max=maxDeg*Math.PI/180;
 return frames.map(p=>{
  const d=wrap(shoulderTurn(p)-t0),want=clamp(k*d,-Math.max(max,Math.abs(d)),Math.max(max,Math.abs(d))),turn=want-d;
  if(Math.abs(turn)<1e-9)return p;
  const o=p.spine||p.pelvis,c=Math.cos(turn),s=Math.sin(turn),out={...p};
  for(const q of UPPER)if(p[q]){const v=sub(p[q],o);out[q]=add(o,[c*v[0]+s*v[2],v[1],-s*v[0]+c*v[2]]);}
  return out;
 });
}

// New time for the same motion. The source plays at a pace (source seconds
// per output second) set per phase: 1/windup from a to b, 1/strike from b to
// d, 1/recover after d; the pace changes smoothly over ±0.1 s at each phase
// boundary, and dips by `pause` around the top of the windup. Frames are
// interpolated linearly between source frames (1/30 s apart). Returns the
// frames at the same fps, and where each phase landed (output frames).
export function retime(frames,fps,phases,{windup=1,strike=1,recover=1,pause=0}){
 const n=frames.length,{a,b,c,d}=phases,T=n-1;
 if(windup===1&&strike===1&&recover===1&&!pause)return{frames,phases:{a,b,c,d},map:i=>i};
 const ramp=.1*fps,step=(x,e,v0,v1)=>v0+(v1-v0)*smooth((x-e+ramp)/(2*ramp));
 // Before a → 1; a..b → 1/windup; b..d → 1/strike; after d → 1/recover.
 const pace=x=>{
  let v=1;
  if(b>a)v=step(x,a,1,1/windup);
  v=x<b-ramp?v:step(x,b,b>a?1/windup:1,1/strike);
  v=x<d-ramp?v:step(x,d,1/strike,1/recover);
  const dip=pause?1-pause*Math.exp(-(((x-b)/(.09*fps))**2)):1;
  return v*dip;
 };
 // Output time of each source position (in frames), by integrating 1/pace.
 const sub_=20,xs=[0],ts=[0];
 for(let i=0;i<T*sub_;i++){const x0=i/sub_,x1=(i+1)/sub_,dt=(x1-x0)/pace((x0+x1)/2);xs.push(x1);ts.push(ts[ts.length-1]+dt);}
 const total=ts[ts.length-1],count=Math.floor(total+1e-9)+1;
 const at=t=>{let lo=0,hi=ts.length-1;while(hi-lo>1){const m=(lo+hi)>>1;if(ts[m]<=t)lo=m;else hi=m;}const w=ts[hi]>ts[lo]?(t-ts[lo])/(ts[hi]-ts[lo]):0;return xs[lo]+(xs[hi]-xs[lo])*w;};
 const sample=x=>{const i=Math.min(T-1,Math.floor(x)),w=x-i,A=frames[i],B=frames[Math.min(T,i+1)],o={};for(const k of Object.keys(A))o[k]=lerp(A[k],B[k]||A[k],w);return o;};
 const out=Array.from({length:count},(_,k)=>sample(Math.min(T,at(k))));
 const map=x=>ts[Math.min(ts.length-1,Math.round(x*sub_))];
 return{frames:out,phases:{a:map(a),b:map(b),c:map(c),d:map(d)},map};
}

// A strike's frames at a skill: windup reach, trunk twist and time, in that
// order (reach and twist on the recording's own clock). Returns the frames,
// the phases on the new clock (frames, fractional) and the parameters, which
// also carry the grip limits and the spear's aim lead for strike.mjs.
export function applySkill(frames,fps,skill,{hands='two',twist=true}={}){
 const P=skillParams(skill),ph=strikePhases(frames,fps,{hands});
 let f=scaleWindup(frames,ph,P.reach);
 if(twist)f=scaleTwist(f,P.twist);
 const r=retime(f,fps,ph,P);
 return{frames:r.frames,phases:r.phases,source:{a:ph.a,b:ph.b,c:ph.c,d:ph.d},params:P,
  limits:{...GRIP_LIMITS,handForceN:P.handForceN,wristTorqueNm:P.wristTorqueNm}};
}
