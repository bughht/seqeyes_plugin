/* ═══════════════════════════════════════════════════════════════════════
   Analysis panel — mode state machine, layout, controls

   The one host-aware module of the spectrogram feature. It never touches host
   globals directly; each host registers an adapter on `window.SeqEyesPanelHost`
   and calls `SeqEyesPanel.install(host)`. That is what lets `web/index.html`
   drive the same code the VS Code webview does instead of growing another
   copy of it.

   Because the bundle also loads inside `web/index.html` (whose inline IIFE
   installs its own adapter afterwards), `install()` is idempotent: it swaps
   the active host and wires the DOM only once, and every handler reads the
   host at call time.
   ═══════════════════════════════════════════════════════════════════════ */

var panelMode = 'off';          // 'off' | 'kspace' | 'spectrogram'
var panelOpen = false;          // read by applyLayoutMode() in state.js

var SeqEyesPanel = (function () {
  var host = null;
  var wired = false;

  /* ── Persistence ──────────────────────────────────────────────────── */
  function get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode */ } }
  function getNum(key, fallback) {
    var raw = get(key);
    var value = raw === null ? NaN : parseFloat(raw);
    return isFinite(value) ? value : fallback;
  }
  function getBool(key, fallback) {
    var raw = get(key);
    return raw === null ? fallback : raw === '1';
  }

  /* ── Parameters and view state ────────────────────────────────────── */
  var params = {
    source: get('seqeyes.spectrogram.source') === 'dGdt' ? 'dGdt' : 'G',
    fMinHz: getNum('seqeyes.spectrogram.fmin', 0),
    fMaxHz: getNum('seqeyes.spectrogram.fmax', 3000),
    windowSamples: getNum('seqeyes.spectrogram.window', 0),
    overlap: getNum('seqeyes.spectrogram.overlap', 0.75),
    oversample: getNum('seqeyes.spectrogram.oversample', 3),
    targetColumns: 256,
    normalize: true
  };
  var colormapName = get('seqeyes.spectrogram.colormap') || 'viridis';
  if (SG_COLORMAP_NAMES.indexOf(colormapName) < 0) colormapName = 'viridis';

  var traces = [
    { key: 'gx', label: 'Gx', varName: '--gx', visible: getBool('seqeyes.spectrogram.trace.gx', true) },
    { key: 'gy', label: 'Gy', varName: '--gy', visible: getBool('seqeyes.spectrogram.trace.gy', true) },
    { key: 'gz', label: 'Gz', varName: '--gz', visible: getBool('seqeyes.spectrogram.trace.gz', true) },
    { key: 'rss', label: 'Σ', varName: '--fg', visible: getBool('seqeyes.spectrogram.trace.rss', true) }
  ];
  var freeY = getBool('seqeyes.spectrogram.freeY', false);
  var bandsVisible = getBool('seqeyes.spectrogram.bands', true);

  var currentSpec = null;
  var currentView = { startSec: 0, endSec: 0 };
  var frequencyRange = { fMin: params.fMinHz, fMax: params.fMaxHz };
  var windowLevel = { level: -40, width: 60 };
  var windowLevelAuto = true;
  var acousticBands = [];
  var hotBands = [];
  var markerTimeSec = NaN;
  var playheadTimeSec = NaN;
  var hover = null;
  var busy = false;
  var lastError = null;

  var requestId = 0;
  var pendingRequestId = 0;
  var debounceTimer = 0;
  var cache = [];
  var computeCount = 0;         // asserted by the perf tests
  var renderCount = 0;
  var requestStartedAt = 0;     // performance.now() when the request issued
  var lastRedrawMs = 0;         // issue -> painted, excluding the debounce
  var redrawSamples = [];

  var audioRequestId = 0;
  var pendingAudioId = 0;
  var audioWindow = null;       // buffered range plus the first-pass offset
  var playheadFrame = 0;

  var AUDIO_SAMPLE_RATE = 44100;
  var AUDIO_SAMPLE_VALUE_LIMIT = 5400000;
  var AUDIO_PREVIEW_MAX_SEC = 30;
  var AUDIO_FULL_RANGE_MAX_SEC = (AUDIO_SAMPLE_VALUE_LIMIT / 2 - 1) / AUDIO_SAMPLE_RATE;
  var AUDIO_LOOP_THRESHOLD_SEC = 0.25;
  var AUDIO_LOOP_TARGET_SEC = 1.0;

  var imageCache = null;
  var imageDirty = true;
  var offscreen = null;

  /* ── DOM ──────────────────────────────────────────────────────────── */
  function el(id) { return document.getElementById(id); }

  /* ── Host access ──────────────────────────────────────────────────── */
  function activeHost() { return host || window.SeqEyesPanelHost || null; }
  function layoutMode() {
    var h = activeHost();
    return h && h.getLayoutMode ? h.getLayoutMode() : 'horizontal';
  }
  function timeUnit() {
    var h = activeHost();
    return h && h.getTimeUnit ? h.getTimeUnit() : 'ms';
  }
  function hostView() {
    var h = activeHost();
    if (h && h.getView) return h.getView();
    return { startSec: 0, endSec: 0, totalDuration: 0 };
  }
  function notice(key, message) {
    var h = activeHost();
    if (h && h.setNotice) h.setNotice(key, message);
  }

  /* ── Mode state machine (R1) ──────────────────────────────────────── */

  var MODE_LABELS = {
    off: { text: 'K-Space / Spectrum', title: 'Show the k-space trajectory' },
    kspace: { text: 'K-Space ▸ Spectrogram', title: 'Switch to the gradient spectrogram' },
    spectrogram: { text: 'Spectrogram ✕', title: 'Close the panel' }
  };

  function updateButton() {
    var button = el('panelBtn');
    if (!button) return;
    var label = MODE_LABELS[panelMode] || MODE_LABELS.off;
    button.textContent = label.text;
    button.title = label.title;
    button.setAttribute('aria-pressed', panelMode === 'off' ? 'false' : 'true');
    button.setAttribute('aria-label', panelMode === 'off'
      ? 'Analysis panel closed. Show the k-space trajectory.'
      : (panelMode === 'kspace'
        ? 'K-space trajectory shown. Switch to the gradient spectrogram.'
        : 'Gradient spectrogram shown. Close the analysis panel.'));
  }

  function applyPanelGeometry() {
    var right = el('right');
    if (!right) return;
    var vertical = layoutMode() === 'vertical';
    if (panelOpen) {
      right.classList.add('open');
      if (vertical) {
        right.style.setProperty('height', panelSizeVertical() + 'px', 'important');
        right.style.setProperty('width', '100%', 'important');
      } else {
        right.style.width = panelSizeHorizontal() + 'px';
      }
    } else {
      right.classList.remove('open');
      if (vertical) right.style.setProperty('height', '0', 'important');
      else right.style.width = '';
    }
  }

  function panelSizeHorizontal() { return getNum('seqeyes.panelWidth', 500); }
  function panelSizeVertical() { return getNum('seqeyes.panelHeight', 300); }

  /**
   * Enter a mode.
   *
   * The k-space safety gate applies only to `off -> kspace`: the spectrogram
   * is view-windowed and cheap, so it must stay reachable on sequences where
   * k-space is refused.
   */
  function setMode(mode, options) {
    if (mode !== 'off' && mode !== 'kspace' && mode !== 'spectrogram') mode = 'off';
    var h = activeHost();

    if (mode === 'kspace') {
      var noData = !h || !h.hasKspaceData || !h.hasKspaceData();
      if (noData && h && h.showKspaceSafetyDialog && h.showKspaceSafetyDialog()) return panelMode;
    }
    if (panelMode === mode) return panelMode;

    if (panelMode === 'spectrogram' && mode !== 'spectrogram') stopPlayback();

    var previous = panelMode;
    panelMode = mode;
    panelOpen = mode !== 'off';
    kOpen = mode === 'kspace';

    if (h && h.refreshLayout) h.refreshLayout();

    var kpane = el('kpane');
    var spane = el('spane');
    if (kpane) kpane.classList.toggle('on', mode === 'kspace');
    if (spane) spane.classList.toggle('on', mode === 'spectrogram');

    applyPanelGeometry();
    updateButton();
    set('seqeyes.panelMode', mode);

    if (mode === 'kspace') {
      if (h && h.requestKspace) h.requestKspace();
      if (h && h.onKspaceShown) requestAnimationFrame(function () { h.onKspaceShown(); });
    } else if (previous === 'kspace') {
      if (h && h.onKspaceHidden) requestAnimationFrame(function () { h.onKspaceHidden(); });
    }

    if (mode === 'spectrogram') {
      applySplit();
      requestAnimationFrame(function () { resize(); requestSpectrogram(true); });
    }
    return panelMode;
  }

  function cycle() {
    if (panelMode === 'off') return setMode('kspace');
    if (panelMode === 'kspace') return setMode('spectrogram');
    return setMode('off');
  }

  /* ── Split (R5, R6) ───────────────────────────────────────────────── */

  function splitStorageKey() { return 'seqeyes.spectrogramSplit.' + layoutMode(); }

  function splitRatio() {
    var value = getNum(splitStorageKey(), 0.75);   // 3:1 default
    return Math.max(0.15, Math.min(0.85, value));
  }

  function applySplit() {
    var sgPane = el('sgPane');
    var spPane = el('spPane');
    if (!sgPane || !spPane) return;
    var ratio = splitRatio();
    sgPane.style.flex = ratio + ' 1 0%';
    spPane.style.flex = (1 - ratio) + ' 1 0%';
  }

  function setSplitRatio(ratio) {
    set(splitStorageKey(), String(Math.max(0.15, Math.min(0.85, ratio))));
    applySplit();
    resize();
  }

  /* ── Canvas sizing ────────────────────────────────────────────────── */

  function sizeCanvas(canvas, rect, dpr) {
    if (!canvas) return false;
    var width = Math.max(1, Math.round(rect.width * dpr));
    var height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width === width && canvas.height === height) return false;
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    return true;
  }

  function resize() {
    if (panelMode !== 'spectrogram') return;
    var dpr = window.devicePixelRatio || 1;
    var sgPane = el('sgPane');
    var spPane = el('spPane');
    if (!sgPane || !spPane) return;
    var sgRect = sgPane.getBoundingClientRect();
    var spRect = spPane.getBoundingClientRect();
    if (sgRect.width <= 0 || sgRect.height <= 0) return;

    var changed = false;
    changed = sizeCanvas(el('sgImg'), sgRect, dpr) || changed;
    changed = sizeCanvas(el('sgOvl'), sgRect, dpr) || changed;
    changed = sizeCanvas(el('spCanvas'), spRect, dpr) || changed;
    if (changed) imageDirty = true;

    // Column budget follows the pane width in device pixels (§5.4), quantised
    // to 32: it is part of the cache key, so tracking every pixel of the
    // open/resize animation would invalidate a perfectly good matrix.
    var target = Math.max(64, Math.min(512, Math.round(sgRect.width * dpr / 64) * 32));
    if (target !== params.targetColumns) {
      params.targetColumns = target;
    }
    render();
  }

  /* ── Spectrogram requests (R4) ────────────────────────────────────── */

  function paramsSignature() {
    return [params.source, params.fMaxHz, params.windowSamples, params.overlap,
      params.oversample, params.targetColumns, params.normalize ? 1 : 0].join('|');
  }

  function cacheKey(startSec, endSec) {
    return [Math.round(startSec * 1e9), Math.round(endSec * 1e9), paramsSignature()].join('#');
  }

  function cacheGet(key) {
    for (var i = 0; i < cache.length; i++) if (cache[i].key === key) return cache[i].spec;
    return null;
  }

  function cachePut(key, spec) {
    for (var i = 0; i < cache.length; i++) {
      if (cache[i].key === key) { cache[i].spec = spec; return; }
    }
    cache.push({ key: key, spec: spec });
    while (cache.length > 8) cache.shift();
  }

  function clearCache() { cache = []; }

  /** Debounced request; an unchanged view served from cache never recomputes. */
  function requestSpectrogram(immediate) {
    if (panelMode !== 'spectrogram') return;
    clearTimeout(debounceTimer);
    if (immediate) { issueRequest(); return; }
    debounceTimer = setTimeout(issueRequest, 120);
  }

  function issueRequest() {
    if (panelMode !== 'spectrogram') return;
    var h = activeHost();
    if (!h || !h.requestSpectrogram) return;
    var view = hostView();
    if (!(view.endSec > view.startSec)) return;
    currentView = { startSec: view.startSec, endSec: view.endSec };

    var key = cacheKey(view.startSec, view.endSec);
    var cached = cacheGet(key);
    if (cached) {
      pendingRequestId = 0;
      setBusy(false);
      applySpectrogram(cached);
      return;
    }

    pendingRequestId = ++requestId;
    setBusy(true);
    computeCount++;
    // Measured from here rather than from the view change: the 120 ms
    // debounce is a deliberate wait, not redraw cost.
    requestStartedAt = now();
    h.requestSpectrogram(pendingRequestId, view.startSec, view.endSec, {
      source: params.source,
      fMinHz: 0,                       // always compute from DC; fMin only crops
      fMaxHz: params.fMaxHz,
      windowSamples: params.windowSamples,
      overlap: params.overlap,
      oversample: params.oversample,
      targetColumns: params.targetColumns,
      normalize: params.normalize,
      trTimeSec: h.getTrTimeSec ? h.getTrTimeSec() : 0
    });
  }

  function setBusy(value) {
    busy = !!value;
    var pane = el('sgPane');
    if (pane) pane.classList.toggle('busy', busy);
  }

  function deliverSpectrogram(id, spec) {
    if (id !== pendingRequestId) return;   // stale or explicitly invalidated
    pendingRequestId = 0;
    setBusy(false);
    lastError = null;
    if (!spec) return;
    cachePut(cacheKey(spec.requestedStartSec, spec.requestedEndSec), spec);
    applySpectrogram(spec);
  }

  function deliverSpectrogramError(id, message) {
    if (id !== pendingRequestId) return;
    pendingRequestId = 0;
    setBusy(false);
    currentSpec = null;
    averageCache = null;
    imageCache = null;
    imageDirty = true;
    hotBands = [];
    playheadTimeSec = NaN;
    hover = null;
    lastError = message || 'The spectrogram could not be calculated.';
    notice('spectrogram', lastError);
    render();
  }

  function applySpectrogram(spec) {
    currentSpec = spec;
    currentView = { startSec: spec.requestedStartSec, endSec: spec.requestedEndSec };
    if (windowLevelAuto) windowLevel = sgAutoWindowLevel(spec, 'rss');
    clampFrequencyRange();
    imageDirty = true;
    hotBands = sgDetectHotBands(spec, acousticBands, windowLevel, 'rss');
    publishNotices();
    render();
    if (requestStartedAt) {
      lastRedrawMs = now() - requestStartedAt;
      requestStartedAt = 0;
      redrawSamples.push(lastRedrawMs);
      if (redrawSamples.length > 64) redrawSamples.shift();
    }
  }

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function clampFrequencyRange() {
    var specMax = currentSpec && currentSpec.nFreq
      ? currentSpec.fStartHz + (currentSpec.nFreq - 1) * currentSpec.fStepHz
      : params.fMaxHz;
    var fMin = Math.max(0, Math.min(params.fMinHz, specMax - 1));
    var fMax = Math.min(params.fMaxHz, specMax);
    if (!(fMax > fMin)) fMax = fMin + 1;
    frequencyRange = { fMin: fMin, fMax: fMax };
  }

  /* ── Notices ──────────────────────────────────────────────────────── */

  function publishNotices() {
    var messages = [];
    if (currentSpec && currentSpec.warnings) {
      for (var i = 0; i < currentSpec.warnings.length; i++) messages.push(currentSpec.warnings[i]);
    }
    var outside = 0;
    for (var b = 0; b < acousticBands.length; b++) {
      if (acousticBands[b].freqHz < frequencyRange.fMin || acousticBands[b].freqHz > frequencyRange.fMax) outside++;
    }
    if (outside) {
      messages.push(outside + ' resonance band' + (outside === 1 ? ' is' : 's are')
        + ' outside the displayed frequency range.');
    }
    var anyHot = false;
    for (var k = 0; k < hotBands.length; k++) if (hotBands[k]) anyHot = true;
    if (anyHot) {
      messages.push('Gradient energy falls inside a forbidden acoustic band (advisory: '
        + 'this compares against the current display window, and is not a compliance check).');
    }
    notice('spectrogram', messages.length ? messages : null);
  }

  /* ── Rendering ────────────────────────────────────────────────────── */

  function render() {
    if (panelMode !== 'spectrogram') return;
    renderCount++;
    var css = getComputedStyle(document.body);
    var dpr = window.devicePixelRatio || 1;
    var img = el('sgImg');
    var ovl = el('sgOvl');
    if (!img || !ovl) return;

    var width = ovl.width / dpr;
    var height = ovl.height / dpr;
    var leftMargin = leftMarginForLayout();
    var rect = sgPlotRect(width, height, leftMargin);
    var lut = sgColormapLut(colormapName, css);

    // Image layer: rebuilt only when the data, colormap or window/level move.
    var imgCtx = img.getContext('2d');
    imgCtx.setTransform(1, 0, 0, 1, 0, 0);
    imgCtx.clearRect(0, 0, img.width, img.height);
    if (currentSpec && currentSpec.nTime) {
      var pixelW = Math.max(1, Math.round(rect.w * dpr));
      var pixelH = Math.max(1, Math.round(rect.h * dpr));
      if (imageDirty || !imageCache || imageCache.width !== pixelW || imageCache.height !== pixelH) {
        imageCache = sgBuildImageData({
          spectrogram: currentSpec,
          channel: 'rss',
          lut: lut,
          windowLevel: windowLevel,
          view: currentView,
          frequencyRange: frequencyRange,
          pixelWidth: pixelW,
          pixelHeight: pixelH,
          reuse: imageCache
        });
        imageDirty = false;
      }
      if (!offscreen) offscreen = document.createElement('canvas');
      if (offscreen.width !== pixelW || offscreen.height !== pixelH) {
        offscreen.width = pixelW;
        offscreen.height = pixelH;
      }
      offscreen.getContext('2d').putImageData(imageCache, 0, 0);
      imgCtx.drawImage(offscreen, Math.round(rect.x * dpr), Math.round(rect.y * dpr));
    }

    renderOverlay(css, dpr, leftMargin);
    renderSpectrum(css, dpr, leftMargin);
    renderReadout();
  }

  /**
   * In vertical layout the panel sits directly under the waveform panel, so
   * it borrows the waveform's left margin and the time columns line up
   * pixel-for-pixel (§6.3). In horizontal layout only the range matches.
   */
  function leftMarginForLayout() {
    var h = activeHost();
    if (layoutMode() !== 'vertical' || !h || !h.getWaveformLeftMargin) return SG_MARGIN.l;
    var margin = h.getWaveformLeftMargin();
    return isFinite(margin) && margin > 0 ? margin : SG_MARGIN.l;
  }

  function renderOverlay(css, dpr, leftMargin) {
    var ovl = el('sgOvl');
    if (!ovl) return;
    var ctx = ovl.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sgDrawOverlay({
      ctx: ctx,
      css: css || getComputedStyle(document.body),
      width: ovl.width / dpr,
      height: ovl.height / dpr,
      dpr: dpr,
      leftMargin: leftMargin,
      spectrogram: currentSpec,
      view: currentView,
      frequencyRange: frequencyRange,
      windowLevel: windowLevel,
      lut: sgColormapLut(colormapName, css || getComputedStyle(document.body)),
      bands: acousticBands,
      showBands: bandsVisible,
      hotBands: hotBands,
      markerTimeSec: markerTimeSec,
      playheadTimeSec: playheadTimeSec,
      hover: hover,
      timeUnit: timeUnit(),
      emptyMessage: lastError || (busy ? 'Calculating…' : 'No spectrogram for this view.')
    });
  }

  function currentSlice() {
    if (!currentSpec || !currentSpec.nTime) return null;
    if (isFinite(playheadTimeSec)) return computeGradientSpectrumSliceLocal(playheadTimeSec);
    if (isFinite(markerTimeSec)) return computeGradientSpectrumSliceLocal(markerTimeSec);
    return sliceAverage();
  }

  /* The slice helpers are re-implemented here rather than imported from the
     TypeScript module: the webview bundle has no module loader, and a row
     copy is cheap enough to duplicate honestly. */
  function computeGradientSpectrumSliceLocal(timeSec) {
    var spec = currentSpec;
    var col = spec.tStepSec > 0
      ? Math.max(0, Math.min(spec.nTime - 1, Math.round((timeSec - spec.tStartSec) / spec.tStepSec)))
      : 0;
    var out = {
      columnIndex: col,
      timeSec: spec.tStartSec + col * spec.tStepSec,
      gx: new Float32Array(spec.nFreq),
      gy: new Float32Array(spec.nFreq),
      gz: new Float32Array(spec.nFreq),
      rss: new Float32Array(spec.nFreq)
    };
    for (var row = 0; row < spec.nFreq; row++) {
      var index = row * spec.nTime + col;
      out.gx[row] = spec.data.gx[index];
      out.gy[row] = spec.data.gy[index];
      out.gz[row] = spec.data.gz[index];
      out.rss[row] = spec.data.rss[index];
    }
    return out;
  }

  var averageCache = null;
  function sliceAverage() {
    var spec = currentSpec;
    if (!spec || !spec.nTime) return null;
    if (averageCache && averageCache.spec === spec) return averageCache.slice;
    var out = {
      columnIndex: -1,
      timeSec: NaN,
      gx: new Float32Array(spec.nFreq),
      gy: new Float32Array(spec.nFreq),
      gz: new Float32Array(spec.nFreq),
      rss: new Float32Array(spec.nFreq)
    };
    for (var row = 0; row < spec.nFreq; row++) {
      var base = row * spec.nTime, ax = 0, ay = 0, az = 0;
      for (var col = 0; col < spec.nTime; col++) {
        var vx = spec.data.gx[base + col], vy = spec.data.gy[base + col], vz = spec.data.gz[base + col];
        ax += vx * vx; ay += vy * vy; az += vz * vz;
      }
      var rx = Math.sqrt(ax / spec.nTime), ry = Math.sqrt(ay / spec.nTime), rz = Math.sqrt(az / spec.nTime);
      out.gx[row] = rx; out.gy[row] = ry; out.gz[row] = rz;
      out.rss[row] = Math.sqrt(rx * rx + ry * ry + rz * rz);
    }
    averageCache = { spec: spec, slice: out };
    return out;
  }

  function renderSpectrum(css, dpr, leftMargin) {
    var canvas = el('spCanvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var slice = currentSlice();
    var style = css || getComputedStyle(document.body);
    var resolved = [];
    for (var i = 0; i < traces.length; i++) {
      resolved.push({
        key: traces[i].key,
        visible: traces[i].visible,
        color: (style.getPropertyValue(traces[i].varName) || '#888').trim()
      });
    }
    sgDrawSpectrum({
      ctx: ctx,
      css: style,
      width: canvas.width / dpr,
      height: canvas.height / dpr,
      orientation: layoutMode(),
      leftMargin: leftMargin,
      spectrogram: currentSpec,
      slice: slice,
      frequencyRange: frequencyRange,
      magnitudeScale: sgSpectrumScale(currentSpec, slice, windowLevel, freeY, resolved),
      traces: resolved,
      bands: acousticBands,
      showBands: bandsVisible,
      hotBands: hotBands
    });
  }

  function renderReadout() {
    var out = el('sgReadout');
    if (!out) return;
    var parts = [];
    if (currentSpec && currentSpec.nTime) {
      parts.push('dt ' + sgFmtResolution(currentSpec.dtResolutionSec));
      parts.push('df ' + sgFmtHz(currentSpec.dfResolutionHz) + ' Hz');
      parts.push('unit ' + currentSpec.unit);
      parts.push('D ' + currentSpec.decimationFactor + '×');
      parts.push(currentSpec.nTime + '×' + currentSpec.nFreq);
      parts.push('W ' + windowLevel.width.toFixed(1) + ' dB  L ' + sgFmtDb(windowLevel.level) + ' dB');
    } else if (busy) {
      parts.push('Calculating…');
    }
    if (isFinite(playheadTimeSec)) parts.push('▶ ' + sgFmtTime(playheadTimeSec, timeUnit()));
    else if (isFinite(markerTimeSec)) parts.push('marker ' + sgFmtTime(markerTimeSec, timeUnit()));
    else if (currentSpec && currentSpec.nTime) {
      parts.push('view average (right-click the spectrogram for a single time point)');
    }
    if (hoverReadout) parts.push(hoverReadout);
    out.textContent = parts.join('   ');
    out.title = 'Simulated gradient spectral content — not calibrated sound pressure level.';
  }

  var hoverReadout = '';

  /* ── Marker (R9) ──────────────────────────────────────────────────── */

  function setMarkerTime(timeSec, options) {
    if (!(options && options.preservePlayback)) stopPlayback();
    if (!isFinite(timeSec)) {
      markerTimeSec = NaN;
    } else if (!(options && options.exact) && currentSpec && currentSpec.nTime && currentSpec.tStepSec > 0) {
      var col = Math.max(0, Math.min(currentSpec.nTime - 1,
        Math.round((timeSec - currentSpec.tStartSec) / currentSpec.tStepSec)));
      markerTimeSec = currentSpec.tStartSec + col * currentSpec.tStepSec;
    } else {
      // Keep transport updates exact. Manual analysis markers still snap above,
      // while spectrum lookup independently snaps every exact transport time.
      markerTimeSec = timeSec;
    }
    var h = activeHost();
    if (h && h.setWaveformMarker) h.setWaveformMarker(isFinite(markerTimeSec) ? markerTimeSec : null);
    syncControls();
    render();
  }

  /* ── Window / level (R8) ──────────────────────────────────────────── */

  function setWindowLevel(width, level) {
    windowLevel = {
      width: Math.max(3, Math.min(200, width)),
      level: level
    };
    windowLevelAuto = false;
    imageDirty = true;
    if (currentSpec) hotBands = sgDetectHotBands(currentSpec, acousticBands, windowLevel, 'rss');
    render();
  }

  function resetWindowLevel() {
    windowLevelAuto = true;
    if (currentSpec) windowLevel = sgAutoWindowLevel(currentSpec, 'rss');
    imageDirty = true;
    if (currentSpec) hotBands = sgDetectHotBands(currentSpec, acousticBands, windowLevel, 'rss');
    render();
  }

  /* ── Frequency range (R3, R4) ─────────────────────────────────────── */

  function setFrequencyRange(fMin, fMax, options) {
    var opts = options || {};
    var lo = Math.max(0, fMin);
    var hi = Math.max(lo + 1, fMax);
    var needsRecompute = hi > params.fMaxHz + 1e-6 || (opts.forceRecompute && hi !== params.fMaxHz);
    params.fMinHz = lo;
    params.fMaxHz = hi;
    set('seqeyes.spectrogram.fmin', String(lo));
    set('seqeyes.spectrogram.fmax', String(hi));
    syncControls();
    clampFrequencyRange();
    imageDirty = true;
    if (needsRecompute) {
      // fMax sets the decimation factor, so raising it needs new data;
      // lowering fMin only re-crops the matrix already in hand.
      clearCache();
      requestSpectrogram(true);
    } else {
      publishNotices();
      render();
    }
  }

  /* ── Audio (R13, R14) ─────────────────────────────────────────────── */

  function audioRange() {
    var view = hostView();
    var tolerance = Math.max(1e-9, Math.abs(view.endSec - view.startSec) * 1e-9);
    var viewSpan = view.endSec - view.startSec;
    var markerInside = isFinite(markerTimeSec)
      && markerTimeSec >= view.startSec - tolerance
      && markerTimeSec < view.endSec - tolerance;
    // Replaying at this view's endpoint wraps to its start. A retained position
    // still resumes normally when a moved viewport contains it in the interior.
    var resumeStart = markerInside ? Math.max(view.startSec, markerTimeSec) : view.startSec;
    // A short audition needs the complete visible buffer so only its first pass
    // starts at the retained position; later repeats return to the window start.
    var loops = viewSpan < AUDIO_LOOP_THRESHOLD_SEC;
    var start = loops ? view.startSec : resumeStart;
    var requestedEnd = view.endSec;
    var boundedPreview = requestedEnd - start > AUDIO_FULL_RANGE_MAX_SEC;
    return {
      startSec: start,
      endSec: boundedPreview ? Math.min(requestedEnd, start + AUDIO_PREVIEW_MAX_SEC) : requestedEnd,
      boundedPreview: boundedPreview,
      initialOffsetSec: loops ? Math.max(0, resumeStart - start) : 0
    };
  }

  function togglePlayback() {
    if (!SeqEyesAudio.isAvailable()) return;
    if (SeqEyesAudio.isPlaying()) { pausePlayback(); return; }

    SeqEyesAudio.ensureContext();   // must happen inside the click handler
    if (SeqEyesAudio.getState() === 'paused' && audioWindow) {
      SeqEyesAudio.play(SeqEyesAudio.currentBufferOffsetSec(), playbackLengthSec(audioWindow));
      startPlayheadLoop();
      syncTransport();
      return;
    }

    var range = audioRange();
    if (!(range.endSec > range.startSec)) {
      notice('gradientSound', 'There is no time range to play. Zoom out or clear the marker.');
      return;
    }
    var h = activeHost();
    if (!h || !h.requestAudio) return;
    pendingAudioId = ++audioRequestId;
    audioWindow = range;
    notice('gradientSound', null);
    h.requestAudio(pendingAudioId, range.startSec, range.endSec, {
      sampleRate: 44100,
      source: params.source,
      channelWeights: [1, 1, 1]
    });
    syncTransport();
  }

  /** D4: complete short-window repeats extend the audition to at least one second. */
  function playbackLengthSec(range) {
    var span = range.endSec - range.startSec;
    var offset = Math.max(0, Math.min(span, range.initialOffsetSec || 0));
    var firstPass = span - offset;
    if (!(span < AUDIO_LOOP_THRESHOLD_SEC)) return firstPass;
    var repeats = Math.max(0, Math.ceil((AUDIO_LOOP_TARGET_SEC - firstPass) / span - 1e-9));
    return firstPass + repeats * span;
  }

  function deliverAudio(id, payload) {
    if (id !== pendingAudioId) return;
    pendingAudioId = 0;
    if (!payload || !payload.left || !payload.left.length) {
      notice('gradientSound', 'No gradient activity in this window — nothing to play.');
      syncTransport();
      return;
    }
    if (payload.silent) {
      notice('gradientSound', 'No gradient activity in this window — nothing to play.');
      syncTransport();
      return;
    }
    if (!SeqEyesAudio.load(payload.sampleRate, payload.left, payload.right, payload.startSec)) {
      notice('gradientSound', 'This host could not create an audio buffer.');
      syncTransport();
      return;
    }
    var range = audioWindow || audioRange();
    var span = range.endSec - range.startSec;
    if (range.boundedPreview) {
      notice('gradientSound', 'Playing a ' + AUDIO_PREVIEW_MAX_SEC + ' s preview because the visible window exceeds the '
        + AUDIO_FULL_RANGE_MAX_SEC.toFixed(1) + ' s interactive audio limit. '
        + 'Simulated gradient sound — not calibrated.');
    } else if (span < 0.25) {
      notice('gradientSound', 'Window is ' + Math.round(span * 1000) + ' ms; looping. '
        + 'Simulated gradient sound — not calibrated.');
    } else {
      notice('gradientSound', 'Simulated gradient sound — not calibrated sound pressure level.');
    }
    SeqEyesAudio.onEnded(function () {
      stopPlayheadLoop();
      playheadTimeSec = range.endSec;
      setMarkerTime(range.endSec, { preservePlayback: true, exact: true });
      playheadTimeSec = NaN;
      syncTransport();
      render();
    });
    SeqEyesAudio.play(range.initialOffsetSec || 0, playbackLengthSec(range));
    startPlayheadLoop();
    syncTransport();
  }

  function deliverAudioError(id, message) {
    if (id !== pendingAudioId) return;
    pendingAudioId = 0;
    notice('gradientSound', message || 'The gradient sound could not be synthesised.');
    syncTransport();
  }

  function pausePlayback() {
    SeqEyesAudio.pause();
    stopPlayheadLoop();
    playheadTimeSec = NaN;
    setMarkerTime(SeqEyesAudio.currentTimeSec(), { preservePlayback: true, exact: true });
    syncTransport();
    render();
  }

  function stopPlayback() {
    audioRequestId++;
    SeqEyesAudio.stop();
    stopPlayheadLoop();
    playheadTimeSec = NaN;
    pendingAudioId = 0;
    audioWindow = null;
    syncTransport();
    render();
  }

  /**
   * Playhead loop (R14).
   *
   * Redraws only the overlay and the spectrum pane — the image layer is never
   * touched, and the spectrum is a row copy out of the cached matrix, so this
   * runs at 60 fps without recomputing anything.
   */
  function startPlayheadLoop() {
    if (playheadFrame) return;
    var step = function () {
      if (!SeqEyesAudio.isPlaying()) { playheadFrame = 0; return; }
      playheadTimeSec = SeqEyesAudio.currentTimeSec();
      var css = getComputedStyle(document.body);
      var dpr = window.devicePixelRatio || 1;
      var leftMargin = leftMarginForLayout();
      renderOverlay(css, dpr, leftMargin);
      renderSpectrum(css, dpr, leftMargin);
      renderReadout();
      playheadFrame = requestAnimationFrame(step);
    };
    playheadFrame = requestAnimationFrame(step);
  }

  function stopPlayheadLoop() {
    if (playheadFrame) cancelAnimationFrame(playheadFrame);
    playheadFrame = 0;
  }

  function syncTransport() {
    var play = el('sgPlay');
    var stopBtn = el('sgStop');
    var mute = el('sgMute');
    var available = SeqEyesAudio.isAvailable();
    if (play) {
      play.disabled = !available || pendingAudioId !== 0;
      play.textContent = SeqEyesAudio.isPlaying() ? '‖' : '▶';
      play.setAttribute('aria-label', SeqEyesAudio.isPlaying() ? 'Pause' : 'Play simulated gradient sound');
      if (!available) play.title = 'Audio playback is unavailable in this host.';
    }
    if (stopBtn) stopBtn.disabled = !available || SeqEyesAudio.getState() === 'idle';
    if (mute) {
      mute.disabled = !available;
      mute.textContent = SeqEyesAudio.isMuted() ? '🔇' : '🔊';
      mute.setAttribute('aria-pressed', SeqEyesAudio.isMuted() ? 'true' : 'false');
    }
  }

  /* ── Acoustic bands (R12) ─────────────────────────────────────────── */

  function setAcousticBands(bands) {
    acousticBands = Array.isArray(bands) ? bands.slice() : [];
    hotBands = currentSpec ? sgDetectHotBands(currentSpec, acousticBands, windowLevel, 'rss') : [];
    buildLegend();
    publishNotices();
    render();
  }

  /* ── Legend chips ─────────────────────────────────────────────────── */

  function buildLegend() {
    var legend = el('sgLegend');
    if (!legend) return;
    legend.innerHTML = '';
    var style = getComputedStyle(document.body);

    for (var i = 0; i < traces.length; i++) {
      (function (trace) {
        var chip = document.createElement('div');
        chip.className = 'li' + (trace.visible ? '' : ' off');
        chip.title = 'Toggle the ' + trace.label + ' spectrum trace';
        var swatch = document.createElement('div');
        swatch.className = 'ld';
        swatch.style.background = (style.getPropertyValue(trace.varName) || '#888').trim();
        chip.appendChild(swatch);
        chip.appendChild(document.createTextNode(trace.key === 'rss' ? 'Σ combined' : trace.label));
        chip.onclick = function () {
          trace.visible = !trace.visible;
          set('seqeyes.spectrogram.trace.' + trace.key, trace.visible ? '1' : '0');
          buildLegend();
          render();
        };
        legend.appendChild(chip);
      })(traces[i]);
    }

    var yChip = document.createElement('div');
    yChip.className = 'li' + (freeY ? '' : ' off');
    yChip.title = 'Autoscale the spectrum pane instead of sharing the spectrogram window/level';
    yChip.textContent = 'Free Y';
    yChip.onclick = function () {
      freeY = !freeY;
      set('seqeyes.spectrogram.freeY', freeY ? '1' : '0');
      buildLegend();
      render();
    };
    legend.appendChild(yChip);

    if (acousticBands.length) {
      var bandChip = document.createElement('div');
      bandChip.className = 'li' + (bandsVisible ? '' : ' off');
      bandChip.title = 'Toggle the acoustic resonance bands read from the ASC profile';
      var bandSwatch = document.createElement('div');
      bandSwatch.className = 'ld';
      bandSwatch.style.background = SG_BAND_COLOR;
      bandChip.appendChild(bandSwatch);
      bandChip.appendChild(document.createTextNode('Acoustic bands (' + acousticBands.length + ')'));
      bandChip.onclick = function () {
        bandsVisible = !bandsVisible;
        set('seqeyes.spectrogram.bands', bandsVisible ? '1' : '0');
        buildLegend();
        render();
      };
      legend.appendChild(bandChip);
    }
  }

  /* ── Control strip ────────────────────────────────────────────────── */

  function syncControls() {
    var cmap = el('sgCmap');
    if (cmap && !cmap.options.length) {
      for (var i = 0; i < SG_COLORMAP_NAMES.length; i++) {
        var name = SG_COLORMAP_NAMES[i];
        var option = document.createElement('option');
        option.value = name;
        option.textContent = SG_COLORMAP_LABELS[name];
        option.title = SG_COLORMAP_TOOLTIPS[name];
        cmap.appendChild(option);
      }
    }
    if (cmap) {
      cmap.value = colormapName;
      cmap.title = SG_COLORMAP_TOOLTIPS[colormapName] || 'Colormap';
    }
    setValue('sgSource', params.source);
    setValue('sgFMin', String(params.fMinHz));
    setValue('sgFMax', String(params.fMaxHz));
    setValue('sgWin', String(params.windowSamples));
    setValue('sgOverlap', String(params.overlap));
    setValue('sgOversample', String(params.oversample));
    var clear = el('sgMarkerClear');
    if (clear) clear.disabled = !isFinite(markerTimeSec);
  }

  function setValue(id, value) {
    var node = el(id);
    if (node && node.value !== value) node.value = value;
  }

  function onParamChanged(recompute) {
    set('seqeyes.spectrogram.source', params.source);
    set('seqeyes.spectrogram.window', String(params.windowSamples));
    set('seqeyes.spectrogram.overlap', String(params.overlap));
    set('seqeyes.spectrogram.oversample', String(params.oversample));
    syncControls();
    if (recompute) {
      clearCache();
      windowLevelAuto = true;
      requestSpectrogram(true);
    } else {
      imageDirty = true;
      render();
    }
  }

  /* ── Event wiring ─────────────────────────────────────────────────── */

  function wire() {
    if (wired) return;
    wired = true;

    var button = el('panelBtn');
    if (button) button.onclick = function () { cycle(); };

    var safetySpectrogram = el('kspaceSafetySpectrogram');
    if (safetySpectrogram) {
      safetySpectrogram.onclick = function () {
        var overlay = el('kspaceSafetyOverlay');
        if (overlay) { overlay.style.display = 'none'; overlay.setAttribute('aria-hidden', 'true'); }
        setMode('spectrogram');
      };
    }

    wireControls();
    wireSpectrogramCanvas();
    wireSpectrumCanvas();
    wireSplit();

    document.addEventListener('keydown', function (e) {
      if (panelMode !== 'spectrogram') return;
      if (e.key === 'Escape' && isFinite(markerTimeSec)) { setMarkerTime(NaN); syncControls(); }
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopPlayback();
    });
    window.addEventListener('pagehide', function () { SeqEyesAudio.dispose(); });
    window.addEventListener('resize', function () { if (panelMode === 'spectrogram') resize(); });

    var pane = el('sgPane');
    if (pane && typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function () { if (panelMode === 'spectrogram') resize(); }).observe(pane);
    }

    syncControls();
    buildLegend();
    syncTransport();
    applySplit();
    updateButton();
  }

  function wireControls() {
    var cmap = el('sgCmap');
    if (cmap) cmap.onchange = function () {
      colormapName = this.value;
      set('seqeyes.spectrogram.colormap', colormapName);
      this.title = SG_COLORMAP_TOOLTIPS[colormapName] || 'Colormap';
      imageDirty = true;
      render();
    };

    var source = el('sgSource');
    if (source) source.onchange = function () {
      stopPlayback();
      params.source = this.value === 'dGdt' ? 'dGdt' : 'G';
      onParamChanged(true);
    };

    var win = el('sgWin');
    if (win) win.onchange = function () { params.windowSamples = parseFloat(this.value) || 0; onParamChanged(true); };
    var overlap = el('sgOverlap');
    if (overlap) overlap.onchange = function () { params.overlap = parseFloat(this.value) || 0; onParamChanged(true); };
    var oversample = el('sgOversample');
    if (oversample) oversample.onchange = function () { params.oversample = parseFloat(this.value) || 3; onParamChanged(true); };

    var fMin = el('sgFMin');
    if (fMin) fMin.onchange = function () {
      setFrequencyRange(parseFloat(this.value) || 0, params.fMaxHz);
    };
    var fMax = el('sgFMax');
    if (fMax) fMax.onchange = function () {
      setFrequencyRange(params.fMinHz, parseFloat(this.value) || 3000, { forceRecompute: true });
    };
    var fit = el('sgFit');
    if (fit) fit.onclick = function () { setFrequencyRange(0, 3000, { forceRecompute: true }); };

    var reset = el('sgWlReset');
    if (reset) reset.onclick = resetWindowLevel;
    bindWl('sgWlWider', function () { setWindowLevel(windowLevel.width * 1.25, windowLevel.level); });
    bindWl('sgWlNarrower', function () { setWindowLevel(windowLevel.width / 1.25, windowLevel.level); });
    bindWl('sgWlUp', function () { setWindowLevel(windowLevel.width, windowLevel.level + windowLevel.width * 0.1); });
    bindWl('sgWlDown', function () { setWindowLevel(windowLevel.width, windowLevel.level - windowLevel.width * 0.1); });

    var clear = el('sgMarkerClear');
    if (clear) clear.onclick = function () { setMarkerTime(NaN); syncControls(); };

    var play = el('sgPlay');
    if (play) play.onclick = togglePlayback;
    var stopBtn = el('sgStop');
    if (stopBtn) stopBtn.onclick = stopPlayback;
    var mute = el('sgMute');
    if (mute) mute.onclick = function () {
      SeqEyesAudio.setMuted(!SeqEyesAudio.isMuted());
      set('seqeyes.spectrogram.muted', SeqEyesAudio.isMuted() ? '1' : '0');
      syncTransport();
    };
    var volume = el('sgVol');
    if (volume) {
      var stored = getNum('seqeyes.spectrogram.volume', 70);
      volume.value = String(stored);
      SeqEyesAudio.setVolume(stored / 100);
      SeqEyesAudio.setMuted(getBool('seqeyes.spectrogram.muted', false));
      volume.oninput = function () {
        SeqEyesAudio.setVolume(parseFloat(this.value) / 100);
        set('seqeyes.spectrogram.volume', this.value);
      };
    }
  }

  function bindWl(id, action) {
    var node = el(id);
    if (node) node.onclick = action;
  }

  /* ── Spectrogram canvas interaction ───────────────────────────────── */

  var wlDrag = null;
  var freqDrag = null;

  function canvasPoint(canvas, e) {
    var rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function currentPlotRect() {
    var ovl = el('sgOvl');
    if (!ovl) return null;
    var dpr = window.devicePixelRatio || 1;
    return sgPlotRect(ovl.width / dpr, ovl.height / dpr, leftMarginForLayout());
  }

  function wireSpectrogramCanvas() {
    var canvas = el('sgOvl');
    if (!canvas) return;

    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    // Middle-click autoscroll has to be suppressed in both places or Chromium
    // (and the VS Code webview) starts scrolling instead of adjusting W/L.
    canvas.addEventListener('auxclick', function (e) { if (e.button === 1) e.preventDefault(); });

    canvas.addEventListener('mousedown', function (e) {
      var rect = currentPlotRect();
      if (!rect) return;
      var point = canvasPoint(canvas, e);
      if (e.button === 1) {
        e.preventDefault();
        wlDrag = { x: e.clientX, y: e.clientY, width: windowLevel.width, level: windowLevel.level, height: rect.h };
        document.body.classList.add('sg-wl-drag');
      } else if (e.button === 2) {
        e.preventDefault();
        if (point.x < rect.x) return;
        var time = sgXToTime(rect, currentView, point.x);
        // Right-clicking the same column again clears the marker.
        if (isFinite(markerTimeSec) && currentSpec && currentSpec.tStepSec > 0
          && Math.abs(time - markerTimeSec) < currentSpec.tStepSec / 2) {
          setMarkerTime(NaN);
        } else {
          setMarkerTime(time);
        }
        syncControls();
      } else if (e.button === 0 && point.x < rect.x) {
        e.preventDefault();
        freqDrag = { y: e.clientY, fMin: frequencyRange.fMin, fMax: frequencyRange.fMax, height: rect.h };
      }
    });

    canvas.addEventListener('dblclick', function (e) {
      if (e.button === 1) { e.preventDefault(); resetWindowLevel(); }
    });
    // Chromium reports a middle double-click as two auxclicks, not dblclick.
    var lastAux = 0;
    canvas.addEventListener('auxclick', function (e) {
      if (e.button !== 1) return;
      var now = Date.now();
      if (now - lastAux < 400) resetWindowLevel();
      lastAux = now;
    });

    canvas.addEventListener('mousemove', function (e) {
      var rect = currentPlotRect();
      if (!rect) return;
      var point = canvasPoint(canvas, e);
      var inside = point.x >= rect.x && point.x <= rect.x + rect.w
        && point.y >= rect.y && point.y <= rect.y + rect.h;
      hover = { x: point.x, y: point.y, inside: inside };
      updateHoverReadout(rect, point, inside);
      if (!wlDrag && !freqDrag) {
        renderOverlay(getComputedStyle(document.body), window.devicePixelRatio || 1, leftMarginForLayout());
        renderReadout();
      }
    });

    canvas.addEventListener('mouseleave', function () {
      hover = null;
      hoverReadout = '';
      if (panelMode === 'spectrogram') {
        renderOverlay(getComputedStyle(document.body), window.devicePixelRatio || 1, leftMarginForLayout());
        renderReadout();
      }
    });

    // Frequency axis: wheel zooms around the pointer, drag pans (§7.4).
    canvas.addEventListener('wheel', function (e) {
      var rect = currentPlotRect();
      if (!rect) return;
      var point = canvasPoint(canvas, e);
      if (point.x >= rect.x) return;
      e.preventDefault();
      var anchor = sgYToFreq(rect, frequencyRange, point.y);
      var factor = e.deltaY < 0 ? 1 / 1.2 : 1.2;
      var lo = anchor + (frequencyRange.fMin - anchor) * factor;
      var hi = anchor + (frequencyRange.fMax - anchor) * factor;
      setFrequencyRange(Math.max(0, lo), Math.max(lo + 1, hi), { forceRecompute: true });
    }, { passive: false });

    window.addEventListener('mousemove', function (e) {
      if (wlDrag) {
        var dx = e.clientX - wlDrag.x;
        var dy = e.clientY - wlDrag.y;
        var width = wlDrag.width * Math.exp(dx / 200);
        var level = wlDrag.level + dy * (wlDrag.width / Math.max(1, wlDrag.height));
        setWindowLevel(width, level);
      } else if (freqDrag) {
        var span = freqDrag.fMax - freqDrag.fMin;
        var shift = (e.clientY - freqDrag.y) / Math.max(1, freqDrag.height) * span;
        var lo = Math.max(0, freqDrag.fMin + shift);
        setFrequencyRange(lo, lo + span);
      }
    });

    window.addEventListener('mouseup', endDrags);
    window.addEventListener('blur', endDrags);

    wireTouch(canvas);
  }

  function endDrags() {
    if (wlDrag) { wlDrag = null; document.body.classList.remove('sg-wl-drag'); }
    freqDrag = null;
  }

  /**
   * Touch fallbacks (§7.3): two-finger drag adjusts window/level, long-press
   * sets the marker, double-tap resets. Every one of these also exists as a
   * button in #sgTools, so nothing is gesture-only.
   */
  function wireTouch(canvas) {
    var pinch = null;
    var longPressTimer = 0;
    var lastTap = 0;

    canvas.addEventListener('touchstart', function (e) {
      var rect = currentPlotRect();
      if (!rect) return;
      if (e.touches.length === 2) {
        clearTimeout(longPressTimer);
        pinch = {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
          width: windowLevel.width,
          level: windowLevel.level,
          height: rect.h
        };
        e.preventDefault();
      } else if (e.touches.length === 1) {
        var now = Date.now();
        if (now - lastTap < 350) { resetWindowLevel(); lastTap = 0; e.preventDefault(); return; }
        lastTap = now;
        var canvasRect = canvas.getBoundingClientRect();
        var x = e.touches[0].clientX - canvasRect.left;
        longPressTimer = setTimeout(function () {
          if (x < rect.x) return;
          setMarkerTime(sgXToTime(rect, currentView, x));
          syncControls();
        }, 500);
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', function (e) {
      clearTimeout(longPressTimer);
      if (!pinch || e.touches.length !== 2) return;
      var midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      var midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      setWindowLevel(
        pinch.width * Math.exp((midX - pinch.x) / 200),
        pinch.level + (midY - pinch.y) * (pinch.width / Math.max(1, pinch.height)),
      );
      e.preventDefault();
    }, { passive: false });

    canvas.addEventListener('touchend', function () { clearTimeout(longPressTimer); pinch = null; });
    canvas.addEventListener('touchcancel', function () { clearTimeout(longPressTimer); pinch = null; });
  }

  function updateHoverReadout(rect, point, inside) {
    if (!inside || !currentSpec || !currentSpec.nTime) { hoverReadout = ''; return; }
    var time = sgXToTime(rect, currentView, point.x);
    var freq = sgYToFreq(rect, frequencyRange, point.y);
    var cell = sgSampleCell(currentSpec, 'rss', time, freq);
    if (!cell) { hoverReadout = ''; return; }
    var floorValue = sgValueFloor(currentSpec);
    var text = 'f ' + sgFmtHz(cell.freqHz) + ' Hz  '
      + 'Gx ' + sgFmtDb(sgToDb(cell.gx, floorValue))
      + '  Gy ' + sgFmtDb(sgToDb(cell.gy, floorValue))
      + '  Gz ' + sgFmtDb(sgToDb(cell.gz, floorValue))
      + '  Σ ' + sgFmtDb(sgToDb(cell.rss, floorValue)) + ' dB';
    var bandIndex = sgBandAtFrequency(acousticBands, cell.freqHz);
    if (bandIndex >= 0) {
      var band = acousticBands[bandIndex];
      text += '   [band f0 ' + sgFmtHz(band.freqHz) + ' Hz, BW ' + sgFmtHz(band.bwHz) + ' Hz]';
    }
    hoverReadout = text;
  }

  /* ── Spectrum canvas hover ────────────────────────────────────────── */

  function wireSpectrumCanvas() {
    var canvas = el('spCanvas');
    if (!canvas) return;
    canvas.addEventListener('mousemove', function (e) {
      if (!currentSpec || !currentSpec.nFreq) return;
      var dpr = window.devicePixelRatio || 1;
      var rect = sgSpectrumRect(canvas.width / dpr, canvas.height / dpr, leftMarginForLayout());
      var point = canvasPoint(canvas, e);
      var rotated = layoutMode() === 'vertical';
      var freq = rotated
        ? sgYToFreq(rect, frequencyRange, point.y)
        : frequencyRange.fMin + (point.x - rect.x) / Math.max(1, rect.w) * (frequencyRange.fMax - frequencyRange.fMin);
      if (freq < frequencyRange.fMin || freq > frequencyRange.fMax) { hoverReadout = ''; renderReadout(); return; }
      var slice = currentSlice();
      if (!slice) return;
      var row = Math.max(0, Math.min(currentSpec.nFreq - 1,
        Math.round((freq - currentSpec.fStartHz) / currentSpec.fStepHz)));
      var floorValue = sgValueFloor(currentSpec);
      hoverReadout = 'f ' + sgFmtHz(currentSpec.fStartHz + row * currentSpec.fStepHz) + ' Hz  '
        + 'Gx ' + sgFmtDb(sgToDb(slice.gx[row], floorValue))
        + '  Gy ' + sgFmtDb(sgToDb(slice.gy[row], floorValue))
        + '  Gz ' + sgFmtDb(sgToDb(slice.gz[row], floorValue))
        + '  Σ ' + sgFmtDb(sgToDb(slice.rss[row], floorValue)) + ' dB';
      renderReadout();
    });
    canvas.addEventListener('mouseleave', function () { hoverReadout = ''; renderReadout(); });
  }

  /* ── Split drag ───────────────────────────────────────────────────── */

  function wireSplit() {
    var handle = el('sgSplit');
    if (!handle) return;
    var drag = null;

    function begin(clientX, clientY) {
      var body = el('sgBody');
      if (!body) return;
      var rect = body.getBoundingClientRect();
      drag = { rect: rect, vertical: layoutMode() === 'vertical' };
      document.body.classList.add('sg-split-drag');
      move(clientX, clientY);
    }
    function move(clientX, clientY) {
      if (!drag) return;
      var ratio = drag.vertical
        ? (clientX - drag.rect.left) / Math.max(1, drag.rect.width)
        : (clientY - drag.rect.top) / Math.max(1, drag.rect.height);
      setSplitRatio(ratio);
    }
    function end() {
      if (!drag) return;
      drag = null;
      document.body.classList.remove('sg-split-drag');
    }

    handle.addEventListener('mousedown', function (e) { e.preventDefault(); begin(e.clientX, e.clientY); });
    handle.addEventListener('touchstart', function (e) {
      e.preventDefault();
      begin(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    window.addEventListener('mousemove', function (e) { if (drag) move(e.clientX, e.clientY); });
    window.addEventListener('touchmove', function (e) {
      if (drag && e.touches.length === 1) { move(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }
    }, { passive: false });
    window.addEventListener('mouseup', end);
    window.addEventListener('touchend', end);
  }

  /* ── Lifecycle hooks called by the hosts ──────────────────────────── */

  function onViewChanged() {
    if (panelMode !== 'spectrogram') return;
    var view = hostView();
    var tolerance = Math.max(1, Math.abs(view.endSec - view.startSec)) * 1e-9;
    if (Math.abs(view.startSec - currentView.startSec) > tolerance
      || Math.abs(view.endSec - currentView.endSec) > tolerance) {
      if (SeqEyesAudio.getState() !== 'idle') {
        setMarkerTime(SeqEyesAudio.currentTimeSec(), { preservePlayback: true, exact: true });
      }
      stopPlayback();
    }
    requestSpectrogram(false);
  }

  function onSequenceLoaded() {
    clearCache();
    currentSpec = null;
    averageCache = null;
    imageCache = null;
    imageDirty = true;
    markerTimeSec = NaN;
    windowLevelAuto = true;
    stopPlayback();
    notice('spectrogram', null);
    notice('gradientSound', null);
    if (panelMode === 'kspace') {
      var h = activeHost();
      var refused = h && h.showKspaceSafetyDialog && h.showKspaceSafetyDialog();
      if (!refused && h && h.requestKspace) h.requestKspace();
    }
    if (panelMode === 'spectrogram') requestSpectrogram(true);
  }

  function onThemeChanged() {
    imageDirty = true;
    buildLegend();
    render();
  }

  function onLayoutChanged() {
    if (panelMode !== 'spectrogram') return;
    applySplit();
    applyPanelGeometry();
    requestAnimationFrame(resize);
  }

  function onPanelResized() {
    if (panelMode === 'spectrogram') resize();
  }

  /** Restore the persisted mode once the host is ready to serve data. */
  function restoreMode() {
    var stored = get('seqeyes.panelMode');
    if (stored === 'spectrogram') setMode('spectrogram', { force: true });
    else if (stored === 'kspace') setMode('kspace', { force: true });
  }

  /**
   * `state.js` used to force-click the toggle when k-space data arrived. That
   * must not yank a user out of the spectrogram, so this is a no-op unless the
   * panel is closed.
   */
  function showKspaceIfClosed() {
    if (panelMode === 'off') setMode('kspace', { force: true });
  }

  /** Re-run geometry after deferred k-space work releases the UI thread. */
  function refreshKspace() {
    if (panelMode !== 'kspace') return;
    var h = activeHost();
    applyPanelGeometry();
    if (h && h.refreshLayout) h.refreshLayout();
    if (h && h.onKspaceShown) requestAnimationFrame(function () { h.onKspaceShown(); });
  }

  function install(newHost) {
    host = newHost || window.SeqEyesPanelHost || null;
    wire();
    syncControls();
    buildLegend();
    updateButton();
    return api;
  }

  var api = {
    install: install,
    setMode: setMode,
    getMode: function () { return panelMode; },
    cycle: cycle,
    restoreMode: restoreMode,
    showKspaceIfClosed: showKspaceIfClosed,
    refreshKspace: refreshKspace,
    onViewChanged: onViewChanged,
    onSequenceLoaded: onSequenceLoaded,
    onThemeChanged: onThemeChanged,
    onLayoutChanged: onLayoutChanged,
    onPanelResized: onPanelResized,
    deliverSpectrogram: deliverSpectrogram,
    deliverSpectrogramError: deliverSpectrogramError,
    deliverAudio: deliverAudio,
    deliverAudioError: deliverAudioError,
    setAcousticBands: setAcousticBands,
    getAcousticBands: function () { return acousticBands.slice(); },
    setMarkerTime: function (t) { setMarkerTime(t); syncControls(); },
    getMarkerTime: function () { return markerTimeSec; },
    setSplitRatio: setSplitRatio,
    getSplitRatio: splitRatio,
    setWindowLevel: setWindowLevel,
    resetWindowLevel: resetWindowLevel,
    setFrequencyRange: setFrequencyRange,
    togglePlayback: togglePlayback,
    stopPlayback: stopPlayback,
    resize: resize,
    render: render,
    currentSlice: currentSlice,
    state: function () {
      return {
        mode: panelMode,
        open: panelOpen,
        busy: busy,
        computeCount: computeCount,
        renderCount: renderCount,
        lastRedrawMs: lastRedrawMs,
        redrawSamples: redrawSamples.slice(),
        splitRatio: splitRatio(),
        colormap: colormapName,
        source: params.source,
        fMin: frequencyRange.fMin,
        fMax: frequencyRange.fMax,
        windowLevel: { width: windowLevel.width, level: windowLevel.level },
        windowLevelAuto: windowLevelAuto,
        markerTimeSec: markerTimeSec,
        playheadTimeSec: playheadTimeSec,
        bands: acousticBands.length,
        hotBands: hotBands.filter(Boolean).length,
        audioState: SeqEyesAudio.getState(),
        audioAvailable: SeqEyesAudio.isAvailable(),
        pendingAudioId: pendingAudioId,
        audioWindowStartSec: audioWindow ? audioWindow.startSec : null,
        audioWindowEndSec: audioWindow ? audioWindow.endSec : null,
        audioBoundedPreview: !!(audioWindow && audioWindow.boundedPreview),
        tStartSec: currentSpec ? currentSpec.tStartSec : null,
        tEndSec: currentSpec ? currentSpec.tStartSec + (currentSpec.nTime - 1) * currentSpec.tStepSec : null,
        viewStartSec: currentView.startSec,
        viewEndSec: currentView.endSec,
        nTime: currentSpec ? currentSpec.nTime : 0,
        nFreq: currentSpec ? currentSpec.nFreq : 0,
        dtResolutionSec: currentSpec ? currentSpec.dtResolutionSec : null,
        dfResolutionHz: currentSpec ? currentSpec.dfResolutionHz : null,
        decimationFactor: currentSpec ? currentSpec.decimationFactor : null,
        warnings: currentSpec ? currentSpec.warnings.slice() : [],
        error: lastError
      };
    }
  };
  return api;
})();

/** Called from kspace.js's outer resize handle, whichever pane is showing. */
function panelHandleResize() {
  if (panelMode === 'spectrogram') SeqEyesPanel.onPanelResized();
  else if (typeof resizeKc === 'function') { resizeKc(); if (typeof drawKs === 'function') drawKs(); }
}

/* Test hooks (§10.3). */
window.SeqEyesDev = window.SeqEyesDev || {};
window.SeqEyesDev.panelMode = function () { return panelMode; };
window.SeqEyesDev.setPanelMode = function (mode) { return SeqEyesPanel.setMode(mode, { force: true }); };
window.SeqEyesDev.spectrogramState = function () { return SeqEyesPanel.state(); };
window.SeqEyesDev.spectrumAtMarker = function () {
  var slice = SeqEyesPanel.currentSlice();
  if (!slice) return null;
  return {
    columnIndex: slice.columnIndex,
    timeSec: slice.timeSec,
    gx: Array.prototype.slice.call(slice.gx),
    gy: Array.prototype.slice.call(slice.gy),
    gz: Array.prototype.slice.call(slice.gz),
    rss: Array.prototype.slice.call(slice.rss)
  };
};
window.SeqEyesDev.setMarkerTime = function (t) { SeqEyesPanel.setMarkerTime(t); };
window.SeqEyesDev.acousticBands = function () { return SeqEyesPanel.getAcousticBands(); };
window.SeqEyesDev.setAcousticBands = function (bands) { SeqEyesPanel.setAcousticBands(bands); };
window.SeqEyesDev.audioState = function () {
  return {
    state: SeqEyesAudio.getState(),
    available: SeqEyesAudio.isAvailable(),
    playing: SeqEyesAudio.isPlaying(),
    currentTimeSec: SeqEyesAudio.currentTimeSec(),
    hasBuffer: SeqEyesAudio.hasBuffer(),
    durationSec: SeqEyesAudio.bufferDurationSec(),
    auditionDurationSec: SeqEyesAudio.auditionDurationSec()
  };
};
window.SeqEyesDev.setAudioClock = function (fn) { SeqEyesAudio.setClock(fn); };
window.SeqEyesDev.setSplitRatio = function (r) { SeqEyesPanel.setSplitRatio(r); };
window.SeqEyesDev.getSplitRatio = function () { return SeqEyesPanel.getSplitRatio(); };
