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

/* ── Viewport waveform detail ─────────────────────────────────────────────
   The initial payload is one bounded overview of the whole sequence: every
   waveform is reduced to at most a few hundred points so a large sequence can
   cross the transport at all.  That is the right trade for the first paint and
   for wide views, but it is irreversible — zooming into 0.5 ms of a 48 ms
   readout leaves the renderer connecting a handful of surviving extrema, which
   draws as straight polygonal segments instead of the real waveform.

   So when the view is zoomed far enough that it holds fewer transported
   samples than it has pixels, the host is asked to decode that block range
   again and reduce it against the visible interval instead of the whole event.
   The reply replaces only the blocks it covers, and only while it covers the
   view; everything outside keeps the overview.  Requests are debounced so a
   drag issues one decode at rest rather than one per frame, and each reply
   carries the sequence generation it was packed from so a load that lands
   mid-flight cannot paint the previous sequence's samples. */

/** Detail currently held: {blocks,startBlock,endBlock,startSec,endSec,generation}. */
var waveformDetail = null;
/** Set for the duration of one drawBlocks pass when detail covers the view. */
var activeWaveformDetail = null;
var waveformDetailPending = null;
var waveformDetailTimer = 0;
var waveformDetailRequestId = 0;
/** Bumped by the host on every sequence load; stale replies are dropped. */
var waveformDetailGeneration = 0;
/**
 * Installed by each host: VS Code posts a message to the extension, the
 * standalone web app packs the range in this same heap.  Receives
 * {requestId, generation, startSec, endSec, pointBudget}.
 */
var requestWaveformDetailWindow = null;
/**
 * Installed by each host to surface a detail failure.  This bundle's notice
 * state is not what the standalone web app renders, so the message has to go
 * back out to whichever viewer is actually on screen.
 */
var waveformDetailNotice = null;

function reportWaveformDetail(message){
  if(typeof waveformDetailNotice==='function')waveformDetailNotice(message);
}

var WAVEFORM_DETAIL_DEBOUNCE_MS = 160;
/**
 * Refetch once the held window is this many times wider than the view.
 *
 * Time coverage alone is not enough: a window fetched for a 5 ms view still
 * covers a 0.5 ms view, so without this the detail would freeze at whatever
 * zoom first requested it and never sharpen as the user keeps zooming in.  A
 * fresh request pads to 1.5x the view, comfortably inside this bound, so
 * refetching settles in one step instead of oscillating.
 */
var WAVEFORM_DETAIL_REFINE_FACTOR = 2;
/**
 * Stop asking for detail once the view already holds this many transported
 * samples per pixel.  Below it the curve is being drawn from fewer samples than
 * the screen could show, which is exactly when a finer window helps.
 */
var WAVEFORM_DETAIL_TRIGGER_PPP = 4;
/**
 * Total detail samples to ask for, per pixel of plot width, shared across every
 * curve in the window.  Generous because most events in a window are short and
 * keep far fewer samples than their share, which leaves the long readouts —
 * the ones that actually looked wrong — enough points to draw smoothly.
 */
var WAVEFORM_DETAIL_VIEW_POINTS = 32;
/** Mirrors the host's block ceiling so a hopeless request is never sent. */
var WAVEFORM_DETAIL_BLOCK_LIMIT = 20000;

/**
 * Discard detail and in-flight requests; call whenever BL is replaced.
 *
 * VS Code passes the extension host's own sequence generation so both sides
 * agree on which load a reply belongs to; the standalone web app owns the
 * counter itself and just advances it.
 */
function resetWaveformDetail(generation){
  waveformDetail=null;activeWaveformDetail=null;waveformDetailPending=null;
  clearTimeout(waveformDetailTimer);waveformDetailTimer=0;
  waveformDetailGeneration=(typeof generation==='number'&&isFinite(generation))
    ?generation:waveformDetailGeneration+1;
}

function waveformDetailCovers(detail,vs,ve){
  return !!(detail&&detail.generation===waveformDetailGeneration
    &&detail.startSec<=vs+1e-12&&detail.endSec>=ve-1e-12);
}

/**
 * Whether a window is not just valid for this view but sharp enough for it.
 * A window far wider than the view spent most of its point budget off screen.
 */
