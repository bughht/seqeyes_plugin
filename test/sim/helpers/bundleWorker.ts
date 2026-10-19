import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Bundle a TypeScript worker entry into a self-contained CommonJS file for
 * `worker_threads`, as the shipped worker will be bundled. Returns its path.
 */
export async function bundleWorker(entry: string): Promise<string> {
    const outfile = join(mkdtempSync(join(tmpdir(), 'seqeyes-worker-')), 'worker.cjs');
    await build({
        entryPoints: [entry],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        outfile,
        logLevel: 'silent',
    });
    return outfile;
}
