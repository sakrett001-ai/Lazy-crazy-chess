import * as THREE from 'three';

// The field and the land around it, generated from one seed. The board is
// ground, not a floor: 64 squares of the same field, light ones of pale
// sand and dry grass, dark ones of turf, divided by trodden joints, with
// hummocks, pebbles and grass, gently rising and falling (ground.mjs keeps
// the relief within what a fencer stands and lunges on). A low kerb of
// rough stone follows the ground round the board; beyond it the land rolls
// away into grassy hills with bare earth, rock outcrops on steep slopes,
// stones and trees. The page carries no image files; a new seed gives a new
// place. The squares are painted on the graphics card (ground-paint.mjs),
// so they stay sharp close up at no texture memory.
//
// Units are metres, the board centre is the origin, y is up; the field's
// height at the centre is 0 and height(x,z) gives it anywhere.

import {createGround,createNoise,rng,smooth} from './ground.mjs';
import {GROUND_VERTEX,GROUND_FRAGMENT,GROUND_FUNCTIONS,GROUND_ROUGHNESS,GROUND_NORMAL} from './ground-paint.mjs';

// A stone surface painted into a canvas: mottled base colour, fine grain,
// a few veins or pores. Used as colour and roughness variation of a slab.
function stoneTexture(seed,base,{veins=0,pores=0,contrast=.12}={}){
 const size=256,c=document.createElement('canvas');c.width=c.height=size;const g=c.getContext('2d'),img=g.createImageData(size,size),n=createNoise(seed),random=rng(seed*7+3);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  // Each slab face shows the whole texture once, so it need not tile.
  const u=x/size*3.2,v=y/size*3.2,warp=n.noise(u*.7+9,v*.7)*.6;
  let k=(n.fbm(u+warp,v-warp,4)*.6+n.fbm(u*5,v*5,3)*.4)*contrast+(random()-.5)*.13;
  if(veins){const vein=Math.abs(n.noise(u*1.6+warp*2,v*.9));if(vein<.05)k-=veins*(1-vein/.05);}
  if(pores&&random()<pores)k-=.12;
  const i=(y*size+x)*4;img.data[i]=Math.max(0,Math.min(255,base[0]*(1+k)*255));img.data[i+1]=Math.max(0,Math.min(255,base[1]*(1+k)*255));img.data[i+2]=Math.max(0,Math.min(255,base[2]*(1+k)*255));img.data[i+3]=255;
 }
 g.putImageData(img,0,0);
 const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=4;return t;
}

