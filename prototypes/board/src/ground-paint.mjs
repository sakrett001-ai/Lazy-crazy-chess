// The board's squares painted on the graphics card, over the terrain's
// vertex colours (landscape.mjs patches MeshStandardMaterial with these).
// Per pixel, in world metres: light squares of pale sand with dry grass and
// grit, dark squares of turf with bare soil, the trodden middle of each
// square where the figures stand, and joints of compacted earth between
// squares, their edges a little uneven as if cut into a real field. The
// same grain gives every patch of ground its small relief (a bump on the
// normal) and roughness. Octaves finer than a pixel fade out (fwidth), so
// distant ground does not shimmer. Value noise, a few octaves: light
// enough for an integrated graphics card.
//
// Uniforms: uSquare (m), uHalf (half the board, m), uOffset (per seed).

export const GROUND_VERTEX=/* glsl */`vGround=(modelMatrix*vec4(transformed,1.)).xyz;`;

export const GROUND_FUNCTIONS=/* glsl */`
varying vec3 vGround;
uniform float uSquare,uHalf;
uniform vec2 uOffset;
float gHash(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
float gNoise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);
 return mix(mix(gHash(i),gHash(i+vec2(1,0)),u.x),mix(gHash(i+vec2(0,1)),gHash(i+vec2(1,1)),u.x),u.y)*2.-1.;}
// fw: the pixel's footprint in units of p; octaves under a pixel fade.
float gFbm(vec2 p,int octaves,float fw){float s=0.,a=.5;
 for(int i=0;i<5;i++){if(i>=octaves||fw>.7)break;s+=a*gNoise(p)*(1.-smoothstep(.25,.7,fw));p=p*2.03+vec2(17.1,9.7);a*=.5;fw*=2.03;}return s;}
vec3 gLinear(vec3 c){return pow(c,vec3(2.2));}
// Filled by the colour pass, read by the roughness and normal passes.
float gMask,gRough,gBump;
`;

