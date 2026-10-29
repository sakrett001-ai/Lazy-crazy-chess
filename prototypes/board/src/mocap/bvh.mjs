import {add,qMul,qRotate,qAxisAngle,qIdentity} from './math.mjs';
import {resolveJoints} from './profiles.mjs';
import {buildMotionFile} from './format.mjs';

// BVH reader: hierarchy, motion and forward kinematics to joint positions.
// End sites become joints named "<parent>_end", so a foot without a toe
// joint still gives a toe point.
export function parseBVH(text){
 const tokens=text.split(/\s+/).filter(Boolean);let i=0;
 const next=()=>tokens[i++],expect=t=>{const v=next();if(v!==t)throw Error(`BVH: ожидалось «${t}», найдено «${v}»`);};
 const joints=[];
 function joint(parent,name,end=false){
  const index=joints.length,j={name,parent,offset:[0,0,0],channels:[],end};joints.push(j);
  expect('{');
  for(;;){
   const t=next();
   if(t==='OFFSET')j.offset=[+next(),+next(),+next()];
   else if(t==='CHANNELS'){const n=+next();for(let k=0;k<n;k++)j.channels.push(next());}
   else if(t==='JOINT')joint(index,next());
   else if(t==='End'){next();joint(index,name+'_end',true);}
   else if(t==='}')break;
   else throw Error('BVH: неожиданное слово «'+t+'»');
  }
 }
 expect('HIERARCHY');const root=next();if(root!=='ROOT')throw Error('BVH: нет ROOT');joint(-1,next());
 expect('MOTION');expect('Frames:');const frames=+next();expect('Frame');expect('Time:');const frameTime=+next();
 const width=joints.reduce((s,j)=>s+j.channels.length,0),values=new Float64Array(frames*width);
 for(let k=0;k<values.length;k++){const v=next();if(v===undefined)throw Error('BVH: данных меньше, чем кадров');values[k]=+v;}
 return{joints,frames,frameTime,width,values};
}

const AXES={Xrotation:[1,0,0],Yrotation:[0,1,0],Zrotation:[0,0,1]};
// Joint world positions for every frame: positions[frame][joint] = [x,y,z].
export function bvhPositions(bvh){
 const {joints,frames,width,values}=bvh,out=[];
 for(let f=0;f<frames;f++){
  let c=f*width;const pos=[],rot=[];
  for(let j=0;j<joints.length;j++){
   const J=joints[j];let local=[...J.offset],q=qIdentity();
   for(const ch of J.channels){const v=values[c++];
    if(ch==='Xposition')local[0]=J.offset[0]+v;else if(ch==='Yposition')local[1]=J.offset[1]+v;else if(ch==='Zposition')local[2]=J.offset[2]+v;
    else q=qMul(q,qAxisAngle(AXES[ch],v*Math.PI/180));}
   if(J.parent<0){pos.push(local);rot.push(q);}
   else{pos.push(add(pos[J.parent],qRotate(rot[J.parent],local)));rot.push(qMul(rot[J.parent],q));}
  }
  out.push(pos);
 }
 return out;
}

// A BVH file as one clip of the project's motion format.
export function bvhToClip(text,{name='bvh',label,role='other',loop=false}={}){
 const bvh=parseBVH(text),{map,profile,missing}=resolveJoints(bvh.joints.map(j=>j.name));
 // A foot's end site stands in for a missing toe joint.
 for(const s of ['L','R'])if(map['toe'+s]===undefined&&map['ankle'+s]!==undefined){const e=bvh.joints.findIndex(j=>j.end&&j.parent===map['ankle'+s]);if(e>=0)map['toe'+s]=e;}
 const still=missing.filter(p=>map[p]===undefined);
 if(still.length)throw Error('В скелете BVH не найдены точки: '+still.join(', ')+'. Суставы: '+bvh.joints.filter(j=>!j.end).map(j=>j.name).join(', '));
 const frames=bvhPositions(bvh).map(pos=>Object.fromEntries(Object.entries(map).map(([p,j])=>[p,pos[j]])));
 return{clip:{name,label:label||name,role,loop,fps:Math.round(1/bvh.frameTime*1000)/1000,frames},profile,joints:bvh.joints.length};
}
export function bvhToMotionFile(text,options={}){
 const {clip,profile}=bvhToClip(text,options);
 return buildMotionFile({source:{kind:'bvh',name:options.name||'bvh',skeleton:profile,license:options.license||'не указана'},clips:[clip]});
}