export function createLandscape({seed=1,square,squareName}){
 const group=new THREE.Group(),disposables=[],random=rng(seed*9973+17),noise=createNoise(seed),field=createGround({seed,square});
 const own=x=>{disposables.push(x);return x;};
 const half=4*square,kerb=half+.55,line=half+.3;
 const m4=new THREE.Matrix4(),q=new THREE.Quaternion(),e=new THREE.Euler(),p=new THREE.Vector3(),s=new THREE.Vector3(),col=new THREE.Color();

 // Height: the field's relief everywhere, flat trampled ground at the board,
 // rolling hills beyond; outside the kerb the ground is trodden a little
 // lower than the field.
 const tilt=random()*Math.PI*2,valley=[Math.cos(tilt),Math.sin(tilt)];
 function height(x,z){
  const r=Math.max(Math.abs(x),Math.abs(z)),flat=smooth(kerb+.6,kerb+16,r),far=smooth(20,90,Math.hypot(x,z));
  const hills=noise.fbm(x*.018,z*.018,5)*9*flat+noise.ridged(x*.01+3,z*.01-7)*14*far*far;
  // A broad valley on one side keeps a long view open over the field.
  const across=x*valley[1]-z*valley[0],along=x*valley[0]+z*valley[1];
  const cut=-6*far*Math.exp(-(across*across)/(2*30*30))*smooth(0,60,along);
  const bumps=noise.fbm(x*.25,z*.25,3)*.05*flat;
  return field.height(x,z)+hills+cut+bumps-.035*smooth(line,kerb+.4,r);
 }
 function normal(x,z,d=.04){const dx=(height(x+d,z)-height(x-d,z))/(2*d),dz=(height(x,z+d)-height(x,z-d))/(2*d),l=Math.hypot(dx,1,dz);return[-dx/l,1/l,-dz/l];}
 const kerbTop=(x,z)=>height(x,z)+.12;

 // Picking: one invisible box per square, standing on the field.
 const pickGeometry=own(new THREE.BoxGeometry(square,.5,square)),pickMaterial=own(new THREE.MeshBasicMaterial({visible:false}));
 const squares=[];
 for(let f=0;f<8;f++)for(let r=0;r<8;r++){
  const x=(f-3.5)*square,z=(3.5-r)*square,m=new THREE.Mesh(pickGeometry,pickMaterial);
  m.position.set(x,height(x,z),z);m.userData.square=squareName(f,r);group.add(m);squares.push(m);
 }

 // Kerb of rough stone blocks set into the ground round the board; each
 // block follows the ground along its length.
 const kerbMaterial=own(new THREE.MeshStandardMaterial({map:own(stoneTexture(seed*13+5,[.47,.43,.37],{contrast:.3,pores:.02})),roughness:.92}));
 const blocks=[];
 for(let side=0;side<4;side++){
  let along=-kerb;
  while(along<kerb){const length=Math.min(kerb-along,.9+random()*.7);blocks.push({side,along:along+length/2,length,h:.16+random()*.06,w:.52+random()*.08,tilt:(random()-.5)*.03,lean:(random()-.5)*.025});along+=length+.02;}
 }
 const blockGeometry=own(new THREE.BoxGeometry(1,1,1)),kerbMesh=new THREE.InstancedMesh(blockGeometry,kerbMaterial,blocks.length);
 blocks.forEach((b,i)=>{
  const pos=b.side===0?[b.along,-line]:b.side===1?[line,b.along]:b.side===2?[-b.along,line]:[-line,-b.along];
  const yaw=b.side%2?Math.PI/2:0,dir=[Math.cos(yaw),-Math.sin(yaw)];
  const rise=(height(pos[0]+dir[0]*b.length/2,pos[1]+dir[1]*b.length/2)-height(pos[0]-dir[0]*b.length/2,pos[1]-dir[1]*b.length/2))/b.length;
  e.set(b.tilt,yaw,Math.atan(rise)+b.lean);q.setFromEuler(e);p.set(pos[0],height(...pos)+b.h/2-.1,pos[1]);s.set(b.length,b.h,b.w);
  kerbMesh.setMatrixAt(i,m4.compose(p,q,s));
 });
 kerbMesh.castShadow=kerbMesh.receiveShadow=true;group.add(kerbMesh);

 // Terrain: one mesh, dense under the board (12 cm, enough for the
 // hummocks) and coarser with distance, out to the hills.
 const size=220,axis=[0];{let x=0,step=.12;while(x<size/2){x=Math.min(size/2,x+step);axis.push(x);if(x>kerb+1.5)step=Math.min(2.5,step*1.07);}}
 const coords=[...axis.slice(1).reverse().map(v=>-v),...axis],nAxis=coords.length;
 const position=new Float32Array(nAxis*nAxis*3);
 for(let j=0;j<nAxis;j++)for(let i=0;i<nAxis;i++){const k=(j*nAxis+i)*3,x=coords[i],z=coords[j];position[k]=x;position[k+1]=height(x,z);position[k+2]=z;}
 const index=new Uint32Array((nAxis-1)*(nAxis-1)*6);{let k=0;for(let j=0;j<nAxis-1;j++)for(let i=0;i<nAxis-1;i++){const a=j*nAxis+i,b=a+1,c=a+nAxis,d=c+1;index.set([a,c,b,b,c,d],k);k+=6;}}
 const terrainGeometry=own(new THREE.BufferGeometry());terrainGeometry.setAttribute('position',new THREE.BufferAttribute(position,3));terrainGeometry.setIndex(new THREE.BufferAttribute(index,1));
 terrainGeometry.computeVertexNormals();
 const normals=terrainGeometry.attributes.normal,colors=new Float32Array(nAxis*nAxis*3);
 const grassA=new THREE.Color(0x3a4a26),grassB=new THREE.Color(0x56603a),dry=new THREE.Color(0x7c7452),earth=new THREE.Color(0x6b5338),rock=new THREE.Color(0x77736b);
 for(let i=0;i<nAxis*nAxis;i++){
  const x=position[i*3],y=position[i*3+1],z=position[i*3+2],slope=1-normals.getY(i),r=Math.max(Math.abs(x),Math.abs(z));
  col.copy(grassA).lerp(grassB,smooth(-.3,.4,noise.fbm(x*.06+11,z*.06,3)));
  col.lerp(dry,.55*smooth(.1,.5,noise.fbm(x*.03-5,z*.03+2,3))+.25*smooth(4,12,y));
  // Trampled earth around the field where the armies stood.
  const worn=(1-smooth(kerb+.4,kerb+5+2.5*noise.fbm(x*.3,z*.3,2),r))*.9;col.lerp(earth,worn);
  col.lerp(rock,smooth(.18,.38,slope));
  const k=1+(noise.noise(x*1.3,z*1.3))*.06;colors.set([col.r*k,col.g*k,col.b*k],i*3);
 }
 terrainGeometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
 // The squares, their joints and the fine grain of all the ground are
 // painted per pixel (ground-paint.mjs) over the vertex colours.
 const terrainMaterial=own(new THREE.MeshStandardMaterial({vertexColors:true,roughness:.96}));
 const offset=[random()*500,random()*500];
 terrainMaterial.onBeforeCompile=shader=>{
  Object.assign(shader.uniforms,{uSquare:{value:square},uHalf:{value:half},uOffset:{value:new THREE.Vector2(...offset)}});
  shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 vGround;').replace('#include <project_vertex>','#include <project_vertex>\n'+GROUND_VERTEX);
  shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\n'+GROUND_FUNCTIONS).replace('#include <color_fragment>','#include <color_fragment>\n'+GROUND_FRAGMENT)
   .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\n'+GROUND_ROUGHNESS).replace('#include <normal_fragment_maps>','#include <normal_fragment_maps>\n'+GROUND_NORMAL);
 };
 terrainMaterial.customProgramCacheKey=()=>'living-chess-ground';
 const terrain=new THREE.Mesh(terrainGeometry,terrainMaterial);terrain.receiveShadow=true;group.add(terrain);

 // On the board: grass tufts on the turf squares, a few dry ones on the
 // sand, pebbles in the sand and the joints. None in the joints' line or
 // the trampled middle of a square where the figures stand.
 const where=(x,z)=>{const c=field.cell(x,z);if(!c)return null;const ex=Math.min(Math.abs(x-c.center[0]),Math.abs(z-c.center[1])),edge=square/2-Math.max(Math.abs(x-c.center[0]),Math.abs(z-c.center[1]));return{...c,edge,middle:Math.hypot(x-c.center[0],z-c.center[1]),ex};};
 const boardTufts=[],pebbles=[];
 for(let f=0;f<8;f++)for(let r=0;r<8;r++){
  const light=(f+r)%2===1,cx=(f-3.5)*square,cz=(3.5-r)*square;
  for(let i=0,n=light?40:330;i<n;i++){const x=cx+(random()-.5)*square,z=cz+(random()-.5)*square,w=where(x,z);if(!w||w.edge<.09)continue;
   if(w.middle<.4+.5*random())continue;boardTufts.push({x,z,light});}
  for(let i=0,n=light?46:6;i<n;i++){const x=cx+(random()-.5)*square,z=cz+(random()-.5)*square,w=where(x,z);if(!w)continue;pebbles.push({x,z,joint:w.edge<.06});}
  // A few pebbles strewn along the joints.
  for(let i=0;i<10;i++){const t=(random()-.5)*square,side=Math.floor(random()*4),x=cx+(side<2?t:(side===2?-1:1)*square/2),z=cz+(side<2?(side?-1:1)*square/2:t);if(Math.max(Math.abs(x),Math.abs(z))<half)pebbles.push({x,z,joint:true});}
 }
 const scatter=(count,accept)=>{const out=[];for(let tries=0;out.length<count&&tries<count*30;tries++){const x=(random()-.5)*size*.9,z=(random()-.5)*size*.9,r=Math.max(Math.abs(x),Math.abs(z));if(r<kerb+.8)continue;const y=height(x,z);if(accept(x,z,y,r))out.push([x,y,z]);}return out;};
 // Stones: jittered icosahedra, more of them near rock and on the worn ring.
 const stoneGeometry=own(new THREE.IcosahedronGeometry(1,1));{const sp=stoneGeometry.attributes.position;for(let i=0;i<sp.count;i++){const k=.75+random()*.5;sp.setXYZ(i,sp.getX(i)*k,sp.getY(i)*k*.7,sp.getZ(i)*k);}stoneGeometry.computeVertexNormals();}
 const stonePlaces=scatter(260,(x,z,y,r)=>r<kerb+9?random()<.55:random()<.25);
 const stones=new THREE.InstancedMesh(stoneGeometry,own(new THREE.MeshStandardMaterial({color:0x8a857b,roughness:.9,flatShading:true})),stonePlaces.length);
 stonePlaces.forEach(([x,y,z],i)=>{const k=.08+random()**3*(Math.hypot(x,z)>30?1.6:.45);e.set(random()*3,random()*3,random()*3);q.setFromEuler(e);p.set(x,y+k*.15,z);s.set(k*(1+random()),k,k*(1+random()));stones.setMatrixAt(i,m4.compose(p,q,s));col.setHSL(.09,.06+random()*.06,.38+random()*.2);stones.setColorAt(i,col);});
 stones.castShadow=stones.receiveShadow=true;group.add(stones);
 // Pebbles of the field: small, flat, half sunk into the ground.
 const pebbleGeometry=own(new THREE.IcosahedronGeometry(1,0));
 const pebbleMesh=new THREE.InstancedMesh(pebbleGeometry,own(new THREE.MeshStandardMaterial({roughness:.85,flatShading:true})),Math.max(1,pebbles.length));
 pebbles.forEach(({x,z,joint},i)=>{const k=(joint?.012:.009)+random()**2*.026;e.set(random()*.4,random()*6.3,random()*.4);q.setFromEuler(e);p.set(x,height(x,z)-k*.12,z);s.set(k*(1+random()*.6),k*.42,k*(1+random()*.6));pebbleMesh.setMatrixAt(i,m4.compose(p,q,s));col.setHSL(.07+random()*.05,.06+random()*.08,.16+random()*.18);pebbleMesh.setColorAt(i,col);});
 pebbleMesh.count=pebbles.length;pebbleMesh.receiveShadow=true;group.add(pebbleMesh);
 // Grass tufts: clusters of thin blades, denser away from the trampled ring.
 const blade=own(new THREE.ConeGeometry(.035,1,3,1,true));blade.translate(0,.5,0);
 const tuftGeometry=own(mergeBlades(blade,7,random));
 const tuftPlaces=scatter(2600,(x,z,y,r)=>{const worn=1-smooth(kerb+1,kerb+6,r);return random()>worn*.85&&y<11;});
 const tufts=new THREE.InstancedMesh(tuftGeometry,own(new THREE.MeshStandardMaterial({color:0x4f5a2c,roughness:.9,side:THREE.DoubleSide})),tuftPlaces.length);
 tuftPlaces.forEach(([x,y,z],i)=>{const k=.22+random()*.3;e.set((random()-.5)*.2,random()*6.3,(random()-.5)*.2);q.setFromEuler(e);p.set(x,y-.02,z);s.set(k*1.4,k,k*1.4);tufts.setMatrixAt(i,m4.compose(p,q,s));col.setRGB(.75+.5*random(),.8+.4*random(),.7+.4*random());tufts.setColorAt(i,col);});
 tufts.receiveShadow=true;group.add(tufts);
 // The board's grass: short tufts, green on the turf, straw on the sand.
 const fieldTufts=new THREE.InstancedMesh(tuftGeometry,own(new THREE.MeshStandardMaterial({color:0xffffff,roughness:.85,side:THREE.DoubleSide,vertexColors:true})),Math.max(1,boardTufts.length));
 boardTufts.forEach(({x,z,light},i)=>{const k=light?.05+random()*.06:.06+random()**1.5*.11;e.set((random()-.5)*.25,random()*6.3,(random()-.5)*.25);q.setFromEuler(e);p.set(x,height(x,z)-.006,z);s.set(k*1.6,k,k*1.6);fieldTufts.setMatrixAt(i,m4.compose(p,q,s));
  if(light)col.setRGB(.26+.08*random(),.21+.06*random(),.08+.03*random());else col.setRGB(.045+.03*random(),.075+.04*random(),.022+.015*random());fieldTufts.setColorAt(i,col);});
 fieldTufts.count=boardTufts.length;fieldTufts.receiveShadow=true;group.add(fieldTufts);
 // Trees: pines (stacked tapering cones) and broadleaf trees (several
 // jittered leaf clumps), on the hills and never close to the board.
 const treePlaces=scatter(90,(x,z,y,r)=>r>24&&y>-.5&&noise.fbm(x*.02+40,z*.02,3)>-.08);
 const jitter=(g,amount)=>{const gp=g.attributes.position;for(let i=0;i<gp.count;i++)gp.setXYZ(i,gp.getX(i)*(1+(random()-.5)*amount),gp.getY(i)*(1+(random()-.5)*amount*.6),gp.getZ(i)*(1+(random()-.5)*amount));g.computeVertexNormals();return g;};
 const trunk=new THREE.InstancedMesh(own(new THREE.CylinderGeometry(.12,.24,1,7)),own(new THREE.MeshStandardMaterial({color:0x3d2c20,roughness:1})),treePlaces.length);
 const needle=own(jitter(new THREE.ConeGeometry(1,1.6,9,2),.25)),leaf=own(jitter(new THREE.IcosahedronGeometry(1,2),.35));
 const pines=treePlaces.map(()=>random()<.55);
 const nPine=pines.filter(Boolean).length*4,nLeaf=pines.filter(x=>!x).length*5;
 const pineCrowns=new THREE.InstancedMesh(needle,own(new THREE.MeshStandardMaterial({color:0x1d3321,roughness:.95})),Math.max(1,nPine));
 const leafCrowns=new THREE.InstancedMesh(leaf,own(new THREE.MeshStandardMaterial({color:0x34421f,roughness:.92})),Math.max(1,nLeaf));
 let ip=0,il=0;
 treePlaces.forEach(([x,y,z],i)=>{
  const pine=pines[i],h=pine?7+random()*7:4.5+random()*4;q.identity();p.set(x,y+h*(pine?.3:.25),z);s.set(1+h*.04,h*(pine?.6:.5),1+h*.04);trunk.setMatrixAt(i,m4.compose(p,q,s));
  if(pine)for(let j=0;j<4;j++){const k=(1.25-j*.24)*h/7.5;e.set(0,random()*6,0);q.setFromEuler(e);p.set(x,y+h*(.32+j*.17),z);s.set(k*1.6,k*1.25,k*1.6);pineCrowns.setMatrixAt(ip,m4.compose(p,q,s));col.setRGB(.8+.35*random(),.85+.3*random(),.8+.3*random());pineCrowns.setColorAt(ip++,col);}
  else for(let j=0;j<5;j++){const k=(.55+random()*.45)*h/4.2,a=random()*6.3,d=j?h*.16:0;e.set(random(),random()*6,random());q.setFromEuler(e);p.set(x+Math.cos(a)*d,y+h*(.62+random()*.2)+(j?0:h*.12),z+Math.sin(a)*d);s.set(k,k*.82,k);leafCrowns.setMatrixAt(il,m4.compose(p,q,s));col.setRGB(.75+.5*random(),.8+.4*random(),.75+.35*random());leafCrowns.setColorAt(il++,col);}
 });
 pineCrowns.count=ip;leafCrowns.count=il;
 trunk.castShadow=pineCrowns.castShadow=leafCrowns.castShadow=true;group.add(trunk,pineCrowns,leafCrowns);

 // Sky: vertical gradient on a large inverted sphere, matched by the fog.
 const sky=new THREE.Mesh(own(new THREE.SphereGeometry(400,32,16)),own(new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,fog:false,uniforms:{top:{value:new THREE.Color(0x6f9fd0)},horizon:{value:new THREE.Color(0xd8e2e6)},ground:{value:new THREE.Color(0xa8ab9a)}},
  vertexShader:'varying vec3 vDir;void main(){vDir=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader:'uniform vec3 top,horizon,ground;varying vec3 vDir;void main(){float h=vDir.y;vec3 c=h>0.?mix(horizon,top,pow(smoothstep(0.,.55,h),.7)):mix(horizon,ground,smoothstep(0.,-.2,h));gl_FragColor=vec4(c,1.);}'})));
 group.add(sky);

 return{group,squares,height,normal,kerbTop,field,seed,trees:treePlaces,fog:0xd8e2e6,dispose(){group.removeFromParent();for(const d of disposables)d.dispose?.();for(const o of [kerbMesh,stones,tufts,trunk,pineCrowns,leafCrowns,pebbleMesh,fieldTufts])o.dispose();}};
}

// Seven blades of one tuft in one geometry, leaning outwards.
function mergeBlades(blade,count,random){
 const parts=[];
 for(let i=0;i<count;i++){const g=blade.clone(),a=i/count*Math.PI*2+random(),lean=.15+random()*.3,h=.6+random()*.5;
  g.scale(1,h,1);g.rotateZ(lean);g.rotateY(a);g.translate(Math.cos(a)*.04,0,Math.sin(a)*.04);parts.push(g);}
 const position=[],normal=[];
 for(const g of parts){const ng=g.toNonIndexed();position.push(...ng.attributes.position.array);normal.push(...ng.attributes.normal.array);ng.dispose();g.dispose();}
 const out=new THREE.BufferGeometry();out.setAttribute('position',new THREE.Float32BufferAttribute(position,3));out.setAttribute('normal',new THREE.Float32BufferAttribute(normal,3));
 // Darker at the root, where the blades shade each other.
 const color=new Float32Array(position.length);for(let i=0;i<position.length;i+=3){const k=.4+.6*Math.min(1,Math.max(0,position[i+1]/.8));color[i]=color[i+1]=color[i+2]=k;}
 out.setAttribute('color',new THREE.Float32BufferAttribute(color,3));return out;
}
