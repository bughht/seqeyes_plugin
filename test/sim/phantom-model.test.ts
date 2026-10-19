import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';
import { simulateReference } from '../../src/sim/engine/reference';
import { ChunkAccumulator, INSTANT_TOLERANCE, SimulationJob } from '../../src/sim/job';
import { sheppLoganPhantom2D, sheppLoganVolume, TISSUES } from '../../src/sim/phantom/builtin';
import {
    coarsenPhantom,
    mrzeroFieldMaps,
    occupiedVoxels,
    phantomSpins,
    sliceVolume,
    syntheticCoils,
    type Phantom2D,
    type PhantomVolume,
} from '../../src/sim/phantom/model';
import { compileProgram } from '../../src/sim/program/compile';

/** A 5 × 4 × 3 volume whose PD encodes its voxel: 1 + x + 10y + 100z. */
function codedVolume(): PhantomVolume {
    const shape: [number, number, number] = [5, 4, 3];
    const n = 5 * 4 * 3;
    const pd = new Float32Array(n), t1 = new Float32Array(n).fill(1), t2 = new Float32Array(n).fill(0.1);
    for (let z = 0; z < 3; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) pd[x + 5 * (y + 4 * z)] = 1 + x + 10 * y + 100 * z;
    return { shape, voxel: [1e-3, 2e-3, 3e-3], maps: { pd, t1, t2 }, source: 'coded', notes: [] };
}

describe('the 3-D Shepp–Logan', () => {
    it('places its structures at their published heights, so planes differ as through a head', () => {
        // 64 × 64 × 64 over [−1, 1]³: plane k sits at w = (k − 32)/32.
        const n = 64;
        const volume = sheppLoganVolume(n, n, [0.256, 0.256, 0.256]);
        const at = (u: number, v: number, w: number) => {
            const i = Math.round(u * n / 2 + n / 2), j = Math.round(v * n / 2 + n / 2), k = Math.round(w * n / 2 + n / 2);
            return volume.maps.t2[(k * n + j) * n + i];
        };
        const planeHas = (w: number, t2: number) => {
            const k = Math.round(w * n / 2 + n / 2);
            return volume.maps.t2.subarray(k * n * n, (k + 1) * n * n).some(v => v === Math.fround(t2));
        };
        // The ventricles at z = −0.25 (Kak & Roberts; Koay et al. 2007), not at 0 or above.
        expect(at(-0.25, 0.08, -0.25)).toBe(Math.fround(TISSUES.csf.t2));
        expect(at(0.25, 0, -0.25)).toBe(Math.fround(TISSUES.csf.t2));
        expect(planeHas(-0.25, TISSUES.csf.t2)).toBe(true);
        expect(planeHas(0, TISSUES.csf.t2)).toBe(false);
        expect(planeHas(0.25, TISSUES.csf.t2)).toBe(false);
        // The large ellipsoid above them spans z −0.75…0.25; near the vertex, a CSF spot and a lesion.
        expect(at(0, 0.35, -0.6)).toBe(Math.fround(TISSUES.greyMatter.t2));
        expect(at(0, 0.35, 0.4)).toBe(Math.fround(TISSUES.whiteMatter.t2));
        expect(at(0, 0.1, 0.625)).toBe(Math.fround(TISSUES.csf.t2));
        expect(planeHas(0.625, TISSUES.lesion.t2)).toBe(true);
        // The head ends at |z| = 0.9.
        expect(volume.maps.pd.subarray(0, n * n).every(v => v === 0)).toBe(true);
    });
});

