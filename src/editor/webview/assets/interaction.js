/* ═══════════════════════════════════════════════════════════════════════
   Mouse interaction
   ═══════════════════════════════════════════════════════════════════════ */
mc.addEventListener('wheel',function(e){e.preventDefault();
  if(e.ctrlKey||e.metaKey){
    var ch=cH(),vc=visChannels(),my=e.clientY-mc.getBoundingClientRect().top;
    var vi2=Math.floor((my-M.t)/ch);
    if(vi2>=0&&vi2<vc.length){var ci=vc[vi2];ampZoom[ci]*=e.deltaY<0?1.3:1/1.3;ampZoom[ci]=Math.max(0.1,Math.min(100,ampZoom[ci]));}
  }else{
    var r=mc.getBoundingClientRect(),mx2=e.clientX-r.left;
    var zf=e.deltaY<0?1.3:1/1.3;zoomAt(mx2,zf);
  }
  draw();drawMinimap();},{passive:false});
mc.addEventListener('mousedown',function(e){if(e.button===0){dr=true;dsx=e.clientX;dso=ox;cc.classList.add('pan')}});
window.addEventListener('mousemove',function(e){
  var r=mc.getBoundingClientRect(),mx2=e.clientX-r.left,my=e.clientY-r.top;cursorT=x2t(mx2);cursorActive=mx2>=M.l&&mx2<=r.width-M.r&&my>=M.t&&my<=r.height-M.b;
  var kInfo=(typeof formatKCursorReadout==='function')?formatKCursorReadout():'';
  curEl.textContent=fmtT(timeConv(cursorT))+' '+timeUnitStr()+(kInfo?' | '+kInfo:'');
  if(dr){ox=dso-(e.clientX-dsx)/sc;clampView();draw();drawMinimap();return}
  draw();
  // Tooltip
  var ch=cH(),vc=visChannels(),vi2=Math.floor((my-M.t)/ch);
  if(vi2>=0&&vi2<vc.length&&mx2>=M.l){
    var found=null;for(var i=0;i<BL.length;i++){if(cursorT>=BL[i].s&&cursorT<=BL[i].s+BL[i].d){found=BL[i];break}}
    if(found){
      var blockDt=Math.max(0,Math.min(found.d,cursorT-found.s));
      var lines=['Block #'+found.i,'Time: '+fmtT(timeConv(cursorT))+' '+timeUnitStr()+' (\u0394 '+fmtT(timeConv(blockDt))+' / dur: '+fmtT(timeConv(found.d))+' '+timeUnitStr()+')'];
      if(found.rf){lines.push('RF: '+(found.rf.a||0).toFixed(1)+' Hz  fo='+(found.rf.fo||0).toFixed(0)+' Hz  \u03c6\u2080='+((found.rf.po||0)%6.283).toFixed(2)+' rad');}
      if(found.gx&&found.gx.ty!=='none')lines.push('Gx: '+fmtG(found.gx,cursorT));
      if(found.gy&&found.gy.ty!=='none')lines.push('Gy: '+fmtG(found.gy,cursorT));
      if(found.gz&&found.gz.ty!=='none')lines.push('Gz: '+fmtG(found.gz,cursorT));
      if(found.adc){lines.push('ADC: '+found.adc.n+'pts @'+(found.adc.dw*1e6).toFixed(1)+'\u00b5s  fo='+(found.adc.fo||0).toFixed(0)+' Hz  \u03c6\u2080='+((found.adc.po||0)%6.283).toFixed(2)+' rad');}
      if(found.trg)lines.push('Trig: ch'+found.trg.map(function(x){return x.c}).join(',')+' \u0394'+found.trg.map(function(x){return fmtT(timeConv(x.dr))+' '+timeUnitStr()}).join(','));
      tt.textContent=lines.join('\n');tt.style.display='block';
      tt.style.left=Math.min(e.clientX+15,window.innerWidth-350)+'px';tt.style.top=(e.clientY-10)+'px';
    }else{tt.style.display='none'}
  }else{tt.style.display='none'}
});
window.addEventListener('mouseup',function(){dr=false;cc.classList.remove('pan');drawMinimap();});
cc.addEventListener('mouseleave',function(){cursorT=0;cursorActive=false;curEl.textContent='\u2190 hover for time';draw();drawMinimap();});

/* ── Toolbar buttons ──────────────────────────────────────────────────── */
document.getElementById('openBtn').onclick=function(){
  if(vscApi){vscApi.postMessage({command:'openFile'});}
  else{var fi=document.getElementById('fileInput');if(fi)fi.click();}
};
document.getElementById('exportKspaceBtn').onclick=function(){
  if(vscApi){vscApi.postMessage({command:'exportKspace'});}
};
document.getElementById('m1Btn').onclick=function(){
  if(m1Busy)return;
  if(m1Data){chVis[8]=!chVis[8];chVis[9]=chVis[8];chVis[10]=chVis[8];buildLegend();draw();return;}
  m1Busy=true;if(m1Btn)m1Btn.disabled=true;
  if(vscApi){vscApi.postMessage({command:'calculateM1'});}
};
document.getElementById('pnsBtn').onclick=function(){
  if(pnsBusy)return;
  if(pnsData){chVis[7]=!chVis[7];buildLegend();draw();return;}
  pnsBusy=true;if(pnsBtn)pnsBtn.disabled=true;
  if(vscApi){vscApi.postMessage({command:'openPnsAsc'});}
};
document.getElementById('zi').onclick=function(){zoomAtCenter(1.5);draw();drawMinimap();};
document.getElementById('zo').onclick=function(){zoomAtCenter(1/1.5);draw();drawMinimap();};
document.getElementById('zf').onclick=function(){fit();drawMinimap();};
document.getElementById('zr').onclick=function(){fit();drawMinimap();};
document.getElementById('bbc').onchange=function(){showBB=this.checked;draw();};

/* ── Minimap interaction ──────────────────────────────────────────────── */
mmCanvas.addEventListener('mousedown',function(e){
  mmDrag=true;scrollMinimapToMouse(e);e.preventDefault();
});
window.addEventListener('mousemove',function(e){
  if(!mmDrag)return;
  scrollMinimapToMouse(e);
});
window.addEventListener('mouseup',function(){mmDrag=false;});
mmCanvas.addEventListener('wheel',function(e){
  e.preventDefault();
  var zf=e.deltaY<0?1.3:1/1.3;zoomAtCenter(zf);
  draw();drawMinimap();
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
