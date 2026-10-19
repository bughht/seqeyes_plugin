import { describe, expect, it } from 'vitest';

import { decodeElements, halfToNumber } from '../../../src/sim/io/elements';
import { elementCount, getValue, linearIndex, stridesOf, toOrder, type NdArray } from '../../../src/sim/io/ndarray';

/** A C-order array whose value at (i, j, k) is 100·i + 10·j + k. */
function labelled(shape: [number, number, number]): NdArray {
    const data = new Float64Array(elementCount(shape));
    let n = 0;
    for (let i = 0; i < shape[0]; i++) for (let j = 0; j < shape[1]; j++) for (let k = 0; k < shape[2]; k++) data[n++] = 100 * i + 10 * j + k;
    return { dtype: '<f8', shape, order: 'C', data, imag: data.map(v => -v) };
}

describe('NdArray helpers', () => {
    it('counts elements, with 1 for a 0-d array and 0 for an empty one', () => {
        expect(elementCount([])).toBe(1);
        expect(elementCount([3, 0, 2])).toBe(0);
        expect(elementCount([128, 128, 128])).toBe(2097152);
        expect(() => elementCount([2, -1])).toThrow(/Invalid array shape/);
        expect(() => elementCount([1.5])).toThrow(/Invalid array shape/);
    });

    it('computes strides in both orders', () => {
        expect(stridesOf([2, 3, 4], 'C')).toEqual([12, 4, 1]);
        expect(stridesOf([2, 3, 4], 'F')).toEqual([1, 2, 6]);
        expect(stridesOf([], 'C')).toEqual([]);
    });

    it('indexes C and F order data', () => {
        const c = labelled([2, 3, 4]);
        expect(linearIndex(c, [1, 2, 3])).toBe(12 + 8 + 3);
        expect(getValue(c, 1, 2, 3)).toBe(123);
        expect(linearIndex({ shape: [2, 3, 4], order: 'F' }, [1, 2, 3])).toBe(1 + 4 + 18);
        expect(linearIndex({ shape: [], order: 'C' }, [])).toBe(0);
        expect(() => linearIndex(c, [1, 2])).toThrow(/Expected 3 indices/);
        expect(() => linearIndex(c, [2, 0, 0])).toThrow(/out of range for dimension 0/);
        expect(() => getValue(c, 0, 0, -1)).toThrow(/out of range/);
    });

    it('reorders between C and F without changing what the indices address', () => {
        const c = labelled([2, 3, 4]);
        const f = toOrder(c, 'F');
        expect(f.order).toBe('F');
        expect(f.data).toBeInstanceOf(Float64Array);
        for (let i = 0; i < 2; i++) {
            for (let j = 0; j < 3; j++) {
                for (let k = 0; k < 4; k++) {
                    expect(getValue(f, i, j, k)).toBe(100 * i + 10 * j + k);
                    expect(f.imag![linearIndex(f, [i, j, k])]).toBe(-(100 * i + 10 * j + k));
                }
            }
        }
        expect(Array.from(f.data.slice(0, 4))).toEqual([0, 100, 10, 110]);
        expect(toOrder(f, 'C').data).toEqual(c.data);
        expect(toOrder(c, 'C')).toBe(c);
    });

    it('shares the data when both layouts coincide', () => {
        const vector: NdArray = { dtype: '<f4', shape: [1, 5, 1], order: 'C', data: new Float32Array(5) };
        expect(toOrder(vector, 'F').data).toBe(vector.data);
        const empty: NdArray = { dtype: '<f4', shape: [0, 3], order: 'C', data: new Float32Array(0) };
        expect(toOrder(empty, 'F').data.length).toBe(0);
    });
});

describe('element decoding', () => {
    it('converts half floats exactly', () => {
        expect([0x0000, 0x8000, 0x3c00, 0xc000, 0x7bff, 0x0001, 0x0400, 0x7c00, 0xfc00].map(halfToNumber))
            .toEqual([0, -0, 1, -2, 65504, 2 ** -24, 2 ** -14, Infinity, -Infinity]);
        expect(halfToNumber(0x7e00)).toBeNaN();
    });

    it('reads unaligned data in both byte orders', () => {
        const bytes = new Uint8Array(1 + 3 * 8);
        const view = new DataView(bytes.buffer);
        [1.5, -2.25, 1e300].forEach((v, i) => view.setFloat64(1 + 8 * i, v, false));
        expect(Array.from(decodeElements(bytes, 1, 3, 'f8', false, 'f8'))).toEqual([1.5, -2.25, 1e300]);
        [1.5, -2.25, 1e300].forEach((v, i) => view.setFloat64(1 + 8 * i, v, true));
        expect(Array.from(decodeElements(bytes, 1, 3, 'f8', true, 'f8'))).toEqual([1.5, -2.25, 1e300]);
        // A float32 output rounds what float64 holds.
        expect(Array.from(decodeElements(bytes, 1, 2, 'f8', true, 'f4'))).toEqual([1.5, -2.25]);
    });

    it('takes every step-th element for interleaved complex data', () => {
        const pairs = new Float32Array([1, -1, 2, -2, 3, -3]);
        const bytes = new Uint8Array(pairs.buffer);
        expect(Array.from(decodeElements(bytes, 0, 3, 'f4', true, 'f4', 2))).toEqual([1, 2, 3]);
        expect(Array.from(decodeElements(bytes, 4, 3, 'f4', true, 'f4', 2))).toEqual([-1, -2, -3]);
    });

    it('rounds 64-bit integers once, to the nearest double', () => {
        const values = [-(2n ** 63n), -1n, 2n ** 53n + 1n, 2n ** 63n - 1n];
        for (const littleEndian of [true, false]) {
            const bytes = new Uint8Array(8 * values.length);
            const view = new DataView(bytes.buffer);
            values.forEach((v, i) => view.setBigInt64(8 * i, v, littleEndian));
            expect(Array.from(decodeElements(bytes, 0, values.length, 'i8', littleEndian, 'f8'))).toEqual(values.map(Number));
        }
    });

    it('guards the buffer bounds', () => {
        expect(() => decodeElements(new Uint8Array(7), 0, 1, 'f8', true, 'f8')).toThrow(RangeError);
        expect(decodeElements(new Uint8Array(0), 0, 0, 'f8', true, 'f8').length).toBe(0);
    });
});
