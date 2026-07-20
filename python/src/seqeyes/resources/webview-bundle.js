/* SeqEyes WebView Bundle — auto-generated, do not edit */
"use strict";
/* ══ state.js ══ */
/* ═══════════════════════════════════════════════════════════════════════
   Application state & configuration
   ═══════════════════════════════════════════════════════════════════════ */
var cc=document.getElementById('cc'),mc=document.getElementById('mc'),ctx=mc.getContext('2d'),
 moc=document.getElementById('moc'),moctx=moc.getContext('2d'),
 tt=document.getElementById('tt'),curEl=document.getElementById('cur'),legend=document.getElementById('legend'),
 tuSel=document.getElementById('tu'),guSel=document.getElementById('gu');
var exportBtn=document.getElementById('exportKspaceBtn');
var pnsBtn=document.getElementById('pnsBtn');
var BL=[],waveformOverview=null,TD=0,GR=1e-5,RR=1e-6,AR=1e-7,BR=1e-5; // blocks, duration, rasters [s]
var M={t:8,r:30,b:22,l:92};                // margins
var CH=['RF','\u03c6','Gx','Gy','Gz','ADC','Trig','PNS','M1x','M1y','M1z'];
var chColors=['var(--rf)','var(--rf)','var(--gx)','var(--gy)','var(--gz)','var(--adc)','var(--tr)','var(--fg)','var(--gx)','var(--gy)','var(--gz)'];
var chVis=[true,true,true,true,true,true,true,false,false,false,false];                   // visibility toggles
var gMax=[1,6.28318,1,1,1,0,0,1,0.001,0.001,0.001];          // global max per channel
var ox=0,sc=1;                             // view offset [s] & scale [px/s]
var dr=false,dsx=0,dso=0;                  // drag state
var cursorT=0,cursorActive=false;            // mouse time position
var timeUnit='ms',gradUnit='Hz/m';          // display unit selections
var showBB=false;                            // show block boundaries (default off)
var GAMMA=42576;                            // Hz/m per mT/m for 1H

var ampZoom=[1,1,1,1,1,1,1];
ampZoom[7]=1;ampZoom[8]=1;ampZoom[9]=1;ampZoom[10]=1;
/* K‑space data — pre‑computed on the extension side */
var kTraj=null,kAdc=null,kTime=null,kAdcTime=null;
var m1Data=null,m1WindowData=null,m1WindowPending=null,m1WindowRequestId=0,pnsData=null,pnsWindowData=null,pnsWindowPending=null,pnsWindowRequestId=0,pnsBusy=false,m1Busy=false,m1RequestedChannel=8,m1ReferenceMode=readM1ReferenceMode(),m1RestoreChannels=null;
var viewerNotices={};
var kspaceSafetyWarning=null,kspaceSafetyBusy=false,kspaceSafetyPopupTimer=0;
var derivedRenderPointCount=0,derivedEnvelopeCurveCount=0,derivedRawCurveCount=0,waveformOverviewActive=false,rfRenderPointCount=0,rfRawCurveCount=0,rfReducedCurveCount=0,rfOverviewBucketCount=0,lastDrawDurationMs=0,viewerDrawCount=0,viewerCursorDrawCount=0;
var viewerDrawFrame=0,viewerDrawMinimap=false;
function isMobileSafetyLayout(){return !!(window.matchMedia&&window.matchMedia('(max-width: 768px), (pointer: coarse)').matches);}
function renderViewerNotices(){
  var el=document.getElementById('viewerNotice');if(!el)return;el.textContent='';
  var keys=Object.keys(viewerNotices),visible=0;
  for(var i=0;i<keys.length;i++){
    if(keys[i]==='kspace'&&kspaceSafetyWarning&&isMobileSafetyLayout())continue;
    if(visible)el.appendChild(document.createTextNode(' '));
    var span=document.createElement('span');span.textContent=viewerNotices[keys[i]];el.appendChild(span);visible++;
  }
  if(kspaceSafetyWarning&&!isMobileSafetyLayout()){
    var action=document.createElement('button');action.type='button';action.className='notice-action';action.textContent=kspaceSafetyBusy?'Calculating…':'Calculate anyway…';action.disabled=kspaceSafetyBusy;
    action.onclick=showKspaceSafetyDialog;el.appendChild(action);visible++;
  }
  el.style.display=visible?'block':'none';
}
function setViewerNotice(key,message){
  if(message&&viewerNotices[key]===message)return;
  if(!message&&!Object.prototype.hasOwnProperty.call(viewerNotices,key))return;
  if(message)viewerNotices[key]=message;else delete viewerNotices[key];
  renderViewerNotices();
}
function setKspaceSafetyWarning(message){
  clearTimeout(kspaceSafetyPopupTimer);kspaceSafetyWarning=message||null;kspaceSafetyBusy=false;
  setViewerNotice('kspace',message?(message+' Calculating anyway may freeze or crash SeqEyes or its host, exhaust system memory, and cause unsaved work to be lost.'):null);
  if(kspaceSafetyWarning&&isMobileSafetyLayout())kspaceSafetyPopupTimer=setTimeout(showKspaceSafetyDialog,650);
  if(!kspaceSafetyWarning)hideKspaceSafetyDialog();
}
function showKspaceSafetyDialog(){
  if(!kspaceSafetyWarning)return false;
  var overlay=document.getElementById('kspaceSafetyOverlay'),text=document.getElementById('kspaceSafetyText'),proceed=document.getElementById('kspaceSafetyProceed');
  if(!overlay||!text||!proceed)return false;
  text.textContent=kspaceSafetyWarning+'\n\nCalculating anyway may freeze or crash SeqEyes or its host, exhaust system memory, and cause unsaved work to be lost. Continue only if you accept this risk.';
  proceed.disabled=kspaceSafetyBusy;proceed.textContent=kspaceSafetyBusy?'Calculating…':'Calculate anyway (dangerous)';
  overlay.style.display='flex';overlay.setAttribute('aria-hidden','false');
  var acknowledge=document.getElementById('kspaceSafetyAcknowledge');if(acknowledge)acknowledge.focus();return true;
}
function hideKspaceSafetyDialog(){
  var overlay=document.getElementById('kspaceSafetyOverlay');if(!overlay)return;overlay.style.display='none';overlay.setAttribute('aria-hidden','true');
}
function requestDangerousKspaceCalculation(){
  if(!kspaceSafetyWarning||kspaceSafetyBusy)return;kspaceSafetyBusy=true;hideKspaceSafetyDialog();renderViewerNotices();
  if(vscApi)vscApi.postMessage({command:'calculateKspaceUnsafe'});
}
function finishDangerousKspaceCalculation(error){
  kspaceSafetyBusy=false;
  if(!error){setViewerNotice('kspaceOverrideFailure',null);setKspaceSafetyWarning(null);return;}
  setViewerNotice('kspaceOverrideFailure','The requested K-space calculation failed: '+error);
  renderViewerNotices();
}
document.getElementById('kspaceSafetyAcknowledge').onclick=hideKspaceSafetyDialog;
document.getElementById('kspaceSafetyProceed').onclick=requestDangerousKspaceCalculation;
window.addEventListener('resize',renderViewerNotices);

function scheduleViewerDraw(includeMinimap){
  viewerDrawMinimap=viewerDrawMinimap||includeMinimap;
  if(viewerDrawFrame)return;
  viewerDrawFrame=requestAnimationFrame(function(){
    viewerDrawFrame=0;draw();
    if(typeof drawKs==='function')drawKs();
    if(viewerDrawMinimap)drawMinimap();
    viewerDrawMinimap=false;
  });
}

/* Timing metadata (TR/TE info for minimap tooltip) */
var seqTiming=null;  // {trTimeSec,trCount,hasExplicitTR,teTimeSec,hasExplicitTE,rfUseGuessed}

/* Block positions for minimap: [{i,s,d}, ...] */
var blockPos=[];

/* VS Code API — acquired once, used for postMessage to extension host */
var vscApi=(typeof acquireVsCodeApi!=='undefined')?acquireVsCodeApi():null;

function normalizeM1ReferenceMode(mode){return mode==='observationTime'?'observationTime':'rfCenter';}
function readM1ReferenceMode(){
  try{localStorage.removeItem('seqeyes.m1ReferenceMode');}catch(_){}
  return 'rfCenter';
}
function setM1ReferenceMode(mode){
  var next=normalizeM1ReferenceMode(mode);
  if(next===m1ReferenceMode)return m1ReferenceMode;
  var restore=[!!chVis[8],!!chVis[9],!!chVis[10]];
  var shouldRecalc=!!m1Data&&(chVis[8]||chVis[9]||chVis[10]);
  m1ReferenceMode=next;
  m1Data=null;m1WindowData=null;m1WindowPending=null;chVis[8]=false;chVis[9]=false;chVis[10]=false;
  computeGlobalMax();buildLegend();draw();
  if(shouldRecalc){
    m1RestoreChannels=restore;
    requestM1(restore[0]?8:(restore[1]?9:(restore[2]?10:(m1RequestedChannel||8))));
  }
  return m1ReferenceMode;
}
window.SeqEyesDev=window.SeqEyesDev||{};
window.SeqEyesDev.getM1ReferenceMode=function(){return m1ReferenceMode;};
window.SeqEyesDev.setM1ReferenceMode=setM1ReferenceMode;

/* ── Shared touch utilities (used by kspace.js & interaction.js) ──────── */
function isTouchDevice(){return('ontouchstart' in window)||(navigator.maxTouchPoints>0);}
function getTouchPos(touch,el){var r=el.getBoundingClientRect();return {x:touch.clientX-r.left, y:touch.clientY-r.top};}
function getTouchMid(touches){return {x:(touches[0].clientX+touches[1].clientX)/2, y:(touches[0].clientY+touches[1].clientY)/2};}
function getTouchDist(touches){var dx=touches[0].clientX-touches[1].clientX, dy=touches[0].clientY-touches[1].clientY;return Math.sqrt(dx*dx+dy*dy);}

/* ── Responsive layout ────────────────────────────────────────────────── */
var layoutMode='horizontal';  // 'horizontal' (kspace right) or 'vertical' (kspace bottom)
function detectLayoutMode(){
  var was=layoutMode;
  layoutMode=(window.innerHeight>window.innerWidth)?'vertical':'horizontal';
  return layoutMode!==was;
}
function applyLayoutMode(){
  document.body.classList.remove('layout-vertical','layout-horizontal');
  document.body.classList.add('layout-'+layoutMode);
  
  var main=document.getElementById('main');
  var left=document.getElementById('left');
  var right=document.getElementById('right');
  var handle=document.getElementById('khandle');
  var rc=document.getElementById('rc');
  
  if(layoutMode==='vertical'){
    // Direct inline !important styles — beats everything in CSS cascade
    main.style.setProperty('flex-direction','column','important');
    left.style.setProperty('flex','1 1 0%','important');
    left.style.setProperty('min-height','0','important');
    left.style.setProperty('min-width','0','important');
    right.style.setProperty('width','100%','important');
    right.style.setProperty('height','0','important');
    right.style.setProperty('border-left','none','important');
    right.style.setProperty('border-top','1px solid var(--gr)','important');
    right.style.setProperty('transition','height .25s','important');
    right.style.setProperty('flex-shrink','0','important');
    right.style.setProperty('overflow','hidden','important');
    right.style.setProperty('position','relative','important');
    handle.style.setProperty('cursor','row-resize','important');
    handle.style.setProperty('left','0','important');
    handle.style.setProperty('right','0','important');
    handle.style.setProperty('top','0','important');
    handle.style.setProperty('width','100%','important');
    handle.style.setProperty('height','5px','important');
    handle.style.setProperty('bottom','auto','important');
    if(rc){rc.style.setProperty('flex-direction','row','important');}
    // If kspace is open, apply open height inline
    if(typeof kOpen!=='undefined'&&kOpen){
      right.style.setProperty('height','300px','important');
    }
  }else{
    // Remove all inline !important overrides — base CSS takes over
    main.style.cssText='';
    left.style.cssText='';
    right.style.cssText='';
    handle.style.cssText='';
    if(rc)rc.style.cssText='';
    // If kspace is open, restore width
    if(typeof kOpen!=='undefined'&&kOpen){
      right.style.width='500px';
    }
  }
}
function refreshLayout(){
  if(detectLayoutMode()){
    applyLayoutMode();
    rs();
    if(typeof drawKs==='function')drawKs();
    if(typeof drawMinimap==='function')drawMinimap();
  }
}
applyLayoutMode();
// Use ResizeObserver on #main for reliable layout detection
var _mainEl=document.getElementById('main');
if(_mainEl&&typeof ResizeObserver!=='undefined'){
  new ResizeObserver(function(){refreshLayout();}).observe(_mainEl);
}
// Fallback listeners
window.addEventListener('resize',function(){refreshLayout();});
if(typeof window.matchMedia==='function'){
  window.matchMedia('(orientation: portrait)').addEventListener('change',function(){refreshLayout();});
}

/* ── Unit conversion helpers ──────────────────────────────────────────── */
function gradConv(v){if(gradUnit==='mT/m')return v/GAMMA;if(gradUnit==='G/cm')return v/(GAMMA*10);return v;}
function gradUnitStr(){return gradUnit;}
function timeConv(t){if(timeUnit==='ms')return t*1e3;if(timeUnit==='us')return t*1e6;return t;}
function timeUnitStr(){return timeUnit;}