export const GROUND_FRAGMENT=/* glsl */`{
 vec2 q=vGround.xz,p=q+uOffset;
 float fw=max(length(fwidth(q)),1e-4);
 // Uneven edges of the squares: a small warp of the grid.
 vec2 warp=vec2(gFbm(p*2.1,3,fw*2.1),gFbm(p*2.1+31.,3,fw*2.1))*.05;
 vec2 g=(q+warp)/uSquare;
 float file=floor(g.x+4.),rank=floor(4.-g.y),light=mod(file+rank,2.);
 vec2 fr=fract(g+4.);
 float edge=min(min(fr.x,1.-fr.x),min(fr.y,1.-fr.y))*uSquare;
 float middle=length((fr-.5)*uSquare);
 gMask=1.-smoothstep(uHalf-.01,uHalf+.05,max(abs(q.x+warp.x),abs(q.y+warp.y)));
 float big=gFbm(p*.8,3,fw*.8),mid=gFbm(p*5.,4,fw*5.),fine=gFbm(p*21.,3,fw*21.);
 // Each square a patch of its own: a little drier, greener or darker.
 float own=gHash(vec2(file,rank)+uOffset)*2.-1.,own2=gHash(vec2(rank,file)-uOffset)*2.-1.;
 // Sand with dry grass, clumps of gravel and grit.
 vec3 sand=mix(gLinear(vec3(.47,.41,.31)),gLinear(vec3(.62,.55,.42)),clamp(.5+.7*big+.12*own,0.,1.));
 float straw=smoothstep(-.05,.45,gFbm(vec2(p.x*6.,p.y*1.8)+big*3.+own2,3,fw*6.));
 sand=mix(sand,gLinear(vec3(.58,.50,.29)),straw*(.45+.2*own2));
 sand*=1.+.32*mid+.2*fine;
 float gravel=smoothstep(.2,.6,gFbm(p*13.+5.,2,fw*13.))*smoothstep(-.2,.4,big+.3*own);
 float grit=smoothstep(.45,.8,gNoise(p*48.))*(1.-smoothstep(.004,.02,fw));
 sand=mix(sand,gLinear(vec3(.40,.37,.33))*(1.+.5*fine),max(gravel*.55,grit*.7));
 // Grains: light and dark specks a few millimetres across, close up only.
 float near=1.-smoothstep(.002,.012,fw),grain=gNoise(p*140.)+.5*gNoise(p*290.+7.);
 sand*=1.+near*(.22*grain-.18*smoothstep(.55,.9,gNoise(p*85.+3.)));
 // Turf with clover, darker tussocks and bare soil.
 vec3 turf=mix(gLinear(vec3(.16,.21,.08)),gLinear(vec3(.27,.31,.13)),clamp(.5+.7*big+.15*own,0.,1.));
 turf=mix(turf,gLinear(vec3(.20,.30,.10)),smoothstep(.1,.6,mid)*.45);
 turf=mix(turf,gLinear(vec3(.12,.15,.07)),smoothstep(.15,.5,gFbm(p*3.3+11.,3,fw*3.3))*.5);
 float soil=smoothstep(.2,.65,gFbm(p*1.25+7.,3,fw*1.25)+.15*own2);
 turf=mix(turf,gLinear(vec3(.24,.18,.12)),soil*.5);
 turf*=1.+.35*mid+.35*fine;
 // Blades: stringy streaks that turn with the lie of the grass.
 float lie=big*3.+own*2.;vec2 bl=mat2(cos(lie),-sin(lie),sin(lie),cos(lie))*p;
 float blades=gFbm(vec2(bl.x*55.,bl.y*9.),2,fw*55.);
 turf*=1.+.45*blades*(1.-smoothstep(.004,.03,fw));
 vec3 c=mix(turf,sand,light);
 // The trodden middle where the figures stand: dust on sand, mud on turf.
 float worn=gFbm(p*1.7+3.,3,fw*1.7);
 float trod=(1.-smoothstep(.2,1.,middle*(1.+.55*worn)+.3*big))*smoothstep(-.35,.25,worn+.25*mid)*.55;
 c=mix(c,mix(gLinear(vec3(.24,.18,.12)),gLinear(vec3(.52,.45,.34)),light)*(1.+.3*mid+.25*fine),trod);
 // Joints of compacted earth and small stones.
 float joint=1.-smoothstep(.028,.06,edge+.012*mid);
 vec3 jc=gLinear(vec3(.33,.28,.22))*(1.+.35*fine+.25*grit);
 c=mix(c,jc,joint*.92);
 diffuseColor.rgb=mix(diffuseColor.rgb*(1.+.18*mid+.12*fine),c,gMask);
 gRough=mix(mix(.86,.97,light),.93,max(trod,joint));
 // Relief of the grain: grass is rough and stringy, sand finer, mud smooth.
 gBump=(mix(.6*mid+.5*fine+.35*blades,.35*mid+.3*fine+.3*grit+.5*gravel,light)*(1.-.5*trod)+.25*joint*fine)*mix(1.,gMask,.4);
}`;

export const GROUND_ROUGHNESS=/* glsl */`roughnessFactor=mix(roughnessFactor,gRough,gMask);`;

// Bump from the grain: screen-space slope of the grain height, turned into
// a tilt of the normal (as three.js bump maps do), faded with distance.
export const GROUND_NORMAL=/* glsl */`{
 vec3 dpx=dFdx(-vViewPosition),dpy=dFdy(-vViewPosition);
 float hx=dFdx(gBump),hy=dFdy(gBump),fw=length(fwidth(vGround.xz));
 float k=.045*(1.-smoothstep(.015,.08,fw));
 vec3 r1=cross(dpy,normal),r2=cross(normal,dpx);
 float det=dot(dpx,r1);
 vec3 grad=sign(det)*(hx*r1+hy*r2)*k;
 normal=normalize(abs(det)*normal-grad);
}`;
