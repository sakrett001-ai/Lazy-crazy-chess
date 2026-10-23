import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,access,rm,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeHostedConfig,validateCandidate,makeRelease,sourceCommit,sha256,MAX_DOCUMENT_BYTES} from './release-utils.mjs';
import {runtimeFiles,runtimeSource} from './runtime-source.mjs';
import {assertReviewMotion} from '../src/review.mjs';

function fixture() {
  const modelBytes=Buffer.from('verified model fixture'),loadoutSource=Buffer.from('verified equipment runtime');
  const motionDeclaration=`window.PAWN_MOTION_SHA=${JSON.stringify(sha256(loadoutSource))};`;
  const standaloneHtml=Buffer.from(`<html><script>${motionDeclaration}</script>verified standalone</html>`);
  const biomechanicsAuditSource=Buffer.from('biomechanics audit fixture'),gripAuditSource=Buffer.from('grip audit fixture'),weaponClearanceAuditSource=Buffer.from('weapon clearance audit fixture'),enarmeAuditSource=Buffer.from('shield strap audit fixture'),bodyContactAuditSource=Buffer.from('body contact audit fixture');
  const motionReport=auditSource=>({status:'passed',glbSha256:sha256(modelBytes),runtimeSha256:sha256(loadoutSource),auditSha256:sha256(auditSource),scope:'Fixture motion audit',failures:[],checks:[{name:'Measured motion stays within limits',passed:true}],negativeControls:[{name:'Deliberately invalid motion rejected',passed:true}]});
  const weaponClearanceReport={...motionReport(weaponClearanceAuditSource),coverage:{sampleRateHz:10,caseCount:72,frameCount:2610,quick:false,weapons:['spear','sword'],shields:['tower','round','heater'],weaponMaterials:['weapon.metal','weapon.wood'],shieldMaterials:['shield.face','shield.wood','shield.trim'],bodyBuilds:['lean','regular','strong'],actions:['rest','Guard_Breath','Shield_Brace','Spear_Study']},cases:[],checks:[],negativeControls:[{name:'Imported sword hand is moved through the actual shield face',passed:true,beforeIntersectionPairs:0,afterIntersectionPairs:1,beforeWristWorld:[0,1,0],afterWristWorld:[.1,1,0],intersections:[{pointsWorld:[[0,1,0]]}]}]};
  for(const weaponType of ['spear','sword'])for(const shieldType of ['tower','round','heater'])for(const bodyBuild of ['lean','regular','strong'])for(const [action,samples]of Object.entries({rest:1,Guard_Breath:61,Shield_Brace:41,Spear_Study:42})){
    const id=[weaponType,shieldType,bodyBuild,action].join('/');weaponClearanceReport.cases.push({id,weaponType,shieldType,bodyBuild,action,samples,maximumIntersections:0,intersectingFrames:0,nonfinite:0,weaponTriangles:10,shieldTriangles:100,examples:[]});weaponClearanceReport.checks.push({name:id+': weapon does not cross shield surfaces',passed:true});
  }
  const bodyContactReport={...motionReport(bodyContactAuditSource),baseline:false,limits:{containmentToleranceM:.001,minimumRightHandAdvanceRelativeChestM:.06,minimumRightElbowExtensionDeg:10,minimumCombinedElbowExtensionDeg:10,minimumTwoHandElbowExtensionDeg:0,minimumFrontKneeFlexChangeDeg:2,minimumRearKneeExtensionDeg:2,minimumTorsoPitchChangeDeg:2,maximumFootDriftM:.006},bodyClearancePassed:true,wholeBodyContributionPassed:true,coverage:{quick:false,sampleRateHz:30,caseCount:18,frameCount:2178,weapons:['spear','sword','pike','greatsword'],bodyBuilds:['lean','regular','strong'],armorTypes:['plate','mail','padded'],actions:['Spear_Study']},cases:[],contributionCases:[],negativeControls:[
    {name:'Moved imported weapon and hand enter torso',passed:true,movementM:.2,beforeIntersectionPairs:0,beforeContainedVertices:0,afterIntersectionPairs:1,afterContainedVertices:0,beforeWristWorld:[0,1,0],afterWristWorld:[0,1,.2],intersections:[{pointWorld:[0,1,.15]}],contained:[]},
    {name:'Pelvis-only translated ready pose is rejected',passed:true,translationM:.1,rightHandAdvanceRelativeChestM:0,rightElbowExtensionDeg:0,frontKneeFlexChangeDeg:0,contributionPassed:false}
  ]};
  for(const weaponType of ['spear','sword','pike','greatsword'])for(const bodyBuild of ['lean','regular','strong'])for(const armorType of (weaponType==='greatsword'?['plate','mail','padded']:['plate'])) {
    const id=[weaponType,bodyBuild,armorType,'Spear_Study'].join('/');
    bodyContactReport.cases.push({id,weaponType,bodyBuild,armorType,action:'Spear_Study',duration:4,samples:121,intersectingFrames:0,maximumIntersectionPairs:0,containedFrames:0,maximumContainedVertices:0,maximumContainmentDepthM:0,nonfinite:0,weaponTriangles:10,handTriangles:{L:10,R:10},torsoTriangles:100,examples:[]});
    bodyContactReport.checks.push({name:id+': no torso contact',passed:true});
    if(armorType==='plate'){bodyContactReport.checks.push({name:id+': arms torso and legs contribute',passed:true});bodyContactReport.contributionCases.push({id,weaponType,bodyBuild,readyTime:1.25,peakTime:1.9,rightHandAdvanceRelativeChestM:.1,rightElbowExtensionDeg:15,leftElbowExtensionDeg:5,totalElbowExtensionDeg:20,frontKneeFlexChangeDeg:3,rearKneeExtensionDeg:3,torsoPitchChangeDeg:3,maximumFootDriftM:.001,passed:true});}
  }
  const config=makeHostedConfig({commit:'a'.repeat(40),version:'0.4.2',modelBytes});
  const html=`<!doctype html><html><script id="model-data" type="application/octet-stream"></script><script>${motionDeclaration}window.PAWN_HOSTED=Object.freeze(${JSON.stringify(config)});</script></html>`;
  return {html,config,modelBytes,standaloneHtml,loadoutSource,biomechanicsAuditSource,gripAuditSource,weaponClearanceAuditSource,weaponClearanceReport,enarmeAuditSource,bodyContactAuditSource,bodyContactReport,
    enarmeReport:{...motionReport(enarmeAuditSource),coverage:{quick:false,sampleRateHz:10,caseCount:36,frameCount:1314,shields:['tower','round','heater'],bodyBuilds:['regular','lean','strong'],actions:['rest','Guard_Breath','Shield_Brace','Spear_Study']}},
    biomechanicsReport:{...motionReport(biomechanicsAuditSource),coverage:{sampleRateHz:30,caseCount:42,frameCount:1452,weapons:['spear','sword','pike','greatsword'],bodyBuilds:['lean','regular','strong'],actions:['rest','Guard_Breath','Shield_Brace','Spear_Study']}},
    gripReport:{...motionReport(gripAuditSource),coverage:{frameCount:164,weapons:['spear','sword','pike','greatsword'],bodyBuilds:['lean','regular','strong'],sides:['L','R'],radiiM:[.014,.016]}},
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
  assert.deepEqual(r,{schemaVersion:1,repository:'sakrett001-ai/Lazy-crazy-chess',sourceBranch:'main',sourceCommit:'a'.repeat(40),version:'0.4.2',modelVersion:'0.3.0',checks:'passed',motionSha256:sha256(f.loadoutSource),biomechanicsStatus:'passed',gripStatus:'passed',weaponClearanceStatus:'passed',enarmeStatus:'passed',bodyContactStatus:'passed',wholeBodyContributionStatus:'passed',geometryStatus:'passed',geometryLimitations:[],builtAt:f.builtAt,document:{path:`chess/releases/${'a'.repeat(40)}/viewer.html`,sha256:sha256(f.html),bytes:Buffer.byteLength(f.html)}});
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

for(const [key,label] of [['biomechanics','Biomechanics'],['grip','Grip'],['weaponClearance','Weapon clearance'],['bodyContact','Body contact']]) {
  for(const [name,mutate,expected] of [
    ['missing audit',f=>{delete f[key+'Report'];},/verification did not pass/],
    ['failed audit',f=>{f[key+'Report'].status='failed';},/verification did not pass/],
    ['stale model',f=>{f[key+'Report'].glbSha256='0'.repeat(64);},/different GLB bytes/],
    ['stale runtime module',f=>{f[key+'Report'].runtimeSha256='0'.repeat(64);},/stale for this motion runtime/],
    ['changed audit code',f=>{f[key+'AuditSource']=Buffer.from('changed audit');},/stale for its audit source/],
    ['missing audit code',f=>{delete f[key+'AuditSource'];},/audit source is required/],
    ['failed check under passed status',f=>{f[key+'Report'].checks[0].passed=false;},/cannot waive/],
    ['failed negative control',f=>{f[key+'Report'].negativeControls[0].passed=false;},/cannot waive/],
    ['no checks',f=>{f[key+'Report'].checks=[];},/checks are required/],
    ['no negative controls',f=>{f[key+'Report'].negativeControls=[];},/negativeControls are required/],
    ['duplicate checks',f=>{f[key+'Report'].checks.push({...f[key+'Report'].checks[0]});},/unique named results/],
    ['retained failure',f=>{f[key+'Report'].failures=['unresolved'];},/retains failures/],
    ['missing scope',f=>{delete f[key+'Report'].scope;},/audit scope is required/],
    ['nonfinite measured value',f=>{f[key+'Report'].checks[0].distanceM=NaN;},/nonfinite/]
  ])test(`${label} gate refuses ${name}`,()=>{const f=fixture();mutate(f);assert.throws(()=>makeRelease(f),expected);});
}
for(const [name,change] of [
  ['low sample rate',c=>{c.sampleRateHz=1;}],['missing cases',c=>{c.caseCount=1;}],
  ['missing frames',c=>{c.frameCount=1;}],['untested weapon',c=>{c.weapons.pop();}],
  ['untested body build',c=>{c.bodyBuilds.pop();}],['untested action',c=>{c.actions.pop();}]
])test(`Biomechanics coverage refuses ${name}`,()=>{const f=fixture();change(f.biomechanicsReport.coverage);assert.throws(()=>makeRelease(f),/Biomechanics audit/);});
for(const [name,change] of [
  ['missing frames',c=>{c.frameCount=1;}],['untested weapon',c=>{c.weapons.pop();}],
  ['untested body build',c=>{c.bodyBuilds.pop();}],['untested hand',c=>{c.sides.pop();}],
  ['untested radius',c=>{c.radiiM.pop();}]
])test(`Grip coverage refuses ${name}`,()=>{const f=fixture();change(f.gripReport.coverage);assert.throws(()=>makeRelease(f),/Grip audit/);});
for(const [name,change] of [
  ['quick-only diagnostic',r=>{r.coverage.quick=true;}],['low sample rate',r=>{r.coverage.sampleRateHz=1;}],
  ['missing cases',r=>{r.coverage.caseCount=1;}],['missing frames',r=>{r.coverage.frameCount=1;}],
  ['untested shield',r=>{r.coverage.shields.pop();}],['untested weapon',r=>{r.coverage.weapons.pop();}],
  ['untested strong build',r=>{r.coverage.bodyBuilds=r.coverage.bodyBuilds.filter(b=>b!=='strong');}],
  ['regular-only old coverage',r=>{r.coverage.caseCount=24;r.coverage.frameCount=870;r.coverage.bodyBuilds=['regular'];r.cases=r.cases.filter(c=>c.bodyBuild==='regular');}],
  ['changed actual build identity',r=>{r.cases.find(c=>c.bodyBuild==='strong').bodyBuild='regular';}],
  ['strong build collision hidden by clear regular samples',r=>{r.cases.find(c=>c.bodyBuild==='strong').maximumIntersections=1;}],
  ['untested shield rim',r=>{r.coverage.shieldMaterials.pop();}],['untested weapon shaft',r=>{r.coverage.weaponMaterials.pop();}],
  ['untested action',r=>{r.coverage.actions.pop();}],['duplicate actual case',r=>{r.cases[1]={...r.cases[0]};}],
  ['claimed coverage without samples',r=>{r.cases[1].samples=1;}],['invented frame count',r=>{r.coverage.frameCount++;}],
  ['retained crossing evidence',r=>{r.cases[0].maximumIntersections=1;}],['missing actual triangles',r=>{r.cases[0].weaponTriangles=0;}],
  ['retained intersection example',r=>{r.cases[0].examples=[{}];}],['missing case check',r=>{r.checks.pop();}],
  ['already intersecting control baseline',r=>{r.negativeControls[0].beforeIntersectionPairs=1;}],
  ['unmoved control wrist',r=>{r.negativeControls[0].afterWristWorld=[...r.negativeControls[0].beforeWristWorld];}],
  ['control without actual intersection points',r=>{r.negativeControls[0].intersections=[];}]
])test(`Weapon clearance coverage refuses ${name}`,()=>{const f=fixture();change(f.weaponClearanceReport);assert.throws(()=>makeRelease(f),/Weapon clearance/);});
test('motion declarations must match audited runtime in both documents',()=>{
  const f=fixture(),bad=f.html.replace(sha256(f.loadoutSource),'0'.repeat(64));
  assert.throws(()=>makeRelease({...f,html:bad}),/Hosted document belongs to a different motion runtime/);
  const stale=Buffer.from(f.standaloneHtml.toString().replace(sha256(f.loadoutSource),'0'.repeat(64)));
  assert.throws(()=>makeRelease({...f,standaloneHtml:stale,viewerReport:{...f.viewerReport,documentSha256:sha256(stale)}}),/Standalone document belongs to a different motion runtime/);
});
test('Enarme gate requires a completed passed audit',()=>{
  for(const mutate of [f=>{delete f.enarmeReport;},f=>{f.enarmeReport.status='failed';},f=>{f.enarmeReport.failures=['strap crosses bracer'];}]){const f=fixture();mutate(f);assert.throws(()=>makeRelease(f),/Enarme/);}
});
test('Enarme audit binds exact GLB, all runtime modules and audit source',()=>{
  for(const key of ['glbSha256','runtimeSha256','auditSha256']){const f=fixture();f.enarmeReport[key]='0'.repeat(64);assert.throws(()=>makeRelease(f),/Enarme/);}
  const f=fixture();delete f.enarmeAuditSource;assert.throws(()=>makeRelease(f),/Enarme audit source is required/);
});
test('Enarme audit rejects quick or incomplete coverage',()=>{
  for(const change of [c=>{c.quick=true;},c=>{c.sampleRateHz=1;},c=>{c.caseCount=35;},c=>{c.frameCount=1313;},c=>{c.shields.pop();},c=>{c.bodyBuilds.pop();},c=>{c.actions.pop();}]){const f=fixture();change(f.enarmeReport.coverage);assert.throws(()=>makeRelease(f),/Enarme audit/);}
});
test('Enarme audit cannot hide failed checks or negative controls under passed status',()=>{
  for(const key of ['checks','negativeControls']){const f=fixture();f.enarmeReport[key][0].passed=false;assert.throws(()=>makeRelease(f),/Enarme cannot waive/);}
});
for(const [name,change]of [
  ['quick-only diagnostic',r=>{r.coverage.quick=true;}],['low sample rate',r=>{r.coverage.sampleRateHz=1;}],
  ['historical baseline',r=>{r.baseline=true;}],['weakened penetration tolerance',r=>{r.limits.containmentToleranceM=.02;}],
  ['weakened elbow threshold',r=>{r.limits.minimumCombinedElbowExtensionDeg=1;}],['weakened rear-leg threshold',r=>{r.limits.minimumRearKneeExtensionDeg=0;}],
  ['weakened hand-advance threshold',r=>{r.limits.minimumRightHandAdvanceRelativeChestM=.01;}],['weakened foot-contact threshold',r=>{r.limits.maximumFootDriftM=.1;}],
  ['incomplete case count',r=>{r.coverage.caseCount=17;}],['incomplete frames',r=>{r.coverage.frameCount=2177;}],
  ['untested weapon',r=>{r.coverage.weapons.pop();}],['untested build',r=>{r.coverage.bodyBuilds.pop();}],
  ['untested armor',r=>{r.coverage.armorTypes.pop();}],['untested action',r=>{r.coverage.actions=[];}],
  ['missing collision case',r=>{r.cases.pop();}],['duplicate collision case',r=>{r.cases[1]={...r.cases[0]};}],
  ['changed case identity',r=>{r.cases[0].armorType='mail';}],['shortened sampled cycle',r=>{r.cases[0].duration=2;}],
  ['undersampled actual cycle',r=>{r.cases[0].samples=120;}],['invented sample count',r=>{r.coverage.frameCount++;}],
  ['intersecting weapon or hand',r=>{r.cases[0].maximumIntersectionPairs=1;}],['hand contained inside torso',r=>{r.cases[0].maximumContainedVertices=1;}],
  ['retained collision frames',r=>{r.cases[0].intersectingFrames=1;}],['retained containment frames',r=>{r.cases[0].containedFrames=1;}],
  ['retained penetration depth',r=>{r.cases[0].maximumContainmentDepthM=.03;}],['missing case check',r=>{r.checks=r.checks.filter(c=>!c.name.endsWith(': no torso contact'));}],
  ['nonfinite contact geometry',r=>{r.cases[0].nonfinite=1;}],['retained collision example',r=>{r.cases[0].examples=[{}];}],
  ['missing weapon triangles',r=>{r.cases[0].weaponTriangles=0;}],['missing torso surface',r=>{r.cases[0].torsoTriangles=0;}],
  ['missing left-hand triangles',r=>{delete r.cases[0].handTriangles.L;}],['missing right-hand triangles',r=>{r.cases[0].handTriangles.R=0;}],
  ['failed body clearance',r=>{r.bodyClearancePassed=false;}],['failed whole-body summary',r=>{r.wholeBodyContributionPassed=false;}],
  ['missing contribution case',r=>{r.contributionCases.pop();}],['duplicate contribution case',r=>{r.contributionCases[1]={...r.contributionCases[0]};}],
  ['wrong ready phase',r=>{r.contributionCases[0].readyTime=0;}],['wrong peak phase',r=>{r.contributionCases[0].peakTime=0;}],
  ['failed measured contribution',r=>{r.contributionCases[0].passed=false;}],['pelvic slide without arm advance',r=>{r.contributionCases[0].rightHandAdvanceRelativeChestM=.025;}],
  ['no elbow extension',r=>{r.contributionCases[0].rightElbowExtensionDeg=0;}],['no front-knee flexion',r=>{r.contributionCases[0].frontKneeFlexChangeDeg=0;}],
  ['missing rear-leg evidence',r=>{delete r.contributionCases[0].rearKneeExtensionDeg;}],['no torso contribution',r=>{r.contributionCases[0].torsoPitchChangeDeg=0;}],
  ['no rear-knee extension',r=>{r.contributionCases[0].rearKneeExtensionDeg=0;}],['missing contribution checks',r=>{r.checks=r.checks.filter(c=>!c.name.endsWith(': arms torso and legs contribute'));}],
  ['invented combined elbow extension',r=>{r.contributionCases.find(c=>c.weaponType==='pike').totalElbowExtensionDeg=100;}],
  ['two-hand arms that retract',r=>{const c=r.contributionCases.find(c=>c.weaponType==='greatsword');c.rightElbowExtensionDeg=-1;c.leftElbowExtensionDeg=16;c.totalElbowExtensionDeg=15;}],
  ['two-hand arms without combined extension',r=>{const c=r.contributionCases.find(c=>c.weaponType==='greatsword');c.rightElbowExtensionDeg=4;c.leftElbowExtensionDeg=4;c.totalElbowExtensionDeg=8;}],
  ['sliding feet',r=>{r.contributionCases[0].maximumFootDriftM=.01;}],['negative foot drift',r=>{r.contributionCases[0].maximumFootDriftM=-.01;}],
  ['missing physical negative control',r=>{r.negativeControls.shift();}],['unmoved weapon control',r=>{r.negativeControls[0].movementM=0;}],
  ['already-crossing negative-control baseline',r=>{r.negativeControls[0].beforeIntersectionPairs=1;}],['already-contained negative-control baseline',r=>{r.negativeControls[0].beforeContainedVertices=1;}],
  ['mutation without measured body contact',r=>{r.negativeControls[0].afterIntersectionPairs=0;}],['missing pelvic-slide control',r=>{r.negativeControls.pop();}],
  ['physical control without actual movement vectors',r=>{delete r.negativeControls[0].afterWristWorld;}],['physical control without collision points',r=>{r.negativeControls[0].intersections=[];}],
  ['pelvis-only control that passes contribution',r=>{r.negativeControls[1].contributionPassed=true;}],
  ['unmoved pelvis control',r=>{r.negativeControls[1].translationM=0;}],['pelvis control secretly extends the arm',r=>{r.negativeControls[1].rightHandAdvanceRelativeChestM=.1;}]
])test(`Body contact coverage refuses ${name}`,()=>{const f=fixture();change(f.bodyContactReport);assert.throws(()=>makeRelease(f),/Body contact/);});
test('body contact accepts a measured contained-vertex negative control without surface crossing',()=>{
  const f=fixture(),control=f.bodyContactReport.negativeControls[0];control.afterIntersectionPairs=0;control.afterContainedVertices=8;control.intersections=[];control.contained=[{pointWorld:[0,1,.15]}];
  assert.equal(makeRelease(f).bodyContactStatus,'passed');
});
test('two-hand contribution supports asymmetric elbow extension with both arms advancing',()=>{
  const f=fixture();
  for(const c of f.bodyContactReport.contributionCases.filter(c=>['pike','greatsword'].includes(c.weaponType))){c.rightElbowExtensionDeg=4;c.leftElbowExtensionDeg=8;c.totalElbowExtensionDeg=12;}
  assert.equal(makeRelease(f).wholeBodyContributionStatus,'passed');
});
test('runtime identity includes motion, body coordination and facial geometry modules',()=>{
  for(const file of ['src/loadout.mjs','src/biomechanics.mjs','src/grip.mjs','src/full-body.mjs','src/appearance.mjs','src/facial-hair.mjs'])assert(runtimeFiles.includes(file),`Missing runtime identity module ${file}`);
  assert.equal(new Set(runtimeFiles).size,runtimeFiles.length,'Runtime identity modules must not repeat');
});
test('every articulated module changes runtime identity and missing modules are rejected',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'pawn-motion-'));
  try {
    await mkdir(path.join(dir,'src'));
    for(const file of runtimeFiles)await writeFile(path.join(dir,file),'original '+file);
    const initial=sha256(await runtimeSource(dir));
    for(const file of runtimeFiles){await writeFile(path.join(dir,file),'changed '+file);assert.notEqual(sha256(await runtimeSource(dir)),initial);await writeFile(path.join(dir,file),'original '+file);}
    for(const file of runtimeFiles){
      await rm(path.join(dir,file));
      await assert.rejects(runtimeSource(dir),{code:'ENOENT'});
      await writeFile(path.join(dir,file),'original '+file);
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('exact review restoration refuses changed or unknown motion on the same GLB',()=>{
  const current={modelSha256:'a'.repeat(64),motionSha256:'b'.repeat(64)};
  assert.doesNotThrow(()=>assertReviewMotion({...current},current));
  assert.throws(()=>assertReviewMotion({...current,motionSha256:'c'.repeat(64)},current),/Движение в этой версии изменилось/);
  assert.throws(()=>assertReviewMotion({modelSha256:current.modelSha256},current),/Движение в этой версии изменилось/);
  assert.throws(()=>assertReviewMotion({},{motionSha256:undefined}),/Движение в этой версии изменилось/);
});

function prototypeFixture() {
  const f=fixture();f.geometryAuditSource=Buffer.from('bounded intersection audit fixture');
  const report=f.geometryReport={...f.geometryReport,status:'failed',auditSha256:sha256(f.geometryAuditSource),scope:'18 bounded cases; not whole-body collision freedom',unassessed:[],limits:{handFrameErrorM:.01,soleDriftM:.006,soleFloorGapM:.008,thumbSurfaceDistanceM:.014},cases:[],checks:[],failures:[],negativeControls:[]};
  const check=(name,passed=true,details={})=>report.checks.push({name,passed,...details});
  for(const name of ['Required physical layer meshes exist','Layer meshes use the audited identity bind/world frame','mail: local bind patch coverage','plate: local bind patch coverage','Thumb skin vertices exist on both hands','Actual sole surfaces exist'])check(name);
  for(const bodyBuild of ['lean','regular','strong'])for(const [name,armorType,weaponType,shieldType,action,time] of [
    ['plate-rest','plate','spear','tower','rest',0],['mail-brace','mail','spear','tower','Shield_Brace',1.65],['mail-sword','mail','sword','round','Spear_Study',1.9],['padded-rest','padded','sword','heater','rest',0],['mail-pike','mail','pike','none','Spear_Study',1.9],['plate-greatsword','plate','greatsword','none','Spear_Study',1.9]
  ]) {
    const id=`${bodyBuild}/${name}`,entry={id,bodyBuild,armorType,weaponType,shieldType,action,time,layers:[],thumbs:[]};report.cases.push(entry);
    if(armorType!=='padded') {
      const known=id==='regular/mail-sword',patch={paddingWorld:[0,1,0],outerWallWorld:[0,1,.001],paddingNormal:[0,0,1],lateralDistanceM:.001,bindDistanceM:.008,trackedGapM:-.001,intersections:[{mesh:'mail',triangle:1,pointsWorld:[[0,1,0]]}]};
      const layer={probes:10,minTrackedGapM:known?-.001:.008,intersectionPatches:known?[patch]:[],inconclusivePatches:[],invalidSourcePatches:[],outerValidation:{nonfiniteTriangles:0,unassessedDegenerateTriangles:0}};entry.layers.push(layer);
      const checkName=`${id}: sampled garment triangles do not intersect`;
      check(checkName,!known,{probes:10,invalidSourcePatches:0,outerValidation:{...layer.outerValidation},intersectingPaddingTriangles:known?1:0,inconclusiveTrackedPatches:0,minTrackedGapM:layer.minTrackedGapM});
      if(known)report.failures.push(checkName);
    }
    check(`${id}: hand attachment frames meet targets`,true,{rightM:0,leftM:['pike','greatsword'].includes(weaponType)?0:null});
    for(const side of ['L','R']) {
      check(`${id}: ${side} actual sole stays planted`,true,{maxDriftM:0,minYM:.001});
      check(`${id}: ${side} thumb reaches actual handle`,true,{distanceM:.001});
      entry.thumbs.push({side,distanceM:.001,thumbWorld:[0,1,0],handleWorld:[0,1,.001]});
    }
  }
  report.negativeControls=[{name:'Move actual mail triangle across padding triangle',passed:true,intersectionPointsWorld:[[0,1,0]]},{name:'Move actual mail triangle inward60mm',passed:true,beforeM:.008,afterM:-.052}];
  for(const control of report.negativeControls)check(control.name);
  f.geometryAcceptance={schemaVersion:1,decision:'prototype-with-known-intersections',glbSha256:sha256(f.modelBytes),runtimeSha256:sha256(f.loadoutSource),geometryReportSha256:'',reviewer:'Codex',rationale:'The exact reported motion contact was visually reviewed for this prototype.',limitations:['Known mail intersection in the reviewed sword motion; not collision-free.']};
  bindPrototypeReport(f);return f;
}
function bindPrototypeReport(f) {f.geometryReportBytes=Buffer.from(JSON.stringify(f.geometryReport));f.geometryAcceptance.geometryReportSha256=sha256(f.geometryReportBytes);}

test('exact prototype acceptance retains failed geometry and exposes reviewed limitations',()=>{
  const f=prototypeFixture(),before=JSON.stringify(f.geometryReport),release=makeRelease(f);
  assert.equal(release.checks,'passed');assert.equal(release.geometryStatus,'failed');
  assert.equal(release.geometryDecision,'prototype-with-known-intersections');
  assert.deepEqual(release.geometryLimitations,f.geometryAcceptance.limitations);
  assert.equal(release.geometryReportSha256,sha256(f.geometryReportBytes));
  assert.deepEqual(release.geometryReview,{reviewer:'Codex',rationale:f.geometryAcceptance.rationale});
  assert.equal(JSON.stringify(f.geometryReport),before);
});

test('known intersections still reject without explicit acceptance',()=>{
  const f=prototypeFixture();delete f.geometryAcceptance;assert.throws(()=>makeRelease(f),/Geometry audit did not pass/);
});

test('garment intersection acceptance cannot waive joint, grip, weapon or body contact failures',()=>{
  for(const key of ['biomechanicsReport','gripReport','weaponClearanceReport','enarmeReport','bodyContactReport']) {
    const f=prototypeFixture();f[key].status='failed';
    assert.throws(()=>makeRelease(f),/verification did not pass/);
    f[key].status='passed';f[key].checks[0].passed=false;
    assert.throws(()=>makeRelease(f),/cannot waive/);
  }
});
test('garment acceptance cannot conceal hand penetration or a pelvic slide under a passed body status',()=>{
  for(const mutate of [r=>{r.cases[0].maximumContainedVertices=1;},r=>{r.contributionCases[0].rightHandAdvanceRelativeChestM=.025;},r=>{r.negativeControls[0].passed=false;}]){
    const f=prototypeFixture();mutate(f.bodyContactReport);assert.throws(()=>makeRelease(f),/Body contact/);
  }
});

for(const [name,mutate] of [
  ['different report bytes',f=>{f.geometryReportBytes=Buffer.concat([f.geometryReportBytes,Buffer.from('\n')]);}],
  ['different accepted model',f=>{f.geometryAcceptance.glbSha256='0'.repeat(64);}],
  ['different accepted runtime',f=>{f.geometryAcceptance.runtimeSha256='0'.repeat(64);}],
  ['different audit source',f=>{f.geometryAuditSource=Buffer.from('new audit');}],
  ['missing raw report',f=>{delete f.geometryReportBytes;}],
  ['changed parsed report',f=>{f.geometryReport.scope+=' changed';}],
  ['empty limitations',f=>{f.geometryAcceptance.limitations=[];}],
  ['blank rationale',f=>{f.geometryAcceptance.rationale=' ';}],
  ['unknown schema field',f=>{f.geometryAcceptance.waiveAll=true;}],
  ['nonintersection failure',f=>{const check=f.geometryReport.checks.find(c=>c.name.endsWith('L actual sole stays planted'));check.passed=false;f.geometryReport.failures.push(check.name);bindPrototypeReport(f);}],
  ['missing required check',f=>{f.geometryReport.checks=f.geometryReport.checks.filter(c=>!c.name.endsWith('R thumb reaches actual handle'));bindPrototypeReport(f);}],
  ['invalid source triangle',f=>{const entry=f.geometryReport.cases[0];entry.layers[0].invalidSourcePatches=[{reason:'degenerate'}];f.geometryReport.checks.find(c=>c.name===`${entry.id}: sampled garment triangles do not intersect`).invalidSourcePatches=1;bindPrototypeReport(f);}],
  ['nonfinite outer triangle',f=>{f.geometryReport.cases[0].layers[0].outerValidation.nonfiniteTriangles=1;bindPrototypeReport(f);}],
  ['nonfinite intersection point',f=>{f.geometryReport.cases.find(c=>c.id==='regular/mail-sword').layers[0].intersectionPatches[0].intersections[0].pointsWorld[0][0]=null;bindPrototypeReport(f);}],
  ['failed negative control',f=>{f.geometryReport.negativeControls[0].passed=false;bindPrototypeReport(f);}],
  ['missing sampled case',f=>{f.geometryReport.cases.pop();bindPrototypeReport(f);}],
  ['inconsistent failure summary',f=>{f.geometryReport.failures.push('unrecorded failure');bindPrototypeReport(f);}],
  ['error status',f=>{f.geometryReport.status='error';bindPrototypeReport(f);}]
])test(`prototype acceptance refuses ${name}`,()=>{const f=prototypeFixture();mutate(f);assert.throws(()=>makeRelease(f));});

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
