/* ═══════════════════════════════════════════════════════════════════════
   Simulation panel — Bloch simulation of the open sequence on a phantom

   Pure UI and scheduling. The simulator is a separate worker script
   (web/sim-worker.js, built from src/sim/worker/entry.ts) that the host
   creates through `createSimulationWorker()`; this file never touches the
   parser or the engine, which the VS Code webview does not even load. A host
   without that hook keeps the Simulation button hidden.

   A run:
     1. the first worker opens the job and returns its plan: spins per voxel
        (probed for spoiled axes), folding, and how many chunks;
     2. more workers open the same job with the plan's spins per voxel, so
        they split it into the same chunks without probing again;
     3. chunks go one at a time to whichever worker is idle, and their
        signals are added in chunk order, so the result does not depend on
        the worker count;
     4. the first worker reconstructs the image, k-space and raw views.
   Cancel, a new run or a new sequence terminates every worker.
   ═══════════════════════════════════════════════════════════════════════ */

var SeqEyesSimulation = (function () {
  var get = SeqEyesPrefs.get, set = SeqEyesPrefs.set;

  var SIZES = [32, 64, 128, 256];
  var SPIN_CHOICES = ['auto', '1x1', '8x1', '32x1', '128x1', '384x1', '768x1'];
  var VIEWS = { image: 'Image', kspace: 'k-space', raw: 'Raw' };
  /* Dynamic range of the log display. */
  var LOG_RANGE_DB = 60;

  var size = SIZES.indexOf(+get('seqeyes.simulation.size')) >= 0 ? +get('seqeyes.simulation.size') : 128;
  var spins = SPIN_CHOICES.indexOf(get('seqeyes.simulation.spins')) >= 0 ? get('seqeyes.simulation.spins') : 'auto';
  var view = VIEWS[get('seqeyes.simulation.view')] ? get('seqeyes.simulation.view') : 'image';
  var colormapName = get('seqeyes.simulation.colormap') || 'grey';
  if (SG_COLORMAP_NAMES.indexOf(colormapName) < 0) colormapName = 'grey';
  /* Log display per view: k-space and raw data span decades, images do not. */
  var logScale = { image: false, kspace: true, raw: true };
  ['image', 'kspace', 'raw'].forEach(function (key) {
    var stored = get('seqeyes.simulation.log.' + key);
    if (stored === '1' || stored === '0') logScale[key] = stored === '1';
  });

  var shown = false;
  var wired = false;
  var runCounter = 0;
  var run = null;          // the active or last run (see startRun)
  var result = null;       // { recon, raw, plan, timings } of the last finished run
  var frame = 0;
  var zoom = { image: null, kspace: null, raw: null };   // { scale, ox, oy } per view, null = fit
  var offscreen = null;
  var offscreenKey = '';
  var hover = null;

  function el(id) { return document.getElementById(id); }
  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function host() {
    if (typeof SeqEyesPanel !== 'undefined' && SeqEyesPanel.getHost) return SeqEyesPanel.getHost();
    return window.SeqEyesPanelHost || null;
  }
  function isAvailable() {
    var h = host();
    return !!(h && typeof h.createSimulationWorker === 'function' && typeof h.getSequenceSource === 'function'
      && typeof Worker !== 'undefined');
  }

  /* ── Formatting ───────────────────────────────────────────────────── */

  function formatCount(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + ' M';
    if (n >= 1e4) return Math.round(n / 1e3) + ' k';
    return String(n);
  }
  function formatSeconds(ms) { return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s'; }
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function describePlan(plan) {
    var axes = plan.axes.map(function (axis, i) {
      var name = 'xy'.charAt(i);
      if (axis.reason === 'manual') return name + ' ' + axis.count;
      var why = axis.reason === 'spoiling' ? 'spoiling'
        : axis.reason === 'resolution' ? 'resolution' : '';
      var text = name + ' ' + axis.count + (why ? ' (' + why : '');
      if (axis.probe) text += ', ' + (100 * axis.probe.error).toFixed(1) + ' % probe error';
      if (why) text += ')';
      if (axis.folded) text += ' folded';
      return text;
    });
    return plan.phantom.nx + '² Shepp–Logan · spins/voxel ' + axes.join(', ')
      + ' · ' + formatCount(plan.spins) + ' spins, ' + formatCount(plan.simulated) + ' simulated'
      + ' · ' + plan.rfEvents + ' RF, ' + plan.adcEvents + ' ADC';
  }

  /* ── Status line ──────────────────────────────────────────────────── */

  function setStatus(lines, warnings) {
    var node = el('simReadout');
    if (!node) return;
    var html = (lines || []).map(function (line) { return '<div>' + escapeHtml(line) + '</div>'; }).join('');
    html += (warnings || []).map(function (line) {
      return '<div class="sg-warn">' + escapeHtml(line) + '</div>';
    }).join('');
    node.innerHTML = html;
  }

  function setProgress(fraction) {
    var bar = el('simProgress');
    var fill = el('simProgressFill');
    if (!bar || !fill) return;
    var active = fraction !== null && fraction !== undefined;
    bar.classList.toggle('on', active);
    fill.style.width = active ? Math.round(100 * Math.max(0, Math.min(1, fraction))) + '%' : '0%';
  }

  function syncButtons() {
    var running = !!(run && !run.finished);
    var runButton = el('simRun');
    var cancel = el('simCancel');
    if (runButton) {
      runButton.disabled = running;
      runButton.textContent = result ? '▶ Run again' : '▶ Run';
    }
    if (cancel) cancel.disabled = !running;
    var frameSelect = el('simFrame');
    var frames = result && result.recon ? result.recon.frames : 0;
    if (frameSelect) {
      frameSelect.hidden = !(frames > 1) || view === 'raw';
      if (frames > 1 && frameSelect.options.length !== frames) {
        frameSelect.innerHTML = '';
        for (var f = 0; f < frames; f++) {
          var option = document.createElement('option');
          option.value = String(f);
          option.textContent = 'Frame ' + (f + 1);
          frameSelect.appendChild(option);
        }
      }
      frameSelect.value = String(frame);
    }
    var log = el('simLog');
    if (log) {
      log.classList.toggle('on', !!logScale[view]);
      log.setAttribute('aria-pressed', logScale[view] ? 'true' : 'false');
    }
    var empty = el('simEmpty');
    if (empty) {
      empty.style.display = currentMatrix() ? 'none' : 'flex';
      empty.textContent = running ? 'Simulating…' : 'No simulation yet. Press Run.';
    }
  }

  /* ── Running ──────────────────────────────────────────────────────── */

  function workerBudget(bytes) {
    var cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    var count = Math.max(1, Math.min(8, cores - 1));
    // Every worker parses its own copy of the sequence.
    if (bytes > 32 * 1024 * 1024) count = Math.min(count, 2);
    return count;
  }

  function jobSettings() {
    var settings = { phantom: 'shepp-logan', size: size, subSpins: 'auto' };
    if (spins !== 'auto') settings.subSpins = spins.split('x').map(Number);
    return settings;
  }

  function startRun() {
    var h = host();
    if (!isAvailable()) return;
    var source = h.getSequenceSource();
    if (!source || !source.bytes || !source.bytes.length) {
      setStatus(['Open a Pulseq sequence first.']);
      return;
    }
    stopWorkers(run);
    var settings = jobSettings();
    run = {
      id: ++runCounter,
      source: source,
      settings: settings,
      started: now(),
      planMs: 0,
      plan: null,
      workers: [],
      budget: workerBudget(source.bytes.length),
      nextChunk: 0,
      added: 0,
      pending: {},
      signal: null,
      progress: {},
      finished: false
    };
    var leader = spawnWorker(run);
    if (!leader) return;
    openJob(run, leader, settings);
    setStatus(['Planning: parsing the sequence and choosing spins per voxel…']);
    setProgress(0);
    syncButtons();
  }

  function spawnWorker(r) {
    var worker;
    try {
      worker = host().createSimulationWorker();
    } catch (error) {
      fail(r, 'Could not start the simulation worker: ' + (error && error.message || error));
      return null;
    }
    var slot = { worker: worker, chunk: -1, ready: false };
    worker.onmessage = function (event) { onWorkerMessage(r, slot, event.data); };
    worker.onerror = function (event) {
      if (event && event.preventDefault) event.preventDefault();
      fail(r, 'The simulation worker failed: ' + (event && event.message || 'unknown error'));
    };
    r.workers.push(slot);
    return slot;
  }

  function openJob(r, slot, settings) {
    var copy = r.source.bytes.slice();
    slot.worker.postMessage({
      type: 'open', job: r.id, bytes: copy.buffer, name: r.source.name || 'sequence.seq', settings: settings
    }, [copy.buffer]);
  }

  function onWorkerMessage(r, slot, message) {
    if (r !== run || r.finished || !message || message.job !== r.id) return;
    switch (message.type) {
      case 'plan':
        slot.ready = true;
        if (!r.plan) {
          r.plan = message.plan;
          r.planMs = now() - r.started;
          r.simulateStarted = now();
          // Followers take the leader's spins per voxel: same chunks, no probe.
          var followers = Math.min(r.budget, r.plan.chunks) - 1;
          var settings = { phantom: r.settings.phantom, size: r.settings.size, subSpins: r.plan.subSpins.slice() };
          for (var i = 0; i < followers; i++) {
            var follower = spawnWorker(r);
            if (!follower) return;
            openJob(r, follower, settings);
          }
        } else if (message.plan.chunks !== r.plan.chunks) {
          fail(r, 'Internal error: workers disagree on the job plan.');
          return;
        }
        dispatch(r, slot);
        reportProgress(r);
        break;
      case 'progress':
        r.progress[message.chunk] = message.fraction;
        reportProgress(r);
        break;
      case 'chunk':
        delete r.progress[message.chunk];
        slot.chunk = -1;
        addChunk(r, message.chunk, message.signal);
        if (r.added === r.plan.chunks) reconstruct(r);
        else dispatch(r, slot);
        reportProgress(r);
        break;
      case 'recon':
        finish(r, message.recon, message.raw);
        break;
      case 'error':
        fail(r, message.message);
        break;
    }
  }

  function dispatch(r, slot) {
    if (!slot.ready || slot.chunk >= 0 || r.nextChunk >= r.plan.chunks) return;
    slot.chunk = r.nextChunk++;
    slot.worker.postMessage({ type: 'chunk', job: r.id, chunk: slot.chunk });
  }

  /* Chunk signals are added strictly in chunk order (see src/sim/job.ts). */
  function addChunk(r, index, signal) {
    r.pending[index] = signal;
    while (r.pending[r.added]) {
      var chunk = r.pending[r.added];
      delete r.pending[r.added];
      if (!r.signal) r.signal = new Float64Array(chunk.length);
      var total = r.signal;
      for (var i = 0; i < total.length; i++) total[i] += chunk[i];
      r.added++;
    }
  }

  function reconstruct(r) {
    r.simulateMs = now() - r.simulateStarted;
    // Every chunk is in: free the followers' memory now.
    for (var i = 1; i < r.workers.length; i++) r.workers[i].worker.terminate();
    r.workers.length = Math.min(1, r.workers.length);
    setStatus([describePlan(r.plan), 'Reconstructing…']);
    r.workers[0].worker.postMessage({ type: 'recon', job: r.id, signal: r.signal.slice() });
  }

  function reportProgress(r) {
    if (!r.plan) return;
    var done = r.added;
    var partial = 0;
    for (var key in r.progress) if (Object.prototype.hasOwnProperty.call(r.progress, key)) partial += r.progress[key];
    var fraction = (done + partial) / r.plan.chunks;
    setProgress(fraction);
    var elapsed = now() - r.simulateStarted;
    var line = 'Simulating: ' + done + '/' + r.plan.chunks + ' chunks on ' + r.workers.length
      + (r.workers.length === 1 ? ' worker' : ' workers') + ' · ' + formatSeconds(elapsed);
    if (fraction > 0.05) line += ' · about ' + formatSeconds(elapsed * (1 - fraction) / fraction) + ' left';
    setStatus([describePlan(r.plan), line], r.plan.notes);
  }

  function finish(r, recon, raw) {
    r.finished = true;
    var totalMs = now() - r.started;
    stopWorkers(r);
    result = { recon: recon, raw: raw, plan: r.plan, signal: r.signal, name: r.source.name || '',
      timings: { totalMs: totalMs, planMs: r.planMs, simulateMs: r.simulateMs } };
    frame = Math.min(frame, Math.max(0, recon.frames - 1));
    offscreenKey = '';
    setProgress(null);
    statusForResult();
    syncButtons();
    render();
  }

  function statusForResult() {
    if (!result) return;
    var t = result.timings;
    var line = 'Done in ' + formatSeconds(t.totalMs) + ' (plan ' + formatSeconds(t.planMs)
      + ', simulate ' + formatSeconds(t.simulateMs) + ') · ' + result.recon.nu + '×' + result.recon.nv
      + (result.recon.frames > 1 ? ' × ' + result.recon.frames + ' frames' : '');
    setStatus([describePlan(result.plan), line], result.plan.notes.concat(result.recon.warnings || []));
  }

  function fail(r, message) {
    if (!r || r !== run || r.finished) return;
    r.finished = true;
    stopWorkers(r);
    setProgress(null);
    setStatus([], ['Simulation failed: ' + message]);
    syncButtons();
  }

  function stopWorkers(r) {
    if (!r) return;
    for (var i = 0; i < r.workers.length; i++) r.workers[i].worker.terminate();
    r.workers.length = 0;
  }

  function cancelRun() {
    if (!run || run.finished) return;
    run.finished = true;
    stopWorkers(run);
    setProgress(null);
    if (result) statusForResult();
    setStatus(['Cancelled.'].concat(result ? ['Showing the previous result.'] : []));
    syncButtons();
  }

  /* ── Rendering ────────────────────────────────────────────────────── */

  /**
   * The matrix the current view shows: { width, height, values, square,
   * xLabel, yLabel, yUp }. Image and k-space rows run top-down from the
   * largest y (recon/cartesian.ts); raw rows are readouts in order.
   */
  function currentMatrix() {
    if (!result) return null;
    var recon = result.recon;
    if (view === 'raw') {
      var raw = result.raw;
      if (!raw || !raw.rows || !raw.columns) return null;
      return { width: raw.columns, height: raw.rows, values: raw.magnitude, square: false,
        xLabel: 'sample', yLabel: 'readout', yUp: false };
    }
    if (!recon || !recon.frames) return null;
    var cells = recon.nu * recon.nv;
    var source = view === 'kspace' ? recon.kspace : recon.images;
    var axes = 'xyz';
    return { width: recon.nu, height: recon.nv, values: source.subarray(frame * cells, (frame + 1) * cells),
      square: true, xLabel: (view === 'kspace' ? 'k' : '') + axes.charAt(recon.axes[0]),
      yLabel: (view === 'kspace' ? 'k' : '') + axes.charAt(recon.axes[1]), yUp: true };
  }

  function matrixImage(matrix) {
    var key = [view, frame, colormapName, logScale[view] ? 1 : 0, result && result.timings.totalMs,
      document.body.className].join('|');
    if (offscreen && offscreenKey === key) return offscreen;
    var w = matrix.width, h = matrix.height, values = matrix.values;
    var max = 0;
    for (var i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
    var lut = sgColormapLut(colormapName, getComputedStyle(document.body));
    var canvas = offscreen || document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var context = canvas.getContext('2d');
    var image = context.createImageData(w, h);
    var data = image.data;
    var log = !!logScale[view];
    for (var p = 0; p < w * h; p++) {
      var v = max > 0 ? values[p] / max : 0;
      if (log) v = v > 0 ? Math.max(0, 1 + 20 * Math.log10(v) / LOG_RANGE_DB) : 0;
      var index = Math.max(0, Math.min(255, Math.round(v * 255))) * 3;
      data[4 * p] = lut[index];
      data[4 * p + 1] = lut[index + 1];
      data[4 * p + 2] = lut[index + 2];
      data[4 * p + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    offscreen = canvas;
    offscreenKey = key;
    return canvas;
  }

  /** Fitted placement of the matrix in a w × h box, before zoom. */
  function fitRect(matrix, w, h) {
    if (!matrix.square) return { x: 0, y: 0, w: w, h: h };
    var scale = Math.min(w / matrix.width, h / matrix.height);
    var dw = matrix.width * scale, dh = matrix.height * scale;
    return { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh };
  }

  function placement(matrix, w, h) {
    var fit = fitRect(matrix, w, h);
    var z = zoom[view];
    if (!z) return fit;
    return { x: fit.x * z.scale + z.ox, y: fit.y * z.scale + z.oy, w: fit.w * z.scale, h: fit.h * z.scale };
  }

  function resize() {
    if (!shown) return;
    var body = el('simBody');
    var canvas = el('simCanvas');
    if (!body || !canvas) return;
    var rect = body.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    var dpr = window.devicePixelRatio || 1;
    var width = Math.max(1, Math.round(rect.width * dpr));
    var height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
    }
    render();
  }

  function render() {
    if (!shown) return;
    var canvas = el('simCanvas');
    if (!canvas) return;
    var context = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.width / dpr, h = canvas.height / dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    var style = getComputedStyle(document.body);
    context.fillStyle = style.getPropertyValue('--bg') || '#fff';
    context.fillRect(0, 0, w, h);
    var matrix = currentMatrix();
    syncButtons();
    if (!matrix) return;
    var image = matrixImage(matrix);
    var place = placement(matrix, w, h);
    context.imageSmoothingEnabled = false;
    context.drawImage(image, place.x, place.y, place.w, place.h);
    // Matrix size and axis directions, on a backing so it reads over data.
    context.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    var caption = matrix.width + ' × ' + matrix.height + '  (' + matrix.xLabel + ' →, '
      + matrix.yLabel + (matrix.yUp ? ' ↑' : ' ↓') + ')';
    context.fillStyle = style.getPropertyValue('--trbg') || '#f8f8f8';
    context.fillRect(2, h - 18, context.measureText(caption).width + 8, 16);
    context.fillStyle = style.getPropertyValue('--lb') || '#888';
    context.fillText(caption, 6, h - 6);
    if (hover) {
      var text = hover.label;
      var tw = context.measureText(text).width + 8;
      context.fillStyle = style.getPropertyValue('--trbg') || '#f8f8f8';
      context.fillRect(w - tw - 4, 4, tw, 16);
      context.fillStyle = style.getPropertyValue('--fg') || '#222';
      context.fillText(text, w - tw, 15);
    }
  }

  /* ── Interaction: wheel zoom, drag pan, double-click fit, hover value ── */

  function localPoint(event) {
    var canvas = el('simCanvas');
    var rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, w: rect.width, h: rect.height };
  }

  function wireCanvas() {
    var canvas = el('simCanvas');
    if (!canvas) return;
    var drag = null;
    canvas.addEventListener('wheel', function (event) {
      var matrix = currentMatrix();
      if (!matrix) return;
      event.preventDefault();
      var p = localPoint(event);
      var z = zoom[view] || { scale: 1, ox: 0, oy: 0 };
      var factor = Math.exp(-event.deltaY * 0.0015);
      var scale = Math.max(1, Math.min(64, z.scale * factor));
      var applied = scale / z.scale;
      // Keep the point under the cursor fixed.
      zoom[view] = { scale: scale, ox: p.x - (p.x - z.ox) * applied, oy: p.y - (p.y - z.oy) * applied };
      if (scale === 1) zoom[view] = null;
      render();
    }, { passive: false });
    canvas.addEventListener('mousedown', function (event) {
      if (event.button !== 0 || !zoom[view]) return;
      drag = { x: event.clientX, y: event.clientY };
      event.preventDefault();
    });
    window.addEventListener('mousemove', function (event) {
      if (drag && zoom[view]) {
        zoom[view].ox += event.clientX - drag.x;
        zoom[view].oy += event.clientY - drag.y;
        drag = { x: event.clientX, y: event.clientY };
        render();
      }
    });
    window.addEventListener('mouseup', function () { drag = null; });
    canvas.addEventListener('dblclick', function () { zoom[view] = null; render(); });
    canvas.addEventListener('mousemove', function (event) {
      var matrix = currentMatrix();
      if (!matrix) { hover = null; return; }
      var p = localPoint(event);
      var place = placement(matrix, p.w, p.h);
      var column = Math.floor((p.x - place.x) / place.w * matrix.width);
      var row = Math.floor((p.y - place.y) / place.h * matrix.height);
      if (column < 0 || row < 0 || column >= matrix.width || row >= matrix.height) {
        hover = null;
      } else {
        var value = matrix.values[row * matrix.width + column];
        var y = matrix.yUp ? matrix.height - 1 - row : row;
        hover = { label: matrix.xLabel + ' ' + column + ', ' + matrix.yLabel + ' ' + y + ': ' + value.toPrecision(4) };
      }
      render();
    });
    canvas.addEventListener('mouseleave', function () { hover = null; render(); });
  }

  /* ── Controls ─────────────────────────────────────────────────────── */

  function fillSelect(select, entries, value) {
    if (!select) return;
    select.innerHTML = '';
    entries.forEach(function (entry) {
      var option = document.createElement('option');
      option.value = entry[0];
      option.textContent = entry[1];
      select.appendChild(option);
    });
    select.value = value;
  }

  function wire() {
    if (wired) return;
    wired = true;
    fillSelect(el('simSize'), SIZES.map(function (n) { return [String(n), n + '²']; }), String(size));
    fillSelect(el('simSpins'), SPIN_CHOICES.map(function (choice) {
      return [choice, choice === 'auto' ? 'Auto' : choice.replace('x', ' × ')];
    }), spins);
    fillSelect(el('simView'), Object.keys(VIEWS).map(function (key) { return [key, VIEWS[key]]; }), view);
    fillSelect(el('simCmap'), SG_COLORMAP_NAMES.map(function (name) {
      return [name, SG_COLORMAP_LABELS[name] || name];
    }), colormapName);

    var sizeSelect = el('simSize');
    if (sizeSelect) sizeSelect.onchange = function () { size = +this.value; set('seqeyes.simulation.size', String(size)); };
    var spinSelect = el('simSpins');
    if (spinSelect) spinSelect.onchange = function () { spins = this.value; set('seqeyes.simulation.spins', spins); };
    var viewSelect = el('simView');
    if (viewSelect) viewSelect.onchange = function () {
      view = this.value;
      set('seqeyes.simulation.view', view);
      hover = null;
      render();
    };
    var cmap = el('simCmap');
    if (cmap) cmap.onchange = function () {
      colormapName = this.value;
      set('seqeyes.simulation.colormap', colormapName);
      render();
    };
    var log = el('simLog');
    if (log) log.onclick = function () {
      logScale[view] = !logScale[view];
      set('seqeyes.simulation.log.' + view, logScale[view] ? '1' : '0');
      render();
    };
    var frameSelect = el('simFrame');
    if (frameSelect) frameSelect.onchange = function () { frame = +this.value || 0; render(); };
    var runButton = el('simRun');
    if (runButton) runButton.onclick = startRun;
    var cancel = el('simCancel');
    if (cancel) cancel.onclick = cancelRun;

    wireCanvas();
    var body = el('simBody');
    if (body && typeof ResizeObserver !== 'undefined') new ResizeObserver(function () { resize(); }).observe(body);
    syncButtons();
  }

  /* ── Lifecycle hooks (called by panel.js) ─────────────────────────── */

  function install() {
    wire();
    var button = el('simBtn');
    if (button) button.hidden = !isAvailable();
  }

  function onShown() {
    shown = true;
    install();
    if (!result && !(run && !run.finished)) {
      var source = isAvailable() ? host().getSequenceSource() : null;
      setStatus([source ? 'Press Run to simulate ' + (source.name || 'the open sequence')
        + ' on a Shepp–Logan phantom (2D, z = 0).' : 'Open a Pulseq sequence first.']);
    }
    requestAnimationFrame(resize);
  }

  function onHidden() {
    shown = false;
    hover = null;
  }

  function onSequenceLoaded() {
    if (run && !run.finished) {
      run.finished = true;
      stopWorkers(run);
    }
    run = null;
    result = null;
    frame = 0;
    zoom = { image: null, kspace: null, raw: null };
    offscreenKey = '';
    setProgress(null);
    if (shown) onShown();
    syncButtons();
    render();
  }

  function state() {
    return {
      available: isAvailable(),
      shown: shown,
      running: !!(run && !run.finished),
      runs: runCounter,
      workers: run ? run.workers.length : 0,
      view: view,
      size: size,
      spins: spins,
      plan: result ? result.plan : (run ? run.plan : null),
      done: !!result,
      nu: result ? result.recon.nu : 0,
      nv: result ? result.recon.nv : 0,
      frames: result ? result.recon.frames : 0,
      timings: result ? result.timings : null,
      status: el('simReadout') ? el('simReadout').textContent : ''
    };
  }

  /** Image statistics for tests: mean of the displayed matrix and its peak. */
  function matrixSummary() {
    var matrix = currentMatrix();
    if (!matrix) return null;
    var sum = 0, max = 0;
    for (var i = 0; i < matrix.values.length; i++) {
      sum += matrix.values[i];
      if (matrix.values[i] > max) max = matrix.values[i];
    }
    return { width: matrix.width, height: matrix.height, mean: sum / matrix.values.length, max: max };
  }

  return {
    install: install,
    isAvailable: isAvailable,
    onShown: onShown,
    onHidden: onHidden,
    onSequenceLoaded: onSequenceLoaded,
    onThemeChanged: function () { offscreenKey = ''; render(); },
    resize: resize,
    run: startRun,
    cancel: cancelRun,
    setView: function (name) { if (VIEWS[name]) { view = name; fillSelect(el('simView'), Object.keys(VIEWS).map(function (key) { return [key, VIEWS[key]]; }), view); render(); } },
    setSettings: function (options) {
      if (options && SIZES.indexOf(options.size) >= 0) { size = options.size; if (el('simSize')) el('simSize').value = String(size); }
      if (options && SPIN_CHOICES.indexOf(options.spins) >= 0) { spins = options.spins; if (el('simSpins')) el('simSpins').value = spins; }
    },
    state: state,
    matrixSummary: matrixSummary
  };
})();
