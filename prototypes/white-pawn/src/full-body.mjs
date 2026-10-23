import * as THREE from 'three';

// A compact, planted thrust: the imported clip supplies preparation and
// recovery; this layer distributes its drive through both knees and thorax.
// It is evaluated after each absolute clip sample, never integrated in time.
const V=()=>new THREE.Vector3(),Q=()=>new THREE.Quaternion();
const normalize=s=>String(s).replace(/[._\-\s]/g,'').toLowerCase();
const perpendicular=(v,axis)=>v.clone().addScaledVector(axis,-v.dot(axis));

export function createFullBodyMotion({model,bones,update}){
 const map=new Map(Object.entries(bones).map(([n,b])=>[normalize(n),b])),bind=new Map();
 model.traverse(o=>{if(o.isBone)map.set(normalize(o.name),o);if(o.isSkinnedMesh)for(let i=0;i<o.skeleton.bones.length;i++){const b=o.skeleton.bones[i];if(!bind.has(normalize(b.name)))bind.set(normalize(b.name),o.skeleton.boneInverses[i].clone().invert());}});
 const bone=n=>map.get(normalize(n)),point=n=>bone(n).getWorldPosition(V());
 const bindPoint=n=>V().setFromMatrixPosition(bind.get(normalize(n)));
 const legs=Object.fromEntries(['L','R'].map(side=>{
  const upper='upperleg01.'+side,lower='lowerleg01.'+side,foot='foot.'+side;
  const h=bindPoint(upper),k=bindPoint(lower),f=bindPoint(foot);
  return[side,{upper,lower,foot,a:h.distanceTo(k),b:k.distanceTo(f)}];
 }));
 function worldQ(name,q){const b=bone(name);b.quaternion.copy(b.parent.getWorldQuaternion(Q()).invert().multiply(q)).normalize();b.updateWorldMatrix(false,true);}
 function solveLeg(side,target,footQ){
  const c=legs[side],h=point(c.upper),delta=target.clone().sub(h),distance=delta.length(),d=delta.normalize();
  if(distance>=c.a+c.b-.001||distance<=Math.abs(c.a-c.b)+.001)throw Error('Planted thrust exceeds leg reach: '+side);
  const pole=new THREE.Vector3(side==='L'?.06:-.06,0,1),bend=perpendicular(pole,d).normalize();
  const along=(c.a*c.a-c.b*c.b+distance*distance)/(2*distance),height=Math.sqrt(Math.max(0,c.a*c.a-along*along));
  const knee=h.clone().addScaledVector(d,along).addScaledVector(bend,height),a=knee.clone().sub(h).normalize(),b=target.clone().sub(knee).normalize();
  // Preserve the sampled link twist while changing its direction. This
  // avoids a sudden knee-plane reset when the drive envelope leaves zero.
  const upperDelta=Q().setFromUnitVectors(point(c.lower).sub(h).normalize(),a);
  worldQ(c.upper,upperDelta.multiply(bone(c.upper).getWorldQuaternion(Q())));
  const lowerDelta=Q().setFromUnitVectors(point(c.foot).sub(point(c.lower)).normalize(),b);
  worldQ(c.lower,lowerDelta.multiply(bone(c.lower).getWorldQuaternion(Q())));worldQ(c.foot,footQ);
 }
 function apply(action,phase){
  if(action!=='Spear_Study'||phase.thrust===0)return;
  const x=point('upperarm01.L').sub(point('upperarm01.R')).normalize();
  const up=new THREE.Vector3(0,1,0),forward=x.clone().cross(up).normalize();
  const soles=Object.fromEntries(['L','R'].map(side=>[side,{point:point(legs[side].foot),rotation:bone(legs[side].foot).getWorldQuaternion(Q())}]));
  // The front knee accepts the drive while the rear knee extends. Without
  // this small lowering the original clip straightened both legs at impact.
  const root=bone('root'),position=point('root').addScaledVector(up,-.030*phase.thrust).addScaledVector(forward,.045*phase.thrust);
  root.position.copy(root.parent.worldToLocal(position));update();
  for(const side of ['L','R'])solveLeg(side,soles[side].point,soles[side].rotation);
  // Share the forward inclination over the thoracic chain; do not hinge the
  // entire person at the pelvis. Keep the head's extra inclination modest.
  for(const [name,degrees]of [['spine03',5],['spine02',4],['spine01',3],['head',-7]])worldQ(name,Q().setFromAxisAngle(x,THREE.MathUtils.degToRad(degrees)*phase.thrust).multiply(bone(name).getWorldQuaternion(Q())));
  update();
 }
 return{apply};
}
