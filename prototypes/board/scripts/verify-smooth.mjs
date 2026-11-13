import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {measure,LIMITS} from '../src/mocap/smoothness.mjs';

// Smoothness of the «пешка берёт пешку» scene (src/mocap/smoothness.mjs):
// no trembling joints, feet that stand or step and never creep or shuffle.
// Records the scene first (scripts/record-duel-track.mjs), or reads a track.
//   node scripts/verify-smooth.mjs [track.json]
// The limits (LIMITS in src/mocap/smoothness.mjs) sit between the PR #9 board (fails each one) and the fix with
// planted feet, held on the board (src/mocap/footlock.mjs).
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let file=process.argv[2];
if(!file){file=path.join(root,'review','duel-track.json');execFileSync(process.execPath,[path.join(root,'scripts','record-duel-track.mjs'),file],{stdio:'inherit'});}
const d=JSON.parse(await readFile(file,'utf8'));
const parts=[['fence','обмен ударами'],['take','взятие до удара']];
const failures=[];
const check=(name,ok,detail)=>{console.log(`${ok?'ok  ':'FAIL'} ${name}`,JSON.stringify(detail));if(!ok)failures.push(name);};
for(const [part,label] of parts)for(const [role,id] of Object.entries(d.ids)){
 let frames=d[part].map(f=>f[id]).filter(Boolean);
 // The taken figure is measured until the blow lands; then it is struck and falls.
 if(part==='take'&&role==='defender'){const k=d.take.findIndex(f=>/проиграл/.test(f.phase||''));if(k>0)frames=d.take.slice(0,k).map(f=>f[id]).filter(Boolean);}
 const m=measure(frames,d.fps),who=`${label}, ${role==='attacker'?'атакующий':'защитник'}`;
 for(const s of ['L','R']){const f=m.feet[s];
  check(`${who}: стопа ${s} стоит`,f.standing>=LIMITS.standing,{standing:+f.standing.toFixed(2)});
  check(`${who}: стопа ${s} не скользит`,f.slides<=LIMITS.slides,{slides:f.slides,slidM:+f.slid.toFixed(2)});
  check(`${who}: стопа ${s} не семенит`,f.micro<=LIMITS.micro&&f.perSecond<=LIMITS.perSecond,{micro:f.micro,perSecond:+f.perSecond.toFixed(2),steps:f.steps.map(x=>+x.length.toFixed(2))});}
 check(`${who}: колени не дрожат`,Math.max(m.kneeShake.L,m.kneeShake.R)<=LIMITS.kneeShake,m.kneeShake);
 check(`${who}: таз не дрожит`,m.shake.root<=LIMITS.rootShake,{root:m.shake.root});
 const z=['root','lowerleg01.L','lowerleg01.R','foot.L','foot.R'].map(j=>m.zigzag[j]);
 check(`${who}: без зигзагов`,Math.max(...z)<=LIMITS.zigzag,{zigzag:z});
}
if(d.errors?.length)check('без ошибок страницы',false,d.errors);
console.log(failures.length?`${failures.length} проверок не прошло`:'все проверки плавности прошли');
process.exit(failures.length?1:0);
