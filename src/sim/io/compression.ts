/**
 * DEFLATE, zlib and gzip decoding for the phantom readers, built on fflate.
 *
 * fflate's one-shot decoders trust the container's size fields and skip the
 * checksums. Phantoms arrive as user uploads, where neither is safe: the last
 * four bytes of a truncated .nii.gz are compressed data, not the size, so
 * gunzipSync would allocate up to 4 GB for it, and when an output buffer is
 * too small fflate silently drops what does not fit. So these wrappers size
 * every output from the content itself (the caller reads its header from a
 * decoded prefix), decode once into exactly that buffer, and check the
 * stream's CRC-32 or Adler-32 before returning.
 */

import { Inflate, inflateSync } from 'fflate';

/** The decoded size of a stream, worked out from the first bytes of its output. */
export type SizeFromPrefix = (prefix: Uint8Array) => number;

export function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Raw DEFLATE data that must expand to exactly `size` bytes; `what` names it in errors. */
export function inflateExact(deflated: Uint8Array, size: number, what: string): Uint8Array {
    let out: Uint8Array;
    try {
        out = new Uint8Array(size);
    } catch {
        throw new Error(`${what}: cannot allocate ${size} bytes for the decompressed data.`);
    }
    let result: Uint8Array;
    try {
        result = inflateSync(deflated, { out });
    } catch (error) {
        throw new Error(`${what}: the compressed data is corrupt or truncated (${messageOf(error)}).`);
    }
    // A longer stream is cut to `size` without an error; the checksum the
    // caller verifies catches that case.
    if (result.length !== size) {
        throw new Error(`${what}: the compressed data expands to ${result.length} bytes, expected ${size}; the file is corrupt.`);
    }
    return out;
}

/**
 * At least the first `length` bytes that raw DEFLATE data decodes to (fewer
 * only when the whole stream is shorter). Input is fed in growing chunks so a
 * highly compressible stream does not decode far past what was asked for.
 */
export function inflatePrefix(deflated: Uint8Array, length: number, what: string): Uint8Array {
    const parts: Uint8Array[] = [];
    let have = 0;
    const stream = new Inflate(chunk => {
        if (chunk.length) { parts.push(chunk); have += chunk.length; }
    });
    try {
        for (let p = 0, chunk = 1024; p < deflated.length && have < length; chunk *= 2) {
            const end = Math.min(p + chunk, deflated.length);
            stream.push(deflated.subarray(p, end), end === deflated.length);
            p = end;
        }
    } catch (error) {
        throw new Error(`${what}: the compressed data is corrupt or truncated (${messageOf(error)}).`);
    }
    const prefix = new Uint8Array(have);
    let offset = 0;
    for (const part of parts) { prefix.set(part, offset); offset += part.length; }
    return prefix;
}

