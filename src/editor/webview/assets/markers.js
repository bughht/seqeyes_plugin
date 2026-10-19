/* ═══════════════════════════════════════════════════════════════════════
   Measurement markers
   ═══════════════════════════════════════════════════════════════════════

   Right-click the waveform viewer to drop a vertical marker. Each marker
   reads out its time, its block and every channel's value where it crosses,
   and Δt to its neighbour. Placement snaps to gradient corners, RF and ADC
   edges and centres, and block boundaries.

   Two renderers draw this viewer: the bundle (VS Code) and web/index.html's
   own copy inside its IIFE (web app, preview, MATLAB). Both install this
   module with accessors to their own state. The last install wins and the
   DOM is wired once, which is the pattern prefs-ui.js and panel.js use.

   The core takes everything it reads as arguments, so it runs in node:vm for
   the unit tests; only install() touches the DOM. */

var SeqEyesMarkers = (function () {
  /* Pointer distances in CSS pixels: how close a corner must be to pull a
     marker onto it, how close a press must be to grab a marker, and how close
     a right-click must be to offer removing one. */
  var SNAP_PX = 8;
  var HIT_PX = 4;
  var REMOVE_PX = 6;
  /* More blocks than this inside the snap distance means the view is too
     zoomed out for a corner to be a meaningful target. */
  var MAX_SNAP_BLOCKS = 32;
  /* Interior corners of an arbitrary waveform are only searched in a slice
     this small, so a hover never walks a whole readout. */
  var MAX_CORNER_SAMPLES = 512;
  /* Candidates closer than this are one point with several names. */
  var MERGE_SEC = 1e-9;

  var AXES = ['gx', 'gy', 'gz'];
  var AXIS_NAMES = { gx: 'Gx', gy: 'Gy', gz: 'Gz' };
  var AXIS_ROW = { gx: 2, gy: 3, gz: 4 };
  var ROW_COLOURS = { 0: '--rf', 1: '--rf', 2: '--gx', 3: '--gy', 4: '--gz', 5: '--adc', 6: '--tr' };
  var KIND_RANK = { corner: 0, event: 1, block: 2 };
  var TRAP_NAMES = ['ramp-up start', 'flat-top start', 'flat-top end', 'ramp-down end'];

  /* ── Core: lookups ─────────────────────────────────────────────────── */

  /** First block whose end (s + d) is at or after `t`. */
  function firstBlockEndingAfter(blocks, t) {
    var lo = 0, hi = blocks.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (blocks[mid].s + blocks[mid].d < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /**
   * Index of the block that holds `t`, or -1 outside the sequence. A time on
   * a boundary belongs to the block that starts there, except that a
   * zero-duration block (labels, soft delays) hands it back to the block that
   * ends there, which is the one with waveforms.
   */
  function blockIndexAt(blocks, t) {
    if (!blocks || !blocks.length || !(t >= blocks[0].s)) return -1;
    var lo = 0, hi = blocks.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (blocks[mid].s <= t) lo = mid + 1; else hi = mid;
    }
    var i = lo - 1;
    while (i > 0 && !(blocks[i].d > 0) && blocks[i - 1].s + blocks[i - 1].d >= t) i--;
    var block = blocks[i];
    return t <= block.s + block.d + 1e-12 ? i : -1;
  }

  /** Linear interpolation, 0 outside the waveform (the tooltip's convention). */
  function sampleAt(times, values, t) {
    var n = Math.min(times.length, values.length);
    if (!n || t < times[0] || t > times[n - 1]) return 0;
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid; else hi = mid;
    }
    var dt = times[hi] - times[lo];
    if (!(dt > 0)) return values[hi];
    return values[lo] + (values[hi] - values[lo]) * (t - times[lo]) / dt;
  }

  /** The sample nearest `t`; for wrapped phase, where interpolating is wrong. */
  function nearestAt(times, values, t) {
    var n = Math.min(times.length, values.length);
    if (!n) return NaN;
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid; else hi = mid;
    }
    return Math.abs(times[hi] - t) < Math.abs(t - times[lo]) ? values[hi] : values[lo];
  }

  function lowerIndex(times, n, t) {
    var lo = 0, hi = n;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (times[mid] < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /**
   * The detail block for `bi`, when the held detail covers [lo, hi].
   *
   * Not blockAt(): that answers for the view being drawn, and its arrays are
   * clipped to that view, so a marker scrolled off screen would read zero.
   */
  function detailBlock(detail, bi, lo, hi) {
    if (!detail || !detail.blocks || bi < detail.startBlock || bi >= detail.endBlock) return null;
    if (detail.startSec > lo || detail.endSec < hi) return null;
    return detail.blocks[bi - detail.startBlock] || null;
  }

  /** Detail the renderer currently holds for this sequence, or null. */
  function liveDetail() {
    if (typeof waveformDetail === 'undefined' || !waveformDetail) return null;
    if (typeof waveformDetailGeneration !== 'undefined' && waveformDetail.generation !== waveformDetailGeneration) return null;
    return waveformDetail;
  }

  /* ── Core: corners ─────────────────────────────────────────────────── */

  /** Coincident corners are one point; name it for what it is. */
  function mergeCoincident(corners) {
    var out = [];
    for (var i = 0; i < corners.length; i++) {
      var c = corners[i], last = out[out.length - 1];
      if (last && Math.abs(c.t - last.t) <= MERGE_SEC) {
        if (last.name === 'flat-top start' && c.name === 'flat-top end') last.name = 'peak';
        else if (last.name === 'ramp-up start' && c.name === 'flat-top start') last.name = 'flat-top start';
        else if (last.name === 'flat-top end' && c.name === 'ramp-down end') last.name = 'flat-top end';
        else if (last.name !== c.name) last.name += ' / ' + c.name;
        continue;
      }
      out.push({ t: c.t, w: c.w, name: c.name });
    }
    return out;
  }

  /**
   * A trapezoid's four corners. The decoder writes exactly these points, plus
   * a leading zero at the block start when the gradient is delayed, and the
   * overview never reduces a waveform this short, so they are exact.
   */
  function trapezoidCorners(g) {
    var n = Math.min(g.t.length, g.w.length), first = n === 5 ? 1 : 0;
    if (n - first !== 4) return endpointCorners(g);
    var corners = [];
    for (var k = 0; k < 4; k++) corners.push({ t: g.t[first + k], w: g.w[first + k], name: TRAP_NAMES[k] });
    return mergeCoincident(corners);
  }

  /** First and last sample: exact even after reduction, which keeps both. */
  function endpointCorners(g) {
    var n = Math.min(g.t.length, g.w.length);
    if (!n) return [];
    return n === 1
      ? [{ t: g.t[0], w: g.w[0], name: 'start' }]
      : [{ t: g.t[0], w: g.w[0], name: 'start' }, { t: g.t[n - 1], w: g.w[n - 1], name: 'end' }];
  }

  /**
   * Douglas–Peucker on samples i0..i1: the indices a polyline within `eps`
   * (vertically) of every sample needs. Iterative, so a long slice cannot
   * overflow the stack.
   */
  function simplify(t, w, i0, i1, eps) {
    var keep = [i0, i1], stack = [i0, i1];
    while (stack.length) {
      var b = stack.pop(), a = stack.pop();
      if (b - a < 2) continue;
      var ta = t[a], wa = w[a], span = t[b] - ta, slope = span > 0 ? (w[b] - wa) / span : 0;
      var worst = -1, at = -1;
      for (var k = a + 1; k < b; k++) {
        var deviation = Math.abs(w[k] - (wa + slope * (t[k] - ta)));
        if (deviation > worst) { worst = deviation; at = k; }
      }
      if (worst > eps) { keep.push(at); stack.push(a, at, at, b); }
    }
    keep.sort(function (x, y) { return x - y; });
    return keep;
  }

  /**
   * Corners inside an arbitrary or extended-trapezoid waveform near [lo, hi].
   *
   * Both arrive as 'arb', so breakpoints cannot be told from raster samples.
   * The shape is simplified to a polyline within 0.5 % of the waveform's
   * scale, and a vertex is a corner where the line goes flat↔ramp, reverses
   * (a peak), steps, or changes slope by at least half. That finds every
   * breakpoint of an extended trapezoid and the trapezoid-like corners of a
   * raster-sampled one, while a smooth spiral keeps little more than its
   * peaks.
   */
  function interiorCorners(g, lo, hi, amplitude) {
    var n = Math.min(g.t.length, g.w.length);
    if (n < 3) return [];
    var i0 = Math.max(0, lowerIndex(g.t, n, lo) - 1);
    var i1 = Math.min(n - 1, lowerIndex(g.t, n, hi));
    if (i1 - i0 < 2 || i1 - i0 + 1 > MAX_CORNER_SAMPLES) return [];
    var scale = Math.abs(amplitude) || 0;
    for (var i = i0; i <= i1; i++) scale = Math.max(scale, Math.abs(g.w[i]));
    if (!(scale > 0)) return [];
    var eps = 0.005 * scale, keep = simplify(g.t, g.w, i0, i1, eps), out = [];
    for (var j = 1; j < keep.length - 1; j++) {
      var p = keep[j - 1], k = keep[j], q = keep[j + 1];
      var d1 = g.w[k] - g.w[p], d2 = g.w[q] - g.w[k], dt1 = g.t[k] - g.t[p], dt2 = g.t[q] - g.t[k];
      var name = null;
      if (!(dt1 > 0) || !(dt2 > 0)) {
        if (Math.abs(!(dt1 > 0) ? d1 : d2) > 0.02 * scale) name = 'step';
      } else {
        var flat1 = Math.abs(d1) <= eps, flat2 = Math.abs(d2) <= eps;
        if (flat1 && flat2) continue;
        if (flat1) name = Math.abs(g.w[q]) > Math.abs(g.w[k]) ? 'ramp-up start' : 'ramp-down start';
        else if (flat2) name = Math.abs(g.w[k]) > Math.abs(g.w[p]) ? 'ramp-up end' : 'ramp-down end';
        else {
          var s1 = d1 / dt1, s2 = d2 / dt2;
          if (s1 * s2 < 0) name = 'peak';
          else if (Math.abs(s2 - s1) >= 0.5 * Math.max(Math.abs(s1), Math.abs(s2))) name = 'slope change';
        }
      }
      if (name) out.push({ t: g.t[k], w: g.w[k], name: name });
    }
    return out;
  }

  /**
   * Corners of one gradient near [lo, hi]. Trapezoids come from the overview,
   * which always has them whole. An arbitrary waveform's interior corners
   * come from exact detail when it covers the window, otherwise from the
   * overview unless the overview was reduced; a reduced waveform only offers
   * its ends.
   */
  function gradientCorners(overview, detail, lo, hi) {
    if (overview.ty === 'trap') return trapezoidCorners(overview);
    var corners = endpointCorners(overview);
    var source = detail && detail.t && !detail.r ? detail : (!overview.r ? overview : null);
    if (source) corners = corners.concat(interiorCorners(source, lo, hi, overview.a));
    corners.sort(function (a, b) { return a.t - b.t; });
    return mergeCoincident(corners);
  }

  /* ── Core: snapping ────────────────────────────────────────────────── */

  function blockLabel(blocks, bi) {
    return bi > 0 ? 'block #' + blocks[bi - 1].i + '/#' + blocks[bi].i : 'block #' + blocks[bi].i + ' start';
  }

  /**
   * Every snap target within `tol` seconds of `t`.
   *
   * opts.rows: visible channel indices; a channel whose row is hidden offers
   * no corners. Block boundaries are always offered. opts.detail: the held
   * waveform detail, or null.
   */
  function snapCandidates(blocks, t, tol, opts) {
    var out = [];
    if (!blocks || !blocks.length || !(tol > 0)) return out;
    opts = opts || {};
    var rows = opts.rows || [0, 1, 2, 3, 4, 5, 6], shown = {};
    for (var r = 0; r < rows.length; r++) shown[rows[r]] = true;
    var lo = t - tol, hi = t + tol, count = 0;
    for (var bi = firstBlockEndingAfter(blocks, lo); bi < blocks.length && blocks[bi].s <= hi; bi++) {
      if (++count > MAX_SNAP_BLOCKS) return [];
      var b = blocks[bi];
      out.push({ t: b.s, kind: 'block', ci: -1, value: 0, label: blockLabel(blocks, bi) });
      if (bi === blocks.length - 1) out.push({ t: b.s + b.d, kind: 'block', ci: -1, value: 0, label: 'block #' + b.i + ' end' });
      for (var a = 0; a < AXES.length; a++) {
        var axis = AXES[a], g = b[axis];
        if (!shown[AXIS_ROW[axis]] || !g || g.ty === 'none' || !g.t || !g.t.length) continue;
        if (g.t[g.t.length - 1] < lo || g.t[0] > hi) continue;
        var detail = detailBlock(opts.detail, bi, lo, hi);
        var corners = gradientCorners(g, detail && detail[axis], lo, hi);
        for (var c = 0; c < corners.length; c++) {
          out.push({ t: corners[c].t, kind: 'corner', ci: AXIS_ROW[axis], value: corners[c].w, label: AXIS_NAMES[axis] + ' ' + corners[c].name });
        }
      }
      var rf = b.rf;
      if (rf && (shown[0] || shown[1])) {
        var rfValue = function (time) { return rf.t && rf.m ? sampleAt(rf.t, rf.m, time) : 0; };
        out.push({ t: rf.s, kind: 'event', ci: 0, value: 0, label: 'RF start' });
        if (isFinite(rf.c)) out.push({ t: rf.c, kind: 'event', ci: 0, value: rfValue(rf.c), label: 'RF centre' });
        out.push({ t: rf.s + rf.d, kind: 'event', ci: 0, value: 0, label: 'RF end' });
      }
      var adc = b.adc;
      if (adc && shown[5] && adc.n > 0) {
        var start = adc.s + (adc.d || 0), span = adc.n * adc.dw;
        out.push({ t: start, kind: 'event', ci: 5, value: 0, label: 'ADC start' });
        out.push({ t: start + span / 2, kind: 'event', ci: 5, value: 0, label: 'ADC centre' });
        out.push({ t: start + span, kind: 'event', ci: 5, value: 0, label: 'ADC end' });
      }
      if (b.trg && shown[6]) {
        for (var g2 = 0; g2 < b.trg.length; g2++) {
          var tg = b.trg[g2];
          out.push({ t: tg.s + (tg.d || 0), kind: 'event', ci: 6, value: 0, label: 'trigger start' });
        }
      }
    }
    return out.filter(function (candidate) { return candidate.t >= lo && candidate.t <= hi; });
  }

  function rank(candidate, pointerCi) {
    var own = candidate.kind === 'corner' && candidate.ci === pointerCi ? 0 : 1;
    return own * 10 + KIND_RANK[candidate.kind];
  }

  /**
   * The candidate to snap to: the nearest, except that within `onePx` seconds
   * a corner on the pointer's own row beats other corners, which beat event
   * edges, which beat block boundaries. Everything at the same instant is
   * folded into its label, e.g. "Gx ramp-down end · block #12/#13".
   */
  function chooseSnap(candidates, t, onePx, pointerCi) {
    var best = null, bestDistance = Infinity;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i], distance = Math.abs(c.t - t);
      if (!best || distance < bestDistance - onePx) { best = c; bestDistance = distance; continue; }
      if (distance > bestDistance + onePx) continue;
      var difference = rank(c, pointerCi) - rank(best, pointerCi);
      if (difference < 0 || (difference === 0 && distance < bestDistance)) { best = c; bestDistance = distance; }
    }
    if (!best) return null;
    var same = candidates.filter(function (c) { return Math.abs(c.t - best.t) <= MERGE_SEC; });
    same.sort(function (a, b) { return rank(a, pointerCi) - rank(b, pointerCi); });
    var labels = [best.label];
    for (var j = 0; j < same.length; j++) if (labels.indexOf(same[j].label) < 0) labels.push(same[j].label);
    var text = labels.length > 3 ? labels.slice(0, 3).join(' · ') + ' +' + (labels.length - 3) : labels.join(' · ');
    return { t: best.t, kind: best.kind, ci: best.ci, value: best.value, label: best.label, labels: labels, text: text };
  }

  function snapAt(blocks, t, tol, opts) {
    opts = opts || {};
    return chooseSnap(snapCandidates(blocks, t, tol, opts), t, opts.onePx || tol / SNAP_PX, opts.pointerCi);
  }

  /* ── Core: readout ─────────────────────────────────────────────────── */

  /**
   * Every channel's value at `t`. Gradients are in Hz/m; `approx` names the
   * channels read from a reduced overview, where the samples either side of
   * `t` may not be adjacent.
   */
  function readoutAt(blocks, t, detail) {
    var out = { t: t, index: -1, block: -1, offset: NaN, gx: 0, gy: 0, gz: 0, approx: {}, rf: null, adc: null, trigger: false };
    var bi = blockIndexAt(blocks, t);
    if (bi < 0) return out;
    var b = blocks[bi], d = detailBlock(detail, bi, t, t);
    out.index = bi; out.block = b.i; out.offset = t - b.s;
    for (var a = 0; a < AXES.length; a++) {
      var axis = AXES[a], g = b[axis];
      if (!g || g.ty === 'none' || !g.t || !g.w) continue;
      var exact = d && d[axis] && g.ty !== 'trap' ? d[axis] : null;
      var source = exact && exact.t && exact.t.length && exact.t[0] <= t && exact.t[exact.t.length - 1] >= t ? exact : g;
      out[axis] = sampleAt(source.t, source.w, t);
      if (source.r && t >= g.t[0] && t <= g.t[g.t.length - 1]) out.approx[axis] = true;
    }
    var rf = b.rf;
    if (rf && t >= rf.s && t <= rf.s + rf.d && rf.t && rf.m) {
      var rfSource = d && d.rf && d.rf.t && d.rf.t.length && d.rf.t[0] <= t && d.rf.t[d.rf.t.length - 1] >= t ? d.rf : rf;
      out.rf = {
        amplitude: sampleAt(rfSource.t, rfSource.m, t),
        phase: rfSource.pt && rfSource.p ? nearestAt(rfSource.pt, rfSource.p, t) : NaN,
        approx: !!rfSource.r
      };
    }
    var adc = b.adc;
    if (adc && adc.n > 0) {
      var start = adc.s + (adc.d || 0), end = start + adc.n * adc.dw;
      if (t >= start && t <= end) {
        // The tolerance keeps a time exactly on a sample edge (as snapping
        // places it) from rounding down into the previous sample.
        var sample = Math.floor((t - start) / adc.dw + 1e-6);
        out.adc = { sample: Math.max(0, Math.min(adc.n - 1, sample)), count: adc.n };
      }
    }
    if (b.trg) {
      for (var i = 0; i < b.trg.length; i++) {
        var tg = b.trg[i], from = tg.s + (tg.d || 0);
        if (t >= from && t <= from + (tg.dr || 0)) out.trigger = true;
      }
    }
    return out;
  }

  /* ── Core: formatting ──────────────────────────────────────────────── */

  /* Digits that resolve 0.1 µs, the finest raster Pulseq uses (ADC dwell). */
  var TIME_DIGITS = { s: 7, ms: 4, us: 1 };
  var GRAD_DIGITS = { 'Hz/m': 0, 'mT/m': 2, 'G/cm': 3 };

  function unitName(unit) { return unit === 'us' ? 'µs' : unit; }

  function formatTime(seconds, units) {
    var digits = TIME_DIGITS[units.timeUnit];
    return units.timeConv(seconds).toFixed(digits === undefined ? 4 : digits);
  }

  function formatGradient(hzPerM, units) {
    var digits = GRAD_DIGITS[units.gradUnit];
    var text = units.gradConv(hzPerM).toFixed(digits === undefined ? 2 : digits);
    return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text;
  }

  /**
   * One row per marker, in time order, with everything formatted in the
   * viewer's current units. `list` is [{id, t, snap}].
   */
  function tableRows(list, blocks, detail, units) {
    var rows = [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i], r = readoutAt(blocks, m.t, detail), previous = i > 0 ? list[i - 1] : null;
      rows.push({
        id: m.id,
        name: 'M' + m.id,
        time: formatTime(m.t, units),
        delta: previous ? formatTime(m.t - previous.t, units) : '',
        block: r.block >= 0 ? '#' + r.block : '',
        offset: r.block >= 0 ? formatTime(r.offset, units) : '',
        gx: (r.approx.gx ? '≈' : '') + formatGradient(r.gx, units),
        gy: (r.approx.gy ? '≈' : '') + formatGradient(r.gy, units),
        gz: (r.approx.gz ? '≈' : '') + formatGradient(r.gz, units),
        rf: r.rf ? (r.rf.approx ? '≈' : '') + r.rf.amplitude.toFixed(1) : '',
        phase: r.rf && isFinite(r.rf.phase) ? (r.rf.phase * 180 / Math.PI).toFixed(1) : '',
        adc: r.adc ? (r.adc.sample + 1) + '/' + r.adc.count : '',
        trigger: r.trigger ? 'on' : '',
        snap: m.snap || '',
        approx: !!(r.approx.gx || r.approx.gy || r.approx.gz || (r.rf && r.rf.approx))
      });
    }
    return rows;
  }

  function columns(units) {
    var t = unitName(units.timeUnit), g = units.gradUnit;
    return [
      ['name', 'Marker'], ['time', 'Time (' + t + ')'], ['delta', 'Δt (' + t + ')'],
      ['block', 'Block'], ['offset', 'In block (' + t + ')'],
      ['gx', 'Gx (' + g + ')'], ['gy', 'Gy (' + g + ')'], ['gz', 'Gz (' + g + ')'],
      ['rf', 'RF (Hz)'], ['phase', 'RF phase (°)'], ['adc', 'ADC sample'], ['trigger', 'Trigger'],
      ['snap', 'Snapped to']
    ];
  }

  /** Tab-separated, with a header, for pasting into a spreadsheet. */
  function toTsv(rows, units) {
    var cols = columns(units), lines = [cols.map(function (c) { return c[1]; }).join('\t')];
    for (var i = 0; i < rows.length; i++) {
      lines.push(cols.map(function (c) { return String(rows[i][c[0]]).replace(/[\t\n]/g, ' '); }).join('\t'));
    }
    return lines.join('\n');
  }

  /* ── Marker list ───────────────────────────────────────────────────── */

  var markers = [];
  var version = 0;

  function sortMarkers() { markers.sort(function (a, b) { return a.t - b.t || a.id - b.id; }); }

  /** Ids keep growing while markers exist, so "M2" keeps meaning one marker. */
  function addMarker(t, snap) {
    var id = 1;
    for (var i = 0; i < markers.length; i++) id = Math.max(id, markers[i].id + 1);
    var marker = { id: id, t: t, snap: snap || '' };
    markers.push(marker); sortMarkers(); version++;
    return marker;
  }

  function findMarker(id) {
    for (var i = 0; i < markers.length; i++) if (markers[i].id === id) return markers[i];
    return null;
  }

  function moveMarker(id, t, snap) {
    var marker = findMarker(id);
    if (!marker) return null;
    marker.t = t; marker.snap = snap || ''; sortMarkers(); version++;
    return marker;
  }

  function removeMarker(id) {
    var before = markers.length;
    markers = markers.filter(function (m) { return m.id !== id; });
    if (markers.length !== before) version++;
  }

  function clearMarkers() {
    if (markers.length) version++;
    markers = [];
  }

  function listMarkers() { return markers.map(function (m) { return { id: m.id, t: m.t, snap: m.snap }; }); }

  /* ══ UI (only install() reaches here) ══════════════════════════════════ */

  var ctx = null;
  var wired = false;
  var snapEnabled = true;
  var tableOpen = true;
  /** Pointer over the plot, in canvas CSS pixels; null when elsewhere. */
  var hover = null;
  var hoverMarkerId = 0;
  /** {id, from, fromSnap, snap} while a marker is being dragged. */
  var drag = null;
  var menu = null;
  /** {x, y, snap} the open menu was opened for. */
  var menuTarget = null;
  var tableEl = null;
  var tableKey = '';
  var snapCache = null;

  function el(id) { return document.getElementById(id); }
  function prefs() { return typeof SeqEyesPrefs !== 'undefined' ? SeqEyesPrefs : null; }

  function units() {
    return { timeConv: ctx.timeConv, timeUnit: ctx.timeUnitStr(), gradConv: ctx.gradConv, gradUnit: ctx.gradUnitStr() };
  }

  function canvasPoint(event) {
    var mc = el('mc'), rect = mc.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width, height: rect.height };
  }

  function insidePlot(p) {
    var M = ctx.margins();
    return p.x >= M.l && p.x <= p.width - M.r && p.y >= M.t && p.y <= p.height - M.b;
  }

  function rowAt(y) {
    var M = ctx.margins(), rows = ctx.visChannels(), vi = Math.floor((y - M.t) / ctx.cH());
    return vi >= 0 && vi < rows.length ? rows[vi] : -1;
  }

  function markerNear(x, px) {
    var best = null, bestDistance = px + 1e-9;
    for (var i = 0; i < markers.length; i++) {
      var distance = Math.abs(ctx.t2x(markers[i].t) - x);
      if (distance <= bestDistance) { best = markers[i]; bestDistance = distance; }
    }
    return best;
  }

  function clampTime(t) {
    var total = ctx.duration();
    return Math.max(0, total > 0 ? Math.min(total, t) : t);
  }

  /**
   * Snap target under the pointer, or null. Cached: in the web app the
   * overlay is drawn twice a frame (once by the bundle, once by the page).
   */
  function snapFor(x, y) {
    if (!ctx || !snapEnabled) return null;
    var blocks = ctx.blocks();
    if (!blocks || !blocks.length) return null;
    var t = ctx.x2t(x), tol = Math.abs(ctx.x2t(x + SNAP_PX) - t), rows = ctx.visChannels();
    var pointerCi = y === null || y === undefined ? -1 : rowAt(y), detail = liveDetail(), rowKey = rows.join(',');
    var c = snapCache;
    if (c && c.blocks === blocks && c.detail === detail && c.t === t && c.tol === tol && c.ci === pointerCi && c.rows === rowKey) {
      return c.result;
    }
    var result = snapAt(blocks, t, tol, { rows: rows, pointerCi: pointerCi, detail: detail, onePx: tol / SNAP_PX });
    snapCache = { blocks: blocks, detail: detail, t: t, tol: tol, ci: pointerCi, rows: rowKey, result: result };
    return result;
  }

  /** The suggestion shows once markers are in use, not while just browsing. */
  function currentSuggestion() {
    if (menuTarget) return menuTarget.snap;
    if (drag) return drag.snap;
    if (hover && markers.length) return snapFor(hover.x, hover.y);
    return null;
  }

  function redraw() {
    if (ctx && typeof ctx.requestOverlay === 'function') ctx.requestOverlay();
  }

  /* ── Drawing on the overlay canvas ─────────────────────────────────── */

  function valueToY(ci, vi, value) {
    var M = ctx.margins(), ch = ctx.cH(), y = ctx.cy(vi);
    if (ci === 0 || ci === 1) return y + ch * 0.45 - value * (ch * 0.9 / ctx.channelRange(ci));
    if (ci >= 2 && ci <= 4) return y - value * (ch * 0.4 / ctx.channelRange(ci));
    if (ci === 7) return M.t + (vi + 1) * ch - ch * 0.08 - value * (ch * 0.84 / ctx.channelRange(7));
    if (ci >= 8 && ci <= 10) return y - value * (ch * 0.4 / ctx.channelRange(ci));
    return y;
  }

  function clampToRow(vi, y) {
    var M = ctx.margins(), ch = ctx.cH(), top = M.t + vi * ch;
    return Math.max(top + 2, Math.min(top + ch - 2, y));
  }

  function colour(style, name, fallback) {
    var value = style.getPropertyValue(name).trim();
    return value || fallback;
  }

  function pill(g, text, x, y, left, right, fg, bg) {
    var width = g.measureText(text).width + 8, cx = Math.max(left + width / 2, Math.min(right - width / 2, x));
    g.fillStyle = fg; g.fillRect(cx - width / 2, y - 7, width, 13);
    g.fillStyle = bg; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, cx, y);
    return { left: cx - width / 2, right: cx + width / 2 };
  }

  function drawSuggestion(g, w, h, s, style, fg) {
    var M = ctx.margins(), x = ctx.t2x(s.t);
    if (x < M.l || x > w - M.r) return;
    g.save();
    g.globalAlpha = 0.75; g.strokeStyle = fg; g.lineWidth = 1; g.setLineDash([2, 3]);
    g.beginPath(); g.moveTo(x, M.t); g.lineTo(x, h - M.b); g.stroke(); g.setLineDash([]);
    g.globalAlpha = 1;
    var rows = ctx.visChannels(), vi = rows.indexOf(s.ci), y = M.t + 12;
    if (vi >= 0) {
      y = clampToRow(vi, valueToY(s.ci, vi, s.value));
      g.lineWidth = 1.5; g.strokeStyle = colour(style, ROW_COLOURS[s.ci] || '--fg', fg);
      g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.stroke();
    }
    g.font = '10px monospace';
    var text = s.text, width = g.measureText(text).width, right = x + 8 + width <= w - M.r;
    g.fillStyle = colour(style, '--bg', '#fff'); g.globalAlpha = 0.85;
    g.fillRect(right ? x + 7 : x - 9 - width, y - 16, width + 2, 12);
    g.globalAlpha = 1; g.fillStyle = fg; g.textAlign = right ? 'left' : 'right'; g.textBaseline = 'middle';
    g.fillText(text, right ? x + 8 : x - 8, y - 10);
    g.restore();
  }

  /**
   * Called by both renderers' drawCursorOverlay, after the overlay is cleared:
   * marker lines with a dot where each crosses RF and the gradients, Δt
   * between neighbours, and the snap suggestion.
   */
  function drawOverlay(g, w, h) {
    if (!ctx || !g) return;
    syncTable();
    var suggestion = currentSuggestion();
    if (!markers.length && !suggestion) return;
    var style = getComputedStyle(document.body), fg = colour(style, '--fg', '#222'), bg = colour(style, '--bg', '#fff');
    var M = ctx.margins(), left = M.l, right = w - M.r, top = M.t, bottom = h - M.b;
    var rows = ctx.visChannels(), detail = liveDetail(), blocks = ctx.blocks(), u = units();
    g.save();
    g.beginPath(); g.rect(left, top, Math.max(0, right - left), Math.max(0, bottom - top)); g.clip();
    g.font = '10px monospace';

    // Δt between neighbours, just above the marker names.
    var bracketY = bottom - 22;
    for (var i = 1; i < markers.length; i++) {
      var xa = ctx.t2x(markers[i - 1].t), xb = ctx.t2x(markers[i].t);
      if (xb < left || xa > right || xb - xa < 2) continue;
      var a = Math.max(left, xa), b = Math.min(right, xb);
      g.strokeStyle = fg; g.lineWidth = 1; g.globalAlpha = 0.8;
      g.beginPath(); g.moveTo(a, bracketY); g.lineTo(b, bracketY);
      if (xa >= left) { g.moveTo(xa, bracketY - 4); g.lineTo(xa, bracketY + 4); }
      if (xb <= right) { g.moveTo(xb, bracketY - 4); g.lineTo(xb, bracketY + 4); }
      g.stroke(); g.globalAlpha = 1;
      var label = 'Δ ' + formatTime(markers[i].t - markers[i - 1].t, u) + ' ' + unitName(u.timeUnit);
      var width = g.measureText(label).width;
      if (b - a > width + 10) {
        g.fillStyle = bg; g.fillRect((a + b) / 2 - width / 2 - 3, bracketY - 15, width + 6, 12);
        g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, (a + b) / 2, bracketY - 9);
      }
    }

    for (var k = 0; k < markers.length; k++) {
      var m = markers[k], x = ctx.t2x(m.t);
      if (x < left - 1 || x > right + 1) continue;
      var active = m.id === hoverMarkerId || (drag && drag.id === m.id);
      g.strokeStyle = fg; g.lineWidth = active ? 2 : 1.2; g.setLineDash([]);
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke();

      var reading = readoutAt(blocks, m.t, detail);
      var next = k + 1 < markers.length ? ctx.t2x(markers[k + 1].t) : right;
      for (var vi = 0; vi < rows.length; vi++) {
        var ci = rows[vi], value = null;
        if (ci === 0) value = reading.rf ? reading.rf.amplitude : null;
        else if (ci >= 2 && ci <= 4) value = reading[AXES[ci - 2]];
        if (value === null) continue;
        var y = clampToRow(vi, valueToY(ci, vi, value));
        g.fillStyle = colour(style, ROW_COLOURS[ci], fg); g.strokeStyle = bg; g.lineWidth = 1;
        g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); g.stroke();
        if (ci >= 2 && next - x > 70) {
          var text = (reading.approx[AXES[ci - 2]] ? '≈' : '') + formatGradient(value, u);
          g.fillStyle = fg; g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillText(text, x + 5, y - 2);
        }
      }
      var nameRoom = Math.min(next, right) - x;
      var name = 'M' + m.id, full = name + ' ' + formatTime(m.t, u) + ' ' + unitName(u.timeUnit);
      pill(g, nameRoom > g.measureText(full).width + 24 ? full : name, x, bottom - 8, left, right, fg, bg);
    }
    if (suggestion) drawSuggestion(g, w, h, suggestion, style, fg);
    g.restore();
  }

  /* ── Table strip ───────────────────────────────────────────────────── */

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, title, onClick) {
    var b = element('button', null, text);
    b.type = 'button'; if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function buildTable() {
    var cc = el('cc');
    if (!cc || !cc.parentNode) return;
    tableEl = element('div', 'mk-table'); tableEl.id = 'mkTable'; tableEl.hidden = true;
    tableEl.setAttribute('role', 'region'); tableEl.setAttribute('aria-label', 'Measurement markers');
    cc.parentNode.insertBefore(tableEl, cc.nextSibling);
  }

  /** Re-render when the markers, units or underlying samples changed. */
  function syncTable() {
    if (!tableEl || !ctx) return;
    var u = units(), detail = liveDetail(), blocks = ctx.blocks();
    var key = [version, markers.length, u.timeUnit, u.gradUnit, tableOpen, detail ? detail.startSec + ':' + detail.endSec : '-', blocks ? blocks.length : 0].join('|');
    if (key === tableKey && tableEl.__blocks === blocks && tableEl.__detail === detail) return;
    tableKey = key; tableEl.__blocks = blocks; tableEl.__detail = detail;
    renderTable(u, detail, blocks);
  }

  function renderTable(u, detail, blocks) {
    var wasHidden = tableEl.hidden;
    tableEl.textContent = '';
    tableEl.hidden = !markers.length;
    if (!markers.length) { if (!wasHidden) relayout(); return; }
    var rows = tableRows(markers, blocks, detail, u);
    var head = element('div', 'mk-head');
    head.appendChild(element('span', 'mk-title', 'Markers'));
    var span = markers.length > 1 ? ' · span ' + formatTime(markers[markers.length - 1].t - markers[0].t, u) + ' ' + unitName(u.timeUnit) : '';
    head.appendChild(element('span', 'mk-summary', markers.length + (markers.length === 1 ? ' marker' : ' markers') + span));
    if (rows.some(function (r) { return r.approx; })) {
      head.appendChild(element('span', 'mk-note', '≈ from reduced samples; zoom in for exact values'));
    }
    var actions = element('span', 'mk-actions');
    actions.appendChild(button(tableOpen ? 'Hide' : 'Show', tableOpen ? 'Collapse the marker table' : 'Expand the marker table', function () { setTableOpen(!tableOpen); }));
    actions.appendChild(button('Copy', 'Copy the table as tab-separated text', function () { copyTable(this); }));
    actions.appendChild(button('Clear', 'Remove every marker', function () { clearMarkers(); afterChange(); }));
    head.appendChild(actions);
    tableEl.appendChild(head);
    if (tableOpen) {
      var scroll = element('div', 'mk-scroll'), table = element('table'), thead = element('thead'), tr = element('tr');
      var cols = columns(u);
      cols.forEach(function (c) { tr.appendChild(element('th', null, c[1])); });
      tr.appendChild(element('th'));
      thead.appendChild(tr); table.appendChild(thead);
      var body = element('tbody');
      rows.forEach(function (row) {
        var line = element('tr');
        line.setAttribute('data-marker', String(row.id));
        cols.forEach(function (c) { line.appendChild(element('td', c[0] === 'name' ? 'mk-name' : null, row[c[0]])); });
        var cell = element('td');
        cell.appendChild(button('×', 'Remove ' + row.name, function () { removeMarker(row.id); afterChange(); }));
        line.appendChild(cell);
        body.appendChild(line);
      });
      table.appendChild(body); scroll.appendChild(table); tableEl.appendChild(scroll);
    }
    relayout();
  }

  /* The strip takes height from the plot; the hosts' ResizeObserver on #cc
     redraws, but only once the size actually settles, so ask explicitly. */
  function relayout() {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(redraw);
  }

  function setTableOpen(open) {
    tableOpen = !!open;
    var p = prefs(); if (p && p.KEYS.markerTable) p.setBool(p.KEYS.markerTable, tableOpen);
    tableKey = '';
    syncTable();
  }

  function copyTable(source) {
    var text = toTsv(tableRows(markers, ctx.blocks(), liveDetail(), units()), units());
    var done = function () { if (source) { var old = source.textContent; source.textContent = 'Copied'; setTimeout(function () { source.textContent = old; }, 1200); } };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }

  function fallbackCopy(text) {
    var area = element('textarea'); area.value = text;
    area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.appendChild(area); area.select();
    try { document.execCommand('copy'); } catch (e) { /* nothing more to try */ }
    document.body.removeChild(area);
  }

  function afterChange() {
    snapCache = null;
    syncTable();
    redraw();
  }

  /* ── Context menu ──────────────────────────────────────────────────── */

  function isCompactLayout() {
    return !!(window.matchMedia && window.matchMedia('(max-width: 768px), (pointer: coarse)').matches);
  }

  function menuItem(label, detail, onSelect) {
    var item = element('button', 'mk-item');
    item.type = 'button'; item.setAttribute('role', 'menuitem');
    item.appendChild(element('span', 'mk-item-label', label));
    if (detail) item.appendChild(element('span', 'mk-item-detail', detail));
    item.addEventListener('click', function () { closeMenu(); onSelect(); });
    return item;
  }

  function menuToggle(label, checked, onChange) {
    var row = element('label', 'mk-item mk-check');
    var box = element('input'); box.type = 'checkbox'; box.checked = checked;
    box.setAttribute('role', 'menuitemcheckbox');
    box.addEventListener('change', function () { onChange(box.checked); });
    row.appendChild(box); row.appendChild(element('span', 'mk-item-label', label));
    return row;
  }

  function openMenu(event, p) {
    closeMenu();
    var u = units(), t = clampTime(ctx.x2t(p.x)), snap = snapFor(p.x, p.y), near = markerNear(p.x, REMOVE_PX);
    var time = function (seconds) { return formatTime(seconds, u) + ' ' + unitName(u.timeUnit); };
    menuTarget = { x: p.x, y: p.y, snap: snap };
    menu = element('div', 'lblc mk-menu'); menu.id = 'markerMenu';
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Measurement markers');
    if (snap) menu.appendChild(menuItem('Add marker at ' + snap.text, time(snap.t), function () { place(snap.t, snap.text); }));
    menu.appendChild(menuItem(snap ? 'Add marker at pointer (no snap)' : 'Add marker here', time(t), function () { place(t, ''); }));
    if (near) menu.appendChild(menuItem('Remove M' + near.id, time(near.t), function () { removeMarker(near.id); afterChange(); }));
    if (markers.length) menu.appendChild(menuItem('Clear all markers', String(markers.length), function () { clearMarkers(); afterChange(); }));
    menu.appendChild(element('div', 'mk-sep'));
    menu.appendChild(menuToggle('Snap to corners and block edges', snapEnabled, function (on) {
      snapEnabled = on;
      var pr = prefs(); if (pr && pr.KEYS.markerSnap) pr.setBool(pr.KEYS.markerSnap, on);
      menuTarget.snap = on ? snapFor(p.x, p.y) : null;
      snapCache = null; redraw();
    }));
    if (markers.length) menu.appendChild(menuToggle('Show the marker table', tableOpen, function (on) { setTableOpen(on); }));
    document.body.appendChild(menu);
    positionMenu(event.clientX, event.clientY);
    el('cc').classList.add('mk-menu-open');
    document.addEventListener('pointerdown', onOutsidePointer, true);
    window.addEventListener('resize', closeMenu);
    var first = menu.querySelector('.mk-item');
    if (first && first.focus) first.focus();
    redraw();
  }

  function positionMenu(clientX, clientY) {
    var compact = isCompactLayout();
    menu.classList.toggle('sheet', compact);
    if (compact) { menu.style.left = ''; menu.style.top = ''; return; }
    var width = menu.offsetWidth, height = menu.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    menu.style.left = Math.max(8, Math.min(clientX + 2, vw - width - 8)) + 'px';
    menu.style.top = Math.max(8, clientY + 2 + height > vh - 8 ? clientY - height - 2 : clientY + 2) + 'px';
  }

  function closeMenu() {
    if (!menu) return;
    document.removeEventListener('pointerdown', onOutsidePointer, true);
    window.removeEventListener('resize', closeMenu);
    if (menu.parentNode) menu.parentNode.removeChild(menu);
    menu = null; menuTarget = null;
    var cc = el('cc'); if (cc) cc.classList.remove('mk-menu-open');
    redraw();
  }

  function onOutsidePointer(event) {
    if (menu && !menu.contains(event.target)) closeMenu();
  }

  function moveMenuFocus(step) {
    var items = Array.prototype.slice.call(menu.querySelectorAll('.mk-item'));
    var at = items.indexOf(document.activeElement && document.activeElement.closest ? document.activeElement.closest('.mk-item') : null);
    var next = items[(at + step + items.length) % items.length];
    if (next) (next.querySelector('input') || next).focus();
  }

  function place(t, snap) {
    addMarker(clampTime(t), snap);
    afterChange();
  }

  /* ── Pointer handling ──────────────────────────────────────────────── */

  function onContextMenu(event) {
    if (!ctx || event.target !== el('mc')) return;
    // Keeps the browser's menu, and VS Code's webview menu, off the plot.
    event.preventDefault();
    var p = canvasPoint(event);
    if (insidePlot(p)) openMenu(event, p);
  }

  /* Capture phase on #cc runs before both renderers' mousedown on #mc, so
     grabbing a marker never starts a pan. Anything else passes through. */
  function onMouseDown(event) {
    if (!ctx || event.button !== 0 || event.ctrlKey || event.target !== el('mc') || !markers.length) return;
    var p = canvasPoint(event), marker = insidePlot(p) ? markerNear(p.x, HIT_PX) : null;
    if (!marker) return;
    event.stopPropagation(); event.preventDefault();
    drag = { id: marker.id, from: marker.t, fromSnap: marker.snap, snap: null };
    el('cc').classList.add('mk-drag');
    redraw();
  }

  function onWindowMove(event) {
    if (!drag || !ctx) return;
    var p = canvasPoint(event), bypass = event.shiftKey || event.altKey;
    var snap = bypass ? null : snapFor(p.x, p.y);
    drag.snap = snap;
    moveMarker(drag.id, clampTime(snap ? snap.t : ctx.x2t(p.x)), snap ? snap.text : '');
    afterChange();
  }

  function onWindowUp() {
    if (!drag) return;
    drag = null;
    var cc = el('cc'); if (cc) cc.classList.remove('mk-drag');
    afterChange();
  }

  function onHoverMove(event) {
    if (!ctx || drag) return;
    var p = canvasPoint(event), inside = insidePlot(p);
    hover = inside ? { x: p.x, y: p.y } : null;
    var near = inside && markers.length ? markerNear(p.x, HIT_PX) : null, id = near ? near.id : 0;
    if (id !== hoverMarkerId) { hoverMarkerId = id; redraw(); }
    el('cc').classList.toggle('mk-hover', !!near);
  }

  function onHoverLeave() {
    if (drag) return;
    hover = null; hoverMarkerId = 0;
    var cc = el('cc'); if (cc) cc.classList.remove('mk-hover');
    redraw();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && (menu || drag)) {
      event.preventDefault(); event.stopPropagation();
      if (menu) { closeMenu(); return; }
      moveMarker(drag.id, drag.from, drag.fromSnap);
      onWindowUp();
      return;
    }
    if (menu && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault(); moveMenuFocus(event.key === 'ArrowDown' ? 1 : -1);
    }
  }

  function wire() {
    var cc = el('cc');
    if (!cc || !el('mc')) return;
    wired = true;
    cc.addEventListener('mousedown', onMouseDown, true);
    cc.addEventListener('contextmenu', onContextMenu);
    cc.addEventListener('mousemove', onHoverMove);
    cc.addEventListener('mouseleave', onHoverLeave);
    window.addEventListener('mousemove', onWindowMove);
    window.addEventListener('mouseup', onWindowUp);
    window.addEventListener('blur', onWindowUp);
    document.addEventListener('keydown', onKeyDown, true);
    buildTable();
    var p = prefs();
    if (p && p.KEYS.markerSnap) snapEnabled = p.getBool(p.KEYS.markerSnap, true);
    if (p && p.KEYS.markerTable) tableOpen = p.getBool(p.KEYS.markerTable, true);
    if (typeof window !== 'undefined') {
      var dev = window.SeqEyesDev = window.SeqEyesDev || {};
      dev.markers = function () {
        var detail = liveDetail(), blocks = ctx ? ctx.blocks() : [];
        return markers.map(function (m) { return { id: m.id, t: m.t, snap: m.snap, readout: readoutAt(blocks, m.t, detail) }; });
      };
      dev.addMarker = function (t, snap) { var m = addMarker(clampTime(t), snap); afterChange(); return m.id; };
      dev.snapAt = function (t) { return ctx ? snapFor(ctx.t2x(t), null) : null; };
      dev.markerTable = function () { return ctx ? toTsv(tableRows(markers, ctx.blocks(), liveDetail(), units()), units()) : ''; };
      dev.markerState = function () {
        return { suggestion: currentSuggestion(), menuOpen: !!menu, dragging: !!drag, snapEnabled: snapEnabled, tableOpen: tableOpen };
      };
    }
  }

  /**
   * Hand the module a renderer's state. ctx: blocks(), duration(), margins(),
   * t2x, x2t, visChannels, cH, cy, channelRange, timeConv, timeUnitStr,
   * gradConv, gradUnitStr, requestOverlay. A later install replaces an
   * earlier one; the DOM is wired once.
   */
  function install(context) {
    ctx = context;
    snapCache = null; tableKey = '';
    if (!wired && typeof document !== 'undefined') wire();
    syncTable();
  }

  /** A new sequence: its markers would point at nothing. */
  function reset() {
    clearMarkers();
    drag = null; hover = null; hoverMarkerId = 0; snapCache = null;
    closeMenu();
    var cc = typeof document !== 'undefined' ? el('cc') : null;
    if (cc) cc.classList.remove('mk-drag', 'mk-hover');
    syncTable();
  }

  return {
    install: install,
    reset: reset,
    drawOverlay: drawOverlay,
    // List operations, also used by tests and dev hooks.
    add: function (t, snap) { var m = addMarker(t, snap); if (ctx) afterChange(); return m; },
    remove: function (id) { removeMarker(id); if (ctx) afterChange(); },
    clear: function () { clearMarkers(); if (ctx) afterChange(); },
    move: moveMarker,
    list: listMarkers,
    // Pure core, exported for the unit tests.
    core: {
      blockIndexAt: blockIndexAt,
      sampleAt: sampleAt,
      trapezoidCorners: trapezoidCorners,
      gradientCorners: gradientCorners,
      interiorCorners: interiorCorners,
      snapCandidates: snapCandidates,
      chooseSnap: chooseSnap,
      snapAt: snapAt,
      readoutAt: readoutAt,
      tableRows: tableRows,
      toTsv: toTsv,
      formatTime: formatTime,
      formatGradient: formatGradient
    }
  };
})();
