import {loadPage} from '../tools/cpu-render/env.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Armour against the body in every pose the board plays, on the CPU (no
// browser, no graphics card). The board's own code runs in Node
// (tools/cpu-render) and drives the pawns as it does on screen; each sampled
// frame skins the visible meshes of every pawn on the CPU and looks for
// what a player would see:
//   armour → body: cloth, padding or skin showing through metal. Each pawn is
//     rasterised from 12 directions at 5 mm pixels; a pixel is a fault where
//     a soft surface lies in front of a plate it should be under, by more
//     than 1.5 mm (a tasset sunk in the thigh, a nasal in the face). The
//     region's size is the largest area seen from one direction;
//   leg → leg: geometry of one leg crossing the other (boots, sabatons,
//     greaves and the legs themselves): an edge of one triangle strictly
//     through the other, deeper than CONTACT_M.
// Scenes: the start position with e2–e4 (rest, walk), «схватка и оборона»
// (fencing, shield defence, alert), «пешка берёт пешку» with the recorded
// exchange (fencing, the capture: lunge, hit, fall). Each scene is played for
// recruits and again with the veteran shape keys on.
//   node scripts/verify-armor.mjs [--fps 10] [--only capture] [--report review/armor-contact.json]
//     [--glb other.glb] [--dump dir --dump-at scene:experience:frame:pieceId] [--write-baseline]
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg=(k,d)=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:d;};
const FPS=+arg('--fps',10),only=arg('--only',null),reportFile=path.resolve(root,arg('--report','review/armor-contact.json'));
const CONTACT_M=.003,LIMITS={armorBodyDepthM:CONTACT_M,legLegDepthM:CONTACT_M};

const [tpl,glb,motionText]=await Promise.all([readFile(path.join(root,'src/index.html'),'utf8'),readFile(path.resolve(root,arg('--glb','../white-pawn/assets/white-pawn.glb'))),readFile(path.join(root,'motions/duel-516.motion.json'),'utf8')]);
const html=tpl.replace('/*MODEL*/',()=>glb.toString('base64')).replace('/*MOTIONS*/[]','[]').replace('/*STYLE*/','').replace('/*SCRIPT*/','');
const t0=Date.now();
const page=await loadPage({html,entry:path.join(root,'src/board.mjs'),nodePaths:[path.join(root,'../white-pawn/node_modules'),path.join(root,'../human-base/node_modules')],width:320,height:180,url:'file:///page.html?seed=1'});
const L=page.window.livingChess;if(!L.ready)throw Error('board did not start: '+L.fallback);
const THREE=globalThis.__THREE;L.manual(true);
console.log(`board ready in ${((Date.now()-t0)/1000).toFixed(1)} s`);

const norm=s=>String(s||'').replace(/[._\-\s]/g,'').toLowerCase();
const tag=(o,k)=>{for(;o;o=o.parent)if(o.userData?.[k]!==undefined)return o.userData[k];};
const visible=o=>{for(;o;o=o.parent)if(!o.visible)return false;return true;};
const LEG=/^(upperleg|lowerleg|foot|toe)/;

