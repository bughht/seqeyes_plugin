/* ═══════════════════════════════════════════════════════════════════════
   Gradient spectrogram & spectrum rendering

   Pure module. Every entry point takes an explicit context object and reads
   no host globals (BL, ox, sc, TD, layoutMode …), which is what lets the VS
   Code webview, the standalone web app and the MATLAB toolbox share one
   implementation instead of three that drift apart.

   Two canvases, deliberately:
     #sgImg  — the colourmapped matrix, built as ImageData and blitted with a
               single putImageData (the technique buildMinimapCache uses;
               roughly 20x faster than per-cell fillRect). Rebuilt only when
               the data, the colormap or the window/level change.
     #sgOvl  — axes, ticks, forbidden bands, marker, playhead, crosshair.
               Redrawn every frame during playback, which stays cheap because
               it never touches the image layer.
   ═══════════════════════════════════════════════════════════════════════ */

/** A fixed warning hue, not a theme colour: acoustic bands must never blend
 *  into whichever colormap is active. Matches #viewerNotice's border. */
var SG_BAND_COLOR = '#b8860b';
var SG_BAND_FILL = 'rgba(184,134,11,0.16)';
var SG_BAND_HOT = '#e0521b';

var SG_MARGIN = { l: 46, r: 42, t: 7, b: 20 };
var SG_SPECTRUM_MARGIN = { l: 46, r: 10, t: 7, b: 20 };

/* ── Scalar helpers ──────────────────────────────────────────────────── */

function sgClamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/** dB relative to 1 unit (1 mT/m, or 1 T/m/s for dG/dt). */
function sgToDb(value, floorValue) {
  var v = value > floorValue ? value : floorValue;
  return 20 * Math.log10(v);
}

/** Magnitude floor that keeps an all-zero window off -Infinity. */
function sgValueFloor(spec) {
  var m = spec && spec.maxValue > 0 ? spec.maxValue : 0;
  return m > 0 ? m * 1e-6 : 1e-12;
}

function sgFmtDb(v) {
  if (!isFinite(v)) return '--';
  return (v >= 0 ? '+' : '') + v.toFixed(1);
}

function sgFmtHz(v) {
  if (!isFinite(v)) return '--';
  if (Math.abs(v) >= 10000) return (v / 1000).toFixed(1) + 'k';
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(2) + 'k';
  if (Math.abs(v) >= 10) return v.toFixed(0);
  return v.toFixed(1);
}

/** Duration in the caller's display unit — the panel and the waveform agree. */
function sgFmtTime(seconds, unit) {
  if (!isFinite(seconds)) return '--';
  if (unit === 'us') return (seconds * 1e6).toFixed(1) + ' µs';
  if (unit === 's') return seconds.toFixed(4) + ' s';
  return (seconds * 1e3).toFixed(3) + ' ms';
}

function sgFmtResolution(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '--';
  if (seconds >= 1) return seconds.toFixed(2) + ' s';
  if (seconds >= 1e-3) return (seconds * 1e3).toFixed(2) + ' ms';
  return (seconds * 1e6).toFixed(1) + ' µs';
}

