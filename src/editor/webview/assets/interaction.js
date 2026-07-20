/* ═══════════════════════════════════════════════════════════════════════
   Mouse interaction
   ═══════════════════════════════════════════════════════════════════════ */

var _touchTooltipTimer=null,_pointerFrame=0,_pendingPointer=null,mmDrag=false,yLimitEdit=null;

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
mc.addEventListener('mousedown',function(e){
  if(e.button!==0)return;
  if((e.ctrlKey||e.metaKey)&&startYLimitEdit(e)){e.preventDefault();return;}
  dr=true;dsx=e.clientX;dso=ox;cc.classList.add('pan');
});
window.addEventListener('mousemove',function(e){
  // Skip waveform pointer work while user is dragging/rotating k-space.
  if(typeof kDragging!=='undefined'&&kDragging)return;
  _pendingPointer={x:e.clientX,y:e.clientY,dragging:dr};
  if(_pointerFrame)return;
  _pointerFrame=requestAnimationFrame(flushPointerUpdate);
});
window.addEventListener('mouseup',function(){dr=false;cc.classList.remove('pan');drawMinimap();});
cc.addEventListener('mouseleave',function(){
  if(dr)return;
  _pendingPointer=null;if(_pointerFrame){cancelAnimationFrame(_pointerFrame);_pointerFrame=0;}
  clearViewerCursor();
});

function flushPointerUpdate(){
  _pointerFrame=0;var p=_pendingPointer;_pendingPointer=null;if(!p)return;
  var r=mc.getBoundingClientRect();
  var inside=p.x>=r.left&&p.x<=r.right&&p.y>=r.top&&p.y<=r.bottom;
  if(!p.dragging&&!inside){if(cursorActive)clearViewerCursor();return;}
  var mx=p.x-r.left,my=p.y-r.top;cursorT=x2t(mx);
  cursorActive=mx>=M.l&&mx<=r.width-M.r&&my>=M.t&&my<=r.height-M.b;
  var kInfo=(typeof formatKCursorReadout==='function')?formatKCursorReadout():'';
  curEl.textContent=fmtT(timeConv(cursorT))+' '+timeUnitStr()+(kInfo?' | '+kInfo:'');
  if(p.dragging){
    ox=dso-(p.x-dsx)/sc;clampView();tt.style.display='none';
    draw();if(typeof drawKs==='function')drawKs();drawMinimap();return;
  }
  drawCursorOverlay();
  if(typeof drawKsOverlayFast==='function')drawKsOverlayFast();
  showTooltipAt(p.x,p.y,cursorT);
}

function clearViewerCursor(){
  cursorT=0;cursorActive=false;curEl.textContent='\u2190 hover for time';tt.style.display='none';
  drawCursorOverlay();if(typeof drawKsOverlayFast==='function')drawKsOverlayFast();
}

