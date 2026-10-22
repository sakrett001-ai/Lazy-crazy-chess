import {chromium} from '../../human-base/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),review=path.join(root,'review');
const hash=x=>createHash('sha256').update(x).digest('hex');
const [glb,html]=await Promise.all([readFile(path.join(root,'assets/white-pawn.glb')),readFile(path.join(root,'white-pawn.html'))]);
await mkdir(review,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']});
const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});
context.setDefaultNavigationTimeout(180000);await context.setOffline(true);
const page=await context.newPage();
const report={date:new Date().toISOString(),status:'running',browser:browser.version(),glbSha256:hash(glb),documentSha256:hash(html),tests:[],scenes:[],errors:[],network:[]};
page.on('pageerror',e=>report.errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))report.network.push(r.url());});
const shot=async name=>{await page.screenshot({path:path.join(review,'variants-'+name+'.png'),fullPage:true,timeout:120000});console.log('VARIANT_SCENE '+name);};
const set=async settings=>page.evaluate(settings=>{whitePawn.appearance.set(settings);whitePawn.select('rest');whitePawn.fit('three');},settings);
const scene=()=>page.evaluate(()=>{
 const meshes=[];
 const inherited=(o,key)=>{for(let p=o;p;p=p.parent)if(p.userData?.[key]!==undefined)return p.userData[key];return null;};
 const visible=o=>{for(let p=o;p;p=p.parent)if(!p.visible)return false;return true;};
 whitePawn.debug.model.traverse(o=>{if(!o.isMesh||!visible(o))return;
  const materials=(Array.isArray(o.material)?o.material:[o.material]).map(m=>{const channel=m.normalMap?.channel||0,uv=o.geometry.attributes[channel?'uv'+channel:'uv'];let minU=Infinity,maxU=-Infinity,minV=Infinity,maxV=-Infinity;
   if(uv)for(let i=0;i<uv.count;i++){minU=Math.min(minU,uv.getX(i));maxU=Math.max(maxU,uv.getX(i));minV=Math.min(minV,uv.getY(i));maxV=Math.max(maxV,uv.getY(i));}
   return {slot:m.userData.customizationSlot||m.name,metalness:m.metalness,roughness:m.roughness,normalMap:!!m.normalMap,uvChannel:channel,uvSpan:uv?[maxU-minU,maxV-minV]:null};});
  const positions=o.geometry.attributes.position;let checksum=0;for(let i=0;i<positions.count;i+=17)checksum+=positions.getX(i)*.31+positions.getY(i)*.17+positions.getZ(i)*.23;
  meshes.push({name:o.name,slot:inherited(o,'equipmentSlot'),variant:inherited(o,'equipmentVariant'),vertices:positions.count,checksum,materials,morphs:Object.fromEntries(Object.entries(o.morphTargetDictionary||{}).map(([k,i])=>[k,o.morphTargetInfluences[i]]))});
 });
 return {appearance:whitePawn.appearance.get(),loadout:whitePawn.loadout.summary(),state:whitePawn.state(),meshes};
});
const has=(s,slot,variant)=>s.meshes.some(m=>m.slot===slot&&(variant===undefined||m.variant===variant));
const footSnapshot=()=>page.evaluate(()=>{whitePawn.debug.model.updateMatrixWorld(true);return Object.fromEntries(Object.entries(whitePawn.debug.bones).filter(([n])=>/^foot[LR]$/i.test(n.replace(/[._\-\s]/g,''))).map(([n,b])=>[n,b.matrixWorld.elements.slice(12,15)]));});
const difference=(a,b)=>Math.max(...Object.keys(a).flatMap(k=>a[k].map((n,i)=>Math.abs(n-b[k][i]))));
try{
 await page.goto(pathToFileURL(path.join(root,'white-pawn.html')).href);
 await page.waitForFunction(()=>window.whitePawn?.ready||window.whitePawn?.fallback,{},{timeout:180000});
 assert(await page.evaluate(()=>!!whitePawn.ready&&!!whitePawn.loadout),await page.locator('#fallback').textContent());
 let s=await scene();assert(has(s,'plate'));assert(has(s,'shield','tower'));assert(has(s,'weapon','spear'));assert(!has(s,'mail'));
 report.scenes.push({name:'default',...s});await shot('default');
 const shieldSignatures=[];
 for(const type of ['tower','round','heater']){await set({shieldType:type});s=await scene();assert(has(s,'shield',type),type+' is missing');assert(s.meshes.filter(m=>m.slot==='shield').every(m=>m.variant===type),'Extra shield rendered');shieldSignatures.push(JSON.stringify(s.meshes.filter(m=>m.slot==='shield').map(m=>[m.vertices,m.checksum])));}
 assert.equal(new Set(shieldSignatures).size,3,'Shield variants use identical geometry');
 await set({armorType:'mail',shieldType:'round',weaponType:'sword'});s=await scene();assert(has(s,'mail'));assert(has(s,'padding'));assert(!has(s,'plate'));assert(has(s,'weapon','sword'));assert(has(s,'shield','round'));
 const mail=s.meshes.filter(m=>m.slot==='mail').flatMap(m=>m.materials).filter(m=>m.slot==='mail');assert(mail.length,'No actual mail material visible');
 assert(mail.every(m=>m.metalness>.9&&m.roughness>=.5&&m.normalMap&&m.uvSpan?.some(n=>n>1)),'Mail requires metallic roughness and normal map using nontrivial UVs');
 report.scenes.push({name:'mail-sword',...s});await shot('mail-sword');
 await page.evaluate(()=>whitePawn.fit('back'));await shot('mail-back');
 await set({armorType:'padded',shieldType:'none',weaponType:'sword',helmet:'off',bodyBuild:'lean'});s=await scene();assert(has(s,'padding'));assert(!has(s,'plate'));assert(!has(s,'mail'));assert(!has(s,'shield'));assert(!has(s,'helmet'));assert(has(s,'hair'));
 const padding=s.meshes.filter(m=>m.slot==='padding').flatMap(m=>m.materials).filter(m=>m.slot==='padding');assert(padding.length);assert(padding.every(m=>m.metalness===0&&m.roughness>.8&&m.normalMap&&m.uvSpan?.some(n=>n>1)),'Padding requires matte quilt normal map using real UVs');
 await shot('padded-lean');
 const morphology=await page.evaluate(()=>{
  const meshes=[];whitePawn.debug.model.traverse(o=>{if(o.isSkinnedMesh&&o.morphTargetDictionary?.strong!==undefined)meshes.push(o);});
  if(!meshes.length)return {meshes:0,maxDelta:0};
  const capture=()=>{whitePawn.debug.model.updateMatrixWorld(true);return meshes.map(m=>{m.skeleton.update();const p=m.position.clone(),a=[];for(let i=0;i<m.geometry.attributes.position.count;i+=13){m.getVertexPosition(i,p);a.push(p.x,p.y,p.z);}return a;});};
  whitePawn.appearance.set({bodyBuild:'lean'});const lean=capture();whitePawn.appearance.set({bodyBuild:'strong'});const strong=capture();
  let maxDelta=0;for(let m=0;m<lean.length;m++)for(let i=0;i<lean[m].length;i+=3)maxDelta=Math.max(maxDelta,Math.hypot(...strong[m].slice(i,i+3).map((n,k)=>n-lean[m][i+k])));
  return {meshes:meshes.length,maxDelta};
 });
 assert(morphology.meshes>=2&&morphology.maxDelta>.005,'Physique must displace actual body/clothing vertices');report.morphology=morphology;
 await page.evaluate(()=>whitePawn.fit('three'));await shot('padded-strong');
 await set({bodyBuild:'strong',experience:'veteran',beard:'short',hairColor:'grey',helmet:'off'});s=await scene();assert.equal(s.appearance.bodyBuild,'strong');assert.equal(s.appearance.experience,'veteran');assert(has(s,'beard','short'));await page.evaluate(()=>whitePawn.fit('face'));await shot('veteran');
 await page.evaluate(()=>whitePawn.appearance.set({experience:'recruit'}));assert.equal((await scene()).appearance.bodyBuild,'strong','Experience overwrote physique');
 await page.evaluate(()=>whitePawn.appearance.set({bodyBuild:'lean'}));assert.equal((await scene()).appearance.experience,'recruit','Physique overwrote experience');
 report.tests.push('Three genuinely different shields; independent plate/mail/padding geometry; visible textured mail and quilting; actual physique displacement and independent experience');
 for(const weapon of ['spear','sword','pike','greatsword']){
  await set({armorType:'plate',bodyBuild:'regular',experience:'recruit',beard:'none',helmet:'on',weaponType:weapon,shieldType:'heater'});s=await scene();
  assert(has(s,'weapon',weapon));assert(s.meshes.filter(m=>m.slot==='weapon').every(m=>m.variant===weapon),'Extra weapon rendered');
  const twoHanded=['pike','greatsword'].includes(weapon);assert.equal(has(s,'shield'),!twoHanded);assert.equal(s.appearance.shieldType,'heater','Shield preference lost');
  assert.equal(await page.locator('[data-pose="Shield_Brace"]').isDisabled(),twoHanded);
  const feet=await footSnapshot();assert.equal(Object.keys(feet).length,2);
  const thrust=await page.evaluate(()=>{whitePawn.select('Spear_Study');whitePawn.seek(1.25);const before=whitePawn.loadout.measure();whitePawn.seek(1.9);const after=whitePawn.loadout.measure();return {before,after,advance:after.tip.reduce((sum,value,i)=>sum+(value-before.tip[i])*after.axis[i],0)};});
  assert(thrust.advance>.025,weapon+' point did not advance along its axis');
  assert(thrust.after.axis[2]>.8,weapon+' point did not face forward');
  assert(thrust.after.rightGripErrorM<.015,weapon+' right grip lost');if(twoHanded)assert(thrust.after.leftGripErrorM<.015,weapon+' left grip lost');
  await page.evaluate(()=>whitePawn.seek(1.6));
  assert(difference(feet,await footSnapshot())<.012,weapon+' feet moved out of their planted support');
  const deterministic=await page.evaluate(()=>{const snapshot=()=>{whitePawn.debug.model.updateMatrixWorld(true);const a=[];whitePawn.debug.model.traverse(o=>a.push(...o.matrixWorld.elements));return a;};const first=snapshot();whitePawn.seek(.3);whitePawn.seek(3.7);whitePawn.seek(1.6);const second=snapshot();return Math.max(...first.map((v,i)=>Math.abs(v-second[i])));});
  assert(deterministic<1e-6,weapon+' reverse seek drift');
  assert((await page.evaluate(()=>whitePawn.measure())).finite,weapon+' nonfinite geometry');
  report.scenes.push({name:weapon+'-thrust',...await scene(),reverseSeekError:deterministic,feetDelta:difference(feet,await footSnapshot()),runtimeMeasures:await page.evaluate(()=>whitePawn.loadout.measure()),thrustAdvanceM:thrust.advance});
  await page.evaluate(()=>whitePawn.fit('side'));await shot(weapon+'-thrust');
 }
 await set({weaponType:'sword',shieldType:'heater'});assert(has(await scene(),'shield','heater'),'Returning onehand weapon did not restore shield');
 for(const patch of [{weaponType:'pike'},{weaponType:'greatsword'},{shieldType:'none'}]){
  await set({weaponType:'spear',shieldType:'tower'});await page.evaluate(()=>{whitePawn.select('Shield_Brace');whitePawn.seek(1.6);whitePawn.fit('shield');});
  await page.evaluate(patch=>whitePawn.appearance.set(patch),patch);const state=await page.evaluate(()=>whitePawn.state());
  assert.equal(state.pose,'rest');assert.equal(state.view,'three');assert(await page.locator('[data-view="shield"]').isDisabled());assert(await page.locator('[data-pose="Shield_Brace"]').isDisabled());
 }
 await set({weaponType:'spear',shieldType:'tower'});await page.evaluate(()=>{whitePawn.select('Shield_Brace');whitePawn.seek(1.6);});
 const reviewRecord=await page.evaluate(()=>whitePawn.exportReview());await page.locator('#review-close').click();
 const invalid=structuredClone(reviewRecord);invalid.state.appearance.weaponType='pike';
 const atomic=await page.evaluate(record=>{const before=JSON.stringify({appearance:whitePawn.appearance.get(),state:whitePawn.state()});try{whitePawn.restoreReview(record);return false;}catch{return before===JSON.stringify({appearance:whitePawn.appearance.get(),state:whitePawn.state()});}},invalid);
 assert(atomic,'Incompatible review changed the current scene before rejection');
 report.tests.push('Four visible weapon geometries, deterministic reverse seek and planted feet; twohand weapons suppress shield and brace; singlehand restores choice; invalid review is atomic');
 await set({weaponType:'greatsword',armorType:'mail',bodyBuild:'strong'});await page.setViewportSize({width:390,height:844});await page.evaluate(()=>whitePawn.fit('three'));
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert(await page.evaluate(()=>whitePawn.state().contained));await shot('mobile');
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.network,[]);
 assert.equal(hash(await readFile(path.join(root,'assets/white-pawn.glb'))),report.glbSha256);assert.equal(hash(await readFile(path.join(root,'white-pawn.html'))),report.documentSha256);
 report.status='passed';report.scope='Actual visible equipment meshes and PBR/UV assignment, sampled morphed vertex displacement, deterministic sampled poses and foot support, review/profile compatibility, 390px software browser. Full collision freedom and real-phone performance are not asserted.';
 console.log(JSON.stringify({status:report.status,tests:report.tests,glbSha256:report.glbSha256,documentSha256:report.documentSha256}));
}catch(error){report.status='failed';report.failure=error.message;try{await page.screenshot({path:path.join(review,'variants-failure.png'),fullPage:true,timeout:120000});}catch{}throw error;}
finally{await writeFile(path.join(review,'variant-checks.json'),JSON.stringify(report,null,2)+'\n');await browser.close();}
