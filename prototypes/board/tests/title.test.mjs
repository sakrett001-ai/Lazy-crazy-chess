import test from 'node:test';
import assert from 'node:assert/strict';
import {titleCamera,TITLE_VIEW,flight,INTRO_VIEW,FLIGHT_SECONDS,readArmy,recordGame,ARMY_START,readSettings,writeSettings,SETTINGS_START,needsEconomy,SLOW_FRAME} from '../src/title.mjs';

const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
const memory=()=>{const m=new Map();return{getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v))};};
const broken={getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}};

test('start window camera drifts smoothly and keeps the fencing pair in view',()=>{
 const step=1/60;let prev=titleCamera(0),worst=0;
 assert.deepEqual(prev.position.map(v=>+v.toFixed(9)),TITLE_VIEW.position.map(v=>+v.toFixed(9)));
 for(let t=step;t<=300;t+=step){
  const c=titleCamera(t);worst=Math.max(worst,dist(c.position,prev.position));
  // Above the figures' heads and never closer to the pair than at the start.
  assert.ok(c.position[1]>2,`camera too low at ${t.toFixed(2)} s`);
  assert.ok(dist(c.position,c.target)>6,`camera too close at ${t.toFixed(2)} s`);
  prev=c;
 }
 // A slow drift: well under a centimetre per frame at 60 frames a second.
 assert.ok(worst<.01,`camera jumps ${worst.toFixed(4)} m in a frame`);
});

test('flight to the home view starts and ends exactly and has no jumps',()=>{
 const home={position:[0,18.5,24.5],target:[0,.6,.8]};
 assert.deepEqual(flight(INTRO_VIEW,home,0),{position:[...INTRO_VIEW.position],target:[...INTRO_VIEW.target]});
 const end=flight(INTRO_VIEW,home,1);
 for(let i=0;i<3;i++){assert.ok(Math.abs(end.position[i]-home.position[i])<1e-9);assert.ok(Math.abs(end.target[i]-home.target[i])<1e-9);}
 const frames=Math.round(FLIGHT_SECONDS*60);let prev=flight(INTRO_VIEW,home,0),worst=0;
 for(let f=1;f<=frames;f++){
  const c=flight(INTRO_VIEW,home,f/frames);worst=Math.max(worst,dist(c.position,prev.position));
  // The camera rises at least as fast as it travels: never below the start height.
  assert.ok(c.position[1]>=INTRO_VIEW.position[1]-1e-9);
  prev=c;
 }
 assert.ok(worst<.6,`flight jumps ${worst.toFixed(3)} m in a frame`);
});

test('army summary counts finished games and the white fallen, and survives blocked storage',()=>{
 const s=memory();
 assert.deepEqual(readArmy(s),ARMY_START);
 recordGame(s,13);
 assert.deepEqual(readArmy(s),{...ARMY_START,games:1,fallen:3});
 recordGame(s,16);recordGame(s,-4);
 assert.deepEqual(readArmy(s),{...ARMY_START,games:3,fallen:19});
 s.setItem('living-chess.army','not json');
 assert.deepEqual(readArmy(s),ARMY_START);
 assert.deepEqual(readArmy(broken),ARMY_START);
 assert.deepEqual(recordGame(broken,15),{...ARMY_START,games:1,fallen:1});
 assert.deepEqual(readArmy(null),ARMY_START);
});

test('settings are kept between visits and fall back to the defaults',()=>{
 const s=memory();
 assert.deepEqual(readSettings(s),SETTINGS_START);
 writeSettings(s,{graphics:'economy',slow:true});
 assert.deepEqual(readSettings(s),{graphics:'economy',slow:true});
 writeSettings(broken,{graphics:'full',slow:false});
 assert.deepEqual(readSettings(broken),SETTINGS_START);
});

test('auto graphics waits for enough frames and goes by the median',()=>{
 assert.equal(needsEconomy(Array(29).fill(.1)),null);
 assert.equal(needsEconomy(Array(30).fill(1/60)),false);
 assert.equal(needsEconomy(Array(30).fill(1/20)),true);
 // A few hitches in a smooth run do not switch the economy mode on.
 assert.equal(needsEconomy([...Array(25).fill(1/60),...Array(5).fill(.2)]),false);
 assert.equal(needsEconomy(Array(30).fill(SLOW_FRAME)),false);
 // A very slow machine is not kept waiting for thirty frames.
 assert.equal(needsEconomy(Array(4).fill(1)),null);
 assert.equal(needsEconomy(Array(16).fill(.2)),true);
});
