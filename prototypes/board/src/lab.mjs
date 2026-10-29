import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {createPawnFactory} from './actors.mjs';
import {walkLayer,idleLayer} from './choreography.mjs';
import {readMotionSource,ROLES} from './mocap/library.mjs';
import {buildMotionFile,parseMotionFile,prepareClip,sampleClip,sampleAlong,clipTravel,scaleLayer} from './mocap/format.mjs';
import {syntheticMotionFile} from './mocap/synthetic.mjs';
import {videoToClip,videoMotionFile} from './mocap/video.mjs';

// Motion lab: one clip on four lanes side by side, so the look of a motion
// can be judged on our own figure. Source stick figure, our procedural
// layer alone, the clip retargeted onto the pawn, and the clip blended with
// our layer at a chosen share. Plays BVH, the project's motion files and
// poses read from a video.
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const LANES=[-3.3,-1.1,1.1,3.3],SQUARE=2.6;
const BONES=[['pelvis','spine'],['spine','chest'],['chest','neck'],['neck','head'],['hipL','hipR'],['shoulderL','shoulderR'],['pelvis','hipL'],['pelvis','hipR'],
 ['hipL','kneeL'],['kneeL','ankleL'],['ankleL','toeL'],['ankleL','heelL'],['hipR','kneeR'],['kneeR','ankleR'],['ankleR','toeR'],['ankleR','heelR'],
 ['shoulderL','elbowL'],['elbowL','wristL'],['shoulderR','elbowR'],['elbowR','wristR'],['neck','shoulderL'],['neck','shoulderR']];

function fallback(message){$('#loading').hidden=true;$('#fallback').hidden=false;$('#fallback').textContent=message+'. Обновите страницу или откройте файл в свежей версии Chrome, Edge или Firefox.';window.motionLab={ready:false,fallback:message};}
async function modelBytes(){
 const embedded=$('#model-data')?.textContent.trim();
 if(!embedded||embedded==='/*MODEL*/')throw Error('В сборке нет модели пешки');
 const bytes=Uint8Array.from(atob(embedded),c=>c.charCodeAt(0));
 if($('#model-data').dataset.encoding!=='gzip')return bytes;
 return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

let renderer;
try{renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});}catch{fallback('WebGL недоступен');}
if(renderer)modelBytes().then(init).catch(error=>{console.error(error);fallback(error.message||'Ошибка загрузки');});

