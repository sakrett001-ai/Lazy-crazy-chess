// three.js as the page imports it, with the GPU parts replaced for Node:
// WebGLRenderer hands each frame to a CPU rasterizer (raster.mjs) instead of
// a graphics card, PMREMGenerator returns no environment map (the rasterizer
// stands in for it), and TextureLoader decodes embedded PNG/JPEG itself
// (lazily, the first time a texture is sampled). Everything else is the real
// three.js, so the scene graph, skinning and animation are unchanged.
export * from 'three';
import * as REAL from 'three';
import {resolveObjectURL} from 'node:buffer';
import jpeg from 'jpeg-js';
import {PNG} from 'pngjs';
globalThis.__THREE=REAL; // the page's own three.js, for the rasterizer

export class WebGLRenderer{
 constructor(){this.domElement=globalThis.document.createElement('canvas');this.shadowMap={enabled:false,type:REAL.PCFShadowMap};this.info={render:{triangles:0,calls:0},memory:{}};
  this.outputColorSpace=REAL.SRGBColorSpace;this.toneMapping=REAL.NoToneMapping;this.toneMappingExposure=1;this.domElement.toDataURL=()=>'data:,';}
 setPixelRatio(){}setSize(w,h){this.width=w;this.height=h;}getSize(v){return v.set(this.width||0,this.height||0);}getPixelRatio(){return 1;}
 render(scene,camera){globalThis.__cpuRender?.(scene,camera,this);}
 compile(){}dispose(){}setAnimationLoop(){}getContext(){return null;}
}
export class PMREMGenerator{constructor(){}fromScene(){return{texture:null,dispose(){}};}fromEquirectangular(){return{texture:null,dispose(){}};}compileEquirectangularShader(){}dispose(){}}

// An embedded image, decoded on first use.
class LazyImage{
 constructor(bytes,mime){this.bytes=bytes;this.mime=mime;this.width=1;this.height=1;this.rgba=null;}
 get _rgba(){if(!this.rgba){const b=Buffer.from(this.bytes);
   if(this.mime==='image/png'||b[0]===0x89){const p=PNG.sync.read(b);this.width=p.width;this.height=p.height;this.rgba=p.data;}
   else{const j=jpeg.decode(b,{useTArray:true,formatAsRGBA:true,maxMemoryUsageInMB:2048});this.width=j.width;this.height=j.height;this.rgba=j.data;}
   this.bytes=null;}
  return this.rgba;}
}
export class TextureLoader extends REAL.Loader{
 load(url,onLoad,_onProgress,onError){const texture=new REAL.Texture();
  (async()=>{const blob=url.startsWith('blob:')?resolveObjectURL(url):null;if(!blob)throw Error('cpu TextureLoader: only blob: URLs, got '+url.slice(0,40));
   texture.image=new LazyImage(new Uint8Array(await blob.arrayBuffer()),blob.type);texture.needsUpdate=true;onLoad?.(texture);})().catch(e=>{onError?onError(e):console.error(e);});
  return texture;}
 loadAsync(url){return new Promise((res,rej)=>this.load(url,res,undefined,rej));}
}
