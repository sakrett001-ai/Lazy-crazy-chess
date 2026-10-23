import * as THREE from 'three';

// Facial hair is a thin, softly masked shell sampled from the actual head.
// The catalogue's coarse face subsets had opaque triangle edges; replacing
// those geometries keeps the same two loadout entries and their visibility.
const smooth=(a,b,x)=>{const t=THREE.MathUtils.clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
export function beardCoverage(x,y,z){
 const ax=Math.abs(x),front=smooth(.055,.082,z),side=1-smooth(.073,.084,ax);
 const cheekTop=1.618+.042*smooth(.016,.067,ax);
 const cheek=smooth(1.549,1.568,y)*(1-smooth(cheekTop-.006,cheekTop+.006,y));
 const sideburn=smooth(.054,.069,ax)*(1-smooth(.074,.084,ax))*smooth(1.626,1.651,y)*(1-smooth(1.689,1.704,y));
 // The upper lip is y≈1.624, the nose begins above y≈1.636. Keep the
 // philtrum and lip opening exposed, with a separate soft moustache band.
 const moustache=(1-smooth(.023,.034,ax))*smooth(1.623,1.627,y)*(1-smooth(1.632,1.637,y))*(.65+.35*smooth(.002,.007,ax));
 const lip=Math.sqrt((x/.030)**2+((y-1.616)/.0085)**2);
 const mouthOpening=smooth(.9,1.2,lip);
 const noseOpening=1-smooth(1.631,1.638,y)*(1-smooth(.021,.031,ax));
 return THREE.MathUtils.clamp(Math.max(cheek,sideburn,moustache)*front*side*mouthOpening*noseOpening,0,1);
}

function fibreTexture(kind){
 const width=1024,height=512,data=new Uint8Array(width*height*4);
 let state=0x71f19a37;
 const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
 for(let i=0;i<width*height;i++){
  const value=kind==='short'?125+Math.floor(random()*45):210;
  data[i*4]=data[i*4+1]=data[i*4+2]=value;
  data[i*4+3]=kind==='short'?224:8;
 }
 // Individual short tapered strands follow the downward jaw growth. Texture
 // resolution corresponds to roughly 0.2 mm across the mapped facial region.
 const strands=kind==='short'?50000:17000;
 for(let i=0;i<strands;i++){
  const x0=random()*width,y0=random()*height,length=kind==='short'?7+random()*18:1+random()*3;
  const slope=(x0/width-.5)*.38+(random()-.5)*.20,light=165+Math.floor(random()*90);
  for(let j=0;j<length;j++){
   const x=(Math.round(x0+slope*j)+width)%width,y=Math.floor(y0-j);
   if(y<0||y>=height)continue;
   const at=(y*width+x)*4,taper=Math.sin(Math.PI*(j+.5)/length);
   const v=Math.round(light*(.62+.38*taper));
   data[at]=data[at+1]=data[at+2]=v;
   data[at+3]=Math.max(data[at+3],Math.round((kind==='short'?240:210)*taper));
  }
 }
 const texture=new THREE.DataTexture(data,width,height,THREE.RGBAFormat);
 texture.name='Facial hair '+kind+' directional fibres';texture.wrapS=THREE.RepeatWrapping;
 texture.wrapT=THREE.ClampToEdgeWrapping;texture.magFilter=THREE.LinearFilter;
 texture.minFilter=THREE.LinearMipmapLinearFilter;texture.generateMipmaps=true;
 texture.colorSpace=THREE.SRGBColorSpace;texture.needsUpdate=true;
 return texture;
}

function faceGeometry(source,kind){
 const g=source.geometry,p=g.attributes.position,n=g.attributes.normal,coverage=new Float32Array(p.count);
 for(let i=0;i<p.count;i++)coverage[i]=beardCoverage(p.getX(i),p.getY(i),p.getZ(i));
 const faces=[];
 for(let i=0;i<g.index.count;i+=3){const f=[g.index.getX(i),g.index.getX(i+1),g.index.getX(i+2)];
  if(f.some(id=>coverage[id]>.001)&&f.every(id=>p.getY(id)>1.535&&p.getY(id)<1.715&&p.getZ(id)>.045))faces.push(f);
 }
 const ids=[...new Set(faces.flat())],lookup=new Map(ids.map((id,i)=>[id,i])),out=new THREE.BufferGeometry();
 for(const [name,attribute]of Object.entries(g.attributes)){
  const array=new attribute.array.constructor(ids.length*attribute.itemSize);
  ids.forEach((id,i)=>{for(let k=0;k<attribute.itemSize;k++)array[i*attribute.itemSize+k]=attribute.getComponent(id,k);});
  out.setAttribute(name,new THREE.BufferAttribute(array,attribute.itemSize,attribute.normalized));
 }
 const uv=new Float32Array(ids.length*2),mask=new Float32Array(ids.length);
 ids.forEach((id,i)=>{
  const x=p.getX(id),y=p.getY(id),z=p.getZ(id),c=coverage[id];mask[i]=c;
  const depth=(kind==='short'?.0055+.003*(1-smooth(1.586,1.623,y)):.00065)*smooth(0,.65,c);
  out.attributes.position.setXYZ(i,x+n.getX(id)*depth,y+n.getY(id)*depth,z+n.getZ(id)*depth);
  uv[i*2]=.5+Math.atan2(x,z-.030)/(Math.PI*1.15);uv[i*2+1]=(y-1.545)/.17;
 });
 out.setAttribute('uv',new THREE.BufferAttribute(uv,2));out.setAttribute('beardCoverage',new THREE.BufferAttribute(mask,1));
 out.setIndex(faces.flat().map(id=>lookup.get(id)));
 out.morphTargetsRelative=g.morphTargetsRelative;
 for(const [name,attributes]of Object.entries(g.morphAttributes))out.morphAttributes[name]=attributes.map(attribute=>{
  const array=new attribute.array.constructor(ids.length*attribute.itemSize);
  ids.forEach((id,i)=>{for(let k=0;k<attribute.itemSize;k++)array[i*attribute.itemSize+k]=attribute.getComponent(id,k);});
  return new THREE.BufferAttribute(array,attribute.itemSize,attribute.normalized);
 });
 out.computeBoundingBox();out.computeBoundingSphere();
 out.userData={facialHairKind:kind,sourceMesh:source.name,sourceVertexIndices:ids,maximumShellDepthM:kind==='short'?.0085:.00065};
 return out;
}

export function installFacialHair({model}){
 const targets=[];let source;
 model.traverse(mesh=>{if(!mesh.isSkinnedMesh)return;if(mesh.material?.name==='skin'&&(!source||mesh.geometry.attributes.position.count>source.geometry.attributes.position.count))source=mesh;if(mesh.userData?.equipmentSlot==='beard')targets.push(mesh);});
 if(!source||!targets.length)return{installed:false,reason:'No skinned head/beard slots'};
 for(const mesh of targets){
  if(mesh.userData.runtimeFacialHair==='soft-fibres-v1')continue;
  const kind=mesh.userData.equipmentVariant;if(!['short','stubble'].includes(kind))continue;
  // The GLB uses a common identity-space bind; copy the source skin binding,
  // so veteran expression deltas and every animated head transform agree.
  mesh.geometry=faceGeometry(source,kind);mesh.skeleton=source.skeleton;
  mesh.bindMatrix.copy(source.bindMatrix);mesh.bindMatrixInverse.copy(source.bindMatrixInverse);
  mesh.updateMorphTargets();mesh.morphTargetDictionary={...source.morphTargetDictionary};
  mesh.morphTargetInfluences=source.morphTargetInfluences?.slice()||[];
  const material=mesh.material.clone();material.name='beard';material.userData={...material.userData,customizationSlot:'beard',facialHairKind:kind};
  const texture=fibreTexture(kind);material.map=texture;material.bumpMap=texture;
  material.bumpScale=kind==='short'?.00022:.00007;material.metalness=0;material.roughness=.86;
  material.transparent=true;material.depthWrite=false;material.alphaTest=.015;
  material.side=THREE.FrontSide;material.forceSinglePass=true;
  material.onBeforeCompile=shader=>{
   shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nattribute float beardCoverage; varying float vBeardCoverage;')
    .replace('#include <begin_vertex>','#include <begin_vertex>\nvBeardCoverage = beardCoverage;');
   shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying float vBeardCoverage;')
    .replace('#include <alphamap_fragment>','#include <alphamap_fragment>\ndiffuseColor.a *= smoothstep(0.0, 0.8, vBeardCoverage);');
  };
  material.customProgramCacheKey=()=>`facial-hair-soft-fibres-v1-${kind}`;
  mesh.material=material;mesh.castShadow=false;mesh.receiveShadow=true;
  mesh.userData.runtimeFacialHair='soft-fibres-v1';mesh.renderOrder=2;
 }
 return{installed:true,meshes:targets.map(mesh=>({name:mesh.name,kind:mesh.userData.equipmentVariant,vertices:mesh.geometry.attributes.position.count,triangles:mesh.geometry.index.count/3,morphs:Object.keys(mesh.morphTargetDictionary||{})}))};
}
