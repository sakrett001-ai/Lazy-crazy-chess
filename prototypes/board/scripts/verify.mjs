import {chromium} from '../../human-base/node_modules/playwright/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

// Browser acceptance of the standalone board on the real skinned pawns.
// It drives the page with a fixed 30 Hz clock, so results do not depend on
// the speed of the machine. Geometry checks are sampled per frame; they are
// animation measurements, not a physics or collision solver.
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const review=path.join(root,'review');await mkdir(review,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1280,height:800}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
await page.goto(pathToFileURL(path.join(root,'board.html')).href);
await page.waitForFunction(()=>window.livingChess&&'ready' in window.livingChess,null,{timeout:300000});
const failures=[],checks=[];
const check=(name,ok,detail)=>{checks.push({name,ok:!!ok,detail});if(!ok)failures.push(name);};
const shot=async(name)=>{const data=await page.evaluate(()=>window.livingChess.screenshot());await writeFile(path.join(review,`board-${name}.png`),Buffer.from(data.split(',')[1],'base64'));return`board-${name}.png`;};
check('page loads with WebGL',await page.evaluate(()=>window.livingChess.ready),null);
await page.evaluate(()=>window.livingChess.manual(true));

// 1. Starting position: 32 figures, every pawn at rest.
let state=await page.evaluate(()=>window.livingChess.state());
check('32 figures on the board',state.actors===32,state.actors);
check('all figures at rest in the starting position',state.pieces.every(p=>p.state==='rest'),state.pieces.filter(p=>p.state!=='rest').map(p=>p.id));
await page.evaluate(()=>window.livingChess.step(.5));
const images={start:await shot('start')};

// 2. Clash: fencing pair and a pawn braced against a knight. Every fencing
// thrust must stop at the partner's shield face, not pass through it.
await page.evaluate(()=>window.livingChess.load('clash'));
state=await page.evaluate(()=>window.livingChess.state());
const at=sq=>state.pieces.find(p=>p.square===sq);
check('d4 and d5 fence each other',at('d4').state==='fencing'&&at('d5').state==='fencing'&&at('d4').target===at('d5').id,[at('d4'),at('d5')].map(p=>p.state));
check('e4 braces behind its shield against the knight',at('e4').state==='defense'&&at('e4').target===at('f5').id,at('e4').state);
const fencing=await page.evaluate(({shieldFront})=>{
 const L=window.livingChess,ids=['wp-d4','bp-d5'],out={frames:0,maxDepth:-Infinity,thrusts:{'wp-d4':0,'bp-d5':0},overlap:0,minReach:Infinity};
 for(let i=0;i<8*30;i++){
  L.step(1/30,30);const s=L.state(),pieces=Object.fromEntries(s.pieces.map(p=>[p.id,p]));
  const attacking=ids.filter(id=>pieces[id].pose.action==='Spear_Study');
  if(attacking.length>1)out.overlap++;
  for(const id of attacking){
   const other=ids.find(x=>x!==id),tip=L.tip(id),p=pieces[other].place;
   // Tip in the partner's frame: local z is the partner's forward axis.
   const dx=tip[0]-p.x,dz=tip[2]-p.z,localZ=-dx*Math.sin(-p.yaw)+dz*Math.cos(-p.yaw);
   out.maxDepth=Math.max(out.maxDepth,shieldFront-localZ);
   out.minReach=Math.min(out.minReach,localZ-shieldFront);
   out.thrusts[id]++;
  }
  out.frames++;
 }
 return out;
},{shieldFront:state.shield.front});
check('fencing partners never thrust at the same moment',fencing.overlap===0,fencing.overlap);
check('both partners take a turn to thrust',fencing.thrusts['wp-d4']>30&&fencing.thrusts['bp-d5']>30,fencing.thrusts);
check('fencing thrusts stop at the shield face (≤ 3 cm)',fencing.maxDepth<=.03,{maxDepthM:+fencing.maxDepth.toFixed(3)});
await page.evaluate(()=>{window.livingChess.load('clash');window.livingChess.camera([7.5,4.2,6.5],[-.6,1,0]);});
await page.evaluate(()=>window.livingChess.step(1.7));
images.fencing=await shot('clash');

