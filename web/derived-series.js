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

/* Block-indexed min/max summaries for RF, gradients, and ADC occupancy. */
function createWaveformOverview(blocks){
  if(!blocks||!blocks.length)return null;
  var level=buildWaveformOverviewLevel(blocks,1),levels=[level];
  while(level.count>1){level=mergeWaveformOverviewLevel(level);levels.push(level);}
  return{levels:levels,blockCount:blocks.length,pointPrefix:createWaveformPointPrefixes(blocks)};
}

function createEmptyWaveformOverviewLevel(count,bucketSize){
  var level={count:count,bucketSize:bucketSize,t0:new Float64Array(count),t1:new Float64Array(count),
    rfMin:new Float64Array(count),rfMax:new Float64Array(count),gxMin:new Float64Array(count),gxMax:new Float64Array(count),
    gyMin:new Float64Array(count),gyMax:new Float64Array(count),gzMin:new Float64Array(count),gzMax:new Float64Array(count),
    gxStart:new Float64Array(count),gxEnd:new Float64Array(count),gyStart:new Float64Array(count),gyEnd:new Float64Array(count),gzStart:new Float64Array(count),gzEnd:new Float64Array(count),
    adcStart:new Float64Array(count),adcEnd:new Float64Array(count)};
  var mins=[level.rfMin,level.gxMin,level.gyMin,level.gzMin,level.gxStart,level.gyStart,level.gzStart,level.adcStart];
  var maxs=[level.rfMax,level.gxMax,level.gyMax,level.gzMax,level.gxEnd,level.gyEnd,level.gzEnd,level.adcEnd];
  for(var m=0;m<mins.length;m++)mins[m].fill(Infinity);
  for(var x=0;x<maxs.length;x++)maxs[x].fill(-Infinity);
  return level;
}

function createWaveformPointPrefixes(blocks){
  var keys=['rf','phase','gx','gy','gz','adc'],prefix={};
  for(var ki=0;ki<keys.length;ki++)prefix[keys[ki]]=new Float64Array(blocks.length+1);
  for(var i=0;i<blocks.length;i++){
    var block=blocks[i],rf=block.rf,adc=block.adc;
    prefix.rf[i+1]=prefix.rf[i]+(rf&&rf.t&&rf.m?Math.min(rf.t.length,rf.m.length):0);
    var rfPhase=rf&&rf.t&&rf.p?Math.min(rf.t.length,rf.p.length):0,adcPhase=0;
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
      if(rf){
        includeOverviewValues(rf.m,level.rfMin,level.rfMax,bucket);if(level.rfMin[bucket]===Infinity)includeOverviewValues([rf.a||0],level.rfMin,level.rfMax,bucket);
      }
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
  var channels=[['rfMin','rfMax'],['gxMin','gxMax'],['gyMin','gyMax'],['gzMin','gzMax'],['gxStart','gxEnd'],['gyStart','gyEnd'],['gzStart','gzEnd'],['adcStart','adcEnd']];
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