/* ── Build legend ─────────────────────────────────────────────────────── */
function buildLegend(){
  legend.innerHTML='';
  chColors.forEach(function(c,i){
    var d=document.createElement('div');d.className='li'+(chVis[i]?'':' off');d.title='Toggle '+CH[i];
    d.innerHTML='<div class="ld" style="background:'+c+'"></div>'+CH[i];
    if(i>=8&&i<=10&&!m1Data)d.title='Calculate and show '+CH[i];
    else if(i===7&&!pnsData)d.title='Select a PNS ASC file before showing PNS';
    d.onclick=function(){
      if(i>=8&&i<=10&&!m1Data){requestM1(i);return;}
      if(i===7&&!pnsData)return;
      chVis[i]=!chVis[i];
      buildLegend();computeGlobalMax();draw();
    };
    legend.appendChild(d);
  });
}
buildLegend();
tuSel.onchange=function(){timeUnit=tuSel.value;draw();};
guSel.onchange=function(){gradUnit=guSel.value;draw();};
function setExportButtonEnabled(enabled){if(exportBtn)exportBtn.disabled=!enabled;}
function applySerializedKspace(payload){
  kTraj=null;kAdc=null;kTime=null;kAdcTime=null;
  if(!payload)return;
  kTraj=[payload.kx,payload.ky,payload.kz];kTime=payload.tk;
  var n=payload.nAdc||0;
  if(n>0&&payload.axb){
    kAdc=[decodeB64F32(payload.axb,n),decodeB64F32(payload.ayb,n),decodeB64F32(payload.azb,n)];
    kAdcTime=decodeB64F32(payload.tab,n);uploadKSpaceGPU();
  }
}

/* ── Data reception ───────────────────────────────────────────────────── */
window.addEventListener('message',function(e){
  var m=e.data;
  if(m.type==='progress'){
    var overlay=document.getElementById('poverlay'),fill=document.getElementById('pfill2'),
        text=document.getElementById('ptext'),pct=document.getElementById('ppct');
    if(m.phase==='start'){
      setExportButtonEnabled(false);
      overlay.style.display='flex';fill.style.width='0%';
      text.textContent=m.text||'Loading sequence\u2026';pct.textContent='0%';
    }else if(m.phase==='done'){
      fill.style.width='100%';pct.textContent='100%';
      text.textContent=m.text||'Ready';
      setTimeout(function(){overlay.style.display='none';},500);
    }else{
      fill.style.width=(m.percent||0)+'%';
      pct.textContent=(m.percent||0)+'%';
      text.textContent=m.text||'';
    }
    return;
  }
  if(m.type==='sequenceData'){
    BL=m.blocks||[];TD=m.totalDuration||0;GR=m.gradRaster||1e-5;
    setViewerNotice('sequence',m.notices&&m.notices.length?m.notices.join(' '):null);
    setViewerNotice('kspaceOverrideFailure',null);setKspaceSafetyWarning(m.kspaceSafety||null);
    setViewerNotice('m1',null);setViewerNotice('pns',null);setViewerNotice('pnsThreshold',null);
    waveformOverview=createWaveformOverview(BL);
    RR=m.rfRaster||RR;AR=m.adcRaster||AR;BR=m.blockRaster||BR;
    blockPos=m.blockPositions||[];
    mmCache=null;  // invalidate minimap cache on new data
    applySerializedKspace(m.kspace);
    m1Data=null;m1WindowData=null;m1WindowPending=null;pnsData=null;pnsWindowData=null;pnsWindowPending=null;chVis[7]=false;chVis[8]=false;chVis[9]=false;chVis[10]=false;
    // Store timing metadata for minimap tooltip
    if(m.timing) seqTiming=m.timing; else seqTiming=null;
    computeGlobalMax();
    buildLegend();
    // Auto-zoom: if TR is known, zoom to first TR; otherwise fit full sequence
    if(seqTiming&&seqTiming.trTimeSec>0){fitToFirstTR();}else{fit();}
    draw();drawKs();drawMinimap();
    setExportButtonEnabled(true);
  }else if(m.type==='kspaceData'){
    applySerializedKspace(m.kspace);finishDangerousKspaceCalculation(null);drawKs();
    if(typeof kOpen!=='undefined'&&!kOpen)document.getElementById('kbtn').click();
  }else if(m.type==='kspaceError'){
    finishDangerousKspaceCalculation(m.message||'Unknown error.');
  }else if(m.type==='m1Data'){
    m1Busy=false;
    if(m.m1&&m.m1.valid){
      setViewerNotice('m1',null);
      m1Data=createM1SeriesPayload(m.m1);
      m1WindowData=null;m1WindowPending=null;
      if(m1RestoreChannels){
        chVis[8]=!!m1RestoreChannels[0];chVis[9]=!!m1RestoreChannels[1];chVis[10]=!!m1RestoreChannels[2];m1RestoreChannels=null;
      }else chVis[m1RequestedChannel]=true;
      computeGlobalMax();buildLegend();draw();
      if(m.m1.warnings&&m.m1.warnings.length)console.warn('[SeqEyes M1]',m.m1.warnings.join('\n'));
      setViewerNotice('m1Coarse',m.m1.coarse?'Large sequence: showing bounded full-sequence M1. Zoom to 100 TRs or fewer for automatic detail.':null);
    }else{
      setViewerNotice('m1','M1 calculation failed: '+((m.m1&&m.m1.error)||'unknown error')+' Zoom in to inspect waveform detail.');
    }
  }else if(m.type==='m1WindowData'){
    if(m1WindowPending&&m.requestId!==m1WindowPending.requestId)return;
    m1WindowPending=null;
    if(m.m1&&m.m1.valid){m1WindowData=createM1SeriesPayload(m.m1);draw();}
    else if(m.m1&&m.m1.error)setViewerNotice('m1Detail','M1 detail was not calculated: '+m.m1.error);
  }else if(m.type==='m1Error'){
    m1Busy=false;
    setViewerNotice('m1',(m.message||'M1 calculation failed.')+(m.message&&/zoom in/i.test(m.message)?'':' Zoom in to inspect waveform detail.'));
  }else if(m.type==='pnsData'){
    pnsBusy=false;if(pnsBtn)pnsBtn.disabled=false;
    if(m.pns&&m.pns.valid){
      setViewerNotice('pns',null);
      pnsData=createPnsSeriesPayload(m.pns);
      pnsWindowData=null;pnsWindowPending=null;chVis[7]=true;
      computeGlobalMax();buildLegend();draw();
      setViewerNotice('pnsThreshold',m.pns.ok?null:'PNS warning: predicted level reaches or exceeds 100%.');
      setViewerNotice('pnsCoarse',m.pns.coarse?'Large sequence: showing bounded full-sequence PNS. Zoom to 100 TRs or fewer for automatic detail.':null);
    }else{
      setViewerNotice('pns','PNS calculation failed: '+((m.pns&&m.pns.error)||'unknown error')+' Zoom in to inspect waveform detail.');
    }
  }else if(m.type==='pnsWindowData'){
    if(pnsWindowPending&&m.requestId!==pnsWindowPending.requestId)return;
    pnsWindowPending=null;
    if(m.pns&&m.pns.valid){
      pnsWindowData=createPnsSeriesPayload(m.pns);
      draw();
    }
  }else if(m.type==='pnsError'){
    pnsBusy=false;if(pnsBtn)pnsBtn.disabled=false;
    setViewerNotice('pns',(m.message||'PNS calculation failed.')+(m.message&&/zoom in/i.test(m.message)?'':' Zoom in to inspect waveform detail.'));
  }else if(m.type==='pnsSelectionCancelled'){
    pnsBusy=false;if(pnsBtn)pnsBtn.disabled=false;
  }
});

/* ── Base64 → Float32Array decoder ─────────────────────────────────── */
function decodeB64F32(b64,n){var bin=atob(b64),len=bin.length,b=new Uint8Array(len);for(var i=0;i<len;i++)b[i]=bin.charCodeAt(i);return new Float32Array(b.buffer,0,n);}


/* ── Global amplitude ranges ──────────────────────────────────────────── */
function computeGlobalMax(){
  gMax=[0.001,6.28318,0.001,0.001,0.001,1,1,0.001,0.001,0.001,0.001];
  for(var i=0;i<BL.length;i++){var b=BL[i];
    if(b.rf){var a=Math.abs(b.rf.a||0);if(a>gMax[0])gMax[0]=a;}
    if(b.gx&&b.gx.ty!=='none'&&Math.abs(b.gx.a||0)>gMax[2])gMax[2]=Math.abs(b.gx.a);
    if(b.gy&&b.gy.ty!=='none'&&Math.abs(b.gy.a||0)>gMax[3])gMax[3]=Math.abs(b.gy.a);
    if(b.gz&&b.gz.ty!=='none'&&Math.abs(b.gz.a||0)>gMax[4])gMax[4]=Math.abs(b.gz.a);
  }
  if(pnsData)gMax[7]=Math.max(gMax[7],pnsData.x.maxAbs,pnsData.y.maxAbs,pnsData.z.maxAbs,pnsData.n.maxAbs);
  if(m1Data){gMax[8]=Math.max(gMax[8],m1Data.x.maxAbs);gMax[9]=Math.max(gMax[9],m1Data.y.maxAbs);gMax[10]=Math.max(gMax[10],m1Data.z.maxAbs);}
  gMax[0]=Math.max(gMax[0],100);
}

function createPnsSeriesPayload(pns){
  function series(prefix,timeKey,valueKey){
    return pns.coarse
      ?createEnvelopeSeries(pns[prefix+'0'],pns[prefix+'1'],pns[prefix+'min'],pns[prefix+'max'],pns[prefix+'first'],pns[prefix+'last'],1)
      :createDerivedSeries(pns[timeKey]||pns.t,pns[valueKey],1);
  }
  return{
    coarse:!!pns.coarse,
    startSec:isFinite(pns.startSec)?pns.startSec:null,
    endSec:isFinite(pns.endSec)?pns.endSec:null,
    x:series('x','tx','x'),
    y:series('y','ty','y'),
    z:series('z','tz','z'),
    n:series('n','tn','n')
  };
}

function createM1SeriesPayload(m1){
  function series(prefix,timeKey,valueKey){
    return m1.coarse
      ?createEnvelopeSeries(m1[prefix+'0'],m1[prefix+'1'],m1[prefix+'min'],m1[prefix+'max'],m1[prefix+'first'],m1[prefix+'last'],1)
      :createDerivedSeries(m1[timeKey]||m1.t,m1[valueKey],1);
  }
  return{
    coarse:!!m1.coarse,
    startSec:isFinite(m1.startSec)?m1.startSec:null,
    endSec:isFinite(m1.endSec)?m1.endSec:null,
    referenceMode:m1.referenceMode||m1ReferenceMode,
    warnings:m1.warnings||[],
    x:series('x','tx','x'),
    y:series('y','ty','y'),
    z:series('z','tz','z')
  };
}

function shouldRequestFineM1Window(vs,ve){
  if(!vscApi||!m1Data||!m1Data.coarse||!(chVis[8]||chVis[9]||chVis[10]))return false;
  var dur=ve-vs;
  return !!(seqTiming&&seqTiming.trTimeSec>0&&dur<=seqTiming.trTimeSec*100.5);
}

function derivedWindowCovers(data,vs,ve){
  return !!(data&&data.startSec!==null&&data.endSec!==null&&data.startSec<=vs+1e-12&&data.endSec>=ve-1e-12);
}

function requestM1Window(vs,ve){
  if(!shouldRequestFineM1Window(vs,ve))return;
  if(derivedWindowCovers(m1WindowData,vs,ve)||derivedWindowCovers(m1WindowPending,vs,ve))return;
  var dur=Math.max(ve-vs,minRasterTime()),pad=Math.max(dur*.5,seqTiming&&seqTiming.trTimeSec?seqTiming.trTimeSec:0);
  var start=Math.max(0,vs-pad),end=Math.min(TD||ve,ve+pad);
  m1WindowPending={startSec:start,endSec:end,requestId:++m1WindowRequestId};
  vscApi.postMessage({command:'calculateM1Window',requestId:m1WindowPending.requestId,startSec:start,endSec:end,maxPoints:120000,referenceMode:m1ReferenceMode});
}

function m1SeriesForView(vs,ve){
  if(!m1Data)return null;
  if(shouldRequestFineM1Window(vs,ve)){
    requestM1Window(vs,ve);
    if(derivedWindowCovers(m1WindowData,vs,ve)){setViewerNotice('m1Detail',null);setViewerNotice('m1Coarse','Large sequence: full sequence uses bounded M1; the current view is detailed.');return m1WindowData;}
  }
  if(m1Data.coarse)setViewerNotice('m1Coarse','Large sequence: showing bounded full-sequence M1. Zoom to 100 TRs or fewer for automatic detail.');
  return m1Data;
}

function shouldRequestFinePnsWindow(vs,ve){
  if(!vscApi||!pnsData||!pnsData.coarse||!chVis[7])return false;
  var dur=ve-vs;
  return !!(seqTiming&&seqTiming.trTimeSec>0&&dur<=seqTiming.trTimeSec*100.5);
}

function pnsWindowCovers(data,vs,ve){
  return derivedWindowCovers(data,vs,ve);
}

function requestPnsWindow(vs,ve){
  if(!shouldRequestFinePnsWindow(vs,ve))return;
  if(pnsWindowCovers(pnsWindowData,vs,ve)||pnsWindowCovers(pnsWindowPending,vs,ve))return;
  var dur=Math.max(ve-vs,minRasterTime()),pad=Math.max(dur*.5,seqTiming&&seqTiming.trTimeSec?seqTiming.trTimeSec:0);
  var start=Math.max(0,vs-pad),end=Math.min(TD||ve,ve+pad);
  pnsWindowPending={startSec:start,endSec:end,requestId:++pnsWindowRequestId};
  vscApi.postMessage({command:'calculatePnsWindow',requestId:pnsWindowPending.requestId,startSec:start,endSec:end,maxPoints:120000});
}

function pnsSeriesForView(vs,ve){
  if(!pnsData)return null;
  if(shouldRequestFinePnsWindow(vs,ve)){
    requestPnsWindow(vs,ve);
    if(pnsWindowCovers(pnsWindowData,vs,ve)){setViewerNotice('pnsCoarse','Large sequence: full sequence uses bounded PNS; the current view is detailed.');return pnsWindowData;}
  }
  if(pnsData.coarse)setViewerNotice('pnsCoarse','Large sequence: showing bounded full-sequence PNS. Zoom to 100 TRs or fewer for automatic detail.');
  return pnsData;
}

/* ── Minimap ──────────────────────────────────────────────────────────── */
var mmCanvas=document.getElementById('mmc'),mmCtx=mmCanvas.getContext('2d');
/* Offscreen cache: static block bands rendered once, then blitted each frame.
 * Invalidated on data load or theme change. */
