import test from 'node:test';
import assert from 'node:assert/strict';
import {sub,length,dot,normalize,qRotate,qMul,qConj,frame,rotateY,distance} from '../src/mocap/math.mjs';
import {resolveJoints,fromMediaPipe,REQUIRED} from '../src/mocap/profiles.mjs';
import {buildMotionFile,parseMotionFile,prepareClip,sampleClip,centerPoints} from '../src/mocap/format.mjs';
import {readFileSync} from 'node:fs';
import {parseBVH,bvhPositions,bvhToMotionFile} from '../src/mocap/bvh.mjs';
import {createRetargeter,PAWN,DRIVEN} from '../src/mocap/retarget.mjs';
import {pawnRest} from './pawn-rest.mjs';
import {walkerFrame,syntheticMotionFile} from '../src/mocap/synthetic.mjs';

const near=(a,b,eps,msg)=>assert.ok(Math.abs(a-b)<=eps,`${msg}: ${a} vs ${b} (±${eps})`);
const angle=(u,v)=>Math.acos(Math.max(-1,Math.min(1,dot(normalize(u),normalize(v)))))*180/Math.PI;
const qAngle=(a,b)=>{const d=qMul(a,qConj(b));return 2*Math.acos(Math.min(1,Math.abs(d[3])))*180/Math.PI;};
const rest=pawnRest(),retarget=createRetargeter(rest);

test('a frame turns its two defining directions onto the first two axes',()=>{
 const q=frame([0,-2,0],[0,.3,5]);
 const x=qRotate(q,[1,0,0]),y=qRotate(q,[0,1,0]);
 assert.ok(distance(x,[0,-1,0])<1e-9&&distance(y,[0,0,1])<1e-9);
});

test('joint names: SOMA, CMU and Mixamo skeletons resolve to the same anatomy',()=>{
 const soma=resolveJoints(['Hips','Spine1','Spine2','Chest','Neck1','Neck2','Head','LeftEye','RightEye','LeftShoulder','LeftArm','LeftForeArm','LeftHand','RightShoulder','RightArm','RightForeArm','RightHand','LeftLeg','LeftShin','LeftFoot','LeftToeBase','RightLeg','RightShin','RightFoot','RightToeBase']);
 assert.equal(soma.profile,'soma');assert.deepEqual(soma.missing,[]);
 assert.equal(soma.map.hipL,17,'SOMA LeftLeg is the thigh');assert.equal(soma.map.kneeL,18);
 const cmu=resolveJoints(['Hips','LHipJoint','LeftUpLeg','LeftLeg','LeftFoot','LeftToeBase','RHipJoint','RightUpLeg','RightLeg','RightFoot','RightToeBase','LowerBack','Spine','Spine1','Neck','Neck1','Head','LeftShoulder','LeftArm','LeftForeArm','LeftHand','RightShoulder','RightArm','RightForeArm','RightHand']);
 assert.equal(cmu.profile,'generic');assert.deepEqual(cmu.missing,[]);
 assert.equal(cmu.map.hipL,2,'CMU LeftUpLeg is the thigh');assert.equal(cmu.map.kneeL,3,'CMU LeftLeg is the knee');
 const mixamo=resolveJoints(['mixamorig:Hips','mixamorig:Spine','mixamorig:Spine1','mixamorig:Spine2','mixamorig:Neck','mixamorig:Head','mixamorig:LeftArm','mixamorig:RightArm','mixamorig:LeftUpLeg','mixamorig:LeftLeg','mixamorig:LeftFoot','mixamorig:LeftToeBase','mixamorig:RightUpLeg','mixamorig:RightLeg','mixamorig:RightFoot','mixamorig:RightToeBase']);
 assert.deepEqual(mixamo.missing,[]);assert.equal(mixamo.map.chest,3,'Mixamo Spine2 is the chest');
});

test('MediaPipe landmarks become y-up key points on the person\'s own sides',()=>{
 const lm=Array.from({length:33},()=>({x:0,y:0,z:0}));
 lm[23]={x:.1,y:0,z:0};lm[24]={x:-.1,y:0,z:0};lm[27]={x:.1,y:.85,z:0};lm[11]={x:.18,y:-.5,z:0};lm[12]={x:-.18,y:-.5,z:0};
 const p=fromMediaPipe(lm);
 assert.ok(p.ankleL[1]<p.pelvis[1]&&p.neck[1]>p.pelvis[1],'y points up');
 assert.ok(p.hipL[0]>0);
});

