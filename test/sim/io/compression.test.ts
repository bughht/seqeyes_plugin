import { deflateSync, gzipSync, zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { adler32, crc32, gunzip, inflateExact, inflatePrefix, unzlib } from '../../../src/sim/io/compression';

const ascii = (text: string) => Uint8Array.from(text, c => c.charCodeAt(0));

/** Vitest's deep equality walks typed arrays element by element; this finds the first difference directly. */
function expectSameBytes(actual: Uint8Array, wanted: Uint8Array): void {
    expect(actual.length).toBe(wanted.length);
    expect(actual.findIndex((byte, i) => byte !== wanted[i]), 'first differing byte').toBe(-1);
}

/** Deterministic bytes that compress, but not trivially. */
function sample(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    let state = 12345;
    for (let i = 0; i < length; i++) {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        bytes[i] = (state >>> 24) % 16 + (i % 7);
    }
    return bytes;
}

describe('checksums', () => {
    it('match the reference CRC-32 and Adler-32 values', () => {
        expect(crc32(ascii('123456789'))).toBe(0xcbf43926);
        expect(crc32(new Uint8Array(0))).toBe(0);
        expect(adler32(ascii('Wikipedia'))).toBe(0x11e60398);
        expect(adler32(new Uint8Array(0))).toBe(1);
    });

    it('compute CRC-32 incrementally and on lengths that are not multiples of 8', () => {
        const data = sample(1003);
        expect(crc32(data.subarray(500), crc32(data.subarray(0, 500)))).toBe(crc32(data));
        // Bytewise reference.
        let c = ~0;
        for (const byte of data) {
            c ^= byte;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        expect(crc32(data)).toBe(~c >>> 0);
    });

    it('reduce Adler-32 sums on long inputs', () => {
        const data = new Uint8Array(100_000).fill(0xff);
        let a = 1, b = 0;
        for (const byte of data) { a = (a + byte) % 65521; b = (b + a) % 65521; }
        expect(adler32(data)).toBe((b * 65536 + a) >>> 0);
    });
});

describe('decompression', () => {
    const data = sample(200_000);

    it('inflates into a buffer of exactly the expected size', () => {
        expectSameBytes(inflateExact(deflateSync(data), data.length, 'test'), data);
        expect(() => inflateExact(deflateSync(data), data.length + 1, 'test')).toThrow(/expands to 200000 bytes, expected 200001/);
        expect(() => inflateExact(deflateSync(data).subarray(0, 1000), data.length, 'test')).toThrow(/test: the compressed data is corrupt or truncated/);
    });

    it('decodes only about as much as a prefix needs', () => {
        const prefix = inflatePrefix(deflateSync(data), 100, 'test');
        expect(prefix.length).toBeGreaterThanOrEqual(100);
        expect(prefix.length).toBeLessThan(data.length);
        expectSameBytes(prefix, data.subarray(0, prefix.length));
        expect(inflatePrefix(deflateSync(data.subarray(0, 10)), 100, 'test')).toEqual(data.subarray(0, 10));
    });

    it('unzlib sizes the output from the prefix and checks the Adler-32', () => {
        const stream = zlibSync(data);
        expectSameBytes(unzlib(stream, 8, () => data.length, 'test'), data);
        const damaged = stream.slice();
        damaged[damaged.length - 1] ^= 1;
        expect(() => unzlib(damaged, 8, () => data.length, 'test')).toThrow(/zlib checksum mismatch/);
        expect(() => unzlib(new Uint8Array([1, 2, 3, 4, 5, 6]), 8, () => 0, 'test')).toThrow(/not a zlib stream/);
    });

    it('gunzip trusts the content, not a truncated trailer', () => {
        const gz = gzipSync(data);
        expectSameBytes(gunzip(gz, 16, () => data.length, 'test'), data);
        // Cut in half, the last four bytes are compressed data, not a size.
        expect(() => gunzip(gz.subarray(0, gz.length >> 1), 16, () => data.length, 'test')).toThrow(/test: .*(truncated|corrupt)/);
        expect(() => gunzip(ascii('not gzip at all'), 16, () => 0, 'test')).toThrow(/not gzip data/);
    });
});
