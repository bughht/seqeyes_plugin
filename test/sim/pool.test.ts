import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { TaskAbortedError, WorkerPool } from '../../src/sim/backend/pool';
import { nodeWorkerFactory } from '../../src/sim/platform/node';
import { bundleWorker } from './helpers/bundleWorker';

let script = '';
const pools: WorkerPool[] = [];

beforeAll(async () => {
    script = await bundleWorker(join(__dirname, 'fixtures', 'pool-worker.ts'));
}, 60_000);

afterEach(() => {
    for (const pool of pools.splice(0)) pool.close();
});

function makePool(size: number): WorkerPool {
    const pool = new WorkerPool(nodeWorkerFactory(script), size);
    pools.push(pool);
    return pool;
}

describe('WorkerPool on worker_threads', () => {
    it('runs tasks and returns their results', async () => {
        const pool = makePool(2);
        const results = await Promise.all([1, 2, 3, 4].map(n => {
            const buffer = Float64Array.from({ length: n }, (_, i) => i + 1).buffer;
            return pool.run<number>('sum', buffer, [buffer]);
        }));
        expect(results).toEqual([1, 3, 6, 10]);
    });

    it('runs tasks in parallel across workers', async () => {
        const pool = makePool(4);
        const start = Date.now();
        await Promise.all(Array.from({ length: 8 }, () => pool.run('sleep', 150)));
        // Eight 150 ms tasks on four workers: two rounds, not eight.
        expect(Date.now() - start).toBeLessThan(8 * 150 * 0.6);
    });

    it('transfers buffers both ways instead of copying', async () => {
        const pool = makePool(1);
        const buffer = Float64Array.of(1, 2, 3).buffer;
        const result = await pool.run<ArrayBuffer>('scale', { buffer, factor: 2 }, [buffer]);
        expect(buffer.byteLength).toBe(0);                    // moved to the worker
        expect(Array.from(new Float64Array(result))).toEqual([2, 4, 6]);
    });

    it('rejects a failing task and keeps serving', async () => {
        const pool = makePool(1);
        await expect(pool.run('fail', null)).rejects.toThrow(/RangeError: boom/);
        await expect(pool.run('sleep', 1)).resolves.toBe(1);
    });

    it('replaces a crashed worker', async () => {
        const pool = makePool(1);
        await expect(pool.run('crash', null)).rejects.toThrow(/exited with code 3/);
        await expect(pool.run('sleep', 1)).resolves.toBe(1);
    });

    it('cancels queued and running tasks, then keeps serving', async () => {
        const pool = makePool(1);
        const controller = new AbortController();
        const running = pool.run('hang', null, [], controller.signal);
        const queued = pool.run('sleep', 1, [], controller.signal);
        controller.abort();
        await expect(running).rejects.toBeInstanceOf(TaskAbortedError);
        await expect(queued).rejects.toBeInstanceOf(TaskAbortedError);
        await expect(pool.run('sleep', 1)).resolves.toBe(1);
    });

    it('refuses already-aborted signals and rejects everything on close', async () => {
        const pool = makePool(1);
        const controller = new AbortController();
        controller.abort();
        await expect(pool.run('sleep', 1, [], controller.signal)).rejects.toBeInstanceOf(TaskAbortedError);
        const pending = pool.run('hang', null);
        pool.close();
        await expect(pending).rejects.toThrow(/closed/);
        await expect(pool.run('sleep', 1)).rejects.toThrow(/closed/);
    });
});