// 3. Pawn takes pawn: feint, thrust into the flank, fall, step in.
await page.evaluate(()=>window.livingChess.load('capture'));
const played=await page.evaluate(()=>window.livingChess.play('e4','d5'));
check('e4 takes d5 is accepted by the rules',played,played);
await page.evaluate(()=>window.livingChess.camera([6.8,3.4,5.4],[-.4,1,-.3]));
const capture=await page.evaluate(()=>{
 const L=window.livingChess,frames=[];
 for(let i=0;i<=Math.round(4.5*30);i++){
  const s=L.state(),a=s.pieces.find(p=>p.id==='wp-e4');
  frames.push({t:+(i/30).toFixed(3),tip:L.tip('wp-e4'),attacker:a.place,pose:a.pose});
  L.step(1/30,30);
 }
 return frames;
});
const victim={x:-1.3,z:-1.3};
const hit=capture.reduce((best,f)=>{const d=Math.hypot(f.tip[0]-victim.x,f.tip[2]-victim.z);return d<best.d?{d,f}:best;},{d:Infinity});
check('the thrust reaches the defender at the hit (tip ≤ 25 cm from body axis)',hit.d<=.25,{distanceM:+hit.d.toFixed(3),time:hit.f.t,tipHeightM:+hit.f.tip[1].toFixed(2)});
check('the hit lands at body height (0.8–1.5 m)',hit.f.tip[1]>.8&&hit.f.tip[1]<1.5,+hit.f.tip[1].toFixed(2));
const jumps=capture.slice(1).map((f,i)=>Math.hypot(f.attacker.x-capture[i].attacker.x,f.attacker.z-capture[i].attacker.z));
check('attacker moves without jumps (< 15 cm per frame)',Math.max(...jumps)<.15,+Math.max(...jumps).toFixed(3));
state=await page.evaluate(()=>window.livingChess.state());
check('after the scene the attacker stands on d5 and the victim is gone',state.actors===3&&state.pieces.find(p=>p.square==='d5')?.id==='wp-e4'&&!state.busy,state.fen);
// Contact sheet of the phases.
const phases=[['turn',.35],['approach',1.1],['feint',1.55],['shield-turn',1.85],['strike',2.3],['fall',2.85],['removed',3.75],['step-in',4.4]];
images.capture={};
for(const [name,t]of phases){
 await page.evaluate(t=>{const L=window.livingChess;L.load('capture');L.play('e4','d5');L.camera([6.8,3.4,5.4],[-.4,1,-.3]);L.step(t,30);},t);
 images.capture[name]=await shot(`capture-${name}`);
}

// 4. A short real game with the automatic reply, including castling.
await page.evaluate(()=>{const L=window.livingChess;L.load('start');L.home();});
const game=await page.evaluate(()=>{
 const L=window.livingChess,line=[['e2','e4'],['e7','e5'],['g1','f3'],['b8','c6'],['f1','c4'],['g8','f6'],['e1','g1']],done=[];
 for(const [f,t]of line){const ok=L.play(f,t);done.push(ok);L.step(5,30);}
 return{done,state:L.state()};
});
check('a legal opening including castling plays through',game.done.every(Boolean)&&game.state.pieces.some(p=>p.id==='wr-h1'&&p.square==='f1'),game.state.fen);
images.game=await shot('opening');
const perf=await page.evaluate(()=>({...window.livingChess.profile(5),triangles:window.livingChess.state().triangles}));
check('no page errors',errors.length===0,errors.slice(0,5));
await browser.close();
const report={status:failures.length?'failed':'passed',failures,checks,fencing,performance:{...perf,note:'Pose solving per figure on this machine; rendering speed depends on the GPU.'},images,scope:'Sampled at 30 Hz with a fixed clock. Spear tip and shield face are measured on the skinned model; this is not a physics or continuous collision check. Garment intersections of the pawn model are a separate known limitation.'};
await writeFile(path.join(review,'board-checks.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,failures,fencing,hit:{d:hit.d,t:hit.f.t},perf},null,1));
process.exit(failures.length?1:0);
