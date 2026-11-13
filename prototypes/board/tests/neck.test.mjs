import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {qMul,qConj,qRotate} from '../src/mocap/math.mjs';
import {parseMotionFile,prepareClip,turnHead} from '../src/mocap/format.mjs';
import {createRetargeter,PAWN} from '../src/mocap/retarget.mjs';
import {NECK,neckAngles,fromNeckAngles,limitNeck,leadWithChest,TWIST,createNeckFollower,NECK_SPEED,NECK_ACCEL,GAP} from '../src/mocap/neck.mjs';
import {shake,LIMITS} from '../src/mocap/smoothness.mjs';

import {pawnRest} from './pawn-rest.mjs';

// The head on its neck (src/mocap/neck.mjs): in every frame of every
// recorded motion, with or without the board's own turn onto the opponent,
// the head stays within the neck's range against the chest (AMA Guides 5th
// ed. 2000: rotation 80°, flexion 50°, extension 60°, lateral bend 45°), and
// it moves on the neck as smoothly as the pelvis has to move on the board
// (scripts/verify-smooth.mjs): a head that tracking flipped round from
// frame to frame shook a point in front of the face by 18 mm.
const rest=pawnRest(),rt=createRetargeter(rest),top=PAWN.spine.at(-1),EPS=.05;
const dir=fileURLToPath(new URL('../motions/',import.meta.url));
const files=readdirSync(dir).filter(f=>f.endsWith('.motion.json'));
// Head against chest, both as turned from the figure's rest.
const onNeck=p=>qMul(qConj(qMul(p.world[top],qConj(rest.quat[top]))),qMul(p.world[PAWN.head],qConj(rest.quat[PAWN.head])));
const within=(a,where)=>{
 assert.ok(Math.abs(a.yaw)<=NECK.yaw+EPS,`${where}: поворот ${a.yaw.toFixed(1)}°`);
 assert.ok(a.pitch<=NECK.flexion+EPS,`${where}: наклон вперёд ${a.pitch.toFixed(1)}°`);
 assert.ok(-a.pitch<=NECK.extension+EPS,`${where}: наклон назад ${(-a.pitch).toFixed(1)}°`);
 assert.ok(Math.abs(a.roll)<=NECK.roll+EPS,`${where}: наклон вбок ${a.roll.toFixed(1)}°`);
};

test('the neck limit leaves an easy turn alone and holds a wrong one at the range',()=>{
 const easy=fromNeckAngles({yaw:30,pitch:10,roll:-5});
 assert.deepEqual(limitNeck(easy),easy);
 for(const a of [{yaw:171,pitch:0,roll:0},{yaw:-140,pitch:-35,roll:44},{yaw:0,pitch:-90,roll:0},{yaw:20,pitch:70,roll:-60}]){
  const b=neckAngles(limitNeck(fromNeckAngles(a)));
  within(b,JSON.stringify(a));
  assert.ok(Math.sign(b.yaw)===Math.sign(a.yaw)||!a.yaw,'поворот в ту же сторону');
 }
});

for(const f of files){
 const file=parseMotionFile(JSON.parse(readFileSync(dir+f,'utf8')));
 for(const c of file.clips){const clip=prepareClip(file,c);
  test(`${c.name}: the head stays on its neck and moves smoothly`,()=>{
   // The board turns the head onto the opponent on top of the recording.
   for(const turn of [0,Math.PI/2,-Math.PI/2,Math.PI*.95]){
    const face=[];
    clip.frames.forEach((src,i)=>{const X=onNeck(rt.pose(turnHead(src,turn),clip));
     within(neckAngles(X),`${c.name}, кадр ${i}, поворот доски ${Math.round(turn*180/Math.PI)}°`);
     face.push(qRotate(X,[0,0,.1]));});
    if(!turn)assert.ok(shake(face)<=LIMITS.rootShake,`${c.name}: голова дрожит на шее, ${shake(face).toFixed(1)} мм`);
   }
  });
 }
}

// The head through time (neck.mjs, createNeckFollower): a head the
// recording flips round is followed no faster than a person turns the
// head at most (Röijezon et al. 2010: 348°/s), with the speed changing
// smoothly, and a head that moves within those limits is followed exactly.
const angleDeg=(a,b)=>2*Math.acos(Math.min(1,Math.abs(a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3])))*180/Math.PI;
test('the head turns on the neck at the neck\'s pace and follows an easy turn exactly',()=>{
 const f=createNeckFollower(),dt=1/30,from=fromNeckAngles({yaw:-50,pitch:0,roll:0}),to=fromNeckAngles({yaw:50,pitch:10,roll:0});
 let q=f.step(from,0),v=0,t=0,frames=0;
 assert.deepEqual(q,from,'первый кадр — как есть');
 while(angleDeg(q,to)>.5&&frames<60){t+=dt;frames++;const n=f.step(to,t),s=angleDeg(q,n)/dt;
  assert.ok(s<=NECK_SPEED+1,`кадр ${frames}: ${s.toFixed(0)}°/с`);
  assert.ok(Math.abs(s-v)/dt<=NECK_ACCEL*1.05+1,`кадр ${frames}: разгон ${((s-v)/dt).toFixed(0)}°/с²`);
  v=s;q=n;}
 assert.ok(frames<30,`голова дошла за ${frames} кадров`);
 // A slow sway, 40° each way at 0.5 Hz (≤126°/s): no lag once the head has
 // picked up the sway's speed from rest.
 const g=createNeckFollower();
 for(let i=0;i<90;i++){const want=fromNeckAngles({yaw:40*Math.sin(Math.PI*i*dt),pitch:0,roll:0}),got=g.step(want,i*dt);
  if(i>8)assert.ok(angleDeg(got,want)<1.5,`кадр ${i}: отстаёт на ${angleDeg(got,want).toFixed(1)}°`);}
 // The same frame posed twice gives the same head; a pause starts it over.
 const h=createNeckFollower();h.step(from,0);const a=h.step(to,dt),b=h.step(to,dt);
 assert.ok(angleDeg(a,b)<1e-6,'второй вызов в том же кадре');
 assert.deepEqual(h.step(from,dt+GAP+.01),from,'после паузы — как есть');
});

test('shoulders swung away from the eyes come back to the trunk\'s twist',()=>{
 // Pelvis on the line, chest twisted 67° to the left, head held 68° to the right of the chest.
 const dP=[0,0,0,1],dC=fromNeckAngles({yaw:67,pitch:0,roll:0}),dH=fromNeckAngles({yaw:-1,pitch:0,roll:0});
 const c=leadWithChest(dP,dC,dH),twist=neckAngles(c).yaw,neck=neckAngles(qMul(qConj(c),dH)).yaw;
 assert.ok(Math.abs(twist-TWIST)<.5,`грудь повернута на ${twist.toFixed(1)}°`);
 assert.ok(Math.abs(neck)<=TWIST+2,`голова на шее ${neck.toFixed(1)}°`);
 // Twisted towards the eyes, a recorded wind-up stays.
 const wind=fromNeckAngles({yaw:60,pitch:0,roll:0}),look=fromNeckAngles({yaw:90,pitch:0,roll:0});
 assert.ok(Math.abs(neckAngles(leadWithChest(dP,wind,look)).yaw-60)<.5,'замах к взгляду не трогаем');
});
