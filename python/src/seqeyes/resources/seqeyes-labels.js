/* ═══════════════════════════════════════════════════════════════════════
   MDH label row — markers at each ADC centre, and their style controls
   ═══════════════════════════════════════════════════════════════════════
   Shared by all three renderers: the VS Code webview, web/index.html (which
   the MATLAB toolbox also loads) and the Python viewer.html.  Each declares
   its own canvas state, so nothing here reads renderer globals — callers pass
   the 2-D context, the time→x mapping and the row geometry.  The Python
   viewer loads this file on its own, without the rest of the bundle.

   The DOM and localStorage are only touched inside functions, so the tests
   can run the shipped file in a bare VM context.

   A "labels" argument is anything with `names` and `kinds`: the popup and the
   styles need nothing more, so ⚙ works before the per-ADC values arrive. */
var SeqEyesLabels = (function () {
  var STORAGE_KEY = 'seqeyes.labelStyles.v1';
  // Tableau 10: distinct hues that stay readable on light and dark themes.
  var PALETTE = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];
  var SHAPES = ['circle', 'square', 'triangle', 'triangleDown', 'diamond', 'cross', 'plus'];
  var SHAPE_NAMES = {
    circle: '● Circle', square: '■ Square', triangle: '▲ Triangle', triangleDown: '▼ Triangle down',
    diamond: '◆ Diamond', cross: '✕ Cross', plus: '＋ Plus'
  };

  var overrides = null;
  var popover = null, popoverAnchor = null, popoverLabels = null, popoverChange = null, popoverRows = [];

  /* ── Table ─────────────────────────────────────────────────────────── */

  /* Same contract as asTypedView in block-transport.js, repeated because the
     Python viewer loads this file without the bundle. */
  function typedView(buffer, Ctor) {
    if (buffer instanceof Ctor) return buffer;
    if (buffer instanceof ArrayBuffer) return new Ctor(buffer);
    if (buffer && buffer.buffer instanceof ArrayBuffer && typeof buffer.byteLength === 'number')
      return new Ctor(buffer.buffer, buffer.byteOffset || 0, Math.floor(buffer.byteLength / Ctor.BYTES_PER_ELEMENT));
    return null;
  }

  function makeTable(names, kinds, count, timeSec, block, values, min, max) {
    var width = names.length, table = {
      names: Array.prototype.slice.call(names), kinds: [], count: count,
      timeSec: timeSec, block: block, values: values, min: [], max: []
    };
    for (var i = 0; i < width; i++) {
      table.kinds.push(kinds && kinds[i] === 'flag' ? 'flag' : 'counter');
      table.min.push(min && isFinite(min[i]) ? min[i] : 0);
      table.max.push(max && isFinite(max[i]) ? max[i] : 0);
    }
    return table;
  }

  /* Rebuild the table the extension host serialized (labelTransport.ts). */
  function fromPayload(payload) {
    if (!payload || !payload.names) throw new Error('the label table did not arrive from the extension host');
    var count = payload.count | 0, width = payload.names.length;
    var time = typedView(payload.timeSec, Float64Array), block = typedView(payload.block, Uint32Array),
        values = typedView(payload.values, Int32Array);
    if (!time || !block || !values) throw new Error('the label values did not arrive as binary data');
    if (time.length < count || block.length < count || values.length < count * width)
      throw new Error('the label values arrived truncated');
    return makeTable(payload.names, payload.kinds, count, time.subarray(0, count), block.subarray(0, count),
      values.subarray(0, count * width), payload.min, payload.max);
  }

  /* Wrap a table evaluated in the page by Pulseq.evaluateAdcLabels. */
  function fromTable(table) {
    return makeTable(table.names, table.kinds, table.count, table.timeSec, table.block, table.values, table.min, table.max);
  }

  /* ── Styles ────────────────────────────────────────────────────────── */

  function readOverrides() {
    if (overrides) return overrides;
    overrides = {};
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (saved && typeof saved === 'object') overrides = saved;
    } catch (_) {}
    return overrides;
  }

  function writeOverrides() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides)); } catch (_) {}
  }

  /* Defaults follow the label's position in its sequence, so one sequence's
     labels get distinct colours.  A user's choice is saved per name and
     follows that label into every sequence. */
  function styleFor(labels, index) {
    var saved = readOverrides()[labels.names[index]] || {};
    return {
      shape: SHAPES.indexOf(saved.shape) >= 0 ? saved.shape : SHAPES[index % SHAPES.length],
      color: /^#[0-9a-f]{6}$/i.test(saved.color || '') ? saved.color : PALETTE[index % PALETTE.length],
      visible: saved.visible !== false
    };
  }

  function setStyle(name, patch) {
    var all = readOverrides(), current = all[name] || {};
    for (var key in patch) if (Object.prototype.hasOwnProperty.call(patch, key)) current[key] = patch[key];
    all[name] = current;
    writeOverrides();
  }

  function resetStyles(names) {
    var all = readOverrides();
    for (var i = 0; i < names.length; i++) delete all[names[i]];
    writeOverrides();
  }

  /* ── Drawing ───────────────────────────────────────────────────────── */

  function lowerBound(values, target, count) {
    var lo = 0, hi = count;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (values[mid] < target) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function upperBound(values, target, count) {
    var lo = 0, hi = count;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (values[mid] <= target) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function addMarker(ctx, shape, x, y, r) {
    if (shape === 'circle') { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 6.283185); }
    else if (shape === 'square') { var h = r * .85; ctx.rect(x - h, y - h, 2 * h, 2 * h); }
    else if (shape === 'triangle') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r * .8); ctx.lineTo(x - r, y + r * .8); ctx.closePath(); }
    else if (shape === 'triangleDown') { ctx.moveTo(x, y + r); ctx.lineTo(x + r, y - r * .8); ctx.lineTo(x - r, y - r * .8); ctx.closePath(); }
    else if (shape === 'diamond') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
    else if (shape === 'cross') { ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); }
    else { ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); }
  }

  function paint(ctx, style) {
    if (style.shape === 'cross' || style.shape === 'plus') {
      ctx.strokeStyle = style.color; ctx.lineWidth = 1.5; ctx.stroke();
    } else {
      ctx.fillStyle = style.color; ctx.fill();
    }
  }

  /* Each counter spans its own min–max, so SLC 0–3 stays readable beside
     LIN 0–255.  Flags are pinned to 0/1; a constant label sits mid-row. */
  function valueScale(labels, index, top, span) {
    var flag = labels.kinds[index] === 'flag';
    var lo = flag ? 0 : labels.min[index], hi = flag ? 1 : labels.max[index];
    return { lo: lo, k: hi > lo ? span / (hi - lo) : 0, bottom: top + span, mid: top + span / 2 };
  }

  function yFor(scale, value) { return scale.k ? scale.bottom - (value - scale.lo) * scale.k : scale.mid; }

  /* Keep one pixel column's lowest and highest value per label. */
  function addColumnExtremes(ctx, table, label, first, last, left, plotW, scale, shape, r, t2x) {
    var width = table.names.length, columns = Math.max(1, Math.floor(plotW)), column = -1, lo = 0, hi = 0, drawn = 0;
    for (var adc = first; adc <= last; adc++) {
      var c = -2, v = 0;
      if (adc < last) {
        c = Math.floor(t2x(table.timeSec[adc]) - left);
        c = c < 0 ? 0 : (c >= columns ? columns - 1 : c);
        v = table.values[adc * width + label];
        if (c === column) { if (v < lo) lo = v; if (v > hi) hi = v; continue; }
      }
      if (column >= 0) {
        addMarker(ctx, shape, left + column + .5, yFor(scale, lo), r); drawn++;
        if (hi !== lo) { addMarker(ctx, shape, left + column + .5, yFor(scale, hi), r); drawn++; }
      }
      column = c; lo = v; hi = v;
    }
    return drawn;
  }

  /* A compact key in the row's top-left corner, so the markers read without
     opening the controls. */
  function drawKey(ctx, labels, geom) {
    var x = geom.left + 5, y = geom.top + 8, limit = geom.right - 8, items = [], widths = [], total = 6;
    ctx.save();
    ctx.font = '9px monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    for (var i = 0; i < labels.names.length; i++) {
      var style = styleFor(labels, i);
      if (!style.visible) continue;
      var w = 10 + ctx.measureText(labels.names[i]).width + 8;
      if (x + total + w > limit) break;
      items.push({ index: i, style: style }); widths.push(w); total += w;
    }
    if (items.length) {
      ctx.globalAlpha = .78; ctx.fillStyle = geom.background || 'rgba(128,128,128,.15)';
      ctx.fillRect(x, y - 6, total, 12);
      ctx.globalAlpha = 1;
      var cursor = x + 6;
      for (var j = 0; j < items.length; j++) {
        ctx.beginPath(); addMarker(ctx, items[j].style.shape, cursor + 3, y, 3); paint(ctx, items[j].style);
        ctx.fillStyle = geom.foreground || items[j].style.color;
        ctx.fillText(labels.names[items[j].index], cursor + 10, y + .5);
        cursor += widths[j];
      }
    }
    ctx.restore();
  }

  /* Draw the label row.  geom = {left, right, top, height, background,
     foreground} in CSS pixels; t2x maps seconds to x.  Every ADC gets a
     marker while they sit at least three pixels apart; beyond that each pixel
     column keeps only its lowest and highest value per label, so the cost is
     bounded by the plot width rather than the ADC count.  Returns the number
     of markers drawn. */
  function drawRow(ctx, table, geom, vs, ve, t2x) {
    if (!table || !table.count || !table.names.length) return 0;
    var first = lowerBound(table.timeSec, vs, table.count), last = upperBound(table.timeSec, ve, table.count);
    var width = table.names.length, plotW = Math.max(1, geom.right - geom.left), drawn = 0;
    if (last > first) {
      var pad = Math.max(5, Math.min(16, geom.height * .2)), top = geom.top + pad, span = Math.max(1, geom.height - 2 * pad);
      var r = Math.max(2.5, Math.min(4.5, geom.height * .05)), dense = last - first > plotW / 3;
      ctx.save();
      for (var label = 0; label < width; label++) {
        var style = styleFor(table, label);
        if (!style.visible) continue;
        var scale = valueScale(table, label, top, span);
        ctx.beginPath();
        if (dense) drawn += addColumnExtremes(ctx, table, label, first, last, geom.left, plotW, scale, style.shape, r, t2x);
        else {
          for (var adc = first; adc < last; adc++) {
            addMarker(ctx, style.shape, t2x(table.timeSec[adc]), yFor(scale, table.values[adc * width + label]), r);
            drawn++;
          }
        }
        paint(ctx, style);
      }
      ctx.restore();
    }
    if (geom.height >= 34) drawKey(ctx, table, geom);
    return drawn;
  }

  /* The label state at the ADC of `block` ({i, s, d}, as in the renderers'
     block lists), or null when that block has no ADC. */
  function tooltipLine(table, block) {
    if (!table || !table.count || !block) return null;
    var index = lowerBound(table.timeSec, block.s, table.count);
    if (index >= table.count || table.block[index] !== block.i || table.timeSec[index] > block.s + block.d) return null;
    var width = table.names.length, parts = [];
    for (var label = 0; label < width; label++) {
      if (styleFor(table, label).visible) parts.push(table.names[label] + '=' + table.values[index * width + label]);
    }
    return parts.length ? 'Labels: ' + parts.join('  ') : null;
  }

  /* ── Controls popup ────────────────────────────────────────────────── */

  function isCompactLayout() {
    return !!(window.matchMedia && window.matchMedia('(max-width: 768px), (pointer: coarse)').matches);
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function drawPreview(canvas, style) {
    var dpr = window.devicePixelRatio || 1, size = 16, context = canvas.getContext('2d');
    canvas.width = size * dpr; canvas.height = size * dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, size, size);
    context.beginPath(); addMarker(context, style.shape, size / 2, size / 2, 5); paint(context, style);
  }

  function controlRow(index) {
    var name = popoverLabels.names[index], row = element('div', 'lblc-row');
    var toggle = element('input'); toggle.type = 'checkbox'; toggle.setAttribute('aria-label', 'Show ' + name);
    var preview = element('canvas'); preview.setAttribute('aria-hidden', 'true');
    var title = element('span', 'lblc-name', name);
    if (popoverLabels.kinds[index] === 'flag') title.appendChild(element('span', 'lblc-kind', 'flag'));
    var shape = element('select'); shape.setAttribute('aria-label', name + ' marker shape');
    for (var s = 0; s < SHAPES.length; s++) {
      var option = element('option', null, SHAPE_NAMES[SHAPES[s]]); option.value = SHAPES[s]; shape.appendChild(option);
    }
    var custom = element('input'); custom.type = 'color'; custom.title = 'Custom colour';
    custom.setAttribute('aria-label', name + ' custom marker colour');
    var swatches = element('div', 'lblc-swatches'), swatchButtons = [];
    PALETTE.forEach(function (color) {
      var swatch = element('button', 'lblc-swatch'); swatch.type = 'button';
      swatch.style.background = color; swatch.title = color;
      swatch.setAttribute('aria-label', 'Use ' + color + ' for ' + name);
      swatch.onclick = function () { update({ color: color }); };
      swatches.appendChild(swatch); swatchButtons.push(swatch);
    });

    function refresh() {
      var style = styleFor(popoverLabels, index);
      row.classList.toggle('off', !style.visible);
      toggle.checked = style.visible; shape.value = style.shape;
      if (custom.value.toLowerCase() !== style.color.toLowerCase()) custom.value = style.color;
      for (var i = 0; i < swatchButtons.length; i++)
        swatchButtons[i].setAttribute('aria-pressed', PALETTE[i].toLowerCase() === style.color.toLowerCase() ? 'true' : 'false');
      drawPreview(preview, style);
    }
    function update(patch) { setStyle(name, patch); refresh(); if (popoverChange) popoverChange(); }

    toggle.onchange = function () { update({ visible: toggle.checked }); };
    shape.onchange = function () { update({ shape: shape.value }); };
    // Updating in place, never re-rendering, keeps a native picker open while it drags.
    custom.oninput = function () { update({ color: custom.value }); };

    row.appendChild(toggle); row.appendChild(preview); row.appendChild(title);
    row.appendChild(shape); row.appendChild(custom); row.appendChild(swatches);
    refresh();
    return { row: row, refresh: refresh };
  }

  function renderControls() {
    popover.textContent = ''; popoverRows = [];
    var head = element('div', 'lblc-head');
    head.appendChild(element('span', null, 'Label markers'));
    var close = element('button', 'lblc-close', '✕'); close.type = 'button'; close.setAttribute('aria-label', 'Close');
    close.onclick = function () { closeControls(true); };
    head.appendChild(close);
    var list = element('div', 'lblc-list');
    for (var i = 0; i < popoverLabels.names.length; i++) {
      var entry = controlRow(i); popoverRows.push(entry); list.appendChild(entry.row);
    }
    var foot = element('div', 'lblc-foot');
    function action(text, apply) {
      var button = element('button', null, text); button.type = 'button';
      button.onclick = function () {
        apply();
        for (var r = 0; r < popoverRows.length; r++) popoverRows[r].refresh();
        if (popoverChange) popoverChange();
      };
      foot.appendChild(button);
    }
    action('Show all', function () { popoverLabels.names.forEach(function (name) { setStyle(name, { visible: true }); }); });
    action('Hide all', function () { popoverLabels.names.forEach(function (name) { setStyle(name, { visible: false }); }); });
    action('Reset', function () { resetStyles(popoverLabels.names); });
    popover.appendChild(head); popover.appendChild(list); popover.appendChild(foot);
  }

  function positionPopover() {
    if (!popover) return;
    var compact = isCompactLayout();
    popover.classList.toggle('sheet', compact);
    if (compact) { popover.style.left = ''; popover.style.top = ''; return; }
    var rect = popoverAnchor && popoverAnchor.isConnected ? popoverAnchor.getBoundingClientRect() : { left: 8, top: 8, bottom: 8 };
    var width = popover.offsetWidth, height = popover.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    var top = rect.bottom + 4;
    if (top + height > vh - 8) top = Math.max(8, rect.top - height - 4);
    if (top + height > vh - 8) top = Math.max(8, vh - height - 8);
    popover.style.left = Math.max(8, Math.min(rect.left, vw - width - 8)) + 'px';
    popover.style.top = top + 'px';
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    closeControls(true);
  }

  function onPointerDown(event) {
    var target = event.target;
    if (popover.contains(target)) return;
    // The chip toggles on its own click; closing here first would reopen it.
    if (target && target.closest && target.closest('.lbl-gear')) return;
    closeControls(false);
  }

  function openControls(anchor, labels, onChange) {
    closeControls(false);
    if (!labels || !labels.names || !labels.names.length) return;
    popover = element('div', 'lblc'); popover.id = 'labelControls';
    popover.setAttribute('role', 'dialog'); popover.setAttribute('aria-label', 'Label markers');
    popoverAnchor = anchor; popoverLabels = labels; popoverChange = onChange;
    renderControls();
    document.body.appendChild(popover);
    if (anchor) anchor.setAttribute('aria-expanded', 'true');
    positionPopover();
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', positionPopover);
    var first = popover.querySelector('.lblc-row input');
    if (first) first.focus();
  }

  function closeControls(restoreFocus) {
    if (!popover) return;
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('resize', positionPopover);
    if (popover.parentNode) popover.parentNode.removeChild(popover);
    var anchor = popoverAnchor;
    popover = null; popoverAnchor = null; popoverLabels = null; popoverChange = null; popoverRows = [];
    if (anchor) {
      anchor.setAttribute('aria-expanded', 'false');
      if (restoreFocus && anchor.isConnected) anchor.focus();
    }
  }

  /* The ⚙ chip that follows the Label chip.  Legends are rebuilt wholesale,
     so a fresh chip takes over as the anchor of a popup that is still open. */
  function createGearChip(labels, onChange) {
    var chip = element('div', 'li lbl-gear', '⚙');
    chip.title = 'Label marker shapes, colours and visibility';
    chip.tabIndex = 0;
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-haspopup', 'dialog');
    chip.setAttribute('aria-expanded', popover ? 'true' : 'false');
    if (popover) { popoverAnchor = chip; popoverLabels = labels; popoverChange = onChange; }
    function toggle() { if (popover) closeControls(false); else openControls(chip, labels, onChange); }
    chip.onclick = toggle;
    chip.onkeydown = function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
    };
    return chip;
  }

  return {
    PALETTE: PALETTE,
    SHAPES: SHAPES,
    fromPayload: fromPayload,
    fromTable: fromTable,
    styleFor: styleFor,
    setStyle: setStyle,
    resetStyles: resetStyles,
    drawRow: drawRow,
    tooltipLine: tooltipLine,
    createGearChip: createGearChip,
    openControls: openControls,
    closeControls: closeControls,
    isOpen: function () { return !!popover; }
  };
})();
