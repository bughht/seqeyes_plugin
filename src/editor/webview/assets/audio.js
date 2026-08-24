/* ═══════════════════════════════════════════════════════════════════════
   Simulated gradient sound playback

   Pure module: no host globals. One lazily created AudioContext, constructed
   and resumed inside the play button's click handler so the autoplay policy
   is satisfied (this works inside a VS Code webview too).

   The playhead is driven by `AudioContext.currentTime`, never by Date.now()
   or a frame counter — it is the only clock that stays aligned with what is
   actually coming out of the speakers.

   `setClock` lets tests inject a fake clock so CI needs no audio device.
   ═══════════════════════════════════════════════════════════════════════ */

var SeqEyesAudio = (function () {
  var ctx = null;
  var buffer = null;
  var source = null;
  var gainNode = null;
  var available = null;

  var state = 'idle';            // 'idle' | 'playing' | 'paused'
  var volume = 0.7;
  var muted = false;

  var bufferStartSeqSec = 0;     // sequence time of buffer sample 0
  var playOffsetSec = 0;         // offset into the buffer where playback began
  var startCtxTime = 0;          // ctx.currentTime at the last start()
  var pausedAtSec = 0;           // offset into the buffer when paused
  var loopUntilSec = 0;          // remaining playback length for this source
  var playbackTotalSec = 0;      // full audition length, including short-window repeats
  var playedBeforeSec = 0;       // audition time accumulated before the current source
  var loopStartSec = 0;          // stable loop boundary; pause/resume must not move it
  var onEndedCallback = null;

  var clock = null;              // injected test clock, seconds

  function now() {
    if (clock) return clock();
    return ctx ? ctx.currentTime : 0;
  }

  function contextClass() {
    if (typeof window === 'undefined') return null;
    return window.AudioContext || window.webkitAudioContext || null;
  }

  /** True when this host can play audio at all (R13 graceful degradation). */
  function isAvailable() {
    if (available === null) available = !!contextClass();
    return available;
  }

  /** Must be called from inside a user gesture the first time. */
  function ensureContext() {
    if (ctx) {
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      return ctx;
    }
    var Ctor = contextClass();
    if (!Ctor) { available = false; return null; }
    try {
      ctx = new Ctor();
      gainNode = ctx.createGain();
      gainNode.gain.value = muted ? 0 : volume;
      gainNode.connect(ctx.destination);
      available = true;
    } catch (err) {
      available = false;
      ctx = null;
    }
    return ctx;
  }

  /**
   * Install a stereo buffer.
   * `startSeqSec` is the sequence time of sample 0, so the playhead can be
   * reported in sequence time rather than buffer time.
   */
  function load(sampleRate, left, right, startSeqSec) {
    if (!ensureContext()) return false;
    var frames = Math.min(left.length, right.length);
    if (!frames) return false;
    try {
      buffer = ctx.createBuffer(2, frames, sampleRate);
      buffer.getChannelData(0).set(left.subarray ? left.subarray(0, frames) : left);
      buffer.getChannelData(1).set(right.subarray ? right.subarray(0, frames) : right);
    } catch (err) {
      buffer = null;
      return false;
    }
    bufferStartSeqSec = isFinite(startSeqSec) ? startSeqSec : 0;
    pausedAtSec = 0;
    playbackTotalSec = 0;
    playedBeforeSec = 0;
    loopStartSec = 0;
    return true;
  }

  function hasBuffer() { return !!buffer; }

  function bufferDurationSec() { return buffer ? buffer.duration : 0; }

  /**
   * Start (or restart) playback at `offsetSec` into the buffer.
   *
   * `totalSec` extends a short window by looping — per D4, a window under
   * 250 ms is looped until roughly a second has played, because a 40 ms blip
   * is not audible as anything.
   */
  function play(offsetSec, totalSec) {
    if (!buffer || !ensureContext()) return false;
    var resuming = state === 'paused';
    stopSource();
    var offset = Math.max(0, Math.min(buffer.duration, isFinite(offsetSec) ? offsetSec : 0));
    if (!resuming) {
      playedBeforeSec = 0;
      playbackTotalSec = Math.max(buffer.duration,
        isFinite(totalSec) && totalSec > 0 ? totalSec : buffer.duration);
      loopStartSec = 0;
    }
    loopUntilSec = Math.max(0, playbackTotalSec - playedBeforeSec);
    if (!(loopUntilSec > 0)) {
      state = 'idle';
      pausedAtSec = 0;
      return false;
    }
    var remaining = buffer.duration - offset;

    source = ctx.createBufferSource();
    source.buffer = buffer;
    if (loopUntilSec > remaining) {
      source.loop = true;
      source.loopStart = loopStartSec;
      source.loopEnd = buffer.duration;
    }
    source.connect(gainNode);
    source.onended = function () {
      if (state === 'playing') {
        state = 'idle';
        pausedAtSec = 0;
        playedBeforeSec = 0;
        playbackTotalSec = 0;
        source = null;
        if (onEndedCallback) onEndedCallback();
      }
    };
    startCtxTime = now();
    playOffsetSec = offset;
    state = 'playing';
    try {
      if (source.loop) source.start(0, offset, loopUntilSec);
      else source.start(0, offset);
    } catch (err) {
      state = 'idle';
      return false;
    }
    // A looping node never fires `ended` on its own, so cap it explicitly.
    if (source.loop && source.stop) {
      try { source.stop(ctx.currentTime + loopUntilSec); } catch (err) { /* best effort */ }
    }
    return true;
  }

  function stopSource() {
    if (!source) return;
    source.onended = null;
    try { source.stop(); } catch (err) { /* already stopped */ }
    try { source.disconnect(); } catch (err) { /* already detached */ }
    source = null;
  }

  function pause() {
    if (state !== 'playing') return;
    pausedAtSec = currentBufferOffsetSec();
    playedBeforeSec = Math.min(playbackTotalSec,
      playedBeforeSec + Math.max(0, now() - startCtxTime));
    stopSource();
    state = 'paused';
  }

  function stop() {
    stopSource();
    state = 'idle';
    pausedAtSec = 0;
    playedBeforeSec = 0;
    playbackTotalSec = 0;
    loopUntilSec = 0;
  }

  /** Offset into the buffer right now, wrapped when looping. */
  function currentBufferOffsetSec() {
    if (state === 'paused') return pausedAtSec;
    if (state !== 'playing' || !buffer) return pausedAtSec;
    var elapsed = Math.max(0, now() - startCtxTime);
    var offset = playOffsetSec + elapsed;
    if (source && source.loop && buffer.duration > loopStartSec) {
      var span = buffer.duration - loopStartSec;
      if (span > 0) offset = loopStartSec + ((playOffsetSec - loopStartSec + elapsed) % span);
    }
    return Math.min(buffer.duration, offset);
  }

  /** Playhead in *sequence* time — what the marker and the spectrum use. */
  function currentTimeSec() {
    return bufferStartSeqSec + currentBufferOffsetSec();
  }

  function isPlaying() { return state === 'playing'; }
  function getState() { return state; }

  function setVolume(value) {
    volume = Math.max(0, Math.min(1, value));
    if (gainNode) gainNode.gain.value = muted ? 0 : volume;
  }
  function getVolume() { return volume; }

  function setMuted(value) {
    muted = !!value;
    if (gainNode) gainNode.gain.value = muted ? 0 : volume;
  }
  function isMuted() { return muted; }

  function onEnded(callback) { onEndedCallback = callback; }

  /** Inject a clock for tests; pass null to return to the audio clock. */
  function setClock(fn) { clock = typeof fn === 'function' ? fn : null; }

  /** Release the audio device — VS Code should not leak one on dispose. */
  function dispose() {
    stopSource();
    buffer = null;
    state = 'idle';
    if (ctx && ctx.close) { try { ctx.close(); } catch (err) { /* best effort */ } }
    ctx = null;
    gainNode = null;
  }

  return {
    isAvailable: isAvailable,
    ensureContext: ensureContext,
    load: load,
    hasBuffer: hasBuffer,
    bufferDurationSec: bufferDurationSec,
    play: play,
    pause: pause,
    stop: stop,
    currentTimeSec: currentTimeSec,
    currentBufferOffsetSec: currentBufferOffsetSec,
    isPlaying: isPlaying,
    getState: getState,
    setVolume: setVolume,
    getVolume: getVolume,
    setMuted: setMuted,
    isMuted: isMuted,
    onEnded: onEnded,
    setClock: setClock,
    dispose: dispose
  };
})();
