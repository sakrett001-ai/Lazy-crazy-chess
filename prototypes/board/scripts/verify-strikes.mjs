import {chromium} from '../../human-base/node_modules/playwright/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

// Strikes from a recording on the fighter (src/strikes.mjs): every strike
// frame by frame, with the checks the capture scene uses and the weapon ones.
//
//   node scripts/verify-strikes.mjs [--page tools/strikes/out/strike-lab.html] [--out tools/strikes/out/verify] [--fps 30] [--frames] [--camera three]
//
// --frames saves every frame as PNG (for the side-by-side videos).
// CHROME_PATH may point at a Chrome or chrome-headless-shell binary.
const args=process.argv.slice(2),opt=(k,d)=>{const i=args.indexOf('--'+k);return i>=0?args[i+1]:d;};
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pageFile=path.resolve(opt('page',path.join(root,'tools/strikes/out/strike-lab.html')));
const out=path.resolve(opt('out',path.join(root,'tools/strikes/out/verify'))),fps=+opt('fps',30),frames=args.includes('--frames'),view=opt('camera','three');
const width=+opt('width',1280),height=+opt('height',720);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width,height}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(pathToFileURL(pageFile).href);
await page.waitForFunction(()=>window.strikeLab&&'ready' in window.strikeLab,null,{timeout:300000});
if(!await page.evaluate(()=>window.strikeLab.ready))throw Error(await page.evaluate(()=>window.strikeLab.error));
await page.evaluate(()=>{window.strikeLab.manual(true);document.querySelector('#bar').hidden=true;});
await page.evaluate(v=>window.strikeLab.camera(v),view);
const list=await page.evaluate(()=>window.strikeLab.list());
// Limits. Knees: 0–140°, never backwards (capture scene). Elbow flexion
// 0–150° (AAOS 1965 / Soucie 2011: 0–145…150°). Wrist bend: under 75°
// (flexion/extension 70–80°, radial/ulnar much less; the solver aims
// lower). Grip: the palm on the handle within 2 cm. Blade: no closer than
// 0 cm to the armour envelope from 18 % of the blade outwards. Shield: the
// pawn's own spear never passes through its shield.
const report=[];
for(const [index,clip]of list.entries()){
 await page.evaluate(i=>window.strikeLab.select(i),index);
 const count=Math.round(clip.duration*fps)+1,acc={knee:{min:180,max:-180,backward:0,sole:9},elbow:{R:[180,0],L:[180,0]},wrist:{R:0,L:0},grip:{R:0,L:0},reach:0,blade:{min:9,where:null,t:null},shield:[]};
 const dir=path.join(out,clip.name);if(frames)await mkdir(dir,{recursive:true});
 for(let i=0;i<count;i++){
  const t=Math.min(clip.duration,i/fps),r=await page.evaluate(t=>window.strikeLab.set(t),t);
  for(const s of ['L','R']){const k=r.knees[s];acc.knee.min=Math.min(acc.knee.min,k.flex);acc.knee.max=Math.max(acc.knee.max,k.flex);acc.knee.sole=Math.min(acc.knee.sole,k.sole);if(k.flex>8&&k.forward<0)acc.knee.backward++;
   if(r.elbow[s]!=null){acc.elbow[s][0]=Math.min(acc.elbow[s][0],r.elbow[s]);acc.elbow[s][1]=Math.max(acc.elbow[s][1],r.elbow[s]);}
   if(r.wrist[s]!=null)acc.wrist[s]=Math.max(acc.wrist[s],r.wrist[s]);if(r.grip[s]!=null)acc.grip[s]=Math.max(acc.grip[s],r.grip[s]);
   acc.reach=Math.max(acc.reach,r.reach?.[s]?.reachErrorM??0);}
  if(r.blade.min<acc.blade.min)acc.blade={min:r.blade.min,where:r.blade.where,t:+t.toFixed(2)};
  if(r.shieldHit!=null)acc.shield.push(+t.toFixed(2));
  if(frames){const data=await page.evaluate(()=>window.strikeLab.screenshot());await writeFile(path.join(dir,`frame-${String(i).padStart(4,'0')}.png`),Buffer.from(data.split(',')[1],'base64'));}
 }
 const two=clip.strike?.loadout?.weaponType==='greatsword'||clip.strike?.loadout?.weaponType==='pike';
 const checks=[
  {name:'колени 0–140°, назад не гнутся',ok:acc.knee.min>=-1&&acc.knee.max<=140&&acc.knee.backward===0,detail:acc.knee},
  {name:'подошвы не уходят в доску глубже 1 см',ok:acc.knee.sole>=-.01,detail:{sole:+acc.knee.sole.toFixed(3)}},
  {name:'локти 0–150°',ok:['R',...(two?['L']:[])].every(s=>acc.elbow[s][0]>=-1&&acc.elbow[s][1]<=150),detail:acc.elbow},
  {name:'кисть: изгиб запястья до 75°',ok:['R',...(two?['L']:[])].every(s=>acc.wrist[s]<=75),detail:acc.wrist},
  {name:'рукоять в ладони (до 2 см)',ok:acc.grip.R<=.02&&(!two||acc.grip.L<=.02),detail:acc.grip},
  {name:'рука дотягивается (недолёт до 2 см)',ok:acc.reach<=.02,detail:{reach:+acc.reach.toFixed(3)}},
  {name:'клинок не проходит сквозь своё тело',ok:acc.blade.min>=0,detail:{...acc.blade,min:+acc.blade.min.toFixed(3)}},
  {name:'копьё не проходит сквозь свой щит',ok:acc.shield.length===0,detail:{frames:acc.shield.slice(0,8)}}];
 report.push({name:clip.name,label:clip.label,frames:count,checks});
 console.log(`\n${clip.label} (${count} кадров)`);for(const c of checks)console.log(' ',c.ok?'✓':'✗',c.name,JSON.stringify(c.detail));
}
const ok=report.every(r=>r.checks.every(c=>c.ok))&&errors.length===0;
await writeFile(path.join(out,'checks.json'),JSON.stringify({fps,view,errors,report},null,1));
await browser.close();
if(errors.length)console.log('Ошибки страницы:',errors.slice(0,5));
if(!ok)process.exit(1);
