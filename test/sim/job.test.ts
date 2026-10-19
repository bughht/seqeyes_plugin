import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';
import { simulateReference } from '../../src/sim/engine/reference';
import { ChunkAccumulator, SimulationJob } from '../../src/sim/job';
import { sheppLoganPhantom, spinsFromGrid2D } from '../../src/sim/phantom/builtin';
import { analyzeDephasing, foldableAxes } from '../../src/sim/plan/dephasing';
import { probeSubSpins } from '../../src/sim/plan/probe';
import { compileProgram } from '../../src/sim/program/compile';
import { TISSUES } from '../../src/sim/phantom/builtin';
import { seqText } from './helpers/seqBuilder';

const demo = (file: string) => {
    const path = join(__dirname, '..', 'seqeyes_demo_seq_files', file);
    return { path, bytes: new Uint8Array(readFileSync(path)) };
};

function relativeDifference(a: Float64Array, b: Float64Array): number {
    let diff = 0, norm = 0;
    for (let i = 0; i < a.length; i++) {
        diff += (a[i] - b[i]) ** 2;
        norm += b[i] ** 2;
    }
    return Math.sqrt(diff / norm);
}

function runAll(job: SimulationJob, order: number[]): Float64Array {
    const first = job.simulateChunk(order[0]);
    const total = new ChunkAccumulator(first.length, job.plan.chunks);
    total.add(order[0], first);
    for (const chunk of order.slice(1)) total.add(chunk, job.simulateChunk(chunk));
    expect(total.done).toBe(true);
    return total.signal;
}

describe('sequence analysis for spin sampling', () => {
    it('folds the rewound phase-encode axis of a Cartesian GRE and nothing else', () => {
        const { path, bytes } = demo('writeGradientEcho.seq');
        const analysis = analyzeDephasing(compileProgram(parseSequenceBytes(bytes, path)));
        // x reads out, z carries the slice select; y is phase-encoded and rewound.
        expect(foldableAxes(analysis, [0.256, 0.256, 0.005])).toBe(2);
        // About 2.5 cycles of x dephasing across a 2 mm voxel per TR.
        expect(analysis.intervalArea[0] * 0.002).toBeGreaterThan(2.4);
        expect(analysis.intervalArea[0] * 0.002).toBeLessThan(2.6);
    });

    it('does not fold an EPI, whose phase blips are never rewound', () => {
        const { path, bytes } = demo('writeEpi.seq');
        const analysis = analyzeDephasing(compileProgram(parseSequenceBytes(bytes, path)));
        expect(foldableAxes(analysis, [0.22, 0.22, 0.003]) & 2).toBe(0);
    });

    it('probes the spoiled GRE axis up to the count where CSF converges', () => {
        const { path, bytes } = demo('writeGradientEcho.seq');
        const program = compileProgram(parseSequenceBytes(bytes, path));
        const analysis = analyzeDephasing(program);
        const probe = probeSubSpins(program, 0, 0.002, Object.values(TISSUES), { intervalCycles: analysis.intervalArea[0] * 0.002 });
        expect(probe.reference).toBe(1024);
        // 128 TRs × ~2.5 cycles: anything below ~320 aliases a surviving
        // pathway for long-T2 CSF (256 leaves ~18 %).
        expect(probe.capped).toBe(false);
        expect(probe.count).toBeGreaterThanOrEqual(320);
        expect(probe.error).toBeLessThanOrEqual(0.02);
        expect(probe.tested.find(t => t.count === 256)!.error).toBeGreaterThan(0.05);
    });
});

