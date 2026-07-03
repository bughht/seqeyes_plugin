/**
 * webview/html.ts — HTML body template for the SeqEyes webview.
 *
 * Contains the toolbar, canvas container, and tooltip overlay.
 * The <script> tag is injected separately by {@link getWebviewContent}.
 */

export const HTML_BODY = `
<!-- ── Toolbar ── -->
<div id="tb">
<button id="openBtn" title="Open another .seq file">📂 Open</button><div class="sep"></div>
<button id="zi" title="Zoom In (scroll wheel)">+</button>
<button id="zo" title="Zoom Out">\u2212</button>
<button id="zf" title="Fit All">Fit</button>
<button id="zr" title="Reset">\u21BA</button><div class="sep"></div>
<span class="ulbl">Theme:</span><select id="theme"><option value="system">System</option><option value="onelight">One Light</option><option value="onedark">One Dark</option><option value="dracula">Dracula</option><option value="nord">Nord</option><option value="githublight">GitHub Light</option><option value="github">GitHub</option></select>
<div class="sep"></div>
<span class="ulbl">Time:</span><select id="tu"><option value="s">s</option><option value="ms" selected>ms</option><option value="us">\u00b5s</option></select>
<span class="ulbl">Grad:</span><select id="gu"><option value="Hz/m" selected>Hz/m</option><option value="mT/m">mT/m</option><option value="G/cm">G/cm</option></select>
<div class="sep"></div>
<label class="li" id="bbt" title="Toggle block boundary lines"><input type="checkbox" id="bbc" style="margin:0;cursor:pointer"><span style="font-size:11px;color:var(--fg)">Blocks</span></label>
<div class="sep"></div><div class="lg" id="legend"></div>
<button id="kbtn" title="Toggle K-Space View" style="margin-left:4px">K-Space</button>
<span class="cur" id="cur">\u2190 hover for time</span>
</div>
<!-- Main split: waveforms | k-space -->
<div id="main">
<div id="left"><div id="cc"><canvas id="mc"></canvas><div id="tt"></div></div></div>
<div id="right"><div class="handle" id="khandle"></div><canvas id="kg"></canvas><canvas id="kc"></canvas><div id="rc"><button id="krst" title="Reset view">\u21BA</button><button id="kax" title="Toggle projection">Prj</button><button id="kunit" title="Toggle k-space unit (1/m \u2194 rad/m)">Unit: 1/m</button><div style="display:flex;align-items:center;gap:2px;margin-top:4px"><span style="font-size:9px;color:var(--lb)">Size</span><input type="range" id="kdot" min="1" max="12" value="2" style="width:50px;accent-color:var(--adc)" title="ADC marker size"></div></div></div>
</div>
<!-- Hidden file input for standalone web mode -->
<input type="file" id="fileInput" accept=".seq" style="display:none">
`;