function waveformWindowServes(win,vs,ve){
  if(!waveformDetailCovers(win,vs,ve))return false;
  return (win.endSec-win.startSec)<=(ve-vs)*WAVEFORM_DETAIL_REFINE_FACTOR;
}

/**
 * The block the renderer should draw for index `bi`.  Detail blocks carry the
 * same identity and timing as their overview counterparts and differ only in
 * waveform resolution, so substituting one is transparent to every caller.
 *
 * `blocks` is passed in rather than read from a global because the standalone
 * web app runs its renderer inside an IIFE with its own `BL`; every function
 * this bundle shares with it has to take the state it operates on.
 */
function blockAt(blocks,bi){
  var detail=activeWaveformDetail;
  if(detail&&bi>=detail.startBlock&&bi<detail.endBlock){
    var block=detail.blocks[bi-detail.startBlock];
    if(block)return block;
  }
  return blocks[bi];
}

/**
 * Decide whether detail applies to this view and, if it would help, ask for it.
 * Returns the detail to draw from, or null to keep the overview.
 */
function waveformDetailForView(vs,ve,visiblePoints,pixelBudget,startBlock,endBlock,pointBudget){
  // Draw from any detail that covers the view, even while a sharper window is
  // in flight: coarse detail still beats the whole-sequence overview.
  activeWaveformDetail=waveformDetailCovers(waveformDetail,vs,ve)?waveformDetail:null;
  // Without detail, too few transported samples per pixel means the view is
  // showing reduced data where it has room for more.  With detail, keep
  // sharpening while the held window stays wider than the view deserves.
  var wants=activeWaveformDetail
    ?!waveformWindowServes(waveformDetail,vs,ve)
    :visiblePoints<pixelBudget*WAVEFORM_DETAIL_TRIGGER_PPP;
  if(wants&&endBlock-startBlock<=WAVEFORM_DETAIL_BLOCK_LIMIT)scheduleWaveformDetail(vs,ve,pointBudget);
  return activeWaveformDetail;
}

function scheduleWaveformDetail(vs,ve,pointBudget){
  if(typeof requestWaveformDetailWindow!=='function'||!(ve>vs))return;
  var pad=(ve-vs)*0.25,start=Math.max(0,vs-pad),end=ve+pad;
  // Same adequacy test as the held detail, so an in-flight wide request cannot
  // suppress the narrower one a deeper zoom now needs.
  if(waveformWindowServes(waveformDetailPending,vs,ve))return;
  clearTimeout(waveformDetailTimer);
  waveformDetailTimer=setTimeout(function(){
    waveformDetailPending={startSec:start,endSec:end,generation:waveformDetailGeneration};
    waveformDetailRequestId++;
    try{
      requestWaveformDetailWindow({
        requestId:waveformDetailRequestId,
        generation:waveformDetailGeneration,
        startSec:start,endSec:end,
        pointBudget:pointBudget
      });
    }catch(err){waveformDetailPending=null;
      reportWaveformDetail('Waveform detail was not calculated: '+(err&&err.message||String(err))+'.');}
  },WAVEFORM_DETAIL_DEBOUNCE_MS);
}

/** Accept a detail reply. Ignores stale generations and superseded requests. */
function applyWaveformDetail(payload){
  if(!payload||payload.generation!==waveformDetailGeneration)return false;
  if(payload.requestId!==waveformDetailRequestId)return false;
  waveformDetailPending=null;
  waveformDetail={
    blocks:payload.blocks,startBlock:payload.startBlock,endBlock:payload.endBlock,
    startSec:payload.startSec,endSec:payload.endSec,generation:payload.generation
  };
  reportWaveformDetail(null);
  return true;
}

/**
 * Record a failed detail request without discarding the overview.  Checks the
 * request id as well as the generation so a superseded failure cannot clear a
 * newer in-flight request or leave a notice about a window nobody is viewing.
 */
function failWaveformDetail(payload){
  if(!payload||payload.generation!==waveformDetailGeneration)return;
  if(payload.requestId!==waveformDetailRequestId)return;
  waveformDetailPending=null;
  reportWaveformDetail('Waveform detail was not calculated: '+(payload.message||'unknown error')+'.');
}
