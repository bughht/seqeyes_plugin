import { describe, expect, it } from 'vitest';

import { MAT_V73_MESSAGE, readMat5, type MatVariable } from '../../../src/sim/io/mat5';
import { getValue } from '../../../src/sim/io/ndarray';
import { expectArray, expected, fixture, patched, truncated, type ExpectedMatVariable } from './fixtures';

function expectVariable(actual: MatVariable, wanted: ExpectedMatVariable): void {
    expect([actual.name, actual.kind]).toEqual([wanted.name, wanted.kind]);
    if (wanted.kind === 'array' && actual.kind === 'array') {
        expect(actual.class).toBe(wanted.class);
        expectArray(actual, wanted);
    } else if (wanted.kind === 'text' && actual.kind === 'text') {
        expect(actual.shape).toEqual(wanted.shape);
        expect(actual.rows).toEqual(wanted.rows);
        expect(actual.value).toBe(wanted.rows.join('\n'));
    } else if (wanted.kind === 'skipped' && actual.kind === 'skipped') {
        expect(actual.class).toBe(wanted.class);
        expect(actual.reason.length).toBeGreaterThan(10);
    }
}

describe('readMat5', () => {
    for (const [name, wanted] of Object.entries(expected.mat)) {
        it(`reads ${name} as SciPy does`, () => {
            const variables = readMat5(fixture(name));
            expect(variables.map(v => v.name)).toEqual(wanted.variables.map(v => v.name));
            variables.forEach((variable, i) => expectVariable(variable, wanted.variables[i]));
        });
    }

    it('gives the same variables whether or not the file is compressed', () => {
        expect(readMat5(fixture('vars_v7.mat'))).toEqual(readMat5(fixture('vars_v5.mat')));
        expect(readMat5(fixture('crafted_le_zlib.mat'))).toEqual(readMat5(fixture('crafted_be.mat')));
    });

    it('indexes a 3-D array in MATLAB order', () => {
        const sgl3 = readMat5(fixture('vars_v7.mat')).find(v => v.name === 'sgl3');
        if (sgl3?.kind !== 'array') throw new Error('sgl3 is not an array');
        expect(sgl3.order).toBe('F');
        // sgl3(i, j, k) = ((i·20 + j·5 + k)·0.25 − 3, zero-based) in the NumPy original.
        expect(getValue(sgl3, 2, 1, 3)).toBe((2 * 20 + 1 * 5 + 3) * 0.25 - 3);
    });

    it('explains why it skips structs, cells, sparse matrices and objects', () => {
        const reasons = Object.fromEntries(readMat5(fixture('vars_v5.mat'))
            .flatMap(v => (v.kind === 'skipped' ? [[v.name, v.reason]] : [])));
        expect(reasons.st).toMatch(/structs are not supported/);
        expect(reasons.cel).toMatch(/cell arrays are not supported/);
        expect(reasons.sp).toMatch(/sparse matrices are not supported; save full\(x\)/);
        const objects = readMat5(fixture('objects.mat'));
        expect(objects.find(v => v.name === 'obj')).toMatchObject({ kind: 'skipped', reason: expect.stringMatching(/MATLAB string objects/) });
        expect(objects.find(v => v.name === 'fh')).toMatchObject({ kind: 'skipped', reason: 'function handles are not supported' });
    });

    it('refuses v7.3 (HDF5) and v4 files with a clear message', () => {
        expect(() => readMat5(fixture('v73.mat'))).toThrow(MAT_V73_MESSAGE);
        expect(MAT_V73_MESSAGE).toBe('MAT v7.3 files are HDF5; save with -v7 or use .npz.');
        // A bare HDF5 file (no MATLAB user block) is refused the same way.
        expect(() => readMat5(fixture('v73.mat').subarray(512))).toThrow(MAT_V73_MESSAGE);
        expect(() => readMat5(fixture('v4.mat'))).toThrow(/MAT v4 \(Level 4\) files are not supported/);
    });

    it('rejects files that are not MAT-files', () => {
        expect(() => readMat5(new Uint8Array(0))).toThrow(/shorter than the 128-byte header/);
        // Zeros pass for neither a Level 5 header nor a Level 4 variable header (name length 0).
        expect(() => readMat5(new Uint8Array(256))).toThrow(/Not a MAT-file: the endian indicator is missing/);
        expect(() => readMat5(fixture('f32_sform.nii'))).toThrow(/Not a MAT-file: the endian indicator is missing/);
        expect(() => readMat5(patched(fixture('vars_v5.mat'), 125, 3))).toThrow(/Unsupported MAT-file version 3/);
    });

    it('reports truncation, plain or compressed', () => {
        const plain = fixture('vars_v5.mat');
        expect(() => readMat5(plain.subarray(0, 600))).toThrow(/MAT variable \d+: the MAT-file is truncated/);
        expect(() => readMat5(truncated(plain, 3))).toThrow(/truncated/);
        expect(() => readMat5(truncated(fixture('vars_v7.mat'), 20))).toThrow(/truncated/);
    });

    it('detects corrupt compressed data', () => {
        const bytes = fixture('vars_v7.mat');
        // Byte 128 + 8 + 2 is inside the first variable's DEFLATE stream.
        expect(() => readMat5(patched(bytes, 140, bytes[140] ^ 0x55))).toThrow(/MAT variable 1: .*(corrupt|checksum)/);
        // The Adler-32 trailer of the first compressed element.
        const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(132, true);
        expect(() => readMat5(patched(bytes, 136 + length - 1, bytes[136 + length - 1] ^ 1))).toThrow(/zlib checksum mismatch/);
    });

    it('rejects data that does not fit the dimensions', () => {
        const bytes = fixture('crafted_be.mat');
        // dbl_u8: tag at 128, flags 136–151, dims tag at 152 with [2, 3] at 160–167.
        expect(() => readMat5(patched(bytes, 167, 4))).toThrow(/'dbl_u8'.*6 bytes of u1 data do not fit dimensions \[2, 4\]/);
    });
});
