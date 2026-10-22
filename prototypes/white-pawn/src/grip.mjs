import * as THREE from 'three';

// Relative corrections to the exported, already flexed MakeHuman fingers.
// Fitted against the *skinned surface*, not finger joint centres. The old curl
// touched the shaft only at the fingertips while the middle phalanges floated.
// Raising MCP flexion and redistributing PIP/DIP flexion wraps each phalanx
// around the same cylinder used by the weapon and arm contact frames.
// Values are pose offsets in degrees, not anatomical joint angles.
const FITS={
  14:{1:[-5.4,1.9,15],2:[22.2,-45.2,46.2],3:[21.3,-40.2,48.3],4:[23,-34.3,25.6],5:[24.2,-34.5,1.4]},
  16:{1:[-7,15,-6.9],2:[14,-27,22],3:[14.7,-26.7,26],4:[22,-38.5,29.4],5:[22.1,-38.8,9.4]}
};
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
  const reference={},chains={};
  for(const side of ['R','L']){
    const source=typeof frames==='function'?frames()[side]:frames[side],wrist=bone(source.wristBone||'wrist.'+side);
    reference[side]={wrist,gripLocal:vector(source.gripLocal),axisLocal:vector(source.axisLocal).normalize()};
    const flexWorld=reference[side].axisLocal.clone().applyQuaternion(wrist.getWorldQuaternion(Q())).multiplyScalar(side==='L'?-1:1);
    chains[side]=Array.from({length:5},(_,f)=>Array.from({length:3},(_,j)=>{
      const b=bone(`finger${f+1}-${j+1}.${side}`);
      return{bone:b,q:b.quaternion.clone(),axis:flexWorld.clone().applyQuaternion(b.getWorldQuaternion(Q()).invert()).normalize()};
    }));
  }
  let settings={weaponType:'spear',effectiveShield:'tower'},patches=null;
  function active(side){return side==='R'||twoHanded.has(settings.weaponType)||settings.effectiveShield!=='none';}
  function radius(side){return side==='R'||twoHanded.has(settings.weaponType)?gripRadiusM(settings.weaponType):.014;}
  function apply(next){
    settings={...settings,...next};
    for(const side of ['R','L'])for(let f=0;f<5;f++)for(let j=0;j<3;j++){
      const link=chains[side][f][j];link.bone.quaternion.copy(link.q);
      if(active(side))link.bone.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(link.axis,THREE.MathUtils.degToRad(FITS[Math.round(radius(side)*1000)][f+1][j]))).normalize();
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
      const axis=override?.axis?vector(override.axis).normalize():ref.axisLocal.clone().applyQuaternion(ref.wrist.getWorldQuaternion(Q())).normalize();
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
        fingers.push({finger:f+1,phalanges,wrapDeg:THREE.MathUtils.radToDeg(proximal.angleTo(distal))});
      }
      result[side]={radiusM:r,grip:grip.toArray(),axis:axis.toArray(),fingers,scope:'Actual dominant-weight finger surface vertices around the active handle cylinder. Does not establish complete palm/self-collision freedom.'};
    }
    return result;
  }
  return{apply,measure};
}
