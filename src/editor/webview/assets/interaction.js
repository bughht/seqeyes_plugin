/* ═══════════════════════════════════════════════════════════════════════
   Mouse interaction
   ═══════════════════════════════════════════════════════════════════════ */

var _touchTooltipTimer=null,_pointerFrame=0,_pendingPointer=null,mmDrag=false;

mc.addEventListener('wheel',function(e){e.preventDefault();
  var changed=false,zf=wheelZoomFactor(e,WHEEL_ZOOM_NOTCH,WHEEL_ZOOM_MAX_STEP);
  if(e.ctrlKey||e.metaKey){
    var ch=cH(),vc=visChannels(),my=e.clientY-mc.getBoundingClientRect().top;
    var vi2=Math.floor((my-M.t)/ch);
    if(vi2>=0&&vi2<vc.length){var ci=vc[vi2],oldZoom=ampZoom[ci];ampZoom[ci]*=zf;ampZoom[ci]=Math.max(0.1,Math.min(100,ampZoom[ci]));changed=ampZoom[ci]!==oldZoom;}
  }else{
    var r=mc.getBoundingClientRect(),mx2=e.clientX-r.left;
    changed=zoomAt(mx2,zf);
  }
  if(changed)scheduleViewerDraw(true);},{passive:false});
mc.addEventListener('mousedown',function(e){if(e.button===0){dr=true;dsx=e.clientX;dso=ox;cc.classList.add('pan')}});
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
/* Coarse PNS buckets span many TRs, so there is no single value to report: the
   plot draws the band and the readout has to say the same thing. Interpolating
   first to last, as the point sampler does, lands near the baseline and
   disagrees with a band reaching several times higher. */
