import * as THREE from 'three';

// MakeHuman keeps two deform segments per anatomical link. Calibrate their
// frames from inverse binds rather than treating Euler channels as anatomy.
const V=()=>new THREE.Vector3(), Q=()=>new THREE.Quaternion();
const normalize=s=>String(s).replace(/[._\-\s]/g,'').toLowerCase();
const perpendicular=(v,axis)=>v.clone().addScaledVector(axis,-v.dot(axis));
function frame(x,y){
 x=x.clone().normalize();y=perpendicular(y,x).normalize();
 return Q().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x,y,x.clone().cross(y).normalize()));
}
function signedTwist(q,axis){
 const projection=axis.clone().multiplyScalar(new THREE.Vector3(q.x,q.y,q.z).dot(axis));
 const twist=new THREE.Quaternion(projection.x,projection.y,projection.z,q.w).normalize();
 let angle=2*Math.atan2(new THREE.Vector3(twist.x,twist.y,twist.z).dot(axis),twist.w);
 if(angle>Math.PI)angle-=2*Math.PI;if(angle< -Math.PI)angle+=2*Math.PI;return angle;
}
export function createArmBiomechanics({model,bones,handReference,update}){
 const map=new Map(Object.entries(bones).map(([n,b])=>[normalize(n),b]));
 model.traverse(o=>{if(o.isBone)map.set(normalize(o.name),o);});
 const bone=n=>map.get(normalize(n)), point=n=>bone(n).getWorldPosition(V());
 const bind=new Map();
 model.traverse(o=>{if(o.isSkinnedMesh)for(let i=0;i<o.skeleton.bones.length;i++){
  const b=o.skeleton.bones[i];if(!bind.has(normalize(b.name)))bind.set(normalize(b.name),o.skeleton.boneInverses[i].clone().invert());
 }});
 const bindMatrix=n=>bind.get(normalize(n)), bindPoint=n=>V().setFromMatrixPosition(bindMatrix(n));
 const bindQ=n=>Q().setFromRotationMatrix(bindMatrix(n));
 const calibration={};
 for(const side of ['R','L']){
  const upper='upperarm01.'+side,lower='lowerarm01.'+side,wrist='wrist.'+side;
  const s=bindPoint(upper),e=bindPoint(lower),w=bindPoint(wrist),a=e.clone().sub(s).normalize(),f=w.clone().sub(e).normalize();
  let hinge=a.clone().cross(f);if(hinge.lengthSq()<1e-5)hinge=new THREE.Vector3(1,0,0).applyQuaternion(bindQ(lower));
  hinge=perpendicular(hinge,a).normalize();
  const upperFrame=frame(hinge,a),lowerFrame=frame(hinge,f);
  const reference=handReference[side],wq=bone(wrist).getWorldQuaternion(Q());
  const across=point('finger2-1.'+side).sub(point('finger5-1.'+side)).normalize();
  const forward=perpendicular(point('finger3-1.'+side).sub(point(wrist)),across).normalize();
  const axisLocal=across.clone().applyQuaternion(wq.clone().invert());
  const forwardLocal=forward.clone().applyQuaternion(wq.clone().invert());
  reference.axisLocal=axisLocal;reference.forwardLocal=forwardLocal;
  calibration[side]={upper,lower,wrist,a:e.distanceTo(s),b:w.distanceTo(e),
   upperCorrection:upperFrame.clone().invert().multiply(bindQ(upper)),
   lowerCorrection:lowerFrame.clone().invert().multiply(bindQ(lower)),
   lowerBindQ:bindQ(lower),lowerSplitBindQ:bindQ('lowerarm02.'+side),wristBindQ:bindQ(wrist),neutralDistalLocal:f.clone().applyQuaternion(bindQ(wrist).invert()),
   palmCorrection:frame(axisLocal,forwardLocal).invert(),
   hingeLocal:hinge.clone().applyQuaternion(bindQ(upper).invert()),
   lowerHingeLocal:hinge.clone().applyQuaternion(bindQ(lower).invert()),
   lowerSplitBindLocal:bone('lowerarm02.'+side).quaternion.clone(),last:null};
  const c=calibration[side];c.neutralCorrection=c.lowerCorrection.clone().multiply(c.lowerBindQ.clone().invert()).multiply(c.wristBindQ);
  c.inverseNeutralCorrection=c.neutralCorrection.clone().invert();
 }
 function worldQ(name,q){const b=bone(name);b.quaternion.copy(b.parent.getWorldQuaternion(Q()).invert().multiply(q)).normalize();b.updateWorldMatrix(false,true);}
 function twoBone(s,target,a,b,pole,shaft,side,handForward,handQ,bodyX,bodyUp){
  const d=target.clone().sub(s),requested=d.length();d.normalize();
  // Operational pose range, deliberately inside a locked elbow and a fully
  // folded elbow. These are animation limits, not clinical ROM claims.
  const min=Math.sqrt(a*a+b*b+2*a*b*Math.cos(THREE.MathUtils.degToRad(140)));
  const max=Math.sqrt(a*a+b*b+2*a*b*Math.cos(THREE.MathUtils.degToRad(8)));
  const distance=THREE.MathUtils.clamp(requested,min,max);
  let bend=perpendicular(pole,d);if(bend.lengthSq()<1e-8)bend=perpendicular(new THREE.Vector3(0,-1,0),d);bend.normalize();
  const along=(a*a-b*b+distance*distance)/(2*distance),height=Math.sqrt(Math.max(0,a*a-along*along));
  // The pole expresses a preference, not permission to break the wrist or
  // raise the elbow above the shoulder. Search the anatomical elbow circle
  // for a relaxed compromise; forcing a perfectly straight wrist alone can
  // produce the very high-elbow pose this solver is meant to remove.
  let score=0;
  if(shaft&&height>1e-6){
   const projection=perpendicular(shaft,d),length=projection.length();
   if(length>1e-6){
    const u=projection.multiplyScalar(1/length),v=d.clone().cross(u).normalize(),preferred=bend.clone();
    const c=calibration[side],neutralWristForward=handQ?c.neutralDistalLocal.clone().applyQuaternion(handQ):null;
    const handToNeutral=handQ?handQ.clone().multiply(c.inverseNeutralCorrection):null;
    const cost=angle=>{
     const candidate=u.clone().multiplyScalar(Math.cos(angle)).addScaledVector(v,Math.sin(angle));
     const elbowDelta=d.clone().multiplyScalar(along).addScaledVector(candidate,height);
     const fore=target.clone().sub(s).sub(elbowDelta).normalize();
     const wrist=neutralWristForward?fore.angleTo(neutralWristForward):(handForward?fore.angleTo(handForward):Math.asin(Math.min(1,Math.abs(fore.dot(shaft)))));
     const elevation=elbowDelta.dot(bodyUp),inward=elbowDelta.dot(bodyX)*(side==='R'?1:-1);
     let twistCost=0;
     if(handToNeutral){const hinge=elbowDelta.clone().normalize().cross(fore).normalize();
      const twist=signedTwist(handToNeutral.clone().multiply(frame(hinge,fore).invert()),fore);
      twistCost=40*Math.max(0,Math.abs(twist)-Math.PI*.46)**2;
     }
     return .15*wrist*wrist+6*Math.max(0,wrist-.40)**2 + 500*Math.max(0,elevation+.08)**2 + 300*Math.max(0,inward+.005)**2 + .05*(1-candidate.dot(preferred))+twistCost;
    };
    let best=0,bestCost=Infinity;const step=2*Math.PI/24;
    for(let i=0;i<24;i++){const angle=i*step,c=cost(angle);if(c<bestCost){best=angle;bestCost=c;}}
    let radius=step;for(let i=0;i<8;i++){const lo=best-radius/2,hi=best+radius/2,lc=cost(lo),hc=cost(hi);if(lc<bestCost){best=lo;bestCost=lc;}if(hc<bestCost){best=hi;bestCost=hc;}radius*=.5;}
    bend=u.multiplyScalar(Math.cos(best)).addScaledVector(v,Math.sin(best));score=bestCost;
   }
  }
  return{elbow:s.clone().addScaledVector(d,along).addScaledVector(bend,height),wrist:s.clone().addScaledVector(d,distance),reachErrorM:Math.abs(requested-distance),score:score+1000*(requested-distance)**2};
 }
 function setLinks(side,elbow,wrist,handQ){
  const c=calibration[side],s=point(c.upper),a=elbow.clone().sub(s).normalize(),f=wrist.clone().sub(elbow).normalize();
  const hinge=a.clone().cross(f).normalize();
  worldQ(c.upper,frame(hinge,a).multiply(c.upperCorrection));
  worldQ(c.lower,frame(hinge,f).multiply(c.lowerCorrection));
  // Pronation belongs to the distal forearm. It is not an arbitrary wrist
  // roll. A residual wrist swing remains visible and is audited separately.
  const lowerQ=bone(c.lower).getWorldQuaternion(Q()),neutral=lowerQ.clone().multiply(c.lowerBindQ.clone().invert()).multiply(c.wristBindQ);
  const twist=THREE.MathUtils.clamp(signedTwist(handQ.clone().multiply(neutral.clone().invert()),f),-Math.PI*.48,Math.PI*.48);
  const split=bone('lowerarm02.'+side);split.quaternion.copy(c.lowerSplitBindLocal);split.updateWorldMatrix(false,true);
  worldQ(split.name,Q().setFromAxisAngle(f,twist).multiply(split.getWorldQuaternion(Q())));
  worldQ(c.wrist,handQ);
  return twist;
 }
 function solve(side,grip,axis,pole,toolAxisLocal,fixedHandQ){
  const c=calibration[side],reference=handReference[side],shaft=axis.clone().normalize(),s=point(c.upper);
  let u=perpendicular(point('neck01').sub(point('spine05')).negate(),shaft).normalize();
  if(u.lengthSq()<.1)u=perpendicular(new THREE.Vector3(0,0,1),shaft).normalize();
  const v=shaft.clone().cross(u).normalize();
  const correction=toolAxisLocal?frame(toolAxisLocal,reference.forwardLocal).invert():c.palmCorrection;
  const bodyX=point('upperarm01.L').sub(point('upperarm01.R')).normalize(),bodyUp=point('neck01').sub(point('spine05')).normalize();
  // Solve palm roll and elbow plane together. A sequential fixed-point solve
  // can oscillate between opposite sides of a short, folded arm; evaluating
  // the bounded circle is deterministic under arbitrary seeking.
  const candidate=angle=>{
   const distal=u.clone().multiplyScalar(Math.cos(angle)).addScaledVector(v,Math.sin(angle));
   const handQ=fixedHandQ?fixedHandQ.clone():frame(shaft,distal).multiply(correction),target=grip.clone().sub(reference.gripLocal.clone().applyQuaternion(handQ));
   const handForward=reference.forwardLocal.clone().applyQuaternion(handQ);
   const result=twoBone(s,target,c.a,c.b,pole,shaft,side,handForward,handQ,bodyX,bodyUp);
   return{...result,handQ};
  };
  // Shield orientation is authored as a full frame. Free rotation around its
  // handle would turn the board through its own forearm and leather loops.
  let bestAngle=0,result=fixedHandQ?candidate(0):null;const step=2*Math.PI/16;
  if(!fixedHandQ){
   for(let i=0;i<16;i++){const angle=i*step,next=candidate(angle);if(!result||next.score<result.score){result=next;bestAngle=angle;}}
   let radius=step;for(let i=0;i<8;i++){for(const angle of [bestAngle-radius/2,bestAngle+radius/2]){const next=candidate(angle);if(next.score<result.score){result=next;bestAngle=angle;}}radius*=.5;}
  }
  const twist=setLinks(side,result.elbow,result.wrist,result.handQ);
  c.last={target:grip.clone(),axis:shaft,forearmTwistDeg:THREE.MathUtils.radToDeg(twist),reachErrorM:result.reachErrorM};
  return measure(side);
 }
 function measure(side){
  const c=calibration[side],s=point(c.upper),e=point(c.lower),w=point(c.wrist),a=e.clone().sub(s).normalize(),f=w.clone().sub(e).normalize();
  const wq=bone(c.wrist).getWorldQuaternion(Q()),handForward=handReference[side].forwardLocal.clone().applyQuaternion(wq),actualHinge=a.clone().cross(f).normalize();
  const upperHinge=c.hingeLocal.clone().applyQuaternion(bone(c.upper).getWorldQuaternion(Q()));
  const lowerHinge=c.lowerHingeLocal.clone().applyQuaternion(bone(c.lower).getWorldQuaternion(Q()));
  const distalNeutral=bone('lowerarm02.'+side).getWorldQuaternion(Q()).multiply(c.lowerSplitBindQ.clone().invert()).multiply(c.wristBindQ);
  const wristAxialTwistDeg=THREE.MathUtils.radToDeg(signedTwist(wq.clone().multiply(distalNeutral.invert()),f));
  return{elbowFlexDeg:THREE.MathUtils.radToDeg(a.angleTo(f)),wristBendDeg:THREE.MathUtils.radToDeg(f.angleTo(handForward)),
   elbowHingeAlignment:Math.min(actualHinge.dot(upperHinge),actualHinge.dot(lowerHinge)),
   upperLengthM:e.distanceTo(s),forearmLengthM:w.distanceTo(e),referenceLengthsM:[c.a,c.b],
   forearmTwistDeg:c.last?.forearmTwistDeg??null,wristAxialTwistDeg,reachErrorM:c.last?.reachErrorM??null,
   gripErrorM:c.last?bone(c.wrist).localToWorld(handReference[side].gripLocal.clone()).distanceTo(c.last.target):null};
 }
 return{solve,measure,calibration:()=>Object.fromEntries(['R','L'].map(side=>[side,{hingeLocal:calibration[side].hingeLocal.toArray(),lowerHingeLocal:calibration[side].lowerHingeLocal.toArray(),lengthsM:[calibration[side].a,calibration[side].b]}]))};
}
