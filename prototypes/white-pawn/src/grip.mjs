import * as THREE from 'three';

// Relative corrections to the exported, already flexed MakeHuman fingers.
// Each digit stores [MCP flex, MCP abduction, PIP flex, DIP flex]; the thumb
// adds a CMC opposition angle. Profiles are transverse shield /35° diagonal
// weapon, then14/16mm handle radius. Fitting also limits actual PIP/DIP bend
// and keeps DIP from folding sharply while PIP stays straight.
// Fitted against the *skinned surface*, not finger joint centres. The old curl
// touched the shaft only at the fingertips while the middle phalanges floated.
// Raising MCP flexion and redistributing PIP/DIP flexion wraps each phalanx
// around the same cylinder used by the weapon and arm contact frames.
// Values are pose offsets in degrees, not anatomical joint angles.
const FITS={"0":{"14":{"1":[0,4,3.8,-7.6,4.4],"2":[15,14,-15,15],"3":[-2.03,-10.2,4.11,-11.84],"4":[18,9.7,-20,1.4],"5":[18,-13.9,-20,-0.6]},"16":{"1":[2,17.2,-26.2,-7,0],"2":[2.8,-4.2,-15,15],"3":[-4.03,-10.8,3.11,-11.34],"4":[-4,25,5.7,-12.7],"5":[3,21.5,-15,-0.3]}},"35":{"14":{"1":[-2,4.3,2,5.5,-27],"2":[-34.35,16.23,-25.34,5.02],"3":[-20,12,8,-9.3],"4":[20.2,10.8,-17.5,3.8],"5":[21.37,29.8,-13.53,-11.89,20]},"16":{"1":[-3,-8.8,2,2.8,-26.5],"2":[-35,19.23,-22.34,-1.18],"3":[-20,19.7,8,-14.5],"4":[18.2,4.8,-20.2,12],"5":[24.21,11.72,-20.52,1.16,20]}}};
const norm=s=>String(s||'').replace(/[._\-\s]/g,'').toLowerCase();
const vector=x=>x?.isVector3?x.clone():new THREE.Vector3().fromArray(x);
const Q=()=>new THREE.Quaternion(),V=()=>new THREE.Vector3();
const twoHanded=new Set(['pike','greatsword']);
export function gripRadiusM(weaponType){return weaponType==='pike'?.016:.014;}

