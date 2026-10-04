/**
 * Simulation worker: the panel's only route into the simulator. Bundled on its
 * own (web/sim-worker.js) so the page never loads the engine.
 *
 * Messages (panel → worker):
 *   { type: 'open',   job, bytes, name, settings }  parse, compile, plan
 *   { type: 'chunk',  job, chunk }                   simulate one chunk
 *   { type: 'recon',  job, signal }                  image, k-space and raw views
 *   { type: 'close',  job }                          release the job
 * Replies (worker → panel):
 *   { type: 'plan', job, plan }   { type: 'progress', job, chunk, fraction }
 *   { type: 'chunk', job, chunk, signal, ms }   { type: 'recon', job, ... }
 *   { type: 'error', job, message }
 * Several workers serve one job, each opening it; the panel hands out chunks
 * and sums them in order (job.ts). Cancelling terminates the workers.
 */

import { SimulationJob, type JobSettings } from '../job';
import { standardSelfPort } from '../platform/browser';

type Request =
    | { type: 'open'; job: number; bytes: ArrayBuffer; name: string; settings: JobSettings }
    | { type: 'chunk'; job: number; chunk: number }
    | { type: 'recon'; job: number; signal: Float64Array }
    | { type: 'close'; job: number };

const port = standardSelfPort();
const jobs = new Map<number, SimulationJob>();
/** Progress messages per chunk are spaced at least this far apart [ms]. */
const PROGRESS_SPACING_MS = 100;

function now(): number {
    const clock = (globalThis as unknown as { performance?: { now(): number } }).performance;
    return clock ? clock.now() : Date.now();
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function jobFor(id: number): SimulationJob {
    const job = jobs.get(id);
    if (!job) throw new Error('The simulation job is not open in this worker.');
    return job;
}

function handle(request: Request): void {
    switch (request.type) {
        case 'open': {
            // One job at a time: a new open replaces whatever ran before.
            jobs.clear();
            const job = new SimulationJob(new Uint8Array(request.bytes), request.name, request.settings);
            jobs.set(request.job, job);
            port.post({ type: 'plan', job: request.job, plan: job.plan }, []);
            return;
        }
        case 'chunk': {
            const job = jobFor(request.job);
            const started = now();
            let last = started;
            const signal = job.simulateChunk(request.chunk, {
                progressInterval: 16,
                onProgress: fraction => {
                    const t = now();
                    if (t - last < PROGRESS_SPACING_MS) return;
                    last = t;
                    port.post({ type: 'progress', job: request.job, chunk: request.chunk, fraction }, []);
                },
            });
            port.post(
                { type: 'chunk', job: request.job, chunk: request.chunk, signal, ms: now() - started },
                [signal.buffer as ArrayBuffer],
            );
            return;
        }
        case 'recon': {
            const job = jobFor(request.job);
            const recon = job.reconstruct(request.signal);
            const raw = job.rawMagnitude(request.signal);
            port.post({
                type: 'recon',
                job: request.job,
                recon: {
                    axes: recon.axes,
                    nu: recon.nu,
                    nv: recon.nv,
                    frames: recon.frames,
                    images: recon.images,
                    kspace: recon.kspace,
                    fill: recon.fill,
                    offGridFraction: recon.offGridFraction,
                    warnings: recon.warnings,
                },
                raw,
            }, [recon.images.buffer as ArrayBuffer, recon.kspace.buffer as ArrayBuffer, raw.magnitude.buffer as ArrayBuffer]);
            return;
        }
        case 'close':
            jobs.delete(request.job);
            return;
    }
}

port.onMessage(data => {
    const request = data as Request;
    try {
        handle(request);
    } catch (error) {
        port.post({ type: 'error', job: request?.job ?? -1, message: errorMessage(error) }, []);
    }
});
