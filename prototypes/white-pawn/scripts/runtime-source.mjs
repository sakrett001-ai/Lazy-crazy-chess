import {readFile} from 'node:fs/promises';
import path from 'node:path';

// Every module that changes articulated geometry belongs to the audit identity.
export const runtimeFiles=['src/loadout.mjs','src/biomechanics.mjs','src/grip.mjs'];
export async function runtimeSource(root){
 const parts=[];
 for(const name of runtimeFiles){
  const bytes=await readFile(path.join(root,name));
  parts.push(Buffer.from(name+'\n'),bytes,Buffer.from('\n'));
 }
 return Buffer.concat(parts);
}
