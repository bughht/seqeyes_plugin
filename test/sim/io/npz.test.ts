import { describe, expect, it } from 'vitest';

import { writeNpy } from '../../../src/sim/io/npy';
import { readNpz, writeNpz } from '../../../src/sim/io/npz';
import { readZipDirectory, writeZip } from '../../../src/sim/io/zip';
import { expectArray, expected, fixture, patched, truncated } from './fixtures';

describe('readNpz', () => {
    for (const [name, wanted] of Object.entries(expected.npz)) {
        it(`reads ${name} as NumPy does`, () => {
            const arrays = readNpz(fixture(name));
            expect([...arrays.keys()]).toEqual(wanted.keys);
            for (const key of wanted.keys) expectArray(arrays.get(key)!, wanted.arrays[key]);
        });
    }

    it('reads the sizes from the central directory, not NumPy\'s force_zip64 local headers', () => {
        const bytes = fixture('maps_stored.npz');
        const view = new DataView(bytes.buffer, bytes.byteOffset);
        // np.savez writes 0xFFFFFFFF sizes in every local header (numpy gh-10776).
        expect(view.getUint32(18, true)).toBe(0xffffffff);
        expect(readZipDirectory(bytes)[0].compressedSize).toBeLessThan(0xffffffff);
    });

    it('takes every size and offset from ZIP64 extra fields when the 32-bit ones overflow', () => {
        const [a, b] = readZipDirectory(fixture('zip64.npz'));
        expect([a.name, a.method, a.headerOffset]).toEqual(['a.npy', 0, 0]);
        expect([b.name, b.method, b.size]).toEqual(['b.npy', 8, 134]);
    });

    it('ignores members that are not .npy files', () => {
        const names = readZipDirectory(fixture('with_extras.npz')).map(entry => entry.name);
        expect(names).toEqual(['PD_map.npy', 'sub/', 'notes.txt', 'µ_map.npy']);
        expect([...readNpz(fixture('with_extras.npz')).keys()]).toEqual(['PD_map', 'µ_map']);
    });

    it('rejects non-zip and truncated data', () => {
        expect(() => readNpz(new Uint8Array(100))).toThrow(/end-of-central-directory record is missing/);
        expect(() => readNpz(truncated(fixture('maps_deflated.npz'), 30))).toThrow(/end-of-central-directory/);
        // A gap in the middle shifts the central directory away from where the end record says it is.
        const bytes = fixture('maps_stored.npz');
        const gap = new Uint8Array([...bytes.subarray(0, 200), ...bytes.subarray(300)]);
        expect(() => readNpz(gap)).toThrow(/central directory lies outside the file/);
    });

    it('detects corrupt member data with the CRC-32', () => {
        const stored = fixture('maps_stored.npz');
        const firstData = 30 + 'PD_map.npy'.length + 20 + 128;   // local header, name, ZIP64 extra, NPY header
        expect(() => readNpz(patched(stored, firstData, stored[firstData] ^ 0x40))).toThrow(/'PD_map\.npy' fails its CRC-32 check/);
        const deflated = fixture('maps_deflated.npz');
        expect(() => readNpz(patched(deflated, 100, deflated[100] ^ 0xff))).toThrow(/corrupt/);
    });

    it('refuses compression methods other than stored and DEFLATE, and encryption', () => {
        expect(() => readNpz(fixture('bzip2.npz'))).toThrow(/'x\.npy' uses compression method 12/);
        const bytes = fixture('maps_stored.npz');
        const directory = new DataView(bytes.buffer, bytes.byteOffset).getUint32(bytes.length - 22 + 16, true);
        expect(() => readNpz(patched(bytes, directory + 8, bytes[directory + 8] | 1))).toThrow(/'PD_map\.npy' is encrypted/);
    });

    it('names the member when its NPY data is invalid', () => {
        expect(readNpz(writeNpz([])).size).toBe(0);
        const npy = writeNpy({ shape: [1], data: new Float64Array([1]) });
        npy[1] = 0x41;
        expect(() => readNpz(writeZip([{ name: 'bad.npy', data: npy }], false))).toThrow(/NPZ member 'bad\.npy': Not an NPY file/);
    });
});

describe('writeNpz', () => {
    const arrays = new Map([
        ['PD_map', { shape: [2, 3], data: Float64Array.from({ length: 6 }, (_, i) => i / 7), order: 'F' as const }],
        ['T1_map', { shape: [3], data: new Float32Array([0.8, 1.2, 4]) }],
        ['labels', { shape: [2, 2], data: new Uint8Array([0, 1, 2, 255]) }],
        ['coil', { shape: [2], data: new Float32Array([1, 2]), imag: new Float32Array([-1, 0.5]) }],
        ['µ_map', { shape: [], data: new Int32Array([-7]) }],
    ]);

    for (const compress of [false, true]) {
        it(`round-trips arrays ${compress ? 'deflated' : 'stored'}`, () => {
            const bytes = writeNpz(arrays, { compress });
            expect(readZipDirectory(bytes).map(entry => entry.method)).toEqual(Array(arrays.size).fill(compress ? 8 : 0));
            const read = readNpz(bytes);
            expect([...read.keys()]).toEqual([...arrays.keys()]);
            for (const [key, input] of arrays) {
                const array = read.get(key)!;
                expect(array.shape).toEqual(input.shape);
                expect(array.order).toBe(input.order ?? 'C');
                expect(Array.from(array.data)).toEqual(Array.from(input.data));
                if (input.imag) expect(Array.from(array.imag!)).toEqual(Array.from(input.imag));
            }
            // Fixed timestamps: the same arrays give the same bytes.
            expect(writeNpz(arrays, { compress })).toEqual(bytes);
        });
    }

    it('writes back what readNpz returned', () => {
        const original = readNpz(fixture('maps_deflated.npz'));
        const copy = readNpz(writeNpz(original, { compress: true }));
        for (const [key, array] of original) {
            expect(copy.get(key)!.shape).toEqual(array.shape);
            expect(copy.get(key)!.data).toEqual(array.data);
        }
    });

    it('still reads an archive with bytes prepended to it', () => {
        const bytes = writeNpz(arrays);
        const prefixed = new Uint8Array(bytes.length + 1000);
        prefixed.fill(0x55, 0, 1000);
        prefixed.set(bytes, 1000);
        expect([...readNpz(prefixed).keys()]).toEqual([...arrays.keys()]);
    });

    it('rejects duplicate keys', () => {
        const entry = { shape: [1], data: new Float64Array(1) };
        expect(() => writeNpz([['a', entry], ['a', entry]])).toThrow(/Duplicate NPZ key 'a'/);
    });
});
