#!/usr/bin/env node
// Strikes from open recordings → one motion file with an arms track per clip.
//
//   git clone --depth 1 https://github.com/BandaiNamcoResearchInc/Bandai-Namco-Research-Motiondataset /tmp/bnr
//   node tools/strikes/build.mjs --bvh /tmp/bnr/dataset/Bandai-Namco-Research-Motiondataset-1/data
//
// Writes tools/strikes/out/strikes.motion.json (closed in .gitignore: the
// recordings are CC BY-NC 4.0 and stay out of the repository, see
// docs/STRIKES.md). catalog.json lists the strikes: file, frame range, how the
// arms are led (cut: the recorded hands lead the blade; thrust: the recording
// times the loadout's spear thrust) and the fighter's equipment.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {bvhToClip} from '../../src/mocap/bvh.mjs';
import {buildMotionFile} from '../../src/mocap/format.mjs';
import {cutTrack,thrustTrack,weaponTrack,mirrorFrames,ARM_M} from '../../src/mocap/strike.mjs';
import {LEVELS,applySkill} from '../../src/mocap/skill.mjs';
import {RUNTIME_WEAPONS,massProperties} from '../../../white-pawn/src/weapons.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2),opt=(k,d)=>{const i=args.indexOf('--'+k);return i>=0?args[i+1]:d;};
const dir=opt('bvh');
const catalog=JSON.parse(await readFile(path.join(here,'catalog.json'),'utf8'));
const only=opt('only');
const round=v=>+v.toFixed(3);

