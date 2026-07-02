/**
 * webview/js_interaction.ts — JavaScript mouse, wheel & toolbar handlers.
 *
 * Contains:
 *   • Mouse wheel (time zoom + Y‑axis amplitude zoom)
 *   • Drag‑to‑pan
 *   • Hover cursor + tooltip
 *   • Toolbar button handlers
 *   • Helper functions (fit, nice, fmtT, fmtAmp, fmtG)
 *   • MutationObserver for theme changes
 *   • Initial resize trigger
 *   • IIFE closing
 */

export const JS_INTERACTION = `
/* ═══════════════════════════════════════════════════════════════════════
   Mouse interaction
   ═══════════════════════════════════════════════════════════════════════ */
mc.addEventListener('wheel',function(e){e.preventDefault();
  if(e.ctrlKey||e.metaKey){
    // Y-axis amplitude zoom
    var ch=cH(),vc=visChannels(),my=e.clientY-mc.getBoundingClientRect().top;
    var vi2=Math.floor((my-M.t)/ch);
    if(vi2>=0&&vi2<vc.length){var ci=vc[vi2];ampZoom[ci]*=e.deltaY<0?1.3:1/1.3;ampZoom[ci]=Math.max(0.1,Math.min(100,ampZoom[ci]));}
  }else{
    // Time axis zoom
    var r=mc.getBoundingClientRect(),mx2=e.clientX-r.left,tm=x2t(mx2);
    var zf=e.deltaY<0?1.3:1/1.3;sc*=zf;sc=Math.max(50/(TD||1e-3),Math.min(sc,1e7));
    ox=tm-(mx2-M.l)/sc;ox=Math.max(0,Math.min(ox,TD));
  }
  draw();},{passive:false});
mc.addEventListener('mousedown',function(e){if(e.button===0){dr=true;dsx=e.clientX;dso=ox;cc.classList.add('pan')}});
window.addEventListener('mousemove',function(e){
  var r=mc.getBoundingClientRect(),mx2=e.clientX-r.left,my=e.clientY-r.top;cursorT=x2t(mx2);
  curEl.textContent=fmtT(timeConv(cursorT))+' '+timeUnitStr();
  if(dr){ox=dso-(e.clientX-dsx)/sc;ox=Math.max(0,Math.min(ox,TD));draw();return}
  draw();
  // Tooltip
  var ch=cH(),vc=visChannels(),vi2=Math.floor((my-M.t)/ch);
  if(vi2>=0&&vi2<vc.length&&mx2>=M.l){
    var found=null;for(var i=0;i<BL.length;i++){if(cursorT>=BL[i].s&&cursorT<=BL[i].s+BL[i].d){found=BL[i];break}}
    if(found){
      var lines=['Block #'+found.i,'Time: '+fmtT(timeConv(found.s))+' '+timeUnitStr()+' (dur: '+fmtT(timeConv(found.d))+' '+timeUnitStr()+')'];
      if(found.rf){lines.push('RF: '+(found.rf.a||0).toFixed(1)+' Hz  fo='+(found.rf.fo||0).toFixed(0)+' Hz  \\u03c6\\u2080='+((found.rf.po||0)%6.283).toFixed(2)+' rad');}
      if(found.gx&&found.gx.ty!=='none')lines.push('Gx: '+fmtG(found.gx));
      if(found.gy&&found.gy.ty!=='none')lines.push('Gy: '+fmtG(found.gy));
      if(found.gz&&found.gz.ty!=='none')lines.push('Gz: '+fmtG(found.gz));
      if(found.adc){lines.push('ADC: '+found.adc.n+'pts @'+(found.adc.dw*1e6).toFixed(1)+'\\u00b5s  fo='+(found.adc.fo||0).toFixed(0)+' Hz  \\u03c6\\u2080='+((found.adc.po||0)%6.283).toFixed(2)+' rad');}
      if(found.trg)lines.push('Trig: ch'+found.trg.map(function(x){return x.c}).join(',')+' \\u0394'+found.trg.map(function(x){return fmtT(timeConv(x.dr))+' '+timeUnitStr()}).join(','));
      tt.textContent=lines.join('\\n');tt.style.display='block';
      tt.style.left=Math.min(e.clientX+15,window.innerWidth-350)+'px';tt.style.top=(e.clientY-10)+'px';
    }else{tt.style.display='none'}
  }else{tt.style.display='none'}
});
window.addEventListener('mouseup',function(){dr=false;cc.classList.remove('pan')});
cc.addEventListener('mouseleave',function(){cursorT=0;curEl.textContent='\\u2190 hover for time';draw()});

/* ── Toolbar buttons ──────────────────────────────────────────────────── */
document.getElementById('zi').onclick=function(){sc*=1.5;draw()};
document.getElementById('zo').onclick=function(){sc/=1.5;sc=Math.max(50/(TD||1e-3),sc);draw()};
document.getElementById('zf').onclick=fit;document.getElementById('zr').onclick=fit;
document.getElementById('bbc').onchange=function(){showBB=this.checked;draw();};

/* ── Helpers ──────────────────────────────────────────────────────────── */
function fit(){var w=mc.width/(window.devicePixelRatio||1);sc=(w-M.l-M.r)/(TD||1e-3);ox=0;draw()}
function nice(r){var ms=[1,2,5,10,20,50,100,200,500,1000,2000,5000,10000,20000,50000];
  for(var i=0;i<ms.length;i++){var b=Math.pow(10,Math.floor(Math.log10(r)));if(ms[i]*b>=r)return ms[i]*b}return 1000*Math.pow(10,Math.floor(Math.log10(r)))}
function fmtT(v){if(v>=1)return v.toFixed(3);if(v>=0.001)return v.toFixed(3);return v.toExponential(2)}
function fmtAmp(v){if(v>=1e6)return(v/1e6).toFixed(1)+'M';if(v>=1e3)return(v/1e3).toFixed(1)+'k';if(v>=1)return v.toFixed(1);return v.toFixed(2)}
function fmtG(g){var a=gradConv(g.a||0);return a.toFixed(1)+' '+gradUnitStr()+' ('+g.ty+')';}
new MutationObserver(function(){draw()}).observe(document.body,{attributes:true,attributeFilter:['class']});
rs();
})();
`;
