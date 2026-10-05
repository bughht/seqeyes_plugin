/**
 * build-webview.mjs — Bundle the shared SeqEyes webview rendering assets.
 *
 * Concatenates the webview JS files (prefs, block-transport, labels, state,
 * derived-series, drawing, kspace, colormaps, spectrogram, audio, panel,
 * ndview, simulation-panel, prefs-ui, interaction) into a single
 * self-contained script.  The files
 * communicate via shared globals so they are concatenated without IIFE
 * wrapping — they run in the global scope.  The VS Code extension wraps
 * them in an IIFE when inlining into the webview; the standalone web app
 * loads them directly.
 *
 * It also bundles the simulation worker (src/sim/worker/entry.ts) into
 * web/sim-worker.js, with the licence notice of the code it includes.
 *
 * Usage:  node scripts/build-webview.mjs
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ASSETS_DIR = path.join(ROOT, 'src', 'editor', 'webview', 'assets');

const files = [
    // prefs first: every later file reads its remembered values while
    // initialising.  prefs-ui sits just before interaction.js, which calls
    // its install() — a later slot would leave the var still unassigned.
    'prefs.js',
    'block-transport.js',
    'labels.js',
    'state.js',
    'derived-series.js',
    'drawing.js',
    'kspace.js',
    'colormaps.js',
    'spectrogram.js',
    'audio.js',
    'panel.js',
    // After panel.js, which calls into them only at run time; both read colormaps.js.
    'ndview.js',
    'simulation-panel.js',
    'prefs-ui.js',
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

// Simulation worker: one self-contained classic script (hosts start it as a
// Worker from its URL or a Blob). fflate is MIT-licensed, and its notice must
// travel with every copy, so it leads the bundle.
const fflateLicence = fs.readFileSync(path.join(ROOT, 'node_modules', 'fflate', 'LICENSE'), 'utf-8').trim();
esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'sim', 'worker', 'entry.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    outfile: path.join(webDir, 'sim-worker.js'),
    banner: {
        js: '/*! SeqEyes simulation worker. Includes fflate (https://github.com/101arrowz/fflate):\n'
            + fflateLicence.split('\n').map(line => ' * ' + line).join('\n').replace(/\*\//g, '* /') + '\n */',
    },
    logLevel: 'warning',
});
console.log('✓  web/sim-worker.js');

// Copy template.html to out/
const htmlContent = fs.readFileSync(path.join(ASSETS_DIR, 'template.html'), 'utf-8');
fs.writeFileSync(path.join(outDir, 'template.html'), htmlContent, 'utf-8');
console.log('✓  out/editor/webview/assets/template.html');