function editableYLimitChannel(ci){return (ci>=2&&ci<=4)||(ci>=8&&ci<=10);}
function yLimitLabelText(ci){
  if(ci>=2&&ci<=4)return '\u00b1'+fmtAmp(gradConv(channelRange(ci)))+gradUnitStr();
  if(ci>=8&&ci<=10)return '\u00b1'+fmtAmp(channelRange(ci))+'s/m';
  return '';
}
function yLimitDisplayValue(ci){
  if(ci>=2&&ci<=4)return gradConv(channelRange(ci));
  if(ci>=8&&ci<=10)return channelRange(ci);
  return NaN;
}
function formatYLimitInputValue(v){
  if(!isFinite(v))return '';
  return String(Number(v.toPrecision(6)));
}
function displayToInternalYLimit(ci,value){
  if(ci>=2&&ci<=4){
    if(gradUnit==='mT/m')return value*GAMMA;
    if(gradUnit==='G/cm')return value*GAMMA*10;
    return value;
  }
  return value;
}
function baseYLimitRange(ci){
  if(ci>=2&&ci<=4)return gMax[ci]||1;
  if(ci>=8&&ci<=10)return gMax[ci]||0.001;
  return 1;
}
function setYLimitFromDisplayValue(ci,value){
  var target=displayToInternalYLimit(ci,value),base=baseYLimitRange(ci);
  if(!isFinite(target)||target<=0||!isFinite(base)||base<=0)return false;
  var oldZoom=ampZoom[ci]||1;
  ampZoom[ci]=Math.max(0.1,Math.min(100,target/base));
  return ampZoom[ci]!==oldZoom;
}
function yLimitLabelHitTest(e){
  var r=mc.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
  var vc=visChannels(),ch=cH(),vi=Math.floor((my-M.t)/ch);
  if(vi<0||vi>=vc.length)return null;
  var ci=vc[vi];if(!editableYLimitChannel(ci))return null;
  var w=mc.width/(window.devicePixelRatio||1),narrow=(typeof layoutMode!=='undefined'&&layoutMode==='vertical')||w<600;
  var font=narrow?'9px monospace':'10px monospace',label=yLimitLabelText(ci),lblX=narrow?4:M.l-12,labelY=M.t+vi*ch+12;
  ctx.save();ctx.font=font;var tw=ctx.measureText(label).width;ctx.restore();
  var x0=narrow?lblX-4:lblX-tw-4,x1=narrow?lblX+tw+4:lblX+4,y0=labelY-12,y1=labelY+4;
  if(mx<x0||mx>x1||my<y0||my>y1)return null;
  return {ci:ci,vi:vi,labelX:lblX,labelY:labelY,width:Math.max(56,Math.ceil(tw+18)),narrow:narrow};
}
function finishYLimitEdit(commit){
  if(!yLimitEdit)return;
  var edit=yLimitEdit,input=edit.input;
  yLimitEdit=null;
  if(input&&input.parentNode)input.parentNode.removeChild(input);
  if(commit){
    var value=Number(input.value.trim());
    if(setYLimitFromDisplayValue(edit.ci,value))scheduleViewerDraw(true);
  }
}
function startYLimitEdit(e){
  var hit=yLimitLabelHitTest(e);if(!hit)return false;
  finishYLimitEdit(false);
  dr=false;cc.classList.remove('pan');tt.style.display='none';
  var input=document.createElement('input'),ccRect=cc.getBoundingClientRect(),mcRect=mc.getBoundingClientRect();
  input.id='ylimEdit';input.type='text';input.inputMode='decimal';input.value=formatYLimitInputValue(yLimitDisplayValue(hit.ci));
  var left=mcRect.left-ccRect.left+(hit.narrow?hit.labelX:hit.labelX-hit.width),top=mcRect.top-ccRect.top+hit.labelY-14;
  input.style.left=Math.max(2,Math.round(left))+'px';input.style.top=Math.max(2,Math.round(top))+'px';input.style.width=hit.width+'px';
  input.addEventListener('keydown',function(ev){
    if(ev.key==='Enter'){ev.preventDefault();finishYLimitEdit(true);}
    else if(ev.key==='Escape'){ev.preventDefault();finishYLimitEdit(false);}
  });
  input.addEventListener('blur',function(){finishYLimitEdit(true);});
  input.addEventListener('mousedown',function(ev){ev.stopPropagation();});
  cc.appendChild(input);yLimitEdit={input:input,ci:hit.ci};
  input.focus();input.select();
  return true;
}

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
function sampleDerivedSeriesAtTime(series,t){
  if(series&&series.kind==='envelope'){
    var base=series.levels&&series.levels[0];if(!base||base.count<1||!isFinite(t))return null;
    var index=Math.max(0,lowerBoundSeries(base.t1,t));if(index>=base.count||t<base.t0[index]||t>base.t1[index])return null;
    var span=base.t1[index]-base.t0[index],alpha=span>0?(t-base.t0[index])/span:0;
    return(base.first[index]+(base.last[index]-base.first[index])*alpha)*series.scale;
  }
  if(!series||!series.t||!series.v||series.n<1||!isFinite(t))return null;
  var n=Math.min(series.n,series.t.length,series.v.length);
  if(n<1||t<series.t[0]||t>series.t[n-1])return null;
  if(n===1||t<=series.t[0])return series.v[0]*series.scale;
  if(t>=series.t[n-1])return series.v[n-1]*series.scale;
  var lo=0,hi=n-1;
  while(hi-lo>1){var m=(lo+hi)>>1;if(series.t[m]<=t)lo=m;else hi=m;}
  var dt=series.t[hi]-series.t[lo];
  if(dt<=0)return series.v[lo]*series.scale;
  return (series.v[lo]+(series.v[hi]-series.v[lo])*(t-series.t[lo])/dt)*series.scale;
}
function fmtSignedAmp(v){
  var av=Math.abs(v),s;if(av>=1e6)s=(av/1e6).toFixed(1)+'M';else if(av>=1e3)s=(av/1e3).toFixed(1)+'k';else if(av>=1)s=av.toFixed(1);else s=av.toFixed(2);
  return(v<0?'-':'')+s;
}
function fmtDerivedValue(v,unit){return unit==='%'?v.toFixed(1)+'%':fmtSignedAmp(v)+' '+unit;}
function pushDerivedPart(parts,label,series,t,unit){
  var v=sampleDerivedSeriesAtTime(series,t);if(v===null)return;
  parts.push(label+'='+fmtDerivedValue(v,unit));
}
function pushM1DerivedPart(parts,label,series,t){
  if(series&&series.kind==='envelope'){
    var range=sampleEnvelopeRangeAtTime(series,t);if(!range)return;
    if(range.min===range.max)parts.push(label+'='+fmtDerivedValue(range.min,'s/m'));
    else parts.push(label+'\u2208['+fmtSignedAmp(range.min)+', '+fmtSignedAmp(range.max)+'] s/m');
    return;
  }
  pushDerivedPart(parts,label,series,t,'s/m');
}
function appendDerivedTooltipLines(lines,ct){
  if(pnsData&&chVis[7]){
    var p=[];pushDerivedPart(p,'X',pnsData.x,ct,'%');pushDerivedPart(p,'Y',pnsData.y,ct,'%');pushDerivedPart(p,'Z',pnsData.z,ct,'%');pushDerivedPart(p,'Norm',pnsData.n,ct,'%');
    if(p.length)lines.push('PNS: '+p.join('  '));
  }
  var activeM1=m1SeriesForView(ox,ox+visibleDuration());
  if(activeM1&&(chVis[8]||chVis[9]||chVis[10])){
    var m=[];if(chVis[8])pushM1DerivedPart(m,'M1x',activeM1.x,ct);if(chVis[9])pushM1DerivedPart(m,'M1y',activeM1.y,ct);if(chVis[10])pushM1DerivedPart(m,'M1z',activeM1.z,ct);
    if(m.length)lines.push('M1: '+m.join('  '));
  }
}
function placeTooltip(cx,cy){
  var pad=8;tt.style.left='0px';tt.style.top='0px';
  var r=tt.getBoundingClientRect(),vw=window.innerWidth,vh=window.innerHeight;
  var left=Math.min(Math.max(pad,cx+15),Math.max(pad,vw-r.width-pad));
  var top=cy+12;if(top+r.height+pad>vh)top=cy-r.height-12;if(top<pad)top=pad;
  tt.style.left=left+'px';tt.style.top=top+'px';
}
function showTooltipAt(cx,cy,ct){
  var ch=cH(),vc=visChannels(),vi2=Math.floor((cy-mc.getBoundingClientRect().top-M.t)/ch);
  if(vi2>=0&&vi2<vc.length){
    var found=findBlockAtTime(ct);
    var lines=[];
    if(found){
      var blockDt=Math.max(0,Math.min(found.d,ct-found.s));
      lines=['Block #'+found.i,'Time: '+fmtT(timeConv(ct))+' '+timeUnitStr()+' (\u0394 '+fmtT(timeConv(blockDt))+' / dur: '+fmtT(timeConv(found.d))+' '+timeUnitStr()+')'];
      if(found.rf){lines.push('RF: '+(found.rf.a||0).toFixed(1)+' Hz  fo='+(found.rf.fo||0).toFixed(0)+' Hz  \u03c6\u2080='+((found.rf.po||0)%6.283).toFixed(2)+' rad');}
      if(found.gx&&found.gx.ty!=='none')lines.push('Gx: '+fmtG(found.gx,ct));
      if(found.gy&&found.gy.ty!=='none')lines.push('Gy: '+fmtG(found.gy,ct));
      if(found.gz&&found.gz.ty!=='none')lines.push('Gz: '+fmtG(found.gz,ct));
      if(found.adc){lines.push('ADC: '+found.adc.n+'pts @'+(found.adc.dw*1e6).toFixed(1)+'\u00b5s  fo='+(found.adc.fo||0).toFixed(0)+' Hz  \u03c6\u2080='+((found.adc.po||0)%6.283).toFixed(2)+' rad');}
      if(found.trg)lines.push('Trig: ch'+found.trg.map(function(x){return x.c}).join(',')+' \u0394'+found.trg.map(function(x){return fmtT(timeConv(x.dr))+' '+timeUnitStr()}).join(','));
    }else{
      lines=['Time: '+fmtT(timeConv(ct))+' '+timeUnitStr()];
    }
    appendDerivedTooltipLines(lines,ct);
    if(lines.length>1||found){
      tt.textContent=lines.join('\n');tt.style.display='block';
      placeTooltip(cx,cy);
      // Auto-dismiss on touch devices
      if(_touchTooltipTimer)clearTimeout(_touchTooltipTimer);
      if(isTouchDevice())_touchTooltipTimer=setTimeout(function(){tt.style.display='none';},3000);
      return;
    }
  }
  tt.style.display='none';
}

