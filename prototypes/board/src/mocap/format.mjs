import {POINTS,REQUIRED} from './profiles.mjs';
import {sub,add,scale,mid,cross,normalize,length,distance,rotateY,lerp} from './math.mjs';

// The project's motion file: "lazy-chess.motion", version 1. One file holds
// several clips from one source, each as anatomical key points per frame
// (profiles.mjs), y up. Units are whatever the source used: retargeting
// rescales by leg length, so only proportions within a clip matter.
//
// {format:'lazy-chess.motion',version:1,source:{kind,name,license,note},
//  points:[names...],clips:[{name,label,role,loop,fps,frames,data:[...]}]}
// data holds frames × points × 3 numbers in `points` order. A point that no
// clip of the source has is left out of `points` altogether.
// A clip may also carry arms:{action,fields:['aim','thrust','turn','swing','raise','reach','lift'],
// data:[frames × fields]}: the spear phases and the shield turn the loadout
// solves the arms with (see sampleArms). A struck clip may give fade:[t0,t1],
// the seconds over which the taken figure fades out and leaves the board.
export const FORMAT='lazy-chess.motion';
export const ROLES=Object.freeze({stand:'стойка покоя',shift:'переминание',march:'строевой шаг',step:'шаг на клетку и остановка',approach:'подход к цели',strike:'взятие: атакующий',struck:'взятие: защитник',other:'прочее'});

// Builds a file from clips given as arrays of {point:[x,y,z]} frames.
export function buildMotionFile({source,clips}){
 const used=POINTS.filter(p=>clips.some(c=>c.frames.some(f=>f[p])));
 return{format:FORMAT,version:1,source,points:used,clips:clips.map(c=>{
  const data=[];
  for(const f of c.frames)for(const p of used){const v=f[p]||f.pelvis;data.push(+v[0].toFixed(4),+v[1].toFixed(4),+v[2].toFixed(4));}
  return{name:c.name,label:c.label||c.name,role:c.role||'other',loop:!!c.loop,fps:c.fps,frames:c.frames.length,...(c.partner?{partner:c.partner}:{}),...(c.frame?{frame:c.frame}:{}),data};
 })};
}

export function parseMotionFile(json){
 const file=typeof json==='string'?JSON.parse(json):json;
 if(file?.format!==FORMAT)throw Error('Это не файл движений «живых шахмат» (format должен быть '+FORMAT+')');
 if(file.version!==1)throw Error('Неизвестная версия файла движений: '+file.version);
 const missing=REQUIRED.filter(p=>!file.points.includes(p));
 if(missing.length)throw Error('В файле нет обязательных точек: '+missing.join(', '));
 for(const c of file.clips){
  if(!(c.fps>0))throw Error(`Клип ${c.name}: нет частоты кадров`);
  if(c.data.length!==c.frames*file.points.length*3)throw Error(`Клип ${c.name}: длина данных не совпадает с числом кадров`);
  if(c.arms&&c.arms.data?.length!==c.frames*c.arms.fields?.length)throw Error(`Клип ${c.name}: дорожка рук не совпадает с числом кадров`);
 }
 return file;
}

// A clip ready to drive a figure: frames turned so the figure starts at the
// origin facing +Z with up +Y, plus the measures the retargeter needs.
// frame:'shared' (a pair such as a capture) keeps the file's own frame,
// which must already be Y up with the attacker at the origin facing +Z.
export function prepareClip(file,clip){
 const P=file.points,J=P.length,raw=[];
 for(let f=0;f<clip.frames;f++){const o={};P.forEach((p,j)=>{const i=(f*J+j)*3;o[p]=[clip.data[i],clip.data[i+1],clip.data[i+2]];});raw.push(o);}
 // Up axis: the one along which the head stands farthest from the ankles.
 const f0=raw[0],stand=sub(f0.head,mid(f0.ankleL,f0.ankleR)),axis=[0,1,2].reduce((a,b)=>Math.abs(stand[b])>Math.abs(stand[a])?b:a,1),sign=Math.sign(stand[axis])||1;
 const toYUp=v=>axis===1?[v[0],v[1]*sign,v[2]*sign]:axis===2?[v[0],v[2]*sign,-v[1]*sign]:[-v[1]*sign,v[0]*sign,v[2]];
 let frames=raw.map(o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,toYUp(v)])));
 // Facing at the first frame: forward = left × up, with left from the hips.
 const left=sub(frames[0].hipL,frames[0].hipR),fwd=normalize([-left[2],0,left[0]]);
 const shared=clip.frame==='shared',turn=shared?0:Math.atan2(fwd[0],fwd[2]),origin=shared?[0,0,0]:[frames[0].pelvis[0],0,frames[0].pelvis[2]];
 frames=frames.map(o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,rotateY(sub(v,origin),-turn)])));
 const legOf=(o,s)=>distance(o['hip'+s],o['knee'+s])+distance(o['knee'+s],o['ankle'+s]);
 const leg=frames.slice(0,Math.min(frames.length,30)).reduce((a,o)=>a+legOf(o,'L')+legOf(o,'R'),0)/(2*Math.min(frames.length,30));
 const ground=Math.min(...frames.map(o=>Math.min(o.ankleL[1],o.ankleR[1])));
 const duration=(clip.frames-1)/clip.fps;
 const travel=sub(frames[frames.length-1].pelvis,frames[0].pelvis);travel[1]=0;
 return{name:clip.name,label:clip.label||clip.name,role:clip.role||'other',loop:!!clip.loop,fps:clip.fps,count:clip.frames,duration,frames,leg,ground,travel,points:P,partner:clip.partner||null,shared,arms:clip.arms||null,fade:clip.fade||null};
}