var mmCache=null, mmCacheW=0, mmCacheDpr=0;

/** (Re)build the offscreen minimap cache using ImageData pixel‑buffer rendering.
 *  Avoids O(blocks) canvas API calls — instead does one integer‑array pass
 *  per block and a single putImageData() at the end.  ~20× faster than fillRect. */
function buildMinimapCache(){
  mmCache=null;
  if(!TD||TD<=0||!BL.length)return;
  var dpr=window.devicePixelRatio||1;
  var W=mmCanvas.width, H=mmCanvas.height;  // physical pixels
  if(W<=0||H<=0)return;

  var s=getComputedStyle(document.body);
  var cssW=W/dpr, scM=cssW/TD;

  // Parse theme colours → [r,g,b]
  var rfRGB=parseHexRGB(s.getPropertyValue('--rf').trim());
  var gxRGB=parseHexRGB(s.getPropertyValue('--gx').trim());
  var gyRGB=parseHexRGB(s.getPropertyValue('--gy').trim());
  var gzRGB=parseHexRGB(s.getPropertyValue('--gz').trim());
  var adcRGB=parseHexRGB(s.getPropertyValue('--adc').trim());
  var bgRGB=parseHexRGB(s.getPropertyValue('--trbg').trim());

  // Band layout in physical pixels
  var rfY0=0, rfY1=5*dpr;
  var gY0=5*dpr, gH=2*dpr;
  var aY0=11*dpr, aY1=H;

  // ── Step 1: accumulate per‑pixel‑column counters ──
  // For each pixel column we store a hit count per band (integer 0..255).
  var pw=Math.max(1,Math.ceil(cssW));
  var rfCnt=new Uint8Array(pw), adcCnt=new Uint8Array(pw);
  var gxCnt=new Uint8Array(pw), gyCnt=new Uint8Array(pw), gzCnt=new Uint8Array(pw);

  // Stride: for very large sequences, skip blocks that map to sub‑pixel positions
  var stride=BL.length>20000?Math.floor(BL.length/15000):1;

  for(var i=0;i<BL.length;i+=stride){
    var b=BL[i];
    var px0=Math.floor(b.s*scM), px1=Math.ceil((b.s+b.d)*scM);
    if(px0>=pw)continue;
    px0=Math.max(0,px0);px1=Math.min(pw,px1);

    if(b.rf) for(var p=px0;p<px1;p++){if(rfCnt[p]<255)rfCnt[p]++;}
    if(b.gx&&b.gx.ty!=='none') for(var p=px0;p<px1;p++){if(gxCnt[p]<255)gxCnt[p]++;}
    if(b.gy&&b.gy.ty!=='none') for(var p=px0;p<px1;p++){if(gyCnt[p]<255)gyCnt[p]++;}
    if(b.gz&&b.gz.ty!=='none') for(var p=px0;p<px1;p++){if(gzCnt[p]<255)gzCnt[p]++;}
    if(b.adc) for(var p=px0;p<px1;p++){if(adcCnt[p]<255)adcCnt[p]++;}
  }

  // ── Step 2: build ImageData from counters ──
  var imgData=new ImageData(W,H);
  var d=imgData.data;
  // Fill background first
  for(var y=0;y<H;y++){
    for(var x=0;x<W;x++){
      var idx=(y*W+x)*4;
      d[idx]=bgRGB[0];d[idx+1]=bgRGB[1];d[idx+2]=bgRGB[2];d[idx+3]=255;
    }
  }
  // Overlay each band — alpha proportional to hit count, clamped
  for(var px=0;px<pw;px++){
    var x0=Math.floor(px*dpr), x1=Math.floor((px+1)*dpr);
    if(x1<=x0)x1=x0+1;

    // RF band
    if(rfCnt[px]>0){
      var a=Math.min(140,rfCnt[px]*55);
      fillBand(d,W,x0,x1,rfY0,rfY1,rfRGB[0],rfRGB[1],rfRGB[2],a);
    }
    // Gx band
    if(gxCnt[px]>0){
      var a=Math.min(150,gxCnt[px]*60);
      fillBand(d,W,x0,x1,gY0,gY0+gH,gxRGB[0],gxRGB[1],gxRGB[2],a);
    }
    // Gy band
    if(gyCnt[px]>0){
      var a=Math.min(150,gyCnt[px]*60);
      fillBand(d,W,x0,x1,gY0+gH,gY0+2*gH,gyRGB[0],gyRGB[1],gyRGB[2],a);
    }
    // Gz band
    if(gzCnt[px]>0){
      var a=Math.min(150,gzCnt[px]*60);
      fillBand(d,W,x0,x1,gY0+2*gH,gY0+3*gH,gzRGB[0],gzRGB[1],gzRGB[2],a);
    }
    // ADC band
    if(adcCnt[px]>0){
      var a=Math.min(130,adcCnt[px]*50);
      fillBand(d,W,x0,x1,aY0,aY1,adcRGB[0],adcRGB[1],adcRGB[2],a);
    }
  }

  // Write to offscreen canvas
  var oc=document.createElement('canvas');
  oc.width=W;oc.height=H;
  oc.getContext('2d').putImageData(imgData,0,0);
  mmCache=oc;mmCacheW=W;mmCacheDpr=dpr;
}

/** Fill a rectangular band in the ImageData buffer with alpha blending. */
function fillBand(d,W,x0,x1,y0,y1,r,g,b,a){
  for(var y=y0;y<y1;y++){
    for(var x=x0;x<x1;x++){
      var i=(y*W+x)*4;
      var srcA=a/255, dstA=d[i+3]/255;
      var outA=srcA+dstA*(1-srcA);
      if(outA<0.001)continue;
      d[i]  =(r*srcA+d[i]  *dstA*(1-srcA))/outA;
      d[i+1]=(g*srcA+d[i+1]*dstA*(1-srcA))/outA;
      d[i+2]=(b*srcA+d[i+2]*dstA*(1-srcA))/outA;
      d[i+3]=Math.round(outA*255);
    }
  }
}

/** Parse a hex colour (#rrggbb or #rgb) to [r,g,b]. */
function parseHexRGB(c){
  if(!c||c[0]!=='#')return[128,128,128];
  var h=c.substring(1);
  if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  return[parseInt(h.substring(0,2),16),parseInt(h.substring(2,4),16),parseInt(h.substring(4,6),16)];
}

/** Fast per‑frame draw: blit cache + dynamic viewport highlight + TR lines + text. */
function drawMinimap(){
  var dpr=window.devicePixelRatio||1;
  var W=mmCanvas.width/dpr, H=mmCanvas.height/dpr;
  mmCtx.globalAlpha=1;  // reset — prevent stale alpha from previous draws
  mmCtx.clearRect(0,0,W,H);
  if(!TD||TD<=0)return;
  var s=getComputedStyle(document.body);

  // Rebuild cache when needed (data changed, theme changed, or DPR changed)
  if(!mmCache||mmCacheW!==mmCanvas.width||mmCacheDpr!==dpr){
    buildMinimapCache();
  }

  // ── Blit cached block bands ──
  if(mmCache){
    mmCtx.drawImage(mmCache,0,0);
  }else{
    mmCtx.fillStyle=s.getPropertyValue('--trbg').trim();mmCtx.fillRect(0,0,W,H);
  }

  if(!BL.length)return;
  var scM=W/TD;

  // ── TR boundary lines ──
  if(seqTiming&&seqTiming.trTimeSec>0&&seqTiming.trCount>1){
    mmCtx.strokeStyle=s.getPropertyValue('--fg').trim();
    mmCtx.globalAlpha=0.10;mmCtx.lineWidth=0.4;
    mmCtx.beginPath();
    var trStep=Math.max(1,Math.ceil(seqTiming.trCount/Math.max(1,W)));
    for(var tr=0;tr<=seqTiming.trCount;tr+=trStep){
      var tx=tr*seqTiming.trTimeSec*scM;
      if(tx<=W){mmCtx.moveTo(tx,0);mmCtx.lineTo(tx,H);}
    }
    mmCtx.stroke();mmCtx.globalAlpha=1;
  }

  // ── Viewport highlight ──
  var mcW=mc.width/dpr;
  var visibleDur = plotWidth() / Math.max(sc, 1e-12);
  var vx0=ox*scM, vx1=(ox+visibleDur)*scM;
  vx0=Math.max(0,vx0);vx1=Math.min(W,vx1);
  var vw=Math.max(2,vx1-vx0);
  // Subtle wash
  mmCtx.fillStyle=s.getPropertyValue('--fg').trim();mmCtx.globalAlpha=0.18;
  mmCtx.fillRect(vx0,0,vw,H);
  // Edge markers — only when viewport is not flush against the canvas edge
  mmCtx.globalAlpha=0.45;
  mmCtx.fillStyle=s.getPropertyValue('--adc').trim();
  if(vx0>0.5)mmCtx.fillRect(vx0,0,1,H);
  if(vx1<W-0.5)mmCtx.fillRect(vx1-1,0,1,H);
  mmCtx.globalAlpha=1;

  // ── Info text ──
  var info='';
  if(seqTiming){
    if(seqTiming.trTimeSec>0)info+='TR='+fmtDur2(seqTiming.trTimeSec)+(seqTiming.hasExplicitTR?'':'~')+'  ';
    if(seqTiming.teTimeSec>0)info+='TE='+fmtDur2(seqTiming.teTimeSec)+'  ';
    if(seqTiming.trCount>1)info+=seqTiming.trCount+' TRs';
  }
  if(info){
    mmCtx.fillStyle='rgba(0,0,0,0.35)';mmCtx.font='9px monospace';mmCtx.textAlign='left';
    mmCtx.fillText(info,5,H-3);
    mmCtx.fillStyle=s.getPropertyValue('--fg').trim();mmCtx.globalAlpha=0.9;
    mmCtx.fillText(info,4,H-4);
    mmCtx.globalAlpha=1;
  }
}

function fmtDur2(s){
  if(s>=1)return s.toFixed(2)+'s';
  if(s>=0.001)return(s*1e3).toFixed(1)+'ms';
  return(s*1e6).toFixed(0)+'\u00b5s';
}

/* ── Canvas resize ────────────────────────────────────────────────────── */
function rs(){
  var dpr=window.devicePixelRatio||1,r=cc.getBoundingClientRect();
  mc.width=r.width*dpr;mc.height=r.height*dpr;
  mc.style.width=r.width+'px';mc.style.height=r.height+'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);
  moc.width=r.width*dpr;moc.height=r.height*dpr;
  moc.style.width=r.width+'px';moc.style.height=r.height+'px';
  moctx.setTransform(dpr,0,0,dpr,0,0);
  // Adaptive margins for small/narrow screens
  if(layoutMode==='vertical'||r.width<600){
    M.l=60;M.r=3;M.t=5;M.b=18;
  }else{
    M.l=92;M.r=4;M.t=8;M.b=22;
  }
  // Resize minimap canvas too
  var mr=document.getElementById('mmap').getBoundingClientRect();
  mmCanvas.width=mr.width*dpr;mmCanvas.height=mr.height*dpr;
  mmCanvas.style.width=mr.width+'px';mmCanvas.style.height=mr.height+'px';
  mmCtx.setTransform(dpr,0,0,dpr,0,0);
  draw();drawMinimap();
}
window.addEventListener('resize',rs);new ResizeObserver(rs).observe(cc);

/* ── Coordinate mapping ───────────────────────────────────────────────── */
function visChannels(){var v=[];for(var i=0;i<CH.length;i++)if(chVis[i])v.push(i);return v;}
function cy(vi){var vc=visChannels(),h=(mc.height/(window.devicePixelRatio||1)-M.t-M.b)/Math.max(vc.length,1);return M.t+vi*h+h/2;}
function cH(){var vc=visChannels();return(mc.height/(window.devicePixelRatio||1)-M.t-M.b)/Math.max(vc.length,1);}
function t2x(t){return M.l+(t-ox)*sc}
function x2t(x){return ox+(x-M.l)/sc}

/* ── Viewport bounds ───────────────────────────────────────────────────── */
function plotWidth(){
  var dpr=window.devicePixelRatio||1,w=mc.width/dpr;
  return Math.max(1,w-M.l-M.r);
}
function minRasterTime(){
  var vals=[GR,RR,AR,BR].filter(function(v){return isFinite(v)&&v>0;});
  return vals.length?Math.min.apply(null,vals):1e-7;
}
function visibleDuration(){return plotWidth()/Math.max(sc,1e-12);}
function clampView(){
  var pw=plotWidth();
  if(!isFinite(TD)||TD<=0){ox=0;sc=1;return;}
  if(!isFinite(sc)||sc<=0)sc=pw/TD;
  var minDur=Math.min(TD,minRasterTime());
  var dur=visibleDuration();
  if(!isFinite(dur)||dur<=0)dur=TD;
  dur=Math.max(minDur,Math.min(TD,dur));
  sc=pw/dur;
  var maxOx=Math.max(0,TD-dur);
  if(!isFinite(ox))ox=0;
  ox=Math.max(0,Math.min(ox,maxOx));
}
function zoomAt(screenX,zf){
  if(!isFinite(zf)||zf<=0)return false;
  var oldSc=sc,oldOx=ox;
  var tm=x2t(screenX);
  sc*=zf;
  var dur=visibleDuration();
  if(!isFinite(dur)||dur<=0)dur=TD||minRasterTime();
  var maxDur=TD||dur,minDur=Math.min(maxDur,minRasterTime());
  dur=Math.max(minDur,Math.min(maxDur,dur));
  sc=plotWidth()/dur;
  ox=tm-(screenX-M.l)/sc;
  clampView();
  var scaleTol=Math.max(1,Math.abs(oldSc))*1e-12,offsetTol=Math.max(1,TD)*1e-12;
  return Math.abs(sc-oldSc)>scaleTol||Math.abs(ox-oldOx)>offsetTol;
}
function zoomAtCenter(zf){
  return zoomAt(M.l+plotWidth()/2,zf);
}

