/* ═══════════════════════════════════════════════════════════════════════
   Main draw loop
   ═══════════════════════════════════════════════════════════════════════ */
function draw(){
  var drawStarted=performance.now();derivedRenderPointCount=0;derivedEnvelopeCurveCount=0;derivedRawCurveCount=0;viewerDrawCount++;
  var w=mc.width/(window.devicePixelRatio||1),h=mc.height/(window.devicePixelRatio||1);
  var s=getComputedStyle(document.body);
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle=s.getPropertyValue('--bg').trim();ctx.fillRect(0,0,w,h);
  var visibleRange=visibleDuration();var vs=ox,ve=ox+visibleRange;
  drawGrid(w,h,vs,ve,s);
  drawZeroLines(w,h,s);
  if(showBB)drawBlockBounds(w,h,s);
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
  if(m1Data){
    if(viM1x>=0)drawBipolarSeries(m1Data.x,viM1x,8,s.getPropertyValue('--gx').trim(),ch,vs,ve);
    if(viM1y>=0)drawBipolarSeries(m1Data.y,viM1y,9,s.getPropertyValue('--gy').trim(),ch,vs,ve);
    if(viM1z>=0)drawBipolarSeries(m1Data.z,viM1z,10,s.getPropertyValue('--gz').trim(),ch,vs,ve);
  }
}

function drawPercentSeries(series,vi,ci,c,ch,vs,ve){
  if(!series||series.n<2)return;
  rowClip(vi,ch,function(){
    var maxA=channelRange(ci),base=M.t+(vi+1)*ch-ch*.08,scale=ch*.84/maxA;
    var clipL=M.l,clipR=mc.width/(window.devicePixelRatio||1)-M.r;
    var plotW=Math.max(1,clipR-clipL);
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
  if(!series||series.n<2)return;
  rowClip(vi,ch,function(){
    var maxA=channelRange(ci),y=cy(vi),scale=ch*.4/maxA;
    var clipL=M.l,clipR=mc.width/(window.devicePixelRatio||1)-M.r;
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
  if(rows[0]>=0)drawRfBlocks(range.start,range.end,rows[0],ch,colors,vs,ve);
  if(rows[1]>=0)drawPhaseBlocks(range.start,range.end,rows[1],ch,colors,vs,ve);
  if(rows[2]>=0)drawGradientBlocks(range.start,range.end,'gx',rows[2],2,ch,colors.gx,vs,ve);
  if(rows[3]>=0)drawGradientBlocks(range.start,range.end,'gy',rows[3],3,ch,colors.gy,vs,ve);
  if(rows[4]>=0)drawGradientBlocks(range.start,range.end,'gz',rows[4],4,ch,colors.gz,vs,ve);
  if(rows[5]>=0)drawAdcBlocks(range.start,range.end,rows[5],ch,colors,vs,ve);
  if(rows[6]>=0)drawTriggerBlocks(range.start,range.end,rows[6],ch,colors,vs,ve);
}

function visibleBlockRange(vs,ve){
  var lo=0,hi=BL.length,mid;
  while(lo<hi){mid=(lo+hi)>>1;if(BL[mid].s+BL[mid].d<vs)lo=mid+1;else hi=mid;}
  var start=lo;hi=BL.length;
  while(lo<hi){mid=(lo+hi)>>1;if(BL[mid].s<=ve)lo=mid+1;else hi=mid;}
  return{start:Math.max(0,start-1),end:Math.min(BL.length,lo+1)};
}

function drawRfBlocks(start,end,vi,ch,colors,vs,ve){
  var y=cy(vi),scale=ch*.9/channelRange(0);
  rowClip(vi,ch,function(){
    ctx.strokeStyle=colors.rf;ctx.lineWidth=1.1;ctx.beginPath();var hasPath=false;
    for(var bi=start;bi<end;bi++){
      var rf=BL[bi].rf;if(!rf||rf.s+rf.d<vs||rf.s>ve)continue;
      var x0=t2x(rf.s),x1=t2x(rf.s+rf.d);
      ctx.fillStyle=colors.rff;ctx.fillRect(x0,y-ch*.45,x1-x0,ch*.9);
      if(!rf.t||!rf.m||rf.t.length<2)continue;
      var n=Math.min(rf.t.length,rf.m.length);
      for(var i=0;i<n;i++){
        var sx=t2x(rf.t[i]),sy=y+ch*.45-rf.m[i]*scale;
        if(i===0)ctx.moveTo(sx,sy);else ctx.lineTo(sx,sy);
      }
      hasPath=true;
    }
    if(hasPath)ctx.stroke();
  });
}

function drawPhaseBlocks(start,end,vi,ch,colors,vs,ve){
  var y=cy(vi),scale=ch*.9/channelRange(1);
  rowClip(vi,ch,function(){
    ctx.strokeStyle=colors.rf;ctx.lineWidth=.8;ctx.beginPath();var hasRf=false;
    for(var bi=start;bi<end;bi++){
      var rf=BL[bi].rf;if(!rf||!rf.p||!rf.t||rf.s+rf.d<vs||rf.s>ve)continue;
      var n=Math.min(rf.t.length,rf.p.length);
      for(var i=0;i<n;i++){
        var sx=t2x(rf.t[i]),sy=y+ch*.45-rf.p[i]*scale;
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
