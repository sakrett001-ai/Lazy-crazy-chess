import {STRENGTH,chebyshev,coords} from './game.mjs';

// What a figure does between moves depends only on where its enemies stand.
// The rules never change; this is presentation of the position.
//   rest     — no enemy within two squares: stance in formation
//   alert    — an enemy two squares away: turns towards it, weapon ready
//   fencing  — an enemy pawn on an adjacent square: thrusts into the shield
//              and covers in turn, nobody is hurt
//   defense  — a stronger enemy on an adjacent square: the pawn braces
//              behind its shield and does not attack
export const STATE_LABELS=Object.freeze({rest:'покой',alert:'готовность',fencing:'фехтование',defense:'глухая оборона'});

function nearestFirst(self,list){
 const p=coords(self.square);
 return list.slice().sort((a,b)=>{
  const qa=coords(a.square),qb=coords(b.square);
  // Directly ahead or beside first, then diagonals, then a stable id order.
  const da=Math.abs(qa.file-p.file)+Math.abs(qa.rank-p.rank),db=Math.abs(qb.file-p.file)+Math.abs(qb.rank-p.rank);
  return da-db||a.id.localeCompare(b.id);
 });
}

export function engagements(pieces){
 const result=new Map();
 for(const self of pieces){
  const enemies=pieces.filter(p=>p.color!==self.color);
  const adjacent=enemies.filter(e=>chebyshev(self.square,e.square)===1);
  const near=enemies.filter(e=>chebyshev(self.square,e.square)===2);
  let state='rest',target=null;
  if(self.type==='p'){
   const stronger=adjacent.filter(e=>STRENGTH[e.type]>STRENGTH.p);
   const pawns=adjacent.filter(e=>e.type==='p');
   if(stronger.length){state='defense';target=nearestFirst(self,stronger).sort((a,b)=>STRENGTH[b.type]-STRENGTH[a.type])[0];}
   else if(pawns.length){state='fencing';target=nearestFirst(self,pawns)[0];}
   else if(near.length){state='alert';target=nearestFirst(self,near)[0];}
  }else if(adjacent.length||near.length){state='alert';target=nearestFirst(self,adjacent.length?adjacent:near)[0];}
  result.set(self.id,{state,target:target?.id||null,role:null});
 }
 // Mutual fencing pairs take turns. The lower id attacks first; a pawn whose
 // opponent is busy elsewhere keeps attacking on its own.
 for(const [id,entry]of result){
  if(entry.state!=='fencing')continue;
  const other=result.get(entry.target);
  entry.role=other?.state==='fencing'&&other.target===id?(id<entry.target?'lead':'follow'):'solo';
 }
 return result;
}

// Fencing exchange: one cycle per authored thrust clip. In each cycle one
// partner thrusts and the other braces; the roles swap every cycle.
export function fencingAction(role,clock,cycle=4){
 const turn=Math.floor(clock/cycle)%2,local=clock-Math.floor(clock/cycle)*cycle;
 const attacking=role==='solo'||(role==='lead'?turn===0:turn===1);
 return{action:attacking?'Spear_Study':'Shield_Brace',time:local,attacking};
}
