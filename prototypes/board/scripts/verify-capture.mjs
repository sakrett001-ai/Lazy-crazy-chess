import {chromium} from '../../human-base/node_modules/playwright/index.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

// Browser acceptance of «пешка берёт пешку» played from the Blender clip pair
// (motions/pawn-capture.motion.json, tools/blender/pawn_capture.py) on the
// real skinned pawns: the same scene and measures as verify.mjs, with the
// bodies driven by the clips and the arms by the loadout.
//   node scripts/verify-capture.mjs [--frames] [--view above]
// --frames: every frame as PNG for a video; --view above: from above the attacker's left, to see the spear against the shield.
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const review=path.join(root,'review');await mkdir(review,{recursive:true});
const view=process.argv.includes('--view')?process.argv[process.argv.indexOf('--view')+1]:'side';
const VIEWS={side:[[3.4,1.7,-2.6],[-.4,.95,-.3]],above:[[1.6,4.6,-2.2],[-.35,.8,-.55]]};
if(!VIEWS[view])throw Error('--view: '+Object.keys(VIEWS).join(', '));
const framesDir=path.join(review,view==='side'?'capture-frames':`capture-frames-${view}`),keepFrames=process.argv.includes('--frames');
if(keepFrames)await mkdir(framesDir,{recursive:true});
const file=path.join(root,'motions/pawn-capture.motion.json'),text=await readFile(file,'utf8');
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1280,height:720}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
await page.goto(pathToFileURL(path.join(root,'board.html')).href);
await page.waitForFunction(()=>window.livingChess&&'ready' in window.livingChess,null,{timeout:300000});
const failures=[],checks=[];
const check=(name,ok,detail)=>{checks.push({name,ok:!!ok,detail});if(!ok)failures.push(name);};
const png=async()=>Buffer.from((await page.evaluate(()=>window.livingChess.screenshot())).split(',')[1],'base64');
check('page loads with WebGL',await page.evaluate(()=>window.livingChess.ready),null);
await page.evaluate(()=>window.livingChess.manual(true));

await page.evaluate(()=>window.livingChess.load('capture'));
// A preview build (build.mjs --motion) already carries the clip; a plain
// build gets it here, as if opened by hand.
const used=await page.evaluate(([name,text])=>{const L=window.livingChess;if(!L.motion.list().includes('pawn-capture-strike'))L.motion.add(name,text);return L.motion.use({capture:L.motion.list().indexOf('pawn-capture-strike')});},[path.basename(file),text]);
check('the board takes the clip pair for the capture',used.capture==='pawn-capture-strike'&&used.pair,used);
const victimId=await page.evaluate(()=>window.livingChess.state().pieces.find(p=>p.square==='d5').id);
const played=await page.evaluate(()=>window.livingChess.play('e4','d5'));
check('e4 takes d5 is accepted by the rules',played,played);
const {hitTime,captureDuration}=await page.evaluate(()=>({hitTime:window.livingChess.hitTime,captureDuration:window.livingChess.captureDuration}));
await page.evaluate(([p,t])=>window.livingChess.camera(p,t),VIEWS[view]);
const phases=[['march',1.0],['coil',2.2],['feint',2.5],['strike',hitTime],['jolt',3.7],['knees-give',4.3],['step-in',5.6],['end',captureDuration]];
const capture=[],images={};
for(let i=0;i<=Math.round((captureDuration+.1)*30);i++){
 const t=+(i/30).toFixed(3);
 capture.push(await page.evaluate(([t,v])=>{const L=window.livingChess,a=L.state().pieces.find(p=>p.id==='wp-e4');return{t,tip:L.tip('wp-e4'),grip:L.grip?.('wp-e4'),attacker:a.place,body:L.biomech('wp-e4'),victim:L.biomech(v),trunk:L.pointsWorld(v,['root','spine03','spine05','neck01','head']),feet:L.feetWorld('wp-e4')};},[t,victimId]));
 if(keepFrames)await writeFile(path.join(framesDir,`f${String(i).padStart(4,'0')}.png`),await png());
 const phase=phases.find(([,at])=>Math.round(at*30)===i);
 if(phase){images[phase[0]]=`capture-clip-${view==='side'?'':view+'-'}${phase[0]}.png`;await writeFile(path.join(review,images[phase[0]]),await png());}
 await page.evaluate(()=>window.livingChess.step(1/30,30));
}
const victim={x:-1.3,z:-1.3};
const hit=capture[Math.round(hitTime*30)],hitAxis=Math.hypot(hit.tip[0]-victim.x,hit.tip[2]-victim.z);
check('at the hit the spear tip is at the defender flank (10–25 cm from the body axis)',hitAxis>=.1&&hitAxis<=.25,{distanceM:+hitAxis.toFixed(3),time:hit.t});
check('the hit lands at body height (0.8–1.5 m)',hit.tip[1]>.8&&hit.tip[1]<1.5,+hit.tip[1].toFixed(2));
// After the hit the shaft must not sink deeper into the falling defender:
// the closest approach of grip→tip to the trunk axis (root…head) is never
// more than 2 cm nearer than at the hit itself.
const seg=(p,q,a,b)=>{const d1=q.map((x,i)=>x-p[i]),d2=b.map((x,i)=>x-a[i]),r=p.map((x,i)=>x-a[i]),dt=(u,v)=>u[0]*v[0]+u[1]*v[1]+u[2]*v[2];
 const A=dt(d1,d1),E=dt(d2,d2),F=dt(d2,r),C=dt(d1,r),B=dt(d1,d2),den=A*E-B*B;let s=den>1e-9?Math.min(1,Math.max(0,(B*F-C*E)/den)):0,t=(B*s+F)/E;
 if(t<0){t=0;s=Math.min(1,Math.max(0,-C/A));}else if(t>1){t=1;s=Math.min(1,Math.max(0,(B-C)/A));}
 return Math.hypot(...p.map((x,i)=>x+d1[i]*s-a[i]-d2[i]*t));};
