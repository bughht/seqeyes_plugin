/**
 * webview/js_drawing.ts — JavaScript Canvas drawing functions.
 *
 * Contains the main draw() loop and all sub-drawing routines:
 *   draw, drawCursor, drawGrid, drawZeroLines, drawBlockBounds,
 *   drawAxes, drawBlocks, drawG.
 */

export const JS_DRAWING = `
/* ═══════════════════════════════════════════════════════════════════════
   Main draw loop
   ═══════════════════════════════════════════════════════════════════════ */
function draw(){
  var w=mc.width/(window.devicePixelRatio||1),h=mc.height/(window.devicePixelRatio||1);
  var s=getComputedStyle(document.body);
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle=s.getPropertyValue('--bg').trim();ctx.fillRect(0,0,w,h);
  var vs=ox,ve=ox+(w-M.l-M.r)/sc;
  drawGrid(w,h,vs,ve,s);
  drawZeroLines(w,h,s);
  if(showBB)drawBlockBounds(w,h,s);
  drawBlocks(vs,ve,s);
  drawAxes(w,h,vs,ve,s);
  drawCursor(w,h,s);
  drawKs();  // sync k-space ADC points with current time window
}

/* ── Vertical cursor ──────────────────────────────────────────────────── */
function drawCursor(w,h,s){
  if(!cursorT)return;var cx=t2x(cursorT);
  if(cx<M.l||cx>w-M.r)return;
  ctx.strokeStyle=s.getPropertyValue('--cr').trim();ctx.lineWidth=0.8;ctx.setLineDash([4,3]);
  ctx.beginPath();ctx.moveTo(cx,M.t);ctx.lineTo(cx,h-M.b);ctx.stroke();ctx.setLineDash([]);
  ctx.fillStyle=s.getPropertyValue('--cr').trim();ctx.font='10px monospace';ctx.textAlign='center';
  var label=fmtT(timeConv(cursorT)),tw=ctx.measureText(label).width;
  ctx.fillText(label,Math.max(M.l+tw/2+4,Math.min(cx,w-M.r-tw/2-4)),M.t-1);
}

/* ── Zero lines & grid ────────────────────────────────────────────────── */
function drawZeroLines(w,h,s){
  ctx.strokeStyle=s.getPropertyValue('--gr').trim();ctx.lineWidth=0.4;ctx.setLineDash([2,4]);
  var vc=visChannels();for(var vi=0;vi<vc.length;vi++){var i=vc[vi];if(i>=2&&i<=4){ctx.beginPath();ctx.moveTo(M.l,cy(vi));ctx.lineTo(w-M.r,cy(vi));ctx.stroke();}}
  ctx.setLineDash([]);
}
function drawBlockBounds(w,h,s){
  ctx.strokeStyle=s.getPropertyValue('--ax').trim();ctx.lineWidth=0.6;ctx.setLineDash([3,6]);
  for(var i=0;i<BL.length;i++){
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
  while(t<=ve){var x=t2x(t);ctx.beginPath();ctx.moveTo(x,M.t);ctx.lineTo(x,h-M.b);ctx.stroke();t+=st;}
  var ch=cH(),vc=visChannels();
  for(var i=0;i<=vc.length;i++){ctx.beginPath();ctx.moveTo(M.l,M.t+i*ch);ctx.lineTo(w-M.r,M.t+i*ch);ctx.stroke();}
}

/* ── Axes (X time + Y per channel) ────────────────────────────────────── */
function drawAxes(w,h,vs,ve,s){
  // X-axis
  ctx.fillStyle=s.getPropertyValue('--lb').trim();ctx.font='10px monospace';ctx.textAlign='center';
  ctx.strokeStyle=s.getPropertyValue('--ax').trim();ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(M.l,h-M.b);ctx.lineTo(w-M.r,h-M.b);ctx.stroke();
  var st=nice((ve-vs)/8),t=Math.floor(vs/st)*st;
  while(t<=ve){ctx.fillText(fmtT(timeConv(t)),t2x(t),h-M.b+14);t+=st;}
  ctx.fillText('time ('+timeUnitStr()+')',w-M.r+24,h-M.b+4);

  // Y-axes — one per visible channel
  var vc=visChannels(),ch=cH();
  for(var vi=0;vi<vc.length;vi++){
    var ci=vc[vi],y0=cy(vi);
    // Channel label (bold, coloured)
    ctx.textAlign='right';ctx.font='bold 18px monospace';
    ctx.fillStyle=chColors[ci];ctx.fillText(CH[ci],M.l-40,y0+4);
    // Tick values
    ctx.fillStyle=s.getPropertyValue('--lb').trim();ctx.font='10px monospace';
    var lblX=M.l-12;
    if(ci===0){ctx.fillText(fmtAmp(gMax[0])+'Hz',lblX,M.t+vi*ch+12);ctx.fillText('0',lblX,y0+ch/2-2);}
    else if(ci===1){ctx.fillText('2\\u03c0',lblX,M.t+vi*ch+12);ctx.fillText('\\u03c0',lblX,y0+4);ctx.fillText('0',lblX,y0+ch/2-2);}
    else if(ci>=2&&ci<=4){var d=gradConv(gMax[ci]);ctx.fillText('\\u00b1'+fmtAmp(d)+gradUnitStr(),lblX,M.t+vi*ch+12);ctx.fillText('0',lblX,y0+4);}
    else if(ci===5){ctx.fillText('on',lblX,M.t+vi*ch+12);}
    else if(ci===6){ctx.fillText('ch',lblX,M.t+vi*ch+12);}

    // Small tick marks
    ctx.strokeStyle=s.getPropertyValue('--ax').trim();ctx.lineWidth=0.5;
    ctx.beginPath();ctx.moveTo(M.l-2,M.t+vi*ch);ctx.lineTo(M.l+2,M.t+vi*ch);ctx.stroke();
    ctx.beginPath();ctx.moveTo(M.l-2,y0);ctx.lineTo(M.l+2,y0);ctx.stroke();
    ctx.beginPath();ctx.moveTo(M.l-2,M.t+(vi+1)*ch);ctx.lineTo(M.l+2,M.t+(vi+1)*ch);ctx.stroke();
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   Block waveform rendering
   ═══════════════════════════════════════════════════════════════════════ */
function drawBlocks(vs,ve,s){
  var ch=cH(),vc=visChannels();
  for(var bi=0;bi<BL.length;bi++){
    var b=BL[bi];if(b.s+b.d<vs||b.s>ve)continue;

    // Map channel indices -> visual rows
    var viRF=-1,viPh=-1,viGx=-1,viGy=-1,viGz=-1,viADC=-1,viTrig=-1;
    for(var vi=0;vi<vc.length;vi++){
      if(vc[vi]===0)viRF=vi;if(vc[vi]===1)viPh=vi;
      if(vc[vi]===2)viGx=vi;if(vc[vi]===3)viGy=vi;if(vc[vi]===4)viGz=vi;
      if(vc[vi]===5)viADC=vi;if(vc[vi]===6)viTrig=vi;
    }

    // -- RF magnitude --
    if(b.rf&&viRF>=0){
      var y=cy(viRF),rc=s.getPropertyValue('--rf').trim(),rff=s.getPropertyValue('--rff').trim();
      var rfx0=t2x(b.rf.s),rfx1=t2x(b.rf.s+b.rf.d);
      ctx.fillStyle=rff;ctx.fillRect(rfx0,y-ch*.45,rfx1-rfx0,ch*.9);
      if(b.rf.t&&b.rf.t.length>1){
        ctx.strokeStyle=rc;ctx.lineWidth=1.1;ctx.beginPath();
        for(var i=0,f=1,sc2=ch*.9/gMax[0];i<b.rf.t.length;i++){
          var sx=t2x(b.rf.t[i]),sy=y+ch*.45-b.rf.m[i]*sc2;
          if(f){ctx.moveTo(sx,sy);f=0}else ctx.lineTo(sx,sy);
        }ctx.stroke();
      }
    }

    // -- RF phase --
    if(b.rf&&b.rf.p&&viPh>=0){
      var py=cy(viPh);
      ctx.strokeStyle=s.getPropertyValue('--rf').trim();ctx.lineWidth=0.8;ctx.beginPath();
      for(var i=0,f=1,psc=ch*.9/6.28318;i<b.rf.t.length;i++){
        var sx=t2x(b.rf.t[i]),sy=py+ch*.45-b.rf.p[i]*psc;
        if(f){ctx.moveTo(sx,sy);f=0}else ctx.lineTo(sx,sy);
      }ctx.stroke();ctx.setLineDash([]);
    }

    // -- ADC phase curve on φ axis (evolves linearly:  φ(t) = po + 2π·fo·Δt) --
    if(b.adc&&viPh>=0&&b.adc.n>1){
      var apy3=cy(viPh);
      var t0=b.adc.s+b.adc.d, fo2=b.adc.fo||0, po2=b.adc.po||0;
      var nAdc=b.adc.n, dw2=b.adc.dw, te2=t0+nAdc*dw2;
      if(te2>vs&&t0<ve){
        ctx.strokeStyle=s.getPropertyValue('--adc').trim();ctx.lineWidth=0.8;
        ctx.beginPath();
        var psc2=ch*.9/6.28318;
        // Subsample large readouts to ≤ 200 points for performance
        var step=Math.max(1,Math.ceil(nAdc/200));
        for(var s2=0,f2=1;s2<=nAdc;s2+=step){
          var tA=(s2<nAdc)?t0+(s2+0.5)*dw2:te2;
          var dtA=tA-t0;
          var phA=((po2+6.283185*fo2*dtA)%6.28318+6.28318)%6.28318;
          var sxA=t2x(tA),syA=apy3+ch*.45-phA*psc2;
          var clipL2=M.l,clipR2=mc.width/(window.devicePixelRatio||1)-M.r;
          if(sxA<clipL2||sxA>clipR2){f2=1;continue}
          if(f2){ctx.moveTo(sxA,syA);f2=0}else ctx.lineTo(sxA,syA);
        }ctx.stroke();ctx.setLineDash([]);
      }
    }

    // -- Gradients --
    if(viGx>=0)drawG(b.gx,viGx,2,s.getPropertyValue('--gx').trim(),ch,s,gMax[2]);
    if(viGy>=0)drawG(b.gy,viGy,3,s.getPropertyValue('--gy').trim(),ch,s,gMax[3]);
    if(viGz>=0)drawG(b.gz,viGz,4,s.getPropertyValue('--gz').trim(),ch,s,gMax[4]);

    // -- ADC --
    if(b.adc&&viADC>=0){
      var ay=cy(viADC),af=s.getPropertyValue('--adf').trim(),ac=s.getPropertyValue('--adc').trim();
      var as=b.adc.s+b.adc.d,ae=as+b.adc.n*b.adc.dw;
      if(ae>vs&&as<ve){
        var ax0=t2x(Math.max(as,vs)),ax1=t2x(Math.min(ae,ve));
        ctx.fillStyle=af;ctx.fillRect(ax0,ay-ch*.28,ax1-ax0,ch*.56);
        ctx.strokeStyle=ac;ctx.lineWidth=1;ctx.strokeRect(ax0,ay-ch*.28,ax1-ax0,ch*.56);
        if(ax1-ax0>30){ctx.fillStyle=s.getPropertyValue('--fg').trim();ctx.font='9px monospace';ctx.textAlign='center';ctx.fillText(b.adc.n+'pts',(ax0+ax1)/2,ay+3);}
      }
    }

    // -- Triggers --
    if(b.trg&&viTrig>=0){
      var ty=cy(viTrig),tc=s.getPropertyValue('--tr').trim();
      for(var tj=0;tj<b.trg.length;tj++){
        var tg=b.trg[tj],ts=tg.s+tg.d,te=ts+tg.dr;if(te<vs||ts>ve)continue;
        var txm=t2x((ts+te)/2);
        ctx.fillStyle=tc;ctx.beginPath();ctx.moveTo(txm,ty-ch*.05);ctx.lineTo(txm-5,ty+ch*.05);ctx.lineTo(txm+5,ty+ch*.05);ctx.closePath();ctx.fill();
        ctx.fillStyle=tc;ctx.font='8px monospace';ctx.textAlign='center';ctx.fillText('ch'+tg.c,txm,ty+ch*.28);
      }
    }
  }
}

/* ── Single gradient channel ──────────────────────────────────────────── */
function drawG(g,vi,ci,c,ch,s,globMax){
  if(!g||g.ty==='none')return;var y=cy(vi);
  if(g.t&&g.t.length>1){
    var maxA=Math.max(globMax||1,0.001)*ampZoom[ci];var sc2=ch*.4/maxA;
    ctx.strokeStyle=c;ctx.lineWidth=1;ctx.beginPath();
    var clipL=M.l,clipR=mc.width/(window.devicePixelRatio||1)-M.r;
    for(var i=0,f=1;i<g.t.length;i++){
      var sx=t2x(g.t[i]);if(sx<clipL||sx>clipR){f=1;continue}
      var sy=y-g.w[i]*sc2;if(f){ctx.moveTo(sx,sy);f=0}else ctx.lineTo(sx,sy);
    }ctx.stroke();
  }
}

;`;
