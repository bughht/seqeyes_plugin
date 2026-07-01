/**
 * Webview HTML for SeqEyes — interactive Pulseq sequence visualization.
 * Features: toggle channels, y-axis units, unit switchers, vertical cursor,
 *           trigger arrows, ADC phase, frequency-modulated RF phase.
 */
export function getWebviewContent(_hint: number): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>SeqEyes</title><style>
:root{--bg:#fff;--fg:#222;--gr:#ddd;--rf:#e6194b;--rff:rgba(230,25,75,.07);--gx:#3cb44b;--gy:#4363d8;--gz:#f58231;--adc:#42d4f4;--adf:rgba(66,212,244,.14);--tr:#911eb4;--ax:#aaa;--lb:#888;--cr:#ee0000}
body.vscode-dark{--bg:#1e1e1e;--fg:#ddd;--gr:#3a3a3a;--rf:#ff6b8a;--rff:rgba(255,107,138,.05);--gx:#5cdb5c;--gy:#6b8cff;--gz:#ffb347;--adc:#5ce1f4;--adf:rgba(92,225,244,.10);--tr:#d45cff;--ax:#666;--lb:#999;--cr:#ff4444}
*{margin:0;padding:0;box-sizing:border-box}
body{font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--fg);overflow:hidden;height:100vh;user-select:none;display:flex;flex-direction:column}
#tb{display:flex;align-items:center;gap:6px;padding:5px 10px;background:var(--bg);border-bottom:1px solid var(--gr);font-size:11px;flex-shrink:0;flex-wrap:wrap}
#tb button{background:var(--gr);border:1px solid var(--ax);color:var(--fg);padding:2px 7px;border-radius:3px;cursor:pointer;font-size:11px}
#tb button:hover{opacity:.75}
#tb select{background:var(--gr);border:1px solid var(--ax);color:var(--fg);padding:2px 4px;border-radius:3px;font-size:11px;cursor:pointer}
#tb .sep{width:1px;height:16px;background:var(--ax);margin:0 3px}
#tb .lg{display:flex;gap:7px;align-items:center;font-size:11px}
#tb .li{cursor:pointer;display:flex;align-items:center;gap:3px;padding:1px 4px;border-radius:3px;opacity:1;transition:opacity .15s}
#tb .li.off{opacity:.30}
#tb .ld{width:10px;height:10px;border-radius:2px;border:1px solid rgba(0,0,0,.15)}
#tb .cur{font:11px monospace;color:var(--cr);margin-left:auto;min-width:180px;text-align:right}
#tb .ulbl{font-size:10px;color:var(--lb);margin:0 1px}
#cc{flex:1;overflow:hidden;position:relative;cursor:crosshair}
#cc.pan{cursor:grabbing}
canvas{display:block}
#tt{position:absolute;pointer-events:none;background:rgba(0,0,0,.88);color:#fff;padding:5px 9px;border-radius:4px;font:11px monospace;white-space:pre;display:none;z-index:100;line-height:1.35;max-width:340px}
</style></head><body>
<div id="tb">
<button id="zi" title="Zoom In (scroll wheel)">+</button>
<button id="zo" title="Zoom Out">\u2212</button>
<button id="zf" title="Fit All">Fit</button>
<button id="zr" title="Reset">\u21BA</button><div class="sep"></div>
<span class="ulbl">Time:</span>
<select id="tu" title="Time unit"><option value="s">s</option><option value="ms" selected>ms</option><option value="us">\u00b5s</option></select>
<span class="ulbl">Grad:</span>
<select id="gu" title="Gradient unit"><option value="Hz/m" selected>Hz/m</option><option value="mT/m">mT/m</option><option value="G/cm">G/cm</option></select>
<div class="sep"></div>
<div class="lg" id="legend"></div>
<span class="cur" id="cur">\u2190 hover for time</span>
</div><div id="cc"><canvas id="mc"></canvas><div id="tt"></div></div>
<script>
(function(){
var cc=document.getElementById('cc'),mc=document.getElementById('mc'),ctx=mc.getContext('2d'),
 tt=document.getElementById('tt'),curEl=document.getElementById('cur'),legend=document.getElementById('legend'),
 tuSel=document.getElementById('tu'),guSel=document.getElementById('gu');
var BL=[],TD=0;
var M={t:8,r:30,b:22,l:92};
var CH=['RF','\u03c6','Gx','Gy','Gz','ADC','Trig'];
var chColors=['var(--rf)','var(--rf)','var(--gx)','var(--gy)','var(--gz)','var(--adc)','var(--tr)'];
var chVis=[true,true,true,true,true,true,true];
var gMax=[1,6.28318,1,1,1,0,0]; // in native units (Hz, rad, Hz/m)
var ox=0,sc=1,dr=false,dsx=0,dso=0,mx=0,my=0,cursorT=0;
var timeUnit='ms',gradUnit='Hz/m'; // default
var GAMMA=42576; // Hz/m per mT/m for 1H

// Gradient conversion: native Hz/m → display unit
function gradConv(v){if(gradUnit==='mT/m')return v/GAMMA;if(gradUnit==='G/cm')return v/(GAMMA*10);return v;}
function gradUnitStr(){return gradUnit;}
// Time conversion: native s → display
function timeConv(t){if(timeUnit==='ms')return t*1e3;if(timeUnit==='us')return t*1e6;return t;}
function timeUnitStr(){return timeUnit;}

// Build legend
chColors.forEach(function(c,i){
  var d=document.createElement('div');d.className='li'+(chVis[i]?'':' off');d.title='Toggle '+CH[i];
  d.innerHTML='<div class="ld" style="background:'+c+'"></div>'+CH[i];
  d.onclick=function(){chVis[i]=!chVis[i];d.className='li'+(chVis[i]?'':' off');computeGlobalMax();draw();};
  legend.appendChild(d);
});

// Unit switchers
tuSel.onchange=function(){timeUnit=tuSel.value;draw();};
guSel.onchange=function(){gradUnit=guSel.value;draw();};

window.addEventListener('message',function(e){
  var m=e.data;
  if(m.type==='sequenceData'){BL=m.blocks||[];TD=m.totalDuration||0;computeGlobalMax();fit();draw();}
});

function computeGlobalMax(){
  gMax=[0.001,6.28318,0.001,0.001,0.001,1,1];
  for(var i=0;i<BL.length;i++){var b=BL[i];
    if(b.rf){var a=Math.abs(b.rf.a||0);if(a>gMax[0])gMax[0]=a;}
    if(b.gx&&b.gx.ty!=='none'&&Math.abs(b.gx.a||0)>gMax[2])gMax[2]=Math.abs(b.gx.a);
    if(b.gy&&b.gy.ty!=='none'&&Math.abs(b.gy.a||0)>gMax[3])gMax[3]=Math.abs(b.gy.a);
    if(b.gz&&b.gz.ty!=='none'&&Math.abs(b.gz.a||0)>gMax[4])gMax[4]=Math.abs(b.gz.a);
  }
  gMax[0]=Math.max(gMax[0],100);
}

function rs(){
  var dpr=window.devicePixelRatio||1,r=cc.getBoundingClientRect();
  mc.width=r.width*dpr;mc.height=r.height*dpr;
  mc.style.width=r.width+'px';mc.style.height=r.height+'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);draw();
}
window.addEventListener('resize',rs);new ResizeObserver(rs).observe(cc);

function visChannels(){var v=[];for(var i=0;i<CH.length;i++)if(chVis[i])v.push(i);return v;}
function cy(vi){var vc=visChannels(),h=(mc.height/(window.devicePixelRatio||1)-M.t-M.b)/Math.max(vc.length,1);return M.t+vi*h+h/2;}
function cH(){var vc=visChannels();return(mc.height/(window.devicePixelRatio||1)-M.t-M.b)/Math.max(vc.length,1);}
function t2x(t){return M.l+(t-ox)*sc}
function x2t(x){return ox+(x-M.l)/sc}

function draw(){
  var w=mc.width/(window.devicePixelRatio||1),h=mc.height/(window.devicePixelRatio||1);
  var s=getComputedStyle(document.body);
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle=s.getPropertyValue('--bg').trim();ctx.fillRect(0,0,w,h);
  var vs=ox,ve=ox+(w-M.l-M.r)/sc;
  drawGrid(w,h,vs,ve,s);
  drawZeroLines(w,h,s);
  drawBlocks(vs,ve,s);
  drawAxes(w,h,vs,ve,s);
  drawCursor(w,h,s);
}

function drawCursor(w,h,s){
  if(!cursorT)return;
  var cx=t2x(cursorT);
  if(cx<M.l||cx>w-M.r)return;
  ctx.strokeStyle=s.getPropertyValue('--cr').trim();ctx.lineWidth=0.8;ctx.setLineDash([4,3]);
  ctx.beginPath();ctx.moveTo(cx,M.t);ctx.lineTo(cx,h-M.b);ctx.stroke();ctx.setLineDash([]);
  ctx.fillStyle=s.getPropertyValue('--cr').trim();ctx.font='10px monospace';ctx.textAlign='center';
  var label=fmtT(timeConv(cursorT));
  var tw=ctx.measureText(label).width;
  var lx=Math.max(M.l+tw/2+4,Math.min(cx,w-M.r-tw/2-4));
  ctx.fillText(label,lx,M.t-1);
}

function drawZeroLines(w,h,s){
  ctx.strokeStyle=s.getPropertyValue('--gr').trim();ctx.lineWidth=0.4;ctx.setLineDash([2,4]);
  var vc=visChannels();
  for(var vi=0;vi<vc.length;vi++){var i=vc[vi],y=cy(vi);if(i>=2&&i<=4){ctx.beginPath();ctx.moveTo(M.l,y);ctx.lineTo(w-M.r,y);ctx.stroke();}}
  ctx.setLineDash([]);
}

function drawGrid(w,h,vs,ve,s){
  ctx.strokeStyle=s.getPropertyValue('--gr').trim();ctx.lineWidth=0.5;
  var st=nice((ve-vs)/8),t=Math.floor(vs/st)*st;
  while(t<=ve){var x=t2x(t);ctx.beginPath();ctx.moveTo(x,M.t);ctx.lineTo(x,h-M.b);ctx.stroke();t+=st;}
  var ch=cH(),vc=visChannels();
  for(var i=0;i<=vc.length;i++){var y=M.t+i*ch;ctx.beginPath();ctx.moveTo(M.l,y);ctx.lineTo(w-M.r,y);ctx.stroke();}
}

function drawAxes(w,h,vs,ve,s){
  // X axis with time labels
  ctx.fillStyle=s.getPropertyValue('--lb').trim();ctx.font='10px monospace';ctx.textAlign='center';
  ctx.strokeStyle=s.getPropertyValue('--ax').trim();ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(M.l,h-M.b);ctx.lineTo(w-M.r,h-M.b);ctx.stroke();
  var st=nice((ve-vs)/8),t=Math.floor(vs/st)*st;
  while(t<=ve){ctx.fillText(fmtT(timeConv(t)),t2x(t),h-M.b+14);t+=st;}
  ctx.fillText('time ('+timeUnitStr()+')',w-M.r+24,h-M.b+4);

  // Y axes per visible channel
  var vc=visChannels(),ch=cH();
  for(var vi=0;vi<vc.length;vi++){
    var ci=vc[vi],y0=cy(vi);
    // Channel label — bold, colored, shifted well left of ticks
    ctx.textAlign='right';ctx.font='bold 12px monospace';
    ctx.fillStyle=chColors[ci];ctx.fillText(CH[ci],M.l-20,y0+4);
    // Tick values
    ctx.fillStyle=s.getPropertyValue('--lb').trim();ctx.font='10px monospace';
    if(ci===0){ // RF magnitude — 0 at bottom, max at top
      ctx.fillText(fmtAmp(gMax[0])+'Hz',M.l-12,M.t+vi*ch+12);
      ctx.fillText('0',M.l-12,y0+ch/2-2);
    }else if(ci===1){ // Phase — 0 at bottom, 2π at top
      ctx.fillText('2\u03c0',M.l-12,M.t+vi*ch+12);
      ctx.fillText('\u03c0',M.l-12,y0+4);
      ctx.fillText('0',M.l-12,y0+ch/2-2);
    }else if(ci>=2&&ci<=4){ // Gradients — ±max at top/bottom, 0 at center
      var dMax=gradConv(gMax[ci]);
      ctx.fillText('\u00b1'+fmtAmp(dMax)+gradUnitStr(),M.l-12,M.t+vi*ch+12);
      ctx.fillText('0',M.l-12,y0+4);
    }else if(ci===5){ctx.fillText('on',M.l-12,M.t+vi*ch+12);}
    else if(ci===6){ctx.fillText('ch',M.l-12,M.t+vi*ch+12);}
    // Tick marks
    ctx.strokeStyle=s.getPropertyValue('--ax').trim();ctx.lineWidth=0.5;
    ctx.beginPath();ctx.moveTo(M.l-2,M.t+vi*ch);ctx.lineTo(M.l+2,M.t+vi*ch);ctx.stroke();
    ctx.beginPath();ctx.moveTo(M.l-2,M.t+vi*ch+ch/2);ctx.lineTo(M.l+2,M.t+vi*ch+ch/2);ctx.stroke();
    ctx.beginPath();ctx.moveTo(M.l-2,M.t+(vi+1)*ch);ctx.lineTo(M.l+2,M.t+(vi+1)*ch);ctx.stroke();
  }
}

function drawBlocks(vs,ve,s){
  var ch=cH(),vc=visChannels();
  for(var bi=0;bi<BL.length;bi++){
    var b=BL[bi],t0=b.s,t1=t0+b.d;
    if(t1<vs||t0>ve)continue;
    // Map channel index to visual row
    var viRF=-1,viPh=-1,viGx=-1,viGy=-1,viGz=-1,viADC=-1,viTrig=-1;
    for(var vi=0;vi<vc.length;vi++){
      if(vc[vi]===0)viRF=vi;if(vc[vi]===1)viPh=vi;
      if(vc[vi]===2)viGx=vi;if(vc[vi]===3)viGy=vi;if(vc[vi]===4)viGz=vi;
      if(vc[vi]===5)viADC=vi;if(vc[vi]===6)viTrig=vi;
    }
    // RF magnitude — 0 at bottom of channel, amplitude fills upward
    if(b.rf&&viRF>=0){
      var y=cy(viRF),rc=s.getPropertyValue('--rf').trim(),rff=s.getPropertyValue('--rff').trim();
      var rfx0=t2x(b.rf.s),rfx1=t2x(b.rf.s+b.rf.d);
      var rfBot=y+ch*.45,rfTop=y-ch*.45;
      ctx.fillStyle=rff;ctx.fillRect(rfx0,rfTop,rfx1-rfx0,rfBot-rfTop);
      if(b.rf.t&&b.rf.t.length>1){
        ctx.strokeStyle=rc;ctx.lineWidth=1.1;ctx.beginPath();
        var f=true,sc2=ch*.9/gMax[0];
        for(var i=0;i<b.rf.t.length;i++){
          var sx=t2x(b.rf.t[i]),sy=y+ch*.45-b.rf.m[i]*sc2;
          if(f){ctx.moveTo(sx,sy);f=false}else ctx.lineTo(sx,sy);
        }ctx.stroke();
      }
    }
    // RF phase — 0 at bottom (≈y+ch*.45), 2π at top (≈y-ch*.45)
    if(b.rf&&b.rf.p&&viPh>=0){
      var py=cy(viPh);
      ctx.strokeStyle=s.getPropertyValue('--rf').trim();ctx.lineWidth=0.8;ctx.setLineDash([2,3]);ctx.beginPath();
      var f=true,psc=ch*.9/6.28318;
      for(var i=0;i<b.rf.t.length;i++){
        var sx=t2x(b.rf.t[i]),sy=py+ch*.45-b.rf.p[i]*psc;
        if(f){ctx.moveTo(sx,sy);f=false}else ctx.lineTo(sx,sy);
      }ctx.stroke();ctx.setLineDash([]);
    }
    // Gradients — draw waveform; amplitude is in native Hz/m, display conversion in tooltip only
    if(viGx>=0)drawG(b.gx,viGx,s.getPropertyValue('--gx').trim(),ch,s,gMax[2]);
    if(viGy>=0)drawG(b.gy,viGy,s.getPropertyValue('--gy').trim(),ch,s,gMax[3]);
    if(viGz>=0)drawG(b.gz,viGz,s.getPropertyValue('--gz').trim(),ch,s,gMax[4]);
    // ADC
    if(b.adc&&viADC>=0){
      var ay=cy(viADC),af=s.getPropertyValue('--adf').trim(),ac=s.getPropertyValue('--adc').trim();
      var as2=b.adc.s+b.adc.d,ae=as2+b.adc.n*b.adc.dw;
      if(ae>vs&&as2<ve){
        var ax0=t2x(Math.max(as2,vs)),ax1=t2x(Math.min(ae,ve));
        ctx.fillStyle=af;ctx.fillRect(ax0,ay-ch*.28,ax1-ax0,ch*.56);
        ctx.strokeStyle=ac;ctx.lineWidth=1;ctx.strokeRect(ax0,ay-ch*.28,ax1-ax0,ch*.56);
        if(ax1-ax0>30){ctx.fillStyle=s.getPropertyValue('--fg').trim();ctx.font='9px monospace';ctx.textAlign='center';ctx.fillText(b.adc.n+'pts',(ax0+ax1)/2,ay+3);}
        if(b.adc.po&&Math.abs(b.adc.po)>1e-6){ctx.fillStyle=ac;ctx.beginPath();ctx.arc((ax0+ax1)/2,ay-ch*.22,4,0,6.283);ctx.fill();ctx.fillStyle='#fff';ctx.font='7px monospace';ctx.textAlign='center';ctx.fillText('\u03c6',(ax0+ax1)/2,ay-ch*.19);}
      }
    }
    // Triggers — downward triangles
    if(b.trg&&viTrig>=0){
      var ty=cy(viTrig),tc=s.getPropertyValue('--tr').trim();
      for(var ti2=0;ti2<b.trg.length;ti2++){
        var tg=b.trg[ti2],ts2=tg.s+tg.d,te2=ts2+tg.dr;
        if(te2<vs||ts2>ve)continue;
        var txm=t2x((ts2+te2)/2);
        ctx.fillStyle=tc;ctx.beginPath();ctx.moveTo(txm,ty-ch*.15);ctx.lineTo(txm-5,ty+ch*.15);ctx.lineTo(txm+5,ty+ch*.15);ctx.closePath();ctx.fill();
        ctx.fillStyle=tc;ctx.font='8px monospace';ctx.textAlign='center';ctx.fillText('ch'+tg.c,txm,ty+ch*.28);
      }
    }
  }
}

function drawG(g,vi,c,ch,s,globMax){
  if(!g||g.ty==='none')return;var y=cy(vi);
  if(g.t&&g.t.length>1){
    var maxA=Math.max(globMax||1,0.001),sc2=ch*.4/maxA;
    ctx.strokeStyle=c;ctx.lineWidth=1;ctx.beginPath();
    var f=true,clipL=M.l,clipR=mc.width/(window.devicePixelRatio||1)-M.r;
    for(var i=0;i<g.t.length;i++){var sx=t2x(g.t[i]);if(sx<clipL||sx>clipR){f=true;continue}var sy=y-g.w[i]*sc2;if(f){ctx.moveTo(sx,sy);f=false}else ctx.lineTo(sx,sy);}
    ctx.stroke();
  }
}

// Mouse
mc.addEventListener('wheel',function(e){e.preventDefault();
  var r=mc.getBoundingClientRect(),mx2=e.clientX-r.left,tm=x2t(mx2);
  var zf=e.deltaY<0?1.3:1/1.3;sc*=zf;sc=Math.max(50/(TD||1e-3),Math.min(sc,1e7));
  ox=tm-(mx2-M.l)/sc;ox=Math.max(0,Math.min(ox,TD));draw();},{passive:false});
mc.addEventListener('mousedown',function(e){if(e.button===0){dr=true;dsx=e.clientX;dso=ox;cc.classList.add('pan')}});
window.addEventListener('mousemove',function(e){
  var r=mc.getBoundingClientRect();mx=e.clientX-r.left;my=e.clientY-r.top;cursorT=x2t(mx);
  curEl.textContent=fmtT(timeConv(cursorT))+' '+timeUnitStr();
  if(dr){ox=dso-(e.clientX-dsx)/sc;ox=Math.max(0,Math.min(ox,TD));draw();return}
  draw();
  var ch=cH(),vc=visChannels(),vi2=Math.floor((my-M.t)/ch);
  if(vi2>=0&&vi2<vc.length&&mx>=M.l){
    var ci=vc[vi2],found=null;
    for(var i=0;i<BL.length;i++){if(cursorT>=BL[i].s&&cursorT<=BL[i].s+BL[i].d){found=BL[i];break}}
    if(found){
      var lines=['Block #'+found.i,'Time: '+fmtT(timeConv(found.s))+' '+timeUnitStr()+' (dur: '+fmtT(timeConv(found.d))+' '+timeUnitStr()+')'];
      if(found.rf){lines.push('RF: '+(found.rf.a||0).toFixed(1)+' Hz, fo='+(found.rf.fo||0).toFixed(0)+' Hz, \u03c6\u2080='+((found.rf.po||0)%6.283).toFixed(2)+' rad');}
      if(found.gx&&found.gx.ty!=='none')lines.push('Gx: '+fg(found.gx));
      if(found.gy&&found.gy.ty!=='none')lines.push('Gy: '+fg(found.gy));
      if(found.gz&&found.gz.ty!=='none')lines.push('Gz: '+fg(found.gz));
      if(found.adc){lines.push('ADC: '+found.adc.n+'pts @'+(found.adc.dw*1e6).toFixed(1)+'\u00b5s, fo='+(found.adc.fo||0).toFixed(0)+'Hz, \u03c6\u2080='+((found.adc.po||0)%6.283).toFixed(2)+'rad');}
      if(found.trg)lines.push('Trig: ch'+found.trg.map(function(x){return x.c}).join(',')+' \u0394'+found.trg.map(function(x){return fmtT(timeConv(x.dr))+' '+timeUnitStr()}).join(','));
      tt.textContent=lines.join('\\n');tt.style.display='block';
      tt.style.left=Math.min(e.clientX+15,window.innerWidth-350)+'px';tt.style.top=(e.clientY-10)+'px';
    }else{tt.style.display='none'}
  }else{tt.style.display='none'}
});
window.addEventListener('mouseup',function(){dr=false;cc.classList.remove('pan')});
cc.addEventListener('mouseleave',function(){cursorT=0;curEl.textContent='\u2190 hover for time';draw()});

document.getElementById('zi').onclick=function(){sc*=1.5;draw()};
document.getElementById('zo').onclick=function(){sc/=1.5;sc=Math.max(50/(TD||1e-3),sc);draw()};
document.getElementById('zf').onclick=fit;document.getElementById('zr').onclick=fit;

function fit(){var w=mc.width/(window.devicePixelRatio||1);sc=(w-M.l-M.r)/(TD||1e-3);ox=0;draw()}
function nice(r){var ms=[1,2,5,10,20,50,100,200,500,1000,2000,5000,10000,20000,50000];
  for(var i=0;i<ms.length;i++){var b=Math.pow(10,Math.floor(Math.log10(r)));if(ms[i]*b>=r)return ms[i]*b}return 1000*Math.pow(10,Math.floor(Math.log10(r)))}
function fmt(s){if(s<1e-6)return(s*1e9).toFixed(0)+'ns';if(s<.001)return(s*1e6).toFixed(1)+'\u00b5s';if(s<1)return(s*1000).toFixed(2)+'ms';return s.toFixed(3)+'s'}
function fmtT(v){if(v>=1)return v.toFixed(3);if(v>=0.001)return v.toFixed(3);if(v>=1e-6)return v.toFixed(3);return v.toExponential(2);}
function fmtAmp(v){if(v>=1e6)return(v/1e6).toFixed(1)+'M';if(v>=1e3)return(v/1e3).toFixed(1)+'k';if(v>=1)return v.toFixed(1);return v.toFixed(2);}
function fg(g){var a=gradConv(g.a||0);return a.toFixed(1)+' '+gradUnitStr()+' ('+g.ty+')';}
new MutationObserver(function(){draw()}).observe(document.body,{attributes:true,attributeFilter:['class']});
rs();
})();
</script></body></html>`;
}