/* ── Initial view: zoom to first TR ───────────────────────────────────── */
function fitToFirstTR(){
  if(!seqTiming||seqTiming.trTimeSec<=0){fit();return;}
  var w=mc.width/(window.devicePixelRatio||1);
  // Show first TR with 10% padding on each side
  var trDur=seqTiming.trTimeSec;
  sc=(w-M.l-M.r)/(trDur*1.2);
  ox=Math.max(0,-trDur*0.1);  // small negative offset for left padding
  clampView();
}


/* ══ derived-series.js ══ */
/* Multiresolution first/min/max/last summaries for derived waveform rendering. */
function createDerivedSeries(time,values,scale){
  var n=Math.min(time?time.length:0,values?values.length:0),maxAbs=0;
  var series={t:time||[],v:values||[],n:n,scale:scale||1,maxAbs:0,levels:[]};
  for(var i=0;i<n;i++)if(isFinite(values[i]))maxAbs=Math.max(maxAbs,Math.abs(values[i]*(scale||1)));
  series.maxAbs=maxAbs;
  if(n<16)return series;

  var bucketSize=8,child=null;
  while(bucketSize<n){
    var count=Math.ceil(n/bucketSize),mins=new Int32Array(count),maxs=new Int32Array(count);
    mins.fill(-1);maxs.fill(-1);
    for(var b=0;b<count;b++){
      var minIndex=-1,maxIndex=-1;
      if(!child){
        var start=b*bucketSize,end=Math.min(n,start+bucketSize);
        for(var j=start;j<end;j++){
          var value=values[j];if(!isFinite(value))continue;
          if(minIndex<0||value<values[minIndex])minIndex=j;
          if(maxIndex<0||value>values[maxIndex])maxIndex=j;
        }
      }else{
        var childStart=b*4,childEnd=Math.min(child.mins.length,childStart+4);
        for(var c=childStart;c<childEnd;c++){
          var candidates=[child.mins[c],child.maxs[c]];
          for(var k=0;k<2;k++){
            var index=candidates[k];if(index<0)continue;
            if(minIndex<0||values[index]<values[minIndex])minIndex=index;
            if(maxIndex<0||values[index]>values[maxIndex])maxIndex=index;
          }
        }
      }
      mins[b]=minIndex;maxs[b]=maxIndex;
    }
    child={bucketSize:bucketSize,mins:mins,maxs:maxs};
    series.levels.push(child);
    if(count<=1)break;
    bucketSize*=4;
  }
  return series;
}

/* Explicit time-bucket envelopes used by bounded full-sequence M1/PNS. */
function createEnvelopeSeries(startTime,endTime,minValues,maxValues,firstValues,lastValues,scale){
  var n=Math.min(startTime?startTime.length:0,endTime?endTime.length:0,minValues?minValues.length:0,maxValues?maxValues.length:0);
  var series={kind:'envelope',n:n,scale:scale||1,maxAbs:0,levels:[]};
  if(n<1)return series;
  var base={count:n,bucketSize:1,t0:startTime,t1:endTime,min:minValues,max:maxValues,first:firstValues||minValues,last:lastValues||maxValues};
  series.levels.push(base);
  for(var i=0;i<n;i++){
    if(isFinite(minValues[i]))series.maxAbs=Math.max(series.maxAbs,Math.abs(minValues[i]*(scale||1)));
    if(isFinite(maxValues[i]))series.maxAbs=Math.max(series.maxAbs,Math.abs(maxValues[i]*(scale||1)));
  }
  var level=base;
  while(level.count>1){level=mergeEnvelopeLevel(level);series.levels.push(level);}
  return series;
}

function mergeEnvelopeLevel(child){
  var count=Math.ceil(child.count/4),level={count:count,bucketSize:child.bucketSize*4,t0:new Float64Array(count),t1:new Float64Array(count),min:new Float64Array(count),max:new Float64Array(count),first:new Float64Array(count),last:new Float64Array(count)};
  level.min.fill(Infinity);level.max.fill(-Infinity);
  for(var bucket=0;bucket<count;bucket++){
    var start=bucket*4,end=Math.min(child.count,start+4);
    level.t0[bucket]=child.t0[start];level.t1[bucket]=child.t1[end-1];level.first[bucket]=child.first[start];level.last[bucket]=child.last[end-1];
    for(var i=start;i<end;i++){if(child.min[i]<level.min[bucket])level.min[bucket]=child.min[i];if(child.max[i]>level.max[bucket])level.max[bucket]=child.max[i];}
  }
  return level;
}

function envelopeLevelWindow(level,viewStart,viewEnd){
  var i0=Math.max(0,lowerBoundSeries(level.t1,viewStart));
  var i1=Math.min(level.count,upperBoundSeries(level.t0,viewEnd));
  return{i0:i0,i1:i1,count:Math.max(0,i1-i0)};
}

function selectEnvelopeLevel(series,viewStart,viewEnd,maxBuckets){
  if(!series||series.kind!=='envelope'||!series.levels.length)return null;
  var selected=series.levels[series.levels.length-1];
  for(var i=0;i<series.levels.length;i++){
    var candidate=series.levels[i];
    if(envelopeLevelWindow(candidate,viewStart,viewEnd).count<=maxBuckets){selected=candidate;break;}
  }
  return selected;
}

function forEachEnvelopeRange(series,viewStart,viewEnd,maxBuckets,visit){
  var level=selectEnvelopeLevel(series,viewStart,viewEnd,maxBuckets);if(!level)return 0;
  var range=envelopeLevelWindow(level,viewStart,viewEnd),emitted=0;
  for(var i=range.i0;i<range.i1;i++){
    if(!isFinite(level.t0[i])||!isFinite(level.t1[i])||!isFinite(level.min[i])||!isFinite(level.max[i]))continue;
    visit(Math.max(viewStart,level.t0[i]),Math.min(viewEnd,level.t1[i]),level.min[i]*series.scale,level.max[i]*series.scale,level.first[i]*series.scale,level.last[i]*series.scale);
    emitted++;
  }
  return emitted;
}

function sampleEnvelopeRangeAtTime(series,timeSec){
  if(!series||series.kind!=='envelope'||!series.levels.length||!isFinite(timeSec))return null;
  var base=series.levels[0];if(!base||base.count<1)return null;
  var index=Math.max(0,lowerBoundSeries(base.t1,timeSec));
  if(index>=base.count||timeSec<base.t0[index]||timeSec>base.t1[index])return null;
  return{
    startTime:base.t0[index],endTime:base.t1[index],
    min:base.min[index]*series.scale,max:base.max[index]*series.scale,
    first:base.first[index]*series.scale,last:base.last[index]*series.scale
  };
}

function lowerBoundSeries(values,target){
  var lo=0,hi=values.length;
  while(lo<hi){var mid=(lo+hi)>>1;if(values[mid]<target)lo=mid+1;else hi=mid}
  return lo;
}
function upperBoundSeries(values,target){
  var lo=0,hi=values.length;
  while(lo<hi){var mid=(lo+hi)>>1;if(values[mid]<=target)lo=mid+1;else hi=mid}
  return lo;
}

function derivedSeriesWindow(series,viewStart,viewEnd){
  if(!series||series.n<1)return{i0:0,i1:0,count:0};
  var i0=Math.max(0,lowerBoundSeries(series.t,viewStart)-1);
  var i1=Math.min(series.n,upperBoundSeries(series.t,viewEnd)+1);
  return{i0:i0,i1:i1,count:Math.max(0,i1-i0)};
}

function forEachDerivedRange(series,viewStart,viewEnd,maxBuckets,visit){
  var windowRange=derivedSeriesWindow(series,viewStart,viewEnd);
  if(windowRange.count<1)return 0;
  var i0=windowRange.i0,i1=windowRange.i1,t=series.t,v=series.v,n=series.n;
  var level=series.levels[series.levels.length-1];
  for(var li=0;li<series.levels.length;li++){
    var candidate=series.levels[li];
    var visibleBuckets=Math.ceil(i1/candidate.bucketSize)-Math.floor(i0/candidate.bucketSize);
    if(visibleBuckets<=maxBuckets){level=candidate;break}
  }
  var emitted=0,size=level.bucketSize;
  var firstBucket=Math.floor(i0/size),lastBucket=Math.floor((i1-1)/size);
  function emitRange(start,end,minIndex,maxIndex){
    if(end<=start)return;
    if(minIndex===undefined||maxIndex===undefined){
      minIndex=-1;maxIndex=-1;
      for(var index=start;index<end;index++){
        if(!isFinite(v[index]))continue;
        if(minIndex<0||v[index]<v[minIndex])minIndex=index;
        if(maxIndex<0||v[index]>v[maxIndex])maxIndex=index;
      }
    }
    if(minIndex<0||maxIndex<0)return;
    var center=0.5*(t[start]+t[end-1]);
    if(!isFinite(center))return;
    visit(center,v[minIndex]*series.scale,v[maxIndex]*series.scale);
    emitted++;
  }
  if(firstBucket===lastBucket){
    emitRange(i0,i1);
    return emitted;
  }
  emitRange(i0,Math.min(i1,(firstBucket+1)*size));
  for(var bucket=firstBucket+1;bucket<lastBucket;bucket++){
    var start=bucket*size,end=Math.min(n,start+size);
    emitRange(start,end,level.mins[bucket],level.maxs[bucket]);
  }
  emitRange(Math.max(i0,lastBucket*size),i1);
  return emitted;
}

function forEachDerivedPoint(series,viewStart,viewEnd,maxPoints,visit){
  if(!series||series.n<1)return 0;
  var t=series.t,v=series.v,n=series.n;
  var windowRange=derivedSeriesWindow(series,viewStart,viewEnd);
  var i0=windowRange.i0,i1=windowRange.i1;
  if(i1<=i0)return 0;
  var count=i1-i0,emitted=0;
  function emit(index){
    if(index<i0||index>=i1||!isFinite(t[index])||!isFinite(v[index]))return;
    visit(t[index],v[index]*series.scale);emitted++;
  }
  if(count<=maxPoints||!series.levels.length){
    for(var raw=i0;raw<i1;raw++)emit(raw);
    return emitted;
  }

  var maxBuckets=Math.max(1,Math.floor(maxPoints/4)),level=series.levels[series.levels.length-1];
  for(var li=0;li<series.levels.length;li++){
    var candidate=series.levels[li],visibleBuckets=Math.ceil(i1/candidate.bucketSize)-Math.floor(i0/candidate.bucketSize);
    if(visibleBuckets<=maxBuckets){level=candidate;break}
  }
  var size=level.bucketSize,firstBucket=Math.floor(i0/size),lastBucket=Math.floor((i1-1)/size);
  function emitRange(start,end){
    var minIndex=-1,maxIndex=-1;
    for(var index=start;index<end;index++){
      if(!isFinite(v[index]))continue;
      if(minIndex<0||v[index]<v[minIndex])minIndex=index;
      if(maxIndex<0||v[index]>v[maxIndex])maxIndex=index;
    }
    emitOrdered([start,minIndex,maxIndex,end-1]);
  }
  function emitOrdered(indices){
    indices.sort(function(a,b){return a-b});
    var previous=-1;
    for(var index=0;index<indices.length;index++){
      var sample=indices[index];if(sample<0||sample===previous)continue;
      emit(sample);previous=sample;
    }
  }
  if(firstBucket===lastBucket){
    emitRange(i0,i1);
    return emitted;
  }
  var firstEnd=Math.min(i1,(firstBucket+1)*size);
  emitRange(i0,firstEnd);
  for(var bucket=firstBucket+1;bucket<lastBucket;bucket++){
    var start=bucket*size,end=Math.min(n,start+size);
    emitOrdered([start,level.mins[bucket],level.maxs[bucket],end-1]);
  }
  emitRange(Math.max(i0,lastBucket*size),i1);
  return emitted;
}

/* Ordered M4-style reduction for one waveform. Keeps both extrema per bucket. */
function forEachWaveformPoint(time,values,maxPoints,visit){
  var n=Math.min(time?time.length:0,values?values.length:0);if(n<1||maxPoints<1)return 0;
  if(n<=maxPoints){for(var direct=0;direct<n;direct++)visit(time[direct],values[direct]);return n;}
  var bucketCount=Math.max(1,Math.floor(maxPoints/4)),emitted=0;
  for(var bucket=0;bucket<bucketCount;bucket++){
    var start=Math.floor(bucket*n/bucketCount),end=Math.max(start+1,Math.floor((bucket+1)*n/bucketCount));end=Math.min(n,end);
    var minIndex=start,maxIndex=start;
    for(var i=start+1;i<end;i++){if(values[i]<values[minIndex])minIndex=i;if(values[i]>values[maxIndex])maxIndex=i;}
    var indices=[start,minIndex,maxIndex,end-1].sort(function(a,b){return a-b;}),previous=-1;
    for(var j=0;j<indices.length;j++){var index=indices[j];if(index===previous)continue;visit(time[index],values[index]);previous=index;emitted++;}
  }
  return emitted;
}

function createRfEventOverview(blocks){
  var starts=[],ends=[],peaks=[],peakTimes=[],areas=[],waveforms=[];
  for(var bi=0;bi<blocks.length;bi++){
    var rf=blocks[bi]&&blocks[bi].rf;if(!rf)continue;
    var start=isFinite(rf.s)?rf.s:(rf.t&&rf.t.length?rf.t[0]:NaN),end=isFinite(rf.d)&&isFinite(start)?start+Math.max(0,rf.d):(rf.t&&rf.t.length?rf.t[rf.t.length-1]:NaN);
    if(!isFinite(start)||!isFinite(end))continue;
    var n=Math.min(rf.t?rf.t.length:0,rf.m?rf.m.length:0),peak=isFinite(rf.pk)?Math.abs(rf.pk):0,peakTime=(start+end)*.5,area=isFinite(rf.ar)?Math.max(0,rf.ar):0,samplePeak=-1;
    for(var i=0;i<n;i++)if(isFinite(rf.m[i])&&isFinite(rf.t[i])&&Math.abs(rf.m[i])>samplePeak){samplePeak=Math.abs(rf.m[i]);peakTime=rf.t[i];}
    if(!isFinite(rf.pk))peak=Math.max(0,samplePeak);
    if(!isFinite(rf.ar))for(var sample=1;sample<n;sample++){
      var dt=rf.t[sample]-rf.t[sample-1];if(!isFinite(dt)||dt<=0)continue;
      area+=.5*(Math.abs(rf.m[sample-1]||0)+Math.abs(rf.m[sample]||0))*dt;
    }
    if(n<2&&peak>0&&end>start)area=peak*(end-start);
    starts.push(start);ends.push(end);peaks.push(peak);peakTimes.push(peakTime);areas.push(area);waveforms.push(rf);
  }
  return{count:starts.length,start:new Float64Array(starts),end:new Float64Array(ends),peak:new Float64Array(peaks),peakTime:new Float64Array(peakTimes),area:new Float64Array(areas),waveforms:waveforms};
}

