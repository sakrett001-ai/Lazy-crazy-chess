import {chromium} from '../../human-base/node_modules/playwright/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {parseMotionFile} from '../src/mocap/format.mjs';

// Browser check of the motion lab (motion-lab.html): the four lanes play
// the built-in clips, the blended lane stays within the board's knee and
// sole limits, the walk advances and stays put on the spot, and the export
// is a valid motion file. Pictures go to review/lab-*.png.
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const review=path.join(root,'review');await mkdir(review,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1280,height:760}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
await page.goto(pathToFileURL(path.join(root,'motion-lab.html')).href);
await page.waitForFunction(()=>window.motionLab&&'ready' in window.motionLab,null,{timeout:300000});
const checks=[],failures=[];
const check=(name,ok,detail)=>{checks.push({name,ok:!!ok,detail});if(!ok)failures.push(name);};
const shot=async name=>{const data=await page.evaluate(()=>window.motionLab.screenshot());await writeFile(path.join(review,`lab-${name}.png`),Buffer.from(data.split(',')[1],'base64'));};
check('the lab starts',await page.evaluate(()=>window.motionLab.ready),null);
await page.evaluate(()=>window.motionLab.manual(true));
const clips=await page.evaluate(()=>window.motionLab.clips());
check('built-in clips are listed',clips.length===2,clips);

// March: two seconds at 30 frames a second, share 60 %.
await page.evaluate(()=>{window.motionLab.select(0);window.motionLab.set({t:0,share:.6,inPlace:false});});
const march=await page.evaluate(()=>window.motionLab.run(2));
check('march: blended knees 0–140°, never backward',march.cycle.minFlex>=-1&&march.cycle.maxFlex<=140&&march.cycle.backward===0,march.cycle);
check('march: soles never sink below the ground (≥ −1 cm)',march.cycle.minSole>=-.01,march.cycle);
check('march: the figures walk forward',march.last.s>1,march.last);
const lanes=await page.evaluate(()=>window.motionLab.pawns());
check('march: the clip lane is on the clip and our lane is not',lanes[1].pose.motion==='synthetic-march'&&!lanes[0].pose.motion&&lanes[0].pose.layered,lanes.map(l=>l.pose));
await page.evaluate(()=>window.motionLab.camera('side'));await shot('march-side');
await page.evaluate(()=>window.motionLab.camera('three'));await shot('march-three');
// On the spot the figures stay at the start.
await page.evaluate(()=>window.motionLab.set({t:0,inPlace:true}));
const still=await page.evaluate(()=>window.motionLab.run(1.5));
check('on the spot: no travel',Math.abs(still.last.s)<1e-6,still.last);
check('on the spot: soles stay on the ground',still.cycle.minSole>=-.01,still.cycle);
// Stance.
await page.evaluate(()=>{window.motionLab.select(1);window.motionLab.set({t:0,inPlace:false});});
const stand=await page.evaluate(()=>window.motionLab.run(2));
check('stance: knees and soles fine',stand.cycle.minFlex>=-1&&stand.cycle.maxFlex<=140&&stand.cycle.minSole>=-.01&&stand.cycle.backward===0,stand.cycle);
await page.evaluate(()=>window.motionLab.camera('front'));await shot('stand-front');
// Export round trip.
const exported=await page.evaluate(()=>window.motionLab.exportFile());
let ok=true;try{parseMotionFile(exported);}catch(error){ok=error.message;}
check('export is a valid motion file with both clips',ok===true&&exported.clips.length===2,ok);
const again=await page.evaluate(t=>window.motionLab.add('motions.json',t).length,JSON.stringify(exported));
check('the exported file opens again',again===2,again);
check('no page errors',errors.length===0,errors.slice(0,5));
await writeFile(path.join(review,'lab-checks.json'),JSON.stringify({checks,failures},null,1));
await browser.close();
for(const c of checks)console.log(c.ok?'✓':'✗',c.name,c.ok?'':JSON.stringify(c.detail));
if(failures.length){console.error(`${failures.length} проверок не прошли`);process.exit(1);}
