import {chromium} from '../../human-base/node_modules/playwright/index.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

// Browser acceptance of the recorded exchange (motions/duel-516.motion.json,
// tools/duels/build.py) on the real skinned pawns, in the «пешка берёт
// пешку» position: e4 and d5 stand diagonally next to each other.
//  1. Before the move they fence: blows and answers with no winner, the
//     roles swapping every cycle. Nobody's spear goes into a body or through
//     a shield, nobody walks into the other.
//  2. e4 takes d5: one cycle more, then the decisive blow lands in the
//     defender's body, the defender falls and leaves, e4 steps onto d5.
//   node scripts/verify-duel.mjs [--frames]
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const review=path.join(root,'review');await mkdir(review,{recursive:true});
const keepFrames=process.argv.includes('--frames'),framesDir=path.join(review,'duel-frames');
if(keepFrames)await mkdir(framesDir,{recursive:true});
const file=path.join(root,'motions/duel-516.motion.json'),text=await readFile(file,'utf8');
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1280,height:720}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
await page.goto(pathToFileURL(path.join(root,'board.html')).href);
await page.waitForFunction(()=>window.livingChess&&'ready' in window.livingChess,null,{timeout:300000});
const failures=[],checks=[];
const check=(name,ok,detail)=>{checks.push({name,ok:!!ok,detail});if(!ok)failures.push(name);};
const png=async()=>{await page.evaluate(()=>window.livingChess.render());return Buffer.from((await page.evaluate(()=>window.livingChess.screenshot())).split(',')[1],'base64');};
check('page loads with WebGL',await page.evaluate(()=>window.livingChess.ready),null);
await page.evaluate(()=>window.livingChess.manual(true));
await page.evaluate(()=>window.livingChess.load('capture'));
const used=await page.evaluate(([name,text])=>{const L=window.livingChess;if(!L.motion.list().includes('duel516.exchange.attack'))L.motion.add(name,text);return L.motion.use({duel:0});},[path.basename(file),text]);
check('the board takes the recorded exchange and the decisive blow',used.duel?.exchange==='duel516.exchange.attack'&&used.duel?.decisive==='duel516.decisive.attack',used);
const victimId=await page.evaluate(()=>window.livingChess.state().pieces.find(p=>p.square==='d5').id),A='wp-e4';
await page.evaluate(()=>window.livingChess.camera([3.4,1.7,-2.6],[-.4,.95,-.3]));

// One frame of measures: bone chains of both, both spears (butt to tip),
// crossings of either shield, the spear's nearest approach to the other's
// trunk axis, both pelvises. A piece taken off the board (hidden) is not measured.
const measure=t=>page.evaluate(([t,A,V])=>{const L=window.livingChess,ids=[A,V].filter(id=>L.points(id,['root'])&&L.shown(id)),touch=[];
 const chains={legL:['upperleg01.L','lowerleg01.L','foot.L','toe3-1.L'],legR:['upperleg01.R','lowerleg01.R','foot.R','toe3-1.R'],trunk:['root','spine03','spine05','neck01','head'],armL:['upperarm01.L','lowerarm01.L','wrist.L'],armR:['upperarm01.R','lowerarm01.R','wrist.R']};
 const spear=id=>{const g=L.grip(id),p=L.tip(id);if(!g||!p)return null;const d=p.map((x,i)=>x-g[i]),k=1.004/1.566;return[g.map((x,i)=>x-d[i]*k),p];};
 const out={t,ids,spear:{},trunk:{},root:{},body:{},touch};
 for(const id of ids){const P=L.pointsWorld(id,Object.values(chains).flat());out.trunk[id]=chains.trunk.map(n=>P[n]);out.root[id]=P.root;out.spear[id]=spear(id);out.body[id]=L.biomech(id);
  for(const owner of ids)for(const [name,chain] of Object.entries(chains)){if(id===owner&&name==='armL')continue;
   for(let i=0;i<chain.length-1;i++)if(L.shieldHit(owner,P[chain[i]],P[chain[i+1]])!==null)touch.push(`${owner===id?'own':'opponent'} shield × ${id===A?'e4':'d5'} ${name}`);}
  const s=out.spear[id];if(s)for(const owner of ids)if(L.shieldHit(owner,s[0],s[1])!==null)touch.push(`${id===A?'e4':'d5'} spear × ${owner===id?'own':'opponent'} shield`);}
 return out;},[t,A,victimId]);
const seg=(p,q,a,b)=>{const d1=q.map((x,i)=>x-p[i]),d2=b.map((x,i)=>x-a[i]),r=p.map((x,i)=>x-a[i]),dt=(u,v)=>u[0]*v[0]+u[1]*v[1]+u[2]*v[2];
 const P=dt(d1,d1),E=dt(d2,d2),F=dt(d2,r),C=dt(d1,r),B=dt(d1,d2),den=P*E-B*B;let s=den>1e-9?Math.min(1,Math.max(0,(B*F-C*E)/den)):0,t=(B*s+F)/E;
 if(t<0){t=0;s=Math.min(1,Math.max(0,-C/P));}else if(t>1){t=1;s=Math.min(1,Math.max(0,(B-C)/P));}
 return Math.hypot(...p.map((x,i)=>x+d1[i]*s-a[i]-d2[i]*t));};
