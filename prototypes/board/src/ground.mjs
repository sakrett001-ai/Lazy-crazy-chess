// The ground the figures stand on. No three.js here: the same functions
// shape the terrain mesh, paint it, plant the grass and put the feet down,
// and the node tests measure them without a browser.
//
// Units are metres, the board centre is the origin, y is up. The board's
// relief is a gentle field, not a floor: a slight tilt, a long swell, and
// hummocks of a few centimetres under the feet. The limits below keep it a
// place where a fencer can stand and lunge: a square's standing zone stays
// nearly level, a neighbour's square is only a few centimetres higher or
// lower (a thrust aimed on the flat still meets the shield), and the
// steepest slope under a foot is a few degrees.

export function rng(seed){let s=seed>>>0||1;return()=>{s^=s<<13;s^=s>>>17;s^=s<<5;return(s>>>0)/4294967296;};}

// Gradient noise on a lattice, smooth fractal sums of it.
export function createNoise(seed){
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

export const smooth=(a,b,x)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};

// The relief of the field (metres). Tested limits: tests/ground.test.mjs.
export const RELIEF=Object.freeze({
 tilt:.003,       // rise per metre of the whole field along one heading
 swell:[16,.065], // wavelength (m) and amplitude (m) of the long swell
 hummock:[1.6,.014],// hummocks under the feet
 grain:[.33,.004], // grain of the soil, a few millimetres
});
// Tested limits of the relief over the board (tests/ground.test.mjs).
export const LIMITS=Object.freeze({
 slope:.085,       // steepest rise per metre under a foot (≈ 4.9°)
 neighbour:.09,    // height difference of two neighbouring square centres (m)
 stand:.05,        // height range inside a standing zone (m)
 standRadius:.65,  // standing zone around a square centre (m)
});

// The board's ground for one seed: height(x,z), normal(x,z) as [x,y,z],
// and which square a point is in. half: half the board's width (4 squares).
export function createGround({seed=1,square=2.6}={}){
 const n=createNoise(seed*7919+11),random=rng(seed*31337+5),half=4*square;
 const heading=random()*Math.PI*2,tx=Math.cos(heading)*RELIEF.tilt,tz=Math.sin(heading)*RELIEF.tilt;
 const [sw,sa]=RELIEF.swell,[hw,ha]=RELIEF.hummock,[gw,ga]=RELIEF.grain;
 const ox=random()*100,oz=random()*100;
 const raw=(x,z)=>x*tx+z*tz+n.fbm(x/sw+ox,z/sw+oz,3)*sa*2+n.fbm(x/hw+40+ox,z/hw-17+oz,2)*ha*2+n.noise(x/gw+9,z/gw-3)*ga;
 const zero=raw(0,0);
 const height=(x,z)=>raw(x,z)-zero;
 function normal(x,z,e=.04){
  const dx=(height(x+e,z)-height(x-e,z))/(2*e),dz=(height(x,z+e)-height(x,z-e))/(2*e),l=Math.hypot(dx,1,dz);
  return[-dx/l,1/l,-dz/l];
 }
 // Square under a point: file 0–7 from a to h, rank 0–7 from 1 to 8, as on
 // the board (rank 1 at +z); null off the board.
 function cell(x,z){
  const file=Math.floor(x/square+4),rank=Math.floor(4-z/square);
  if(file<0||file>7||rank<0||rank>7)return null;
  return{file,rank,light:(file+rank)%2===1,center:[(file-3.5)*square,(3.5-rank)*square]};
 }
 return{seed,square,half,height,normal,cell};
}
