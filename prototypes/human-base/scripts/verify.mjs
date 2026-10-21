import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']});
const report={date:new Date().toISOString(),browser:browser.version(),tests:[],measurements:[]};
const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});
await context.setOffline(true);
const page=await context.newPage(),errors=[],network=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});
const url=pathToFileURL(path.join(root,'human-base.html')).href;
try{
 const loaded=Date.now();await page.goto(url);await page.waitForFunction(()=>window.humanBase?.ready,{},{timeout:90000});
 report.loadMs=Date.now()-loaded;report.initial=await page.evaluate(()=>humanBase.state());
 assert.equal(report.initial.bones,163);assert.equal(report.initial.clips.length,3);assert(report.initial.clips.every(c=>Math.abs(c.duration-3)<1e-5));assert.equal(report.initial.playing,false);
 assert.deepEqual(network,[]);report.tests.push('offline load; no HTTP requests; expected skeleton and clips');
 await page.screenshot({path:path.join(root,'review/browser-desktop.png'),fullPage:true});
 for(const name of ['Elbow_Flex','Ready_Study','Hand_Close']){
  await page.locator(`[data-pose="${name}"]`).click();
  for(const t of [0,.5,1.4,2.5,3,0]){
   const result=await page.evaluate(({name,t})=>{humanBase.seek(t);return {name,t,...humanBase.measure()};},{name,t});
   assert(result.finite);assert(Math.abs(result.minY)<.004,`${name} floor contact ${result.minY}`);assert(result.height>1.75&&result.height<1.83);report.measurements.push(result);
  }
  const deterministic=await page.evaluate(()=>{const snapshot=()=>Object.values(humanBase.debug.bones).flatMap(b=>b.quaternion.toArray());humanBase.seek(.72);const a=snapshot();humanBase.seek(3);humanBase.seek(.72);return Math.max(...snapshot().map((v,i)=>Math.abs(v-a[i])));});
  assert(deterministic<1e-7,`reverse seek ${name}: ${deterministic}`);
  await page.evaluate(()=>humanBase.seek(1.4));await page.screenshot({path:path.join(root,`review/browser-${name}.png`),fullPage:true});
 }
 report.tests.push('18 pose samples finite; feet within 4 mm of floor; repeat/reverse seek stable');
 await page.locator('[data-pose="rest"]').click();
 for(const view of ['front','side','back','three','top','bottom','face']){
  const state=await page.evaluate(v=>{humanBase.fit(v);return humanBase.state();},view);assert(state.contained,`${view} framing`);
  await page.screenshot({path:path.join(root,`review/browser-${view}.png`),fullPage:true});
 }
 await page.locator('#home').click();
 await page.locator('[data-display="wire"]').click();await page.locator('#skeleton').check();await page.screenshot({path:path.join(root,'review/browser-wire.png'),fullPage:true});
 await page.locator('[data-display="surface"]').click();await page.locator('#skeleton').uncheck();
 await page.locator('[data-pose="Elbow_Flex"]').click();await page.locator('#speed').selectOption('1.5');
 await page.locator('#play').click();await page.waitForFunction(()=>humanBase.state().time>1.5,{},{timeout:15000});
 await page.locator('#play').click();const paused=await page.evaluate(()=>humanBase.state().time);
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await page.evaluate(()=>humanBase.state().time),paused);
 assert.equal(await page.evaluate(()=>humanBase.state().speed),1.5);report.tests.push('play, pause and tempo control');
 // Keyboard and pointer input must change the view and pause playback.
 await page.locator('#stage').focus();const before=await page.evaluate(()=>humanBase.debug.controls.object.position.toArray());await page.keyboard.press('ArrowLeft');
 assert.notDeepEqual(await page.evaluate(()=>humanBase.debug.controls.object.position.toArray()),before);
 await page.locator('#play').click();const box=await page.locator('#stage').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+70,box.y+box.height/2+15,{steps:5});await page.mouse.up();assert.equal(await page.evaluate(()=>humanBase.state().playing),false);
 report.tests.push('keyboard rotation and pointer interruption');
 await page.evaluate(()=>humanBase.select('rest'));await page.locator('#home').click();
 report.performance=await page.evaluate(()=>{const gl=humanBase.debug.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info'),pixel=new Uint8Array(4),times=[];for(let i=0;i<25;i++){const t=performance.now();humanBase.render();gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);if(i>=3)times.push(performance.now()-t);}times.sort((a,b)=>a-b);return {renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),viewport:[innerWidth,innerHeight],p50ReadbackMs:times[Math.floor(times.length*.5)],p95ReadbackMs:times[Math.floor(times.length*.95)],note:'Synchronous render + readback in headless Chromium; not sustained phone FPS.'};});
 const download=await Promise.all([page.waitForEvent('download'),page.locator('#download').click()]);
 assert.equal(download[0].suggestedFilename(),'lazy-crazy-chess-human-base.glb');
 report.tests.push('embedded GLB download');
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>humanBase.fit('three'));
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.equal(await page.evaluate(()=>humanBase.state().contained),true);
 await page.screenshot({path:path.join(root,'review/browser-mobile.png'),fullPage:true});
 report.tests.push('390px viewport, no horizontal overflow, full model framing');
 await page.locator('[data-pose="Elbow_Flex"]').click();await page.locator('#play').evaluate(e=>e.scrollIntoView({block:'center'}));
 await page.locator('#play').click();await page.waitForFunction(()=>humanBase.state().playing&&humanBase.state().time>1.5,{},{timeout:15000});
 assert(await page.evaluate(()=>{const r=document.querySelector('#stage').getBoundingClientRect();return Math.min(innerHeight,r.bottom)-Math.max(0,r.top)>r.height*.4;}));
 await page.evaluate(()=>humanBase.pause());report.tests.push('mobile offscreen Play returns to model and advances time');
 const reduced=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});await reduced.setOffline(true);
 const rp=await reduced.newPage();await rp.goto(url);await rp.waitForFunction(()=>window.humanBase?.ready,{},{timeout:90000});
 assert.equal(await rp.evaluate(()=>humanBase.state().reducedMotion),true);assert.equal(await rp.evaluate(()=>humanBase.state().playing),false);await reduced.close();report.tests.push('reduced motion starts still');
 const fallback=await browser.newContext({viewport:{width:390,height:844}});await fallback.setOffline(true);
 await fallback.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){if(/webgl/.test(type))return null;return original.call(this,type,...args);};});
 const fp=await fallback.newPage();await fp.goto(url);await fp.waitForFunction(()=>window.humanBase?.fallback);
 assert(await fp.locator('#poster').isVisible());assert(await fp.locator('#fallback').isVisible());assert(await fp.locator('#download').isEnabled());await fp.screenshot({path:path.join(root,'review/browser-fallback.png'),fullPage:true});await fallback.close();report.tests.push('WebGL failure shows poster and retains download');
 assert.deepEqual(errors,[]);report.errors=errors;report.status='passed';
 report.model=JSON.parse(await readFile(path.join(root,'assets/model-info.json'),'utf8'));
 await writeFile(path.join(root,'review/viewer-checks.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({status:report.status,tests:report.tests,performance:report.performance,loadMs:report.loadMs},null,2));
}finally{await browser.close();}
