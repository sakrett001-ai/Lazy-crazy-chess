import {loadPage} from '../tools/cpu-render/env.mjs';
import {createRasterizer} from '../tools/cpu-render/raster.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {cpus} from 'node:os';
import {rm,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {PNG} from 'pngjs';

// The pawns' duel as the board plays it, drawn on the CPU (no graphics card,
// no browser) into video and a contact sheet, so motion can be judged by eye
// on any machine. The board's own code runs in Node (tools/cpu-render): the
// same model, the same recorded exchange (motions/duel-516.motion.json), the
// same «пешка берёт пешку» position as scripts/verify-duel.mjs; only the
// drawing is done by tools/cpu-render/raster.mjs instead of WebGL.
//
// Writes into review/render/ (not kept in git):
//   duel-close.mp4  — the two pawns from the side, close;
//   duel-board.mp4  — the board's home camera;
//   duel-sheet.png  — 16 close-up frames, evenly over the clip, with time and phase;
//   duel-measures.json — per frame: head against chest (yaw, pitch, roll),
//     the head's angular acceleration (shake), planted-foot sliding, the
//     spear's closest approach to the other trunk.
//   npm run render:duel -- [--fps 30] [--size 1280x720] [--ssaa 2] [--fence 2] [--only close] [--jobs 4] [--seed 1]
// Needs ffmpeg on PATH. Frames are drawn by --jobs processes in parallel:
// each one plays the whole clip (the board is deterministic for a given
// seed) and draws every jobs-th frame into review/render/frames/.
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg=(k,d)=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:d;};
const FPS=+arg('--fps',30),[W,H]=arg('--size','1280x720').split('x').map(Number),SSAA=+arg('--ssaa',2),CYCLES=+arg('--fence',2),only=arg('--only',null);
const SEED=+arg('--seed',1),shard=arg('--shard',null),JOBS=+arg('--jobs',Math.max(1,Math.min(4,cpus().length)));
const out=path.join(root,'review','render'),framesDir=path.join(out,'frames');await mkdir(out,{recursive:true});
const run=(cmd,args,opt={})=>new Promise((res,rej)=>{const p=spawn(cmd,args,{stdio:['ignore','inherit','inherit'],...opt});p.on('close',c=>c===0?res():rej(Error(`${cmd} exited ${c}`)));});
if(!shard){
 // Orchestrator: start the drawing processes, then make the videos and the sheet.
 const t0=Date.now();await rm(framesDir,{recursive:true,force:true});await mkdir(framesDir,{recursive:true});
 const rest=process.argv.slice(2);await Promise.all([...Array(JOBS)].map((_,r)=>run(process.execPath,[fileURLToPath(import.meta.url),...rest,'--shard',`${r}/${JOBS}`])));
 const measures=JSON.parse(await readFile(path.join(out,'duel-measures.json'),'utf8')),names=[...new Set((await readdir(framesDir)).map(f=>f.split('-')[0]))];
 for(const v of names)await run('ffmpeg',['-y','-loglevel','error','-framerate',String(FPS),'-i',path.join(framesDir,`${v}-%05d.png`),'-c:v','libx264','-preset','medium','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',path.join(out,`duel-${v}.mp4`)]);
 if(names.includes('close'))await contactSheet(measures.frames);
 console.log(JSON.stringify({out,frames:measures.frames.length,seconds:((Date.now()-t0)/1000).toFixed(0),summary:measures.summary},null,1));
 process.exit(0);}
const [SHARD,NSHARD]=shard.split('/').map(Number),lead=SHARD===0;

