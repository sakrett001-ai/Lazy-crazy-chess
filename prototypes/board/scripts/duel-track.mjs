import {chromium} from '../../human-base/node_modules/playwright/index.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

// The duel of two pawns as it is played on the board, written as a
// duel.track (Lazy-skills-lab, skills/strike-principles/references/format.md)
// for the pair coherence check (pair_check.py): both bodies, both spears,
// both shields as plates, at 30 Hz with a fixed clock.
//  review/duel-fence.track.json — e4 and d5 fence, no winner (mode loop);
//  review/duel-take.track.json  — e4 takes d5 (mode decisive).
//   node scripts/duel-track.mjs [--board board.html] [--out review]
//   python3 <Lazy-skills-lab>/skills/strike-principles/scripts/pair_check.py review/duel-fence.track.json
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg=(k,d)=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:d;};
const out=path.resolve(root,arg('--out','review'));await mkdir(out,{recursive:true});
const boardFile=path.resolve(root,arg('--board','board.html'));
const file=path.join(root,'motions/duel-516.motion.json'),text=await readFile(file,'utf8');
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:640,height:360}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(pathToFileURL(boardFile).href);
await page.waitForFunction(()=>window.livingChess&&'ready' in window.livingChess,null,{timeout:300000});
await page.evaluate(()=>window.livingChess.manual(true));
await page.evaluate(()=>window.livingChess.load('capture'));
await page.evaluate(([name,text])=>{const L=window.livingChess;if(!L.motion.list().includes('duel516.exchange.attack'))L.motion.add(name,text);return L.motion.use({duel:0});},[path.basename(file),text]);
const A='wp-e4',V=await page.evaluate(()=>window.livingChess.state().pieces.find(p=>p.square==='d5').id);

const JOINTS={pelvis:'root',chest:'spine03',neck:'neck01',head:'head',shoulderL:'upperarm01.L',shoulderR:'upperarm01.R',elbowL:'lowerarm01.L',elbowR:'lowerarm01.R',
 wristL:'wrist.L',wristR:'wrist.R',hipL:'upperleg01.L',hipR:'upperleg01.R',kneeL:'lowerleg01.L',kneeR:'lowerleg01.R',ankleL:'foot.L',ankleR:'foot.R',toeL:'toe3-1.L',toeR:'toe3-1.R'};
const frame=()=>page.evaluate(([ids,J])=>{const L=window.livingChess,r=x=>+x.toFixed(4),out={};
 for(const id of ids){const shown=!!L.points(id,['root'])&&L.shown(id);if(!shown){out[id]=null;continue;}
  const P=L.pointsWorld(id,Object.values(J)),g=L.grip(id),tip=L.tip(id),k=1.004/1.566;
  const butt=g&&tip?g.map((x,i)=>x-(tip[i]-x)*k):null;
  out[id]={joints:Object.fromEntries(Object.entries(J).map(([n,b])=>[n,P[b]?.map(r)])),grip:g?.map(r),tip:tip?.map(r),butt:butt?.map(r),shield:L.shieldPlane(id),info:L.duelInfo(id)};}
 // How far the spear's tip is from the other's shield along the spear
 // (ray cast on the posed mesh; negative: the tip is past its surface),
 // and whether the shaft crosses that shield.
 for(const [id,other] of [[ids[0],ids[1]],[ids[1],ids[0]]]){const o=out[id];if(!o||!o.tip||!o.grip||!out[other])continue;
  const d=o.tip.map((x,i)=>x-o.grip[i]),len=Math.hypot(...d),u=d.map(x=>x/len),far=o.tip.map((x,i)=>x+u[i]*1.5);
  const h=L.shieldHit(other,o.grip,far);o.shieldGap=h==null?null:r(h-len);o.shaftCross=L.shieldHit(other,o.butt,o.tip)!=null;}
 return out;},[[A,V],JOINTS]);

function track(frames,mode,label){
 const fighters={};
 for(const [id,name] of [[A,'A'],[V,'B']]){
  const shownAt=frames.map(f=>!!f[id]);
  const last=i=>{for(let j=i;j>=0;j--)if(frames[j][id])return frames[j][id];return frames.find(f=>f[id])[id];};
  const all=frames.map((_,i)=>last(i));
  fighters[name]={id,kit:'spear_shield',label:id===A?'пешка e4':'пешка d5',
   joints:Object.fromEntries(Object.keys(JOINTS).map(n=>[n,all.map(f=>f.joints[n])])),
   weapon:{kind:'spear',grip:all.map(f=>f.grip),tip:all.map(f=>f.tip),butt:all.map(f=>f.butt),shieldGap:all.map(f=>f.shieldGap??null),shaftCross:all.map(f=>!!f.shaftCross)},
   shield:{center:all.map(f=>f.shield?.center),normal:all.map(f=>f.shield?.normal),u:all.map(f=>f.shield?.u),v:all.map(f=>f.shield?.v),half:all.map(f=>f.shield?.half)},
   shown:shownAt,
   declared:all.map(f=>f.info?{side:f.info.side,cycle:f.info.cycle,local:f.info.local}:null)};
 }
 return{format:'duel.track',version:1,fps:30,mode,label,source:'Lazy-crazy-chess, доска: обмен с записи 516 (motions/duel-516.motion.json), снято scripts/duel-track.mjs',
  axes:{units:'m',y:'up, board at 0'},fighters};
}

// 1. Fencing: two full cycles of 2,367 s, from half a second before a cycle
// starts (the defender's answer to the first thrust begins before it).
const cycle=2.667-.3,lead=.5,clock0=await page.evaluate(()=>window.livingChess.state().clock);
await page.evaluate(s=>window.livingChess.step(s,30,false),Math.ceil((clock0+lead)/cycle)*cycle-lead-clock0);
const fence=[];for(let i=0;i<=Math.round((2*cycle+lead)*30)+6;i++){fence.push(await frame());await page.evaluate(()=>window.livingChess.step(1/30,30,false));}
await writeFile(path.join(out,'duel-fence.track.json'),JSON.stringify(track(fence,'loop','Обмен пешек e4 и d5 без победителя (доска)')));
// 2. The capture.
await page.evaluate(()=>window.livingChess.play('e4','d5'));
const take=[];for(let i=0;i<600;i++){const busy=await page.evaluate(()=>window.livingChess.state().busy);if(!busy)break;take.push(await frame());await page.evaluate(()=>window.livingChess.step(1/30,30,false));}
await writeFile(path.join(out,'duel-take.track.json'),JSON.stringify(track(take,'decisive','e4 берёт d5: схватка, которую d5 проигрывает (доска)')));
await browser.close();
console.log(JSON.stringify({fence:fence.length,take:take.length,errors}));
process.exit(errors.length?1:0);
