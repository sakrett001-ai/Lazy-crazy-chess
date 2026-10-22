import {chromium} from '../../human-base/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const review=path.join(root,'review');
const url=pathToFileURL(path.join(root,'white-pawn.html')).href;
const storageKey='lazy-crazy-chess.appearance.v1';
const defaults={schemaVersion:2,armorFinish:'steel',shieldColor:'#eaeae5',accentColor:'#2c676f',weaponWood:'ash',weaponMetal:'steel',armorType:'plate',shieldType:'tower',weaponType:'spear',bodyBuild:'regular',experience:'recruit',skinTone:'medium',hairColor:'brown',beard:'none',helmet:'on'};
const sha256=value=>createHash('sha256').update(value).digest('hex');
const [modelBytes,documentBytes]=await Promise.all([readFile(path.join(root,'assets/white-pawn.glb')),readFile(path.join(root,'white-pawn.html'))]);
await mkdir(review,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']});
const report={date:new Date().toISOString(),browser:browser.version(),glbSha256:sha256(modelBytes),documentSha256:sha256(documentBytes),tests:[],errors:[],network:[]};
const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});
await context.setOffline(true);
context.setDefaultNavigationTimeout(180000);
const page=await context.newPage();
function observe(p){p.on('pageerror',error=>report.errors.push(error.message));p.on('request',request=>{if(/^https?:/.test(request.url()))report.network.push(request.url());});}
observe(page);
const ready=async p=>{await p.waitForFunction(()=>window.whitePawn?.ready||window.whitePawn?.fallback,{},{timeout:180000});assert(await p.evaluate(()=>!!whitePawn.ready&&!!whitePawn.appearance),await p.locator('#fallback').textContent());};
const get=()=>page.evaluate(()=>whitePawn.appearance.get());
const openPanel=async p=>{for(const selector of ['#appearance-panel','#loadout-panel','#fighter-panel','#finish-panel'])if(!await p.locator(selector).evaluate(e=>e.open))await p.locator(selector+' > summary').click();};
const materials=()=>page.evaluate(()=>{
 const result={};
 whitePawn.debug.model.traverse(object=>{if(!object.isMesh)return;for(const material of Array.isArray(object.material)?object.material:[object.material]){
  const slot=material.userData.customizationSlot||material.name;
  const values={color:material.color.toArray(),srgb:material.color.getHexString(),metalness:material.metalness,roughness:material.roughness};
  if(!result[slot])result[slot]=[];
  if(!result[slot].some(item=>JSON.stringify(item)===JSON.stringify(values)))result[slot].push(values);
 }});
 return result;
});
function onlyChanged(before,after,prefixes,label){
 assert.deepEqual(Object.keys(after).sort(),Object.keys(before).sort(),`${label}: material slot set changed`);
 const changed=Object.keys(before).filter(key=>JSON.stringify(before[key])!==JSON.stringify(after[key]));
 assert(changed.length>0,`${label}: no material changed`);
 assert(changed.every(key=>prefixes.some(prefix=>key.startsWith(prefix))),`${label}: changed unrelated slots: ${changed}`);
 return changed;
}
async function color(id,value){await page.locator(id).evaluate((input,value)=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));},value);}
async function importFile(contents,name='appearance.json'){
 await page.locator('#appearance-import').setInputFiles({name,mimeType:'application/json',buffer:Buffer.from(contents)});
 await page.waitForFunction(()=>document.querySelector('#appearance-import').value==='');
}
async function rejection(contents,message){
 const before=await get();await importFile(contents);
 assert.deepEqual(await get(),before,`${message}: current settings changed`);
 assert((await page.locator('#appearance-status').textContent()).trim(),`${message}: no visible feedback`);
}