function binRfEvents(series,viewStart,viewEnd,pixelCount,widePixelThreshold){
  var count=Math.max(1,Math.floor(pixelCount)),peak=new Float64Array(count),peakTime=new Float64Array(count),occupiedStart=new Float64Array(count),occupiedEnd=new Float64Array(count),area=new Float64Array(count),events=new Uint32Array(count),wide=[];
  if(!series||series.count<1||!isFinite(viewStart)||!isFinite(viewEnd)||viewEnd<=viewStart)return{peak:peak,peakTime:peakTime,occupiedStart:occupiedStart,occupiedEnd:occupiedEnd,area:area,events:events,wide:wide,secondsPerPixel:0};
  var secondsPerPixel=(viewEnd-viewStart)/count,first=Math.max(0,lowerBoundSeries(series.end,viewStart));
  for(var i=first;i<series.count;i++){
    var start=series.start[i],end=series.end[i];if(start>viewEnd)break;if(end<viewStart)continue;
    var clippedStart=Math.max(viewStart,start),clippedEnd=Math.min(viewEnd,end),duration=Math.max(0,end-start);
    if(duration/secondsPerPixel>=widePixelThreshold){wide.push(i);continue;}
    var firstBin=Math.max(0,Math.min(count-1,Math.floor((clippedStart-viewStart)/secondsPerPixel)));
    var lastBin=Math.max(firstBin,Math.min(count-1,Math.ceil((clippedEnd-viewStart)/secondsPerPixel)-1));
    for(var bin=firstBin;bin<=lastBin;bin++){
      var binStart=viewStart+bin*secondsPerPixel,binEnd=binStart+secondsPerPixel;
      var overlap=Math.max(0,Math.min(clippedEnd,binEnd)-Math.max(clippedStart,binStart));
      if(duration<=0){if(bin!==firstBin)continue;overlap=secondsPerPixel;}
      if(overlap<=0)continue;
      var overlapStart=Math.max(clippedStart,binStart),overlapEnd=Math.min(clippedEnd,binEnd),eventPeak=series.peak[i];
      if(events[bin]<1){occupiedStart[bin]=overlapStart;occupiedEnd[bin]=overlapEnd;peakTime[bin]=Math.max(overlapStart,Math.min(overlapEnd,series.peakTime[i]));}
      else{occupiedStart[bin]=Math.min(occupiedStart[bin],overlapStart);occupiedEnd[bin]=Math.max(occupiedEnd[bin],overlapEnd);}
      if(eventPeak>peak[bin]){peak[bin]=eventPeak;peakTime[bin]=Math.max(overlapStart,Math.min(overlapEnd,series.peakTime[i]));}
      area[bin]+=series.area[i]*(duration>0?overlap/duration:1);events[bin]++;
    }
  }
  return{peak:peak,peakTime:peakTime,occupiedStart:occupiedStart,occupiedEnd:occupiedEnd,area:area,events:events,wide:wide,secondsPerPixel:secondsPerPixel};
}

/* Block-indexed min/max summaries for RF, gradients, and ADC occupancy. */
function createWaveformOverview(blocks){
  if(!blocks||!blocks.length)return null;
  var level=buildWaveformOverviewLevel(blocks,1),levels=[level];
  while(level.count>1){level=mergeWaveformOverviewLevel(level);levels.push(level);}
  return{levels:levels,blockCount:blocks.length,pointPrefix:createWaveformPointPrefixes(blocks),rfEvents:createRfEventOverview(blocks)};
}

function createEmptyWaveformOverviewLevel(count,bucketSize){
  var level={count:count,bucketSize:bucketSize,t0:new Float64Array(count),t1:new Float64Array(count),
    rfMin:new Float64Array(count),rfMax:new Float64Array(count),gxMin:new Float64Array(count),gxMax:new Float64Array(count),
    rfStart:new Float64Array(count),rfEnd:new Float64Array(count),
    gyMin:new Float64Array(count),gyMax:new Float64Array(count),gzMin:new Float64Array(count),gzMax:new Float64Array(count),
    gxStart:new Float64Array(count),gxEnd:new Float64Array(count),gyStart:new Float64Array(count),gyEnd:new Float64Array(count),gzStart:new Float64Array(count),gzEnd:new Float64Array(count),
    adcStart:new Float64Array(count),adcEnd:new Float64Array(count)};
  var mins=[level.rfMin,level.rfStart,level.gxMin,level.gyMin,level.gzMin,level.gxStart,level.gyStart,level.gzStart,level.adcStart];
  var maxs=[level.rfMax,level.rfEnd,level.gxMax,level.gyMax,level.gzMax,level.gxEnd,level.gyEnd,level.gzEnd,level.adcEnd];
  for(var m=0;m<mins.length;m++)mins[m].fill(Infinity);
  for(var x=0;x<maxs.length;x++)maxs[x].fill(-Infinity);
  return level;
}

function createWaveformPointPrefixes(blocks){
  var keys=['rf','rfEvents','phase','gx','gy','gz','adc'],prefix={};
  for(var ki=0;ki<keys.length;ki++)prefix[keys[ki]]=new Float64Array(blocks.length+1);
  for(var i=0;i<blocks.length;i++){
    var block=blocks[i],rf=block.rf,adc=block.adc;
    prefix.rf[i+1]=prefix.rf[i]+(rf&&rf.t&&rf.m?Math.min(rf.t.length,rf.m.length):0);
    prefix.rfEvents[i+1]=prefix.rfEvents[i]+(rf?1:0);
    var rfPhase=rf&&(rf.pt||rf.t)&&rf.p?Math.min((rf.pt||rf.t).length,rf.p.length):0,adcPhase=0;
    if(adc&&adc.n>1){var step=Math.max(1,Math.ceil(adc.n/200));adcPhase=Math.floor(adc.n/step)+1;}
    prefix.phase[i+1]=prefix.phase[i]+rfPhase+adcPhase;
    prefix.gx[i+1]=prefix.gx[i]+overviewGradientPointCount(block.gx);
    prefix.gy[i+1]=prefix.gy[i]+overviewGradientPointCount(block.gy);
    prefix.gz[i+1]=prefix.gz[i]+overviewGradientPointCount(block.gz);
    prefix.adc[i+1]=prefix.adc[i]+(adc?1:0);
  }
  return prefix;
}

function overviewGradientPointCount(gradient){
  return gradient&&gradient.ty!=='none'&&gradient.t&&gradient.w?Math.min(gradient.t.length,gradient.w.length):0;
}

function includeOverviewValues(values,minArray,maxArray,bucket){
  if(!values)return;
  for(var i=0;i<values.length;i++){
    var value=values[i];if(!isFinite(value))continue;
    if(value<minArray[bucket])minArray[bucket]=value;
    if(value>maxArray[bucket])maxArray[bucket]=value;
  }
}

function includeOverviewRf(rf,level,bucket){
  if(!rf)return;
  includeOverviewValues(rf.m,level.rfMin,level.rfMax,bucket);
  if(level.rfMin[bucket]===Infinity)includeOverviewValues([rf.a||0],level.rfMin,level.rfMax,bucket);
  var start=isFinite(rf.s)?rf.s:(rf.t&&rf.t.length?rf.t[0]:NaN),end=isFinite(rf.d)&&isFinite(start)?start+rf.d:(rf.t&&rf.t.length?rf.t[rf.t.length-1]:NaN);
  if(isFinite(start)&&start<level.rfStart[bucket])level.rfStart[bucket]=start;
  if(isFinite(end)&&end>level.rfEnd[bucket])level.rfEnd[bucket]=end;
}

function includeOverviewGradient(gradient,level,key,bucket){
  if(!gradient||gradient.ty==='none'||!gradient.t||!gradient.w)return;
  var n=Math.min(gradient.t.length,gradient.w.length);if(n<2)return;
  var maxAbs=0;for(var i=0;i<n;i++)if(isFinite(gradient.w[i]))maxAbs=Math.max(maxAbs,Math.abs(gradient.w[i]));
  var epsilon=Math.max(1e-12,maxAbs*1e-12),minArray=level[key+'Min'],maxArray=level[key+'Max'],startArray=level[key+'Start'],endArray=level[key+'End'];
  for(var segment=0;segment<n-1;segment++){
    var t0=gradient.t[segment],t1=gradient.t[segment+1],v0=gradient.w[segment],v1=gradient.w[segment+1];
    if(!isFinite(t0)||!isFinite(t1)||!isFinite(v0)||!isFinite(v1)||t1<t0)continue;
    if(Math.abs(v0)<=epsilon&&Math.abs(v1)<=epsilon)continue;
    if(t0<startArray[bucket])startArray[bucket]=t0;if(t1>endArray[bucket])endArray[bucket]=t1;
    if(v0<minArray[bucket])minArray[bucket]=v0;if(v1<minArray[bucket])minArray[bucket]=v1;
    if(v0>maxArray[bucket])maxArray[bucket]=v0;if(v1>maxArray[bucket])maxArray[bucket]=v1;
  }
}

function buildWaveformOverviewLevel(blocks,bucketSize){
  var count=Math.ceil(blocks.length/bucketSize),level=createEmptyWaveformOverviewLevel(count,bucketSize);
  for(var bucket=0;bucket<count;bucket++){
    var start=bucket*bucketSize,end=Math.min(blocks.length,start+bucketSize);
    level.t0[bucket]=blocks[start].s;level.t1[bucket]=blocks[end-1].s+blocks[end-1].d;
    for(var bi=start;bi<end;bi++){
      var block=blocks[bi],rf=block.rf;
      if(rf)includeOverviewRf(rf,level,bucket);
      includeOverviewGradient(block.gx,level,'gx',bucket);includeOverviewGradient(block.gy,level,'gy',bucket);includeOverviewGradient(block.gz,level,'gz',bucket);
      if(block.adc){
        var adcStart=block.adc.s+block.adc.d,adcEnd=adcStart+block.adc.n*block.adc.dw;
        if(adcStart<level.adcStart[bucket])level.adcStart[bucket]=adcStart;
        if(adcEnd>level.adcEnd[bucket])level.adcEnd[bucket]=adcEnd;
      }
    }
  }
  return level;
}

function mergeWaveformOverviewLevel(child){
  var count=Math.ceil(child.count/4),level=createEmptyWaveformOverviewLevel(count,child.bucketSize*4);
  var channels=[['rfMin','rfMax'],['rfStart','rfEnd'],['gxMin','gxMax'],['gyMin','gyMax'],['gzMin','gzMax'],['gxStart','gxEnd'],['gyStart','gyEnd'],['gzStart','gzEnd'],['adcStart','adcEnd']];
  for(var bucket=0;bucket<count;bucket++){
    var start=bucket*4,end=Math.min(child.count,start+4);
    level.t0[bucket]=child.t0[start];level.t1[bucket]=child.t1[end-1];
    for(var ci=0;ci<channels.length;ci++){
      var minKey=channels[ci][0],maxKey=channels[ci][1];
      for(var i=start;i<end;i++){
        if(child[minKey][i]<level[minKey][bucket])level[minKey][bucket]=child[minKey][i];
        if(child[maxKey][i]>level[maxKey][bucket])level[maxKey][bucket]=child[maxKey][i];
      }
    }
  }
  return level;
}

function waveformVisiblePointCount(overview,key,startBlock,endBlock){
  if(!overview||!overview.pointPrefix||!overview.pointPrefix[key])return 0;
  var prefix=overview.pointPrefix[key],start=Math.max(0,Math.min(startBlock,prefix.length-1)),end=Math.max(start,Math.min(endBlock,prefix.length-1));
  return prefix[end]-prefix[start];
}

function waveformVisibleGradientPointCount(blocks,key,startBlock,endBlock,viewStart,viewEnd){
  var count=0;
  for(var blockIndex=startBlock;blockIndex<endBlock;blockIndex++){
    var gradient=blocks[blockIndex]&&blocks[blockIndex][key];
    if(!gradient||gradient.ty==='none'||!gradient.t||!gradient.w)continue;
    var n=Math.min(gradient.t.length,gradient.w.length);
    if(n<1)continue;
    var first=lowerBoundSeries(gradient.t,viewStart),last=upperBoundSeries(gradient.t,viewEnd);
    count+=Math.max(0,Math.min(n,last)-Math.min(n,first));
  }
  return count;
}

function selectWaveformOverview(overview,startBlock,endBlock,maxBuckets){
  if(!overview||endBlock<=startBlock)return null;
  var selected=overview.levels[overview.levels.length-1];
  for(var i=0;i<overview.levels.length;i++){
    var candidate=overview.levels[i];
    var count=Math.ceil(endBlock/candidate.bucketSize)-Math.floor(startBlock/candidate.bucketSize);
    if(count<=maxBuckets){selected=candidate;break;}
  }
  return{level:selected,first:Math.floor(startBlock/selected.bucketSize),last:Math.min(selected.count,Math.ceil(endBlock/selected.bucketSize))};
}


/* ══ drawing.js ══ */
/* ═══════════════════════════════════════════════════════════════════════
   Main draw loop
   ═══════════════════════════════════════════════════════════════════════ */
