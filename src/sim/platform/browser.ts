/**
 * Browser and Deno adapters for the worker pool. Typed structurally so this
 * file compiles without the DOM library; the globals are only touched at call
 * time.
 *
 * VS Code webviews load workers only from blob: or data: URLs and forbid
 * importScripts/import() inside them, so the worker is always a self-contained
 * script started from a Blob URL (with a data: URL fallback for opaque-origin
 * documents such as the Jupyter iframe).
 */

import type { WorkerFactory, WorkerPort, WorkerSelfPort } from '../backend/pool';

interface StandardWorker {
    postMessage(message: unknown, transfer: ArrayBuffer[]): void;
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: ((event: { message?: string; preventDefault?: () => void }) => void) | null;
    terminate(): void;
}

type WorkerConstructor = new (url: string, options?: { name?: string; type?: string }) => StandardWorker;

export function standardWorkerPort(worker: StandardWorker): WorkerPort {
    return {
        post: (message, transfer) => worker.postMessage(message, transfer),
        listen(onMessage, onError) {
            worker.onmessage = event => onMessage(event.data);
            worker.onerror = event => {
                event.preventDefault?.();
                onError(new Error(event.message || 'worker error'));
            };
        },
        terminate: () => worker.terminate(),
    };
}

/**
 * Factory for workers running `source` (a self-contained classic script). Each
 * call creates its own Blob URL; the URL is revoked once the worker has loaded.
 */
export function inlineWorkerFactory(source: string, name = 'seqeyes-sim'): WorkerFactory {
    const g = globalThis as unknown as {
        Worker?: WorkerConstructor;
        Blob?: new (parts: string[], options: { type: string }) => unknown;
        URL?: { createObjectURL(blob: unknown): string; revokeObjectURL(url: string): void };
        setTimeout(callback: () => void, ms: number): unknown;
    };
    if (!g.Worker) throw new Error('Web Workers are not available in this environment.');
    const WorkerCtor = g.Worker;
    return () => {
        let worker: StandardWorker;
        if (g.Blob && g.URL) {
            const url = g.URL.createObjectURL(new g.Blob([source], { type: 'text/javascript' }));
            try {
                worker = new WorkerCtor(url, { name });
            } catch {
                worker = new WorkerCtor(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`, { name });
            } finally {
                // Safe once construction returns: the script fetch has started.
                g.setTimeout(() => g.URL!.revokeObjectURL(url), 0);
            }
        } else {
            worker = new WorkerCtor(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`, { name });
        }
        return standardWorkerPort(worker);
    };
}

/** The worker side, for browser and Deno dedicated workers. */
export function standardSelfPort(): WorkerSelfPort {
    const g = globalThis as unknown as {
        postMessage(message: unknown, transfer: ArrayBuffer[]): void;
        addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
    };
    return {
        post: (message, transfer) => g.postMessage(message, transfer),
        onMessage: handler => g.addEventListener('message', event => handler(event.data)),
    };
}
