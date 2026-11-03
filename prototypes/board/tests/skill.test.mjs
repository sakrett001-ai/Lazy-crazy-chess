import test from 'node:test';
import assert from 'node:assert/strict';
import {mid,distance,sub,length} from '../src/mocap/math.mjs';
import {createRetargeter} from '../src/mocap/retarget.mjs';
import {pawnRest} from './pawn-rest.mjs';
import {LEVELS,ANCHORS,skillParams,strikePhases,scaleWindup,scaleTwist,shoulderTurn,retime,applySkill} from '../src/mocap/skill.mjs';
import {trunkFrame,toTrunk,cutTrack} from '../src/mocap/strike.mjs';

const near=(a,b,eps,msg)=>assert.ok(Math.abs(a-b)<=eps,`${msg}: ${a} vs ${b} (±${eps})`);
const retarget=createRetargeter(pawnRest());
const rest=()=>JSON.parse(JSON.stringify(retarget.points));
const fps=30,smooth=u=>{u=Math.min(1,Math.max(0,u));return u*u*(3-2*u);};
// A synthetic two-handed blow, 3 s: guard to 0.5 s, windup to overhead by
// 1.3 s, a short stop, the blow down and forward peaking at 1.6 s, a held
// follow-through, back to guard by 2.6 s. The shoulders turn against the hips
// with the windup (+25°) and the blow (−20°).
function blow({twist=true}={}){
 return Array.from({length:91},(_,f)=>{
  const t=f/fps,p=rest(),sh=mid(p.shoulderL,p.shoulderR);
  const up=smooth((t-.5)/.8)-smooth((t-1.4)/.35)*1.1+smooth((t-2)/.6)*.1;   // 0 guard, 1 overhead, −0.1 low
  const turn=(25*smooth((t-.5)/.8)-45*smooth((t-1.4)/.35)+20*smooth((t-2)/.6))*Math.PI/180;
  for(const s of ['L','R']){p['elbow'+s]=[p['shoulder'+s][0]*.6,sh[1]-.15+.45*up,sh[2]+.22];p['wrist'+s]=[s==='L'?.03:-.03,sh[1]-.3+.75*up,sh[2]+.3-.1*up];}
  if(!twist)return p;
  const o=p.spine,c=Math.cos(turn),sn=Math.sin(turn);
  for(const k of ['chest','neck','head','eyeL','eyeR','shoulderL','shoulderR','elbowL','elbowR','wristL','wristR'])if(p[k]){const v=sub(p[k],o);p[k]=[o[0]+c*v[0]+sn*v[2],p[k][1],o[2]-sn*v[0]+c*v[2]];}
  return p;
 });
}

test('skill levels: the recording in the middle, recruit and veteran on either side',()=>{
 assert.deepEqual(LEVELS.map(l=>l.id),['recruit','fighter','veteran']);
 const mid_=skillParams(.5);
 for(const [k,v]of Object.entries(ANCHORS))near(mid_[k],v[1],1e-12,'skill 0.5 is the recording: '+k);
 const r=skillParams(0),v=skillParams(1);
 assert.ok(r.windup>1&&v.windup<1&&r.recover>1&&v.recover<1,'the recruit is slower, the veteran faster');
 assert.ok(r.reach>1&&v.reach<1,'the recruit winds up wider, the veteran tighter');
 assert.ok(r.twist<1&&v.twist>=1,'the recruit turns the trunk less');
 assert.ok(r.handForceN<200&&v.handForceN>200,'the veteran holds the weapon harder');
 assert.ok(r.pause>0&&v.pause===0,'only the recruit hesitates at the top');
 near(skillParams(.25).windup,(r.windup+1)/2,1e-12,'continuous between levels');
 near(skillParams(-1).windup,r.windup,1e-12,'clamped below');
});

test('strike phases from the hands: windup start, top, blow, end of follow-through',()=>{
 const frames=blow(),ph=strikePhases(frames,fps);
 near(ph.a/fps,.5,.12,'windup starts');near(ph.b/fps,1.35,.12,'top of the windup');near(ph.c/fps,1.57,.08,'blow');
 assert.ok(ph.d>ph.c&&ph.d/fps<2,'follow-through ends before the return');
});

test('windup reach: wider or tighter on the way up, the blow itself untouched',()=>{
 const frames=blow(),ph=strikePhases(frames,fps),wide=scaleWindup(frames,ph,1.3),tight=scaleWindup(frames,ph,.7);
 const lift=fr=>i=>toTrunk(trunkFrame(fr[i]),mid(fr[i].wristL,fr[i].wristR))[1];
 const top=ph.b;
 assert.ok(lift(wide)(top)>lift(frames)(top)+.05,'recruit: hands farther from the guard at the top');
 assert.ok(lift(tight)(top)<lift(frames)(top)-.05,'veteran: hands nearer');
 for(const fr of [wide,tight]){
  for(const i of [0,ph.a,ph.c,ph.d,frames.length-1])assert.deepEqual(fr[i],frames[i],'unchanged at frame '+i);
  for(let i=0;i<fr.length;i++){assert.deepEqual(fr[i].pelvis,frames[i].pelvis);assert.deepEqual(fr[i].shoulderL,frames[i].shoulderL,'only the arms move');}
 }
 assert.equal(scaleWindup(frames,ph,1),frames,'k = 1 leaves the recording');
});

