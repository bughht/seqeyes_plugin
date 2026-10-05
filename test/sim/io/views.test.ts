/**
 * Inputs are often views into larger buffers (a slice of a fetched archive, a
 * worker message), so every reader must honour byteOffset, including odd ones
 * that leave the data unaligned for typed-array views.
 */

import { describe, expect, it } from 'vitest';

import { readMat5 } from '../../../src/sim/io/mat5';
import { readNifti } from '../../../src/sim/io/nifti';
import { readNpy } from '../../../src/sim/io/npy';
import { readNpz } from '../../../src/sim/io/npz';
import { fixture } from './fixtures';

/** `bytes` copied into a larger buffer at `offset`, returned as a view. */
function viewAt(bytes: Uint8Array, offset: number): Uint8Array {
    const host = new Uint8Array(offset + bytes.length + 5).fill(0xa5);
    host.set(bytes, offset);
    return host.subarray(offset, offset + bytes.length);
}

describe('readers on views with a byte offset', () => {
    for (const offset of [1, 3, 8]) {
        it(`read the same values at offset ${offset}`, () => {
            for (const name of ['f8_be_specials.npy', 'c16_be_f.npy', 'f4_f_3d.npy', 'i8.npy']) {
                expect(readNpy(viewAt(fixture(name), offset)), name).toEqual(readNpy(fixture(name)));
            }
            for (const name of ['maps_stored.npz', 'maps_deflated.npz', 'zip64.npz']) {
                expect(readNpz(viewAt(fixture(name), offset)), name).toEqual(readNpz(fixture(name)));
            }
            for (const name of ['vars_v5.mat', 'vars_v7.mat', 'crafted_be.mat']) {
                expect(readMat5(viewAt(fixture(name), offset)), name).toEqual(readMat5(fixture(name)));
            }
            for (const name of ['be_f64_4d.nii', 'n2_f64.nii', 'n2_be_c64.nii.gz', 'i16_scaled_qform.nii.gz']) {
                expect(readNifti(viewAt(fixture(name), offset)), name).toEqual(readNifti(fixture(name)));
            }
        });
    }
});
