// Appearance changes material parameters only. Geometry and attachments stay fixed.
export const APPEARANCE_KEY='lazy-crazy-chess.appearance.v1';
export const DEFAULT_APPEARANCE=Object.freeze({schemaVersion:1,armorFinish:'steel',shieldColor:'#eaeae5',accentColor:'#2c676f',weaponWood:'ash',weaponMetal:'steel'});
const PROFILE_SCHEMA='lazy-crazy-chess/appearance',MAX_PROFILE_BYTES=16*1024;
const ARMOR={
 steel:{label:'Сталь',main:[.50,.54,.58],trim:[.60,.64,.67],roughness:.32,trimRoughness:.24},
 brushed:{label:'Матовая сталь',main:[.40,.44,.47],trim:[.51,.55,.58],roughness:.52,trimRoughness:.38},
 dark:{label:'Воронёная сталь',main:[.075,.095,.12],trim:[.17,.20,.24],roughness:.32,trimRoughness:.26},
 bronze:{label:'Бронза',main:[.49,.28,.095],trim:[.62,.38,.14],roughness:.34,trimRoughness:.25}
};
const WOOD={ash:[.24,.135,.061],walnut:[.105,.044,.018],ebony:[.021,.014,.010]};
const METAL={steel:[.50,.57,.62],dark:[.10,.13,.16],bronze:[.49,.28,.095]};
export function validAppearance(value){
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===Object.keys(DEFAULT_APPEARANCE).length&&Object.keys(DEFAULT_APPEARANCE).every(k=>Object.hasOwn(value,k))&&value.schemaVersion===1&&Object.hasOwn(ARMOR,value.armorFinish)&&Object.hasOwn(WOOD,value.weaponWood)&&Object.hasOwn(METAL,value.weaponMetal)&&[value.shieldColor,value.accentColor].every(c=>typeof c==='string'&&/^#[a-f0-9]{6}$/i.test(c));
}
function checked(value){
 if(!validAppearance(value))throw Error('Неверные настройки снаряжения. Загрузите профиль, сохранённый в этой мастерской.');
 return {schemaVersion:1,armorFinish:value.armorFinish,shieldColor:value.shieldColor.toLowerCase(),accentColor:value.accentColor.toLowerCase(),weaponWood:value.weaponWood,weaponMetal:value.weaponMetal};
}
export function installAppearance({model,render,beforeChange=()=>{}}){
 const $=s=>document.querySelector(s),status=$('#appearance-status');
 const controls={armorFinish:$('#armor-finish'),shieldColor:$('#shield-color'),accentColor:$('#accent-color'),weaponWood:$('#weapon-wood'),weaponMetal:$('#weapon-metal')};
 const slots=new Map();
 model.traverse(o=>{if(!o.isMesh)return;(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>{const key=m.userData?.customizationSlot||m.name;if(!slots.has(key))slots.set(key,new Set());slots.get(key).add(m);});});
 for(const name of ['armor.main','armor.trim','shield.face','shield.emblem','weapon.metal','weapon.wood'])if(!slots.has(name))throw Error('В модели отсутствует материал снаряжения: '+name);
 let current={...DEFAULT_APPEARANCE},storageWarning='';
 try{const saved=localStorage.getItem(APPEARANCE_KEY);if(saved)current=checked(JSON.parse(saved));}
 catch{storageWarning='Сохранённый профиль недоступен или повреждён. Загружен стандартный вид.';}
 function paint(name,color,metalness,roughness){for(const material of slots.get(name)||[]){Array.isArray(color)?material.color.setRGB(...color):material.color.set(color);material.metalness=metalness;material.roughness=roughness;}}
 function apply(){
  const armor=ARMOR[current.armorFinish];
  paint('armor.main',armor.main,1,armor.roughness);paint('armor.trim',armor.trim,1,armor.trimRoughness);
  paint('shield.face',current.shieldColor===DEFAULT_APPEARANCE.shieldColor?[.82,.82,.78]:current.shieldColor,0,.42);
  paint('shield.emblem',current.accentColor===DEFAULT_APPEARANCE.accentColor?[.025,.135,.16]:current.accentColor,.28,.31);
  paint('weapon.wood',WOOD[current.weaponWood],0,.62);paint('weapon.metal',METAL[current.weaponMetal],1,.27);
  for(const [key,control]of Object.entries(controls))control.value=current[key];
  $('#appearance-summary').textContent=ARMOR[current.armorFinish].label+' · '+(current.shieldColor===DEFAULT_APPEARANCE.shieldColor?'белый щит':'цветной щит');
  render();
 }
 function persist(message='Выбор сохранён в этом браузере.'){
  try{localStorage.setItem(APPEARANCE_KEY,JSON.stringify(current));storageWarning='';status.textContent=message;}
  catch{status.textContent='Вид изменён. Браузер не разрешил сохранение — скачайте профиль JSON.';}
 }
 function set(patch,{save=true,message}={}){
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error('Неверные настройки снаряжения.');
  const next=checked({...current,...patch});beforeChange();current=next;apply();if(save)persist(message);return {...current};
 }
 function reset(){return set(DEFAULT_APPEARANCE,{message:'Стальной доспех и белый щит восстановлены.'});}
 function exportProfile(){return {schema:PROFILE_SCHEMA,schemaVersion:1,model:'white-pawn',appearance:{...current}};}
 function restoreProfile(profile){
  if(profile?.schema!==PROFILE_SCHEMA||profile?.schemaVersion!==1||profile?.model!=='white-pawn')throw Error('Это не профиль снаряжения белой пешки. Выберите сохранённый JSON профиля.');
  const next=checked(profile.appearance);return set(next,{message:'Профиль применён и сохранён в этом браузере.'});
 }
 for(const [key,control]of Object.entries(controls))control.addEventListener(control.type==='color'?'input':'change',()=>{try{set({[key]:control.value});}catch(error){status.textContent=error.message;}});
 $('#appearance-reset').onclick=reset;
 $('#appearance-export').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(exportProfile(),null,2)+'\n'],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='white-pawn-appearance.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);status.textContent='Профиль скачан. Его можно загрузить в мастерскую на другом устройстве.';};
 $('#appearance-import').onchange=async event=>{const file=event.target.files?.[0];if(!file)return;try{if(file.size>MAX_PROFILE_BYTES)throw Error('Профиль слишком большой. Предел — 16 КБ.');let profile;try{profile=JSON.parse(await file.text());}catch{throw Error('Не удалось прочитать JSON. Выберите сохранённый профиль снаряжения.');}restoreProfile(profile);}catch(error){status.textContent=error.message;}finally{event.target.value='';}};
 $('#appearance-panel').querySelectorAll('fieldset,button,input,select').forEach(control=>control.disabled=false);
 apply();status.textContent=storageWarning;
 return {get:()=>({...current}),set,reset,exportProfile,restoreProfile};
}
