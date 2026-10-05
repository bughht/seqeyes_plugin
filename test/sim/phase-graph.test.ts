import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseSequenceText } from '../../src/pulseq/reader';
import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';
import { simulatePhaseGraph, type PhaseGraphModel } from '../../src/sim/engine/phaseGraph';
import { simulateReference } from '../../src/sim/engine/reference';
import type { SpinSet } from '../../src/sim/engine/spins';
import { ChunkAccumulator, SimulationJob, type JobSettings } from '../../src/sim/job';
import { sheppLoganPhantom2D, TISSUES } from '../../src/sim/phantom/builtin';
import type { Phantom2D } from '../../src/sim/phantom/model';
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
function voxelModel(t1: number, t2: number, size: number, slices?: { z: Float64Array; weight: Float64Array; reference: number }, t2prime = Infinity): PhaseGraphModel {
    const K = slices ? slices.z.length : 1;
    return {
        classes: [{ t1, t2, b1Re: 1, b1Im: 0, df: 0, t2prime }],
        slices: slices ?? { z: Float64Array.of(0), weight: Float64Array.of(1), reference: 1 },
        sources: {
            count: 1, x: Float64Array.of(0), y: Float64Array.of(0), df: Float64Array.of(0), classOf: Int32Array.of(0),
            sliceFrom: Int32Array.of(0), sliceTo: Int32Array.of(K), pd: Float64Array.of(1), coils: 1, rxRe: Float64Array.of(1), rxIm: Float64Array.of(0),
        },
        voxel: [size, 0],
    };
}

/** The phantom without its T2′ map: the isochromat engine does not simulate T2′. */
function withoutT2prime(phantom: Phantom2D): Phantom2D {
    return { ...phantom, maps: { ...phantom.maps, t2prime: undefined } };
}

/**
 * A spin echo from hard pulses of `pulseUs` at the start of 20 µs blocks.
 * Without gradients (20 µs pulses: excitation centred at 10 µs): an FID
 * readout right after excitation, refocusing centred at 3.24 ms and 6.4 ms
 * of readout across the echo at 6.47 ms. With gradients: refocusing in the
 * block at 5 ms, a readout prephaser, equal crushers around it and a
 * 64-sample readout along x whose k-space centre is at 10.01 ms.
 */
