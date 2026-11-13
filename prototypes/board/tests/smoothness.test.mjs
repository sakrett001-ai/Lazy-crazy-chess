import test from 'node:test';
import assert from 'node:assert/strict';
import {shake,zigzag,footwork} from '../src/mocap/smoothness.mjs';

// The measures of scripts/verify-smooth.mjs tell noise from motion and a
// step from a slide on paths whose answer is known.
const fps=30,T=90;
let seed=7;const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647-.5;};
const minJerk=u=>{u=Math.min(1,Math.max(0,u));return u*u*u*(10-15*u+6*u*u);};

test('a slow sway does not shake, the same sway with 1 cm noise does', ()=>{
 const sway=[...Array(T)].map((_,t)=>[.2*Math.sin(2*Math.PI*t/fps),1,0]);
 const noisy=sway.map(p=>[p[0]+.02*rnd(),p[1]+.02*rnd(),p[2]+.02*rnd()]);
 assert.ok(shake(sway)<1,`sway ${shake(sway)}`);
 assert.ok(shake(noisy)>4,`noisy ${shake(noisy)}`);
 assert.ok(zigzag(sway)<.1);
 assert.ok(zigzag(noisy)>.4);
 // A fast step turns its acceleration once: motion, not a zigzag.
 const step=[...Array(T)].map((_,t)=>[.5*minJerk((t-30)/9),.07,0]);
 assert.equal(zigzag(step),0);
});

test('a planted foot with two lifted steps stands, steps and does not slide', ()=>{
 const A=[];
 for(let t=0;t<T;t++){
  let x=0,y=.07;
  for(const [a,b,to] of [[20,29,.4],[60,69,.8]]){if(t>=b)x=to;else if(t>a){const u=(t-a)/(b-a);x=to-.4+.4*minJerk(u);y+=.05*Math.sin(Math.PI*u);}}
  A.push([x,y,0]);
 }
 const f=footwork(A,fps);
 assert.equal(f.steps.length,2);
 assert.equal(f.slides,0);
 assert.equal(f.micro,0);
 assert.ok(f.standing>.7);
});

test('a foot that drags over the floor slides; a lift in place is no step', ()=>{
 const drag=[...Array(T)].map((_,t)=>[t<30?0:t<50?(t-30)*.01:.2,.07,0]);
 assert.equal(footwork(drag,fps).slides,1);
 const lift=[...Array(T)].map((_,t)=>[t>40&&t<46?.004*(t-40):0,t>40&&t<46?.1:.07,0]);
 const f=footwork(lift,fps);
 assert.equal(f.micro,1);
 const creep=[...Array(T)].map((_,t)=>[t*.003,.07,0]);
 assert.ok(footwork(creep,fps).standing<.1,'a foot creeping 9 cm/s never stands');
});

test('a step that drags its foot over the floor at lift-off skids; a clean step does not',()=>{
 // A 40 cm step lifting 5 cm: clean, or lifting only after its first 6.5 cm
 // have gone over the floor.
 const step=drag=>[...Array(T)].map((_,t)=>{if(t<=30)return[0,.07,0];if(t>=50)return[.4,.07,0];
  const u=(t-30)/20,v=drag?Math.max(0,(u-.3)/.7):u;
  return[.4*minJerk(u),.07+.05*Math.sin(Math.PI*v),0];});
 const clean=footwork(step(false),fps),dragged=footwork(step(true),fps);
 assert.ok(clean.skid<.01,`чистый шаг: ${clean.skid.toFixed(3)} м`);
 assert.ok(dragged.skid>.05,`шаг со скольжением: ${dragged.skid.toFixed(3)} м`);
 assert.equal(clean.steps.length,1);assert.equal(clean.slides,0);
});
