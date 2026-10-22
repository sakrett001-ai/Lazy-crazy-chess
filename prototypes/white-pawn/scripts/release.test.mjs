import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,access,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeHostedConfig,validateCandidate,makeRelease,sourceCommit,sha256,MAX_DOCUMENT_BYTES} from './release-utils.mjs';

function fixture() {
  const modelBytes=Buffer.from('verified model fixture'),standaloneHtml=Buffer.from('<html>verified standalone</html>'),loadoutSource=Buffer.from('verified equipment runtime');
  const config=makeHostedConfig({commit:'a'.repeat(40),version:'0.4.0',modelBytes});
  const html=`<!doctype html><html><script id="model-data" type="application/octet-stream"></script><script>window.PAWN_HOSTED=Object.freeze(${JSON.stringify(config)});</script></html>`;
  return {html,config,modelBytes,standaloneHtml,loadoutSource,
    modelReport:{status:'passed',sha256:sha256(modelBytes),glb_bytes:modelBytes.length},
    equipmentReport:{status:'passed',glbSha256:sha256(modelBytes)},
    geometryReport:{status:'passed',glbSha256:sha256(modelBytes),runtimeSha256:sha256(loadoutSource)},
    variantReport:{status:'passed',glbSha256:sha256(modelBytes),documentSha256:sha256(standaloneHtml)},
    appearanceReport:{status:'passed',glbSha256:sha256(modelBytes),documentSha256:sha256(standaloneHtml)},
    viewerReport:{status:'passed',glbSha256:sha256(modelBytes),documentSha256:sha256(standaloneHtml)},
    hostedReport:{status:'passed',sourceCommit:config.sourceCommit,documentSha256:sha256(html),glbSha256:sha256(modelBytes),tamperedModelRejected:true},
    builtAt:'2026-10-21T00:00:00.000Z'};
}

test('release binds the exact verified document to its immutable source and model',()=>{
  const f=fixture(),r=makeRelease(f);
  assert.deepEqual(r,{schemaVersion:1,repository:'sakrett001-ai/Lazy-crazy-chess',sourceBranch:'main',sourceCommit:'a'.repeat(40),version:'0.4.0',modelVersion:'0.3.0',checks:'passed',builtAt:f.builtAt,document:{path:`chess/releases/${'a'.repeat(40)}/viewer.html`,sha256:sha256(f.html),bytes:Buffer.byteLength(f.html)}});
  assert.equal(f.config.modelUrl,`https://raw.githubusercontent.com/sakrett001-ai/Lazy-crazy-chess/${'a'.repeat(40)}/prototypes/white-pawn/assets/white-pawn.glb`);
});

test('mutable refs and malformed commits cannot create releases',()=>{
  for(const ref of ['main','abc123','../main','a'.repeat(39),'A'.repeat(40),undefined])assert.throws(()=>sourceCommit(ref));
});

test('external, mutable and unverified asset configurations are refused',()=>{
  for(const change of [
    c=>{c.modelUrl=c.modelUrl.replace('raw.githubusercontent.com','example.com');},
    c=>{c.modelUrl=c.modelUrl.replace('a'.repeat(40),'main');},
    c=>{c.posterUrl+='?override=1';},
    c=>{c.modelSha256='0'.repeat(64);},
    c=>{c.modelVersion='99.0.0';}
  ]) {const f=fixture();change(f.config);assert.throws(()=>validateCandidate(f));}
});

test('hosted document size and no embedded-model requirements are enforced',()=>{
  const f=fixture();
  assert.throws(()=>validateCandidate({...f,html:f.html+'x'.repeat(MAX_DOCUMENT_BYTES)}),/smaller than 2 MB/);
  assert.throws(()=>validateCandidate({...f,html:f.html.replace('</html>','<img src="data:image/png;base64,ZmFrZQ=="></html>')}),/poster/);
  assert.throws(()=>validateCandidate({...f,html:f.html.replace('></script><script>',`>${'a'.repeat(1001)}</script><script>`)}),/embed the GLB/);
});