describe('the half-resolution phantom of the Instant accuracy', () => {
    /** PD sum and PD-weighted centroid over a phantom's planes, in the simulation's coordinates. */
    function moments(p: Phantom2D) {
        let sum = 0, x = 0, y = 0, z = 0;
        for (const plane of [{ offset: 0, maps: p.maps }, ...(p.planes ?? [])]) {
            for (let row = 0; row < p.ny; row++) {
                for (let col = 0; col < p.nx; col++) {
                    const pd = plane.maps.pd[row * p.nx + col];
                    sum += pd;
                    x += pd * (col - p.nx / 2) * p.voxel[0];
                    y += pd * (p.ny / 2 - 1 - row) * p.voxel[1];
                    z += pd * plane.offset * p.voxel[2];
                }
            }
        }
        return { sum, x: x / sum, y: y / sum, z: z / sum };
    }

    it('keeps the PD sum and its centroid, and only real tissues', () => {
        // An off-centre 3-D Shepp–Logan, 64³: every axis halves.
        const volume = sheppLoganVolume(64, 64, [0.256, 0.256, 0.256]);
        const fine = sliceVolume(volume, { index: 37, neighbours: [-37, 26] });
        const coarse = coarsenPhantom(fine)!;
        expect([coarse.nx, coarse.ny, 1 + coarse.planes!.length]).toEqual([32, 32, 33]);
        expect(coarse.voxel.map(v => v / 0.004)).toEqual([2, 2, 2]);
        const a = moments(fine), b = moments(coarse);
        expect(b.sum).toBeCloseTo(a.sum, 1);
        // No shift: the centroid stays within a hundredth of a fine voxel.
        for (const axis of ['x', 'y', 'z'] as const) expect(Math.abs(b[axis] - a[axis])).toBeLessThan(0.04e-3);
        const tissues = new Set(Object.values(TISSUES).map(t => Math.fround(t.t2)));
        for (const plane of [coarse.maps, ...coarse.planes!.map(p => p.maps)]) {
            plane.t2.forEach((t2, i) => { if (plane.pd[i] > 0) expect(tissues.has(t2)).toBe(true); });
        }
    });

    it('halves only axes with an even count of at least 64, and leaves small phantoms alone', () => {
        expect(coarsenPhantom(sheppLoganPhantom2D(32, 0.256, 0.256))).toBeNull();
        const wide = sheppLoganPhantom2D(128, 0.256, 0.256);
        const odd = { ...wide, nx: 127, ny: 128, maps: { pd: wide.maps.pd.subarray(0, 127 * 128), t1: wide.maps.t1.subarray(0, 127 * 128), t2: wide.maps.t2.subarray(0, 127 * 128) } };
        const coarse = coarsenPhantom(odd)!;
        expect([coarse.nx, coarse.ny]).toEqual([127, 64]);
        expect(coarse.voxel[0]).toBe(odd.voxel[0]);
    });

    it('is what a job at the Instant accuracy simulates', () => {
        const bytes = new Uint8Array(readFileSync(join(__dirname, '../seqeyes_demo_seq_files/writeEpiRS.seq')));
        const job = new SimulationJob(bytes, 'epi.seq', { phantom: { kind: 'shepp-logan', size: 128 }, engine: 'phase-graph', tolerance: INSTANT_TOLERANCE });
        expect([job.plan.phantom.nx, job.plan.phantom.ny]).toEqual([64, 64]);
        expect(job.plan.notes.some(note => note.startsWith('Instant: the phantom is simulated at half resolution, 64×64 from 128×128'))).toBe(true);
        const sketch = new SimulationJob(bytes, 'epi.seq', { phantom: { kind: 'shepp-logan', size: 128 }, engine: 'phase-graph', tolerance: 0.25 });
        expect(sketch.plan.phantom.nx).toBe(128);
    });
});

