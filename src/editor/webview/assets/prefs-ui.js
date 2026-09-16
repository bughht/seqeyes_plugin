/* ═══════════════════════════════════════════════════════════════════════
   Settings popover — the consent surface for SeqEyesPrefs

   One ⚙ chip in the toolbar overflow, opening a small dialog that says what
   the viewer keeps, lets the user turn that off, and throws away what is
   already stored.  Persistence is useless to someone who cannot see it or
   revoke it, and the ASC cache in particular puts the contents of a scanner
   hardware file into browser storage — that deserves a visible switch rather
   than a line in the README.

   It borrows the `.lblc` popover styles from the label marker controls
   instead of growing a second popup look.
   ═══════════════════════════════════════════════════════════════════════ */

var SeqEyesPrefsUi = (function () {
  var popover = null, anchor = null, rememberBox = null, summaryEl = null;

  function element(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }

  function inVsCode() { return typeof vscApi !== 'undefined' && !!vscApi; }

  function whereText() {
    return inVsCode()
      ? 'this copy of VS Code'
      : 'this browser';
  }

  /* Plain counts rather than a key dump: enough to tell whether "Forget" will
     do anything, without turning the dialog into a storage inspector. */
  function summarise() {
    if (!SeqEyesPrefs.enabled()) return 'Nothing is being stored.';
    var stored = SeqEyesPrefs.storedKeys();
    if (!stored.length) return 'Nothing stored yet.';
    var asc = SeqEyesPrefs.getAsc();
    var line = stored.length + ' setting' + (stored.length === 1 ? '' : 's') + ' stored';
    return asc ? line + ', including the ASC profile ' + asc.name + '.' : line + '.';
  }

  function refresh() {
    if (rememberBox) rememberBox.checked = SeqEyesPrefs.enabled();
    if (summaryEl) summaryEl.textContent = summarise();
  }

  function render() {
    popover.textContent = '';

    var head = element('div', 'lblc-head');
    head.appendChild(element('span', null, 'SeqEyes settings'));
    var close = element('button', 'lblc-close', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.onclick = function () { closeControls(true); };
    head.appendChild(close);

    var list = element('div', 'lblc-list');

    var row = element('div', 'lblc-row');
    rememberBox = document.createElement('input');
    rememberBox.type = 'checkbox';
    rememberBox.id = 'prefsRemember';
    rememberBox.checked = SeqEyesPrefs.enabled();
    var label = element('label', 'prefs-label', 'Remember my settings on ' + whereText());
    label.setAttribute('for', 'prefsRemember');
    rememberBox.onchange = function () {
      SeqEyesPrefs.setEnabled(this.checked);
      refresh();
    };
    row.appendChild(rememberBox);
    row.appendChild(label);
    list.appendChild(row);

    var note = element('div', 'prefs-note');
    note.appendChild(element('div', null,
      'Theme, time and gradient units, the Blocks toggle, k-space and '
      + 'spectrogram options, and panel sizes are kept between sessions.'));
    note.appendChild(element('div', null, inVsCode()
      /* Different sentences because the two hosts really do keep different
         things: a path the extension re-reads, versus the file's text. */
      ? 'A loaded ASC profile is remembered by its file path and re-read when '
        + 'you open a sequence. If the file moves, it is quietly forgotten.'
      : 'A loaded ASC profile is stored as text in this browser so it can be '
        + 'restored without picking the file again.'));
    list.appendChild(note);

    summaryEl = element('div', 'prefs-note prefs-summary', summarise());
    list.appendChild(summaryEl);

    var foot = element('div', 'lblc-foot');
    var forget = element('button', null, 'Forget stored settings');
    forget.type = 'button';
    forget.title = 'Delete everything SeqEyes has stored. The current view is left as it is.';
    forget.onclick = function () {
      SeqEyesPrefs.forget();
      refresh();
    };
    foot.appendChild(forget);

    popover.appendChild(head);
    popover.appendChild(list);
    popover.appendChild(foot);
  }

  /* Same placement rules as the label popover: below the chip when it fits,
     flipped above when it does not, and a bottom sheet on narrow screens. */
  function positionPopover() {
    if (!popover) return;
    var compact = !!(window.matchMedia && window.matchMedia('(max-width: 768px), (pointer: coarse)').matches);
    popover.classList.toggle('sheet', compact);
    if (compact) { popover.style.left = ''; popover.style.top = ''; return; }
    var rect = anchor && anchor.isConnected ? anchor.getBoundingClientRect() : { left: 8, top: 8, bottom: 8 };
    var width = popover.offsetWidth, height = popover.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
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
    if (target && target.closest && target.closest('#prefsBtn')) return;
    closeControls(false);
  }

  function openControls(chip) {
    closeControls(false);
    popover = element('div', 'lblc prefs-pop');
    popover.id = 'prefsControls';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', 'SeqEyes settings');
    anchor = chip;
    render();
    document.body.appendChild(popover);
    if (anchor) anchor.setAttribute('aria-expanded', 'true');
    positionPopover();
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', positionPopover);
    if (rememberBox) rememberBox.focus();
  }

  function closeControls(restoreFocus) {
    if (!popover) return;
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('resize', positionPopover);
    if (popover.parentNode) popover.parentNode.removeChild(popover);
    var chip = anchor;
    popover = null; anchor = null; rememberBox = null; summaryEl = null;
    if (chip) {
      chip.setAttribute('aria-expanded', 'false');
      if (restoreFocus && chip.isConnected) chip.focus();
    }
  }

  /* Idempotent, because web/index.html installs its own handlers over the
     bundle's and may call this again. */
  var wired = false;
  function install() {
    if (wired) return;
    var chip = document.getElementById('prefsBtn');
    if (!chip) return;
    wired = true;
    chip.onclick = function () { if (popover) closeControls(false); else openControls(chip); };
  }

  return {
    install: install,
    open: openControls,
    close: closeControls,
    isOpen: function () { return !!popover; }
  };
})();
