/* ═══════════════════════════════════════════════════════════════════════
   Viewer preferences — one consent-gated gateway to localStorage

   Every host (VS Code webview, standalone web page, MATLAB) keeps its
   remembered settings under the `seqeyes.` prefix.  Before this module there
   were three near-identical copies of the get/set pair — kspace.js, panel.js
   and the inline script in web/index.html — and none of them asked whether
   the user wanted anything written down at all.

   Two rules shape the API:

     - Persistence is opt-out, not unconditional.  `seqeyes.rememberSettings`
       is the master switch.  With it off, `set()` keeps the value in memory
       so the control still behaves for the rest of the session and nothing
       reaches the disk; turning it off purges every key this module owns.

     - localStorage is only ever touched inside a function, so the file loads
       in a bare `node:vm` context for the unit tests the same way labels.js
       does.  Nothing here runs at load time.
   ═══════════════════════════════════════════════════════════════════════ */

var SeqEyesPrefs = (function () {
  var PREFIX = 'seqeyes.';

  /* Named so the standalone page's inline fork spells the keys the same way
     the bundle does; a typo there would look like "my settings reset again". */
  var KEYS = {
    remember: 'seqeyes.rememberSettings',
    theme: 'seqeyes.theme',
    timeUnit: 'seqeyes.timeUnit',
    gradUnit: 'seqeyes.gradUnit',
    showBlocks: 'seqeyes.showBlocks',
    panelWidth: 'seqeyes.panelWidth',
    panelHeight: 'seqeyes.panelHeight',
    noticesCollapsed: 'seqeyes.viewerNoticesCollapsed',
    kspaceUnit: 'seqeyes.kspace.unit',
    kspaceDotSize: 'seqeyes.kspace.dotSize',
    kspaceProjection: 'seqeyes.kspace.projection',
    ascName: 'seqeyes.asc.name',
    ascText: 'seqeyes.asc.text'
  };

  /* A profile bigger than this is not worth fighting the quota over: the
     whole origin gets about 5 MB, and a real Siemens gradient ASC is tens of
     kilobytes.  Anything this large means the picker found the wrong file. */
  var ASC_MAX_CHARS = 2 * 1024 * 1024;

  /* Values written while persistence is off, or refused by a full quota.
     Keeping them is what lets someone switch units, decide they do want the
     choice kept, and tick the box without redoing the work. */
  var session = {};

  function store() {
    try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { return null; }
  }
  function rawGet(key) {
    var s = store(); if (!s) return null;
    try { return s.getItem(key); } catch (e) { return null; }
  }
  function rawSet(key, value) {
    var s = store(); if (!s) return false;
    try { s.setItem(key, value); return true; } catch (e) { return false; }
  }
  function rawRemove(key) {
    var s = store(); if (!s) return;
    try { s.removeItem(key); } catch (e) { /* private mode */ }
  }

  /* Default on.  localStorage was already load-bearing here — theme, panel
     size and every spectrogram parameter — so defaulting off would quietly
     take away persistence people are already relying on. */
  function enabled() { return rawGet(KEYS.remember) !== '0'; }

  function get(key) {
    if (enabled()) {
      var stored = rawGet(key);
      if (stored !== null) return stored;
    }
    return Object.prototype.hasOwnProperty.call(session, key) ? session[key] : null;
  }

  /* Returns whether the value reached the disk, which setAsc uses to decide
     whether a restore will actually be possible next time.

     A successful write drops any session copy instead of mirroring it: the
     disk is then the single source of truth, so a key that later goes missing
     reads as missing rather than being answered from a stale shadow. */
  function set(key, value) {
    var text = String(value);
    if (enabled() && rawSet(key, text)) { delete session[key]; return true; }
    session[key] = text;
    return false;
  }

  function remove(key) {
    delete session[key];
    rawRemove(key);
  }

  function getNum(key, fallback) {
    var raw = get(key);
    var value = raw === null ? NaN : parseFloat(raw);
    return isFinite(value) ? value : fallback;
  }
  function getBool(key, fallback) {
    var raw = get(key);
    return raw === null ? !!fallback : raw === '1';
  }
  function setBool(key, value) { return set(key, value ? '1' : '0'); }

  /* The guard that keeps a stale or hand-edited key from putting the viewer
     into a state its own controls cannot express. */
  function getEnum(key, allowed, fallback) {
    var raw = get(key);
    return (raw !== null && allowed.indexOf(raw) >= 0) ? raw : fallback;
  }

  /* Every key this module owns, minus the master switch: a "no" has to
     survive the purge it triggers. */
  function storedKeys() {
    var s = store(); if (!s) return [];
    var found = [];
    try {
      for (var i = 0; i < s.length; i++) {
        var key = s.key(i);
        if (key && key.indexOf(PREFIX) === 0 && key !== KEYS.remember) found.push(key);
      }
    } catch (e) { return []; }
    return found;
  }

  function clearStored() {
    var doomed = storedKeys();
    for (var i = 0; i < doomed.length; i++) rawRemove(doomed[i]);
  }

  /* "Forget stored settings": wipe the disk and the in-memory shadow, so the
     next reload really does start from defaults. */
  function forget() {
    session = {};
    clearStored();
  }

  function setEnabled(on) {
    if (on) {
      rawSet(KEYS.remember, '1');
      /* Write through whatever the session accumulated while we were not
         allowed to, so ticking the box keeps the state now on screen. */
      var keys = Object.keys(session);
      for (var i = 0; i < keys.length; i++) rawSet(keys[i], session[keys[i]]);
    } else {
      clearStored();
      rawSet(KEYS.remember, '0');
    }
    return enabled();
  }

  /* ── ASC profile cache (standalone web and MATLAB hosts) ───────────────
     The VS Code host stores a path on the extension side instead; a browser
     file input hands over a File with no re-openable path, so the text is
     the only thing worth keeping. */
  function setAsc(name, text) {
    if (!name || typeof text !== 'string' || text.length > ASC_MAX_CHARS) { clearAsc(); return false; }
    var ok = set(KEYS.ascText, text);
    set(KEYS.ascName, name);
    return ok;
  }
  function getAsc() {
    var name = get(KEYS.ascName), text = get(KEYS.ascText);
    /* Both or nothing: a half-written pair (quota hit between the two sets)
       must not restore a button label for a profile we cannot re-parse. */
    return (name && text) ? { name: name, text: text } : null;
  }
  function clearAsc() {
    remove(KEYS.ascName);
    remove(KEYS.ascText);
  }

  return {
    KEYS: KEYS,
    ASC_MAX_CHARS: ASC_MAX_CHARS,
    enabled: enabled,
    setEnabled: setEnabled,
    get: get,
    set: set,
    remove: remove,
    getNum: getNum,
    getBool: getBool,
    setBool: setBool,
    getEnum: getEnum,
    storedKeys: storedKeys,
    forget: forget,
    setAsc: setAsc,
    getAsc: getAsc,
    clearAsc: clearAsc
  };
})();