describe('phantom volumes', () => {
    const volume = codedVolume();
    const at = (p: { nx: number; maps: { pd: Float32Array } }, row: number, col: number) => p.maps.pd[row * p.nx + col];

    it('places the xy plane with x across and the largest y on top', () => {
        const plane = sliceVolume(volume, { plane: 'xy', index: 1 });
        expect([plane.nx, plane.ny]).toEqual([5, 4]);
        expect(plane.voxel).toEqual([1e-3, 2e-3, 3e-3]);
        expect(at(plane, 0, 0)).toBe(1 + 0 + 30 + 100);     // top-left: x = 0, y = 3
        expect(at(plane, 3, 4)).toBe(1 + 4 + 0 + 100);      // bottom-right: x = 4, y = 0
    });

    it('slices xz and yz planes with the remaining axis as the slice index', () => {
        const xz = sliceVolume(volume, { plane: 'xz', index: 2 });
        expect([xz.nx, xz.ny]).toEqual([5, 3]);
        expect(at(xz, 0, 1)).toBe(1 + 1 + 20 + 200);        // top row is the largest z
        const yz = sliceVolume(volume, { plane: 'yz', index: 4 });
        expect([yz.nx, yz.ny]).toEqual([4, 3]);
        expect(at(yz, 2, 3)).toBe(1 + 4 + 30 + 0);
        expect(() => sliceVolume(volume, { plane: 'xy', index: 3 })).toThrow(/outside/);
    });

    it('resamples by nearest neighbour and keeps the field of view', () => {
        const plane = sliceVolume(volume, { plane: 'xy', index: 0, matrix: 10 });
        expect([plane.nx, plane.ny]).toEqual([10, 8]);
        expect(plane.voxel[0] * plane.nx).toBeCloseTo(5e-3, 12);
        expect(plane.voxel[1] * plane.ny).toBeCloseTo(8e-3, 12);
        expect(new Set(plane.maps.pd)).toEqual(new Set(sliceVolume(volume, { plane: 'xy', index: 0 }).maps.pd));
    });

    it('invents B0/B1 exactly as MRzero does (numbers from its formula in numpy)', () => {
        const pd = new Float32Array(5 * 4 * 3);
        for (let z = 0; z < 3; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) pd[x + 5 * (y + 4 * z)] = 1 + x;
        const { b0, b1 } = mrzeroFieldMaps({ ...codedVolume(), maps: { ...codedVolume().maps, pd } });
        const expected: [number, number, number, number, number][] = [
            [0, 0, 0, 17.692159430012012, 0.6590957038400354],
            [2, 1, 1, -20.126354567901046, 1.585486418054824],
            [4, 3, 2, 5.848446491762715, 0.6590957038400354],
            [1, 3, 0, -6.77864439143363, 0.8896861408639767],
        ];
        for (const [x, y, z, B0, B1] of expected) {
            expect(b0[x + 5 * (y + 4 * z)]).toBeCloseTo(B0, 3);
            expect(b1[x + 5 * (y + 4 * z)]).toBeCloseTo(B1, 5);
        }
    });

    it('normalises synthetic coils to unit root-sum-of-squares at the centre', () => {
        const coils = syntheticCoils(32, 32, [2e-3, 2e-3, 0], 8);
        const centre = 16 * 32 + 16;
        let power = 0;
        for (let c = 0; c < 8; c++) power += coils.re[c * 1024 + centre] ** 2 + coils.im[c * 1024 + centre] ** 2;
        expect(Math.sqrt(power)).toBeGreaterThan(0.9);
        expect(Math.sqrt(power)).toBeLessThan(1.1);
        const single = syntheticCoils(4, 4, [1e-3, 1e-3, 0], 1);
        expect(Array.from(single.re)).toEqual(new Array(16).fill(1));
    });
});

