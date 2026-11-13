import {chromium} from '../../human-base/node_modules/playwright/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

// Views of the field for review: the whole board, a low view along the
// ranks, and close-ups of a fencing pair's feet on the ground.
// node scripts/preview-ground.mjs [--seed N] [--out dir]
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg=(k,d)=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:d;};
const seed=+arg('--seed',7),out=path.resolve(arg('--out',path.join(root,'review')));await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1280,height:800}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
await page.goto(pathToFileURL(path.join(root,'board.html')).href+'?seed='+seed);
await page.waitForFunction(()=>window.livingChess&&'ready' in window.livingChess,null,{timeout:300000});
await page.evaluate(()=>window.livingChess.manual(true));
const shot=async name=>{const data=await page.evaluate(()=>window.livingChess.screenshot());const f=path.join(out,`ground-${name}.png`);await writeFile(f,Buffer.from(data.split(',')[1],'base64'));console.log(f);};
const views=(arg('--views','home,low,feet')).split(',');
await page.evaluate(()=>window.livingChess.step(.5));
if(views.includes('home')){await page.evaluate(()=>{window.livingChess.home();});await shot('home');}
if(views.includes('low')){await page.evaluate(()=>window.livingChess.camera([-13,2.2,15],[2,0,-3]));await shot('low');}
if(views.includes('clash')||views.includes('feet')){
 await page.click('[data-preset="clash"]').catch(()=>{});await page.evaluate(()=>window.livingChess.step(1.5));
 if(views.includes('clash')){await page.evaluate(()=>window.livingChess.home());await shot('clash');}
 if(views.includes('feet')){await page.evaluate(()=>window.livingChess.camera([3.2,1.1,4.4],[0,.35,1.3]));await shot('feet');}
}
console.log(JSON.stringify({seed,errors}));
await browser.close();
