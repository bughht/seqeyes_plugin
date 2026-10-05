/**
 * MATLAB Level 5 MAT-files: what MATLAB `save -v6`/`-v7` and SciPy's savemat
 * write. MAT v7.3 files are HDF5 containers and are detected and refused.
 *
 * Layout (MathWorks, "MAT-File Format"): a 128-byte header whose last two
 * bytes, 'IM' or 'MI', give the byte order, then one data element per
 * variable. An element is an 8-byte tag (type, byte count) and its data,
 * padded to 8 bytes; data of at most 4 bytes may instead share the tag's
 * 8 bytes ("small data element", flagged by a non-zero upper half of the
 * first word). A variable is an miMATRIX element whose sub-elements are the
 * array flags (class, complex, logical), the dimensions, the name and the
 * real and imaginary parts, or, in v7 files, an miCOMPRESSED element holding
 * the zlib-compressed miMATRIX.
 *
 * MATLAB stores numbers in the smallest type that holds them exactly (a double
 * array of small integers as miUINT8, say), so the stored type of the real and
 * imaginary parts is independent of the class; the output precision follows
 * the class.
 */

import { unzlib } from './compression';
import { decodeElements, ELEMENT_SIZE, type ElementType, type OutputPrecision } from './elements';
import { elementCount, type NdArray } from './ndarray';

export type MatNumericClass = 'double' | 'single' | 'int8' | 'uint8' | 'int16' | 'uint16'
    | 'int32' | 'uint32' | 'int64' | 'uint64' | 'logical';

export type MatClass = MatNumericClass | 'char' | 'cell' | 'struct' | 'object' | 'sparse'
    | 'function_handle' | 'opaque' | 'unknown';

/** A numeric or logical array. `dtype` is the class name; the shape is MATLAB's dimensions. */
export interface MatArray extends NdArray {
    kind: 'array';
    name: string;
    class: MatNumericClass;
    order: 'F';
}

/** A char array, decoded to text. */
export interface MatText {
    kind: 'text';
    name: string;
    class: 'char';
    shape: number[];
    /** The rows of the char matrix (pages of an N-D array follow one another). */
    rows: string[];
    /** The rows joined by '\n': the string itself for the usual 1×N char array. */
    value: string;
}

/** A variable the reader does not convert, and why. */
export interface MatSkipped {
    kind: 'skipped';
    name: string;
    class: MatClass;
    /** MATLAB's dimensions (empty for objects, which do not store them). */
    shape: number[];
    reason: string;
}

export type MatVariable = MatArray | MatText | MatSkipped;

const miINT8 = 1, miUINT8 = 2, miINT16 = 3, miUINT16 = 4, miINT32 = 5, miUINT32 = 6, miINT64 = 12, miUINT64 = 13;
const miMATRIX = 14, miCOMPRESSED = 15, miUTF8 = 16, miUTF16 = 17, miUTF32 = 18;

/** Storage types of numeric data, by mi* code. */
const NUMERIC_STORAGE: Readonly<Record<number, ElementType>> = {
    [miINT8]: 'i1', [miUINT8]: 'u1', [miINT16]: 'i2', [miUINT16]: 'u2', [miINT32]: 'i4', [miUINT32]: 'u4',
    7: 'f4', 9: 'f8', [miINT64]: 'i8', [miUINT64]: 'u8',
};

/** mx class codes 0–17. */
const CLASS_NAMES: readonly MatClass[] = [
    'unknown', 'cell', 'struct', 'object', 'char', 'sparse', 'double', 'single', 'int8', 'uint8',
    'int16', 'uint16', 'int32', 'uint32', 'int64', 'uint64', 'function_handle', 'opaque',
];

const CLASS_PRECISION: Readonly<Record<MatNumericClass, OutputPrecision>> = {
    double: 'f8', single: 'f4', int8: 'f4', uint8: 'f4', int16: 'f4', uint16: 'f4',
    int32: 'f8', uint32: 'f8', int64: 'f8', uint64: 'f8', logical: 'f4',
};

