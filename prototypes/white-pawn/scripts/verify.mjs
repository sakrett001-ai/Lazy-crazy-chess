import {chromium} from '../../human-base/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const review=path.join(root,'review');await mkdir(review,{recursive:true});
const url=pathToFileURL(path.join(root,'white-pawn.html')).href;
const expected={Guard_Breath:6,Shield_Brace:4,Spear_Study:4};
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']});
const report={date:new Date().toISOString(),browser:browser.version(),tests:[],measurements:[],errors:[],network:[]};
const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});context.setDefaultNavigationTimeout(180000);await context.setOffline(true);
const page=await context.newPage();context.setDefaultNavigationTimeout(180000);
page.on('pageerror',e=>report.errors.push(e.message));
page.on('request',r=>{if(/^https?:/.test(r.url()))report.network.push(r.url());});
const shot=async name=>page.screenshot({path:path.join(review,`browser-${name}.png`),fullPage:true,timeout:180000});
try{
 const start=Date.now();await page.goto(url,{timeout:180000});await page.waitForFunction(()=>window.whitePawn?.ready,{},{timeout:180000});
 report.loadMs=Date.now()-start;report.initial=await page.evaluate(()=>whitePawn.state());
 assert.equal(report.initial.playing,false);assert.equal(report.initial.clips.length,3);
 for(const clip of report.initial.clips)assert(Math.abs(clip.duration-expected[clip.name])<1e-4,`duration ${clip.name}: ${clip.duration}`);
 assert.deepEqual(report.network,[]);report.tests.push('Offline load; expected clips and durations; no autoplay or HTTP requests');
 report.defaultPoseMaxError=await page.evaluate(()=>{const snapshot=()=>{whitePawn.debug.model.updateMatrixWorld(true);const a=[];whitePawn.debug.model.traverse(o=>a.push(...o.matrixWorld.elements));return a;};const neutral=snapshot();whitePawn.select('Guard_Breath');whitePawn.seek(0);const animated=snapshot();whitePawn.select('rest');return Math.max(...animated.map((v,i)=>Math.abs(v-neutral[i])));});
 assert(report.defaultPoseMaxError<1e-5,`default pose differs from Guard_Breath t=0: ${report.defaultPoseMaxError}`);report.tests.push('Default GLB pose matches equipped guard at Guard_Breath t=0');
 report.modelStructure=await page.evaluate(()=>{const info={meshes:0,skinnedMeshes:0,objects:0,materials:new Set(),vertices:0};whitePawn.debug.model.traverse(o=>{info.objects++;if(o.isMesh){info.meshes++;if(o.isSkinnedMesh)info.skinnedMeshes++;info.vertices+=o.geometry.attributes.position.count;(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>info.materials.add(m.uuid));}});return {...info,materials:info.materials.size};});
 await shot('desktop');
 for(const [name,duration] of Object.entries(expected)){
  await page.locator(`[data-pose="${name}"]`).click();assert.equal(await page.evaluate(()=>whitePawn.state().time),0);
  const precision=await page.evaluate(({duration})=>{
   const snap=()=>{whitePawn.debug.model.updateMatrixWorld(true);const a=[];whitePawn.debug.model.traverse(o=>a.push(...o.matrixWorld.elements));return a;};
   whitePawn.seek(0);const first=snap();whitePawn.seek(duration);const last=snap();
   whitePawn.seek(duration*.37);const forward=snap();whitePawn.seek(duration*.9);whitePawn.seek(duration*.37);const backward=snap();
   return {endpointMaxError:Math.max(...last.map((v,i)=>Math.abs(v-first[i]))),reverseSeekMaxError:Math.max(...backward.map((v,i)=>Math.abs(v-forward[i])))};
  },{duration});
  assert(precision.endpointMaxError<1e-5,`${name} endpoint error ${precision.endpointMaxError}`);
  assert(precision.reverseSeekMaxError<1e-6,`${name} seek drift ${precision.reverseSeekMaxError}`);
  for(const time of [0,duration*.25,duration*.5,duration*.75,duration]){
   const m=await page.evaluate(time=>{whitePawn.seek(time);return whitePawn.measure();},time);
   assert(m.finite,`${name} ${time}: nonfinite geometry`);report.measurements.push({clip:name,time,...m});
  }
  report.tests.push(`${name}: duration, matching endpoints, reverse seek, five finite complete-model-bound samples`);
  report.measurements.push({clip:name,...precision});
 }
 await page.evaluate(()=>whitePawn.select('rest'));
 for(const view of ['front','three','back','side','face','spear','shield']){
  const state=await page.evaluate(v=>{whitePawn.fit(v);return whitePawn.state();},view);assert(state.contained,`${view}: camera framing`);
  if(['front','three','back','spear','shield'].includes(view))await shot(view);
 }
 report.tests.push('Full figure views and close inspection bounds fit their cameras');
 await page.evaluate(()=>{whitePawn.select('Spear_Study');whitePawn.seek(1.6);whitePawn.fit('three');});await shot('spear-peak');
 await page.evaluate(()=>{whitePawn.select('Shield_Brace');whitePawn.seek(1.6);whitePawn.fit('shield');});await shot('shield-grip');
 await page.evaluate(()=>{whitePawn.select('Guard_Breath');whitePawn.fit('three');});
 await page.locator('#speed').selectOption('1.5');await page.locator('#play').click();
 await page.waitForFunction(()=>whitePawn.state().playing&&whitePawn.state().time>.7,{},{timeout:25000});
 await page.locator('#play').click();const paused=await page.evaluate(()=>whitePawn.state().time);
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await page.evaluate(()=>whitePawn.state().time),paused);assert.equal(await page.evaluate(()=>whitePawn.state().speed),1.5);
 await page.locator('#timeline').evaluate(e=>{e.value='2.15';e.dispatchEvent(new Event('input',{bubbles:true}));});assert(Math.abs(await page.evaluate(()=>whitePawn.state().time)-2.15)<1e-6);
 await page.locator('#stage').focus();const before=await page.evaluate(()=>whitePawn.debug.controls.object.position.toArray());await page.keyboard.press('ArrowLeft');assert.notDeepEqual(await page.evaluate(()=>whitePawn.debug.controls.object.position.toArray()),before);
 report.tests.push('Playback, pause, tempo, UI timeline and keyboard camera rotation');
 await page.locator('[data-display="wire"]').click();await page.locator('#skeleton').check();await shot('wire');await page.locator('[data-display="surface"]').click();await page.locator('#skeleton').uncheck();
 await page.evaluate(()=>{whitePawn.select('rest');whitePawn.fit('three');});
 report.performance=await page.evaluate(()=>{const gl=whitePawn.debug.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info'),pixel=new Uint8Array(4),times=[];for(let i=0;i<12;i++){const t=performance.now();whitePawn.render();gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);if(i>=2)times.push(performance.now()-t);}times.sort((a,b)=>a-b);return {renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),viewport:[innerWidth,innerHeight],drawCalls:whitePawn.state().renderCalls,triangles:whitePawn.state().triangles,p50ReadbackMs:times[Math.floor(times.length*.5)],p95ReadbackMs:times[Math.floor(times.length*.95)],note:'Headless Chromium with software rendering; synchronous render and readback, not sustained real-device FPS.'};});
 const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#download').click()]);assert.equal(download.suggestedFilename(),'lazy-crazy-chess-white-pawn.glb');report.tests.push('Embedded model download');
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>whitePawn.fit('three'));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.evaluate(()=>whitePawn.state().contained),true);await shot('mobile');
 await page.locator('[data-pose="Guard_Breath"]').click();await page.locator('#play').evaluate(e=>e.scrollIntoView({block:'center'}));await page.locator('#play').click();await page.waitForFunction(()=>whitePawn.state().playing&&whitePawn.state().time>.5,{},{timeout:25000});assert(await page.evaluate(()=>{const r=document.querySelector('#stage').getBoundingClientRect();return Math.min(innerHeight,r.bottom)-Math.max(0,r.top)>r.height*.4;}));await page.evaluate(()=>whitePawn.pause());report.tests.push('390 px without overflow; mobile Play returns to scene and advances');
 const reduced=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});await reduced.setOffline(true);const rp=await reduced.newPage();await rp.goto(url,{timeout:180000});await rp.waitForFunction(()=>window.whitePawn?.ready,{},{timeout:180000});assert.equal(await rp.evaluate(()=>whitePawn.state().reducedMotion),true);assert.equal(await rp.evaluate(()=>whitePawn.state().playing),false);await reduced.close();report.tests.push('Reduced motion starts still');
 const fallback=await browser.newContext({viewport:{width:390,height:844}});await fallback.setOffline(true);await fallback.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){if(/webgl/.test(type))return null;return original.call(this,type,...args);};});const fp=await fallback.newPage();await fp.goto(url,{timeout:180000});await fp.waitForFunction(()=>window.whitePawn?.fallback);assert(await fp.locator('#poster').isVisible());assert(await fp.locator('#fallback').isVisible());assert(await fp.locator('#download').isEnabled());await fp.screenshot({path:path.join(review,'browser-fallback.png'),fullPage:true,timeout:180000});await fallback.close();report.tests.push('WebGL fallback retains poster and model download');
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.network,[]);report.status='passed';
 report.glbSha256=createHash('sha256').update(await readFile(path.join(root,'assets/white-pawn.glb'))).digest('hex');
 report.documentSha256=createHash('sha256').update(await readFile(path.join(root,'white-pawn.html'))).digest('hex');
 report.scope='Viewer integrity and selected transforms. Does not prove full collision freedom, historical accuracy, muscle simulation, combat logic, or real-phone performance.';
 await writeFile(path.join(review,'viewer-checks.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({status:report.status,tests:report.tests,structure:report.modelStructure,performance:report.performance,loadMs:report.loadMs},null,2));
}catch(error){report.status='failed';report.failure=error.message;await writeFile(path.join(review,'viewer-checks.json'),JSON.stringify(report,null,2)+'\n');throw error;}
finally{await browser.close();}