function findBlockAtTime(t){
  var lo=0,hi=BL.length;
  while(lo<hi){var mid=(lo+hi)>>1;if(BL[mid].s+BL[mid].d<t)lo=mid+1;else hi=mid;}
  for(var i=lo;i<Math.min(BL.length,lo+2);i++){
    if(t>=BL[i].s&&t<=BL[i].s+BL[i].d)return BL[i];
  }
  return null;
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
  if(vscApi){vscApi.postMessage({command:'calculateM1',referenceMode:m1ReferenceMode});}
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
  draw();if(typeof drawKs==='function')drawKs();drawMinimap();
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
  var vsWidth=visibleDuration();
  // Align viewport CENTER to mouse, not left edge
  var viewCenter=frac*TD;
  ox=viewCenter-vsWidth/2;
  clampView();
  draw();if(typeof drawKs==='function')drawKs();drawMinimap();
}

/* ── Helpers ──────────────────────────────────────────────────────────── */
function fit(){var w=mc.width/(window.devicePixelRatio||1);sc=(w-M.l-M.r)/(TD||1e-3);ox=0;clampView();draw();if(typeof drawKs==='function')drawKs();drawMinimap();}
function nice(r){var ms=[1,2,5,10,20,50,100,200,500,1000,2000,5000,10000,20000,50000];
  for(var i=0;i<ms.length;i++){var b=Math.pow(10,Math.floor(Math.log10(r)));if(ms[i]*b>=r)return ms[i]*b}return 1000*Math.pow(10,Math.floor(Math.log10(r)))}
function fmtT(v){if(v===0)return'0';if(v>=0.001)return v.toFixed(3);return v.toExponential(2)}
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
