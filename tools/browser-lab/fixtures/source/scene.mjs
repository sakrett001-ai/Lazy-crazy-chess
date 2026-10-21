import * as THREE from 'three';
import {measureContacts,worldAnchor,motionChecks} from './contact-checks.mjs';

export function makeModel(fault='none') {
  const root=new THREE.Group();root.rotation.z=.12;root.position.set(.1,.25,0);
  const geometry=new THREE.BoxGeometry(.12,.08,.06);
  const count=geometry.attributes.position.count,indices=[],weights=[];
  for(let i=0;i<count;i++){indices.push(0,0,0,0);weights.push(1,0,0,0);}
  geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(indices,4));
  geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4));
  const hand=new THREE.SkinnedMesh(geometry,new THREE.MeshStandardMaterial({color:0xe0ae87}));
  const bone=new THREE.Bone();hand.add(bone);hand.bind(new THREE.Skeleton([bone]));root.add(hand);
  const handle=new THREE.Mesh(new THREE.CylinderGeometry(.02,.02,.22,16),new THREE.MeshStandardMaterial({color:0x6099b2,metalness:.5,roughness:.3}));
  root.add(handle);
  const rest=new THREE.Vector3().fromBufferAttribute(geometry.attributes.position,0);
  const contacts=[{id:'grip',interval:[0,2],maxGapMetres:.003,
    a:{object:hand,vertex:0},b:{object:handle,local:[0,.11,0]}}];
  function evaluatePose(frame) {
    const t=frame.time,x=.25*Math.sin(Math.PI*t)+(fault==='snap'&&t>=1?.15:0),y=.07*Math.sin(Math.PI*t/2);
    bone.position.set(x,y,0);
    handle.position.set(rest.x+x,rest.y+y-.11,rest.z);
    if(fault==='gap'&&t>=.7&&t<=1.2)handle.position.x+=.04;
    root.updateMatrixWorld(true);
  }
  function measure(frame){return {checks:measureContacts(contacts,frame.time)}}
  evaluatePose({time:0});
  return {root,hand,handle,contacts,evaluatePose,measure,
    point:()=>worldAnchor(contacts[0].a).toArray(),
    sampleTimes:()=>[.699,.7,1,1.2,1.201]};
}

export function inspectModel(fault='none') {
  const m=makeModel(fault),positions=[],checks=[];
  for(let i=0;i<=200;i++){
    const time=i/100;m.evaluatePose({time});
    positions.push({time,position:m.point()});checks.push(...m.measure({time}).checks);
  }
  checks.push(...motionChecks(positions,{id:'hand',maxSpeed:2,maxAcceleration:8}));
  return {pass:checks.every(c=>c.ok),checks,failures:checks.filter(c=>!c.ok)};
}

export function mount({container,project={}}) {
  const m=makeModel(project.contactFault||'none'),scene=new THREE.Scene();
  scene.background=new THREE.Color('#18232d');scene.add(m.root,new THREE.HemisphereLight(0xe9f3ff,0x303742,2));
  const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(1,2,3);scene.add(light);
  const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
  renderer.setPixelRatio(1);container.append(renderer.domElement);
  const camera=new THREE.PerspectiveCamera(35,1,.01,10);camera.position.set(.8,.7,1.1);camera.lookAt(.1,.25,0);
  function resize(){renderer.setSize(container.clientWidth,container.clientHeight);camera.aspect=container.clientWidth/container.clientHeight;camera.updateProjectionMatrix();}
  function draw(frame){m.evaluatePose(frame);renderer.render(scene,camera);}
  resize();draw({time:0});
  return {...m,draw,resize,poster:()=>renderer.domElement.toDataURL('image/png')};
}
