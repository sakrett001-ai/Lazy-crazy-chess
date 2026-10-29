import {Chess} from 'chess.js';

// Chess rules come from chess.js unchanged. This module only maps a legal
// move onto persistent figures: who walks, who is taken, which rook follows
// castling and which pawn is promoted. Figures keep their identity between
// moves, which later carries each soldier's personal history.
export const FILES='abcdefgh';
export const STRENGTH=Object.freeze({p:1,n:3,b:3,r:5,q:9,k:100});
export const PRESETS=Object.freeze({
 start:{label:'Новая партия',fen:'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'},
 capture:{label:'Сцена: пешка берёт пешку',fen:'4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1',hint:'Белые: e4 берёт d5'},
 clash:{label:'Сцена: схватка и оборона',fen:'4k3/8/8/3p1n2/3PP3/8/8/4K3 w - - 0 1',hint:'d4 и d5 фехтуют, e4 закрывается щитом от коня f5'}
});

export const square=(file,rank)=>FILES[file]+(rank+1);
export function coords(name){
 const file=FILES.indexOf(name?.[0]),rank=Number(name?.slice(1))-1;
 if(file<0||!(rank>=0&&rank<8)||name.length!==2)throw Error('Неверная клетка: '+name);
 return{file,rank};
}
export const chebyshev=(a,b)=>{const p=coords(a),q=coords(b);return Math.max(Math.abs(p.file-q.file),Math.abs(p.rank-q.rank));};

export function piecesFromChess(chess){
 const pieces=[];
 for(const row of chess.board())for(const cell of row)if(cell)pieces.push({id:`${cell.color}${cell.type}-${cell.square}`,type:cell.type,color:cell.color,square:cell.square});
 return pieces;
}

// Converts one verbose chess.js move into figure events. The caller animates
// the events; the rules engine has already accepted the move.
export function applyMove(pieces,move){
 const at=new Map(pieces.map(p=>[p.square,p]));
 const mover=at.get(move.from);
 if(!mover||mover.color!==move.color||mover.type!==move.piece)throw Error('Фигура хода не совпадает с позицией: '+move.from);
 const events=[];
 let victimSquare=null;
 if(move.captured)victimSquare=move.flags.includes('e')?move.to[0]+move.from[1]:move.to;
 const victim=victimSquare?at.get(victimSquare):null;
 if(move.captured&&(!victim||victim.color===move.color||victim.type!==move.captured))throw Error('Взятая фигура не совпадает с позицией: '+victimSquare);
 events.push(victim?{type:'capture',attacker:mover.id,victim:victim.id,from:move.from,to:move.to,victimSquare,enPassant:move.flags.includes('e')}:{type:'move',id:mover.id,from:move.from,to:move.to});
 let next=pieces.filter(p=>p!==victim).map(p=>p===mover?{...p,square:move.to}:p);
 if(move.flags.includes('k')||move.flags.includes('q')){
  const rank=move.from[1],[rookFrom,rookTo]=move.flags.includes('k')?['h'+rank,'f'+rank]:['a'+rank,'d'+rank];
  const rook=next.find(p=>p.square===rookFrom&&p.type==='r'&&p.color===move.color);
  if(!rook)throw Error('Нет ладьи для рокировки: '+rookFrom);
  events.push({type:'move',id:rook.id,from:rookFrom,to:rookTo});
  next=next.map(p=>p===rook?{...p,square:rookTo}:p);
 }
 if(move.promotion){
  events.push({type:'promote',id:mover.id,to:move.promotion});
  next=next.map(p=>p.id===mover.id?{...p,type:move.promotion}:p);
 }
 return{pieces:next,events};
}

export function createGame(fen=PRESETS.start.fen){
 const chess=new Chess(fen);
 let pieces=piecesFromChess(chess);
 return{
  chess,
  get pieces(){return pieces;},
  legal:from=>chess.moves({square:from,verbose:true}),
  play(from,to){
   const candidates=chess.moves({square:from,verbose:true}).filter(m=>m.to===to);
   if(!candidates.length)return null;
   // Promotion is fixed to a queen in this slice; the choice UI comes later.
   const chosen=candidates.find(m=>!m.promotion||m.promotion==='q');
   const move=chess.move({from,to,promotion:chosen.promotion});
   const result=applyMove(pieces,move);pieces=result.pieces;
   return{move,events:result.events};
  },
  status(){
   const turn=chess.turn()==='w'?'белые':'чёрные';
   if(chess.isCheckmate())return`Мат. Победили ${chess.turn()==='w'?'чёрные':'белые'}`;
   if(chess.isStalemate())return'Пат, ничья';
   if(chess.isDraw())return'Ничья';
   return`Ходят ${turn}${chess.inCheck()?' · шах':''}`;
  }
 };
}