const failureCases=[
  ['failed model checks',f=>{f.modelReport.status='failed';}],
  ['different model bytes',f=>{f.modelBytes=Buffer.from('modified model');}],
  ['incorrect model report byte size',f=>{f.modelReport.glb_bytes++;}],
  ['missing equipment checks',f=>{delete f.equipmentReport;},/Equipment and motion verification did not pass/],
  ['failed equipment checks',f=>{f.equipmentReport.status='failed';},/Equipment and motion verification did not pass/],
  ['stale equipment checks',f=>{f.equipmentReport.glbSha256='0'.repeat(64);},/Equipment report belongs to different GLB bytes/],
  ['missing geometry audit',f=>{delete f.geometryReport;},/Geometry audit did not pass/],
  ['failed geometry audit',f=>{f.geometryReport.status='failed';},/Geometry audit did not pass/],
  ['stale geometry audit',f=>{f.geometryReport.glbSha256='0'.repeat(64);},/Geometry report belongs to different GLB bytes/],
  ['missing runtime bytes',f=>{delete f.loadoutSource;},/Runtime source is required/],
  ['stale geometry runtime',f=>{f.loadoutSource=Buffer.from('changed runtime');},/Geometry report is stale for this equipment runtime/],
  ['missing variants checks',f=>{delete f.variantReport;},/Equipment variants verification did not pass/],
  ['failed variants checks',f=>{f.variantReport.status='failed';},/Equipment variants verification did not pass/],
  ['stale variants model',f=>{f.variantReport.glbSha256='0'.repeat(64);},/Variant report belongs to different GLB bytes/],
  ['stale variants document',f=>{f.variantReport.documentSha256='0'.repeat(64);},/Variant report is stale for this HTML/],
  ['missing appearance checks',f=>{delete f.appearanceReport;},/Appearance verification did not pass/],
  ['failed appearance checks',f=>{f.appearanceReport.status='failed';},/Appearance verification did not pass/],
  ['stale appearance model',f=>{f.appearanceReport.glbSha256='0'.repeat(64);},/Appearance report belongs to different GLB bytes/],
  ['stale appearance document',f=>{f.appearanceReport.documentSha256='0'.repeat(64);},/Appearance report is stale for this HTML/],
  ['failed standalone checks',f=>{f.viewerReport.status='failed';}],
  ['stale standalone report',f=>{f.standaloneHtml=Buffer.from('changed viewer');}],
  ['stale standalone GLB',f=>{f.viewerReport.glbSha256='0'.repeat(64);}],
  ['missing hosted browser checks',f=>{delete f.hostedReport;}],
  ['failed hosted browser checks',f=>{f.hostedReport.status='failed';}],
  ['stale hosted report',f=>{f.html+='\n';}],
  ['wrong hosted source commit',f=>{f.hostedReport.sourceCommit='b'.repeat(40);}],
  ['wrong hosted model hash',f=>{f.hostedReport.glbSha256='0'.repeat(64);}],
  ['untested integrity failure',f=>{f.hostedReport.tamperedModelRejected=false;}],
];
for(const [name,mutate,expected] of failureCases)test(`no passed manifest for ${name}`,()=>{const f=fixture();mutate(f);assert.throws(()=>makeRelease(f),expected);});

// Exercise the real command once: an old manifest must not survive a failed rebuild.
test('failed build command removes an old publishable manifest',async()=>{
  const dist=await mkdtemp(path.join(tmpdir(),'pawn-release-failure-'));
  const manifest=path.join(dist,'chess-release.json');
  try {
    await writeFile(manifest,JSON.stringify({checks:'passed',version:'old'}));
    const run=spawnSync(process.execPath,[fileURLToPath(new URL('./build-hosted.mjs',import.meta.url)),'--release'],{env:{...process.env,PAWN_DIST_DIR:dist,GITHUB_SHA:'main'},encoding:'utf8',timeout:10000});
    assert.notEqual(run.status,0);
    assert.match(run.stderr,/full immutable source commit/);
    await assert.rejects(access(manifest),{code:'ENOENT'});
  } finally {await rm(dist,{recursive:true,force:true});}
});
