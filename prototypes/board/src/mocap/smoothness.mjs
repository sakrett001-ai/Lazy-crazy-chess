// Smoothness of a figure's motion on the board, measured on the joints'
// world positions frame by frame (scripts/record-duel-track.mjs). Two
// complaints are measured, each as plainly as it shows on the screen:
//
// Trembling: a joint that shakes from frame to frame. The shake is what is
// left after a local cubic fit over 7 frames (Savitzky–Golay, 0.23 s at
// 30 Hz): any motion smooth over that span, a step or a cut included, is
// fitted and leaves next to nothing, noise is left, as an RMS in
// millimetres. A knee is also measured while both feet stand. Zigzag is the
// share of frames where the acceleration turns back by more than ZIG
// mm/frame² twice running: a smooth curve turns once, noise every frame.
//
// Shuffling and sliding: each foot stands (moves under STILL m/s) or
// moves. A move that never lifts the foot by LIFTED is a slide over the
// floor (a fencer's foot does not creep); a move shorter than MICRO is no
// step (a lift in place); and the steps per second are counted.
export const ZIG=2;            // mm per frame², the least turn counted
export const STILL=.05;        // m/s, a standing foot (0.5 mm a frame on the record's 1 mm rounding)
export const LIFTED=.015;      // m, a step lifts the foot at least this much
export const SLIDE=.01;        // m, a shorter move without a lift is the record's rounding
export const MICRO=.1;         // m, shorter is no step

const sub=(a,b)=>a.map((v,i)=>v-b[i]),norm=a=>Math.hypot(...a);
const SG=[-2,3,6,7,6,3,-2].map(v=>v/21); // cubic, 7 points, value at the centre
// RMS shake (mm) of a path X [[x,y,z],...], over frames where mask is true.
export function shake(X,mask=null){
 let s=0,n=0;
 for(let t=3;t+3<X.length;t++){if(mask&&!mask[t])continue;
  const fit=X[t].map((_,k)=>SG.reduce((a,w,i)=>a+w*X[t+i-3][k],0));
  s+=norm(sub(X[t],fit))**2;n++;}
 return n?Math.sqrt(s/n)*1000:0;
}
// Share of frames where the acceleration turns back twice running: noise
// flips it every frame, a step or a cut turns it once (min-jerk speeds up,
// then slows down), so a single turn is motion and two in a row are shake.
export function zigzag(X,least=ZIG){
 const acc=t=>X[t+1].map((v,k)=>v-2*X[t][k]+X[t-1][k]),dot=(a,b)=>a.reduce((s,v,k)=>s+v*b[k],0);
 let turns=0,n=0;
 for(let t=1;t+3<X.length;t++){const a=acc(t),b=acc(t+1),c=acc(t+2);n++;
  if(dot(a,b)<0&&dot(b,c)<0&&Math.min(norm(a),norm(b),norm(c))*1000>least)turns++;}
 return n?turns/n:0;
}
// Stands and steps of one foot's ankle path A at fps.
export function footwork(A,fps){
 const v=[0,...A.slice(1).map((p,t)=>Math.hypot(p[0]-A[t][0],p[2]-A[t][2])*fps)],still=v.map(x=>x<STILL);
 const steps=[];
 for(let t=1;t<A.length;t++){if(still[t])continue;let e=t;while(e<A.length&&!still[e])e++;
  const from=A[t-1],to=A[Math.min(e,A.length-1)],base=Math.min(from[1],to[1]);
  const lift=Math.max(...A.slice(t,e).map(p=>p[1]-base));
  steps.push({from:t-1,to:e,length:Math.hypot(to[0]-from[0],to[2]-from[2]),lift});t=e;}
 const slides=steps.filter(s=>s.lift<LIFTED&&s.length>SLIDE);
 return{standing:still.filter(Boolean).length/A.length,steps,slides:slides.length,slid:slides.reduce((a,s)=>a+s.length,0),
  micro:steps.filter(s=>s.length<MICRO).length,perSecond:steps.length/(A.length/fps)};
}
// All measures of one figure's frames [{joint:[x,y,z]}] (frames where it is
// not shown left out). Joints by the pawn's bone names.
export function measure(frames,fps){
 const P=j=>frames.map(f=>f[j]);
 const feet={L:footwork(P('foot.L'),fps),R:footwork(P('foot.R'),fps)};
 const stand=s=>{const A=P('foot.'+s);return A.map((p,t)=>t>0&&Math.hypot(p[0]-A[t-1][0],p[2]-A[t-1][2])*fps<STILL);};
 const both=stand('L').map((x,t)=>x&&stand('R')[t]);
 const joints=Object.keys(frames[0]||{});
 return{frames:frames.length,feet,
  shake:Object.fromEntries(joints.map(j=>[j,+shake(P(j)).toFixed(1)])),
  kneeShake:{L:+shake(P('lowerleg01.L'),both).toFixed(1),R:+shake(P('lowerleg01.R'),both).toFixed(1),frames:both.filter(Boolean).length},
  zigzag:Object.fromEntries(joints.map(j=>[j,+zigzag(P(j)).toFixed(2)]))};
}