// Per geometry, once: triangles over canonical vertices (glTF repeats
// vertices at seams), each vertex's dominant bone and its leg side.
const prepared=new WeakMap();
function prepare(mesh){
 let p=prepared.get(mesh.geometry);if(p)return p;
 const g=mesh.geometry,pos=g.attributes.position,si=g.attributes.skinIndex,sw=g.attributes.skinWeight,bones=mesh.skeleton.bones;
 const key=new Map(),canon=new Int32Array(pos.count),ids=[];
 for(let i=0;i<pos.count;i++){const k=[pos.getX(i),pos.getY(i),pos.getZ(i),si.getX(i),si.getY(i),sw.getX(i),sw.getY(i)].map(v=>v.toFixed(6)).join('/');let j=key.get(k);if(j===undefined){j=ids.length;key.set(k,j);ids.push(i);}canon[i]=j;}
 const bone=new Array(ids.length),side=new Int8Array(ids.length);
 ids.forEach((i,j)=>{let best=0,b=0;const leg={l:0,r:0};for(let c=0;c<4;c++){const w=sw.getComponent(i,c),n=norm(bones[si.getComponent(i,c)]?.name);if(w>best){best=w;b=n;}if(LEG.test(n)){if(n.endsWith('l'))leg.l+=w;if(n.endsWith('r'))leg.r+=w;}}bone[j]=b;side[j]=leg.l>.9?1:leg.r>.9?2:0;});
 const n=g.index?g.index.count:pos.count,tris=new Int32Array(n);for(let i=0;i<n;i++)tris[i]=canon[g.index?g.index.getX(i):i];
 p={ids,tris,bone,side};prepared.set(mesh.geometry,p);return p;
}
// One pawn, posed: every visible mesh skinned on the CPU.
function posedPawn(holder){
 holder.updateMatrixWorld(true);const parts=[];
 holder.traverse(m=>{if(!m.isSkinnedMesh||!visible(m))return;const slot=tag(m,'equipmentSlot');if(!['base','padding','plate','helmet','mail'].includes(slot))return;
  m.skeleton.update();const p=prepare(m),v=new THREE.Vector3(),P=new Float32Array(p.ids.length*3);
  p.ids.forEach((i,j)=>{m.getVertexPosition(i,v).applyMatrix4(m.matrixWorld);P[3*j]=v.x;P[3*j+1]=v.y;P[3*j+2]=v.z;});
  parts.push({mesh:m,name:m.name,slot,armour:['plate','helmet','mail'].includes(slot),...p,P});});
 return parts;
}
function triangles(parts,filter){
 const out=[];for(const part of parts)for(let t=0;t<part.tris.length;t+=3){const a=part.tris[t],b=part.tris[t+1],c=part.tris[t+2];if(a===b||b===c||a===c)continue;if(!filter(part,a,b,c))continue;
  const p=[a,b,c].map(i=>[part.P[3*i],part.P[3*i+1],part.P[3*i+2]]);out.push({part,v:[a,b,c],p,min:[0,1,2].map(k=>Math.min(p[0][k],p[1][k],p[2][k])),max:[0,1,2].map(k=>Math.max(p[0][k],p[1][k],p[2][k]))});}
 return out;
}
const CELL=.04,cellKey=(x,y,z)=>x*73856093^y*19349663^z*83492791;
function grid(tris){const map=new Map();tris.forEach((t,i)=>{for(let x=Math.floor(t.min[0]/CELL);x<=Math.floor(t.max[0]/CELL);x++)for(let y=Math.floor(t.min[1]/CELL);y<=Math.floor(t.max[1]/CELL);y++)for(let z=Math.floor(t.min[2]/CELL);z<=Math.floor(t.max[2]/CELL);z++){const k=cellKey(x,y,z);let l=map.get(k);if(!l)map.set(k,l=[]);l.push(i);}});return map;}
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
// Möller–Trumbore: the parameter t along o→o+d where it meets the triangle, or -1.
function rayTri(o,d,tri){const e1=sub(tri[1],tri[0]),e2=sub(tri[2],tri[0]),h=cross(d,e2),a=dot(e1,h);if(Math.abs(a)<1e-12)return -1;const f=1/a,s=sub(o,tri[0]),u=f*dot(s,h);if(u<=0||u>=1)return -1;const q=cross(s,e1),v=f*dot(d,q);if(v<=0||u+v>=1)return -1;return f*dot(e2,q);}
// An edge of one triangle strictly through the other: the crossing point, or null.
function crossing(A,B){for(const [X,Y]of[[A,B],[B,A]])for(let i=0;i<3;i++){const o=X[i],d=sub(X[(i+1)%3],o),t=rayTri(o,d,Y);if(t>1e-6&&t<1-1e-6)return[o[0]+d[0]*t,o[1]+d[1]*t,o[2]+d[2]*t];}return null;}
// How far a crossing reaches: A's vertices on the shorter side of B's plane.
function depth(A,B){const n=cross(sub(B[1],B[0]),sub(B[2],B[0])),l=Math.hypot(...n);if(l<1e-12)return 0;let lo=0,hi=0;for(const p of A){const s=dot(sub(p,B[0]),n)/l;lo=Math.min(lo,s);hi=Math.max(hi,s);}return Math.min(-lo,hi);}
function collide(As,Bs){
 const cells=grid(Bs),hits=[];
 for(const a of As){const seen=new Set();
  for(let x=Math.floor(a.min[0]/CELL);x<=Math.floor(a.max[0]/CELL);x++)for(let y=Math.floor(a.min[1]/CELL);y<=Math.floor(a.max[1]/CELL);y++)for(let z=Math.floor(a.min[2]/CELL);z<=Math.floor(a.max[2]/CELL);z++)
   for(const j of cells.get(cellKey(x,y,z))||[]){if(seen.has(j))continue;seen.add(j);const b=Bs[j];
    if(a.max[0]<b.min[0]||b.max[0]<a.min[0]||a.max[1]<b.min[1]||b.max[1]<a.min[1]||a.max[2]<b.min[2]||b.max[2]<a.min[2])continue;
    const at=crossing(a.p,b.p);if(at)hits.push({a,b,at,depth:depth(a.p,b.p)});}}
 return hits;
}
// Seen from outside, the way a camera sees it: the pawn is rasterised from
// VIEWS around it (pixel PX) keeping the two nearest surfaces per pixel. A
// fault is a pixel where a soft layer (skin, padding, mail) is the nearest
// surface, facing the camera, and a hard piece (plate, helmet) is the very next
// surface behind it: the plate is inside the body there, the cloth shows
// through the metal. A hand in front of the chest is not a fault (the hand's
// own back face comes next), a plate over cloth is not (the plate is nearest).
// Pokes under POKE_M are a plate lying on cloth.
const PX=+arg('--px',.005),POKE_M=.0015,VIEWS=[];
for(let a=0;a<360;a+=45)VIEWS.push({az:a,el:10});for(const a of[0,90,180,270])VIEWS.push({az:a,el:50});
const soft=part=>!['plate','helmet'].includes(part.slot);
function viewBasis(holder,{az,el}){
 // Holder frame: +Z forward (the way the pawn faces), +Y up. The camera stands at (az, el) and looks back at the pawn.
 const m=holder.matrixWorld.elements,X=[m[0],m[1],m[2]],Y=[m[4],m[5],m[6]],Z=[m[8],m[9],m[10]];const nX=Math.hypot(...X),nY=Math.hypot(...Y),nZ=Math.hypot(...Z);
 const A=az*Math.PI/180,E=el*Math.PI/180,loc=[Math.sin(A)*Math.cos(E),Math.sin(E),Math.cos(A)*Math.cos(E)];
 const w=k=>X[k]/nX*loc[0]+Y[k]/nY*loc[1]+Z[k]/nZ*loc[2];const toCam=[w(0),w(1),w(2)],dir=toCam.map(v=>-v);
 const up0=Y.map(v=>v/nY);let right=cross(dir,up0);const l=Math.hypot(...right);right=right.map(v=>v/l);const up=cross(right,dir);
 return {dir,right,up};
}
const DUMP=arg('--dump',null),DUMP_AT=arg('--dump-at',null),dumpViews=[];let dumped=false,dumpNow=!DUMP_AT;
async function faults(all,holder){
 const res={};let worst=null;
 for(const view of VIEWS){const {dir,right,up}=viewBasis(holder,view);
  const n=all.length,X=new Float32Array(n*3),Y=new Float32Array(n*3),Z=new Float32Array(n*3);let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9;
  all.forEach((t,i)=>{for(let k=0;k<3;k++){const p=t.p[k];const x=dot(p,right),y=dot(p,up),z=dot(p,dir);X[3*i+k]=x;Y[3*i+k]=y;Z[3*i+k]=z;if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}});
  const W=Math.ceil((x1-x0)/PX)+1,H=Math.ceil((y1-y0)/PX)+1,d1=new Float32Array(W*H).fill(1e9),d2=new Float32Array(W*H).fill(1e9),i1=new Int32Array(W*H).fill(-1),i2=new Int32Array(W*H).fill(-1);
  for(let i=0;i<n;i++){const ax=(X[3*i]-x0)/PX,ay=(Y[3*i]-y0)/PX,bx=(X[3*i+1]-x0)/PX,by=(Y[3*i+1]-y0)/PX,cx=(X[3*i+2]-x0)/PX,cy=(Y[3*i+2]-y0)/PX;
   const area=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);if(Math.abs(area)<1e-9)continue;
   const az_=Z[3*i],bz=Z[3*i+1],cz=Z[3*i+2];
   for(let py=Math.max(0,Math.ceil(Math.min(ay,by,cy)-.5));py<=Math.min(H-1,Math.floor(Math.max(ay,by,cy)-.5));py++)
    for(let qx=Math.max(0,Math.ceil(Math.min(ax,bx,cx)-.5));qx<=Math.min(W-1,Math.floor(Math.max(ax,bx,cx)-.5));qx++){const sx=qx+.5,sy=py+.5;
     const w0=((bx-sx)*(cy-sy)-(by-sy)*(cx-sx))/area,w1=((cx-sx)*(ay-sy)-(cy-sy)*(ax-sx))/area,w2=1-w0-w1;if(w0<0||w1<0||w2<0)continue;
     const z=w0*az_+w1*bz+w2*cz,o=py*W+qx;
     if(Math.abs(z-d1[o])<3e-4)continue;
     if(z<d1[o]){d2[o]=d1[o];i2[o]=i1[o];d1[o]=z;i1[o]=i;}else if(z<d2[o]){d2[o]=z;i2[o]=i;}}}
  if(DUMP&&!dumped&&dumpNow){const img=Buffer.alloc(W*H*3,255);for(let o=0;o<W*H;o++){const a=i1[o];if(a<0)continue;const A=all[a],nn=cross(sub(A.p[1],A.p[0]),sub(A.p[2],A.p[0])),l=Math.hypot(...nn)||1,sh=Math.abs(dot(nn,dir))/l;const r=(H-1-Math.floor(o/W))*W+o%W;
    const c=soft(A.part)?[200*sh+40,170*sh+40,140*sh+40]:[120*sh+60,150*sh+70,210*sh+40];img.set(c.map(Math.round),r*3);}
   dumpViews.push({W,H,img,i1,i2,d1,d2,dir,view});}
  const seen={};
  for(let o=0;o<W*H;o++){const a=i1[o],b=i2[o];if(a<0||b<0)continue;const A=all[a],B=all[b];if(!soft(A.part)||soft(B.part))continue;
   const poke=d2[o]-d1[o];if(poke<POKE_M||poke>.08)continue;
   const nrm=cross(sub(A.p[1],A.p[0]),sub(A.p[2],A.p[0]));if(dot(nrm,dir)>=0)continue;
   const ab=B.part.bone[B.v[0]],sb=A.part.bone[A.v[0]],key=`${named(PIECE,ab)}${sideOf(ab)} → ${named(UNDER,sb)}`;
   if(DUMP&&!dumped&&dumpNow){const dv=dumpViews[dumpViews.length-1];const r=(dv.H-1-Math.floor(o/W))*W+o%W;dv.img.set([230,20,20],r*3);}
   const e=seen[key]||(seen[key]={px:0,maxPokeM:0,at:null});e.px++;if(poke>e.maxPokeM){e.maxPokeM=poke;e.at=A.p[0].map(v=>+v.toFixed(3));e.view=view;}}
  for(const [k,e]of Object.entries(seen)){const r=res[k]||(res[k]={areaCm2:0,maxPokeM:0,views:0,at:null,view:null});r.views++;const cm2=e.px*PX*PX*1e4;if(cm2>r.areaCm2)r.areaCm2=cm2;if(e.maxPokeM>r.maxPokeM){r.maxPokeM=e.maxPokeM;r.at=e.at;r.view=e.view;}}}
 for(const r of Object.values(res))r.areaCm2=+r.areaCm2.toFixed(1);
 if(DUMP&&!dumped&&dumpNow){dumped=true;const {mkdirSync,writeFileSync}=await import('node:fs');mkdirSync(DUMP,{recursive:true});dumpViews.forEach((v,i)=>writeFileSync(path.join(DUMP,`v${i}-az${v.view.az}-el${v.view.el}.ppm`),Buffer.concat([Buffer.from(`P6 ${v.W} ${v.H} 255\n`),v.img])));}
 return res;
}
// Names the user knows: the armour piece by the bone that carries it, the surface under it.
const PIECE=[[/^head/,'шлем'],[/^(neck|clavicle|spine|breast)/,'кираса и горжет'],[/^(shoulder|upperarm)/,'наплечник'],[/^(lowerarm|wrist|hand)/,'наруч'],[/^(pelvis|upperleg|root)/,'набедренники и пояс'],[/^lowerleg/,'поножи и наколенники'],[/^(foot|toe)/,'сабатоны']];
const UNDER=[[/^head|^(eye|orbic|oculi|nose|jaw|lip|cheek|levator|temporal|oris|risorius|mentalis|tongue|teeth)/,'лицо и голова'],[/^(neck|clavicle|spine|breast|shoulder)/,'корпус'],[/^(upperarm|lowerarm|wrist|hand|finger)/,'руки'],[/^(pelvis|upperleg|root)/,'бёдра'],[/^lowerleg/,'голени'],[/^(foot|toe)/,'стопы и сапоги']];
const named=(list,bone)=>(list.find(([r])=>r.test(bone))||[0,bone])[1];
const sideOf=bone=>/l$/.test(bone)?' L':/r$/.test(bone)?' R':'';
async function audit(holder){
 const parts=posedPawn(holder);
 const all=triangles(parts,()=>true);
 const legL=all.filter(t=>t.v.every(i=>t.part.side[i]===1)),legR=all.filter(t=>t.v.every(i=>t.part.side[i]===2));
 const legLeg={};
 for(const h of collide(legL,legR)){if(h.depth<=CONTACT_M)continue;const nm=(t,b)=>t.part.armour?named(PIECE,b):named(UNDER,b);const key=`${nm(h.a,h.a.part.bone[h.a.v[0]])} L → ${nm(h.b,h.b.part.bone[h.b.v[0]])} R`;
  const e=legLeg[key]||(legLeg[key]={pairs:0,maxDepthM:0,at:null});e.pairs++;if(h.depth>e.maxDepthM){e.maxDepthM=h.depth;e.at=h.at.map(v=>+v.toFixed(3));}}
 return {armourBody:await faults(all,holder),legLeg};
}

