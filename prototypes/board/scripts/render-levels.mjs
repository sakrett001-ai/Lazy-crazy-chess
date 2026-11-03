import {chromium} from '../../human-base/node_modules/playwright/index.mjs';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

// Skill levels side by side (src/strikes.mjs, «уровни рядом»): every frame of
// every strike's trio as PNG, one folder per strike and camera, plus
// levels.json with the levels' offsets, phases and where their heads stand on
// screen (for the labels of the videos).
//
//   node scripts/render-levels.mjs [--page tools/strikes/out/strike-lab.html] [--out tools/strikes/out/levels] [--fps 30] [--cameras three,side]
//
// CHROME_PATH may point at a Chrome or chrome-headless-shell binary.
const args=process.argv.slice(2),opt=(k,d)=>{const i=args.indexOf('--'+k);return i>=0?args[i+1]:d;};
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pageFile=path.resolve(opt('page',path.join(root,'tools/strikes/out/strike-lab.html')));
const out=path.resolve(opt('out',path.join(root,'tools/strikes/out/levels'))),fps=+opt('fps',30),cameras=opt('cameras','three,side').split(',');
const width=+opt('width',1280),height=+opt('height',720),only=opt('only');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width,height}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(pathToFileURL(pageFile).href);
await page.waitForFunction(()=>window.strikeLab&&'ready' in window.strikeLab,null,{timeout:300000});
if(!await page.evaluate(()=>window.strikeLab.ready))throw Error(await page.evaluate(()=>window.strikeLab.error));
await page.evaluate(()=>{window.strikeLab.manual(true);document.querySelector('#bar').hidden=true;document.querySelector('#lanes').hidden=true;});
const groups=await page.evaluate(()=>window.strikeLab.groups()),meta=[];
for(const g of groups){
 if(only&&g.id!==only)continue;
 await page.evaluate(i=>window.strikeLab.selectGroup(i),g.index);
 const count=Math.round(g.duration*fps)+1,entry={...g,fps,count,cameras:{}};
 for(const cam of cameras){
  await page.evaluate(v=>window.strikeLab.camera(v),cam);
  const dir=path.join(out,`${g.id}-${cam}`);await rm(dir,{recursive:true,force:true});await mkdir(dir,{recursive:true});
  let screen=null;
  for(let i=0;i<count;i++){
   const r=await page.evaluate(t=>window.strikeLab.set(t),Math.min(g.duration,i/fps));
   if(!screen)screen=r.levels.map(l=>l.screen);
   const data=await page.evaluate(()=>window.strikeLab.screenshot());
   await writeFile(path.join(dir,`frame-${String(i).padStart(4,'0')}.png`),Buffer.from(data.split(',')[1],'base64'));
  }
  entry.cameras[cam]={dir,screen};
  console.log(`${g.label}, ${cam}: ${count} кадров`);
 }
 meta.push(entry);
}
await writeFile(path.join(out,'levels.json'),JSON.stringify({width,height,errors,groups:meta},null,1));
await browser.close();
if(errors.length){console.log('Ошибки страницы:',errors.slice(0,5));process.exit(1);}