function pushPnsDerivedPart(parts,label,series,t){
  if(series&&series.kind==='envelope'){
    var range=sampleEnvelopeRangeAtTime(series,t);if(!range)return;
    if(range.min===range.max)parts.push(label+'='+fmtDerivedValue(range.min,'%'));
    else parts.push(label+'\u2208['+range.min.toFixed(1)+', '+range.max.toFixed(1)+']%');
    return;
  }
  pushDerivedPart(parts,label,series,t,'%');
}
/* Readout lines go out as [channel, text] so they can follow the row order. */
function appendDerivedTooltipRows(rows,ct){
  // The series the plot is showing, not the full-sequence one behind it.
  var activePns=pnsSeriesShown(ox,ox+visibleDuration());
  if(activePns&&chVis[7]){
    var p=[];pushPnsDerivedPart(p,'X',activePns.x,ct);pushPnsDerivedPart(p,'Y',activePns.y,ct);pushPnsDerivedPart(p,'Z',activePns.z,ct);pushPnsDerivedPart(p,'Norm',activePns.n,ct);
    if(p.length)rows.push([7,'PNS: '+p.join('  ')]);
  }
  var activeM1=m1SeriesForView(ox,ox+visibleDuration());
  if(activeM1&&(chVis[8]||chVis[9]||chVis[10])){
    var m=[];if(chVis[8])pushM1DerivedPart(m,'M1x',activeM1.x,ct);if(chVis[9])pushM1DerivedPart(m,'M1y',activeM1.y,ct);if(chVis[10])pushM1DerivedPart(m,'M1z',activeM1.z,ct);
    if(m.length)rows.push([[8,9,10].filter(function(c){return chVis[c];}),'M1: '+m.join('  ')]);
  }
}
function appendDerivedTooltipLines(lines,ct){
  var rows=[];appendDerivedTooltipRows(rows,ct);
  Array.prototype.push.apply(lines,SeqEyesChannelOrder.sortRows(rows,CH_ORDER));
}
function placeTooltip(cx,cy){
  var pad=8;tt.style.left='0px';tt.style.top='0px';
  var r=tt.getBoundingClientRect(),vw=window.innerWidth,vh=window.innerHeight;
  /* #tt is absolutely positioned inside #cc, which hides its overflow, so the
     usable area is the plot box and not the window: with the analysis panel
     open the window extends well past #cc, and a readout clamped to the window
     edge is cut off where the panel begins. Its style offsets are measured
     from #cc's box too, which is why they are written relative to it. */
  var host=tt.offsetParent?tt.offsetParent.getBoundingClientRect()
    :{left:0,top:0,right:vw,bottom:vh};
  var minX=Math.max(pad,host.left+pad),maxX=Math.min(vw,host.right)-pad-r.width;
  var minY=Math.max(pad,host.top+pad),maxY=Math.min(vh,host.bottom)-pad-r.height;
  var left=Math.min(Math.max(minX,cx+15),Math.max(minX,maxX));
  var top=cy+12;if(top>maxY)top=cy-r.height-12;if(top<minY)top=minY;
  tt.style.left=(left-host.left)+'px';tt.style.top=(top-host.top)+'px';
}
function fmtFlipAngle(value){
  if(!isFinite(value))return null;
  var absolute=Math.abs(value),digits=absolute<10?2:(absolute<100?1:0);
  return value.toFixed(digits)+'\u00b0';
}
function fmtRfFrequency(value){
  var absolute=Math.abs(value),sign=value<0?'\u2212':'+';
  if(absolute>=1000)return sign+(absolute/1000).toFixed(absolute<10000?2:1)+' kHz';
  return sign+absolute.toFixed(absolute<100?1:0)+' Hz';
}
function rfBandMetric(bands,index){
  if(!bands.length)return null;
  var min=Infinity,max=-Infinity,total=0;
  for(var i=0;i<bands.length;i++){var value=bands[i][index];if(!isFinite(value))return null;min=Math.min(min,value);max=Math.max(max,value);total+=value;}
  var mean=total/bands.length;
  if(max-min<=Math.max(.25,Math.abs(mean)*.01))return fmtFlipAngle(mean);
  return fmtFlipAngle(min)+'\u2013'+fmtFlipAngle(max);
}
function rfBandOffsets(bands){
  if(!bands.length)return '';
  if(bands.length===2){
    var left=bands[0][0],right=bands[1][0],scale=Math.max(1,Math.abs(left),Math.abs(right));
    if(Math.abs(left+right)<=.02*scale)return '\u00b1'+fmtRfFrequency(Math.abs(right)).slice(1);
  }
  if(bands.length<=3)return bands.map(function(v){return fmtRfFrequency(v[0]);}).join(',');
  return fmtRfFrequency(bands[0][0])+'\u2026'+fmtRfFrequency(bands[bands.length-1][0]);
}
// One decimal: the band centroid is good to a few hundredths of a millimetre.
function fmtRfPosition(value){
  var mm=value*1e3,text=Math.abs(mm).toFixed(1);
  return text==='0.0'?text:(mm<0?'\u2212':'+')+text;
}
/** Band positions [m] (each band's fifth entry) along `axis`, in mm. */
function rfBandPositions(bands,axis){
  var positions=bands.length<=3
    ?bands.map(function(v){return fmtRfPosition(v[4]);}).join(',')
    :fmtRfPosition(bands[0][4])+'\u2026'+fmtRfPosition(bands[bands.length-1][4]);
  return (axis||'s')+'='+positions+' mm';
}
/**
 * `rd` says how the bands were resolved: absent against a static frequency
 * offset, 'p' along the gradient played with the pulse (positions in `rx`),
 * 'u' under a gradient the analysis cannot represent, so areas only.
 */
