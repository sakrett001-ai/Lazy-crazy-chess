import * as THREE from 'three';
import {clone as cloneSkinned} from 'three/addons/utils/SkeletonUtils.js';
import {createLoadout} from '../../white-pawn/src/loadout.mjs';
import {deterministicClip} from '../../white-pawn/src/camera-rig.mjs';
import {createBodyRig} from './motion.mjs';
import {createMocapDriver} from './mocap/apply.mjs';
import {sampleClip} from './mocap/format.mjs';

// Faction finishes on the one shared pawn model. White keeps the workshop
// default (steel, white shield). Black is a temporary repaint until the
// obsidian pawn gets its own geometry: dark glossy plate, blood-red enamel.
export const PALETTES=Object.freeze({
 w:{'armor.main':[[.50,.54,.58],1,.32],'armor.trim':[[.60,.64,.67],1,.24],mail:[[.50,.54,.58],1,.52],'shield.face':[[.82,.82,.78],0,.42],'shield.emblem':[[.025,.135,.16],.28,.31],'weapon.wood':[[.24,.135,.061],0,.62],'weapon.metal':[[.50,.57,.62],1,.27],skin:[[.46,.27,.16],0,.65],hair:[[.055,.026,.012],0,.88]},
 b:{'armor.main':[[.035,.036,.042],.85,.2],'armor.trim':[[.36,.018,.02],.35,.24],mail:[[.06,.062,.07],1,.45],'shield.face':[[.03,.028,.032],.2,.22],'shield.emblem':[[.42,.015,.02],.3,.26],'weapon.wood':[[.021,.014,.010],0,.55],'weapon.metal':[[.10,.13,.16],1,.27],skin:[[.46,.27,.16],0,.65],hair:[[.012,.009,.007],0,.88]}
});
const TOKEN_COLORS={w:{main:0xd9d1bf,band:0x2c676f},b:{main:0x0b0b0e,band:0x6b0508}};

const slotOf=m=>m.userData?.customizationSlot||m.name;
function factionMaterial(cache,material,color){
 if(!cache.has(material)){
  const copy=material.clone(),paint=PALETTES[color][slotOf(material)];
  if(paint){copy.color.setRGB(...paint[0]);copy.metalness=paint[1];copy.roughness=paint[2];}
  cache.set(material,copy);
 }
 return cache.get(material);
}

// Places a figure on the board. Poses are always solved with the holder at
// the origin, because the workshop's motion layers work in model space;
// the board transform is applied afterwards.
function placement(holder){
 const yawQ=new THREE.Quaternion(),fallQ=new THREE.Quaternion(),up=new THREE.Vector3(0,1,0),axis=new THREE.Vector3();
 let last={x:0,z:0,yaw:0,fall:0,fallHeading:0,lift:0};
 return{
  set({x=last.x,z=last.z,yaw=last.yaw,fall=0,fallHeading=0,lift=0}={}){
   last={x,z,yaw,fall,fallHeading,lift};
   yawQ.setFromAxisAngle(up,yaw);
   axis.set(Math.cos(fallHeading),0,-Math.sin(fallHeading));
   fallQ.setFromAxisAngle(axis,fall);
   holder.position.set(x,lift,z);holder.quaternion.copy(fallQ).multiply(yawQ);holder.updateMatrixWorld(true);
  },
  get:()=>({...last})
 };
}

function fader(holder){
 let own=false;
 return opacity=>{
  if(opacity>=1&&!own)return;
  if(!own){own=true;holder.traverse(o=>{if(!o.isMesh)return;o.material=Array.isArray(o.material)?o.material.map(m=>m.clone()):o.material.clone();});}
  holder.traverse(o=>{if(!o.isMesh)return;for(const m of Array.isArray(o.material)?o.material:[o.material]){m.transparent=opacity<1;m.opacity=opacity;}o.castShadow=opacity>.6;});
 };
}

