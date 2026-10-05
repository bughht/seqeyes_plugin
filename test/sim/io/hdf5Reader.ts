/**
 * A strict reader for the HDF5 subset hdf5.ts writes, used to check its
 * output without libhdf5: every checksum, size field and address is verified,
 * and anything outside the subset fails loudly. The Python tests (h5py,
 * ismrmrd-python) cover what real readers make of the files.
 */

import { lookup3 } from '../../../src/sim/io/hdf5';

export interface ParsedMessage {
    type: number;
    flags: number;
    body: Uint8Array;
}

export interface ParsedObject {
    path: string;
    /** Object header extent [address, end). */
    address: number;
    end: number;
}

export interface ParsedGroup extends ParsedObject {
    /** Child link names in file order. */
    links: string[];
}

export interface ParsedDataset extends ParsedObject {
    dims: number[];
    /** Datatype message body. */
    datatype: Uint8Array;
    /** Fill value message body. */
    fill: Uint8Array;
    /** Undefined (NaN) when the dataset has no storage. */
    dataAddress: number;
    raw: Uint8Array;
}

export interface ParsedFile {
    rootAddress: number;
    /** In visiting order (depth-first, '/' first). */
    groups: ParsedGroup[];
    datasets: Map<string, ParsedDataset>;
}

export interface ParsedCollection {
    address: number;
    size: number;
    objects: Map<number, Uint8Array>;
    /** Free bytes: object 0 (header included) or an implied tail. */
    free: number;
}

class Cursor {
    private readonly view: DataView;

    constructor(readonly bytes: Uint8Array, public at: number) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    u8() { return this.bytes[this.at++]; }
    u16() { const v = this.view.getUint16(this.at, true); this.at += 2; return v; }
    u32() { const v = this.view.getUint32(this.at, true); this.at += 4; return v; }
    /** NaN for the undefined address (all bits set). */
    u64() {
        const lo = this.view.getUint32(this.at, true), hi = this.view.getUint32(this.at + 4, true);
        this.at += 8;
        return hi === 0xffffffff && lo === 0xffffffff ? NaN : hi * 2 ** 32 + lo;
    }
    uint(width: number) {
        let v = 0;
        for (let i = 0; i < width; i++) v += this.bytes[this.at + i] * 2 ** (8 * i);
        this.at += width;
        return v;
    }
    take(n: number) { const v = this.bytes.subarray(this.at, this.at + n); this.at += n; return v; }
    text(n: number) { return String.fromCharCode(...this.take(n)); }
}

function fail(message: string): never {
    throw new Error(`HDF5 check failed: ${message}`);
}

function checkChecksum(bytes: Uint8Array, start: number, end: number, what: string): void {
    const stored = new DataView(bytes.buffer, bytes.byteOffset).getUint32(end, true);
    const computed = lookup3(bytes.subarray(start, end));
    if (stored !== computed) fail(`${what} checksum ${stored.toString(16)} != ${computed.toString(16)}`);
}

/** Messages of a version 2 object header, and the address just past it. */
export function readObjectHeader(bytes: Uint8Array, address: number): { messages: ParsedMessage[]; end: number } {
    const c = new Cursor(bytes, address);
    if (c.text(4) !== 'OHDR') fail(`no object header at ${address}`);
    if (c.u8() !== 2) fail('object header version');
    const flags = c.u8();
    if (flags & ~3) fail(`unexpected object header flags ${flags}`);
    const size = c.uint(1 << (flags & 3));
    const end = c.at + size;
    checkChecksum(bytes, address, end, `object header at ${address}`);
    const messages: ParsedMessage[] = [];
    while (c.at < end) {
        if (end - c.at < 4) fail('gap in object header');
        const type = c.u8(), length = c.u16(), messageFlags = c.u8();
        if (c.at + length > end) fail('message overruns its object header');
        messages.push({ type, flags: messageFlags, body: c.take(length) });
    }
    return { messages, end: end + 4 };
}

