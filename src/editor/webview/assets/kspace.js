var kOpen=false, kView="3d";
var kCx=0, kCy=0, kCz=0, kScl=1;    // view center & zoom
var kAutoFit=true;
var kRotX=-0.5, kRotY=0.7;           // default 3D perspective
var kDragging=false, kDragPrev=null, kDragBtn=0;
var kCanvas=document.getElementById("kc"), kCtx=kCanvas.getContext("2d");
var kDotSize=2, kUnit="cyc";         // cyc=1/m, rad=rad/m
document.getElementById("kdot").oninput=function(){kDotSize=parseInt(this.value);drawKs();};
document.getElementById("kunit").onclick=function(){
  kUnit=kUnit==="cyc"?"rad":"cyc";this.textContent=kUnit==="cyc"?"Unit: 1/m":"Unit: rad/m";drawKs();
};

/* ── Theme selector (toolbar) ─────────────────────────────────────── */
var kThemeClass=null;
document.getElementById("theme").onchange=function(){
  var b=document.body, v=this.value;
  if(kThemeClass)b.classList.remove(kThemeClass);
  if(v==="system"){kThemeClass=null;}
  else{b.classList.add("theme-"+v);kThemeClass="theme-"+v;}
  draw(); drawKs();  // redraw both views with new colours
};

/* ═══════════════════════════════════════════════════════════════════════
   WebGL state
   ═══════════════════════════════════════════════════════════════════════ */
var gl=null, glProgram=null, glBuf=null, glN=0;
var glAttribPos=-1, glAttribTime=-1;
var glU_cy=-1,glU_sy=-1,glU_cx=-1,glU_sx=-1,glU_center=-1,glU_scale=-1;
var glU_halfRes=-1,glU_tMin=-1,glU_tMax=-1,glU_dot=-1,glU_color=-1;

function initWebGL(){
  var c=document.getElementById("kg");
  gl=c.getContext("webgl2",{antialias:true,alpha:true,premultipliedAlpha:false})
     ||c.getContext("webgl",{antialias:true,alpha:true,premultipliedAlpha:false});
  if(!gl){console.warn("[SeqEyes] WebGL unavailable");return false;}
  gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);

  var vs=gl.createShader(gl.VERTEX_SHADER), fs=gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(vs,'\
    attribute vec3 aPos; attribute float aTime;\
    uniform float uCy,uSy,uCx,uSx,uScale;\
    uniform vec3 uCenter; uniform vec2 uHalfRes;\
    uniform float uTMin,uTMax,uDot;\
    varying float vVis;\
    void main(){\
      float dx=aPos.x-uCenter.x,dy=aPos.y-uCenter.y,dz=aPos.z-uCenter.z;\
      float rx=dx*uCy-dz*uSy;\
      float rz=dx*uSy+dz*uCy;\
      float ry=dy*uCx-rz*uSx;\
      float sx=rx*uScale/uHalfRes.x;\
      float sy=ry*uScale/uHalfRes.y;\
      vVis=(aTime>=uTMin&&aTime<=uTMax)?1.0:-1.0;\
      gl_Position=vec4(sx,sy,0.0,1.0);\
      gl_PointSize=vVis>0.0?uDot:0.0;\
    }');
  gl.shaderSource(fs,'\
    precision mediump float;\
    uniform vec4 uColor; varying float vVis;\
    void main(){\
      if(vVis<0.0)discard;\
      float d=length(gl_PointCoord-vec2(0.5));\
      float a=1.0-smoothstep(0.40,0.50,d);\
      gl_FragColor=vec4(uColor.rgb,uColor.a*a);\
    }');
  gl.compileShader(vs);if(!gl.getShaderParameter(vs,gl.COMPILE_STATUS)){console.warn("[SeqEyes] VS:",gl.getShaderInfoLog(vs));return false;}
  gl.compileShader(fs);if(!gl.getShaderParameter(fs,gl.COMPILE_STATUS)){console.warn("[SeqEyes] FS:",gl.getShaderInfoLog(fs));return false;}
  glProgram=gl.createProgram();
  gl.attachShader(glProgram,vs);gl.attachShader(glProgram,fs);
  gl.linkProgram(glProgram);
  if(!gl.getProgramParameter(glProgram,gl.LINK_STATUS)){console.warn("[SeqEyes] Link:",gl.getProgramInfoLog(glProgram));return false;}

  glAttribPos=gl.getAttribLocation(glProgram,"aPos");
  glAttribTime=gl.getAttribLocation(glProgram,"aTime");
  glU_cy=gl.getUniformLocation(glProgram,"uCy");glU_sy=gl.getUniformLocation(glProgram,"uSy");
  glU_cx=gl.getUniformLocation(glProgram,"uCx");glU_sx=gl.getUniformLocation(glProgram,"uSx");
  glU_center=gl.getUniformLocation(glProgram,"uCenter");glU_scale=gl.getUniformLocation(glProgram,"uScale");
  glU_halfRes=gl.getUniformLocation(glProgram,"uHalfRes");glU_dot=gl.getUniformLocation(glProgram,"uDot");
  glU_tMin=gl.getUniformLocation(glProgram,"uTMin");glU_tMax=gl.getUniformLocation(glProgram,"uTMax");
  glU_color=gl.getUniformLocation(glProgram,"uColor");
  return true;
}

