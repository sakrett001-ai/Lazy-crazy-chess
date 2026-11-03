// Weapons the pawn GLB does not carry: the bishop's bastard sword and the
// rook's two-handed war hammer. They are built at runtime around the same
// right-hand grip frame as the catalogue greatsword (gripBind, shaftAxisBind)
// and bound rigidly to wrist.R, so the loadout's attachment frames, diagonal
// grip rebind, second-hand frame and finger fit treat them like any GLB
// weapon.
//
// Every part is described once, in the weapon frame: s along the haft from
// the right-hand grip (metres, + towards the point or head), u across it (the
// sword's edge, the hammer's face), v the flat. The same table gives the mesh
// and the mass properties the strike dynamics use (board/src/mocap/strike.mjs),
// so the trajectory is driven by the weapon that is drawn.
//
// Dimensions follow surviving late-medieval pieces (Oakeshott types XV–XVIII
// hand-and-a-half swords: 1.1–1.2 m, 1.3–1.6 kg; two-handed hammers and
// pollhammers: 1.3–2 m, 2–3.5 kg). Masses are computed from the geometry with
// steel 7850 kg/m³, ash 670 kg/m³, leather over wood 750 kg/m³.

export const DENSITY=Object.freeze({steel:7850,ash:670,grip:750,leather:900});

// tube: from s0 to s1 along a direction ('axis' or '±u'), radii r0→r1 (0 is a
// point), at an offset [u,v] from the haft; wall makes it a shell (socket,
// ferrule) over the wood that already carries the haft's mass.
// blade: diamond section from s0, stations [t, half width, half thickness].
// box: centre [s,u,v], half sizes [s,u,v]. fill: the share of the solid that
// is metal (langets are two strips, the head a socket around the haft).
const BASTARD={
 label:'бастард',twoHanded:true,guard:'greatsword',gripRadiusM:.014,
 // Hand-and-a-half: the left hand sits low on the grip, partly on the pommel.
 secondS:-.115,tipS:.98,
 parts:[
  {name:'Pommel',kind:'tube',material:'weapon.metal',density:'steel',s:[-.175,-.142],r:[.019,.022],res:16},
  {name:'Peen',kind:'tube',material:'weapon.metal',density:'steel',s:[-.183,-.175],r:[.006,.008],res:10},
  {name:'Grip',kind:'tube',material:'weapon.grip',density:'grip',s:[-.142,.094],r:[.014,.014],res:16},
  ...[-.125,-.07,-.02,.03,.078].map(s=>({name:'Riser',kind:'tube',material:'weapon.binding',density:'leather',s:[s,s+.003],r:[.0144,.0144],res:16})),
  {name:'Quillon block',kind:'box',material:'weapon.metal',density:'steel',centre:[.103,0,0],half:[.009,.017,.011]},
  {name:'Cross',kind:'tube',material:'weapon.metal',density:'steel',dir:'u',s:[-.112,.112],at:[.103,0],r:[.006,.006],res:12},
  {name:'Blade',kind:'blade',material:'weapon.metal',density:'steel',s0:.112,length:.868,
   stations:[[0,.025,.0045],[.35,.022,.0038],[.72,.016,.003],[.92,.0085,.002],[1,0,0]]},
 ]};