function draw(){
  var drawStarted=performance.now();derivedRenderPointCount=0;derivedEnvelopeCurveCount=0;derivedRawCurveCount=0;rfRenderPointCount=0;rfRawCurveCount=0;rfReducedCurveCount=0;rfOverviewBucketCount=0;viewerDrawCount++;
  var w=mc.width/(window.devicePixelRatio||1),h=mc.height/(window.devicePixelRatio||1);
  var s=getComputedStyle(document.body);
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle=s.getPropertyValue('--bg').trim();ctx.fillRect(0,0,w,h);
  var visibleRange=visibleDuration();var vs=ox,ve=ox+visibleRange;
  drawGrid(w,h,vs,ve,s);
  drawZeroLines(w,h,s);
  if(showBB)drawBlockBounds(w,h,vs,ve,s);
  drawBlocks(vs,ve,s);
  drawDerivedChannels(vs,ve,s);
  drawAxes(w,h,vs,ve,s);
  lastDrawDurationMs=performance.now()-drawStarted;
  drawCursorOverlay();
}

/* ── Vertical cursor ──────────────────────────────────────────────────── */
function drawCursorOverlay(){
  viewerCursorDrawCount++;
  var dpr=window.devicePixelRatio||1,w=moc.width/dpr,h=moc.height/dpr;
  moctx.clearRect(0,0,w,h);
  if(!cursorActive)return;var cx=t2x(cursorT);
  if(cx<M.l||cx>w-M.r)return;
  var color=getComputedStyle(document.body).getPropertyValue('--cr').trim();
  moctx.strokeStyle=color;moctx.lineWidth=0.8;moctx.setLineDash([4,3]);
  moctx.beginPath();moctx.moveTo(cx,M.t);moctx.lineTo(cx,h-M.b);moctx.stroke();moctx.setLineDash([]);
  moctx.fillStyle=color;moctx.font='10px monospace';moctx.textAlign='center';
  var label=fmtT(timeConv(cursorT)),tw=moctx.measureText(label).width;
  moctx.fillText(label,Math.max(M.l+tw/2+4,Math.min(cx,w-M.r-tw/2-4)),M.t-1);
}

/* ── Zero lines & grid ────────────────────────────────────────────────── */
function drawZeroLines(w,h,s){
  ctx.strokeStyle=s.getPropertyValue('--gr').trim();ctx.lineWidth=0.4;ctx.setLineDash([2,4]);
  var vc=visChannels();for(var vi=0;vi<vc.length;vi++){var i=vc[vi];if((i>=2&&i<=4)||(i>=8&&i<=10)){ctx.beginPath();ctx.moveTo(M.l,cy(vi));ctx.lineTo(w-M.r,cy(vi));ctx.stroke();}}
  ctx.setLineDash([]);
}
function drawBlockBounds(w,h,vs,ve,s){
  ctx.strokeStyle=s.getPropertyValue('--ax').trim();ctx.lineWidth=0.6;ctx.setLineDash([3,6]);
  var range=visibleBlockRange(vs,ve);
  for(var i=range.start;i<range.end;i++){
    var x=t2x(BL[i].s);if(x<M.l||x>w-M.r)continue;
    ctx.beginPath();ctx.moveTo(x,M.t);ctx.lineTo(x,h-M.b);ctx.stroke();
    ctx.fillStyle=s.getPropertyValue('--ax').trim();ctx.font='9px monospace';ctx.textAlign='center';
    ctx.fillText('#'+BL[i].i,x,M.t-2);
  }
  ctx.setLineDash([]);
}
function drawGrid(w,h,vs,ve,s){
  ctx.strokeStyle=s.getPropertyValue('--gr').trim();ctx.lineWidth=0.5;
  var st=nice((ve-vs)/8),t=Math.floor(vs/st)*st;
  while(t<=ve){var x=t2x(t);if(x>=M.l){ctx.beginPath();ctx.moveTo(x,M.t);ctx.lineTo(x,h-M.b);ctx.stroke();}t+=st;}
  var ch=cH(),vc=visChannels();
  for(var i=0;i<=vc.length;i++){ctx.beginPath();ctx.moveTo(M.l,M.t+i*ch);ctx.lineTo(w-M.r,M.t+i*ch);ctx.stroke();}
}

function channelRange(ci){
  var z=ampZoom[ci]||1;
  if(ci===0)return Math.max((gMax[0]||1)*z,1e-9);
  if(ci===1)return Math.max(6.28318*z,1e-9);
  if(ci>=2&&ci<=4)return Math.max((gMax[ci]||1)*z,0.001);
  if(ci===7)return Math.max((gMax[7]||1)*z,0.001);
  if(ci>=8&&ci<=10)return Math.max((gMax[ci]||1)*z,1e-12);
  return 1;
}
function fmtPhase(v){if(Math.abs(v-6.28318)<1e-3)return'2\u03c0';if(Math.abs(v-3.14159)<1e-3)return'\u03c0';if(v>=1)return v.toFixed(2);if(v>=0.01)return v.toFixed(3);return v.toExponential(1);}
function rowClip(vi,ch,fn){
  var w=mc.width/(window.devicePixelRatio||1),top=M.t+vi*ch,bottom=M.t+(vi+1)*ch,rw=Math.max(0,w-M.l-M.r);
  if(rw<=0||bottom<=top)return;
  ctx.save();ctx.beginPath();ctx.rect(M.l,top,rw,bottom-top);ctx.clip();
  try{fn();}finally{ctx.restore();}
}

/* ── Axes (X time + Y per channel) ────────────────────────────────────── */
function drawAxes(w,h,vs,ve,s){
  var narrow=(typeof layoutMode!=='undefined'&&layoutMode==='vertical')||w<600;
  var axFont=narrow?'9px monospace':'10px monospace';
  var chFont=narrow?'bold 14px monospace':'bold 18px monospace';
  // X-axis
  ctx.fillStyle=s.getPropertyValue('--lb').trim();ctx.font=axFont;ctx.textAlign='center';
  ctx.strokeStyle=s.getPropertyValue('--ax').trim();ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(M.l,h-M.b);ctx.lineTo(w-M.r,h-M.b);ctx.stroke();
  var st=nice((ve-vs)/8),t=Math.floor(vs/st)*st;
  while(t<=ve){ctx.fillText(fmtT(timeConv(t)),t2x(t),h-M.b+14);t+=st;}
  ctx.textAlign='right';
  ctx.fillText('time ('+timeUnitStr()+')',w-4,h-M.b+4);

  // Y-axes — one per visible channel
  var vc=visChannels(),ch=cH();
  for(var vi=0;vi<vc.length;vi++){
    var ci=vc[vi],y0=cy(vi);
    // Channel label (bold, coloured) — left-aligned on narrow to avoid off-screen overflow
    if(narrow){
      ctx.textAlign='left';ctx.font=chFont;
      ctx.fillStyle=chColors[ci];ctx.fillText(CH[ci],4,y0+4);
    }else{
      ctx.textAlign='right';ctx.font=chFont;
      ctx.fillStyle=chColors[ci];ctx.fillText(CH[ci],M.l-40,y0+4);
    }
    // Tick values — left-aligned on narrow to stay within reduced margin
    ctx.fillStyle=s.getPropertyValue('--lb').trim();ctx.font=axFont;
    var lblX=narrow?4:M.l-12;
    ctx.textAlign=narrow?'left':'right';
    if(ci===0){ctx.fillText(fmtAmp(channelRange(0))+'Hz',lblX,M.t+vi*ch+12);ctx.fillText('0',lblX,y0+ch/2-2);}
    else if(ci===1){var ph=channelRange(1);ctx.fillText(fmtPhase(ph),lblX,M.t+vi*ch+12);ctx.fillText(fmtPhase(ph/2),lblX,y0+4);ctx.fillText('0',lblX,y0+ch/2-2);}
    else if(ci>=2&&ci<=4){var d=gradConv(channelRange(ci));ctx.fillText('\u00b1'+fmtAmp(d)+gradUnitStr(),lblX,M.t+vi*ch+12);ctx.fillText('0',lblX,y0+4);}
    else if(ci===5){ctx.fillText('on',lblX,M.t+vi*ch+12);}
    else if(ci===6){ctx.fillText('ch',lblX,M.t+vi*ch+12);}
    else if(ci===7){ctx.fillText(fmtAmp(channelRange(7))+'%',lblX,M.t+vi*ch+12);ctx.fillText('0',lblX,M.t+(vi+1)*ch-4);}
    else if(ci>=8&&ci<=10){ctx.fillText('\u00b1'+fmtAmp(channelRange(ci))+'s/m',lblX,M.t+vi*ch+12);ctx.fillText('0',lblX,y0+4);}

    // Small tick marks
    ctx.strokeStyle=s.getPropertyValue('--ax').trim();ctx.lineWidth=0.5;
    ctx.beginPath();ctx.moveTo(M.l-2,M.t+vi*ch);ctx.lineTo(M.l+2,M.t+vi*ch);ctx.stroke();
    ctx.beginPath();ctx.moveTo(M.l-2,y0);ctx.lineTo(M.l+2,y0);ctx.stroke();
    ctx.beginPath();ctx.moveTo(M.l-2,M.t+(vi+1)*ch);ctx.lineTo(M.l+2,M.t+(vi+1)*ch);ctx.stroke();
  }
}

/* ── Derived calculation overlays: PNS and M1 ────────────────────────── */
function drawDerivedChannels(vs,ve,s){
  var ch=cH(),vc=visChannels();
  var viP=-1,viM1x=-1,viM1y=-1,viM1z=-1;
  for(var vi=0;vi<vc.length;vi++){
    if(vc[vi]===7)viP=vi;if(vc[vi]===8)viM1x=vi;if(vc[vi]===9)viM1y=vi;if(vc[vi]===10)viM1z=vi;
  }
  var pnsDrawData=pnsSeriesForView(vs,ve);
  if(pnsDrawData&&viP>=0){
    drawPercentSeries(pnsDrawData.x,viP,7,s.getPropertyValue('--gx').trim(),ch,vs,ve);
    drawPercentSeries(pnsDrawData.y,viP,7,s.getPropertyValue('--gy').trim(),ch,vs,ve);
    drawPercentSeries(pnsDrawData.z,viP,7,s.getPropertyValue('--gz').trim(),ch,vs,ve);
    ctx.setLineDash([5,3]);
    drawPercentSeries(pnsDrawData.n,viP,7,s.getPropertyValue('--fg').trim(),ch,vs,ve);
    ctx.setLineDash([]);
  }
  var m1DrawData=m1SeriesForView(vs,ve);
  if(m1DrawData){
    if(viM1x>=0)drawBipolarSeries(m1DrawData.x,viM1x,8,s.getPropertyValue('--gx').trim(),ch,vs,ve);
    if(viM1y>=0)drawBipolarSeries(m1DrawData.y,viM1y,9,s.getPropertyValue('--gy').trim(),ch,vs,ve);
    if(viM1z>=0)drawBipolarSeries(m1DrawData.z,viM1z,10,s.getPropertyValue('--gz').trim(),ch,vs,ve);
  }
}

function groupEnvelopeRanges(ranges,maxGapPx){
  var groups=[],group=[];
  for(var i=0;i<ranges.length;i++){
    if(group.length&&ranges[i][0]-group[group.length-1][1]>maxGapPx){groups.push(group);group=[];}
    group.push(ranges[i]);
  }
  if(group.length)groups.push(group);return groups;
}

function drawStepEnvelopeGroups(groups,color,fillAlpha){
  for(var groupIndex=0;groupIndex<groups.length;groupIndex++){
    var ranges=groups[groupIndex];if(!ranges.length)continue;
    ctx.fillStyle=color;ctx.globalAlpha=fillAlpha;ctx.beginPath();ctx.moveTo(ranges[0][0],ranges[0][2]);
    for(var upperIndex=0;upperIndex<ranges.length;upperIndex++){ctx.lineTo(ranges[upperIndex][0],ranges[upperIndex][2]);ctx.lineTo(ranges[upperIndex][1],ranges[upperIndex][2]);}
    for(var lowerIndex=ranges.length-1;lowerIndex>=0;lowerIndex--){ctx.lineTo(ranges[lowerIndex][1],ranges[lowerIndex][3]);ctx.lineTo(ranges[lowerIndex][0],ranges[lowerIndex][3]);}
    ctx.closePath();ctx.fill();
    ctx.strokeStyle=color;ctx.lineWidth=.8;ctx.globalAlpha=.72;ctx.beginPath();ctx.moveTo(ranges[0][0],ranges[0][2]);
    for(var upper=0;upper<ranges.length;upper++){ctx.lineTo(ranges[upper][0],ranges[upper][2]);ctx.lineTo(ranges[upper][1],ranges[upper][2]);}ctx.stroke();
    ctx.globalAlpha=.38;ctx.beginPath();ctx.moveTo(ranges[0][0],ranges[0][3]);
    for(var lower=0;lower<ranges.length;lower++){ctx.lineTo(ranges[lower][0],ranges[lower][3]);ctx.lineTo(ranges[lower][1],ranges[lower][3]);}ctx.stroke();ctx.globalAlpha=1;
  }
}

function drawPercentSeries(series,vi,ci,c,ch,vs,ve){
  if(!series||series.n<(series.kind==='envelope'?1:2))return;
  rowClip(vi,ch,function(){
    var maxA=channelRange(ci),base=M.t+(vi+1)*ch-ch*.08,scale=ch*.84/maxA;
    var clipL=M.l,clipR=mc.width/(window.devicePixelRatio||1)-M.r;
    var plotW=Math.max(1,clipR-clipL);
    if(series.kind==='envelope'){
      derivedEnvelopeCurveCount++;
      var ranges=[];
      var count=forEachEnvelopeRange(series,vs,ve,Math.max(32,Math.ceil(plotW)),function(t0,t1,minValue,maxValue){
        var x0=t2x(t0),x1=t2x(t1),upper=base-maxValue*scale,lower=base-minValue*scale;
        if(isFinite(x0)&&isFinite(x1)&&isFinite(upper)&&isFinite(lower)&&x1>=clipL&&x0<=clipR)ranges.push([Math.max(clipL,x0),Math.min(clipR,x1),upper,lower]);
      });
      derivedRenderPointCount+=count*4;drawStepEnvelopeGroups(groupEnvelopeRanges(ranges,1),c,.12);return;
    }
    var rawLimit=Math.max(64,Math.ceil(plotW*2));
    var fineLimit=Math.max(128,Math.ceil(plotW*8));
    var windowRange=derivedSeriesWindow(series,vs,ve);
    var useFinePns=shouldUseFinePnsRendering(windowRange.count,plotW,vs,ve);
    ctx.strokeStyle=c;ctx.lineWidth=1;ctx.beginPath();
    if(windowRange.count<=rawLimit||useFinePns){
      derivedRawCurveCount++;
      var f=1;
      derivedRenderPointCount+=forEachDerivedPoint(series,vs,ve,useFinePns?fineLimit:rawLimit,function(tv,vv){
        var sx=t2x(tv);if(!isFinite(sx)||sx<clipL||sx>clipR){f=1;return}
        var sy=base-vv*scale;if(!isFinite(sy)){f=1;return}
        if(f){ctx.moveTo(sx,sy);f=0}else ctx.lineTo(sx,sy);
      });
    }else{
      derivedEnvelopeCurveCount++;
      var first=1;
      derivedRenderPointCount+=forEachDerivedRange(series,vs,ve,Math.max(32,Math.ceil(clipR-clipL)),function(tv,_minValue,maxValue){
        var sx=t2x(tv),sy=base-maxValue*scale;
        if(!isFinite(sx)||!isFinite(sy)||sx<clipL||sx>clipR){first=1;return}
        if(first){ctx.moveTo(sx,sy);first=0}else ctx.lineTo(sx,sy);
      });
    }
    ctx.stroke();
  });
}

