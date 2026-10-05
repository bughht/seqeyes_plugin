/* ═══════════════════════════════════════════════════════════════════════
   Simulation panel — Bloch simulation of the open sequence on a phantom

   Pure UI and scheduling. The simulator is a separate worker script
   (web/sim-worker.js, built from src/sim/worker/entry.ts) that the host
   creates through `createSimulationWorker()`; this file never touches the
   parser or the engine, which the VS Code webview does not even load. A host
   without that hook keeps the Simulation button hidden.

   Phantoms: the built-in Shepp–Logan, MRzero's example phantoms fetched
   from its GitHub repository on request (pinned commit, SHA-256 checked;
   nothing is bundled), or the user's own files. A long-lived phantom worker
   parses files and keeps the volume, so a new slice or plane is cheap.

   A run:
     1. the first worker opens the job and returns its plan: spins per voxel
        (probed for spoiled axes), folding, and how many chunks;
     2. more workers open the same job with the plan's spins per voxel, so
        they split it into the same chunks without probing again;
     3. chunks go one at a time to whichever worker is idle, and their
        signals are added in chunk order, so the result does not depend on
        the worker count;
     4. the first worker reconstructs and keeps the job for exports.
   While it runs, a progress card shows the phase, overall progress and each
   worker's chunk. Chunks are strips of phantom columns simulated through the
   whole sequence, so the partial signal is the signal of the strips done so
   far: the raw views show it as it builds up, and the (otherwise idle)
   phantom worker reconstructs it about twice a second, so the image fills in
   strip by strip.

   Spins along z: the plan places sub-slices wherever the sequence's pulses
   act along z (src/sim/plan/slices.ts), so slice profiles, refocusing and
   inversion slabs and multiband pulses act on a 2-D phantom as on a slab.
   The RF pulses tab shows every pulse's measured response (across z, or
   against off-resonance), before any run; the phantom worker measures it
   when a sequence opens. A 3-D phantom brings the neighbouring planes the
   slabs reach.

   Results are shown with SeqEyesNdView (ndview.js): any two dimensions of
   the raw data, k-space, images or phantom maps as an image, the waveform
   along one of them as a line plot, hover marking the sample's time on the
   sequence timeline.
   ═══════════════════════════════════════════════════════════════════════ */