// ---- the board page in Node ----
const [tpl,glb,motionText]=await Promise.all([readFile(path.join(root,'src/index.html'),'utf8'),readFile(path.join(root,'../white-pawn/assets/white-pawn.glb')),readFile(path.join(root,'motions/duel-516.motion.json'),'utf8')]);
const html=tpl.replace('/*MODEL*/',()=>glb.toString('base64')).replace('/*MOTIONS*/[]','[]').replace('/*STYLE*/','').replace('/*SCRIPT*/','');
const t0=Date.now();
const page=await loadPage({html,entry:path.join(root,'src/board.mjs'),nodePaths:[path.join(root,'../white-pawn/node_modules'),path.join(root,'../human-base/node_modules')],width:W,height:H,url:`file:///page.html?seed=${SEED}`});
const L=page.window.livingChess;if(!L.ready)throw Error('board did not start: '+L.fallback);
const THREE=globalThis.__THREE;
L.manual(true);L.load('capture');
L.motion.add('duel-516.motion.json',motionText);const used=L.motion.use({duel:0});
if(used.duel?.exchange!=='duel516.exchange.attack')throw Error('recorded exchange not taken: '+JSON.stringify(used));
const A='wp-e4',V=L.state().pieces.find(p=>p.square==='d5').id;
L.home();const scene=page.lastScene,boardCamera=page.lastCamera;
if(lead)console.log(`board ready in ${((Date.now()-t0)/1000).toFixed(1)} s; attacker ${A}, defender ${V}`);

// ---- the ground paint of src/ground-paint.mjs, per pixel on the CPU ----
// Same squares, joints, sand and turf colours; the fine grain is coarser.
const SQ=2.6,HALF=4*SQ,lin=c=>Math.pow(c,2.2);
const hash=(x,y)=>{let p3x=(x*.1031)%1,p3y=(y*.1031)%1,p3z=(x*.1031)%1;p3x-=Math.floor(p3x);p3y-=Math.floor(p3y);p3z-=Math.floor(p3z);
 const d=p3x*(p3y+33.33)+p3y*(p3z+33.33)+p3z*(p3x+33.33);p3x+=d;p3y+=d;p3z+=d;const v=(p3x+p3y)*p3z;return v-Math.floor(v);};
const noise=(x,y)=>{const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy,ux=fx*fx*(3-2*fx),uy=fy*fy*(3-2*fy);
 const a=hash(ix,iy),b=hash(ix+1,iy),c=hash(ix,iy+1),d=hash(ix+1,iy+1);return((a+(b-a)*ux)+((c+(d-c)*ux)-(a+(b-a)*ux))*uy)*2-1;};
const fbm=(x,y,o)=>{let s=0,a=.5;for(let i=0;i<o;i++){s+=a*noise(x,y);x=x*2.03+17.1;y=y*2.03+9.7;a*=.5;}return s;};
const smooth=(a,b,x)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};
const SAND=[[.47,.41,.31].map(lin),[.62,.55,.42].map(lin)],TURF=[[.16,.21,.08].map(lin),[.27,.31,.13].map(lin)],JOINT=[.33,.28,.22].map(lin),MUD=[[.24,.18,.12].map(lin),[.52,.45,.34].map(lin)];
const gc=new Float64Array(3);
function groundPaint(x,y,z,albedo){
 const wx=fbm(x*2.1,z*2.1,3)*.05,wz=fbm(x*2.1+31,z*2.1+31,3)*.05,gx=(x+wx)/SQ,gz=(z+wz)/SQ;
 const file=Math.floor(gx+4),rank=Math.floor(4-gz),light=((file+rank)%2+2)%2;
 const fx=gx+4-Math.floor(gx+4),fz=gz+4-Math.floor(gz+4),edge=Math.min(fx,1-fx,fz,1-fz)*SQ,middle=Math.hypot(fx-.5,fz-.5)*SQ;
 const mask=1-smooth(HALF-.01,HALF+.05,Math.max(Math.abs(x+wx),Math.abs(z+wz)));if(mask<=0)return;
 const big=fbm(x*.8,z*.8,3),mid=fbm(x*5,z*5,3),own=hash(file,rank)*2-1;
 const pair=light?SAND:TURF,k=Math.min(1,Math.max(0,.5+.7*big+(light?.12:.15)*own)),gain=1+(light?.32:.35)*mid;
 for(let i=0;i<3;i++)gc[i]=(pair[0][i]+(pair[1][i]-pair[0][i])*k)*gain;
 const worn=fbm(x*1.7+3,z*1.7,3),trod=(1-smooth(.2,1,middle*(1+.55*worn)+.3*big))*smooth(-.35,.25,worn+.25*mid)*.55,mud=MUD[light?1:0];
 const joint=(1-smooth(.028,.06,edge+.012*mid))*.92;
 for(let i=0;i<3;i++){let v=gc[i]+(mud[i]-gc[i])*trod;v+=(JOINT[i]-v)*joint;albedo[i]=albedo[i]*(1-mask)+v*mask;}
 return{roughness:.9};}

