/**
 * A minimal, deterministic HDF5 writer: the subset of the HDF5 file format
 * (https://docs.hdfgroup.org/hdf5/develop/_f_m_t3.html) needed for groups and
 * contiguous datasets of integer, float, array, compound and variable-length
 * types — what ISMRMRD raw data uses. It is plain TypeScript so simulated data
 * can be exported from a browser without shipping a WASM build of libhdf5.
 *
 * The structure versions are the ones libhdf5 itself writes with libver
 * 'v108', which every HDF5 release since 1.8.0 reads (h5py, MATLAB, the
 * ISMRMRD C library):
 *   - superblock version 2 with 8-byte offsets and lengths;
 *   - version 2 object headers, checksummed with Jenkins' lookup3;
 *   - new-style compact groups (Link Info, Group Info and Link messages);
 *   - datasets with a version 2 dataspace, a version 3 fill value message and
 *     a version 3 contiguous layout;
 *   - variable-length data in global heap collections.
 * No modification times are stored, so identical input gives identical bytes.
 *
 * Everything is laid out in finish(): superblock, object headers (depth-first
 * from the root), each dataset's raw data, then the global heap. A first pass
 * measures the variable-length data, so the file is written into a single
 * allocation of its exact size.
 */

// ─── Datatypes ───────────────────────────────────────────────────────────

/** Little-endian integer, two's complement when signed. */
export interface Hdf5IntegerType {
    readonly kind: 'int';
    readonly size: 1 | 2 | 4 | 8;
    readonly signed: boolean;
}

/** Little-endian IEEE 754 binary32 or binary64. */
export interface Hdf5FloatType {
    readonly kind: 'float';
    readonly size: 4 | 8;
}

/** Fixed-size array of `base`, row-major. */
export interface Hdf5ArrayType {
    readonly kind: 'array';
    readonly base: Hdf5Type;
    readonly dims: readonly number[];
}

export interface Hdf5Member {
    readonly name: string;
    /** Byte offset within the compound. */
    readonly offset: number;
    readonly type: Hdf5Type;
}

/** A struct; members may not overlap or extend past `size`. */
export interface Hdf5CompoundType {
    readonly kind: 'compound';
    readonly size: number;
    readonly members: readonly Hdf5Member[];
}

/** Variable-length sequence of `base` (which may not itself hold variable-length data). */
export interface Hdf5VlenType {
    readonly kind: 'vlen';
    readonly base: Hdf5Type;
}

/** Variable-length, null-terminated string. */
export interface Hdf5StringType {
    readonly kind: 'string';
    /**
     * The character set the file declares; the bytes stored are always the
     * string's UTF-8 encoding. libhdf5 never inspects the bytes, but it will
     * not convert between ASCII and UTF-8 strings, so a reader must ask for
     * the declared set. 'ascii' is what C's H5T_C_S1, and so the ISMRMRD
     * library, uses.
     */
    readonly charset: 'ascii' | 'utf-8';
}

export type Hdf5Type =
    | Hdf5IntegerType
    | Hdf5FloatType
    | Hdf5ArrayType
    | Hdf5CompoundType
    | Hdf5VlenType
    | Hdf5StringType;

function integer(size: 1 | 2 | 4 | 8, signed: boolean): Hdf5IntegerType {
    return Object.freeze({ kind: 'int', size, signed });
}

function float(size: 4 | 8): Hdf5FloatType {
    return Object.freeze({ kind: 'float', size });
}

/** Datatype constructors. */
export const h5t = Object.freeze({
    i8: integer(1, true),
    u8: integer(1, false),
    i16: integer(2, true),
    u16: integer(2, false),
    i32: integer(4, true),
    u32: integer(4, false),
    i64: integer(8, true),
    u64: integer(8, false),
    f32: float(4),
    f64: float(8),
    array(base: Hdf5Type, dims: readonly number[]): Hdf5ArrayType {
        return Object.freeze({ kind: 'array', base, dims: Object.freeze([...dims]) });
    },
    /**
     * A compound with its members packed in order, without padding — numpy's
     * default layout, and the layout of the #pragma pack(2) ISMRMRD structs.
     */
    compound(members: readonly (readonly [name: string, type: Hdf5Type])[]): Hdf5CompoundType {
        let offset = 0;
        const placed = members.map(([name, type]) => {
            const member = Object.freeze({ name, offset, type });
            offset += typeInfo(type).size;
            return member;
        });
        return Object.freeze({ kind: 'compound', size: offset, members: Object.freeze(placed) });
    },
    vlen(base: Hdf5Type): Hdf5VlenType {
        return Object.freeze({ kind: 'vlen', base });
    },
    string(charset: 'ascii' | 'utf-8' = 'utf-8'): Hdf5StringType {
        return Object.freeze({ kind: 'string', charset });
    },
});

/** Bytes one element of `type` occupies in a dataset (16 for variable-length data). */
export function typeSize(type: Hdf5Type): number {
    return typeInfo(type).size;
}