function rfResponseSummary(rf){
  var position=rf.rd==='p';
  var bands=(rf.rb||[]).filter(function(v){return v&&v.length>=4&&isFinite(v[0])&&isFinite(v[1])&&isFinite(v[2])&&isFinite(v[3])&&(!position||isFinite(v[4]));});
  var area0=fmtFlipAngle(rf.a0),use=(rf.u||'u').toLowerCase();
  if(!bands.length)return area0?'  area\u2080='+area0:'';
  var polar=rfBandMetric(bands,2),spectral=rfBandMetric(bands,1);
  if(use==='i'||use==='inversion'){
    var center=bands[0];for(var i=1;i<bands.length;i++)if(Math.abs(bands[i][0])<Math.abs(center[0]))center=bands[i];
    var efficiency=Math.max(0,Math.min(1,-center[3]))*100;
    return '  Inv\u2248'+efficiency.toFixed(1)+'%  \u03b8z\u2248'+fmtFlipAngle(center[2])+(area0?'  area\u2080='+area0:'');
  }
  if(rf.rd==='u'){
    var area='  area\u2248'+spectral;
    if(bands.length>1||Math.abs(bands[0][0])>1)area+=' @ \u0394f='+rfBandOffsets(bands);
    return area+' (gradient not modelled)';
  }
  var summary='  '+(bands.length>1?'MB'+bands.length+' ':'')+((use==='e'||use==='excitation')?'FA\u2248':'\u03b8z\u2248')+polar;
  var meanPolar=0,meanArea=0;for(var j=0;j<bands.length;j++){meanPolar+=bands[j][2];meanArea+=bands[j][1];}
  meanPolar/=bands.length;meanArea/=bands.length;
  if(bands.length>1&&Math.abs(meanArea-meanPolar)>.5)summary+=' (area\u2248'+spectral+')';
  // The carrier-frame area only where it says something the band does not:
  // a slice written as phase leaves almost nothing at the carrier.
  if(position)return summary+' @ '+rfBandPositions(bands,rf.rx)+(area0&&Math.abs(rf.a0-meanArea)>.5?'  area\u2080='+area0:'');
  if(bands.length>1)return summary+'  \u0394f='+rfBandOffsets(bands);
  if(Math.abs(bands[0][0])>1)summary+='  \u0394f='+fmtRfFrequency(bands[0][0]);
  return summary;
}
function showTooltipAt(cx,cy,ct){
  var ch=cH(),vc=visChannels(),vi2=Math.floor((cy-mc.getBoundingClientRect().top-M.t)/ch);
  if(vi2>=0&&vi2<vc.length){
    var found=findBlockAtTime(ct);
    var lines=[],rows=[];
    if(found){
      var blockDt=Math.max(0,Math.min(found.d,ct-found.s));
      lines=['Block #'+found.i,'Time: '+fmtT(timeConv(ct))+' '+timeUnitStr()+' (\u0394 '+fmtT(timeConv(blockDt))+' / dur: '+fmtT(timeConv(found.d))+' '+timeUnitStr()+')'];
      if(found.rf){rows.push([0,'RF: '+(found.rf.a||0).toFixed(1)+' Hz'+rfResponseSummary(found.rf)+'  fo='+(found.rf.fo||0).toFixed(0)+' Hz  \u03c6\u2080='+((found.rf.po||0)%6.283).toFixed(2)+' rad']);}
      if(found.gx&&found.gx.ty!=='none')rows.push([2,'Gx: '+fmtG(found.gx,ct)]);
      if(found.gy&&found.gy.ty!=='none')rows.push([3,'Gy: '+fmtG(found.gy,ct)]);
      if(found.gz&&found.gz.ty!=='none')rows.push([4,'Gz: '+fmtG(found.gz,ct)]);
      if(found.adc){rows.push([5,'ADC: '+found.adc.n+'pts @'+(found.adc.dw*1e6).toFixed(1)+'\u00b5s  fo='+(found.adc.fo||0).toFixed(0)+' Hz  \u03c6\u2080='+((found.adc.po||0)%6.283).toFixed(2)+' rad']);}
      if(found.trg)rows.push([6,'Trig: ch'+found.trg.map(function(x){return x.c}).join(',')+' \u0394'+found.trg.map(function(x){return fmtT(timeConv(x.dr))+' '+timeUnitStr()}).join(',')]);
      if(chVis[11]&&labelTable){var labelLine=SeqEyesLabels.tooltipLine(labelTable,found);if(labelLine)rows.push([11,labelLine]);}
    }else{
      lines=['Time: '+fmtT(timeConv(ct))+' '+timeUnitStr()];
    }
    appendDerivedTooltipRows(rows,ct);
    Array.prototype.push.apply(lines,SeqEyesChannelOrder.sortRows(rows,CH_ORDER));
    if(lines.length>1||found){
      renderTooltipLines(tt,lines);tt.style.display='block';
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
/* The label values are evaluated on first use: most views never open the row,
   and a long acquisition has one table row per ADC. */
function requestLabels(){
  if(labelBusy||!labelInfo.names.length)return;
  if(labelTable){chVis[11]=!chVis[11];buildLegend();draw();return;}
  labelBusy=true;buildLegend();
  if(vscApi)vscApi.postMessage({command:'requestLabels',sequenceGeneration:labelGeneration});
}
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
var bbCheck=document.getElementById('bbc');
bbCheck.checked=showBB;   // state.js read the remembered value; match the box to it
bbCheck.onchange=function(){showBB=this.checked;SeqEyesPrefs.setBool(SeqEyesPrefs.KEYS.showBlocks,showBB);draw();};

/* ── Mobile hamburger menu ─────────────────────────────────────────── */
var menuBtn=document.getElementById('menuBtn');
if(menuBtn){
  menuBtn.onclick=function(e){var m=document.getElementById('tbMore'),open=m.classList.toggle('open');menuBtn.setAttribute('aria-expanded',open?'true':'false');e.stopPropagation();};
  document.addEventListener('click',function(e){
    var m=document.getElementById('tbMore');
    if(m.classList.contains('open')&&!m.contains(e.target)&&e.target!==menuBtn){m.classList.remove('open');menuBtn.setAttribute('aria-expanded','false');}
  });
  // Close menu when any option inside it is used
  document.getElementById('tbMore').addEventListener('click',function(e){
    if(e.target.tagName==='BUTTON'||e.target.tagName==='SELECT'||e.target.tagName==='INPUT'){
      this.classList.remove('open');menuBtn.setAttribute('aria-expanded','false');
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
  var zf=wheelZoomFactor(e,WHEEL_ZOOM_NOTCH,WHEEL_ZOOM_MAX_STEP);
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

/* The analysis panel is wired last: it needs the toolbar, both sub-panes and
   the host adapter to exist. web/index.html installs its own adapter over
   this one — install() swaps the host without re-binding the DOM. */
SeqEyesPanel.install(window.SeqEyesPanelHost);
SeqEyesPrefsUi.install();
/* Measurement markers read this renderer's state through these accessors.
   web/index.html installs its own over them, as it does the panel host. */
SeqEyesMarkers.install({
  blocks:function(){return BL;},duration:function(){return TD;},margins:function(){return M;},
  t2x:t2x,x2t:x2t,visChannels:visChannels,cH:cH,cy:cy,channelRange:channelRange,
  timeConv:timeConv,timeUnitStr:timeUnitStr,gradConv:gradConv,gradUnitStr:gradUnitStr,
  requestOverlay:drawCursorOverlay,
  derivedLines:function(t){var lines=[];appendDerivedTooltipLines(lines,t);return lines;}
});
/* Row reordering from the gutter; web/index.html installs its own over it. */
SeqEyesChannelOrder.install({
  names:CH,defaults:CH_DEFAULT_ORDER,margins:function(){return M;},visChannels:visChannels,cH:cH,
  getOrder:function(){return CH_ORDER;},
  setOrder:function(order){CH_ORDER=order;buildLegend();draw();}
});
/* Deferred by one macrotask so web/index.html, whose inline IIFE runs after
   this bundle, has installed its own adapter before the persisted mode is
   restored against it. */
setTimeout(function(){SeqEyesPanel.restoreMode();},0);
