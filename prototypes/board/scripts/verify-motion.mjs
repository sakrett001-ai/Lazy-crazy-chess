import {chromium} from '../../human-base/node_modules/playwright/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {syntheticMotionFile} from '../src/mocap/synthetic.mjs';

// Browser check of imported motion on the board, with the built-in
// synthetic walker (no capture file and no GPU needed): the clips load,
// rest and walk use them, the knees and soles stay within the board's
// biomechanics limits, and clearing the clips gives the board back its own
// procedural layer.
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const review=path.join(root,'review');await mkdir(review,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1280,height:800}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
await page.goto(pathToFileURL(path.join(root,'board.html')).href);
await page.waitForFunction(()=>window.livingChess&&'ready' in window.livingChess,null,{timeout:300000});
const checks=[],failures=[];
const check=(name,ok,detail)=>{checks.push({name,ok:!!ok,detail});if(!ok)failures.push(name);};
const shot=async name=>{const data=await page.evaluate(()=>window.livingChess.screenshot());await writeFile(path.join(review,`motion-${name}.png`),Buffer.from(data.split(',')[1],'base64'));};
await page.evaluate(()=>window.livingChess.manual(true));

const text=JSON.stringify(syntheticMotionFile());
const names=await page.evaluate(t=>window.livingChess.motion.add('synthetic.json',t),text);
check('synthetic clips load',names.length===2,names);
const used=await page.evaluate(()=>window.livingChess.motion.use({stand:1,walk:0,weight:1}));
check('stand and walk clips picked',used.stand==='synthetic-stand'&&used.walk==='synthetic-march',used);
await page.evaluate(()=>window.livingChess.step(1));
let state=await page.evaluate(()=>window.livingChess.state());
const pawns=state.pieces.filter(p=>p.type==='p');
check('every pawn at rest stands on the clip',pawns.every(p=>p.pose.motion==='synthetic-stand'),pawns.filter(p=>p.pose.motion!=='synthetic-stand').map(p=>p.id));
const restBio=await page.evaluate(ids=>ids.map(id=>window.livingChess.biomech(id)),pawns.map(p=>p.id));
check('stance on the clip: knees 0–140° and forward, soles on the board',restBio.every(b=>[b.L,b.R].every(k=>k.flex>=-1&&k.flex<=140&&k.sole>-.01)),restBio.slice(0,2));
await page.evaluate(()=>window.livingChess.camera([6,3.2,13],[0,1,6.5]));
await shot('stand');

// e2–e4 on the walk clip, frame by frame.
const id=state.pieces.find(p=>p.square==='e2').id;
check('e2–e4 starts',await page.evaluate(()=>window.livingChess.play('e2','e4')),null);
const walk=await page.evaluate(id=>{
 const L=window.livingChess,out={frames:0,maxFlex:0,minFlex:180,backward:0,minSole:Infinity,onClip:0};
 for(let i=0;i<120&&L.state().busy;i++){
  L.step(1/30,30);const b=L.biomech(id),p=L.state().pieces.find(x=>x.id===id);
  if(p.pose.motion&&p.pose.motion.includes('synthetic-march'))out.onClip++;
  for(const k of [b.L,b.R]){out.maxFlex=Math.max(out.maxFlex,k.flex);out.minFlex=Math.min(out.minFlex,k.flex);if(k.flex>8&&k.forward<0)out.backward++;out.minSole=Math.min(out.minSole,k.sole);}
  out.frames++;
 }
 return out;
},id);
check('the walk plays on the clip',walk.onClip>walk.frames*.8,walk);
check('walking knees stay within 0–140°',walk.minFlex>=-1&&walk.maxFlex<=140,walk);
check('walking knees never bend backward',walk.backward===0,walk);
check('soles never sink into the board while walking (≥ −1 cm)',walk.minSole>=-.01,walk);
state=await page.evaluate(()=>window.livingChess.state());
check('the pawn arrives on e4',state.pieces.find(p=>p.id===id).square==='e4',null);
await shot('walk-done');
// Mid-walk picture.
await page.evaluate(()=>{window.livingChess.play('e7','e5');window.livingChess.step(.8);});
await page.evaluate(()=>window.livingChess.camera([5,2.6,-1],[0,1,-4.5]));
await shot('walk-mid');
await page.evaluate(()=>window.livingChess.step(3));

// Clearing the clips gives the board its own layer back.
await page.evaluate(()=>window.livingChess.motion.use({}));
await page.evaluate(()=>window.livingChess.step(.5));
state=await page.evaluate(()=>window.livingChess.state());
check('without clips the pawns use the procedural layer again',state.pieces.filter(p=>p.type==='p').every(p=>!p.pose.motion),null);
check('no page errors',errors.length===0,errors.slice(0,5));
await writeFile(path.join(review,'motion-checks.json'),JSON.stringify({checks,failures},null,1));
await browser.close();
for(const c of checks)console.log(c.ok?'✓':'✗',c.name,c.ok?'':JSON.stringify(c.detail));
if(failures.length){console.error(`${failures.length} проверок не прошли`);process.exit(1);}