const WARHAMMER={
 label:'боевой молот',twoHanded:true,guard:'greatsword',gripRadiusM:.016,
 // A round haft sits in the hands at any roll: the head is turned 30° about
 // it so the face meets the overhead blow square (measured on the stand at
 // the fastest frames; the greatsword edge would meet it 30° off).
 turnDeg:30,
 // The face strikes: in the diagonal grip it leads the overhead blow (−u),
 // the beak trails. Two-handed: the left hand at the butt, 28 cm under the right; the head
 // about a metre past the right hand.
 secondS:-.28,tipS:1.17,
 parts:[
  {name:'Haft',kind:'tube',material:'weapon.wood',density:'ash',s:[-.34,1.0],r:[.016,.016],res:16},
  {name:'Butt cap',kind:'tube',material:'weapon.metal',density:'steel',s:[-.345,-.325],r:[.0175,.0175],wall:.0025,res:16},
  {name:'Lower grip',kind:'tube',material:'weapon.grip',density:'leather',s:[-.325,-.235],r:[.0165,.0165],wall:.0015,res:16},
  {name:'Upper grip',kind:'tube',material:'weapon.grip',density:'leather',s:[-.065,.065],r:[.0165,.0165],wall:.0015,res:16},
  {name:'Langets',kind:'tube',material:'weapon.metal',density:'steel',s:[.78,1.0],r:[.0185,.0185],wall:.0025,fill:.35,res:16},
  {name:'Head',kind:'box',material:'weapon.metal',density:'steel',centre:[1.03,0,0],half:[.035,.021,.02],fill:.5},
  {name:'Face',kind:'tube',material:'weapon.metal',density:'steel',dir:'-u',s:[.021,.085],at:[1.03,0],r:[.016,.018],res:12},
  {name:'Beak',kind:'tube',material:'weapon.metal',density:'steel',dir:'u',s:[.021,.125],at:[1.03,0],r:[.015,0],res:8},
  {name:'Top spike',kind:'tube',material:'weapon.metal',density:'steel',s:[1.072,1.17],r:[.013,0],res:8},
 ]};
export const RUNTIME_WEAPONS=Object.freeze({bastard:BASTARD,warhammer:WARHAMMER});
export const TWO_HANDED=new Set(['pike','greatsword',...Object.entries(RUNTIME_WEAPONS).filter(([,w])=>w.twoHanded).map(([k])=>k)]);
export const WEAPON_NAMES={spear:'копьё',sword:'меч',pike:'длинное копьё',greatsword:'двуручный меч',...Object.fromEntries(Object.entries(RUNTIME_WEAPONS).map(([k,w])=>[k,w.label]))};
export const gripRadiusOf=type=>RUNTIME_WEAPONS[type]?.gripRadiusM??(type==='pike'?.016:.014);

// Slices of every part as point masses [s,u,v,m]. Shells over the haft count
// their wall only; the blade and box are solid.
export function slices(part,n=24){
 const rho=DENSITY[part.density]*(part.fill??1),out=[];
 if(part.kind==='box'){
  const [cs,cu,cv]=part.centre,[hs,hu,hv]=part.half,m=8*hs*hu*hv*rho;
  for(let i=0;i<n;i++)out.push([cs-hs+2*hs*(i+.5)/n,cu,cv,m/n,hs*2/n,hu,hv]);return out;
 }
 if(part.kind==='blade'){
  const st=part.stations;
  for(let i=0;i<n;i++){const t=(i+.5)/n;let k=0;while(k<st.length-2&&st[k+1][0]<t)k++;
   const [t0,w0,h0]=st[k],[t1,w1,h1]=st[k+1],a=(t-t0)/(t1-t0),w=w0+(w1-w0)*a,h=h0+(h1-h0)*a,L=part.length/n;
   out.push([part.s0+t*part.length,0,0,2*w*h*L*rho,L,w,h]);}
  return out;
 }
 const [s0,s1]=part.s,[r0,r1]=part.r,dir=part.dir||'axis',[as,av]=part.at||[0,0];
 for(let i=0;i<n;i++){const t=(i+.5)/n,r=r0+(r1-r0)*t,L=Math.abs(s1-s0)/n,w=part.wall?Math.min(part.wall,r):r,area=Math.PI*(r*r-(r-w)*(r-w)),m=area*L*rho,x=s0+(s1-s0)*t;
  out.push(dir==='axis'?[x,0,0,m,L,r,r]:[as,dir==='u'?x:-x,av,m,L,r,r]);}
 return out;
}

