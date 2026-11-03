import {parseMotionFile,prepareClip,ROLES} from './format.mjs';
import {bvhToMotionFile} from './bvh.mjs';

// Motion files opened in the page: the project's JSON or a BVH. Nothing is
// uploaded anywhere; the clips live only in this tab.
export function readMotionSource(name,text){
 const trimmed=text.trimStart();
 let file;
 if(/^HIERARCHY/i.test(trimmed)){
  const base=name.replace(/\.[^.]+$/,''),role=guessRole(base);
  file=parseMotionFile(bvhToMotionFile(text,{name:base,label:base,role,loop:role==='march'}));
 }else file=parseMotionFile(JSON.parse(text));
 return{file,clips:file.clips.map(c=>({...prepareClip(file,c),source:file.source||{}}))};
}
// A role from a file name, so a dropped "march.bvh" lands in the right list.
export function guessRole(name){
 const n=name.toLowerCase();
 if(/march|строев|марш/.test(n))return'march';
 if(/step|шаг/.test(n))return'step';
 if(/idle|stand|стойк|покой|wait/.test(n))return'stand';
 if(/shift|weight|перемин/.test(n))return'shift';
 if(/approach|подход/.test(n))return'approach';
 if(/walk|ходьб/.test(n))return'march';
 return'other';
}
export {ROLES};
