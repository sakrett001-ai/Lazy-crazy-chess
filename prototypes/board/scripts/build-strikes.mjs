import {build} from '../../human-base/node_modules/esbuild/lib/main.js';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {gzipSync} from 'node:zlib';

// Strike stand (src/strikes.mjs): the recording and the fighter side by side.
// node scripts/build-strikes.mjs [--motion tools/strikes/out/strikes.motion.json] [--out tools/strikes/out/strike-lab.html]
// The motion file comes from tools/strikes/build.mjs; it holds clips derived
// from a CC BY-NC dataset, so the page stays out of git like the file.
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pawn=path.resolve(root,'../white-pawn'),human=path.resolve(root,'../human-base');
const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:fallback;};
const motion=path.resolve(arg('--motion',path.join(root,'tools/strikes/out/strikes.motion.json')));
const out=path.resolve(arg('--out',path.join(root,'tools/strikes/out/strike-lab.html')));
const bundle=await build({entryPoints:[path.join(root,'src/strikes.mjs')],nodePaths:[path.join(root,'node_modules'),path.join(pawn,'node_modules'),path.join(human,'node_modules')],bundle:true,minify:!process.argv.includes('--debug'),write:false,format:'iife',legalComments:'inline',target:'es2022'});
const [template,three,model,data]=await Promise.all([readFile(path.join(root,'src/strikes.html'),'utf8'),readFile(path.join(human,'licenses/three-MIT.txt'),'utf8'),readFile(path.join(pawn,'assets/white-pawn.glb')),readFile(motion,'utf8')]);
const script=`/* Three.js MIT license:\n${three}\n*/\n`+bundle.outputFiles[0].text;
// --gzip packs the model (the page unpacks it, src/strikes.mjs) to stay under 16 MB for hosting.
const gzip=process.argv.includes('--gzip');
const html=template.replace('/*STRIKES*/',()=>data.replaceAll('</','<\\/')).replace('/*SCRIPT*/',()=>script.replaceAll('</script','<\\/script'))
 .replace('<script id="model-data" type="application/octet-stream">/*MODEL*/',()=>`<script id="model-data" type="application/octet-stream"${gzip?' data-encoding="gzip"':''}>`+(gzip?gzipSync(model,{level:9}):model).toString('base64'));
await mkdir(path.dirname(out),{recursive:true});await writeFile(out,html);
console.log(`Strike stand: ${(Buffer.byteLength(html)/1048576).toFixed(1)} MiB, ${out}`);
