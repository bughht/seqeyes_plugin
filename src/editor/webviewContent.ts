/**
 * webviewContent.ts — SeqEyes webview HTML assembler.
 *
 * Composes the full HTML document from separate, readable modules:
 *   webview/css.ts            → <style> block
 *   webview/html.ts           → <body> markup
 *   webview/js_state.ts       → state, helpers, data reception
 *   webview/js_drawing.ts     → Canvas rendering functions
 *   webview/js_interaction.ts → mouse, wheel, toolbar & IIFE close
 *
 * The modules export plain strings; this file simply concatenates them
 * into a single HTML document string returned to the VS Code webview.
 */

import { CSS } from './webview/css';
import { HTML_BODY } from './webview/html';
import { JS_STATE } from './webview/js_state';
import { JS_DRAWING } from './webview/js_drawing';
import { JS_INTERACTION } from './webview/js_interaction';
import { JS_KSPACE } from './webview/js_kspace';

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
        JS_STATE,
        JS_DRAWING,
        JS_KSPACE,
        JS_INTERACTION,
        '</script>',
        '</body>',
        '</html>',
    ].join('\n');
}
