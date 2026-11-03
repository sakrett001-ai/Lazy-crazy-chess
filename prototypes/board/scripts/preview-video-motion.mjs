import {chromium} from '../../human-base/node_modules/playwright/index.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

// A motion file from video (tools/videomocap) on the pawn: opens the motion
// lab, plays the first clip of the file frame by frame and saves every frame
// as PNG, plus the lab's biomechanics over the clip (knees, soles).
//
//   node scripts/preview-video-motion.mjs take.motion.json --out out/take [--fps 30] [--camera side]
//
// CHROME_PATH may point at a Chrome or chrome-headless-shell binary.
const args=process.argv.slice(2),opt=(k,d)=>{const i=args.indexOf('--'+k);return i>=0?args[i+1]:d;};
const file=args.find((a,i)=>!a.startsWith('--')&&!['--out','--fps','--camera'].includes(args[i-1]));
if(!file){console.error('Нужен файл движений');process.exit(2);}
const out=path.resolve(opt('out','review/video-preview')),fps=+opt('fps',30),view=opt('camera','side');
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1280,height:760}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(pathToFileURL(path.join(root,'motion-lab.html')).href);
await page.waitForFunction(()=>window.motionLab&&'ready' in window.motionLab,null,{timeout:300000});
await page.evaluate(()=>window.motionLab.manual(true));
const text=await readFile(file,'utf8');
const before=(await page.evaluate(()=>window.motionLab.clips())).length;
await page.evaluate(([n,t])=>window.motionLab.add(n,t),[path.basename(file),text]);
await page.evaluate(i=>{window.motionLab.select(i);window.motionLab.set({t:0,share:1,inPlace:false});},before);
await page.evaluate(v=>window.motionLab.camera(v),view);
const clip=(await page.evaluate(()=>window.motionLab.clips())).at(-1);
const count=Math.round((clip.count-1)/(JSON.parse(text).clips[0].fps)*fps)+1;
let cycle=null;
for(let i=0;i<count;i++){
 const r=await page.evaluate(t=>window.motionLab.set({t}),i/fps);
 const bio=r.bio;cycle=cycle||{minFlex:180,maxFlex:0,minSole:9,backward:0};
 for(const s of ['L','R']){cycle.minFlex=Math.min(cycle.minFlex,bio[s].flex);cycle.maxFlex=Math.max(cycle.maxFlex,bio[s].flex);cycle.minSole=Math.min(cycle.minSole,bio[s].sole);if(bio[s].flex>8&&bio[s].forward<0)cycle.backward++;}
 const data=await page.evaluate(()=>window.motionLab.screenshot());
 await writeFile(path.join(out,`frame-${String(i).padStart(4,'0')}.png`),Buffer.from(data.split(',')[1],'base64'));
}
const checks=[
 {name:'колени 0–140°, назад не гнутся',ok:cycle.minFlex>=-1&&cycle.maxFlex<=140&&cycle.backward===0,detail:cycle},
 {name:'подошвы не уходят в доску глубже 1 см',ok:cycle.minSole>=-.01,detail:{minSole:cycle.minSole}},
 {name:'нет ошибок страницы',ok:errors.length===0,detail:errors.slice(0,5)}];
await writeFile(path.join(out,'checks.json'),JSON.stringify({clip,frames:count,fps,checks},null,1));
await browser.close();
for(const c of checks)console.log(c.ok?'✓':'✗',c.name,c.ok?'':JSON.stringify(c.detail));
console.log(`${count} кадров → ${out}`);
if(checks.some(c=>!c.ok))process.exit(1);
