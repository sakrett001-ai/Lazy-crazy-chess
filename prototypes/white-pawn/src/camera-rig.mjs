// Camera and deterministic clip helpers from Anatomy; MIT, see licenses/anatomy-MIT.txt.
import * as THREE from 'three';

// Fit all eight bounding-box corners; no hand-tuned distance per aspect ratio.
// Caller owns the clock. pose() is a pure function of timeline/selection inputs.
export function cameraRig(bounds,{aspect=1,fov=36,margin=1.18}={}){
 const center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3());
 const radius=Math.max(size.length()/2,1e-5),corners=[];
 for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z])corners.push(new THREE.Vector3(x,y,z));
 const perspective=new THREE.PerspectiveCamera(fov,aspect,radius/1000,radius*100);
 const ortho=new THREE.OrthographicCamera(-1,1,1,-1,radius/1000,radius*100);
 let camera=perspective,last={direction:[1,.5,2],projection:'perspective',zoom:1};
 function pose(options={}){
  last={...last,...options};const {projection,zoom}=last;
  if(!['perspective','orthographic'].includes(projection))throw Error('Unknown projection');
  if(!Number.isFinite(zoom)||zoom<=0)throw Error('Invalid zoom');
  camera=projection==='orthographic'?ortho:perspective;camera.zoom=1;
  const dir=new THREE.Vector3(...last.direction).normalize();if(dir.lengthSq()<.5)throw Error('Zero camera direction');
  camera.up.set(0,1,0);if(Math.abs(dir.y)>.999)camera.up.set(0,0,-Math.sign(dir.y));
  camera.position.copy(center).addScaledVector(dir,radius*4);camera.lookAt(center);camera.updateMatrixWorld(true);
  const right=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,0),up=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,1);
  const tanY=Math.tan(THREE.MathUtils.degToRad(fov/2)),tanX=tanY*aspect;
  let distance=radius,halfHeight=0;
  for(const corner of corners){const r=corner.clone().sub(center),x=Math.abs(r.dot(right)),y=Math.abs(r.dot(up)),z=r.dot(dir);
   distance=Math.max(distance,z+margin/zoom*Math.max(x/tanX,y/tanY));halfHeight=Math.max(halfHeight,y,x/aspect);
  }
  camera.position.copy(center).addScaledVector(dir,distance);camera.lookAt(center);
  if(camera===ortho){const h=halfHeight*margin/zoom;camera.left=-h*aspect;camera.right=h*aspect;camera.top=h;camera.bottom=-h;}
  else camera.aspect=aspect;
  camera.updateProjectionMatrix();camera.updateMatrixWorld(true);return camera;
 }
 return {get camera(){return camera},center,radius,corners,
  pose,resize(w,h){aspect=Math.max(w,1)/Math.max(h,1);return pose();},
  containment(){return corners.map(p=>p.clone().project(camera)).every(p=>Math.abs(p.x)<=1.0001&&Math.abs(p.y)<=1.0001&&p.z>=-1&&p.z<=1);},
  state:()=>({...last,position:camera.position.toArray(),projection:camera===ortho?'orthographic':'perspective'})};
}

export const VIEW_DIRECTIONS={front:[0,0,1],back:[0,0,-1],left:[-1,0,0],right:[1,0,0],top:[0,1,0],bottom:[0,-1,0],iso:[1,.55,2]};

// setTime() alone accumulates old track state when a seek crosses an ended clip.
// Reset the action before every sample so reverse and arbitrary seeks agree.
export function deterministicClip(root,clips,index=0){
 if(!clips.length)return null;
 const mixer=new THREE.AnimationMixer(root),clip=clips[index],action=mixer.clipAction(clip);
 return {duration:clip.duration,seek(t){mixer.stopAllAction();action.reset();action.setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;action.play();mixer.setTime(Math.max(0,Math.min(clip.duration,t)));},dispose(){mixer.stopAllAction();mixer.uncacheRoot(root);}};
}
