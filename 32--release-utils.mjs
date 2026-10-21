import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const REPOSITORY='sakrett001-ai/Lazy-crazy-chess';
export const MAX_DOCUMENT_BYTES=2_000_000;
export const MODEL_VERSION='0.2.0';
export const sha256=data=>createHash('sha256').update(data).digest('hex');
export function sourceCommit(value) {
  assert.match(value??'',/^[a-f0-9]{40}$/,'A full immutable source commit is required');
  return value;
}
export function makeHostedConfig({commit,version,modelBytes}) {
  sourceCommit(commit);
  assert.match(version??'',/^\d+\.\d+\.\d+$/,'Invalid viewer version');
  const base=`https://raw.githubusercontent.com/${REPOSITORY}/${commit}/prototypes/white-pawn`;
  return {modelUrl:`${base}/assets/white-pawn.glb`,modelSha256:sha256(modelBytes),posterUrl:`${base}/review/neutral.png`,version,modelVersion:MODEL_VERSION,sourceCommit:commit};
}
export function validateCandidate({html,config,modelBytes}) {
  const expected=makeHostedConfig({commit:config.sourceCommit,version:config.version,modelBytes});
  assert.deepEqual(config,expected,'Hosted configuration must use exact immutable repository assets');
  const bytes=Buffer.byteLength(html);
  assert(bytes>0&&bytes<MAX_DOCUMENT_BYTES,'Hosted viewer must be smaller than 2 MB');
  assert(html.includes(`window.PAWN_HOSTED=Object.freeze(${JSON.stringify(expected)})`),'Hosted configuration is missing or changed');
  assert(!/<script[^>]+id=["']model-data["'][^>]*>\s*[A-Za-z0-9+/]{1000}/i.test(html),'Hosted HTML must not embed the GLB');
  assert(!/data:image\/(?:png|jpeg);base64,/i.test(html),'Hosted HTML must not embed the poster');
  return {path:`chess/releases/${config.sourceCommit}/viewer.html`,sha256:sha256(html),bytes};
}
export function assertBaseChecks({modelBytes,standaloneHtml,modelReport,viewerReport}) {
  const hash=sha256(modelBytes);
  assert.equal(modelReport?.status,'passed','Model verification did not pass');
  assert.equal(modelReport?.sha256,hash,'Model report belongs to different GLB bytes');
  assert.equal(modelReport?.glb_bytes,modelBytes.byteLength,'Model report has a different GLB size');
  assert.equal(viewerReport?.status,'passed','Standalone viewer verification did not pass');
  assert.equal(viewerReport?.glbSha256,hash,'Standalone report belongs to a different model');
  assert.equal(viewerReport?.documentSha256,sha256(standaloneHtml),'Standalone report is stale for this HTML');
}
export function makeRelease({html,config,modelBytes,standaloneHtml,modelReport,equipmentReport,geometryReport,viewerReport,hostedReport,builtAt=new Date().toISOString()}) {
  const document=validateCandidate({html,config,modelBytes});
  assertBaseChecks({modelBytes,standaloneHtml,modelReport,viewerReport});
  assert.equal(equipmentReport?.status,'passed','Equipment and motion verification did not pass');
  assert.equal(equipmentReport?.glbSha256,sha256(modelBytes),'Equipment report belongs to different GLB bytes');
  assert.equal(geometryReport?.status,'passed','Geometry audit did not pass');
  assert.equal(geometryReport?.glbSha256,sha256(modelBytes),'Geometry report belongs to different GLB bytes');
  assert.equal(hostedReport?.status,'passed','Hosted browser verification did not pass');
  assert.equal(hostedReport?.sourceCommit,config.sourceCommit,'Hosted report belongs to a different commit');
  assert.equal(hostedReport?.documentSha256,document.sha256,'Hosted report is stale for this HTML');
  assert.equal(hostedReport?.glbSha256,config.modelSha256,'Hosted report belongs to a different GLB');
  assert.equal(hostedReport?.tamperedModelRejected,true,'The model integrity failure case was not verified');
  assert(Number.isFinite(Date.parse(builtAt)),'Invalid build date');
  return {schemaVersion:1,repository:REPOSITORY,sourceBranch:'main',sourceCommit:config.sourceCommit,version:config.version,modelVersion:config.modelVersion,checks:'passed',builtAt,document};
}
