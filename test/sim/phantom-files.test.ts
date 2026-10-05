import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadPhantomFiles, withFieldMode, type PhantomFile } from '../../src/sim/phantom/files';
import { sliceVolume } from '../../src/sim/phantom/model';

const FIXTURES = join(__dirname, '..', 'fixtures', 'sim');
const file = (name: string, dir = FIXTURES): PhantomFile => ({ name, bytes: new Uint8Array(readFileSync(join(dir, name))) });
/** Largest value (a spread would overflow the stack on 128³ maps). */
const peak = (values: ArrayLike<number>) => { let max = -Infinity; for (let i = 0; i < values.length; i++) max = Math.max(max, values[i]); return max; };

describe('phantom files', () => {
    it('reads an MRzero .npz the way MRzero does (maps, FOV, ADC units)', () => {
        const volume = loadPhantomFiles([file('mrzero_like_small.npz')]);
        expect(volume.shape).toEqual([20, 24, 6]);
        expect(volume.voxel.map(v => +v.toFixed(6))).toEqual([0.01, 0.01, 0.01]);
        expect(Object.keys(volume.maps).sort()).toEqual(['adc', 'pd', 't1', 't2', 't2prime']);
        expect(volume.source).toContain('MRzero');
        // D_map is stored in 1e-9 m²/s.
        expect(peak(volume.maps.adc!)).toBeCloseTo(3e-9, 15);
        // x fastest: the volume's (x, y, z) is the file's C-order (x, y, z).
        const centre = 10 + 20 * (12 + 24 * 3);
        expect(volume.maps.t2[centre]).toBeCloseTo(2.0, 6);           // CSF core
        expect(volume.maps.pd[0]).toBe(0);                             // outside the head
    });

    it('reads the MRzero load_mat layout: PD, T1, T2, B0, B1 in a [x, y, 5] array', () => {
        const volume = loadPhantomFiles([file('mrzero_like_2d.mat')]);
        expect(volume.shape).toEqual([20, 24, 1]);
        expect(volume.voxel[0]).toBeCloseTo(0.2 / 20, 12);
        expect(volume.voxel[1]).toBeCloseTo(0.2 / 24, 12);
        expect(Object.keys(volume.maps).sort()).toEqual(['adc', 'b0', 'b1', 'pd', 't1', 't2', 't2prime']);
        expect(volume.notes.join(' ')).toContain('MRzero .mat layout');
        expect(peak(volume.maps.b0!)).toBeGreaterThan(5);
        // The T2′ default MRzero applies.
        expect(volume.maps.t2prime![0]).toBeCloseTo(0.03, 6);
    });

    it('reads one NIfTI map per file, named by suffix', () => {
        const volume = loadPhantomFiles(['maps.nii.gz', 'maps_T1.nii.gz', 'maps_T2.nii.gz'].map(name => file(name)));
        expect(volume.shape).toEqual([20, 24, 6]);
        expect(volume.voxel.map(v => +v.toFixed(6))).toEqual([0.01, 0.01, 0.01]);
        expect(Object.keys(volume.maps).sort()).toEqual(['pd', 't1', 't2']);
        const npz = loadPhantomFiles([file('mrzero_like_small.npz')]);
        expect(Array.from(volume.maps.t1)).toEqual(Array.from(npz.maps.t1));
    });

    it('explains what is missing or ambiguous', () => {
        expect(() => loadPhantomFiles([file('maps_T1.nii.gz')])).toThrow(/proton-density/);
        expect(() => loadPhantomFiles([{ name: 'phantom.json', bytes: new Uint8Array(2) }])).toThrow(/not supported yet/);
        expect(() => loadPhantomFiles([{ name: 'phantom.txt', bytes: new Uint8Array(2) }])).toThrow(/Load one/);
    });

    it('adds MRzero-style B0/B1 only when asked, and can drop them', () => {
        const volume = loadPhantomFiles([file('mrzero_like_small.npz')]);
        expect(volume.maps.b0).toBeUndefined();
        const invented = withFieldMode(volume, 'mrzero');
        expect(invented.maps.b0).toBeDefined();
        expect(invented.notes.join(' ')).toContain('generated as MRzero does');
        expect(withFieldMode(loadPhantomFiles([file('mrzero_like_2d.mat')]), 'none').maps.b0).toBeUndefined();
        // The input is left alone.
        expect(volume.maps.b0).toBeUndefined();
    });

    it('slices a loaded 3-D phantom into the plane the run simulates', () => {
        const plane = sliceVolume(loadPhantomFiles([file('mrzero_like_small.npz')]), { plane: 'xz', index: 12 });
        expect([plane.nx, plane.ny]).toEqual([20, 6]);
        expect(plane.source).toContain('xz plane, y = 12');
    });
});

// The MRzero example phantoms themselves, when present (they are not committed).
const REAL = process.env.SEQEYES_PHANTOM_DIR ?? '';
const real = (name: string) => REAL && existsSync(join(REAL, name));

describe.skipIf(!real('subject05.npz'))('MRzero BrainWeb phantoms', () => {
    it('reads subject05.npz with MRzero\'s default 192 mm FOV', () => {
        const volume = loadPhantomFiles([file('subject05.npz', REAL)]);
        expect(volume.shape).toEqual([128, 128, 128]);
        expect(volume.voxel[0]).toBeCloseTo(0.192 / 128, 12);
        expect(peak(volume.maps.t2)).toBeCloseTo(1.65, 3);
    });

    it.skipIf(!real('subject04_7T-noise.npz'))('reads subject04 with its own FOV', () => {
        const volume = loadPhantomFiles([file('subject04_7T-noise.npz', REAL)]);
        expect(volume.shape).toEqual([120, 144, 120]);
        expect(volume.voxel[1]).toBeCloseTo(0.217 / 144, 9);
    });

    it.skipIf(!real('numerical_brain_cropped.mat'))('reads numerical_brain_cropped.mat', () => {
        const volume = loadPhantomFiles([file('numerical_brain_cropped.mat', REAL)]);
        expect(volume.shape).toEqual([141, 161, 1]);
        expect(volume.maps.b0).toBeDefined();
        expect(volume.maps.b1).toBeDefined();
    });
});
