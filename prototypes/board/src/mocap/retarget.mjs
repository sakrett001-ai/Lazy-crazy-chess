import {add,sub,scale,mid,lerp,normalize,distance,qMul,qConj,qSlerp,qRotate,frame} from './math.mjs';

// Retargeting by anatomical frames. For each driven bone the source key
// points and the figure's own rest pose give the same frame (for a thigh:
// hip→knee as the main axis, the foot's forward direction as the second).
// The bone turns by exactly the rotation that carries its rest frame onto
// the source frame: world = source · rest⁻¹ · restWorld. Only directions
// between key points are used, so the source's bone axes, rest pose, units
// and proportions never enter; the pelvis height comes from the supporting
// foot, so the figure stands on the ground whatever its leg length.

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
 foot:(p,s)=>frame(sub(p['toe'+s],p['ankle'+s]),sub(p['knee'+s],p['ankle'+s]),[0,1,0])
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
 const ankleHeight=Math.min(pts.ankleL[1],pts.ankleR[1]);

 // pose(points, clip): world rotations of the driven bones and the root
 // position, all in model space. clip supplies leg (source leg length) and
 // ground (lowest source ankle height) from prepareClip.
 function pose(src,clip){
  const delta=(name,q)=>qMul(q,qConj(restFrames[name]));
  const dP=delta('pelvis',FRAMES.pelvis(src)),dC=delta('chest',FRAMES.chest(src));
  const dH=delta('head',FRAMES.head(src));
  const world={},turned=(bone,d)=>{world[bone]=qMul(d,Q[bone]);};
  turned(PAWN.root,dP);
  PAWN.spine.forEach((b,i)=>turned(b,qSlerp(dP,dC,(i+1)/PAWN.spine.length)));
  PAWN.neck.forEach((b,i)=>turned(b,qSlerp(dC,dH,(i+1)/(PAWN.neck.length+1))));
  turned(PAWN.head,dH);
  const d={};
  for(const s of ['L','R']){
   const c=PAWN.legs[s];
   d['thigh'+s]=delta('thigh'+s,FRAMES.thigh(src,s));d['shin'+s]=delta('shin'+s,FRAMES.shin(src,s));d['foot'+s]=delta('foot'+s,FRAMES.foot(src,s));
   turned(c.hip,d['thigh'+s]);turned(c.knee,d['shin'+s]);turned(c.ankle,d['foot'+s]);
  }
  // Root: horizontal travel scaled to the figure; height set so the lower
  // ankle sits as high above the ground as the source's does.
  const k=leg/clip.leg,root=[P.root[0]+src.pelvis[0]*k,P.root[1],P.root[2]+src.pelvis[2]*k];
  const chain=s=>{const c=PAWN.legs[s],hip=add(root,qRotate(dP,sub(P[c.hip],P.root))),knee=add(hip,qRotate(d['thigh'+s],sub(P[c.knee],P[c.hip]))),ankle=add(knee,qRotate(d['shin'+s],sub(P[c.ankle],P[c.knee])));
   return{hip,knee,ankle,toe:add(ankle,qRotate(d['foot'+s],sub(P[c.toe],P[c.ankle])))};};
  const low=Math.min(chain('L').ankle[1],chain('R').ankle[1]),want=ankleHeight+(Math.min(src.ankleL[1],src.ankleR[1])-clip.ground)*k;
  root[1]+=want-low;
  return{root,world,legs:{L:chain('L'),R:chain('R')},scale:k};
 }
 return{pose,leg,ankleHeight,restFrames,points:pts};
}
