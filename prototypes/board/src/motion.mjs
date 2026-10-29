import * as THREE from 'three';

// Procedural body layer over a sampled clip. The pawn model has only three
// clips (breathing guard, shield brace, spear study) and no walk, so weight,
// steps, buckling knees and torso turns are added here. The layer works in
// model space (holder at the origin, forward +Z, the figure's left +X) and
// runs before the loadout solves the arms, so the spear and the shield
// follow the torso. Every value is an absolute function of the caller's
// time; nothing is integrated between frames.
const V=(x=0,y=0,z=0)=>new THREE.Vector3(x,y,z),Q=()=>new THREE.Quaternion();
const X=V(1,0,0),Y=V(0,1,0),Z=V(0,0,1);
const SPINE=[['spine01',.16],['spine02',.2],['spine03',.22],['spine04',.22],['spine05',.2]];

const normalize=s=>String(s).replace(/[._\-\s]/g,'').toLowerCase();
export function createBodyRig({bones}){
 const map=new Map(Object.entries(bones).map(([n,b])=>[normalize(n),b]));
 const bone=n=>{const b=map.get(normalize(n));if(!b)throw Error('В модели нет кости '+n);return b;};
 const world=n=>bone(n).getWorldPosition(V());
 const worldQ=n=>bone(n).getWorldQuaternion(Q());
 function setWorldQ(name,q){const b=bone(name);b.quaternion.copy(b.parent.getWorldQuaternion(Q()).invert().multiply(q)).normalize();b.updateMatrixWorld(true);}
 const turn=(name,axis,angle)=>{if(angle)setWorldQ(name,Q().setFromAxisAngle(axis,angle).multiply(worldQ(name)));};
 const legs=Object.fromEntries(['L','R'].map(side=>{
  const h=world('upperleg01.'+side),k=world('lowerleg01.'+side),f=world('foot.'+side);
  return[side,{upper:'upperleg01.'+side,lower:'lowerleg01.'+side,foot:'foot.'+side,a:h.distanceTo(k),b:k.distanceTo(f)}];
 }));
 // Two-bone leg to a foot target. The knee bends forward along the foot's
 // heading; an out-of-reach target is pulled back inside the reach.
 function solveLeg(side,target,footQ,heading){
  const c=legs[side],h=world(c.upper),delta=target.clone().sub(h);let distance=delta.length();const d=delta.normalize();
  distance=THREE.MathUtils.clamp(distance,Math.abs(c.a-c.b)+.02,c.a+c.b-.004);
  const end=h.clone().addScaledVector(d,distance);
  const pole=V(Math.sin(heading)+(side==='L'?.06:-.06),0,Math.cos(heading));pole.addScaledVector(d,-pole.dot(d)).normalize();
  const along=(c.a*c.a-c.b*c.b+distance*distance)/(2*distance),height=Math.sqrt(Math.max(0,c.a*c.a-along*along));
  const knee=h.clone().addScaledVector(d,along).addScaledVector(pole,height);
  setWorldQ(c.upper,Q().setFromUnitVectors(world(c.lower).sub(h).normalize(),knee.clone().sub(h).normalize()).multiply(worldQ(c.upper)));
  setWorldQ(c.lower,Q().setFromUnitVectors(world(c.foot).sub(world(c.lower)).normalize(),end.clone().sub(knee).normalize()).multiply(worldQ(c.lower)));
  setWorldQ(c.foot,footQ);
 }
 // layer: {root:[x,y,z] metres, pelvis:{yaw,roll,pitch}, spine:{bend,side,twist},
 // head:{bend,twist}, feet:{L,R:{offset:[x,y,z],yaw,pitch}}}; angles in radians.
 function apply(layer){
  if(!layer)return;
  const root=bone('root');root.parent.updateMatrixWorld(true);root.updateMatrixWorld(true);
  const soles=Object.fromEntries(['L','R'].map(side=>[side,{point:world(legs[side].foot),q:worldQ(legs[side].foot)}]));
  if(layer.root){const p=world('root').add(V(...layer.root));root.position.copy(root.parent.worldToLocal(p));root.updateMatrixWorld(true);}
  const pelvis=layer.pelvis||{};
  turn('root',Y,pelvis.yaw||0);turn('root',Z,pelvis.roll||0);turn('root',X,pelvis.pitch||0);
  for(const side of ['L','R']){
   const f=layer.feet?.[side]||{},o=f.offset||[0,0,0],yaw=f.yaw||0;
   const target=soles[side].point.clone().add(V(...o));
   const q=Q().setFromAxisAngle(V(Math.cos(yaw),0,-Math.sin(yaw)),f.pitch||0).multiply(Q().setFromAxisAngle(Y,yaw)).multiply(soles[side].q);
   solveLeg(side,target,q,yaw);
  }
  const s=layer.spine||{};
  // Bend about the figure's left axis (+ leans forward), side bend about its
  // forward axis (+ leans to its left), twist about up (+ turns to its left).
  for(const [name,share]of SPINE){turn(name,Y,(s.twist||0)*share);turn(name,X,(s.bend||0)*share);turn(name,Z,-(s.side||0)*share);}
  const head=layer.head||{};turn('head',Y,head.twist||0);turn('head',X,head.bend||0);
 }
 const rest=()=>Object.fromEntries(['L','R'].map(side=>[side,world(legs[side].foot).toArray()]));
 return{apply,rest,legs};
}