// Mass, centre of mass along the haft and the moment of inertia for turning
// the haft about a point on it (pivotS), averaged over the two directions
// across the haft. Slices are short rods: point mass plus their own length.
export function massProperties(type,pivotS=null){
 const w=RUNTIME_WEAPONS[type];if(!w)throw Error('Нет описания оружия: '+type);
 const all=w.parts.flatMap(p=>slices(p));
 const m=all.reduce((a,q)=>a+q[3],0),cm=all.reduce((a,q)=>a+q[0]*q[3],0)/m;
 const p=pivotS??w.secondS/2;
 const inertia=all.reduce((a,[s,u,v,dm,L])=>a+dm*((s-p)**2+(u*u+v*v)/2+L*L/12),0);
 return{massKg:m,centreS:cm,pivotS:p,inertiaKgM2:inertia,lengthM:w.tipS-Math.min(...w.parts.map(q=>q.kind==='tube'&&(q.dir||'axis')==='axis'?Math.min(...q.s):q.kind==='blade'?q.s0:q.centre?.[0]??0))};
}

// Body-clearance samples [s,u,v,radius] along the weapon, outside the hands.
export function clearanceSamples(type){
 const w=RUNTIME_WEAPONS[type],lo=w.secondS-.06,hi=.06,out=[];
 for(const part of w.parts){
  if(part.kind==='blade'){for(let i=0;i<=16;i++){const t=i/16;out.push([part.s0+t*part.length,0,0,.03*(1-t)]);}continue;}
  if(part.kind==='box'){out.push([part.centre[0],part.centre[1],part.centre[2],Math.max(...part.half)]);continue;}
  const [s0,s1]=part.s,dir=part.dir||'axis',[as,av]=part.at||[0,0],n=Math.max(2,Math.ceil(Math.abs(s1-s0)/.05));
  for(let i=0;i<=n;i++){const x=s0+(s1-s0)*i/n,r=part.r[0]+(part.r[1]-part.r[0])*i/n;
   if(dir==='axis'&&x>lo&&x<hi)continue;out.push(dir==='axis'?[x,0,0,r]:[as,dir==='u'?x:-x,av,r]);}
 }
 return out;
}