// Key points of the pawn's own rest pose, as a source would give them.
function pawnPoints(){
 const r=retarget.points;return{...r,eyeL:[r.head[0]+.03,r.head[1]+.08,r.head[2]+.09],eyeR:[r.head[0]-.03,r.head[1]+.08,r.head[2]+.09]};
}
function asFile(frames,{fps=30,loop=false,transform=v=>v}={}){
 return buildMotionFile({source:{kind:'test',name:'test'},clips:[{name:'c',fps,loop,frames:frames.map(f=>Object.fromEntries(Object.entries(f).map(([k,v])=>[k,transform(v)])))}]});
}

test('the pawn\'s own rest pose, in any units, facing and up axis, retargets to its rest pose',()=>{
 // Centimetres, z up, facing -X: none of it may change the result.
 const zUpFacingMinusX=v=>{const r=rotateY(v,-Math.PI/2);return[r[0]*100,-r[2]*100,r[1]*100];};
 for(const transform of [v=>v,zUpFacingMinusX]){
  const file=parseMotionFile(JSON.parse(JSON.stringify(asFile([pawnPoints()],{transform}))));
  const clip=prepareClip(file,file.clips[0]),pose=retarget.pose(sampleClip(clip,0),clip);
  for(const b of DRIVEN)assert.ok(qAngle(pose.world[b],rest.quat[b])<.5,`${b} turned ${qAngle(pose.world[b],rest.quat[b]).toFixed(2)}°`);
  near(pose.root[1],rest.pos.root[1],.003,'pelvis height');
  near(Math.hypot(pose.root[0],pose.root[2]),Math.hypot(rest.pos.root[0],rest.pos.root[2]),.003,'pelvis over the feet');
 }
});

const walker=t=>walkerFrame(t);

test('a walk keeps its knee angles and foot directions on the pawn, and the pawn stays on the ground',()=>{
 const frames=Array.from({length:61},(_,f)=>walker(f/30));
 const file=asFile(frames,{transform:v=>[v[0]*100,v[1]*100,v[2]*100]});
 const clip=prepareClip(file,file.clips[0]);
 let maxKnee=0,minAnkle=Infinity;
 for(let f=0;f<=60;f++){
  const src=sampleClip(clip,f/30),pose=retarget.pose(src,clip);
  for(const s of ['L','R']){
   const leg=pose.legs[s];
   const flexSrc=angle(sub(src['knee'+s],src['hip'+s]),sub(src['ankle'+s],src['knee'+s]));
   const flexPawn=angle(sub(leg.knee,leg.hip),sub(leg.ankle,leg.knee));
   near(flexPawn,flexSrc,.5,`knee ${s} frame ${f}`);
   near(angle(sub(leg.toe,leg.ankle),sub(src['toe'+s],src['ankle'+s])),0,1,`foot ${s} frame ${f}`);
   // The knee bends forward: it lies ahead of the hip–ankle line.
   const line=normalize(sub(leg.ankle,leg.hip)),off=sub(sub(leg.knee,leg.hip),line.map(v=>v*dot(sub(leg.knee,leg.hip),line)));
   if(flexSrc>5)assert.ok(off[2]>0,`knee ${s} bends forward at frame ${f}`);
   maxKnee=Math.max(maxKnee,flexPawn);minAnkle=Math.min(minAnkle,leg.ankle[1]);
  }
  assert.ok(Math.min(pose.legs.L.ankle[1],pose.legs.R.ankle[1])>=retarget.ankleHeight-1e-6,'a foot never sinks into the ground');
 }
 assert.ok(maxKnee>30&&maxKnee<140,`knee flexion in range: ${maxKnee}`);
 near(minAnkle,retarget.ankleHeight,1e-6,'the supporting foot is on the ground');
});

