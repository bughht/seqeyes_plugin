/* ═══════════════════════════════════════════════════════════════════════
   N-D data viewer — any two dimensions as an image, a waveform along one

   The simulation panel shows phantom maps, raw ADC data, gridded k-space
   and images through this one component. A dataset is a real or complex
   array with named dimensions, the first dimension fastest in memory:

     { id, title, dims: [{ name, size, fft?, labels?, units?, scale? }],
       re: Float32Array, im: Float32Array | null,
       defaultX, defaultY, valueUnit?, timeOf?(indices) }

   `fft` marks a dimension transformable: 'k' (k-space → position, inverse
   centred DFT) or 'x' (position → k-space, forward). `labels` name the
   entries of a categorical dimension (coils, maps); `units` gives each
   entry's value unit. `scale` = { start, step, unit } maps an index to a
   physical coordinate for axis captions. `timeOf` returns the sequence time
   [s] of an element, which the host marks on the waveform timeline.

   The viewer shows the plane of the chosen X and Y dimensions (the others
   fixed by sliders), and below it the line along X through the selected Y:
   the waveform itself, real, imaginary and magnitude. Parts: magnitude,
   phase, real, imaginary; magnitude optionally in dB. Pure UI.
   ═══════════════════════════════════════════════════════════════════════ */