interface TypeInfo {
    size: number;
    /** Holds variable-length data (needs the global heap). */
    vlen: boolean;
    /** Datatype message version: 3 for the compact compound/array encodings, else 1. */
    version: number;
}

/** A variable-length element on disk: length (4), heap collection address (8), object index (4). */
const VLEN_REFERENCE_SIZE = 16;
const MAX_U32 = 0xffffffff;

const typeInfoCache = new WeakMap<Hdf5Type, TypeInfo>();

/** Validates `type` and returns its layout facts; throws on anything HDF5 would reject. */
function typeInfo(type: Hdf5Type): TypeInfo {
    const cached = typeInfoCache.get(type);
    if (cached) return cached;
    let info: TypeInfo;
    switch (type.kind) {
        case 'int':
            if (![1, 2, 4, 8].includes(type.size)) throw new Error(`Integer size must be 1, 2, 4 or 8 bytes, got ${type.size}.`);
            info = { size: type.size, vlen: false, version: 1 };
            break;
        case 'float':
            if (type.size !== 4 && type.size !== 8) throw new Error(`Float size must be 4 or 8 bytes, got ${type.size}.`);
            info = { size: type.size, vlen: false, version: 1 };
            break;
        case 'string':
            if (type.charset !== 'ascii' && type.charset !== 'utf-8') throw new Error(`Unknown string charset '${type.charset}'.`);
            info = { size: VLEN_REFERENCE_SIZE, vlen: true, version: 1 };
            break;
        case 'vlen': {
            const base = typeInfo(type.base);
            if (base.vlen) throw new Error('Variable-length data nested in variable-length data is not supported.');
            // A vlen's version may not be below its base type's (HDF5 rejects it on read).
            info = { size: VLEN_REFERENCE_SIZE, vlen: true, version: base.version };
            break;
        }
        case 'array': {
            const base = typeInfo(type.base);
            if (type.dims.length < 1 || type.dims.length > 32) throw new Error(`An array type needs 1 to 32 dimensions, got ${type.dims.length}.`);
            let count = 1;
            for (const dim of type.dims) {
                if (!Number.isInteger(dim) || dim < 1 || dim > MAX_U32) throw new Error(`Array dimensions must be positive integers, got ${dim}.`);
                count *= dim;
            }
            info = { size: checkedSize(count * base.size), vlen: base.vlen, version: 3 };
            break;
        }
        case 'compound': {
            const { members, size } = type;
            if (!Number.isInteger(size) || size < 1 || size > MAX_U32) throw new Error(`Compound size must be a positive integer, got ${size}.`);
            if (members.length < 1 || members.length > 0xffff) throw new Error(`A compound needs 1 to 65535 members, got ${members.length}.`);
            const names = new Set<string>();
            const spans: [number, number][] = [];
            let vlen = false;
            for (const member of members) {
                if (!member.name || member.name.includes('\0')) throw new Error(`Invalid compound member name '${member.name}'.`);
                if (names.has(member.name)) throw new Error(`Duplicate compound member '${member.name}'.`);
                names.add(member.name);
                const memberInfo = typeInfo(member.type);
                if (!Number.isInteger(member.offset) || member.offset < 0 || member.offset + memberInfo.size > size) {
                    throw new Error(`Member '${member.name}' (offset ${member.offset}, ${memberInfo.size} bytes) does not fit a ${size}-byte compound.`);
                }
                spans.push([member.offset, member.offset + memberInfo.size]);
                vlen ||= memberInfo.vlen;
            }
            spans.sort((a, b) => a[0] - b[0]);
            for (let i = 1; i < spans.length; i++) {
                if (spans[i][0] < spans[i - 1][1]) throw new Error('Compound members overlap.');
            }
            info = { size, vlen, version: 3 };
            break;
        }
        default:
            throw new Error(`Unknown HDF5 type kind '${(type as { kind?: unknown }).kind}'.`);
    }
    typeInfoCache.set(type, info);
    return info;
}

function checkedSize(size: number): number {
    if (size > MAX_U32) throw new Error(`A ${size}-byte datatype is larger than HDF5 allows.`);
    return size;
}

// ─── Checksum ────────────────────────────────────────────────────────────

const rotate = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;

/**
 * Bob Jenkins' lookup3 hashlittle(), which HDF5 uses (as H5_checksum_lookup3)
 * to checksum the superblock, object headers and other version 2 structures.
 */