test('travel is rescaled to the pawn and can be removed for in-place playback',()=>{
 const frames=Array.from({length:61},(_,f)=>walker(f/30));
 const file=asFile(frames),clip=prepareClip(file,file.clips[0]);
 const a=retarget.pose(sampleClip(clip,0),clip),b=retarget.pose(sampleClip(clip,2),clip);
 near(b.root[2]-a.root[2],2*1.3*retarget.leg/clip.leg,.01,'travel in pawn metres');
 const c=retarget.pose(sampleClip(clip,2,{inPlace:true}),clip);
 near(c.root[2]-a.root[2],0,.01,'in place');
});

test('a looping clip wraps and keeps walking',()=>{
 const frames=Array.from({length:31},(_,f)=>walker(f/30));
 const file=buildMotionFile({source:{kind:'test'},clips:[{name:'loop',fps:30,loop:true,frames}]});
 const clip=prepareClip(file,file.clips[0]);
 near(sampleClip(clip,2.5).pelvis[2],1.3*2.5,.02,'pelvis keeps going after two laps');
});

const BVH=`HIERARCHY
ROOT Hips
{
 OFFSET 0 0 0
 CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
 JOINT LeftUpLeg
 {
  OFFSET 10 0 0
  CHANNELS 3 Zrotation Xrotation Yrotation
  JOINT LeftLeg
  {
   OFFSET 0 -45 0
   CHANNELS 3 Zrotation Xrotation Yrotation
   JOINT LeftFoot
   {
    OFFSET 0 -45 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    End Site
    {
     OFFSET 0 -5 15
    }
   }
  }
 }
 JOINT RightUpLeg
 {
  OFFSET -10 0 0
  CHANNELS 3 Zrotation Xrotation Yrotation
  JOINT RightLeg
  {
   OFFSET 0 -45 0
   CHANNELS 3 Zrotation Xrotation Yrotation
   JOINT RightFoot
   {
    OFFSET 0 -45 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    End Site
    {
     OFFSET 0 -5 15
    }
   }
  }
 }
 JOINT Spine
 {
  OFFSET 0 12 0
  CHANNELS 3 Zrotation Xrotation Yrotation
  JOINT Neck
  {
   OFFSET 0 45 0
   CHANNELS 3 Zrotation Xrotation Yrotation
   JOINT Head
   {
    OFFSET 0 10 2
    CHANNELS 3 Zrotation Xrotation Yrotation
    End Site
    {
     OFFSET 0 10 0
    }
   }
  }
  JOINT LeftArm
  {
   OFFSET 18 40 0
   CHANNELS 3 Zrotation Xrotation Yrotation
   End Site
   {
    OFFSET 25 0 0
   }
  }
  JOINT RightArm
  {
   OFFSET -18 40 0
   CHANNELS 3 Zrotation Xrotation Yrotation
   End Site
   {
    OFFSET -25 0 0
   }
  }
 }
}
MOTION
Frames: 2
Frame Time: 0.033333
0 95 0 0 0 0  0 0 0  0 0 0  0 0 0  0 0 0  0 0 0  0 0 0  0 0 0  0 0 0  0 0 0  0 0 0  0 0 0
0 95 3 0 0 90  0 -30 0  0 60 0  0 0 0  0 0 0  0 0 0  0 0 0  0 0 0  0 0 0  0 0 0  0 0 0  0 0 0
`;

test('BVH: hierarchy, intrinsic rotation order and end sites',()=>{
 const bvh=parseBVH(BVH),pos=bvhPositions(bvh);
 assert.equal(bvh.frames,2);near(bvh.frameTime,1/30,1e-4,'frame time');
 const idx=n=>bvh.joints.findIndex(j=>j.name===n);
 assert.deepEqual(pos[0][idx('LeftFoot')],[10,5,0]);
 assert.ok(idx('LeftFoot_end')>0,'end site kept');
 // Frame 2: hips turned 90° about Y, so the left hip sits at -Z.
 const hip=pos[1][idx('LeftUpLeg')];near(hip[0],0,1e-6,'x');near(hip[2],3-10,1e-6,'z');
 // The knee bend (60° at LeftLeg) is the angle between thigh and shin.
 const p=j=>pos[1][idx(j)];
 near(angle(sub(p('LeftLeg'),p('LeftUpLeg')),sub(p('LeftFoot'),p('LeftLeg'))),60,1e-6,'knee bend');
});

