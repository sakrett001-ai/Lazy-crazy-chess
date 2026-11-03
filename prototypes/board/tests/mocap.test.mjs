import test from 'node:test';
import assert from 'node:assert/strict';
import {sub,length,dot,normalize,qRotate,qMul,qConj,frame,rotateY,distance,mid} from '../src/mocap/math.mjs';
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

test('a skeleton with its own spine curve stands at the pawn\'s rest when it stands at its neutral',()=>{
 // Another skeleton: neck 6 cm further back, head point 5 cm back, the
 // lower spine point over the pelvis. Frame against frame the pawn leans
 // back; against the file's neutral the same stance is the pawn's rest.
 const own=p=>({...p,neck:[p.neck[0],p.neck[1],p.neck[2]-.06],head:[p.head[0],p.head[1],p.head[2]-.05],spine:[p.pelvis[0],p.spine[1],p.pelvis[2]]});
 const stance=own(pawnPoints()),trunk=[PAWN.root,...PAWN.spine,...PAWN.neck,PAWN.head];
 const plain=parseMotionFile(JSON.parse(JSON.stringify(asFile([stance])))),pc=prepareClip(plain,plain.clips[0]),bent=retarget.pose(sampleClip(pc,0),pc);
 assert.ok(qAngle(bent.world.neck01,rest.quat.neck01)>4,'without a neutral the trunk turns');
 const file=parseMotionFile(JSON.parse(JSON.stringify({...asFile([stance]),neutral:buildMotionFile({source:{},neutral:stance,clips:[{name:'n',fps:30,frames:[stance]}]}).neutral})));
 const clip=prepareClip(file,file.clips[0]),pose=retarget.pose(sampleClip(clip,0),clip);
 for(const b of DRIVEN)assert.ok(qAngle(pose.world[b],rest.quat[b])<.5,`${b} turned ${qAngle(pose.world[b],rest.quat[b]).toFixed(2)}°`);
 assert.ok(trunk.every(b=>pose.world[b]),'trunk driven');
 // A bow from that neutral bends the pawn forward by the same rotation.
 const bow=JSON.parse(JSON.stringify(stance)),about=bow.pelvis;
 for(const k of ['spine','chest','neck','head','shoulderL','shoulderR','elbowL','elbowR','wristL','wristR'])if(bow[k]){const d=sub(bow[k],about),c=Math.cos(.3),s=Math.sin(.3);bow[k]=[about[0]+d[0],about[1]+d[1]*c-d[2]*s,about[2]+d[1]*s+d[2]*c];}
 const bf=parseMotionFile(JSON.parse(JSON.stringify({...asFile([bow]),neutral:file.neutral}))),bc=prepareClip(bf,bf.clips[0]),bp=retarget.pose(sampleClip(bc,0),bc);
 near(qAngle(bp.world.neck01,rest.quat.neck01),.3*180/Math.PI,1.5,'bow of 17°');
});

test('a skeleton that marks its toe lower stands flat and lifts the heel as recorded',()=>{
 // Another skeleton marks the toe 9 cm under the pawn's toe point: its flat
 // foot's ankle→toe line drops about 40° where the pawn's drops 18°.
 const pitch=(a,t)=>Math.atan2(a[1]-t[1],Math.hypot(t[0]-a[0],t[2]-a[2]))*180/Math.PI;
 const low=p=>({...p,toeL:[p.toeL[0],p.toeL[1]-.06,p.toeL[2]-.03],toeR:[p.toeR[0],p.toeR[1]-.06,p.toeR[2]-.03]});
 const stance=low(pawnPoints()),restPitch=pitch(retarget.points.ankleL,retarget.points.toeL);
 assert.ok(pitch(stance.ankleL,stance.toeL)-restPitch>15,'the source toe line is steeper');
 const neutral=buildMotionFile({source:{},neutral:stance,clips:[{name:'n',fps:30,frames:[stance]}]}).neutral;
 const run=f=>{const file=parseMotionFile(JSON.parse(JSON.stringify({...asFile([f]),neutral})));const c=prepareClip(file,file.clips[0]);return retarget.pose(sampleClip(c,0),c);};
 const flat=run(stance);
 for(const s of ['L','R'])near(pitch(flat.legs[s].ankle,flat.legs[s].toe),restPitch,.5,'flat foot, boot flat '+s);
 // The heel rises 25° about the toe: the boot's heel rises 25° too.
 const lift=JSON.parse(JSON.stringify(stance)),t=lift.toeL,a=sub(lift.ankleL,t),c=Math.cos(25*Math.PI/180),sn=Math.sin(25*Math.PI/180);
 const r=Math.hypot(a[0],a[2]),u=[a[0]/r,a[2]/r],h=r*c-a[1]*sn,y=r*sn+a[1]*c;
 lift.ankleL=[t[0]+u[0]*h,t[1]+y,t[2]+u[1]*h];
 const up=run(lift);
 near(pitch(up.legs.L.ankle,up.legs.L.toe)-restPitch,25,1,'heel lifted 25°');
});

