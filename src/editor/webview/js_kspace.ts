/**
 * K-space viewer — scatter-only, 2D/3D, zoom/pan/rotate, axis ticks.
 * 3D view is default.  Right/middle drag pans in 3D.
 */
export const JS_KSPACE = `
var kOpen=false, kView="3d";
var kCx=0, kCy=0, kCz=0, kScl=1;    // view center & zoom
var kAutoFit=true;
var kRotX=-0.5, kRotY=0.7;
var kDragging=false, kDragPrev=null, kDragBtn=0;
var kCanvas=document.getElementById("kc"), kCtx=kCanvas.getContext("2d");
var kDotSize=2, kUnit="cyc";         // cyc=cycles/m, rad=rad/m
document.getElementById("kdot").oninput=function(){kDotSize=parseInt(this.value);drawKs();};
document.getElementById("kunit").onclick=function(){
  kUnit=kUnit==="cyc"?"rad":"cyc";this.textContent=kUnit==="cyc"?"U":"U\u0302";drawKs();
};

/* ── Toggle ──────────────────────────────────────────────────────────── */
document.getElementById("kbtn").onclick=function(){
  kOpen=!kOpen;
  var p=document.getElementById("right");
  if(kOpen){p.classList.add("open");this.textContent="K \u2715";kAutoFit=true;}else{p.classList.remove("open");this.textContent="K";}
  requestAnimationFrame(function(){resizeKc();drawKs();});
};
document.getElementById("kax").textContent="3D";

/* ── View cycle ──────────────────────────────────────────────────────── */
document.getElementById("krst").onclick=function(){kAutoFit=true;kRotX=-0.5;kRotY=0.7;drawKs();};
document.getElementById("kax").onclick=function(){
  var views=["3d","xy","xz","yz"];var idx=views.indexOf(kView);kView=views[(idx+1)%4];
  kAutoFit=true;document.getElementById("kax").textContent=kView.toUpperCase();drawKs();
};

/* ── Canvas sizing ───────────────────────────────────────────────────── */
function resizeKc(){
  var r=document.getElementById("right").getBoundingClientRect();
  if(r.width<=0||r.height<=0)return;
  var dpr=window.devicePixelRatio||1;
  kCanvas.width=r.width*dpr;kCanvas.height=r.height*dpr;
  kCanvas.style.width=r.width+"px";kCanvas.style.height=r.height+"px";
  kCtx.setTransform(dpr,0,0,dpr,0,0);
}

/* ── Convert k-space value to display units ──────────────────────────── */
function kUnitVal(v){if(kUnit==="rad")return v*6.283185;return v;}
function kUnitStr(){return kUnit==="rad"?"rad/m":"cycles/m";}
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
  kScl*=zf;kAutoFit=false;
  kCx+=(mx-W/2)*(1-zf)/kScl;
  kCy+=(my-H/2)*(1-zf)/kScl;
  drawKs();
},{passive:false});

window.addEventListener("mousemove",function(e){
  if(!kDragging||!kDragPrev||!kOpen)return;
  var dx=e.clientX-kDragPrev.x, dy=e.clientY-kDragPrev.y;
  kDragPrev={x:e.clientX,y:e.clientY};
  if(kView==="3d"){
    if(kDragBtn===0){
      // Left drag = rotate
      kRotY+=dx*0.008;kRotX-=dy*0.008;
    }else if(kDragBtn===2||kDragBtn===1){
      // Right/middle drag = pan (proper 3D pan using inverse rotation)
      var cz=Math.cos(kRotY),sz=Math.sin(kRotY),cx=Math.cos(kRotX),sx=Math.sin(kRotX);
      var dpr=window.devicePixelRatio||1;
      dx/=(dpr*kScl); dy/=(dpr*kScl);
      // Inverse rotation: move kC so screen point shifts by (-dx, -dy)
      // R = [cz, sz*sx, -sz*cx; 0, cx, sx; sz, -cz*sx, cz*cx]
      // screen_x changes by -R[0].d(kC); screen_y changes by +R[1].d(kC) (note sign)
      // We solve 2 eqns with d(kCz)=0:
      if(Math.abs(cz)>0.01){
        kCy += dy/cx;
        kCx += (-dx - sz*sx*(dy/cx))/cz;
      }else{
        // Rotated ~90 deg around Y, use sz instead
        kCy += dy/cx;
        kCz += (dx - cz*sx*(dy/cx))/sz;
      }
      kAutoFit=false;
    }
  }else{
    if(kDragBtn===0){kCx-=dx/kScl;kCy+=dy/kScl;kAutoFit=false;}
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
   Drawing
   ═══════════════════════════════════════════════════════════════════════ */
function drawKs(){
  resizeKc();
  var W=kCanvas.width/(window.devicePixelRatio||1),H=kCanvas.height/(window.devicePixelRatio||1);
  if(W<=0||H<=0)return;
  var ctx=kCtx,cs=getComputedStyle(document.body);
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle=cs.getPropertyValue("--bg").trim();ctx.fillRect(0,0,W,H);
  if(!kOpen)return;
  if(!kAdc||!kAdcTime||!kAdc[0]||!kAdc[0].length){ctx.fillStyle="#f00";ctx.font="11px monospace";ctx.fillText("NO ADC data",10,20);return;}

  var adcX=kAdc[0],adcY=kAdc[1],adcZ=kAdc[2], nAdc=adcX.length;

  // ── Bounds ──
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
  // 3D MODE
  // ═══════════════════════════════════════════════════════════════════
  if(kView==="3d"){
    var cz=Math.cos(kRotY),sz=Math.sin(kRotY),cxR=Math.cos(kRotX),sxR=Math.sin(kRotX);
    function proj(px,py,pz){
      var dx=px-kCx, dy=py-kCy, dz=pz-kCz;
      var rx=dx*cz-dz*sz;
      var rz2=dx*sz+dz*cz;
      var ry=dy*cxR-rz2*sxR;
      return {x:W/2+rx*kScl, y:H/2-ry*kScl};
    }

    // ── ADC scatter ──
    ctx.fillStyle=cs.getPropertyValue("--adc").trim();
    for(var a=0;a<nAdc;a++){
      if(kAdcTime[a]<vs||kAdcTime[a]>ve)continue;
      var pt=proj(adcX[a],adcY[a],adcZ[a]);
      if(pt.x<-50||pt.x>W+50||pt.y<-50||pt.y>H+50)continue;
      ctx.beginPath();ctx.arc(pt.x,pt.y,kDotSize,0,6.283);ctx.fill();
    }

    // ── Draw axes through k-space ORIGIN (absolute coords, pans/zooms with data) ──
    var tick=kNice(rng3);
    function drawAxis3D(fx,fy,fz,label,col){
      var al=rng3*0.65;
      // Use ABSOLUTE k-space positions so axis pans with the view
      var o=proj(0,0,0);
      var t1=proj(fx*al,fy*al,fz*al);
      var t2=proj(-fx*al,-fy*al,-fz*al);
      ctx.strokeStyle=col;ctx.lineWidth=1.6;ctx.setLineDash([]);
      ctx.beginPath();ctx.moveTo(t2.x,t2.y);ctx.lineTo(t1.x,t1.y);ctx.stroke();
      // Arrowhead
      ctx.fillStyle=col;ctx.beginPath();ctx.arc(t1.x,t1.y,4,0,6.283);ctx.fill();
      // Label
      ctx.fillStyle=col;ctx.font="bold 11px monospace";ctx.fillText(label,t1.x+5,t1.y-5);
      // Ticks at absolute positions
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
    // Origin dot
    var oo=proj(0,0,0);
    ctx.fillStyle=cs.getPropertyValue("--fg").trim();ctx.beginPath();ctx.arc(oo.x,oo.y,4,0,6.283);ctx.fill();
    // Unit info (bottom-left)
    ctx.fillStyle=cs.getPropertyValue("--lb").trim();ctx.font="9px monospace";ctx.textAlign="left";
    ctx.fillText("unit:"+kUnitStr(),6,H-4);
    // Change cursor when hovering over unit area
    var r2=kCanvas.getBoundingClientRect(),dpr2=window.devicePixelRatio||1;
    // (cursor is set in mousemove below)
  }
  // ═══════════════════════════════════════════════════════════════════
  // 2D MODE
  // ═══════════════════════════════════════════════════════════════════
  else{
    var ox2=W/2-kCx*kScl, oy2=H/2+kCy*kScl;
    function tx(px){return ox2+kUnitVal(px)*kScl;}function ty(py){return oy2-kUnitVal(py)*kScl;}

    // ── Pick axes ──
    var dX,dY,xl,yl,clX,clY;
    if(kView==="xy"){dX=adcX;dY=adcY;xl="kx";yl="ky";clX=cs.getPropertyValue("--gx").trim();clY=cs.getPropertyValue("--gy").trim();}
    else if(kView==="xz"){dX=adcX;dY=adcZ;xl="kx";yl="kz";clX=cs.getPropertyValue("--gx").trim();clY=cs.getPropertyValue("--gz").trim();}
    else{dX=adcY;dY=adcZ;xl="ky";yl="kz";clX=cs.getPropertyValue("--gy").trim();clY=cs.getPropertyValue("--gz").trim();}

    // ── Draw axes with ticks ──
    var xrng=kView==="yz"?ymax-ymin:xmax-xmin;
    var yrng=kView==="xz"?zmax-zmin:kView==="yz"?zmax-zmin:ymax-ymin;
    var xtick=kNice(xrng), ytick=kNice(yrng);
    ctx.lineWidth=1;ctx.setLineDash([]);
    // X axis
    ctx.strokeStyle=clX;ctx.beginPath();ctx.moveTo(20,oy2);ctx.lineTo(W-20,oy2);ctx.stroke();
    // Y axis
    ctx.strokeStyle=clY;ctx.beginPath();ctx.moveTo(ox2,20);ctx.lineTo(ox2,H-20);ctx.stroke();
    // X ticks
    ctx.fillStyle=cs.getPropertyValue("--lb").trim();ctx.font="9px monospace";ctx.textAlign="center";
    for(var v=xtick;v<=xrng*0.7;v+=xtick){
      var px=tx(v);if(px>25&&px<W-25){ctx.beginPath();ctx.moveTo(px,oy2-4);ctx.lineTo(px,oy2+4);ctx.strokeStyle=clX;ctx.stroke();ctx.fillText(kTickVal(v),px,oy2+14);}
      var nx=tx(-v);if(nx>25&&nx<W-25){ctx.beginPath();ctx.moveTo(nx,oy2-4);ctx.lineTo(nx,oy2+4);ctx.strokeStyle=clX;ctx.stroke();ctx.fillText(kTickVal(-v),nx,oy2+14);}
    }
    // Y ticks
    ctx.textAlign="right";
    for(var v=ytick;v<=yrng*0.7;v+=ytick){
      var py=ty(v);if(py>25&&py<H-25){ctx.beginPath();ctx.moveTo(ox2-4,py);ctx.lineTo(ox2+4,py);ctx.strokeStyle=clY;ctx.stroke();ctx.fillText(kTickVal(v),ox2-6,py+3);}
      var ny=ty(-v);if(ny>25&&ny<H-25){ctx.beginPath();ctx.moveTo(ox2-4,ny);ctx.lineTo(ox2+4,ny);ctx.strokeStyle=clY;ctx.stroke();ctx.fillText(kTickVal(-v),ox2-6,ny+3);}
    }
    // Axis labels
    ctx.fillStyle=clX;ctx.font="bold 11px monospace";ctx.textAlign="center";ctx.fillText(xl+" ("+kUnitStr()+")",W-10,oy2-8);
    ctx.fillStyle=clY;ctx.textAlign="left";ctx.fillText(yl+" ("+kUnitStr()+")",ox2+8,14);
    // Origin
    ctx.fillStyle=cs.getPropertyValue("--fg").trim();ctx.beginPath();ctx.arc(ox2,oy2,3,0,6.283);ctx.fill();

    // ── ADC scatter ──
    ctx.fillStyle=cs.getPropertyValue("--adc").trim();
    for(var a=0;a<nAdc;a++){
      if(kAdcTime[a]<vs||kAdcTime[a]>ve)continue;
      ctx.beginPath();ctx.arc(tx(dX[a]),ty(dY[a]),kDotSize,0,6.283);ctx.fill();
    }
  }

  // ── Unit switch (bottom-left) ──
  ctx.fillStyle=cs.getPropertyValue("--lb").trim();ctx.font="9px monospace";ctx.textAlign="left";
  ctx.fillText("unit:"+kUnitStr()+" (click)",6,H-4);
}
`;
