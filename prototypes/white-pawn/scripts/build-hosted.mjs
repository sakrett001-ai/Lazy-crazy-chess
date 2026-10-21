import {readFile,writeFile,mkdir,rm,rename} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildViewer,root,repositoryRoot} from './build-helper.mjs';
import {makeHostedConfig,validateCandidate,makeRelease,sourceCommit} from './release-utils.mjs';

const args=process.argv.slice(2);
if(args.some(a=>a!=='--release'))throw new Error('Usage: node scripts/build-hosted.mjs [--release]');
const publish=args.includes('--release');
const dist=path.resolve(repositoryRoot,process.env.PAWN_DIST_DIR||'dist');
const manifestPath=path.join(dist,'chess-release.json');
await mkdir(dist,{recursive:true});
// Failed or incomplete verification must never leave a publishable old manifest.
await rm(manifestPath,{force:true});
const commit=sourceCommit(process.env.GITHUB_SHA||execFileSync('git',['rev-parse','HEAD'],{cwd:repositoryRoot,encoding:'utf8'}).trim());
const packageInfo=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const modelBytes=await readFile(path.join(root,'assets/white-pawn.glb'));
const posterBytes=await readFile(path.join(root,'review/neutral.png'));
for(const [relative,bytes] of [['assets/white-pawn.glb',modelBytes],['review/neutral.png',posterBytes]]) {
  const committed=execFileSync('git',['show',`${commit}:prototypes/white-pawn/${relative}`],{cwd:repositoryRoot,maxBuffer:16*1024*1024});
  if(!bytes.equals(committed))throw new Error(`The immutable URL does not match local ${relative}; commit the asset before building`);
}
const config=makeHostedConfig({commit,version:packageInfo.version,modelBytes});
const html=await buildViewer({hostedConfig:config});
const document=validateCandidate({html,config,modelBytes});
const htmlPath=path.join(dist,document.path);
await mkdir(path.dirname(htmlPath),{recursive:true});
if(!publish) {
  await writeFile(htmlPath,html);
  await writeFile(path.join(dist,'chess-candidate.json'),JSON.stringify({config,document},null,2)+'\n');
  console.log(`Hosted candidate: ${document.bytes} bytes; ${document.path}. Run verify:hosted before release:hosted.`);
} else {
  const readJson=async p=>JSON.parse(await readFile(p,'utf8'));
  const release=makeRelease({html,config,modelBytes,
    standaloneHtml:await readFile(path.join(root,'white-pawn.html')),
    modelReport:await readJson(path.join(root,'assets/model-checks.json')),
    viewerReport:await readJson(path.join(root,'review/viewer-checks.json')),
    hostedReport:await readJson(path.join(dist,'review/hosted-checks.json'))});
  const verifiedHtml=await readFile(htmlPath);
  if(!verifiedHtml.equals(Buffer.from(html)))throw new Error('The candidate HTML changed after hosted verification');
  await writeFile(manifestPath+'.tmp',JSON.stringify(release,null,2)+'\n');
  await rename(manifestPath+'.tmp',manifestPath);
  console.log(`Verified hosted release ${release.version}: ${commit}`);
}
