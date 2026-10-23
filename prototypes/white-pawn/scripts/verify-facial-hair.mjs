/** Skin/morph integrity of the facial-hair retrofit. Visual review is separate. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {installFacialHair,beardCoverage} from '../src/facial-hair.mjs';
import {runtimeSource} from './runtime-source.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output=process.env.PAWN_FACIAL_HAIR_REPORT||path.join(root,'review/facial-hair-checks.json');
const hash=value=>createHash('sha256').update(value).digest('hex');
const bytes=await readFile(path.join(root,'assets/white-pawn.glb'));
const limits={maximumVerticesPerVariant:6000,minimumFeatherVertices:200,maximumMorphErrorM:1e-8,maximumBindingGapErrorM:.00025};
const report={status:'running',glbSha256:hash(bytes),runtimeSha256:hash(await runtimeSource(root)),auditSha256:hash(await readFile(fileURLToPath(import.meta.url))),limits,coverage:{variants:['stubble','short'],morphs:['lean','strong','veteran'],headRotationsRad:[0,.35,-.35],vertexSamples:0},checks:[],cases:[],negativeControls:[],failures:[],scope:'Actual runtime beard meshes: source skin weights, skeleton binding, all body/experience morph deltas, finite geometry, graded opacity attributes, deterministic fibre textures, bounded shell offset, transformed vertex gap and idempotent installation. This does not establish visual quality, hair simulation, arbitrary facial expressions or continuous collision freedom. Front/side/three-quarter visual inspection is separate.'};
const check=(name,passed,details={})=>{report.checks.push({name,passed:!!passed,...details});if(!passed)report.failures.push(name);};
const loader=new GLTFLoader();loader.register(()=>({name:'CPU_NO_TEXTURES',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
const parse=async()=> (await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')).scene;
const model=await parse(),targets=[];let source,head;
model.traverse(m=>{if(m.isSkinnedMesh&&m.material?.name==='skin')source=m;if(m.userData?.equipmentSlot==='beard')targets.push(m);if(m.isBone&&/^head$/i.test(m.name))head=m;});
const original=targets.map(mesh=>({mesh,parent:mesh.parent,visible:mesh.visible}));
const installed=installFacialHair({model});
check('Both existing beard slots are retrofitted in place',installed.installed&&targets.length===2&&original.every(({mesh,parent,visible})=>mesh.parent===parent&&mesh.visible===visible));
const featherStats=geometry=>{const data=geometry.attributes.beardCoverage.array;return{count:data.length,zero:data.filter(v=>v<=.001).length,partial:data.filter(v=>v>.001&&v<.999).length,full:data.filter(v=>v>=.999).length,valid:data.every(v=>Number.isFinite(v)&&v>=0&&v<=1)};};
const soft=stats=>stats.valid&&stats.zero>0&&stats.partial>=limits.minimumFeatherVertices&&stats.full>0;
const sourcePoint=new THREE.Vector3(),hairPoint=new THREE.Vector3();
for(const mesh of targets){
 const g=mesh.geometry,ids=g.userData.sourceVertexIndices,kind=mesh.userData.equipmentVariant,mask=featherStats(g);
 let weightErrors=0,maxMorphErrorM=0,maxVeteranDeltaM=0,maxBaseGapM=0;
 for(let i=0;i<ids.length;i++){
  for(const name of ['skinIndex','skinWeight'])for(let k=0;k<4;k++)if(g.attributes[name].getComponent(i,k)!==source.geometry.attributes[name].getComponent(ids[i],k))weightErrors++;
  for(const [name,attributes]of Object.entries(source.geometry.morphAttributes))attributes.forEach((a,j)=>{for(let k=0;k<a.itemSize;k++)maxMorphErrorM=Math.max(maxMorphErrorM,Math.abs(a.getComponent(ids[i],k)-g.morphAttributes[name][j].getComponent(i,k)));});
  const veteran=g.morphAttributes.position[mesh.morphTargetDictionary.veteran];maxVeteranDeltaM=Math.max(maxVeteranDeltaM,Math.hypot(veteran.getX(i),veteran.getY(i),veteran.getZ(i)));
  maxBaseGapM=Math.max(maxBaseGapM,sourcePoint.fromBufferAttribute(source.geometry.attributes.position,ids[i]).distanceTo(hairPoint.fromBufferAttribute(g.attributes.position,i)));
 }
 const finite=Object.values(g.attributes).every(a=>a.array.every(Number.isFinite))&&g.index.array.every(i=>i>=0&&i<ids.length);
 const texture=mesh.material.map,image=texture.image,alphaLevels=new Set(),luminanceLevels=new Set();
 for(let i=0;i<image.data.length;i+=4){alphaLevels.add(image.data[i+3]);luminanceLevels.add(image.data[i]);}
 const textureSha256=hash(image.data);
 check(kind+': finite bounded geometry',finite&&ids.length<=limits.maximumVerticesPerVariant&&maxBaseGapM<=g.userData.maximumShellDepthM+1e-7);
 check(kind+': cheek/neck edge contains an interpolated opacity gradient',soft(mask),mask);
 check(kind+': same skeleton, skin weights and experience/build morphs',mesh.skeleton===source.skeleton&&weightErrors===0&&maxMorphErrorM<=limits.maximumMorphErrorM&&maxVeteranDeltaM>0&&JSON.stringify(mesh.morphTargetDictionary)===JSON.stringify(source.morphTargetDictionary));
 check(kind+': graded fibre material retains the customization slot',mesh.material.transparent&&!mesh.material.depthWrite&&mesh.material.userData.customizationSlot==='beard'&&mesh.material.bumpMap===texture&&alphaLevels.size>8&&luminanceLevels.size>80);
 report.cases.push({kind,vertices:ids.length,triangles:g.index.count/3,mask,maxBaseGapM,maxMorphErrorM,maxVeteranDeltaM,textureSha256,textureSize:[image.width,image.height]});
}
check('Lips and nose remain exposed',beardCoverage(0,1.616,.164)===0&&beardCoverage(0,1.644,.174)===0);
const headRest=head?.quaternion.clone();let maxBindingGapErrorM=0,maxTransformedGapM=0;
for(const angle of report.coverage.headRotationsRad)for(const morph of ['regular',...report.coverage.morphs]){
 if(head)head.quaternion.copy(headRest).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),angle));
 for(const mesh of [source,...targets])for(const [name,index]of Object.entries(mesh.morphTargetDictionary))mesh.morphTargetInfluences[index]=name===morph?1:0;
 model.updateMatrixWorld(true);source.skeleton.update();
 for(const mesh of targets){const g=mesh.geometry,ids=g.userData.sourceVertexIndices;for(let i=0;i<ids.length;i++){
  const base=sourcePoint.fromBufferAttribute(source.geometry.attributes.position,ids[i]).distanceTo(hairPoint.fromBufferAttribute(g.attributes.position,i));
  source.getVertexPosition(ids[i],sourcePoint).applyMatrix4(source.matrixWorld);mesh.getVertexPosition(i,hairPoint).applyMatrix4(mesh.matrixWorld);
  const gap=sourcePoint.distanceTo(hairPoint);maxBindingGapErrorM=Math.max(maxBindingGapErrorM,Math.abs(gap-base));maxTransformedGapM=Math.max(maxTransformedGapM,gap);report.coverage.vertexSamples++;
 }}
}
check('Head rotation and all morphs keep the shell within the skin attachment tolerance',!!head&&maxBindingGapErrorM<=limits.maximumBindingGapErrorM,{maxBindingGapErrorM,maxTransformedGapM});
const geometryRefs=targets.map(m=>m.geometry),textureRefs=targets.map(m=>m.material.map);installFacialHair({model});
check('Repeated installation does not replace geometry or allocate textures',targets.every((m,i)=>m.geometry===geometryRefs[i]&&m.material.map===textureRefs[i]));
const second=await parse();installFacialHair({model:second});const repeated=[];second.traverse(m=>{if(m.userData?.equipmentSlot==='beard')repeated.push({kind:m.userData.equipmentVariant,textureSha256:hash(m.material.map.image.data)});});
check('Fibre texture generation is deterministic',repeated.every(r=>report.cases.find(c=>c.kind===r.kind)?.textureSha256===r.textureSha256));
const hard=targets[0].geometry.clone();hard.attributes.beardCoverage.array.fill(1);report.negativeControls.push({name:'An opaque hard-edged coverage attribute is rejected',passed:!soft(featherStats(hard))});
check('Negative control detects removal of the feather boundary',report.negativeControls.every(c=>c.passed));
report.status=report.failures.length?'failed':'passed';await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,checks:report.checks.length,failures:report.failures,vertexSamples:report.coverage.vertexSamples,maxBindingGapErrorM,output},null,2));if(report.failures.length)process.exitCode=1;