// Strikes from a storyboard (catalog.storyboard): poses lifted from treatise
// plates (Lazy-skills-lab, skills/storyboard-motion), exported with their
// weapon. The plates are public domain and the motion is ours, so the built
// file is committed (motions/), unlike the dataset's. Each goes to a file of
// its own: the retargeter turns the trunk from the file's neutral stance,
// which is the storyboard skeleton's, not the dataset's.
const fromFile=(file,clip)=>{const P=file.points,J=P.length;return Array.from({length:clip.frames},(_,f)=>Object.fromEntries(P.map((p,j)=>{const i=(f*J+j)*3;return[p,clip.data.slice(i,i+3)];})));};
for(const s of catalog.storyboard||[]){
 if(only&&s.id!==only)continue;
 const src=JSON.parse(await readFile(path.join(here,s.motion),'utf8')),clip=src.clips.find(c=>c.name===s.clip);
 if(!clip?.weapon)throw Error(`${s.id}: в ${s.motion} нет клипа ${s.clip} с оружием`);
 const neutral=fromFile({points:src.points},{frames:1,data:src.neutral})[0];
 // Hold the first and last frames: the plates give the guard and the end of
 // the cut, the board needs a moment in each. Only frames are repeated.
 const [before,after]=(s.hold||[0,0]).map(t=>Math.round(t*clip.fps));
 const pad=(rows,w)=>[...Array(before).fill(rows[0]),...rows,...Array(after).fill(rows[rows.length-1])];
 const frames=pad(fromFile(src,clip)),F=clip.weapon.fields.length,wrows=[];
 for(let i=0;i<clip.frames;i++)wrows.push(clip.weapon.data.slice(i*F,i*F+F));
 const weapon={...clip.weapon,data:pad(wrows).flat()};
 const spec=RUNTIME_WEAPONS[s.loadout?.weaponType],spacing=spec?-spec.secondS:.13;
 const arms=weaponTrack(frames,weapon,{shift:spacing/2/ARM_M,neutral});
 const strike={...s,phases:{windup:0,top:round(before/clip.fps),blow:round((before+clip.frames-1)/clip.fps),followThrough:round((frames.length-1)/clip.fps)}};
 delete strike.motion;delete strike.clip;delete strike.out;
 const label=`${s.figure}: ${s.label}`;
 const file=buildMotionFile({neutral,source:{...src.source,note:src.source.note+' Оружие поднято вместе с телом; дорожка рук — weaponTrack (src/mocap/strike.mjs).'},
  clips:[{name:s.id,label,role:'strike',fps:clip.fps,frames,arms}]});
 file.strikes=[strike];
 const out=path.resolve(here,s.out);await mkdir(path.dirname(out),{recursive:true});await writeFile(out,JSON.stringify(file));
 console.log(`${s.id}: ${clip.name}, ${clip.frames} кадров раскадровки + стойка ${s.hold?.[0]??0} с и конец ${s.hold?.[1]??0} с, ${(frames.length/clip.fps).toFixed(2)} с, руки — по записанному оружию → ${path.relative(process.cwd(),out)}`);
}
const wantsBvh=catalog.strikes.some(s=>!only||s.id===only),built=(catalog.storyboard||[]).some(s=>!only||s.id===only);
if(!dir&&wantsBvh){if(built){console.log('Удары из набора пропущены: нужна папка с BVH (--bvh <папка data набора>).');process.exit(0);}console.error('Нужна папка с BVH: --bvh <папка data набора>');process.exit(2);}
if(!wantsBvh)process.exit(0);
// Neutral stance of the same skeleton: the trunk, head and feet turn from it
// (retarget.mjs) and the cut's trunk frame stands upright at it (strike.mjs).
const n=catalog.dataset.neutral,neutral=n?bvhToClip(await readFile(path.join(dir,n.file),'utf8'),{name:'neutral'}).clip.frames[n.frame||0]:null;
// Skill levels (src/mocap/skill.mjs): every strike once per level, from the
// recruit to the veteran. --levels recruit,veteran picks some; --levels none
// keeps the recording alone, as before.
const levelArg=opt('levels',(catalog.skill?.levels||[]).join(','));
const levels=levelArg&&levelArg!=='none'?levelArg.split(',').map(id=>{const l=LEVELS.find(x=>x.id===id);if(!l)throw Error('Нет уровня '+id);return l;}):[null];
const clips=[];
for(const s of catalog.strikes){
 if(only&&s.id!==only)continue;
 const {clip}=bvhToClip(await readFile(path.join(dir,s.file),'utf8'),{name:s.id,label:`${s.figure}: ${s.label}`,role:'strike'});
 let recorded=clip.frames.slice(s.frames[0],s.frames[1]+1);
 if(s.mirror)recorded=mirrorFrames(recorded);
 // A weapon with its own geometry (weapons.mjs) sets the hand spacing and its
 // mass turns the blade line into the weapon's own path (strike.mjs).
 const spec=RUNTIME_WEAPONS[s.loadout?.weaponType],spacing=spec?-spec.secondS:null;
 for(const level of levels){
  // The recording reshaped for the level: windup, trunk turn and time; the
  // hands' grip on the weapon and the spear's aim lead go to the arms track.
  const sk=level?applySkill(recorded,clip.fps,level.skill,{hands:s.track==='cut'?s.hands:'right'}):null,frames=sk?sk.frames:recorded;
  const cut={hands:s.hands,neutral:s.mirror&&neutral?mirrorFrames([neutral])[0]:neutral,...(s.pivot?{pivot:s.pivot}:{}),
   ...(spec?{shift:spacing/2/ARM_M,fps:clip.fps,weapon:{...massProperties(s.loadout.weaponType),spacingM:spacing,...(sk?{limits:sk.limits}:{})}}:{})};
  const arms=s.track==='cut'?cutTrack(frames,cut):thrustTrack(frames,{fps:clip.fps,...(sk?{lead:sk.params.aimLead}:{})});
  const strike={...s,loadout:{...(s.loadout||{}),...(level?{experience:level.id==='veteran'?'veteran':'recruit'}:{})}};
  if(level){
   const ph=sk.phases,P=sk.params;
   Object.assign(strike,{strike:s.id,level:level.id,levelLabel:level.label,skill:level.skill,
    phases:{windup:round(ph.a/clip.fps),top:round(ph.b/clip.fps),blow:round(ph.c/clip.fps),followThrough:round(ph.d/clip.fps)},
    sourcePhases:Object.fromEntries(Object.entries(sk.source).map(([k,v])=>[k,v+s.frames[0]])),
    params:Object.fromEntries(Object.entries(P).map(([k,v])=>[k,round(v)]))});
  }
  if(arms.dynamics){strike.dynamics=arms.dynamics;delete arms.dynamics;}
  delete arms.reach;
  const name=level?`${s.id}@${level.id}`:s.id,label=`${s.figure}: ${s.label}${level?' — '+level.label:''}`;
  clips.push({...clip,name,label,frames,arms,strike});
  console.log(`${name}: кадры ${s.frames[0]}–${s.frames[1]} из ${s.file}, ${(frames.length/clip.fps).toFixed(2)} с, руки — ${s.track}`+(strike.phases?`, удар на ${strike.phases.blow} с`:'')+(strike.dynamics?`, оружие: отстаёт ${strike.dynamics.behindDeg}°, проваливается ${strike.dynamics.aheadDeg}°`:''));
 }
}
const file=buildMotionFile({neutral,source:{kind:'bvh',name:catalog.dataset.name,url:catalog.dataset.url,license:catalog.dataset.license,credit:catalog.dataset.credit,
 note:'Руки и оружие: tools/strikes (src/mocap/strike.mjs). Клинка в записи нет — его линия задана моделью по пути кистей.'},clips});
file.strikes=clips.map(c=>c.strike);
const out=path.resolve(opt('out',path.join(here,'out/strikes.motion.json')));
await mkdir(path.dirname(out),{recursive:true});
await writeFile(out,JSON.stringify(file));
console.log('→',out);
