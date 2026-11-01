/* ═══════════════════════════════════════════════════════════════════════
   Channel row order
   ═══════════════════════════════════════════════════════════════════════

   The waveform rows can be reordered, as SeqEyes Qt's subplots can: drag a
   channel's name in the left gutter, or right-click it for Top / Up / Down /
   Bottom and Reset order. A drop on the middle of a row swaps with it; near
   its top or bottom edge it inserts above or below. Moves count only the
   rows on screen, so a hidden channel keeps its slot for when it returns.

   A channel index stays the channel's identity everywhere (chColors[ci],
   ampZoom[ci], the derived series); only the renderer's CH_ORDER, the
   display order, changes. Both renderers install this module with accessors
   to their own state, the last install winning, as they do markers.js. The
   order is kept by name under seqeyes.channelOrder, behind the settings
   consent switch.

   The core takes everything it reads as arguments, so it runs in node:vm
   for the unit tests; only install() touches the DOM. */

var SeqEyesChannelOrder = (function () {
  /* Movement in CSS pixels before a press on a name becomes a drag (Qt's
     Manhattan threshold), and the long-press that opens the menu by touch. */
  var DRAG_START_PX = 4;
  var LONG_PRESS_MS = 500;
  var TOUCH_SLOP_PX = 8;
  var MOVES = [['top', 'Top'], ['up', 'Up'], ['down', 'Down'], ['bottom', 'Bottom']];

  /* ── Core ──────────────────────────────────────────────────────────── */

  function sameOrder(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /**
   * Channel indices for a stored list of channel names. Unknown names and
   * repeats are dropped, and a channel the list lacks (one added in a later
   * version) goes back in at its default position, so an old order can never
   * lose a row.
   */
  function normalize(stored, names, defaults) {
    var out = [], seen = {}, i;
    for (i = 0; stored && i < stored.length; i++) {
      var ci = names.indexOf(stored[i]);
      if (ci >= 0 && defaults.indexOf(ci) >= 0 && !seen[ci]) { seen[ci] = true; out.push(ci); }
    }
    for (i = 0; i < defaults.length; i++) {
      if (seen[defaults[i]]) continue;
      seen[defaults[i]] = true;
      out.splice(Math.min(i, out.length), 0, defaults[i]);
    }
    return out;
  }

  /** Which moves would change what is on screen, for the menu. */
  function movesFor(visible, ci) {
    var vi = visible.indexOf(ci), up = vi > 0, down = vi >= 0 && vi < visible.length - 1;
    return { top: up, up: up, down: down, bottom: down };
  }

  /**
   * Qt's moveVisibleAxis. Top and Bottom go to the ends of the whole order;
   * Up and Down step over the neighbouring row on screen rather than the next
   * entry, which may be hidden. Null when nothing would change.
   */
  function move(order, visible, ci, where) {
    var vi = visible.indexOf(ci);
    if (vi < 0) return null;
    var next = order.filter(function (c) { return c !== ci; });
    if (where === 'top') next.unshift(ci);
    else if (where === 'bottom') next.push(ci);
    else if (where === 'up' && vi > 0) next.splice(next.indexOf(visible[vi - 1]), 0, ci);
    else if (where === 'down' && vi < visible.length - 1) next.splice(next.indexOf(visible[vi + 1]) + 1, 0, ci);
    else return null;
    return sameOrder(next, order) ? null : next;
  }

  /**
   * Where the shown row `source` lands with the pointer at `y`, given `count`
   * rows of height `rowH` from `top`: {mode: 'swap' | 'insert', index}, the
   * index counted in rows shown (an insert index of `count` means after the
   * last). Each row's top and bottom bands insert above and below it and its
   * middle swaps, the bands a quarter of the row clamped to 8–40 px as in Qt.
   * Null for a drop that would change nothing.
   */
  function dropTarget(count, source, y, top, rowH) {
    if (!(count > 0) || !(rowH > 0) || source < 0 || source >= count || !isFinite(y)) return null;
    var target;
    if (y < top) target = { mode: 'insert', index: 0 };
    else if (y >= top + count * rowH) target = { mode: 'insert', index: count };
    else {
      var i = Math.min(count - 1, Math.floor((y - top) / rowH));
      var within = y - top - i * rowH, edge = Math.max(8, Math.min(40, rowH / 4));
      if (within < edge) target = { mode: 'insert', index: i };
      else if (within > rowH - edge) target = { mode: 'insert', index: i + 1 };
      else target = { mode: 'swap', index: i };
    }
    if (target.mode === 'swap' ? target.index === source : (target.index === source || target.index === source + 1)) return null;
    return target;
  }

  /** The order after dropping channel `ci` on a dropTarget() result. */
  function applyDrop(order, visible, ci, target) {
    if (!target || visible.indexOf(ci) < 0) return null;
    var next = order.slice();
    if (target.mode === 'swap') {
      var other = visible[target.index], a = next.indexOf(ci), b = next.indexOf(other);
      if (other === undefined || a < 0 || b < 0) return null;
      next[a] = other; next[b] = ci;
    } else {
      next.splice(next.indexOf(ci), 1);
      if (target.index < visible.length) next.splice(next.indexOf(visible[target.index]), 0, ci);
      else next.splice(next.indexOf(visible[visible.length - 1]) + 1, 0, ci);
    }
    return sameOrder(next, order) ? null : next;
  }

  /**
   * Hover-readout lines, given as [channel, text], in row order. A line that
   * speaks for several rows (M1) passes their indices and sits with the
   * highest of them; a line for no row in the order goes last. Stable.
   */
  function sortRows(rows, order) {
    function rank(ci) {
      var list = Array.isArray(ci) ? ci : [ci], best = Infinity;
      for (var i = 0; i < list.length; i++) {
        var at = order.indexOf(list[i]);
        if (at >= 0 && at < best) best = at;
      }
      return best;
    }
    return rows
      .map(function (row, i) { return { rank: rank(row[0]), i: i, text: row[1] }; })
      .sort(function (a, b) { return (a.rank === b.rank ? 0 : a.rank - b.rank) || a.i - b.i; })
      .map(function (row) { return row.text; });
  }

  /* ── Persistence ───────────────────────────────────────────────────── */

  function prefs() {
    var p = typeof SeqEyesPrefs !== 'undefined' ? SeqEyesPrefs : null;
    return p && p.KEYS.channelOrder ? p : null;
  }

  /** The remembered order, validated against this version's channels. */
  function restore(names, defaults) {
    var p = prefs(), raw = p ? p.get(p.KEYS.channelOrder) : null, stored = null;
    try { stored = raw ? JSON.parse(raw) : null; } catch (e) { stored = null; }
    return normalize(Array.isArray(stored) ? stored : [], names, defaults);
  }

  /* The default order is kept as no key at all, so Reset leaves nothing
     behind and a future default still reaches anyone who never reordered. */
  function save(order, names, defaults) {
    var p = prefs();
    if (!p) return;
    if (sameOrder(order, defaults)) p.remove(p.KEYS.channelOrder);
    else p.set(p.KEYS.channelOrder, JSON.stringify(order.map(function (ci) { return names[ci]; })));
  }

  /* ── Interaction (DOM) ─────────────────────────────────────────────── */

  var ctx = null;
  var wired = false;
  /** {ci, vi, x0, y0, dragging, target} for a mouse press on a row's name. */
  var press = null;
  /** {x0, y0, timer, fired} for a finger that may become a long-press. */
  var touchPress = null;
  var menu = null;
  var feedback = null;

  function el(id) { return document.getElementById(id); }

  function canvasPoint(event) {
    var rect = el('mc').getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width };
  }

  /** The shown row whose name is under `p` in the left gutter, or -1. */
  function gutterRow(p) {
    var M = ctx.margins(), rows = ctx.visChannels(), vi = Math.floor((p.y - M.t) / ctx.cH());
    return p.x >= 0 && p.x < M.l && p.y >= M.t && vi >= 0 && vi < rows.length ? vi : -1;
  }

  function apply(next) {
    if (!next || !ctx) return;
    ctx.setOrder(next);
    save(next, ctx.names, ctx.defaults);
  }

  /* Drag feedback is DOM laid over the canvas rather than paint on it, so it
     needs no hook in either renderer's draw. */
  function buildFeedback(cc) {
    function layer(id, className) {
      var node = document.createElement('div');
      node.id = id; node.className = className; node.hidden = true;
      node.setAttribute('aria-hidden', 'true');
      cc.appendChild(node);
      return node;
    }
    feedback = {
      source: layer('coSource', 'co-box'), target: layer('coTarget', 'co-box'),
      line: layer('coLine', 'co-line'), ghost: layer('coGhost', 'co-ghost')
    };
  }

  function placeRow(node, vi, inset, width) {
    var M = ctx.margins(), ch = ctx.cH();
    node.style.left = inset + 'px';
    node.style.width = Math.max(0, width - M.r - 2 * inset) + 'px';
    node.style.top = (M.t + vi * ch + inset) + 'px';
    node.style.height = Math.max(0, ch - 2 * inset) + 'px';
    node.hidden = false;
  }

  function hideFeedback() {
    if (!feedback) return;
    for (var key in feedback) feedback[key].hidden = true;
  }

  function updateDrag(p) {
    var M = ctx.margins(), rows = ctx.visChannels(), ch = ctx.cH(), f = feedback;
    var target = dropTarget(rows.length, press.vi, p.y, M.t, ch), name = ctx.names[press.ci], hint = name;
    press.target = target;
    f.target.hidden = true; f.line.hidden = true;
    if (target && target.mode === 'swap') {
      placeRow(f.target, target.index, 3, p.width);
      hint = 'Swap ' + name + ' ↔ ' + ctx.names[rows[target.index]];
    } else if (target) {
      var y = M.t + target.index * ch;
      if (target.index === 0) y += 2; else if (target.index === rows.length) y -= 2;
      f.line.style.left = '4px';
      f.line.style.width = Math.max(0, p.width - M.r - 8) + 'px';
      f.line.style.top = y + 'px';
      f.line.hidden = false;
      hint = 'Insert ' + name + ' here';
    }
    f.ghost.textContent = hint;
    f.ghost.hidden = false;
    f.ghost.style.left = Math.max(0, Math.min(p.x + 16, p.width - f.ghost.offsetWidth - 4)) + 'px';
    f.ghost.style.top = p.y + 'px';
  }

  function endDrag(commit) {
    if (!press) return;
    var ended = press;
    press = null;
    hideFeedback();
    var cc = el('cc'); if (cc) cc.classList.remove('co-drag');
    if (commit && ended.dragging) apply(applyDrop(ctx.getOrder(), ctx.visChannels(), ended.ci, ended.target));
  }

  /* Capture phase on #cc runs before both renderers' mousedown on #mc, so a
     press on a name never starts a pan. Presses elsewhere pass through. */
  function onMouseDown(event) {
    if (!ctx || event.button !== 0 || event.ctrlKey || event.target !== el('mc')) return;
    var vi = gutterRow(canvasPoint(event));
    if (vi < 0) return;
    event.stopPropagation(); event.preventDefault();
    closeMenu();
    press = { ci: ctx.visChannels()[vi], vi: vi, x0: event.clientX, y0: event.clientY, dragging: false, target: null };
  }

  function onWindowMove(event) {
    if (!press || !ctx) return;
    if (!press.dragging) {
      if (Math.abs(event.clientX - press.x0) + Math.abs(event.clientY - press.y0) < DRAG_START_PX) return;
      press.dragging = true;
      var cc = el('cc');
      cc.classList.add('co-drag'); cc.classList.remove('co-grab');
      placeRow(feedback.source, press.vi, 1, canvasPoint(event).width);
    }
    event.preventDefault();
    updateDrag(canvasPoint(event));
  }

  function onWindowUp(event) {
    if (!press) return;
    if (press.dragging && event && isFinite(event.clientY)) updateDrag(canvasPoint(event));
    endDrag(true);
  }

  function onHoverMove(event) {
    if (!ctx || press) return;
    var over = event.target === el('mc') && gutterRow(canvasPoint(event)) >= 0;
    el('cc').classList.toggle('co-grab', over);
  }

  function onHoverLeave() {
    var cc = el('cc'); if (cc && !press) cc.classList.remove('co-grab');
  }

  /* ── Menu ──────────────────────────────────────────────────────────── */

  /* Built from the marker menu's classes so the two read as one control. */
  function menuItem(label, enabled, onSelect) {
    var item = document.createElement('button'), text = document.createElement('span');
    item.type = 'button'; item.className = 'mk-item'; item.setAttribute('role', 'menuitem');
    text.className = 'mk-item-label'; text.textContent = label;
    item.appendChild(text);
    item.disabled = !enabled;
    item.addEventListener('click', function () { closeMenu(); onSelect(); });
    return item;
  }

  function openMenu(clientX, clientY, ci) {
    closeMenu();
    var name = ctx.names[ci], can = movesFor(ctx.visChannels(), ci);
    menu = document.createElement('div');
    menu.className = 'lblc mk-menu co-menu'; menu.id = 'channelOrderMenu';
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Move the ' + name + ' row');
    var title = document.createElement('div');
    title.className = 'co-menu-title'; title.textContent = 'Move ' + name;
    menu.appendChild(title);
    MOVES.forEach(function (m) {
      menu.appendChild(menuItem(m[1], can[m[0]], function () { apply(move(ctx.getOrder(), ctx.visChannels(), ci, m[0])); }));
    });
    var sep = document.createElement('div'); sep.className = 'mk-sep';
    menu.appendChild(sep);
    menu.appendChild(menuItem('Reset order', !sameOrder(ctx.getOrder(), ctx.defaults), function () { apply(ctx.defaults.slice()); }));
    document.body.appendChild(menu);
    positionMenu(clientX, clientY);
    el('cc').classList.add('co-menu-open');
    document.addEventListener('pointerdown', onOutsidePointer, true);
    window.addEventListener('resize', closeMenu);
    var first = menu.querySelector('.mk-item:not(:disabled)');
    if (first) first.focus();
  }

  function positionMenu(clientX, clientY) {
    var compact = !!(window.matchMedia && window.matchMedia('(max-width: 768px), (pointer: coarse)').matches);
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
    menu = null;
    var cc = el('cc'); if (cc) cc.classList.remove('co-menu-open');
  }

  function onOutsidePointer(event) {
    if (menu && !menu.contains(event.target)) closeMenu();
  }

  function onContextMenu(event) {
    if (!ctx || event.target !== el('mc')) return;
    var vi = gutterRow(canvasPoint(event));
    if (vi < 0) return;
    event.preventDefault();
    openMenu(event.clientX, event.clientY, ctx.visChannels()[vi]);
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && (menu || press)) {
      event.preventDefault(); event.stopPropagation();
      if (menu) closeMenu(); else endDrag(false);
      return;
    }
    if (menu && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      var items = Array.prototype.slice.call(menu.querySelectorAll('.mk-item:not(:disabled)'));
      var at = items.indexOf(document.activeElement), step = event.key === 'ArrowDown' ? 1 : -1;
      var next = items[(at + step + items.length) % items.length];
      if (next) next.focus();
    }
  }

  /* ── Touch ──────────────────────────────────────────────────────────

     A finger held still on a name opens the menu, as a long-press in the plot
     opens the marker menu; its later moves and lift are swallowed so the view
     does not pan. A finger that moves first is the renderer's pan, as before.
     Touch has no drag reorder. */

  function endTouch() {
    if (touchPress && touchPress.timer) clearTimeout(touchPress.timer);
    touchPress = null;
  }

  function onTouchStart(event) {
    endTouch();
    if (!ctx || event.target !== el('mc') || event.touches.length !== 1) return;
    var finger = event.touches[0], vi = gutterRow(canvasPoint(finger));
    if (vi < 0) return;
    var x0 = finger.clientX, y0 = finger.clientY, ci = ctx.visChannels()[vi];
    touchPress = { x0: x0, y0: y0, fired: false, timer: setTimeout(function () {
      if (!touchPress) return;
      touchPress.fired = true; touchPress.timer = 0;
      var cc = el('cc'); if (cc) cc.classList.remove('pan');
      openMenu(x0, y0, ci);
    }, LONG_PRESS_MS) };
  }

  function onTouchMove(event) {
    if (!touchPress) return;
    if (touchPress.fired) { event.stopPropagation(); event.preventDefault(); return; }
    var finger = event.touches[0];
    if (event.touches.length !== 1 || Math.abs(finger.clientX - touchPress.x0) > TOUCH_SLOP_PX || Math.abs(finger.clientY - touchPress.y0) > TOUCH_SLOP_PX) endTouch();
  }

  function onTouchEnd(event) {
    if (!touchPress) return;
    if (touchPress.fired) {
      event.stopPropagation(); event.preventDefault();
      var cc = el('cc'); if (cc) cc.classList.remove('pan');
    }
    endTouch();
  }

  function names(list) { return list.map(function (ci) { return ctx.names[ci]; }); }

  function wire() {
    var cc = el('cc');
    if (!cc || !el('mc')) return;
    wired = true;
    buildFeedback(cc);
    cc.addEventListener('mousedown', onMouseDown, true);
    cc.addEventListener('contextmenu', onContextMenu);
    cc.addEventListener('mousemove', onHoverMove);
    cc.addEventListener('mouseleave', onHoverLeave);
    window.addEventListener('mousemove', onWindowMove);
    window.addEventListener('mouseup', onWindowUp);
    window.addEventListener('blur', function () { endDrag(false); });
    document.addEventListener('keydown', onKeyDown, true);
    cc.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
    cc.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    cc.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
    cc.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: false });
    var dev = window.SeqEyesDev = window.SeqEyesDev || {};
    dev.channelOrder = function () { return ctx ? names(ctx.getOrder()) : []; };
    dev.channelOrderState = function () {
      var target = press && press.target;
      return {
        visible: ctx ? names(ctx.visChannels()) : [],
        dragging: !!(press && press.dragging),
        menuOpen: !!menu,
        target: target ? { mode: target.mode, index: target.index } : null
      };
    };
  }

  /**
   * Hand the module a renderer's state. ctx: names (CH), defaults (the
   * default order), margins(), visChannels(), cH(), getOrder(), and
   * setOrder(order), which adopts the order and redraws. A later install
   * replaces an earlier one; the DOM is wired once.
   */
  function install(context) {
    ctx = context;
    if (!wired && typeof document !== 'undefined') wire();
  }

  return {
    install: install,
    restore: restore,
    sortRows: sortRows,
    // Pure core, exported for the unit tests.
    core: {
      normalize: normalize,
      movesFor: movesFor,
      move: move,
      dropTarget: dropTarget,
      applyDrop: applyDrop,
      sortRows: sortRows,
      sameOrder: sameOrder,
      save: save
    }
  };
})();