// Meshes. frame: {grip,axis,across} three.js vectors in the reference mesh's
// local (bind) space. Returns one BufferGeometry per material name. Every
// part is convex, so a face is turned outwards against the part's own centre
// line; tubes get smooth side normals, the rest flat ones.
export function buildGeometry(THREE,type,frame){
 const w=RUNTIME_WEAPONS[type],A=frame.axis.clone().normalize(),U0=frame.across.clone().sub(A.clone().multiplyScalar(frame.across.dot(A))).normalize(),W0=A.clone().cross(U0).normalize();
 // turnDeg: the head or edge turned about the haft from the greatsword's edge.
 const turn=(w.turnDeg||0)*Math.PI/180,U=U0.clone().multiplyScalar(Math.cos(turn)).addScaledVector(W0,Math.sin(turn)),W=A.clone().cross(U).normalize();
 const at=(s,u,v)=>frame.grip.clone().addScaledVector(A,s).addScaledVector(U,u).addScaledVector(W,v);
 const byMaterial=new Map();
 for(const part of w.parts){
  if(!byMaterial.has(part.material))byMaterial.set(part.material,{p:[],n:[]});
  const out=byMaterial.get(part.material),tris=[];let lineA,lineD;
  // tris: [[p0,n0],[p1,n1],[p2,n2]] with n null for a flat face.
  if(part.kind==='tube'){
   const [s0,s1]=part.s,[r0,r1]=part.r,res=part.res||12,dir=part.dir||'axis',[as,av]=part.at||[0,0];
   const centre=x=>dir==='axis'?at(x,0,0):at(as,dir==='u'?x:-x,av);
   const d=dir==='axis'?A.clone():dir==='u'?U.clone():U.clone().negate(),e1=dir==='axis'?U.clone():A.clone(),e2=d.clone().cross(e1).normalize();
   const slope=(r0-r1)/Math.abs(s1-s0),cos=1/Math.hypot(1,slope),sin=slope*cos;
   const ring=(x,r)=>Array.from({length:res},(_,i)=>{const a=2*Math.PI*i/res,rad=e1.clone().multiplyScalar(Math.cos(a)).addScaledVector(e2,Math.sin(a));
    return[centre(x).addScaledVector(rad,r),rad.multiplyScalar(cos).addScaledVector(d,sin).normalize()];});
   const a=ring(s0,r0),b=ring(s1,r1),ca=centre(s0),cb=centre(s1);lineA=ca;lineD=d;
   for(let i=0;i<res;i++){const j=(i+1)%res;
    if(r0>0&&r1>0)tris.push([a[i],b[i],b[j]],[a[i],b[j],a[j]]);
    else if(r1===0)tris.push([a[i],[cb,b[i][1]],a[j]]);else tris.push([[ca,a[i][1]],b[i],b[j]]);
    if(r0>0)tris.push([[ca,null],[a[i][0],null],[a[j][0],null]]);
    if(r1>0)tris.push([[cb,null],[b[i][0],null],[b[j][0],null]]);}
  }else if(part.kind==='blade'){
   const st=part.stations,rows=st.map(([t,hw,ht])=>{const s=part.s0+t*part.length;return hw===0?[at(s,0,0)]:[at(s,hw,0),at(s,0,ht),at(s,-hw,0),at(s,0,-ht)];});
   for(let k=0;k<rows.length-1;k++){const p=rows[k],q=rows[k+1];
    for(let i=0;i<4;i++){const j=(i+1)%4;if(q.length===1)tris.push([p[i],q[0],p[j]].map(x=>[x,null]));else tris.push([p[i],q[i],q[j]].map(x=>[x,null]),[p[i],q[j],p[j]].map(x=>[x,null]));}}
   const base=rows[0];tris.push([base[0],base[2],base[1]].map(x=>[x,null]),[base[0],base[3],base[2]].map(x=>[x,null]));lineA=at(0,0,0);lineD=A;
  }else if(part.kind==='box'){
   const [cs,cu,cv]=part.centre,[hs,hu,hv]=part.half,c=(i,j,k)=>at(cs+i*hs,cu+j*hu,cv+k*hv);
   const faces=[[[1,-1,-1],[1,1,-1],[1,1,1],[1,-1,1]],[[-1,-1,-1],[-1,-1,1],[-1,1,1],[-1,1,-1]],[[-1,1,-1],[-1,1,1],[1,1,1],[1,1,-1]],[[-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1]],[[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]],[[-1,-1,-1],[-1,1,-1],[1,1,-1],[1,-1,-1]]];
   for(const f of faces){const p=f.map(v=>[c(...v),null]);tris.push([p[0],p[1],p[2]],[p[0],p[2],p[3]]);}
   lineA=at(cs,cu,cv);lineD=null;
  }
  for(let t of tris){
   const [p0,p1,p2]=t.map(x=>x[0]),n=p1.clone().sub(p0).cross(p2.clone().sub(p0));if(n.lengthSq()<1e-16)continue;n.normalize();
   const c=p0.clone().add(p1).add(p2).divideScalar(3),rel=c.clone().sub(lineA);if(lineD)rel.addScaledVector(lineD,-rel.dot(lineD));
   // A cap's centroid lies on the line: its outward side is along the line.
   const ref=rel.lengthSq()>1e-10?rel:c.clone().sub(lineA).lengthSq()>1e-10?c.clone().sub(lineA):n;
   if(n.dot(ref)<0){t=[t[0],t[2],t[1]];n.negate();}
   for(const [p,vn]of t){out.p.push(p.x,p.y,p.z);const m=vn&&vn.dot(n)>0?vn:vn?vn.clone().negate():n;out.n.push(m.x,m.y,m.z);}
  }
 }
 const geometries=new Map();
 for(const [name,{p,n}]of byMaterial){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(n,3));geometries.set(name,g);}
 return{geometries,frame:{grip:frame.grip.clone(),axis:A,across:U,flat:W},at};
}