export function lookup3(data: Uint8Array, initval = 0): number {
    let length = data.length;
    let a = (0xdeadbeef + length + initval) >>> 0;
    let b = a;
    let c = a;
    let k = 0;
    const word = (i: number) => (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) >>> 0;
    while (length > 12) {
        a = (a + word(k)) >>> 0;
        b = (b + word(k + 4)) >>> 0;
        c = (c + word(k + 8)) >>> 0;
        a = ((a - c) ^ rotate(c, 4)) >>> 0; c = (c + b) >>> 0;
        b = ((b - a) ^ rotate(a, 6)) >>> 0; a = (a + c) >>> 0;
        c = ((c - b) ^ rotate(b, 8)) >>> 0; b = (b + a) >>> 0;
        a = ((a - c) ^ rotate(c, 16)) >>> 0; c = (c + b) >>> 0;
        b = ((b - a) ^ rotate(a, 19)) >>> 0; a = (a + c) >>> 0;
        c = ((c - b) ^ rotate(b, 4)) >>> 0; b = (b + a) >>> 0;
        length -= 12;
        k += 12;
    }
    if (length === 0) return c;
    // The last 1–12 bytes, zero-padded: the same sums as lookup3's fall-through switch.
    const tail = new Uint8Array(12);
    tail.set(data.subarray(k, k + length));
    a = (a + (tail[0] | (tail[1] << 8) | (tail[2] << 16) | (tail[3] << 24))) >>> 0;
    b = (b + (tail[4] | (tail[5] << 8) | (tail[6] << 16) | (tail[7] << 24))) >>> 0;
    c = (c + (tail[8] | (tail[9] << 8) | (tail[10] << 16) | (tail[11] << 24))) >>> 0;
    c = ((c ^ b) - rotate(b, 14)) >>> 0;
    a = ((a ^ c) - rotate(c, 11)) >>> 0;
    b = ((b ^ a) - rotate(a, 25)) >>> 0;
    c = ((c ^ b) - rotate(b, 16)) >>> 0;
    a = ((a ^ c) - rotate(c, 4)) >>> 0;
    b = ((b ^ a) - rotate(a, 14)) >>> 0;
    c = ((c ^ b) - rotate(b, 24)) >>> 0;
    return c;
}

// ─── Byte helpers ────────────────────────────────────────────────────────

/** Encoded as eight 0xff bytes: HDF5's "undefined address". */
const UNDEFINED_ADDRESS = -1;
const TWO_POW_32 = 4294967296;
const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const utf8 = new TextEncoder();

function setU64(view: DataView, at: number, value: number): void {
    if (value === UNDEFINED_ADDRESS) {
        view.setUint32(at, MAX_U32, true);
        view.setUint32(at + 4, MAX_U32, true);
        return;
    }
    view.setUint32(at, value % TWO_POW_32, true);
    view.setUint32(at + 4, Math.floor(value / TWO_POW_32), true);
}

/** Growable little-endian byte list, for the small metadata structures. */
class ByteList {
    private buffer = new Uint8Array(64);
    private view = new DataView(this.buffer.buffer);
    length = 0;

    /** Reserves `count` bytes and returns their offset; may replace buffer and view, so call it first. */
    private take(count: number): number {
        const at = this.length;
        if (at + count > this.buffer.length) {
            const grown = new Uint8Array(Math.max(2 * this.buffer.length, at + count));
            grown.set(this.buffer);
            this.buffer = grown;
            this.view = new DataView(grown.buffer);
        }
        this.length += count;
        return at;
    }

    u8(value: number): this {
        const at = this.take(1);
        this.buffer[at] = value;
        return this;
    }

    u16(value: number): this {
        const at = this.take(2);
        this.view.setUint16(at, value, true);
        return this;
    }

    u32(value: number): this {
        const at = this.take(4);
        this.view.setUint32(at, value, true);
        return this;
    }

    /** A non-negative safe integer, or UNDEFINED_ADDRESS. */
    u64(value: number): this {
        const at = this.take(8);
        setU64(this.view, at, value);
        return this;
    }

    /** Unsigned little-endian integer in `width` bytes. */
    uint(value: number, width: number): this {
        const at = this.take(width);
        for (let i = 0; i < width; i++) this.buffer[at + i] = Math.floor(value / 2 ** (8 * i)) & 0xff;
        return this;
    }

    bytes(values: ArrayLike<number>): this {
        const at = this.take(values.length);
        this.buffer.set(values, at);
        return this;
    }

    result(): Uint8Array {
        return this.buffer.slice(0, this.length);
    }
}

// ─── Datatype messages ───────────────────────────────────────────────────

/** Bytes HDF5 uses for a compound member offset: the fewest that can hold the compound's size (H5VM_limit_enc_size). */
function offsetWidth(size: number): number {
    let bits = 0;
    for (let v = size; v >= 1; v = Math.floor(v / 2)) bits++;
    return Math.floor((bits - 1) / 8) + 1;
}

