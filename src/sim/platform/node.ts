/**
 * Node adapters for the worker pool (`worker_threads`). The only file under
 * src/sim allowed to import Node built-ins; the CLI and tests use it, the
 * webview bundle never does.
 */

import { Worker, parentPort } from 'node:worker_threads';
import type { WorkerFactory, WorkerPort, WorkerSelfPort } from '../backend/pool';

export function nodeWorkerPort(worker: Worker): WorkerPort {
    return {
        post: (message, transfer) => worker.postMessage(message, transfer),
        listen(onMessage, onError) {
            worker.on('message', onMessage);
            worker.on('error', onError);
            worker.on('exit', code => {
                if (code !== 0) onError(new Error(`worker exited with code ${code}`));
            });
        },
        terminate: () => { void worker.terminate(); },
    };
}

/** Factory for workers running a bundled script file. */
export function nodeWorkerFactory(scriptPath: string, resourceLimits?: { maxOldGenerationSizeMb?: number }): WorkerFactory {
    return () => nodeWorkerPort(new Worker(scriptPath, { resourceLimits }));
}

/** The worker side, inside a `worker_threads` worker. */
export function nodeSelfPort(): WorkerSelfPort {
    const port = parentPort;
    if (!port) throw new Error('nodeSelfPort() must run inside a worker thread.');
    return {
        post: (message, transfer) => port.postMessage(message, transfer),
        onMessage: handler => port.on('message', handler),
    };
}
