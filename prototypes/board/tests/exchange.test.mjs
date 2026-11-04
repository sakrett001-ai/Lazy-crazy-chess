import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseMotionFile,prepareClip} from '../src/mocap/format.mjs';
import {exchangePairs,exchangeLayout,exchangeAt,exchangeArms,cyclePose,trunkLean,levelSpear,shieldAt,keyed,CROSSFADE,SHIELD_LIFT_MAX} from '../src/mocap/exchange.mjs';
import {createRetargeter} from '../src/mocap/retarget.mjs';
import {pawnRest} from './pawn-rest.mjs';

// The recorded exchange (motions/duel-516.motion.json, tools/duels/build.py)
// as the board plays it on two pawns standing on neighbouring squares.
const file=parseMotionFile(JSON.parse(readFileSync(new URL('../motions/duel-516.motion.json',import.meta.url))));
const clips=file.clips.map(c=>prepareClip(file,c)),pairs=exchangePairs(clips);
const k=createRetargeter(pawnRest()).leg/pairs.exchange.attack.leg,SQUARE=2.6;
const STRAIGHT=SQUARE,DIAGONAL=SQUARE*Math.SQRT2;

test('the file holds an endless exchange and a decisive cycle, each an attacker and a defender',()=>{
 for(const kind of ['exchange','decisive']){const p=pairs[kind];
  assert.ok(p,kind);assert.equal(p.attack.side,'attack');assert.equal(p.defend.side,'defend');
  assert.equal(p.attack.partner,p.defend.name);assert.equal(!!p.attack.decisive,kind==='decisive');
  assert.ok(p.attack.events.strike.reach>p.attack.events.strike.start,'the blow reaches after it starts');}
 assert.ok(pairs.exchange.attack.events.parry,'the plain exchange is answered');
 assert.ok(!pairs.decisive.attack.events.parry,'the decisive blow is not');
});

test('the recorded path of the pelvis is no faster than a step-lunge',()=>{
 for(const c of clips)for(let i=1;i<c.frames.length;i++){
  const a=c.frames[i-1].pelvis,b=c.frames[i].pelvis,v=Math.hypot(b[0]-a[0],b[2]-a[2])*c.fps/c.leg;
  assert.ok(v<=2.75,`${c.name} frame ${i}: ${v.toFixed(2)} legs/s`);}
});

test('on neighbouring squares the fighters come as close as the recording but never into each other',()=>{
 for(const d of [STRAIGHT,DIAGONAL]){const l=exchangeLayout(pairs.exchange,k,d);
  assert.ok(l.scale>0&&l.scale<=1,`scale ${l.scale}`);
  assert.ok(l.closest>=Math.min(l.recordedClosest,d)-1e-6,`closest ${l.closest} vs recorded ${l.recordedClosest}`);
  assert.ok(l.closest>=1.2,`pelvises ${l.closest.toFixed(2)} m apart at the closest`);}
 assert.ok(exchangeLayout(pairs.exchange,k,STRAIGHT).scale<exchangeLayout(pairs.exchange,k,DIAGONAL).scale,'the nearer squares shorten the approach more');
});

test('the shoulders turn over the hips no further than the spine twists',()=>{
 const yaw=(a,b)=>Math.atan2(-(b[2]-a[2]),b[0]-a[0])*180/Math.PI,wrap=a=>((a+540)%360)-180;
 for(const c of clips)for(const f of c.frames){const d=wrap(yaw(f.shoulderL,f.shoulderR)-yaw(f.hipL,f.hipR));
  assert.ok(Math.abs(d)<=51,`${c.name}: twist ${d.toFixed(0)}°`);}
});

test('a figure keeps to the line of the fight: no sideways drift',()=>{
 for(const c of clips)for(let t=0;t<=c.duration;t+=.1)assert.equal(cyclePose(c,t,k,1).offset.x,0);
});

test('lead attacks in even cycles and follow in odd ones; solo attacks every cycle',()=>{
 const p=pairs.exchange,L=Math.min(p.attack.duration,p.defend.duration)-CROSSFADE;
 for(let n=0;n<4;n++){const c=n*L+L/2,lead=exchangeAt(p,'lead',c,k,1),follow=exchangeAt(p,'follow',c,k,1);
  assert.equal(lead.side,n%2?'defend':'attack');assert.equal(follow.side,n%2?'attack':'defend');
  assert.equal(exchangeAt(p,'solo',c,k,1).side,'attack');}
});

