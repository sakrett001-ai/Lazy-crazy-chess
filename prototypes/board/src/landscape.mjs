import * as THREE from 'three';

// The field around the board: a generated landscape that keeps the chess
// squares readable. The 64 squares are stone slabs (pale limestone, dark
// basalt) laid on a gravel bed inside a kerb; around them the ground rolls
// away into grassy hills with bare earth, rock outcrops on steep slopes,
// stones, grass tufts and a few trees. Everything is procedural from one
// seed, so the page carries no image files; a new seed gives a new place.
//
// Units are metres, the board centre is the origin and the slab tops are at
// y = 0, so figures keep standing on the board exactly as before.

function rng(seed){let s=seed>>>0||1;return()=>{s^=s<<13;s^=s>>>17;s^=s<<5;return(s>>>0)/4294967296;};}

// Gradient noise on a lattice, smooth fractal sums of it.
function createNoise(seed){
 const random=rng(seed),perm=new Uint16Array(512),gx=new Float32Array(256),gy=new Float32Array(256);
 const p=[...Array(256).keys()];for(let i=255;i>0;i--){const j=Math.floor(random()*(i+1));[p[i],p[j]]=[p[j],p[i]];}
 for(let i=0;i<512;i++)perm[i]=p[i&255];
 for(let i=0;i<256;i++){const a=random()*Math.PI*2;gx[i]=Math.cos(a);gy[i]=Math.sin(a);}
 const fade=t=>t*t*t*(t*(t*6-15)+10);
 function noise(x,y){
  const xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi,X=xi&255,Y=yi&255;
  const g=(i,j,dx,dy)=>{const h=perm[perm[X+i]+Y+j];return gx[h]*dx+gy[h]*dy;};
  const u=fade(xf),v=fade(yf);
  const a=g(0,0,xf,yf)+(g(1,0,xf-1,yf)-g(0,0,xf,yf))*u,b=g(0,1,xf,yf-1)+(g(1,1,xf-1,yf-1)-g(0,1,xf,yf-1))*u;
  return(a+(b-a)*v)*1.41;
 }
 const fbm=(x,y,octaves=5)=>{let sum=0,amp=.5,freq=1;for(let i=0;i<octaves;i++){sum+=amp*noise(x*freq,y*freq);freq*=2.03;amp*=.5;}return sum;};
 // Ridged noise for rocky crests.
 const ridged=(x,y)=>{let sum=0,amp=.5,freq=1;for(let i=0;i<4;i++){sum+=amp*(1-Math.abs(noise(x*freq,y*freq)));freq*=2.1;amp*=.5;}return sum;};
 return{noise,fbm,ridged};
}

