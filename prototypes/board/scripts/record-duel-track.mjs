import {chromium} from '../../human-base/node_modules/playwright/index.mjs';
import {writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

// Records what the board shows in the «пешка берёт пешку» scene: world
// positions of both pawns' joints at 30 Hz, two fencing cycles and the
// capture. The smoothness check (scripts/smoothness.mjs) reads the track.
//   node scripts/record-duel-track.mjs [out.json]
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out=process.argv[2]||path.join(root,'review','duel-track.json');
const file=path.join(root,'motions/duel-516.motion.json'),text=await readFile(file,'utf8');
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:640,height:360}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(pathToFileURL(path.join(root,'board.html')).href);
await page.waitForFunction(()=>window.livingChess&&'ready' in window.livingChess,null,{timeout:300000});
await page.evaluate(()=>window.livingChess.manual(true));
await page.evaluate(()=>window.livingChess.load('capture'));
await page.evaluate(([name,text])=>{const L=window.livingChess;if(!L.motion.list().includes('duel516.exchange.attack'))L.motion.add(name,text);return L.motion.use({duel:0});},[path.basename(file),text]);
const V=await page.evaluate(()=>window.livingChess.state().pieces.find(p=>p.square==='d5').id),A='wp-e4';
export const JOINTS=['root','spine05','head','upperleg01.L','lowerleg01.L','foot.L','toe3-1.L','upperleg01.R','lowerleg01.R','foot.R','toe3-1.R','upperarm01.L','lowerarm01.L','wrist.L','upperarm01.R','lowerarm01.R','wrist.R'];
const grab=()=>page.evaluate(([ids,J])=>{const L=window.livingChess;return Object.fromEntries(ids.map(id=>[id,L.shown(id)?L.pointsWorld(id,J):null]));},[[A,V],JOINTS]);
const fence=[],take=[];
for(let i=0;i<Math.round(2*2.367*30);i++){fence.push(await grab());await page.evaluate(()=>window.livingChess.step(1/30,30,false));}
await page.evaluate(()=>window.livingChess.play('e4','d5'));
for(let i=0;i<600;i++){const busy=await page.evaluate(()=>window.livingChess.state().busy);if(!busy)break;const f=await grab();f.phase=await page.evaluate(()=>document.querySelector('#phase').textContent);take.push(f);await page.evaluate(()=>window.livingChess.step(1/30,30,false));}
await browser.close();
await writeFile(out,JSON.stringify({fps:30,ids:{attacker:A,defender:V},joints:JOINTS,fence,take,errors}));
console.log(JSON.stringify({out,fence:fence.length,take:take.length,errors}));
