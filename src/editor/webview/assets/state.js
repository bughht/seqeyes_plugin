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
  try{return normalizeM1ReferenceMode(localStorage.getItem('seqeyes.m1ReferenceMode'));}catch(_){return 'rfCenter';}
}
function writeM1ReferenceMode(mode){
  try{localStorage.setItem('seqeyes.m1ReferenceMode',mode);}catch(_){}
}
function setM1ReferenceMode(mode){
  var next=normalizeM1ReferenceMode(mode);
  if(next===m1ReferenceMode)return m1ReferenceMode;
  var restore=[!!chVis[8],!!chVis[9],!!chVis[10]];
  var shouldRecalc=!!m1Data&&(chVis[8]||chVis[9]||chVis[10]);
  m1ReferenceMode=next;writeM1ReferenceMode(next);
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
