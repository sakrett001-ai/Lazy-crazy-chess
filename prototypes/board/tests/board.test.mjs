import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,applyMove,piecesFromChess,PRESETS} from '../src/game.mjs';
import {engagements,fencingAction} from '../src/behavior.mjs';
import {planCapture,captureAt,CAPTURE_DURATION,HIT_TIME,rotate,wrapAngle} from '../src/choreography.mjs';
import {Chess} from 'chess.js';

const bySquare=(pieces,square)=>pieces.find(p=>p.square===square);

test('rules stay classical: illegal moves are refused, legal ones move the same figure',()=>{
 const game=createGame();
 assert.equal(game.play('e2','e5'),null);
 const id=bySquare(game.pieces,'e2').id;
 const result=game.play('e2','e4');
 assert.equal(result.move.san,'e4');
 assert.equal(bySquare(game.pieces,'e4').id,id);
 assert.deepEqual(result.events,[{type:'move',id,from:'e2',to:'e4'}]);
});

test('capture removes exactly the taken figure and keeps the attacker identity',()=>{
 const game=createGame(PRESETS.capture.fen);
 const attacker=bySquare(game.pieces,'e4').id,victim=bySquare(game.pieces,'d5').id;
 const {events}=game.play('e4','d5');
 assert.deepEqual(events,[{type:'capture',attacker,victim,from:'e4',to:'d5',victimSquare:'d5',enPassant:false}]);
 assert.equal(game.pieces.length,3);
 assert.equal(bySquare(game.pieces,'d5').id,attacker);
});

test('en passant takes the pawn beside, not on the target square',()=>{
 const chess=new Chess('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
 const pieces=piecesFromChess(chess),move=chess.move('exd6');
 const {events,pieces:next}=applyMove(pieces,move);
 assert.equal(events[0].victimSquare,'d5');
 assert.equal(events[0].to,'d6');
 assert.equal(bySquare(next,'d5'),undefined);
});

test('castling moves the rook as its own figure; promotion keeps the soldier',()=>{
 const chess=new Chess('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
 const castle=applyMove(piecesFromChess(chess),chess.move('O-O'));
 assert.deepEqual(castle.events.map(e=>[e.type,e.from,e.to]),[['move','e1','g1'],['move','h1','f1']]);
 const game=createGame('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
 const id=bySquare(game.pieces,'a7').id;
 const {events}=game.play('a7','a8');
 assert.deepEqual(events.at(-1),{type:'promote',id,to:'q'});
 assert.equal(bySquare(game.pieces,'a8').type,'q');
 assert.equal(bySquare(game.pieces,'a8').id,id);
});

test('pawn behaviour follows the position: rest, fencing, shield defence',()=>{
 const start=engagements(createGame().pieces);
 assert.ok([...start.values()].every(e=>e.state==='rest'));
 const clash=createGame(PRESETS.clash.fen),states=engagements(clash.pieces),at=sq=>states.get(bySquare(clash.pieces,sq).id);
 assert.equal(at('d4').state,'fencing');assert.equal(at('d5').state,'fencing');
 assert.equal(at('d4').target,bySquare(clash.pieces,'d5').id);
 assert.deepEqual(new Set([at('d4').role,at('d5').role]),new Set(['lead','follow']));
 assert.equal(at('e4').state,'defense');
 assert.equal(at('e4').target,bySquare(clash.pieces,'f5').id);
 assert.equal(at('f5').state,'alert');
 // A pawn two squares away turns towards the enemy but does not fight.
 const near=engagements(createGame('4k3/8/3p4/8/3P4/8/8/4K3 w - - 0 1').pieces);
 assert.ok([...near.values()].some(e=>e.state==='alert'));
 assert.ok([...near.values()].every(e=>e.state!=='fencing'));
});

test('fencing partners never thrust at the same time and swap every cycle',()=>{
 for(let t=0;t<16;t+=.1){
  const a=fencingAction('lead',t),b=fencingAction('follow',t);
  assert.notEqual(a.attacking,b.attacking);
  assert.ok(a.time>=0&&a.time<4);
 }
 assert.equal(fencingAction('lead',1).attacking,true);
 assert.equal(fencingAction('lead',5).attacking,false);
});

test('capture choreography: the off-centre spear tip ends at the victim flank at the hit',()=>{
 const reach={x:-.876,z:2.057};
 const plan=planCapture({from:[1.3,1.3],to:[-1.3,-1.3],attackerYaw:Math.PI,victimYaw:0,reach});
 const hit=captureAt(plan,HIT_TIME),tip=rotate([reach.x,reach.z],hit.attacker.yaw);
 const world=[hit.attacker.position[0]+tip[0],hit.attacker.position[1]+tip[1]];
 assert.ok(Math.hypot(world[0]+1.3,world[1]+1.3)<.13,'tip reaches the victim');
 assert.equal(hit.attacker.action,'Spear_Study');
 assert.ok(hit.attacker.time>1.9,'full thrust at the hit');
 // The victim reacts to the feint before the hit and only falls after it.
 assert.equal(captureAt(plan,1.8).victim.action,'Shield_Brace');
 assert.equal(captureAt(plan,HIT_TIME-.01).victim.fall,0);
 assert.ok(captureAt(plan,3.2).victim.fall>1.3);
 const end=captureAt(plan,CAPTURE_DURATION);
 assert.deepEqual(end.attacker.position.map(v=>+v.toFixed(6)),[-1.3,-1.3]);
 assert.ok(Math.abs(wrapAngle(end.attacker.yaw-Math.PI))<1e-6);
 assert.equal(end.victim.removed,true);
 // Absolute timing: sampling the same moment twice gives the same pose.
 assert.deepEqual(captureAt(plan,2.1),captureAt(plan,2.1));
 // Positions are continuous: no jump larger than a fast step per frame.
 let prev=captureAt(plan,0).attacker.position;
 for(let t=1/30;t<=CAPTURE_DURATION;t+=1/30){const p=captureAt(plan,t).attacker.position;assert.ok(Math.hypot(p[0]-prev[0],p[1]-prev[1])<.2);prev=p;}
});
