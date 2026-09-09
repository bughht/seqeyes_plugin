var kOpen=false, kView="3d";
var kSpaceTrajectoryDrawCount=0,kSpaceOverlayDrawCount=0;
var kCx=0, kCy=0, kCz=0, kScl=1;    // view center & zoom
var kAutoFit=true;
var kRotX=-0.5, kRotY=0.7;           // default 3D perspective
var kDragging=false, kDragPrev=null, kDragBtn=0;
/**
 * Pending coalesced drag redraw.  A drag updates the rotation on every
 * mousemove but only needs one draw per displayed frame; the frames in between
 * are overwritten before anyone sees them.  The inertial path is already
 * requestAnimationFrame-driven, so this only brings the drag into line with it.
 */
var _kDragRaf=0;
var kCanvas=document.getElementById("kc"), kCtx=kCanvas.getContext("2d");
var kDotSize=2, kUnit="cyc";         // cyc=1/m, rad=rad/m

// ── Smooth animation targets ──────────────────────────────────────────
var _tRotX=kRotX, _tRotY=kRotY, _tScl=kScl, _tCx=kCx, _tCy=kCy, _tCz=kCz;
var _kAnimId=null;
var _kEasing=0.12;  // higher = snappier, lower = smoother (0.06–0.20)

function startKSpaceAnim() {
  if (_kAnimId || kDragging) return;
  function tick() {
    var changed = false;
    var eps = 0.0005;
    if (Math.abs(_tRotX - kRotX) > eps)  { kRotX += (_tRotX - kRotX) * _kEasing; changed = true; }
    if (Math.abs(_tRotY - kRotY) > eps)  { kRotY += (_tRotY - kRotY) * _kEasing; changed = true; }
    if (Math.abs(_tScl  - kScl)  > 0.001){ kScl  += (_tScl  - kScl)  * _kEasing; changed = true; }
    if (Math.abs(_tCx   - kCx)   > 0.001){ kCx   += (_tCx   - kCx)   * _kEasing; changed = true; }
    if (Math.abs(_tCy   - kCy)   > 0.001){ kCy   += (_tCy   - kCy)   * _kEasing; changed = true; }
    if (Math.abs(_tCz   - kCz)   > 0.001){ kCz   += (_tCz   - kCz)   * _kEasing; changed = true; }
    if (changed) {
      drawKsFast();
      _kAnimId = requestAnimationFrame(tick);
    } else {
      // Snap to exact targets
      kRotX=_tRotX; kRotY=_tRotY; kScl=_tScl; kCx=_tCx; kCy=_tCy; kCz=_tCz;
      _kAnimId = null;
      drawKsFast();   // no longer moving: redraw the complete cloud
    }
  }
  _kAnimId = requestAnimationFrame(tick);
}

function setKSpaceTarget(rx, ry, s, cx, cy, cz, instant) {
  if (instant) {
    kRotX=_tRotX=rx; kRotY=_tRotY=ry; kScl=_tScl=s; kCx=_tCx=cx; kCy=_tCy=cy; kCz=_tCz=cz;
    drawKs();
  } else {
    _tRotX=rx; _tRotY=ry; _tScl=s; _tCx=cx; _tCy=cy; _tCz=cz;
    startKSpaceAnim();
  }
}
document.getElementById("kdot").oninput=function(){kDotSize=parseInt(this.value);drawKs();};
document.getElementById("kunit").onclick=function(){
  kUnit=kUnit==="cyc"?"rad":"cyc";this.textContent=kUnit==="cyc"?"Unit: 1/m":"Unit: rad/m";drawKs();
};

