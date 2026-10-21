import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transform} from '../../human-base/node_modules/esbuild/lib/main.js';
import {sha256} from './release-utils.mjs';

// Compile the production Floot helper, so these checks exercise its actual request
// validation and integrity handling rather than a duplicate implementation.
const source=await readFile(new URL('../../../floot/helpers/chessRelease.tsx',import.meta.url),'utf8');
const compiled=await transform(source,{loader:'tsx',format:'esm',target:'es2022'});
const {chessRelease}=await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);
const upstream='https://raw.githubusercontent.com/sakrett001-ai/Lazy-crazy-chess/gh-pages/';
function fixture() {
  const commit='b'.repeat(40),html='<html><script>window.PAWN_HOSTED={};</script></html>';
  return {html,manifest:{schemaVersion:1,repository:'sakrett001-ai/Lazy-crazy-chess',sourceBranch:'main',sourceCommit:commit,version:'0.2.0',modelVersion:'0.1.0',checks:'passed',builtAt:'2026-10-21T00:00:00.000Z',document:{path:`chess/releases/${commit}/viewer.html`,sha256:sha256(html),bytes:Buffer.byteLength(html)}}};
}
function mockFetch(f) {
  const requests=[];
  return {requests,fetcher:async(url,options)=>{
    requests.push({url,options});
    if(url.startsWith(upstream+'chess-release.json?t='))return new Response(JSON.stringify(f.manifest));
    assert.equal(url,upstream+f.manifest.document.path);
    return new Response(f.html);
  }};
}
test('real Floot helper accepts the exact immutable checked viewer',async()=>{
  const f=fixture(),mock=mockFetch(f),result=await chessRelease.read(mock.fetcher);
  assert.deepEqual(result,{html:f.html,version:'0.2.0',modelVersion:'0.1.0',sourceCommit:'b'.repeat(40),builtAt:f.manifest.builtAt});
  assert.equal(mock.requests.length,2);
  assert(mock.requests.every(r=>r.options.redirect==='error'&&r.options.cache==='no-store'));
});
test('real Floot helper rejects altered document bytes',async()=>{
  const f=fixture();f.html=f.html.replace('{}','[]');const mock=mockFetch(f);
  await assert.rejects(chessRelease.read(mock.fetcher),/целостности/);assert.equal(mock.requests.length,2);
});
test('real Floot helper rejects a foreign repository before downloading HTML',async()=>{
  const f=fixture();f.manifest.repository='different-owner/different-project';const mock=mockFetch(f);
  await assert.rejects(chessRelease.read(mock.fetcher),/подтвердить/);assert.equal(mock.requests.length,1);
});
test('real Floot helper rejects unchecked release and external document path',async()=>{
  for(const mutate of [m=>{m.checks='failed';},m=>{m.document.path='https://example.com/viewer.html';}]){
    const f=fixture();mutate(f.manifest);const mock=mockFetch(f);
    await assert.rejects(chessRelease.read(mock.fetcher));assert.equal(mock.requests.length,1);
  }
});
