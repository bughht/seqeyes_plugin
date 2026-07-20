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

async function build() {
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
    }
}

build().catch(err => {
    console.error(err);
    process.exit(1);
});