try{
 await page.goto(url,{timeout:180000});await ready(page);
 assert.deepEqual(await get(),defaults);
 assert.equal(await page.locator('#appearance-panel').evaluate(e=>e.open),false,'Appearance panel should start collapsed');
 const initial=await materials();
 for(const slot of ['armor.main','armor.trim','shield.face','shield.trim','shield.emblem','weapon.metal','weapon.wood'])assert(initial[slot]?.length,`Missing material slot ${slot}`);
 for(const value of initial['armor.main']){assert(value.metalness>=.95);assert(value.roughness>=.2&&value.roughness<=.5);}
 for(const value of initial['shield.face']){assert.equal(value.metalness,0);assert.equal(value.srgb,'eaeae5');}
 report.defaultMaterials=Object.fromEntries(Object.entries(initial).filter(([name])=>/^(armor|shield|weapon)\./.test(name)));
 report.tests.push('Default armor is metallic steel; shield face remains white dielectric; appearance panel starts collapsed');
 await page.screenshot({path:path.join(review,'appearance-default.png'),fullPage:true,timeout:120000});
 await page.evaluate(()=>whitePawn.fit('back'));
 await page.screenshot({path:path.join(review,'appearance-steel-back.png'),fullPage:true,timeout:120000});
 await page.evaluate(()=>whitePawn.fit('three'));
 await openPanel(page);
 await page.locator('#armor-finish').selectOption('dark');
 const dark=await materials();
 report.armorChangedSlots=onlyChanged(initial,dark,['armor.','mail'],'armor finish');
 assert.equal((await get()).armorFinish,'dark');
 assert(dark['armor.main'][0].color.reduce((sum,n)=>sum+n,0)<initial['armor.main'][0].color.reduce((sum,n)=>sum+n,0),'Dark steel is not darker');
 await color('#shield-color','#cfd8e8');
 const painted=await materials();
 assert.deepEqual(onlyChanged(dark,painted,['shield.face'],'shield paint'),['shield.face']);
 assert.equal(painted['shield.face'][0].srgb,'cfd8e8');
 await color('#accent-color','#a4212c');
 const emblem=await materials();
 assert.deepEqual(onlyChanged(painted,emblem,['shield.emblem'],'shield stripe'),['shield.emblem']);
 await page.locator('#weapon-wood').selectOption('walnut');
 const walnut=await materials();
 assert.deepEqual(onlyChanged(emblem,walnut,['weapon.wood'],'spear shaft'),['weapon.wood']);
 await page.locator('#weapon-metal').selectOption('bronze');
 let bronze=await materials();
 assert.deepEqual(onlyChanged(walnut,bronze,['weapon.metal'],'spear point'),['weapon.metal']);
 report.tests.push('Armor, shield face, shield stripe, spear wood and spear metal controls change only their own material slots; crest, backing, leather and body remain unchanged');
 await page.locator('#armor-type').selectOption('mail');await page.locator('#shield-type').selectOption('round');await page.locator('#weapon-type').selectOption('sword');
 await page.locator('#body-build').selectOption('strong');await page.locator('#experience').selectOption('veteran');await page.locator('#skin-tone').selectOption('dark');await page.locator('#hair-color').selectOption('grey');await page.locator('#beard').selectOption('short');await page.locator('#helmet').selectOption('off');
 bronze=await materials();
 const customized=await get();
 assert.deepEqual(customized,{...defaults,armorFinish:'dark',shieldColor:'#cfd8e8',accentColor:'#a4212c',weaponWood:'walnut',weaponMetal:'bronze',armorType:'mail',shieldType:'round',weaponType:'sword',bodyBuild:'strong',experience:'veteran',skinTone:'dark',hairColor:'grey',beard:'short',helmet:'off'});
 await page.evaluate(()=>whitePawn.fit('back'));
 await page.screenshot({path:path.join(review,'appearance-custom.png'),fullPage:true,timeout:120000});
 const storage=await page.evaluate(key=>localStorage.getItem(key),storageKey);assert(storage,'Customization was not saved');
 await page.reload({timeout:180000});await ready(page);assert.deepEqual(await get(),customized);
 assert.deepEqual(await materials(),bronze,'Reload did not restore actual material values');
 report.tests.push('Appearance and actual shader material values survive a page reload');
 await openPanel(page);
 const [profileDownload]=await Promise.all([page.waitForEvent('download'),page.locator('#appearance-export').click()]);
 const profileBytes=await readFile(await profileDownload.path());
 const profile=JSON.parse(profileBytes.toString());
 assert.equal(profile.schema,'lazy-crazy-chess/appearance');assert.equal(profile.schemaVersion,2);assert.equal(profile.model,'white-pawn');
 assert.deepEqual(profile.appearance,customized);
 await page.locator('#appearance-reset').click();assert.deepEqual(await get(),defaults);
 assert.deepEqual(await materials(),initial,'Reset did not restore default materials');
 await importFile(profileBytes);assert.deepEqual(await get(),customized);assert.deepEqual(await materials(),bronze);
 report.tests.push('UI JSON export/import preserves all appearance fields and materials; Reset restores the default steel/white configuration');
 const legacyAppearance={schemaVersion:1,...Object.fromEntries(['armorFinish','shieldColor','accentColor','weaponWood','weaponMetal'].map(key=>[key,customized[key]]))};
 await importFile(JSON.stringify({schema:'lazy-crazy-chess/appearance',schemaVersion:1,model:'white-pawn',appearance:legacyAppearance}));
 const migrated={...defaults,...legacyAppearance,schemaVersion:2};assert.deepEqual(await get(),migrated);
 await page.evaluate(({key,value})=>localStorage.setItem(key,JSON.stringify(value)),{key:storageKey,value:legacyAppearance});await page.reload({timeout:180000});await ready(page);assert.deepEqual(await get(),migrated);
 await openPanel(page);await importFile(profileBytes);assert.deepEqual(await get(),customized);
 report.tests.push('Old schema1 JSON and the existing storage key migrate to schema2 while preserving finishes and applying default loadout/body settings');
 await rejection('{broken json','Malformed profile');
 await rejection(JSON.stringify({...profile,appearance:{...profile.appearance,armorFinish:'unknown'}}),'Unknown finish');
 await rejection(JSON.stringify({...profile,schemaVersion:999}),'Unsupported profile version');
 await rejection(' '.repeat(16*1024+1),'Oversized profile');
 const apiRejected=await page.evaluate(()=>{const before=JSON.stringify(whitePawn.appearance.get());try{whitePawn.appearance.set({armorFinish:'bronze',shieldColor:'not-a-color'});return false;}catch{return JSON.stringify(whitePawn.appearance.get())===before;}});
 assert(apiRejected,'Invalid partial API update was not rejected atomically');
 report.tests.push('Malformed, incompatible, invalid-enum and oversized JSON imports leave current appearance intact; invalid partial API update is atomic');
 await page.evaluate(()=>{whitePawn.select('Spear_Study');whitePawn.seek(1.6);whitePawn.fit('side');});
 const record=await page.evaluate(()=>whitePawn.exportReview());
 assert.deepEqual(record.state.appearance,customized,'Review omitted current appearance');
 await page.locator('#review-close').click();
 await page.evaluate(()=>whitePawn.appearance.reset());
 const restored=await page.evaluate(record=>whitePawn.restoreReview(record),record);
 assert.deepEqual(restored.state.appearance,customized);assert.deepEqual(await get(),customized);assert.deepEqual(await materials(),bronze);
 assert.equal(await page.evaluate(()=>whitePawn.state().pose),'Spear_Study');
 assert(Math.abs(await page.evaluate(()=>whitePawn.state().time)-1.6)<1e-6);
 await page.locator('#review-close').click();
 const legacy=JSON.parse(JSON.stringify(record));delete legacy.state.appearance;
 await page.evaluate(record=>whitePawn.restoreReview(record),legacy);assert.deepEqual(await get(),defaults);assert.deepEqual(await materials(),initial);
 await page.locator('#review-close').click();
 report.tests.push('Review records capture and restore appearance together with pose/time; old records without appearance restore documented defaults');
 await page.evaluate(value=>whitePawn.appearance.set(value),customized);
 const [modelDownload]=await Promise.all([page.waitForEvent('download'),page.locator('#download').click()]);
 assert.equal(sha256(await readFile(await modelDownload.path())),report.glbSha256,'Base-model download changed with appearance');
 const baseModelNote=page.locator('.appearance-file-note').filter({hasText:/^GLB/});
 assert(await baseModelNote.isVisible(),'Base-model download explanation is not visible');
 assert(/GLB.*все варианты/i.test(await baseModelNote.textContent()),'Catalog download is not distinguished from customization JSON');
 assert.notEqual(profileDownload.suggestedFilename(),modelDownload.suggestedFilename());
 report.tests.push('Catalog GLB download remains byte-identical after customization; UI explains the complete catalog and browser-only new weapon poses; selected loadout uses a separate JSON');
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>{whitePawn.select('rest');whitePawn.fit('three');});
 await openPanel(page);
 await page.locator('#appearance-panel').scrollIntoViewIfNeeded();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Mobile horizontal overflow');
 const labels=await page.locator('#appearance-panel').evaluate(panel=>[...panel.querySelectorAll('select,input')].filter(e=>e.type!=='file').map(e=>({id:e.id,labels:e.labels?.length||0,height:e.getBoundingClientRect().height})));
 assert(labels.length>=15);assert(labels.every(e=>e.labels>0),`Unlabelled mobile controls: ${JSON.stringify(labels)}`);
 assert(labels.every(e=>e.height>=44),`Small mobile control targets: ${JSON.stringify(labels)}`);
 await page.screenshot({path:path.join(review,'appearance-mobile.png'),fullPage:true,timeout:120000});
 report.tests.push('390 px layout has no horizontal overflow; customization controls have labels and usable touch targets');
 const corruptContext=await browser.newContext({viewport:{width:390,height:844}});await corruptContext.setOffline(true);
 await corruptContext.addInitScript(key=>localStorage.setItem(key,'{invalid'),storageKey);
 const corruptPage=await corruptContext.newPage();observe(corruptPage);await corruptPage.goto(url,{timeout:180000});await ready(corruptPage);
 assert.deepEqual(await corruptPage.evaluate(()=>whitePawn.appearance.get()),defaults);
 assert((await corruptPage.locator('#appearance-status').textContent()).trim(),'Corrupt storage has no feedback');
 await corruptContext.close();
 const deniedContext=await browser.newContext({viewport:{width:390,height:844}});await deniedContext.setOffline(true);
 await deniedContext.addInitScript(()=>{for(const name of ['getItem','setItem','removeItem'])Storage.prototype[name]=()=>{throw new DOMException('Storage unavailable','SecurityError');};});
 const deniedPage=await deniedContext.newPage();observe(deniedPage);await deniedPage.goto(url,{timeout:180000});await ready(deniedPage);await openPanel(deniedPage);
 await deniedPage.locator('#armor-finish').selectOption('bronze');assert.equal(await deniedPage.evaluate(()=>whitePawn.appearance.get().armorFinish),'bronze');
 const deniedStatus=await deniedPage.locator('#appearance-status').textContent();assert(/не|недоступ|скача/i.test(deniedStatus),'Unavailable persistence is not explained');
 const [deniedExport]=await Promise.all([deniedPage.waitForEvent('download'),deniedPage.locator('#appearance-export').click()]);
 assert.equal(JSON.parse((await readFile(await deniedExport.path())).toString()).appearance.armorFinish,'bronze');
 await deniedContext.close();
 report.tests.push('Corrupt browser storage falls back to defaults with feedback; unavailable storage still allows editing and JSON export with an explicit persistence warning');
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.network,[]);
 assert.equal(sha256(await readFile(path.join(root,'assets/white-pawn.glb'))),report.glbSha256,'Model changed during appearance verification');
 assert.equal(sha256(await readFile(path.join(root,'white-pawn.html'))),report.documentSha256,'Document changed during appearance verification');
 report.status='passed';report.scope='Appearance material isolation, persistence, profile validation, review reproducibility and mobile controls in software Chromium. Includes schema1 migration and independent equipment/body/experience persistence; no real-device performance claim.';
 await writeFile(path.join(review,'appearance-checks.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({status:report.status,tests:report.tests,glbSha256:report.glbSha256,documentSha256:report.documentSha256},null,2));
}catch(error){
 report.status='failed';report.failure=error.message;
 await writeFile(path.join(review,'appearance-checks.json'),JSON.stringify(report,null,2)+'\n');throw error;
}finally{await browser.close();}