const raster=createRasterizer(THREE,{width:W,height:H,ssaa:SSAA,paint:{'living-chess-ground':groundPaint}});

// ---- bones of a pawn, for the measures ----
const holderOf=id=>{let h=null;scene.traverse(o=>{if(!h&&o.name===id&&!o.isBone)h=o;});return h;};
const bonesOf=id=>{const b={};holderOf(id).traverse(o=>{if(o.isBone&&!b[o.name])b[o.name]=o;});return b;};
const bones={[A]:bonesOf(A),[V]:bonesOf(V)};
// Rest relation head ← chest from the bind pose (the skeleton's inverse bind matrices).
const restWorld=(id,name)=>{let found=null;holderOf(id).traverse(o=>{if(found||!o.isSkinnedMesh)return;const i=o.skeleton.bones.findIndex(b=>b.name===name);if(i>=0)found=new THREE.Matrix4().copy(o.skeleton.boneInverses[i]).invert();});return found;};
const restRel={};for(const id of [A,V]){const c=new THREE.Quaternion().setFromRotationMatrix(restWorld(id,'spine01')||restWorld(id,'spine03')),h=new THREE.Quaternion().setFromRotationMatrix(restWorld(id,'head'));restRel[id]=c.clone().invert().multiply(h);}
const CHEST=bones[A].spine01?'spine01':'spine03';
function headAgainstChest(id){const b=bones[id],c=b[CHEST].getWorldQuaternion(new THREE.Quaternion()),h=b.head.getWorldQuaternion(new THREE.Quaternion());
 const rel=c.clone().invert().multiply(h).multiply(restRel[id].clone().invert());
 // In the chest's rest frame (MakeHuman bones: y along the spine).
 const e=new THREE.Euler().setFromQuaternion(rel,'YXZ');const deg=x=>+(x*180/Math.PI).toFixed(1);
 return{yaw:deg(e.y),pitch:deg(e.x),roll:deg(e.z),total:deg(2*Math.acos(Math.min(1,Math.abs(rel.w)))),q:h};}

// ---- cameras ----
scene.updateMatrixWorld(true);
const pa=new THREE.Vector3(),pv=new THREE.Vector3();bones[A].root.getWorldPosition(pa);bones[V].root.getWorldPosition(pv);
const mid=pa.clone().add(pv).multiplyScalar(.5),line=pv.clone().sub(pa).setY(0).normalize(),side=new THREE.Vector3(line.z,0,-line.x);
// The side looking away from the board's home camera would face the trees; take the one towards it.
if(side.dot(new THREE.Vector3(0,0,1))<0)side.negate();
const closeCamera=new THREE.PerspectiveCamera(34,W/H,.1,900);
closeCamera.position.copy(mid).addScaledVector(side,5.6).add(new THREE.Vector3(0,1.2,0)).addScaledVector(line,.5);closeCamera.lookAt(mid.clone().add(new THREE.Vector3(0,.95,0)).addScaledVector(line,.5));
const views=[{name:'close',camera:closeCamera,shadow:{center:mid.clone().add(new THREE.Vector3(0,1,0)),halfSize:5}},{name:'board',camera:boardCamera,shadow:{center:new THREE.Vector3(0,0,0),halfSize:14}}].filter(v=>!only||v.name===only);

