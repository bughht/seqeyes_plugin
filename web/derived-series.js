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

function forEachDerivedPoint(series,viewStart,viewEnd,maxPoints,visit){
  if(!series||series.n<1)return 0;
  var t=series.t,v=series.v,n=series.n;
  var i0=Math.max(0,lowerBoundSeries(t,viewStart)-1),i1=Math.min(n,upperBoundSeries(t,viewEnd)+1);
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
