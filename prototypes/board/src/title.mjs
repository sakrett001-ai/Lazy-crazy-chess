// Start window «Поединок»: the menu over a live scene. Behind it a pawn pair
// fences on the board (the «clash» position) and the camera circles them
// slowly. The camera paths here are pure functions of time, without
// three.js, so tests can check them (tests/title.test.mjs).

const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const smooth=u=>{u=clamp(u,0,1);return u*u*(3-2*u);};
const TAU=2*Math.PI;

// The pair d4–d5 seen low from the white side, the braced e4 pawn in front.
export const TITLE_VIEW={position:[6.5,2.6,5.5],target:[-.6,1.2,0]};

// Slow drift round the pair: a quarter radian either way over 48 s, the
// height and the distance breathing on their own periods, so the shot
// never repeats exactly and never stops.
export function titleCamera(t){
 const [tx,ty,tz]=TITLE_VIEW.target,[px,py,pz]=TITLE_VIEW.position;
 const r=Math.hypot(px-tx,pz-tz)*(1+.05*Math.sin(t*TAU/37)),a=Math.atan2(px-tx,pz-tz)+.25*Math.sin(t*TAU/48);
 return{position:[tx+r*Math.sin(a),py+.3*Math.sin(t*TAU/31),tz+r*Math.cos(a)],target:[tx,ty+.08*Math.sin(t*TAU/41),tz]};
}

// After «В бой»: the camera starts low behind the white line and rises to
// the home view of the whole board.
export const INTRO_VIEW={position:[0,2.4,15.5],target:[0,1.2,4.5]};
export const FLIGHT_SECONDS=2.2;
export function flight(from,to,u){
 const s=smooth(u),mix=(a,b)=>a.map((x,i)=>x+(b[i]-x)*s);
 // The camera lifts a little faster than it travels, so it rises over the
 // front rank instead of passing through the pieces on it.
 const lift=smooth(u*1.6),position=mix(from.position,to.position);
 position[1]=from.position[1]+(to.position[1]-from.position[1])*lift;
 return{position,target:mix(from.target,to.target)};
}

// The army summary. Careers are not tracked yet, so it holds what is known:
// sixteen fighters in a new game, finished games and the fallen of the
// white side in them, kept in this browser.
const ARMY_KEY='living-chess.army',SETTINGS_KEY='living-chess.settings';
const read=(storage,key,fallback)=>{try{const v=JSON.parse(storage?.getItem(key)||'null');return v&&typeof v==='object'?{...fallback,...v}:{...fallback};}catch{return{...fallback};}};
const write=(storage,key,value)=>{try{storage?.setItem(key,JSON.stringify(value));}catch{}};
export const ARMY_START={fighters:16,veterans:0,games:0,fallen:0};
export const readArmy=storage=>read(storage,ARMY_KEY,ARMY_START);
// A finished game from the starting position: one more game, and the white
// figures it lost go to the fallen.
export function recordGame(storage,whiteLeft){
 const a=readArmy(storage),lost=clamp(16-whiteLeft,0,16);
 const next={...a,games:a.games+1,fallen:a.fallen+lost};write(storage,ARMY_KEY,next);return next;
}
export const SETTINGS_START={graphics:'auto',slow:false};
export const readSettings=storage=>read(storage,SETTINGS_KEY,SETTINGS_START);
export const writeSettings=(storage,s)=>write(storage,SETTINGS_KEY,s);

// Built-in graphics: when no choice was made, the first seconds of the
// start window decide. A median frame slower than ~36 frames a second
// turns on the economy mode (pixel ratio 1, smaller shadow map).
export const SLOW_FRAME=1/36;
export function needsEconomy(frames){
 if(frames.length<30)return null;
 const s=[...frames].sort((a,b)=>a-b);return s[Math.floor(s.length/2)]>SLOW_FRAME;
}

// The window's own controls. `on` gives what the board does for each.
export function mountTitle(root,on){
 const $=s=>root.querySelector(s),storage=(()=>{try{return window.localStorage;}catch{return null;}})();
 let settings=readSettings(storage);
 const showArmy=()=>{const a=readArmy(storage);for(const k of ['fighters','veterans','games','fallen'])$(`[data-army=${k}]`).textContent=String(a[k]);};
 const sync=()=>{for(const b of root.querySelectorAll('[data-graphics]'))b.setAttribute('aria-pressed',String(b.dataset.graphics===settings.graphics));$('#t-slow').checked=settings.slow;};
 const set=change=>{settings={...settings,...change};writeSettings(storage,settings);sync();on.settings(settings);};
 const go=$('#t-go'),modes=$('#t-modes'),sheet=$('#t-sheet');
 go.onclick=()=>{const open=modes.hidden;modes.hidden=!open;go.setAttribute('aria-expanded',String(open));if(open)modes.querySelector('button').focus();};
 for(const b of modes.querySelectorAll('[data-mode]'))b.onclick=()=>on.start(b.dataset.mode);
 $('#t-settings').onclick=()=>{sheet.hidden=!sheet.hidden;$('#t-settings').setAttribute('aria-expanded',String(!sheet.hidden));};
 $('#t-sheet-close').onclick=()=>{sheet.hidden=true;$('#t-settings').setAttribute('aria-expanded','false');$('#t-settings').focus();};
 for(const b of root.querySelectorAll('[data-graphics]'))b.onclick=()=>set({graphics:b.dataset.graphics});
 $('#t-slow').onchange=()=>set({slow:$('#t-slow').checked});
 root.addEventListener('keydown',e=>{if(e.key!=='Escape')return;if(!sheet.hidden)$('#t-sheet-close').click();else if(!modes.hidden){modes.hidden=true;go.setAttribute('aria-expanded','false');go.focus();}});
 sync();showArmy();
 return{
  get settings(){return settings;},
  // A change made outside the window (the board's own «slow» box).
  update:change=>set(change),
  // Auto graphics resolved by measurement: shown in the sheet, not saved as a choice.
  noteAuto(economy){$('#t-auto-note').textContent=economy?'Сейчас экономная: кадры шли медленно.':'Сейчас полная.';},
  record(whiteLeft){recordGame(storage,whiteLeft);showArmy();},
  open(){showArmy();modes.hidden=true;sheet.hidden=true;go.setAttribute('aria-expanded','false');root.hidden=false;go.focus({preventScroll:true});},
  // Curtain down over the stage, `swap` under it, then the curtain lifts.
  curtain(swap,delay=420){const c=on.curtain;c.classList.add('down');
   return new Promise(resolve=>setTimeout(()=>{try{swap();}finally{requestAnimationFrame(()=>c.classList.remove('down'));resolve();}},delay));},
  close(){root.hidden=true;}
 };
}
