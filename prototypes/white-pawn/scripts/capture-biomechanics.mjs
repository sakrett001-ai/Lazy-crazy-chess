import {chromium} from '../../human-base/node_modules/playwright/index.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const label=process.argv[2]||'after',mode=process.argv[3]||'full',out=path.join(root,'review','biomechanics-'+label);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']});
const context=await browser.newContext({viewport:{width:1100,height:1000},deviceScaleFactor:1});
context.setDefaultNavigationTimeout(180000);await context.setOffline(true);
const page=await context.newPage(),errors=[],records=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(pathToFileURL(path.join(root,'white-pawn.html')).href);
 await page.waitForFunction(()=>window.whitePawn?.ready||window.whitePawn?.fallback,{},{timeout:180000});
 if(!await page.evaluate(()=>whitePawn.ready))throw Error('WebGL did not start');
 const cases=label==='before'?[['sword',1.36,'side'],['greatsword',1.59,'spear']]:[
  ['sword',1.36,'weapon-side'],['sword',1.36,'spear'],['sword',2.47,'three','Shield_Brace'],['sword',2.47,'shield','Shield_Brace'],['sword',2.47,'shield-inside','Shield_Brace'],
  ['greatsword',1.59,'weapon-side'],['greatsword',1.59,'spear'],['greatsword',1.59,'grip-top'],['greatsword',1.59,'grip-under'],['pike',1.59,'weapon-side'],['pike',1.59,'spear'],['spear',1.9,'weapon-side'],
  ['sword',1.0,'three','Shield_Brace'],['greatsword',1.59,'weapon-side','Spear_Study','plate'],['spear',0,'three','rest','plate','lean']
 ];
 for(const [weapon,time,view,action='Spear_Study',armorType=weapon==='sword'?'plate':'mail',bodyBuild='regular']of cases.filter(c=>mode==='fingers'?c[0]==='greatsword'&&['grip-top','grip-under'].includes(c[2]):mode==='shield'?c[2]==='shield-inside':mode!=='grip'||c[2]==='shield-inside'||(c[0]==='greatsword'&&c[2]!=='weapon-side')||(c[0]==='pike'&&c[2]==='spear'))){
  const record=await page.evaluate(({weapon,time,view,action,armorType,bodyBuild})=>{
   whitePawn.appearance.set({weaponType:weapon,armorType,bodyBuild,shieldType:'round'});
   whitePawn.select(action);whitePawn.seek(time);whitePawn.fit(view==='weapon-side'?'side':view==='shield-inside'?'shield':view.startsWith('grip-')?'spear':view);
   if(view==='weapon-side'||view.startsWith('grip-')||view==='shield-inside'){
    const controls=whitePawn.debug.controls,camera=controls.object,offset=camera.position.clone().sub(controls.target);
    offset.x=-Math.abs(offset.x||offset.length());if(view==='grip-back')offset.z=-Math.abs(offset.z);
    if(view==='grip-top'||view==='grip-under'){
     const grips=whitePawn.loadout.measure().handGripWorld;controls.target.fromArray(grips.R).lerp(camera.position.clone().fromArray(grips.L),.35);
     offset.set(-1.2,view==='grip-top'?1.8:-1.3,1.1).normalize().multiplyScalar(.72);
    }
    if(view==='shield-inside'){
     controls.target.fromArray(whitePawn.loadout.measure().handGripWorld.L);
     offset.set(3,1,-.8).normalize().multiplyScalar(.70);
    }
    camera.position.copy(controls.target).add(offset);controls.update();
   }
   whitePawn.render();
   return{weapon,time,view,action,armorType,bodyBuild,measures:whitePawn.loadout.measure()};
  },{weapon,time,view,action,armorType,bodyBuild});
  const name=`${weapon}-${action}-${time}-${view}-${armorType}-${bodyBuild}`;
  await page.locator('#stage').screenshot({path:path.join(out,name+'.png'),timeout:120000});records.push({...record,image:name+'.png'});
  console.log('CAPTURE '+name);
 }
 const sha=createHash('sha256').update(await readFile(path.join(root,'white-pawn.html'))).digest('hex');
 await writeFile(path.join(out,'captures.json'),JSON.stringify({documentSha256:sha,errors,records},null,2)+'\n');
 if(errors.length)throw Error(errors.join('\n'));
}finally{await browser.close();}
