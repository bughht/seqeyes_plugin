import { describe, expect, it } from 'vitest';

import { readNpy, readNpyHeader, writeNpy, type NpyWriteInput } from '../../../src/sim/io/npy';
import { expectArray, expected, fixture, patched, truncated } from './fixtures';

describe('readNpy', () => {
    for (const [name, wanted] of Object.entries(expected.npy)) {
        it(`reads ${name} as NumPy does`, () => {
            expectArray(readNpy(fixture(name)), wanted);
        });
    }

    it('keeps the memory order of a Fortran-order file and indexes it correctly', () => {
        const array = readNpy(fixture('f4_f_3d.npy'));
        expect(array.order).toBe('F');
        // a[i, j, k] = (i·20 + j·5 + k)·0.5 − 7 for the C-order original.
        expect(array.data[1 + 3 * 2 + 3 * 4 * 4]).toBe((1 * 20 + 2 * 5 + 4) * 0.5 - 7);
    });

    it('parses all three header versions', () => {
        expect(readNpyHeader(fixture('f8_c_2d.npy')).version).toEqual([1, 0]);
        expect(readNpyHeader(fixture('v2_i2.npy')).version).toEqual([2, 0]);
        expect(readNpyHeader(fixture('v3_f8.npy')).version).toEqual([3, 0]);
    });

    it('rejects files that are not NPY', () => {
        expect(() => readNpy(new Uint8Array([1, 2, 3]))).toThrow(/magic/);
        expect(() => readNpy(fixture('vars_v5.mat'))).toThrow(/magic/);
    });

    it('reports truncation in the header and in the data', () => {
        expect(() => readNpy(fixture('f8_c_2d.npy').subarray(0, 9))).toThrow(/truncated/);
        expect(() => readNpy(fixture('f8_c_2d.npy').subarray(0, 60))).toThrow(/truncated: the header needs 118 bytes/);
        expect(() => readNpy(truncated(fixture('f8_c_2d.npy'), 1))).toThrow(/truncated: shape \(3, 4\) of <f8 needs 96 bytes, 95 remain/);
        expect(() => readNpy(truncated(fixture('c16_be_f.npy'), 8))).toThrow(/truncated/);
    });

    it('names the unsupported dtype', () => {
        expect(() => readNpy(fixture('unicode.npy'))).toThrow(/'<U2' \(Unicode strings\) is not supported/);
        expect(() => readNpy(fixture('object.npy'))).toThrow(/'\|O' \(Python objects\) is not supported/);
        expect(() => readNpy(fixture('datetime.npy'))).toThrow(/'<M8\[D\]' \(datetimes\) is not supported/);
        expect(() => readNpy(fixture('structured.npy'))).toThrow(/structured \(record\) dtypes are not supported/);
    });

    it('rejects unknown format versions and malformed headers', () => {
        expect(() => readNpy(patched(fixture('f8_c_2d.npy'), 6, 4))).toThrow(/version 4\.0 is not supported/);
        expect(() => readNpy(craft("{'descr': '<f8', 'shape': (2,), }"))).toThrow(/'fortran_order'/);
        expect(() => readNpy(craft("{'descr': '<f8', 'fortran_order': False, 'shape': (2, -1), }"))).toThrow(/'shape'/);
        expect(() => readNpy(craft("{'descr': '<f8', 'fortran_order': False, 'shape': __import__('os')}"))).toThrow(/Python literal/);
        expect(() => readNpy(craft("{'descr': '<f8', 'fortran_order': False, 'shape': (2,)"))).toThrow(/Python literal/);
    });

    it('reads Python literal escapes, double quotes and nested lists in the header', () => {
        const array = readNpy(craft('{"descr": "<f8", "fortran_order": False, "shape": (2,), "extra": [\'a\\x41\', (None, True)]}',
            new Float64Array([1.5, -2]).buffer));
        expect(Array.from(array.data)).toEqual([1.5, -2]);
    });
});

