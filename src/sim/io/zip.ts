/**
 * The ZIP container under .npz files: reading (stored and DEFLATE members,
 * ZIP64) and writing (stored or DEFLATE, ZIP32).
 *
 * Sizes and offsets come from the central directory, never from the local
 * headers: NumPy opens every member with force_zip64 (numpy gh-10776), so its
 * local headers carry 0xFFFFFFFF sizes with the real ones in a ZIP64 extra
 * field, and streamed archives leave them zero. The local header is read only
 * for the length of its name and extra field, which locate the data.
 * fflate's unzipSync is not used: it assumes every ZIP64 extra field holds
 * all three 64-bit values, while writers include only those that overflowed.
 */

import { deflateSync } from 'fflate';
import { crc32, inflateExact } from './compression';

export interface ZipEntry {
    name: string;
    /** 0 = stored, 8 = DEFLATE. */
    method: number;
    compressedSize: number;
    size: number;
    crc32: number;
    /** Position of the local file header in the archive. */
    headerOffset: number;
    encrypted: boolean;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const MAX32 = 0xffffffff;

/** The members listed in an archive's central directory, in order. */
export function readZipDirectory(bytes: Uint8Array): ZipEntry[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEndOfCentralDirectory(view);
    let count = view.getUint16(eocd + 10, true);
    let directorySize = view.getUint32(eocd + 12, true);
    let directoryOffset = view.getUint32(eocd + 16, true);
    let directoryEnd = eocd;
    if (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR) {
        // Python writes the ZIP64 record right before its locator and so do
        // other writers; the locator's own offset is wrong when bytes were
        // prepended to the archive, so it is only the fallback.
        let record = eocd - 20 - 56;
        if (record < 0 || view.getUint32(record, true) !== ZIP64_EOCD) record = readUint64(view, eocd - 12);
        if (!(record >= 0 && record + 56 <= eocd - 20) || view.getUint32(record, true) !== ZIP64_EOCD) {
            throw new Error('Corrupt zip archive: the ZIP64 end-of-central-directory record is missing.');
        }
        count = readUint64(view, record + 32);
        directorySize = readUint64(view, record + 40);
        directoryOffset = readUint64(view, record + 48);
        directoryEnd = record;
    }
    // Offsets are relative to the archive start; anything prepended to it
    // (a self-extractor stub, say) shifts every one of them by this much.
    const shift = directoryEnd - directorySize - directoryOffset;
    if (shift < 0) throw new Error('Corrupt zip archive: the central directory lies outside the file.');

    const entries: ZipEntry[] = [];
    let p = directoryOffset + shift;
    for (let i = 0; i < count; i++) {
        if (p + 46 > directoryEnd || view.getUint32(p, true) !== CENTRAL_HEADER) {
            throw new Error(`Corrupt zip archive: central directory entry ${i + 1} of ${count} is damaged.`);
        }
        const flags = view.getUint16(p + 8, true);
        const nameLength = view.getUint16(p + 28, true);
        const extraLength = view.getUint16(p + 30, true);
        const commentLength = view.getUint16(p + 32, true);
        const nameStart = p + 46;
        if (nameStart + nameLength + extraLength > directoryEnd) {
            throw new Error(`Corrupt zip archive: central directory entry ${i + 1} of ${count} is truncated.`);
        }
        const entry: ZipEntry = {
            name: decodeName(bytes.subarray(nameStart, nameStart + nameLength), (flags & 0x800) !== 0),
            method: view.getUint16(p + 10, true),
            crc32: view.getUint32(p + 16, true),
            compressedSize: view.getUint32(p + 20, true),
            size: view.getUint32(p + 24, true),
            headerOffset: view.getUint32(p + 42, true),
            encrypted: (flags & 1) !== 0,
        };
        applyZip64Extra(view, nameStart + nameLength, extraLength, entry);
        entry.headerOffset += shift;
        entries.push(entry);
        p = nameStart + nameLength + extraLength + commentLength;
    }
    return entries;
}

/** A member's contents, decompressed and checked against its CRC-32. */
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
    const what = `zip member '${entry.name}'`;
    if (entry.encrypted) throw new Error(`${what} is encrypted, which is not supported.`);
    if (entry.method !== 0 && entry.method !== 8) {
        throw new Error(`${what} uses compression method ${entry.method}; only stored and DEFLATE members are supported.`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = entry.headerOffset;
    if (header + 30 > bytes.length || view.getUint32(header, true) !== LOCAL_HEADER) {
        throw new Error(`Corrupt zip archive: the local header of ${what} is missing.`);
    }
    const start = header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
    const end = start + entry.compressedSize;
    if (end > bytes.length) throw new Error(`Zip archive is truncated: ${what} extends past the end of the file.`);
    const raw = bytes.subarray(start, end);
    let data: Uint8Array;
    if (entry.method === 0) {
        if (entry.compressedSize !== entry.size) throw new Error(`Corrupt zip archive: stored ${what} has inconsistent sizes.`);
        data = raw;
    } else {
        data = inflateExact(raw, entry.size, what);
    }
    if (crc32(data) !== entry.crc32) throw new Error(`${what} fails its CRC-32 check; the archive is corrupt.`);
    return data;
}

export interface ZipInput {
    name: string;
    data: Uint8Array;
}

/**
 * A ZIP32 archive of `files`, DEFLATE-compressed when `compress` is set and
 * stored otherwise. Timestamps are fixed at 1980-01-01 so equal input gives
 * byte-identical archives.
 */
export function writeZip(files: readonly ZipInput[], compress: boolean): Uint8Array {
    if (files.length > 0xffff) throw new Error(`A zip archive holds at most 65535 members (got ${files.length}).`);
    const members = files.map(file => {
        const name = encodeUtf8(file.name);
        if (name.length > 0xffff) throw new Error(`Zip member name '${file.name.slice(0, 40)}…' is too long.`);
        const data = compress ? deflateSync(file.data, { level: 6 }) : file.data;
        if (file.data.length >= MAX32 || data.length >= MAX32) {
            throw new Error(`Zip member '${file.name}' is ${file.data.length} bytes; members of 4 GB and more are not supported.`);
        }
        // Bit 11 marks UTF-8 names; ASCII names (whose UTF-8 is no longer
        // than the string) leave it clear, as Python does.
        const flags = name.length !== file.name.length ? 0x800 : 0;
        return { name, data, flags, size: file.data.length, crc: crc32(file.data), offset: 0 };
    });
    const method = compress ? 8 : 0;
    let size = 22;
    for (const member of members) size += 30 + 46 + 2 * member.name.length + member.data.length;
    if (size >= MAX32) throw new Error('The zip archive would reach 4 GB, which is not supported.');

    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    let p = 0;
    for (const member of members) {
        member.offset = p;
        view.setUint32(p, LOCAL_HEADER, true);
        writeCommonFields(view, p + 4, member.flags, method, member.crc, member.data.length, member.size, member.name.length);
        view.setUint16(p + 28, 0, true);                       // extra field length
        out.set(member.name, p + 30);
        out.set(member.data, p + 30 + member.name.length);
        p += 30 + member.name.length + member.data.length;
    }
    const directoryOffset = p;
    for (const member of members) {
        view.setUint32(p, CENTRAL_HEADER, true);
        view.setUint16(p + 4, 20, true);                       // version made by: 2.0, MS-DOS attributes
        writeCommonFields(view, p + 6, member.flags, method, member.crc, member.data.length, member.size, member.name.length);
        // Extra and comment lengths, disk number, internal and external
        // attributes stay zero.
        view.setUint32(p + 42, member.offset, true);
        out.set(member.name, p + 46);
        p += 46 + member.name.length;
    }
    view.setUint32(p, EOCD, true);
    view.setUint16(p + 8, members.length, true);
    view.setUint16(p + 10, members.length, true);
    view.setUint32(p + 12, p - directoryOffset, true);
    view.setUint32(p + 16, directoryOffset, true);
    return out;
}

/** Version needed, flags, method, time, date, CRC, sizes and name length: the layout both headers share. */
function writeCommonFields(
    view: DataView, p: number, flags: number, method: number, crc: number, compressedSize: number, size: number, nameLength: number,
): void {
    view.setUint16(p, 20, true);                                // version needed: 2.0
    view.setUint16(p + 2, flags, true);
    view.setUint16(p + 4, method, true);
    view.setUint16(p + 6, 0, true);                             // 00:00:00
    view.setUint16(p + 8, (1 << 5) | 1, true);                  // 1980-01-01
    view.setUint32(p + 10, crc, true);
    view.setUint32(p + 14, compressedSize, true);
    view.setUint32(p + 18, size, true);
    view.setUint16(p + 22, nameLength, true);
}

function findEndOfCentralDirectory(view: DataView): number {
    // The 22-byte record ends the file, followed only by a comment of up to 64 KiB.
    const last = view.byteLength - 22;
    for (let p = last; p >= 0 && p >= last - 0xffff; p--) {
        if (view.getUint32(p, true) === EOCD && p + 22 + view.getUint16(p + 20, true) <= view.byteLength) return p;
    }
    throw new Error('Not a zip archive, or a truncated one: the end-of-central-directory record is missing.');
}

/**
 * The ZIP64 extended-information field (header 0x0001) holds 64-bit
 * replacements for exactly those fields stored as 0xFFFFFFFF, in the order
 * size, compressed size, header offset.
 */
function applyZip64Extra(view: DataView, start: number, length: number, entry: ZipEntry): void {
    const end = start + length;
    for (let p = start; p + 4 <= end;) {
        const id = view.getUint16(p, true);
        const fieldLength = view.getUint16(p + 2, true);
        if (id === 0x0001) {
            let q = p + 4;
            const fieldEnd = Math.min(q + fieldLength, end);
            const next = (): number => {
                if (q + 8 > fieldEnd) throw new Error(`Corrupt zip archive: the ZIP64 field of '${entry.name}' is too short.`);
                const value = readUint64(view, q);
                q += 8;
                return value;
            };
            if (entry.size === MAX32) entry.size = next();
            if (entry.compressedSize === MAX32) entry.compressedSize = next();
            if (entry.headerOffset === MAX32) entry.headerOffset = next();
            return;
        }
        p += 4 + fieldLength;
    }
}

/** An unsigned 64-bit little-endian integer; exact below 2⁵³, which bounds any array a browser can hold. */
function readUint64(view: DataView, p: number): number {
    return view.getUint32(p + 4, true) * 4294967296 + view.getUint32(p, true);
}

function decodeName(bytes: Uint8Array, utf8: boolean): string {
    // Python marks every non-ASCII name as UTF-8, so unflagged names are ASCII
    // in practice; Latin-1 keeps any stray high bytes readable.
    if (utf8) return new TextDecoder('utf-8').decode(bytes);
    let name = '';
    for (const byte of bytes) name += String.fromCharCode(byte);
    return name;
}

function encodeUtf8(text: string): Uint8Array {
    const out: number[] = [];
    for (const char of text) {
        const c = char.codePointAt(0)!;
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | c >> 6, 0x80 | c & 0x3f);
        else if (c < 0x10000) out.push(0xe0 | c >> 12, 0x80 | c >> 6 & 0x3f, 0x80 | c & 0x3f);
        else out.push(0xf0 | c >> 18, 0x80 | c >> 12 & 0x3f, 0x80 | c >> 6 & 0x3f, 0x80 | c & 0x3f);
    }
    return Uint8Array.from(out);
}