const axisGap=f=>{if(!f.grip||!f.trunk?.root)return Infinity;const k=['root','spine03','spine05','neck01','head'].map(n=>f.trunk[n]);let m=Infinity;for(let i=0;i<k.length-1;i++)m=Math.min(m,seg(f.grip,f.tip,k[i],k[i+1]));return m;};
const after=capture.filter(f=>f.t>hitTime+.05&&f.t<=4.6&&f.trunk?.root),atHit=axisGap(hit),closest=after.reduce((m,f)=>{const g=axisGap(f);return g<m.gap?{gap:g,t:f.t}:m;},{gap:Infinity,t:null});
check('after the hit the spear does not sink deeper into the defender (≥ hit − 2 cm from its trunk axis)',closest.gap>=atHit-.02,{atHitM:+atHit.toFixed(3),closestM:+closest.gap.toFixed(3),time:closest.t});
const jumps=capture.slice(1).map((f,i)=>Math.hypot(f.attacker.x-capture[i].attacker.x,f.attacker.z-capture[i].attacker.z));
check('attacker moves without jumps (< 15 cm per frame)',Math.max(...jumps)<.15,+Math.max(...jumps).toFixed(3));
const bodies=[...capture.map(f=>f.body),...capture.filter(f=>f.victim).map(f=>({...f.victim,struck:f.t>hitTime}))].filter(Boolean);
const knees=bodies.flatMap(b=>[b.L,b.R]),maxFlex=Math.max(...knees.map(k=>k.flex));
check('knees stay within 0–140° flexion',knees.every(k=>k.flex>=-1&&k.flex<=140),{maxFlexDeg:+maxFlex.toFixed(1)});
check('bent knees point forward, never backwards',knees.every(k=>k.flex<8||k.forward>0),knees.filter(k=>k.flex>=8&&k.forward<=0).length);
const soles=bodies.filter(b=>!(b.fall>.01)).flatMap(b=>[b.L.sole,b.R.sole]);
check('soles do not sink into the board (≥ rest − 2 cm)',Math.min(...soles)>=.054,+Math.min(...soles).toFixed(3));
check('pelvis over the feet while standing',bodies.filter(b=>!b.struck).every(b=>b.pelvisOverFeet),bodies.filter(b=>!b.struck&&!b.pelvisOverFeet).length);
// The clip's planted feet stay planted on the board once the attacker has
// turned onto the line (0.5 s) and until it turns back at the end (5.7 s).
let slide=0,planted=0;
for(let i=1;i<capture.length;i++){const t=capture[i].t;if(t<.6||t>5.6)continue;for(const f of ['foot.L','foot.R']){const a=capture[i-1].feet[f],b=capture[i].feet[f];if(a[1]<.08&&b[1]<.08){planted++;slide=Math.max(slide,Math.hypot(b[0]-a[0],b[2]-a[2]));}}}
check('planted feet do not slide (≤ 1.5 cm per frame)',planted>60&&slide<=.015,{plantedFrames:planted,maxSlideM:+slide.toFixed(4)});
const state=await page.evaluate(()=>window.livingChess.state());
check('after the scene the attacker stands on d5 and the victim is gone',state.actors===3&&state.pieces.find(p=>p.square==='d5')?.id==='wp-e4'&&!state.busy,state.fen);
check('no page errors',errors.length===0,errors.slice(0,5));
await browser.close();
const report={status:failures.length?'failed':'passed',failures,checks,hit:{distanceM:+hitAxis.toFixed(3),heightM:+hit.tip[1].toFixed(3)},images,frames:keepFrames?capture.length:0,
 scope:'Sampled at 30 Hz with a fixed clock on the skinned pawns. Bodies come from the clip pair; arms, spear and shield from the loadout on the board timeline. Not a physics or continuous collision check.'};
await writeFile(path.join(review,'capture-clip-checks.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,failures,hit:report.hit,slide:{planted,maxSlideM:slide}},null,1));
process.exit(failures.length?1:0);