/** True when `bytes` starts with the gzip magic number. */
export function isGzip(bytes: Uint8Array): boolean {
    return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Decode a single-member gzip file. `sizeOf` gives the decoded size from the
 * first `prefixLength` decoded bytes; the gzip trailer must agree with it
 * (modulo 2³², as stored), or exceed it by trailing content of at most the
 * same size again. Anything else is a truncated or damaged file.
 */
export function gunzip(bytes: Uint8Array, prefixLength: number, sizeOf: SizeFromPrefix, what: string): Uint8Array {
    const start = gzipDataStart(bytes, what);
    const trailer = bytes.length - 8;
    const deflated = bytes.subarray(start, trailer);
    const expectedCrc = readUint32LE(bytes, trailer);
    const storedSize = readUint32LE(bytes, trailer + 4);
    const needed = sizeOf(inflatePrefix(deflated, prefixLength, what));
    const extra = storedSize - needed % 4294967296;
    if (extra < 0 || extra > Math.max(needed, 1 << 20)) {
        throw new Error(`${what}: the gzip data is truncated or corrupt (the content needs ${needed} bytes, `
            + `the gzip trailer records ${storedSize}).`);
    }
    const out = inflateExact(deflated, needed + extra, what);
    if (crc32(out) !== expectedCrc) throw new Error(`${what}: gzip checksum mismatch; the file is corrupt.`);
    return out;
}

/** Offset of the DEFLATE data in a gzip member (RFC 1952 header). */
function gzipDataStart(bytes: Uint8Array, what: string): number {
    if (!isGzip(bytes)) throw new Error(`${what}: not gzip data.`);
    if (bytes.length < 18) throw new Error(`${what}: the gzip file is truncated.`);
    if (bytes[2] !== 8) throw new Error(`${what}: unsupported gzip compression method ${bytes[2]}.`);
    const flags = bytes[3];
    if (flags & 0xe0) throw new Error(`${what}: invalid gzip header flags.`);
    let p = 10;
    if (flags & 0x04) p += 2 + (bytes[p] | bytes[p + 1] << 8);   // FEXTRA
    if (flags & 0x08) { while (p < bytes.length && bytes[p] !== 0) p++; p++; }   // FNAME
    if (flags & 0x10) { while (p < bytes.length && bytes[p] !== 0) p++; p++; }   // FCOMMENT
    if (flags & 0x02) p += 2;                                     // FHCRC
    if (p > bytes.length - 8) throw new Error(`${what}: the gzip file is truncated.`);
    return p;
}

/**
 * Decode a zlib stream (RFC 1950) whose decoded size `sizeOf` gives from the
 * first `prefixLength` decoded bytes, and check its Adler-32.
 */
export function unzlib(bytes: Uint8Array, prefixLength: number, sizeOf: SizeFromPrefix, what: string): Uint8Array {
    if (bytes.length < 6) throw new Error(`${what}: the zlib stream is truncated.`);
    const cmf = bytes[0], flg = bytes[1];
    if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7 || ((cmf << 8) | flg) % 31 !== 0) throw new Error(`${what}: not a zlib stream.`);
    if (flg & 0x20) throw new Error(`${what}: zlib streams with a preset dictionary are not supported.`);
    const deflated = bytes.subarray(2, bytes.length - 4);
    const out = inflateExact(deflated, sizeOf(inflatePrefix(deflated, prefixLength, what)), what);
    const end = bytes.length - 4;
    const expected = (bytes[end] << 24 | bytes[end + 1] << 16 | bytes[end + 2] << 8 | bytes[end + 3]) >>> 0;
    if (adler32(out) !== expected) throw new Error(`${what}: zlib checksum mismatch; the data is corrupt.`);
    return out;
}

export function readUint32LE(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0;
}

// ─── Checksums ───────────────────────────────────────────────────────────

let crcTables: Int32Array | null = null;

/**
 * Slicing-by-8 tables: table k maps a byte to its CRC contribution k bytes
 * further on, so the main loop folds eight bytes per step.
 */
function crcTable(): Int32Array {
    if (crcTables) return crcTables;
    const table = new Int32Array(8 * 256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    for (let n = 0; n < 256; n++) {
        let c = table[n];
        for (let k = 1; k < 8; k++) {
            c = table[c & 0xff] ^ (c >>> 8);
            table[k * 256 + n] = c;
        }
    }
    crcTables = table;
    return table;
}

/** CRC-32 as used by zip and gzip, continuing from `crc` (0 to start). */
export function crc32(bytes: Uint8Array, crc = 0): number {
    const t = crcTable();
    let c = ~crc;
    const n = bytes.length;
    const blocks = n - (n & 7);
    let i = 0;
    for (; i < blocks; i += 8) {
        const a = c ^ (bytes[i] | bytes[i + 1] << 8 | bytes[i + 2] << 16 | bytes[i + 3] << 24);
        c = t[1792 + (a & 0xff)] ^ t[1536 + ((a >>> 8) & 0xff)] ^ t[1280 + ((a >>> 16) & 0xff)] ^ t[1024 + (a >>> 24)]
            ^ t[768 + bytes[i + 4]] ^ t[512 + bytes[i + 5]] ^ t[256 + bytes[i + 6]] ^ t[bytes[i + 7]];
    }
    for (; i < n; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
}

/** Adler-32 as used by zlib. */
export function adler32(bytes: Uint8Array): number {
    let a = 1, b = 0;
    const n = bytes.length;
    for (let i = 0; i < n;) {
        // 5552 bytes is the longest run before the sums need reducing to stay
        // below 2³² (zlib's NMAX), which keeps the arithmetic in fast integers.
        const end = Math.min(i + 5552, n);
        for (; i < end; i++) { a += bytes[i]; b += a; }
        a %= 65521;
        b %= 65521;
    }
    return (b * 65536 + a) >>> 0;
}
