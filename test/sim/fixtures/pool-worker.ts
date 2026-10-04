// Worker fixture for pool.test.ts, bundled with esbuild at test time.
import { serveWorkerTasks, withTransfer } from '../../../src/sim/backend/pool';
import { nodeSelfPort } from '../../../src/sim/platform/node';

serveWorkerTasks(nodeSelfPort(), {
    sum(payload) {
        const values = new Float64Array(payload as ArrayBuffer);
        let total = 0;
        for (const value of values) total += value;
        return total;
    },
    scale(payload) {
        const { buffer, factor } = payload as { buffer: ArrayBuffer; factor: number };
        const values = new Float64Array(buffer);
        for (let i = 0; i < values.length; i++) values[i] *= factor;
        return withTransfer(buffer, [buffer]);
    },
    async sleep(payload) {
        await new Promise(resolve => setTimeout(resolve, payload as number));
        return payload;
    },
    hang() {
        return new Promise(() => { /* never settles */ });
    },
    fail() {
        throw new RangeError('boom');
    },
    crash() {
        process.exit(3);
    },
});