test('BVH to motion file: profile, toes from end sites, retargets',()=>{
 const file=parseMotionFile(bvhToMotionFile(BVH,{name:'tiny'}));
 for(const p of REQUIRED)assert.ok(file.points.includes(p),p);
 const clip=prepareClip(file,file.clips[0]),pose=retarget.pose(sampleClip(clip,1/30),clip);
 const leg=pose.legs.L;near(angle(sub(leg.knee,leg.hip),sub(leg.ankle,leg.knee)),60,.5,'knee bend carried over');
});

test('motion file validation names what is wrong',()=>{
 assert.throws(()=>parseMotionFile({format:'other'}),/format/);
 const file=asFile([pawnPoints()]);file.clips[0].data.pop();
 assert.throws(()=>parseMotionFile(file),/длина данных/);
});

test('the built-in synthetic file loads and its stance keeps both feet down',()=>{
 const file=parseMotionFile(JSON.parse(JSON.stringify(syntheticMotionFile())));
 const stand=prepareClip(file,file.clips.find(c=>c.role==='stand'));
 for(let t=0;t<4;t+=.1){const pose=retarget.pose(sampleClip(stand,t),stand);
  assert.ok(Math.abs(pose.legs.L.ankle[1]-pose.legs.R.ankle[1])<.03,`both feet down at ${t.toFixed(1)} s`);}
});

test('a shared-frame pair keeps the file\'s own frame and names its partner',()=>{
 // A figure offset from the origin and facing -X: an ordinary clip is moved
 // and turned onto the origin, a shared-frame clip is left where it is.
 const pts=pawnPoints(),moved=Object.fromEntries(Object.entries(pts).map(([k,v])=>[k,rotateY(v,-Math.PI/2).map((x,i)=>x+[2,0,1][i])]));
 const file=buildMotionFile({source:{kind:'test'},clips:[{name:'own',fps:30,frames:[moved,moved]},{name:'pair',fps:30,frame:'shared',partner:'other',frames:[moved,moved]}]});
 const own=prepareClip(file,file.clips[0]),pair=prepareClip(file,file.clips[1]);
 near(own.frames[0].pelvis[0],0,1e-3,'own clip starts at the origin');
 assert.equal(pair.shared,true);assert.equal(pair.partner,'other');assert.equal(own.partner,null);
 near(distance(pair.frames[0].pelvis,moved.pelvis),0,1e-3,'shared clip stays in the file\'s frame');
});

test('centerPoints moves the pelvis over the origin and keeps heights',()=>{
 const c=centerPoints({pelvis:[1,.9,-2],head:[1.1,1.6,-1.9]});
 assert.deepEqual(c.pelvis,[0,.9,0]);near(c.head[0],.1,1e-9,'head x');near(c.head[2],.1,1e-9,'head z');assert.equal(c.head[1],1.6);
});

test('the Blender capture pair is a shared-frame attacker and defender',()=>{
 const file=parseMotionFile(readFileSync(new URL('../motions/pawn-capture.motion.json',import.meta.url),'utf8'));
 const strike=file.clips.find(c=>c.name==='pawn-capture-strike'),struck=file.clips.find(c=>c.name==='pawn-capture-struck');
 assert.ok(strike&&struck,'both clips');assert.equal(strike.partner,'pawn-capture-struck');assert.equal(struck.partner,'pawn-capture-strike');
 for(const c of [strike,struck]){assert.equal(c.frame,'shared');assert.equal(c.frames,strike.frames);}
 const a=prepareClip(file,strike),d=prepareClip(file,struck);
 // The origin is the attacker's square; in its guard the pelvis sits a few cm off.
 near(Math.hypot(a.frames[0].pelvis[0],a.frames[0].pelvis[2]),0,.1,'attacker starts on its square');
 assert.ok(d.frames[0].pelvis[2]>1,'defender stands ahead of the attacker');
 for(const c of [a,d])for(const f of c.frames)for(const s of ['L','R'])assert.ok(f['ankle'+s][1]>-.01,'ankles stay above the board');
});