/* ── Upload ADC k‑space data to GPU (called after base64 decode) ────── */
function uploadKSpaceGPU(){
  if(!kAdc||!kAdc[0]||kAdc[0].length===0){glN=0;return;}
  if(!gl&&!initWebGL())return;
  var n=kAdc[0].length;
  // Interleave: [kx,ky,kz,time] × n  →  4 floats per point  (16 bytes)
  var data=new Float32Array(n*4);
  var ax=kAdc[0],ay=kAdc[1],az=kAdc[2],at=kAdcTime;
  for(var i=0;i<n;i++){var j=i*4;data[j]=ax[i];data[j+1]=ay[i];data[j+2]=az[i];data[j+3]=at[i];}
  if(glBuf)gl.deleteBuffer(glBuf);
  glBuf=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,glBuf);
  gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);
  glN=n;
}

/* ═══════════════════════════════════════════════════════════════════════
   Toggle / View cycle / Canvas sizing
   ═══════════════════════════════════════════════════════════════════════ */
document.getElementById("kbtn").onclick=function(){
  kOpen=!kOpen;
  var p=document.getElementById("right");
  if(kOpen){p.classList.add("open");this.textContent="K Space ✕";kAutoFit=true;}
  else{p.classList.remove("open");p.style.width="";this.textContent="K Space";}
  if(kOpen){requestAnimationFrame(function(){drawKs_init();});}
  else{requestAnimationFrame(function(){resizeKc();drawKs();});}
};
document.getElementById("kax").textContent="3D";
document.getElementById("krst").onclick=function(){
  kAutoFit=true;kRotX=-0.5;kRotY=0.7;kView="3d";
  document.getElementById("kax").textContent="3D";
  drawKs();
};
// Camera presets: rotate the 3D view to look straight down an axis
document.getElementById("kax").onclick=function(){
  var views=["3d","xy","xz","yz"];var idx=views.indexOf(kView);
  kView=views[(idx+1)%4];kAutoFit=true;
  if(kView==="xy"){kRotX=0;kRotY=0;}
  else if(kView==="xz"){kRotX=-Math.PI/2;kRotY=0;}
  else if(kView==="yz"){kRotX=0;kRotY=Math.PI/2;}
  else{kRotX=-0.5;kRotY=0.7;}  // 3d — default perspective
  document.getElementById("kax").textContent=kView.toUpperCase();
  drawKs();
};

function resizeKc(){
  var r=document.getElementById("right").getBoundingClientRect();
  if(r.width<=0||r.height<=0)return;
  var dpr=window.devicePixelRatio||1;
  // Resize both canvases
  var kg=document.getElementById("kg");
  kg.width=r.width*dpr;kg.height=r.height*dpr;
  kg.style.width=r.width+"px";kg.style.height=r.height+"px";
  kCanvas.width=r.width*dpr;kCanvas.height=r.height*dpr;
  kCanvas.style.width=r.width+"px";kCanvas.style.height=r.height+"px";
  kCtx.setTransform(dpr,0,0,dpr,0,0);
}

