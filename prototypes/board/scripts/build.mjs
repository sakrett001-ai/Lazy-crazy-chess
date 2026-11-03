import {build} from '../../human-base/node_modules/esbuild/lib/main.js';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {gzipSync} from 'node:zlib';

// Standalone board: page, three.js, chess.js and the pawn model in one file.
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pawn=path.resolve(root,'../white-pawn'),human=path.resolve(root,'../human-base');
const bundleOf=entry=>build({entryPoints:[path.join(root,entry)],nodePaths:[path.join(root,'node_modules'),path.join(pawn,'node_modules'),path.join(human,'node_modules')],bundle:true,minify:true,write:false,format:'iife',legalComments:'inline',target:'es2022'});
const [bundle,labBundle]=await Promise.all([bundleOf('src/board.mjs'),bundleOf('src/lab.mjs')]);
const [template,labTemplate,css,labCss,three,chess,model]=await Promise.all([
 readFile(path.join(root,'src/index.html'),'utf8'),readFile(path.join(root,'src/lab.html'),'utf8'),readFile(path.join(root,'src/style.css'),'utf8'),readFile(path.join(root,'src/lab.css'),'utf8'),
 readFile(path.join(human,'licenses/three-MIT.txt'),'utf8'),readFile(path.join(root,'node_modules/chess.js/LICENSE'),'utf8'),
 readFile(path.join(pawn,'assets/white-pawn.glb'))
]);
const script=`/* Three.js MIT license:\n${three}\nchess.js BSD-2-Clause license:\n${chess}\n*/\n`+bundle.outputFiles[0].text;
// `--motion <file>` (repeatable) builds motion files into the board page; it
// loads them at start as if opened by hand (src/board.mjs, #motion-data).
const motions=await Promise.all(process.argv.flatMap((a,i)=>a==='--motion'?[process.argv[i+1]]:[]).map(async f=>({name:path.basename(f),text:await readFile(path.resolve(f),'utf8')})));
const motionData=JSON.stringify(motions).replaceAll('</','<\\/');
const html=template.replace('/*MOTIONS*/[]',()=>motionData).replace('/*STYLE*/',()=>css).replace('/*SCRIPT*/',()=>script.replaceAll('</script','<\\/script')).replace('/*MODEL*/',()=>model.toString('base64'));
const out=path.join(root,'board.html');
await writeFile(out,html);
console.log(`Standalone board: ${(Buffer.byteLength(html)/1048576).toFixed(1)} MiB, ${out}`+(motions.length?`, движения: ${motions.map(m=>m.name).join(', ')}`:''));

// Motion lab: the same pawn model, one clip on four lanes (lab.mjs).
const labScript=`/* Three.js MIT license:\n${three}\n*/\n`+labBundle.outputFiles[0].text;
const labHtml=labTemplate.replace('/*STYLE*/',()=>css+'\n'+labCss).replace('/*SCRIPT*/',()=>labScript.replaceAll('</script','<\\/script')).replace('/*MODEL*/',()=>model.toString('base64'));
const labOut=path.join(root,'motion-lab.html');
await writeFile(labOut,labHtml);
console.log(`Motion lab: ${(Buffer.byteLength(labHtml)/1048576).toFixed(1)} MiB, ${labOut}`);

// Optional hosted build: `node scripts/build.mjs --web <dir>` writes the page
// body without the document skeleton, with the model gzipped inline so the
// page loads nothing from other addresses and stays under 16 MB.
const web=process.argv.indexOf('--web');
if(web>0){
 const dir=path.resolve(process.argv[web+1]);await mkdir(dir,{recursive:true});
 const packed=gzipSync(model,{level:9}).toString('base64');
 const page=html.replace(/<script id="model-data"[^>]*>[^<]*<\/script>/,()=>`<script id="model-data" type="application/octet-stream" data-encoding="gzip">${packed}</script>`);
 const title=page.match(/<title>.*?<\/title>/)[0],style=page.match(/<style>[\s\S]*?<\/style>/)[0],body=page.match(/<body>([\s\S]*)<\/body>/)[1];
 const out=`${title}\n${style}\n${body}`;
 await writeFile(path.join(dir,'index.html'),out);
 console.log(`Web board: ${(Buffer.byteLength(out)/1048576).toFixed(1)} MiB, ${dir}`);
}