/* ── Theme selector (toolbar) ─────────────────────────────────────── */
var themeSelect=document.getElementById("theme");
var systemThemeQuery=(typeof window.matchMedia==="function")?window.matchMedia("(prefers-color-scheme: dark)"):null;
var inVsCode=!!vscApi;
function storageGet(k){try{return localStorage.getItem(k);}catch(_){return null;}}
function storageSet(k,v){try{localStorage.setItem(k,v);}catch(_){}}
function clearThemeClasses(){
  var b=document.body,rm=[];
  b.classList.forEach(function(c){if(c.indexOf("theme-")===0)rm.push(c);});
  rm.forEach(function(c){b.classList.remove(c);});
}
function redrawAfterThemeChange(){
  mmCache=null;
  draw();drawKs();drawMinimap();
  if(typeof SeqEyesPanel!=='undefined')SeqEyesPanel.onThemeChanged();
}
function applyThemeChoice(value,persist){
  if(!value)value="system";
  clearThemeClasses();
  if(value!=="system"){
    document.body.classList.add("theme-"+value);
  }else if(!inVsCode){
    document.body.classList.add(systemThemeQuery&&systemThemeQuery.matches?"theme-github":"theme-githublight");
  }
  if(themeSelect&&themeSelect.value!==value)themeSelect.value=value;
  if(persist)storageSet("seqeyes.theme",value);
  redrawAfterThemeChange();
}
if(themeSelect){
  var savedTheme=storageGet("seqeyes.theme")||"system";
  if(!themeSelect.querySelector('option[value="'+savedTheme+'"]'))savedTheme="system";
  themeSelect.onchange=function(){applyThemeChoice(this.value,true);};
  applyThemeChoice(savedTheme,false);
}
if(systemThemeQuery){
  var onSystemTheme=function(){if(!themeSelect||themeSelect.value==="system")applyThemeChoice("system",false);};
  if(systemThemeQuery.addEventListener)systemThemeQuery.addEventListener("change",onSystemTheme);
  else if(systemThemeQuery.addListener)systemThemeQuery.addListener(onSystemTheme);
}

/* ═══════════════════════════════════════════════════════════════════════
   WebGL state
   ═══════════════════════════════════════════════════════════════════════ */
var gl=null, glProgram=null, glBuf=null, glN=0;
var glAttribPos=-1, glAttribTime=-1;
var glU_cy=-1,glU_sy=-1,glU_cx=-1,glU_sx=-1,glU_center=-1,glU_scale=-1;
var glU_halfRes=-1,glU_tMin=-1,glU_tMax=-1,glU_dot=-1,glU_color=-1;

// ── Cached bounds (computed once when data is uploaded) ──────────────
var _kBxmin=0,_kBxmax=0,_kBymin=0,_kBymax=0,_kBzmin=0,_kBzmax=0,_kBrng=0;
var _kBoundsDirty=true;  // set true when new data arrives

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
  return !!(kDragging||_kTouchActive||_kAnimId);
}

/** Points to keep on screen while the camera is moving. */
var KSPACE_MOVING_POINT_TARGET = 600000;

/**
 * Stride to draw the cloud with while the camera is moving.
 *
 * Window culling cannot help when the whole sequence is in view: every point
 * really is visible, and 6.4 million of them onto a few hundred thousand
 * pixels costs about a second a frame.  While the camera moves, every k-th
 * point is drawn instead.
 *
 * This is a true subset — each drawn point is a real ADC k-space location, and
 * nothing is interpolated or invented.  The moment the drag or the easing
 * settles the full set is redrawn, so the image actually being read is always
 * exact; only the motion is cheaper.  A subset also needs no extra memory: the
 * buffer is interleaved x,y,z,t at 16 bytes, so widening the attribute stride
 * to 16k selects every k-th vertex with no CPU work and no second upload.
 *
 * Returns 1 below the target, so narrow views and modest sequences are drawn
 * exactly even in motion.
 */
function kSpaceMovingStride(count){
  // The target is overridable so the settle-exactness guarantee can be tested
  // against a fixture small enough to ship; no repository fixture exceeds it.
  var target=(typeof window!=='undefined'&&window.__kMovingPointTarget>0)
    ?window.__kMovingPointTarget:KSPACE_MOVING_POINT_TARGET;
  if(!(count>target))return 1;
  return Math.ceil(count/target);
}

/** True while a drag, touch gesture, or camera easing is in progress. */
function kSpaceCameraMoving(){
  return !!(kDragging||_kTouchActive||_kAnimId);
}

