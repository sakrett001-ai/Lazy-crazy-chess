import {build} from '../../human-base/node_modules/esbuild/lib/main.js';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Standalone board: page, three.js, chess.js and the pawn model in one file.
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pawn=path.resolve(root,'../white-pawn'),human=path.resolve(root,'../human-base');
const bundle=await build({entryPoints:[path.join(root,'src/board.mjs')],nodePaths:[path.join(root,'node_modules'),path.join(pawn,'node_modules'),path.join(human,'node_modules')],bundle:true,minify:true,write:false,format:'iife',legalComments:'inline',target:'es2022'});
const [template,css,three,chess,model]=await Promise.all([
 readFile(path.join(root,'src/index.html'),'utf8'),readFile(path.join(root,'src/style.css'),'utf8'),
 readFile(path.join(human,'licenses/three-MIT.txt'),'utf8'),readFile(path.join(root,'node_modules/chess.js/LICENSE'),'utf8'),
 readFile(path.join(pawn,'assets/white-pawn.glb'))
]);
const script=`/* Three.js MIT license:\n${three}\nchess.js BSD-2-Clause license:\n${chess}\n*/\n`+bundle.outputFiles[0].text;
const html=template.replace('/*STYLE*/',()=>css).replace('/*SCRIPT*/',()=>script.replaceAll('</script','<\\/script')).replace('/*MODEL*/',()=>model.toString('base64'));
const out=path.join(root,'board.html');
await writeFile(out,html);
console.log(`Standalone board: ${(Buffer.byteLength(html)/1048576).toFixed(1)} MiB, ${out}`);