// ---- the clip: fencing, then e4 takes d5 ----
const frames=[];let phase='обмен ударами';
const phaseText=()=>page.window.document.querySelector('#phase')?.textContent||'';
const spearGap=(by,at)=>{const g=L.grip(by),t=L.tip(by);if(!g||!t||!L.shown(at))return null;const P=L.pointsWorld(at,['root','spine03','spine05','neck01','head']);
 const seg=(p,q,a,b)=>{const d1=q.map((x,i)=>x-p[i]),d2=b.map((x,i)=>x-a[i]),r=p.map((x,i)=>x-a[i]),dt=(u,v)=>u[0]*v[0]+u[1]*v[1]+u[2]*v[2],PP=dt(d1,d1),E=dt(d2,d2),F=dt(d2,r),C=dt(d1,r),B=dt(d1,d2),den=PP*E-B*B;
  let s=den>1e-9?Math.min(1,Math.max(0,(B*F-C*E)/den)):0,t=(B*s+F)/E;if(t<0){t=0;s=Math.min(1,Math.max(0,-C/PP));}else if(t>1){t=1;s=Math.min(1,Math.max(0,(B-C)/PP));}
  return Math.hypot(...p.map((x,i)=>x+d1[i]*s-a[i]-d2[i]*t));};
 const k=Object.values(P);let m=Infinity;for(let i=0;i<k.length-1;i++)m=Math.min(m,seg(g,t,k[i],k[i+1]));return+m.toFixed(3);};
async function grab(stage){
 const f={i:frames.length,t:+(frames.length/FPS).toFixed(3),stage,phase:phaseText()||phase,pieces:{}};
 for(const id of [A,V]){if(!L.shown(id)){f.pieces[id]=null;continue;}const h=headAgainstChest(id),feet=L.feetWorld(id);
  f.pieces[id]={head:{yaw:h.yaw,pitch:h.pitch,roll:h.roll,total:h.total},hq:h.q.toArray(),feet,spearToOther:spearGap(id,id===A?V:A)};}
 frames.push(f);
 if(f.i%NSHARD===SHARD)for(const v of views){const img=raster.render(scene,v.camera,{shadow:v.shadow});
  await writeFile(path.join(framesDir,`${v.name}-${String(f.i).padStart(5,'0')}.png`),PNG.sync.write({width:img.width,height:img.height,data:img.rgb},{colorType:2,inputColorType:2,inputHasAlpha:false,deflateLevel:3}));}
 if(lead&&frames.length%30===0)console.log(`frame ${frames.length} (${stage}) ${((Date.now()-t0)/1000).toFixed(0)} s`);}
const cycle=2.367,fenceFrames=Math.round(CYCLES*cycle*FPS);
for(let i=0;i<fenceFrames;i++){await grab('fence');L.step(1/FPS,FPS,false);}
L.play('e4','d5');
for(let i=0;i<40*FPS;i++){if(!L.state().busy)break;await grab('take');L.step(1/FPS,FPS,false);}
for(let i=0;i<FPS;i++){await grab('after');L.step(1/FPS,FPS,false);}

// ---- measures: head against chest, head shake, planted feet sliding ----
const deg=x=>+x.toFixed(1),angle=(a,b)=>{const qa=new THREE.Quaternion(...a),qb=new THREE.Quaternion(...b);return 2*Math.acos(Math.min(1,Math.abs(qa.dot(qb))))*180/Math.PI;};
const summary={};
for(const id of [A,V]){const seq=frames.map(f=>f.pieces[id]).filter(Boolean),who=id===A?'e4 (атакует)':'d5 (берут)';
 const yaw=seq.map(p=>Math.abs(p.head.yaw)),pitch=seq.map(p=>p.head.pitch),roll=seq.map(p=>Math.abs(p.head.roll)),total=seq.map(p=>p.head.total);
 // Angular speed of the head in the world, deg/s, and its change frame to frame (shake = sign flips of acceleration with size).
 const speed=[];for(let i=1;i<seq.length;i++)speed.push(angle(seq[i-1].hq,seq[i].hq)*FPS);
 const accel=[];for(let i=1;i<speed.length;i++)accel.push((speed[i]-speed[i-1])*FPS);
 let flips=0;for(let i=1;i<accel.length;i++)if(Math.sign(accel[i])!==Math.sign(accel[i-1])&&Math.abs(accel[i])>3000&&Math.abs(accel[i-1])>3000)flips++;
 // Foot sliding: a foot low on the ground (≤ 6 cm sole height above the lowest) that moves sideways.
 const slide=[];for(const s of ['foot.L','foot.R'])for(let i=1;i<seq.length;i++){const a=seq[i-1].feet?.[s],b=seq[i].feet?.[s];if(!a||!b)continue;const v=Math.hypot(b[0]-a[0],b[2]-a[2])*FPS,low=Math.max(a[1],b[1])<.12;if(low)slide.push({i,side:s,mps:+v.toFixed(2)});}
 const slow=slide.filter(s=>s.mps>.05&&s.mps<.6);
 summary[who]={frames:seq.length,headYawMaxDeg:deg(Math.max(...yaw)),headYawOver60Frames:yaw.filter(y=>y>60).length,headYawOver90Frames:yaw.filter(y=>y>90).length,
  headPitchRangeDeg:[deg(Math.min(...pitch)),deg(Math.max(...pitch))],headRollMaxDeg:deg(Math.max(...roll)),headTotalMaxDeg:deg(Math.max(...total)),
  headSpeedMaxDegPerS:deg(Math.max(...speed)),headShakeFlips:flips,plantedFootSlideFrames:slow.length,worstSlide:slow.sort((a,b)=>b.mps-a.mps).slice(0,3)};}