function shouldUseFinePnsRendering(count,plotW,vs,ve){
  var dur=ve-vs;
  if(seqTiming&&seqTiming.trTimeSec>0&&dur<=seqTiming.trTimeSec*10.5)return true;
  return count<=Math.max(256,Math.ceil(plotW*12));
}

function drawBipolarSeries(series,vi,ci,c,ch,vs,ve){
  if(!series||series.n<(series.kind==='envelope'?1:2))return;
  rowClip(vi,ch,function(){
    var maxA=channelRange(ci),y=cy(vi),scale=ch*.4/maxA;
    var clipL=M.l,clipR=mc.width/(window.devicePixelRatio||1)-M.r;
    if(series.kind==='envelope'){
      derivedEnvelopeCurveCount++;
      var envelopeRanges=[];
      var envelopeCount=forEachEnvelopeRange(series,vs,ve,Math.max(32,Math.ceil(clipR-clipL)),function(t0,t1,minValue,maxValue){
        var x0=t2x(t0),x1=t2x(t1),upper=y-maxValue*scale,lower=y-minValue*scale;
        if(isFinite(x0)&&isFinite(x1)&&isFinite(upper)&&isFinite(lower)&&x1>=clipL&&x0<=clipR)envelopeRanges.push([Math.max(clipL,x0),Math.min(clipR,x1),upper,lower]);
      });
      derivedRenderPointCount+=envelopeCount*4;drawStepEnvelopeGroups(groupEnvelopeRanges(envelopeRanges,1),c,.14);return;
    }
    var rawLimit=Math.max(128,Math.ceil((clipR-clipL)*8));
    if(derivedSeriesWindow(series,vs,ve).count<=rawLimit){
      derivedRawCurveCount++;
      ctx.strokeStyle=c;ctx.lineWidth=1;ctx.beginPath();var f=1;
      derivedRenderPointCount+=forEachDerivedPoint(series,vs,ve,rawLimit,function(tv,vv){
        var sx=t2x(tv);if(!isFinite(sx)||sx<clipL||sx>clipR){f=1;return}
        var sy=y-vv*scale;if(!isFinite(sy)){f=1;return}
        if(f){ctx.moveTo(sx,sy);f=0}else ctx.lineTo(sx,sy);
      });
      ctx.stroke();
    }else{
      derivedEnvelopeCurveCount++;
      var ranges=[];
      var rangeCount=forEachDerivedRange(series,vs,ve,Math.max(32,Math.ceil(clipR-clipL)),function(tv,minValue,maxValue){
        var sx=t2x(tv),upper=y-maxValue*scale,lower=y-minValue*scale;
        if(isFinite(sx)&&isFinite(upper)&&isFinite(lower)&&sx>=clipL&&sx<=clipR)ranges.push([sx,upper,lower]);
      });
      derivedRenderPointCount+=rangeCount*2;
      if(ranges.length){
        ctx.fillStyle=c;ctx.globalAlpha=.14;ctx.beginPath();
        ctx.moveTo(ranges[0][0],ranges[0][1]);
        for(var ri=1;ri<ranges.length;ri++)ctx.lineTo(ranges[ri][0],ranges[ri][1]);
        for(var rj=ranges.length-1;rj>=0;rj--)ctx.lineTo(ranges[rj][0],ranges[rj][2]);
        ctx.closePath();ctx.fill();
        ctx.globalAlpha=.65;ctx.strokeStyle=c;ctx.lineWidth=.8;
        ctx.beginPath();ctx.moveTo(ranges[0][0],(ranges[0][1]+ranges[0][2])*.5);
        for(var rk=1;rk<ranges.length;rk++)ctx.lineTo(ranges[rk][0],(ranges[rk][1]+ranges[rk][2])*.5);
        ctx.stroke();ctx.globalAlpha=1;
      }
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   Block waveform rendering
   ═══════════════════════════════════════════════════════════════════════ */
function drawBlocks(vs,ve,s){
  var range=visibleBlockRange(vs,ve);if(range.start>=range.end)return;
  var ch=cH(),vc=visChannels(),rows=[-1,-1,-1,-1,-1,-1,-1];
  for(var vi=0;vi<vc.length;vi++)if(vc[vi]>=0&&vc[vi]<=6)rows[vc[vi]]=vi;
  var colors={
    rf:s.getPropertyValue('--rf').trim(),rff:s.getPropertyValue('--rff').trim(),
    gx:s.getPropertyValue('--gx').trim(),gy:s.getPropertyValue('--gy').trim(),gz:s.getPropertyValue('--gz').trim(),
    adc:s.getPropertyValue('--adc').trim(),adf:s.getPropertyValue('--adf').trim(),
    tr:s.getPropertyValue('--tr').trim(),fg:s.getPropertyValue('--fg').trim()
  };
  var pixelBudget=Math.max(1,Math.floor(plotWidth()));
  var overview=selectWaveformOverview(waveformOverview,range.start,range.end,pixelBudget);
  function useOverview(key){return !!overview&&waveformVisiblePointCount(waveformOverview,key,range.start,range.end)>pixelBudget;}
  function useGradientOverview(key){return !!overview&&waveformVisibleGradientPointCount(BL,key,range.start,range.end,vs,ve)>pixelBudget*8;}
  var rfPoints=waveformVisiblePointCount(waveformOverview,'rf',range.start,range.end),rfEvents=waveformVisiblePointCount(waveformOverview,'rfEvents',range.start,range.end);
  var aggregateRf=!!overview&&rfEvents>pixelBudget*2,reduceRf=aggregateRf||rfPoints>pixelBudget*8;
  var overviewUse={rf:reduceRf,phase:useOverview('phase'),gx:useGradientOverview('gx'),gy:useGradientOverview('gy'),gz:useGradientOverview('gz'),adc:useOverview('adc')};
  var dense=overviewUse.rf||overviewUse.phase||overviewUse.gx||overviewUse.gy||overviewUse.gz||overviewUse.adc;
  waveformOverviewActive=dense;
  setViewerNotice('dense',dense?'Dense overview mode is active. Zoom in for full waveform detail.':null);
  if(rows[0]>=0){if(aggregateRf)drawRfOverview(overview,rows[0],ch,colors,vs,ve);else drawRfBlocks(range.start,range.end,rows[0],ch,colors,vs,ve,pixelBudget*8);}
  if(rows[1]>=0){if(overviewUse.phase)drawPhaseSampled(range.start,range.end,rows[1],ch,colors,vs,ve,pixelBudget);else drawPhaseBlocks(range.start,range.end,rows[1],ch,colors,vs,ve);}
  if(rows[2]>=0){if(overviewUse.gx)drawGradientOverview(overview,'gx',rows[2],2,ch,colors.gx,vs,ve);else drawGradientBlocks(range.start,range.end,'gx',rows[2],2,ch,colors.gx,vs,ve);}
  if(rows[3]>=0){if(overviewUse.gy)drawGradientOverview(overview,'gy',rows[3],3,ch,colors.gy,vs,ve);else drawGradientBlocks(range.start,range.end,'gy',rows[3],3,ch,colors.gy,vs,ve);}
  if(rows[4]>=0){if(overviewUse.gz)drawGradientOverview(overview,'gz',rows[4],4,ch,colors.gz,vs,ve);else drawGradientBlocks(range.start,range.end,'gz',rows[4],4,ch,colors.gz,vs,ve);}
  if(rows[5]>=0){if(overviewUse.adc)drawAdcOverview(overview,rows[5],ch,colors,vs,ve);else drawAdcBlocks(range.start,range.end,rows[5],ch,colors,vs,ve);}
  if(rows[6]>=0&&range.end-range.start<=pixelBudget)drawTriggerBlocks(range.start,range.end,rows[6],ch,colors,vs,ve);
}

function drawRfOverview(summary,vi,ch,colors,vs,ve){
  var y=cy(vi),base=y+ch*.45,scale=ch*.9/channelRange(0),pixelCount=Math.max(1,Math.ceil(plotWidth()));
  var bins=binRfEvents(waveformOverview.rfEvents,vs,ve,pixelCount,2),series=waveformOverview.rfEvents;
  rowClip(vi,ch,function(){
    ctx.fillStyle=colors.rf;ctx.globalAlpha=.28;
    for(var bin=0;bin<bins.peak.length;bin++){
      if(bins.events[bin]<1||bins.peak[bin]<=0)continue;
      var mean=Math.min(bins.peak[bin],bins.area[bin]/bins.secondsPerPixel),x=t2x(vs+(bin+.5)*bins.secondsPerPixel);
      if(mean>0)ctx.fillRect(x-.5,base-mean*scale,1,Math.max(1,mean*scale));
    }
    ctx.globalAlpha=.75;ctx.strokeStyle=colors.rf;ctx.lineWidth=1.1;
    for(var peakBin=0;peakBin<bins.peak.length;peakBin++){
      if(bins.events[peakBin]<1||bins.peak[peakBin]<=0)continue;
      var leftX=t2x(bins.occupiedStart[peakBin]),rightX=t2x(bins.occupiedEnd[peakBin]),peakX=t2x(bins.peakTime[peakBin]);
      if(rightX-leftX<2){var centerX=(leftX+rightX)*.5;leftX=centerX-1;rightX=centerX+1;}
      peakX=Math.max(leftX+.25,Math.min(rightX-.25,peakX));
      ctx.beginPath();ctx.moveTo(leftX,base);ctx.lineTo(peakX,base-bins.peak[peakBin]*scale);ctx.lineTo(rightX,base);ctx.stroke();
      rfOverviewBucketCount++;rfRenderPointCount+=3;
    }
    ctx.globalAlpha=1;
    for(var wi=0;wi<bins.wide.length;wi++){
      var rf=series.waveforms[bins.wide[wi]],x0=t2x(Math.max(vs,rf.s)),x1=t2x(Math.min(ve,rf.s+rf.d));
      ctx.fillStyle=colors.rff;ctx.fillRect(x0,y-ch*.45,Math.max(1,x1-x0),ch*.9);
      var n=Math.min(rf.t?rf.t.length:0,rf.m?rf.m.length:0),pointBudget=Math.max(8,Math.ceil(Math.max(1,x1-x0)*4)),first=true;
      ctx.strokeStyle=colors.rf;ctx.lineWidth=1.1;ctx.beginPath();
      var emitted=rf.bp?appendBlockRfPath(rf,base,scale):forEachWaveformPoint(rf.t,rf.m,pointBudget,function(time,value){var sx=t2x(time),sy=base-value*scale;if(first){ctx.moveTo(sx,sy);first=false;}else ctx.lineTo(sx,sy);});
      if(emitted>1)ctx.stroke();rfRenderPointCount+=emitted;if(n<=pointBudget)rfRawCurveCount++;else rfReducedCurveCount++;
    }
  });
}

function appendBlockRfPath(rf,base,scale){
  var amplitude=isFinite(rf.pk)?rf.pk:(rf.m&&rf.m.length?Math.abs(rf.m[0]):0),top=base-amplitude*scale,x0=t2x(rf.s),x1=t2x(rf.s+rf.d);
  ctx.moveTo(x0,base);ctx.lineTo(x0,top);ctx.lineTo(x1,top);ctx.lineTo(x1,base);return 4;
}

function drawPhaseSampled(start,end,vi,ch,colors,vs,ve,maxPoints){
  var prefix=waveformOverview.pointPrefix.phase,first=prefix[start],last=prefix[end],count=last-first;
  if(count<=0)return;
  var y=cy(vi),scale=ch*.9/channelRange(1),sampleCount=Math.min(maxPoints,count),sampleStep=count/sampleCount;
  rowClip(vi,ch,function(){
    for(var sampleIndex=0;sampleIndex<sampleCount;sampleIndex++){
      var ordinal=Math.min(last-1,Math.floor(first+(sampleIndex+.5)*sampleStep)),lo=start,hi=end;
      while(lo<hi){var mid=(lo+hi)>>1;if(prefix[mid+1]<=ordinal)lo=mid+1;else hi=mid;}
      if(lo>=end)continue;
      var block=BL[lo],rf=block.rf,phaseTime=rf&&(rf.pt||rf.t),rfCount=phaseTime&&rf.p?Math.min(phaseTime.length,rf.p.length):0;
      var local=ordinal-prefix[lo],time=NaN,value=NaN,isAdc=false;
      if(local<rfCount){time=phaseTime[local];value=rf.p[local];}
      else if(block.adc&&block.adc.n>1){
        var adc=block.adc,adcStep=Math.max(1,Math.ceil(adc.n/200)),adcSample=(local-rfCount)*adcStep;
        var adcStart=adc.s+adc.d,adcEnd=adcStart+adc.n*adc.dw;
        time=adcSample<adc.n?adcStart+(adcSample+.5)*adc.dw:adcEnd;
        value=((adc.po||0)+6.283185*(adc.fo||0)*(time-adcStart))%6.28318;value=(value+6.28318)%6.28318;isAdc=true;
      }
      if(!isFinite(time)||!isFinite(value)||time<vs||time>ve)continue;
      ctx.fillStyle=isAdc?colors.adc:colors.rf;
      ctx.fillRect(t2x(time)-.5,y+ch*.45-value*scale-.5,1,1);
    }
  });
}

function drawGradientOverview(summary,key,vi,ci,ch,color,vs,ve){
  var level=summary.level,minValues=level[key+'Min'],maxValues=level[key+'Max'],startValues=level[key+'Start'],endValues=level[key+'End'],y=cy(vi),scale=ch*.4/channelRange(ci);
  rowClip(vi,ch,function(){
    var ranges=[];
    for(var i=summary.first;i<summary.last;i++){
      if(endValues[i]<vs||startValues[i]>ve||minValues[i]===Infinity)continue;
      var x0=t2x(Math.max(vs,startValues[i])),x1=t2x(Math.min(ve,endValues[i]));
      ranges.push([x0,x1,y-maxValues[i]*scale,y-minValues[i]*scale]);
    }
    drawStepEnvelopeGroups(groupEnvelopeRanges(ranges,1),color,.14);
  });
}

function drawAdcOverview(summary,vi,ch,colors,vs,ve){
  var level=summary.level,y=cy(vi);
  rowClip(vi,ch,function(){
    ctx.fillStyle=colors.adf;ctx.strokeStyle=colors.adc;ctx.lineWidth=1;ctx.beginPath();var hasRect=false;
    for(var i=summary.first;i<summary.last;i++){
      if(level.adcStart[i]===Infinity||level.adcEnd[i]<vs||level.adcStart[i]>ve)continue;
      var x0=t2x(Math.max(vs,level.adcStart[i])),x1=t2x(Math.min(ve,level.adcEnd[i]));
      ctx.rect(x0,y-ch*.28,Math.max(1,x1-x0),ch*.56);hasRect=true;
    }
    if(hasRect){ctx.fill();ctx.stroke();}
  });
}

function visibleBlockRange(vs,ve){
  var lo=0,hi=BL.length,mid;
  while(lo<hi){mid=(lo+hi)>>1;if(BL[mid].s+BL[mid].d<vs)lo=mid+1;else hi=mid;}
  var start=lo;hi=BL.length;
  while(lo<hi){mid=(lo+hi)>>1;if(BL[mid].s<=ve)lo=mid+1;else hi=mid;}
  return{start:Math.max(0,start-1),end:Math.min(BL.length,lo+1)};
}

function drawRfBlocks(start,end,vi,ch,colors,vs,ve,maxPoints){
  var y=cy(vi),scale=ch*.9/channelRange(0);
  rowClip(vi,ch,function(){
    var visibleEvents=[];
    for(var bi=start;bi<end;bi++){
      var rf=BL[bi].rf;if(!rf||rf.s+rf.d<vs||rf.s>ve)continue;
      visibleEvents.push(rf);
    }
    var pointBudget=Math.max(4,Math.floor((maxPoints||Infinity)/Math.max(1,visibleEvents.length)));
    ctx.strokeStyle=colors.rf;ctx.lineWidth=1.1;ctx.beginPath();var hasPath=false;
    for(var eventIndex=0;eventIndex<visibleEvents.length;eventIndex++){
      var rf=visibleEvents[eventIndex];
      var x0=t2x(rf.s),x1=t2x(rf.s+rf.d);
      ctx.fillStyle=colors.rff;ctx.fillRect(x0,y-ch*.45,x1-x0,ch*.9);
      if(!rf.t||!rf.m||rf.t.length<2)continue;
      var n=Math.min(rf.t.length,rf.m.length);
      var first=true,emitted=rf.bp?appendBlockRfPath(rf,y+ch*.45,scale):forEachWaveformPoint(rf.t,rf.m,pointBudget,function(time,value){
        var sx=t2x(time),sy=y+ch*.45-value*scale;if(first){ctx.moveTo(sx,sy);first=false;}else ctx.lineTo(sx,sy);
      });
      rfRenderPointCount+=emitted;if(n<=pointBudget)rfRawCurveCount++;else rfReducedCurveCount++;hasPath=hasPath||emitted>1;
    }
    if(hasPath)ctx.stroke();
  });
}

function drawPhaseBlocks(start,end,vi,ch,colors,vs,ve){
  var y=cy(vi),scale=ch*.9/channelRange(1);
  rowClip(vi,ch,function(){
    ctx.strokeStyle=colors.rf;ctx.lineWidth=.8;ctx.beginPath();var hasRf=false;
    for(var bi=start;bi<end;bi++){
      var rf=BL[bi].rf,phaseTime=rf&&(rf.pt||rf.t);if(!rf||!rf.p||!phaseTime||rf.s+rf.d<vs||rf.s>ve)continue;
      var n=Math.min(phaseTime.length,rf.p.length);
      for(var i=0;i<n;i++){
        var sx=t2x(phaseTime[i]),sy=y+ch*.45-rf.p[i]*scale;
        if(i===0)ctx.moveTo(sx,sy);else ctx.lineTo(sx,sy);
      }
      hasRf=hasRf||n>1;
    }
    if(hasRf)ctx.stroke();

    ctx.strokeStyle=colors.adc;ctx.lineWidth=.8;ctx.beginPath();var hasAdc=false;
    var clipL=M.l,clipR=mc.width/(window.devicePixelRatio||1)-M.r;
    for(var bj=start;bj<end;bj++){
      var adc=BL[bj].adc;if(!adc||adc.n<=1)continue;
      var t0=adc.s+adc.d,nAdc=adc.n,te=t0+nAdc*adc.dw;
      if(te<=vs||t0>=ve)continue;
      var step=Math.max(1,Math.ceil(nAdc/200)),first=true,fo=adc.fo||0,po=adc.po||0;
      for(var sample=0;sample<=nAdc;sample+=step){
        var t=(sample<nAdc)?t0+(sample+.5)*adc.dw:te;
        var phase=((po+6.283185*fo*(t-t0))%6.28318+6.28318)%6.28318;
        var x=t2x(t);if(x<clipL||x>clipR){first=true;continue;}
        var py=y+ch*.45-phase*scale;
        if(first){ctx.moveTo(x,py);first=false;}else ctx.lineTo(x,py);
        hasAdc=true;
      }
    }
    if(hasAdc)ctx.stroke();ctx.setLineDash([]);
  });
}

function drawGradientBlocks(start,end,key,vi,ci,ch,color,vs,ve){
  var y=cy(vi),scale=ch*.4/channelRange(ci);
  rowClip(vi,ch,function(){
    ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();var hasPath=false;
    for(var bi=start;bi<end;bi++){
      var g=BL[bi][key];if(!g||g.ty==='none'||!g.t||!g.w||g.t.length<2)continue;
      var n=Math.min(g.t.length,g.w.length);
      if(n<2)continue;
      if(g.t[n-1]<vs||g.t[0]>ve)continue;
      for(var i=0;i<n;i++){
        var sx=t2x(g.t[i]),sy=y-g.w[i]*scale;
        if(i===0)ctx.moveTo(sx,sy);else ctx.lineTo(sx,sy);
      }
      hasPath=true;
    }
    if(hasPath)ctx.stroke();
  });
}

function drawAdcBlocks(start,end,vi,ch,colors,vs,ve){
  var y=cy(vi),labels=[];
  rowClip(vi,ch,function(){
    ctx.beginPath();var hasRect=false;
    for(var bi=start;bi<end;bi++){
      var adc=BL[bi].adc;if(!adc)continue;
      var eventStart=adc.s+adc.d,eventEnd=eventStart+adc.n*adc.dw;
      if(eventEnd<=vs||eventStart>=ve)continue;
      var x0=t2x(Math.max(eventStart,vs)),x1=t2x(Math.min(eventEnd,ve));
      ctx.rect(x0,y-ch*.28,x1-x0,ch*.56);hasRect=true;
      if(x1-x0>30)labels.push({text:adc.n+'pts',x:(x0+x1)/2});
    }
    if(hasRect){ctx.fillStyle=colors.adf;ctx.fill();ctx.strokeStyle=colors.adc;ctx.lineWidth=1;ctx.stroke();}
    ctx.fillStyle=colors.fg;ctx.font='9px monospace';ctx.textAlign='center';
    for(var li=0;li<labels.length;li++)ctx.fillText(labels[li].text,labels[li].x,y+3);
  });
}

function drawTriggerBlocks(start,end,vi,ch,colors,vs,ve){
  var y=cy(vi),labels=[];
  rowClip(vi,ch,function(){
    ctx.fillStyle=colors.tr;ctx.beginPath();var hasTrigger=false;
    for(var bi=start;bi<end;bi++){
      var triggers=BL[bi].trg;if(!triggers)continue;
      for(var ti=0;ti<triggers.length;ti++){
        var tg=triggers[ti],eventStart=tg.s+tg.d,eventEnd=eventStart+tg.dr;
        if(eventEnd<vs||eventStart>ve)continue;
        var x=t2x((eventStart+eventEnd)/2);
        ctx.moveTo(x,y-ch*.05);ctx.lineTo(x-5,y+ch*.05);ctx.lineTo(x+5,y+ch*.05);ctx.closePath();
        labels.push({text:'ch'+tg.c,x:x});hasTrigger=true;
      }
    }
    if(hasTrigger)ctx.fill();ctx.font='8px monospace';ctx.textAlign='center';
    for(var li=0;li<labels.length;li++)ctx.fillText(labels[li].text,labels[li].x,y+ch*.28);
  });
}


/* ══ kspace.js ══ */
var kOpen=false, kView="3d";
var kSpaceTrajectoryDrawCount=0,kSpaceOverlayDrawCount=0;
var kCx=0, kCy=0, kCz=0, kScl=1;    // view center & zoom
var kAutoFit=true;
var kRotX=-0.5, kRotY=0.7;           // default 3D perspective
var kDragging=false, kDragPrev=null, kDragBtn=0;
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
  return true;
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
document.getElementById("kbtn").onclick=function(){
  if((!kAdc||!kAdc[0]||!kAdc[0].length)&&typeof showKspaceSafetyDialog==='function'&&showKspaceSafetyDialog())return;
  // Ensure layout class is in sync before toggling
  if(typeof refreshLayout==='function')refreshLayout();
  kOpen=!kOpen;
  var p=document.getElementById("right");
  if(kOpen){
    p.classList.add("open");
    if(typeof layoutMode!=='undefined'&&layoutMode==='vertical'){
      // In vertical mode, apply height via inline !important to match applyLayoutMode
      p.style.setProperty('height','300px','important');
      p.style.setProperty('width','100%','important');
    }else{
      p.style.width='500px';
    }
    this.textContent="K Space ✕";kAutoFit=true;
  }else{
    p.classList.remove("open");
    if(typeof layoutMode!=='undefined'&&layoutMode==='vertical'){
      p.style.setProperty('height','0','important');
    }else{
      p.style.width='';
    }
    this.textContent="K Space";
  }
  if(kOpen){requestAnimationFrame(function(){drawKs_init();});}
  else{requestAnimationFrame(function(){resizeKc();drawKs();});}
};
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
  if(!kDragging||!kDragPrev||!kOpen)return;
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
  drawKsFast();
});
window.addEventListener("mouseup",function(){kDragging=false;kDragPrev=null;});

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
  if(!_kTouchActive||!_kTouchPrev||!kOpen)return;
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
  if(e.touches.length===1){
    // Transition from 2‑finger to 1‑finger
    _kTouchActive=true;_kTouchBtn=0;
    _kTouchPrev={x:e.touches[0].clientX,y:e.touches[0].clientY};
  }
});
kCanvas.addEventListener("touchcancel",function(){
  _kTouchActive=false;_kTouchPrev=null;_kTouchPinch0=0;_kTouchMid=null;
});

