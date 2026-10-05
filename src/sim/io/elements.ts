/**
 * Decoding of stored array elements into the readers' output types.
 *
 * The NPY, MAT and NIfTI readers all reduce to "n elements of some integer or
 * float type, in some byte order, at some offset". This module does that once:
 * float64 sources and integers wider than 16 bits (which float32 cannot hold
 * exactly) become Float64Array, everything else Float32Array (see NdArray).
 *
 * Data in the host's byte order is viewed as its own typed array and converted
 * by TypedArray.prototype.set, which engines implement natively; only foreign
 * byte orders, 64-bit integers and half floats take a per-element loop.
 */

/** Stored element types, named like NumPy's kind and byte size. */
export type ElementType = 'b1' | 'i1' | 'u1' | 'i2' | 'u2' | 'i4' | 'u4' | 'i8' | 'u8' | 'f2' | 'f4' | 'f8';

/** Output element type: 'f4' → Float32Array, 'f8' → Float64Array. */
export type OutputPrecision = 'f4' | 'f8';

export const ELEMENT_SIZE: Readonly<Record<ElementType, number>> = {
    b1: 1, i1: 1, u1: 1, i2: 2, u2: 2, i4: 4, u4: 4, i8: 8, u8: 8, f2: 2, f4: 4, f8: 8,
};

/** True on little-endian hosts, which is every current browser and Node platform. */
export const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** The output type for a stored type: float64 and integers wider than 16 bits need double precision. */
export function outputPrecision(type: ElementType): OutputPrecision {
    return type === 'f8' || type === 'i4' || type === 'u4' || type === 'i8' || type === 'u8' ? 'f8' : 'f4';
}

/**
 * Decode `count` elements of `type` starting at byte `offset` of `bytes`,
 * taking every `step`-th element (2 picks one half of interleaved complex
 * data), into a fresh array. Callers check that the data is present first, so
 * they can report truncation in their own terms; this only guards the bounds.
 */
export function decodeElements(
    bytes: Uint8Array,
    offset: number,
    count: number,
    type: ElementType,
    littleEndian: boolean,
    precision: OutputPrecision,
    step = 1,
): Float32Array | Float64Array {
    const out = precision === 'f8' ? new Float64Array(count) : new Float32Array(count);
    if (count === 0) return out;
    const size = ELEMENT_SIZE[type];
    const span = (count - 1) * step + 1;
    if (!(offset >= 0 && offset + span * size <= bytes.length)) {
        throw new RangeError(`Element data [${offset}, ${offset + span * size}) lies outside the ${bytes.length}-byte buffer.`);
    }
    if (type === 'i8' || type === 'u8') {
        decodeInt64(bytes, offset, count, type === 'i8', littleEndian, step, out);
    } else if (size === 1 || littleEndian === HOST_LITTLE_ENDIAN) {
        const view = nativeView(bytes, offset, span, type);
        if (type === 'f2') {
            for (let i = 0; i < count; i++) out[i] = halfToNumber(view[i * step]);
        } else if (type === 'b1') {
            // NumPy reads any non-zero byte as True.
            for (let i = 0; i < count; i++) out[i] = view[i * step] === 0 ? 0 : 1;
        } else if (step === 1) {
            out.set(view);
        } else {
            for (let i = 0; i < count; i++) out[i] = view[i * step];
        }
    } else {
        decodeSwapped(bytes, offset, count, type, littleEndian, step, out);
    }
    return out;
}

type NativeArray = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array;

/** `length` elements of `type` at `offset`, as a typed array in host byte order. */
function nativeView(bytes: Uint8Array, offset: number, length: number, type: Exclude<ElementType, 'i8' | 'u8'>): NativeArray {
    const size = ELEMENT_SIZE[type];
    let buffer = bytes.buffer;
    let start = bytes.byteOffset + offset;
    if (start % size !== 0) {
        // Typed-array views must be aligned; an unaligned run is copied once.
        buffer = bytes.slice(offset, offset + length * size).buffer;
        start = 0;
    }
    switch (type) {
        case 'i1': return new Int8Array(buffer, start, length);
        case 'u1': case 'b1': return new Uint8Array(buffer, start, length);
        case 'i2': return new Int16Array(buffer, start, length);
        case 'u2': case 'f2': return new Uint16Array(buffer, start, length);
        case 'i4': return new Int32Array(buffer, start, length);
        case 'u4': return new Uint32Array(buffer, start, length);
        case 'f4': return new Float32Array(buffer, start, length);
        case 'f8': return new Float64Array(buffer, start, length);
    }
}

function decodeSwapped(
    bytes: Uint8Array, offset: number, count: number, type: ElementType, littleEndian: boolean, step: number,
    out: Float32Array | Float64Array,
): void {
    const size = ELEMENT_SIZE[type];
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, ((count - 1) * step + 1) * size);
    const stride = step * size;
    let p = 0;
    switch (type) {
        case 'i2': for (let i = 0; i < count; i++, p += stride) out[i] = view.getInt16(p, littleEndian); break;
        case 'u2': for (let i = 0; i < count; i++, p += stride) out[i] = view.getUint16(p, littleEndian); break;
        case 'f2': for (let i = 0; i < count; i++, p += stride) out[i] = halfToNumber(view.getUint16(p, littleEndian)); break;
        case 'i4': for (let i = 0; i < count; i++, p += stride) out[i] = view.getInt32(p, littleEndian); break;
        case 'u4': for (let i = 0; i < count; i++, p += stride) out[i] = view.getUint32(p, littleEndian); break;
        case 'f4': for (let i = 0; i < count; i++, p += stride) out[i] = view.getFloat32(p, littleEndian); break;
        case 'f8': for (let i = 0; i < count; i++, p += stride) out[i] = view.getFloat64(p, littleEndian); break;
        default: throw new Error(`No byte-swapped decoder for ${type}.`);
    }
}

/**
 * 64-bit integers as high·2³² + low. The sum is exact up to 2⁵³ and otherwise
 * rounds once, to the double nearest the integer (as Number(BigInt) would).
 */
function decodeInt64(
    bytes: Uint8Array, offset: number, count: number, signed: boolean, littleEndian: boolean, step: number,
    out: Float32Array | Float64Array,
): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, ((count - 1) * step + 1) * 8);
    const low = littleEndian ? 0 : 4, high = 4 - low;
    const stride = step * 8;
    for (let i = 0, p = 0; i < count; i++, p += stride) {
        const hi = signed ? view.getInt32(p + high, littleEndian) : view.getUint32(p + high, littleEndian);
        out[i] = hi * 4294967296 + view.getUint32(p + low, littleEndian);
    }
}

/** IEEE 754 binary16 bits → number (exact; every half value is a float32). */
export function halfToNumber(bits: number): number {
    const exponent = (bits >> 10) & 0x1f;
    const fraction = bits & 0x3ff;
    const sign = bits & 0x8000 ? -1 : 1;
    if (exponent === 0) return sign * fraction * 2 ** -24;
    if (exponent === 31) return fraction ? NaN : sign * Infinity;
    return sign * (1024 + fraction) * 2 ** (exponent - 25);
}
