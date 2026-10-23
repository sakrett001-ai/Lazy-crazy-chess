import * as THREE from 'three';

// Relative corrections to the exported, already flexed MakeHuman fingers.
// Each digit stores [MCP flex, MCP abduction, PIP flex, DIP flex]; the thumb
// adds a CMC opposition angle; digits 2–5 add metacarpal cupping. Profiles are transverse shield /35° diagonal
// weapon, then14/16mm handle radius. Fitting also limits actual PIP/DIP bend
// and keeps DIP from folding sharply while PIP stays straight.
// Fitted against the *skinned surface*, not finger joint centres. The old curl
// touched the shaft only at the fingertips while the middle phalanges floated.
// Raising MCP flexion and redistributing PIP/DIP flexion wraps each phalanx
// around the same cylinder used by the weapon and arm contact frames.
// Values are pose offsets in degrees, not anatomical joint angles.
const FITS={"0":{"14":{"1":[-27.67,-18.33,-50,-20.65,-16.48],"2":[16.5,17,-11.5,8.5,0],"3":[15.46,15,-16.59,13.64,0],"4":[2,21.8,-3,10.9,5],"5":[3.5,28.4,-14,3.4,0.4]},"16":{"1":[2,17.2,-26.2,-7,0],"2":[2.8,-4.2,-15,15],"3":[-4.03,-10.8,3.11,-11.34],"4":[-4,25,5.7,-12.7],"5":[3,21.5,-15,-0.3]}},"35":{"14":{"1":[-2,4.3,2,5.5,-27],"2":[-35,26.3,-13.31,9.72,0],"3":[-25.69,-6.27,0.16,15.84,0],"4":[7.59,-15,3.14,8.19,10],"5":[39.35,-5.17,-13.32,-1.83,20]},"16":{"1":[-3,-8.8,2,2.8,-26.5],"2":[-35,30,-13.31,9.72,0],"3":[-12.16,7.7,-11.58,21.57,0],"4":[4.14,-14.1,2.42,9.79,9.8],"5":[39.26,-10.73,-13.65,-4.18,20]}}};
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
  const reference={},chains={},metacarpals={};
  for(const side of ['R','L']){
    const source=frameState()[side],wrist=bone(source.wristBone||'wrist.'+side),sign=side==='L'?-1:1;
    const anatomicalAxis=vector(source.anatomicalAxisLocal||source.axisLocal).normalize(),forward=source.forwardLocal?vector(source.forwardLocal).normalize():new THREE.Vector3(0,1,0);
    reference[side]={wrist,gripLocal:vector(source.gripLocal)};
    const wristQ=wrist.getWorldQuaternion(Q()),acrossWorld=anatomicalAxis.clone().applyQuaternion(wristQ),forwardWorld=forward.clone().applyQuaternion(wristQ);
    const flexWorld=acrossWorld.clone().multiplyScalar(sign),abductionWorld=acrossWorld.clone().cross(forwardWorld).normalize(),twistWorld=forwardWorld.clone().multiplyScalar(sign);
    metacarpals[side]=[];
    chains[side]=Array.from({length:5},(_,f)=>{
      const bs=Array.from({length:3},(_,j)=>bone(`finger${f+1}-${j+1}.${side}`)),p=bs.map(b=>b.getWorldPosition(V()));
      const proximal=p[1].clone().sub(p[0]).normalize(),middle=p[2].clone().sub(p[1]).normalize(),distal=new THREE.Vector3(0,1,0).applyQuaternion(bs[2].getWorldQuaternion(Q()));
      // Joint flexion follows each actual exported phalanx hinge. The weapon's
      // diagonal axis is a contact frame, never a finger rotation axis.
      const hingeWorld=[flexWorld,proximal.clone().cross(middle).normalize(),middle.clone().cross(distal).normalize()];
      if(f>0){const b=bs[0].parent;if(norm(b.name)!==norm(`metacarpal${f}.${side}`))throw Error('Unexpected metacarpal parent '+b.name);
        metacarpals[side][f]={bone:b,p:b.position.clone(),q:b.quaternion.clone(),axis:flexWorld.clone().applyQuaternion(b.getWorldQuaternion(Q()).invert()),length:bs[0].position.length()};}
      return bs.map((b,j)=>{const inverse=b.getWorldQuaternion(Q()).invert();return{bone:b,p:b.position.clone(),q:b.quaternion.clone(),axis:hingeWorld[j].clone().applyQuaternion(inverse),abduction:abductionWorld.clone().applyQuaternion(inverse),twist:twistWorld.clone().applyQuaternion(inverse)};});
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
      if(f>0){const meta=metacarpals[side][f];meta.bone.position.copy(meta.p);meta.bone.quaternion.copy(meta.q);if(active(side))meta.bone.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(meta.axis,THREE.MathUtils.degToRad(fit[4]||0)));}
      for(let j=0;j<3;j++){
        const link=chains[side][f][j];link.bone.position.copy(link.p);link.bone.quaternion.copy(link.q);if(!active(side))continue;
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
    for(const side of ['R','L'])for(let f=0;f<5;f++){
      const distalBone=chains[side][f][2].bone,palmar=chains[side][f][2].axis.clone().cross(new THREE.Vector3(0,1,0)).normalize();
      const refs=result[side][f][2].map(ref=>{const index=ref.mesh.skeleton.bones.indexOf(distalBone),local=V().fromBufferAttribute(ref.mesh.geometry.attributes.position,ref.index).applyMatrix4(ref.mesh.bindMatrix).applyMatrix4(ref.mesh.skeleton.boneInverses[index]);return{...ref,y:local.y,palmar:local.dot(palmar)};});
      const quant=(key,fraction)=>refs.map(r=>r[key]).sort((a,b)=>a-b)[Math.floor((refs.length-1)*fraction)];
      result[side][f].tip=refs.filter(r=>r.y>=quant('y',.8));result[side][f].pad=refs.filter(r=>r.y>=quant('y',.6)&&r.y<=quant('y',.9)&&r.palmar>=quant('palmar',.7));
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
        const patchMeasure=(patch,j)=>{
          const radial=[];let nearest=null,min=Infinity,inside=0;
          for(const {mesh,index}of patch){
            const p=mesh.getVertexPosition(index,V()).applyMatrix4(mesh.matrixWorld),d=p.sub(grip),axial=d.dot(axis),rad=d.addScaledVector(axis,-axial),distance=rad.length();
            radial.push(distance);if(distance<min){min=distance;nearest=rad.clone().normalize();}if(distance<r-.00025)inside++;
          }
          radial.sort((a,b)=>a-b);
          return{joint:j+1,vertices:patch.length,minGapM:min-r,q10GapM:radial[Math.floor(radial.length*.1)]-r,medianGapM:radial[Math.floor(radial.length*.5)]-r,verticesInside:inside,contactDirection:nearest?.toArray()||null};
        };
        const phalanges=patches[side][f].map(patchMeasure);
        const proximal=chains[side][f][0].bone.getWorldPosition(V()).sub(grip),distal=chains[side][f][2].bone.getWorldPosition(V()).sub(grip);
        proximal.addScaledVector(axis,-proximal.dot(axis)).normalize();distal.addScaledVector(axis,-distal.dot(axis)).normalize();
        const joints=chains[side][f].map(link=>link.bone),p=joints.map(b=>b.getWorldPosition(V())),firstLink=p[1].clone().sub(p[0]),middleLink=p[2].clone().sub(p[1]),lastLink=new THREE.Vector3(0,1,0).applyQuaternion(joints[2].getWorldQuaternion(Q()));
        fingers.push({finger:f+1,phalanges,pad:patchMeasure(patches[side][f].pad,2),tip:patchMeasure(patches[side][f].tip,2),tipOutward:lastLink.dot(distal),wrapDeg:THREE.MathUtils.radToDeg(proximal.angleTo(distal)),pipDeg:THREE.MathUtils.radToDeg(firstLink.angleTo(middleLink)),dipDeg:THREE.MathUtils.radToDeg(middleLink.angleTo(lastLink))});
      }
      result[side]={radiusM:r,grip:grip.toArray(),axis:axis.toArray(),fingers,metacarpals:metacarpals[side].slice(1).map((meta,f)=>({bone:meta.bone.name,restLengthM:meta.length,lengthM:chains[side][f+1][0].bone.position.length(),rootShiftM:meta.bone.position.distanceTo(meta.p),cupDeg:THREE.MathUtils.radToDeg(meta.bone.quaternion.angleTo(meta.q))})),scope:'Actual finger skin, fixed palmar distal pads and terminal caps around the handle. Does not establish complete palm/self-collision freedom.'};
    }
    return result;
  }
  return{apply,measure};
}
