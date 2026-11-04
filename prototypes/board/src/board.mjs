import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {createGame,PRESETS,coords,FILES} from './game.mjs';
import {engagements,fencingAction,STATE_LABELS} from './behavior.mjs';
import {planCapture,captureAt,CAPTURE_DURATION,CAPTURE_PHASES,HIT_TIME,headingTo,lerpAngle,wrapAngle,rotate,strikeLayer,travel,walkLayer,idleLayer,victimHitLayer} from './choreography.mjs';
import {createPawnFactory,createToken} from './actors.mjs';
import {createLandscape} from './landscape.mjs';
import {readMotionSource} from './mocap/library.mjs';
import {sampleAlong,sampleClip,sampleArms,scaleLayer,centerPoints,turnHead} from './mocap/format.mjs';
import {rotateY} from './mocap/math.mjs';
import {exchangePairs,exchangeLayout,exchangeAt,exchangeArms,cyclePose,bodyMotion,travelAt,trunkLean,levelSpear,shieldAt,SHIELD_WINDOW,CROSSFADE} from './mocap/exchange.mjs';
import {loadoutPhases} from '../../white-pawn/src/loadout.mjs';

// One square is 2.6 m. A 1.8 m soldier with a tower shield and a 2.4 m
// spear fits inside it, and a full thrust from the next square reaches the
// neighbour's braced shield (measured on the model at start-up).
export const SQUARE=2.6;
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const world=sq=>{const {file,rank}=coords(sq);return[(file-3.5)*SQUARE,(3.5-rank)*SQUARE];};
const forwardYaw=color=>color==='w'?Math.PI:0;
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const smooth=(t,a,b)=>{const u=clamp((t-a)/(b-a),0,1);return u*u*(3-2*u);};
const HEAD_FIND=.25; // s, the head coming round onto the opponent as a capture starts
const hash=s=>{let h=2166136261;for(const c of s)h=Math.imul(h^c.charCodeAt(0),16777619);return(h>>>0)/4294967296;};

function fallback(message){$('#loading').hidden=true;$('#fallback').hidden=false;$('#fallback').textContent=message+'. Обновите страницу или откройте файл в свежей версии Chrome, Edge или Firefox.';window.livingChess={ready:false,fallback:message};}

async function modelBytes(){
 const embedded=$('#model-data')?.textContent.trim();
 if(!embedded||embedded==='/*MODEL*/')throw Error('В сборке нет модели пешки');
 const bytes=Uint8Array.from(atob(embedded),c=>c.charCodeAt(0));
 // The hosted build embeds the model gzipped to fit the page size limit.
 if($('#model-data').dataset.encoding!=='gzip')return bytes;
 return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

let renderer;
try{renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});}catch{fallback('WebGL недоступен');}
if(renderer)modelBytes().then(init).catch(error=>{console.error(error);fallback(error.message||'Ошибка загрузки');});

