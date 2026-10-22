import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const REPOSITORY='sakrett001-ai/Lazy-crazy-chess';
export const MAX_DOCUMENT_BYTES=2_000_000;
export const MODEL_VERSION='0.3.0';
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
const geometryCases=[
  ['plate-rest','plate','spear','tower','rest',0],
  ['mail-brace','mail','spear','tower','Shield_Brace',1.65],
  ['mail-sword','mail','sword','round','Spear_Study',1.9],
  ['padded-rest','padded','sword','heater','rest',0],
  ['mail-pike','mail','pike','none','Spear_Study',1.9],
  ['plate-greatsword','plate','greatsword','none','Spear_Study',1.9]
];
const controlNames=['Move actual mail triangle across padding triangle','Move actual mail triangle inward60mm'];
const nonempty=value=>typeof value==='string'&&value.trim().length>0;
const count=value=>Number.isSafeInteger(value)&&value>=0;
const finiteVector=value=>Array.isArray(value)&&value.length===3&&value.every(Number.isFinite);
function assertFiniteNumbers(value) {
  if(typeof value==='number')assert(Number.isFinite(value),'Geometry report contains nonfinite values');
  else if(value&&typeof value==='object')for(const child of Object.values(value))assertFiniteNumbers(child);
}
function assertKnownIntersectionReport(report) {
  assert(report&&report.status==='failed'&&!report.failure,'Only a completed failed geometry audit can receive prototype acceptance');
  assert(Array.isArray(report.cases)&&report.cases.length===18,'Prototype acceptance requires all 18 geometry cases');
  assert(Array.isArray(report.checks)&&report.checks.length>=113,'Geometry audit checks are incomplete');
  assert(Array.isArray(report.failures)&&report.failures.length>0,'Geometry audit must retain its failures');
  assert(nonempty(report.scope)&&Array.isArray(report.unassessed),'Geometry audit scope is missing');
  assertFiniteNumbers(report);
  const checks=new Map();
  for(const check of report.checks) {
    assert(nonempty(check?.name)&&typeof check.passed==='boolean'&&!checks.has(check.name),'Geometry checks must have unique names and boolean results');
    checks.set(check.name,check);
  }
  const requirePassed=name=>{const check=checks.get(name);assert(check?.passed===true,`Prototype acceptance cannot waive ${name}`);return check;};
  for(const name of ['Required physical layer meshes exist','Layer meshes use the audited identity bind/world frame','mail: local bind patch coverage','plate: local bind patch coverage','Thumb skin vertices exist on both hands','Actual sole surfaces exist'])requirePassed(name);
  const limits=report.limits;
  for(const key of ['handFrameErrorM','soleDriftM','soleFloorGapM','thumbSurfaceDistanceM'])assert(Number.isFinite(limits?.[key])&&limits[key]>0,`Missing geometry limit ${key}`);
  const seenCases=new Set(),allowedFailures=new Set();
  for(const bodyBuild of ['lean','regular','strong'])for(const [name,armorType,weaponType,shieldType,action,time] of geometryCases) {
    const id=`${bodyBuild}/${name}`,matches=report.cases.filter(entry=>entry?.id===id);
    assert.equal(matches.length,1,`Missing or duplicate geometry case ${id}`);
    const entry=matches[0];seenCases.add(id);
    for(const [key,value] of Object.entries({bodyBuild,armorType,weaponType,shieldType,action,time}))assert.equal(entry[key],value,`Geometry case ${id} has changed ${key}`);
    assert(Array.isArray(entry.layers)&&entry.layers.length===(armorType==='padded'?0:1),`Invalid layer evidence for ${id}`);
    const frame=requirePassed(`${id}: hand attachment frames meet targets`),twoHanded=weaponType==='pike'||weaponType==='greatsword';
    assert(Number.isFinite(frame.rightM)&&frame.rightM>=0&&frame.rightM<=limits.handFrameErrorM,'Invalid right-hand frame evidence');
    assert(!twoHanded||(Number.isFinite(frame.leftM)&&frame.leftM>=0&&frame.leftM<=limits.handFrameErrorM),'Invalid left-hand frame evidence');
    assert(Array.isArray(entry.thumbs)&&entry.thumbs.length===2,`Missing thumb evidence for ${id}`);
    for(const side of ['L','R']) {
      const sole=requirePassed(`${id}: ${side} actual sole stays planted`),thumb=requirePassed(`${id}: ${side} thumb reaches actual handle`);
      assert(Number.isFinite(sole.maxDriftM)&&sole.maxDriftM>=0&&sole.maxDriftM<=limits.soleDriftM&&Number.isFinite(sole.minYM)&&sole.minYM>=-.004&&sole.minYM<=limits.soleFloorGapM,'Invalid sole evidence');
      const contacts=entry.thumbs.filter(contact=>contact.side===side);
      assert(contacts.length===1&&Number.isFinite(thumb.distanceM)&&thumb.distanceM>=0&&thumb.distanceM<=limits.thumbSurfaceDistanceM&&contacts[0].distanceM===thumb.distanceM,'Invalid thumb evidence');
      assert(finiteVector(contacts[0].thumbWorld)&&finiteVector(contacts[0].handleWorld),'Nonfinite thumb coordinates');
    }
    if(armorType==='padded')continue;
    const layer=entry.layers[0],checkName=`${id}: sampled garment triangles do not intersect`,check=checks.get(checkName);
    assert(check&&count(check.probes)&&check.probes>0&&layer.probes===check.probes,'Missing sampled layer evidence');
    assert(Array.isArray(layer.invalidSourcePatches)&&layer.invalidSourcePatches.length===0&&check.invalidSourcePatches===0,'Prototype acceptance cannot waive invalid source triangles');
    for(const validation of [layer.outerValidation,check.outerValidation])assert(validation?.nonfiniteTriangles===0&&count(validation.unassessedDegenerateTriangles),'Prototype acceptance cannot waive nonfinite outer triangles');
    assert.deepEqual(layer.outerValidation,check.outerValidation,'Inconsistent outer triangle evidence');
    assert(Array.isArray(layer.intersectionPatches)&&Array.isArray(layer.inconclusivePatches),'Missing intersection evidence');
    assert.equal(check.intersectingPaddingTriangles,layer.intersectionPatches.length,'Intersection count does not match evidence');
    assert.equal(check.inconclusiveTrackedPatches,layer.inconclusivePatches.length,'Inconclusive count does not match evidence');
    assert(Number.isFinite(layer.minTrackedGapM)&&Number.isFinite(check.minTrackedGapM),'Nonfinite tracked geometry gap');
    for(const patch of [...layer.intersectionPatches,...layer.inconclusivePatches]) {
      for(const key of ['paddingWorld','outerWallWorld','paddingNormal'])assert(finiteVector(patch[key]),`Invalid ${key}`);
      for(const key of ['lateralDistanceM','bindDistanceM','trackedGapM'])assert(Number.isFinite(patch[key]),`Invalid ${key}`);
    }
    for(const patch of layer.intersectionPatches) {
      assert(Array.isArray(patch.intersections)&&patch.intersections.length>0,'Intersection failure lacks actual intersection evidence');
      for(const hit of patch.intersections)assert(nonempty(hit.mesh)&&count(hit.triangle)&&Array.isArray(hit.pointsWorld)&&hit.pointsWorld.length>0&&hit.pointsWorld.every(finiteVector),'Invalid intersection coordinates');
    }
    assert.equal(check.passed,layer.intersectionPatches.length===0,'Layer result is inconsistent with intersection evidence');
    if(!check.passed)allowedFailures.add(checkName);
  }
  assert.equal(seenCases.size,report.cases.length,'Unexpected geometry case');
  const failed=report.checks.filter(check=>!check.passed).map(check=>check.name);
  assert(failed.every(name=>allowedFailures.has(name)),'Prototype acceptance can waive only sampled garment intersections');
  assert.deepEqual([...report.failures].sort(),[...failed].sort(),'Geometry failure summary differs from failed checks');
  assert(Array.isArray(report.negativeControls)&&report.negativeControls.length===2,'Both geometry negative controls are required');
  for(const name of controlNames) {
    const matches=report.negativeControls.filter(control=>control.name===name);
    assert(matches.length===1&&matches[0].passed===true,`Prototype acceptance cannot waive negative control ${name}`);requirePassed(name);
  }
  const crossing=report.negativeControls.find(control=>control.name===controlNames[0]),inward=report.negativeControls.find(control=>control.name===controlNames[1]);
  assert(Array.isArray(crossing.intersectionPointsWorld)&&crossing.intersectionPointsWorld.length>0&&crossing.intersectionPointsWorld.every(finiteVector),'Missing negative-control intersection coordinates');
  assert(Number.isFinite(inward.beforeM)&&Number.isFinite(inward.afterM)&&inward.afterM<0,'Invalid negative-control gap');
}
function geometryReleaseDecision({geometryReport,geometryReportBytes,geometryAcceptance,geometryAuditSource,modelBytes,loadoutSource}) {
  assert(geometryReport&&['passed','failed'].includes(geometryReport.status),'Geometry audit did not pass');
  assert.equal(geometryReport.glbSha256,sha256(modelBytes),'Geometry report belongs to different GLB bytes');
  assert(loadoutSource?.byteLength,'Runtime source is required for the geometry audit');
  assert.equal(geometryReport.runtimeSha256,sha256(loadoutSource),'Geometry report is stale for this equipment runtime');
  if(geometryAcceptance===undefined) {
    assert.equal(geometryReport.status,'passed','Geometry audit did not pass; exact prototype acceptance is required for known intersections');
    return {geometryStatus:'passed',geometryLimitations:[]};
  }
  assert(geometryAcceptance&&typeof geometryAcceptance==='object'&&!Array.isArray(geometryAcceptance),'Invalid geometry acceptance');
  assert.deepEqual(Object.keys(geometryAcceptance).sort(),['schemaVersion','decision','glbSha256','runtimeSha256','geometryReportSha256','reviewer','rationale','limitations'].sort(),'Unexpected geometry acceptance fields');
  assert.equal(geometryAcceptance.schemaVersion,1,'Unsupported geometry acceptance schema');
  assert.equal(geometryAcceptance.decision,'prototype-with-known-intersections','Invalid geometry acceptance decision');
  assert.equal(geometryAcceptance.reviewer,'Codex','Invalid geometry acceptance reviewer');
  assert(nonempty(geometryAcceptance.rationale)&&Array.isArray(geometryAcceptance.limitations)&&geometryAcceptance.limitations.length>0&&geometryAcceptance.limitations.every(nonempty),'Geometry acceptance requires rationale and explicit limitations');
  assert(geometryReportBytes?.byteLength,'Raw geometry report bytes are required for prototype acceptance');
  assert.deepEqual(JSON.parse(Buffer.from(geometryReportBytes).toString('utf8')),geometryReport,'Parsed geometry report differs from exact report bytes');
  assert.equal(geometryAcceptance.geometryReportSha256,sha256(geometryReportBytes),'Prototype acceptance belongs to different geometry report bytes');
  assert.equal(geometryAcceptance.glbSha256,sha256(modelBytes),'Prototype acceptance belongs to different GLB bytes');
  assert.equal(geometryAcceptance.runtimeSha256,sha256(loadoutSource),'Prototype acceptance belongs to different runtime bytes');
  assert(geometryAuditSource?.byteLength,'Geometry audit source is required for prototype acceptance');
  assert.equal(geometryReport.auditSha256,sha256(geometryAuditSource),'Prototype acceptance report is stale for this geometry audit');
  assertKnownIntersectionReport(geometryReport);
  return {geometryStatus:'failed',geometryDecision:geometryAcceptance.decision,geometryLimitations:[...geometryAcceptance.limitations],geometryReportSha256:geometryAcceptance.geometryReportSha256,geometryReview:{reviewer:geometryAcceptance.reviewer,rationale:geometryAcceptance.rationale}};
}
export function makeRelease({html,config,modelBytes,standaloneHtml,modelReport,equipmentReport,geometryReport,geometryReportBytes,geometryAcceptance,geometryAuditSource,loadoutSource,variantReport,appearanceReport,viewerReport,hostedReport,builtAt=new Date().toISOString()}) {
  const document=validateCandidate({html,config,modelBytes});
  assertBaseChecks({modelBytes,standaloneHtml,modelReport,viewerReport});
  assert.equal(equipmentReport?.status,'passed','Equipment and motion verification did not pass');
  assert.equal(equipmentReport?.glbSha256,sha256(modelBytes),'Equipment report belongs to different GLB bytes');
  const geometry=geometryReleaseDecision({geometryReport,geometryReportBytes,geometryAcceptance,geometryAuditSource,modelBytes,loadoutSource});
  assert.equal(variantReport?.status,'passed','Equipment variants verification did not pass');
  assert.equal(variantReport?.glbSha256,sha256(modelBytes),'Variant report belongs to different GLB bytes');
  assert.equal(variantReport?.documentSha256,sha256(standaloneHtml),'Variant report is stale for this HTML');
  assert.equal(appearanceReport?.status,'passed','Appearance verification did not pass');
  assert.equal(appearanceReport?.glbSha256,sha256(modelBytes),'Appearance report belongs to different GLB bytes');
  assert.equal(appearanceReport?.documentSha256,sha256(standaloneHtml),'Appearance report is stale for this HTML');
  assert.equal(hostedReport?.status,'passed','Hosted browser verification did not pass');
  assert.equal(hostedReport?.sourceCommit,config.sourceCommit,'Hosted report belongs to a different commit');
  assert.equal(hostedReport?.documentSha256,document.sha256,'Hosted report is stale for this HTML');
  assert.equal(hostedReport?.glbSha256,config.modelSha256,'Hosted report belongs to a different GLB');
  assert.equal(hostedReport?.tamperedModelRejected,true,'The model integrity failure case was not verified');
  assert(Number.isFinite(Date.parse(builtAt)),'Invalid build date');
  return {schemaVersion:1,repository:REPOSITORY,sourceBranch:'main',sourceCommit:config.sourceCommit,version:config.version,modelVersion:config.modelVersion,checks:'passed',...geometry,builtAt,document};
}
