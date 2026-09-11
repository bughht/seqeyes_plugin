/**
 * build-extension.mjs — Build the VS Code extension with esbuild.
 *
 * Replaces `tsc -p ./` for the extension build.  Bundles src/extension.ts
 * and its dependencies into out/extension.js (CommonJS, targeting Node 18).
 * The vscode module is externalised (provided by the VS Code host).
 *
 * The webview assets are NOT bundled here — they are built separately by
 * build-webview.mjs and copied into out/editor/webview/assets/.
 *
 * Usage:
 *   node scripts/build-extension.mjs          # one-shot build
 *   node scripts/build-extension.mjs --watch  # incremental watch mode
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const watch = process.argv.includes('--watch');

const common = {
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['vscode'],
    sourcemap: true,
    logLevel: 'info',
};

const extensionEntry = path.join(ROOT, 'src', 'extension.ts');
const extensionOutfile = path.join(ROOT, 'out', 'extension.js');

const cliEntry = path.join(ROOT, 'src', 'cli', 'exportKspace.ts');
const cliOutfile = path.join(ROOT, 'out', 'cli', 'exportKspace.js');
const loadProfileEntry = path.join(ROOT, 'src', 'cli', 'profileLoad.ts');
const loadProfileOutfile = path.join(ROOT, 'out', 'cli', 'profileLoad.js');

/**
 * Discard anything a previous build left behind.
 *
 * Nothing used to clear `out/`, so output from the old `tsc` build stayed
 * there indefinitely and `.vscodeignore` does not exclude it: a packaged VSIX
 * carried 39 stale modules beside the bundles that actually run, some of them
 * months older than the source. They were dead weight at best and misleading
 * to anyone debugging the package at worst.
 *
 * Watch mode skips this so an incremental rebuild does not delete the output
 * a running host is holding.
 */
function cleanOutDir() {
    fs.rmSync(path.join(ROOT, 'out'), { recursive: true, force: true });
}

async function build() {
    if (!watch) cleanOutDir();
    if (watch) {
        // Watch mode: use esbuild context for incremental rebuilds
        const extCtx = await esbuild.context({
            ...common,
            entryPoints: [extensionEntry],
            outfile: extensionOutfile,
        });
        await extCtx.watch();
        console.log('👁  Watching src/extension.ts …');

        const cliCtx = await esbuild.context({
            ...common,
            entryPoints: [cliEntry],
            outfile: cliOutfile,
        });
        await cliCtx.watch();
        console.log('👁  Watching src/cli/exportKspace.ts …');

        const loadProfileCtx = await esbuild.context({
            ...common,
            entryPoints: [loadProfileEntry],
            outfile: loadProfileOutfile,
        });
        await loadProfileCtx.watch();
        console.log('👁  Watching src/cli/profileLoad.ts …');
        console.log('(Press Ctrl+C to stop watching)');
    } else {
        await esbuild.build({
            ...common,
            entryPoints: [extensionEntry],
            outfile: extensionOutfile,
        });
        console.log('✓  out/extension.js (VS Code extension)');

        await esbuild.build({
            ...common,
            entryPoints: [cliEntry],
            outfile: cliOutfile,
        });
        console.log('✓  out/cli/exportKspace.js');

        await esbuild.build({
            ...common,
            entryPoints: [loadProfileEntry],
            outfile: loadProfileOutfile,
        });
        console.log('✓  out/cli/profileLoad.js');
    }
}

build().catch(err => {
    console.error(err);
    process.exit(1);
});