test('a cut from a recording leads the weapon hand in the trunk frame',async()=>{
 const {cutTrack,thrustTrack,trunkFrame,toTrunk}=await import('../src/mocap/strike.mjs');
 const {sampleArms}=await import('../src/mocap/format.mjs');
 // Hands rise from the belly to over the head and come down in front.
 const frames=Array.from({length:31},(_,f)=>{const p=JSON.parse(JSON.stringify(pawnPoints())),u=Math.sin(f/30*Math.PI),sh=mid(p.shoulderL,p.shoulderR);
  for(const s of ['L','R']){p['elbow'+s]=[p['shoulder'+s][0]*.6,sh[1]-.15+.45*u,sh[2]+.22];p['wrist'+s]=[s==='L'?.03:-.03,sh[1]-.3+.75*u,sh[2]+.3-.1*u];}return p;});
 const track=cutTrack(frames,{smooth:0});
 assert.equal(track.data.length,frames.length*track.fields.length);
 const clip={arms:track,fps:30,count:frames.length},low=sampleArms(clip,0).hand,high=sampleArms(clip,.5).hand;
 assert.ok(high.grip[1]>.6&&low.grip[1]<0,'grip follows the hands up');
 assert.ok(high.axis[1]>.8,'overhead the blade stands up');
 for(const h of [low,high]){near(Math.hypot(...h.axis),1,1e-3,'unit axis');near(Math.hypot(...h.pole),1,1e-3,'unit pole');}
 const f=trunkFrame(frames[0]),w=toTrunk(f,frames[0].wristR);assert.ok(w[2]>0,'hands in front of the chest');
 // A thrust: the wrist goes forward and comes back, aim leads the thrust.
 const jab=Array.from({length:31},(_,i)=>{const p=JSON.parse(JSON.stringify(pawnPoints())),u=Math.max(0,Math.sin((i-6)/20*Math.PI));p.wristR=[p.shoulderR[0],p.shoulderR[1]-.1,p.shoulderR[2]+.25+.3*u];p.elbowR=[p.shoulderR[0]-.05,p.shoulderR[1]-.2,p.shoulderR[2]+.1+.15*u];return p;});
 const t=thrustTrack(jab,{fps:30,smooth:0}),thrust=i=>t.data[i*2+1],aim=i=>t.data[i*2];
 assert.ok(thrust(16)>.9&&thrust(0)<.05,'thrust at the farthest reach');
 assert.ok(aim(10)>thrust(10),'aim leads the thrust');
});

test('weapon weight: a light blade keeps the line, a heavy head runs on past a sudden stop', async()=>{
 const {cutTrack}=await import('../src/mocap/strike.mjs');
 const {massProperties,clearanceSamples,RUNTIME_WEAPONS}=await import('../../white-pawn/src/weapons.mjs');
 // Masses and balance in the range of surviving pieces.
 const b=massProperties('bastard'),h=massProperties('warhammer');
 assert.ok(b.massKg>1.3&&b.massKg<1.8&&b.lengthM>1.1&&b.lengthM<1.22,'bastard: 1.3–1.8 kg, 1.1–1.2 m');
 assert.ok(h.massKg>2&&h.massKg<3.5&&h.lengthM>1.3&&h.lengthM<2,'war hammer: 2–3.5 kg, 1.3–2 m');
 assert.ok(h.inertiaKgM2>5*b.inertiaKgM2,'the hammer is far harder to turn');
 assert.ok(clearanceSamples('warhammer').every(([s])=>s<RUNTIME_WEAPONS.warhammer.secondS-.05||s>.05),'clearance samples stay out of the hands');
 // A fast downward cut that stops dead: hands from overhead to the belly in 0.3 s.
 const frames=Array.from({length:40},(_,f)=>{const p=JSON.parse(JSON.stringify(pawnPoints())),u=Math.min(1,Math.max(0,(f-10)/9)),e=u*u*(3-2*u),sh=mid(p.shoulderL,p.shoulderR);
  for(const s of ['L','R']){p['elbow'+s]=[p['shoulder'+s][0]*.6,sh[1]+.3-.45*e,sh[2]+.22];p['wrist'+s]=[s==='L'?.03:-.03,sh[1]+.45-.75*e,sh[2]+.2+.1*e];}return p;});
 const run=(type,mp)=>cutTrack(frames,{smooth:0,shift:-RUNTIME_WEAPONS[type].secondS/2/.59,weapon:{...mp,spacingM:-RUNTIME_WEAPONS[type].secondS}}).dynamics;
 const light=run('bastard',b),heavy=run('warhammer',h);
 assert.ok(light.aheadDeg<3&&light.behindDeg<3,'bastard stays on the line: '+JSON.stringify(light));
 assert.ok(heavy.aheadDeg>light.aheadDeg+5,'hammer runs on past the stop: '+JSON.stringify(heavy));
 assert.ok(heavy.saturatedShare>0&&light.saturatedShare===0,'only the hammer asks the hands for more than they give');
 // Without a weapon the track is unchanged.
 const plain=cutTrack(frames,{smooth:0}),again=cutTrack(frames,{smooth:0});assert.deepEqual(plain.data,again.data);assert.equal(plain.dynamics,undefined);
});