const SKIP_REASONS: Partial<Record<MatClass, string>> = {
    cell: 'cell arrays are not supported; save each cell as its own variable',
    struct: 'structs are not supported; save the fields as variables (save(file, \'-struct\', \'s\'))',
    object: 'MATLAB objects are not supported',
    sparse: 'sparse matrices are not supported; save full(x) instead',
    function_handle: 'function handles are not supported',
};

export const MAT_V73_MESSAGE = 'MAT v7.3 files are HDF5; save with -v7 or use .npz.';

/**
 * The variables of a Level 5 MAT-file, in file order. Numeric and logical
 * arrays and char arrays are converted; cells, structs, objects, sparse
 * matrices and function handles are listed as skipped with the reason.
 * The unnamed element MATLAB appends to hold object data is left out.
 */
export function readMat5(bytes: Uint8Array): MatVariable[] {
    const littleEndian = readHeader(bytes);
    const variables: MatVariable[] = [];
    let pos = 128;
    for (let index = 1; bytes.length - pos >= 8; index++) {
        const what = `MAT variable ${index}`;
        const tag = readTag(bytes, pos, bytes.length, littleEndian, what);
        let variable: MatVariable | null;
        if (tag.type === miCOMPRESSED) {
            const inner = unzlib(bytes.subarray(tag.start, tag.start + tag.length), 8,
                prefix => compressedSize(prefix, littleEndian, what), what);
            const element = readTag(inner, 0, inner.length, littleEndian, what);
            variable = readVariable(inner, element, littleEndian, what);
        } else {
            variable = readVariable(bytes, tag, littleEndian, what);
        }
        if (variable) variables.push(variable);
        // Top-level elements follow one another without padding: miMATRIX
        // lengths are multiples of 8 already, and compressed ones are not padded.
        pos = tag.start + tag.length;
    }
    return variables;
}

/** Validate the 128-byte header; returns the file's byte order. */
function readHeader(bytes: Uint8Array): boolean {
    if (isHdf5(bytes, 0) || isHdf5(bytes, 512)) throw new Error(MAT_V73_MESSAGE);
    if (isMat4(bytes)) throw new Error('MAT v4 (Level 4) files are not supported; save with -v7.');
    if (bytes.length < 128) throw new Error('Not a MAT-file: shorter than the 128-byte header.');
    const indicator = String.fromCharCode(bytes[126], bytes[127]);
    if (indicator !== 'IM' && indicator !== 'MI') throw new Error('Not a MAT-file: the endian indicator is missing.');
    const littleEndian = indicator === 'IM';
    // The version (0x0100) is a 16-bit word in the file's byte order; v7.3 writes 0x0200.
    const major = littleEndian ? bytes[125] : bytes[124];
    if (major === 2) throw new Error(MAT_V73_MESSAGE);
    if (major !== 1) throw new Error(`Unsupported MAT-file version ${major} (Level 5 files are version 1).`);
    return littleEndian;
}

/**
 * Level 4 files start with the first variable's 20-byte header: the type
 * code MOPT (decimal digits: machine ≤ 4, 0, precision ≤ 5, type ≤ 2), rows,
 * columns, the imaginary flag (0 or 1) and the name length including its
 * NUL, in either byte order. Level 5 files start with text instead.
 */
function isMat4(bytes: Uint8Array): boolean {
    if (bytes.length < 20) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, 20);
    return [true, false].some(littleEndian => {
        const [mopt, rows, columns, imagf, nameLength] = [0, 4, 8, 12, 16].map(p => view.getInt32(p, littleEndian));
        return mopt >= 0 && mopt <= 4052 && Math.floor(mopt / 100) % 10 === 0
            && Math.floor(mopt / 10) % 10 <= 5 && mopt % 10 <= 2
            && rows >= 0 && columns >= 0 && (imagf === 0 || imagf === 1) && nameLength >= 1 && nameLength <= 65536;
    });
}

function isHdf5(bytes: Uint8Array, offset: number): boolean {
    const signature = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];   // "\x89HDF\r\n\x1a\n"
    return bytes.length >= offset + 8 && signature.every((byte, i) => bytes[offset + i] === byte);
}

interface Tag {
    type: number;
    /** Offset of the element's data. */
    start: number;
    length: number;
    /** Offset of the next element (after any padding). */
    next: number;
}

