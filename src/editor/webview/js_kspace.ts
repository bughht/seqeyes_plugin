/**
 * K-space viewer — 2D projections + 3D rotation, zoom & pan.
 * ADC points are synchronised with the left panel's time zoom.
 */
export const JS_KSPACE = `
var kOpen=false, kView="xy";
var kCx=0, kCy=0, kScl=1;            // view center (k-space coords) & zoom
var kAutoFit=true;                    // auto-fit to data bounds
var kRotX=-0.6, kRotY=0.8;           // 3D rotation
var kDragging=false, kDragPrev=null, kPanning=false;
var kCanvas=document.getElementById("kc"), kCtx=kCanvas.getContext("2d");

document.getElementById("kbtn").onclick=function(){
  kOpen=!kOpen;
  var p=document.getElementById("right");
  if(kOpen){p.classList.add("open");this.textContent="K \u2715";kAutoFit=true;}else{p.classList.remove("open");this.textContent="K";}
  requestAnimationFrame(function(){resizeKc();drawKs();});
};

document.getElementById("krst").onclick=function(){kAutoFit=true;kRotX=-0.6;kRotY=0.8;drawKs();};
document.getElementById("kax").onclick=function(){
  var views=["xy","xz","yz","3d"];var idx=views.indexOf(kView);kView=views[(idx+1)%4];
  kAutoFit=true;document.getElementById("kax").textContent=kView.toUpperCase();drawKs();
};
document.getElementById("kax").textContent="XY";

function resizeKc(){
  var r=document.getElementById("right").getBoundingClientRect();
  if(r.width<=0||r.height<=0)return;
  var dpr=window.devicePixelRatio||1;
  kCanvas.width=r.width*dpr;kCanvas.height=r.height*dpr;
  kCanvas.style.width=r.width+"px";kCanvas.style.height=r.height+"px";
  kCtx.setTransform(dpr,0,0,dpr,0,0);
}

/* ── Mouse / wheel ───────────────────────────────────────────────────── */
kCanvas.addEventListener("mousedown",function(e){
  if(e.button===0){kDragging=true;kDragPrev={x:e.clientX,y:e.clientY};kPanning=!e.shiftKey;}
});
kCanvas.addEventListener("wheel",function(e){e.preventDefault();
  var r=kCanvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  var mx=e.clientX-r.left,my=e.clientY-r.top;mx/=dpr;my/=dpr;
  var zf=e.deltaY<0?1.25:0.8, W=kCanvas.width/dpr, H=kCanvas.height/dpr;
  kScl*=zf;kAutoFit=false;
  kCx+=(mx-W/2)*(1-zf)/kScl;
  kCy+=(my-H/2)*(1-zf)/kScl;
  drawKs();
},{passive:false});
window.addEventListener("mousemove",function(e){
  if(!kDragging||!kDragPrev||!kOpen)return;
  var dx=e.clientX-kDragPrev.x,dy=e.clientY-kDragPrev.y;
  kDragPrev={x:e.clientX,y:e.clientY};
  if(kPanning&&kView!=="3d"){kCx-=dx/kScl;kCy+=dy/kScl;kAutoFit=false;}
  else{kRotY+=dx*0.01;kRotX-=dy*0.01;}
  drawKs();
});
window.addEventListener("mouseup",function(){kDragging=false;kDragPrev=null;});
window.addEventListener("resize",function(){if(kOpen){resizeKc();drawKs();}});

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
  if(!kTraj){ctx.fillStyle="#f00";ctx.font="11px monospace";ctx.fillText("NO kTraj",10,20);return;}
  var kx=kTraj[0],ky=kTraj[1],kz=kTraj[2];
  if(!kx||kx.length<2)return;

  var ax,ay,az;
  if(kView==="xy"){ax=kx;ay=ky;az=kz;}
  else if(kView==="xz"){ax=kx;ay=kz;az=ky;}
  else if(kView==="yz"){ax=ky;ay=kz;az=kx;}
  else{ax=kx;ay=ky;az=kz;}

  var xmin=Infinity,xmax=-Infinity,ymin=Infinity,ymax=-Infinity,zmin=Infinity,zmax=-Infinity;
  for(var i=0;i<ax.length;i++){var xi=ax[i],yi=ay[i];if(isFinite(xi)){if(xi<xmin)xmin=xi;if(xi>xmax)xmax=xi;}if(isFinite(yi)){if(yi<ymin)ymin=yi;if(yi>ymax)ymax=yi;}}
  if(!isFinite(xmin)){ctx.fillStyle="#f00";ctx.font="11px monospace";ctx.fillText("ALL NaN",10,20);return;}
  if(kView==="3d"){for(var i=0;i<az.length;i++){var zi=az[i];if(isFinite(zi)){if(zi<zmin)zmin=zi;if(zi>zmax)zmax=zi;}}}

  if(kAutoFit){
    if(kView==="3d"){var rng3=Math.max(xmax-xmin,ymax-ymin,zmax-zmin,1e-6);kCx=(xmin+xmax)/2;kCy=(ymin+ymax)/2;kScl=Math.min(W,H)/(rng3*1.3);}
    else{var rng2=Math.max(xmax-xmin,ymax-ymin,1e-6);kCx=(xmin+xmax)/2;kCy=(ymin+ymax)/2;kScl=Math.min(W,H)/(rng2*1.3);}
    kAutoFit=false;
  }

  var ox2=W/2-kCx*kScl, oy2=H/2+kCy*kScl;
  function tx(px){return ox2+px*kScl;}function ty(py){return oy2-py*kScl;}

  ctx.strokeStyle=cs.getPropertyValue("--gr").trim();ctx.lineWidth=0.3;ctx.setLineDash([2,4]);
  var x0=tx(0),y0=ty(0);
  if(x0>0&&x0<W){ctx.beginPath();ctx.moveTo(x0,0);ctx.lineTo(x0,H);ctx.stroke();}
  if(y0>0&&y0<H){ctx.beginPath();ctx.moveTo(0,y0);ctx.lineTo(W,y0);ctx.stroke();}
  ctx.setLineDash([]);

  if(kView==="3d"){
    var cz=Math.cos(kRotY),sz=Math.sin(kRotY),cxR=Math.cos(kRotX),sxR=Math.sin(kRotX);
    function proj(px,py,pz){
      var rx=px*cz-pz*sz, rz=px*sz+pz*cz;
      var ry=py*cxR-rz*sxR;
      return {x:tx(rx),y:ty(ry)};
    }
    ctx.lineWidth=1.2;ctx.font="10px monospace";
    function dAxis(fx,fy,fz,label,col){
      var o=proj(0,0,0),t=proj(fx,fy,fz);
      ctx.strokeStyle=col;ctx.beginPath();ctx.moveTo(o.x,o.y);ctx.lineTo(t.x,t.y);ctx.stroke();
      ctx.fillStyle=col;ctx.fillText(label,t.x+3,t.y-3);
    }
    var al=rng3*0.5;
    dAxis(al,0,0,"kx",cs.getPropertyValue("--gx").trim());
    dAxis(0,al,0,"ky",cs.getPropertyValue("--gy").trim());
    dAxis(0,0,al,"kz",cs.getPropertyValue("--gz").trim());
    ctx.lineWidth=1;var drawing=false;
    for(var i=0;i<kx.length;i++){
      if(!isFinite(kx[i])){if(drawing){ctx.stroke();drawing=false;}continue;}
      var pt=proj(kx[i],ky[i],kz[i]);
      if(!drawing){ctx.beginPath();ctx.moveTo(pt.x,pt.y);drawing=true;ctx.strokeStyle="hsl("+((i*47)%360)+",70%,55%)";}
      else{ctx.lineTo(pt.x,pt.y);}
    }
    if(drawing)ctx.stroke();
    if(kAdc&&kAdcTime&&kAdc[0]&&kAdc[0].length){
      var mw2=mc.width/(window.devicePixelRatio||1),vs=ox,ve=ox+(mw2-M.l-M.r)/sc;
      ctx.fillStyle=cs.getPropertyValue("--adc").trim();
      for(var a=0;a<kAdc[0].length;a++){if(kAdcTime[a]<vs||kAdcTime[a]>ve)continue;var pt=proj(kAdc[0][a],kAdc[1][a],kAdc[2][a]);ctx.beginPath();ctx.arc(pt.x,pt.y,2,0,6.283);ctx.fill();}
    }
  }else{
    ctx.lineWidth=1;var drawing=false;
    for(var i=0;i<ax.length;i++){
      if(!isFinite(ax[i])){if(drawing){ctx.stroke();drawing=false;}continue;}
      var px=tx(ax[i]),py=ty(ay[i]);
      if(!drawing){ctx.beginPath();ctx.moveTo(px,py);drawing=true;ctx.strokeStyle="hsl("+((i*47)%360)+",70%,55%)";}
      else{ctx.lineTo(px,py);}
    }
    if(drawing)ctx.stroke();
    if(kAdc&&kAdcTime&&kAdc[0]&&kAdc[0].length){
      var mw2=mc.width/(window.devicePixelRatio||1),vs=ox,ve=ox+(mw2-M.l-M.r)/sc;
      ctx.fillStyle=cs.getPropertyValue("--adc").trim();
      var adcX,adcY;
      if(kView==="xy"){adcX=kAdc[0];adcY=kAdc[1];}
      else if(kView==="xz"){adcX=kAdc[0];adcY=kAdc[2];}
      else{adcX=kAdc[1];adcY=kAdc[2];}
      for(var a=0;a<adcX.length;a++){if(kAdcTime[a]<vs||kAdcTime[a]>ve)continue;ctx.beginPath();ctx.arc(tx(adcX[a]),ty(adcY[a]),2.5,0,6.283);ctx.fill();}
    }
    ctx.fillStyle=cs.getPropertyValue("--fg").trim();ctx.font="10px monospace";
    var xl=kView==="yz"?"ky":"kx",yl=kView==="xz"?"kz":"ky";
    ctx.fillText(xl,W-8,H-4);ctx.fillText(yl,4,12);
  }
}
`;