test('the exchange runs on without a break where the cycles meet',()=>{
 const p=pairs.exchange,L=Math.min(p.attack.duration,p.defend.duration)-CROSSFADE,dt=1/120;
 for(const role of ['lead','follow'])for(let n=1;n<4;n++){
  const a=exchangeAt(p,role,n*L-dt,k,1),b=exchangeAt(p,role,n*L,k,1);
  assert.equal(a.cycle,n-1);assert.equal(b.cycle,n);
  assert.ok(Math.abs(a.offset.z-b.offset.z)<.02,`${role} cycle ${n}: offset ${a.offset.z} → ${b.offset.z}`);
  for(const j of ['pelvis','head','ankleL','ankleR','wristR'])
   assert.ok(Math.hypot(...a.points[j].map((x,i)=>x-b.points[j][i]))*k<.03,`${role} cycle ${n}: ${j} jumps`);}
});

test('the spear chambers with the recorded blow, is out at its reach and stops where asked',()=>{
 const c=pairs.exchange.attack,s=c.events.strike;
 assert.equal(exchangeArms(c,0).action,'Spear_Study');
 assert.equal(exchangeArms(c,s.reach,{stop:1.6}).time,1.6);
 assert.ok(exchangeArms(c,s.start).time<.5,'not yet out when the blow starts');
 assert.equal(exchangeArms(c,c.duration+1).time,4,'back in guard');
});

test('the defender is braced by the answer; on the decisive blow the shield is late',()=>{
 const d=pairs.exchange.defend,a=d.events.parry.at,s=d.events.strike;
 assert.equal(exchangeArms(d,a).action,'Shield_Brace');assert.equal(exchangeArms(d,a).time,1);
 const late=pairs.decisive.defend,r=late.events.strike.reach;
 assert.ok(exchangeArms(late,r).time<.55,'not braced when the decisive blow lands');
 assert.ok(exchangeArms(d,Math.min(a,s.reach)-.08).time>=.99);
});

test('keyed values ease between keys and hold at the ends',()=>{
 const keys=[[1,0],[2,10]];
 assert.equal(keyed(keys,0),0);assert.equal(keyed(keys,3),10);assert.equal(keyed(keys,1.5),5);
});

test('a lean into the blow is taken out of the levelled spear, not out of the guard',()=>{
 assert.equal(levelSpear({aim:1,thrust:1},0).aim,1);
 assert.ok(levelSpear({aim:1,thrust:1},.3).aim<1);
 assert.equal(levelSpear({aim:0,thrust:0},.3).aim,0,'the guard keeps its rise');
 const c=pairs.exchange.attack,s=c.events.strike,lean=trunkLean(cyclePose(c,s.reach,k,1).points,c.neutral);
 assert.ok(Math.abs(lean)<Math.PI/3,`recorded lean ${(lean*180/Math.PI).toFixed(0)}°`);
});

test('the shield is carried over the front knee within the arm, without chasing every step',()=>{
 for(const c of clips){let prev=null;
  for(let t=0;t<=c.duration;t+=1/30){const s=shieldAt(c,t,k);
   assert.ok(s.lift>=0&&s.lift<=SHIELD_LIFT_MAX+1e-9,`${c.name} ${t}: lift ${s.lift}`);
   if(prev)assert.ok(Math.abs(s.lift-prev.lift)<=SHIELD_LIFT_MAX/(.35*30)*1.05+1e-9,`${c.name} ${t.toFixed(2)}: lift jumps`);
   prev=s;}}
});

test('every bent knee bends forwards within the hip rotation, not sideways',()=>{
 const sub=(a,b)=>a.map((x,i)=>x-b[i]),dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],unit=a=>{const n=Math.hypot(...a);return a.map(x=>x/n);};
 for(const c of clips)c.frames.forEach((f,i)=>{const lat=sub(f.hipR,f.hipL);for(const s of ['L','R']){const H=f['hip'+s],K=f['knee'+s],A=f['ankle'+s],u=unit(sub(A,H)),fw=unit(cross(lat,u)),HK=sub(K,H),off=HK.map((x,j)=>x-u[j]*dot(HK,u)),KA=sub(A,K);
  const flex=Math.acos(Math.max(-1,Math.min(1,dot(HK,KA)/Math.hypot(...HK)/Math.hypot(...KA))))*180/Math.PI;
  if(flex>8)assert.ok(dot(off,fw)>0.5*Math.hypot(...off)-1e-3,`${c.name} frame ${i} knee ${s}: flex ${flex.toFixed(0)}°, bends ${(Math.acos(Math.max(-1,Math.min(1,dot(off,fw)/Math.hypot(...off))))*180/Math.PI).toFixed(0)}° off forwards`);}});
});
