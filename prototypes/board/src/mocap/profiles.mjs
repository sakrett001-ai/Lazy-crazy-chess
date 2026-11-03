// Anatomical key points shared by every motion source. A source skeleton
// (BVH, MotionBricks SOMA, a video pose estimate) is reduced to these points
// once; retargeting onto our figures only ever reads them, so the source's
// bone axes, rest pose and units never matter.
export const POINTS=Object.freeze([
 'pelvis','spine','chest','neck','head','eyeL','eyeR','earL','earR','nose',
 'hipL','kneeL','ankleL','heelL','toeL','hipR','kneeR','ankleR','heelR','toeR',
 'shoulderL','elbowL','wristL','shoulderR','elbowR','wristR'
]);
// Points without which a figure cannot be retargeted.
export const REQUIRED=Object.freeze(['pelvis','hipL','kneeL','ankleL','toeL','hipR','kneeR','ankleR','toeR','shoulderL','shoulderR','neck','head']);

const norm=s=>String(s).replace(/^.*[:|]/,'').replace(/[._\-\s]/g,'').toLowerCase();
// Candidate joint names per point, normalised; {s} is the side word in all
// its usual spellings. The first candidate present in the skeleton wins.
const SIDE={L:['left','l'],R:['right','r']};
const CANDIDATES={
 pelvis:['hips','pelvis','hip'],
 spine:['spine','lowerback','spine1','spine01','abdomen'],
 chest:['chest','spine2','upperchest','spine1','spine3','spine02'],
 neck:['neck','neck1','neck01'],
 head:['head'],
 eye:['{s}eye','eye{s}'],
 hip:['{s}upleg','{s}thigh','{s}upperleg','upperleg{s}','thigh{s}','{s}hip','hip{s}','upleg{s}'],
 knee:['{s}leg','{s}shin','{s}lowerleg','lowerleg{s}','{s}knee','knee{s}','{s}calf','calf{s}','shin{s}','leg{s}'],
 ankle:['{s}foot','foot{s}','{s}ankle','ankle{s}'],
 toe:['{s}toebase','{s}toe','{s}toes','toes{s}','toe{s}','toebase{s}','{s}toeend','{s}footend'],
 shoulder:['{s}arm','{s}upperarm','upperarm{s}','{s}uparm','arm{s}','uparm{s}'],
 elbow:['{s}forearm','{s}lowerarm','lowerarm{s}','forearm{s}','{s}elbow','elbow{s}'],
 wrist:['{s}hand','hand{s}','{s}wrist','wrist{s}']
};
// Skeletons whose names mean something else than the usual convention.
// SOMA (MotionBricks) calls the thigh "Leg" and the knee "Shin".
const SPECIAL={
 soma:{test:names=>names.has('leftshin')&&names.has('leftleg'),map:{
  pelvis:'Hips',spine:'Spine1',chest:'Chest',neck:'Neck1',head:'Head',eyeL:'LeftEye',eyeR:'RightEye',
  hipL:'LeftLeg',kneeL:'LeftShin',ankleL:'LeftFoot',toeL:'LeftToeBase',hipR:'RightLeg',kneeR:'RightShin',ankleR:'RightFoot',toeR:'RightToeBase',
  shoulderL:'LeftArm',elbowL:'LeftForeArm',wristL:'LeftHand',shoulderR:'RightArm',elbowR:'RightForeArm',wristR:'RightHand'}}
};

// Map from point name to the joint index in `names`. Returns {map,profile,missing}.
export function resolveJoints(names){
 const index=new Map();names.forEach((n,i)=>{const k=norm(n);if(!index.has(k))index.set(k,i);});
 const keys=new Set(index.keys());
 for(const [profile,{test,map}]of Object.entries(SPECIAL))if(test(keys)){
  const out={};for(const [p,j]of Object.entries(map)){const i=index.get(norm(j));if(i!==undefined)out[p]=i;}
  return{map:out,profile,missing:REQUIRED.filter(p=>out[p]===undefined)};
 }
 const out={};
 const pick=list=>{for(const c of list){const i=index.get(c);if(i!==undefined)return i;}return undefined;};
 for(const p of ['pelvis','spine','chest','neck','head'])out[p]=pick(CANDIDATES[p]);
 for(const [side,words]of Object.entries(SIDE))for(const part of ['eye','hip','knee','ankle','toe','shoulder','elbow','wrist']){
  out[part+side]=pick(CANDIDATES[part].flatMap(c=>words.map(w=>c.replace('{s}',w))));
 }
 // A spine that is the chest too is no lower-spine point.
 if(out.spine===out.chest)delete out.spine;
 for(const k of Object.keys(out))if(out[k]===undefined)delete out[k];
 return{map:out,profile:'generic',missing:REQUIRED.filter(p=>out[p]===undefined)};
}

// MediaPipe Pose landmarks (33 points, the person's own left and right).
export const MEDIAPIPE=Object.freeze({nose:0,eyeL:2,eyeR:5,earL:7,earR:8,shoulderL:11,shoulderR:12,elbowL:13,elbowR:14,wristL:15,wristR:16,hipL:23,hipR:24,kneeL:25,kneeR:26,ankleL:27,ankleR:28,heelL:29,heelR:30,toeL:31,toeR:32});
// Key points from one MediaPipe world-landmark frame. MediaPipe's world
// space is image-aligned (x right, y down, z away from the camera); ours is
// y up, so y and z flip.
export function fromMediaPipe(landmarks){
 const p=i=>{const l=landmarks[i];return[l.x,-l.y,-l.z];};
 const out={};for(const [k,i]of Object.entries(MEDIAPIPE))out[k]=p(i);
 const m=(a,b)=>a.map((v,i)=>(v+b[i])/2);
 out.pelvis=m(out.hipL,out.hipR);out.neck=m(out.shoulderL,out.shoulderR);out.head=m(out.earL,out.earR);
 out.chest=out.pelvis.map((v,i)=>v+(out.neck[i]-v)*.7);
 return out;
}