function spinEchoProgram(options: { exciteDeg: number; refocusDeg: number; gradients: boolean; pulseUs: number }) {
    const hard = (deg: number) => (deg / 360) / (options.pulseUs * 1e-6);      // Hz for a block pulse
    const rf = [
        { amplitude: hard(options.exciteDeg), magShape: 1, centerUs: options.pulseUs / 2 },
        { amplitude: hard(options.refocusDeg), magShape: 1, centerUs: options.pulseUs / 2, phase: Math.PI / 2, use: 'r' },
    ];
    const shapes = [Array(options.pulseUs).fill(1)];
    if (!options.gradients) {
        return compileProgram(parseSequenceText(seqText({
            blocks: [
                { ticks: 2, rf: 1 }, { ticks: 320, adc: 1 }, { ticks: 1 },        // FID 0.02–3.22 ms; refocusing at 3.24 ms
                { ticks: 2, rf: 2 }, { ticks: 1 }, { ticks: 640, adc: 2 },         // readout 3.26–9.66 ms
            ],
            rf, shapes,
            adc: [{ samples: 64, dwellNs: 50_000 }, { samples: 128, dwellNs: 50_000 }],
        })));
    }
    // Readout: 64 × 20 µs on a 1.28 ms flat top at G; ±2 cycles across a 2 mm voxel.
    const g = 2000 / 1.28e-3;
    return compileProgram(parseSequenceText(seqText({
        blocks: [
            { ticks: 2, rf: 1 }, { ticks: 72, gx: 2 }, { ticks: 376 },             // prephaser, 0.02–0.74 ms
            { ticks: 50, gx: 3 }, { ticks: 2, rf: 2 }, { ticks: 50, gx: 3 },        // crushers around 5.01 ms
            { ticks: 380 }, { ticks: 138, gx: 1, adc: 1 },                         // flat-top centre at 10.01 ms
        ],
        rf, shapes,
        traps: [
            { amplitude: g, riseUs: 50, flatUs: 1280, fallUs: 50 },
            { amplitude: g, riseUs: 50, flatUs: 615, fallUs: 50 },                 // the readout's area up to its centre
            { amplitude: 1000 / 450e-6, riseUs: 50, flatUs: 400, fallUs: 50 },     // 2 cycles across 2 mm
        ],
        adc: [{ samples: 64, dwellNs: 20_000, delayUs: 50 }],
    })));
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
        const phantom = { kind: 'phantom' as const, phantom: withoutT2prime(sheppLoganPhantom2D(16, 0.032, 0.032)) };
        const spins = runJob('writeGradientEcho.seq', { phantom, subSpins: [1024, 16], throughSlice: 'off' });
        const graph = runJob('writeGradientEcho.seq', { phantom, subSpins: 'auto', engine: 'phase-graph', throughSlice: 'off' });
        expect(graph.job.plan.engine).toBe('phase-graph');
        expect(graph.job.plan.phaseGraph?.classes).toBe(5);
        expect(graph.job.plan.chunks).toBeGreaterThanOrEqual(5);
        expect(relativeDifference(graph.signal, spins.signal)).toBeLessThan(0.01);
    });

    it('agrees through the slab, with each voxel B0, B1 and coil sensitivity applied', () => {
        // Linear B0 (±12 Hz) and a smooth B1 across a small Shepp–Logan, two coils.
        const base = withoutT2prime(sheppLoganPhantom2D(12, 0.024, 0.024));
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

    it('decays each configuration by e^{−|τ|/T2′} about the pulse centres, refocused at the spin echo', () => {
        // Ideal 90° and 180° pulses, no gradients and no relaxation (which
        // would leave faint pathways from inside the pulses): one pathway, so
        // with and without T2′ the signals differ by exactly the Lorentzian
        // factor, its τ counted from the pulses' centres.
        const se = spinEchoProgram({ exciteDeg: 90, refocusDeg: 180, gradients: false, pulseUs: 20 });
        const t2prime = 0.004;
        const plain = simulatePhaseGraph(se, voxelModel(Infinity, Infinity, 0)).signal;
        const lorentz = simulatePhaseGraph(se, voxelModel(Infinity, Infinity, 0, undefined, t2prime)).signal;
        const expected: number[] = [];
        for (let s = 0; s < 64; s++) expected.push(Math.exp(-((20 + (s + 0.5) * 50) * 1e-6 - 10e-6) / t2prime));         // FID from 10 µs
        for (let s = 0; s < 128; s++) expected.push(Math.exp(-Math.abs((3260 + (s + 0.5) * 50) * 1e-6 - 6.47e-3) / t2prime));  // echo at 6.47 ms
        let worst = 0, peak = 0;
        expected.forEach((f, s) => {
            peak = Math.max(peak, Math.hypot(plain[2 * s], plain[2 * s + 1]));
            worst = Math.max(worst, Math.hypot(lorentz[2 * s] - f * plain[2 * s], lorentz[2 * s + 1] - f * plain[2 * s + 1]));
        });
        expect(worst / peak).toBeLessThan(1e-9);
        // The echo peaks at its centre, between samples 63 and 64 of the second readout.
        const echo = (s: number) => Math.hypot(lorentz[2 * (64 + s)], lorentz[2 * (64 + s) + 1]);
        expect(echo(63)).toBeGreaterThan(echo(40));
        expect(echo(64)).toBeGreaterThan(echo(90));
    });

    it('matches isochromats that carry a Lorentzian line of frequencies, through crushers and imperfect pulses', () => {
        // 70°/140° pulses leave the FIDs of both pulses besides the echo; the
        // crushers and the readout put them at different k. Brute force: 64
        // positions across the 2 mm voxel × 2048 Lorentzian quantiles. These
        // precess in free precession only (dfFree), so the pulses are 2 µs,
        // too short for the graph's precession about their centres to show.
        const se = spinEchoProgram({ exciteDeg: 70, refocusDeg: 140, gradients: true, pulseUs: 2 });
        const t1 = 0.8, t2 = 0.08, t2prime = 0.004, size = 0.002, nx = 64, nf = 2048;
        const count = nx * nf;
        const dfFree = new Float64Array(count);
        const spins: SpinSet = {
            count,
            x: new Float64Array(count), y: new Float64Array(count), z: new Float64Array(count),
            df: new Float64Array(count), dfFree,
            r1: new Float64Array(count).fill(1 / t1), r2: new Float64Array(count).fill(1 / t2), weight: new Float64Array(count).fill(1 / count),
            b1Re: new Float64Array(count).fill(1), b1Im: new Float64Array(count), coils: 1, rxRe: new Float64Array(count).fill(1), rxIm: new Float64Array(count),
        };
        const width = 1 / (2 * Math.PI * t2prime);
        for (let a = 0; a < nx; a++) {
            for (let b = 0; b < nf; b++) {
                spins.x[a * nf + b] = ((a + 0.5) / nx - 0.5) * size;
                dfFree[a * nf + b] = width * Math.tan(Math.PI * ((b + 0.5) / nf - 0.5));
            }
        }
        const reference = simulateReference(se, spins).signal;
        const graph = simulatePhaseGraph(se, voxelModel(t1, t2, size, undefined, t2prime)).signal;
        const plain = simulatePhaseGraph(se, voxelModel(t1, t2, size)).signal;
        // Within the brute force's own quadrature error (≈1e-3 at 2048 quantiles).
        expect(relativeDifference(graph, reference)).toBeLessThan(2e-3);
        // T2′ matters here: without it the signal is off by far more.
        expect(relativeDifference(plain, reference)).toBeGreaterThan(0.03);
    });

    it("models the built-in phantom's T2′, which the isochromat engine reports it leaves out", () => {
        const settings: JobSettings = { phantom: { kind: 'shepp-logan', size: 16 }, subSpins: [1, 1], throughSlice: 'off' };
        const spins = new SimulationJob(demoBytes('writeGradientEcho.seq'), 'gre.seq', settings);
        const graph = new SimulationJob(demoBytes('writeGradientEcho.seq'), 'gre.seq', { ...settings, engine: 'phase-graph' });
        expect(spins.plan.notes.some(note => note.startsWith('Not simulated: T2′'))).toBe(true);
        expect(graph.plan.notes.some(note => note.startsWith('T2′ is exact'))).toBe(true);
        expect(graph.plan.phaseGraph?.classes).toBe(5);
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