function encodeDatatype(type: Hdf5Type, out: ByteList): void {
    const info = typeInfo(type);
    switch (type.kind) {
        case 'int':
            // Class 0 (fixed-point): bit 3 = signed; bit offset 0, precision = all bits.
            out.u8(0x10).u8(type.signed ? 0x08 : 0).u8(0).u8(0).u32(type.size);
            out.u16(0).u16(8 * type.size);
            break;
        case 'float': {
            // Class 1: implied-MSB mantissa (0x20), sign bit position, IEEE layout.
            const single = type.size === 4;
            out.u8(0x11).u8(0x20).u8(single ? 31 : 63).u8(0).u32(type.size);
            out.u16(0).u16(8 * type.size);
            out.u8(single ? 23 : 52).u8(single ? 8 : 11).u8(0).u8(single ? 23 : 52).u32(single ? 127 : 1023);
            break;
        }
        case 'string':
            // Class 9, type 1 (string), null-terminated; the base is the unsigned
            // char libhdf5 itself records for H5T_C_S1 with H5T_VARIABLE size.
            out.u8(0x19).u8(0x01).u8(type.charset === 'utf-8' ? 1 : 0).u8(0).u32(VLEN_REFERENCE_SIZE);
            encodeDatatype(h5t.u8, out);
            break;
        case 'vlen':
            out.u8((info.version << 4) | 9).u8(0).u8(0).u8(0).u32(VLEN_REFERENCE_SIZE);
            encodeDatatype(type.base, out);
            break;
        case 'array':
            // Class 10, version 3: rank and u32 dimensions, no permutation.
            out.u8(0x3a).u8(0).u8(0).u8(0).u32(info.size).u8(type.dims.length);
            for (const dim of type.dims) out.u32(dim);
            encodeDatatype(type.base, out);
            break;
        case 'compound': {
            // Class 6, version 3: unpadded names, variable-width offsets.
            const count = type.members.length;
            const width = offsetWidth(type.size);
            out.u8(0x36).u8(count & 0xff).u8(count >>> 8).u8(0).u32(type.size);
            for (const member of type.members) {
                out.bytes(utf8.encode(member.name)).u8(0).uint(member.offset, width);
                encodeDatatype(member.type, out);
            }
            break;
        }
    }
}

// ─── Global heap ─────────────────────────────────────────────────────────

const COLLECTION_HEADER_SIZE = 16;
const HEAP_OBJECT_HEADER_SIZE = 16;
/** libhdf5 refuses smaller collections. */
const MIN_COLLECTION_SIZE = 4096;
/**
 * Objects go into one collection until it would pass 4 MiB. A reader loads a
 * whole collection to fetch one object, so collections stay modest; an object
 * larger than this gets a collection of its own, as libhdf5 does.
 */
const TARGET_COLLECTION_SIZE = 4 * 1024 * 1024;
/** Object indices are 16-bit; stay well below the limit. */
const MAX_COLLECTION_OBJECTS = 8192;

const align8 = (n: number) => Math.ceil(n / 8) * 8;

/**
 * Assigns heap objects to collections in arrival order. It depends only on the
 * sequence of object sizes, so the measuring pass and the writing pass, which
 * see the same sequence, agree on every placement.
 */
class HeapPacker {
    /** Bytes in use (header and objects) in each collection so far. */
    readonly used: number[] = [];
    private objects = 0;
    /** Of the last placement. */
    collection = -1;
    index = 0;
    /** Offset of the object's header within its collection. */
    offset = 0;

    place(size: number): void {
        const need = HEAP_OBJECT_HEADER_SIZE + align8(size);
        let last = this.used.length - 1;
        if (last < 0 || this.objects === MAX_COLLECTION_OBJECTS || this.used[last] + need > TARGET_COLLECTION_SIZE) {
            this.used.push(COLLECTION_HEADER_SIZE);
            this.objects = 0;
            last++;
        }
        this.collection = last;
        this.index = ++this.objects;
        this.offset = this.used[last];
        this.used[last] += need;
    }
}

const collectionSize = (used: number) => Math.max(MIN_COLLECTION_SIZE, used);

// ─── Element encoding ────────────────────────────────────────────────────

interface Sink {
    readonly bytes: Uint8Array;
    readonly view: DataView;
}

/** Places one heap object, writes its object header, and returns where its data goes. */
type HeapPut = (size: number) => { collectionAddress: number; index: number; dataAddress: number };

type Measure = (value: unknown) => void;
type Encode = (value: unknown, at: number) => void;

function fail(where: string, expected: string, value: unknown): never {
    const shown = typeof value === 'bigint' ? `${value}n`
        : typeof value === 'string' ? JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)
            : value !== null && typeof value === 'object' ? (value.constructor?.name ?? 'object')
                : String(value);
    throw new Error(`${where}: expected ${expected}, got ${shown}.`);
}

function asArrayLike(value: unknown, where: string): ArrayLike<unknown> {
    if (value === null || typeof value !== 'object' || typeof (value as ArrayLike<unknown>).length !== 'number') {
        fail(where, 'an array', value);
    }
    return value as ArrayLike<unknown>;
}

function asString(value: unknown, where: string): string {
    if (typeof value !== 'string') fail(where, 'a string', value);
    return value;
}

function memberValue(value: unknown, name: string, where: string): unknown {
    if (value === null || typeof value !== 'object') fail(where, 'an object', value);
    const member = (value as Record<string, unknown>)[name];
    if (member === undefined) throw new Error(`${where}: member '${name}' is missing.`);
    return member;
}