const smooth=(a,b,x)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};

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
 const group=new THREE.Group(),disposables=[],random=rng(seed*9973+17),noise=createNoise(seed);
 const own=x=>{disposables.push(x);return x;};
 const half=4*square,kerb=half+.55;

 // Slabs: four textures per colour so neighbours of one colour differ.
 const light=[0,1,2,3].map(i=>own(new THREE.MeshStandardMaterial({map:own(stoneTexture(seed*31+i,[.80,.74,.62],{veins:.12,contrast:.34,pores:.004})),roughness:.78})));
 const dark=[0,1,2,3].map(i=>own(new THREE.MeshStandardMaterial({map:own(stoneTexture(seed*57+i,[.24,.23,.22],{pores:.02,contrast:.42})),roughness:.62,metalness:.02})));
 const slabGeometry=own(new THREE.BoxGeometry(square*.965,.16,square*.965,1,1,1));
 const squares=[];
 for(let f=0;f<8;f++)for(let r=0;r<8;r++){
  const name=squareName(f,r),x=(f-3.5)*square,z=(3.5-r)*square,isLight=(f+r)%2===1;
  const m=new THREE.Mesh(slabGeometry,(isLight?light:dark)[Math.floor(random()*4)]);
  m.position.set(x,-.08,z);m.rotation.y=(random()-.5)*.012;m.receiveShadow=true;m.userData.square=name;group.add(m);squares.push(m);
 }
 // Gravel bed in the joints and a kerb of rough stone blocks.
 const bed=new THREE.Mesh(own(new THREE.BoxGeometry(2*half+.12,.2,2*half+.12)),own(new THREE.MeshStandardMaterial({color:0x5a5047,roughness:1})));bed.position.y=-.115;bed.receiveShadow=true;group.add(bed);
 const kerbMaterial=own(new THREE.MeshStandardMaterial({map:own(stoneTexture(seed*13+5,[.47,.43,.37],{contrast:.3,pores:.02})),roughness:.92}));
 const blocks=[];
 for(let side=0;side<4;side++){
  let along=-kerb;
  while(along<kerb){const length=Math.min(kerb-along,.9+random()*.7);blocks.push({side,along:along+length/2,length,h:.16+random()*.06,w:.52+random()*.08,tilt:(random()-.5)*.03});along+=length+.02;}
 }
 const blockGeometry=own(new THREE.BoxGeometry(1,1,1)),kerbMesh=new THREE.InstancedMesh(blockGeometry,kerbMaterial,blocks.length),m4=new THREE.Matrix4(),q=new THREE.Quaternion(),e=new THREE.Euler(),p=new THREE.Vector3(),s=new THREE.Vector3();
 blocks.forEach((b,i)=>{
  const off=half+.3,pos=b.side===0?[b.along,-off]:b.side===1?[off,b.along]:b.side===2?[-b.along,off]:[-off,-b.along];
  e.set(b.tilt,b.side%2?Math.PI/2:0,b.tilt*.6);q.setFromEuler(e);p.set(pos[0],b.h/2-.17,pos[1]);s.set(b.length,b.h,b.w);
  kerbMesh.setMatrixAt(i,m4.compose(p,q,s));
 });
 kerbMesh.castShadow=kerbMesh.receiveShadow=true;group.add(kerbMesh);

 // Terrain: flat trampled ground at the board, rolling hills beyond.
 const size=220,segments=220,terrainGeometry=own(new THREE.PlaneGeometry(size,size,segments,segments));terrainGeometry.rotateX(-Math.PI/2);
 const tilt=random()*Math.PI*2,valley=[Math.cos(tilt),Math.sin(tilt)];
 function height(x,z){
  const r=Math.max(Math.abs(x),Math.abs(z)),flat=smooth(kerb+.6,kerb+16,r),far=smooth(20,90,Math.hypot(x,z));
  const hills=noise.fbm(x*.018,z*.018,5)*9*flat+noise.ridged(x*.01+3,z*.01-7)*14*far*far;
  // A broad valley on one side keeps a long view open over the field.
  const across=x*valley[1]-z*valley[0],along=x*valley[0]+z*valley[1];
  const cut=-6*far*Math.exp(-(across*across)/(2*30*30))*smooth(0,60,along);
  const bumps=noise.fbm(x*.25,z*.25,3)*.05*flat+noise.fbm(x*.7,z*.7,2)*.015;
  return -.2+hills+cut+bumps;
 }
 const position=terrainGeometry.attributes.position,colors=new Float32Array(position.count*3);
 for(let i=0;i<position.count;i++){const x=position.getX(i),z=position.getZ(i);position.setY(i,height(x,z));}
 terrainGeometry.computeVertexNormals();
 const normal=terrainGeometry.attributes.normal,col=new THREE.Color();
 const grassA=new THREE.Color(0x3a4a26),grassB=new THREE.Color(0x56603a),dry=new THREE.Color(0x7c7452),earth=new THREE.Color(0x6b5338),rock=new THREE.Color(0x77736b);
 for(let i=0;i<position.count;i++){
  const x=position.getX(i),z=position.getZ(i),y=position.getY(i),slope=1-normal.getY(i),r=Math.max(Math.abs(x),Math.abs(z));
  col.copy(grassA).lerp(grassB,smooth(-.3,.4,noise.fbm(x*.06+11,z*.06,3)));
  col.lerp(dry,.55*smooth(.1,.5,noise.fbm(x*.03-5,z*.03+2,3))+.25*smooth(4,12,y));
  // Trampled earth around the field where the armies stood.
  const worn=(1-smooth(kerb+.4,kerb+5+2.5*noise.fbm(x*.3,z*.3,2),r))*.9;col.lerp(earth,worn);
  col.lerp(rock,smooth(.18,.38,slope));
  const k=1+(noise.noise(x*1.3,z*1.3))*.06;colors.set([col.r*k,col.g*k,col.b*k],i*3);
 }
 terrainGeometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
 const terrain=new THREE.Mesh(terrainGeometry,own(new THREE.MeshStandardMaterial({vertexColors:true,roughness:.96})));terrain.receiveShadow=true;group.add(terrain);

 const scatter=(count,accept)=>{const out=[];for(let tries=0;out.length<count&&tries<count*30;tries++){const x=(random()-.5)*size*.9,z=(random()-.5)*size*.9,r=Math.max(Math.abs(x),Math.abs(z));if(r<kerb+.8)continue;const y=height(x,z);if(accept(x,z,y,r))out.push([x,y,z]);}return out;};
 // Stones: jittered icosahedra, more of them near rock and on the worn ring.
 const stoneGeometry=own(new THREE.IcosahedronGeometry(1,1));{const sp=stoneGeometry.attributes.position;for(let i=0;i<sp.count;i++){const k=.75+random()*.5;sp.setXYZ(i,sp.getX(i)*k,sp.getY(i)*k*.7,sp.getZ(i)*k);}stoneGeometry.computeVertexNormals();}
 const stonePlaces=scatter(260,(x,z,y,r)=>r<kerb+9?random()<.55:random()<.25);
 const stones=new THREE.InstancedMesh(stoneGeometry,own(new THREE.MeshStandardMaterial({color:0x8a857b,roughness:.9,flatShading:true})),stonePlaces.length);
 stonePlaces.forEach(([x,y,z],i)=>{const k=.08+random()**3*(Math.hypot(x,z)>30?1.6:.45);e.set(random()*3,random()*3,random()*3);q.setFromEuler(e);p.set(x,y+k*.15,z);s.set(k*(1+random()),k,k*(1+random()));stones.setMatrixAt(i,m4.compose(p,q,s));col.setHSL(.09,.06+random()*.06,.38+random()*.2);stones.setColorAt(i,col);});
 stones.castShadow=stones.receiveShadow=true;group.add(stones);
 // Grass tufts: clusters of thin blades, denser away from the trampled ring.
 const blade=own(new THREE.ConeGeometry(.035,1,3,1,true));blade.translate(0,.5,0);
 const tuftGeometry=own(mergeBlades(blade,7,random));
 const tuftPlaces=scatter(2600,(x,z,y,r)=>{const worn=1-smooth(kerb+1,kerb+6,r);return random()>worn*.85&&y<11;});
 const tufts=new THREE.InstancedMesh(tuftGeometry,own(new THREE.MeshStandardMaterial({color:0x4f5a2c,roughness:.9,side:THREE.DoubleSide})),tuftPlaces.length);
 tuftPlaces.forEach(([x,y,z],i)=>{const k=.22+random()*.3;e.set((random()-.5)*.2,random()*6.3,(random()-.5)*.2);q.setFromEuler(e);p.set(x,y-.02,z);s.set(k*1.4,k,k*1.4);tufts.setMatrixAt(i,m4.compose(p,q,s));col.setRGB(.75+.5*random(),.8+.4*random(),.7+.4*random());tufts.setColorAt(i,col);});
 tufts.receiveShadow=true;group.add(tufts);
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

 return{group,squares,height,seed,trees:treePlaces,fog:0xd8e2e6,dispose(){group.removeFromParent();for(const d of disposables)d.dispose?.();for(const o of [kerbMesh,stones,tufts,trunk,pineCrowns,leafCrowns])o.dispose();}};
}

// Seven blades of one tuft in one geometry, leaning outwards.
function mergeBlades(blade,count,random){
 const parts=[];
 for(let i=0;i<count;i++){const g=blade.clone(),a=i/count*Math.PI*2+random(),lean=.15+random()*.3,h=.6+random()*.5;
  g.scale(1,h,1);g.rotateZ(lean);g.rotateY(a);g.translate(Math.cos(a)*.04,0,Math.sin(a)*.04);parts.push(g);}
 const position=[],normal=[];
 for(const g of parts){const ng=g.toNonIndexed();position.push(...ng.attributes.position.array);normal.push(...ng.attributes.normal.array);ng.dispose();g.dispose();}
 const out=new THREE.BufferGeometry();out.setAttribute('position',new THREE.Float32BufferAttribute(position,3));out.setAttribute('normal',new THREE.Float32BufferAttribute(normal,3));return out;
}