// The spear's nearest approach to the other figure's trunk axis (root…head).
const axisGap=(f,by,at)=>{const s=f.spear[by],k=f.trunk[at];if(!s||!k)return Infinity;let m=Infinity;for(let i=0;i<k.length-1;i++)m=Math.min(m,seg(s[0],s[1],k[i],k[i+1]));return m;};
const flat=(a,b)=>Math.hypot(a[0]-b[0],a[2]-b[2]);
const images={};

// 1. Fencing before the move: two full cycles and a bit.
const fence=[],clock0=await page.evaluate(()=>window.livingChess.state().clock);
for(let i=0;i<=Math.round((Math.ceil(clock0/2.367)*2.367-clock0+2*2.367)*30)+3;i++){const t=+(i/30).toFixed(3);fence.push(await measure(t));
 if(keepFrames)await writeFile(path.join(framesDir,`fence${String(i).padStart(4,'0')}.png`),await png());
 if(i===22||i===93){const n=`duel-fence-${i===22?1:2}.png`;images[n]=t;await writeFile(path.join(review,n),await png());}
 await page.evaluate(()=>window.livingChess.step(1/30,30,false));}
const TRUNK=.17; // m, a trunk's half depth: nearer than this a spear is inside the body
const fenceGap=Math.min(...fence.map(f=>Math.min(axisGap(f,A,victimId),axisGap(f,victimId,A))));
check('fencing: neither spear goes into the other body (spear ≥ 17 cm from the trunk axis)',fenceGap>=TRUNK,{closestM:+fenceGap.toFixed(3)});
const fenceTouch=fence.filter(f=>f.touch.length).map(f=>({t:f.t,touch:f.touch}));
check('fencing: no body or spear passes through a shield',fenceTouch.length===0,fenceTouch.slice(0,6));
const close=Math.min(...fence.map(f=>flat(f.root[A],f.root[victimId])));
check('fencing: the two never walk into each other (pelvises ≥ 1.2 m apart)',close>=1.2,{closestM:+close.toFixed(2)});
// Who thrusts: the spear tip's reach towards the other, per cycle.
const reachOf=(f,by,at)=>{const s=f.spear[by];if(!s)return 0;const r=f.root[by],o=f.root[at],d=[o[0]-r[0],o[2]-r[2]],n=Math.hypot(...d);return((s[1][0]-r[0])*d[0]+(s[1][2]-r[2])*d[1])/n;};
const cycle=2.667-.3,first=Math.ceil(clock0/cycle),inCycle=(f,n)=>clock0+f.t>=(first+n)*cycle&&clock0+f.t<(first+n+1)*cycle;
const peaks=[0,1].map(n=>({e4:Math.max(...fence.filter(f=>inCycle(f,n)).map(f=>reachOf(f,A,victimId))),d5:Math.max(...fence.filter(f=>inCycle(f,n)).map(f=>reachOf(f,victimId,A)))}));
check('fencing: the attacker changes each cycle (the one thrusting reaches ≥ 40 cm further)',(peaks[0].e4-peaks[0].d5>.4&&peaks[1].d5-peaks[1].e4>.4)||(peaks[0].d5-peaks[0].e4>.4&&peaks[1].e4-peaks[1].d5>.4),peaks.map(p=>({e4:+p.e4.toFixed(2),d5:+p.d5.toFixed(2)})));
const fenceBodies=fence.flatMap(f=>Object.values(f.body)).filter(Boolean),fenceKnees=fenceBodies.flatMap(b=>[b.L,b.R]);
const kneeBad=k=>!(k.flex>=-1&&k.flex<=140&&(k.flex<8||k.forward>0));
const offenders=(frames,ids)=>frames.flatMap(f=>ids(f).flatMap(id=>{const b=f.body[id];if(!b)return[];return['L','R'].filter(s=>kneeBad(b[s])||b[s].sole<.054).map(s=>({t:f.t,who:id===A?'e4':'d5',side:s,flex:+b[s].flex.toFixed(1),forward:b[s].forward,sole:+b[s].sole.toFixed(3)}));}));
check('fencing: knees within 0–140° and bent forwards',fenceKnees.every(k=>!kneeBad(k)),{maxFlexDeg:+Math.max(...fenceKnees.map(k=>k.flex)).toFixed(1),first:offenders(fence,f=>Object.keys(f.body)).filter(o=>o.flex>=8||o.flex<-1).slice(0,4)});
check('fencing: soles do not sink into the board',Math.min(...fenceBodies.flatMap(b=>[b.L.sole,b.R.sole]))>=.054,{minM:+Math.min(...fenceBodies.flatMap(b=>[b.L.sole,b.R.sole])).toFixed(3),first:offenders(fence,f=>Object.keys(f.body)).filter(o=>o.sole<.054).slice(0,4)});
// A jump is the figure moving faster than a fighter can: 10 cm in a frame is
// 3 m/s, above the step-lunge the recording is limited to (tools/duels/build.py).
const jumpsF=fence.slice(1).flatMap((f,i)=>[A,victimId].map(id=>flat(f.root[id],fence[i].root[id])));
check("fencing: no jumps (pelvis < 10 cm per frame)",Math.max(...jumpsF)<.1,+Math.max(...jumpsF).toFixed(3));

