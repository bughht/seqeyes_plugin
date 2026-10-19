/**
 * webviewContent.ts — SeqEyes webview HTML assembler.
 *
 * Reads the pre-built webview bundle (produced by scripts/build-webview.mjs)
 * plus CSS and HTML template from the out/ directory.  The webview JS is
 * wrapped in an IIFE so it runs isolated from the VS Code webview host.
 *
 * When bundled with esbuild, __dirname points to out/.
 * Asset files live under out/editor/webview/assets/.
 */

import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/naming-convention
declare const __dirname: string;

const ASSETS_DIR = path.join(__dirname, 'editor', 'webview', 'assets');

function readAsset(filename: string): string {
    return fs.readFileSync(path.join(ASSETS_DIR, filename), 'utf-8');
}

const CSS = readAsset('styles.css');
const HTML_BODY = readAsset('template.html');
const WEBVIEW_BUNDLE = readAsset('webview-bundle.js');

let simulationWorkerSource: string | undefined;

/**
 * The simulation worker script, which the webview starts from a Blob URL.
 * Read on first use only: most viewers never open the Simulation panel.
 */
export function readSimulationWorkerSource(): string {
    simulationWorkerSource ??= readAsset('sim-worker.js');
    return simulationWorkerSource;
}

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
        WEBVIEW_BUNDLE,
        '})();',
        '</script>',
        '</body>',
        '</html>',
    ].join('\n');
}
