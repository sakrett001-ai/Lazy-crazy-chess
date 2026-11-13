import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {qMul,qConj,qRotate} from '../src/mocap/math.mjs';
import {parseMotionFile,prepareClip,turnHead} from '../src/mocap/format.mjs';
import {createRetargeter,PAWN} from '../src/mocap/retarget.mjs';
import {NECK,neckAngles,fromNeckAngles,limitNeck} from '../src/mocap/neck.mjs';
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
