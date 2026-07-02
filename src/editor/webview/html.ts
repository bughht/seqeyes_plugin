/**
 * webview/html.ts — HTML body template for the SeqEyes webview.
 *
 * Contains the toolbar, canvas container, and tooltip overlay.
 * The <script> tag is injected separately by {@link getWebviewContent}.
 */

export const HTML_BODY = `
<!-- ── Toolbar ── -->
<div id="tb">
<button id="zi" title="Zoom In (scroll wheel)">+</button>
<button id="zo" title="Zoom Out">\u2212</button>
<button id="zf" title="Fit All">Fit</button>
<button id="zr" title="Reset">\u21BA</button><div class="sep"></div>
<span class="ulbl">Time:</span><select id="tu"><option value="s">s</option><option value="ms" selected>ms</option><option value="us">\u00b5s</option></select>
<span class="ulbl">Grad:</span><select id="gu"><option value="Hz/m" selected>Hz/m</option><option value="mT/m">mT/m</option><option value="G/cm">G/cm</option></select>
<div class="sep"></div>
<label class="li" id="bbt" title="Toggle block boundary lines"><input type="checkbox" id="bbc" style="margin:0;cursor:pointer"><span style="font-size:11px;color:var(--fg)">Blocks</span></label>
<div class="sep"></div><div class="lg" id="legend"></div>
<button id="kbtn" title="Toggle K-Space View" style="margin-left:4px">K</button>
<span class="cur" id="cur">\u2190 hover for time</span>
</div>
<!-- Main split: waveforms | k-space -->
<div id="main">
<div id="left"><div id="cc"><canvas id="mc"></canvas><div id="tt"></div></div></div>
<div id="right"><canvas id="kc"></canvas><div id="rc"><button id="krst" title="Reset view">\u21BA</button><button id="kax" title="Toggle projection">Prj</button></div></div>
</div>
`;