/**
 * The raw bytes of `value` when it is a typed array whose elements are
 * exactly `type` on this (little-endian) host, so it can be copied whole.
 */
function rawElements(type: Hdf5Type, value: unknown): Uint8Array | null {
    if (!LITTLE_ENDIAN_HOST || !ArrayBuffer.isView(value) || value instanceof DataView) return null;
    let match = false;
    if (type.kind === 'float') {
        match = type.size === 4 ? value instanceof Float32Array : value instanceof Float64Array;
    } else if (type.kind === 'int') {
        switch (type.size) {
            case 1: match = type.signed ? value instanceof Int8Array : value instanceof Uint8Array; break;
            case 2: match = type.signed ? value instanceof Int16Array : value instanceof Uint16Array; break;
            case 4: match = type.signed ? value instanceof Int32Array : value instanceof Uint32Array; break;
            case 8: match = type.signed ? value instanceof BigInt64Array : value instanceof BigUint64Array; break;
        }
    }
    return match ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
}

/** Visits the variable-length data of a value in encoding order; null when `type` holds none. */
function compileMeasure(type: Hdf5Type, packer: HeapPacker, where: string): Measure | null {
    switch (type.kind) {
        case 'int':
        case 'float':
            return null;
        case 'string':
            return value => packer.place(utf8.encode(asString(value, where)).length);
        case 'vlen': {
            const baseSize = typeInfo(type.base).size;
            return value => {
                const count = asArrayLike(value, where).length;
                // Empty sequences are stored as nil references, without a heap object.
                if (count > 0) packer.place(count * baseSize);
            };
        }
        case 'array': {
            const inner = compileMeasure(type.base, packer, `${where}[]`);
            if (!inner) return null;
            return value => {
                const items = asArrayLike(value, where);
                for (let i = 0; i < items.length; i++) inner(items[i]);
            };
        }
        case 'compound': {
            const parts: [string, Measure][] = [];
            for (const member of type.members) {
                const inner = compileMeasure(member.type, packer, `${where}.${member.name}`);
                if (inner) parts.push([member.name, inner]);
            }
            if (parts.length === 0) return null;
            return value => {
                for (const [name, inner] of parts) inner(memberValue(value, name, where));
            };
        }
    }
}

/** Writes values of `type` into `sink`; heap objects for variable-length data come from `put`. */
function compileEncoder(type: Hdf5Type, sink: Sink, put: HeapPut, where: string): Encode {
    const { bytes, view } = sink;
    switch (type.kind) {
        case 'int': {
            const { size, signed } = type;
            if (size === 8) {
                const min = signed ? -(2n ** 63n) : 0n;
                const max = signed ? 2n ** 63n - 1n : 2n ** 64n - 1n;
                return (value, at) => {
                    const v = typeof value === 'bigint' ? value
                        : Number.isSafeInteger(value) ? BigInt(value as number)
                            : fail(where, 'an integer', value);
                    if (v < min || v > max) fail(where, `an integer in [${min}, ${max}]`, value);
                    if (signed) view.setBigInt64(at, v, true);
                    else view.setBigUint64(at, v, true);
                };
            }
            const bits = 8 * size;
            const min = signed ? -(2 ** (bits - 1)) : 0;
            const max = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
            return (value, at) => {
                if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
                    fail(where, `an integer in [${min}, ${max}]`, value);
                }
                if (size === 1) view.setUint8(at, value & 0xff);
                else if (size === 2) view.setUint16(at, value & 0xffff, true);
                else view.setUint32(at, value >>> 0, true);
            };
        }
        case 'float':
            return (value, at) => {
                if (typeof value !== 'number') fail(where, 'a number', value);
                if (type.size === 4) view.setFloat32(at, value, true);
                else view.setFloat64(at, value, true);
            };
        case 'string':
            return (value, at) => {
                const encoded = utf8.encode(asString(value, where));
                const slot = put(encoded.length);
                writeVlenReference(view, at, encoded.length, slot.collectionAddress, slot.index);
                bytes.set(encoded, slot.dataAddress);
            };
        case 'vlen': {
            const baseSize = typeInfo(type.base).size;
            const writeItems = compileItems(type.base, sink, put, `${where}[]`);
            return (value, at) => {
                const items = asArrayLike(value, where);
                const count = items.length;
                // A nil reference (all zero, as the file buffer already is) reads back as empty.
                if (count === 0) return;
                const slot = put(count * baseSize);
                writeVlenReference(view, at, count, slot.collectionAddress, slot.index);
                writeItems(items, slot.dataAddress);
            };
        }
        case 'array': {
            const count = type.dims.reduce((product, dim) => product * dim, 1);
            const writeItems = compileItems(type.base, sink, put, `${where}[]`);
            return (value, at) => {
                const items = asArrayLike(value, where);
                if (items.length !== count) fail(where, `${count} values`, `${items.length} values`);
                writeItems(items, at);
            };
        }
        case 'compound': {
            const { size } = type;
            const vlen = typeInfo(type).vlen;
            const members = type.members.map(member =>
                [member.name, member.offset, compileEncoder(member.type, sink, put, `${where}.${member.name}`)] as const);
            return (value, at) => {
                // Pre-encoded bytes (e.g. an ISMRMRD header from encodeAcquisitionHeader) are copied as they are.
                if (value instanceof Uint8Array && !vlen) {
                    if (value.length !== size) fail(where, `${size} pre-encoded bytes`, `${value.length} bytes`);
                    bytes.set(value, at);
                    return;
                }
                for (const [name, offset, encode] of members) encode(memberValue(value, name, where), at + offset);
            };
        }
    }
}