export function createGrip({model,bones={},frames}){
  const lookup=new Map(),meshes=[];
  model.traverse(o=>{if(o.isBone)lookup.set(norm(o.name),o);if(o.isSkinnedMesh)meshes.push(o);});
  for(const [name,b]of Object.entries(bones))lookup.set(norm(name),b);
  const bone=name=>{const b=lookup.get(norm(name));if(!b)throw Error('Missing grip bone '+name);return b;};
  const skeletons=[...new Set(meshes.map(m=>m.skeleton))];
  const update=()=>{model.updateMatrixWorld(true);skeletons.forEach(s=>s.update());};update();
  const frameState=()=>typeof frames==='function'?frames():frames;
  const reference={},chains={};
  for(const side of ['R','L']){
    const source=frameState()[side],wrist=bone(source.wristBone||'wrist.'+side),sign=side==='L'?-1:1;
    const anatomicalAxis=vector(source.anatomicalAxisLocal||source.axisLocal).normalize(),forward=source.forwardLocal?vector(source.forwardLocal).normalize():new THREE.Vector3(0,1,0);
    reference[side]={wrist,gripLocal:vector(source.gripLocal)};
    const wristQ=wrist.getWorldQuaternion(Q()),acrossWorld=anatomicalAxis.clone().applyQuaternion(wristQ),forwardWorld=forward.clone().applyQuaternion(wristQ);
    const flexWorld=acrossWorld.clone().multiplyScalar(sign),abductionWorld=acrossWorld.clone().cross(forwardWorld).normalize(),twistWorld=forwardWorld.clone().multiplyScalar(sign);
    chains[side]=Array.from({length:5},(_,f)=>{
      const bs=Array.from({length:3},(_,j)=>bone(`finger${f+1}-${j+1}.${side}`)),p=bs.map(b=>b.getWorldPosition(V()));
      const proximal=p[1].clone().sub(p[0]).normalize(),middle=p[2].clone().sub(p[1]).normalize(),distal=new THREE.Vector3(0,1,0).applyQuaternion(bs[2].getWorldQuaternion(Q()));
      // Joint flexion follows each actual exported phalanx hinge. The weapon's
      // diagonal axis is a contact frame, never a finger rotation axis.
      const hingeWorld=[flexWorld,proximal.clone().cross(middle).normalize(),middle.clone().cross(distal).normalize()];
      return bs.map((b,j)=>{const inverse=b.getWorldQuaternion(Q()).invert();const link={bone:b,p:b.position.clone(),q:b.quaternion.clone(),axis:hingeWorld[j].clone().applyQuaternion(inverse),abduction:abductionWorld.clone().applyQuaternion(inverse),twist:twistWorld.clone().applyQuaternion(inverse)};
        if(f===4&&j===0){
          // This rig has no separate fifth metacarpal. Represent its bounded
          // CMC cupping with a virtual pivot25mm distal to the wrist, on the
          // same ulnar row. Rotation preserves pivot→MCP length and moves the
          // existing weighted palm surface, rather than stretching a finger.
          const wristP=wrist.getWorldPosition(V()),pivot=wristP.clone().addScaledVector(forwardWorld,.025).addScaledVector(acrossWorld,p[0].clone().sub(wristP).dot(acrossWorld));
          link.cmcPivot=b.parent.worldToLocal(pivot);link.cmcAxis=flexWorld.clone().applyQuaternion(b.parent.getWorldQuaternion(Q()).invert());link.cmcLength=link.p.distanceTo(link.cmcPivot);
        }
        return link;});
    });
  }
  let settings={weaponType:'spear',effectiveShield:'tower'},patches=null;
  function active(side){return side==='R'||twoHanded.has(settings.weaponType)||settings.effectiveShield!=='none';}
  function radius(side){return side==='R'||twoHanded.has(settings.weaponType)?gripRadiusM(settings.weaponType):.014;}
  function apply(next){
    settings={...settings,...next};const currentFrames=frameState();
    for(const side of ['R','L'])for(let f=0;f<5;f++){
      const angle=currentFrames[side].weaponGripAngleDeg||0,fit=FITS[angle]?.[Math.round(radius(side)*1000)]?.[f+1];
      if(active(side)&&!fit)throw Error('Uncalibrated handle grip '+angle+' degrees');
      for(let j=0;j<3;j++){
        const link=chains[side][f][j];link.bone.position.copy(link.p);link.bone.quaternion.copy(link.q);if(!active(side))continue;
        if(f===4&&j===0&&fit[4]){const cup=new THREE.Quaternion().setFromAxisAngle(link.cmcAxis,THREE.MathUtils.degToRad(fit[4]));link.bone.position.sub(link.cmcPivot).applyQuaternion(cup).add(link.cmcPivot);link.bone.quaternion.premultiply(cup);}
        const rotate=(axis,degrees)=>link.bone.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(axis,THREE.MathUtils.degToRad(degrees)));
        if(j===0){rotate(link.abduction,fit[1]);if(f===0)rotate(link.twist,fit[4]);}
        rotate(link.axis,fit[j===0?0:j+1]);link.bone.quaternion.normalize();
      }
    }
    update();
  }
  function makePatches(){
    const result={L:Array.from({length:5},()=>[[],[],[]]),R:Array.from({length:5},()=>[[],[],[]])};
    for(const mesh of meshes){
      const g=mesh.geometry;if(!g.attributes.skinIndex||!g.attributes.skinWeight)continue;
      const identity=mesh.skeleton.bones.map(b=>{const match=/^finger([1-5])([1-3])([lr])$/.exec(norm(b.name));return match?{f:Number(match[1])-1,j:Number(match[2])-1,side:match[3].toUpperCase()}:null;});
      for(let i=0;i<g.attributes.position.count;i++)for(let k=0;k<4;k++){
        const tag=identity[g.attributes.skinIndex.getComponent(i,k)];
        if(tag&&g.attributes.skinWeight.getComponent(i,k)>.5)result[tag.side][tag.f][tag.j].push({mesh,index:i});
      }
    }
    return result;
  }
  function measure(worldFrames={}){
    update();patches??=makePatches();const result={};
    for(const side of ['R','L']){
      if(!active(side))continue;
      const ref=reference[side],override=worldFrames[side],grip=override?.grip?vector(override.grip):ref.wrist.localToWorld(ref.gripLocal.clone());
      const axis=override?.axis?vector(override.axis).normalize():vector(frameState()[side].axisLocal).applyQuaternion(ref.wrist.getWorldQuaternion(Q())).normalize();
      const r=override?.radiusM??radius(side),fingers=[];
      for(let f=0;f<5;f++){
        const phalanges=patches[side][f].map((patch,j)=>{
          const radial=[];let nearest=null,min=Infinity,inside=0;
          for(const {mesh,index}of patch){
            const p=mesh.getVertexPosition(index,V()).applyMatrix4(mesh.matrixWorld),d=p.sub(grip),axial=d.dot(axis),rad=d.addScaledVector(axis,-axial),distance=rad.length();
            radial.push(distance);if(distance<min){min=distance;nearest=rad.clone().normalize();}if(distance<r-.00025)inside++;
          }
          radial.sort((a,b)=>a-b);
          return{joint:j+1,vertices:patch.length,minGapM:min-r,q10GapM:radial[Math.floor(radial.length*.1)]-r,verticesInside:inside,contactDirection:nearest?.toArray()||null};
        });
        const proximal=chains[side][f][0].bone.getWorldPosition(V()).sub(grip),distal=chains[side][f][2].bone.getWorldPosition(V()).sub(grip);
        proximal.addScaledVector(axis,-proximal.dot(axis)).normalize();distal.addScaledVector(axis,-distal.dot(axis)).normalize();
        const joints=chains[side][f].map(link=>link.bone),p=joints.map(b=>b.getWorldPosition(V())),firstLink=p[1].clone().sub(p[0]),middleLink=p[2].clone().sub(p[1]),lastLink=new THREE.Vector3(0,1,0).applyQuaternion(joints[2].getWorldQuaternion(Q()));
        fingers.push({finger:f+1,phalanges,wrapDeg:THREE.MathUtils.radToDeg(proximal.angleTo(distal)),pipDeg:THREE.MathUtils.radToDeg(firstLink.angleTo(middleLink)),dipDeg:THREE.MathUtils.radToDeg(middleLink.angleTo(lastLink))});
      }
      const metacarpal=chains[side][4][0];
      result[side]={radiusM:r,grip:grip.toArray(),axis:axis.toArray(),fingers,virtualCmc:{restLengthM:metacarpal.cmcLength,lengthM:metacarpal.bone.position.distanceTo(metacarpal.cmcPivot),cupDeg:(frameState()[side].weaponGripAngleDeg||0)===35?20:0},scope:'Actual dominant-weight finger surface vertices around the active handle cylinder. Does not establish complete palm/self-collision freedom.'};
    }
    return result;
  }
  return{apply,measure};
}