/* ── Resize handle ───────────────────────────────────────────────────── */
var kResizing=false, kResizeStart=0, kResizeW=500, kResizeH=300;
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
  if(!kResizing)return;
  var p=document.getElementById("right");
  var vertical=(typeof layoutMode!=='undefined'&&layoutMode==='vertical');
  if(vertical){
    kResizeH=Math.max(120,Math.min(800,kResizeH-(e.clientY-kResizeStart)));
    kResizeStart=e.clientY;
    p.style.setProperty('height',kResizeH+'px','important');p.style.setProperty('transition','none','important');
  }else{
    kResizeW=Math.max(200,Math.min(1200,kResizeW-(e.clientX-kResizeStart)));
    kResizeStart=e.clientX;
    p.style.width=kResizeW+"px";p.style.transition="none";
  }
  resizeKc();drawKs();
});
window.addEventListener("touchmove",function(e){
  if(!kResizing||e.touches.length!==1)return;
  var p=document.getElementById("right");
  var vertical=(typeof layoutMode!=='undefined'&&layoutMode==='vertical');
  if(vertical){
    kResizeH=Math.max(120,Math.min(800,kResizeH-(e.touches[0].clientY-kResizeStart)));
    kResizeStart=e.touches[0].clientY;
    p.style.setProperty('height',kResizeH+'px','important');p.style.setProperty('transition','none','important');
  }else{
    kResizeW=Math.max(200,Math.min(1200,kResizeW-(e.touches[0].clientX-kResizeStart)));
    kResizeStart=e.touches[0].clientX;
    p.style.width=kResizeW+"px";p.style.transition="none";
  }
  resizeKc();drawKs();
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

    gl.bindBuffer(gl.ARRAY_BUFFER,glBuf);
    gl.enableVertexAttribArray(glAttribPos);
    gl.vertexAttribPointer(glAttribPos,3,gl.FLOAT,false,16,0);
    gl.enableVertexAttribArray(glAttribTime);
    gl.vertexAttribPointer(glAttribTime,1,gl.FLOAT,false,16,12);

    kSpaceTrajectoryDrawCount++;
    gl.drawArrays(gl.POINTS,0,glN);
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


/* ══ interaction.js ══ */
/* ═══════════════════════════════════════════════════════════════════════
   Mouse interaction
   ═══════════════════════════════════════════════════════════════════════ */

var _touchTooltipTimer=null,_pointerFrame=0,_pendingPointer=null,mmDrag=false;

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

