/**
 * Real phantoms from MRzero (BrainWeb-derived maps; their licence keeps them
 * out of the repository). These tests run when the files are in
 * test/fixtures/phantom-io/real/ (git-ignored) or in the directory named by
 * SEQEYES_PHANTOM_DIR, and are skipped otherwise. Reference values are from
 * NumPy 2.5 and SciPy 1.18.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readMat5 } from '../../../src/sim/io/mat5';
import { getValue, type NdArray } from '../../../src/sim/io/ndarray';
import { readNpz } from '../../../src/sim/io/npz';
import { FIXTURE_DIR } from './fixtures';

const directory = process.env.SEQEYES_PHANTOM_DIR ?? join(FIXTURE_DIR, 'real');
const available = (name: string) => existsSync(join(directory, name));
const load = (name: string) => new Uint8Array(readFileSync(join(directory, name)));

/** Sum and non-zero count: a checksum of every value that survives a change of summation order. */
function expectTotals(array: NdArray, sum: number, nonZero: number): void {
    let total = 0, count = 0;
    for (const value of array.data) {
        total += value;
        if (value !== 0) count++;
    }
    expect(count).toBe(nonZero);
    expect(Math.abs(total - sum) / Math.abs(sum)).toBeLessThan(1e-10);
}

describe.skipIf(!available('subject05.npz'))('MRzero subject05.npz', () => {
    it('parses five 128³ float64 maps to NumPy\'s values, well within 2 s', () => {
        const bytes = load('subject05.npz');
        const start = performance.now();
        const maps = readNpz(bytes);
        const elapsed = performance.now() - start;
        console.log(`subject05.npz (${(bytes.length / 1e6).toFixed(1)} MB, 5 × 16.8 MB deflated): parsed in ${elapsed.toFixed(0)} ms`);
        expect(elapsed).toBeLessThan(2000);

        expect([...maps.keys()]).toEqual(['T1_map', 'T2_map', 'T2dash_map', 'PD_map', 'D_map']);
        for (const map of maps.values()) {
            expect([map.dtype, map.order, map.shape]).toEqual(['<f8', 'C', [128, 128, 128]]);
            expect(map.data).toBeInstanceOf(Float64Array);
        }
        const values: Record<string, [number, number, number, number, number]> = {
            //          [64,64,64]            [40,70,90]            [100,30,64]          sum                  non-zero
            T1_map: [1.6005859375, 0.8973281452658883, 1.5078803641092327, 1271798.0911371843, 631539],
            T2_map: [0.12088831018518517, 0.07765816400057646, 0.1982271348071088, 305475.97828278993, 631539],
            T2dash_map: [0.3165679542824074, 0.1930145121775472, 0.2574766507730097, 135930.75459818883, 631539],
            PD_map: [0.8038049768518518, 0.7087188355670846, 0.7821991041756972, 519640.2921230304, 631539],
            D_map: [0.876490162037037, 0.6734760051880675, 0.945046958532004, 873476.4330032755, 631539],
        };
        for (const [key, [a, b, c, sum, nonZero]] of Object.entries(values)) {
            const map = maps.get(key)!;
            expect([getValue(map, 64, 64, 64), getValue(map, 40, 70, 90), getValue(map, 100, 30, 64)]).toEqual([a, b, c]);
            expectTotals(map, sum, nonZero);
        }
    });
});

describe.skipIf(!available('subject04_7T-noise.npz'))('MRzero subject04_7T-noise.npz', () => {
    it('reads the FOV and the float32 and float64 maps', () => {
        const maps = readNpz(load('subject04_7T-noise.npz'));
        expect([...maps.keys()]).toEqual(['FOV', 'PD_map', 'T1_map', 'T2_map', 'T2dash_map', 'D_map', 'tissue_gm', 'tissue_wm', 'tissue_csf']);
        expect(Array.from(maps.get('FOV')!.data)).toEqual([0.181, 0.217, 0.181]);
        const pd = maps.get('PD_map')!, t1 = maps.get('T1_map')!, wm = maps.get('tissue_wm')!;
        expect([pd.dtype, pd.shape]).toEqual(['<f4', [120, 144, 120]]);
        expect(pd.data).toBeInstanceOf(Float32Array);
        expect([getValue(pd, 60, 72, 60), getValue(pd, 30, 100, 50)]).toEqual([1.0362815856933594, 0.8073615431785583]);
        expect([getValue(t1, 60, 72, 60), getValue(t1, 30, 100, 50)]).toEqual([4.72468376159668, 1.726089358329773]);
        expectTotals(pd, 528070.2209326411, 644066);
        expect(wm.data).toBeInstanceOf(Float64Array);
        expect(getValue(wm, 26, 52, 55)).toBe(0.6801742985844612);
        expectTotals(wm, 192168.37484189254, 469739);
    });
});

describe.skipIf(!available('numerical_brain_cropped.mat'))('MRzero numerical_brain_cropped.mat', () => {
    it('reads the compressed single-precision volume in MATLAB order', () => {
        const variables = readMat5(load('numerical_brain_cropped.mat'));
        expect(variables.map(v => [v.name, v.kind, v.class])).toEqual([['cropped_brain', 'array', 'single']]);
        const brain = variables[0];
        if (brain.kind !== 'array') throw new Error('cropped_brain is not an array');
        expect([brain.dtype, brain.order, brain.shape]).toEqual(['single', 'F', [141, 161, 5]]);
        expect(brain.data).toBeInstanceOf(Float32Array);
        expect([getValue(brain, 70, 80, 2), getValue(brain, 0, 0, 0), getValue(brain, 100, 40, 4)])
            .toEqual([0.3742991089820862, 0, 0.9830614328384399]);
        expectTotals(brain, 2635.851763640996, 69790);
    });
});
