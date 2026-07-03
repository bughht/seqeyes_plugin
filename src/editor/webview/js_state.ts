/**
 * webview/js_state.ts — JavaScript state, configuration, helpers & setup.
 *
 * This string contains the first part of the webview's inline <script>:
 *   • DOM element references
 *   • Application state variables
 *   • Unit conversion helpers
 *   • Legend builder
 *   • postMessage data reception
 *   • Global amplitude range computation
 *   • Canvas resize handler
 *   • Coordinate mapping utilities
 */

export const JS_STATE = `
/* ═══════════════════════════════════════════════════════════════════════
   Application state & configuration
   ═══════════════════════════════════════════════════════════════════════ */
(function(){
var cc=document.getElementById('cc'),mc=document.getElementById('mc'),ctx=mc.getContext('2d'),
 tt=document.getElementById('tt'),curEl=document.getElementById('cur'),legend=document.getElementById('legend'),
 tuSel=document.getElementById('tu'),guSel=document.getElementById('gu');
var BL=[],TD=0,GR=1e-5;              // blocks, total duration, gradient raster [s]
var M={t:8,r:30,b:22,l:92};                // margins
var CH=['RF','\\u03c6','Gx','Gy','Gz','ADC','Trig']; // 7 channels
var chColors=['var(--rf)','var(--rf)','var(--gx)','var(--gy)','var(--gz)','var(--adc)','var(--tr)'];
var chVis=[true,true,true,true,true,true,true];                   // visibility toggles
var gMax=[1,6.28318,1,1,1,0,0];          // global max per channel
var ox=0,sc=1;                             // view offset [s] & scale [px/s]
var dr=false,dsx=0,dso=0;                  // drag state
var cursorT=0;                              // mouse time position
var timeUnit='ms',gradUnit='Hz/m';          // display unit selections
var showBB=false;                            // show block boundaries (default off)
var GAMMA=42576;                            // Hz/m per mT/m for 1H

var ampZoom=[1,1,1,1,1,1,1];
/* K‑space data — pre‑computed on the extension side */
var kTraj=null,kAdc=null,kTime=null,kAdcTime=null;

/* VS Code API — acquired once, used for postMessage to extension host */
var vscApi=(typeof acquireVsCodeApi!=='undefined')?acquireVsCodeApi():null;

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
    d.onclick=function(){
      chVis[i]=!chVis[i];
      buildLegend();computeGlobalMax();draw();
    };
    legend.appendChild(d);
  });
}
buildLegend();
tuSel.onchange=function(){timeUnit=tuSel.value;draw();};
guSel.onchange=function(){gradUnit=guSel.value;draw();};

/* ── Data reception ───────────────────────────────────────────────────── */
window.addEventListener('message',function(e){
  var m=e.data;if(m.type==='sequenceData'){
    BL=m.blocks||[];TD=m.totalDuration||0;GR=m.gradRaster||1e-5;
    // Decode binary k‑space ADC data (Float32 base64 → typed arrays)
    if(m.kspace){
      kTraj=[m.kspace.kx,m.kspace.ky,m.kspace.kz];kTime=m.kspace.tk;
      var n=m.kspace.nAdc||0;
      if(n>0&&m.kspace.axb){
        kAdc=[decodeB64F32(m.kspace.axb,n),decodeB64F32(m.kspace.ayb,n),decodeB64F32(m.kspace.azb,n)];
        kAdcTime=decodeB64F32(m.kspace.tab,n);
        uploadKSpaceGPU();  // send to WebGL buffers
      }
    }
    computeGlobalMax();fit();draw();drawKs();
  }
});

/* ── Base64 → Float32Array decoder ─────────────────────────────────── */
function decodeB64F32(b64,n){var bin=atob(b64),len=bin.length,b=new Uint8Array(len);for(var i=0;i<len;i++)b[i]=bin.charCodeAt(i);return new Float32Array(b.buffer,0,n);}


/* ── Global amplitude ranges ──────────────────────────────────────────── */
function computeGlobalMax(){
  gMax=[0.001,6.28318,0.001,0.001,0.001,1,1,0.001,0.001];
  for(var i=0;i<BL.length;i++){var b=BL[i];
    if(b.rf){var a=Math.abs(b.rf.a||0);if(a>gMax[0])gMax[0]=a;}
    if(b.gx&&b.gx.ty!=='none'&&Math.abs(b.gx.a||0)>gMax[2])gMax[2]=Math.abs(b.gx.a);
    if(b.gy&&b.gy.ty!=='none'&&Math.abs(b.gy.a||0)>gMax[3])gMax[3]=Math.abs(b.gy.a);
    if(b.gz&&b.gz.ty!=='none'&&Math.abs(b.gz.a||0)>gMax[4])gMax[4]=Math.abs(b.gz.a);
  }
  gMax[0]=Math.max(gMax[0],100);
}

/* ── Canvas resize ────────────────────────────────────────────────────── */
function rs(){
  var dpr=window.devicePixelRatio||1,r=cc.getBoundingClientRect();
  mc.width=r.width*dpr;mc.height=r.height*dpr;
  mc.style.width=r.width+'px';mc.style.height=r.height+'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);draw();
}
window.addEventListener('resize',rs);new ResizeObserver(rs).observe(cc);

/* ── Coordinate mapping ───────────────────────────────────────────────── */
function visChannels(){var v=[];for(var i=0;i<CH.length;i++)if(chVis[i])v.push(i);return v;}
function cy(vi){var vc=visChannels(),h=(mc.height/(window.devicePixelRatio||1)-M.t-M.b)/Math.max(vc.length,1);return M.t+vi*h+h/2;}
function cH(){var vc=visChannels();return(mc.height/(window.devicePixelRatio||1)-M.t-M.b)/Math.max(vc.length,1);}
function t2x(t){return M.l+(t-ox)*sc}
function x2t(x){return ox+(x-M.l)/sc}
`;
