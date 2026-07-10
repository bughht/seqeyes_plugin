/* ═══════════════════════════════════════════════════════════════════════
   Mouse interaction
   ═══════════════════════════════════════════════════════════════════════ */

var _touchTooltipTimer=null;

mc.addEventListener('wheel',function(e){e.preventDefault();
  var changed=false;
  if(e.ctrlKey||e.metaKey){
    var ch=cH(),vc=visChannels(),my=e.clientY-mc.getBoundingClientRect().top;
    var vi2=Math.floor((my-M.t)/ch);
    if(vi2>=0&&vi2<vc.length){var ci=vc[vi2],oldZoom=ampZoom[ci];ampZoom[ci]*=e.deltaY<0?1.3:1/1.3;ampZoom[ci]=Math.max(0.1,Math.min(100,ampZoom[ci]));changed=ampZoom[ci]!==oldZoom;}
  }else{
    var r=mc.getBoundingClientRect(),mx2=e.clientX-r.left;
    var zf=e.deltaY<0?1.3:1/1.3;changed=zoomAt(mx2,zf);
  }
  if(changed)scheduleViewerDraw(true);},{passive:false});
mc.addEventListener('mousedown',function(e){if(e.button===0){dr=true;dsx=e.clientX;dso=ox;cc.classList.add('pan')}});
window.addEventListener('mousemove',function(e){
  var r=mc.getBoundingClientRect(),mx2=e.clientX-r.left,my=e.clientY-r.top;cursorT=x2t(mx2);cursorActive=mx2>=M.l&&mx2<=r.width-M.r&&my>=M.t&&my<=r.height-M.b;
  var kInfo=(typeof formatKCursorReadout==='function')?formatKCursorReadout():'';
  curEl.textContent=fmtT(timeConv(cursorT))+' '+timeUnitStr()+(kInfo?' | '+kInfo:'');
  if(dr){ox=dso-(e.clientX-dsx)/sc;clampView();draw();drawMinimap();return}
  draw();
  // Tooltip (desktop hover)
  showTooltipAt(e.clientX,e.clientY,cursorT);
});
window.addEventListener('mouseup',function(){dr=false;cc.classList.remove('pan');drawMinimap();});
cc.addEventListener('mouseleave',function(){cursorT=0;cursorActive=false;curEl.textContent='\u2190 hover for time';draw();drawMinimap();});

/* ── Touch: waveform viewer ───────────────────────────────────────── */
var _tchDragging=false,_tchStartX=0,_tchStartO=0,_tchPinch0=0,_tchPinchMid=null,_tchMoved=false;
mc.addEventListener('touchstart',function(e){
  if(e.touches.length===1){
    _tchDragging=true;_tchMoved=false;
    _tchStartX=e.touches[0].clientX;_tchStartO=ox;
    cc.classList.add('pan');
    // Update cursor position
    var p=getTouchPos(e.touches[0],mc);
    cursorT=x2t(p.x);cursorActive=p.x>=M.l&&p.x<=mc.width/(window.devicePixelRatio||1)-M.r&&p.y>=M.t&&p.y<=mc.height/(window.devicePixelRatio||1)-M.b;
    curEl.textContent=fmtT(timeConv(cursorT))+' '+timeUnitStr();
  }else if(e.touches.length===2){
    _tchDragging=false;_tchPinch0=getTouchDist(e.touches);_tchPinchMid=getTouchMid(e.touches);
  }
  e.preventDefault();
},{passive:false});
mc.addEventListener('touchmove',function(e){
  if(e.touches.length===1&&_tchDragging){
    _tchMoved=true;
    ox=_tchStartO-(e.touches[0].clientX-_tchStartX)/sc;clampView();
    var p=getTouchPos(e.touches[0],mc);
    cursorT=x2t(p.x);cursorActive=p.x>=M.l&&p.x<=mc.width/(window.devicePixelRatio||1)-M.r&&p.y>=M.t&&p.y<=mc.height/(window.devicePixelRatio||1)-M.b;
    curEl.textContent=fmtT(timeConv(cursorT))+' '+timeUnitStr();
    scheduleViewerDraw(true);
  }else if(e.touches.length===2){
    _tchDragging=false;
    var d=getTouchDist(e.touches),zf=d/Math.max(_tchPinch0,1);
    var mid=getTouchMid(e.touches),mx2=mid.x-mc.getBoundingClientRect().left;
    if(zoomAt(mx2,zf)){_tchPinch0=d;scheduleViewerDraw(true);}
  }
  e.preventDefault();
},{passive:false});
mc.addEventListener('touchend',function(e){
  if(!_tchMoved&&cursorActive&&e.changedTouches.length===1){
    // Tap → show tooltip
    showTooltipAt(e.changedTouches[0].clientX,e.changedTouches[0].clientY,cursorT);
  }
  _tchDragging=false;cc.classList.remove('pan');drawMinimap();
  if(e.touches.length===0){_tchPinch0=0;_tchPinchMid=null;}
});
mc.addEventListener('touchcancel',function(){_tchDragging=false;cc.classList.remove('pan');_tchPinch0=0;_tchPinchMid=null;});

