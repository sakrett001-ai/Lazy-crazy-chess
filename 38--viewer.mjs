import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {cameraRig,deterministicClip} from './camera-rig.mjs';
import {installReview} from './review.mjs';

const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const stage=$('#stage'),timeInput=$('#timeline'),play=$('#play');
const hosted=window.PAWN_HOSTED&&typeof window.PAWN_HOSTED==='object'?Object.freeze({...window.PAWN_HOSTED}):null;
const clean=value=>typeof value==='string'?value.slice(0,160):'';
const identity={version:clean(hosted?.version)||'0.2.1',modelVersion:clean(hosted?.modelVersion)||'0.2.0',sourceCommit:clean(hosted?.sourceCommit),modelSha256:clean(hosted?.modelSha256).toLowerCase(),modelUrl:clean(hosted?.modelUrl),mode:hosted?'hosted':'standalone'};
$('#build-version').textContent=`Стенд ${identity.version} · модель ${identity.modelVersion}${identity.sourceCommit?' · '+identity.sourceCommit.slice(0,8):''}`;
$('#build-version').title=identity.sourceCommit?`Исходный коммит: ${identity.sourceCommit}`:'Автономная сборка';
const embeddedPoster=$('#poster').getAttribute('src');
if(hosted?.posterUrl){try{const url=new URL(hosted.posterUrl);if(url.protocol!=='https:')throw Error();$('#poster').src=url.href;$('#poster').onerror=()=>{if(embeddedPoster?.startsWith('data:')){$('#poster').onerror=null;$('#poster').src=embeddedPoster;}};}catch{/* The bundled poster remains available for invalid external URLs. */}}
let bytes=null,renderer;
const download=$('#download');
download.onclick=()=>{if(!bytes)return;const url=URL.createObjectURL(new Blob([bytes],{type:'model/gltf-binary'}));const a=document.createElement('a');a.href=url;a.download='lazy-crazy-chess-white-pawn.glb';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);};
const captions={rest:'Стойка · копьё в правой руке, ростовой щит слева',Guard_Breath:'Дыхание в стойке · оружие и щит следуют за телом',Shield_Brace:'Упор щитом · согласованное движение ног, таза и корпуса',Spear_Study:'Учебный укол · наконечником вперёд вдоль древка и возврат'};
function fallback(message){if(renderer)renderer.domElement.hidden=true;$('#loading').hidden=true;$('#poster').style.display='block';$('#fallback').hidden=false;$('#fallback').textContent=message+'. Показан сохранённый рендер. '+(bytes?'Модель можно скачать и открыть в Blender.':'Проверьте соединение и перезагрузите страницу.');document.body.classList.add('unavailable');$$('aside button, aside input, aside select, .view-buttons button, #mark-issue').filter(b=>b!==download).forEach(b=>b.disabled=true);window.whitePawn={ready:false,fallback:message,identity:{...identity}};}
async function loadModel(){
 if(!hosted){const embedded=$('#model-data').textContent.trim();if(!embedded||embedded==='/*MODEL*/')throw Error('В сборке нет модели');const result=Uint8Array.from(atob(embedded),c=>c.charCodeAt(0));if(globalThis.crypto?.subtle)identity.modelSha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',result)),n=>n.toString(16).padStart(2,'0')).join('');return result;}
 const url=new URL(hosted.modelUrl);
 if(url.origin!=='https://raw.githubusercontent.com'||url.username||url.password||url.search||url.hash||!/^\/[^/]+\/[^/]+\/[a-f0-9]{40}\/.+\.glb$/i.test(url.pathname))throw Error('Нужна ссылка на GLB с полным хешем коммита GitHub');
 if(!/^[a-f0-9]{64}$/i.test(identity.modelSha256))throw Error('Не задан SHA-256 модели');
 if(!globalThis.crypto?.subtle)throw Error('Для проверки модели нужен HTTPS и WebCrypto');
 $('#loading').textContent='Загружаем проверенную версию модели…';
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),45000);
 let data;
 try{const response=await fetch(url.href,{mode:'cors',credentials:'omit',cache:'force-cache',redirect:'error',signal:abort.signal});if(!response.ok)throw Error(`Сервер модели ответил ${response.status}`);if(Number(response.headers.get('content-length'))>64*1024*1024)throw Error('Файл модели слишком большой');data=new Uint8Array(await response.arrayBuffer());if(data.byteLength>64*1024*1024)throw Error('Файл модели слишком большой');}finally{clearTimeout(timer);}
 identity.modelUrl=url.href;
 const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),n=>n.toString(16).padStart(2,'0')).join('');
 if(actual!==identity.modelSha256)throw Error('SHA-256 не совпал: модель не открыта');
 return data;
}
try{renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,preserveDrawingBuffer:true});}
catch{fallback('WebGL недоступен');}
loadModel().then(data=>{bytes=data;download.disabled=false;if(renderer)return init();fallback('WebGL недоступен');}).catch(error=>{console.error(error);fallback(error.message||'Ошибка загрузки модели');});

