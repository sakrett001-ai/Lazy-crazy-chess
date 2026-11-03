// Small vector and quaternion helpers on plain arrays, so the motion import
// and retargeting run in Node tests without three.js. Vectors are [x,y,z],
// quaternions [x,y,z,w].
export const add=(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
export const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
export const scale=(a,s)=>[a[0]*s,a[1]*s,a[2]*s];
export const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
export const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const length=a=>Math.hypot(a[0],a[1],a[2]);
export const distance=(a,b)=>length(sub(a,b));
export const normalize=a=>{const l=length(a);return l>1e-12?scale(a,1/l):[0,0,0];};
export const lerp=(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t];
export const mid=(a,b)=>lerp(a,b,.5);

export const qIdentity=()=>[0,0,0,1];
export function qMul(a,b){
 const [ax,ay,az,aw]=a,[bx,by,bz,bw]=b;
 return[aw*bx+ax*bw+ay*bz-az*by,aw*by-ax*bz+ay*bw+az*bx,aw*bz+ax*by-ay*bx+az*bw,aw*bw-ax*bx-ay*by-az*bz];
}
export const qConj=q=>[-q[0],-q[1],-q[2],q[3]];
export const qNormalize=q=>{const l=Math.hypot(...q)||1;return q.map(v=>v/l);};
export function qRotate(q,v){
 const [x,y,z,w]=q,[vx,vy,vz]=v;
 const ix=w*vx+y*vz-z*vy,iy=w*vy+z*vx-x*vz,iz=w*vz+x*vy-y*vx,iw=-x*vx-y*vy-z*vz;
 return[ix*w+iw*-x+iy*-z-iz*-y,iy*w+iw*-y+iz*-x-ix*-z,iz*w+iw*-z+ix*-y-iy*-x];
}
export function qAxisAngle(axis,angle){const a=normalize(axis),s=Math.sin(angle/2);return[a[0]*s,a[1]*s,a[2]*s,Math.cos(angle/2)];}
export function qSlerp(a,b,t){
 let [bx,by,bz,bw]=b,c=a[0]*bx+a[1]*by+a[2]*bz+a[3]*bw;
 if(c<0){c=-c;bx=-bx;by=-by;bz=-bz;bw=-bw;}
 if(c>.9995)return qNormalize([a[0]+(bx-a[0])*t,a[1]+(by-a[1])*t,a[2]+(bz-a[2])*t,a[3]+(bw-a[3])*t]);
 const th=Math.acos(c),s=Math.sin(th),ka=Math.sin((1-t)*th)/s,kb=Math.sin(t*th)/s;
 return[a[0]*ka+bx*kb,a[1]*ka+by*kb,a[2]*ka+bz*kb,a[3]*ka+bw*kb];
}
// Rotation whose columns are the orthonormal axes c0, c1, c2.
export function qFromBasis(c0,c1,c2){
 const m00=c0[0],m10=c0[1],m20=c0[2],m01=c1[0],m11=c1[1],m21=c1[2],m02=c2[0],m12=c2[1],m22=c2[2],tr=m00+m11+m22;
 let q;
 if(tr>0){const s=.5/Math.sqrt(tr+1);q=[(m21-m12)*s,(m02-m20)*s,(m10-m01)*s,.25/s];}
 else if(m00>m11&&m00>m22){const s=2*Math.sqrt(1+m00-m11-m22);q=[.25*s,(m01+m10)/s,(m02+m20)/s,(m21-m12)/s];}
 else if(m11>m22){const s=2*Math.sqrt(1+m11-m00-m22);q=[(m01+m10)/s,.25*s,(m12+m21)/s,(m02-m20)/s];}
 else{const s=2*Math.sqrt(1+m22-m00-m11);q=[(m02+m20)/s,(m12+m21)/s,.25*s,(m10-m01)/s];}
 return qNormalize(q);
}
// Orientation of an anatomical frame: the first axis along `primary`, the
// second along `secondary` made perpendicular to it. When the secondary
// direction is (nearly) parallel to the primary, `fallback` is used.
export function frame(primary,secondary,fallback=[0,0,1]){
 const e1=normalize(primary);
 let s=sub(secondary,scale(e1,dot(secondary,e1)));
 if(length(s)<1e-4*Math.max(1e-9,length(secondary)))s=sub(fallback,scale(e1,dot(fallback,e1)));
 if(length(s)<1e-9)s=Math.abs(e1[0])<.9?[1,0,0]:[0,1,0];
 const e2=normalize(sub(s,scale(e1,dot(s,e1))));
 return qFromBasis(e1,e2,cross(e1,e2));
}
// Rotation of a 3D point set about the vertical axis by `angle`.
export const rotateY=(v,angle)=>{const c=Math.cos(angle),s=Math.sin(angle);return[c*v[0]+s*v[2],v[1],-s*v[0]+c*v[2]];};
