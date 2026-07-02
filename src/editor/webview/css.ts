/**
 * webview/css.ts — CSS stylesheet for the SeqEyes webview.
 *
 * Embedded inline in a <style> tag.  Uses CSS custom properties for
 * light/dark theme support (toggled via `body.vscode-dark`).
 */

export const CSS = `
/* ── Colour scheme ── */
:root{--bg:#fff;--fg:#222;--gr:#ddd;--rf:#e6194b;--rff:rgba(230,25,75,.07);--gx:#3cb44b;--gy:#4363d8;--gz:#f58231;--adc:#42d4f4;--adf:rgba(66,212,244,.14);--tr:#911eb4;--ax:#aaa;--lb:#888;--cr:#ee0000}
body.vscode-dark{--bg:#1e1e1e;--fg:#ddd;--gr:#3a3a3a;--rf:#ff6b8a;--rff:rgba(255,107,138,.05);--gx:#5cdb5c;--gy:#6b8cff;--gz:#ffb347;--adc:#5ce1f4;--adf:rgba(92,225,244,.10);--tr:#d45cff;--ax:#666;--lb:#999;--cr:#ff4444}
/* ── Layout ── */
*{margin:0;padding:0;box-sizing:border-box}
body{font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--fg);overflow:hidden;height:100vh;user-select:none;display:flex;flex-direction:column}
#main{display:flex;flex:1;overflow:hidden}
#left{display:flex;flex-direction:column;flex:1;overflow:hidden;min-width:0}
#right{width:0;overflow:hidden;position:relative;border-left:1px solid var(--gr);transition:width .25s}
#right.open{width:500px}
#right .handle{position:absolute;left:0;top:0;bottom:0;width:5px;cursor:col-resize;z-index:20}
#right .handle:hover{background:var(--adc);opacity:.3}
#right canvas{display:block;width:100%;height:100%}
#rc{position:absolute;top:4px;left:4px;z-index:10;display:flex;flex-direction:column;gap:2px}
#rc button{background:var(--gr);border:1px solid var(--ax);color:var(--fg);padding:2px 6px;border-radius:3px;cursor:pointer;font-size:10px}
#rc button:hover{opacity:.75}
#tb{display:flex;align-items:center;gap:6px;padding:5px 10px;background:var(--bg);border-bottom:1px solid var(--gr);font-size:11px;flex-shrink:0;flex-wrap:wrap}
#tb button{background:var(--gr);border:1px solid var(--ax);color:var(--fg);padding:2px 7px;border-radius:3px;cursor:pointer;font-size:11px}
#tb button:hover{opacity:.75}
#tb select{background:var(--gr);border:1px solid var(--ax);color:var(--fg);padding:2px 4px;border-radius:3px;font-size:11px;cursor:pointer}
#tb .sep{width:1px;height:16px;background:var(--ax);margin:0 3px}
#tb .lg{display:flex;gap:7px;align-items:center;font-size:11px}
#tb .li{cursor:pointer;display:flex;align-items:center;gap:3px;padding:1px 4px;border-radius:3px;opacity:1;transition:opacity .15s}
#tb .li.off{opacity:.30}
#tb .ld{width:10px;height:10px;border-radius:2px;border:1px solid rgba(0,0,0,.15)}
#tb .cur{font:11px monospace;color:var(--cr);margin-left:auto;min-width:180px;text-align:right}
#tb .ulbl{font-size:10px;color:var(--lb);margin:0 1px}
#cc{flex:1;overflow:hidden;position:relative;cursor:crosshair}
#cc.pan{cursor:grabbing}
canvas{display:block}
#tt{position:absolute;pointer-events:none;background:rgba(0,0,0,.88);color:#fff;padding:5px 9px;border-radius:4px;font:11px monospace;white-space:pre;display:none;z-index:100;line-height:1.35;max-width:340px}
`;
