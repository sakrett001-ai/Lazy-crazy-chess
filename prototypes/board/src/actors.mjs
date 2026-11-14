import * as THREE from 'three';
import {clone as cloneSkinned} from 'three/addons/utils/SkeletonUtils.js';
import {createLoadout} from '../../white-pawn/src/loadout.mjs';
import {paintSurface} from '../../white-pawn/src/surfaces.mjs';
import {deterministicClip} from '../../white-pawn/src/camera-rig.mjs';
import {createBodyRig} from './motion.mjs';
import {createGrounding} from './grounding.mjs';
import {createMocapDriver} from './mocap/apply.mjs';
import {createFootLock} from './mocap/footlock.mjs';
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
  if(paint)paintSurface(copy,...paint);
  cache.set(material,copy);
 }
 return cache.get(material);
}

// Places a figure on the board. Poses are always solved with the holder at
// the origin, because the workshop's motion layers work in model space;
// the board transform is applied afterwards. ground ({height,normal}) puts
// the holder on the field: at the ground's height when raise is set (a
// stand-in), and a fall ends lying along the slope it falls on. A pawn's
// height is set by its feet after the pose (grounding.mjs).
function placement(holder,ground=null,raise=false){
 const yawQ=new THREE.Quaternion(),fallQ=new THREE.Quaternion(),up=new THREE.Vector3(0,1,0),axis=new THREE.Vector3();
 let last={x:0,z:0,yaw:0,fall:0,fallHeading:0,lift:0};
 return{
  set({x=last.x,z=last.z,yaw=last.yaw,fall=0,fallHeading=0,lift=0}={}){
   last={x,z,yaw,fall,fallHeading,lift};
   yawQ.setFromAxisAngle(up,yaw);
   axis.set(Math.cos(fallHeading),0,-Math.sin(fallHeading));
   // The fall turns the figure about its feet towards (sin, cos) of its
   // heading; ground rising that way stops it short, falling ground lets it
   // go further, so the body comes to rest along the slope (1.47 rad: the
   // board's full fall).
   let f=fall;
   if(ground&&fall>0){const d=1.5,s=(ground.height(x+Math.sin(fallHeading)*d,z+Math.cos(fallHeading)*d)-ground.height(x,z))/d;f=fall-Math.atan(s)*Math.min(1,fall/1.47);}
   fallQ.setFromAxisAngle(axis,f);
   holder.position.set(x,lift+(ground&&raise?ground.height(x,z):0),z);holder.quaternion.copy(fallQ).multiply(yawQ);holder.updateMatrixWorld(true);
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

// ground: the field ({height,normal}) the board's pawns stand on; a pawn
// created with grounded stands on it, the measuring probes on the flat.
export function createPawnFactory({gltf,ground=null}){
 const caches={w:new Map(),b:new Map()};
 return function createPawn({id,color,weapons=[],grounded=false}){
  const model=cloneSkinned(gltf.scene),holder=new THREE.Group();
  holder.name=id;holder.add(model);
  const bones={},meshes=[];
  model.traverse(o=>{if(o.isBone)bones[o.name]=o;if(o.isMesh){meshes.push(o);o.castShadow=true;o.receiveShadow=true;o.frustumCulled=false;o.material=Array.isArray(o.material)?o.material.map(m=>factionMaterial(caches[color],m,color)):factionMaterial(caches[color],o.material,color);}});
  holder.updateMatrixWorld(true);
  const rest=Object.entries(bones).map(([,b])=>[b,b.position.clone(),b.quaternion.clone(),b.scale.clone()]);
  const restore=()=>{for(const [b,p,q,s]of rest){b.position.copy(p);b.quaternion.copy(q);b.scale.copy(s);}};
  const loadout=createLoadout({model,bones,extraWeapons:weapons});
  loadout.apply({});
  const rig=createBodyRig({bones});
  const mocap=createMocapDriver({bones,holder});
  const feet=createFootLock({bones,holder,retarget:mocap.retarget});
  const field=grounded&&ground?ground:null,grounding=createGrounding({bones,holder});
  const samplers=Object.fromEntries(gltf.animations.map((clip,index)=>[clip.name,deterministicClip(model,gltf.animations,index)]));
  const place=placement(holder,field),fade=fader(holder);
  let pose={action:'rest',time:0};
  // layer: the procedural body layer of motion.mjs, applied over the clip
  // sample and before the arms are solved. motion: an imported motion clip
  // (mocap/format.mjs) for the body, {clip,time,weight,inPlace,points,arms};
  // blended over the sample by weight, under the layer, before the arms.
  // arms: {phase,shield} for the loadout when the clip times the arms too.
  function solve(action,time,layer=null,motion=null){
   const saved=place.get();
   holder.position.set(0,0,0);holder.quaternion.identity();holder.updateMatrixWorld(true);
   restore();samplers[action]?.seek(time);holder.updateMatrixWorld(true);
   // The stance a clip fades into: the feet of the pose under it (holder frame).
   const fading=motion?.feet!=null&&(motion.blend||[motion]).some(m=>m?.clip&&(m.weight??1)<1);
   const stance=fading?feet.capture():null;
   if(motion&&(motion.clip||motion.blend))for(const m of motion.blend||[motion])if(m?.clip)mocap.apply(m.points||sampleClip(m.clip,m.time,{inPlace:m.inPlace}),m.clip,m.weight??1);
   // A clip at full weight owns the legs and trunk, the thrust's body layer included.
   const clipWeight=motion?Math.max(0,...(motion.blend||[motion]).filter(m=>m?.clip).map(m=>m.weight??1)):0,clipBody=clipWeight>=1;
   holder.updateMatrixWorld(true);rig.apply(layer);
   // The board's frames (motion.feet, its clock) carry the head at the neck's pace.
   // A pose with no clip at all (the board's own stance) is held the same way.
   const held=motion?.feet!=null&&(clipWeight>0||!(motion.clip||motion.blend)),hold=clipWeight>0?clipWeight:1;
   // motion.head: the board's clock for the head alone (a walk whose feet
   // the clip places), so the head keeps its pace from the walk into the stance.
   mocap.steady(held?motion.feet:motion?.head??null,saved.yaw);
   loadout.poseAt(action,time,{body:!clipBody,...(motion?.arms||{})});
   place.set(saved);
   // motion.feet (the board's clock): the clip's feet are held where they
   // stand (mocap/footlock.mjs) while the clip moves the legs, and while it
   // hands them over to the stance it fades into (the feet step onto that
   // stance instead of sliding into it). A pause in the poses or a jump in
   // place starts the hold over.
   if(held&&!saved.fall&&!saved.lift)feet.apply(motion.feet,{hold,stance});
   // Last: the pose solved on the flat goes onto the field.
   if(field)grounding.apply(field,{fall:saved.fall});
   pose={action,time,layered:!!layer,motion:(motion?.blend||[motion]).filter(m=>m?.clip).map(m=>m.clip.name).join('+')||null};
  }
  // Spear tip and shield face in the model frame for one pose (metres);
  // motion as in solve, for a pose from a clip.
  function probe(action,time,layer=null,motion=null){
   const saved=place.get();solve(action,time,layer,motion);
   holder.position.set(0,0,0);holder.quaternion.identity();holder.updateMatrixWorld(true);
   const m=loadout.measure();
   place.set(saved);
   return{tip:m.tip,shieldGrip:m.shieldGripWorld,grip:m.weaponGripWorld?.R||null};
  }
  // Foremost point of the visible shield along the figure's forward axis.
  function shieldFront(action,time,motion=null){
   const saved=place.get();solve(action,time,null,motion);
   holder.position.set(0,0,0);holder.quaternion.identity();holder.updateMatrixWorld(true);
   const point=new THREE.Vector3();let front=-Infinity,sx=0,sz=0,n=0;
   const visible=o=>{for(let n=o;n;n=n.parent)if(!n.visible)return false;return true;};
   const inShield=o=>{for(let n=o;n;n=n.parent)if(n.userData?.equipmentSlot==='shield')return true;return false;};
   for(const mesh of meshes){if(!inShield(mesh)||!visible(mesh))continue;const positions=mesh.geometry.attributes.position;
    for(let i=0;i<positions.count;i+=3){mesh.getVertexPosition(i,point);point.applyMatrix4(mesh.matrixWorld);front=Math.max(front,point.z);sx+=point.x;sz+=point.z;n++;}}
   place.set(saved);
   return{front,centerX:sx/n,centerZ:sz/n};
  }
  // Where the segment a→b (world, metres) first meets this pawn's visible
  // shield, as a distance from a, or null. Skinned shields are ray cast in
  // their current pose and from both sides, for the contact checks.
  const ray=new THREE.Raycaster();
  function shieldHit(a,b){
   holder.updateMatrixWorld(true);
   const from=new THREE.Vector3(...a),dir=new THREE.Vector3(...b).sub(from),far=dir.length();
   const visible=o=>{for(let n=o;n;n=n.parent)if(!n.visible)return false;return true;};
   const inShield=o=>{for(let n=o;n;n=n.parent)if(n.userData?.equipmentSlot==='shield')return true;return false;};
   ray.set(from,dir.normalize());ray.near=0;ray.far=far;let best=null;
   for(const mesh of meshes){if(!inShield(mesh)||!visible(mesh))continue;
    if(mesh.isSkinnedMesh)mesh.computeBoundingSphere();
    const list=Array.isArray(mesh.material)?mesh.material:[mesh.material],sides=list.map(m=>m.side);
    for(const m of list)m.side=THREE.DoubleSide;
    const hit=ray.intersectObject(mesh,false)[0];
    list.forEach((m,i)=>m.side=sides[i]);
    if(hit&&(best===null||hit.distance<best))best=hit.distance;}
   return best;
  }
  // The visible shield as a plate in the world (metres): its middle, the
  // normal pointing to the side it faces (away from the bearer's pelvis),
  // two axes in its face (u the longer one) and the half sizes along them.
  // Vertices of the current (skinned) pose, every 3rd; the axes are the
  // principal axes of those points. For the coherence checks of a duel
  // (Lazy-skills-lab strike-principles, pair_check.py), not for drawing.
  function shieldPlane(){
   holder.updateMatrixWorld(true);
   const visible=o=>{for(let n=o;n;n=n.parent)if(!n.visible)return false;return true;};
   const inShield=o=>{for(let n=o;n;n=n.parent)if(n.userData?.equipmentSlot==='shield')return true;return false;};
   const pts=[],v=new THREE.Vector3();
   for(const mesh of meshes){if(!inShield(mesh)||!visible(mesh))continue;mesh.updateMatrixWorld(true);const positions=mesh.geometry.attributes.position;
    for(let i=0;i<positions.count;i+=3){mesh.getVertexPosition(i,v);v.applyMatrix4(mesh.matrixWorld);pts.push([v.x,v.y,v.z]);}}
   if(pts.length<8)return null;
   const c=[0,1,2].map(k=>pts.reduce((s,p)=>s+p[k],0)/pts.length),C=[[0,0,0],[0,0,0],[0,0,0]];
   for(const p of pts){const d=p.map((x,k)=>x-c[k]);for(let a=0;a<3;a++)for(let b=0;b<3;b++)C[a][b]+=d[a]*d[b]/pts.length;}
   // Jacobi eigen decomposition of the 3×3 covariance.
   const A=C.map(r=>[...r]),V=[[1,0,0],[0,1,0],[0,0,1]];
   for(let it=0;it<40;it++){let p=0,q=1;for(const [a,b] of [[0,1],[0,2],[1,2]])if(Math.abs(A[a][b])>Math.abs(A[p][q])){p=a;q=b;}
    if(Math.abs(A[p][q])<1e-12)break;const th=.5*Math.atan2(2*A[p][q],A[q][q]-A[p][p]),cs=Math.cos(th),sn=Math.sin(th);
    for(let k=0;k<3;k++){const akp=A[k][p],akq=A[k][q];A[k][p]=cs*akp-sn*akq;A[k][q]=sn*akp+cs*akq;}
    for(let k=0;k<3;k++){const apk=A[p][k],aqk=A[q][k];A[p][k]=cs*apk-sn*aqk;A[q][k]=sn*apk+cs*aqk;}
    for(let k=0;k<3;k++){const vkp=V[k][p],vkq=V[k][q];V[k][p]=cs*vkp-sn*vkq;V[k][q]=sn*vkp+cs*vkq;}}
   const order=[0,1,2].sort((a,b)=>A[b][b]-A[a][a]),axis=i=>[V[0][order[i]],V[1][order[i]],V[2][order[i]]];
   const u=axis(0),w=axis(1);let n=axis(2);
   const pelvis=bones.root?bones.root.getWorldPosition(new THREE.Vector3()).toArray():c;
   if((c[0]-pelvis[0])*n[0]+(c[2]-pelvis[2])*n[2]<0)n=n.map(x=>-x);
   const half=[u,w].map(a=>Math.max(...pts.map(p=>Math.abs((p[0]-c[0])*a[0]+(p[1]-c[1])*a[1]+(p[2]-c[2])*a[2]))));
   const r=x=>+x.toFixed(4);
   return{center:c.map(r),normal:n.map(r),u:u.map(r),v:w.map(r),half:half.map(r)};
  }
  // Bone positions in the model frame for the current pose.
  function points(names){holder.updateMatrixWorld(true);const inverse=holder.matrixWorld.clone().invert();const norm=x=>String(x).replace(/[._\-\s]/g,'').toLowerCase(),by=new Map(Object.entries(bones).map(([k,b])=>[norm(k),b]));return Object.fromEntries(names.map(n=>[n,by.get(norm(n))?by.get(norm(n)).getWorldPosition(new THREE.Vector3()).applyMatrix4(inverse).toArray().map(v=>+v.toFixed(3)):null]));}
  return{id,kind:'pawn',color,object:holder,pose:solve,ground:()=>field?grounding.gaps(field):null,equip:settings=>loadout.apply(settings),loadout:()=>loadout.summary(),biomechanics:()=>loadout.biomechanics(),mocap,feet,points,rig,probe,shieldFront,shieldHit,shieldPlane,measureWorld:()=>loadout.measure(),place:o=>{place.set(o);if(field)grounding.follow(field,{fall:place.get().fall});},placement:place.get,fade,current:()=>({...pose}),dispose(){holder.removeFromParent();}};
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
export function createToken({id,type,color},ground=null){
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
 const place=placement(holder,ground,true);
 return{id,kind:'token',type,color,object:holder,pose(){},probe:()=>null,place:place.set,placement:place.get,fade:fader(holder),current:()=>({action:'rest',time:0}),dispose(){holder.removeFromParent();}};
}
