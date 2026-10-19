/**
 * Fixtures and expectations for the phantom readers. The files and
 * expected.json come from test/fixtures/phantom-io/make_fixtures.py; the
 * expected values are what NumPy, SciPy or nibabel read from each file.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';

import type { NdArray } from '../../../src/sim/io/ndarray';

export const FIXTURE_DIR = join(__dirname, '..', '..', 'fixtures', 'phantom-io');

export function fixture(name: string): Uint8Array {
    return new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
}

/** JSON has no NaN or infinities; the generator writes them as the strings Number() parses. */
export type JsonNumber = number | 'NaN' | 'Infinity' | '-Infinity';

export interface ExpectedArray {
    dtype: string;
    shape: number[];
    order: 'C' | 'F';
    data: JsonNumber[];
    imag?: JsonNumber[];
}

export type ExpectedMatVariable =
    | ({ name: string; kind: 'array'; class: string } & ExpectedArray)
    | { name: string; kind: 'text'; shape: number[]; rows: string[] }
    | { name: string; kind: 'skipped'; class: string };

export interface ExpectedNifti extends ExpectedArray {
    version: 1 | 2;
    datatype: number;
    littleEndian: boolean;
    pixdim: number[];
    spatialUnits: string;
    temporalUnits: string;
    voxelSize: number[];
    affine: number[];
    affineSource: string;
    qformCode: number;
    sformCode: number;
    scaled: boolean;
    sclSlope?: number;
    sclInter?: number;
    intentName: string;
    description: string;
}

export const expected: {
    npy: Record<string, ExpectedArray>;
    npz: Record<string, { keys: string[]; arrays: Record<string, ExpectedArray> }>;
    mat: Record<string, { variables: ExpectedMatVariable[] }>;
    nifti: Record<string, ExpectedNifti>;
} = JSON.parse(readFileSync(join(FIXTURE_DIR, 'expected.json'), 'utf-8'));

/**
 * Element-wise comparison. Exact by default, with Object.is semantics so a
 * lost sign of zero or a NaN in the wrong place fails; `tolerance` is
 * relative (absolute below 1) for values computed in another precision.
 */
export function expectValues(actual: ArrayLike<number>, wanted: readonly JsonNumber[], tolerance = 0, what = 'value'): void {
    expect(actual.length, `${what} count`).toBe(wanted.length);
    for (let i = 0; i < wanted.length; i++) {
        const want = Number(wanted[i]);
        const got = actual[i];
        const ok = tolerance === 0 || !Number.isFinite(want)
            ? Object.is(got, want)
            : Math.abs(got - want) <= tolerance * Math.max(1, Math.abs(want));
        if (!ok) expect.fail(`${what} ${i}: got ${got}, expected ${want}`);
    }
}

/** Float64Array for float64 and integers wider than 16 bits, Float32Array otherwise (see NdArray). */
export function isWide(dtype: string): boolean {
    return /^[<>|=]?(f8|c16|i4|u4|i8|u8)$/.test(dtype)
        || ['double', 'int32', 'uint32', 'int64', 'uint64', 'float64', 'complex128'].includes(dtype);
}

export function expectArray(actual: NdArray, wanted: ExpectedArray, tolerance = 0): void {
    expect(actual.dtype).toBe(wanted.dtype);
    expect(actual.shape).toEqual(wanted.shape);
    expect(actual.order).toBe(wanted.order);
    const type = isWide(wanted.dtype) ? Float64Array : Float32Array;
    expect(actual.data).toBeInstanceOf(type);
    expectValues(actual.data, wanted.data, tolerance, 'data');
    if (wanted.imag) {
        expect(actual.imag).toBeInstanceOf(type);
        expectValues(actual.imag!, wanted.imag, tolerance, 'imag');
    } else {
        expect(actual.imag).toBeUndefined();
    }
    // Every array owns its whole buffer, so it can be transferred on its own.
    for (const part of [actual.data, actual.imag]) {
        if (part) expect([part.byteOffset, part.byteLength]).toEqual([0, part.buffer.byteLength]);
    }
}

/** A copy of `bytes` with `count` bytes cut from the end. */
export function truncated(bytes: Uint8Array, count: number): Uint8Array {
    return bytes.slice(0, bytes.length - count);
}

/** A copy of `bytes` with the byte at `offset` replaced. */
export function patched(bytes: Uint8Array, offset: number, value: number): Uint8Array {
    const copy = bytes.slice();
    copy[offset] = value;
    return copy;
}