async function init(bytes){
 const stage=$('#stage');
 renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
 renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
 renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.02;
 stage.append(renderer.domElement);
 const scene=new THREE.Scene();scene.background=new THREE.Color('#d8e2e6');scene.fog=new THREE.Fog('#d8e2e6',60,240);
 const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();
 scene.environment=pmrem.fromScene(room,.04).texture;scene.environmentIntensity=.55;room.dispose();pmrem.dispose();
 scene.add(new THREE.HemisphereLight(0xffffff,0x7c837d,1.05));
 const key=new THREE.DirectionalLight(0xfff4e6,3);key.position.set(-12,21,9);key.castShadow=true;key.shadow.mapSize.set(2048,2048);
 Object.assign(key.shadow.camera,{left:-14,right:14,top:14,bottom:-14,near:1,far:60});key.shadow.bias=-.0002;key.shadow.normalBias=.02;scene.add(key);
 const fill=new THREE.DirectionalLight(0xdbe6f5,1);fill.position.set(10,8,-12);scene.add(fill);

 // Board: 64 stone slabs inside a kerb, set in a generated landscape;
 // file and rank letters on the kerb. A new seed builds a new place.
 const half=4*SQUARE,board=new THREE.Group();scene.add(board);
 const squares=[];let landscape=null,landscapeSeed=1+Math.floor(Math.random()*1e6);
 function buildLandscape(seed){
  landscape?.dispose();landscape=createLandscape({seed,square:SQUARE,squareName:(f,r)=>FILES[f]+(r+1)});
  scene.add(landscape.group);squares.length=0;squares.push(...landscape.squares);landscapeSeed=seed;
 }
 buildLandscape(landscapeSeed);
 function label(text,x,z,rot){const c=document.createElement('canvas');c.width=c.height=64;const g=c.getContext('2d');g.fillStyle='#efe6cf';g.font='bold 44px sans-serif';g.textAlign='center';g.textBaseline='middle';g.fillText(text,32,34);
  const m=new THREE.Mesh(new THREE.PlaneGeometry(.42,.42),new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(c),transparent:true}));m.rotation.set(-Math.PI/2,0,rot);m.position.set(x,.075,z);board.add(m);}
 for(let i=0;i<8;i++){const c=(i-3.5)*SQUARE;label(FILES[i],c,half+.3,0);label(FILES[i],c,-half-.3,Math.PI);label(String(i+1),-half-.3,(3.5-i)*SQUARE,0);label(String(i+1),half+.3,(3.5-i)*SQUARE,Math.PI);}
 const markGroup=new THREE.Group();board.add(markGroup);
 const selectMat=new THREE.MeshBasicMaterial({color:0xf2c14e,transparent:true,opacity:.85});
 const moveMat=new THREE.MeshBasicMaterial({color:0x2f8f6f,transparent:true,opacity:.7}),takeMat=new THREE.MeshBasicMaterial({color:0xb3261e,transparent:true,opacity:.75});
 const lastMat=new THREE.MeshBasicMaterial({color:0x7aa6c2,transparent:true,opacity:.35});
 function mark(square,kind){const [x,z]=world(square),k=SQUARE/2;let m;
  if(kind==='select')m=new THREE.Mesh(new THREE.RingGeometry(.78*k,.92*k,48),selectMat);
  else if(kind==='take')m=new THREE.Mesh(new THREE.RingGeometry(.7*k,.86*k,48),takeMat);
  else if(kind==='last')m=new THREE.Mesh(new THREE.PlaneGeometry(SQUARE*.98,SQUARE*.98),lastMat);
  else m=new THREE.Mesh(new THREE.CircleGeometry(.22*k,32),moveMat);
  m.rotation.x=-Math.PI/2;m.position.set(x,.004+(kind==='last'?0:.002),z);markGroup.add(m);}
 function clearMarks(){for(const m of [...markGroup.children]){m.geometry.dispose();markGroup.remove(m);}}

 const camera=new THREE.PerspectiveCamera(34,1,.1,900);camera.position.set(0,18.5,24.5);
 // Home view: the whole board with its frame fits the stage width; a narrow
 // stage moves the camera back along the same line of sight.
 let moved=false;
 const homeView=()=>{const k=Math.max(1,1.6/camera.aspect);camera.position.set(0,18.5*k,24.5*k);controls.target.set(0,.6,.8);controls.update();};
 const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,.6,.8);controls.maxPolarAngle=1.38;controls.minDistance=3;controls.maxDistance=60;controls.enableDamping=false;controls.update();controls.addEventListener('start',()=>{moved=true;});

 // Embedded textures load through an image element, not fetch(): hosted
 // pages may forbid fetching blob: URLs while still allowing blob: images.
 const loader=new GLTFLoader();
 loader.register(parser=>{parser.textureLoader=new THREE.TextureLoader(parser.options.manager);return{name:'image-element-textures'};});
 const gltf=await new Promise((resolve,reject)=>loader.parse(bytes.buffer,'',resolve,reject));
 const createPawn=createPawnFactory({gltf});

 // Reach measurements on the real skinned model, once.
 const probe=createPawn({id:'probe',color:'w'});
 const thrust=[];for(let t=0;t<=4.0001;t+=.05){const {tip}=probe.probe('Spear_Study',t);thrust.push({t,x:tip[0],z:tip[2]});}
 const peak=thrust.reduce((a,b)=>b.z>a.z?b:a);
 const shield=probe.shieldFront('Shield_Brace',2);
 probe.dispose();
 // A fencing thrust is aimed at the partner's braced shield and stops at
 // its face: yaw offset and clip time for a partner at this distance.
 function fencingAim(distance){
  const cx=-shield.centerX,cz=distance-shield.centerZ;
  const yaw=Math.atan2(cx,cz)-Math.atan2(peak.x,peak.z);
  const limit=Math.hypot(cx,distance-shield.front)-.015;let stop=peak.t;
  for(const s of thrust){if(s.t<1)continue;if(s.t>peak.t)break;if(Math.hypot(s.x,s.z)>limit){stop=Math.max(0,s.t-.05);break;}}
  return{yaw,stop};
 }
 const contact={straight:fencingAim(SQUARE),diagonal:fencingAim(SQUARE*Math.SQRT2)};
 // The capture's thrust is a lunge, so its reach is measured with the
 // strike layer: the tip at the moment of impact in the attacker's frame.
 const lungeProbe=createPawn({id:'probe',color:'w'});
 const lungeTip=lungeProbe.probe('Spear_Study',1.95,strikeLayer()).tip;lungeProbe.dispose();
 const reach={x:lungeTip[0],z:lungeTip[2],height:lungeTip[1]};
 let game,actors=new Map(),yaws=new Map(),eng=new Map(),scene_=null,clock=0,speed=1,selected=null,legal=[],lastMove=null,manual=false,autoTimer=null,frameIndex=0,history=[];
 const byId=id=>game.pieces.find(p=>p.id===id);
 function spawn(piece){
  const actor=piece.type==='p'?createPawn({id:piece.id,color:piece.color}):createToken(piece);
  scene.add(actor.object);actors.set(piece.id,actor);
  const [x,z]=world(piece.square);yaws.set(piece.id,forwardYaw(piece.color));actor.place({x,z,yaw:forwardYaw(piece.color)});
  if(actor.kind==='pawn')actor.pose('Guard_Breath',hash(piece.id)*6);
  return actor;
 }
 function load(name){
  scene_=null;clearTimeout(autoTimer);for(const a of actors.values())a.dispose();actors.clear();yaws.clear();
  game=createGame(PRESETS[name].fen);for(const p of game.pieces)spawn(p);
  selected=null;legal=[];lastMove=null;history=[];refresh();
  $('#hint').textContent=PRESETS[name].hint||'';
  $$('[data-preset]').forEach(b=>b.classList.toggle('active',b.dataset.preset===name));
 }
 function refresh(){
  eng=engagements(game.pieces);
  clearMarks();if(lastMove){mark(lastMove.from,'last');mark(lastMove.to,'last');}
  if(selected){mark(selected,'select');for(const m of legal)mark(m.to,m.captured?'take':'move');}
  $('#status').textContent=game.status();
  const pawnStates=game.pieces.filter(p=>p.type==='p').map(p=>eng.get(p.id).state);
  $('#states').textContent=['fencing','defense','alert','rest'].map(s=>`${STATE_LABELS[s]}: ${pawnStates.filter(x=>x===s).length}`).join(' · ');
  $('#history').textContent=history.length?history.map((m,i)=>(i%2===0?`${Math.floor(i/2)+1}. `:'')+m).join(' '):'Ходов пока нет';
 }

 // Idle presentation of a figure from its relation to enemies.
 function thrustTime(u,stop){if(u<stop)return u;if(u<stop+.3)return stop;return stop*(1-clamp((u-stop-.3)/(4-stop-.3),0,1));}
 function idle(piece,actor,dt,force){
  const e=eng.get(piece.id),target=e?.target?byId(e.target):null;
  const [x,z]=world(piece.square);
  let desired=target?headingTo([x,z],world(target.square)):forwardYaw(piece.color),fence=null;
  // A recorded exchange (motion.duel) drives two pawns fencing each other:
  // body from the recording, spear and shield timed to its blows.
  const line=target?headingTo([x,z],world(target.square)):0,ex=e?.state==='fencing'&&actor.kind==='pawn'&&target.type==='p'?duelExchange(actor,piece,target):null;
  if(ex)desired+=ex.aimYaw;
  else if(e?.state==='fencing'){const q=coords(target.square),p=coords(piece.square);fence=q.file!==p.file&&q.rank!==p.rank?contact.diagonal:contact.straight;
   const f=fencingAction(e.role,clock);if(f.attacking)desired+=fence.yaw*smooth(f.time,.3,1)*(1-smooth(f.time,3,3.8));}
  let yaw=yaws.get(piece.id);const diff=wrapAngle(desired-yaw),step=3.2*dt;
  yaw=Math.abs(diff)<=step?desired:yaw+Math.sign(diff)*step;yaws.set(piece.id,yaw);
  if(ex){const w=motion.weight,[ox,oz]=rotate([ex.offset.x*w,ex.offset.z*w],line);actor.place({x:x+ox,z:z+oz,yaw});
   actor.pose(ex.arms.action,ex.arms.time,null,{...bodyMotion(ex,w,p=>turnHead(p,wrapAngle(line-yaw)),spearArms(ex.arms,ex.points,ex.clip,ex.k,ex.local)),feet:clock});return;}
  actor.place({x,z,yaw});
  if(actor.kind!=='pawn')return;
  // Calm figures are re-posed less often; engaged ones every frame.
  const calm=e.state==='rest'||e.state==='alert';
  if(calm&&!force&&(frameIndex+Math.floor(hash(piece.id)*4))%4!==0)return;
  const offset=hash(piece.id)*6;
  if(e.state==='defense')actor.pose('Shield_Brace',2.05+.7*Math.sin(clock*1.1+offset));
  else if(e.state==='fencing'){
   const f=fencingAction(e.role,clock);
   if(f.attacking)actor.pose('Spear_Study',thrustTime(f.time,fence.stop));
   else actor.pose('Shield_Brace',f.time);
  }else if(motion.stand){const w=motion.weight;actor.pose('Guard_Breath',(clock+offset)%6,scaleLayer(idleLayer(clock,hash(piece.id)),1-w),standMotion(piece,w));}
  else actor.pose('Guard_Breath',(clock+offset)%6,idleLayer(clock,hash(piece.id)));
 }

 // Imported motion clips (mocap/): a stance for figures at rest and a walk
 // for a pawn's step. They are a design aid: without them the board plays
 // its own procedural layer, and the clip share blends the two.
 const motion={sources:[],clips:[],stand:null,walk:null,capture:null,duel:null,weight:1};
 const layouts=new Map();
 // The last exchange each fencing pawn played: whom against, its role and
 // when. A capture between two that were fencing each other goes on from it.
 const fenceStates=new Map();
 // The loadout fitted to the recorded body (exchange.mjs): the spear
 // levelled against the lean, the shield carried over the front knee.
 // The shield is carried over the front knee whoever is thrusting: the
 // attacker carries one too, and its lunge brings the knee up most.
 const fittedArms=(arms,points,clip,k,local,shield)=>arms.action==='Spear_Study'?{phase:levelSpear(loadoutPhases(arms.action,arms.time),trunkLean(points,clip.neutral)),shield}
  :arms.action==='Shield_Brace'?{shield}:undefined;
 const spearArms=(arms,points,clip,k,local)=>fittedArms(arms,points,clip,k,local,{...shieldAt(clip,local,k),raise:shieldRaise(clip,k,local)});
 // Lifting the shield up the trunk does not always clear the knee: in the
 // deepest lunge the front thigh comes up under the shield's lower edge
 // whatever the lift. A fighter then swings the shield arm forwards and up
 // from the shoulder, the lower edge ahead of the knee. How far is measured
 // on the real model: every recorded moment is posed with the clip's own
 // arms and the shield raised in RAISE_STEP steps until no thigh or shin
 // of the figure meets it (RAISE_MAX at most). Like the lift, each moment's
 // raise holds over SHIELD_WINDOW around it, fading to nothing at the edge:
 // the shield comes up before the knee arrives and goes down after it.
 const RAISE_STEP=.1,RAISE_MAX=.8,RAISE_RATE=30;let shieldProbe=null;const raises=new Map();
 const LEGS=[['upperleg01.L','lowerleg01.L'],['lowerleg01.L','foot.L'],['upperleg01.R','lowerleg01.R'],['lowerleg01.R','foot.R'],['foot.L','toe3-1.L'],['foot.R','toe3-1.R']];
 const legsClear=P=>{P.object.updateMatrixWorld(true);const B=Object.fromEntries(Object.entries(P.points(LEGS.flat())).map(([n,v])=>[n,new THREE.Vector3(...v).applyMatrix4(P.object.matrixWorld).toArray()]));return!LEGS.some(([a,b])=>P.shieldHit(B[a],B[b])!==null);};
 // Nor its own spear arm, trunk or spear: a shield swung across the body
 // stops at the arm that holds the spear (the butt a spear's back length
 // behind the grip, as the checks take it).
 const SELF=[['upperarm01.R','lowerarm01.R'],['lowerarm01.R','wrist.R'],['root','spine03'],['spine03','spine05'],['spine05','neck01'],['neck01','head']],BUTT=1.004/1.566;
 const selfClear=P=>{if(!legsClear(P))return false;const B=Object.fromEntries(Object.entries(P.points(SELF.flat())).map(([n,v])=>[n,new THREE.Vector3(...v).applyMatrix4(P.object.matrixWorld).toArray()]));
  if(SELF.some(([a,b])=>P.shieldHit(B[a],B[b])!==null))return false;const w=P.measureWorld(),g=w.weaponGripWorld?.R,t=w.tip;if(!g||!t)return true;
  return P.shieldHit(g.map((x,i)=>x-(t[i]-x)*BUTT),t)===null;};
 // The least raise from `from` up that clears the legs for pose(raise), or RAISE_MAX.
 const leastRaise=(P,pose,from=0)=>{for(let raise=from;raise<=RAISE_MAX+1e-9;raise+=RAISE_STEP){pose(raise);if(legsClear(P))return raise;}return RAISE_MAX;};
 // Carrying a moment's raise over its neighbours can put the lower edge on
 // a foot that is clear lower down (the edge goes forwards as it rises). So
 // each sample is posed again at the carried raise and, where that touches,
 // raised further, until the carried shield clears every sample.
 function measureRaise(clip,k){
  const key=`${clip.name}|${k.toFixed(4)}`;if(raises.has(key))return raises.get(key);
  const P=shieldProbe||(shieldProbe=createPawn({id:'shield-probe',color:'w'})),R=[],poses=[];
  P.place({x:0,z:0,yaw:0});
  for(let i=0;i<=Math.ceil(clip.duration*RAISE_RATE);i++){const t=Math.min(clip.duration,i/RAISE_RATE),arms=exchangeArms(clip,t),points=cyclePose(clip,t,k,1).points,base=shieldAt(clip,t,k);
   const pose=raise=>P.pose(arms.action,arms.time,null,{clip,points,weight:1,arms:fittedArms(arms,points,clip,k,t,{...base,raise})});
   poses.push({t,pose});R.push(leastRaise(P,pose));}
  raises.set(key,R);
  for(let pass=0;pass<4;pass++){let changed=false;
   for(let j=0;j<R.length;j++){const {t,pose}=poses[j],carried=shieldRaise(clip,k,t);if(carried<=R[j]+1e-9)continue;
    pose(carried);if(legsClear(P))continue;const r=leastRaise(P,pose,carried+RAISE_STEP);if(r>R[j]){R[j]=r;changed=true;}}
   if(!changed)break;}
  return R;
 }
 // The board's own walk (choreography.mjs gait) swings the shield-side leg
 // forwards and up under the guard's shield the same way. A walking
 // fighter carries the shield forward over the stride: one raise, measured
 // on the model over a two-square walk the same way (the gait's step does
 // not depend on the distance), leaning into the start and back on braking
 // as far as the walk leans, comes in over the first quarter step and
 // goes down as the figure stops (walkRaise: the share of it at s of D).
 let walkRaiseMax=null;
 function measureWalkRaise(){
  if(walkRaiseMax!==null)return walkRaiseMax;
  const P=shieldProbe||(shieldProbe=createPawn({id:'shield-probe',color:'w'})),D=2*SQUARE;P.place({x:0,z:0,yaw:0});let most=0;
  // Raised further for one moment, the shield is checked again over the whole stride.
  for(let pass=0;pass<4;pass++){const before=most;
   for(let s=.05;s<D;s+=.05)for(const accel of [-4,0,4])most=leastRaise(P,r=>P.pose('Guard_Breath',0,walkLayer(D,s,accel,[0,1],0),{arms:{shield:{raise:r}}}),most);
   if(most===before)break;}
  return walkRaiseMax=most;
 }
 const walkRaise=(D,s,{carried=false}={})=>{const l=D/Math.max(2,Math.round(D/.62));return measureWalkRaise()*(carried?1:smooth(s,0,.25*l))*(1-smooth(s,D-.35*l,D));};
 function shieldRaise(clip,k,t){
  const R=measureRaise(clip,k),dt=1/RAISE_RATE,lo=Math.max(0,Math.ceil((t-SHIELD_WINDOW)/dt)),hi=Math.min(R.length-1,Math.floor((t+SHIELD_WINDOW)/dt));
  // Full within a sample of the moment: between two samples either may be the nearer pose.
  let raise=0;for(let j=lo;j<=hi;j++)raise=Math.max(raise,R[j]*Math.min(1,1-(Math.abs(j*dt-t)-dt)/SHIELD_WINDOW));
  return raise;
 }
 // Exchange fitted to the two squares and to the weapons. The recording's
 // fighters held longswords; a pawn's spear is longer. So the approach is
 // what the spear allows: a fencing thrust comes in to full reach and stops
 // at the partner's braced shield, and the two keep the distance that needs
 // (never closer than the recording, never past their squares); a decisive
 // thrust must reach the trunk at full reach, so the winner comes in exactly
 // as far as that takes (pressing past the recording if need be, never so
 // far that the pelvises come within CLOSEST). The blow is
 // measured on the real model posed as the recording has it at the moment
 // of reach: a fencer's trunk is turned and leans, and the spear hangs from
 // the trunk, so an upright probe would aim beside the partner. The partner
 // is posed the same way at that moment. A decisive thrust goes at the side
 // away from the shield and stops a hand's depth inside the near surface of
 // the trunk (DEPTH), not through it.
 const TRUNK_HALF=.15,OPEN_SIDE=.1,DEPTH=.08,FULL_REACH=1.95,PRESS_MAX=1.6,CLOSEST=1.25;
 const WAY_IN=[...Array(12)].map((_,i)=>+(.25-i*.02).toFixed(3)); // s before the reach, .25 … .03
 let aimProbe=null;const blows=new Map();
 function measureBlow(pair,k){
  const key=`${pair.attack.name}|${k.toFixed(4)}`;if(blows.has(key))return blows.get(key);
  const P=aimProbe||(aimProbe=createPawn({id:'aim-probe',color:'w'})),A=pair.attack,B=pair.defend,r=A.events.strike.reach;
  const pose=(clip,arms,at=r)=>{const points=cyclePose(clip,at,k,1).points;return{clip,points,weight:1,arms:spearArms(arms,points,clip,k,at)};};
  // The thrust holds at its stop for a quarter second after the reach while
  // the partner's shield and body keep coming: the shield is measured over
  // that hold (dS: the pair's approach since the reach, source units).
  const shields=[0,.08,.16,.25].map(d=>{const arms=exchangeArms(B,r+d),sh=P.shieldFront(arms.action,arms.time,pose(B,arms,r+d));
   return{...sh,dS:travelAt(A,r+d).forward+travelAt(B,r+d).forward-travelAt(A,r).forward-travelAt(B,r).forward};});
  const defence=exchangeArms(B,r),shield=shields[0];
  P.pose(defence.action,defence.time,null,pose(B,defence));
  const {root,spine05}=P.points(['root','spine05']),axis=root.map((x,i)=>(x+spine05[i])/2);
  const sweep=[];for(let t=1;t<=2.2001;t+=.05){const arms={action:'Spear_Study',time:t},{tip,grip}=P.probe(arms.action,t,null,pose(A,arms));sweep.push({t,x:tip[0],z:tip[2],R:Math.hypot(tip[0],tip[2]),tip,grip});}
  const full=sweep.find(s=>s.t>=FULL_REACH-1e-9),travel=travelAt(A,r).forward+travelAt(B,r).forward;
  // The partner as it stands over the hold, for the shaft against its shield.
  const partner=[0,.08,.16,.25].map(d=>{const arms=exchangeArms(B,r+d);return{arms,motion:pose(B,arms,r+d)};});
  // And as it takes the blow, the way the board shows it: the fencing stops
  // at the hit (the clip holds its frame at the reach) and gives way to the
  // stock guard over a third of a second while victimHitLayer drives the
  // body back and folds it over the blow, struck from straight ahead. The
  // attacker fences on meanwhile: from a quarter second after the reach its
  // trunk lets go of the thrust's line and the aim eases off (holdThrust,
  // aimOf), so its own shaft then, and how far it has come on (dS), are
  // measured too.
  const struck=[.02,.04,.06,.08,.1,.12,.19,.26,.33,.4,.5,.6].map(d=>{const arms=exchangeArms(B,r),armsA=exchangeArms(A,r+d,{stop:FULL_REACH}),{tip,grip}=P.probe(armsA.action,armsA.time,null,pose(A,armsA,r+d));
   return{d,shaft:[grip,tip],dS:travelAt(A,r+d).forward-travelAt(A,r).forward,yawScale:1-smooth(d,.25,.95),poses:[{arms,motion:{...pose(B,arms,r),weight:1-smooth(d,...STRUCK_LET)},layer:victimHitLayer(d,[0,-1])}]};});
  // The way in, from a fifth of a second before the reach on: the
  // thrust's own shaft (the attacker's trunk still turning onto it, the spear
  // not yet out) against the partner then, the two that much further apart.
  const pairTravel=t=>travelAt(A,t).forward+travelAt(B,t).forward;
  // The tip sweeps round to its line on the way in (up to a quarter metre a
  // frame across the shield's edge), so the way in is sampled finer than a
  // frame: a shaft clear at every other frame can still cross the edge.
  // The arms on the way in follow the thrust's stop (exchangeArms), so the
  // shaft is measured for the stop the aim takes, as the board will pose it.
  const ways=new Map();
  const approach=(stop=FULL_REACH)=>{const key=stop.toFixed(3);if(!ways.has(key))ways.set(key,WAY_IN.map(d=>{const armsA=exchangeArms(A,r-d,{stop}),{tip,grip}=P.probe(armsA.action,armsA.time,null,pose(A,armsA,r-d)),arms=exchangeArms(B,r-d);
   return{shaft:[grip,tip],dS:pairTravel(r)-pairTravel(r-d),poses:[{arms,motion:pose(B,arms,r-d)}]};}));return ways.get(key);};
  // Both at any moment after the reach, for the thrust pressed on the shield
  // (pressOn): the partner as it stands, and the attacker's shaft for a
  // Spear_Study time, the attacker's trunk as the recording has it then.
  const after=t=>{const arms=exchangeArms(B,t);return{partner:[{arms,motion:pose(B,arms,t)}],
   shaft:u=>{const arms={action:'Spear_Study',time:u},{tip,grip}=P.probe(arms.action,u,null,pose(A,arms,t));return[grip,tip];},dS:pairTravel(t)-pairTravel(r)};};
  const m={shield,shields,axis,sweep,full,travel,k,partner,struck,approach,after,pairTravel,r};blows.set(key,m);return m;
 }
 // Where the thrust goes at a gap (pelvis to pelvis at the reach): the aim
 // point and how far the tip may come out (attacker's frame, z forward).
 function blowTarget(m,gap,flesh,scale=1,open=null){
  const cx=-m.shield.centerX;
  if(!flesh)return{aim:[cx,gap-m.shield.centerZ],limit:Math.min(...m.shields.map(s=>Math.hypot(-s.centerX,gap-scale*m.k*s.dS-s.front)))-.015};
  const ax=-m.axis[0],az=gap-m.axis[2],side=Math.sign(ax-cx)||1,aim=[ax+(open??side*OPEN_SIDE),az-TRUNK_HALF+DEPTH];
  return{aim,limit:Math.hypot(...aim)};
 }
 function blowAim(m,gap,flesh,scale=1,open=null){
  const {aim,limit}=blowTarget(m,gap,flesh,scale,open);let stop=FULL_REACH;
  for(const s of m.sweep){if(s.t>FULL_REACH+1e-9)break;if(s.R>limit){stop=Math.max(1,s.t-.05);break;}}
  const at=m.sweep.find(s=>s.t>=stop-1e-9);
  return{yaw:Math.atan2(aim[0],aim[1])-Math.atan2(at.x,at.z),stop,target:aim,tip:[at.x,at.z],limit,over:Math.max(0,m.sweep[0].R-limit),short:Math.max(0,limit-at.R),shaft:[at.grip,at.tip]};
 }
 // A decisive thrust goes where the partner's shield is not: the shaft
 // (grip to tip, turned onto the aim) is laid against the partner posed over
 // the hold at the gap, and the first opening of the trunk it clears is
 // taken, the side away from the shield first, nearest the middle first.
 // Partner frame: it stands gap ahead, facing back (x, z → −x, gap − z).
 function shaftClear(m,gap,a,swing=0,poses=m.partner,shaft=a.shaft){
  const c=Math.cos(a.yaw),n=Math.sin(a.yaw),toB=([x,y,z])=>{const X=x*c+z*n,Z=z*c-x*n;return[-X,y,gap-Z];};
  if(!shaft[0])return true;const from=toB(shaft[0]),to=toB(shaft[1]),P=aimProbe;P.place({x:0,z:0,yaw:0});
  const turn=typeof swing==='number'?{swing}:swing,with_=sh=>{const o={...sh};for(const [key,v] of Object.entries(turn))o[key]=(key==='swing'?0:(o[key]||0))+v;return o;};
  return poses.every(({arms,motion,layer=null})=>{P.pose(arms.action,arms.time,layer,{...motion,arms:{...motion.arms,shield:with_(motion.arms?.shield||{})}});P.object.updateMatrixWorld(true);return P.shieldHit(from,to)===null&&(!turn.swing||selfClear(P));});
 }
 // A braced tower shield covers the whole trunk: there is no opening at the
 // moment of the blow unless the shield has gone the wrong way. That is how
 // the defender loses the exchange: it answers the attacker's line late and
 // wide, the shield swung out from the body (loadout swing, about the
 // trunk's up axis), and the thrust goes into the opening. The swing is the
 // least that opens a line for the shaft (SWING_STEP up to SWING_MAX).
 const OPENINGS=[.1,.14,.18,.06],SWING_STEP=.15,SWING_MAX=1.35;
 function openAim(m,gap,scale){
  const cx=-m.shield.centerX,ax=-m.axis[0],side=Math.sign(ax-cx)||1;
  let first=null;
  for(let swing=0;swing<=SWING_MAX+1e-9;swing+=SWING_STEP)for(const w of swing?[swing,-swing]:[0])
   for(const s of [side,-side])for(const o of OPENINGS){const a=blowAim(m,gap,true,scale,s*o);
    if(!shaftClear(m,gap,a,w)||!m.approach(a.stop).every(q=>shaftClear(m,gap+scale*m.k*q.dS,a,w,q.poses,q.shaft)))continue;
    const g=struckSwing(m,gap,a,w,scale),found={...a,open:s*o,swing:w,struckSwing:g};if(g.clear)return found;first??=found;}
  return first||{...blowAim(m,gap,true,scale),open:null,swing:0,struckSwing:{swing:0,lift:0,reach:0,raise:0}};
 }
 // Struck, the defender folds over the blow and its shield arm is thrown:
 // up at the shoulder (raise), on out of the way or back the other way, down
 // the trunk with the elbow opening (lift, reach) — the least of that which
 // keeps the shield off the held shaft and off its own spear arm, trunk,
 // legs and spear (selfClear). The arm is thrown over STRUCK_IN after the
 // hit (fitArms), measured on the way too; the fencing gives way to the stock
 // guard over STRUCK_LET, on the board as here.
 const STRUCK_LET=[.05,.35],STRUCK_IN=.12,DROPS=[[0,0],[-.1,.2],[-.2,.35],[-.3,.5],[-.4,.7]],SINKS=[0,.3,.6,.9,1.2,1.5,-.3,-.6];
 function struckSwing(m,gap,a,swing,scale=1){
  const dir=Math.sign(swing)||1,clear=g=>m.struck.every(q=>{const u=smooth(q.d,0,STRUCK_IN),turn={swing:swing+(g.swing-swing)*u||1e-6,lift:g.lift*u,reach:g.reach*u,raise:g.raise*u};
   return shaftClear(m,gap-scale*m.k*q.dS,{...a,yaw:a.yaw*q.yawScale},turn,q.poses,q.shaft);});
  for(const raise of SINKS)for(const [lift,reach] of DROPS)for(const d of [dir,-dir])for(let w=d===dir?Math.abs(swing):0;w<=SWING_MAX+1e-9;w+=SWING_STEP)
   if(clear({swing:d*w,lift,reach,raise}))return{swing:d*w,lift,reach,raise,clear:true};
  return{swing:dir*SWING_MAX,lift:DROPS.at(-1)[0],reach:DROPS.at(-1)[1],raise:0,clear:false};
 }
 // The full thrust aimed at the partner's shield centre at a gap.
 function fullAim(m,gap){
  const cx=-m.shield.centerX,aim=[cx,gap-m.shield.centerZ],at=m.full;
  return{yaw:Math.atan2(aim[0],aim[1])-Math.atan2(at.x,at.z),stop:FULL_REACH,target:aim,tip:[at.x,at.z],limit:Math.hypot(...aim),over:0,short:0,shaft:[at.grip,at.tip]};
 }
 // The gap at which the full thrust, aimed at the shield, just meets the
 // partner's shield as it stands at the reach (the least gap at which the
 // shaft is clear of it, bisection).
 const CONTACT=.02,STEP_DOWN=.3;
 function shieldGap(m,distance){
  const clear=g=>shaftClear(m,g,fullAim(m,g),0,[m.partner[0]]);
  let lo=.5,hi=distance;if(!clear(hi))return null;
  for(let i=0;i<30;i++){const g=(lo+hi)/2;if(clear(g))hi=g;else lo=g;}
  return hi;
 }
 // The thrust pressed on the shield: from the reach on the pair still closes
 // (the defender comes on behind the shield) and the attacker's arm gives
 // way, so the point stays on the shield, CONTACT off its surface, instead of
 // going into it; when the recovery draws the spear back further, it goes
 // back. Measured on the posed shield every half frame (60 Hz): the latest Spear_Study
 // time on the thrust (1 drawn back … FULL_REACH) whose shaft, CONTACT
 // longer, is clear of the shield. [[local time, Spear_Study time], …].
 const PRESS_FOR=1.35;
 function pressOn(m,l,aim){
  const out=[],steps=Math.round(PRESS_FOR*60);
  for(let i=0;i<=steps;i++){const t=m.r+i/60,q=m.after(t),gap=l.gapAt(t),a={...aim,yaw:aim.yaw*(1-smooth(t,m.r+.25,m.r+.95))};
   const clear=u=>{const [g,tip]=q.shaft(u);if(!g)return true;const d=tip.map((x,j)=>x-g[j]),n=Math.hypot(...d)||1;
    return shaftClear(m,gap,a,0,q.partner,[g,tip.map((x,j)=>x+d[j]/n*CONTACT)]);};
   let u=FULL_REACH;if(!clear(u)){let lo=1,hi=FULL_REACH;for(let k=0;k<8;k++){const c=(lo+hi)/2;if(clear(c))lo=c;else hi=c;}u=lo;}
   out.push([+t.toFixed(4),+u.toFixed(4)]);}
  return out;
 }
 function duelLayout(pair,k,distance,flesh=false){
  const key=`${pair.attack.name}|${k.toFixed(4)}|${distance.toFixed(3)}|${flesh}`;
  if(!layouts.has(key)){
   const base=exchangeLayout(pair,k,distance),m=measureBlow(pair,k),r=pair.attack.events.strike.reach,S=m.travel*k;
   // The gap at which the full thrust just meets its target (the limit grows
   // with the gap), and the approach scale that gives it: the gap at the
   // reach is distance − scale·S.
   let lo=0,hi=distance;for(let i=0;i<40;i++){const g=(lo+hi)/2;if(blowTarget(m,g,flesh,base.scale).limit>m.full.R)hi=g;else lo=g;}
   // A fencing thrust is fitted to the shield itself: the gap at which the
   // full thrust's shaft, aimed at the shield, meets the partner's shield at
   // the reach. The shield's foremost point (blowTarget) is its rim, not
   // where the spear meets it, so a fit to it left the thrust 0.6 m short of
   // the shield, in the air, and the brace met nothing (pair_check.py, rule
   // place). Over the hold the pair still closes; the spear gives way by as
   // much (aim.press), so the tip stays on the shield.
   // The shield meets the thrust at the recorded answer (events.parry.at),
   // and not before the step that carries the thrust is down (a plant of the
   // attacker's feet begun within STEP_DOWN after the recorded reach,
   // events.plants): the blow lands with the step, on a standing foot
   // (pair_check.py, rule footing). The approach is scaled so that the pair
   // is that gap apart then.
   const steps=Object.values(pair.attack.events?.plants||{}).flat().map(([a])=>a).filter(a=>a>r&&a<=r+STEP_DOWN);
   // The closing holds until the exchange is over and is then given back
   // by a step out before the cycle ends (approachAt): the next cycle starts
   // where the squares' fit starts it, so no foot is dragged back.
   const meet=Math.max(pair.defend.events?.parry?.at??r,...steps),Smeet=m.pairTravel(meet)*k,fit=flesh?null:shieldGap(m,distance);
   const cycleEnd=Math.min(pair.attack.duration,pair.defend.duration)-CROSSFADE;
   const closing=w=>fit!=null&&w>base.scale?{base:base.scale,more:w-base.scale,meet,back:[Math.min(meet+.6,cycleEnd-.3),cycleEnd]}:w;
   let want=clamp(fit!=null&&Smeet>1e-6?(distance-(fit+CONTACT))/Smeet:S>1e-6?(distance-(lo+hi)/2)/S:base.scale,0,PRESS_MAX);
   while(want>base.scale&&exchangeLayout(pair,k,distance,closing(want)).closest<CLOSEST)want-=.02;
   const scale=closing(want);
   const l=exchangeLayout(pair,k,distance,scale),gap=l.gapAt(r);
   let aim;
   if(flesh)aim=openAim(m,gap,scale);
   else if(fit!=null){aim=fullAim(m,gap);aim.press=pressOn(m,l,aim);const c=aim.press.find(([,u])=>u<FULL_REACH-1e-3);aim.contact=c?c[0]:null;aim.short=c?0:Math.max(0,l.gapAt(meet)-fit);}
   else aim=blowAim(m,gap,flesh,scale);
   layouts.set(key,{...l,gap,aim});
  }
  return layouts.get(key);
 }
 const duelInfo=new Map();
 function duelExchange(actor,piece,target){
  const pair=motion.duel?.exchange;if(!pair)return null;
  const k=actor.mocap.retarget.leg/pair.attack.leg,[x,z]=world(piece.square),[tx,tz]=world(target.square);
  const l=duelLayout(pair,k,Math.hypot(tx-x,tz-z)),role=eng.get(piece.id).role;
  const ex=exchangeAt(pair,role,clock,k,l.scale),s=ex.clip.events.strike;
  fenceStates.set(piece.id,{target:target.id,role,clock});
  duelInfo.set(piece.id,{side:ex.side,cycle:ex.cycle,local:+ex.local.toFixed(3),clock:+clock.toFixed(3),gap:+l.gap.toFixed(3),scale:typeof l.scale==='number'?+l.scale.toFixed(3):+(l.scale.base+l.scale.more).toFixed(3),stop:+l.aim.stop.toFixed(3),limit:+l.aim.limit.toFixed(3),short:+l.aim.short.toFixed(3),contact:l.aim.contact??null});
  const aimYaw=ex.side==='attack'?l.aim.yaw*smooth(ex.local,s.start-.25,s.reach)*(1-smooth(ex.local,s.reach+.25,s.reach+.95)):0;
  return{...ex,k,aimYaw,arms:exchangeArms(ex.clip,ex.local,ex.side==='attack'?{stop:l.aim.stop,press:l.aim.press,reach:l.aim.contact}:{})};
 }
 const pingpong=(t,d)=>{if(!(d>0))return 0;const u=t%(2*d);return u<d?u:2*d-u;};
 function standMotion(piece,weight){
  const c=motion.stand,t=clock+hash(piece.id)*c.duration;
  return{clip:c,time:c.loop?t%c.duration:pingpong(t,c.duration),inPlace:true,weight};
 }
 function walkMotion(actor,piece,D,s,dir,yaw){
  const w=motion.weight,c=motion.walk,k=actor.mocap.retarget.leg/c.leg;
  const share=w*smooth(s,0,.35)*(1-smooth(s,D-.35,D)),blend=[];
  if(motion.stand)blend.push(standMotion(piece,w));
  // The clip walks along its own +Z; turn it onto the path in the figure's frame.
  const [lx,lz]=rotate(dir,-yaw),turn=Math.atan2(lx,lz),points=sampleAlong(c,s/k).points;
  for(const p of Object.keys(points))points[p]=rotateY(points[p],turn);
  blend.push({clip:c,points,weight:share});
  return{blend,share};
 }

 // Scenes for a played move. Each part is an absolute function of time.
 // A pawn walks to its square: steps with planted feet, a lean into the
 // start and back on braking. Other figures are stand-ins and glide.
 function slidePart(actor,piece,from,to){
  const a=world(from),b=world(to),squaresMoved=Math.max(Math.abs(coords(from).file-coords(to).file),Math.abs(coords(from).rank-coords(to).rank));
  const pawn=actor.kind==='pawn',D=Math.hypot(b[0]-a[0],b[1]-a[1]),dir=[(b[0]-a[0])/D,(b[1]-a[1])/D];
  const duration=pawn?1.1+.7*squaresMoved:.55+.3*squaresMoved,knight=piece.type==='n',startYaw=yaws.get(piece.id),heading=headingTo(a,b),endYaw=forwardYaw(piece.color);
  return{duration,update(t){
   if(pawn){const m=travel(D,t,0,duration);actor.place({x:a[0]+dir[0]*m.s,z:a[1]+dir[1]*m.s,yaw:startYaw});yaws.set(piece.id,startYaw);
    const layer=walkLayer(D,m.s,m.accel,dir,startYaw);
    const arms={shield:{raise:walkRaise(D,m.s)}};
    if(motion.walk){const mm=walkMotion(actor,piece,D,m.s,dir,startYaw);actor.pose('Guard_Breath',(clock+hash(piece.id)*6)%6,scaleLayer(layer,1-mm.share),{...mm,arms});}
    else actor.pose('Guard_Breath',(clock+hash(piece.id)*6)%6,layer,{arms});return;}
   const u=smooth(t,0,duration);const yaw=t<duration*.7?lerpAngle(startYaw,heading,smooth(t,0,.25)):lerpAngle(heading,endYaw,smooth(t,duration*.7,duration));
   actor.place({x:a[0]+(b[0]-a[0])*u,z:a[1]+(b[1]-a[1])*u,yaw,lift:knight?1.1*Math.sin(Math.PI*u):0});yaws.set(piece.id,yaw);},finish(){}};
 }
 function pawnCapturePart(attacker,attackerPiece,victim,event){
  const plan=planCapture({from:world(event.from),to:world(event.victimSquare),end:world(event.to),attackerYaw:yaws.get(attackerPiece.id),victimYaw:yaws.get(victim.id),reach});
  // A capture pair from a file replaces both bodies (arms stay with the
  // loadout, on the same timeline). Pawns take diagonally, so the pair is
  // authored for one geometry: attacker at the origin facing the defender
  // one diagonal square ahead. En passant keeps the procedural scene.
  // A recorded exchange with a decisive cycle (motion.duel) plays the
  // capture as a duel the taken pawn loses; it comes before the clip pair.
  if(motion.duel?.decisive&&event.victimSquare===event.to&&victim.kind==='pawn')return duelCapturePart(attacker,attackerPiece,victim,event);
  const pair=motion.capture&&event.victimSquare===event.to&&victim.kind==='pawn'?captureClips():null;
  if(pair)return clipCapturePart(attacker,attackerPiece,victim,plan,pair);
  return{duration:CAPTURE_DURATION,plan,update(t){
   const s=captureAt(plan,t);
   attacker.place({x:s.attacker.position[0],z:s.attacker.position[1],yaw:s.attacker.yaw});attacker.pose(s.attacker.action,s.attacker.time,s.attacker.layer);yaws.set(attackerPiece.id,s.attacker.yaw);
   if(!s.victim.removed){victim.place({x:s.victim.position[0],z:s.victim.position[1],yaw:s.victim.yaw,fall:s.victim.fall,fallHeading:s.victim.fallHeading});if(victim.kind==='pawn')victim.pose(s.victim.action,s.victim.time,s.victim.layer);victim.fade(s.victim.opacity);}
   victim.object.visible=!s.victim.removed;
   $('#phase').textContent=CAPTURE_PHASES.filter(p=>s.phase.includes(p.name)).map(p=>p.label).join(' · ');
  },finish(){victim.dispose();actors.delete(victim.id);}};
 }
 // A capture as a won duel, from a recorded bout (motion.duel). The two
 // stay on their squares and exchange: if they were already fencing each
 // other, the cycle under way plays out (the scene starts from the very
 // pose they were in); otherwise one full cycle, the defender striking and
 // the attacker answering with the shield, the recording faded in over the
 // stance. Then the recording's decisive cycle: the attacker's blow comes in
 // past a shield raised too late and lands; the defender is jolted, buckles
 // and falls along the blow and leaves the board; the attacker comes back to
 // guard and steps onto the square. Without the plain exchange in the file
 // the scene starts with the decisive cycle.
 function duelCapturePart(attacker,attackerPiece,victim,event){
  const {exchange,decisive}=motion.duel,a=world(event.from),v=world(event.victimSquare),end=world(event.to),D=Math.hypot(v[0]-a[0],v[1]-a[1]);
  const line=headingTo(a,v),back=line+Math.PI,dir=[(v[0]-a[0])/D,(v[1]-a[1])/D],startYaw=yaws.get(attackerPiece.id),victimYaw=yaws.get(victim.id);
  const k=attacker.mocap.retarget.leg/decisive.attack.leg,first=exchange?duelLayout(exchange,k,D):null,last=duelLayout(decisive,k,D,true);
  const L=first?Math.min(exchange.attack.duration,exchange.defend.duration)-CROSSFADE:0,c0=clock,mw=motion.weight;
  const sa=fenceStates.get(attackerPiece.id),sv=fenceStates.get(victim.id);
  const going=!!first&&sa?.target===victim.id&&sv?.target===attackerPiece.id&&sa.clock===c0&&sv.clock===c0;
  // The lead-in before the decisive cycle: what is left of the cycle under
  // way, or one whole cycle the defender opens.
  const T=going?L-(c0-Math.floor(c0/L)*L):L,fadeIn=t=>going?1:smooth(t,0,.4);
  const lead=going?(role=>t=>{const e=exchangeAt(exchange,role,c0+t,k,first.scale);return{clip:e.clip,local:e.local,points:e.points,cur:e.cur,offset:e.offset,fade:e.fade};})
   :(clip=>t=>({clip,local:t,...cyclePose(clip,t,k,first.scale)}));
  const leadA=first?lead(going?sa.role:exchange.defend):null,leadV=first?lead(going?sv.role:exchange.attack):null;
  const blow=decisive.attack.events.strike,hit=T+blow.reach;
  const settle=hit+.5,walkAt=hit+1.15,gone=hit+1.6;
  // Body of one fighter: the lead-in, then the decisive cycle, its first
  // CROSSFADE seconds blended from the lead-in's tail.
  const body=(leadOf,lastClip,t)=>{
   if(first&&t<T)return{...leadOf(t),layout:first};
   const u=t-T,cur=cyclePose(lastClip,u,k,last.scale);
   if(!first||u>=CROSSFADE)return{clip:lastClip,local:u,layout:last,...cur};
   const end=leadOf(T-1e-6),tail=cyclePose(end.clip,end.local+u,k,first.scale),w=smooth(u,0,CROSSFADE),points={};
   for(const n of Object.keys(cur.points))points[n]=cur.points[n].map((x,i)=>tail.points[n][i]+(x-tail.points[n][i])*w);
   return{clip:lastClip,local:u,layout:last,points,cur:cur.points,fade:{clip:end.clip,points:tail.points,u:w},offset:{x:tail.offset.x+(cur.offset.x-tail.offset.x)*w,z:tail.offset.z+(cur.offset.z-tail.offset.z)*w},tail:{clip:end.clip,local:end.local+u}};
  };
  // A thrust into an opening is laid on its line before it goes out: the
  // decisive aim is taken while the spear is drawn back, not on the way in.
  const aimOf=b=>{const s=b.clip.events.strike,on=b.clip.decisive?s.start+.6*(s.reach-s.start):s.reach;return b.clip.side==='attack'?b.layout.aim.yaw*smooth(b.local,s.start-.25,on)*(1-smooth(b.local,s.reach+.25,s.reach+.95)):0;};
  // While the lead-in blends into the decisive cycle the legs are between
  // the two, and so is the shield: it is carried for whichever needs more.
  // The defender who loses answers the decisive line late and wide: its
  // shield swings out of the way as the thrust comes (openAim), so the
  // blow goes into the opening instead of through the shield.
  const fitArms=(arms,b,after=0)=>{const f=spearArms(arms,b.points,b.clip,k,b.local);if(f?.shield&&b.tail)f.shield.raise=Math.max(f.shield.raise,shieldRaise(b.tail.clip,k,b.tail.local));
   const sw=b.layout?.aim?.swing,s=b.clip.events?.strike;if(f?.shield&&sw&&b.clip.side==='defend'&&b.clip.decisive&&s){const g=b.layout.aim.struckSwing,u=smooth(b.local+after,s.reach,s.reach+STRUCK_IN);
    f.shield.swing=sw*smooth(b.local,s.start,s.start+.6*(s.reach-s.start))+(g.swing-sw)*u;f.shield.lift=(f.shield.lift||0)+g.lift*u;f.shield.reach=(f.shield.reach||0)+g.reach*u;f.shield.raise=(f.shield.raise||0)+(g.raise||0)*u;}
   return f;};
  const armsOf=b=>exchangeArms(b.clip,b.local,b.clip.side==='attack'?{stop:b.layout.aim.stop,press:b.layout.aim.press,reach:b.layout.aim.contact}:{});
  const at=(p,o,heading,w)=>{const [x,z]=rotate([o.x*w,o.z*w],heading);return{x:p[0]+x,z:p[1]+z};};
  let stand=null,walk=null;
  return{duration:walkAt+1.1+.7*D/SQUARE,update(t){
   // Attacker: the duel on its square, back to guard, then the step in.
   if(t<walkAt){
    const b=body(leadA,decisive.attack,Math.min(t,settle)),f=fadeIn(t)*mw,w=f*(1-smooth(t,settle,walkAt));
    const yaw=lerpAngle(startYaw,line+aimOf(b),smooth(t,0,.4)),o=at(a,b.offset,line,f);
    if(t>=settle&&!stand)stand=o;
    const arms=armsOf(b);
    attacker.place({...(stand||o),yaw});yaws.set(attackerPiece.id,yaw);
    // Back to guard, the shield comes over to the walk's carry.
    const fitted=fitArms(arms,b);if(fitted?.shield)fitted.shield.raise=Math.max(fitted.shield.raise,measureWalkRaise()*smooth(t,settle,walkAt));
    attacker.pose(arms.action,arms.time,null,{...bodyMotion(b,w,p=>turnHead(p,wrapAngle(line-yaw)),fitted),feet:clock});
   }else{
    if(!walk){const from=stand?[stand.x,stand.z]:a,L=Math.hypot(end[0]-from[0],end[1]-from[1]);walk={from,L,dir:[(end[0]-from[0])/L,(end[1]-from[1])/L],T:1.1+.7*D/SQUARE};}
    const m=travel(walk.L,t-walkAt,0,walk.T),yaw=line;
    attacker.place({x:walk.from[0]+walk.dir[0]*m.s,z:walk.from[1]+walk.dir[1]*m.s,yaw});yaws.set(attackerPiece.id,yaw);
    const layer=walkLayer(walk.L,m.s,m.accel,walk.dir,yaw);
    const arms={shield:{raise:walkRaise(walk.L,m.s,{carried:true})}};
    if(motion.walk){const mm=walkMotion(attacker,attackerPiece,walk.L,m.s,walk.dir,yaw);attacker.pose('Guard_Breath',(clock)%6,scaleLayer(layer,1-mm.share),{...mm,arms});}
    else attacker.pose('Guard_Breath',clock%6,layer,{arms});
   }
   // Defender: fences on, then is struck by the decisive blow and falls.
   const removed=t>=gone;victim.object.visible=!removed;
   if(!removed){
    const b=body(leadV,decisive.defend,Math.min(t,hit)),f=fadeIn(t)*mw,w=f*(1-smooth(t-hit,...STRUCK_LET)),tau=t-hit;
    const yaw=lerpAngle(victimYaw,back+aimOf(b),smooth(t,0,.4)),o=at(v,b.offset,back,f),fallU=clamp((t-hit-.3)/.6,0,1);
    victim.place({...o,yaw,fall:1.47*fallU*fallU,fallHeading:line});
    const arms=armsOf(b);
    victim.pose(arms.action,arms.time,tau>0?victimHitLayer(tau,rotate(dir,-yaw)):null,{...bodyMotion(b,w,p=>turnHead(p,wrapAngle(back-yaw)),fitArms(arms,b,Math.max(0,tau))),feet:clock});
    victim.fade(1-smooth(t,hit+1.1,gone));
   }
   $('#phase').textContent=t<T?(going?'обмен ударами':'обмен: защитник атакует'):t<hit?'обмен: решающий удар':t<gone?'защитник проиграл схватку':'занятие клетки';
  },finish(){victim.dispose();actors.delete(victim.id);}};
 }
 function captureClips(){const a=motion.capture,v=motion.clips.find(c=>c.name===a.partner&&c.role==='struck');return v?{a,v}:null;}
 function clipCapturePart(attacker,attackerPiece,victim,plan,{a,v}){
  const line=headingTo(plan.from,plan.to),attackerYaw=plan.attackerYaw,victimYaw=plan.victimYaw;
  // Holder at the clip's pelvis, turned onto the line of attack: turning a
  // holder then turns the figure about its own pelvis, feet included.
  // While the holder is still turning onto the line, the head leads: it is
  // turned by what the holder has left to turn, so the eyes stay on the other
  // figure as in the clip (the attacker's turn back after the scene is its own).
  // At the move's start the head comes round onto the other figure over the
  // first quarter second (HEAD_FIND) instead of snapping there in one frame.
  const put=(actor,clip,t,yaw,extra={},lead=true)=>{
   const k=actor.mocap.retarget.leg/clip.leg,p=sampleClip(clip,t),[x,z]=rotate([p.pelvis[0]*k,p.pelvis[2]*k],line);
   actor.place({x:plan.from[0]+x,z:plan.from[1]+z,yaw,...extra});
   return{clip,points:turnHead(centerPoints(p),lead?wrapAngle(line-yaw)*smooth(t,0,HEAD_FIND):0),weight:1,arms:sampleArms(clip,t)};
  };
  // A pair that times its own arms (spear phases, shield turn) plays them;
  // one without keeps the board's action timing.
  const pose=(actor,m,action,time)=>actor.pose(m.arms?m.arms.action:action,m.arms?0:time,null,m);
  return{duration:CAPTURE_DURATION,plan,update(t){
   const s=captureAt(plan,t);
   const aYaw=t<2.5?lerpAngle(attackerYaw,line,smooth(t,0,.5)):lerpAngle(line,attackerYaw,smooth(t,5.7,6.6));
   pose(attacker,put(attacker,a,t,aYaw,{},t<2.5),s.attacker.action,s.attacker.time);yaws.set(attackerPiece.id,aYaw);
   // The struck clip may time the victim's fade itself (it ends its collapse).
   const removed=v.fade?t>=v.fade[1]:s.victim.removed,opacity=v.fade?1-smooth(t,v.fade[0],v.fade[1]):s.victim.opacity;
   if(!removed){
    // The clip faces the defender back along the line; the holder adds the
    // turn from its own heading at the start.
    const want=lerpAngle(victimYaw,line+Math.PI,smooth(t,.4,1.1)),vYaw=line+wrapAngle(want-line-Math.PI);
    // A clip with its own arms also carries the collapse; the board's rigid
    // fall is only for a pair that leaves it out.
    const m=put(victim,v,t,vYaw,v.arms?{}:{fall:s.victim.fall,fallHeading:s.victim.fallHeading});
    pose(victim,m,s.victim.action,s.victim.time);victim.fade(opacity);
   }
   victim.object.visible=!removed;
   $('#phase').textContent=CAPTURE_PHASES.filter(p=>s.phase.includes(p.name)).map(p=>p.label).join(' · ');
  },finish(){victim.dispose();actors.delete(victim.id);}};
 }
 function genericCapturePart(attacker,attackerPiece,victim,event){
  const a=world(event.from),v=world(event.victimSquare),end=world(event.to),d=Math.hypot(v[0]-a[0],v[1]-a[1]),dir=[(v[0]-a[0])/d,(v[1]-a[1])/d];
  const stop=[v[0]-dir[0]*SQUARE*.62,v[1]-dir[1]*SQUARE*.62],travel=headingTo(a,v),startYaw=yaws.get(attackerPiece.id),endYaw=forwardYaw(attackerPiece.color),victimYaw=yaws.get(victim.id);
  const approach=.45+.18*d/SQUARE,knight=attackerPiece.type==='n',duration=approach+2.1;
  return{duration,update(t){
   const u=smooth(t,0,approach),w=smooth(t,approach+1.3,approach+2);
   const x=t<approach+1.3?a[0]+(stop[0]-a[0])*u:stop[0]+(end[0]-stop[0])*w,z=t<approach+1.3?a[1]+(stop[1]-a[1])*u:stop[1]+(end[1]-stop[1])*w;
   const yaw=t<approach+1.5?lerpAngle(startYaw,travel,smooth(t,0,.25)):lerpAngle(travel,endYaw,smooth(t,approach+1.5,duration));
   attacker.place({x,z,yaw,lift:knight&&t<approach?1.1*Math.sin(Math.PI*u):0});yaws.set(attackerPiece.id,yaw);
   if(attacker.kind==='pawn')attacker.pose('Guard_Breath',(clock)%6);
   const fallU=clamp((t-approach-.4)/.6,0,1);
   victim.place({x:v[0],z:v[1],yaw:victimYaw,fall:1.47*fallU*fallU,fallHeading:travel});
   if(victim.kind==='pawn')victim.pose('Shield_Brace',1.2,victimHitLayer(t-approach,rotate(dir,-victimYaw)));
   victim.fade(1-smooth(t,approach+1.1,approach+1.6));victim.object.visible=t<approach+1.6;
   $('#phase').textContent=t<approach?'сближение':t<approach+1?'удар':t<approach+1.6?'фигура снята с доски':'занятие клетки';
  },finish(){victim.dispose();actors.delete(victim.id);}};
 }
 function play(from,to){
  if(scene_||!game)return false;
  const before=new Map(game.pieces.map(p=>[p.id,p]));
  const result=game.play(from,to);if(!result)return false;
  history.push(result.move.san);lastMove={from,to};selected=null;legal=[];
  const parts=[];let promote=null;
  for(const event of result.events){
   if(event.type==='move')parts.push(slidePart(actors.get(event.id),before.get(event.id),event.from,event.to));
   else if(event.type==='capture'){const attackerPiece=before.get(event.attacker),attacker=actors.get(event.attacker),victim=actors.get(event.victim);
    parts.push(attackerPiece.type==='p'?pawnCapturePart(attacker,attackerPiece,victim,event):genericCapturePart(attacker,attackerPiece,victim,event));}
   else if(event.type==='promote')promote=event;
  }
  const duration=Math.max(...parts.map(p=>p.duration));
  const driven=new Set(result.events.flatMap(e=>[e.id,e.attacker,e.victim].filter(Boolean)));
  scene_={t:0,duration,parts,promote,move:result.move,driven};
  clearMarks();mark(from,'last');mark(to,'last');
  $('#status').textContent=`${result.move.san} · ход исполняется`;
  return true;
 }
 function finishScene(){
  const s=scene_;scene_=null;for(const p of s.parts){p.update(Math.min(p.duration,s.duration));p.finish();}
  if(s.promote){const old=actors.get(s.promote.id);old.dispose();actors.delete(s.promote.id);spawn(byId(s.promote.id));}
  for(const p of game.pieces)yaws.set(p.id,yaws.get(p.id)??forwardYaw(p.color));
  $('#phase').textContent='';refresh();
  if($('#auto').checked&&game.chess.turn()==='b'&&!game.chess.isGameOver())autoTimer=setTimeout(autoMove,manual?0:500);
 }
 function autoMove(){
  if(scene_||game.chess.turn()!=='b'||game.chess.isGameOver())return;
  const moves=game.chess.moves({verbose:true}),captures=moves.filter(m=>m.captured);
  const pool=captures.length?captures:moves,m=pool[Math.floor(Math.random()*pool.length)];
  play(m.from,m.to);
 }

 function advance(dt,draw=true){
  frameIndex++;clock+=dt*speed;
  if(scene_){scene_.t+=dt*speed;for(const p of scene_.parts)p.update(Math.min(scene_.t,p.duration));if(scene_.t>=scene_.duration)finishScene();}
  const driven=scene_?.driven||new Set();
  for(const piece of game.pieces){if(driven.has(piece.id))continue;const actor=actors.get(piece.id);if(actor)idle(piece,actor,dt,false);}
  if(draw)renderer.render(scene,camera);
 }
 let last=null;
 // The next frame is requested first, so one failed frame never stops the board.
 let failures=0;
 function loop(now){requestAnimationFrame(loop);if(manual)return;const dt=last===null?0:Math.min(.2,(now-last)/1000);last=now;
  try{advance(dt);}catch(error){if(failures++<3)console.error(error);if(scene_){try{finishScene();}catch{scene_=null;}}}}

 // Picking: figures first, then the square under the pointer.
 const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();
 function squareAt(event){
  const rect=renderer.domElement.getBoundingClientRect();pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
  raycaster.setFromCamera(pointer,camera);
  const figures=[...actors.values()].map(a=>a.object);
  const hit=raycaster.intersectObjects(figures,true)[0];
  if(hit){let o=hit.object;while(o&&!actors.has(o.name))o=o.parent;const piece=o&&byId(o.name);if(piece)return piece.square;}
  const sq=raycaster.intersectObjects(squares,false)[0];return sq?.object.userData.square||null;
 }
 function click(square){
  if(scene_||!square)return;
  if(selected&&legal.some(m=>m.to===square)){play(selected,square);return;}
  const piece=game.pieces.find(p=>p.square===square);
  if(piece&&piece.color===game.chess.turn()&&!game.chess.isGameOver()){selected=square;legal=game.legal(square);}else{selected=null;legal=[];}
  refresh();
 }
 let down=null;
 renderer.domElement.addEventListener('pointerdown',e=>{down=[e.clientX,e.clientY];});
 renderer.domElement.addEventListener('pointerup',e=>{if(down&&Math.hypot(e.clientX-down[0],e.clientY-down[1])<6)click(squareAt(e));down=null;});

 $$('[data-preset]').forEach(b=>b.onclick=()=>load(b.dataset.preset));
 $('#slow').onchange=()=>{speed=$('#slow').checked?.4:1;};
 $('#auto').onchange=()=>{if($('#auto').checked&&!scene_&&game.chess.turn()==='b')autoMove();};
 $('#home').onclick=()=>{moved=false;homeView();};
 $('#terrain').onclick=()=>buildLandscape(1+Math.floor(Math.random()*1e6));
 // Motion files: opened locally, listed by role, picked for rest and walk.
 function addMotion(name,text){
  const source=readMotionSource(name,text);motion.sources.push(source);motion.clips.push(...source.clips);
  const options=sel=>{const v=$(sel).value;$(sel).innerHTML='<option value="">наш слой</option>'+motion.clips.map((c,i)=>`<option value="${i}">${c.label} · ${c.role}</option>`).join('');$(sel).value=v;};
  options('#motion-stand');options('#motion-walk');
  $('#motion-capture').innerHTML='<option value="">наша сцена</option>'+motion.clips.map((c,i)=>c.role==='strike'?`<option value="${i}">${c.label}</option>`:'').join('');
  const pick=(sel,roles)=>{if($(sel).value)return;const i=motion.clips.findIndex(c=>roles.includes(c.role));if(i>=0)$(sel).value=String(i);};
  pick('#motion-stand',['stand','shift']);pick('#motion-walk',['march','step','approach']);pick('#motion-capture',['strike']);
  // Recorded exchanges, one entry per source that has one.
  const duels=motion.sources.map((src,i)=>({i,pairs:exchangePairs(src.clips)})).filter(d=>d.pairs.exchange||d.pairs.decisive),dv=$('#motion-duel').value;
  $('#motion-duel').innerHTML='<option value="">наш слой</option>'+duels.map(d=>`<option value="${d.i}">${(d.pairs.exchange||d.pairs.decisive).attack.label.split(':')[0]}</option>`).join('');
  $('#motion-duel').value=dv||(duels.length?String(duels[0].i):'');
  useMotion();return source.clips.map(c=>c.name);
 }
 function useMotion(){
  const at=sel=>$(sel).value===''?null:motion.clips[+$(sel).value];
  motion.stand=at('#motion-stand');motion.walk=at('#motion-walk');motion.capture=at('#motion-capture');motion.weight=+$('#motion-weight').value/100;
  motion.duel=$('#motion-duel').value===''?null:exchangePairs(motion.sources[+$('#motion-duel').value].clips);
  $('#motion-weight-out').value=Math.round(motion.weight*100)+'%';
  const licenses=[...new Set(motion.sources.map(s=>s.file.source?.license).filter(Boolean))];
  $('#motion-status').textContent=motion.clips.length?`Клипов: ${motion.clips.length}. Покой: ${motion.stand?.label||'наш слой'}; ход: ${motion.walk?.label||'наш слой'}; взятие: ${motion.duel?.decisive?'решающий удар из записи':motion.capture?(captureClips()?motion.capture.label:'нет пары защитника'):'наша сцена'}; обмен ударами: ${motion.duel?.exchange?'по записи':'наш слой'}.`+(licenses.length?` Лицензия источника: ${licenses.join('; ')}.`:''):'';
  for(const p of game?.pieces||[]){const a=actors.get(p.id);if(a)idle(p,a,0,true);}
 }
 $('#motion-open').onclick=()=>$('#motion-file').click();
 $('#motion-file').onchange=async()=>{
  for(const f of $('#motion-file').files){try{addMotion(f.name,await f.text());}catch(error){$('#motion-status').textContent=`${f.name}: ${error.message}`;}}
  $('#motion-file').value='';
 };
 // Motion files built into the page (build.mjs --motion): loaded at start
 // like files opened by hand, so the select boxes show what is in use.
 for(const {name,text}of JSON.parse($('#motion-data')?.textContent||'[]'))try{addMotion(name,text);}catch(error){$('#motion-status').textContent=`${name}: ${error.message}`;}
 for(const sel of ['#motion-stand','#motion-walk','#motion-capture','#motion-duel','#motion-weight'])$(sel).oninput=useMotion;
 function resize(){const {width,height}=stage.getBoundingClientRect();renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();if(!moved)homeView();}
 new ResizeObserver(resize).observe(stage);resize();
 renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();fallback('Контекст WebGL потерян');});

 load('start');$('#loading').hidden=true;requestAnimationFrame(loop);

 window.livingChess={ready:true,load,click,play,
  // The recorded exchange's fit to the squares: scale, gap at the blow, aim.
  duelLayouts:()=>[...layouts].map(([key,l])=>({key,scale:l.scale,gap:l.gap,closest:l.closest,aim:l.aim})),
  manual(on=true){manual=on;last=null;},
  // Draws only the last frame: the checks need the motion, not every picture.
  step(seconds,fps=30,draw=true){const n=Math.max(1,Math.round(seconds*fps));for(let i=0;i<n;i++)advance(1/fps,draw&&i===n-1);},
  render(){renderer.render(scene,camera);},
  state:()=>({fen:game.chess.fen(),status:game.status(),busy:!!scene_,sceneTime:scene_?.t||0,clock,contact,reach,shield,thrust,
   pieces:game.pieces.map(p=>{const a=actors.get(p.id),e=eng.get(p.id);return{id:p.id,type:p.type,color:p.color,square:p.square,state:e?.state,role:e?.role,target:e?.target,pose:a?.current(),place:a?.placement()};}),
   actors:actors.size,triangles:renderer.info.render.triangles,calls:renderer.info.render.calls}),
  profile(n=5){const pawns=[...actors.values()].filter(a=>a.kind==='pawn');const t0=performance.now();for(let i=0;i<n;i++)for(const a of pawns)a.pose('Guard_Breath',i*.1);return{pawns:pawns.length,msPerPose:(performance.now()-t0)/(n*pawns.length)};},
  // Joint geometry of a pawn in its own frame for the biomechanics checks:
  // knee flexion and its direction, sole height, pelvis over the feet.
  biomech(id){const a=actors.get(id);if(a?.kind!=='pawn')return null;
   const P=a.points(['root','upperleg01.L','lowerleg01.L','foot.L','upperleg01.R','lowerleg01.R','foot.R']),sub=(u,v)=>u.map((x,i)=>x-v[i]),dot=(u,v)=>u.reduce((s,x,i)=>s+x*v[i],0),len=u=>Math.hypot(...u);
   // Forward is where the hips face, not the holder's +z: a capture clip's
   // defender faces back along its holder.
   const hips=sub(P['upperleg01.L'],P['upperleg01.R']);
   // A bent knee goes out of the hip–foot line forwards for a leg under the
   // body, forwards and up for one raised in front (a step, a kick): the
   // side of the line it bends to is across that line and the hips (x),
   // which is the hips' forward for an upright leg.
   const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],x=hips.map(v=>v/len(hips));
   const knee=side=>{const h=P['upperleg01.'+side],k=P['lowerleg01.'+side],f=P['foot.'+side],u=sub(h,k),v=sub(f,k),flex=180-Math.acos(dot(u,v)/(len(u)*len(v)))*180/Math.PI;
    const line=sub(f,h),t=dot(sub(k,h),line)/dot(line,line),off=sub(k,h.map((x,i)=>x+line[i]*t)),bend=cross(line.map(v=>v/len(line)),x);
    return{flex,forward:dot(off,bend)/len(bend),sole:f[1]};};
   const L=knee('L'),R=knee('R'),feet=[P['foot.L'],P['foot.R']],root=P.root;
   const margin=.15,inside=root[0]>=Math.min(feet[0][0],feet[1][0])-margin&&root[0]<=Math.max(feet[0][0],feet[1][0])+margin&&root[2]>=Math.min(feet[0][2],feet[1][2])-margin&&root[2]<=Math.max(feet[0][2],feet[1][2])+margin;
   return{L,R,pelvisOverFeet:inside,fall:a.placement().fall};},
  feetWorld(id){const a=actors.get(id);if(a?.kind!=='pawn')return null;a.object.updateMatrixWorld(true);const P=a.points(['foot.L','foot.R']);return Object.fromEntries(Object.entries(P).map(([k,v])=>[k,new THREE.Vector3(...v).applyMatrix4(a.object.matrixWorld).toArray()]));},
  landscape:seed=>{if(seed)buildLandscape(seed);renderer.render(scene,camera);return{seed:landscapeSeed,trees:landscape.trees.slice(0,4)};},
  hitTime:HIT_TIME,captureDuration:CAPTURE_DURATION,
  // Imported motion for the checks: add a file's text, then pick by index.
  motion:{add:(name,text)=>addMotion(name,text),list:()=>motion.clips.map(c=>c.name),use({stand=null,walk=null,capture=null,duel=null,weight=1}={}){$('#motion-duel').value=duel===null?'':String(duel);$('#motion-stand').value=stand===null?'':String(stand);$('#motion-walk').value=walk===null?'':String(walk);$('#motion-capture').value=capture===null?'':String(capture);$('#motion-weight').value=String(Math.round(weight*100));useMotion();return{stand:motion.stand?.name||null,walk:motion.walk?.name||null,capture:motion.capture?.name||null,pair:!!(motion.capture&&captureClips()),duel:motion.duel?{exchange:motion.duel.exchange?.attack.name||null,decisive:motion.duel.decisive?.attack.name||null}:null,weight:motion.weight};}},
  shown(id){return!!actors.get(id)?.object.visible;},
  points(id,names){return actors.get(id)?.points?.(names)||null;},
  pointsWorld(id,names){const a=actors.get(id);if(!a?.points)return null;a.object.updateMatrixWorld(true);return Object.fromEntries(Object.entries(a.points(names)).map(([k,v])=>[k,v&&new THREE.Vector3(...v).applyMatrix4(a.object.matrixWorld).toArray()]));},
  pose(id,action,time,layer){const a=actors.get(id);a.pose(action,time,layer);renderer.render(scene,camera);return a.points(['root','foot.L','foot.R','lowerleg01.L','lowerleg01.R','head','upperarm01.L','upperarm01.R']);},
  duelInfo(id){return duelInfo.get(id)||null;},
  shieldPlane(id){return actors.get(id)?.shieldPlane?.()||null;},
  shieldHit(id,a,b){const a_=actors.get(id);return a_?.shieldHit?a_.shieldHit(a,b):null;},
  tip(id){const a=actors.get(id);return a?.kind==='pawn'?a.measureWorld().tip:null;},
  grip(id){const a=actors.get(id);return a?.kind==='pawn'?a.measureWorld().weaponGripWorld.R:null;},
  screenshot:()=>renderer.domElement.toDataURL('image/png'),
  home(){moved=false;homeView();renderer.render(scene,camera);},
  camera(position,target){moved=true;camera.position.fromArray(position);controls.target.fromArray(target);controls.update();renderer.render(scene,camera);}
 };
}