function setExperience(veteran){
 for(const a of page.lastScene.children)a.traverse(m=>{const d=m.morphTargetDictionary;if(!d)return;for(const [k,i]of Object.entries(d))if(['veteran','faceveteran','experienceveteran'].includes(norm(k)))m.morphTargetInfluences[i]=veteran?1:0;});
}
let duelAdded=false;
const scenes={
 start:{preset:'start',run:async grab=>{for(let i=0;i<1.5*FPS;i++){await grab('стойка');L.step(1/FPS,30,false);}L.play('e2','e4');for(let i=0;i<20*FPS;i++){if(!L.state().busy)break;await grab('шаг e2–e4');L.step(1/FPS,30,false);}}},
 clash:{preset:'clash',run:async grab=>{for(let i=0;i<8*FPS;i++){await grab('схватка и оборона');L.step(1/FPS,30,false);}}},
 capture:{preset:'capture',run:async grab=>{if(!duelAdded){L.motion.add('duel-516.motion.json',motionText);duelAdded=true;}const used=L.motion.use({duel:0});if(used.duel?.exchange!=='duel516.exchange.attack')throw Error('recorded exchange not taken');
  for(let i=0;i<5*FPS;i++){await grab('обмен ударами');L.step(1/FPS,30,false);}L.play('e4','d5');for(let i=0;i<40*FPS;i++){if(!L.state().busy)break;await grab('взятие');L.step(1/FPS,30,false);}}}
};
const report={status:'running',fps:FPS,limits:LIMITS,glb:'white-pawn/assets/white-pawn.glb',scope:'CPU-skinned visible meshes of every pawn on the board, sampled at the given rate through scripted scenes; armour→body: soft surface seen through a hard one, rasterised from 12 views at 5 mm pixels; leg→leg: exact triangle edge crossings. Sampling misses contacts shorter than one frame.',scenes:[],totals:{},failures:[]};
const totals={armourBody:{},legLeg:{}};
for(const [name,s]of Object.entries(scenes)){if(only&&only!==name)continue;
 for(const experience of ['recruit','veteran']){
  // Every scene starts from the same board state, whatever ran before it:
  // the board clock (fencing cycles are timed by it) and the recorded
  // exchange carry over a load, so a scene's frames would depend on the
  // scenes run before it (--only) and the same frame would get another number.
  L.load(s.preset);L.motion.use({});L.manual(false);L.manual(true);L.step(.2,30,false);L.render();setExperience(experience==='veteran');
  const frames=[];let n=0;const t1=Date.now();
  const grab=async stage=>{setExperience(experience==='veteran');page.lastScene.updateMatrixWorld(true);
   const pieces={};for(const p of L.state().pieces){if(p.type!=='p'||!L.shown(p.id))continue;
    // Pawns at rest far from the action are the same pose as their neighbours: sample them once a second.
    const moving=p.state!=='rest'||p.pose?.action!=='Guard_Breath'||L.state().busy;if(!moving&&n%FPS)continue;
    const holder=page.lastScene.getObjectByName(p.id);if(!holder)continue;if(DUMP_AT)dumpNow=DUMP_AT===`${name}:${experience}:${n}:${p.id}`;const r=await audit(holder);
    for(const [kind,by]of Object.entries(r))for(const [k,e]of Object.entries(by)){const size=e.areaCm2??e.pairs,m=e.maxPokeM??e.maxDepthM;const t=totals[kind][k]||(totals[kind][k]={frames:0,maxSize:0,maxM:0,worstAt:null});t.frames++;t.maxSize=Math.max(t.maxSize,size);if(m>t.maxM){t.maxM=m;t.worstAt={scene:name,experience,stage,frame:n,piece:p.id,at:e.at,view:e.view};}}
    pieces[p.id]=r;}
   frames.push({frame:n,time:+(n/FPS).toFixed(2),stage,pieces});n++;};
  await s.run(grab);
  const vis=frames.reduce((s,f)=>s+Object.values(f.pieces).reduce((u,r)=>u+Object.keys(r.armourBody).length+Object.keys(r.legLeg).length,0),0);
  report.scenes.push({scene:name,experience,frames:frames.length,faults:vis,seconds:+((Date.now()-t1)/1000).toFixed(1)});
  console.log(`${name} / ${experience}: ${frames.length} frames, ${vis} faults (region×pawn×frame), ${((Date.now()-t1)/1000).toFixed(0)} s`);
 }}
