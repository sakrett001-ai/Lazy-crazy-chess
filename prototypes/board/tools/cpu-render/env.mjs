// A browser page without a browser: jsdom for the DOM, a few shims for what
// jsdom lacks (layout size, ResizeObserver, a 2D canvas that keeps pixels),
// and esbuild to bundle the page's module with three.js swapped for
// three-cpu.mjs. Usage:
//   const page=await loadPage({html,entry,nodePaths,width,height});
//   page.window.livingChess …        (whatever the page exposes)
//   page.lastScene / page.lastCamera (from the page's own render calls)
import {JSDOM} from 'jsdom';
import {build} from '../../../human-base/node_modules/esbuild/lib/main.js';
import {writeFile,mkdtemp} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import os from 'node:os';

const here=path.dirname(fileURLToPath(import.meta.url));

export async function loadPage({html,entry,nodePaths=[],width=1280,height=720,url='file:///page.html',ready=w=>w.livingChess&&'ready' in w.livingChess,timeout=300000}){
 const dom=new JSDOM(html,{url,pretendToBeVisual:false});const w=dom.window;
 // Layout: every element is the stage size (the page sizes its canvas by it).
 w.Element.prototype.getBoundingClientRect=()=>({x:0,y:0,left:0,top:0,right:width,bottom:height,width,height});
 w.ResizeObserver=class{constructor(cb){this.cb=cb;}observe(){}unobserve(){}disconnect(){}};
 // 2D canvas: pixel buffers are kept (CanvasTexture reads them); drawing text is a no-op.
 w.HTMLCanvasElement.prototype.getContext=function(kind){if(kind!=='2d')return null;const c=this;
  const ctx={canvas:c,createImageData:(a,b)=>({data:new Uint8ClampedArray(a*b*4),width:a,height:b}),
   putImageData(img){c._rgba=img.data;c._w=img.width;},getImageData:(x,y,a,b)=>({data:c._rgba||new Uint8ClampedArray(a*b*4),width:a,height:b}),measureText:t=>({width:t.length*8})};
  return new Proxy(ctx,{get:(o,k)=>k in o?o[k]:()=>{},set:(o,k,v)=>{o[k]=v;return true;}});};
 const g=globalThis;
 Object.assign(g,{window:w,document:w.document,location:w.location,self:g,devicePixelRatio:1,ResizeObserver:w.ResizeObserver,requestAnimationFrame:()=>0,cancelAnimationFrame:()=>{},
  HTMLElement:w.HTMLElement,Element:w.Element,Node:w.Node,getComputedStyle:w.getComputedStyle.bind(w)});
 const page={window:w,lastScene:null,lastCamera:null};
 g.__cpuRender=(scene,camera)=>{page.lastScene=scene;page.lastCamera=camera;};
 // Bundle the page module with three → three-cpu.
 const wrapper=path.join(here,'three-cpu.mjs');
 const result=await build({entryPoints:[entry],bundle:true,write:false,format:'esm',platform:'node',target:'node20',nodePaths:[path.join(here,'..','..','node_modules'),...nodePaths],
  plugins:[{name:'three-cpu',setup(b){b.onResolve({filter:/^three$/},args=>args.importer===wrapper?undefined:{path:wrapper});}}],
  banner:{js:"import {createRequire as __cr} from 'node:module';const require=__cr(import.meta.url);"},logLevel:'error'});
 const dir=await mkdtemp(path.join(os.tmpdir(),'cpu-page-')),file=path.join(dir,'page.mjs');
 await writeFile(file,result.outputFiles[0].text);
 await import(pathToFileURL(file).href);
 const t0=Date.now();while(!ready(w)){if(Date.now()-t0>timeout)throw Error('page not ready');await new Promise(r=>setTimeout(r,50));}
 return page;
}