describe('writeNpy', () => {
    const cases: [string, NpyWriteInput][] = [
        ['f8_c_2d.npy', { shape: [3, 4], data: Float64Array.from({ length: 12 }, (_, i) => i * 0.25 - 1.5) }],
        ['f4_f_3d.npy', { shape: [3, 4, 5], data: readNpy(fixture('f4_f_3d.npy')).data as Float32Array, order: 'F' }],
        ['scalar.npy', { shape: [], data: new Float64Array([3.5]) }],
        ['empty.npy', { shape: [0, 3], data: new Float32Array(0) }],
        ['u1.npy', { shape: [5], data: new Uint8Array([0, 1, 127, 128, 255]) }],
        ['i1.npy', { shape: [5], data: new Int8Array([-128, -1, 0, 1, 127]) }],
        ['u2.npy', { shape: [4], data: new Uint16Array([0, 1, 65535, 40000]) }],
        ['i4.npy', { shape: [6], data: new Int32Array([-(2 ** 31), -1, 0, 1, 2 ** 31 - 1, 16777217]) }],
        ['c8.npy', {
            shape: [2, 3],
            data: Float32Array.from({ length: 6 }, (_, i) => i * 0.5 - 1),
            imag: Float32Array.from({ length: 6 }, (_, i) => 2 - i * 0.25),
        }],
    ];
    for (const [name, input] of cases) {
        it(`writes the same bytes as np.save for ${name}`, () => {
            expect(writeNpy(input)).toEqual(fixture(name));
        });
    }

    it('round-trips every writable type, including complex128 and Fortran order', () => {
        const inputs: NpyWriteInput[] = [
            { shape: [2, 3], data: new Float64Array([1e-300, -0, NaN, Infinity, 5, 6]), order: 'F' },
            { shape: [4], data: new Uint32Array([0, 1, 2 ** 32 - 1, 7]) },
            { shape: [2, 2], data: new Int16Array([-32768, 1, 2, 32767]) },
            { shape: [3], data: new Float64Array([1, 2, 3]), imag: new Float64Array([-1, 0.5, 1e-10]) },
            { shape: [2], data: new Int32Array([16777217, -5]), imag: new Float32Array([1, 2]) },
        ];
        for (const input of inputs) {
            const array = readNpy(writeNpy(input));
            expect(array.shape).toEqual(input.shape);
            expect(array.order).toBe(input.order ?? 'C');
            expect(Array.from(array.data)).toEqual(Array.from(input.data));
            if (input.imag) expect(Array.from(array.imag!)).toEqual(Array.from(input.imag));
        }
        expect(readNpy(writeNpy(inputs[4])).dtype).toBe('<c16');
    });

    it('pads every header so the data starts on a 64-byte boundary', () => {
        // Empty arrays, so the shapes can be long without the data being large.
        for (const shape of [[0], [123456789012, 0], [0, 8, 9, 10, 11, 12, 13, 14], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]]) {
            const bytes = writeNpy({ shape, data: new Uint8Array(0) });
            const header = readNpyHeader(bytes);
            expect(header.shape).toEqual(shape);
            expect(header.dataOffset % 64).toBe(0);
            expect(header.dataOffset).toBe(bytes.length);
        }
    });

    it('checks the data length against the shape', () => {
        expect(() => writeNpy({ shape: [2, 2], data: new Float64Array(3) })).toThrow(/3 elements but shape \(2, 2\) needs 4/);
        expect(() => writeNpy({ shape: [2], data: new Float64Array(2), imag: new Float64Array(1) })).toThrow(/Imaginary part/);
        expect(() => writeNpy({ shape: [-1], data: new Float64Array(0) })).toThrow(/Invalid array shape/);
    });
});

/** A version 1.0 NPY file with a hand-written header. */
function craft(header: string, data: ArrayBuffer = new ArrayBuffer(16)): Uint8Array {
    let text = header;
    while ((10 + text.length + 1) % 64 !== 0) text += ' ';
    text += '\n';
    const out = new Uint8Array(10 + text.length + data.byteLength);
    out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0, text.length & 0xff, text.length >> 8]);
    for (let i = 0; i < text.length; i++) out[10 + i] = text.charCodeAt(i);
    out.set(new Uint8Array(data), 10 + text.length);
    return out;
}
