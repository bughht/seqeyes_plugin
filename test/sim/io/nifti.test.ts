import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { getValue } from '../../../src/sim/io/ndarray';
import { readNifti } from '../../../src/sim/io/nifti';
import { expectArray, expected, expectValues, fixture, patched, truncated } from './fixtures';

describe('readNifti', () => {
    for (const [name, wanted] of Object.entries(expected.nifti)) {
        it(`reads ${name} as nibabel does`, () => {
            const image = readNifti(fixture(name));
            // Scaled voxels are computed in float32 here and in float64 by nibabel.
            expectArray(image, wanted, wanted.scaled ? 1e-6 : 0);
            expect(image.version).toBe(wanted.version);
            expect(image.datatype).toBe(wanted.datatype);
            expect(image.littleEndian).toBe(wanted.littleEndian);
            expectValues(image.pixdim, wanted.pixdim, 0, 'pixdim');
            expect([image.spatialUnits, image.temporalUnits]).toEqual([wanted.spatialUnits, wanted.temporalUnits]);
            expectValues(image.voxelSize, wanted.voxelSize, 1e-12, 'voxelSize');
            expectValues(image.affine, wanted.affine, 1e-9, 'affine');
            expect(image.affineSource).toBe(wanted.affineSource);
            expect([image.qformCode, image.sformCode]).toEqual([wanted.qformCode, wanted.sformCode]);
            expect(image.scaled).toBe(wanted.scaled);
            if (wanted.scaled) expect([image.sclSlope, image.sclInter]).toEqual([wanted.sclSlope, wanted.sclInter]);
            expect([image.intentName, image.description]).toEqual([wanted.intentName, wanted.description]);
        });
    }

    it('reads a gzipped file to the same image', () => {
        expect(readNifti(fixture('f32_sform.nii.gz'))).toEqual(readNifti(fixture('f32_sform.nii')));
        expect(readNifti(fixture('i16_scaled_qform.nii.gz'))).toEqual(readNifti(fixture('i16_scaled_qform.nii')));
    });

    it('prefers the sform, then the qform, then pixdim scaling', () => {
        expect(readNifti(fixture('f32_sform.nii')).affineSource).toBe('sform');      // both codes set
        expect(readNifti(fixture('i16_scaled_qform.nii')).affineSource).toBe('qform');
        expect(readNifti(fixture('u8_noaffine.nii')).affineSource).toBe('pixdim');
        // Clearing sform_code (bytes 254–255) makes the reader fall back to the qform.
        const qform = readNifti(patched(patched(fixture('f32_sform.nii'), 254, 0), 255, 0));
        expect(qform.affineSource).toBe('qform');
        expect(qform.affine).toEqual([1.5, 0, 0, 1, 0, 2, 0, 2, 0, 0, 3, 3, 0, 0, 0, 1]);
    });

    it('converts spatial units: the affine to mm, voxel sizes to metres', () => {
        const microns = readNifti(fixture('i16_scaled_qform.nii'));
        expect(microns.spatialUnits).toBe('micron');
        expect(microns.voxelSize).toEqual([0.00025, 0.0005, 0.001]);
        expect(microns.affine[3]).toBeCloseTo(-1, 12);                   // −1000 µm
        const metres = readNifti(fixture('be_f64_4d.nii'));
        expect(metres.affine[3]).toBeCloseTo(100, 4);                   // 0.1 m
    });

    it('keeps x fastest', () => {
        const image = readNifti(fixture('be_f64_4d.nii'));
        expect(image.shape).toEqual([3, 2, 2, 3]);
        // vol[i, j, k, t] = (i·12 + j·6 + k·3 + t)·0.125 − 2 for the C-order original.
        expect(getValue(image, 2, 1, 0, 2)).toBe((2 * 12 + 1 * 6 + 0 * 3 + 2) * 0.125 - 2);
    });

    it('treats a vox_offset below 352 as 352, as nifti1.h specifies, and rejects invalid ones', () => {
        // vox_offset is a float32 at byte 108.
        const withOffset = (value: number) => {
            const bytes = fixture('f32_sform.nii').slice();
            new DataView(bytes.buffer).setFloat32(108, value, true);
            return bytes;
        };
        const reference = readNifti(fixture('f32_sform.nii')).data;
        expect(readNifti(withOffset(0)).data).toEqual(reference);
        expect(readNifti(withOffset(100)).data).toEqual(reference);
        expect(() => readNifti(withOffset(NaN))).toThrow(/invalid vox_offset \(NaN\)/);
        expect(() => readNifti(withOffset(-16))).toThrow(/invalid vox_offset \(-16\)/);
        expect(() => readNifti(withOffset(1e9))).toThrow(/NIfTI data is truncated/);
    });

    it('rejects .hdr/.img pairs and other non-NIfTI input', () => {
        expect(() => readNifti(fixture('pair.hdr'))).toThrow(/header of a NIfTI \.hdr\/\.img pair/);
        expect(() => readNifti(new Uint8Array(400))).toThrow(/Not a NIfTI file: sizeof_hdr/);
        expect(() => readNifti(fixture('vars_v5.mat'))).toThrow(/Not a NIfTI file/);
        const analyze = fixture('f32_sform.nii').slice();
        analyze.fill(0, 344, 348);
        expect(() => readNifti(analyze)).toThrow(/Not a single-file NIfTI-1 image .*Analyze 7\.5/);
    });

    it('names unsupported datatypes', () => {
        expect(() => readNifti(fixture('rgb24.nii'))).toThrow(/NIfTI datatype 128 \(RGB24\) is not supported/);
    });

    it('reports truncated files, plain or gzipped', () => {
        expect(() => readNifti(fixture('f32_sform.nii').subarray(0, 200))).toThrow(/truncated inside its 348-byte header/);
        expect(() => readNifti(truncated(fixture('f32_sform.nii'), 4)))
            .toThrow(/NIfTI data is truncated: 4×5×3 float32 voxels need 240 bytes after offset 352, 236 remain/);
        expect(() => readNifti(truncated(fixture('n2_f64.nii'), 1))).toThrow(/truncated/);
        const gz = fixture('f32_sform.nii.gz');
        expect(() => readNifti(gz.subarray(0, gz.length >> 1))).toThrow(/NIfTI: .*(truncated|corrupt)/);
        expect(() => readNifti(truncated(gz, 4))).toThrow(/NIfTI: .*(truncated|corrupt)/);
    });

    it('checks the gzip CRC and the size in the gzip trailer', () => {
        const gz = fixture('f32_sform.nii.gz');
        expect(() => readNifti(patched(gz, gz.length - 8, gz[gz.length - 8] ^ 1))).toThrow(/gzip checksum mismatch/);
        // A trailer claiming fewer bytes than the header needs means a truncated stream.
        expect(() => readNifti(patched(gz, gz.length - 4, gz[gz.length - 4] - 8))).toThrow(/the content needs 592 bytes/);
    });

    it('reads a gzip stream that carries extra content after the image', () => {
        const nii = fixture('f32_sform.nii');
        const padded = new Uint8Array(nii.length + 100);
        padded.set(nii);
        expect(readNifti(gzipSync(padded)).data).toEqual(readNifti(nii).data);
    });
});
