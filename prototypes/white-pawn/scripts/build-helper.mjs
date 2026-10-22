import {build} from '../../human-base/node_modules/esbuild/lib/main.js';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {runtimeSource} from './runtime-source.mjs';

export const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const repositoryRoot=path.resolve(root,'../..');
const shared=path.resolve(root,'../human-base');

export async function buildViewer({hostedConfig=null}={}) {
  const motionSource=await runtimeSource(root),motionSha256=createHash('sha256').update(motionSource).digest('hex');
  const bundle=await build({entryPoints:[path.join(root,'src/viewer.mjs')],nodePaths:[path.join(root,'node_modules'),path.join(shared,'node_modules')],bundle:true,minify:true,write:false,format:'iife',legalComments:'inline',target:'es2022'});
  if(!motionSource.equals(await runtimeSource(root)))throw new Error('Motion source changed while bundling; rebuild the viewer');
  const [template,css,license,cameraLicense]=await Promise.all([
    readFile(path.join(root,'src/index.html'),'utf8'),readFile(path.join(root,'src/style.css'),'utf8'),
    readFile(path.join(shared,'licenses/three-MIT.txt'),'utf8'),readFile(path.join(shared,'licenses/anatomy-MIT.txt'),'utf8')
  ]);
  const model=hostedConfig?'':(await readFile(path.join(root,'assets/white-pawn.glb'))).toString('base64');
  const poster=hostedConfig?hostedConfig.posterUrl:`data:image/png;base64,${(await readFile(path.join(root,'review/neutral.png'))).toString('base64')}`;
  const config=`window.PAWN_MOTION_SHA=${JSON.stringify(motionSha256)};\n`+(hostedConfig?`window.PAWN_HOSTED=Object.freeze(${JSON.stringify(hostedConfig)});\n`:'');
  const script=`/* Three.js MIT license:\n${license}\nCamera helper (Anatomy):\n${cameraLicense}\n*/\n`+config+bundle.outputFiles[0].text;
  return template.replace('/*STYLE*/',()=>css).replace('/*SCRIPT*/',()=>script.replaceAll('</script','<\\/script')).replace('/*MODEL*/',()=>model).replace('/*POSTER*/',()=>poster);
}