describe('simulation jobs', () => {
    const { path, bytes } = demo('writeGradientEcho.seq');

    it('folded classes give the signal of every spin simulated on its own', () => {
        const settings = {
            phantom: { kind: 'shepp-logan' as const, size: 16, fov: [0.032, 0.032] as [number, number] },
            subSpins: [8, 3] as [number, number], throughSlice: 'off' as const,
        };
        const job = new SimulationJob(bytes, path, settings);
        expect(job.plan.axes.map(axis => axis.folded)).toEqual([false, true]);
        expect(job.plan.simulated).toBeLessThan(job.plan.spins);
        const folded = runAll(job, Array.from({ length: job.plan.chunks }, (_, i) => i));

        // The legacy grid path places spins exactly as the phantom model does.
        const spins = spinsFromGrid2D(sheppLoganPhantom(16, 0.032, 0.032), { subSpins: [8, 3] });
        const direct = simulateReference(compileProgram(parseSequenceBytes(bytes, path)), spins).signal;
        expect(relativeDifference(folded, direct)).toBeLessThan(1e-11);
    });

    it('sums to the same bits whatever order chunks finish in', () => {
        const job = new SimulationJob(bytes, path, { phantom: { kind: 'shepp-logan', size: 48 }, subSpins: [16, 4], throughSlice: 'off' });
        expect(job.plan.chunks).toBeGreaterThan(1);
        const ascending = Array.from({ length: job.plan.chunks }, (_, i) => i);
        const forward = runAll(job, ascending);
        const backward = runAll(job, ascending.slice().reverse());
        expect(Buffer.from(backward.buffer).equals(Buffer.from(forward.buffer))).toBe(true);
    });

    it('lets other workers reproduce an automatic plan exactly', () => {
        // 8 mm phantom voxels on 2 mm pixels: x is spoiled (banded probe),
        // y folded with several spins per voxel for resolution.
        const leader = new SimulationJob(bytes, path, { phantom: { kind: 'shepp-logan', size: 32 }, subSpins: 'auto' });
        expect(leader.plan.bands?.length).toBeGreaterThan(0);
        expect(leader.plan.subSpins[1]).toBeGreaterThan(1);
        expect(leader.plan.slices?.count).toBeGreaterThan(4);
        const follower = new SimulationJob(bytes, path, {
            phantom: { kind: 'shepp-logan', size: 32 }, subSpins: leader.plan.resolved, throughSlice: leader.plan.resolvedSlices,
        });
        expect(follower.pulses).toEqual([]);              // took the sub-slices as resolved
        expect(follower.plan.subSpins).toEqual(leader.plan.subSpins);
        expect(follower.plan.slices).toEqual({ ...leader.plan.slices, probe: null });
        expect([follower.plan.spins, follower.plan.simulated, follower.plan.chunks])
            .toEqual([leader.plan.spins, leader.plan.simulated, leader.plan.chunks]);
        const chunk = Math.floor(leader.plan.chunks / 2);
        const a = leader.simulateChunk(chunk), b = follower.simulateChunk(chunk);
        expect(Buffer.from(b.buffer).equals(Buffer.from(a.buffer))).toBe(true);
    });

    it('says that RF shims are not simulated rather than ignoring them silently', () => {
        // A hard pulse played with a two-channel RF_SHIMS vector, then an FID.
        let text = seqText({
            blocks: [{ ticks: 10, rf: 1 }, { ticks: 64, adc: 1 }],
            rf: [{ amplitude: 2500, magShape: 1, centerUs: 50, use: 'e' }],
            adc: [{ samples: 64, dwellNs: 10_000 }],
            shapes: [new Array(100).fill(1)],
        });
        text = text.replace(/^1 10 1 0 0 0 0 0$/m, '1 10 1 0 0 0 0 1')
            .replace('[SHAPES]', ['[EXTENSIONS]', '1 1 1 0', 'extension RF_SHIMS 1', '1 2 1 0 1 1.5707963267948966', '', '[SHAPES]'].join('\n'));
        const job = new SimulationJob(new TextEncoder().encode(text), 'shim.seq', { phantom: { kind: 'shepp-logan', size: 4 }, subSpins: [1, 1] });
        expect(job.plan.notes.some(note => note.startsWith('Not simulated: RF shims (static pTx)'))).toBe(true);
    });

    it('chooses spins per voxel automatically and reports why', () => {
        const job = new SimulationJob(bytes, path, { phantom: { kind: 'shepp-logan', size: 64 }, subSpins: 'auto' });
        const [x, y] = job.plan.axes;
        // 4 mm voxels. x is spoiled: ~5 cycles per TR over 128 TRs needs more
        // than ~640 spins per voxel (the probe settles on 768). y is folded and
        // only resolves the 2 mm readout pixels across each 4 mm voxel.
        expect(x.reason).toBe('spoiling');
        expect(x.probe?.capped).toBe(false);
        expect(x.count).toBeGreaterThan(640);
        expect(y.folded).toBe(true);
        expect(y.reason).toBe('resolution');
        expect(y.count).toBe(4);
        expect(job.plan.simulated).toBeLessThan(job.plan.spins / 20);
        // The 3 mm slab, sampled through: a few spins per 1/Kz, and the probe agreed.
        const slices = job.plan.slices!;
        expect(slices.extent).toBe('pulses');
        expect(slices.reference * 1000).toBeCloseTo(3, 1);
        expect(slices.count).toBeGreaterThanOrEqual(8);
        expect(slices.probe?.capped).toBe(false);
        expect(job.plan.notes.some(note => note.startsWith('Through-slice:'))).toBe(true);
    });
});