async function init(bytes){
 const stage=$('#stage');
 renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.shadowMap.enabled=true;
 renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;
 stage.append(renderer.domElement);
 const scene=new THREE.Scene();scene.background=new THREE.Color('#d8e2e6');
 const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();
 scene.environment=pmrem.fromScene(room,.04).texture;scene.environmentIntensity=.55;room.dispose();pmrem.dispose();
 scene.add(new THREE.HemisphereLight(0xffffff,0x7c837d,1.05));
 const key=new THREE.DirectionalLight(0xfff4e6,2.6);key.position.set(-8,14,6);key.castShadow=true;key.shadow.mapSize.set(2048,2048);
 Object.assign(key.shadow.camera,{left:-8,right:8,top:12,bottom:-12,near:1,far:50});key.shadow.normalBias=.02;scene.add(key,key.target);
 // Ground with a grid of board squares, so step length reads against 2.6 m.
 const ground=new THREE.Mesh(new THREE.PlaneGeometry(14,80),new THREE.MeshStandardMaterial({color:0xbfc6bd,roughness:.95}));
 ground.rotation.x=-Math.PI/2;ground.position.z=30;ground.receiveShadow=true;scene.add(ground);
 const grid=new THREE.Group();scene.add(grid);
 for(let i=-1;i<=30;i++){const line=new THREE.Mesh(new THREE.PlaneGeometry(14,.03),new THREE.MeshBasicMaterial({color:0x6d7a74}));line.rotation.x=-Math.PI/2;line.position.set(0,.002,i*SQUARE-SQUARE/2);grid.add(line);}
 for(const x of [-2.2,0,2.2]){const line=new THREE.Mesh(new THREE.PlaneGeometry(.02,80),new THREE.MeshBasicMaterial({color:0x8d9a94}));line.rotation.x=-Math.PI/2;line.position.set(x,.002,30);grid.add(line);}

 const camera=new THREE.PerspectiveCamera(34,1,.05,300);
 const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=false;
 let view='three',follow=0;
 function cameraTo(name){view=name;const z=follow,c={side:[[11.5,1.3,z],[0,.95,z]],front:[[0,1.5,z+11],[0,.95,z]],three:[[8.5,3.2,z+8.5],[0,.9,z]],feet:[[3.2,.55,z+3.6],[1.1,.15,z]]}[name];
  camera.position.fromArray(c[0]);controls.target.fromArray(c[1]);controls.update();}

 const loader=new GLTFLoader();
 loader.register(parser=>{parser.textureLoader=new THREE.TextureLoader(parser.options.manager);return{name:'image-element-textures'};});
 const gltf=await new Promise((resolve,reject)=>loader.parse(bytes.buffer,'',resolve,reject));
 const createPawn=createPawnFactory({gltf});
 const pawns=[1,2,3].map(i=>{const p=createPawn({id:'lab-'+i,color:'w'});scene.add(p.object);return p;});
 const {leg:pawnLeg,ankleHeight}=pawns[0].mocap.retarget;
 // Source stick figure, scaled to the pawn's leg length.
 const stickGeo=new THREE.BufferGeometry();stickGeo.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(BONES.length*6),3));
 const stick=new THREE.LineSegments(stickGeo,new THREE.LineBasicMaterial({color:0x2c676f}));stick.frustumCulled=false;scene.add(stick);
 const joints=new THREE.InstancedMesh(new THREE.SphereGeometry(.03,10,8),new THREE.MeshBasicMaterial({color:0xb3261e}),40);joints.frustumCulled=false;scene.add(joints);

 const lab={clips:[],sources:[],index:-1,t:0,playing:true,speed:1,share:.6,inPlace:false,cycle:{}};
 const clip=()=>lab.clips[lab.index]||null;
 function addFile(file,name){
  const clips=file.clips.map(c=>({...prepareClip(file,c),source:file.source||{}}));
  lab.sources.push({name,file});lab.clips.push(...clips);refreshList();return clips;
 }
 function addText(name,text){const s=readMotionSource(name,text);lab.sources.push({name,file:s.file});lab.clips.push(...s.clips);refreshList();return s.clips;}
 function refreshList(){const v=lab.index;$('#clip').innerHTML=lab.clips.map((c,i)=>`<option value="${i}">${c.label} · ${ROLES[c.role]||c.role}</option>`).join('');if(v>=0)$('#clip').value=String(v);}
 function select(i){
  lab.index=Math.max(0,Math.min(lab.clips.length-1,i));lab.t=0;lab.cycle={};$('#clip').value=String(lab.index);
  const c=clip();$('#label').value=c.label;$('#role').value=c.role;$('#loop').checked=c.loop;
  const k=pawnLeg/c.leg,travel=clipTravel(c)*k;
  $('#info').textContent=`${c.count} кадров, ${c.fps} кадр/с, ${c.duration.toFixed(2)} с; продвижение ${travel.toFixed(2)} м за ${c.loop?'круг':'клип'}; масштаб к пешке ×${k.toFixed(2)}. Источник: ${c.source?.name||'—'}; лицензия: ${c.source?.license||'не указана'}.`;
  render();
 }
 // A clip walks when its pelvis goes forward more than a third of a leg.
 const walks=c=>clipTravel(c)>c.leg/3;
 const period=c=>c.loop?Math.max(2*c.duration,4):c.duration+.8;

 function measure(pawn){
  const P=pawn.points(['upperleg01.L','lowerleg01.L','foot.L','toe3-1.L','upperleg01.R','lowerleg01.R','foot.R','toe3-1.R','root']),sub=(u,v)=>u.map((x,i)=>x-v[i]),dot=(u,v)=>u.reduce((s,x,i)=>s+x*v[i],0),len=u=>Math.hypot(...u);
  const knee=s=>{const h=P['upperleg01.'+s],k=P['lowerleg01.'+s],f=P['foot.'+s],u=sub(h,k),v=sub(f,k),flex=180-Math.acos(Math.max(-1,Math.min(1,dot(u,v)/(len(u)*len(v)))))*180/Math.PI;
   const line=sub(f,h),t=dot(sub(k,h),line)/dot(line,line),off=sub(k,h.map((x,i)=>x+line[i]*t));return{flex,forward:off[2],sole:Math.min(f[1],P['toe3-1.'+s][1])};};
  return{L:knee('L'),R:knee('R'),pelvis:P.root[1]};
 }
 function render(){
  const c=clip();
  if(!c){renderer.render(scene,camera);return null;}
  const k=pawnLeg/c.leg,T=period(c),t=Math.min(lab.t%T,c.loop?T:c.duration),walking=walks(c)&&!lab.inPlace;
  // Progress along the path in source units: the pelvis's own forward
  // track. Our layer walks the same distance; on the spot only the figure
  // stays put.
  const along=walks(c)?sampleClip(c,t).pelvis[2]:0,s=walking?along*k:0;
  const points=walking?sampleAlong(c,along).points:sampleClip(c,t,{inPlace:lab.inPlace});
  const D=walks(c)?Math.max(.05,sampleClip(c,c.loop?T:c.duration).pelvis[2]*k):0;
  const ours=walks(c)?walkLayer(D,Math.min(D,along*k),0,[0,1],0):idleLayer(t);
  const action='Guard_Breath',idle=t%6;
  pawns[0].pose(action,idle,ours);
  pawns[1].pose(action,idle,null,{clip:c,points,weight:1});
  pawns[2].pose(action,idle,scaleLayer(ours,1-lab.share),{clip:c,points,weight:lab.share});
  pawns.forEach((p,i)=>p.place({x:LANES[i+1],z:s,yaw:0}));
  // Stick figure in the first lane.
  const pos=stickGeo.attributes.position.array,m=new THREE.Matrix4();let n=0,j=0;
  const at=v=>[LANES[0]+v[0]*k,(v[1]-c.ground)*k+ankleHeight,s+v[2]*k];
  for(const [a,b]of BONES){const A=points[a],B=points[b];const pa=A&&B?at(A):[0,-9,0],pb=A&&B?at(B):[0,-9,0];pos.set([...pa,...pb],n);n+=6;}
  stickGeo.attributes.position.needsUpdate=true;
  for(const v of Object.values(points)){if(j>=40)break;m.makeTranslation(...at(v));joints.setMatrixAt(j++,m);}joints.count=j;joints.instanceMatrix.needsUpdate=true;
  const bio=measure(pawns[2]),cy=lab.cycle;
  cy.minFlex=Math.min(cy.minFlex??180,bio.L.flex,bio.R.flex);cy.maxFlex=Math.max(cy.maxFlex??0,bio.L.flex,bio.R.flex);
  cy.minSole=Math.min(cy.minSole??9,bio.L.sole,bio.R.sole);cy.backward=(cy.backward||0)+[bio.L,bio.R].filter(x=>x.flex>8&&x.forward<0).length;
  const f=v=>v.toFixed(0).padStart(3),cm=v=>(v*100).toFixed(1);
  $('#bio').textContent=`колени   Л ${f(bio.L.flex)}°  П ${f(bio.R.flex)}°\nподошвы  Л ${cm(bio.L.sole)} см  П ${cm(bio.R.sole)} см\nза время: колени ${cy.minFlex.toFixed(0)}–${cy.maxFlex.toFixed(0)}°, подошвы ≥ ${cm(cy.minSole)} см, назад: ${cy.backward}`;
  $('#time').value=String(Math.round(t/T*1000));$('#time-out').value=t.toFixed(2).replace('.',',')+' с';
  if(Math.abs(s-follow)>.01){follow=s;const dz=s-controls.target.z;camera.position.z+=dz;controls.target.z+=dz;controls.update();key.position.z=s+6;key.target.position.z=s;}
  renderer.render(scene,camera);
  return{t,s,bio};
 }

 // Controls.
 $('#role').innerHTML=Object.entries(ROLES).map(([k,v])=>`<option value="${k}">${v}</option>`).join('');
 $('#clip').onchange=()=>select(+$('#clip').value);
 $('#play').onclick=()=>{lab.playing=!lab.playing;$('#play').textContent=lab.playing?'Пауза':'Пуск';};
 $('#speed').onchange=()=>{lab.speed=+$('#speed').value;};
 $('#time').oninput=()=>{const c=clip();if(!c)return;lab.playing=false;$('#play').textContent='Пуск';lab.t=+$('#time').value/1000*period(c);render();};
 $('#share').oninput=()=>{lab.share=+$('#share').value/100;$('#share-out').value=$('#share').value+'%';lab.cycle={};render();};
 $('#in-place').onchange=()=>{lab.inPlace=$('#in-place').checked;lab.cycle={};render();};
 for(const b of $$('[data-cam]'))b.onclick=()=>{cameraTo(b.dataset.cam);render();};
 $('#label').oninput=()=>{const c=clip();if(c){c.label=$('#label').value||c.name;refreshList();}};
 $('#role').onchange=()=>{const c=clip();if(c){c.role=$('#role').value;refreshList();select(lab.index);}};
 $('#loop').onchange=()=>{const c=clip();if(c){c.loop=$('#loop').checked;select(lab.index);}};
 $('#open').onclick=()=>$('#file').click();
 $('#file').onchange=async()=>{let first=lab.clips.length;
  for(const f of $('#file').files){try{addText(f.name,await f.text());}catch(error){$('#info').textContent=`${f.name}: ${error.message}`;first=-1;}}
  $('#file').value='';if(first>=0&&first<lab.clips.length)select(first);};
 $('#video-open').onclick=()=>$('#video-file').click();
 $('#video-file').onchange=async()=>{const f=$('#video-file').files[0];$('#video-file').value='';if(f)await fromVideo(f).catch(error=>{$('#video-status').textContent=`${f.name}: ${error.message}`;});};
 async function fromVideo(blob,options={}){
  const video=document.createElement('video');video.muted=true;video.playsInline=true;video.preload='auto';video.src=URL.createObjectURL(blob);
  const name=(blob.name||'video').replace(/\.[^.]+$/,'');
  try{
   const {clip:raw,missed}=await videoToClip(video,{name,label:name,role:'other',...options,onStatus:m=>{$('#video-status').textContent=m;},onProgress:p=>{$('#video-status').textContent=`Распознаю позу: ${Math.round(p*100)}%`;}});
   const [c]=addFile(parseMotionFile(videoMotionFile([raw],{name})),name);
   $('#video-status').textContent=`Готово: ${raw.frames.length} кадров`+(missed>.02?`; на ${Math.round(missed*100)}% кадров человек не найден`:'')+'. Задайте роль клипа ниже.';
   select(lab.clips.indexOf(c));return c;
  }finally{URL.revokeObjectURL(video.src);}
 }
 $('#export').onclick=()=>{
  const blob=new Blob([JSON.stringify(exportFile())],{type:'application/json'}),a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download='motions.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
 };
 function exportFile(){
  const licenses=[...new Set(lab.clips.map(c=>c.source?.license).filter(Boolean))];
  return buildMotionFile({source:{kind:'lab',name:'Лаборатория движений',license:licenses.join('; ')||'не указана'},clips:lab.clips.map(c=>({name:c.name,label:c.label,role:c.role,loop:c.loop,fps:c.fps,frames:c.frames}))});
 }

 function resize(){const {width,height}=stage.getBoundingClientRect();renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();render();}
 new ResizeObserver(resize).observe(stage);
 addFile(syntheticMotionFile(),'synthetic');cameraTo('three');select(0);resize();
 $('#loading').hidden=true;
 let last=null,manual=false;
 function loop(now){requestAnimationFrame(loop);if(manual)return;const dt=last===null?0:Math.min(.1,(now-last)/1000);last=now;
  if(lab.playing&&clip())lab.t+=dt*lab.speed;try{render();}catch(error){console.error(error);}}
 requestAnimationFrame(loop);

 window.motionLab={ready:true,
  add:addText,select,clips:()=>lab.clips.map(c=>({name:c.name,label:c.label,role:c.role,loop:c.loop,count:c.count})),
  manual(on=true){manual=on;last=null;},
  set({t,share,inPlace}={}){if(share!==undefined){lab.share=share;$('#share').value=String(Math.round(share*100));}if(inPlace!==undefined){lab.inPlace=inPlace;$('#in-place').checked=inPlace;}if(t!==undefined)lab.t=t;lab.cycle={};return render();},
  // Steps the playback in fixed frames and returns the biomechanics of the
  // blended lane (the readout the page shows) over the stretch.
  run(seconds,fps=30){const out=[];for(let i=0;i<Math.round(seconds*fps);i++){lab.t+=1/fps;out.push(render());}return{frames:out.length,cycle:{...lab.cycle},last:out[out.length-1]};},
  pawns:()=>pawns.map(p=>({pose:p.current(),place:p.placement(),bio:measure(p)})),
  camera:cameraTo,video:fromVideo,exportFile,
  screenshot:()=>{render();return renderer.domElement.toDataURL('image/png');}
 };
}
