import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';
import { simulatePhaseGraph, type PhaseGraphModel } from '../../src/sim/engine/phaseGraph';
import { simulateReference } from '../../src/sim/engine/reference';
import type { SpinSet } from '../../src/sim/engine/spins';
import { ChunkAccumulator, SimulationJob, type JobSettings } from '../../src/sim/job';
import { sheppLoganPhantom2D, TISSUES } from '../../src/sim/phantom/builtin';
import { measurePulses, planSlices } from '../../src/sim/plan/slices';
import { compileProgram } from '../../src/sim/program/compile';
import { seqText, sincShape } from './helpers/seqBuilder';

const demoPath = (file: string) => join(__dirname, '..', 'seqeyes_demo_seq_files', file);
const demoBytes = (file: string) => new Uint8Array(readFileSync(demoPath(file)));
function program(file: string) {
    const compiled = compileProgram(parseSequenceBytes(demoBytes(file), file));
    const segments = [...compiled.segments()];
    return { ...compiled, segments: function* () { yield* segments; } };
}
function relativeDifference(a: Float64Array, b: Float64Array): number {
    let diff = 0, norm = 0;
    for (let i = 0; i < a.length; i++) { diff += (a[i] - b[i]) ** 2; norm += b[i] ** 2; }
    return Math.sqrt(diff / norm);
}
function runJob(file: string, settings: JobSettings, order?: number[]): { job: SimulationJob; signal: Float64Array } {
    const job = new SimulationJob(demoBytes(file), demoPath(file), settings);
    const chunks = order ?? Array.from({ length: job.plan.chunks }, (_, i) => i);
    let total: ChunkAccumulator | null = null;
    for (const chunk of chunks) {
        const signal = job.simulateChunk(chunk);
        total ??= new ChunkAccumulator(signal.length, job.plan.chunks);
        total.add(chunk, signal);
    }
    return { job, signal: total!.signal };
}
/** Isochromats across one voxel along x (y and z at the centre, or the sub-slices given). */
function voxelSpins(n: number, size: number, t1: number, t2: number, z = Float64Array.of(0), w = Float64Array.of(1)): SpinSet {
    const count = n * z.length;
    const x = new Float64Array(count), zz = new Float64Array(count), weight = new Float64Array(count);
    let i = 0;
    for (let k = 0; k < z.length; k++) for (let a = 0; a < n; a++) { x[i] = ((a + 0.5) / n - 0.5) * size; zz[i] = z[k]; weight[i] = w[k] / n; i++; }
    return {
        count, x, y: new Float64Array(count), z: zz, df: new Float64Array(count),
        r1: new Float64Array(count).fill(1 / t1), r2: new Float64Array(count).fill(1 / t2), weight,
        b1Re: new Float64Array(count).fill(1), b1Im: new Float64Array(count), coils: 1, rxRe: new Float64Array(count).fill(1), rxIm: new Float64Array(count),
    };
}
/** One voxel of one tissue for the phase graph (a box along x, a point along y). */
function voxelModel(t1: number, t2: number, size: number, slices?: { z: Float64Array; weight: Float64Array; reference: number }): PhaseGraphModel {
    const K = slices ? slices.z.length : 1;
    return {
        classes: [{ t1, t2, b1Re: 1, b1Im: 0, df: 0 }],
        slices: slices ?? { z: Float64Array.of(0), weight: Float64Array.of(1), reference: 1 },
        sources: {
            count: 1, x: Float64Array.of(0), y: Float64Array.of(0), df: Float64Array.of(0), classOf: Int32Array.of(0),
            sliceFrom: Int32Array.of(0), sliceTo: Int32Array.of(K), pd: Float64Array.of(1), coils: 1, rxRe: Float64Array.of(1), rxIm: Float64Array.of(0),
        },
        voxel: [size, 0],
    };
}

