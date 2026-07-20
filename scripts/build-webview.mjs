/**
 * build-webview.mjs — Bundle the shared SeqEyes webview rendering assets.
 *
 * Concatenates the five webview JS files (state, derived-series, drawing,
 * kspace, interaction) into a single self-contained script.  The files
 * communicate via shared globals so they are concatenated without IIFE
 * wrapping — they run in the global scope.  The VS Code extension wraps
 * them in an IIFE when inlining into the webview; the standalone web app
 * loads them directly.
 *
 * Usage:  node scripts/build-webview.mjs
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ASSETS_DIR = path.join(ROOT, 'src', 'editor', 'webview', 'assets');

const files = [
    'state.js',
    'derived-series.js',
    'drawing.js',
    'kspace.js',
    'interaction.js',
];

const parts = files.map(f => {
    const content = fs.readFileSync(path.join(ASSETS_DIR, f), 'utf-8');
    return `/* ══ ${f} ══ */\n${content}`;
});

const bundle = `/* SeqEyes WebView Bundle — auto-generated, do not edit */
"use strict";
${parts.join('\n\n')}
`;

// Write to web/ (for standalone web app)
const webDir = path.join(ROOT, 'web');
fs.mkdirSync(webDir, { recursive: true });
fs.writeFileSync(path.join(webDir, 'webview-bundle.js'), bundle, 'utf-8');
console.log('✓  web/webview-bundle.js');

// Copy to out/ (for VS Code extension — the copy-assets step will use this)
const outDir = path.join(ROOT, 'out', 'editor', 'webview', 'assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'webview-bundle.js'), bundle, 'utf-8');
console.log('✓  out/editor/webview/assets/webview-bundle.js');

// Also copy styles.css to both destinations
const cssContent = fs.readFileSync(path.join(ASSETS_DIR, 'styles.css'), 'utf-8');
fs.writeFileSync(path.join(webDir, 'styles.css'), cssContent, 'utf-8');
console.log('✓  web/styles.css');
fs.writeFileSync(path.join(outDir, 'styles.css'), cssContent, 'utf-8');
console.log('✓  out/editor/webview/assets/styles.css');

// Copy template.html to out/
const htmlContent = fs.readFileSync(path.join(ASSETS_DIR, 'template.html'), 'utf-8');
fs.writeFileSync(path.join(outDir, 'template.html'), htmlContent, 'utf-8');
console.log('✓  out/editor/webview/assets/template.html');
