import test from 'node:test';
import assert from 'node:assert/strict';
import {createGround,LIMITS} from '../src/ground.mjs';

// The relief must stay a field a fencer can stand and lunge on, for any
// seed the "Новый ландшафт" button may draw.
const SQUARE=2.6,HALF=4*SQUARE,SEEDS=Array.from({length:200},(_,i)=>i*4513+1);
const centres=[];for(let f=0;f<8;f++)for(let r=0;r<8;r++)centres.push({f,r,c:[(f-3.5)*SQUARE,(3.5-r)*SQUARE]});

test('ground is the same for the same seed and differs between seeds',()=>{
 const a=createGround({seed:7}),b=createGround({seed:7}),c=createGround({seed:8});
 assert.equal(a.height(1.3,-2.2),b.height(1.3,-2.2));
 assert.notEqual(a.height(1.3,-2.2),c.height(1.3,-2.2));
 assert.equal(a.height(0,0),0);
});

test('slopes under the feet stay within a few degrees',()=>{
 let worst=0;
 for(const seed of SEEDS.slice(0,40)){const g=createGround({seed,square:SQUARE}),e=.1;
  for(let x=-HALF;x<=HALF;x+=.2)for(let z=-HALF;z<=HALF;z+=.2)
   worst=Math.max(worst,Math.hypot(g.height(x+e,z)-g.height(x-e,z),g.height(x,z+e)-g.height(x,z-e))/(2*e));}
 assert.ok(worst<=LIMITS.slope,`наибольший уклон ${worst.toFixed(3)} м/м`);
});

test('neighbouring squares differ by a few centimetres, standing zones are nearly level',()=>{
 let neighbour=0,stand=0;
 for(const seed of SEEDS){const g=createGround({seed,square:SQUARE});
  for(const {f,r,c}of centres){const h=g.height(...c);
   for(const [df,dr]of [[1,0],[0,1],[1,1],[1,-1]]){if(f+df>7||r+dr>7||r+dr<0)continue;neighbour=Math.max(neighbour,Math.abs(g.height(c[0]+df*SQUARE,c[1]-dr*SQUARE)-h));}
   let lo=Infinity,hi=-Infinity;const R=LIMITS.standRadius;
   for(let a=0;a<12;a++)for(const k of [0,.5,1]){const v=g.height(c[0]+Math.cos(a/12*2*Math.PI)*R*k,c[1]+Math.sin(a/12*2*Math.PI)*R*k);lo=Math.min(lo,v);hi=Math.max(hi,v);}
   stand=Math.max(stand,hi-lo);}}
 assert.ok(neighbour<=LIMITS.neighbour,`соседние клетки: ${neighbour.toFixed(3)} м`);
 assert.ok(stand<=LIMITS.stand,`зона стойки: ${stand.toFixed(3)} м`);
});

test('the relief is visible: the field rises and falls by more than a hand',()=>{
 let smallest=Infinity;
 for(const seed of SEEDS.slice(0,40)){const g=createGround({seed,square:SQUARE}),hs=centres.map(({c})=>g.height(...c));smallest=Math.min(smallest,Math.max(...hs)-Math.min(...hs));}
 assert.ok(smallest>=.08,`наименьший перепад по доске ${smallest.toFixed(3)} м`);
});

test('normal points up and leans away from the rise',()=>{
 const g=createGround({seed:3,square:SQUARE});
 for(const [x,z]of [[0,0],[3,-4],[-7,6]]){const n=g.normal(x,z),e=.05,dx=g.height(x+e,z)-g.height(x-e,z);
  assert.ok(n[1]>.99);assert.ok(Math.abs(Math.hypot(...n)-1)<1e-9);if(Math.abs(dx)>1e-4)assert.equal(Math.sign(n[0]),-Math.sign(dx));}
});

test('cell names the square under a point as the board does',()=>{
 const g=createGround({square:SQUARE});
 assert.deepEqual(g.cell(-3.5*SQUARE,3.5*SQUARE),{file:0,rank:0,light:false,center:[-3.5*SQUARE,3.5*SQUARE]}); // a1 dark
 assert.equal(g.cell(-3.5*SQUARE,2.5*SQUARE).light,true); // a2 light
 assert.equal(g.cell(3.5*SQUARE,-3.5*SQUARE).light,false); // h8 dark
 assert.equal(g.cell(HALF+.1,0),null);
});