async function init(){
 renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
 renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
 renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
 stage.append(renderer.domElement);
 const scene=new THREE.Scene();scene.background=new THREE.Color('#e8ebe9');
 const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();
 const env=pmrem.fromScene(room,.04);scene.environment=env.texture;scene.environmentIntensity=.6;room.dispose();pmrem.dispose();
 scene.add(new THREE.HemisphereLight(0xffffff,0x8d9c9b,1));
 const key=new THREE.DirectionalLight(0xf2f6ff,3.1);key.position.set(-2.5,6,2);key.castShadow=true;key.shadow.mapSize.set(1024,1024);
 Object.assign(key.shadow.camera,{left:-1.8,right:1.8,top:2.4,bottom:-1,near:.1,far:12});key.shadow.normalBias=.006;key.shadow.bias=-.0001;key.shadow.radius=3;scene.add(key);
 const fill=new THREE.DirectionalLight(0xdbe7f6,1.15);fill.position.set(3,2,-2);scene.add(fill);
 const floor=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.ShadowMaterial({color:0x61777a,opacity:.19}));floor.rotation.x=-Math.PI/2;floor.position.y=-.0015;floor.receiveShadow=true;scene.add(floor);
 const ring=new THREE.Mesh(new THREE.RingGeometry(.78,.783,128),new THREE.MeshBasicMaterial({color:0xabbab9,transparent:true,opacity:.55,side:THREE.DoubleSide}));ring.rotation.x=-Math.PI/2;ring.position.y=-.0007;scene.add(ring);
 const gltf=await new Promise((resolve,reject)=>new GLTFLoader().parse(bytes.buffer,'',resolve,reject));
 const model=gltf.scene;scene.add(model);
 const meshes=[],bones={};
 model.traverse(o=>{if(o.isMesh){meshes.push(o);o.castShadow=true;o.receiveShadow=!/short/i.test(o.name);o.frustumCulled=false;}if(o.isBone)bones[o.name]=o;});
 const rest={};Object.entries(bones).forEach(([n,b])=>rest[n]={p:b.position.clone(),q:b.quaternion.clone(),s:b.scale.clone()});
 const restore=()=>Object.entries(rest).forEach(([n,r])=>{bones[n].position.copy(r.p);bones[n].quaternion.copy(r.q);bones[n].scale.copy(r.s);});
 const skeletons=[...new Set(meshes.filter(m=>m.isSkinnedMesh).map(m=>m.skeleton))];
 const updateModel=()=>{model.updateMatrixWorld(true);skeletons.forEach(s=>s.update());};
 const bounds=new THREE.Box3(),poseBounds={};
 function currentBounds(){updateModel();return new THREE.Box3().setFromObject(model,true);}
 poseBounds.rest=currentBounds();bounds.union(poseBounds.rest);
 // A separate envelope for each study keeps the neutral figure readable while
 // fitting the full movement of the chosen study without camera pumping.
 for(let i=0;i<gltf.animations.length;i++){
  $('#loading').textContent=`Подготавливаем движения · ${i+1} из ${gltf.animations.length}`;
  await new Promise(resolve=>requestAnimationFrame(resolve));
  const sample=deterministicClip(model,gltf.animations,i),envelope=new THREE.Box3();
  for(let step=0;step<=8;step++){sample.seek(sample.duration*step/8);envelope.union(currentBounds());}
  poseBounds[gltf.animations[i].name]=envelope;bounds.union(envelope);
  sample.dispose();restore();
 }
 updateModel();
 $('#loading').textContent='Готовим первый ракурс…';
 await new Promise(resolve=>requestAnimationFrame(resolve));
 const poseRigs=Object.fromEntries(Object.entries(poseBounds).map(([name,box])=>[name,cameraRig(box,{fov:30,margin:1.08})]));
 const fullRig=poseRigs.rest;
 const faceRig=cameraRig(new THREE.Box3(new THREE.Vector3(-.18,1.43,-.2),new THREE.Vector3(.18,1.95,.25)),{fov:30,margin:1.12});
 const handRig=(side)=>{const bone=bones['wrist.'+side]||bones['wrist'+side];const center=bone?bone.getWorldPosition(new THREE.Vector3()):new THREE.Vector3(side==='R'?-.28:.28,1.1,.25);return cameraRig(new THREE.Box3(center.clone().addScalar(-.2),center.clone().addScalar(.2)),{fov:30,margin:1.22});};

 let camera=fullRig.camera,currentRig=fullRig,view='three';
 const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=false;controls.minDistance=.22;controls.maxDistance=15;controls.maxPolarAngle=Math.PI*.96;
 const directions={front:[0,.03,1],side:[1,.03,0],back:[0,.03,-1],three:[1.8,.48,5],face:[.1,0,1],spear:[-2,.6,3],shield:[2,.4,-3],top:[0,1,0],bottom:[0,-1,0]};
 let selected='rest',sampler=null,playing=false,t=0,last=null,frame=0,onScreen=true,speed=1,pendingPlay=false,reviewLocked=false,cameraPinned=false,display='surface',fps=null,fpsElapsed=0,fpsFrames=0;

 const skeletonGroup=new THREE.Group();skeletonGroup.visible=false;scene.add(skeletonGroup);
 const jointNames=Object.keys(bones).filter(n=>/^(root|spine0[135]|head|neck01|clavicle|shoulder01|upperarm0[12]|lowerarm0[12]|wrist|pelvis|upperleg0[12]|lowerleg0[12]|foot)/.test(n));
 const jointMaterial=new THREE.MeshBasicMaterial({color:0xc25729,depthTest:false,transparent:true,opacity:.9});
 const jointGeometry=new THREE.SphereGeometry(.007,8,6),dots={};
 for(const n of jointNames){const dot=new THREE.Mesh(jointGeometry,jointMaterial);dot.renderOrder=10;skeletonGroup.add(dot);dots[n]=dot;}
 const lineGeometry=new THREE.BufferGeometry();lineGeometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(jointNames.length*6),3));
 const lines=new THREE.LineSegments(lineGeometry,new THREE.LineBasicMaterial({color:0xb95e2e,depthTest:false,transparent:true,opacity:.65}));lines.renderOrder=9;lines.frustumCulled=false;skeletonGroup.add(lines);
 function updateSkeleton(){updateModel();let i=0;const ar=lineGeometry.attributes.position.array;
  for(const n of jointNames){const b=bones[n],p=b.getWorldPosition(new THREE.Vector3());dots[n].position.copy(p);let parent=b.parent;while(parent&&parent.isBone&&!dots[parent.name])parent=parent.parent;const q=parent?.isBone?parent.getWorldPosition(new THREE.Vector3()):p;ar.set(p.toArray(),i);ar.set(q.toArray(),i+3);i+=6;}
  lineGeometry.attributes.position.needsUpdate=true;
 }
 function render(){updateSkeleton();renderer.render(scene,camera);}
 function fit(name=view){
  cameraPinned=false;view=name;updateModel();currentRig=name==='face'?faceRig:name==='spear'?handRig('R'):name==='shield'?handRig('L'):(poseRigs[selected]||fullRig);
  const {width,height}=stage.getBoundingClientRect();currentRig.resize(width,height);
  camera=currentRig.pose({direction:directions[name],projection:'perspective',zoom:1});camera.near=.03;camera.far=40;camera.updateProjectionMatrix();controls.object=camera;controls.target.copy(currentRig.center);controls.update();
  $$('[data-view]').forEach(b=>{const active=b.dataset.view===name;b.classList.toggle('active',active);b.setAttribute('aria-pressed',active);});render();
 }
 function resize(){const {width,height}=stage.getBoundingClientRect();renderer.setSize(width,height);if(reviewLocked||cameraPinned){camera.aspect=width/height;camera.updateProjectionMatrix();render();}else fit(view);}
 function seek(value){t=THREE.MathUtils.clamp(Number(value),0,sampler?.duration||3);if(sampler)sampler.seek(t);else restore();timeInput.value=t;$('#time').value=t.toFixed(2)+' с';render();}
 function pause(){pendingPlay=false;playing=false;play.textContent='▶';play.setAttribute('aria-label','Запустить движение');last=null;cancelAnimationFrame(frame);fps=null;fpsElapsed=0;fpsFrames=0;$('#fps').textContent='FPS · пауза';updateSteps();}
 function updateSteps(){for(const id of ['#step-back','#step-forward'])$(id).disabled=!sampler||playing||reviewLocked;}
 function tick(now){if(!playing)return;if(document.hidden||!onScreen){pause();return;}const dt=last===null?0:(now-last)/1000;last=now;if(dt>0){fpsElapsed+=dt;fpsFrames++;if(fpsElapsed>=1){fps=Math.round(fpsFrames/fpsElapsed);$('#fps').textContent=`≈ ${fps} FPS`;fpsElapsed=0;fpsFrames=0;}}seek((t+dt*speed)%(sampler?.duration||3));frame=requestAnimationFrame(tick);}
 function start(){if(reviewLocked||!sampler||document.hidden)return;const rect=stage.getBoundingClientRect();const visible=Math.max(0,Math.min(innerHeight,rect.bottom)-Math.max(0,rect.top));if(visible<rect.height*.4){pendingPlay=true;stage.scrollIntoView({block:'center',behavior:'instant'});requestAnimationFrame(()=>{if(pendingPlay)start();});return;}onScreen=true;pendingPlay=false;playing=true;updateSteps();$('#fps').textContent='FPS · измеряем';play.textContent='Ⅱ';play.setAttribute('aria-label','Остановить движение');last=null;frame=requestAnimationFrame(tick);}
 function select(name){
  pause();sampler?.dispose();sampler=null;restore();selected=name;
  $$('[data-pose]').forEach(b=>{const active=b.dataset.pose===name;b.classList.toggle('active',active);b.setAttribute('aria-pressed',active);});$('#pose-caption').textContent=captions[name];
  if(name!=='rest'){const index=gltf.animations.findIndex(c=>c.name===name);if(index<0)throw Error(`Missing clip: ${name}`);sampler=deterministicClip(model,gltf.animations,index);timeInput.max=sampler.duration;}
  play.disabled=timeInput.disabled=name==='rest';updateSteps();seek(0);fit(view);
 }
 $$('[data-pose]').forEach(b=>b.onclick=()=>select(b.dataset.pose));
 $('#step-back').onclick=()=>{pause();seek(t-1/30);};$('#step-forward').onclick=()=>{pause();seek(t+1/30);};
 play.onclick=()=>playing?pause():start();timeInput.oninput=()=>{pause();seek(timeInput.value);};$('#speed').onchange=()=>{speed=Number($('#speed').value);};
 $$('[data-view]').forEach(b=>b.onclick=()=>{pause();fit(b.dataset.view);});$('#home').onclick=()=>{pause();fit('three');};
 $$('[data-display]').forEach(b=>b.onclick=()=>{const mode=b.dataset.display;display=mode;meshes.forEach(o=>{const mats=Array.isArray(o.material)?o.material:[o.material];mats.forEach(m=>m.wireframe=mode==='wire');});$$('[data-display]').forEach(el=>{const active=el===b;el.classList.toggle('active',active);el.setAttribute('aria-pressed',active);});render();});
 $('#skeleton').onchange=()=>{skeletonGroup.visible=$('#skeleton').checked;render();};
 controls.addEventListener('start',pause);controls.addEventListener('change',render);
 stage.addEventListener('keydown',e=>{
  if(reviewLocked)return;
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-','=','h','H',' '].includes(e.key))return;e.preventDefault();
  if(e.key===' '){playing?pause():start();return;}pause();if(e.key.toLowerCase()==='h'){fit('three');return;}
  const p=camera.position.clone().sub(controls.target);
  if(e.key.startsWith('Arrow')){const s=new THREE.Spherical().setFromVector3(p);if(e.key==='ArrowLeft')s.theta-=.12;if(e.key==='ArrowRight')s.theta+=.12;if(e.key==='ArrowUp')s.phi-=.1;if(e.key==='ArrowDown')s.phi+=.1;s.phi=THREE.MathUtils.clamp(s.phi,.1,Math.PI-.1);p.setFromSpherical(s);}else p.multiplyScalar(e.key==='-'?1.1:.9);
  camera.position.copy(controls.target).add(p);controls.update();render();
 });
 document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
 const observer=new IntersectionObserver(([e])=>{const r=stage.getBoundingClientRect();onScreen=Math.min(innerHeight,r.bottom)-Math.max(0,r.top)>r.height*.05;if(!onScreen&&playing)pause();if(onScreen&&pendingPlay)start();},{threshold:.05});observer.observe(stage);
 const motion=matchMedia('(prefers-reduced-motion: reduce)');motion.addEventListener('change',()=>{if(motion.matches)pause();});
 // Inspection starts still for everyone; users explicitly opt into motion.
 new ResizeObserver(resize).observe(stage);
 renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();pause();renderer.domElement.hidden=true;fallback('Контекст WebGL потерян');});
 $('#poster').style.display='none';$('#loading').hidden=true;resize();
 const body=meshes.filter(m=>m.isSkinnedMesh).sort((a,b)=>b.geometry.attributes.position.count-a.geometry.attributes.position.count)[0]||meshes[0];
 function measure(){updateModel();let minY=Infinity,maxY=-Infinity;const p=new THREE.Vector3();for(const mesh of meshes){const ar=mesh.geometry.attributes.position;for(let i=0;i<ar.count;i++){mesh.getVertexPosition(i,p);p.applyMatrix4(mesh.matrixWorld);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}}return {minY,maxY,height:maxY-minY,finite:Number.isFinite(minY+maxY)};}
 window.whitePawn={ready:true,select,seek,pause,fit,render,measure,
  state:()=>({pose:selected,time:t,playing,speed,view,onScreen,pendingPlay,reviewLocked,fps,display,renderCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,bones:Object.keys(bones).length,clips:gltf.animations.map(c=>({name:c.name,duration:c.duration})),renderer:renderer.getContext().getParameter(renderer.getContext().RENDERER),reducedMotion:motion.matches,contained:currentRig.containment()}),
  screenshot:()=>renderer.domElement.toDataURL('image/png'),identity:{...identity},
  debug:{model,bones,body,renderer,controls,bounds,poseBounds}
 };
 const review=installReview({
  identity,
  snapshot:()=>({pose:selected,time:t,duration:sampler?.duration||0,frame:Math.round(t*30),frameRate:30,speed,view,display,skeleton:skeletonGroup.visible,camera:{position:camera.position.toArray(),target:controls.target.toArray(),up:camera.up.toArray(),fov:camera.fov,zoom:camera.zoom,near:camera.near,far:camera.far},viewport:{width:renderer.domElement.width,height:renderer.domElement.height}}),
  freeze:()=>{pause();reviewLocked=true;cameraPinned=true;controls.enabled=false;updateSteps();render();return renderer.domElement.toDataURL('image/png');},
  release:()=>{reviewLocked=false;controls.enabled=true;updateSteps();},
  restore:state=>{pause();select(state.pose);seek(state.time);fit(state.view);camera.position.fromArray(state.camera.position);camera.up.fromArray(state.camera.up);camera.fov=state.camera.fov;camera.zoom=state.camera.zoom;camera.near=state.camera.near;camera.far=state.camera.far;camera.updateProjectionMatrix();controls.target.fromArray(state.camera.target);controls.update();speed=state.speed;$('#speed').value=String(speed);$(`[data-display="${state.display}"]`).click();$('#skeleton').checked=state.skeleton;skeletonGroup.visible=state.skeleton;cameraPinned=true;render();},
  poses:['rest',...gltf.animations.map(c=>c.name)],views:Object.keys(directions)
 });
 window.whitePawn.exportReview=review.capture;window.whitePawn.restoreReview=review.restore;
}

