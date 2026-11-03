import {buildMotionFile} from './format.mjs';

// A deliberately simple test walker, made of sines: legs swing in the
// sagittal plane, knees bend in swing, the pelvis travels and bobs. It is
// not a motion to look at; it proves the import and retargeting chain
// without any motion-capture file and without a GPU.
export function walkerFrame(t,{leg=[.48,.46],hipHalf=.1,speed=1.3,cadence=.9,stand=false}={}){
 const p={},z=stand?0:speed*t,H=.92;
 for(const [s,side,phase]of [['L',1,0],['R',-1,Math.PI]]){
  const w=2*Math.PI*cadence*t+phase,a=stand?.03*Math.sin(w):.38*Math.sin(w),b=stand?.06+.03*Math.sin(w):.12+.55*Math.max(0,Math.sin(w+1.2));
  const hip=[side*hipHalf+(stand?.025*Math.sin(2*Math.PI*.25*t):0),H-(stand?.01*(1+Math.sin(w)):0),z];
  const knee=[hip[0],hip[1]-leg[0]*Math.cos(a),hip[2]+leg[0]*Math.sin(a)];
  const ankle=[stand?side*hipHalf*1.1:knee[0],knee[1]-leg[1]*Math.cos(a-b),knee[2]+leg[1]*Math.sin(a-b)],toe=[ankle[0],ankle[1]-.05,ankle[2]+.16];
  Object.assign(p,{['hip'+s]:hip,['knee'+s]:knee,['ankle'+s]:ankle,['toe'+s]:toe});
 }
 const cx=(p.hipL[0]+p.hipR[0])/2,cy=(p.hipL[1]+p.hipR[1])/2;
 p.pelvis=[cx,cy,z];p.spine=[cx,cy+.12,z];p.chest=[cx,cy+.35,z];p.neck=[cx,cy+.58,z];p.head=[cx,cy+.68,z+.02];
 p.shoulderL=[cx+.19,cy+.52,z];p.shoulderR=[cx-.19,cy+.52,z];p.eyeL=[cx+.03,cy+.75,z+.1];p.eyeR=[cx-.03,cy+.75,z+.1];
 return p;
}
export function syntheticMotionFile(){
 const frames=(n,o)=>Array.from({length:n},(_,f)=>walkerFrame(f/30,o));
 return buildMotionFile({source:{kind:'synthetic',name:'Проверочный синусный ходок',license:'собственный, без ограничений',note:'Не движение для оценки на глаз: проверка цепочки импорта и переноса.'},clips:[
  {name:'synthetic-march',label:'Проверочная ходьба',role:'march',loop:true,fps:30,frames:frames(Math.round(30/.9)+1,{})},
  {name:'synthetic-stand',label:'Проверочная стойка',role:'stand',loop:true,fps:30,frames:frames(121,{stand:true,cadence:.25})}
 ]});
}
