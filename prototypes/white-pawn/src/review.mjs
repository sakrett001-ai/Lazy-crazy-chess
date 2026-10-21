// Local review records contain metadata only. Images remain downloadable files.
import {validAppearance} from './appearance.mjs';
const KEY='lazy-crazy-chess.reviews.v1',SCHEMA='lazy-crazy-chess/review';
const $=selector=>document.querySelector(selector);
const clone=value=>JSON.parse(JSON.stringify(value));
const saveFile=(blob,name)=>{const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);};
const finiteVector=(value,n)=>Array.isArray(value)&&value.length===n&&value.every(v=>Number.isFinite(v)&&Math.abs(v)<10000);

export function installReview({identity,snapshot,freeze,release,restore,poses,views}){
 const dialog=$('#review-dialog'),comment=$('#review-comment'),status=$('#review-status'),list=$('#review-list');
 let records=[],active=null,capturedImage='';
 const tell=message=>{status.textContent=message;};
 function valid(record){
  const s=record?.state,c=s?.camera;
  if(s?.appearance!==undefined&&!validAppearance(s.appearance))return false;
  return record?.schema===SCHEMA&&record.schemaVersion===1&&typeof record.id==='string'&&/^[a-zA-Z0-9-]{1,120}$/.test(record.id)&&typeof record.createdAt==='string'&&Number.isFinite(Date.parse(record.createdAt))&&typeof record.comment==='string'&&record.comment.length<=2000&&record.identity&&['version','modelVersion','sourceCommit'].every(key=>typeof record.identity[key]==='string'&&record.identity[key].length<=160)&&typeof record.identity.modelSha256==='string'&&/^[a-f0-9]{64}$/.test(record.identity.modelSha256)&&s&&poses.includes(s.pose)&&views.includes(s.view)&&Number.isFinite(s.time)&&s.time>=0&&s.time<=60&&[.25,.5,1,1.5].includes(s.speed)&&['surface','wire'].includes(s.display)&&typeof s.skeleton==='boolean'&&c&&finiteVector(c.position,3)&&finiteVector(c.target,3)&&finiteVector(c.up,3)&&Math.hypot(...c.up)>.1&&Math.hypot(...c.position.map((v,i)=>v-c.target[i]))>.001&&Number.isFinite(c.fov)&&c.fov>=10&&c.fov<=100&&Number.isFinite(c.zoom)&&c.zoom>=.1&&c.zoom<=10&&Number.isFinite(c.near)&&c.near>0&&c.near<=1&&Number.isFinite(c.far)&&c.far>c.near&&c.far<=1000;
 }
 try{const saved=localStorage.getItem(KEY);if(saved){const parsed=JSON.parse(saved);if(!Array.isArray(parsed))throw Error();records=parsed.filter(valid).slice(0,50);}}
 catch{$('#review-storage').textContent='Хранилище браузера недоступно. JSON и PNG можно скачать.';}
 const summary=record=>`${record.state.pose} · ${record.state.time.toFixed(3)} с · кадр ${record.state.frame}`;
 function renderList(){
  list.replaceChildren();$('#review-count').textContent=String(records.length);
  if(!records.length){const empty=document.createElement('p');empty.className='review-empty';empty.textContent='Пока нет замечаний.';list.append(empty);return;}
  records.forEach((record,index)=>{const item=document.createElement('li'),button=document.createElement('button'),title=document.createElement('strong'),detail=document.createElement('span');button.type='button';title.textContent=(index===0?'Последнее · ':'')+new Date(record.createdAt).toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'});detail.textContent=summary(record)+'\n'+(record.comment||'Без комментария');button.append(title,detail);button.onclick=()=>{try{restoreRecord(record);}catch(error){$('#review-import-status').textContent=error.message;}};item.append(button);list.append(item);});
 }
 function persist(record){
  records=[clone(record),...records.filter(r=>r.id!==record.id)].slice(0,50);renderList();
  try{localStorage.setItem(KEY,JSON.stringify(records));$('#review-storage').textContent='До 50 замечаний в этом браузере. Отправляйте файлы вручную.';return true;}
  catch{$('#review-storage').textContent='Не удалось записать в браузер. Скачайте JSON, чтобы сохранить замечание.';return false;}
 }
 function recordNow(){active.comment=comment.value.slice(0,2000);return clone(active);}
 function filename(record,extension){return `pawn-review-${record.createdAt.replace(/[:.]/g,'-')}-${record.id.slice(0,8)}.${extension}`;}
 function show(record,image,message='Кадр и камера зафиксированы. Замечание остаётся на вашем устройстве.'){
  active=clone(record);capturedImage=image;comment.value=active.comment;$('#review-preview').src=image;$('#review-summary').textContent=summary(active);$('#review-identity').textContent=`Стенд ${active.identity.version} · модель ${active.identity.modelVersion} · SHA ${active.identity.modelSha256.slice(0,12)}`;tell(message);if(!dialog.open)dialog.showModal();
 }
 function capture(){
  const image=freeze(),state=clone(snapshot());
  const record={schema:SCHEMA,schemaVersion:1,id:globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(16).slice(2)}`,createdAt:new Date().toISOString(),identity:clone(identity),state,comment:''};
  show(record,image);return clone(record);
 }
 function restoreRecord(record){
  if(!valid(record))throw Error('Формат замечания не поддерживается или содержит неверные значения.');
  if(record.identity.modelSha256!==identity.modelSha256)throw Error('SHA модели отличается. Откройте версию модели, указанную в JSON; этот ракурс не восстановлен.');
  const limits={rest:0,Guard_Breath:6,Shield_Brace:4,Spear_Study:4};if(record.state.time>(limits[record.state.pose]??60)+1e-5)throw Error('Время замечания находится за пределами движения.');
  restore(record.state);const image=freeze(),restored=clone(record);restored.state.frame=Math.round(restored.state.time*30);show(restored,image,'Поза и камера восстановлены из замечания. PNG создан заново в текущем размере окна.');return clone(restored);
 }
 function close(){dialog.close();release();}
 $('#mark-issue').disabled=false;$('#mark-issue').onclick=capture;
 $('#review-close').onclick=close;dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
 $('#review-save').onclick=()=>{const ok=persist(recordNow());tell(ok?'Замечание сохранено в этом браузере. Ничего не отправлено.':'Хранилище недоступно. Скачайте JSON и PNG.');};
 $('#review-json').onclick=()=>{const record=recordNow();persist(record);saveFile(new Blob([JSON.stringify(record,null,2)+'\n'],{type:'application/json'}),filename(record,'json'));tell('JSON сохранён: комментарий, версия, время и камера.');};
 $('#review-png').onclick=async()=>{
  const record=recordNow(),image=capturedImage;persist(record);const button=$('#review-png');button.disabled=true;
  try{
   const img=new Image();img.src=image;await img.decode();
   const width=Math.max(800,img.naturalWidth),padding=30,lineHeight=25,canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
   const lines=[],wrap=(text,font='17px Arial')=>{ctx.font=font;for(const paragraph of String(text).split('\n')){let line='';for(const character of paragraph){if(ctx.measureText(line+character).width>width-padding*2&&line){lines.push(line);line='';}line+=character;}lines.push(line||' ');}};
   const imageHeight=Math.round(img.naturalHeight*width/img.naturalWidth);canvas.width=width;
   const camera=record.state.camera;
   [ 'LAZY CRAZY CHESS · Замечание',`Стенд ${record.identity.version} · модель ${record.identity.modelVersion} · ${record.createdAt}`,summary(record),`ID: ${record.id}`,`SHA-256: ${record.identity.modelSha256}`,`Коммит: ${record.identity.sourceCommit||'не указан'}`,`Камера: ${camera.position.map(n=>n.toFixed(4)).join(', ')} → ${camera.target.map(n=>n.toFixed(4)).join(', ')} · FOV ${camera.fov}`,`Вид: ${record.state.display} · суставы: ${record.state.skeleton?'да':'нет'}`,`Комментарий: ${record.comment||'—'}`].forEach(text=>wrap(text));
   canvas.height=imageHeight+padding*2+lines.length*lineHeight;ctx.fillStyle='#f6f5ef';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,width,imageHeight);ctx.fillStyle='#23383d';ctx.font='17px Arial';ctx.textBaseline='top';lines.forEach((line,i)=>ctx.fillText(line,padding,imageHeight+padding+i*lineHeight));
   const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('Не удалось сформировать PNG');saveFile(blob,filename(record,'png'));tell('PNG сохранён с зафиксированным кадром, комментарием и метаданными.');
  }catch(error){tell(error.message||'Не удалось сохранить PNG. Попробуйте скачать JSON.');}finally{button.disabled=false;}
 };
 $('#review-import').onchange=async event=>{const file=event.target.files?.[0];if(!file)return;try{$('#review-import-status').textContent='';if(file.size>256*1024)throw Error('JSON слишком большой: предел 256 КБ.');restoreRecord(JSON.parse(await file.text()));}catch(error){$('#review-import-status').textContent=error.message||'Не удалось прочитать JSON.';}finally{event.target.value='';}};
 renderList();
 return {capture,restore:restoreRecord};
}
