import {fromMediaPipe} from './profiles.mjs';
import {buildMotionFile} from './format.mjs';

// Video → pose: MediaPipe Pose Landmarker (Apache-2.0) runs in the page on
// the processor or through WebGL, so an ordinary integrated graphics chip
// is enough. The library and its model load from their public addresses
// the first time; the video itself never leaves the computer.
export const MEDIAPIPE_VERSION='1.1.1';
export const MEDIAPIPE_SOURCES=Object.freeze({
 vision:`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`,
 wasm:`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`,
 model:'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task'
});

let landmarker=null;
async function load(sources,onStatus){
 if(landmarker)return landmarker;
 onStatus?.('Загружаю MediaPipe…');
 const vision=await import(/* esbuild: keep the address */sources.vision);
 const files=await vision.FilesetResolver.forVisionTasks(sources.wasm);
 const make=delegate=>vision.PoseLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:sources.model,delegate},runningMode:'VIDEO',numPoses:1,minPoseDetectionConfidence:.5,minTrackingConfidence:.5});
 try{landmarker=await make('GPU');}catch{landmarker=await make('CPU');}
 return landmarker;
}

// Centred moving average over `radius` frames on each side: removes the
// frame-to-frame jitter of a single-camera estimate.
export function smoothFrames(frames,radius=2){
 if(radius<1)return frames;
 return frames.map((_,i)=>{
  const out={};
  for(const k of Object.keys(frames[i])){let s=[0,0,0],n=0;
   for(let j=Math.max(0,i-radius);j<=Math.min(frames.length-1,i+radius);j++){const v=frames[j][k];if(v){s=[s[0]+v[0],s[1]+v[1],s[2]+v[2]];n++;}}
   out[k]=s.map(v=>v/n);}
  return out;
 });
}

// Pose of every frame of a video element at `fps`. Frames where no person
// is found repeat the last pose; the share of such frames is reported.
export async function videoToClip(video,{name='video',label,role='other',loop=false,fps=30,smooth=2,sources=MEDIAPIPE_SOURCES,onStatus,onProgress}={}){
 const marker=await load(sources,onStatus);
 if(!(video.duration>0))await new Promise((res,rej)=>{video.onloadedmetadata=res;video.onerror=()=>rej(Error('Видео не открывается'));});
 // Recorded WebM often has no duration until the end is reached once.
 if(video.duration===Infinity){await new Promise(res=>{video.ondurationchange=()=>{if(video.duration!==Infinity)res();};video.currentTime=1e9;});}
 const count=Math.max(2,Math.floor(video.duration*fps)),frames=[];let missed=0,last=null;
 for(let i=0;i<count;i++){
  await new Promise(res=>{video.onseeked=res;video.currentTime=Math.min(video.duration-1e-3,i/fps);});
  const result=marker.detectForVideo(video,Math.round(i*1000/fps)+1);
  const world=result.worldLandmarks?.[0];
  if(world){last=fromMediaPipe(world);}else missed++;
  if(last)frames.push(last);
  onProgress?.((i+1)/count);
 }
 if(frames.length<2)throw Error('На видео не найден человек');
 const clip={name,label:label||name,role,loop,fps,frames:smoothFrames(frames,smooth)};
 return{clip,missed:missed/count};
}

export function videoMotionFile(clips,{name='video'}={}){
 return buildMotionFile({source:{kind:'video',name,license:'зависит от видео; поза — MediaPipe Pose (Apache-2.0)',note:'Поза по одной камере: глубина и стопы приблизительны, перемещение по сцене не восстанавливается.'},clips});
}