var SeqEyesNdView = (function () {
  var PARTS = { abs: '|·|', phase: '∠', re: 'Re', im: 'Im' };
  var LOG_RANGE_DB = 60;
  /** Rows above which the image shows every k-th row (canvas size limits). */
  var MAX_IMAGE_ROWS = 4096;

  /* ── Complex FFT (radix-2, Bluestein for other lengths) ─────────────── */

  function fftRadix2(re, im, inverse) {
    var n = re.length;
    for (var i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    var sign = inverse ? 1 : -1;
    for (var len = 2; len <= n; len <<= 1) {
      var angle = sign * 2 * Math.PI / len;
      var wr = Math.cos(angle), wi = Math.sin(angle);
      for (var start = 0; start < n; start += len) {
        var cr = 1, ci = 0;
        for (var k = 0; k < len / 2; k++) {
          var a = start + k, b = a + len / 2;
          var xr = re[b] * cr - im[b] * ci;
          var xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          var nr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = nr;
        }
      }
    }
  }

  /** In-place DFT of any length (unnormalised; +i exponent when inverse). */
  function fft(re, im, inverse) {
    var n = re.length;
    if (n <= 1) return;
    if ((n & (n - 1)) === 0) { fftRadix2(re, im, inverse); return; }
    // Bluestein: a length-n DFT as a convolution of length m ≥ 2n − 1.
    var m = 1;
    while (m < 2 * n - 1) m <<= 1;
    var sign = inverse ? 1 : -1;
    var wr = new Float64Array(n), wi = new Float64Array(n);
    for (var k = 0; k < n; k++) {
      var angle = sign * Math.PI * ((k * k) % (2 * n)) / n;
      wr[k] = Math.cos(angle); wi[k] = Math.sin(angle);
    }
    var ar = new Float64Array(m), ai = new Float64Array(m);
    var br = new Float64Array(m), bi = new Float64Array(m);
    for (k = 0; k < n; k++) {
      ar[k] = re[k] * wr[k] - im[k] * wi[k];
      ai[k] = re[k] * wi[k] + im[k] * wr[k];
    }
    br[0] = wr[0]; bi[0] = -wi[0];
    for (k = 1; k < n; k++) {
      br[k] = br[m - k] = wr[k];
      bi[k] = bi[m - k] = -wi[k];
    }
    fftRadix2(ar, ai, false);
    fftRadix2(br, bi, false);
    for (k = 0; k < m; k++) {
      var pr = ar[k] * br[k] - ai[k] * bi[k];
      ai[k] = ar[k] * bi[k] + ai[k] * br[k];
      ar[k] = pr;
    }
    fftRadix2(ar, ai, true);
    for (k = 0; k < n; k++) {
      var cr = ar[k] / m, ci = ai[k] / m;
      re[k] = cr * wr[k] - ci * wi[k];
      im[k] = cr * wi[k] + ci * wr[k];
    }
  }

  /**
   * Centred DFT along one dimension of the whole array: index n stands for
   * n − N/2 on both sides, as k-space and images are stored. A `reversed`
   * dimension is stored top-down (largest coordinate first, as image rows
   * are) and is transformed in its natural order.
   */
  function transformDim(dims, re, im, d, inverse) {
    var size = dims[d].size;
    var reversed = !!dims[d].reversed;
    var stride = 1;
    for (var i = 0; i < d; i++) stride *= dims[i].size;
    var total = re.length;
    var outer = total / (stride * size);
    var lr = new Float64Array(size), li = new Float64Array(size);
    var half = Math.floor(size / 2);
    for (var o = 0; o < outer; o++) {
      for (var s = 0; s < stride; s++) {
        var base = o * stride * size + s;
        // ifftshift on the way in, fftshift on the way out.
        for (var n = 0; n < size; n++) {
          var logical = (n + half) % size;
          var src = base + (reversed ? size - 1 - logical : logical) * stride;
          lr[n] = re[src]; li[n] = im[src];
        }
        fft(lr, li, inverse);
        for (n = 0; n < size; n++) {
          var target = (n + half) % size;
          var dst = base + (reversed ? size - 1 - target : target) * stride;
          re[dst] = lr[n]; im[dst] = li[n];
        }
      }
    }
  }

  /* ── Formatting helpers ─────────────────────────────────────────────── */

  function niceNumber(value) {
    if (!isFinite(value)) return '–';
    var a = Math.abs(value);
    if (a === 0) return '0';
    if (a >= 1e4 || a < 1e-3) return value.toExponential(2);
    // Trim zeros after a decimal point only: 2500 stays 2500.
    var text = value.toPrecision(4);
    if (text.indexOf('.') >= 0) text = text.replace(/0+$/, '').replace(/\.$/, '');
    return text;
  }

  function niceStep(span, count) {
    var raw = span / Math.max(1, count);
    var power = Math.pow(10, Math.floor(Math.log10(raw)));
    var fraction = raw / power;
    var step = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
    return step * power;
  }

  function cssVar(style, name, fallback) {
    var value = style.getPropertyValue(name);
    return value && value.trim() ? value.trim() : fallback;
  }

  /* ── The viewer ─────────────────────────────────────────────────────── */

  function create(options) {
    var imageCanvas = options.imageCanvas;
    var plotCanvas = options.plotCanvas;
    var controls = options.controls || {};
    var onHover = options.onHover || function () {};
    var onChange = options.onChange || function () {};

    var dataset = null;
    var viewStates = {};        // per dataset id: what the user chose last
    var state = null;
    var transformed = null;     // { key, re, im } for the active FFT mask
    var offscreen = null, offscreenKey = '';
    var sliceCache = null;      // { key, values, width, height, min, max, rowStep }
    var hover = null;           // { kind: 'image'|'plot', x, y, label }
    var drag = null;

    function defaultState(ds) {
      var x = ds.defaultX || 0;
      var y = ds.defaultY === undefined ? (ds.dims.length > 1 ? 1 : -1) : ds.defaultY;
      return {
        x: x,
        y: y,
        indices: ds.dims.map(function (dim, d) {
          if (dim.defaultIndex !== undefined) return dim.defaultIndex;
          return d === x || d === y ? 0 : 0;
        }),
        selected: { x: -1, y: -1 },
        fft: {},
        part: ds.defaultPart || 'abs',
        log: !!ds.defaultLog,
        colormap: ds.defaultColormap || options.colormap || 'grey',
        zoom: null
      };
    }

    function setDataset(ds) {
      if (dataset && state) viewStates[dataset.id] = state;
      dataset = ds;
      transformed = null;
      sliceCache = null;
      offscreenKey = '';
      hover = null;
      if (!ds) { state = null; syncControls(); render(); return; }
      var previous = viewStates[ds.id];
      state = previous && sameShape(previous, ds) ? previous : defaultState(ds);
      if (!ds.im) state.part = state.part === 'phase' || state.part === 'im' ? 'abs' : state.part;
      if (state.selected.y < 0 && state.y >= 0) state.selected.y = Math.floor(ds.dims[state.y].size / 2);
      if (state.selected.x < 0) state.selected.x = Math.floor(ds.dims[state.x].size / 2);
      syncControls();
      render();
    }

    function sameShape(saved, ds) {
      return saved.indices.length === ds.dims.length
        && saved.indices.every(function (index, d) { return index < ds.dims[d].size; })
        && saved.x < ds.dims.length && saved.y < ds.dims.length;
    }

    function strides() {
      var out = [], stride = 1;
      for (var d = 0; d < dataset.dims.length; d++) { out.push(stride); stride *= dataset.dims[d].size; }
      return out;
    }

    function fftKey() {
      return dataset.dims.map(function (dim, d) { return state.fft[d] ? 1 : 0; }).join('');
    }

    /** The data after the requested transforms (cached per transform set). */
    function source() {
      var key = fftKey();
      if (key.indexOf('1') < 0) return { re: dataset.re, im: dataset.im };
      if (transformed && transformed.key === key) return transformed;
      var re = Float32Array.from(dataset.re);
      var im = dataset.im ? Float32Array.from(dataset.im) : new Float32Array(re.length);
      for (var d = 0; d < dataset.dims.length; d++) {
        if (state.fft[d]) transformDim(dataset.dims, re, im, d, dataset.dims[d].fft === 'k');
      }
      transformed = { key: key, re: re, im: im };
      return transformed;
    }

    function partValue(re, im, i) {
      var r = re[i], m = im ? im[i] : 0;
      switch (state.part) {
        case 'phase': return Math.atan2(m, r);
        case 're': return r;
        case 'im': return m;
        default: return Math.sqrt(r * r + m * m);
      }
    }

    function dimName(d) {
      var dim = dataset.dims[d];
      if (state.fft[d]) return dim.fft === 'k' ? (dim.transformedName || dim.name + ' → x') : (dim.transformedName || dim.name + ' → k');
      return dim.name;
    }

    function valueUnit() {
      if (state.part === 'phase') return 'rad';
      if (state.log && state.part === 'abs') return 'dB';
      for (var d = 0; d < dataset.dims.length; d++) {
        var units = dataset.dims[d].units;
        if (units && d !== state.x && d !== state.y) return units[state.indices[d]] || '';
      }
      return dataset.valueUnit || '';
    }

    /** The displayed plane, cached until anything that changes it does. */
    function slice() {
      var key = [fftKey(), state.x, state.y, state.indices.join(','), state.part, state.log ? 1 : 0].join('|');
      if (sliceCache && sliceCache.key === key) return sliceCache;
      var src = source();
      var st = strides();
      var base = 0;
      for (var d = 0; d < dataset.dims.length; d++) {
        if (d !== state.x && d !== state.y) base += state.indices[d] * st[d];
      }
      var width = dataset.dims[state.x].size;
      var rows = state.y >= 0 ? dataset.dims[state.y].size : 1;
      var rowStep = rows > MAX_IMAGE_ROWS ? Math.ceil(rows / MAX_IMAGE_ROWS) : 1;
      var height = Math.ceil(rows / rowStep);
      var values = new Float32Array(width * height);
      var min = Infinity, max = -Infinity, peak = 0;
      for (var row = 0; row < height; row++) {
        var y = row * rowStep;
        for (var x = 0; x < width; x++) {
          var i = base + x * st[state.x] + (state.y >= 0 ? y * st[state.y] : 0);
          var v = partValue(src.re, src.im, i);
          values[row * width + x] = v;
          if (v < min) min = v;
          if (v > max) max = v;
          if (state.part === 'abs' && v > peak) peak = v;
        }
      }
      if (state.part === 'abs' && state.log) {
        for (var p = 0; p < values.length; p++) {
          values[p] = peak > 0 && values[p] > 0 ? Math.max(-LOG_RANGE_DB, 20 * Math.log10(values[p] / peak)) : -LOG_RANGE_DB;
        }
        min = -LOG_RANGE_DB; max = 0;
      } else if (state.part === 'phase') {
        min = -Math.PI; max = Math.PI;
      } else if (!(max > min)) {
        max = min + 1;
      }
      if (state.part === 'abs' && !state.log) min = 0;
      sliceCache = { key: key, values: values, width: width, height: height, min: min, max: max, rowStep: rowStep };
      return sliceCache;
    }

    /** The line along X at the selected Y: complex parts for the plot. */
    function line() {
      var src = source();
      var st = strides();
      var base = 0;
      for (var d = 0; d < dataset.dims.length; d++) {
        if (d === state.x) continue;
        var index = d === state.y ? clampIndex(d, state.selected.y) : state.indices[d];
        base += index * st[d];
      }
      var n = dataset.dims[state.x].size;
      var re = new Float32Array(n), im = new Float32Array(n);
      for (var x = 0; x < n; x++) {
        var i = base + x * st[state.x];
        re[x] = src.re[i];
        im[x] = src.im ? src.im[i] : 0;
      }
      return { re: re, im: im };
    }

    function clampIndex(d, index) {
      return Math.max(0, Math.min(dataset.dims[d].size - 1, index | 0));
    }

    /** Full index vector of a displayed element. */
    function indicesAt(x, y) {
      var indices = state.indices.slice();
      indices[state.x] = x;
      if (state.y >= 0) indices[state.y] = y;
      return indices;
    }

    function coordinateText(d, index) {
      var dim = dataset.dims[d];
      if (dim.labels && !state.fft[d]) return dim.labels[index];
      if (dim.scale && !state.fft[d]) return niceNumber(dim.scale.start + index * dim.scale.step) + (dim.scale.unit ? ' ' + dim.scale.unit : '');
      return String(index);
    }

    /* ── Drawing ─────────────────────────────────────────────────────── */

    function sizeCanvas(canvas) {
      if (!canvas) return null;
      var rect = canvas.parentNode.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      var dpr = window.devicePixelRatio || 1;
      var w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
      }
      return { w: rect.width, h: rect.height, dpr: dpr };
    }

    /** Image area inside the canvas (room for the colorbar and captions). */
    function imageFrame(size) {
      return { x: 6, y: 6, w: Math.max(10, size.w - 70), h: Math.max(10, size.h - 26) };
    }

    function placement(frame, sl) {
      var square = dataset.square && state.y >= 0;
      var fit;
      if (square) {
        // Square elements, or the physical aspect of a pixel when given.
        var aspect = dataset.pixelAspect > 0 ? dataset.pixelAspect : 1;
        var rows = sl.height * sl.rowStep;
        var scale = Math.min(frame.w / sl.width, frame.h / (rows * aspect));
        var dw = sl.width * scale, dh = rows * aspect * scale;
        fit = { x: frame.x + (frame.w - dw) / 2, y: frame.y + (frame.h - dh) / 2, w: dw, h: dh };
      } else {
        fit = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
      }
      var z = state.zoom;
      if (!z) return fit;
      return { x: fit.x * z.scale + z.ox, y: fit.y * z.scale + z.oy, w: fit.w * z.scale, h: fit.h * z.scale };
    }

    function imageBitmap(sl) {
      var key = sl.key + '|' + state.colormap + '|' + document.body.className;
      if (offscreen && offscreenKey === key) return offscreen;
      var lut = sgColormapLut(state.colormap, getComputedStyle(document.body));
      var canvas = offscreen || document.createElement('canvas');
      canvas.width = sl.width; canvas.height = sl.height;
      var context = canvas.getContext('2d');
      var image = context.createImageData(sl.width, sl.height);
      var data = image.data, span = sl.max - sl.min;
      for (var p = 0; p < sl.values.length; p++) {
        var t = span > 0 ? (sl.values[p] - sl.min) / span : 0;
        var index = Math.max(0, Math.min(255, Math.round(t * 255))) * 3;
        data[4 * p] = lut[index]; data[4 * p + 1] = lut[index + 1]; data[4 * p + 2] = lut[index + 2]; data[4 * p + 3] = 255;
      }
      context.putImageData(image, 0, 0);
      offscreen = canvas; offscreenKey = key;
      return canvas;
    }

    function renderImage() {
      var size = sizeCanvas(imageCanvas);
      if (!size) return;
      var context = imageCanvas.getContext('2d');
      context.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
      var style = getComputedStyle(document.body);
      context.fillStyle = cssVar(style, '--bg', '#fff');
      context.fillRect(0, 0, size.w, size.h);
      if (!dataset || state.y < 0) return;
      var sl = slice();
      var frame = imageFrame(size);
      var place = placement(frame, sl);
      context.save();
      context.beginPath(); context.rect(frame.x, frame.y, frame.w, frame.h); context.clip();
      context.imageSmoothingEnabled = false;
      context.drawImage(imageBitmap(sl), place.x, place.y, place.w, place.h);
      // Crosshair at the selected line.
      var fg = cssVar(style, '--adc', '#42d4f4');
      context.strokeStyle = fg; context.globalAlpha = 0.8; context.lineWidth = 1; context.setLineDash([3, 3]);
      var sy = place.y + (clampIndex(state.y, state.selected.y) + 0.5) / dataset.dims[state.y].size * place.h;
      context.beginPath(); context.moveTo(place.x, sy); context.lineTo(place.x + place.w, sy); context.stroke();
      context.restore();

      // Colorbar with its range and unit.
      var lut = sgColormapLut(state.colormap, style);
      var barX = size.w - 56, barY = frame.y, barH = frame.h;
      for (var j = 0; j < barH; j++) {
        context.fillStyle = sgLutCss(lut, 1 - j / Math.max(1, barH - 1));
        context.fillRect(barX, barY + j, 10, 1);
      }
      context.fillStyle = cssVar(style, '--lb', '#888');
      context.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      context.fillText(niceNumber(sl.max), barX + 13, barY + 9);
      context.fillText(niceNumber(sl.min), barX + 13, barY + barH);
      var unit = valueUnit();
      if (unit) context.fillText(unit, barX + 13, barY + barH / 2 + 3);

      // Axis captions: X across, Y down, with their first and last coordinates.
      var xDim = state.x, yDim = state.y;
      var caption = dimName(xDim) + ' → (' + coordinateText(xDim, 0) + ' … ' + coordinateText(xDim, dataset.dims[xDim].size - 1) + ')   '
        + dimName(yDim) + ' ↓ (' + coordinateText(yDim, 0) + ' … ' + coordinateText(yDim, dataset.dims[yDim].size - 1) + ')';
      if (sl.rowStep > 1) caption += '  every ' + sl.rowStep + 'th row';
      context.fillText(caption, 6, size.h - 6);
      if (hover && hover.kind === 'image') drawTooltip(context, style, size, hover.label);
    }

    function renderPlot() {
      var size = sizeCanvas(plotCanvas);
      if (!size) return;
      var context = plotCanvas.getContext('2d');
      context.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
      var style = getComputedStyle(document.body);
      context.fillStyle = cssVar(style, '--bg', '#fff');
      context.fillRect(0, 0, size.w, size.h);
      if (!dataset) return;
      var data = line();
      var n = data.re.length;
      var traces = [];
      var colors = { re: cssVar(style, '--gx', '#3cb44b'), im: cssVar(style, '--gy', '#4363d8'), abs: cssVar(style, '--fg', '#222'), phase: cssVar(style, '--rf', '#e6194b') };
      if (state.part === 'phase') {
        traces.push({ key: 'phase', label: '∠', values: data.re.map(function (r, i) { return Math.atan2(data.im[i], r); }) });
      } else {
        traces.push({ key: 'abs', label: '|·|', values: data.re.map(function (r, i) { return Math.hypot(r, data.im[i]); }) });
        if (dataset.im || state.fft[state.x]) {
          traces.push({ key: 're', label: 'Re', values: data.re });
          traces.push({ key: 'im', label: 'Im', values: data.im });
        }
      }
      var lo = Infinity, hi = -Infinity;
      traces.forEach(function (trace) {
        for (var i = 0; i < n; i++) { var v = trace.values[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      });
      if (!(hi > lo)) { hi = lo + 1; lo -= 1; }
      var pad = 0.06 * (hi - lo); lo -= pad; hi += pad;
      var left = 52, right = 8, top = 16, bottom = 22;
      var w = size.w - left - right, h = size.h - top - bottom;
      if (w <= 10 || h <= 10) return;
      var xOf = function (i) { return left + (n > 1 ? i / (n - 1) : 0.5) * w; };
      var yOf = function (v) { return top + (hi - v) / (hi - lo) * h; };
      // Grid and ticks.
      context.strokeStyle = cssVar(style, '--gr', '#ddd'); context.lineWidth = 1;
      context.fillStyle = cssVar(style, '--lb', '#888');
      context.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      var step = niceStep(hi - lo, Math.max(2, Math.floor(h / 28)));
      for (var t = Math.ceil(lo / step) * step; t <= hi; t += step) {
        var ty = yOf(t);
        context.beginPath(); context.moveTo(left, ty); context.lineTo(left + w, ty); context.stroke();
        context.fillText(niceNumber(t), 4, ty + 3);
      }
      var xStep = Math.max(1, niceStep(Math.max(1, n - 1), Math.max(2, Math.floor(w / 70))));
      for (var xi = 0; xi < n; xi += xStep) {
        var tx = xOf(xi);
        context.beginPath(); context.moveTo(tx, top); context.lineTo(tx, top + h); context.stroke();
        context.fillText(coordinateText(state.x, Math.round(xi)), tx + 2, size.h - 8);
      }
      // Traces; past two points per pixel, each pixel column draws its min–max.
      var perPixel = n / Math.max(1, w);
      traces.forEach(function (trace) {
        context.strokeStyle = colors[trace.key]; context.lineWidth = trace.key === 'abs' ? 1.4 : 1;
        context.beginPath();
        if (perPixel <= 2) {
          for (var i = 0; i < n; i++) {
            var px = xOf(i), py = yOf(trace.values[i]);
            if (i === 0) context.moveTo(px, py); else context.lineTo(px, py);
          }
        } else {
          for (var column = 0; column < w; column++) {
            var from = Math.floor(column * perPixel), to = Math.min(n, Math.floor((column + 1) * perPixel));
            var low = Infinity, high = -Infinity;
            for (var k = from; k < to; k++) { var v = trace.values[k]; if (v < low) low = v; if (v > high) high = v; }
            if (low > high) continue;
            context.moveTo(left + column + 0.5, yOf(high));
            context.lineTo(left + column + 0.5, yOf(low) + 0.5);
          }
        }
        context.stroke();
      });
      // Legend and what the line is.
      var legendX = left + 4;
      traces.forEach(function (trace) {
        context.fillStyle = colors[trace.key];
        context.fillRect(legendX, 4, 10, 3);
        context.fillStyle = cssVar(style, '--fg', '#222');
        context.fillText(trace.label, legendX + 13, 10);
        legendX += 13 + context.measureText(trace.label).width + 10;
      });
      context.fillStyle = cssVar(style, '--lb', '#888');
      var where = state.y >= 0 ? dimName(state.y) + ' = ' + coordinateText(state.y, clampIndex(state.y, state.selected.y)) : '';
      context.fillText('along ' + dimName(state.x) + (where ? ', ' + where : ''), legendX + 6, 10);
      if (hover && hover.kind === 'plot') {
        var hx = xOf(hover.x);
        context.strokeStyle = cssVar(style, '--cr', '#e00'); context.setLineDash([2, 3]);
        context.beginPath(); context.moveTo(hx, top); context.lineTo(hx, top + h); context.stroke();
        context.setLineDash([]);
        drawTooltip(context, style, size, hover.label);
      }
    }

    function drawTooltip(context, style, size, text) {
      context.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      var tw = context.measureText(text).width + 8;
      context.fillStyle = cssVar(style, '--trbg', '#f8f8f8');
      context.fillRect(size.w - tw - 4, size.h - 40, tw, 16);
      context.fillStyle = cssVar(style, '--fg', '#222');
      context.fillText(text, size.w - tw, size.h - 29);
    }

    function render() {
      syncControls();
      renderImage();
      renderPlot();
    }

    /* ── Controls ─────────────────────────────────────────────────────── */

    function fillSelect(select, entries, value) {
      if (!select) return;
      var signature = entries.map(function (e) { return e[0] + ':' + e[1]; }).join('|');
      if (select.getAttribute('data-signature') !== signature) {
        select.innerHTML = '';
        entries.forEach(function (entry) {
          var option = document.createElement('option');
          option.value = entry[0]; option.textContent = entry[1];
          select.appendChild(option);
        });
        select.setAttribute('data-signature', signature);
      }
      select.value = value;
    }

    function syncControls() {
      var has = !!dataset;
      var dims = has ? dataset.dims : [];
      var dimEntries = dims.map(function (dim, d) { return [String(d), dim.name + ' (' + dim.size + ')']; });
      fillSelect(controls.x, dimEntries, has ? String(state.x) : '');
      fillSelect(controls.y, [['-1', 'none (line only)']].concat(dimEntries), has ? String(state.y) : '');
      if (controls.x) controls.x.disabled = !has;
      if (controls.y) controls.y.disabled = !has;
      if (controls.parts) {
        Array.prototype.forEach.call(controls.parts.querySelectorAll('button[data-part]'), function (button) {
          var part = button.getAttribute('data-part');
          var enabled = has && (part === 'abs' || part === 're' || !!dataset.im || anyFft());
          button.disabled = !enabled;
          button.classList.toggle('on', has && state.part === part);
          button.setAttribute('aria-pressed', has && state.part === part ? 'true' : 'false');
        });
      }
      if (controls.log) {
        controls.log.disabled = !has || state.part !== 'abs';
        controls.log.classList.toggle('on', has && state.log && state.part === 'abs');
        controls.log.setAttribute('aria-pressed', has && state.log ? 'true' : 'false');
      }
      if (controls.colormap) {
        fillSelect(controls.colormap, SG_COLORMAP_NAMES.map(function (name) { return [name, SG_COLORMAP_LABELS[name] || name]; }),
          has ? state.colormap : 'grey');
      }
      if (controls.dims) buildDims();
      if (controls.plotPane) controls.plotPane.classList.toggle('full', has && state.y < 0);
    }

    function anyFft() {
      for (var key in state.fft) if (state.fft[key]) return true;
      return false;
    }

    /** One chip per dimension: its role, a slider when fixed, an FFT toggle. */
    function buildDims() {
      var container = controls.dims;
      var signature = dataset ? dataset.id + ':' + dataset.dims.map(function (d) { return d.name + d.size; }).join(',') + ':' + state.x + ',' + state.y : '';
      if (container.getAttribute('data-signature') !== signature) {
        container.innerHTML = '';
        container.setAttribute('data-signature', signature);
        if (!dataset) return;
        dataset.dims.forEach(function (dim, d) {
          var chip = document.createElement('span');
          chip.className = 'nd-dim';
          chip.setAttribute('data-dim', String(d));
          var name = document.createElement('span');
          name.className = 'nd-name';
          chip.appendChild(name);
          if (d !== state.x && d !== state.y && dim.size > 1) {
            var slider = document.createElement('input');
            slider.type = 'range'; slider.min = '0'; slider.max = String(dim.size - 1); slider.step = '1';
            slider.setAttribute('aria-label', dim.name + ' index');
            slider.oninput = function () { setIndex(d, +this.value); };
            chip.appendChild(slider);
            var value = document.createElement('span');
            value.className = 'nd-value';
            chip.appendChild(value);
          }
          if (dim.fft) {
            var toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'nd-fft';
            toggle.textContent = 'FFT';
            toggle.title = dim.fft === 'k' ? 'Centred inverse DFT along ' + dim.name + ' (k-space → position)' : 'Centred DFT along ' + dim.name + ' (position → k-space)';
            toggle.onclick = function () { setFft(d, !state.fft[d]); };
            chip.appendChild(toggle);
          }
          container.appendChild(chip);
        });
      }
      if (!dataset) return;
      Array.prototype.forEach.call(container.querySelectorAll('.nd-dim'), function (chip) {
        var d = +chip.getAttribute('data-dim');
        var role = d === state.x ? 'X' : d === state.y ? 'Y' : '';
        chip.classList.toggle('axis', !!role);
        chip.querySelector('.nd-name').textContent = (role ? role + ': ' : '') + dimName(d) + (role ? ' ' + dataset.dims[d].size : '');
        var slider = chip.querySelector('input');
        if (slider) slider.value = String(state.indices[d]);
        var value = chip.querySelector('.nd-value');
        if (value) value.textContent = coordinateText(d, state.indices[d]) + '/' + (dataset.dims[d].size - 1);
        var toggle = chip.querySelector('.nd-fft');
        if (toggle) {
          toggle.classList.toggle('on', !!state.fft[d]);
          toggle.setAttribute('aria-pressed', state.fft[d] ? 'true' : 'false');
        }
      });
    }

    function setIndex(d, index) {
      state.indices[d] = clampIndex(d, index);
      changed();
    }

    function setFft(d, on) {
      if (!dataset.dims[d].fft) return;
      state.fft[d] = !!on;
      transformed = null;
      changed();
    }

    function setAxes(x, y) {
      if (!dataset) return;
      x = +x; y = +y;
      if (!(x >= 0 && x < dataset.dims.length)) return;
      if (y === x || y >= dataset.dims.length) y = -1;
      state.x = x; state.y = y;
      state.selected = { x: Math.floor(dataset.dims[x].size / 2), y: y >= 0 ? Math.floor(dataset.dims[y].size / 2) : -1 };
      state.zoom = null;
      if (controls.dims) controls.dims.setAttribute('data-signature', '');
      changed();
    }

    function changed() {
      sliceCache = null;
      hover = null;
      render();
      onChange(snapshot());
    }

    // Picking the other axis's dimension swaps the two.
    if (controls.x) controls.x.onchange = function () {
      var x = +this.value;
      setAxes(x, x === state.y ? state.x : state.y);
    };
    if (controls.y) controls.y.onchange = function () {
      var y = +this.value;
      if (y === state.x) setAxes(state.y >= 0 ? state.y : otherDim(y), y);
      else setAxes(state.x, y);
    };

    function otherDim(d) {
      for (var i = 0; i < dataset.dims.length; i++) if (i !== d && dataset.dims[i].size > 1) return i;
      return d === 0 ? 1 : 0;
    }
    if (controls.parts) {
      Array.prototype.forEach.call(controls.parts.querySelectorAll('button[data-part]'), function (button) {
        button.onclick = function () {
          if (!dataset) return;
          state.part = button.getAttribute('data-part');
          changed();
        };
      });
    }
    if (controls.log) controls.log.onclick = function () { if (dataset) { state.log = !state.log; changed(); } };
    if (controls.colormap) controls.colormap.onchange = function () { if (dataset) { state.colormap = this.value; render(); onChange(snapshot()); } };

    /* ── Pointer interaction ─────────────────────────────────────────── */

    function localPoint(canvas, event) {
      var rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top, w: rect.width, h: rect.height };
    }

    function imageElementAt(event) {
      if (!dataset || state.y < 0) return null;
      var p = localPoint(imageCanvas, event);
      var sl = slice();
      var place = placement(imageFrame({ w: p.w, h: p.h }), sl);
      var x = Math.floor((p.x - place.x) / place.w * dataset.dims[state.x].size);
      var y = Math.floor((p.y - place.y) / place.h * dataset.dims[state.y].size);
      if (x < 0 || y < 0 || x >= dataset.dims[state.x].size || y >= dataset.dims[state.y].size) return null;
      return { x: x, y: y };
    }

    function describe(x, y) {
      var src = source();
      var st = strides();
      var indices = indicesAt(x, y);
      var i = 0;
      for (var d = 0; d < indices.length; d++) i += indices[d] * st[d];
      var r = src.re[i], m = src.im ? src.im[i] : 0;
      var where = dimName(state.x) + ' ' + coordinateText(state.x, x) + (state.y >= 0 ? ', ' + dimName(state.y) + ' ' + coordinateText(state.y, y) : '');
      var value = src.im || anyFft() ? niceNumber(r) + (m < 0 ? ' − ' : ' + ') + niceNumber(Math.abs(m)) + 'i  |' + niceNumber(Math.hypot(r, m)) + '|' : niceNumber(r);
      var unit = valueUnit();
      return where + ': ' + value + (unit && state.part !== 'phase' && !(state.log && state.part === 'abs') ? ' ' + unit : '');
    }

    function timeAt(x, y) {
      if (!dataset.timeOf || anyFft()) return NaN;
      return dataset.timeOf(indicesAt(x, y));
    }

    imageCanvas.addEventListener('wheel', function (event) {
      if (!dataset || state.y < 0) return;
      event.preventDefault();
      var p = localPoint(imageCanvas, event);
      var z = state.zoom || { scale: 1, ox: 0, oy: 0 };
      var scale = Math.max(1, Math.min(64, z.scale * Math.exp(-event.deltaY * 0.0015)));
      var applied = scale / z.scale;
      state.zoom = scale === 1 ? null : { scale: scale, ox: p.x - (p.x - z.ox) * applied, oy: p.y - (p.y - z.oy) * applied };
      renderImage();
    }, { passive: false });
    imageCanvas.addEventListener('mousedown', function (event) {
      if (event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, moved: false };
    });
    window.addEventListener('mousemove', function (event) {
      if (!drag || !state || !state.zoom) return;
      var dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      state.zoom.ox += dx; state.zoom.oy += dy;
      drag.x = event.clientX; drag.y = event.clientY;
      renderImage();
    });
    window.addEventListener('mouseup', function (event) {
      if (!drag) return;
      var wasDrag = drag.moved;
      drag = null;
      if (wasDrag || !dataset) return;
      var at = imageElementAt(event);
      if (!at) return;
      // A click picks the line the plot shows.
      state.selected = { x: at.x, y: at.y };
      render();
      onChange(snapshot());
    });
    imageCanvas.addEventListener('dblclick', function () { if (state) { state.zoom = null; renderImage(); } });
    imageCanvas.addEventListener('mousemove', function (event) {
      var at = imageElementAt(event);
      hover = at ? { kind: 'image', x: at.x, y: at.y, label: describe(at.x, at.y) } : null;
      renderImage();
      onHover(at ? { time: timeAt(at.x, at.y), indices: indicesAt(at.x, at.y) } : null);
    });
    imageCanvas.addEventListener('mouseleave', function () { hover = null; renderImage(); onHover(null); });
    plotCanvas.addEventListener('mousemove', function (event) {
      if (!dataset) return;
      var p = localPoint(plotCanvas, event);
      var n = dataset.dims[state.x].size;
      var x = Math.round((p.x - 52) / Math.max(1, p.w - 60) * (n - 1));
      if (x < 0 || x >= n) { hover = null; renderPlot(); onHover(null); return; }
      var y = state.y >= 0 ? clampIndex(state.y, state.selected.y) : 0;
      hover = { kind: 'plot', x: x, y: y, label: describe(x, y) };
      renderPlot();
      onHover({ time: timeAt(x, y), indices: indicesAt(x, y) });
    });
    plotCanvas.addEventListener('mouseleave', function () { hover = null; renderPlot(); onHover(null); });

    function snapshot() {
      if (!dataset) return null;
      return {
        dataset: dataset.id,
        x: state.x, y: state.y,
        xName: dataset.dims[state.x].name,
        yName: state.y >= 0 ? dataset.dims[state.y].name : null,
        indices: state.indices.slice(),
        selected: { x: state.selected.x, y: state.selected.y },
        part: state.part, log: state.log, colormap: state.colormap,
        fft: dataset.dims.map(function (dim, d) { return !!state.fft[d]; }),
        dims: dataset.dims.map(function (dim) { return { name: dim.name, size: dim.size }; })
      };
    }

    /** Statistics of the displayed plane, for tests and the readout. */
    function summary() {
      if (!dataset) return null;
      var sl = slice();
      var sum = 0, max = -Infinity;
      for (var i = 0; i < sl.values.length; i++) { sum += sl.values[i]; if (sl.values[i] > max) max = sl.values[i]; }
      var data = line();
      var lineMax = 0;
      for (i = 0; i < data.re.length; i++) lineMax = Math.max(lineMax, Math.hypot(data.re[i], data.im[i]));
      return { width: sl.width, height: sl.height, mean: sum / sl.values.length, max: max, lineLength: data.re.length, lineMax: lineMax };
    }

    return {
      setDataset: setDataset,
      dataset: function () { return dataset; },
      render: render,
      setAxes: setAxes,
      setIndex: function (name, index) {
        if (!dataset) return;
        for (var d = 0; d < dataset.dims.length; d++) if (dataset.dims[d].name === name) setIndex(d, index);
      },
      setFft: function (name, on) {
        if (!dataset) return;
        for (var d = 0; d < dataset.dims.length; d++) if (dataset.dims[d].name === name) setFft(d, on);
      },
      setPart: function (part) { if (dataset && PARTS[part]) { state.part = part; changed(); } },
      selectLine: function (y) { if (dataset && state.y >= 0) { state.selected.y = clampIndex(state.y, y); render(); } },
      state: snapshot,
      summary: summary,
      exportPng: function (callback) {
        if (!imageCanvas.toBlob) { callback(null); return; }
        (state && state.y < 0 ? plotCanvas : imageCanvas).toBlob(function (blob) { callback(blob); }, 'image/png');
      }
    };
  }

  return { create: create, fft: fft, transformDim: transformDim, PARTS: PARTS };
})();