// Pass: nothing visible, except regions in the ratchet baseline (there the
// worst frame's area and depth can only fall: scripts/armor-baseline.json).
const basePath=path.join(root,'scripts/armor-baseline.json');let baseline={};try{baseline=JSON.parse(await readFile(basePath,'utf8'));}catch{}
for(const kind of ['armourBody','legLeg'])for(const [k,t]of Object.entries(totals[kind])){t.maxM=+t.maxM.toFixed(4);t.maxSize=+t.maxSize.toFixed(1);
 const b=baseline[kind]?.[k];if(b&&t.maxSize<=b.maxSize+.05&&t.maxM<=b.maxM+.0005)continue;
 report.failures.push(`${k}: ${kind==='armourBody'?t.maxSize+' см²':t.maxSize+' пар'}, до ${(t.maxM*1000).toFixed(1)} мм`+(b?` (было ${b.maxSize}, ${(b.maxM*1000).toFixed(1)} мм)`:''));}
if(process.argv.includes('--write-baseline')&&!only){const out={};for(const kind of ['armourBody','legLeg']){out[kind]={};for(const [k,t]of Object.entries(totals[kind]))out[kind][k]={maxSize:t.maxSize,maxM:t.maxM};}await writeFile(basePath,JSON.stringify(out,null,1)+'\n');report.failures=[];}
report.totals=totals;report.status=report.failures.length?'failed':'passed';
await mkdir(path.dirname(reportFile),{recursive:true});await writeFile(reportFile,JSON.stringify(report,null,1)+'\n');
const table=(kind,unit)=>Object.entries(totals[kind]).sort((a,b)=>b[1].maxSize-a[1].maxSize).map(([k,t])=>`  ${k}: до ${t.maxSize} ${unit} в кадре, глубина до ${(t.maxM*1000).toFixed(1)} мм, в ${t.frames} кадрах (${t.worstAt.scene}:${t.worstAt.experience}:${t.worstAt.frame}:${t.worstAt.piece} ${t.worstAt.stage}${t.worstAt.view?' вид '+t.worstAt.view.az+'/'+t.worstAt.view.el:''})`).join('\n')||'  нет';
console.log('Ткань видна сквозь металл (доспех ушёл в тело):\n'+table('armourBody','см²')+'\nНога в ноге:\n'+table('legLeg','пар'));
console.log(report.status,'→',path.relative(root,reportFile));
process.exit(report.failures.length?1:0);
