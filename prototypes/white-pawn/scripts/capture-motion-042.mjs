import {chromium} from '../../human-base/node_modules/playwright/index.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

// Capture the actual application with a fixed camera through preparation,
// extension and recovery. This is visual evidence, not a realism score.
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out=path.join(root,'review','motion-042');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']});
const context=await browser.newContext({viewport:{width:1100,height:1000},deviceScaleFactor:1});
context.setDefaultNavigationTimeout(180000);await context.setOffline(true);
const page=await context.newPage(),errors=[],records=[];
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(pathToFileURL(path.join(root,'white-pawn.html')).href);
 await page.waitForFunction(()=>window.whitePawn?.ready||window.whitePawn?.fallback,{},{timeout:180000});
 if(!await page.evaluate(()=>whitePawn.ready))throw Error('WebGL did not start');
 for(const [weapon,view]of [['greatsword','side'],['greatsword','three'],['pike','side'],['sword','side'],['spear','side']]){
  await page.evaluate(({weapon,view})=>{
   whitePawn.appearance.set({weaponType:weapon,armorType:'plate',bodyBuild:'regular',shieldType:'round',beard:'none',skinTone:'medium',experience:'recruit'});
   whitePawn.select('Spear_Study');whitePawn.seek(1.25);whitePawn.fit(view);
   if(view==='side'){
    const c=whitePawn.debug.controls,offset=c.object.position.clone().sub(c.target);
    offset.x=-Math.abs(offset.x);c.object.position.copy(c.target).add(offset);c.update();
   }
  },{weapon,view});
  for(const [phase,time]of [['ready',1.25],['extended',1.9],['recovered',2.8]]){
   const record=await page.evaluate(time=>{
    whitePawn.seek(time);whitePawn.render();
    return{identity:whitePawn.identity,measurements:whitePawn.loadout.measure(),state:whitePawn.state()};
   },time);
   const name=`${weapon}-${view}-${phase}.png`;
   await page.locator('#stage').screenshot({path:path.join(out,name),timeout:120000});
   records.push({weapon,view,phase,time,image:name,...record});
   console.log('CAPTURE '+name);
  }
 }
 for(const [name,beard,skinTone,hairColor,experience,side]of [
  ['beard-front','short','light','brown','recruit',false],
  ['beard-side','short','light','brown','recruit',true],
  ['beard-dark-veteran','short','dark','grey','veteran',false],
  ['stubble-front','stubble','medium','black','recruit',false]
 ]){
  const record=await page.evaluate(({beard,skinTone,hairColor,experience,side})=>{
   whitePawn.appearance.set({beard,skinTone,hairColor,experience,helmet:'off'});
   whitePawn.select('rest');whitePawn.seek(0);whitePawn.fit('helmet');
   if(side){const c=whitePawn.debug.controls,d=c.object.position.distanceTo(c.target);c.object.position.copy(c.target).add(c.target.clone().set(-d,.05*d,.12*d));c.update();}
   whitePawn.render();return{identity:whitePawn.identity,state:whitePawn.state()};
  },{beard,skinTone,hairColor,experience,side});
  await page.locator('#stage').screenshot({path:path.join(out,name+'.png'),timeout:120000});
  records.push({image:name+'.png',beard,skinTone,hairColor,experience,...record});
  console.log('CAPTURE '+name);
 }
 const sha=createHash('sha256').update(await readFile(path.join(root,'white-pawn.html'))).digest('hex');
 await writeFile(path.join(out,'captures.json'),JSON.stringify({documentSha256:sha,errors,records},null,2)+'\n');
 if(errors.length)throw Error(errors.join('\n'));
}finally{await browser.close();}