test('trunk twist: the shoulders turn k times as far against the hips, within 45°',()=>{
 const frames=blow(),t0=shoulderTurn(frames[0]),turn=fr=>fr.map(p=>shoulderTurn(p)-t0);
 const base=turn(frames),stiff=turn(scaleTwist(frames,.5)),loose=turn(scaleTwist(frames,1.1));
 const i=base.reduce((m,v,k)=>Math.abs(v)>Math.abs(base[m])?k:m,0);
 near(stiff[i],base[i]*.5,1e-9,'half the turn');near(loose[i],base[i]*1.1,1e-9,'10 % more');
 assert.ok(Math.max(...turn(scaleTwist(frames,3)).map(Math.abs))<=45*Math.PI/180+1e-9,'never beyond 45°');
 const tw=scaleTwist(frames,.5);
 for(let k=0;k<frames.length;k++){
  for(const q of ['pelvis','hipL','hipR','kneeL','ankleR','toeL'])assert.deepEqual(tw[k][q],frames[k][q],'legs stay on the recording');
  near(distance(tw[k].shoulderL,tw[k].wristL),distance(frames[k].shoulderL,frames[k].wristL),1e-9,'arm turns as one piece');
  const a=toTrunk(trunkFrame(tw[k]),tw[k].wristR),b=toTrunk(trunkFrame(frames[k]),frames[k].wristR);
  for(let j=0;j<3;j++)near(a[j],b[j],1e-9,'hands keep their path in the trunk frame');
 }
});

test('retime: phases stretch by their factors, the motion keeps its path',()=>{
 const frames=blow(),ph=strikePhases(frames,fps);
 const same=retime(frames,fps,ph,{windup:1,strike:1,recover:1,pause:0});assert.equal(same.frames,frames,'1,1,1 is the recording');
 const slow=retime(frames,fps,ph,{windup:1.5,strike:1.2,recover:2,pause:0}),fast=retime(frames,fps,ph,{windup:.75,strike:.9,recover:.6,pause:0});
 const len=r=>p=>r.phases[p];
 near((len(slow)('b')-len(slow)('a'))/(ph.b-ph.a),1.5,.12,'windup 1.5×');
 near((len(slow)('d')-len(slow)('b'))/(ph.d-ph.b),1.2,.12,'blow 1.2×');
 near((slow.frames.length-1-len(slow)('d'))/(frames.length-1-ph.d),2,.15,'return 2×');
 assert.ok(fast.frames.length<frames.length&&slow.frames.length>frames.length);
 near(len(slow)('a'),ph.a,1.6,'the guard before the windup keeps its time');
 // Same path: every output pose lies on the recording between two of its frames.
 const seg=(p,a,b)=>{const ab=sub(b,a),u=Math.max(0,Math.min(1,(ab[0]*(p[0]-a[0])+ab[1]*(p[1]-a[1])+ab[2]*(p[2]-a[2]))/(length(ab)**2||1)));return distance(p,[a[0]+ab[0]*u,a[1]+ab[1]*u,a[2]+ab[2]*u]);};
 for(const f of slow.frames){const d=Math.min(...frames.slice(1).map((g,i)=>seg(f.wristR,frames[i].wristR,g.wristR)));assert.ok(d<1e-9,'on the path: '+d);}
 assert.deepEqual(slow.frames[0],frames[0]);assert.deepEqual(slow.frames.at(-1),frames.at(-1),'same first and last pose');
 // A pause at the top slows the hands there.
 const paused=retime(frames,fps,ph,{windup:1,strike:1,recover:1,pause:.6}),speed=r=>{const i=Math.round(r.phases.b);return distance(r.frames[i+1].wristR,r.frames[i-1].wristR);};
 const plain=retime(frames,fps,ph,{windup:1.0001,strike:1,recover:1,pause:0});
 assert.ok(paused.frames.length>plain.frames.length,'the pause takes time');
});

test('a recruit lets a heavy head run on, a veteran stops it on the line',async()=>{
 const {massProperties,RUNTIME_WEAPONS}=await import('../../white-pawn/src/weapons.mjs');
 const frames=blow({twist:false}),h=massProperties('warhammer'),spacing=-RUNTIME_WEAPONS.warhammer.secondS;
 const run=skill=>{const sk=applySkill(frames,fps,skill);return cutTrack(sk.frames,{smooth:0,shift:spacing/2/.54,fps,weapon:{...h,spacingM:spacing,limits:sk.limits}}).dynamics;};
 const r=run(0),f=run(.5),v=run(1);
 assert.ok(r.aheadDeg>f.aheadDeg&&f.aheadDeg>v.aheadDeg,'the head runs on less with skill: '+[r.aheadDeg,f.aheadDeg,v.aheadDeg]);
 assert.ok(r.capNm<f.capNm&&f.capNm<v.capNm,'stronger hands with skill');
 const mid_=applySkill(frames,fps,.5);assert.equal(mid_.frames.length,frames.length,'the fighter is the recording');
 for(let i=0;i<frames.length;i++)assert.deepEqual(mid_.frames[i],frames[i]);
});
