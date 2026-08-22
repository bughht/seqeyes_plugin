/* ══════════════════════════════════════════════════════════════════════════
   block-transport.js — rehydrate the packed block payload from the extension.

   The standalone web app builds BL in this same heap, so its waveform arrays
   cost one copy and nothing more.  The VS Code extension has to cross a process
   boundary, and VS Code serialises webview messages with JSON.stringify: every
   sample becomes ~19 characters of text, the extension host and the renderer
   each hold that string alongside the object graph, and V8 refuses to build a
   string longer than 512 MiB at all.  Dense arbitrary waveforms reach ~18 KB of
   JSON per block, so a few tens of thousands of them cannot be delivered as
   JSON at any amount of memory.

   src/editor/blockTransport.ts therefore sends the samples as two shared binary
   buffers — Float64 times, Float32 amplitudes — plus an envelope carrying each
   waveform's offset and count.  Restoring the arrays as typed-array views over
   those buffers reproduces the exact block shape the renderer reads, without
   copying a single sample: the renderer only ever indexes these arrays and asks
   for their length, which a typed array answers identically.
   ══════════════════════════════════════════════════════════════════════════ */

/** Interpret a transferred buffer as `Ctor`, or null if it did not arrive. */
function asTypedView(buffer,Ctor){
  if(buffer instanceof Ctor)return buffer;
  if(buffer instanceof ArrayBuffer)return new Ctor(buffer);
  // Some hosts hand the transfer back as a byte view rather than the buffer.
  if(buffer&&buffer.buffer instanceof ArrayBuffer&&typeof buffer.byteLength==='number')
    return new Ctor(buffer.buffer,buffer.byteOffset||0,Math.floor(buffer.byteLength/Ctor.BYTES_PER_ELEMENT));
  return null;
}

/**
 * Attach typed-array views to the envelope in place and return it as BL.
 * Throws rather than returning partial blocks: a viewer that silently draws
 * half a sequence is worse than one that says why it cannot.
 */
function unpackSequenceBlocks(envelope,timeBuffer,valueBuffer,sampleCount){
  if(!envelope||!envelope.length)return [];
  var times=asTypedView(timeBuffer,Float64Array),values=asTypedView(valueBuffer,Float32Array);
  if(!times||!values)throw new Error('the waveform sample buffers did not arrive as binary data');
  var available=Math.min(times.length,values.length);
  if(sampleCount>available)
    throw new Error('the waveform sample buffers are short by '+(sampleCount-available)+' samples');
  for(var i=0;i<envelope.length;i++){
    var b=envelope[i];
    if(b.rf){
      b.rf.t=times.subarray(b.rf.o,b.rf.o+b.rf.n);
      b.rf.m=values.subarray(b.rf.o,b.rf.o+b.rf.n);
      b.rf.pt=times.subarray(b.rf.qo,b.rf.qo+b.rf.qn);
      b.rf.p=values.subarray(b.rf.qo,b.rf.qo+b.rf.qn);
    }
    if(b.gx)attachGradientSamples(b.gx,times,values);
    if(b.gy)attachGradientSamples(b.gy,times,values);
    if(b.gz)attachGradientSamples(b.gz,times,values);
  }
  return envelope;
}

function attachGradientSamples(gradient,times,values){
  gradient.t=times.subarray(gradient.o,gradient.o+gradient.n);
  gradient.w=values.subarray(gradient.o,gradient.o+gradient.n);
}

/* ── Base64 Float32 payloads ─────────────────────────────────────────────
   K-space ADC arrays, PNS series, spectrogram matrices and audio buffers all
   cross the VS Code boundary this way: Float32 is enough precision for every
   one of them, and base64 is roughly a third the size of the JSON numbers. */

/** Decode a base64 Float32 blob into a typed array of `n` values. */
function decodeB64F32(b64,n){
  var bin=atob(b64),len=bin.length,b=new Uint8Array(len);
  for(var i=0;i<len;i++)b[i]=bin.charCodeAt(i);
  return new Float32Array(b.buffer,0,n);
}

/** Rehydrate a serialized spectrogram into the shape panel.js renders. */
function deserializeSpectrogram(payload){
  if(!payload)return null;
  var cells=payload.nTime*payload.nFreq;
  return{
    nTime:payload.nTime,nFreq:payload.nFreq,
    tStartSec:payload.tStartSec,tStepSec:payload.tStepSec,
    fStartHz:payload.fStartHz,fStepHz:payload.fStepHz,
    dtResolutionSec:payload.dtResolutionSec,dfResolutionHz:payload.dfResolutionHz,
    unit:payload.unit,source:payload.source,
    data:{
      gx:decodeB64F32(payload.gxB64,cells),
      gy:decodeB64F32(payload.gyB64,cells),
      gz:decodeB64F32(payload.gzB64,cells),
      rss:decodeB64F32(payload.rssB64,cells)
    },
    minValue:payload.minValue,maxValue:payload.maxValue,
    decimationFactor:payload.decimationFactor,decimatedRateHz:payload.decimatedRateHz,
    windowSamples:payload.windowSamples,hopSamples:payload.hopSamples,fftPoints:payload.fftPoints,
    requestedStartSec:payload.requestedStartSec,requestedEndSec:payload.requestedEndSec,
    warnings:payload.warnings||[]
  };
}

/** Rehydrate a serialized stereo gradient-sound buffer. */
function deserializeGradientSound(payload){
  if(!payload)return null;
  return{
    sampleRate:payload.sampleRate,
    n:payload.n,
    startSec:payload.startSec,
    endSec:payload.endSec,
    silent:!!payload.silent,
    left:decodeB64F32(payload.leftB64,payload.n),
    right:decodeB64F32(payload.rightB64,payload.n)
  };
}
