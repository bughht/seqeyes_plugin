/**
 * webviewContent.ts — SeqEyes webview HTML assembler.
 *
 * Reads CSS, HTML, and JS from real files under webview/assets/ so you get
 * full syntax highlighting, IntelliSense, and formatting in each language.
 *
 * Asset files (copied to out/ during build):
 *   webview/assets/styles.css        → <style> block
 *   webview/assets/template.html     → <body> markup
 *   webview/assets/state.js          → state, helpers, data reception
 *   webview/assets/drawing.js        → Canvas rendering functions
 *   webview/assets/kspace.js         → WebGL k-space viewer
 *   webview/assets/interaction.js    → mouse, wheel, toolbar & IIFE close
 *
 * Files are read synchronously once when the module first loads — the
 * webview content is static and this runs in Node.js, so there is no
 * performance penalty.
 */

import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/naming-convention
declare const __dirname: string;

const ASSETS_DIR = path.join(__dirname, 'webview', 'assets');

function readAsset(filename: string): string {
    return fs.readFileSync(path.join(ASSETS_DIR, filename), 'utf-8');
}

const CSS = readAsset('styles.css');
const HTML_BODY = readAsset('template.html');
const JS_STATE = readAsset('state.js');
const JS_DRAWING = readAsset('drawing.js');
const JS_KSPACE = readAsset('kspace.js');
const JS_INTERACTION = readAsset('interaction.js');

export function getWebviewContent(_hint: number): string {
    return [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="UTF-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1.0">',
        '<title>SeqEyes</title>',
        '<style>',
        CSS,
        '</style>',
        '</head>',
        '<body>',
        HTML_BODY,
        '<script>',
        '(function(){',
        JS_STATE,
        JS_DRAWING,
        JS_KSPACE,
        JS_INTERACTION,
        '})();',
        '</script>',
        '</body>',
        '</html>',
    ].join('\n');
}
