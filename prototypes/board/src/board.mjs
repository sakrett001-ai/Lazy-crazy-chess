import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {createGame,PRESETS,coords,FILES} from './game.mjs';
import {engagements,fencingAction,STATE_LABELS} from './behavior.mjs';
import {planCapture,captureAt,CAPTURE_DURATION,CAPTURE_PHASES,HIT_TIME,headingTo,lerpAngle,wrapAngle,rotate,strikeLayer,travel,walkLayer,idleLayer,victimHitLayer} from './choreography.mjs';
import {createPawnFactory,createToken} from './actors.mjs';
import {createLandscape} from './landscape.mjs';

// One square is 2.6 m. A 1.8 m soldier with a tower shield and a 2.4 m
// spear fits inside it, and a full thrust from the next square reaches the
// neighbour's braced shield (measured on the model at start-up).
export const SQUARE=2.6;
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const world=sq=>{const {file,rank}=coords(sq);return[(file-3.5)*SQUARE,(3.5-rank)*SQUARE];};
const forwardYaw=color=>color==='w'?Math.PI:0;
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const smooth=(t,a,b)=>{const u=clamp((t-a)/(b-a),0,1);return u*u*(3-2*u);};
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
  if(e?.state==='fencing'){const q=coords(target.square),p=coords(piece.square);fence=q.file!==p.file&&q.rank!==p.rank?contact.diagonal:contact.straight;
   const f=fencingAction(e.role,clock);if(f.attacking)desired+=fence.yaw*smooth(f.time,.3,1)*(1-smooth(f.time,3,3.8));}
  let yaw=yaws.get(piece.id);const diff=wrapAngle(desired-yaw),step=3.2*dt;
  yaw=Math.abs(diff)<=step?desired:yaw+Math.sign(diff)*step;yaws.set(piece.id,yaw);
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
  }else actor.pose('Guard_Breath',(clock+offset)%6,idleLayer(clock,hash(piece.id)));
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
    actor.pose('Guard_Breath',(clock+hash(piece.id)*6)%6,walkLayer(D,m.s,m.accel,dir,startYaw));return;}
   const u=smooth(t,0,duration);const yaw=t<duration*.7?lerpAngle(startYaw,heading,smooth(t,0,.25)):lerpAngle(heading,endYaw,smooth(t,duration*.7,duration));
   actor.place({x:a[0]+(b[0]-a[0])*u,z:a[1]+(b[1]-a[1])*u,yaw,lift:knight?1.1*Math.sin(Math.PI*u):0});yaws.set(piece.id,yaw);},finish(){}};
 }
 function pawnCapturePart(attacker,attackerPiece,victim,event){
  const plan=planCapture({from:world(event.from),to:world(event.victimSquare),end:world(event.to),attackerYaw:yaws.get(attackerPiece.id),victimYaw:yaws.get(victim.id),reach});
  return{duration:CAPTURE_DURATION,plan,update(t){
   const s=captureAt(plan,t);
   attacker.place({x:s.attacker.position[0],z:s.attacker.position[1],yaw:s.attacker.yaw});attacker.pose(s.attacker.action,s.attacker.time,s.attacker.layer);yaws.set(attackerPiece.id,s.attacker.yaw);
   if(!s.victim.removed){victim.place({x:s.victim.position[0],z:s.victim.position[1],yaw:s.victim.yaw,fall:s.victim.fall,fallHeading:s.victim.fallHeading});if(victim.kind==='pawn')victim.pose(s.victim.action,s.victim.time,s.victim.layer);victim.fade(s.victim.opacity);}
   victim.object.visible=!s.victim.removed;
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
 function resize(){const {width,height}=stage.getBoundingClientRect();renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();if(!moved)homeView();}
 new ResizeObserver(resize).observe(stage);resize();
 renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();fallback('Контекст WebGL потерян');});

 load('start');$('#loading').hidden=true;requestAnimationFrame(loop);

 window.livingChess={ready:true,load,click,play,
  manual(on=true){manual=on;last=null;},
  // Draws only the last frame: the checks need the motion, not every picture.
  step(seconds,fps=30){const n=Math.max(1,Math.round(seconds*fps));for(let i=0;i<n;i++)advance(1/fps,i===n-1);},
  state:()=>({fen:game.chess.fen(),status:game.status(),busy:!!scene_,sceneTime:scene_?.t||0,contact,reach,shield,thrust,
   pieces:game.pieces.map(p=>{const a=actors.get(p.id),e=eng.get(p.id);return{id:p.id,type:p.type,color:p.color,square:p.square,state:e?.state,role:e?.role,target:e?.target,pose:a?.current(),place:a?.placement()};}),
   actors:actors.size,triangles:renderer.info.render.triangles,calls:renderer.info.render.calls}),
  profile(n=5){const pawns=[...actors.values()].filter(a=>a.kind==='pawn');const t0=performance.now();for(let i=0;i<n;i++)for(const a of pawns)a.pose('Guard_Breath',i*.1);return{pawns:pawns.length,msPerPose:(performance.now()-t0)/(n*pawns.length)};},
  // Joint geometry of a pawn in its own frame for the biomechanics checks:
  // knee flexion and its direction, sole height, pelvis over the feet.
  biomech(id){const a=actors.get(id);if(a?.kind!=='pawn')return null;
   const P=a.points(['root','upperleg01.L','lowerleg01.L','foot.L','upperleg01.R','lowerleg01.R','foot.R']),sub=(u,v)=>u.map((x,i)=>x-v[i]),dot=(u,v)=>u.reduce((s,x,i)=>s+x*v[i],0),len=u=>Math.hypot(...u);
   const knee=side=>{const h=P['upperleg01.'+side],k=P['lowerleg01.'+side],f=P['foot.'+side],u=sub(h,k),v=sub(f,k),flex=180-Math.acos(dot(u,v)/(len(u)*len(v)))*180/Math.PI;
    const line=sub(f,h),t=dot(sub(k,h),line)/dot(line,line),off=sub(k,h.map((x,i)=>x+line[i]*t));return{flex,forward:off[2],sole:f[1]};};
   const L=knee('L'),R=knee('R'),feet=[P['foot.L'],P['foot.R']],root=P.root;
   const margin=.15,inside=root[0]>=Math.min(feet[0][0],feet[1][0])-margin&&root[0]<=Math.max(feet[0][0],feet[1][0])+margin&&root[2]>=Math.min(feet[0][2],feet[1][2])-margin&&root[2]<=Math.max(feet[0][2],feet[1][2])+margin;
   return{L,R,pelvisOverFeet:inside,fall:a.placement().fall};},
  feetWorld(id){const a=actors.get(id);if(a?.kind!=='pawn')return null;a.object.updateMatrixWorld(true);const P=a.points(['foot.L','foot.R']);return Object.fromEntries(Object.entries(P).map(([k,v])=>[k,new THREE.Vector3(...v).applyMatrix4(a.object.matrixWorld).toArray()]));},
  landscape:seed=>{if(seed)buildLandscape(seed);renderer.render(scene,camera);return{seed:landscapeSeed,trees:landscape.trees.slice(0,4)};},
  hitTime:HIT_TIME,captureDuration:CAPTURE_DURATION,
  points(id,names){return actors.get(id)?.points?.(names)||null;},
  pose(id,action,time,layer){const a=actors.get(id);a.pose(action,time,layer);renderer.render(scene,camera);return a.points(['root','foot.L','foot.R','lowerleg01.L','lowerleg01.R','head','upperarm01.L','upperarm01.R']);},
  tip(id){const a=actors.get(id);return a?.kind==='pawn'?a.measureWorld().tip:null;},
  screenshot:()=>renderer.domElement.toDataURL('image/png'),
  home(){moved=false;homeView();renderer.render(scene,camera);},
  camera(position,target){moved=true;camera.position.fromArray(position);controls.target.fromArray(target);controls.update();renderer.render(scene,camera);}
 };
}