/** Writes a run of `base` values (an array's or a sequence's items) starting at `at`. */
function compileItems(base: Hdf5Type, sink: Sink, put: HeapPut, where: string): (items: ArrayLike<unknown>, at: number) => void {
    const encode = compileEncoder(base, sink, put, where);
    const step = typeInfo(base).size;
    return (items, at) => {
        const raw = rawElements(base, items);
        if (raw) {
            sink.bytes.set(raw, at);
            return;
        }
        for (let i = 0; i < items.length; i++) encode(items[i], at + i * step);
    };
}

function writeVlenReference(view: DataView, at: number, count: number, collectionAddress: number, index: number): void {
    view.setUint32(at, count, true);
    setU64(view, at + 4, collectionAddress);
    view.setUint32(at + 12, index, true);
}

// ─── Object headers ──────────────────────────────────────────────────────

const MSG_DATASPACE = 0x01;
const MSG_LINK_INFO = 0x02;
const MSG_DATATYPE = 0x03;
const MSG_FILL_VALUE = 0x05;
const MSG_LINK = 0x06;
const MSG_LAYOUT = 0x08;
const MSG_GROUP_INFO = 0x0a;
/** The message never changes; libhdf5 marks datatype, fill value and group info messages so. */
const MSG_FLAG_CONSTANT = 0x01;

interface Message {
    readonly type: number;
    readonly flags: number;
    readonly body: Uint8Array;
}

function chunkSize(messages: readonly Message[]): number {
    let size = 0;
    for (const message of messages) {
        if (message.body.length > 0xffff) throw new Error(`A ${message.body.length}-byte header message is too large for HDF5.`);
        size += 4 + message.body.length;
    }
    return size;
}

/** Width code (flags bits 0–1) for the "size of chunk #0" field: 1, 2 or 4 bytes. */
const chunkWidthCode = (size: number) => (size <= 0xff ? 0 : size <= 0xffff ? 1 : 2);

function objectHeaderSize(messages: readonly Message[]): number {
    const size = chunkSize(messages);
    // Signature, version, flags, chunk size, messages, checksum.
    return 4 + 1 + 1 + (1 << chunkWidthCode(size)) + size + 4;
}

function writeObjectHeader(sink: Sink, at: number, messages: readonly Message[]): void {
    const { bytes, view } = sink;
    const size = chunkSize(messages);
    const code = chunkWidthCode(size);
    let p = at;
    bytes.set([0x4f, 0x48, 0x44, 0x52], p); // "OHDR"
    bytes[p + 4] = 2;
    bytes[p + 5] = code;
    p += 6;
    if (code === 0) view.setUint8(p, size);
    else if (code === 1) view.setUint16(p, size, true);
    else view.setUint32(p, size, true);
    p += 1 << code;
    for (const message of messages) {
        bytes[p] = message.type;
        view.setUint16(p + 1, message.body.length, true);
        bytes[p + 3] = message.flags;
        bytes.set(message.body, p + 4);
        p += 4 + message.body.length;
    }
    view.setUint32(p, lookup3(bytes.subarray(at, p)), true);
}

function groupMessages(group: GroupNode): Message[] {
    // Compact storage: no fractal heap and no name index (both undefined).
    const linkInfo = new ByteList().u8(0).u8(0).u64(UNDEFINED_ADDRESS).u64(UNDEFINED_ADDRESS).result();
    const messages: Message[] = [
        { type: MSG_LINK_INFO, flags: 0, body: linkInfo },
        { type: MSG_GROUP_INFO, flags: MSG_FLAG_CONSTANT, body: Uint8Array.of(0, 0) },
    ];
    for (const [name, child] of group.children) {
        const encoded = utf8.encode(name);
        const ascii = encoded.every(byte => byte < 0x80);
        const code = encoded.length <= 0xff ? 0 : encoded.length <= 0xffff ? 1 : 2;
        const link = new ByteList().u8(1).u8(code | (ascii ? 0 : 0x10));
        if (!ascii) link.u8(1); // UTF-8 name
        link.uint(encoded.length, 1 << code).bytes(encoded).u64(child.address); // hard link
        messages.push({ type: MSG_LINK, flags: 0, body: link.result() });
    }
    return messages;
}