/* ── Tooltip helper (also used by touch tap) ──────────────────────── */
function showTooltipAt(cx,cy,ct){
  var ch=cH(),vc=visChannels(),vi2=Math.floor((cy-mc.getBoundingClientRect().top-M.t)/ch);
  if(vi2>=0&&vi2<vc.length){
    var found=null;for(var i=0;i<BL.length;i++){if(ct>=BL[i].s&&ct<=BL[i].s+BL[i].d){found=BL[i];break}}
    if(found){
      var blockDt=Math.max(0,Math.min(found.d,ct-found.s));
      var lines=['Block #'+found.i,'Time: '+fmtT(timeConv(ct))+' '+timeUnitStr()+' (\u0394 '+fmtT(timeConv(blockDt))+' / dur: '+fmtT(timeConv(found.d))+' '+timeUnitStr()+')'];
      if(found.rf){lines.push('RF: '+(found.rf.a||0).toFixed(1)+' Hz  fo='+(found.rf.fo||0).toFixed(0)+' Hz  \u03c6\u2080='+((found.rf.po||0)%6.283).toFixed(2)+' rad');}
      if(found.gx&&found.gx.ty!=='none')lines.push('Gx: '+fmtG(found.gx,ct));
      if(found.gy&&found.gy.ty!=='none')lines.push('Gy: '+fmtG(found.gy,ct));
      if(found.gz&&found.gz.ty!=='none')lines.push('Gz: '+fmtG(found.gz,ct));
      if(found.adc){lines.push('ADC: '+found.adc.n+'pts @'+(found.adc.dw*1e6).toFixed(1)+'\u00b5s  fo='+(found.adc.fo||0).toFixed(0)+' Hz  \u03c6\u2080='+((found.adc.po||0)%6.283).toFixed(2)+' rad');}
      if(found.trg)lines.push('Trig: ch'+found.trg.map(function(x){return x.c}).join(',')+' \u0394'+found.trg.map(function(x){return fmtT(timeConv(x.dr))+' '+timeUnitStr()}).join(','));
      tt.textContent=lines.join('\n');tt.style.display='block';
      tt.style.left=Math.min(cx+15,window.innerWidth-350)+'px';tt.style.top=(cy-10)+'px';
      // Auto-dismiss on touch devices
      if(_touchTooltipTimer)clearTimeout(_touchTooltipTimer);
      if(isTouchDevice())_touchTooltipTimer=setTimeout(function(){tt.style.display='none';},3000);
      return;
    }
  }
  tt.style.display='none';
}

/* ── Toolbar buttons ──────────────────────────────────────────────────── */
document.getElementById('openBtn').onclick=function(){
  if(vscApi){vscApi.postMessage({command:'openFile'});}
  else{var fi=document.getElementById('fileInput');if(fi)fi.click();}
};
document.getElementById('exportKspaceBtn').onclick=function(){
  if(vscApi){vscApi.postMessage({command:'exportKspace'});}
};
function requestM1(channel){
  if(m1Busy)return;
  if(m1Data){chVis[channel]=!chVis[channel];buildLegend();draw();return;}
  m1RequestedChannel=channel;
  m1Busy=true;buildLegend();
  if(vscApi){vscApi.postMessage({command:'calculateM1'});}
}
document.getElementById('pnsBtn').onclick=function(){
  if(pnsBusy)return;
  pnsBusy=true;if(pnsBtn)pnsBtn.disabled=true;
  if(vscApi){vscApi.postMessage({command:'openPnsAsc'});}
};
document.getElementById('zi').onclick=function(){if(zoomAtCenter(1.5))scheduleViewerDraw(true);};
document.getElementById('zo').onclick=function(){if(zoomAtCenter(1/1.5))scheduleViewerDraw(true);};
document.getElementById('zf').onclick=function(){fit();drawMinimap();};
document.getElementById('zr').onclick=function(){fit();drawMinimap();};
document.getElementById('bbc').onchange=function(){showBB=this.checked;draw();};

/* ── Mobile hamburger menu ─────────────────────────────────────────── */
var menuBtn=document.getElementById('menuBtn');
if(menuBtn){
  menuBtn.onclick=function(e){var m=document.getElementById('tbMore');m.classList.toggle('open');e.stopPropagation();};
  document.addEventListener('click',function(e){
    var m=document.getElementById('tbMore');
    if(m.classList.contains('open')&&!m.contains(e.target)&&e.target!==menuBtn)m.classList.remove('open');
  });
  // Close menu when any option inside it is used
  document.getElementById('tbMore').addEventListener('click',function(e){
    if(e.target.tagName==='BUTTON'||e.target.tagName==='SELECT'||e.target.tagName==='INPUT'){
      this.classList.remove('open');
    }
  });
}

