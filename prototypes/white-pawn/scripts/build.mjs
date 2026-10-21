import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {buildViewer,root} from './build-helper.mjs';

const html=await buildViewer();
await writeFile(path.join(root,'white-pawn.html'),html);
console.log(`Standalone white pawn: ${(Buffer.byteLength(html)/1048576).toFixed(1)} MiB; no external resources.`);