function readTag(bytes: Uint8Array, pos: number, end: number, littleEndian: boolean, what: string): Tag {
    if (pos + 8 > end) throw new Error(`${what}: the MAT-file is truncated (an element tag is cut off).`);
    const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 8);
    const first = view.getUint32(0, littleEndian);
    const small = first >>> 16;
    if (small !== 0) {
        if (small > 4) throw new Error(`${what}: corrupt MAT-file (small data element of ${small} bytes).`);
        return { type: first & 0xffff, start: pos + 4, length: small, next: pos + 8 };
    }
    const length = view.getUint32(4, littleEndian);
    const start = pos + 8;
    if (start + length > end) {
        throw new Error(`${what}: the MAT-file is truncated (an element needs ${length} bytes, ${end - start} remain).`);
    }
    return { type: first, start, length, next: Math.min(start + Math.ceil(length / 8) * 8, end) };
}

/** Size of the element an miCOMPRESSED stream decodes to, from its tag. */
function compressedSize(prefix: Uint8Array, littleEndian: boolean, what: string): number {
    if (prefix.length < 8) throw new Error(`${what}: the compressed variable is empty or corrupt.`);
    const view = new DataView(prefix.buffer, prefix.byteOffset, 8);
    const first = view.getUint32(0, littleEndian);
    return first >>> 16 ? 8 : 8 + view.getUint32(4, littleEndian);
}

/** Convert one top-level miMATRIX element; null for an unnamed one. */
function readVariable(bytes: Uint8Array, element: Tag, littleEndian: boolean, what: string): MatVariable | null {
    if (element.type !== miMATRIX) {
        throw new Error(`${what}: expected a MATLAB array (miMATRIX), found data element type ${element.type}; the file is corrupt.`);
    }
    const end = element.start + element.length;
    if (element.length === 0) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const flagsTag = readTag(bytes, element.start, end, littleEndian, what);
    if (flagsTag.type !== miUINT32 || flagsTag.length < 4) throw new Error(`${what}: corrupt MAT-file (no array flags).`);
    const flags = view.getUint32(flagsTag.start, littleEndian);
    const classCode = flags & 0xff;
    const complex = (flags & 0x800) !== 0, logical = (flags & 0x200) !== 0;
    const mclass: MatClass = CLASS_NAMES[classCode] ?? 'unknown';

    if (mclass === 'opaque') {
        // Objects (string, table, datetime, …) store name, type system and
        // class name, then data that only the subsystem element decodes.
        const nameTag = readTag(bytes, flagsTag.next, end, littleEndian, what);
        const name = latin1(bytes, nameTag);
        if (!name) return null;
        let className = 'object';
        try {
            const systemTag = readTag(bytes, nameTag.next, end, littleEndian, what);
            className = latin1(bytes, readTag(bytes, systemTag.next, end, littleEndian, what)) || className;
        } catch {
            // The class name only improves the message.
        }
        return {
            kind: 'skipped', name, class: 'opaque', shape: [],
            reason: `MATLAB ${className} objects are not supported; convert to a numeric or char array (e.g. char(x)) before saving`,
        };
    }

    const dimsTag = readTag(bytes, flagsTag.next, end, littleEndian, what);
    if (dimsTag.type !== miINT32 || dimsTag.length % 4 !== 0 || dimsTag.length === 0) {
        throw new Error(`${what}: corrupt MAT-file (invalid dimensions).`);
    }
    const shape: number[] = [];
    for (let p = dimsTag.start; p < dimsTag.start + dimsTag.length; p += 4) shape.push(view.getInt32(p, littleEndian));
    if (shape.some(size => size < 0)) throw new Error(`${what}: corrupt MAT-file (negative dimension).`);
    const nameTag = readTag(bytes, dimsTag.next, end, littleEndian, what);
    const name = latin1(bytes, nameTag);
    // MATLAB's subsystem data (object storage) is the one unnamed variable.
    if (!name) return null;
    const label = `${what} ('${name}')`;
    const dataStart = nameTag.next;

    if (classCode >= 6 && classCode <= 15) {
        const cls = logical ? 'logical' : mclass as MatNumericClass;
        const count = elementCount(shape);
        const precision = CLASS_PRECISION[cls];
        const real = readNumeric(bytes, dataStart, end, littleEndian, count, shape, precision, `${label}, real part`);
        const array: MatArray = { kind: 'array', name, class: cls, dtype: cls, shape, order: 'F', data: real.data };
        if (complex) array.imag = readNumeric(bytes, real.next, end, littleEndian, count, shape, precision, `${label}, imaginary part`).data;
        return array;
    }
    if (mclass === 'char') return readText(bytes, dataStart, end, littleEndian, name, shape, label);
    return {
        kind: 'skipped', name, class: mclass, shape,
        reason: SKIP_REASONS[mclass] ?? `unknown MATLAB class ${classCode}`,
    };
}

