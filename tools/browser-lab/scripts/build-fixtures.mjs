import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = `import {mount} from './fixtures/source/scene.mjs';
window.adapters={};
for(const fault of ['none','gap']){
  const adapter=mount({container:document.getElementById(fault),project:{contactFault:fault}});
  adapter.draw({time:.8});window.adapters[fault]=adapter;
}
window.ready=true;`;
const bundle = await build({stdin:{contents:entry,resolveDir:root},bundle:true,format:'iife',minify:true,write:false,legalComments:'inline'});
const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Browser Lab — захват</title>
<style>body{margin:0;background:#18232d;color:#edf3f8;font:18px system-ui}.pair{display:flex}.view{width:50vw;height:500px}h2{padding:12px;margin:0;font-size:22px}</style>
<div class="pair"><section><h2>Контакт сохранён</h2><div id="none" class="view"></div></section><section><h2>Зазор 40 мм</h2><div id="gap" class="view"></div></section></div>
<script>${bundle.outputFiles[0].text.replace(/<\/script/gi,'<\\/script')}</script></html>`;
await writeFile(resolve(root, 'fixtures/contacts.html'), html);
await mkdir(resolve(root, 'evidence'), {recursive:true});
await writeFile(resolve(root, 'evidence/fixture.json'), JSON.stringify({
  schema:'browser-lab-fixture/1',
  path:'fixtures/contacts.html',
  sha256:createHash('sha256').update(html).digest('hex'),
  bytes:Buffer.byteLength(html),
  browserStatus:'not-yet-run',
},null,2));
console.log('Built self-contained contact fixture.');