export function createPawnFactory({gltf}){
 const caches={w:new Map(),b:new Map()};
 return function createPawn({id,color}){
  const model=cloneSkinned(gltf.scene),holder=new THREE.Group();
  holder.name=id;holder.add(model);
  const bones={},meshes=[];
  model.traverse(o=>{if(o.isBone)bones[o.name]=o;if(o.isMesh){meshes.push(o);o.castShadow=true;o.receiveShadow=true;o.frustumCulled=false;o.material=Array.isArray(o.material)?o.material.map(m=>factionMaterial(caches[color],m,color)):factionMaterial(caches[color],o.material,color);}});
  holder.updateMatrixWorld(true);
  const rest=Object.entries(bones).map(([,b])=>[b,b.position.clone(),b.quaternion.clone(),b.scale.clone()]);
  const restore=()=>{for(const [b,p,q,s]of rest){b.position.copy(p);b.quaternion.copy(q);b.scale.copy(s);}};
  const loadout=createLoadout({model,bones});
  loadout.apply({});
  const rig=createBodyRig({bones});
  const mocap=createMocapDriver({bones,holder});
  const samplers=Object.fromEntries(gltf.animations.map((clip,index)=>[clip.name,deterministicClip(model,gltf.animations,index)]));
  const place=placement(holder),fade=fader(holder);
  let pose={action:'rest',time:0};
  // layer: the procedural body layer of motion.mjs, applied over the clip
  // sample and before the arms are solved. motion: an imported motion clip
  // (mocap/format.mjs) for the body, {clip,time,weight,inPlace,points};
  // blended over the sample by weight, under the layer, before the arms.
  function solve(action,time,layer=null,motion=null){
   const saved=place.get();
   holder.position.set(0,0,0);holder.quaternion.identity();holder.updateMatrixWorld(true);
   restore();samplers[action]?.seek(time);holder.updateMatrixWorld(true);
   if(motion&&(motion.clip||motion.blend))for(const m of motion.blend||[motion])if(m?.clip)mocap.apply(m.points||sampleClip(m.clip,m.time,{inPlace:m.inPlace}),m.clip,m.weight??1);
   // A clip at full weight owns the legs and trunk, the thrust's body layer included.
   const clipBody=!!motion&&(motion.blend||[motion]).some(m=>m?.clip&&(m.weight??1)>=1);
   holder.updateMatrixWorld(true);rig.apply(layer);loadout.poseAt(action,time,{body:!clipBody});
   place.set(saved);pose={action,time,layered:!!layer,motion:(motion?.blend||[motion]).filter(m=>m?.clip).map(m=>m.clip.name).join('+')||null};
  }
  // Spear tip and shield face in the model frame for one pose (metres).
  function probe(action,time,layer=null){
   const saved=place.get();solve(action,time,layer);
   holder.position.set(0,0,0);holder.quaternion.identity();holder.updateMatrixWorld(true);
   const m=loadout.measure();
   place.set(saved);
   return{tip:m.tip,shieldGrip:m.shieldGripWorld};
  }
  // Foremost point of the visible shield along the figure's forward axis.
  function shieldFront(action,time){
   const saved=place.get();solve(action,time);
   holder.position.set(0,0,0);holder.quaternion.identity();holder.updateMatrixWorld(true);
   const point=new THREE.Vector3();let front=-Infinity,sx=0,sz=0,n=0;
   const visible=o=>{for(let n=o;n;n=n.parent)if(!n.visible)return false;return true;};
   const inShield=o=>{for(let n=o;n;n=n.parent)if(n.userData?.equipmentSlot==='shield')return true;return false;};
   for(const mesh of meshes){if(!inShield(mesh)||!visible(mesh))continue;const positions=mesh.geometry.attributes.position;
    for(let i=0;i<positions.count;i+=3){mesh.getVertexPosition(i,point);point.applyMatrix4(mesh.matrixWorld);front=Math.max(front,point.z);sx+=point.x;sz+=point.z;n++;}}
   place.set(saved);
   return{front,centerX:sx/n,centerZ:sz/n};
  }
  // Bone positions in the model frame for the current pose.
  function points(names){holder.updateMatrixWorld(true);const inverse=holder.matrixWorld.clone().invert();const norm=x=>String(x).replace(/[._\-\s]/g,'').toLowerCase(),by=new Map(Object.entries(bones).map(([k,b])=>[norm(k),b]));return Object.fromEntries(names.map(n=>[n,by.get(norm(n))?by.get(norm(n)).getWorldPosition(new THREE.Vector3()).applyMatrix4(inverse).toArray().map(v=>+v.toFixed(3)):null]));}
  return{id,kind:'pawn',color,object:holder,pose:solve,mocap,points,rig,probe,shieldFront,measureWorld:()=>loadout.measure(),place:place.set,placement:place.get,fade,current:()=>({...pose}),dispose(){holder.removeFromParent();}};
 };
}