function readNumeric(
    bytes: Uint8Array, pos: number, end: number, littleEndian: boolean, count: number, shape: number[],
    precision: OutputPrecision, what: string,
): { data: Float32Array | Float64Array; next: number } {
    const tag = readTag(bytes, pos, end, littleEndian, what);
    const type = NUMERIC_STORAGE[tag.type];
    if (!type) throw new Error(`${what}: unsupported storage type ${tag.type}.`);
    if (tag.length !== count * ELEMENT_SIZE[type]) {
        throw new Error(`${what}: ${tag.length} bytes of ${type} data do not fit dimensions [${shape.join(', ')}].`);
    }
    return { data: decodeElements(bytes, tag.start, count, type, littleEndian, precision), next: tag.next };
}

/**
 * Char arrays hold UTF-16 code units in column-major order: MATLAB writes
 * them as miUINT16 (or miUTF16), SciPy as miUTF8, old writers as bytes.
 */
function readText(
    bytes: Uint8Array, pos: number, end: number, littleEndian: boolean, name: string, shape: number[], what: string,
): MatVariable {
    const tag = readTag(bytes, pos, end, littleEndian, what);
    const raw = bytes.subarray(tag.start, tag.start + tag.length);
    let text: string;
    if (tag.type === miUTF8) {
        text = new TextDecoder('utf-8').decode(raw);
    } else if (tag.type === miUINT8 || tag.type === miINT8) {
        text = latin1(bytes, tag);
    } else if (tag.type === miUINT16 || tag.type === miUTF16 || tag.type === miINT16) {
        text = fromCodes(decodeElements(bytes, tag.start, tag.length >> 1, 'u2', littleEndian, 'f4'), String.fromCharCode);
    } else if (tag.type === miUTF32 || tag.type === miUINT32) {
        // Values beyond Unicode become U+FFFD, as TextDecoder treats bad UTF-8.
        const codes = Array.from(decodeElements(bytes, tag.start, tag.length >> 2, 'u4', littleEndian, 'f8'),
            code => (code <= 0x10ffff ? code : 0xfffd));
        text = fromCodes(codes, String.fromCodePoint);
    } else {
        return { kind: 'skipped', name, class: 'char', shape, reason: `char data stored as unsupported type ${tag.type}` };
    }
    const count = elementCount(shape);
    let rows: string[];
    if (text.length !== count) {
        // Characters outside the BMP decode to two code units; keep the text whole.
        rows = [text];
    } else {
        const height = shape[0], width = shape.length > 1 ? shape[1] : 1;
        const pages = height * width > 0 ? count / (height * width) : 0;
        rows = [];
        for (let page = 0; page < pages; page++) {
            for (let i = 0; i < height; i++) {
                let row = '';
                for (let j = 0; j < width; j++) row += text[page * height * width + j * height + i];
                rows.push(row);
            }
        }
        if (pages === 0 && height > 0 && width === 0) rows = new Array<string>(height).fill('');
    }
    return { kind: 'text', name, class: 'char', shape, rows, value: rows.join('\n') };
}

function fromCodes(codes: ArrayLike<number>, convert: (...codes: number[]) => string): string {
    let text = '';
    for (let i = 0; i < codes.length; i += 8192) {
        text += convert(...Array.from({ length: Math.min(8192, codes.length - i) }, (_, k) => codes[i + k]));
    }
    return text;
}

function latin1(bytes: Uint8Array, tag: Tag): string {
    let text = '';
    for (let i = tag.start; i < tag.start + tag.length; i++) text += String.fromCharCode(bytes[i]);
    return text;
}