describe('field maps and coils in a run', () => {
    const path = join(__dirname, '..', 'seqeyes_demo_seq_files', 'writeGradientEcho.seq');
    const bytes = new Uint8Array(readFileSync(path));

    it('folded classes carry B0, B1 and coil sensitivities exactly', () => {
        // Smooth B0 and B1 that vary along both axes, so classes multiply.
        const base = sheppLoganPhantom2D(12, 0.024, 0.024);
        const n = 12 * 12;
        const b0 = new Float32Array(n), b1 = new Float32Array(n);
        for (let row = 0; row < 12; row++) {
            for (let col = 0; col < 12; col++) {
                b0[row * 12 + col] = 3 * (col - 6) - 2 * (row - 6);
                b1[row * 12 + col] = 0.8 + 0.03 * row;
            }
        }
        const phantom = { ...base, maps: { ...base.maps, b0, b1 } };
        const job = new SimulationJob(bytes, path, { phantom: { kind: 'phantom', phantom }, coils: 4, subSpins: [8, 2], throughSlice: 'off' });
        expect(job.plan.coils).toBe(4);
        expect(job.plan.axes[1].folded).toBe(true);
        let total: ChunkAccumulator | null = null;
        for (let chunk = 0; chunk < job.plan.chunks; chunk++) {
            const signal = job.simulateChunk(chunk);
            total ??= new ChunkAccumulator(signal.length, job.plan.chunks);
            total.add(chunk, signal);
        }
        const spins = phantomSpins(job.phantom, { subSpins: [8, 2], voxels: occupiedVoxels(job.phantom) });
        const direct = simulateReference(compileProgram(parseSequenceBytes(bytes, path)), spins).signal;
        let diff = 0, norm = 0;
        for (let i = 0; i < direct.length; i++) {
            diff += (total!.signal[i] - direct[i]) ** 2;
            norm += direct[i] ** 2;
        }
        expect(Math.sqrt(diff / norm)).toBeLessThan(1e-11);
        // Four coils see the object differently.
        const energy = [0, 0, 0, 0];
        for (let s = 0; s < direct.length / 8; s++) for (let c = 0; c < 4; c++) energy[c] += direct[(s * 4 + c) * 2] ** 2;
        expect(Math.max(...energy) / Math.min(...energy)).toBeGreaterThan(1.05);
    });

    it('banded spins per voxel fold exactly, and short-T2 voxels get fewer', () => {
        // Two bands: T2 ≤ 0.1 s gets 4 spins along x, longer T2 gets 16.
        const phantom = sheppLoganPhantom2D(12, 0.024, 0.024);
        const settings = {
            phantom: { kind: 'phantom' as const, phantom },
            subSpins: { kind: 'bands' as const, edges: [0.1, Infinity], counts: [4, 16], y: 2 },
            throughSlice: 'off' as const,
        };
        const job = new SimulationJob(bytes, path, settings);
        expect(job.plan.subSpins).toEqual([16, 2]);
        expect(job.plan.resolved).toEqual(settings.subSpins);
        let total: ChunkAccumulator | null = null;
        for (let chunk = 0; chunk < job.plan.chunks; chunk++) {
            const signal = job.simulateChunk(chunk);
            total ??= new ChunkAccumulator(signal.length, job.plan.chunks);
            total.add(chunk, signal);
        }
        const countX = new Int32Array(12 * 12);
        const voxels = occupiedVoxels(phantom);
        for (const v of voxels) countX[v] = phantom.maps.t2[v] <= 0.1 ? 4 : 16;
        const spins = phantomSpins(phantom, { subSpins: [16, 2], voxels, countX });
        expect(job.plan.spins).toBe(spins.count);
        expect(spins.count).toBeLessThan(voxels.length * 16 * 2);
        const direct = simulateReference(compileProgram(parseSequenceBytes(bytes, path)), spins).signal;
        let diff = 0, norm = 0;
        for (let i = 0; i < direct.length; i++) {
            diff += (total!.signal[i] - direct[i]) ** 2;
            norm += direct[i] ** 2;
        }
        expect(Math.sqrt(diff / norm)).toBeLessThan(1e-11);
    });

    it('reports the raw layout with labels, times and k for every acquisition', () => {
        const labelled = join(__dirname, '..', 'seqeyes_demo_seq_files', 'writeGradientEcho_label.seq');
        const job = new SimulationJob(new Uint8Array(readFileSync(labelled)), labelled,
            { phantom: { kind: 'shepp-logan', size: 16 }, subSpins: [1, 1] });
        const layout = job.rawLayout();
        expect(layout.acquisitions).toBe(job.plan.adcEvents);
        expect(layout.labels.names).toContain('LIN');
        const lin = layout.labels.names.indexOf('LIN');
        const values = new Set<number>();
        for (let a = 0; a < layout.acquisitions; a++) values.add(layout.labels.values[a * layout.labels.names.length + lin]);
        expect(values.size).toBeGreaterThan(8);
        expect(layout.k.length).toBe(3 * job.plan.adcSamples);
        for (let a = 1; a < layout.acquisitions; a++) expect(layout.t0[a]).toBeGreaterThan(layout.t0[a - 1]);
    });
});