// Stand-ins for the figures that are not modelled yet. Each keeps its
// classical silhouette so the position stays readable.
const PROFILES={
 r:[[0,0],[.42,0],[.42,.12],[.33,.2],[.3,1.15],[.38,1.3],[.38,1.62],[0,1.62]],
 b:[[0,0],[.4,0],[.4,.12],[.3,.2],[.2,1.15],[.3,1.3],[.24,1.6],[.17,1.9],[.06,2.05],[0,2.08]],
 q:[[0,0],[.44,0],[.44,.12],[.32,.22],[.2,1.35],[.34,1.55],[.4,1.95],[.22,2.02],[.12,2.2],[0,2.25]],
 k:[[0,0],[.45,0],[.45,.12],[.33,.22],[.22,1.45],[.36,1.65],[.32,2.05],[.12,2.12],[0,2.14]],
 n:[[0,0],[.42,0],[.42,.12],[.32,.22],[.28,.62],[0,.62]],
 p:[[0,0],[.36,0],[.36,.1],[.26,.18],[.14,.9],[.24,1.05],[.2,1.3],[0,1.38]]
};
function knightHead(material){
 const s=new THREE.Shape();
 s.moveTo(-.22,0);s.lineTo(.26,0);s.lineTo(.2,.55);s.quadraticCurveTo(.42,.9,.5,1.02);s.lineTo(.38,1.14);s.quadraticCurveTo(.1,1.3,-.08,1.24);
 s.lineTo(-.14,1.36);s.lineTo(-.22,1.18);s.quadraticCurveTo(-.36,.7,-.22,0);
 const g=new THREE.ExtrudeGeometry(s,{depth:.3,bevelEnabled:true,bevelSize:.04,bevelThickness:.04,bevelSegments:2});g.translate(0,0,-.15);
 // The shape is drawn facing +X; turn it so the muzzle faces local +Z.
 g.rotateY(-Math.PI/2);
 const head=new THREE.Mesh(g,material);head.position.y=.58;return head;
}
export function createToken({id,type,color}){
 const holder=new THREE.Group();holder.name=id;
 const palette=TOKEN_COLORS[color];
 const material=new THREE.MeshStandardMaterial({color:palette.main,roughness:color==='w'?.38:.16,metalness:color==='w'?0:.3});
 const band=new THREE.MeshStandardMaterial({color:palette.band,roughness:.3,metalness:.4});
 const body=new THREE.Mesh(new THREE.LatheGeometry(PROFILES[type].map(([r,y])=>new THREE.Vector2(r,y)),40),material);
 holder.add(body);
 const ring=new THREE.Mesh(new THREE.TorusGeometry(.33,.035,10,40),band);ring.rotation.x=Math.PI/2;ring.position.y=.2;holder.add(ring);
 if(type==='n')holder.add(knightHead(material));
 if(type==='k'){const c=new THREE.Mesh(new THREE.BoxGeometry(.08,.34,.08),band),h=new THREE.Mesh(new THREE.BoxGeometry(.26,.08,.08),band);c.position.y=2.3;h.position.y=2.34;holder.add(c,h);}
 if(type==='q'){const ball=new THREE.Mesh(new THREE.SphereGeometry(.08,16,12),band);ball.position.y=2.3;holder.add(ball);}
 holder.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});
 const place=placement(holder);
 return{id,kind:'token',type,color,object:holder,pose(){},probe:()=>null,place:place.set,placement:place.get,fade:fader(holder),current:()=>({action:'rest',time:0}),dispose(){holder.removeFromParent();}};
}