// 2. e4 takes d5.
const played=await page.evaluate(()=>window.livingChess.play('e4','d5'));
check('e4 takes d5 is accepted by the rules',played,played);
const scene=await page.evaluate(()=>{const L=window.livingChess;return{busy:L.state().busy};});
const cap=[];let hitAt=null;
for(let i=0;;i++){const t=+(i/30).toFixed(3),state=await page.evaluate(()=>{const s=window.livingChess.state();return{busy:s.busy,phase:document.querySelector('#phase').textContent};});
 if(!state.busy)break;const f=await measure(t);f.phase=state.phase;cap.push(f);
 if(keepFrames)await writeFile(path.join(framesDir,`take${String(i).padStart(4,'0')}.png`),await png());
 const prev=cap.at(-2)?.phase;if(prev!==undefined&&prev!==f.phase){const n=`duel-take-${cap.length}.png`;images[n]=`${t} s, ${f.phase}`;await writeFile(path.join(review,n),await png());}
 if(f.phase==='защитник проиграл схватку'&&hitAt===null)hitAt=cap.length-1;
 await page.evaluate(()=>window.livingChess.step(1/30,30,false));if(i>600)break;}
check('the capture ends (under 20 s)',cap.length>0&&cap.length<600,{frames:cap.length});
const hit=cap[hitAt],hitGap=hit?axisGap(hit,A,victimId):Infinity;
check('the decisive blow lands: the spear reaches the defender body (≤ 25 cm from its trunk axis)',hitGap<=.25,{atHitM:+hitGap.toFixed(3),time:hit?.t});
check('the blow does not run the spear through (≥ 5 cm from the trunk axis)',hitGap>=.05,{atHitM:+hitGap.toFixed(3)});
const before=cap.slice(0,hitAt??0),beforeGap=Math.min(...before.map(f=>axisGap(f,victimId,A)));
check('before the decisive blow the defender attacks and does not wound (its spear ≥ 17 cm from the attacker body)',beforeGap>=TRUNK,{closestM:+beforeGap.toFixed(3)});
const capTouch=cap.filter(f=>f.touch.length).map(f=>({t:f.t,touch:f.touch}));
check('capture: no body or spear passes through a shield',capTouch.length===0,capTouch.slice(0,6));
const jumpsC=cap.slice(1).map((f,i)=>flat(f.root[A],cap[i].root[A]));
check("capture: the attacker moves without jumps (< 10 cm per frame)",Math.max(...jumpsC)<.1,+Math.max(...jumpsC).toFixed(3));
const standing=cap.flatMap(f=>[f.body[A],...(f.t<=(hit?.t??0)?[f.body[victimId]]:[])]).filter(Boolean),capKnees=standing.flatMap(b=>[b.L,b.R]);
const capIds=f=>[A,...(f.t<=(hit?.t??0)?[victimId]:[])].filter(id=>f.body[id]);
check('capture: knees within 0–140° and bent forwards',capKnees.every(k=>!kneeBad(k)),{maxFlexDeg:+Math.max(...capKnees.map(k=>k.flex)).toFixed(1),first:offenders(cap,capIds).filter(o=>o.flex>=8||o.flex<-1).slice(0,4)});
check('capture: soles do not sink into the board',Math.min(...standing.flatMap(b=>[b.L.sole,b.R.sole]))>=.054,{minM:+Math.min(...standing.flatMap(b=>[b.L.sole,b.R.sole])).toFixed(3),first:offenders(cap,capIds).filter(o=>o.sole<.054).slice(0,4)});
const fell=cap.filter(f=>f.body[victimId]).reduce((m,f)=>Math.max(m,f.body[victimId].fall||0),0);
check('the defender falls',fell>1,{fall:+fell.toFixed(2)});
const state=await page.evaluate(()=>window.livingChess.state());
check('after the scene the attacker stands on d5 and the defender is gone',state.actors===3&&state.pieces.find(p=>p.square==='d5')?.id===A&&!state.busy,state.fen);
const endRoot=cap.at(-1).root[A];
check('the attacker ends on the middle of d5 (≤ 10 cm)',Math.hypot(endRoot[0]+1.3,endRoot[2]+1.3)<=.1,{x:+endRoot[0].toFixed(2),z:+endRoot[2].toFixed(2)});
check('no page errors',errors.length===0,errors.slice(0,5));
await browser.close();
const report={status:failures.length?'failed':'passed',failures,checks,images,
 scope:'Sampled at 30 Hz with a fixed clock on the skinned pawns. Bodies from the recorded exchange (ролик 516); arms, spear and shield from the loadout timed to the recorded blows. Not a physics or continuous collision check.'};
await writeFile(path.join(review,'duel-checks.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,failures,checks:checks.map(c=>[c.ok?'ok':'FAIL',c.name,c.detail])},null,1));
process.exit(failures.length?1:0);