var SeqEyesSimulation = (function () {
  var get = SeqEyesPrefs.get, set = SeqEyesPrefs.set;

  /* MRzero-Core's example phantoms, fetched from GitHub only when chosen.
     Pinned to a commit and checked against SHA-256 so a preset is always the
     same data. MRzero-Core is AGPL-3.0; the brains derive from BrainWeb. */
  var MRZERO_COMMIT = '5bca8551d1af6dd8eed4ae1ed32eadd9a456310f';
  var MRZERO_BASE = 'https://raw.githubusercontent.com/MRsources/MRzero-Core/' + MRZERO_COMMIT + '/documentation/playground_mr0/';
  var PRESETS = {
    'shepp-logan': { label: 'Shepp–Logan (built-in)' },
    'mrzero-brain': {
      label: 'MRzero brain 2D (178 kB)', file: 'numerical_brain_cropped.mat', bytes: 178137,
      sha256: 'f32dcc37838e973caae1fc75deb0a803f4bee2bff29fb12589ae0ef5ec63f381'
    },
    'brainweb-05': {
      label: 'BrainWeb subject 05, 3 T (19 MB)', file: 'subject05.npz', bytes: 19405412,
      sha256: '0d59932b8d0cb20fcf603c38402e8afa98bdd95872c88d287e01fa48ac9c62d7'
    },
    'brainweb-04-7t': {
      label: 'BrainWeb subject 04, 7 T (19 MB)', file: 'subject04_7T-noise.npz', bytes: 19003594,
      sha256: '7f2690be27bd049ec68fead6e6f457c21867871f52c09293ec8947e84d6c0e7a'
    },
    'file': { label: 'Your file…' }
  };
  var PRESET_ORDER = ['shepp-logan', 'mrzero-brain', 'brainweb-05', 'brainweb-04-7t', 'file'];
  var SHEPP_SIZES = [32, 64, 128, 256];
  var FILE_MATRICES = [0, 64, 96, 128, 192, 256];
  var SPIN_CHOICES = ['auto', '1x1', '8x1', '32x1', '128x1', '384x1', '768x1'];
  var COIL_CHOICES = [1, 2, 4, 8, 16];
  /* What Auto aims for: the signal error it accepts from the spin discretisation (per tissue, relative L2). */
  var ACCURACY_CHOICES = [['0.02', 'Accurate (2 %)'], ['0.05', 'Fast (5 %)'], ['0.1', 'Draft (10 %)']];
  var FIELD_CHOICES = [
    ['file', 'B0/B1: file, else ideal'],
    ['mrzero', 'B0/B1: file, else MRzero-style'],
    ['none', 'B0/B1: ideal']
  ];
  var SLICE_CHOICES = [['auto', 'Slices: auto'], ['off', 'Slices: z = 0']];
  var DATA_TABS = [['phantom', 'Phantom'], ['rf', 'RF pulses'], ['raw', 'Raw'], ['kspace', 'k-space'], ['image', 'Image']];
  var RF_AXES = [['z', 'across z'], ['frequency', 'against Δf']];
  /** Points of the RF views, and what they show of each pulse (from equilibrium, no relaxation). */
  var RF_POINTS = 1024;
  var RF_QUANTITIES = ['tip', '|Mxy|', 'Mz', 'Mx', 'My'];
  var RF_UNITS = ['°', '', '', '', ''];
  /** Pulse-measurement requests to the phantom worker use their own id range. */
  var PULSE_ID_BASE = 1e9;
  var EXPORTS = [
    ['ismrmrd-h5', 'ISMRMRD raw data (.h5)'],
    ['ismrmrd-stream', 'ISMRMRD stream (.bin)'],
    ['npz', 'NumPy raw + labels (.npz)'],
    ['png', 'Current view (.png)']
  ];

  function choice(value, allowed, fallback) { return allowed.indexOf(value) >= 0 ? value : fallback; }

  var phantomChoice = choice(get('seqeyes.simulation.phantom'), PRESET_ORDER, 'shepp-logan');
  if (phantomChoice === 'file') phantomChoice = 'shepp-logan';    // files are not remembered
  var sheppSize = choice(+get('seqeyes.simulation.size'), SHEPP_SIZES, 128);
  var fileMatrix = choice(+get('seqeyes.simulation.matrix'), FILE_MATRICES, 0);
  var fields = choice(get('seqeyes.simulation.fields'), FIELD_CHOICES.map(function (f) { return f[0]; }), 'file');
  var coils = choice(+get('seqeyes.simulation.coils'), COIL_CHOICES, 1);
  var spins = choice(get('seqeyes.simulation.spins'), SPIN_CHOICES, 'auto');
  var accuracy = choice(get('seqeyes.simulation.accuracy'), ACCURACY_CHOICES.map(function (a) { return a[0]; }), '0.02');
  var sliceMode = choice(get('seqeyes.simulation.slices'), SLICE_CHOICES.map(function (c) { return c[0]; }), 'auto');
  var rfAxis = choice(get('seqeyes.simulation.rfAxis'), RF_AXES.map(function (a) { return a[0]; }), 'z');
  var dataTab = choice(get('seqeyes.simulation.data'), DATA_TABS.map(function (t) { return t[0]; }), 'image');
  /* The progress card can sit minimized in the corner (remembered). */
  var cardMinimized = get('seqeyes.simulation.cardMinimized') === '1';
  var rawOrder = choice(get('seqeyes.simulation.rawOrder'), ['labels', 'acquisition', 'time'], 'labels');
  var slicePlane = choice(get('seqeyes.simulation.plane'), ['xy', 'xz', 'yz'], 'xy');
  var sliceIndex = null;          // null: the middle of the volume

  var shown = false;
  var wired = false;
  var viewer = null;

  /* Phantom state. */
  var phantomWorker = null;
  var phantomRequest = 0;
  var phantom = { status: 'idle', id: 0, data: null, volume: null, label: '', error: null };
  var uploaded = null;            // { label, files } of the user's last upload
  var presetBytes = {};           // preset id → ArrayBuffer (fetched once per session)

  /* The open sequence's RF pulses, measured by the phantom worker. */
  var pulseRequest = PULSE_ID_BASE;
  var pulses = { status: 'idle', id: 0, list: null, error: null };

  /* Run state. */
  var runCounter = 0;
  var run = null;
  var result = null;              // the last finished run
  var datasets = {};
  var exportCounter = 0;
  /** Live previews of a running simulation are rebuilt at most this often [ms]. */
  var PREVIEW_SPACING_MS = 500;

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
  function formatBytes(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' kB'; }
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function describeBands(bands) {
    return bands.map(function (band) {
      var upper = isFinite(band.t2Max) ? '≤' + (band.t2Max >= 1 ? band.t2Max + ' s' : Math.round(band.t2Max * 1000) + ' ms') : '>' + band.t2Min + ' s';
      return upper + ': ' + band.count;
    }).join(', ');
  }

  function describePlan(plan) {
    var axes = plan.axes.map(function (axis, i) {
      var name = 'xy'.charAt(i);
      if (i === 0 && plan.bands && plan.bands.length) return 'x by T2 (' + describeBands(plan.bands) + ')';
      if (axis.reason === 'manual') return name + ' ' + axis.count;
      var text = name + ' ' + axis.count;
      if (axis.reason === 'spoiling' || axis.reason === 'resolution') text += ' (' + axis.reason;
      if (axis.probe) text += ', ' + (100 * axis.probe.error).toFixed(1) + ' % probe error';
      if (axis.reason === 'spoiling' || axis.reason === 'resolution') text += ')';
      if (axis.folded) text += ' folded';
      return text;
    });
    return plan.phantom.source + ' · ' + plan.phantom.nx + '×' + plan.phantom.ny
      + ' · spins/voxel ' + axes.join(', ')
      + (plan.slices ? ' · ' + plan.slices.count + ' sub-slices' + (plan.slices.planes > 1 ? ' over ' + plan.slices.planes + ' planes' : '') : ' · z = 0')
      + ' · ' + formatCount(plan.spins) + ' spins, ' + formatCount(plan.simulated) + ' simulated'
      + (plan.coils > 1 ? ' · ' + plan.coils + ' coils' : '')
      + ' · ' + plan.rfEvents + ' RF, ' + plan.adcEvents + ' ADC';
  }

  /* ── Status line and progress ─────────────────────────────────────── */

  var statusLines = [], statusWarnings = [];
  function setStatus(lines, warnings) {
    statusLines = lines || [];
    statusWarnings = warnings || [];
    var node = el('simReadout');
    if (!node) return;
    node.innerHTML = statusLines.map(function (line) { return '<div>' + escapeHtml(line) + '</div>'; }).join('')
      + statusWarnings.map(function (line) { return '<div class="sg-warn">' + escapeHtml(line) + '</div>'; }).join('');
  }

  function setProgress(fraction) {
    var bar = el('simProgress'), fill = el('simProgressFill');
    if (!bar || !fill) return;
    var active = fraction !== null && fraction !== undefined;
    bar.classList.toggle('on', active);
    fill.style.width = active ? Math.round(100 * Math.max(0, Math.min(1, fraction))) + '%' : '0%';
  }

  /* ── Phantom ──────────────────────────────────────────────────────── */

  function ensurePhantomWorker() {
    if (phantomWorker) return phantomWorker;
    phantomWorker = host().createSimulationWorker();
    phantomWorker.onmessage = function (event) { onPhantomMessage(event.data); };
    phantomWorker.onerror = function (event) {
      if (event && event.preventDefault) event.preventDefault();
      phantomWorker = null;
      phantomFailed(phantom.id, 'The phantom worker failed: ' + (event && event.message || 'unknown error'));
    };
    return phantomWorker;
  }

  function sliceOptions() {
    var options = { plane: slicePlane };
    if (sliceIndex !== null) options.index = sliceIndex;
    if (fileMatrix > 0) options.matrix = fileMatrix;
    return options;
  }

  /** Load the chosen phantom (or a new plane of it). */
  function loadPhantom(reason) {
    if (!isAvailable()) return;
    var id = ++phantomRequest;
    phantom.status = 'loading';
    phantom.id = id;
    phantom.error = null;
    syncControls();
    if (phantomChoice === 'shepp-logan') {
      var source = host().getSequenceSource();
      var request = { kind: 'shepp-logan', size: sheppSize };
      var transfer = [];
      if (source && source.bytes) {
        var copy = source.bytes.slice();
        request.sequence = copy.buffer;
        request.name = source.name || '';
        transfer.push(copy.buffer);
      }
      phantom.label = 'Shepp–Logan';
      postPhantom(id, request, transfer);
      return;
    }
    if (reason === 'slice' && phantom.volume) {
      var sliceRequest = { kind: 'slice', fields: fields, slice: sliceOptions() };
      postPhantom(id, sliceRequest, withSequence(sliceRequest));
      return;
    }
    if (phantomChoice === 'file') {
      if (!uploaded) { phantom.status = 'idle'; syncControls(); return; }
      phantom.label = uploaded.label;
      postFiles(id, uploaded.files);
      return;
    }
    var preset = PRESETS[phantomChoice];
    phantom.label = preset.label;
    if (presetBytes[phantomChoice]) {
      postFiles(id, [{ name: preset.file, bytes: presetBytes[phantomChoice] }]);
      return;
    }
    fetchPreset(phantomChoice, id);
  }

  function postFiles(id, files) {
    var copies = files.map(function (file) { return { name: file.name, bytes: file.bytes.slice(0) }; });
    var request = { kind: 'files', files: copies, fields: fields, slice: sliceOptions() };
    postPhantom(id, request, copies.map(function (file) { return file.bytes; }).concat(withSequence(request)));
  }

  /**
   * Attach a copy of the open sequence to a phantom request, so a 3-D
   * phantom comes with the neighbouring planes its slabs reach. Returns the
   * buffers to transfer.
   */
  function withSequence(request) {
    var source = sliceMode === 'auto' && host() && host().getSequenceSource();
    if (!source || !source.bytes || !source.bytes.length) return [];
    var copy = source.bytes.slice();
    request.sequence = copy.buffer;
    request.name = source.name || '';
    phantom.sequenceBytes = source.bytes;
    return [copy.buffer];
  }

  /** Measure the open sequence's RF pulses (for the RF pulses tab). */
  function requestPulses() {
    if (!isAvailable()) return;
    datasets.rf = null;
    datasets.rfSpectral = null;
    var source = host().getSequenceSource();
    if (!source || !source.bytes || !source.bytes.length) { pulses = { status: 'idle', id: 0, list: null, error: null }; return; }
    var id = ++pulseRequest;
    pulses = { status: 'loading', id: id, list: null, error: null };
    var copy = source.bytes.slice();
    try {
      ensurePhantomWorker().postMessage({ type: 'pulses', id: id, bytes: copy.buffer, name: source.name || '' }, [copy.buffer]);
    } catch (error) {
      pulses.status = 'error';
      pulses.error = String(error && error.message || error);
    }
  }

  function onPulses(message) {
    if (message.id !== pulses.id) return;
    pulses.status = 'ready';
    pulses.list = message.pulses;
    datasets.rf = rfDataset(message.pulses, 'z');
    datasets.rfSpectral = rfDataset(message.pulses, 'frequency');
    if (!datasets.rf && rfAxis === 'z') rfAxis = 'frequency';
    syncControls();
    if (dataTab === 'rf') refreshView();
  }

  function postPhantom(id, request, transfer) {
    try {
      ensurePhantomWorker().postMessage({ type: 'phantom', id: id, request: request }, transfer);
    } catch (error) {
      phantomFailed(id, 'Could not start the phantom worker: ' + (error && error.message || error));
    }
  }

  function fetchPreset(presetId, id) {
    var preset = PRESETS[presetId];
    setStatus(['Downloading ' + preset.file + ' (' + formatBytes(preset.bytes) + ') from MRsources/MRzero-Core on GitHub…']);
    setProgress(0);
    fetch(MRZERO_BASE + preset.file).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var total = +response.headers.get('content-length') || preset.bytes;
      if (!response.body || !response.body.getReader) return response.arrayBuffer();
      var reader = response.body.getReader(), chunks = [], received = 0;
      function pump() {
        return reader.read().then(function (part) {
          if (part.done) {
            var all = new Uint8Array(received), offset = 0;
            chunks.forEach(function (chunk) { all.set(chunk, offset); offset += chunk.length; });
            return all.buffer;
          }
          chunks.push(part.value);
          received += part.value.length;
          if (id === phantomRequest) setProgress(received / total);
          return pump();
        });
      }
      return pump();
    }).then(function (buffer) {
      return verifyDigest(buffer, preset.sha256).then(function () { return buffer; });
    }).then(function (buffer) {
      presetBytes[presetId] = buffer;
      if (id !== phantomRequest) return;
      setProgress(null);
      setStatus(['Parsing ' + preset.file + '…']);
      postFiles(id, [{ name: preset.file, bytes: buffer }]);
    }).catch(function (error) {
      setProgress(null);
      phantomFailed(id, 'Could not download ' + preset.file + ': ' + (error && error.message || error)
        + '. You can download it from github.com/MRsources/MRzero-Core and load it as your file.');
    });
  }

  /** SHA-256 check where WebCrypto exists (secure contexts); skipped elsewhere. */
  function verifyDigest(buffer, expected) {
    var subtle = typeof crypto !== 'undefined' && crypto.subtle;
    if (!subtle || !expected) return Promise.resolve();
    return subtle.digest('SHA-256', buffer).then(function (digest) {
      var hex = Array.prototype.map.call(new Uint8Array(digest), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      if (hex !== expected) throw new Error('the download does not match the pinned SHA-256');
    });
  }

  function onPhantomMessage(message) {
    if (!message) return;
    if (message.type === 'preview') { onPreview(message); return; }
    if (message.type === 'pulses') { onPulses(message); return; }
    if (message.type === 'error' && message.id > PULSE_ID_BASE) {
      if (message.id === pulses.id) { pulses.status = 'error'; pulses.error = message.message; syncControls(); }
      return;
    }
    if (message.type === 'error' && run && message.id === run.id && run.previewPending) {
      // A failed preview is not worth stopping the run for.
      run.previewPending = false;
      return;
    }
    if (message.type === 'error') { phantomFailed(message.id, message.message); return; }
    if (message.type !== 'phantom' || message.id !== phantomRequest) return;
    phantom.status = 'ready';
    phantom.data = message.phantom;
    phantom.volume = message.volume;
    if (phantom.runWhenReady) {
      phantom.runWhenReady = false;
      setTimeout(startRun, 0);
    }
    if (message.volume && sliceIndex === null) sliceIndex = Math.floor(sliceAxisSize() / 2);
    datasets.phantom = phantomDataset(message.phantom);
    syncControls();
    describePhantom();
    if (dataTab === 'phantom' || !result) showData(result ? dataTab : 'phantom');
  }

  function phantomFailed(id, text) {
    if (id !== phantomRequest && id !== -1) return;
    phantom.status = 'error';
    phantom.error = text;
    syncControls();
    setStatus([], ['Phantom: ' + text]);
  }

  function describePhantom() {
    if (!phantom.data || (run && !run.finished)) return;
    var p = phantom.data;
    var lines = [p.source + ' · ' + p.nx + '×' + p.ny + ' at ' + (p.voxel[0] * 1000).toFixed(2) + '×' + (p.voxel[1] * 1000).toFixed(2) + ' mm'
      + (phantom.volume ? ' · volume ' + phantom.volume.shape.join('×') : '')];
    if (!result) {
      lines.push('Press Run to simulate the open sequence on this phantom' + (sliceMode === 'auto'
        ? ', with spins through the slab wherever the pulses act along z.'
        : ' (2-D, every spin at z = 0).'));
    }
    setStatus(lines.concat(result ? statusForResultLines() : []), (p.notes || []).concat(result ? resultWarnings() : []));
  }

  function sliceAxisSize() {
    if (!phantom.volume) return 1;
    var axis = slicePlane === 'xy' ? 2 : slicePlane === 'xz' ? 1 : 0;
    return phantom.volume.shape[axis];
  }

  function readUploadedFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var reads = files.map(function (file) {
      return file.arrayBuffer().then(function (bytes) { return { name: file.name, bytes: bytes }; });
    });
    Promise.all(reads).then(function (loaded) {
      uploaded = { label: loaded.map(function (f) { return f.name; }).join(', '), files: loaded };
      phantomChoice = 'file';
      sliceIndex = null;
      phantom.volume = null;
      syncControls();
      loadPhantom('choice');
    }).catch(function (error) {
      setStatus([], ['Could not read the file: ' + (error && error.message || error)]);
    });
  }

  /* ── Running ──────────────────────────────────────────────────────── */

  function workerBudget(bytes) {
    var cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    var count = Math.max(1, Math.min(8, cores - 1));
    if (bytes > 32 * 1024 * 1024) count = Math.min(count, 2);   // every worker parses its own copy
    return count;
  }

  function jobSettings() {
    var settings = { phantom: { kind: 'phantom', phantom: phantom.data }, coils: coils, subSpins: 'auto', tolerance: +accuracy, throughSlice: sliceMode };
    if (spins !== 'auto') settings.subSpins = spins.split('x').map(Number);
    return settings;
  }

  function startRun() {
    if (!isAvailable()) return;
    var source = host().getSequenceSource();
    if (!source || !source.bytes || !source.bytes.length) { setStatus(['Open a Pulseq sequence first.']); return; }
    if (phantom.status !== 'ready' || !phantom.data) { setStatus(['The phantom is not ready yet.']); return; }
    if (phantom.volume && sliceMode === 'auto' && phantom.sequenceBytes !== source.bytes) {
      // The neighbouring planes depend on the sequence's slabs: cut them first.
      phantom.runWhenReady = true;
      loadPhantom('slice');
      return;
    }
    stopRun(run);
    var settings = jobSettings();
    run = {
      id: ++runCounter, source: source, settings: settings, started: now(), planMs: 0, plan: null,
      workers: [], budget: workerBudget(source.bytes.length), nextChunk: 0, added: 0, pending: {},
      signal: null, progress: {}, finished: false, exports: {}
    };
    var leader = spawnWorker(run);
    if (!leader) return;
    openJob(run, leader, settings, true);
    run.phase = 'planning';
    run.planMessage = 'Parsing the sequence';
    run.planFraction = 0;
    setStatus(['Planning: parsing the sequence and choosing spins per voxel…']);
    setProgress(0);
    renderRunCard(run);
    syncControls();
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

  function openJob(r, slot, settings, withLayout) {
    var copy = r.source.bytes.slice();
    slot.worker.postMessage({
      type: 'open', job: r.id, bytes: copy.buffer, name: r.source.name || 'sequence.seq', settings: settings,
      layout: !!withLayout
    }, [copy.buffer]);
  }

  function onWorkerMessage(r, slot, message) {
    if (!message || message.job !== r.id) return;
    if (message.type === 'export') { finishExport(r, message); return; }
    if (message.type === 'error' && message.id >= 0 && r.exports[message.id]) { exportFailed(r, message.id, message.message); return; }
    if (r !== run || r.finished) return;
    switch (message.type) {
      case 'planProgress':
        if (r.plan) break;
        r.planMessage = message.message;
        r.planFraction = message.fraction;
        renderRunCard(r);
        break;
      case 'plan':
        slot.ready = true;
        if (!r.plan) {
          r.plan = message.plan;
          r.layout = message.layout || null;
          r.planMs = now() - r.started;
          r.simulateStarted = now();
          r.phase = 'simulating';
          openPreview(r);
          // Followers take the leader's spins per voxel and sub-slices: same chunks, no probe.
          var followers = Math.min(r.budget, r.plan.chunks) - 1;
          var settings = {
            phantom: r.settings.phantom, coils: r.settings.coils, tolerance: r.settings.tolerance,
            subSpins: r.plan.resolved, throughSlice: r.plan.resolvedSlices
          };
          for (var i = 0; i < followers; i++) {
            var follower = spawnWorker(r);
            if (!follower) return;
            openJob(r, follower, settings);
          }
        } else if (message.plan.chunks !== r.plan.chunks || message.plan.spins !== r.plan.spins
          || message.plan.simulated !== r.plan.simulated) {
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
        else {
          dispatch(r, slot);
          schedulePreview(r);
        }
        reportProgress(r);
        break;
      case 'recon':
        finish(r, message);
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
    r.phase = 'reconstructing';
    renderRunCard(r);
    // Every chunk is in: free the followers; the leader keeps the job for exports.
    for (var i = 1; i < r.workers.length; i++) r.workers[i].worker.terminate();
    r.workers.length = Math.min(1, r.workers.length);
    setStatus([describePlan(r.plan), 'Reconstructing…']);
    r.workers[0].worker.postMessage({ type: 'recon', job: r.id, signal: r.signal.slice() });
  }

  function reportProgress(r) {
    if (!r.plan) return;
    var partial = 0;
    for (var key in r.progress) if (Object.prototype.hasOwnProperty.call(r.progress, key)) partial += r.progress[key];
    var fraction = (r.added + partial) / r.plan.chunks;
    setProgress(fraction);
    var elapsed = now() - r.simulateStarted;
    var line = 'Simulating: ' + r.added + '/' + r.plan.chunks + ' chunks on ' + r.workers.length
      + (r.workers.length === 1 ? ' worker' : ' workers') + ' · ' + formatSeconds(elapsed);
    if (fraction > 0.05) line += ' · about ' + formatSeconds(elapsed * (1 - fraction) / fraction) + ' left';
    setStatus([describePlan(r.plan), line], r.plan.notes);
    renderRunCard(r);
  }

  /* ── Progress card and live previews ──────────────────────────────── */

  function chunkProgress(r) {
    var partial = 0;
    for (var key in r.progress) if (Object.prototype.hasOwnProperty.call(r.progress, key)) partial += r.progress[key];
    var pending = 0;
    for (key in r.pending) if (Object.prototype.hasOwnProperty.call(r.pending, key)) pending++;
    return { done: r.added + pending, partial: partial };
  }

  /** The phase, overall progress, throughput and one bar per worker (or, minimized, phase and percent). */
  function renderRunCard(r) {
    var card = el('simRunCard');
    if (!card) return;
    var active = !!(r && r === run && !r.finished);
    card.hidden = !active;
    if (!active) return;
    card.classList.toggle('mini', cardMinimized);
    var toggle = el('simRunMin');
    if (toggle) {
      toggle.textContent = cardMinimized ? '▢' : '–';
      toggle.title = cardMinimized ? 'Restore the progress card' : 'Minimize the progress card to the corner';
      toggle.setAttribute('aria-pressed', cardMinimized ? 'true' : 'false');
    }
    var phase, fraction, stats = '';
    if (r.phase === 'planning' || !r.plan) {
      phase = 'Planning · ' + (r.planMessage || '…');
      fraction = r.planFraction || 0;
      stats = 'elapsed ' + formatSeconds(now() - r.started);
    } else if (r.phase === 'reconstructing') {
      phase = 'Reconstructing';
      fraction = 1;
      stats = r.plan.chunks + ' chunks simulated in ' + formatSeconds(r.simulateMs || 0);
    } else {
      var progress = chunkProgress(r);
      fraction = Math.min(1, (progress.done + progress.partial) / r.plan.chunks);
      var elapsed = now() - r.simulateStarted;
      phase = 'Simulating';
      stats = progress.done + '/' + r.plan.chunks + ' chunks · '
        + formatCount(Math.round(fraction * r.plan.simulated)) + ' of ' + formatCount(r.plan.simulated) + ' spins · '
        + formatSeconds(elapsed) + (fraction > 0.03 ? ' · ~' + formatSeconds(elapsed * (1 - fraction) / fraction) + ' left' : '')
        + (elapsed > 500 ? ' · ' + formatCount(Math.round(fraction * r.plan.simulated / (elapsed / 1000))) + ' spins/s' : '');
    }
    el('simRunPhase').textContent = phase;
    el('simRunPercent').textContent = Math.round(100 * fraction) + '%';
    el('simRunFill').style.width = (100 * fraction).toFixed(1) + '%';
    el('simRunStats').textContent = stats;
    var workers = el('simRunWorkers');
    var count = r.phase === 'simulating' ? r.workers.length : 0;
    while (workers.children.length > count) workers.removeChild(workers.lastChild);
    while (workers.children.length < count) {
      var bar = document.createElement('div');
      bar.className = 'sim-run-worker';
      bar.appendChild(document.createElement('div'));
      workers.appendChild(bar);
    }
    for (var i = 0; i < count; i++) {
      var slot = r.workers[i];
      var own = slot.chunk >= 0 ? (r.progress[slot.chunk] || 0) : 0;
      workers.children[i].firstChild.style.width = (100 * own).toFixed(0) + '%';
      workers.children[i].title = 'Worker ' + (i + 1) + (slot.chunk >= 0 ? ': chunk ' + (slot.chunk + 1) : ': idle');
    }
  }

  /** The phantom worker reconstructs partial signals while the run's workers simulate. */
  function openPreview(r) {
    if (!phantomWorker || !r.layout) return;
    var copy = r.source.bytes.slice();
    phantomWorker.postMessage({ type: 'previewOpen', id: r.id, bytes: copy.buffer, name: r.source.name || 'sequence.seq' }, [copy.buffer]);
  }

  function schedulePreview(r) {
    if (r.previewTimer || !r.layout) return;
    var wait = Math.max(0, PREVIEW_SPACING_MS - (now() - (r.lastPreview || 0)));
    r.previewTimer = setTimeout(function () { r.previewTimer = 0; livePreview(r); }, wait);
  }

  /** Every chunk that has arrived, summed (in order, then the ones still waiting their turn). */
  function partialSignal(r) {
    var length = r.signal ? r.signal.length : 0;
    var key;
    for (key in r.pending) if (Object.prototype.hasOwnProperty.call(r.pending, key)) { length = r.pending[key].length; break; }
    if (!length) return null;
    var out = r.signal ? r.signal.slice() : new Float64Array(length);
    for (key in r.pending) {
      if (!Object.prototype.hasOwnProperty.call(r.pending, key)) continue;
      var chunk = r.pending[key];
      for (var i = 0; i < out.length; i++) out[i] += chunk[i];
    }
    return out;
  }

  function livePreview(r) {
    if (r !== run || r.finished || !r.layout) return;
    r.lastPreview = now();
    var partial = partialSignal(r);
    if (!partial) return;
    var coilCount = r.layout.coils;
    r.liveChunks = chunkProgress(r).done;
    datasets.rawAcquisition = rawAcquisitionDataset(r.layout, partial, coilCount);
    datasets.rawLabels = rawLabelDataset(r.layout, partial, coilCount);
    datasets.rawTime = rawTimeDataset(r.layout, partial, coilCount);
    if (dataTab === 'raw') refreshView();
    if (phantomWorker && !r.previewPending) {
      r.previewPending = true;
      phantomWorker.postMessage({ type: 'preview', id: r.id, signal: partial, coils: coilCount }, [partial.buffer]);
    }
    syncControls();
  }

  /** A reconstructed partial signal: magnitude images and k-space for the live views. */
  function onPreview(message) {
    var r = run;
    if (!r || r.id !== message.id || r.finished) return;
    r.previewPending = false;
    var recon = message.recon;
    datasets.image = previewDataset('image', recon, recon.images, true);
    datasets.kspace = previewDataset('kspace', recon, recon.kspace, false);
    r.livePreviews = (r.livePreviews || 0) + 1;
    if (dataTab === 'image' || dataTab === 'kspace' || dataTab === 'phantom' && r.livePreviews === 1) {
      if (dataTab === 'phantom') dataTab = 'image';
      refreshView();
    }
    syncControls();
    if (chunkProgress(r).done > (r.liveChunks || 0)) schedulePreview(r);
  }

  function previewDataset(id, recon, values, isImage) {
    var nu = recon.nu, nv = recon.nv, axes = 'xyz';
    var pixel = recon.delta ? [1000 / (nu * recon.delta[0]), 1000 / (nv * recon.delta[1])] : null;
    var ux = axes.charAt(recon.axes[0]), uy = axes.charAt(recon.axes[1]);
    var dims = isImage
      ? [
        { name: ux, size: nu, scale: pixel ? { start: -nu / 2 * pixel[0], step: pixel[0], unit: 'mm' } : undefined },
        { name: uy, size: nv, reversed: true, scale: pixel ? { start: (nv / 2 - 1) * pixel[1], step: -pixel[1], unit: 'mm' } : undefined }
      ]
      : [{ name: 'k' + ux, size: nu }, { name: 'k' + uy, size: nv, reversed: true }];
    if (recon.frames > 1) dims.push({ name: 'frame', size: recon.frames });
    return {
      id: id, title: (isImage ? 'Image' : 'k-space') + ' (live preview)', live: true, square: true,
      pixelAspect: pixel ? pixel[1] / pixel[0] : 1, dims: dims, re: values, im: null,
      defaultX: 0, defaultY: 1, defaultLog: !isImage, defaultColormap: 'grey'
    };
  }

  /** Show the current tab's dataset again (after it was rebuilt), keeping the view choices. */
  function refreshView() {
    if (!viewer) return;
    var dataset = currentDataset(dataTab);
    viewer.setDataset(dataset);
    var empty = el('simEmpty');
    if (empty) empty.style.display = dataset ? 'none' : 'flex';
  }

  function finish(r, message) {
    r.finished = true;
    renderRunCard(r);
    var leader = r.workers[0];
    r.workers.length = 0;
    if (result && result.leader && result.leader !== leader) result.leader.worker.terminate();
    result = {
      run: r, leader: leader, plan: r.plan, signal: r.signal, recon: message.recon, layout: message.layout,
      phantom: message.phantom, name: r.source.name || '',
      timings: { totalMs: now() - r.started, planMs: r.planMs, simulateMs: r.simulateMs }
    };
    buildResultDatasets();
    setProgress(null);
    statusForResult();
    syncControls();
    showData(dataTab === 'phantom' ? 'image' : dataTab);
  }

  function statusForResultLines() {
    var t = result.timings;
    return [describePlan(result.plan), 'Done in ' + formatSeconds(t.totalMs) + ' (plan ' + formatSeconds(t.planMs)
      + ', simulate ' + formatSeconds(t.simulateMs) + ') · image ' + result.recon.nu + '×' + result.recon.nv
      + (result.recon.frames > 1 ? ' × ' + result.recon.frames + ' frames' : '')
      + ' · raw ' + result.layout.acquisitions + ' acquisitions'];
  }

  function resultWarnings() {
    return result.plan.notes.concat(result.recon.warnings || []).concat(datasets.rawLabels && datasets.rawLabels.notes || []);
  }

  function statusForResult() {
    if (!result) return;
    setStatus(statusForResultLines(), resultWarnings());
  }

  function fail(r, text) {
    if (!r || r !== run || r.finished) return;
    r.finished = true;
    renderRunCard(r);
    stopWorkers(r);
    setProgress(null);
    setStatus([], ['Simulation failed: ' + text]);
    syncControls();
  }

  function stopWorkers(r) {
    if (!r) return;
    for (var i = 0; i < r.workers.length; i++) r.workers[i].worker.terminate();
    r.workers.length = 0;
  }

  function stopRun(r) {
    if (r && !r.finished) { r.finished = true; stopWorkers(r); }
  }

  function cancelRun() {
    if (!run || run.finished) return;
    stopRun(run);
    renderRunCard(run);
    // Live previews belonged to the cancelled run; the last finished result is shown again.
    if (result) buildResultDatasets();
    else datasets = { phantom: datasets.phantom, rf: datasets.rf, rfSpectral: datasets.rfSpectral };
    refreshView();
    setProgress(null);
    setStatus(['Cancelled.'].concat(result ? ['Showing the previous result.'] : []));
    syncControls();
  }

  /* ── Datasets for the viewer ──────────────────────────────────────── */

  function coilLabels(count) {
    var labels = [];
    for (var c = 0; c < count; c++) labels.push('coil ' + (c + 1));
    return labels;
  }

  function phantomDataset(p) {
    var names = [['pd', 'PD', ''], ['t1', 'T1', 's'], ['t2', 'T2', 's'], ['t2prime', 'T2′', 's'],
      ['adc', 'ADC', 'm²/s'], ['b0', 'B0', 'Hz'], ['b1', 'B1+', '']];
    var present = names.filter(function (entry) { return p.maps[entry[0]]; });
    var cells = p.nx * p.ny;
    var coilCount = p.coils ? p.coils.count : 0;
    var count = present.length + (coilCount > 1 ? coilCount : 0);
    var re = new Float32Array(cells * count), im = coilCount > 1 ? new Float32Array(cells * count) : null;
    present.forEach(function (entry, m) { re.set(p.maps[entry[0]], m * cells); });
    var labels = present.map(function (entry) { return entry[1]; });
    var units = present.map(function (entry) { return entry[2]; });
    if (coilCount > 1) {
      for (var c = 0; c < coilCount; c++) {
        var slot = (present.length + c) * cells;
        re.set(p.coils.re.subarray(c * cells, (c + 1) * cells), slot);
        im.set(p.coils.im.subarray(c * cells, (c + 1) * cells), slot);
        labels.push('coil ' + (c + 1));
        units.push('');
      }
    }
    var dx = p.voxel[0] * 1000, dy = p.voxel[1] * 1000;
    return {
      id: 'phantom', title: 'Phantom maps', square: true, pixelAspect: dy / dx,
      dims: [
        { name: 'x', size: p.nx, fft: 'x', scale: { start: -p.nx / 2 * dx, step: dx, unit: 'mm' } },
        { name: 'y', size: p.ny, fft: 'x', reversed: true, scale: { start: (p.ny / 2 - 1) * dy, step: -dy, unit: 'mm' } },
        { name: 'map', size: count, labels: labels, units: units }
      ],
      re: re, im: im, defaultX: 0, defaultY: 1, defaultColormap: 'viridis'
    };
  }

  /** Label of one measured pulse: what it is, how long, how far it tips, where it acts. */
  function pulseLabel(p) {
    var parts = [p.role, (p.duration * 1000).toFixed(2) + ' ms', Math.round(p.peakFlipDeg) + '°'];
    if (p.freq) parts.push((p.freq > 0 ? '+' : '') + Math.round(p.freq) + ' Hz');
    if (p.bands && p.bands.length) {
      parts.push(p.bands.map(function (b) {
        return (b.thickness * 1000).toFixed(2) + ' mm @ ' + (b.centre * 1000).toFixed(1);
      }).join(', ') + ' mm');
    }
    parts.push('×' + p.events);
    return parts.join(' · ');
  }

  /** The response at u: linear between scan points, equilibrium outside the scanned regions. */
  function sampleResponse(p, u) {
    var inside = p.regions.some(function (r) { return u >= r[0] && u <= r[1]; });
    var offsets = p.offsets, n = offsets.length;
    if (!inside || !n || u < offsets[0] || u > offsets[n - 1]) return [0, 0, 1];
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (offsets[mid] <= u) lo = mid; else hi = mid;
    }
    var span = offsets[hi] - offsets[lo], t = span > 0 ? (u - offsets[lo]) / span : 0;
    return [p.mx[lo] + t * (p.mx[hi] - p.mx[lo]), p.my[lo] + t * (p.my[hi] - p.my[lo]), p.mz[lo] + t * (p.mz[hi] - p.mz[lo])];
  }

  /**
   * Every pulse that acts along z, across a common z window (or every other
   * pulse against off-resonance): the tip angle, |Mxy|, Mz, Mx and My after
   * the pulse from equilibrium, × pulse. The z window spans each band ±3
   * FWHM. Null when there is no such pulse.
   */
  function rfDataset(list, axis) {
    var chosen = (list || []).filter(function (p) { return p.axis === axis && p.offsets.length; });
    if (!chosen.length) return null;
    var lo = Infinity, hi = -Infinity;
    chosen.forEach(function (p) {
      if (axis === 'z' && p.bands.length) {
        p.bands.forEach(function (b) {
          var reach = 3 * Math.max(b.thickness, 1 / p.extentZ);
          lo = Math.min(lo, b.centre - reach);
          hi = Math.max(hi, b.centre + reach);
        });
      } else {
        p.regions.forEach(function (r) { lo = Math.min(lo, r[0]); hi = Math.max(hi, r[1]); });
      }
    });
    if (!(hi > lo)) return null;
    var n = RF_POINTS, step = (hi - lo) / (n - 1), q = RF_QUANTITIES.length;
    var re = new Float32Array(n * q * chosen.length);
    chosen.forEach(function (p, k) {
      var base = n * q * k;
      for (var i = 0; i < n; i++) {
        var m = sampleResponse(p, lo + i * step);
        re[base + i] = Math.acos(Math.max(-1, Math.min(1, m[2]))) * 180 / Math.PI;
        re[base + n + i] = Math.sqrt(m[0] * m[0] + m[1] * m[1]);
        re[base + 2 * n + i] = m[2];
        re[base + 3 * n + i] = m[0];
        re[base + 4 * n + i] = m[1];
      }
    });
    var alongZ = axis === 'z';
    return {
      id: 'rf-' + axis,
      title: alongZ ? 'RF pulses across z (from equilibrium, no relaxation)' : 'RF pulses against off-resonance at the isocentre',
      square: false,
      dims: [
        { name: alongZ ? 'z' : 'Δf', size: n, scale: alongZ ? { start: lo * 1000, step: step * 1000, unit: 'mm' } : { start: lo, step: step, unit: 'Hz' } },
        { name: 'quantity', size: q, labels: RF_QUANTITIES, units: RF_UNITS },
        { name: 'pulse', size: chosen.length, labels: chosen.map(pulseLabel) }
      ],
      re: re, im: null, defaultX: 0, defaultY: chosen.length > 1 ? 2 : -1, defaultPart: 're', defaultColormap: 'viridis'
    };
  }

  function buildResultDatasets() {
    var layout = result.layout, signal = result.signal, recon = result.recon;
    var coilCount = layout.coils;
    datasets.rawAcquisition = rawAcquisitionDataset(layout, signal, coilCount);
    datasets.rawLabels = rawLabelDataset(layout, signal, coilCount);
    datasets.rawTime = rawTimeDataset(layout, signal, coilCount);
    datasets.kspace = gridDataset('kspace', recon, recon.coilKspace, coilCount, false);
    datasets.image = gridDataset('image', recon, recon.coilImages, coilCount, true);
    if (result.phantom) datasets.phantom = phantomDataset(result.phantom);
  }

  function sampleTime(layout, acquisition, sample) {
    if (acquisition < 0 || sample >= layout.samples[acquisition]) return NaN;
    return layout.t0[acquisition] + (sample + 0.5) * layout.dwell[acquisition];
  }

  function sampleDim(layout, maxSamples) {
    var dwell = layout.dwell[0];
    var uniform = true;
    for (var a = 1; a < layout.acquisitions; a++) if (Math.abs(layout.dwell[a] - dwell) > 1e-12) { uniform = false; break; }
    var dim = { name: 'sample', size: maxSamples, fft: 'k', transformedName: 'readout position' };
    if (uniform) dim.scale = { start: 0.5 * dwell * 1e6, step: dwell * 1e6, unit: 'µs' };
    return dim;
  }

  /** Readout samples × acquisitions × coils, in acquisition order. */
  function rawAcquisitionDataset(layout, signal, coilCount) {
    var maxSamples = 0;
    for (var a = 0; a < layout.acquisitions; a++) maxSamples = Math.max(maxSamples, layout.samples[a]);
    var size = maxSamples * layout.acquisitions * coilCount;
    var re = new Float32Array(size), im = new Float32Array(size);
    for (a = 0; a < layout.acquisitions; a++) {
      for (var s = 0; s < layout.samples[a]; s++) {
        for (var c = 0; c < coilCount; c++) {
          var src = ((layout.offsets[a] + s) * coilCount + c) * 2;
          var dst = s + maxSamples * (a + layout.acquisitions * c);
          re[dst] = signal[src];
          im[dst] = signal[src + 1];
        }
      }
    }
    var dims = [sampleDim(layout, maxSamples), { name: 'acquisition', size: layout.acquisitions }];
    if (coilCount > 1) dims.push({ name: 'coil', size: coilCount, labels: coilLabels(coilCount) });
    return {
      id: 'raw-acquisition', title: 'Raw data (acquisition order)', square: false, dims: dims, re: re, im: im,
      defaultX: 0, defaultY: 1, defaultLog: true, defaultColormap: 'grey',
      timeOf: function (indices) { return sampleTime(layout, indices[1], indices[0]); },
      acquisitionOf: function (indices) { return indices[1]; }
    };
  }

  /**
   * Every ADC sample of the scan in time order (× coils): the received signal
   * as one waveform, shown as a line by default. Gaps between readouts are not
   * drawn; hovering gives each sample's time.
   */
  function rawTimeDataset(layout, signal, coilCount) {
    var total = signal.length / (2 * coilCount);
    var re = new Float32Array(total * coilCount), im = new Float32Array(total * coilCount);
    for (var i = 0; i < total; i++) {
      for (var c = 0; c < coilCount; c++) {
        re[i + total * c] = signal[(i * coilCount + c) * 2];
        im[i + total * c] = signal[(i * coilCount + c) * 2 + 1];
      }
    }
    var acquisitionOfSample = function (i) {
      var lo = 0, hi = layout.acquisitions - 1;
      while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (layout.offsets[mid] <= i) lo = mid; else hi = mid - 1;
      }
      return lo;
    };
    var dims = [{ name: 'ADC sample', size: total }];
    if (coilCount > 1) dims.push({ name: 'coil', size: coilCount, labels: coilLabels(coilCount) });
    return {
      id: 'raw-time', title: 'Received signal over the scan', square: false, dims: dims, re: re, im: im,
      defaultX: 0, defaultY: -1, defaultColormap: 'grey',
      timeOf: function (indices) {
        var a = acquisitionOfSample(indices[0]);
        return sampleTime(layout, a, indices[0] - layout.offsets[a]);
      },
      acquisitionOf: function (indices) { return acquisitionOfSample(indices[0]); }
    };
  }

  var LABEL_DIM_ORDER = ['LIN', 'PAR', 'SLC', 'ECO', 'PHS', 'REP', 'SET', 'SEG', 'AVG'];
  var LABEL_DIM_SKIP = ['ACQ', 'TRID', 'ONCE'];
  var MAX_LABEL_CELLS = 64e6;

  /**
   * Readout samples × the sequence's counters (LIN, PAR, SLC, ECO, …) ×
   * coils: the raw data as the labels index it. Null when the sequence has
   * no varying counter, or the grid would be too large.
   */
  function rawLabelDataset(layout, signal, coilCount) {
    var names = layout.labels.names, kinds = layout.labels.kinds, width = names.length;
    var used = [];
    for (var l = 0; l < width; l++) {
      if (kinds[l] !== 'counter' || LABEL_DIM_SKIP.indexOf(names[l]) >= 0) continue;
      var lo = Infinity, hi = -Infinity;
      for (var a = 0; a < layout.acquisitions; a++) {
        var v = layout.labels.values[a * width + l];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi > lo) used.push({ column: l, name: names[l], min: lo, size: hi - lo + 1 });
    }
    if (!used.length) return null;
    used.sort(function (p, q) {
      var rp = LABEL_DIM_ORDER.indexOf(p.name), rq = LABEL_DIM_ORDER.indexOf(q.name);
      return (rp < 0 ? 99 : rp) - (rq < 0 ? 99 : rq) || (p.name < q.name ? -1 : 1);
    });
    var maxSamples = 0;
    for (a = 0; a < layout.acquisitions; a++) maxSamples = Math.max(maxSamples, layout.samples[a]);
    var cellsPerSample = 1;
    used.forEach(function (dim) { cellsPerSample *= dim.size; });
    if (maxSamples * cellsPerSample * coilCount > MAX_LABEL_CELLS) return null;
    var acquisitionAt = new Int32Array(cellsPerSample).fill(-1);
    var collisions = 0;
    for (a = 0; a < layout.acquisitions; a++) {
      var cell = 0, stride = 1;
      for (var d = 0; d < used.length; d++) {
        cell += (layout.labels.values[a * width + used[d].column] - used[d].min) * stride;
        stride *= used[d].size;
      }
      if (acquisitionAt[cell] >= 0) collisions++;
      acquisitionAt[cell] = a;
    }
    var size = maxSamples * cellsPerSample * coilCount;
    var re = new Float32Array(size), im = new Float32Array(size);
    for (cell = 0; cell < cellsPerSample; cell++) {
      a = acquisitionAt[cell];
      if (a < 0) continue;
      for (var s = 0; s < layout.samples[a]; s++) {
        for (var c = 0; c < coilCount; c++) {
          var src = ((layout.offsets[a] + s) * coilCount + c) * 2;
          var dst = s + maxSamples * (cell + cellsPerSample * c);
          re[dst] = signal[src];
          im[dst] = signal[src + 1];
        }
      }
    }
    var dims = [sampleDim(layout, maxSamples)];
    used.forEach(function (dim) {
      var labels = [];
      for (var i = 0; i < dim.size; i++) labels.push(String(dim.min + i));
      dims.push({ name: dim.name, size: dim.size, labels: labels, fft: dim.name === 'LIN' || dim.name === 'PAR' ? 'k' : null });
    });
    if (coilCount > 1) dims.push({ name: 'coil', size: coilCount, labels: coilLabels(coilCount) });
    var notes = collisions ? [collisions + ' acquisitions share their label coordinates with another (navigators, references, averages); the label view shows the last of each.'] : [];
    var cellOf = function (indices) {
      var cellIndex = 0, cellStride = 1;
      for (var k = 0; k < used.length; k++) { cellIndex += indices[1 + k] * cellStride; cellStride *= used[k].size; }
      return cellIndex;
    };
    return {
      id: 'raw-labels', title: 'Raw data by labels', square: false, dims: dims, re: re, im: im, notes: notes,
      defaultX: 0, defaultY: 1, defaultLog: true, defaultColormap: 'grey',
      timeOf: function (indices) { return sampleTime(layout, acquisitionAt[cellOf(indices)], indices[0]); },
      acquisitionOf: function (indices) { return acquisitionAt[cellOf(indices)]; }
    };
  }

  /**
   * Gridded k-space or images, frames × coils × rows × columns from the
   * recon, rows top-down. Images get a root-sum-of-squares entry first when
   * there are several coils.
   */
  function gridDataset(id, recon, stack, coilCount, isImage) {
    if (!stack) return null;
    var nu = recon.nu, nv = recon.nv, frames = recon.frames, cells = nu * nv;
    var withRss = isImage && coilCount > 1;
    var slots = coilCount + (withRss ? 1 : 0);
    var re = new Float32Array(cells * slots * frames), im = new Float32Array(cells * slots * frames);
    for (var f = 0; f < frames; f++) {
      var outBase = f * slots * cells;
      if (withRss) re.set(recon.images.subarray(f * cells, (f + 1) * cells), outBase);
      var inBase = f * coilCount * cells;
      var offset = outBase + (withRss ? cells : 0);
      re.set(stack.re.subarray(inBase, inBase + coilCount * cells), offset);
      im.set(stack.im.subarray(inBase, inBase + coilCount * cells), offset);
    }
    var axes = 'xyz';
    var pixel = recon.delta ? [1000 / (nu * recon.delta[0]), 1000 / (nv * recon.delta[1])] : null;
    var ux = axes.charAt(recon.axes[0]), uy = axes.charAt(recon.axes[1]);
    var dims = isImage
      ? [
        { name: ux, size: nu, fft: 'x', transformedName: 'k' + ux, scale: pixel ? { start: -nu / 2 * pixel[0], step: pixel[0], unit: 'mm' } : undefined },
        { name: uy, size: nv, fft: 'x', reversed: true, transformedName: 'k' + uy, scale: pixel ? { start: (nv / 2 - 1) * pixel[1], step: -pixel[1], unit: 'mm' } : undefined }
      ]
      : [
        { name: 'k' + ux, size: nu, fft: 'k', transformedName: ux },
        { name: 'k' + uy, size: nv, fft: 'k', reversed: true, transformedName: uy }
      ];
    if (slots > 1) {
      var labels = (withRss ? ['RSS'] : []).concat(coilLabels(coilCount));
      dims.push({ name: 'coil', size: slots, labels: labels });
    }
    if (frames > 1) dims.push({ name: 'frame', size: frames });
    return {
      id: id, title: isImage ? 'Reconstructed image' : 'Gridded k-space', square: true,
      pixelAspect: pixel ? pixel[1] / pixel[0] : 1,
      dims: dims, re: re, im: im, defaultX: 0, defaultY: 1,
      defaultLog: !isImage, defaultColormap: 'grey'
    };
  }

  function currentDataset(tab) {
    if (tab === 'rf') return (rfAxis === 'z' ? datasets.rf : datasets.rfSpectral) || datasets.rf || datasets.rfSpectral || null;
    if (tab === 'raw') {
      if (rawOrder === 'time' && datasets.rawTime) return datasets.rawTime;
      if (rawOrder === 'labels' && datasets.rawLabels) return datasets.rawLabels;
      return datasets.rawAcquisition || null;
    }
    return datasets[tab] || null;
  }

  function showData(tab) {
    dataTab = tab;
    set('seqeyes.simulation.data', tab);
    syncControls();
    if (!viewer) return;
    var dataset = currentDataset(tab);
    viewer.setDataset(dataset);
    var empty = el('simEmpty');
    if (empty) {
      empty.style.display = dataset ? 'none' : 'flex';
      empty.textContent = tab === 'phantom'
        ? (phantom.status === 'loading' ? 'Loading phantom…' : phantom.status === 'error' ? 'The phantom could not be loaded.' : 'No phantom loaded.')
        : tab === 'rf'
          ? (pulses.status === 'loading' ? 'Measuring the RF pulses…' : pulses.status === 'error' ? 'The pulses could not be measured: ' + pulses.error : 'Open a sequence to see its RF pulses.')
          : (run && !run.finished ? 'Simulating…' : 'No simulation yet. Press Run.');
    }
  }

  /* ── Timeline link ────────────────────────────────────────────────── */

  var lastMarker = NaN;
  function onViewerHover(info) {
    var h = host();
    if (!h || !h.setWaveformMarker) return;
    var time = info && isFinite(info.time) ? info.time : NaN;
    if (time === lastMarker || (isNaN(time) && isNaN(lastMarker))) return;
    lastMarker = time;
    h.setWaveformMarker(isFinite(time) ? time : null);
  }

  /** Bring the selected readout into the waveform view. */
  function revealSelected() {
    var h = host();
    var dataset = viewer && viewer.dataset();
    if (!h || !h.revealTimeRange || !dataset || !dataset.acquisitionOf || !result) return;
    var snap = viewer.state();
    var indices = snap.indices.slice();
    if (snap.y >= 0) indices[snap.y] = snap.selected.y;
    var a = dataset.acquisitionOf(indices);
    if (!(a >= 0)) return;
    var layout = result.layout;
    var start = layout.t0[a], end = start + layout.samples[a] * layout.dwell[a];
    var pad = Math.max(end - start, 1e-4);
    h.revealTimeRange(Math.max(0, start - pad), end + pad);
    h.setWaveformMarker(start + 0.5 * (end - start));
  }

  /* ── Export ───────────────────────────────────────────────────────── */

  function exportAs(format) {
    if (format === 'png') {
      if (!viewer) return;
      viewer.exportPng(function (blob) {
        if (blob) blob.arrayBuffer().then(function (bytes) { saveBytes(fileStem() + '_' + dataTab + '.png', new Uint8Array(bytes), 'image/png'); });
      });
      return;
    }
    if (!result || !result.leader) { setStatus(['Run a simulation first.']); return; }
    var id = ++exportCounter;
    result.run.exports[id] = format;
    setStatus(statusForResultLines().concat(['Preparing ' + format + ' export…']), resultWarnings());
    result.leader.worker.postMessage({ type: 'export', job: result.run.id, id: id, format: format, signal: result.signal.slice() });
  }

  function finishExport(r, message) {
    if (!r.exports[message.id]) return;
    delete r.exports[message.id];
    saveBytes(fileStem() + message.name, message.bytes, message.mime);
    statusForResult();
  }

  function exportFailed(r, id, text) {
    delete r.exports[id];
    setStatus(statusForResultLines(), resultWarnings().concat(['Export failed: ' + text]));
  }

  function fileStem() {
    var name = (result && result.name) || (host() && host().getSequenceSource() && host().getSequenceSource().name) || 'sequence';
    return name.replace(/\.(seq|bseq)$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_') + '_sim';
  }

  function saveBytes(name, bytes, mime) {
    var h = host();
    if (h && typeof h.saveBytes === 'function') { h.saveBytes(name, bytes, mime); return; }
    var url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  /* ── Controls ─────────────────────────────────────────────────────── */

  function fillSelect(select, entries, value) {
    if (!select) return;
    var signature = entries.map(function (e) { return e[0] + ':' + e[1] + (e[2] ? ':off' : ''); }).join('|');
    if (select.getAttribute('data-signature') !== signature) {
      select.innerHTML = '';
      entries.forEach(function (entry) {
        var option = document.createElement('option');
        option.value = entry[0];
        option.textContent = entry[1];
        if (entry[2]) option.disabled = true;
        select.appendChild(option);
      });
      select.setAttribute('data-signature', signature);
    }
    select.value = String(value);
  }

  function syncControls() {
    var running = !!(run && !run.finished);
    fillSelect(el('simPhantom'), PRESET_ORDER.map(function (id) {
      return [id, id === 'file' && uploaded ? 'File: ' + uploaded.label : PRESETS[id].label];
    }), phantomChoice);
    var isShepp = phantomChoice === 'shepp-logan';
    fillSelect(el('simMatrix'), isShepp
      ? SHEPP_SIZES.map(function (n) { return [String(n), n + '²']; })
      : FILE_MATRICES.map(function (n) { return [String(n), n ? 'resample ' + n : 'native']; }),
      isShepp ? sheppSize : fileMatrix);
    var fieldsSelect = el('simFields');
    fillSelect(fieldsSelect, FIELD_CHOICES, fields);
    if (fieldsSelect) fieldsSelect.hidden = isShepp;
    fillSelect(el('simCoils'), COIL_CHOICES.map(function (n) { return [String(n), n === 1 ? '1 coil' : n + ' coils']; }), coils);
    fillSelect(el('simSpins'), SPIN_CHOICES.map(function (c) { return [c, c === 'auto' ? 'Auto' : c.replace('x', ' × ')]; }), spins);
    var accuracySelect = el('simAccuracy');
    fillSelect(accuracySelect, ACCURACY_CHOICES, accuracy);
    if (accuracySelect) accuracySelect.hidden = spins !== 'auto';
    fillSelect(el('simSlices'), SLICE_CHOICES, sliceMode);

    var volume3d = !isShepp && phantom.volume && Math.max(phantom.volume.shape[0], phantom.volume.shape[1], phantom.volume.shape[2]) > 1
      && Math.min(phantom.volume.shape[0], phantom.volume.shape[1], phantom.volume.shape[2]) > 1;
    var group = el('simSliceGroup');
    if (group) group.hidden = !volume3d;
    if (volume3d) {
      fillSelect(el('simPlane'), [['xy', 'xy plane'], ['xz', 'xz plane'], ['yz', 'yz plane']], slicePlane);
      var slider = el('simSlice');
      var max = sliceAxisSize() - 1;
      if (slider) {
        slider.max = String(max);
        slider.value = String(sliceIndex === null ? Math.floor(max / 2) : sliceIndex);
      }
      var value = el('simSliceValue');
      if (value) value.textContent = (sliceIndex === null ? Math.floor(max / 2) : sliceIndex) + '/' + max;
    }

    var runButton = el('simRun');
    if (runButton) {
      runButton.disabled = running || phantom.status !== 'ready';
      runButton.textContent = result ? '▶ Run again' : '▶ Run';
    }
    var cancel = el('simCancel');
    if (cancel) cancel.disabled = !running;
    fillSelect(el('simExport'), [['', 'Export…']].concat(EXPORTS.map(function (entry) {
      return [entry[0], entry[1], entry[0] !== 'png' && !result];
    })), '');

    var tabs = el('simData');
    if (tabs) {
      Array.prototype.forEach.call(tabs.querySelectorAll('button[data-tab]'), function (button) {
        var tab = button.getAttribute('data-tab');
        button.classList.toggle('on', tab === dataTab);
        button.setAttribute('aria-selected', tab === dataTab ? 'true' : 'false');
        button.disabled = tab !== 'phantom' && tab !== 'rf' && !currentDataset(tab);
      });
    }
    var order = el('simRawOrder');
    if (order) {
      order.hidden = !(dataTab === 'raw' && datasets.rawAcquisition);
      var orders = [['acquisition', 'samples × acquisitions'], ['time', 'all samples in time order']];
      if (datasets.rawLabels) orders.unshift(['labels', 'samples × labels']);
      fillSelect(order, orders, rawOrder === 'labels' && !datasets.rawLabels ? 'acquisition' : rawOrder);
    }
    var axisSelect = el('simRfAxis');
    if (axisSelect) {
      var axes = RF_AXES.filter(function (entry) { return entry[0] === 'z' ? datasets.rf : datasets.rfSpectral; });
      axisSelect.hidden = !(dataTab === 'rf' && axes.length > 1);
      if (axes.length) fillSelect(axisSelect, axes, axes.some(function (entry) { return entry[0] === rfAxis; }) ? rfAxis : axes[0][0]);
    }
    var reveal = el('simReveal');
    if (reveal) reveal.disabled = !(dataTab === 'raw' && result && host() && host().revealTimeRange);
  }

  function wire() {
    if (wired) return;
    wired = true;
    viewer = SeqEyesNdView.create({
      imageCanvas: el('simCanvas'),
      plotCanvas: el('simPlot'),
      controls: {
        x: el('simAxisX'), y: el('simAxisY'), parts: el('simParts'), log: el('simLog'),
        colormap: el('simCmap'), dims: el('simDims'), plotPane: el('simBody')
      },
      onHover: onViewerHover,
      onChange: function () { syncControls(); }
    });

    var phantomSelect = el('simPhantom');
    if (phantomSelect) phantomSelect.onchange = function () {
      if (this.value === 'file' && !uploaded) {
        this.value = phantomChoice;
        var input = el('simPhantomInput');
        if (input) input.click();
        return;
      }
      phantomChoice = this.value;
      if (phantomChoice !== 'file') set('seqeyes.simulation.phantom', phantomChoice);
      sliceIndex = null;
      phantom.volume = null;
      loadPhantom('choice');
    };
    var fileButton = el('simPhantomFile');
    var fileInput = el('simPhantomInput');
    if (fileButton && fileInput) fileButton.onclick = function () { fileInput.value = ''; fileInput.click(); };
    if (fileInput) fileInput.onchange = function () { readUploadedFiles(this.files); };
    var matrix = el('simMatrix');
    if (matrix) matrix.onchange = function () {
      if (phantomChoice === 'shepp-logan') { sheppSize = +this.value; set('seqeyes.simulation.size', String(sheppSize)); loadPhantom('choice'); }
      else { fileMatrix = +this.value; set('seqeyes.simulation.matrix', String(fileMatrix)); loadPhantom('slice'); }
    };
    var fieldsSelect = el('simFields');
    if (fieldsSelect) fieldsSelect.onchange = function () { fields = this.value; set('seqeyes.simulation.fields', fields); loadPhantom('slice'); };
    var plane = el('simPlane');
    if (plane) plane.onchange = function () {
      slicePlane = this.value;
      set('seqeyes.simulation.plane', slicePlane);
      sliceIndex = Math.floor(sliceAxisSize() / 2);     // the middle of the new normal axis
      loadPhantom('slice');
    };
    var slider = el('simSlice');
    var sliceTimer = 0;
    if (slider) slider.oninput = function () {
      sliceIndex = +this.value;
      var value = el('simSliceValue');
      if (value) value.textContent = sliceIndex + '/' + this.max;
      clearTimeout(sliceTimer);
      sliceTimer = setTimeout(function () { loadPhantom('slice'); }, 120);
    };
    var coilSelect = el('simCoils');
    if (coilSelect) coilSelect.onchange = function () { coils = +this.value; set('seqeyes.simulation.coils', String(coils)); };
    var spinSelect = el('simSpins');
    if (spinSelect) spinSelect.onchange = function () { spins = this.value; set('seqeyes.simulation.spins', spins); syncControls(); };
    var accuracySelect = el('simAccuracy');
    if (accuracySelect) accuracySelect.onchange = function () { accuracy = this.value; set('seqeyes.simulation.accuracy', accuracy); };
    var sliceSelect = el('simSlices');
    if (sliceSelect) sliceSelect.onchange = function () {
      sliceMode = this.value;
      set('seqeyes.simulation.slices', sliceMode);
      if (phantom.volume) loadPhantom('slice');      // neighbouring planes come and go with it
    };
    var axisSelect = el('simRfAxis');
    if (axisSelect) axisSelect.onchange = function () { rfAxis = this.value; set('seqeyes.simulation.rfAxis', rfAxis); showData('rf'); };
    var runButton = el('simRun');
    if (runButton) runButton.onclick = startRun;
    var cancel = el('simCancel');
    if (cancel) cancel.onclick = cancelRun;
    var exportSelect = el('simExport');
    if (exportSelect) exportSelect.onchange = function () { var format = this.value; this.value = ''; if (format) exportAs(format); };
    var tabs = el('simData');
    if (tabs) {
      tabs.innerHTML = '';
      DATA_TABS.forEach(function (entry) {
        var button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'tab');
        button.setAttribute('data-tab', entry[0]);
        button.textContent = entry[1];
        button.onclick = function () { showData(entry[0]); };
        tabs.appendChild(button);
      });
    }
    var order = el('simRawOrder');
    if (order) order.onchange = function () { rawOrder = this.value; set('seqeyes.simulation.rawOrder', rawOrder); showData('raw'); };
    var reveal = el('simReveal');
    if (reveal) reveal.onclick = revealSelected;
    var card = el('simRunCard'), minimize = el('simRunMin');
    var setMinimized = function (value) {
      cardMinimized = value;
      set('seqeyes.simulation.cardMinimized', value ? '1' : '0');
      renderRunCard(run);
    };
    if (minimize) minimize.onclick = function (event) { event.stopPropagation(); setMinimized(!cardMinimized); };
    if (card) card.onclick = function () { if (cardMinimized) setMinimized(false); };

    var body = el('simBody');
    if (body && typeof ResizeObserver !== 'undefined') new ResizeObserver(function () { if (shown && viewer) viewer.render(); }).observe(body);
    wireSplit();
    syncControls();
  }

  /** Drag the bar between the image and the plot. */
  function wireSplit() {
    var split = el('simSplit'), imagePane = el('simImagePane'), plotPane = el('simPlotPane'), body = el('simBody');
    if (!split || !imagePane || !plotPane || !body) return;
    var ratio = +get('seqeyes.simulation.split') || 0.68;
    function apply() {
      imagePane.style.flex = ratio + ' 1 0%';
      plotPane.style.flex = (1 - ratio) + ' 1 0%';
    }
    apply();
    var dragging = false;
    split.addEventListener('mousedown', function (event) { dragging = true; event.preventDefault(); });
    window.addEventListener('mousemove', function (event) {
      if (!dragging) return;
      var rect = body.getBoundingClientRect();
      ratio = Math.max(0.15, Math.min(0.9, (event.clientY - rect.top) / Math.max(1, rect.height)));
      apply();
      if (viewer) viewer.render();
    });
    window.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      set('seqeyes.simulation.split', ratio.toFixed(3));
    });
  }

  /* ── Lifecycle hooks (called by panel.js) ─────────────────────────── */

  function install() {
    var button = el('simBtn');
    if (button) button.hidden = !isAvailable();
  }

  function onShown() {
    shown = true;
    install();
    wire();
    if (phantom.status === 'idle' || (phantom.status === 'error' && phantomChoice === 'shepp-logan')) loadPhantom('choice');
    if (pulses.status === 'idle') requestPulses();
    showData(result || dataTab === 'phantom' || dataTab === 'rf' ? dataTab : 'phantom');
    describePhantom();
  }

  function onHidden() {
    shown = false;
    onViewerHover(null);
  }

  function onSequenceLoaded() {
    stopRun(run);
    run = null;
    if (result && result.leader) result.leader.worker.terminate();
    result = null;
    datasets = { phantom: datasets.phantom };
    setProgress(null);
    // The built-in phantom follows the sequence's FOV; a volume's neighbouring planes follow its slabs.
    if (phantomChoice === 'shepp-logan' && phantom.status !== 'idle') loadPhantom('choice');
    else if (phantom.volume && sliceMode === 'auto') loadPhantom('slice');
    pulses = { status: 'idle', id: 0, list: null, error: null };
    datasets.rf = null;
    datasets.rfSpectral = null;
    if (shown) requestPulses();
    if (shown) {
      showData(dataTab === 'phantom' ? 'phantom' : dataTab);
      describePhantom();
    }
    syncControls();
  }

  function state() {
    var snap = viewer ? viewer.state() : null;
    return {
      available: isAvailable(),
      shown: shown,
      running: !!(run && !run.finished),
      runs: runCounter,
      workers: run ? run.workers.length : 0,
      phantom: { choice: phantomChoice, status: phantom.status, error: phantom.error,
        nx: phantom.data ? phantom.data.nx : 0, ny: phantom.data ? phantom.data.ny : 0,
        volume: phantom.volume ? phantom.volume.shape.slice() : null, plane: slicePlane, index: sliceIndex,
        source: phantom.data ? phantom.data.source : '' },
      coils: coils,
      spins: spins,
      slices: sliceMode,
      pulses: { status: pulses.status, count: pulses.list ? pulses.list.length : 0,
        alongZ: datasets.rf ? datasets.rf.dims[2].size : 0, spectral: datasets.rfSpectral ? datasets.rfSpectral.dims[2].size : 0 },
      tab: dataTab,
      view: snap,
      plan: result ? result.plan : (run ? run.plan : null),
      done: !!result,
      nu: result ? result.recon.nu : 0,
      nv: result ? result.recon.nv : 0,
      frames: result ? result.recon.frames : 0,
      acquisitions: result ? result.layout.acquisitions : 0,
      labelView: !!datasets.rawLabels,
      live: run && !run.finished ? { phase: run.phase || 'planning', chunks: run.liveChunks || 0, previews: run.livePreviews || 0,
        cardVisible: !!(el('simRunCard') && !el('simRunCard').hidden), cardMinimized: cardMinimized } : null,
      timings: result ? result.timings : null,
      status: el('simReadout') ? el('simReadout').textContent : ''
    };
  }

  return {
    install: install,
    isAvailable: isAvailable,
    onShown: onShown,
    onHidden: onHidden,
    onSequenceLoaded: onSequenceLoaded,
    onThemeChanged: function () { if (viewer) viewer.render(); },
    resize: function () { if (shown && viewer) viewer.render(); },
    run: startRun,
    cancel: cancelRun,
    exportAs: exportAs,
    showData: showData,
    viewer: function () { return viewer; },
    loadFiles: function (files) { readUploadedFiles(files); },
    setSettings: function (options) {
      if (!options) return;
      if (SHEPP_SIZES.indexOf(options.size) >= 0) sheppSize = options.size;
      if (SPIN_CHOICES.indexOf(options.spins) >= 0) spins = options.spins;
      if (COIL_CHOICES.indexOf(options.coils) >= 0) coils = options.coils;
      syncControls();
    },
    state: state,
    matrixSummary: function () { return viewer ? viewer.summary() : null; }
  };
})();
