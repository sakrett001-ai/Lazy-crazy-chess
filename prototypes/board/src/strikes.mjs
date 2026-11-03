import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {createPawnFactory} from './actors.mjs';
import {parseMotionFile,prepareClip,sampleClip,sampleArms} from './mocap/format.mjs';
import {trunkFrame} from './mocap/strike.mjs';

// Strike stand: the recording as a stick figure and the fighter beside it,
// one strike at a time, plus the per-frame checks of verify-strikes.mjs.
// The motion file comes from tools/strikes/build.mjs (#strike-data).
const $=s=>document.querySelector(s);
// The two lanes stand across the line of sight, so the camera sees both at
// one distance and one size: source left, fighter right.
const SPREAD=1.3;
const BONES=[['pelvis','spine'],['spine','chest'],['chest','neck'],['neck','head'],['hipL','hipR'],['shoulderL','shoulderR'],['pelvis','hipL'],['pelvis','hipR'],
 ['hipL','kneeL'],['kneeL','ankleL'],['ankleL','toeL'],['hipR','kneeR'],['kneeR','ankleR'],['ankleR','toeR'],
 ['shoulderL','elbowL'],['elbowL','wristL'],['shoulderR','elbowR'],['elbowR','wristR'],['neck','shoulderL'],['neck','shoulderR']];
const V=(x=0,y=0,z=0)=>new THREE.Vector3(x,y,z);