export function readHdf5(bytes: Uint8Array): ParsedFile {
    const c = new Cursor(bytes, 0);
    if (![0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a].every(b => c.u8() === b)) fail('signature');
    if (c.u8() !== 2 || c.u8() !== 8 || c.u8() !== 8 || c.u8() !== 0) fail('superblock version or sizes');
    if (c.u64() !== 0) fail('base address');
    if (!Number.isNaN(c.u64())) fail('superblock extension');
    if (c.u64() !== bytes.length) fail('end-of-file address');
    const rootAddress = c.u64();
    checkChecksum(bytes, 0, 44, 'superblock');

    const groups: ParsedGroup[] = [];
    const datasets = new Map<string, ParsedDataset>();
    const visit = (address: number, path: string) => {
        const { messages, end } = readObjectHeader(bytes, address);
        if (messages.some(m => m.type === 0x02)) {
            const group: ParsedGroup = { path, address, end, links: [] };
            groups.push(group);
            const children: [string, number][] = [];
            for (const [i, message] of messages.entries()) {
                const m = new Cursor(message.body, 0);
                if (i === 0) {
                    if (message.type !== 0x02 || message.flags !== 0) fail('link info first');
                    if (m.u8() !== 0 || m.u8() !== 0 || !Number.isNaN(m.u64()) || !Number.isNaN(m.u64())) fail('compact link info');
                } else if (i === 1) {
                    if (message.type !== 0x0a || message.flags !== 1 || message.body.join() !== '0,0') fail('group info second');
                } else {
                    if (message.type !== 0x06 || m.u8() !== 1) fail('link message');
                    const flags = m.u8();
                    if (flags & ~0x13) fail(`link flags ${flags}`);
                    if (flags & 0x10 && m.u8() !== 1) fail('link name charset');
                    const name = new TextDecoder().decode(m.take(m.uint(1 << (flags & 3))));
                    children.push([name, m.u64()]);
                    if (m.at !== message.body.length) fail('link message length');
                }
            }
            group.links = children.map(([name]) => name);
            for (const [name, child] of children) visit(child, path === '/' ? `/${name}` : `${path}/${name}`);
            return;
        }
        if (messages.map(m => m.type).join() !== '1,3,5,8') fail(`dataset ${path} message types`);
        if (messages.map(m => m.flags).join() !== '0,1,1,0') fail(`dataset ${path} message flags`);
        const [space, datatype, fill, layout] = messages.map(m => m.body);
        const s = new Cursor(space, 0);
        if (s.u8() !== 2) fail('dataspace version');
        const rank = s.u8();
        if (s.u8() !== 0) fail('dataspace flags');
        if (s.u8() !== (rank === 0 ? 0 : 1)) fail('dataspace type');
        const dims = Array.from({ length: rank }, () => s.u64());
        if (s.at !== space.length) fail('dataspace length');
        const l = new Cursor(layout, 0);
        if (l.u8() !== 3 || l.u8() !== 1) fail('contiguous layout');
        const dataAddress = l.u64(), size = l.u64();
        if (size === 0 ? !Number.isNaN(dataAddress) : !(dataAddress + size <= bytes.length)) fail(`storage of ${path}`);
        const raw = size === 0 ? new Uint8Array(0) : bytes.subarray(dataAddress, dataAddress + size);
        datasets.set(path, { path, address, end, dims, datatype, fill, dataAddress, raw });
    };
    visit(rootAddress, '/');
    return { rootAddress, groups, datasets };
}

/** The heap collections tiling [start, end of file), checked object by object. */
export function readCollections(bytes: Uint8Array, start: number): ParsedCollection[] {
    const collections: ParsedCollection[] = [];
    for (let address = start; address < bytes.length;) {
        const c = new Cursor(bytes, address);
        if (c.text(4) !== 'GCOL') fail(`no heap collection at ${address}`);
        if (c.u8() !== 1 || c.take(3).some(b => b !== 0)) fail('heap collection version');
        const size = c.u64();
        if (!(size >= 4096) || address + size > bytes.length) fail(`heap collection of ${size} bytes at ${address}`);
        const end = address + size;
        const objects = new Map<number, Uint8Array>();
        let free = 0;
        while (c.at < end) {
            if (end - c.at < 16) {
                free = end - c.at;
                if (bytes.subarray(c.at, end).some(b => b !== 0)) fail('implied free space not zero');
                break;
            }
            const index = c.u16(), refs = c.u16(), reserved = c.u32(), length = c.u64();
            if (refs !== 0 || reserved !== 0) fail('heap object reference count or reserved bytes');
            if (index === 0) {
                if (c.at - 16 + length !== end) fail('free space does not reach the end of its collection');
                free = length;
                if (bytes.subarray(c.at, end).some(b => b !== 0)) fail('free space not zero');
                break;
            }
            if (index !== objects.size + 1) fail(`heap object ${index} out of order`);
            objects.set(index, c.take(length));
            const padding = c.take(Math.ceil(length / 8) * 8 - length);
            if (padding.some(b => b !== 0)) fail('heap object padding not zero');
        }
        collections.push({ address, size, objects, free });
        address = end;
    }
    return collections;
}

/** Resolves the 16-byte variable-length reference at `at` in `raw`: element count and data bytes (empty when nil). */
export function readVlen(bytes: Uint8Array, raw: Uint8Array, at: number): { count: number; data: Uint8Array } {
    const c = new Cursor(raw, at);
    const count = c.u32(), address = c.u64(), index = c.u32();
    if (address === 0) {
        if (count !== 0 || index !== 0) fail('nil reference with a length');
        return { count: 0, data: new Uint8Array(0) };
    }
    const [collection] = readCollections(bytes.subarray(0, address + new Cursor(bytes, address + 8).u64()), address);
    const data = collection.objects.get(index);
    if (!data) fail(`no heap object ${index} in the collection at ${address}`);
    return { count, data };
}