describe('phase-graph engine', () => {
    it('resolves the RF-spoiled GRE voxel that isochromats need thousands of spins for', () => {
        const gre = program('writeGradientEcho.seq');
        for (const name of ['csf', 'whiteMatter'] as const) {
            const t = TISSUES[name];
            const reference = simulateReference(gre, voxelSpins(8192, 0.002, t.t1, t.t2)).signal;
            const graph = simulatePhaseGraph(gre, voxelModel(t.t1, t.t2, 0.002)).signal;
            const coarse = simulateReference(gre, voxelSpins(256, 0.002, t.t1, t.t2)).signal;
            expect(relativeDifference(graph, reference)).toBeLessThan(5e-4);
            // 256 spins are not enough for CSF; the graph has no such knob.
            if (name === 'csf') expect(relativeDifference(coarse, reference)).toBeGreaterThan(1e-2);
        }
    });

    it('converges through a slab with crushers, where isochromats alias', () => {
        // writeTSE: 90° slab, 180° refocusing with crushers along z, 16 echoes.
        const tse = program('writeTSE.seq');
        const pulses = measurePulses(tse);
        const t = TISSUES.greyMatter;
        const run = (density: number) => {
            const plan = planSlices(pulses, { density })!;
            const slices = { z: plan.z, weight: plan.weight, reference: plan.reference };
            return {
                graph: simulatePhaseGraph(tse, voxelModel(t.t1, t.t2, 0.004, slices), { prune: 1e-5, maxStates: 1000 }).signal,
                spins: simulateReference(tse, voxelSpins(16, 0.004, t.t1, t.t2, plan.z, plan.weight)).signal,
            };
        };
        const finest = run(8), coarse = run(2);
        expect(relativeDifference(coarse.graph, finest.graph)).toBeLessThan(0.005);
        expect(relativeDifference(coarse.spins, finest.spins)).toBeGreaterThan(0.05);
    });

    it('drops the configurations it can and stays within its target', () => {
        const tse = program('writeTSE.seq');
        const t = TISSUES.greyMatter;
        const exact = simulatePhaseGraph(tse, voxelModel(t.t1, t.t2, 0.004), { prune: 1e-7, maxStates: 10_000 });
        const pruned = simulatePhaseGraph(tse, voxelModel(t.t1, t.t2, 0.004), { prune: 1e-4, maxStates: 200 });
        expect(pruned.stats.maxStates).toBeLessThanOrEqual(200);
        expect(exact.stats.maxStates).toBeGreaterThan(pruned.stats.maxStates);
        expect(relativeDifference(pruned.signal, exact.signal)).toBeLessThan(0.005);
    });

    it('images the demo GRE as the isochromat engine does, given enough spins for CSF', () => {
        // 2 mm voxels in a 32 mm field at z = 0; isochromats resolve the box voxel along x and y.
        const phantom = { kind: 'shepp-logan' as const, size: 16, fov: [0.032, 0.032] as [number, number] };
        const spins = runJob('writeGradientEcho.seq', { phantom, subSpins: [1024, 16], throughSlice: 'off' });
        const graph = runJob('writeGradientEcho.seq', { phantom, subSpins: 'auto', engine: 'phase-graph', throughSlice: 'off' });
        expect(graph.job.plan.engine).toBe('phase-graph');
        expect(graph.job.plan.phaseGraph?.classes).toBe(5);
        expect(graph.job.plan.chunks).toBeGreaterThanOrEqual(5);
        expect(relativeDifference(graph.signal, spins.signal)).toBeLessThan(0.01);
    });

    it('agrees through the slab, with each voxel B0, B1 and coil sensitivity applied', () => {
        // Linear B0 (±12 Hz) and a smooth B1 across a small Shepp–Logan, two coils.
        const base = sheppLoganPhantom2D(12, 0.024, 0.024);
        const n = 12 * 12;
        const b0 = new Float32Array(n), b1 = new Float32Array(n);
        for (let row = 0; row < 12; row++) {
            for (let col = 0; col < 12; col++) {
                b0[row * 12 + col] = 2 * (col - 6);
                b1[row * 12 + col] = 0.9 + 0.02 * row;
            }
        }
        const phantom = { kind: 'phantom' as const, phantom: { ...base, maps: { ...base.maps, b0, b1 } } };
        const spins = runJob('writeGradientEcho.seq', { phantom, coils: 2, subSpins: [512, 8] });
        const graph = runJob('writeGradientEcho.seq', { phantom, coils: 2, subSpins: 'auto', engine: 'phase-graph' });
        expect(graph.job.plan.coils).toBe(2);
        expect(graph.job.plan.notes.some(note => note.includes('exact B0'))).toBe(true);
        expect(relativeDifference(graph.signal, spins.signal)).toBeLessThan(0.02);
    });

    it('sums to the same bits whatever order its chunks finish in', () => {
        const settings: JobSettings = { phantom: { kind: 'shepp-logan', size: 24 }, subSpins: 'auto', engine: 'phase-graph' };
        const forward = runJob('writeGradientEcho.seq', settings);
        const backward = runJob('writeGradientEcho.seq', settings, Array.from({ length: forward.job.plan.chunks }, (_, i) => forward.job.plan.chunks - 1 - i));
        expect(Buffer.from(backward.signal.buffer).equals(Buffer.from(forward.signal.buffer))).toBe(true);
    });

    it('lets other workers reproduce its plan', () => {
        const settings: JobSettings = { phantom: { kind: 'shepp-logan', size: 24 }, subSpins: 'auto', engine: 'phase-graph' };
        const leader = new SimulationJob(demoBytes('writeGradientEcho.seq'), 'gre.seq', settings);
        const follower = new SimulationJob(demoBytes('writeGradientEcho.seq'), 'gre.seq', { ...settings, throughSlice: leader.plan.resolvedSlices });
        expect([follower.plan.chunks, follower.plan.spins, follower.plan.simulated]).toEqual([leader.plan.chunks, leader.plan.spins, leader.plan.simulated]);
        const a = leader.simulateChunk(1), b = follower.simulateChunk(1);
        expect(Buffer.from(b.buffer).equals(Buffer.from(a.buffer))).toBe(true);
    });

    it('bins continuous maps into a bounded number of classes', () => {
        const base = sheppLoganPhantom2D(96, 0.192, 0.192);   // ~4600 voxels, each its own T1: over the 2048-class budget
        const t1 = Float32Array.from(base.maps.t1, (v, i) => (v > 0 ? v * (1 + 0.0001 * i) : v));
        const phantom = { kind: 'phantom' as const, phantom: { ...base, maps: { ...base.maps, t1 } } };
        const job = new SimulationJob(demoBytes('writeGradientEcho.seq'), 'gre.seq', { phantom, subSpins: 'auto', engine: 'phase-graph', throughSlice: 'off' });
        expect(job.plan.phaseGraph!.binning.t).toBeGreaterThan(0);
        expect(job.plan.phaseGraph!.classes).toBeLessThanOrEqual(2048);
        expect(job.plan.notes.some(note => note.startsWith('Continuous maps were binned'))).toBe(true);
    });

    it('refuses pulses played with in-plane gradients, pointing to the isochromat engine', () => {
        const shape = sincShape(1000, 4);
        let area = 0;
        for (const v of shape) area += v * 1e-6;
        const text = seqText({
            blocks: [{ ticks: 120, rf: 1, gx: 1 }, { ticks: 64, adc: 1 }],
            rf: [{ amplitude: 0.25 / area, magShape: 1, centerUs: 500, delayUs: 100, use: 'e' }],
            traps: [{ amplitude: 200e3, riseUs: 100, flatUs: 1000, fallUs: 100 }],
            adc: [{ samples: 64, dwellNs: 10_000 }],
            shapes: [shape],
        });
        expect(() => new SimulationJob(new TextEncoder().encode(text), 'sel.seq', { phantom: { kind: 'shepp-logan', size: 8 }, subSpins: 'auto', engine: 'phase-graph' }))
            .toThrow(/isochromat engine/);
    });
});
