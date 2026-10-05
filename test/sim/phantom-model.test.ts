import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';
import { simulateReference } from '../../src/sim/engine/reference';
import { ChunkAccumulator, SimulationJob } from '../../src/sim/job';
import { sheppLoganPhantom2D } from '../../src/sim/phantom/builtin';
import {
    mrzeroFieldMaps,
    occupiedVoxels,
    phantomSpins,
    sliceVolume,
    syntheticCoils,
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
        const job = new SimulationJob(bytes, path, { phantom: { kind: 'phantom', phantom }, coils: 4, subSpins: [8, 2] });
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
        const settings = { phantom: { kind: 'phantom' as const, phantom }, subSpins: { kind: 'bands' as const, edges: [0.1, Infinity], counts: [4, 16], y: 2 } };
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