/* ── Convert k-space value to display units ──────────────────────────── */
function kUnitVal(v){if(kUnit==="rad")return v*6.283185;return v;}
function kUnitStr(){return kUnit==="rad"?"rad/m":"1/m";}
function kTickVal(v){var u=kUnitVal(v);if(Math.abs(u)>=1000)return (u/1000).toFixed(1)+"k";if(Math.abs(u)>=1)return u.toFixed(1);if(Math.abs(u)>=0.01)return u.toFixed(2);return u.toExponential(1);}

/* ── Mouse ───────────────────────────────────────────────────────────── */
kCanvas.addEventListener("mousedown",function(e){
  kDragging=true;kDragPrev={x:e.clientX,y:e.clientY};kDragBtn=e.button;
  e.preventDefault();
});
kCanvas.addEventListener("contextmenu",function(e){e.preventDefault();});

kCanvas.addEventListener("wheel",function(e){e.preventDefault();
  var r=kCanvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  var mx=(e.clientX-r.left)/dpr, my=(e.clientY-r.top)/dpr;
  var zf=e.deltaY<0?1.25:0.8, W=kCanvas.width/dpr, H=kCanvas.height/dpr;
  // Zoom toward the mouse cursor (NOT the canvas centre).
  // Derivation:  screenX = W/2 + (kx - kCx) * kScl / dpr
  //   → kCx' = kCx + (mx - W/2) * dpr/kScl * (1 - 1/zf)
  //   → kCy' = kCy - (my - H/2) * dpr/kScl * (1 - 1/zf)   (Y is flipped)
  var dz=(1-1/zf)*dpr/kScl;
  kScl*=zf;kAutoFit=false;
  kCx+=(mx-W/2)*dz;
  kCy-=(my-H/2)*dz;
  drawKs();
},{passive:false});

window.addEventListener("mousemove",function(e){
  if(!kDragging||!kDragPrev||!kOpen)return;
  var dx=e.clientX-kDragPrev.x, dy=e.clientY-kDragPrev.y;
  kDragPrev={x:e.clientX,y:e.clientY};
  // Any manual drag reverts the camera‑preset button to "3D"
  if(kView!=="3d"){kView="3d";document.getElementById("kax").textContent="3D";}
  if(kDragBtn===0){
    kRotY+=dx*0.008;kRotX-=dy*0.008;  // left drag = rotate
  }else{
    // right / middle drag = pan in 3D (inverse rotation)
    var cz=Math.cos(kRotY),sz=Math.sin(kRotY),cx=Math.cos(kRotX),sx=Math.sin(kRotX);
    var dpr=window.devicePixelRatio||1;
    dx/=(dpr*kScl); dy/=(dpr*kScl);
    if(Math.abs(cz)>0.01){kCy+=dy/cx;kCx+=(-dx-sz*sx*(dy/cx))/cz;}
    else{kCy+=dy/cx;kCz+=(dx-cz*sx*(dy/cx))/sz;}
    kAutoFit=false;
  }
  drawKs();
});
window.addEventListener("mouseup",function(){kDragging=false;kDragPrev=null;});

/* ── Resize handle ───────────────────────────────────────────────────── */
var kResizing=false, kResizeStart=0, kResizeW=500;
document.getElementById("khandle").addEventListener("mousedown",function(e){
  kResizing=true;kResizeStart=e.clientX;e.preventDefault();e.stopPropagation();
});
window.addEventListener("mousemove",function(e){
  if(!kResizing)return;
  var p=document.getElementById("right");
  kResizeW=Math.max(200,Math.min(1200,kResizeW-(e.clientX-kResizeStart)));
  kResizeStart=e.clientX;
  p.style.width=kResizeW+"px";p.style.transition="none";
  resizeKc();drawKs();
});
window.addEventListener("mouseup",function(){if(kResizing){kResizing=false;document.getElementById("right").style.transition="";}});
window.addEventListener("resize",function(){if(kOpen){resizeKc();drawKs();}});

/* ═══════════════════════════════════════════════════════════════════════
   Nice tick spacing
   ═══════════════════════════════════════════════════════════════════════ */
function kNice(range){var ms=[1,2,5,10,20,50,100,200,500];for(var i=0;i<ms.length;i++){var b=Math.pow(10,Math.floor(Math.log10(range)));if(ms[i]*b>=range/4)return ms[i]*b;}return 1;}