function datasetMessages(dataset: DatasetNode): Message[] {
    const space = new ByteList().u8(2).u8(dataset.dims.length).u8(0).u8(dataset.dims.length === 0 ? 0 : 1);
    for (const dim of dataset.dims) space.u64(dim);
    const datatype = new ByteList();
    encodeDatatype(dataset.type, datatype);
    // Allocation time late; fill time "if set", except that libhdf5 always
    // writes fill values for variable-length types.
    const fill = Uint8Array.of(3, dataset.vlen ? 0x02 : 0x0a);
    const layout = new ByteList().u8(3).u8(1).u64(dataset.dataAddress).u64(dataset.count * dataset.elementSize);
    return [
        { type: MSG_DATASPACE, flags: 0, body: space.result() },
        { type: MSG_DATATYPE, flags: MSG_FLAG_CONSTANT, body: datatype.result() },
        { type: MSG_FILL_VALUE, flags: MSG_FLAG_CONSTANT, body: fill },
        { type: MSG_LAYOUT, flags: 0, body: layout.result() },
    ];
}

const messagesOf = (node: Node) => (node.kind === 'group' ? groupMessages(node) : datasetMessages(node));

// ─── Writer ──────────────────────────────────────────────────────────────

interface GroupNode {
    readonly kind: 'group';
    /** In insertion order, which is the order of the links in the file. */
    readonly children: Map<string, Node>;
    address: number;
}

interface DatasetNode {
    readonly kind: 'dataset';
    readonly path: string;
    readonly type: Hdf5Type;
    readonly dims: readonly number[];
    readonly elements: ArrayLike<unknown>;
    readonly count: number;
    readonly elementSize: number;
    readonly vlen: boolean;
    address: number;
    dataAddress: number;
}

type Node = GroupNode | DatasetNode;

const SUPERBLOCK_SIZE = 48;

function splitPath(path: string): string[] {
    const parts = path.split('/').filter(part => part.length > 0);
    for (const part of parts) {
        if (part === '.' || part.includes('\0')) throw new Error(`Invalid HDF5 path '${path}'.`);
    }
    return parts;
}

/**
 * Builds an HDF5 file in memory.
 *
 *     const writer = new Hdf5Writer();
 *     writer.dataset('/run/signal', h5t.f32, [rows, columns], samples);
 *     const file = writer.finish();
 *
 * Values follow the type: a number (or a bigint for 64-bit integers) for
 * integers and floats; an array-like (typed arrays included) for arrays and
 * sequences; a string for strings; for compounds, an object keyed by member
 * name, or — for compounds without variable-length members — a Uint8Array of
 * exactly the compound's size, copied verbatim.
 */
export class Hdf5Writer {
    private readonly root: GroupNode = { kind: 'group', children: new Map(), address: 0 };
    private finished = false;

    /** Creates a group and any missing parents; an existing group is left as it is. */
    group(path: string): this {
        this.checkOpen();
        this.groupAt(splitPath(path), path);
        return this;
    }

    /**
     * Adds a dataset (and any missing parent groups). `elements` holds the
     * product of `dims` values in row-major order (one value when `dims` is
     * empty, a scalar). The writer keeps the reference and encodes at
     * finish(), so `elements` must not change before then.
     */
    dataset(path: string, type: Hdf5Type, dims: readonly number[], elements: ArrayLike<unknown>): this {
        this.checkOpen();
        const parts = splitPath(path);
        if (parts.length === 0) throw new Error('A dataset needs a name.');
        const name = parts[parts.length - 1];
        const parent = this.groupAt(parts.slice(0, -1), path);
        if (parent.children.has(name)) throw new Error(`'${path}' already exists.`);
        const info = typeInfo(type);
        let count = 1;
        for (const dim of dims) {
            if (!Number.isSafeInteger(dim) || dim < 0) throw new Error(`Dataset dimensions must be non-negative integers, got ${dim}.`);
            count *= dim;
        }
        if (!Number.isSafeInteger(count * info.size)) throw new Error(`Dataset '${path}' is too large.`);
        if (elements.length !== count) throw new Error(`Dataset '${path}' has ${elements.length} elements for dimensions [${dims.join(', ')}].`);
        parent.children.set(name, {
            kind: 'dataset',
            path: `/${parts.join('/')}`,
            type,
            dims: [...dims],
            elements,
            count,
            elementSize: info.size,
            vlen: info.vlen,
            address: 0,
            dataAddress: UNDEFINED_ADDRESS,
        });
        return this;
    }