// Key points at time t (seconds), linear between frames. A looping clip
// wraps; its pelvis travel accumulates per lap so a march keeps going.
export function sampleClip(clip,t,{inPlace=false}={}){
 const n=clip.count;let laps=0,u=t*clip.fps;
 if(clip.loop&&n>1){laps=Math.floor(u/(n-1));u-=laps*(n-1);}
 u=Math.min(Math.max(u,0),n-1);
 const i=Math.floor(u),k=Math.min(n-1,i+1),w=u-i,a=clip.frames[i],b=clip.frames[k],out={};
 const shift=inPlace?scale(clip.travel,-(u/Math.max(1,n-1))):scale(clip.travel,laps);
 for(const p of clip.points){const v=lerp(a[p],b[p],w);out[p]=[v[0]+shift[0],v[1],v[2]+shift[2]];}
 return out;
}

// The arms track of a clip at time t, linear between frames: the loadout's
// spear phases and shield turn, {action,phase:{aim,thrust,turn},shield:{swing,raise,reach,lift}}.
// A clip that times its arms (a capture pair) carries it; others give null.
export function sampleArms(clip,t){
 const a=clip.arms;if(!a)return null;
 const F=a.fields.length,u=Math.min(Math.max(t*clip.fps,0),clip.count-1),i=Math.floor(u),k=Math.min(clip.count-1,i+1),w=u-i;
 const v=Object.fromEntries(a.fields.map((f,j)=>[f,a.data[i*F+j]*(1-w)+a.data[k*F+j]*w]));
 return{action:a.action,phase:{aim:v.aim??0,thrust:v.thrust??0,turn:v.turn??0},shield:{swing:v.swing??0,raise:v.raise??0,reach:v.reach??0,lift:v.lift??0}};
}

// Average forward speed of a clip (source units per second).
export const clipSpeed=clip=>length(clip.travel)/Math.max(1e-6,clip.duration);

// Forward progress of the pelvis per frame, made monotone, for playing a
// walk by distance: the figure's own travel picks the clip time, so a foot
// planted in the clip stays planted on the board whatever the easing.
function forwardTrack(clip){
 if(!clip._forward){let m=-Infinity;clip._forward=clip.frames.map(f=>m=Math.max(m,f.pelvis[2]));}
 return clip._forward;
}
// Key points when the pelvis has gone `d` forward (source units), shifted
// back so the pelvis stays over the figure's origin; {points,time}.
export function sampleAlong(clip,d){
 const F=forwardTrack(clip),n=clip.count,lap=F[n-1]-F[0];
 let laps=0,u=d;
 if(clip.loop&&lap>1e-6){laps=Math.floor((u-F[0])/lap);u-=laps*lap;}
 let lo=0,hi=n-1;
 if(u<=F[0])hi=0;else if(u>=F[n-1])lo=hi=n-1;
 else while(hi-lo>1){const m=(lo+hi)>>1;if(F[m]<=u)lo=m;else hi=m;}
 const w=hi>lo&&F[hi]>F[lo]?(u-F[lo])/(F[hi]-F[lo]):0,time=(lo+w)/clip.fps+laps*clip.duration;
 const p=sampleClip(clip,time),shift=p.pelvis[2];
 for(const k of Object.keys(p))p[k]=[p[k][0],p[k][1],p[k][2]-shift];
 return{points:p,time};
}
// Key points with the pelvis moved over the origin (horizontally): the
// figure's holder is placed where the pelvis is, so turning the holder
// turns the figure about its own pelvis.
export function centerPoints(points){
 const [x,,z]=points.pelvis,out={};
 for(const [k,v]of Object.entries(points))out[k]=[v[0]-x,v[1],v[2]-z];
 return out;
}
// Forward distance a clip covers (source units), for one lap of a loop.
export const clipTravel=clip=>{const F=forwardTrack(clip);return F[F.length-1]-F[0];};

// The procedural body layer (motion.mjs) scaled toward rest by k in [0,1],
// so an imported clip can take over smoothly.
export function scaleLayer(layer,k){
 if(!layer||k>=1)return layer;if(k<=0)return null;
 const s=v=>Array.isArray(v)?v.map(x=>x*k):typeof v==='number'?v*k:v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([a,b])=>[a,s(b)])):v;
 return s(layer);
}