/* ═══════════════════════════════════════════════════════════════════════
   Drawing  (Canvas 2D axes + WebGL scatter)
   ═══════════════════════════════════════════════════════════════════════ */

/** First‑open initialisation: sizes canvases to the KNOWN CSS target
 *  width (500px) so auto‑fit never sees a mid‑transition partial width. */
function drawKs_init(){
  var dpr=window.devicePixelRatio||1;
  var targetW=500;
  var targetH=document.getElementById("right").getBoundingClientRect().height||500;
  if(targetH<=0)targetH=500;
  // Size both canvases directly — no DOM width read
  var kg=document.getElementById("kg");
  kg.width=targetW*dpr;kg.height=targetH*dpr;
  kg.style.width=targetW+"px";kg.style.height=targetH+"px";
  kCanvas.width=targetW*dpr;kCanvas.height=targetH*dpr;
  kCanvas.style.width=targetW+"px";kCanvas.style.height=targetH+"px";
  kCtx.setTransform(dpr,0,0,dpr,0,0);
  drawKs_core(targetW,targetH,dpr);
}

/** Normal draw: reads current canvas size from DOM. */
function drawKs(){
  resizeKc();
  var dpr=window.devicePixelRatio||1;
  var W=kCanvas.width/dpr, H=kCanvas.height/dpr;
  drawKs_core(W,H,dpr);
}