    /** Lays out and encodes the file. The writer cannot be used afterwards. */
    finish(): Uint8Array {
        this.checkOpen();
        this.finished = true;
        const nodes: Node[] = [];
        const visit = (node: Node) => {
            nodes.push(node);
            if (node.kind === 'group') for (const child of node.children.values()) visit(child);
        };
        visit(this.root);
        const datasets = nodes.filter((node): node is DatasetNode => node.kind === 'dataset');

        // Pass 1: measure the variable-length data to size the heap collections.
        const measured = new HeapPacker();
        for (const dataset of datasets) {
            const measure = dataset.vlen ? compileMeasure(dataset.type, measured, dataset.path) : null;
            if (measure) forEachElement(dataset, measure);
        }

        // Layout. Header sizes do not depend on the addresses they will hold.
        let end = SUPERBLOCK_SIZE;
        for (const node of nodes) {
            node.address = end;
            end += objectHeaderSize(messagesOf(node));
        }
        for (const dataset of datasets) {
            const size = dataset.count * dataset.elementSize;
            dataset.dataAddress = size > 0 ? end : UNDEFINED_ADDRESS;
            end += size;
        }
        const collections = measured.used.map(used => {
            const address = end;
            end += collectionSize(used);
            return address;
        });
        if (!Number.isSafeInteger(end)) throw new Error('The HDF5 file would be too large.');

        const bytes = new Uint8Array(end);
        const sink: Sink = { bytes, view: new DataView(bytes.buffer) };

        // Pass 2: raw data, with heap objects placed exactly as measured.
        const packer = new HeapPacker();
        const slot = { collectionAddress: 0, index: 0, dataAddress: 0 };
        const put: HeapPut = size => {
            packer.place(size);
            const collectionAddress = collections[packer.collection];
            if (collectionAddress === undefined || packer.used[packer.collection] > measured.used[packer.collection]) {
                throw new Error('Variable-length data changed while the HDF5 file was being written.');
            }
            const at = collectionAddress + packer.offset;
            sink.view.setUint16(at, packer.index, true);
            // Reference count 0 and reserved bytes stay zero, as libhdf5 writes them.
            setU64(sink.view, at + 8, size);
            slot.collectionAddress = collectionAddress;
            slot.index = packer.index;
            slot.dataAddress = at + HEAP_OBJECT_HEADER_SIZE;
            return slot;
        };
        for (const dataset of datasets) {
            if (dataset.count === 0) continue;
            const raw = rawElements(dataset.type, dataset.elements);
            if (raw) {
                bytes.set(raw, dataset.dataAddress);
                continue;
            }
            const encode = compileEncoder(dataset.type, sink, put, dataset.path);
            const { dataAddress, elementSize } = dataset;
            forEachElement(dataset, (value, i) => encode(value, dataAddress + i * elementSize));
        }
        if (packer.used.length !== measured.used.length || packer.used.some((used, k) => used !== measured.used[k])) {
            throw new Error('Variable-length data changed while the HDF5 file was being written.');
        }

        for (const [k, address] of collections.entries()) writeCollectionHeader(sink, address, measured.used[k]);
        for (const node of nodes) writeObjectHeader(sink, node.address, messagesOf(node));
        writeSuperblock(sink, this.root.address, end);
        return bytes;
    }

    private checkOpen(): void {
        if (this.finished) throw new Error('This HDF5 writer has already finished.');
    }

    private groupAt(parts: readonly string[], path: string): GroupNode {
        let group = this.root;
        for (const part of parts) {
            let child = group.children.get(part);
            if (!child) {
                child = { kind: 'group', children: new Map(), address: 0 };
                group.children.set(part, child);
            }
            if (child.kind !== 'group') throw new Error(`'${part}' in '${path}' is a dataset, not a group.`);
            group = child;
        }
        return group;
    }
}

function forEachElement(dataset: DatasetNode, visit: (value: unknown, index: number) => void): void {
    const { elements, count } = dataset;
    let i = 0;
    try {
        for (; i < count; i++) visit(elements[i], i);
    } catch (error) {
        throw new Error(`Dataset ${dataset.path}, element ${i}: ${(error as Error).message}`);
    }
}

function writeCollectionHeader(sink: Sink, at: number, used: number): void {
    const { bytes, view } = sink;
    const size = collectionSize(used);
    bytes.set([0x47, 0x43, 0x4f, 0x4c], at); // "GCOL"
    bytes[at + 4] = 1;
    setU64(view, at + 8, size);
    // Free space is "object 0", whose size counts its own header. A remainder
    // too small for that header is implied free space, as libhdf5 reads it.
    const free = size - used;
    if (free >= HEAP_OBJECT_HEADER_SIZE) setU64(view, at + used + 8, free);
}

function writeSuperblock(sink: Sink, rootAddress: number, endOfFile: number): void {
    const { bytes, view } = sink;
    bytes.set([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes[8] = 2; // superblock version
    bytes[9] = 8; // size of offsets
    bytes[10] = 8; // size of lengths
    bytes[11] = 0; // file consistency flags
    setU64(view, 12, 0); // base address
    setU64(view, 20, UNDEFINED_ADDRESS); // no superblock extension
    setU64(view, 28, endOfFile);
    setU64(view, 36, rootAddress);
    view.setUint32(44, lookup3(bytes.subarray(0, 44)), true);
}