// Adds the runtime weapons to a loaded pawn. They are built in the bind space
// of the catalogue greatsword: its grip and haft axis, and its cross for the
// edge direction. Call before the loadout reads the equipment slots.
export function attachRuntimeWeapons(THREE,{model,types=Object.keys(RUNTIME_WEAPONS),wristBone='wrist.R'}){
 let reference=null;const materials=new Map(),existing=new Set();
 model.traverse(o=>{const d=o.userData||{};if(d.equipmentSlot==='weapon'){existing.add(d.equipmentVariant);if(d.equipmentVariant==='greatsword')reference=o;}
  if(o.isMesh)for(const m of Array.isArray(o.material)?o.material:[o.material])if(m?.name&&!materials.has(m.name))materials.set(m.name,m);});
 if(!reference)throw Error('Нет двуручного меча — опорной рамки для нового оружия');
 let src=null;reference.traverse(o=>{if(!src&&o.isSkinnedMesh)src=o;});
 const data=reference.userData,G=new THREE.Vector3().fromArray(data.gripBind),A=new THREE.Vector3().fromArray(data.shaftAxisBind).normalize();
 // The greatsword's cross is its widest part near s = 0.115 m: the edge line.
 const pos=src.geometry.attributes.position,p=new THREE.Vector3();let across=null,best=0;
 for(let i=0;i<pos.count;i++){p.fromBufferAttribute(pos,i).sub(G);const s=p.dot(A);if(Math.abs(s-.115)>.03)continue;const r=p.addScaledVector(A,-s);if(r.length()>best){best=r.length();across=r.clone();}}
 if(!across)throw Error('Не найдена крестовина двуручного меча');
 const index=src.skeleton.bones.findIndex(b=>b.name.replace(/[._\-\s]/g,'').toLowerCase()===wristBone.replace(/[._\-\s]/g,'').toLowerCase());
 if(index<0)throw Error('Нет кости '+wristBone);
 const added=[];
 for(const type of types){
  if(existing.has(type))continue;
  const spec=RUNTIME_WEAPONS[type],{geometries,at}=buildGeometry(THREE,type,{grip:G,axis:A,across});
  const group=new THREE.Group();group.name='WEAPON_'+type;
  for(const [name,geometry]of geometries){
   const n=geometry.attributes.position.count;
   geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(new Uint16Array(n*4).map((_,i)=>i%4===0?index:0),4));
   geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(new Float32Array(n*4).map((_,i)=>i%4===0?1:0),4));
   geometry.computeBoundingBox();geometry.computeBoundingSphere();
   const material=materials.get(name)||materials.get('weapon.metal');
   const mesh=new THREE.SkinnedMesh(geometry,material);mesh.name=group.name+'_'+name;mesh.castShadow=src.castShadow;mesh.receiveShadow=src.receiveShadow;mesh.frustumCulled=false;
   mesh.position.copy(src.position);mesh.quaternion.copy(src.quaternion);mesh.scale.copy(src.scale);mesh.bindMode=src.bindMode;
   mesh.bind(src.skeleton,src.bindMatrix.clone());group.add(mesh);
  }
  const mp=massProperties(type);
  group.userData={equipmentSlot:'weapon',equipmentVariant:type,runtimeWeapon:true,gripBind:G.toArray(),shaftAxisBind:A.toArray(),
   tipBind:at(spec.tipS,0,0).toArray(),secondGripBind:at(spec.secondS,0,0).toArray(),lengthMetres:+mp.lengthM.toFixed(3),massKg:+mp.massKg.toFixed(3),
   clearanceBind:clearanceSamples(type).map(([s,u,v,r])=>[...at(s,u,v).toArray(),r]),
   ...(data.runtimeDiagonalGripDegrees?{runtimeDiagonalGripDegrees:data.runtimeDiagonalGripDegrees}:{})};
  // Siblings of the greatsword assembly, with its transform, so hiding the
  // greatsword never hides them.
  if(src!==reference){group.position.copy(reference.position);group.quaternion.copy(reference.quaternion);group.scale.copy(reference.scale);}
  group.visible=false;reference.parent.add(group);added.push(group);
 }
 model.updateMatrixWorld(true);
 return added;
}