/** Core rendering — assumes canvases are already sized, W & H in CSS px. */
function drawKs_core(W,H,dpr){
  if(W<=0||H<=0)return;

  var ctx=kCtx,cs=getComputedStyle(document.body);
  // Clear Canvas 2D (axes layer) — transparent so WebGL shows through
  ctx.clearRect(0,0,W,H);
  if(!kOpen)return;

  // ── Check data ──
  if(!kAdc||!kAdcTime||!kAdc[0]||kAdc[0].length===0){
    ctx.fillStyle="#f00";ctx.font="11px monospace";ctx.fillText("NO ADC data",10,20);return;
  }
  var adcX=kAdc[0],adcY=kAdc[1],adcZ=kAdc[2], nAdc=adcX.length;

  // ── Bounds (scan all points) ──
  var xmin=Infinity,xmax=-Infinity,ymin=Infinity,ymax=-Infinity,zmin=Infinity,zmax=-Infinity;
  for(var a=0;a<nAdc;a++){var xi=adcX[a],yi=adcY[a],zi=adcZ[a];if(isFinite(xi)){if(xi<xmin)xmin=xi;if(xi>xmax)xmax=xi;}if(isFinite(yi)){if(yi<ymin)ymin=yi;if(yi>ymax)ymax=yi;}if(isFinite(zi)){if(zi<zmin)zmin=zi;if(zi>zmax)zmax=zi;}}
  if(!isFinite(xmin)){ctx.fillStyle="#f00";ctx.font="11px monospace";ctx.fillText("ALL NaN",10,20);return;}
  var rng3=Math.max(xmax-xmin,ymax-ymin,zmax-zmin,1e-6);

  // ── Auto-fit ──
  if(kAutoFit){
    kCx=(xmin+xmax)/2;kCy=(ymin+ymax)/2;kCz=(zmin+zmax)/2;
    kScl=Math.min(W,H)/(rng3*1.15);
    kAutoFit=false;
  }

  // ── Time window ──
  var mw2=mc.width/(window.devicePixelRatio||1),vs=ox,ve=ox+(mw2-M.l-M.r)/sc;

  // ═══════════════════════════════════════════════════════════════════
  // WebGL scatter  (GPU — renders millions of points at 60 fps)
  // ═══════════════════════════════════════════════════════════════════
  if(gl&&glBuf&&glN>0){
    gl.useProgram(glProgram);
    var hW=W*dpr*0.5, hH=H*dpr*0.5;
    gl.viewport(0,0,W*dpr,H*dpr);
    gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);

    gl.uniform1f(glU_cy,Math.cos(kRotY));gl.uniform1f(glU_sy,Math.sin(kRotY));
    gl.uniform1f(glU_cx,Math.cos(kRotX));gl.uniform1f(glU_sx,Math.sin(kRotX));
    gl.uniform3f(glU_center,kCx,kCy,kCz);
    gl.uniform1f(glU_scale,kScl);
    gl.uniform2f(glU_halfRes,hW,hH);
    gl.uniform1f(glU_tMin,vs);gl.uniform1f(glU_tMax,ve);
    gl.uniform1f(glU_dot,kDotSize*dpr);

    var ac=cs.getPropertyValue("--adc").trim();
    var rgb=parseCSSColor(ac);
    gl.uniform4f(glU_color,rgb[0],rgb[1],rgb[2],0.85);

    gl.bindBuffer(gl.ARRAY_BUFFER,glBuf);
    gl.enableVertexAttribArray(glAttribPos);
    gl.vertexAttribPointer(glAttribPos,3,gl.FLOAT,false,16,0);
    gl.enableVertexAttribArray(glAttribTime);
    gl.vertexAttribPointer(glAttribTime,1,gl.FLOAT,false,16,12);

    gl.drawArrays(gl.POINTS,0,glN);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Canvas 2D axes / labels  (overlay — transparent background)
  //   Projection MUST match the WebGL vertex shader:
  //     cssX = W/2 + rx * kScl / dpr
  //     cssY = H/2 - ry * kScl / dpr
  // ═══════════════════════════════════════════════════════════════════
  var cz=Math.cos(kRotY),sz=Math.sin(kRotY),cxR=Math.cos(kRotX),sxR=Math.sin(kRotX);
  var invDpr=1/dpr;
  function proj(px,py,pz){
    var dx2=px-kCx, dy2=py-kCy, dz2=pz-kCz;
    var rx=dx2*cz-dz2*sz;
    var rz2=dx2*sz+dz2*cz;
    var ry=dy2*cxR-rz2*sxR;
    return {x:W/2+rx*kScl*invDpr, y:H/2-ry*kScl*invDpr};
  }
  var tick=kNice(rng3);
  function drawAxis3D(fx,fy,fz,label,col){
    var al=rng3*0.65;
    var t1=proj(fx*al,fy*al,fz*al);
    var t2=proj(-fx*al,-fy*al,-fz*al);
    ctx.strokeStyle=col;ctx.lineWidth=1.6;ctx.setLineDash([]);
    ctx.beginPath();ctx.moveTo(t2.x,t2.y);ctx.lineTo(t1.x,t1.y);ctx.stroke();
    ctx.fillStyle=col;ctx.beginPath();ctx.arc(t1.x,t1.y,4,0,6.283);ctx.fill();
    ctx.fillStyle=col;ctx.font="bold 11px monospace";ctx.fillText(label,t1.x+5,t1.y-5);
    ctx.fillStyle=cs.getPropertyValue("--lb").trim();ctx.font="8px monospace";
    for(var v=tick;v<=al;v+=tick){
      var tp=proj(fx*v,fy*v,fz*v);
      var tm=proj(-fx*v,-fy*v,-fz*v);
      ctx.strokeStyle=col;ctx.lineWidth=0.5;
      ctx.beginPath();ctx.moveTo(tp.x-3,tp.y);ctx.lineTo(tp.x+3,tp.y);ctx.stroke();
      ctx.beginPath();ctx.moveTo(tm.x-3,tm.y);ctx.lineTo(tm.x+3,tm.y);ctx.stroke();
      ctx.fillText(kTickVal(v),tp.x+5,tp.y-2);
    }
  }
  drawAxis3D(1,0,0,"kx",cs.getPropertyValue("--gx").trim());
  drawAxis3D(0,1,0,"ky",cs.getPropertyValue("--gy").trim());
  drawAxis3D(0,0,1,"kz",cs.getPropertyValue("--gz").trim());
  var oo=proj(0,0,0);
  ctx.fillStyle=cs.getPropertyValue("--fg").trim();ctx.beginPath();ctx.arc(oo.x,oo.y,4,0,6.283);ctx.fill();

}

/* ── Parse CSS hex colour to [r,g,b] 0‑1 ────────────────────────────── */
function parseCSSColor(c){
  if(!c)return[0.26,0.83,0.96];
  var m=c.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
  if(m)return[parseInt(m[1],16)/255,parseInt(m[2],16)/255,parseInt(m[3],16)/255];
  m=c.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if(m)return[+m[1]/255,+m[2]/255,+m[3]/255];
  return[0.26,0.83,0.96];
}
