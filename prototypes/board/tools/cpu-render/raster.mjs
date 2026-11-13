// A software renderer for a three.js scene: no GPU, no WebGL, no browser.
// It reads the scene graph as three.js leaves it after a frame (skinned and
// morphed meshes, instanced meshes, groups, visibility, materials, lights)
// and draws it with a z-buffer on the CPU, so motion can be watched where
// the machine has no graphics card. The skinning is three.js's own maths
// (bone matrices × bind matrices, morph targets added first), so every
// vertex stands where the browser would put it.
//
// What it draws: opaque surfaces (with near-plane clipping and back-face
// culling), alpha-tested textures, transparent surfaces blended on top,
// one directional shadow map with PCF, hemisphere and directional light,
// a rough stand-in for the environment map, linear fog, ACES tone mapping
// and sRGB output. What it skips: ShaderMaterial and custom GLSL (a
// material can name a CPU replacement in options.paint), normal maps,
// post-processing. It is meant for checking motion, not for final pictures.
//
//   const r=createRasterizer(THREE,{width:1280,height:720,ssaa:2});
//   r.render(scene,camera,{shadow:{center,halfSize}}) → {rgb:Uint8Array,width,height}

export function createRasterizer(THREE,options={}){
 const W=options.width||1280,H=options.height||720,SS=Math.max(1,options.ssaa||1),RW=W*SS,RH=H*SS;
 const depth=new Float32Array(RW*RH),gItem=new Int32Array(RW*RH),gTri=new Int32Array(RW*RH),gB0=new Float32Array(RW*RH),gB1=new Float32Array(RW*RH);
 const color=new Float32Array(RW*RH*3);
 const SHADOW=options.shadowSize||2048,shadowDepth=new Float32Array(SHADOW*SHADOW);
 const exposure=options.exposure??1.02,envIntensity=options.envIntensity??.55,paint=options.paint||{};
 const statics=new Map(); // world arrays of meshes that did not move since the last frame
 const srgbLut=new Float32Array(256);for(let i=0;i<256;i++){const c=i/255;srgbLut[i]=c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4);}
 const v3=new THREE.Vector3(),m4=new THREE.Matrix4(),m4b=new THREE.Matrix4(),nm=new THREE.Matrix3();

 // ---- textures: the decoded RGBA of an image, wherever three keeps it ----
 const texData=tex=>{const img=tex?.image;if(!img)return null;
  if(img._rgba)return{data:img._rgba,width:img.width,height:img.height};
  if(img.data&&img.width&&img.height&&img.data.length>=img.width*img.height*4)return{data:img.data,width:img.width,height:img.height};
  return null;};
 function sampler(tex,linearize){const d=texData(tex);if(!d)return null;
  if(tex.matrixAutoUpdate)tex.updateMatrix();const e=tex.matrix.elements,flip=tex.flipY,repeat=tex.wrapS===THREE.RepeatWrapping,{data,width,height}=d;
  const srgb=linearize&&tex.colorSpace===THREE.SRGBColorSpace;
  return(u,v,out)=>{let x=e[0]*u+e[3]*v+e[6],y=e[1]*u+e[4]*v+e[7];
   if(repeat){x-=Math.floor(x);y-=Math.floor(y);}else{x=x<0?0:x>1?1:x;y=y<0?0:y>1?1:y;}
   const px=Math.min(width-1,(x*width)|0),py=Math.min(height-1,((flip?1-y:y)*height)|0),i=(py*width+px)*4;
   if(srgb){out[0]=srgbLut[data[i]];out[1]=srgbLut[data[i+1]];out[2]=srgbLut[data[i+2]];}else{out[0]=data[i]/255;out[1]=data[i+1]/255;out[2]=data[i+2]/255;}
   out[3]=data[i+3]/255;return out;};}
 const samplers=new WeakMap();
 function materialInfo(mat){let s=samplers.get(mat);if(s&&s.version===mat.version)return s;
  const map=mat.map?sampler(mat.map,true):null;
  s={version:mat.version,map,
   alphaTest:map&&(mat.alphaTest>0||mat.transparent)?Math.max(mat.alphaTest||0,.5):0,
   blend:mat.transparent&&(mat.opacity??1)<.99,
   unlit:mat.isMeshBasicMaterial,paint:mat.customProgramCacheKey&&paint[mat.customProgramCacheKey()]||null,
   skip:!mat.visible||mat.isShaderMaterial||mat.isRawShaderMaterial||mat.isShadowMaterial||mat.colorWrite===false||(mat.transparent&&mat.opacity<.02)||(mat.map&&!map&&mat.transparent)};
  samplers.set(mat,s);return s;}

 // ---- scene → world-space triangle soups ----
 function visibleChain(o){for(let p=o;p;p=p.parent)if(!p.visible)return false;return true;}
 function worldArrays(mesh,instance){
  const g=mesh.geometry,pos=g.attributes.position,nrm=g.attributes.normal,n=pos.count;
  const P=new Float32Array(n*3),N=new Float32Array(n*3);
  let world=mesh.matrixWorld;if(instance!==undefined){mesh.getMatrixAt(instance,m4);world=m4b.multiplyMatrices(mesh.matrixWorld,m4);}
  const we=world.elements;nm.getNormalMatrix(world);const ne=nm.elements;
  const morphs=g.morphAttributes.position,infl=mesh.morphTargetInfluences,relative=g.morphTargetsRelative;
  const skinned=mesh.isSkinnedMesh,si=skinned&&g.attributes.skinIndex,sw=skinned&&g.attributes.skinWeight;
  let bm=null,bind=null,bindInv=null;
  if(skinned){mesh.skeleton.update();bm=mesh.skeleton.boneMatrices;bind=mesh.bindMatrix.elements;bindInv=mesh.bindMatrixInverse.elements;}
  const blend=new Float64Array(16);
  for(let i=0;i<n;i++){
   let x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i),nx=nrm?nrm.getX(i):0,ny=nrm?nrm.getY(i):1,nz=nrm?nrm.getZ(i):0;
   if(morphs&&infl){let sx=0,sy=0,sz=0,sum=0;for(let k=0;k<morphs.length;k++){const w=infl[k];if(!w)continue;const a=morphs[k];
     if(relative){sx+=a.getX(i)*w;sy+=a.getY(i)*w;sz+=a.getZ(i)*w;}else{sx+=(a.getX(i)-x)*w;sy+=(a.getY(i)-y)*w;sz+=(a.getZ(i)-z)*w;}sum+=w;}
    x+=sx;y+=sy;z+=sz;}
   if(skinned){
    // three.js: bindMatrixInverse · Σ wᵢ · boneMatrixᵢ · bindMatrix · v
    blend.fill(0);
    for(let k=0;k<4;k++){const w=sw.getComponent(i,k);if(!w)continue;const b=si.getComponent(i,k)*16;for(let j=0;j<16;j++)blend[j]+=bm[b+j]*w;}
    const bx=bind[0]*x+bind[4]*y+bind[8]*z+bind[12],by=bind[1]*x+bind[5]*y+bind[9]*z+bind[13],bz=bind[2]*x+bind[6]*y+bind[10]*z+bind[14];
    const sx=blend[0]*bx+blend[4]*by+blend[8]*bz+blend[12],sy=blend[1]*bx+blend[5]*by+blend[9]*bz+blend[13],sz=blend[2]*bx+blend[6]*by+blend[10]*bz+blend[14];
    x=bindInv[0]*sx+bindInv[4]*sy+bindInv[8]*sz+bindInv[12];y=bindInv[1]*sx+bindInv[5]*sy+bindInv[9]*sz+bindInv[13];z=bindInv[2]*sx+bindInv[6]*sy+bindInv[10]*sz+bindInv[14];
    const tx=blend[0]*nx+blend[4]*ny+blend[8]*nz,ty=blend[1]*nx+blend[5]*ny+blend[9]*nz,tz=blend[2]*nx+blend[6]*ny+blend[10]*nz;nx=tx;ny=ty;nz=tz;}
   P[i*3]=we[0]*x+we[4]*y+we[8]*z+we[12];P[i*3+1]=we[1]*x+we[5]*y+we[9]*z+we[13];P[i*3+2]=we[2]*x+we[6]*y+we[10]*z+we[14];
   let qx=ne[0]*nx+ne[3]*ny+ne[6]*nz,qy=ne[1]*nx+ne[4]*ny+ne[7]*nz,qz=ne[2]*nx+ne[5]*ny+ne[8]*nz;const l=Math.hypot(qx,qy,qz)||1;
   N[i*3]=qx/l;N[i*3+1]=qy/l;N[i*3+2]=qz/l;}
  return{P,N};}
 function collect(scene){
  scene.updateMatrixWorld(true);const items=[];
  scene.traverse(o=>{
   if(!(o.isMesh||o.isSkinnedMesh)||!o.geometry?.attributes?.position||!visibleChain(o))return;
   const g=o.geometry,mats=Array.isArray(o.material)?o.material:[o.material];
   if(mats.every(m=>materialInfo(m).skip))return;
   const index=g.index?g.index.array:null,count=g.index?g.index.count:g.attributes.position.count;
   const start=g.drawRange.start,end=Math.min(count,start+g.drawRange.count);
   const groups=g.groups.length&&Array.isArray(o.material)?g.groups.map(gr=>({start:Math.max(gr.start,start),end:Math.min(gr.start+gr.count,end),material:o.material[gr.materialIndex]})):[{start,end,material:mats[0]}];
   const uv=g.attributes.uv||null,vc=g.attributes.color||null;
   const instances=o.isInstancedMesh?o.count:1;
   const moving=o.isSkinnedMesh||(g.morphAttributes.position&&o.morphTargetInfluences?.some(Boolean));
   for(let k=0;k<instances;k++){
    const key=o.uuid+':'+k,inst=o.isInstancedMesh?k:undefined;let arrays;
    const stamp=moving?null:o.matrixWorld.elements.join(',')+(o.isInstancedMesh?':'+o.instanceMatrix.version:'')+':'+g.attributes.position.version;
    const cached=stamp&&statics.get(key);
    if(cached&&cached.stamp===stamp)arrays=cached.arrays;else{arrays=worldArrays(o,inst);if(stamp)statics.set(key,{stamp,arrays});}
    let tint=null;if(o.isInstancedMesh&&o.instanceColor){const c=new THREE.Color();o.getColorAt(k,c);tint=[c.r,c.g,c.b];}
    items.push({mesh:o,P:arrays.P,N:arrays.N,uv,vc,index,groups,tint,castShadow:o.castShadow});}
  });
  return items;}

 // ---- lights ----
 function lights(scene){const out={hemi:[],dir:[]};
  scene.traverse(o=>{if(!o.visible)return;
   if(o.isHemisphereLight)out.hemi.push({sky:o.color.clone().multiplyScalar(o.intensity),ground:o.groundColor.clone().multiplyScalar(o.intensity)});
   if(o.isDirectionalLight){const d=new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).sub(new THREE.Vector3().setFromMatrixPosition(o.target.matrixWorld)).normalize();
    out.dir.push({dir:d,color:o.color.clone().multiplyScalar(o.intensity),shadow:o.castShadow,light:o});}});
  return out;}

 // ---- shadow map: depth of the casters seen from the key light ----
 let shadowState=null;
 function buildShadow(items,light,center,half){
  const dir=light.dir,up=Math.abs(dir.y)>.99?new THREE.Vector3(1,0,0):new THREE.Vector3(0,1,0);
  const zA=dir.clone(),xA=new THREE.Vector3().crossVectors(up,zA).normalize(),yA=new THREE.Vector3().crossVectors(zA,xA);
  shadowDepth.fill(Infinity);const S=SHADOW,k=S/(2*half);
  const proj=(x,y,z)=>{const dx=x-center.x,dy=y-center.y,dz=z-center.z;return[(dx*xA.x+dy*xA.y+dz*xA.z)*k+S/2,(-(dx*yA.x+dy*yA.y+dz*yA.z))*k+S/2,-(dx*zA.x+dy*zA.y+dz*zA.z)];};
  for(const it of items){if(!it.castShadow)continue;const P=it.P,n=P.length/3,sx=new Float32Array(n),sy=new Float32Array(n),sz=new Float32Array(n);
   for(let i=0;i<n;i++){const p=proj(P[i*3],P[i*3+1],P[i*3+2]);sx[i]=p[0];sy[i]=p[1];sz[i]=p[2];}
   for(const gr of it.groups){if(materialInfo(gr.material).skip||materialInfo(gr.material).blend)continue;
    for(let t=gr.start;t+2<gr.end;t+=3){const a=it.index?it.index[t]:t,b=it.index?it.index[t+1]:t+1,c=it.index?it.index[t+2]:t+2;
     depthTri(sx[a],sy[a],sz[a],sx[b],sy[b],sz[b],sx[c],sy[c],sz[c]);}}}
  shadowState={proj,k,S};}
 function depthTri(x0,y0,z0,x1,y1,z1,x2,y2,z2){const S=SHADOW;
  let minX=Math.max(0,Math.floor(Math.min(x0,x1,x2))),maxX=Math.min(S-1,Math.ceil(Math.max(x0,x1,x2))),minY=Math.max(0,Math.floor(Math.min(y0,y1,y2))),maxY=Math.min(S-1,Math.ceil(Math.max(y0,y1,y2)));
  if(minX>maxX||minY>maxY)return;const area=(x1-x0)*(y2-y0)-(x2-x0)*(y1-y0);if(Math.abs(area)<1e-9)return;const ia=1/area;
  for(let y=minY;y<=maxY;y++){const py=y+.5;for(let x=minX;x<=maxX;x++){const px=x+.5;
   const w0=((x1-px)*(y2-py)-(x2-px)*(y1-py))*ia,w1=((x2-px)*(y0-py)-(x0-px)*(y2-py))*ia,w2=1-w0-w1;if(w0<0||w1<0||w2<0)continue;
   const z=w0*z0+w1*z1+w2*z2,i=y*S+x;if(z<shadowDepth[i])shadowDepth[i]=z;}}}
 function lit(x,y,z,bias){if(!shadowState)return 1;const p=shadowState.proj(x,y,z),S=shadowState.S;let sum=0,n=0;
  for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const sx=(p[0]+dx)|0,sy=(p[1]+dy)|0;n++;if(sx<0||sy<0||sx>=S||sy>=S){sum++;continue;}if(p[2]-bias<=shadowDepth[sy*S+sx])sum++;}
  return sum/n;}

 // ---- main pass: visibility buffer, then one shading per pixel ----
 function render(scene,camera,opts={}){
  if(scene.matrixWorldAutoUpdate!==false)scene.updateMatrixWorld();
  camera.aspect=W/H;camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
  const items=collect(scene),L=lights(scene);
  const key=L.dir.find(d=>d.shadow);shadowState=null;
  if(key&&opts.shadow!==false){const s=opts.shadow||{};buildShadow(items,key,s.center||new THREE.Vector3(),s.halfSize||14);}
  const vp=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse).elements;
  depth.fill(Infinity);gItem.fill(-1);
  const near=camera.near;
  items.forEach((it,ii)=>{
   const P=it.P,n=P.length/3,cx=new Float32Array(n),cy=new Float32Array(n),cz=new Float32Array(n),cw=new Float32Array(n);
   for(let i=0;i<n;i++){const x=P[i*3],y=P[i*3+1],z=P[i*3+2];cx[i]=vp[0]*x+vp[4]*y+vp[8]*z+vp[12];cy[i]=vp[1]*x+vp[5]*y+vp[9]*z+vp[13];cz[i]=vp[2]*x+vp[6]*y+vp[10]*z+vp[14];cw[i]=vp[3]*x+vp[7]*y+vp[11]*z+vp[15];}
   it.clip={cx,cy,cz,cw};
   for(const gr of it.groups){const mi=materialInfo(gr.material);if(mi.skip||mi.blend)continue;const side=gr.material.side;
    for(let t=gr.start;t+2<gr.end;t+=3){const a=it.index?it.index[t]:t,b=it.index?it.index[t+1]:t+1,c=it.index?it.index[t+2]:t+2;
     rasterTri(it,ii,(t-gr.start)/3+gr.start/3|0,t,a,b,c,side,mi,near);}}});
  // Shade.
  const bg=opts.background||[[.62,.71,.80],[.85,.88,.89]];
  const camPos=new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  const inv=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse).invert().elements;
  const fog=scene.fog,albedo=new Float32Array(4),tex=new Float32Array(4),lit3=new Float32Array(3);
  const cache=paintCacheFor(camera);
  for(let y=0;y<RH;y++)for(let x=0;x<RW;x++){const i=y*RW+x,ii=gItem[i];let r,g,b;
   if(ii<0){// sky: the view ray's height, horizon colour to zenith colour
    const nx=(x+.5)/RW*2-1,ny=1-(y+.5)/RH*2;const dx=inv[0]*nx+inv[4]*ny+inv[8]+inv[12],dy=inv[1]*nx+inv[5]*ny+inv[9]+inv[13],dz=inv[2]*nx+inv[6]*ny+inv[10]+inv[14],dw=inv[3]*nx+inv[7]*ny+inv[11]+inv[15];
    const wy=dy/dw-camPos.y,len=Math.hypot(dx/dw-camPos.x,wy,dz/dw-camPos.z),h=Math.max(0,Math.min(1,wy/len*2.2));
    r=bg[1][0]+(bg[0][0]-bg[1][0])*h;g=bg[1][1]+(bg[0][1]-bg[1][1])*h;b=bg[1][2]+(bg[0][2]-bg[1][2])*h;color[i*3]=r;color[i*3+1]=g;color[i*3+2]=b;continue;}
   const it=items[ii],t=gTri[i],b0=gB0[i],b1=gB1[i],b2=1-b0-b1,ia=it.index?it.index[t]:t,ib=it.index?it.index[t+1]:t+1,ic=it.index?it.index[t+2]:t+2;
   const P=it.P,N=it.N;
   const px=P[ia*3]*b0+P[ib*3]*b1+P[ic*3]*b2,py=P[ia*3+1]*b0+P[ib*3+1]*b1+P[ic*3+1]*b2,pz=P[ia*3+2]*b0+P[ib*3+2]*b1+P[ic*3+2]*b2;
   let nx=N[ia*3]*b0+N[ib*3]*b1+N[ic*3]*b2,ny=N[ia*3+1]*b0+N[ib*3+1]*b1+N[ic*3+1]*b2,nz=N[ia*3+2]*b0+N[ib*3+2]*b1+N[ic*3+2]*b2;
   const mat=groupMaterial(it,t),mi=materialInfo(mat);
   if(mat.flatShading){const ex=P[ib*3]-P[ia*3],ey=P[ib*3+1]-P[ia*3+1],ez=P[ib*3+2]-P[ia*3+2],fx=P[ic*3]-P[ia*3],fy=P[ic*3+1]-P[ia*3+1],fz=P[ic*3+2]-P[ia*3+2];nx=ey*fz-ez*fy;ny=ez*fx-ex*fz;nz=ex*fy-ey*fx;}
   let vx=camPos.x-px,vy=camPos.y-py,vz=camPos.z-pz;const vl=Math.hypot(vx,vy,vz);vx/=vl;vy/=vl;vz/=vl;
   let nl=Math.hypot(nx,ny,nz)||1;nx/=nl;ny/=nl;nz/=nl;if(nx*vx+ny*vy+nz*vz<0){nx=-nx;ny=-ny;nz=-nz;}
   albedo[0]=mat.color?mat.color.r:1;albedo[1]=mat.color?mat.color.g:1;albedo[2]=mat.color?mat.color.b:1;
   if(it.uv&&mi.map){const u=it.uv.getX(ia)*b0+it.uv.getX(ib)*b1+it.uv.getX(ic)*b2,v=it.uv.getY(ia)*b0+it.uv.getY(ib)*b1+it.uv.getY(ic)*b2;mi.map(u,v,tex);albedo[0]*=tex[0];albedo[1]*=tex[1];albedo[2]*=tex[2];}
   if(it.vc&&mat.vertexColors){albedo[0]*=it.vc.getX(ia)*b0+it.vc.getX(ib)*b1+it.vc.getX(ic)*b2;albedo[1]*=it.vc.getY(ia)*b0+it.vc.getY(ib)*b1+it.vc.getY(ic)*b2;albedo[2]*=it.vc.getZ(ia)*b0+it.vc.getZ(ib)*b1+it.vc.getZ(ic)*b2;}
   if(it.tint){albedo[0]*=it.tint[0];albedo[1]*=it.tint[1];albedo[2]*=it.tint[2];}
   let rough=mat.roughness??1;
   if(mi.paint){const c=i*6;
    if(cache[c+5]===1&&Math.abs(cache[c]-px)<1e-4&&Math.abs(cache[c+1]-py)<1e-4&&Math.abs(cache[c+2]-pz)<1e-4){albedo[0]=cache[c+3];albedo[1]=cache[c+4];albedo[2]=cacheRough[i*3];rough=cacheRough[i*3+1];}
    else{const p=mi.paint(px,py,pz,albedo);if(p&&p.roughness!==undefined)rough=p.roughness;cache[c]=px;cache[c+1]=py;cache[c+2]=pz;cache[c+3]=albedo[0];cache[c+4]=albedo[1];cache[c+5]=1;cacheRough[i*3]=albedo[2];cacheRough[i*3+1]=rough;}}
   if(mi.unlit){r=albedo[0];g=albedo[1];b=albedo[2];}
   else{shade(lit3,albedo,mat.metalness??0,rough,mat.emissive,mat.emissiveIntensity??1,px,py,pz,nx,ny,nz,vx,vy,vz,L);r=lit3[0];g=lit3[1];b=lit3[2];}
   if(fog&&fog.isFog){const f=Math.max(0,Math.min(1,(vl-fog.near)/(fog.far-fog.near)));r+=(fog.color.r-r)*f;g+=(fog.color.g-g)*f;b+=(fog.color.b-b)*f;}
   color[i*3]=r;color[i*3+1]=g;color[i*3+2]=b;}
  blendPass(items,L,camPos,near);
  return resolve();}

 // Per camera: painted albedo by pixel, reused while the surface under the pixel stays put.
 const paintCaches=new Map();let cacheRough=null;
 function paintCacheFor(camera){let c=paintCaches.get(camera.uuid);if(!c){c={a:new Float32Array(RW*RH*6),b:new Float32Array(RW*RH*3)};paintCaches.set(camera.uuid,c);}cacheRough=c.b;return c.a;}
 function groupMaterial(it,t){for(const gr of it.groups)if(t>=gr.start&&t<gr.end)return gr.material;return it.groups[0].material;}
 const INV_PI=1/Math.PI;
 function shade(o,al,metal,rough,em,emI,px,py,pz,nx,ny,nz,vx,vy,vz,L){
  const dr=al[0]*(1-metal),dg=al[1]*(1-metal),db=al[2]*(1-metal),f0r=.04+(al[0]-.04)*metal,f0g=.04+(al[1]-.04)*metal,f0b=.04+(al[2]-.04)*metal;
  // Indirect: the hemisphere light, and the room environment as a soft grey dome.
  let ir=0,ig=0,ib=0;const hw=.5*ny+.5;
  for(const h of L.hemi){ir+=h.ground.r+(h.sky.r-h.ground.r)*hw;ig+=h.ground.g+(h.sky.g-h.ground.g)*hw;ib+=h.ground.b+(h.sky.b-h.ground.b)*hw;}
  const env=envIntensity*Math.PI*(.62+.22*ny);ir+=env;ig+=env;ib+=env;
  let r=dr*ir*INV_PI,g=dg*ig*INV_PI,b=db*ib*INV_PI;
  // Environment reflection: grey room seen in the mirror direction, weaker when rough.
  const ndv=Math.max(0,nx*vx+ny*vy+nz*vz),fres=Math.pow(1-ndv,5),spec=envIntensity*(.75+.25*(2*ndv*ny-vy))*(1-.6*rough);
  r+=(f0r+(1-f0r)*fres*(1-rough))*spec;g+=(f0g+(1-f0g)*fres*(1-rough))*spec;b+=(f0b+(1-f0b)*fres*(1-rough))*spec;
  const shin=2/Math.max(.002,Math.pow(Math.max(.05,rough),4))-2;
  for(const d of L.dir){const ndl=nx*d.dir.x+ny*d.dir.y+nz*d.dir.z;if(ndl<=0)continue;const sh=d.shadow?lit(px,py,pz,.02+.04*(1-ndl)):1;if(sh<=0)continue;
   const k=ndl*sh;r+=dr*d.color.r*k*INV_PI;g+=dg*d.color.g*k*INV_PI;b+=db*d.color.b*k*INV_PI;
   let hx=d.dir.x+vx,hy=d.dir.y+vy,hz=d.dir.z+vz;const hl=Math.hypot(hx,hy,hz)||1;const ndh=Math.max(0,(nx*hx+ny*hy+nz*hz)/hl);
   const s=Math.pow(ndh,Math.min(shin,4000))*(shin+8)/(8*Math.PI)*k;r+=f0r*d.color.r*s;g+=f0g*d.color.g*s;b+=f0b*d.color.b*s;}
  if(em){r+=em.r*emI;g+=em.g*emI;b+=em.b*emI;}
  o[0]=r;o[1]=g;o[2]=b;return o;}

 // Triangle into the visibility buffer: clip against the near plane, keep
 // the original triangle's barycentrics so shading reads the real vertices.
 const FA=new Float64Array(6),FB=new Float64Array(6),FC=new Float64Array(6),TEX=new Float32Array(4);
 function rasterTri(it,ii,_,t,a,b,c,side,mi,near){
  const {cx,cy,cz,cw}=it.clip;
  if(cw[a]>=near&&cw[b]>=near&&cw[c]>=near){
   const ia=1/cw[a],ib=1/cw[b],ic=1/cw[c];
   FA[0]=(cx[a]*ia*.5+.5)*RW;FA[1]=(.5-cy[a]*ia*.5)*RH;FA[2]=cz[a]*ia;FA[3]=ia;FA[4]=ia;FA[5]=0;
   FB[0]=(cx[b]*ib*.5+.5)*RW;FB[1]=(.5-cy[b]*ib*.5)*RH;FB[2]=cz[b]*ib;FB[3]=ib;FB[4]=0;FB[5]=ib;
   FC[0]=(cx[c]*ic*.5+.5)*RW;FC[1]=(.5-cy[c]*ic*.5)*RH;FC[2]=cz[c]*ic;FC[3]=ic;FC[4]=0;FC[5]=0;
   fillTri(FA,FB,FC,it,ii,t,side,mi);return;}
  let poly=[[cx[a],cy[a],cz[a],cw[a],1,0],[cx[b],cy[b],cz[b],cw[b],0,1],[cx[c],cy[c],cz[c],cw[c],0,0]];
  const out=poly.filter(v=>v[3]<near).length;if(out===3)return;
  if(out){const res=[];for(let k=0;k<3;k++){const p=poly[k],q=poly[(k+1)%3],pin=p[3]>=near,qin=q[3]>=near;if(pin)res.push(p);
    if(pin!==qin){const s=(near-p[3])/(q[3]-p[3]);res.push(p.map((v,j)=>v+(q[j]-v)*s));}}poly=res;}
  const sv=poly.map(v=>{const iw=1/v[3];return[(v[0]*iw*.5+.5)*RW,(.5-v[1]*iw*.5)*RH,v[2]*iw,iw,v[4]*iw,v[5]*iw];});
  for(let k=1;k+1<sv.length;k++)fillTri(sv[0],sv[k],sv[k+1],it,ii,t,side,mi);}
 function fillTri(A,B,C,it,ii,t,side,mi){
  const area=(B[0]-A[0])*(C[1]-A[1])-(C[0]-A[0])*(B[1]-A[1]);if(Math.abs(area)<1e-12)return;
  // three.js front faces are counter-clockwise; in screen space (y down) that is area < 0.
  if(side===THREE.FrontSide&&area>0)return;if(side===THREE.BackSide&&area<0)return;
  const minX=Math.max(0,Math.floor(Math.min(A[0],B[0],C[0]))),maxX=Math.min(RW-1,Math.ceil(Math.max(A[0],B[0],C[0]))),minY=Math.max(0,Math.floor(Math.min(A[1],B[1],C[1]))),maxY=Math.min(RH-1,Math.ceil(Math.max(A[1],B[1],C[1])));
  if(minX>maxX||minY>maxY)return;const ia=1/area;
  const test=mi.alphaTest&&it.uv?mi:null,tex=TEX;
  for(let y=minY;y<=maxY;y++){const py=y+.5;for(let x=minX;x<=maxX;x++){const px=x+.5;
   const w0=((B[0]-px)*(C[1]-py)-(C[0]-px)*(B[1]-py))*ia,w1=((C[0]-px)*(A[1]-py)-(A[0]-px)*(C[1]-py))*ia,w2=1-w0-w1;if(w0<0||w1<0||w2<0)continue;
   const z=w0*A[2]+w1*B[2]+w2*C[2],i=y*RW+x;if(z<-1||z>=depth[i])continue;
   const iw=w0*A[3]+w1*B[3]+w2*C[3],b0=(w0*A[4]+w1*B[4]+w2*C[4])/iw,b1=(w0*A[5]+w1*B[5]+w2*C[5])/iw;
   if(test){const ia_=it.index?it.index[t]:t,ib_=it.index?it.index[t+1]:t+1,ic_=it.index?it.index[t+2]:t+2,b2=1-b0-b1;
    test.map(it.uv.getX(ia_)*b0+it.uv.getX(ib_)*b1+it.uv.getX(ic_)*b2,it.uv.getY(ia_)*b0+it.uv.getY(ib_)*b1+it.uv.getY(ic_)*b2,tex);if(tex[3]<test.alphaTest)continue;}
   depth[i]=z;gItem[i]=ii;gTri[i]=t;gB0[i]=b0;gB1[i]=b1;}}}

 // Transparent surfaces: flat-blended over the shaded picture, depth-tested, not written.
 function blendPass(items,L,camPos,near){
  for(const it of items)for(const gr of it.groups){const mi=materialInfo(gr.material);if(mi.skip||!mi.blend)continue;const mat=gr.material,op=mat.opacity??1;
   const {cx,cy,cz,cw}=it.clip;
   for(let t=gr.start;t+2<gr.end;t+=3){const a=it.index?it.index[t]:t,b=it.index?it.index[t+1]:t+1,c=it.index?it.index[t+2]:t+2;
    if(cw[a]<near||cw[b]<near||cw[c]<near)continue;
    const s=[a,b,c].map(v=>{const iw=1/cw[v];return[(cx[v]*iw*.5+.5)*RW,(.5-cy[v]*iw*.5)*RH,cz[v]*iw];});
    const [A,B,C]=s,area=(B[0]-A[0])*(C[1]-A[1])-(C[0]-A[0])*(B[1]-A[1]);if(Math.abs(area)<1e-12)continue;const ia=1/area;
    const al=[mat.color.r,mat.color.g,mat.color.b];const col=mi.unlit?al:shade(new Float32Array(3),[...al,1],0,mat.roughness??1,null,0,it.P[a*3],it.P[a*3+1],it.P[a*3+2],it.N[a*3],it.N[a*3+1],it.N[a*3+2],0,1,0,L);
    const minX=Math.max(0,Math.floor(Math.min(A[0],B[0],C[0]))),maxX=Math.min(RW-1,Math.ceil(Math.max(A[0],B[0],C[0]))),minY=Math.max(0,Math.floor(Math.min(A[1],B[1],C[1]))),maxY=Math.min(RH-1,Math.ceil(Math.max(A[1],B[1],C[1])));
    for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){const px=x+.5,py=y+.5;
     const w0=((B[0]-px)*(C[1]-py)-(C[0]-px)*(B[1]-py))*ia,w1=((C[0]-px)*(A[1]-py)-(A[0]-px)*(C[1]-py))*ia,w2=1-w0-w1;if(w0<0||w1<0||w2<0)continue;
     const z=w0*A[2]+w1*B[2]+w2*C[2],i=y*RW+x;if(z>=depth[i])continue;
     color[i*3]+=(col[0]-color[i*3])*op;color[i*3+1]+=(col[1]-color[i*3+1])*op;color[i*3+2]+=(col[2]-color[i*3+2])*op;}}}}

 // ACES filmic (three.js's fit), exposure, sRGB; box-filter the supersamples.
 const out=new Uint8Array(W*H*3);
 function aces(v){v*=exposure/.6;const a=v*(v+.0245786)-.000090537,b=v*(.983729*v+.4329510)+.238081;return a/b;}
 function encode(v){v=v<0?0:v>1?1:v;return v<=.0031308?v*12.92:1.055*Math.pow(v,1/2.4)-.055;}
 function resolve(){const n=SS*SS;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){let r=0,g=0,b=0;
   for(let sy=0;sy<SS;sy++)for(let sx=0;sx<SS;sx++){const i=((y*SS+sy)*RW+x*SS+sx)*3;r+=color[i];g+=color[i+1];b+=color[i+2];}
   const o=(y*W+x)*3;out[o]=Math.round(encode(aces(r/n))*255);out[o+1]=Math.round(encode(aces(g/n))*255);out[o+2]=Math.round(encode(aces(b/n))*255);}
  return{rgb:out,width:W,height:H};}

 // Projects a world point to output pixels (for overlays and checks).
 function project(p,camera){const v=new THREE.Vector3(...p).project(camera);return[(v.x*.5+.5)*W,(.5-v.y*.5)*H,v.z];}
 return{render,project,worldArrays,width:W,height:H};
}