/**
 * First index and count of the ADC points whose time lies in `[vs, ve]`.
 *
 * `kAdcTime` ascends by construction — src/pulseq/kspace.ts fills it block by
 * block in sequence order — and `uploadKSpaceGPU` writes the GPU buffer in that
 * same order, so the visible window is one contiguous run of vertices.
 *
 * Drawing only that run is not a reduction.  The vertex shader already rejects
 * everything outside the window with `gl_PointSize = 0` and a `discard`, so the
 * pixels are identical; the GPU simply stops transforming millions of points in
 * order to throw them away.  A 1.1 ms view of a 16 s sequence was submitting
 * 3.38 million vertices to draw about 218 of them.
 *
 * The range is padded by one point on each side and the shader keeps its own
 * time test, so an off-by-one here cannot change what is drawn.
 *
 * Pure and parameterised on purpose: the standalone app runs its renderer in an
 * IIFE with its own state and calls this global.  Do not copy it into
 * web/index.html — a copy there would shadow this one and diverge.
 */
function kSpaceWindowRange(times,total,vs,ve){
  if(!times||!(total>0)||!(ve>=vs))return{first:0,count:0};
  var n=Math.min(total,times.length),lo=0,hi=n,mid;
  while(lo<hi){mid=(lo+hi)>>1;if(times[mid]<vs)lo=mid+1;else hi=mid;}
  var first=Math.max(0,lo-1);
  lo=first;hi=n;
  while(lo<hi){mid=(lo+hi)>>1;if(times[mid]<=ve)lo=mid+1;else hi=mid;}
  return{first:first,count:Math.max(0,Math.min(n,lo+1)-first)};
}

/* ── Upload ADC k‑space data to GPU (called after base64 decode) ────── */
function uploadKSpaceGPU(){
  if(!kAdc||!kAdc[0]||kAdc[0].length===0){glN=0;return;}
  if(!gl&&!initWebGL())return;
  var n=kAdc[0].length;
  var data=new Float32Array(n*4);
  var ax=kAdc[0],ay=kAdc[1],az=kAdc[2],at=kAdcTime;
  for(var i=0;i<n;i++){var j=i*4;data[j]=ax[i];data[j+1]=ay[i];data[j+2]=az[i];data[j+3]=at[i];}
  if(glBuf)gl.deleteBuffer(glBuf);
  glBuf=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,glBuf);
  gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);
  glN=n;
  // Compute bounds once
  var xmin=Infinity,xmax=-Infinity,ymin=Infinity,ymax=-Infinity,zmin=Infinity,zmax=-Infinity;
  for(var a=0;a<n;a++){var xi=ax[a],yi=ay[a],zi=az[a];if(isFinite(xi)){if(xi<xmin)xmin=xi;if(xi>xmax)xmax=xi;}if(isFinite(yi)){if(yi<ymin)ymin=yi;if(yi>ymax)ymax=yi;}if(isFinite(zi)){if(zi<zmin)zmin=zi;if(zi>zmax)zmax=zi;}}
  _kBxmin=xmin;_kBxmax=xmax;_kBymin=ymin;_kBymax=ymax;_kBzmin=zmin;_kBzmax=zmax;
  _kBrng=Math.max(xmax-xmin,ymax-ymin,zmax-zmin,1e-6);
  _kBoundsDirty=false;
}

/* ═══════════════════════════════════════════════════════════════════════
   Toggle / View cycle / Canvas sizing
   ═══════════════════════════════════════════════════════════════════════ */
/* The panel toggle moved to panel.js: one button now cycles
   off -> k-space -> spectrogram -> off, and only the off -> k-space
   transition passes through the safety gate. `kOpen` is still the flag the
   drawing and interaction code reads, and panel.js keeps it in sync. */
