import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {qMul,qRotate,add} from '../src/mocap/math.mjs';

// The pawn's rest skeleton read straight from the GLB (node TRS, world
// space of the glTF scene), so the retargeter is tested on the real rig
// without a browser.
export function pawnRest(){
 const buf=readFileSync(fileURLToPath(new URL('../../white-pawn/assets/white-pawn.glb',import.meta.url)));
 const json=JSON.parse(buf.subarray(20,20+buf.readUInt32LE(12)).toString());
 const nodes=json.nodes,parent=new Map();nodes.forEach((n,i)=>(n.children||[]).forEach(c=>parent.set(c,i)));
 const cache=new Map();
 const world=i=>{
  if(cache.has(i))return cache.get(i);
  const n=nodes[i],t=n.translation||[0,0,0],r=n.rotation||[0,0,0,1],s=n.scale||[1,1,1];
  let w;
  if(!parent.has(i))w={p:t,q:r,s};
  else{const pw=world(parent.get(i));w={p:add(pw.p,qRotate(pw.q,t.map((v,k)=>v*pw.s[k]))),q:qMul(pw.q,r),s:pw.s.map((v,k)=>v*s[k])};}
  cache.set(i,w);return w;
 };
 const pos={},quat={};
 nodes.forEach((n,i)=>{if(!n.name)return;const w=world(i);pos[n.name]=w.p;quat[n.name]=w.q;});
 return{pos,quat};
}