const gaps=frames.filter(f=>f.stage==='fence').flatMap(f=>[f.pieces[A]?.spearToOther,f.pieces[V]?.spearToOther]).filter(x=>x!==null&&x!==undefined);
summary.fenceSpearClosestToTrunkM=gaps.length?Math.min(...gaps):null;
if(lead)await writeFile(path.join(out,'duel-measures.json'),JSON.stringify({fps:FPS,size:[W,H],ssaa:SSAA,attacker:A,defender:V,summary,frames:frames.map(({pieces,...f})=>({...f,pieces:Object.fromEntries(Object.entries(pieces).map(([k,p])=>[k,p&&{head:p.head,spearToOther:p.spearToOther,feet:p.feet}]))}))},null,1));

process.exit(0);

// ---- contact sheet: 16 close-up frames, 4×4, with time and phase ----
async function contactSheet(frames){const files=frames.map(f=>path.join(framesDir,`close-${String(f.i).padStart(5,'0')}.png`)),n=16,cols=4,tw=Math.round(W*3/8),th=Math.round(H*3/8),pick=[...Array(n)].map((_,k)=>Math.round(k*(files.length-1)/(n-1)));
 const sheet=new PNG({width:tw*cols,height:th*Math.ceil(n/cols)});sheet.data.fill(255);
 for(const [k,fi] of pick.entries()){const png=PNG.sync.read(await readFile(files[fi])),src=png.data,ox=(k%cols)*tw,oy=Math.floor(k/cols)*th;
  const kx=W/tw,ky=H/th;for(let y=0;y<th;y++)for(let x=0;x<tw;x++){let r=0,g=0,b=0,c=0;for(let Y=Math.floor(y*ky);Y<Math.min(H,Math.ceil((y+1)*ky));Y++)for(let X=Math.floor(x*kx);X<Math.min(W,Math.ceil((x+1)*kx));X++){const i=(Y*W+X)*4;r+=src[i];g+=src[i+1];b+=src[i+2];c++;}
   const o=((oy+y)*sheet.width+ox+x)*4;sheet.data[o]=r/c;sheet.data[o+1]=g/c;sheet.data[o+2]=b/c;sheet.data[o+3]=255;}}
 const raw=path.join(out,'duel-sheet-raw.png');await writeFile(raw,PNG.sync.write(sheet));
 // Labels with ffmpeg drawtext (time and phase of each cell).
 const esc=s=>s.replace(/\\/g,'\\\\').replace(/:/g,'\\:').replace(/'/g,'’').replace(/%/g,'\\%');
 const draws=pick.map((fi,k)=>{const f=frames[fi],x=(k%cols)*tw+8,y=Math.floor(k/cols)*th+8;return`drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=4:x=${x}:y=${y}:text='${esc(`${f.t.toFixed(2)} с · ${f.stage==='fence'?'обмен ударами':f.phase||'взятие'}`)}'`;}).join(',');
 await new Promise((res,rej)=>{const p=spawn('ffmpeg',['-y','-loglevel','error','-i',raw,'-vf',draws,path.join(out,'duel-sheet.png')]);p.on('close',c=>c===0?res():rej(Error('ffmpeg drawtext '+c)));});}