document.getElementById("kax").textContent="3D";
document.getElementById("krst").onclick=function(){
  kView="3d";
  document.getElementById("kax").textContent="3D";
  var af=_kAutoFitVals();
  setKSpaceTarget(-0.5, 0.7, af.scl, af.cx, af.cy, af.cz, false);
};
// Camera presets: smoothly rotate to look straight down an axis
document.getElementById("kax").onclick=function(){
  var views=["3d","xy","xz","yz"];var idx=views.indexOf(kView);
  kView=views[(idx+1)%4];
  var trx=_tRotX, tr=_tRotY;
  if(kView==="xy"){trx=0; tr=0;}
  else if(kView==="xz"){trx=-Math.PI/2; tr=0;}
  else if(kView==="yz"){trx=0; tr=Math.PI/2;}
  else{trx=-0.5; tr=0.7;}  // 3d — default perspective
  document.getElementById("kax").textContent=kView.toUpperCase();
  var af=_kAutoFitVals();
  setKSpaceTarget(trx, tr, af.scl, af.cx, af.cy, af.cz, false);
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

/* ── Cursor-linked trajectory sample ─────────────────────────────────── */
function nearestTimeIndex(times,t){
  if(!times||!times.length||!isFinite(t))return -1;
  var lo=0,hi=times.length-1;
  if(t<=times[0])return 0;
  if(t>=times[hi])return hi;
  while(lo<hi){
    var mid=(lo+hi)>>1;
    if(times[mid]<t)lo=mid+1;else hi=mid;
  }
  var a=lo,b=lo-1;
  if(b<0)return a;
  return Math.abs(times[a]-t)<Math.abs(times[b]-t)?a:b;
}
function sampleSeriesAtTime(times,series,t){
  if(!times||!series||!series[0]||!times.length)return null;
  var n=Math.min(times.length,series[0].length,series[1].length,series[2].length);
  if(n<=0)return null;
  var idx=nearestTimeIndex(times,t);
  if(idx<0)return null;
  if(t<=times[0]||t>=times[n-1]){
    idx=Math.max(0,Math.min(n-1,idx));
    return {x:series[0][idx],y:series[1][idx],z:series[2][idx],t:times[idx],source:"traj"};
  }
  var upper=idx;
  if(times[upper]<t)upper++;
  upper=Math.max(1,Math.min(n-1,upper));
  var lower=upper-1,t0=times[lower],t1=times[upper];
  if(!isFinite(t0)||!isFinite(t1)||Math.abs(t1-t0)<1e-15){
    return {x:series[0][idx],y:series[1][idx],z:series[2][idx],t:times[idx],source:"traj"};
  }
  var a=Math.max(0,Math.min(1,(t-t0)/(t1-t0)));
  return {
    x:series[0][lower]+(series[0][upper]-series[0][lower])*a,
    y:series[1][lower]+(series[1][upper]-series[1][lower])*a,
    z:series[2][lower]+(series[2][upper]-series[2][lower])*a,
    t:t,
    source:"traj"
  };
}
function getKCursorSample(){
  if(!cursorActive||!isFinite(cursorT))return null;
  if(kAdc&&kAdcTime&&kAdc[0]&&kAdcTime.length){
    var idx=nearestTimeIndex(kAdcTime,cursorT);
    if(idx>=0){
      var prev=idx>0?Math.abs(kAdcTime[idx]-kAdcTime[idx-1]):Infinity;
      var next=idx+1<kAdcTime.length?Math.abs(kAdcTime[idx+1]-kAdcTime[idx]):Infinity;
      var localStep=Math.min(prev,next);
      if(!isFinite(localStep))localStep=minRasterTime();
      var tol=Math.max(minRasterTime()*0.5,localStep*0.75);
      if(Math.abs(kAdcTime[idx]-cursorT)<=tol){
        return {x:kAdc[0][idx],y:kAdc[1][idx],z:kAdc[2][idx],t:kAdcTime[idx],source:"adc"};
      }
    }
  }
  return sampleSeriesAtTime(kTime,kTraj,cursorT);
}
function fmtKShort(v){
  var u=kUnitVal(v);
  if(!isFinite(u))return "--";
  if(Math.abs(u)>=1000)return (u/1000).toFixed(1)+"k";
  if(Math.abs(u)>=10)return u.toFixed(1);
  if(Math.abs(u)>=0.01)return u.toFixed(2);
  return u.toExponential(1);
}
function formatKCursorReadout(){
  var s=getKCursorSample();
  if(!s)return "";
  return "kxyz="+fmtKShort(s.x)+","+fmtKShort(s.y)+","+fmtKShort(s.z)+" "+kUnitStr();
}
function drawKCursorMarker(ctx,proj,cs,W,H){
  var s=getKCursorSample();
  if(!s||!isFinite(s.x)||!isFinite(s.y)||!isFinite(s.z))return;
  var p=proj(s.x,s.y,s.z);
  if(p.x<-12||p.x>W+12||p.y<-12||p.y>H+12)return;
  ctx.save();
  ctx.lineWidth=2;
  ctx.strokeStyle=cs.getPropertyValue("--cr").trim()||"#ee0000";
  ctx.fillStyle="rgba(255,215,0,0.90)";
  ctx.beginPath();ctx.arc(p.x,p.y,Math.max(5,kDotSize+4),0,6.283);ctx.fill();ctx.stroke();
  ctx.fillStyle=cs.getPropertyValue("--fg").trim();
  ctx.font="10px monospace";
  ctx.textAlign="left";
  ctx.fillText(s.source==="adc"?"ADC":"ktraj",p.x+8,p.y-8);
  ctx.restore();
}

/* ── Mouse ───────────────────────────────────────────────────────────── */
kCanvas.addEventListener("mousedown",function(e){
  kDragging=true;kDragPrev={x:e.clientX,y:e.clientY};kDragBtn=e.button;
  // Cancel any running animation so it doesn't fight the drag
  if(_kAnimId){cancelAnimationFrame(_kAnimId);_kAnimId=null;}
  e.preventDefault();
});
kCanvas.addEventListener("contextmenu",function(e){e.preventDefault();});

kCanvas.addEventListener("wheel",function(e){e.preventDefault();
  var r=kCanvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  var mx=(e.clientX-r.left)/dpr, my=(e.clientY-r.top)/dpr;
  var zf=e.deltaY<0?1.25:0.8, W=kCanvas.width/dpr, H=kCanvas.height/dpr;
  var dz=(1-1/zf)*dpr/kScl;
  kAutoFit=false;
  setKSpaceTarget(kRotX, kRotY, kScl*zf, kCx+(mx-W/2)*dz, kCy-(my-H/2)*dz, kCz, false);
},{passive:false});

window.addEventListener("mousemove",function(e){
  if(!kDragging||!kDragPrev||!kOpen||panelMode!=="kspace")return;
  var dx=e.clientX-kDragPrev.x, dy=e.clientY-kDragPrev.y;
  kDragPrev={x:e.clientX,y:e.clientY};
  if(kView!=="3d"){kView="3d";document.getElementById("kax").textContent="3D";}
  if(kDragBtn===0){
    // left drag = instant rotate (no lerp — feels responsive)
    kRotY+=dx*0.008; kRotX-=dy*0.008;
    _tRotY=kRotY; _tRotX=kRotX;  // sync targets
  }else{
    // right/middle drag = instant pan
    var cz=Math.cos(kRotY),sz=Math.sin(kRotY),cx=Math.cos(kRotX),sx=Math.sin(kRotX);
    var dpr=window.devicePixelRatio||1;
    dx/=(dpr*kScl); dy/=(dpr*kScl);
    if(Math.abs(cz)>0.01){kCy+=dy/cx;kCx+=(-dx-sz*sx*(dy/cx))/cz;}
    else{kCy+=dy/cx;kCz+=(dx-cz*sx*(dy/cx))/sz;}
    _tCy=kCy; _tCx=kCx; _tCz=kCz;  // sync targets
    kAutoFit=false;
  }
  scheduleKsDragDraw();
});
window.addEventListener("mouseup",function(){
  if(!kDragging)return;
  kDragging=false;kDragPrev=null;
  drawKsFast();   // settled: replace the moving subset with every point
});

/** Draw at most once per frame, always from the latest rotation. */
function scheduleKsDragDraw(){
  if(_kDragRaf)return;
  _kDragRaf=requestAnimationFrame(function(){_kDragRaf=0;drawKsFast();});
}

/* ── Touch: 3D k-space viewer ─────────────────────────────────────── */
var _kTouchActive=false,_kTouchPrev=null,_kTouchPinch0=0,_kTouchMid=null,_kTouchBtn=0;
kCanvas.addEventListener("touchstart",function(e){
  if(_kAnimId){cancelAnimationFrame(_kAnimId);_kAnimId=null;}
  if(e.touches.length===1){
    _kTouchActive=true;_kTouchBtn=0;
    _kTouchPrev={x:e.touches[0].clientX,y:e.touches[0].clientY};
  }else if(e.touches.length===2){
    _kTouchActive=true;_kTouchBtn=1;
    _kTouchPinch0=getTouchDist(e.touches);
    _kTouchMid=getTouchMid(e.touches);
    _kTouchPrev={x:_kTouchMid.x,y:_kTouchMid.y};
  }
  e.preventDefault();
},{passive:false});
kCanvas.addEventListener("touchmove",function(e){
  if(!_kTouchActive||!_kTouchPrev||!kOpen||panelMode!=="kspace")return;
  if(kView!=="3d"){kView="3d";document.getElementById("kax").textContent="3D";}
  if(e.touches.length===1&&_kTouchBtn===0){
    // 1‑finger rotate
    var dx=e.touches[0].clientX-_kTouchPrev.x;
    var dy=e.touches[0].clientY-_kTouchPrev.y;
    _kTouchPrev={x:e.touches[0].clientX,y:e.touches[0].clientY};
    kRotY+=dx*0.008; kRotX-=dy*0.008;
    _tRotY=kRotY; _tRotX=kRotX;
    drawKsFast();
  }else if(e.touches.length===2){
    // 2‑finger pinch-zoom + pan
    var d=getTouchDist(e.touches);
    if(_kTouchPinch0>0){
      var zf=d/_kTouchPinch0;
      kScl*=zf; kScl=Math.max(0.001,Math.min(1e6,kScl));
      _tScl=kScl; kAutoFit=false;
      _kTouchPinch0=d;
    }
    var mid=getTouchMid(e.touches);
    var pdx=(mid.x-_kTouchPrev.x), pdy=(mid.y-_kTouchPrev.y);
    _kTouchPrev={x:mid.x,y:mid.y};
    var cz=Math.cos(kRotY),sz=Math.sin(kRotY),cx=Math.cos(kRotX),sx=Math.sin(kRotX);
    var dpr=window.devicePixelRatio||1;
    pdx/=(dpr*kScl); pdy/=(dpr*kScl);
    if(Math.abs(cz)>0.01){kCy+=pdy/cx;kCx+=(-pdx-sz*sx*(pdy/cx))/cz;}
    else{kCy+=pdy/cx;kCz+=(pdx-cz*sx*(pdy/cx))/sz;}
    _tCy=kCy; _tCx=kCx; _tCz=kCz; kAutoFit=false;
    drawKsFast();
  }
  e.preventDefault();
},{passive:false});
kCanvas.addEventListener("touchend",function(e){
  _kTouchActive=false;_kTouchPrev=null;_kTouchPinch0=0;_kTouchMid=null;
  if(!e.touches.length)drawKsFast();
  if(e.touches.length===1){
    // Transition from 2‑finger to 1‑finger
    _kTouchActive=true;_kTouchBtn=0;
    _kTouchPrev={x:e.touches[0].clientX,y:e.touches[0].clientY};
  }
});
kCanvas.addEventListener("touchcancel",function(){
  _kTouchActive=false;_kTouchPrev=null;_kTouchPinch0=0;_kTouchMid=null;
  drawKsFast();
});

/* ── Resize handle ───────────────────────────────────────────────────── */
/* Seeded from storage, not from the 500/300 defaults: the panel size now
   survives a reload, so starting a drag from the default would snap the panel
   back to it before the first mouse move is applied. */
var kResizing=false, kResizeStart=0,
    kResizeW=panelStoredWidth(), kResizeH=panelStoredHeight();
document.getElementById("khandle").addEventListener("mousedown",function(e){
  kResizing=true;
  if(typeof layoutMode!=='undefined'&&layoutMode==='vertical')kResizeStart=e.clientY;
  else kResizeStart=e.clientX;
  e.preventDefault();e.stopPropagation();
});
document.getElementById("khandle").addEventListener("touchstart",function(e){
  kResizing=true;
  if(typeof layoutMode!=='undefined'&&layoutMode==='vertical')kResizeStart=e.touches[0].clientY;
  else kResizeStart=e.touches[0].clientX;
  e.preventDefault();e.stopPropagation();
},{passive:false});
window.addEventListener("mousemove",function(e){
  if(!kResizing||!panelOpen)return;
  var p=document.getElementById("right");
  var vertical=(typeof layoutMode!=='undefined'&&layoutMode==='vertical');
  if(vertical){
    kResizeH=Math.max(120,Math.min(typeof panelMaxHeight==='function'?panelMaxHeight():800,kResizeH-(e.clientY-kResizeStart)));
    kResizeStart=e.clientY;
    p.style.setProperty('height',kResizeH+'px','important');p.style.setProperty('transition','none','important');
  }else{
    kResizeW=Math.max(200,Math.min(1200,kResizeW-(e.clientX-kResizeStart)));
    kResizeStart=e.clientX;
    p.style.width=kResizeW+"px";p.style.transition="none";
  }
  persistPanelSize();
  panelHandleResize();
});
window.addEventListener("touchmove",function(e){
  if(!kResizing||!panelOpen||e.touches.length!==1)return;
  var p=document.getElementById("right");
  var vertical=(typeof layoutMode!=='undefined'&&layoutMode==='vertical');
  if(vertical){
    kResizeH=Math.max(120,Math.min(typeof panelMaxHeight==='function'?panelMaxHeight():800,kResizeH-(e.touches[0].clientY-kResizeStart)));
    kResizeStart=e.touches[0].clientY;
    p.style.setProperty('height',kResizeH+'px','important');p.style.setProperty('transition','none','important');
  }else{
    kResizeW=Math.max(200,Math.min(1200,kResizeW-(e.touches[0].clientX-kResizeStart)));
    kResizeStart=e.touches[0].clientX;
    p.style.width=kResizeW+"px";p.style.transition="none";
  }
  persistPanelSize();
  panelHandleResize();
},{passive:false});
window.addEventListener("mouseup",function(){
  if(kResizing){
    kResizing=false;
    var p=document.getElementById("right");
    var vertical=(typeof layoutMode!=='undefined'&&layoutMode==='vertical');
    if(vertical){p.style.setProperty('transition','height .25s','important');}
    else{p.style.transition='';}
  }
});
window.addEventListener("touchend",function(){
  if(kResizing){
    kResizing=false;
    var p=document.getElementById("right");
    var vertical=(typeof layoutMode!=='undefined'&&layoutMode==='vertical');
    if(vertical){p.style.setProperty('transition','height .25s','important');}
    else{p.style.transition='';}
  }
});
window.addEventListener("resize",function(){if(kOpen){resizeKc();drawKs();}});

/* The panel size is shared by both panes, so it is stored once and
   applyLayoutMode()/setPanelMode() read it back on every open. */
function persistPanelSize(){
  try{
    if(typeof layoutMode!=='undefined'&&layoutMode==='vertical')localStorage.setItem('seqeyes.panelHeight',String(kResizeH));
    else localStorage.setItem('seqeyes.panelWidth',String(kResizeW));
  }catch(_){/* private mode */}
}

/* ═══════════════════════════════════════════════════════════════════════
   Nice tick spacing
   ═══════════════════════════════════════════════════════════════════════ */
function kNice(range){var ms=[1,2,5,10,20,50,100,200,500];for(var i=0;i<ms.length;i++){var b=Math.pow(10,Math.floor(Math.log10(range)));if(ms[i]*b>=range/4)return ms[i]*b;}return 1;}

function _kAutoFitVals(){
  var rng=_kBrng||1,W=kCanvas.width/(window.devicePixelRatio||1),H=kCanvas.height/(window.devicePixelRatio||1);
  return{cx:(_kBxmin+_kBxmax)/2,cy:(_kBymin+_kBymax)/2,cz:(_kBzmin+_kBzmax)/2,scl:Math.min(W,H)/(rng*1.15)};
}

/* ═══════════════════════════════════════════════════════════════════════
   Drawing  (Canvas 2D axes + WebGL scatter)
   ═══════════════════════════════════════════════════════════════════════ */

/** First‑open initialisation: sizes canvases to the KNOWN CSS target
 *  dimensions so auto‑fit never sees a mid‑transition partial size. */
function drawKs_init(){
  var dpr=window.devicePixelRatio||1;
  var vertical=(typeof layoutMode!=='undefined'&&layoutMode==='vertical');
  var targetW=vertical?document.getElementById("right").getBoundingClientRect().width||500:500;
  var targetH=vertical?300:document.getElementById("right").getBoundingClientRect().height||500;
  if(targetW<=0)targetW=500;
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

/** Fast draw: skips canvas resize (use during drag for responsiveness). */
function drawKsFast(){
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

  // ── Use cached bounds (computed once in uploadKSpaceGPU) ──────────
  if (_kBoundsDirty || !isFinite(_kBxmin)) {
    // Recompute if needed (shouldn't happen normally)
    var xmin=Infinity,xmax=-Infinity,ymin=Infinity,ymax=-Infinity,zmin=Infinity,zmax=-Infinity;
    for(var a=0;a<nAdc;a++){var xi=adcX[a],yi=adcY[a],zi=adcZ[a];if(isFinite(xi)){if(xi<xmin)xmin=xi;if(xi>xmax)xmax=xi;}if(isFinite(yi)){if(yi<ymin)ymin=yi;if(yi>ymax)ymax=yi;}if(isFinite(zi)){if(zi<zmin)zmin=zi;if(zi>zmax)zmax=zi;}}
    _kBxmin=xmin;_kBxmax=xmax;_kBymin=ymin;_kBymax=ymax;_kBzmin=zmin;_kBzmax=zmax;
    _kBrng=Math.max(xmax-xmin,ymax-ymin,zmax-zmin,1e-6);
    _kBoundsDirty=false;
  }
  if(!isFinite(_kBxmin)){ctx.fillStyle="#f00";ctx.font="11px monospace";ctx.fillText("ALL NaN",10,20);return;}

  // ── Auto-fit (initial open only) ──
  if(kAutoFit){
    kAutoFit=false;
    var af=_kAutoFitVals();
    setKSpaceTarget(kRotX, kRotY, af.scl, af.cx, af.cy, af.cz, false);
  }

  // ── Time window ──
  var visibleRange=visibleDuration(),vs=ox,ve=ox+visibleRange;

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

    var win=kSpaceWindowRange(kAdcTime,glN,vs,ve);
    var stride=kSpaceCameraMoving()?kSpaceMovingStride(win.count):1;

    gl.bindBuffer(gl.ARRAY_BUFFER,glBuf);
    gl.enableVertexAttribArray(glAttribPos);
    gl.vertexAttribPointer(glAttribPos,3,gl.FLOAT,false,16*stride,0);
    gl.enableVertexAttribArray(glAttribTime);
    gl.vertexAttribPointer(glAttribTime,1,gl.FLOAT,false,16*stride,12);

    kSpaceTrajectoryDrawCount++;
    // Stride reindexes the buffer, so the window offset and count scale with it.
    var drawFirst=Math.floor(win.first/stride),drawCount=Math.floor(win.count/stride);
    if(drawCount>0)gl.drawArrays(gl.POINTS,drawFirst,drawCount);
  }

  drawKsOverlay(W,H,dpr,cs);
}

/** Redraw only the lightweight 2D axes/cursor layer. The WebGL trajectory
 * remains untouched when waveform hover changes cursorT. */
function drawKsOverlayFast(){
  if(!kOpen||!kAdc||!kAdcTime||!kAdc[0]||kAdc[0].length===0)return;
  var dpr=window.devicePixelRatio||1;
  var W=kCanvas.width/dpr,H=kCanvas.height/dpr;
  if(W<=0||H<=0)return;
  drawKsOverlay(W,H,dpr,getComputedStyle(document.body));
}

function drawKsOverlay(W,H,dpr,cs){
  kSpaceOverlayDrawCount++;
  var ctx=kCtx;ctx.clearRect(0,0,W,H);
  if(!kOpen||!isFinite(_kBxmin))return;
  var rng3=_kBrng;
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
  drawKCursorMarker(ctx,proj,cs,W,H);
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
