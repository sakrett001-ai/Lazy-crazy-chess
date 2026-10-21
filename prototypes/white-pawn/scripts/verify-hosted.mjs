import {chromium} from '../../human-base/node_modules/playwright/index.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import {root,repositoryRoot} from './build-helper.mjs';
import {validateCandidate,sha256} from './release-utils.mjs';

const dist=path.resolve(repositoryRoot,process.env.PAWN_DIST_DIR||'dist');
const review=path.join(dist,'review');await mkdir(review,{recursive:true});
const {config,document}=JSON.parse(await readFile(path.join(dist,'chess-candidate.json'),'utf8'));
const html=await readFile(path.join(dist,document.path));
const modelBytes=await readFile(path.join(root,'assets/white-pawn.glb'));
const posterBytes=await readFile(path.join(root,'review/neutral.png'));
assert.deepEqual(validateCandidate({html:html.toString('utf8'),config,modelBytes}),document);
const report={date:new Date().toISOString(),status:'running',sourceCommit:config.sourceCommit,documentSha256:sha256(html),glbSha256:sha256(modelBytes),tests:[],errors:[],unexpectedRequests:[],tamperedModelRejected:false};
const server=createServer((request,response)=>{
  if(request.url==='/viewer.html'){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(html);}
  else {response.writeHead(404);response.end('Not found');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']});
report.browser=browser.version();
async function contextFor(mode='normal') {
  const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});
  await context.route('**/*',async route=>{
    const url=route.request().url();
    if(url===origin+'/viewer.html')return route.continue();
    const headers={'access-control-allow-origin':'*'};
    if(url===config.posterUrl)return route.fulfill({status:200,contentType:'image/png',headers,body:posterBytes});
    if(url===config.modelUrl){
      if(mode==='unavailable')return route.fulfill({status:503,headers,body:'unavailable'});
      const body=Buffer.from(modelBytes);if(mode==='tampered')body[body.length-1]^=1;
      return route.fulfill({status:200,contentType:'model/gltf-binary',headers,body});
    }
    report.unexpectedRequests.push(url);return route.abort();
  });
  return context;
}
try {
  const normal=await contextFor();const page=await normal.newPage();
  page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto(origin+'/viewer.html');
  await page.waitForFunction(()=>window.whitePawn?.ready,{},{timeout:120000});
  const state=await page.evaluate(()=>whitePawn.state());
  assert.equal(state.playing,false);assert.equal(state.clips.length,3);
  assert.deepEqual(await page.evaluate(()=>window.PAWN_HOSTED),config);
  assert.equal(await page.locator('#model-data').textContent(),'');
  report.tests.push('Compact hosted document loads exact immutable GLB and poster; no embedded model or autoplay');
  await page.screenshot({path:path.join(review,'hosted-desktop.png'),fullPage:true});
  await page.evaluate(()=>{whitePawn.select('Guard_Breath');whitePawn.seek(1);});
  assert.equal(await page.evaluate(()=>whitePawn.state().time),1);
  await page.locator('#play').click();
  await page.waitForFunction(()=>whitePawn.state().playing&&whitePawn.state().time>1.2,{},{timeout:25000});
  await page.evaluate(()=>whitePawn.pause());
  assert.equal(await page.evaluate(()=>whitePawn.state().playing),false);
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#download').click()]);
  const downloadPath=await download.path();assert(downloadPath);
  assert.equal(sha256(await readFile(downloadPath)),config.modelSha256);
  report.tests.push('Hosted animation plays and pauses; downloaded GLB equals verified bytes');
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{whitePawn.select('rest');whitePawn.fit('three');});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await page.evaluate(()=>whitePawn.state().contained),true);
  await page.screenshot({path:path.join(review,'hosted-mobile.png'),fullPage:true});
  report.tests.push('390 px layout and camera framing');await normal.close();

  for(const mode of ['tampered','unavailable']) {
    const context=await contextFor(mode);const p=await context.newPage();
    await p.goto(origin+'/viewer.html');await p.waitForFunction(()=>window.whitePawn?.fallback,{},{timeout:30000});
    assert.equal(await p.evaluate(()=>whitePawn.ready),false);assert(await p.locator('#fallback').isVisible());
    assert(await p.locator('#download').isDisabled());
    if(mode==='tampered'){
      assert.match(await p.locator('#fallback').innerText(),/SHA-256/i);
      report.tamperedModelRejected=true;
    }
    report.tests.push(`${mode}: no ready model and no unchecked download; visible recovery message`);
    await context.close();
  }
  const fallback=await contextFor();
  await fallback.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){if(/webgl/.test(type))return null;return original.call(this,type,...args);};});
  const fp=await fallback.newPage();await fp.goto(origin+'/viewer.html');await fp.waitForFunction(()=>window.whitePawn?.fallback,{},{timeout:30000});
  assert(await fp.locator('#poster').isVisible());assert(await fp.locator('#download').isEnabled());
  report.tests.push('WebGL failure keeps the poster and verified model download');await fallback.close();
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.unexpectedRequests,[]);report.status='passed';
  console.log(JSON.stringify({status:report.status,sourceCommit:report.sourceCommit,tests:report.tests},null,2));
} catch(error) {report.status='failed';report.failure=error.message;throw error;}
finally {
  await writeFile(path.join(review,'hosted-checks.json'),JSON.stringify(report,null,2)+'\n');
  await browser.close();await new Promise(resolve=>server.close(resolve));
}
