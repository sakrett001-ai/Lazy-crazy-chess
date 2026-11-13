import {add,sub,scale,mid,lerp,normalize,distance,qMul,qConj,qSlerp,qRotate,frame} from './math.mjs';
import {limitNeck} from './neck.mjs';

// Retargeting by anatomical frames. For each driven bone the source key
// points and the figure's own rest pose give the same frame (for a thigh:
// hip→knee as the main axis, the foot's forward direction as the second).
// The bone turns by exactly the rotation that carries its rest frame onto
// the source frame: world = source · rest⁻¹ · restWorld. Only directions
// between key points are used, so the source's bone axes, rest pose, units
// and proportions never enter; the pelvis height comes from the supporting
// foot's ankle or toe, so the figure stands on the ground whatever its leg
// length and foot proportions.

// Bones of the pawn (MakeHuman game-engine rig) the retargeter drives, from
// the pelvis outwards. Arms are left to the weapon loadout, which places the
// hands on the spear and shield after the body is posed.
export const PAWN={
 root:'root',spine:['spine05','spine04','spine03','spine02','spine01'],neck:['neck01','neck02','neck03'],head:'head',
 legs:{L:{hip:'upperleg01.L',knee:'lowerleg01.L',ankle:'foot.L',toe:'toe3-1.L'},R:{hip:'upperleg01.R',knee:'lowerleg01.R',ankle:'foot.R',toe:'toe3-1.R'}},
 shoulders:{L:'upperarm01.L',R:'upperarm01.R'},
 // Bones between driven ones that must hold their rest pose so the chain is rigid.
 between:['pelvis.L','pelvis.R','upperleg02.L','upperleg02.R','lowerleg02.L','lowerleg02.R']
};
export const PAWN_BONES=[PAWN.root,...PAWN.spine,...PAWN.neck,PAWN.head,...['L','R'].flatMap(s=>Object.values(PAWN.legs[s])),PAWN.shoulders.L,PAWN.shoulders.R];
export const DRIVEN=[PAWN.root,...PAWN.spine,...PAWN.neck,PAWN.head,...['L','R'].flatMap(s=>[PAWN.legs[s].hip,PAWN.legs[s].knee,PAWN.legs[s].ankle])];

// Frames, one rule for source and figure alike. pts: key points by name.
const FRAMES={
 pelvis:p=>frame(sub(p.hipL,p.hipR),sub(p.spine||mid(p.shoulderL,p.shoulderR),p.pelvis),[0,1,0]),
 chest:p=>frame(sub(p.shoulderL,p.shoulderR),sub(p.neck,p.chest||lerp(p.pelvis,p.neck,.5)),[0,1,0]),
 head:p=>frame(sub(p.head,p.neck),p.eyeL&&p.eyeR?sub(p.eyeL,p.eyeR):p.earL&&p.earR?sub(p.earL,p.earR):sub(p.shoulderL,p.shoulderR),[1,0,0]),
 thigh:(p,s)=>frame(sub(p['knee'+s],p['hip'+s]),sub(p['toe'+s],p['ankle'+s]),sub(p.hipL,p.hipR)),
 shin:(p,s)=>frame(sub(p['ankle'+s],p['knee'+s]),sub(p['toe'+s],p['ankle'+s]),sub(p.hipL,p.hipR)),
 foot:(p,s)=>frame(sub(p['toe'+s],p['ankle'+s]),sub(p['knee'+s],p['ankle'+s]),[0,1,0]),
 // The foot level across: its long axis from the ankle and toe, its sole's
 // cross axis kept horizontal. Two points do not give the foot's roll; the
 // knee does not either: with the toes turned out and the knee travelling
 // forward the shin–foot plane rolls about the foot while a foot on the
 // floor stays flat, and the boot rolled up to 60° on its edge.
 footLevel:(p,s)=>frame(sub(p['toe'+s],p['ankle'+s]),[0,1,0],sub(p['knee'+s],p['ankle'+s]))
};