async function modelBytes(){
 const text=$('#model-data').textContent.trim();
 const bytes=Uint8Array.from(atob(text),c=>c.charCodeAt(0));
 if($('#model-data').dataset.encoding!=='gzip')return bytes;
 return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
modelBytes().then(init).catch(e=>{console.error(e);$('#loading').textContent=e.message;window.strikeLab={ready:false,error:e.message};});

async function init(bytes){
 const stage=$('#stage');
 renderer.setPixelRatio(1);renderer.shadowMap.enabled=true;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;
 stage.append(renderer.domElement);
 const scene=new THREE.Scene();scene.background=new THREE.Color('#d8e2e6');
 const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();
 scene.environment=pmrem.fromScene(room,.04).texture;scene.environmentIntensity=.55;room.dispose();pmrem.dispose();
 scene.add(new THREE.HemisphereLight(0xffffff,0x7c837d,1.05));
 const key=new THREE.DirectionalLight(0xfff4e6,2.6);key.position.set(-6,12,7);key.castShadow=true;key.shadow.mapSize.set(2048,2048);
 Object.assign(key.shadow.camera,{left:-5,right:5,top:5,bottom:-5,near:1,far:40});key.shadow.normalBias=.02;scene.add(key,key.target);
 const ground=new THREE.Mesh(new THREE.PlaneGeometry(14,14),new THREE.MeshStandardMaterial({color:0xbfc6bd,roughness:.95}));
 ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;scene.add(ground);
 for(let i=-2;i<=2;i++){const l=new THREE.Mesh(new THREE.PlaneGeometry(14,.02),new THREE.MeshBasicMaterial({color:0x8d9a94}));l.rotation.x=-Math.PI/2;l.position.set(0,.002,i*.5);scene.add(l);}
 const camera=new THREE.PerspectiveCamera(30,1,.05,100);
 function cameraTo(name){const c={three:[[5.4,2.3,6.4],[0,1.05,.3]],side:[[8.4,2.3,.3],[0,1,.3]],front:[[0,1.5,8.2],[0,1.05,.3]],above:[[2.2,6.5,3.6],[0,.9,.3]]}[name]||[[5.2,2.4,6.2],[0,1.05,.3]];camera.position.fromArray(c[0]);camera.lookAt(V().fromArray(c[1]));camera.updateMatrixWorld(true);view=name;
  const right=V().setFromMatrixColumn(camera.matrixWorld,0);right.y=0;right.normalize();
  lanes.source=right.clone().multiplyScalar(-SPREAD);lanes.fighter=right.clone().multiplyScalar(SPREAD);}
 const lanes={source:V(),fighter:V()};
 let view='three';

 const loader=new GLTFLoader();
 loader.register(parser=>{parser.textureLoader=new THREE.TextureLoader(parser.options.manager);return{name:'image-element-textures'};});
 const gltf=await new Promise((res,rej)=>loader.parse(bytes.buffer,'',res,rej));
 const pawn=createPawnFactory({gltf})({id:'fighter',color:'w'});scene.add(pawn.object);
 const {leg:pawnLeg,ankleHeight}=pawn.mocap.retarget;

 const stickGeo=new THREE.BufferGeometry();stickGeo.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(BONES.length*6),3));
 const stick=new THREE.LineSegments(stickGeo,new THREE.LineBasicMaterial({color:0x2c676f}));stick.frustumCulled=false;scene.add(stick);
 const joints=new THREE.InstancedMesh(new THREE.SphereGeometry(.028,10,8),new THREE.MeshBasicMaterial({color:0xb3261e}),40);joints.frustumCulled=false;scene.add(joints);
 // The modelled blade line next to the recording (dashed: not recorded).
 const bladeGeo=new THREE.BufferGeometry().setFromPoints([V(),V()]);
 const blade=new THREE.Line(bladeGeo,new THREE.LineDashedMaterial({color:0x7a4b12,dashSize:.06,gapSize:.04}));blade.frustumCulled=false;scene.add(blade);

 const file=parseMotionFile(JSON.parse($('#strike-data').textContent));
 const strikes=file.strikes||[];
 const clips=file.clips.map((c,i)=>({...prepareClip(file,c),strike:strikes[i]||{}}));
 $('#clip').innerHTML=clips.map((c,i)=>`<option value="${i}">${c.label}</option>`).join('');
 let index=0,t=0,playing=true,manual=false;
 const clip=()=>clips[index];
 function select(i){index=i;t=0;$('#clip').value=String(i);const s=clip().strike;pawn.equip({armorType:'plate',shieldType:'tower',...(s.loadout||{})});return render();}

 // Body capsules for the blade-through-body check: torso, head, thighs.
 // Radii are the plate armour's outer envelope, generous on purpose (cm):
 // chest 17, head with helmet 14, thigh 9.
 const capsules=[['spine05','neck01',.17],['neck03','head',.14],['upperleg01.L','lowerleg01.L',.09],['upperleg01.R','lowerleg01.R',.09]];
 function segDist(p,a,b){const ab=b.clone().sub(a),u=THREE.MathUtils.clamp(p.clone().sub(a).dot(ab)/ab.lengthSq(),0,1);return p.distanceTo(a.clone().addScaledVector(ab,u));}
 function bladeClearance(m){
  const names=capsules.flatMap(c=>[c[0],c[1]]),P=pawn.points(names),place=pawn.placement();
  // points() is in the pawn's model frame; measure() in world. Bring the tip and grip into the model frame.
  const toModel=v=>{const p=V().fromArray(v).sub(V(place.x,0,place.z)).applyAxisAngle(V(0,1,0),-(place.yaw||0));return p;};
  const grip=toModel(m.weaponGripWorld.R),tip=toModel(m.tip);let min=Infinity,where=null;
  // From 25 cm past the grip outwards: the hilt is in the hands.
  for(let k=0;k<=24;k++){const u=k/24,p=grip.clone().lerp(tip,.18+.82*u);
   for(const [a,b,r]of capsules){const d=segDist(p,V().fromArray(P[a]),V().fromArray(P[b]))-r;if(d<min){min=d;where=a;}}}
  return{min,where};
 }
 function knees(){
  const P=pawn.points(['upperleg01.L','lowerleg01.L','foot.L','toe3-1.L','upperleg01.R','lowerleg01.R','foot.R','toe3-1.R']),sub=(u,v)=>u.map((x,i)=>x-v[i]),dot=(u,v)=>u.reduce((s,x,i)=>s+x*v[i],0),len=u=>Math.hypot(...u);
  const one=s=>{const h=P['upperleg01.'+s],k=P['lowerleg01.'+s],f=P['foot.'+s],u=sub(h,k),v=sub(f,k),flex=180-Math.acos(Math.max(-1,Math.min(1,dot(u,v)/(len(u)*len(v)))))*180/Math.PI;
   const line=sub(f,h),q=dot(sub(k,h),line)/dot(line,line),off=sub(k,h.map((x,i)=>x+line[i]*q)),toe=sub(P['toe3-1.'+s],f),lat=sub(P['upperleg01.L'],P['upperleg01.R']);
   const dir=Math.hypot(toe[0],toe[2])>.87*len(toe)?[toe[0],toe[2]]:[-lat[2],lat[0]],fw=Math.hypot(...dir)||1;
   return{flex,forward:(off[0]*dir[0]+off[2]*dir[1])/fw,sole:Math.min(f[1],P['toe3-1.'+s][1])};};
  return{L:one('L'),R:one('R')};
 }

 function render(){
  const c=clip(),time=Math.min(t,c.duration),k=pawnLeg/c.leg;
  const points=sampleClip(c,time),arms=sampleArms(c,time);
  pawn.pose('rest',0,null,{clip:c,points,weight:1,arms:{phase:arms.phase,...(arms.hand?{hand:arms.hand}:{})}});
  pawn.place({x:lanes.fighter.x,z:lanes.fighter.z,yaw:0});
  const at=v=>[lanes.source.x+v[0]*k,(v[1]-c.ground)*k+ankleHeight,lanes.source.z+v[2]*k];
  const pos=stickGeo.attributes.position.array,m4=new THREE.Matrix4();let n=0,j=0;
  for(const [a,b]of BONES){const A=points[a],B=points[b];pos.set(A&&B?[...at(A),...at(B)]:[0,-9,0,0,-9,0],n);n+=6;}
  stickGeo.attributes.position.needsUpdate=true;
  for(const v of Object.values(points)){if(j>=40)break;m4.makeTranslation(...at(v));joints.setMatrixAt(j++,m4);}joints.count=j;joints.instanceMatrix.needsUpdate=true;
  // Blade line beside the recording, from the same track the fighter follows.
  if(arms.hand){const f=trunkFrame(points),arm=['R','L'].reduce((s,x)=>s+Math.hypot(...points['shoulder'+x].map((v,i)=>v-points['elbow'+x][i]))+Math.hypot(...points['elbow'+x].map((v,i)=>v-points['wrist'+x][i])),0)/2;
   const w=(g,o)=>[0,1,2].map(i=>o[i]+(f.x[i]*g[0]+f.up[i]*g[1]+f.forward[i]*g[2]));
   const grip=w(arms.hand.grip.map(v=>v*arm),f.origin),tip=w(arms.hand.axis.map(v=>v*arm*1.75),grip);
   bladeGeo.setFromPoints([V().fromArray(at(grip)),V().fromArray(at(tip))]);blade.computeLineDistances();blade.visible=true;}
  else blade.visible=false;
  renderer.render(scene,camera);
  $('#time').value=String(Math.round(time/c.duration*1000));$('#out').value=time.toFixed(2)+' с';
  const m=pawn.measureWorld(),bio=pawn.biomechanics(),kn=knees(),clear=bladeClearance(m);
  const shield=m.effectiveShield!=='none'?pawn.shieldHit(m.weaponGripWorld.R,m.tip):null;
  return{t:time,knees:kn,elbow:{R:bio.R.elbowFlexDeg,L:bio.L.elbowFlexDeg},wrist:{R:bio.R.wristBendDeg,L:bio.L.wristBendDeg},
   forearmTwist:{R:bio.R.forearmTwistDeg,L:bio.L.forearmTwistDeg},grip:{R:m.rightGripErrorM,L:m.leftGripErrorM},reach:m.reachErrors,blade:clear,shieldHit:shield,tip:m.tip};
 }
 function resize(){const w=innerWidth,h=innerHeight;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();render();}
 addEventListener('resize',resize);
 $('#clip').onchange=()=>select(+$('#clip').value);
 $('#play').onclick=()=>{playing=!playing;$('#play').textContent=playing?'Пауза':'Пуск';};
 $('#time').oninput=()=>{playing=false;t=+$('#time').value/1000*clip().duration;render();};
 for(const b of document.querySelectorAll('[data-cam]'))b.onclick=()=>{cameraTo(b.dataset.cam);render();};
 cameraTo('three');select(0);resize();$('#loading').hidden=true;
 let last=null;
 (function loop(now){requestAnimationFrame(loop);if(manual||now===undefined)return;const dt=last===null?0:Math.min(.1,(now-last)/1000);last=now;if(playing){t+=dt;if(t>clip().duration+.6)t=0;}try{render();}catch(e){console.error(e);}})();
 window.strikeLab={ready:true,pawn,list:()=>clips.map(c=>({name:c.name,label:c.label,duration:c.duration,count:c.count,strike:c.strike})),select,
  manual(on=true){manual=on;last=null;},set(x){t=x;return render();},camera(name){cameraTo(name);return render();},
  size(w,h){renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();},
  screenshot(){render();return renderer.domElement.toDataURL('image/png');}};
}