/* ── Minimap interaction ──────────────────────────────────────────────── */
mmCanvas.addEventListener('mousedown',function(e){
  mmDrag=true;scrollMinimapToMouse(e);e.preventDefault();
});
window.addEventListener('mousemove',function(e){
  if(!mmDrag)return;
  scrollMinimapToMouse(e);
});
window.addEventListener('mouseup',function(){mmDrag=false;});

/* ── Touch: minimap ──────────────────────────────────────────────── */
var _mmTouchDrag=false,_mmTouchPinch0=0;
mmCanvas.addEventListener('touchstart',function(e){
  if(e.touches.length===1){_mmTouchDrag=true;scrollMinimapToTouch(e.touches[0]);}
  else if(e.touches.length===2){_mmTouchPinch0=getTouchDist(e.touches);}
  e.preventDefault();
},{passive:false});
mmCanvas.addEventListener('touchmove',function(e){
  if(e.touches.length===1&&_mmTouchDrag){scrollMinimapToTouch(e.touches[0]);}
  else if(e.touches.length===2){
    var d=getTouchDist(e.touches),zf=d/Math.max(_mmTouchPinch0,1);
    if(zoomAtCenter(zf)){_mmTouchPinch0=d;scheduleViewerDraw(true);}
  }
  e.preventDefault();
},{passive:false});
mmCanvas.addEventListener('touchend',function(){_mmTouchDrag=false;_mmTouchPinch0=0;});
mmCanvas.addEventListener('touchcancel',function(){_mmTouchDrag=false;_mmTouchPinch0=0;});

function scrollMinimapToTouch(touch){
  var r=mmCanvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  var mx=touch.clientX-r.left,W=mmCanvas.width/dpr;
  var frac=Math.max(0,Math.min(1,mx/W));
  var vsWidth=(mc.width/dpr-M.l-M.r)/sc;
  var viewCenter=frac*TD;
  ox=viewCenter-vsWidth/2;
  clampView();
  draw();drawMinimap();
}

/* ── Old mouse minimap ────────────────────────────────────────────── */
mmCanvas.addEventListener('wheel',function(e){
  e.preventDefault();
  var zf=e.deltaY<0?1.3:1/1.3;
  if(zoomAtCenter(zf))scheduleViewerDraw(true);
},{passive:false});

function scrollMinimapToMouse(e){
  var r=mmCanvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  var mx=e.clientX-r.left;  // CSS pixels — e.clientX and r.left are both CSS
  var W=mmCanvas.width/dpr;  // physical → CSS pixels
  var frac=Math.max(0,Math.min(1,mx/W));
  var vsWidth=(mc.width/dpr-M.l-M.r)/sc;
  // Align viewport CENTER to mouse, not left edge
  var viewCenter=frac*TD;
  ox=viewCenter-vsWidth/2;
  clampView();
  draw();drawMinimap();
}

/* ── Helpers ──────────────────────────────────────────────────────────── */
function fit(){var w=mc.width/(window.devicePixelRatio||1);sc=(w-M.l-M.r)/(TD||1e-3);ox=0;clampView();draw();drawMinimap();}
function nice(r){var ms=[1,2,5,10,20,50,100,200,500,1000,2000,5000,10000,20000,50000];
  for(var i=0;i<ms.length;i++){var b=Math.pow(10,Math.floor(Math.log10(r)));if(ms[i]*b>=r)return ms[i]*b}return 1000*Math.pow(10,Math.floor(Math.log10(r)))}
function fmtT(v){if(v>=1)return v.toFixed(3);if(v>=0.001)return v.toFixed(3);return v.toExponential(2)}
function fmtAmp(v){if(v>=1e6)return(v/1e6).toFixed(1)+'M';if(v>=1e3)return(v/1e3).toFixed(1)+'k';if(v>=1)return v.toFixed(1);return v.toFixed(2)}
function sampleGradAtTime(g,t){
  if(!g||g.ty==='none'||!g.t||!g.w||g.t.length<2||g.w.length<2||!isFinite(t))return 0;
  var n=Math.min(g.t.length,g.w.length);
  if(t<g.t[0]||t>g.t[n-1])return 0;
  var lo=0,hi=n-1;
  while(hi-lo>1){var m=(lo+hi)>>1;if(g.t[m]<=t)lo=m;else hi=m;}
  var dt=g.t[hi]-g.t[lo];
  if(dt<=0)return g.w[lo]||0;
  return g.w[lo]+(g.w[hi]-g.w[lo])*(t-g.t[lo])/dt;
}
function fmtG(g,t){var a=gradConv(sampleGradAtTime(g,t));return a.toFixed(1)+' '+gradUnitStr()+' ('+g.ty+')';}
new MutationObserver(function(){mmCache=null;draw();drawKs();drawMinimap();}).observe(document.body,{attributes:true,attributeFilter:['class']});
rs();