// rest: {pos:{bone:[x,y,z]},quat:{bone:[x,y,z,w]}} in the figure's model
// space (forward +Z, left +X, up +Y, soles at y=0).
export function createRetargeter(rest){
 const P=rest.pos,Q=rest.quat;
 for(const b of PAWN_BONES)if(!P[b]||!Q[b])throw Error('В модели нет кости '+b);
 const L=PAWN.legs.L,R=PAWN.legs.R;
 // The figure's own key points at rest. Its lower spine point is the top of
 // the lowest vertebra, its chest the middle of the column.
 const pts={pelvis:P.root,spine:P[PAWN.spine[1]],chest:P[PAWN.spine[3]],neck:P[PAWN.neck[0]],head:P[PAWN.head],
  hipL:P[L.hip],kneeL:P[L.knee],ankleL:P[L.ankle],toeL:P[L.toe],hipR:P[R.hip],kneeR:P[R.knee],ankleR:P[R.ankle],toeR:P[R.toe],
  shoulderL:P[PAWN.shoulders.L],shoulderR:P[PAWN.shoulders.R]};
 const restFrames={pelvis:FRAMES.pelvis(pts),chest:FRAMES.chest(pts),head:FRAMES.head({...pts,eyeL:add(P.head,[1,0,0]),eyeR:P.head}),
  thighL:FRAMES.thigh(pts,'L'),thighR:FRAMES.thigh(pts,'R'),shinL:FRAMES.shin(pts,'L'),shinR:FRAMES.shin(pts,'R'),footL:FRAMES.foot(pts,'L'),footR:FRAMES.foot(pts,'R')};
 const leg=(distance(pts.hipL,pts.kneeL)+distance(pts.kneeL,pts.ankleL)+distance(pts.hipR,pts.kneeR)+distance(pts.kneeR,pts.ankleR))/2;
 const ankleHeight=Math.min(pts.ankleL[1],pts.ankleR[1]),toeHeight=Math.min(pts.toeL[1],pts.toeR[1]);

 // pose(points, clip): world rotations of the driven bones and the root
 // position, all in model space. clip supplies leg (source leg length) and
 // ground and groundToe (lowest source ankle and toe heights) from prepareClip.
 // A clip may carry its skeleton's neutral stance (prepareClip). Skeletons
 // place the spine, neck and head points differently: the Bandai Namco
 // chest→neck line leans 4° back in an easy stance where the pawn's leans
 // 6° forward, its pelvis→spine line stands upright where the pawn's leans
 // 19° forward (lumbar curve). Frame against frame, the pawn then leans
 // back and looks up. With a neutral, the trunk and head turn by the
 // source's rotation away from its own neutral, so standing at ease gives
 // the pawn's rest. The feet follow the same rule. Skeletons mark the toe
 // differently too: on the Bandai Namco skeleton the ankle→toe line of a
 // flat foot drops 40° to the floor, on the pawn 18°. Frame against frame
 // the pawn copied the 40° and stood on its toes, heel raised 22° while the
 // recorded foot was flat. Against the neutral (footLevel) a flat foot is the
 // pawn's flat boot, and a heel lifted by 25° lifts the boot's heel by 25°. Thighs and
 // shins keep the frame-against-frame rule: their checks (knees, soles) hold
 // on it.
 const neutrals=new WeakMap();
 const neutralFrames=n=>{if(!neutrals.has(n))neutrals.set(n,{pelvis:FRAMES.pelvis(n),chest:FRAMES.chest(n),head:FRAMES.head(n),footL:FRAMES.footLevel(n,'L'),footR:FRAMES.footLevel(n,'R')});return neutrals.get(n);};
 function pose(src,clip){
  const N=clip.neutral?neutralFrames(clip.neutral):null;
  const delta=(name,q)=>qMul(q,qConj(restFrames[name]));
  const trunk=(name,q)=>N?qMul(q,qConj(N[name])):delta(name,q);
  const dP=trunk('pelvis',FRAMES.pelvis(src)),dC=trunk('chest',FRAMES.chest(src));
  // The head within the neck's range against the chest (neck.mjs): a turn
  // the tracking got wrong, or the board's own turn onto the opponent on top
  // of the recorded one, never twists it past what a neck does.
  const dH=qMul(dC,limitNeck(qMul(qConj(dC),trunk('head',FRAMES.head(src)))));
  const world={},turned=(bone,d)=>{world[bone]=qMul(d,Q[bone]);};
  turned(PAWN.root,dP);
  PAWN.spine.forEach((b,i)=>turned(b,qSlerp(dP,dC,(i+1)/PAWN.spine.length)));
  PAWN.neck.forEach((b,i)=>turned(b,qSlerp(dC,dH,(i+1)/(PAWN.neck.length+1))));
  turned(PAWN.head,dH);
  const d={};
  for(const s of ['L','R']){
   const c=PAWN.legs[s];
   d['thigh'+s]=delta('thigh'+s,FRAMES.thigh(src,s));d['shin'+s]=delta('shin'+s,FRAMES.shin(src,s));d['foot'+s]=N?qMul(FRAMES.footLevel(src,s),qConj(N['foot'+s])):delta('foot'+s,FRAMES.foot(src,s));
   turned(c.hip,d['thigh'+s]);turned(c.knee,d['shin'+s]);turned(c.ankle,d['foot'+s]);
  }
  // Root: horizontal travel scaled to the figure. Height: each ankle and toe
  // is measured above its own lowest level (the source's lowest over the
  // clip, the figure's rest pose), and the figure's lowest of them is set as
  // high as the source's. A flat foot puts the ankle where it stands at rest;
  // a toe that stays on the floor while the heel rises keeps the figure's
  // toe on the floor, whatever the figure's foot proportions.
  const k=leg/clip.leg,root=[P.root[0]+src.pelvis[0]*k,P.root[1],P.root[2]+src.pelvis[2]*k];
  const chain=s=>{const c=PAWN.legs[s],hip=add(root,qRotate(dP,sub(P[c.hip],P.root))),knee=add(hip,qRotate(d['thigh'+s],sub(P[c.knee],P[c.hip]))),ankle=add(knee,qRotate(d['shin'+s],sub(P[c.ankle],P[c.knee])));
   return{hip,knee,ankle,toe:add(ankle,qRotate(d['foot'+s],sub(P[c.toe],P[c.ankle])))};};
  const L=chain('L'),R=chain('R'),toes=clip.groundToe!==undefined;
  const low=Math.min(L.ankle[1]-ankleHeight,R.ankle[1]-ankleHeight,...(toes?[L.toe[1]-toeHeight,R.toe[1]-toeHeight]:[]));
  const want=Math.min(Math.min(src.ankleL[1],src.ankleR[1])-clip.ground,...(toes?[Math.min(src.toeL[1],src.toeR[1])-clip.groundToe]:[]))*k;
  root[1]+=want-low;
  return{root,world,legs:{L:chain('L'),R:chain('R')},scale:k};
 }
 return{pose,leg,ankleHeight,toeHeight,restFrames,points:pts};
}