/** "Nice" tick values covering [lo, hi] with roughly `target` divisions. */
function sgNiceTicks(lo, hi, target) {
  var out = [];
  if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return out;
  var raw = (hi - lo) / Math.max(1, target);
  var magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  var normalized = raw / magnitude;
  var step = magnitude * (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10);
  var first = Math.ceil(lo / step) * step;
  for (var v = first; v <= hi + step * 1e-6 && out.length < 64; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return out;
}

/* ── Window / level ──────────────────────────────────────────────────── */

/**
 * Auto window/level from the value distribution.
 *
 * Percentiles come from a strided sample rather than a full sort: a 512x1024
 * matrix is half a million cells and sorting it on every first paint would be
 * the slowest step in the pipeline.
 */
function sgAutoWindowLevel(spec, key, previous) {
  var fallback = previous && isFinite(previous.level) && isFinite(previous.width)
    ? { level: previous.level, width: previous.width }
    : { level: -40, width: 60 };
  if (!spec || !spec.nTime || !spec.nFreq) return fallback;
  var data = spec.data[key] || spec.data.rss;
  var n = data.length;
  if (!n) return fallback;

  var floorValue = sgValueFloor(spec);
  var stride = Math.max(1, Math.floor(n / 4096));
  var samples = [];
  for (var i = 0; i < n; i += stride) samples.push(sgToDb(data[i], floorValue));
  if (!samples.length) return fallback;
  samples.sort(function (a, b) { return a - b; });

  function percentile(p) {
    var index = sgClamp(Math.round((samples.length - 1) * p), 0, samples.length - 1);
    return samples[index];
  }
  var lower = percentile(0.02);
  var upper = percentile(0.995);
  if (!(upper > lower + 1e-6)) return fallback;
  return { level: (lower + upper) / 2, width: Math.max(6, upper - lower) };
}

/** Normalised display position of a magnitude under the current window/level. */
function sgNormalize(value, floorValue, wl) {
  var low = wl.level - wl.width / 2;
  return sgClamp((sgToDb(value, floorValue) - low) / wl.width, 0, 1);
}

/* ── Geometry ────────────────────────────────────────────────────────── */

/**
 * Plot rectangle of the spectrogram pane, in CSS pixels.
 *
 * `leftMargin` lets the vertical layout adopt the waveform panel's own left
 * margin so the two time axes line up pixel-for-pixel (§6.3).
 */
function sgPlotRect(width, height, leftMargin) {
  var l = isFinite(leftMargin) && leftMargin > 0 ? leftMargin : SG_MARGIN.l;
  var w = Math.max(1, width - l - SG_MARGIN.r);
  var h = Math.max(1, height - SG_MARGIN.t - SG_MARGIN.b);
  return { x: l, y: SG_MARGIN.t, w: w, h: h };
}

function sgSpectrumRect(width, height, leftMargin) {
  var l = isFinite(leftMargin) && leftMargin > 0 ? leftMargin : SG_SPECTRUM_MARGIN.l;
  var w = Math.max(1, width - l - SG_SPECTRUM_MARGIN.r);
  var h = Math.max(1, height - SG_SPECTRUM_MARGIN.t - SG_SPECTRUM_MARGIN.b);
  return { x: l, y: SG_SPECTRUM_MARGIN.t, w: w, h: h };
}

function sgTimeToX(rect, view, timeSec) {
  var span = view.endSec - view.startSec;
  if (!(span > 0)) return rect.x;
  return rect.x + (timeSec - view.startSec) / span * rect.w;
}

function sgXToTime(rect, view, x) {
  var span = view.endSec - view.startSec;
  if (!(rect.w > 0)) return view.startSec;
  return view.startSec + (x - rect.x) / rect.w * span;
}

/** Frequency grows upward, so row 0 sits at the bottom of the pane. */
function sgFreqToY(rect, range, freqHz) {
  var span = range.fMax - range.fMin;
  if (!(span > 0)) return rect.y + rect.h;
  return rect.y + rect.h - (freqHz - range.fMin) / span * rect.h;
}

function sgYToFreq(rect, range, y) {
  var span = range.fMax - range.fMin;
  if (!(rect.h > 0)) return range.fMin;
  return range.fMin + (rect.y + rect.h - y) / rect.h * span;
}

/* ── Image layer ─────────────────────────────────────────────────────── */

/**
 * Colourmap the matrix into an ImageData sized to the plot rectangle.
 *
 * Nearest-neighbour in both axes: the matrix is already at or below display
 * resolution (targetColumns is derived from the pane width), so interpolating
 * would invent structure that was never computed.
 */
function sgBuildImageData(context) {
  var spec = context.spectrogram;
  var outW = Math.max(1, Math.round(context.pixelWidth));
  var outH = Math.max(1, Math.round(context.pixelHeight));
  var image = context.reuse && context.reuse.width === outW && context.reuse.height === outH
    ? context.reuse
    : new ImageData(outW, outH);
  var pixels = image.data;

  if (!spec || !spec.nTime || !spec.nFreq) {
    for (var clear = 0; clear < pixels.length; clear += 4) pixels[clear + 3] = 0;
    return image;
  }

  var data = spec.data[context.channel] || spec.data.rss;
  var lut = context.lut;
  var wl = context.windowLevel;
  var floorValue = sgValueFloor(spec);
  var low = wl.level - wl.width / 2;
  var invWidth = wl.width > 0 ? 1 / wl.width : 1;
  var logScale = 20 / Math.LN10;

  // Column index per output pixel column, computed once.
  var columnOf = new Int32Array(outW);
  var view = context.view;
  var viewSpan = view.endSec - view.startSec;
  for (var px = 0; px < outW; px++) {
    var t = view.startSec + (px + 0.5) / outW * viewSpan;
    var column = spec.tStepSec > 0 ? Math.round((t - spec.tStartSec) / spec.tStepSec) : 0;
    columnOf[px] = sgClamp(column, 0, spec.nTime - 1);
  }

  var range = context.frequencyRange;
  var freqSpan = range.fMax - range.fMin;
  for (var py = 0; py < outH; py++) {
    var f = range.fMin + (outH - py - 0.5) / outH * freqSpan;
    var row = spec.fStepHz > 0 ? Math.round((f - spec.fStartHz) / spec.fStepHz) : 0;
    var inRange = row >= 0 && row < spec.nFreq;
    var base = row * spec.nTime;
    var rowOffset = py * outW * 4;
    for (var x = 0; x < outW; x++) {
      var offset = rowOffset + x * 4;
      if (!inRange) { pixels[offset + 3] = 0; continue; }
      var value = data[base + columnOf[x]];
      var db = logScale * Math.log(value > floorValue ? value : floorValue);
      var normalized = (db - low) * invWidth;
      var index = normalized <= 0 ? 0 : (normalized >= 1 ? 255 : (normalized * 255) | 0);
      index *= 3;
      pixels[offset] = lut[index];
      pixels[offset + 1] = lut[index + 1];
      pixels[offset + 2] = lut[index + 2];
      pixels[offset + 3] = 255;
    }
  }
  return image;
}

/* ── Overlay layer ───────────────────────────────────────────────────── */

/**
 * Axes, colorbar, forbidden bands, marker and playhead.
 *
 * `context` carries everything: {ctx, width, height, dpr, css, spectrogram,
 * view, frequencyRange, windowLevel, lut, leftMargin, bands, showBands,
 * markerTimeSec, playheadTimeSec, hover, timeUnit, hotBands}.
 */
function sgDrawOverlay(context) {
  var ctx = context.ctx;
  var css = context.css;
  var width = context.width;
  var height = context.height;
  ctx.clearRect(0, 0, width, height);
  if (width <= 0 || height <= 0) return null;

  var rect = sgPlotRect(width, height, context.leftMargin);
  var spec = context.spectrogram;
  var range = context.frequencyRange;
  var view = context.view;
  var fg = (css.getPropertyValue('--fg') || '#222').trim();
  var lb = (css.getPropertyValue('--lb') || '#888').trim();
  var ax = (css.getPropertyValue('--ax') || '#aaa').trim();
  var cr = (css.getPropertyValue('--cr') || '#e00').trim();

  ctx.save();
  ctx.font = '9px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
  ctx.lineWidth = 1;

  // ── Frame ──
  ctx.strokeStyle = ax;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

  if (!spec || !spec.nTime) {
    ctx.fillStyle = lb;
    ctx.textAlign = 'center';
    ctx.fillText(context.emptyMessage || 'No spectrogram for this view.', rect.x + rect.w / 2, rect.y + rect.h / 2);
    ctx.restore();
    return rect;
  }

  // ── Frequency axis (left) ──
  ctx.fillStyle = lb;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  var fTicks = sgNiceTicks(range.fMin, range.fMax, Math.max(2, Math.floor(rect.h / 34)));
  ctx.strokeStyle = ax;
  for (var i = 0; i < fTicks.length; i++) {
    var y = sgFreqToY(rect, range, fTicks[i]);
    ctx.beginPath();
    ctx.moveTo(rect.x - 3, y);
    ctx.lineTo(rect.x, y);
    ctx.stroke();
    ctx.fillText(sgFmtHz(fTicks[i]), rect.x - 5, y);
  }
  ctx.save();
  ctx.translate(10, rect.y + rect.h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText('Hz', 0, 0);
  ctx.restore();

  // ── Time axis (bottom) ──
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  var tTicks = sgNiceTicks(view.startSec, view.endSec, Math.max(2, Math.floor(rect.w / 68)));
  for (var j = 0; j < tTicks.length; j++) {
    var tx = sgTimeToX(rect, view, tTicks[j]);
    if (tx < rect.x - 1 || tx > rect.x + rect.w + 1) continue;
    ctx.beginPath();
    ctx.moveTo(tx, rect.y + rect.h);
    ctx.lineTo(tx, rect.y + rect.h + 3);
    ctx.stroke();
    ctx.fillText(sgAxisTimeLabel(tTicks[j], context.timeUnit), tx, rect.y + rect.h + 4);
  }

  // ── Acoustic resonance bands (R12) ──
  if (context.showBands && context.bands && context.bands.length) {
    sgDrawBandsHorizontal(ctx, rect, range, context.bands, context.hotBands);
  }

  // ── Marker (R9) and playhead (R14) ──
  ctx.textBaseline = 'top';
  if (isFinite(context.markerTimeSec)) {
    var mx = sgTimeToX(rect, view, context.markerTimeSec);
    if (mx >= rect.x - 1 && mx <= rect.x + rect.w + 1) {
      ctx.save();
      ctx.strokeStyle = cr;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(mx, rect.y);
      ctx.lineTo(mx, rect.y + rect.h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cr;
      ctx.textAlign = mx > rect.x + rect.w - 60 ? 'right' : 'left';
      ctx.fillText(sgFmtTime(context.markerTimeSec, context.timeUnit),
        mx + (ctx.textAlign === 'right' ? -3 : 3), rect.y + 2);
      ctx.restore();
    }
  }
  if (isFinite(context.playheadTimeSec)) {
    var px2 = sgTimeToX(rect, view, context.playheadTimeSec);
    if (px2 >= rect.x - 1 && px2 <= rect.x + rect.w + 1) {
      ctx.save();
      ctx.strokeStyle = cr;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(px2, rect.y);
      ctx.lineTo(px2, rect.y + rect.h);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ── Hover crosshair ──
  if (context.hover && context.hover.inside) {
    ctx.save();
    ctx.strokeStyle = fg;
    ctx.globalAlpha = 0.32;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(rect.x, context.hover.y);
    ctx.lineTo(rect.x + rect.w, context.hover.y);
    ctx.moveTo(context.hover.x, rect.y);
    ctx.lineTo(context.hover.x, rect.y + rect.h);
    ctx.stroke();
    ctx.restore();
  }

  sgDrawColorbar(ctx, rect, width, context.lut, context.windowLevel, spec.unit, lb, ax);
  ctx.restore();
  return rect;
}

/** Time-axis label; the panel follows the waveform panel's unit selection. */
function sgAxisTimeLabel(seconds, unit) {
  if (unit === 'us') return (seconds * 1e6).toFixed(0);
  if (unit === 's') return seconds.toFixed(3);
  return (seconds * 1e3).toFixed(2);
}

/** Bands as horizontal spans across the full time width (spectrogram). */
function sgDrawBandsHorizontal(ctx, rect, range, bands, hotBands) {
  ctx.save();
  for (var i = 0; i < bands.length; i++) {
    var band = bands[i];
    var half = (band.bwHz || 0) / 2;
    var top = sgFreqToY(rect, range, band.freqHz + half);
    var bottom = sgFreqToY(rect, range, band.freqHz - half);
    if (bottom < rect.y || top > rect.y + rect.h) continue;
    var y0 = Math.max(rect.y, top);
    var y1 = Math.min(rect.y + rect.h, bottom);
    var hot = hotBands && hotBands[i];
    if (y1 > y0) {
      ctx.fillStyle = SG_BAND_FILL;
      ctx.fillRect(rect.x, y0, rect.w, y1 - y0);
      ctx.strokeStyle = hot ? SG_BAND_HOT : SG_BAND_COLOR;
      ctx.lineWidth = hot ? 1.6 : 1;
      ctx.setLineDash(hot ? [] : [3, 3]);
      ctx.beginPath();
      ctx.moveTo(rect.x, y0 + 0.5); ctx.lineTo(rect.x + rect.w, y0 + 0.5);
      ctx.moveTo(rect.x, y1 - 0.5); ctx.lineTo(rect.x + rect.w, y1 - 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    var centre = sgFreqToY(rect, range, band.freqHz);
    if (centre >= rect.y && centre <= rect.y + rect.h) {
      ctx.strokeStyle = hot ? SG_BAND_HOT : SG_BAND_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rect.x, centre + 0.5);
      ctx.lineTo(rect.x + rect.w, centre + 0.5);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Colorbar strip with dB ticks, in the right margin. */
function sgDrawColorbar(ctx, rect, width, lut, wl, unit, lb, ax) {
  var barWidth = 9;
  var x = Math.min(width - SG_MARGIN.r + 6, width - barWidth - 26);
  if (x <= rect.x + rect.w) x = rect.x + rect.w + 5;
  if (x + barWidth > width - 2) return;

  var steps = Math.max(2, Math.round(rect.h));
  for (var i = 0; i < steps; i++) {
    var normalized = 1 - i / (steps - 1);
    var index = sgClamp(Math.round(normalized * 255), 0, 255) * 3;
    ctx.fillStyle = 'rgb(' + lut[index] + ',' + lut[index + 1] + ',' + lut[index + 2] + ')';
    ctx.fillRect(x, rect.y + i * rect.h / steps, barWidth, rect.h / steps + 1);
  }
  ctx.strokeStyle = ax;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, rect.y + 0.5, barWidth - 1, rect.h - 1);

  ctx.fillStyle = lb;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  var high = wl.level + wl.width / 2;
  var low = wl.level - wl.width / 2;
  var ticks = sgNiceTicks(low, high, Math.max(2, Math.floor(rect.h / 40)));
  for (var t = 0; t < ticks.length; t++) {
    var y = rect.y + rect.h - (ticks[t] - low) / wl.width * rect.h;
    ctx.fillText(ticks[t].toFixed(0), x + barWidth + 2, y);
  }
  ctx.save();
  ctx.translate(x + barWidth + 20, rect.y + rect.h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText('dB re 1 ' + unit, 0, 0);
  ctx.restore();
}

/* ── Spectrum sub-pane (R9, R10) ─────────────────────────────────────── */

/**
 * Plot the four traces of one spectrum slice.
 *
 * Orientation-aware per D2: docked bottom the panes sit side by side, so
 * frequency becomes the shared *vertical* axis and the forbidden bands line
 * up across both sub-panes. Docked right they stack, so frequency stays on x.
 */
function sgDrawSpectrum(context) {
  var ctx = context.ctx;
  var css = context.css;
  var width = context.width;
  var height = context.height;
  ctx.clearRect(0, 0, width, height);
  if (width <= 0 || height <= 0) return null;

  var rotated = context.orientation === 'vertical';
  var rect = sgSpectrumRect(width, height, context.leftMargin);
  var lb = (css.getPropertyValue('--lb') || '#888').trim();
  var ax = (css.getPropertyValue('--ax') || '#aaa').trim();

  ctx.save();
  ctx.font = '9px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
  ctx.lineWidth = 1;
  ctx.strokeStyle = ax;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

  var slice = context.slice;
  if (!slice || !context.spectrogram || !context.spectrogram.nFreq) {
    ctx.fillStyle = lb;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No spectrum yet.', rect.x + rect.w / 2, rect.y + rect.h / 2);
    ctx.restore();
    return rect;
  }

  var spec = context.spectrogram;
  var range = context.frequencyRange;
  var floorValue = sgValueFloor(spec);
  var scale = context.magnitudeScale;   // {min, max} in dB

  function freqPos(freqHz) {
    return rotated
      ? sgFreqToY(rect, range, freqHz)
      : rect.x + (freqHz - range.fMin) / Math.max(1e-9, range.fMax - range.fMin) * rect.w;
  }
  function magPos(db) {
    var normalized = sgClamp((db - scale.min) / Math.max(1e-9, scale.max - scale.min), 0, 1);
    return rotated
      ? rect.x + normalized * rect.w
      : rect.y + rect.h - normalized * rect.h;
  }

  // ── Bands, drawn under the traces ──
  if (context.showBands && context.bands && context.bands.length) {
    ctx.save();
    for (var b = 0; b < context.bands.length; b++) {
      var band = context.bands[b];
      var half = (band.bwHz || 0) / 2;
      var a = freqPos(band.freqHz - half);
      var c = freqPos(band.freqHz + half);
      var lo = Math.min(a, c), hi = Math.max(a, c);
      var hot = context.hotBands && context.hotBands[b];
      ctx.fillStyle = SG_BAND_FILL;
      ctx.strokeStyle = hot ? SG_BAND_HOT : SG_BAND_COLOR;
      ctx.lineWidth = hot ? 1.6 : 1;
      if (rotated) {
        var y0 = sgClamp(lo, rect.y, rect.y + rect.h);
        var y1 = sgClamp(hi, rect.y, rect.y + rect.h);
        if (y1 > y0) ctx.fillRect(rect.x, y0, rect.w, y1 - y0);
        var cy = freqPos(band.freqHz);
        if (cy >= rect.y && cy <= rect.y + rect.h) {
          ctx.beginPath(); ctx.moveTo(rect.x, cy + 0.5); ctx.lineTo(rect.x + rect.w, cy + 0.5); ctx.stroke();
        }
      } else {
        var x0 = sgClamp(lo, rect.x, rect.x + rect.w);
        var x1 = sgClamp(hi, rect.x, rect.x + rect.w);
        if (x1 > x0) ctx.fillRect(x0, rect.y, x1 - x0, rect.h);
        var cx = freqPos(band.freqHz);
        if (cx >= rect.x && cx <= rect.x + rect.w) {
          ctx.beginPath(); ctx.moveTo(cx + 0.5, rect.y); ctx.lineTo(cx + 0.5, rect.y + rect.h); ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  // ── Axes ──
  ctx.fillStyle = lb;
  var fTicks = sgNiceTicks(range.fMin, range.fMax,
    Math.max(2, Math.floor((rotated ? rect.h : rect.w) / (rotated ? 34 : 60))));
  ctx.strokeStyle = ax;
  for (var i = 0; i < fTicks.length; i++) {
    var p = freqPos(fTicks[i]);
    if (rotated) {
      if (p < rect.y - 1 || p > rect.y + rect.h + 1) continue;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.beginPath(); ctx.moveTo(rect.x - 3, p); ctx.lineTo(rect.x, p); ctx.stroke();
      ctx.fillText(sgFmtHz(fTicks[i]), rect.x - 5, p);
    } else {
      if (p < rect.x - 1 || p > rect.x + rect.w + 1) continue;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.beginPath(); ctx.moveTo(p, rect.y + rect.h); ctx.lineTo(p, rect.y + rect.h + 3); ctx.stroke();
      ctx.fillText(sgFmtHz(fTicks[i]), p, rect.y + rect.h + 4);
    }
  }
  var dbTicks = sgNiceTicks(scale.min, scale.max,
    Math.max(2, Math.floor((rotated ? rect.w : rect.h) / (rotated ? 60 : 30))));
  for (var d = 0; d < dbTicks.length; d++) {
    var q = magPos(dbTicks[d]);
    if (rotated) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(dbTicks[d].toFixed(0), q, rect.y + rect.h + 4);
    } else {
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(dbTicks[d].toFixed(0), rect.x - 5, q);
    }
  }

  // ── Traces ──
  var traces = context.traces;
  for (var t = 0; t < traces.length; t++) {
    var trace = traces[t];
    if (!trace.visible) continue;
    var values = slice[trace.key];
    if (!values || !values.length) continue;
    ctx.strokeStyle = trace.color;
    ctx.lineWidth = trace.key === 'rss' ? 1.6 : 1.1;
    ctx.globalAlpha = trace.key === 'rss' ? 1 : 0.9;
    ctx.beginPath();
    var started = false;
    for (var row = 0; row < values.length; row++) {
      var f = spec.fStartHz + row * spec.fStepHz;
      if (f < range.fMin || f > range.fMax) continue;
      var fp = freqPos(f);
      var mp = magPos(sgToDb(values[row], floorValue));
      var xx = rotated ? mp : fp;
      var yy = rotated ? fp : mp;
      if (!started) { ctx.moveTo(xx, yy); started = true; } else ctx.lineTo(xx, yy);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  return rect;
}

/** dB range for the spectrum pane: shared with the image, or autoscaled. */
function sgSpectrumScale(spec, slice, windowLevel, freeY, traces) {
  if (!freeY) {
    return { min: windowLevel.level - windowLevel.width / 2, max: windowLevel.level + windowLevel.width / 2 };
  }
  if (!spec || !slice) return { min: -80, max: 0 };
  var floorValue = sgValueFloor(spec);
  var max = -Infinity;
  var keys = [];
  for (var t = 0; t < traces.length; t++) if (traces[t].visible) keys.push(traces[t].key);
  if (!keys.length) keys = ['rss'];
  for (var k = 0; k < keys.length; k++) {
    var values = slice[keys[k]];
    if (!values) continue;
    for (var i = 0; i < values.length; i++) {
      var db = sgToDb(values[i], floorValue);
      if (db > max) max = db;
    }
  }
  if (!isFinite(max)) return { min: -80, max: 0 };
  return { min: max - 70, max: max + 5 };
}

/* ── Hit testing and advisory checks ─────────────────────────────────── */

/** Nearest band index to a frequency, or -1 when none is within its width. */
function sgBandAtFrequency(bands, freqHz) {
  if (!bands) return -1;
  for (var i = 0; i < bands.length; i++) {
    var half = Math.max((bands[i].bwHz || 0) / 2, 1);
    if (Math.abs(freqHz - bands[i].freqHz) <= half) return i;
  }
  return -1;
}

/**
 * Advisory in-band energy detection (§8.3).
 *
 * Flags a band when any cell inside it renders at the top of the current
 * window — i.e. above `level + width/2`. This is a *display-relative* hint,
 * not a scanner-grade compliance check, and every surface that shows it says
 * so. Returns a boolean per band.
 */
function sgDetectHotBands(spec, bands, windowLevel, channel) {
  var flags = [];
  if (!spec || !spec.nTime || !bands || !bands.length) return flags;
  var data = spec.data[channel] || spec.data.rss;
  var floorValue = sgValueFloor(spec);
  var threshold = windowLevel.level + windowLevel.width / 2;
  for (var i = 0; i < bands.length; i++) {
    var half = (bands[i].bwHz || 0) / 2;
    var rowLow = Math.max(0, Math.floor((bands[i].freqHz - half - spec.fStartHz) / spec.fStepHz));
    var rowHigh = Math.min(spec.nFreq - 1, Math.ceil((bands[i].freqHz + half - spec.fStartHz) / spec.fStepHz));
    var hot = false;
    for (var row = rowLow; row <= rowHigh && !hot; row++) {
      var base = row * spec.nTime;
      for (var col = 0; col < spec.nTime; col++) {
        if (sgToDb(data[base + col], floorValue) >= threshold) { hot = true; break; }
      }
    }
    flags.push(hot);
  }
  return flags;
}

/** Value of one cell, for the hover readout. */
function sgSampleCell(spec, channel, timeSec, freqHz) {
  if (!spec || !spec.nTime || !spec.nFreq) return null;
  var col = spec.tStepSec > 0 ? Math.round((timeSec - spec.tStartSec) / spec.tStepSec) : 0;
  var row = spec.fStepHz > 0 ? Math.round((freqHz - spec.fStartHz) / spec.fStepHz) : 0;
  if (col < 0 || col >= spec.nTime || row < 0 || row >= spec.nFreq) return null;
  var index = row * spec.nTime + col;
  return {
    column: col,
    row: row,
    timeSec: spec.tStartSec + col * spec.tStepSec,
    freqHz: spec.fStartHz + row * spec.fStepHz,
    gx: spec.data.gx[index],
    gy: spec.data.gy[index],
    gz: spec.data.gz[index],
    rss: spec.data[channel] ? spec.data[channel][index] : spec.data.rss[index]
  };
}
