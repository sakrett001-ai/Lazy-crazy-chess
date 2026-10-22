// Profiles keep equipment, physique and experience independent.
export const APPEARANCE_KEY='lazy-crazy-chess.appearance.v1';
export const DEFAULT_APPEARANCE=Object.freeze({schemaVersion:2,armorFinish:'steel',shieldColor:'#eaeae5',accentColor:'#2c676f',weaponWood:'ash',weaponMetal:'steel',armorType:'plate',shieldType:'tower',weaponType:'spear',bodyBuild:'regular',experience:'recruit',skinTone:'medium',hairColor:'brown',beard:'none',helmet:'on'});
const LEGACY_KEYS=['schemaVersion','armorFinish','shieldColor','accentColor','weaponWood','weaponMetal'];
const PROFILE_SCHEMA='lazy-crazy-chess/appearance',MAX_PROFILE_BYTES=16*1024;
const ARMOR={
 steel:{label:'Сталь',main:[.50,.54,.58],trim:[.60,.64,.67],roughness:.32,trimRoughness:.24},
 brushed:{label:'Матовая сталь',main:[.40,.44,.47],trim:[.51,.55,.58],roughness:.52,trimRoughness:.38},
 dark:{label:'Воронёная сталь',main:[.075,.095,.12],trim:[.17,.20,.24],roughness:.32,trimRoughness:.26},
 bronze:{label:'Бронза',main:[.49,.28,.095],trim:[.62,.38,.14],roughness:.34,trimRoughness:.25}
};
const WOOD={ash:[.24,.135,.061],walnut:[.105,.044,.018],ebony:[.021,.014,.010]};
const METAL={steel:[.50,.57,.62],dark:[.10,.13,.16],bronze:[.49,.28,.095]};
const SKIN={light:[.64,.43,.29],medium:[.46,.27,.16],dark:[.18,.075,.035]};
const HAIR={brown:[.055,.026,.012],black:[.012,.009,.007],fair:[.28,.17,.065],grey:[.24,.25,.24]};
export const APPEARANCE_OPTIONS=Object.freeze({
 armorType:['plate','mail','padded'],shieldType:['tower','round','heater','none'],weaponType:['spear','sword','pike','greatsword'],bodyBuild:['lean','regular','strong'],experience:['recruit','veteran'],skinTone:Object.keys(SKIN),hairColor:Object.keys(HAIR),beard:['none','stubble','short'],helmet:['on','off']
});
const LABELS={armorType:{plate:'Латы',mail:'Кольчуга',padded:'Поддоспешник'},shieldType:{tower:'ростовой щит',round:'круглый щит',heater:'треугольный щит',none:'без щита'},weaponType:{spear:'копьё',sword:'меч',pike:'длинное копьё',greatsword:'двуручный меч'}};
const profileError=()=>Error('Неверные настройки бойца. Загрузите профиль, сохранённый в этой мастерской.');
export function normalizeAppearance(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw profileError();
 const legacy=value.schemaVersion===1,keys=legacy?LEGACY_KEYS:Object.keys(DEFAULT_APPEARANCE);
 if((!legacy&&value.schemaVersion!==2)||Object.keys(value).length!==keys.length||!keys.every(k=>Object.hasOwn(value,k)))throw profileError();
 if(!Object.hasOwn(ARMOR,value.armorFinish)||!Object.hasOwn(WOOD,value.weaponWood)||!Object.hasOwn(METAL,value.weaponMetal)||![value.shieldColor,value.accentColor].every(c=>typeof c==='string'&&/^#[a-f0-9]{6}$/i.test(c)))throw profileError();
 if(!legacy&&!Object.entries(APPEARANCE_OPTIONS).every(([k,values])=>values.includes(value[k])))throw profileError();
 return {...DEFAULT_APPEARANCE,...value,schemaVersion:2,shieldColor:value.shieldColor.toLowerCase(),accentColor:value.accentColor.toLowerCase()};
}
export function validAppearance(value){try{normalizeAppearance(value);return true;}catch{return false;}}
export function effectiveShield(value){return ['pike','greatsword'].includes(value.weaponType)?'none':value.shieldType;}
export function installAppearance({model,render,beforeChange=()=>{},onChange=()=>{}}){
 const $=s=>document.querySelector(s),status=$('#appearance-status');
 const ids={armorFinish:'armor-finish',shieldColor:'shield-color',accentColor:'accent-color',weaponWood:'weapon-wood',weaponMetal:'weapon-metal',armorType:'armor-type',shieldType:'shield-type',weaponType:'weapon-type',bodyBuild:'body-build',experience:'experience',skinTone:'skin-tone',hairColor:'hair-color',beard:'beard',helmet:'helmet'};
 const controls=Object.fromEntries(Object.entries(ids).map(([key,id])=>[key,$('#'+id)]));
 const slots=new Map();
 model.traverse(o=>{if(!o.isMesh)return;(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>{const key=m.userData?.customizationSlot||m.name;if(!slots.has(key))slots.set(key,new Set());slots.get(key).add(m);});});
 for(const name of ['armor.main','armor.trim','shield.face','shield.emblem','weapon.metal','weapon.wood'])if(!slots.has(name))throw Error('В модели отсутствует материал снаряжения: '+name);
 let current={...DEFAULT_APPEARANCE},storageWarning='';
 try{const saved=localStorage.getItem(APPEARANCE_KEY);if(saved)current=normalizeAppearance(JSON.parse(saved));}
 catch{storageWarning='Сохранённый профиль недоступен или повреждён. Загружен стандартный вид.';}
 function paint(name,color,metalness,roughness){for(const material of slots.get(name)||[]){if(color!==null)Array.isArray(color)?material.color.setRGB(...color):material.color.set(color);material.metalness=metalness;material.roughness=roughness;}}
 function apply(){
  const armor=ARMOR[current.armorFinish],twoHanded=['pike','greatsword'].includes(current.weaponType);
  paint('armor.main',armor.main,1,armor.roughness);paint('armor.trim',armor.trim,1,armor.trimRoughness);
  paint('mail',armor.main,1,Math.max(.52,armor.roughness));paint('padding',null,0,.91);
  paint('shield.face',current.shieldColor===DEFAULT_APPEARANCE.shieldColor?[.82,.82,.78]:current.shieldColor,0,.42);
  paint('shield.emblem',current.accentColor===DEFAULT_APPEARANCE.accentColor?[.025,.135,.16]:current.accentColor,.28,.31);
  paint('weapon.wood',WOOD[current.weaponWood],0,.62);paint('weapon.metal',METAL[current.weaponMetal],1,.27);
  paint('skin',SKIN[current.skinTone],0,.65);paint('hair',HAIR[current.hairColor],0,.88);paint('beard',HAIR[current.hairColor],0,.91);
  for(const [key,control]of Object.entries(controls))control.value=current[key];
  controls.shieldType.disabled=twoHanded;
  $('#loadout-note').textContent=twoHanded?'Оружие держат обе руки. Щит снят; его выбор сохранён для одноручного оружия.':'Доспех надевается поверх поддоспешника. Комплект можно менять в любой позе.';
  $('#appearance-summary').textContent=[LABELS.armorType[current.armorType],LABELS.weaponType[current.weaponType],LABELS.shieldType[effectiveShield(current)]].join(' · ');
  onChange({...current});render();
 }
 function persist(message='Выбор сохранён в этом браузере.'){
  try{localStorage.setItem(APPEARANCE_KEY,JSON.stringify(current));storageWarning='';status.textContent=message;}
  catch{status.textContent='Вид изменён. Браузер не разрешил сохранение — скачайте профиль JSON.';}
 }
 function set(patch,{save=true,message}={}){
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw profileError();
  const next=normalizeAppearance(patch.schemaVersion===1?patch:{...current,...patch});
  beforeChange(next);current=next;apply();if(save)persist(message);return {...current};
 }
 function reset(){return set(DEFAULT_APPEARANCE,{message:'Исходный боец, стальной доспех и белый щит восстановлены.'});}
 function exportProfile(){return {schema:PROFILE_SCHEMA,schemaVersion:2,model:'white-pawn',appearance:{...current}};}
 function restoreProfile(profile){
  if(!profile||profile.schema!==PROFILE_SCHEMA||![1,2].includes(profile.schemaVersion)||profile.model!=='white-pawn'||profile.appearance?.schemaVersion!==profile.schemaVersion)throw Error('Это не профиль белой пешки. Выберите сохранённый JSON профиля.');
  const next=normalizeAppearance(profile.appearance);return set(next,{message:profile.schemaVersion===1?'Прежний профиль перенесён. Комплект и внешность доступны для настройки.':'Профиль применён и сохранён в этом браузере.'});
 }
 for(const [key,control]of Object.entries(controls))control.addEventListener(control.type==='color'?'input':'change',()=>{try{set({[key]:control.value});}catch(error){status.textContent=error.message;control.value=current[key];}});
 $('#appearance-reset').onclick=reset;
 $('#appearance-export').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(exportProfile(),null,2)+'\n'],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='white-pawn-appearance.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);status.textContent='Профиль скачан. Его можно загрузить в мастерскую на другом устройстве.';};
 $('#appearance-import').onchange=async event=>{const file=event.target.files?.[0];if(!file)return;try{if(file.size>MAX_PROFILE_BYTES)throw Error('Профиль слишком большой. Предел — 16 КБ.');let profile;try{profile=JSON.parse(await file.text());}catch{throw Error('Не удалось прочитать JSON. Выберите сохранённый профиль.');}restoreProfile(profile);}catch(error){status.textContent=error.message;}finally{event.target.value='';}};
 $('#appearance-panel').querySelectorAll('fieldset,button,input,select').forEach(control=>control.disabled=false);
 apply();status.textContent=storageWarning;
 return {get:()=>({...current}),set,reset,exportProfile,restoreProfile};
}
