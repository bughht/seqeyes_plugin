/**
 * NumPy .npy files (format versions 1.0, 2.0 and 3.0).
 *
 * The header is a Python dict literal, e.g.
 *   {'descr': '<f8', 'fortran_order': False, 'shape': (128, 128, 128), }
 * NumPy reads it with ast.literal_eval; here a small parser accepts the same
 * literal subset (dicts, tuples, lists, strings, numbers, True/False/None),
 * so a crafted header can never run code.
 */

import { decodeElements, ELEMENT_SIZE, HOST_LITTLE_ENDIAN, outputPrecision, type ElementType } from './elements';
import { elementCount, type ArrayOrder, type NdArray } from './ndarray';

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];   // "\x93NUMPY"
/** NumPy pads the header so the data starts on a 64-byte boundary (older releases used 16) for memory mapping. */
const ARRAY_ALIGN = 64;
/** Spare header room NumPy leaves so the growth axis can gain digits in place. */
const GROWTH_AXIS_MAX_DIGITS = 21;

export interface NpyHeader {
    version: [number, number];
    /** The dtype string, e.g. '<f8'. */
    descr: string;
    fortranOrder: boolean;
    shape: number[];
    /** Offset of the array data from the start of the file. */
    dataOffset: number;
}

/** Parse and validate the header of an .npy file. */
export function readNpyHeader(bytes: Uint8Array): NpyHeader {
    if (MAGIC.some((byte, i) => bytes[i] !== byte)) throw new Error('Not an NPY file: the \\x93NUMPY magic string is missing.');
    if (bytes.length < 10) throw new Error('NPY file is truncated inside its header.');
    const major = bytes[6], minor = bytes[7];
    if (!(major >= 1 && major <= 3) || minor !== 0) {
        throw new Error(`NPY format version ${major}.${minor} is not supported (1.0, 2.0 and 3.0 are).`);
    }
    // Version 1.0 has a 16-bit header length; 2.0 widened it to 32 bits and
    // 3.0 changed the header encoding from Latin-1 to UTF-8.
    const start = major === 1 ? 10 : 12;
    if (bytes.length < start) throw new Error('NPY file is truncated inside its header.');
    const headerLength = major === 1
        ? bytes[8] | bytes[9] << 8
        : (bytes[8] | bytes[9] << 8 | bytes[10] << 16 | bytes[11] << 24) >>> 0;
    if (start + headerLength > bytes.length) {
        throw new Error(`NPY file is truncated: the header needs ${headerLength} bytes, ${bytes.length - start} remain.`);
    }
    const raw = bytes.subarray(start, start + headerLength);
    const text = major === 3 ? new TextDecoder('utf-8').decode(raw) : latin1(raw);
    let header: PyLiteral;
    try {
        header = new LiteralParser(text).parse();
    } catch (error) {
        throw new Error(`NPY header is not a valid Python literal: ${error instanceof Error ? error.message : error}`);
    }
    if (!isDict(header)) throw new Error('NPY header is not a dict.');
    const { descr, fortran_order: fortranOrder, shape } = header;
    if (Array.isArray(descr)) {
        throw new Error('NPY structured (record) dtypes are not supported; save each field as its own array.');
    }
    if (typeof descr !== 'string') throw new Error('NPY header has no valid \'descr\' entry.');
    if (typeof fortranOrder !== 'boolean') throw new Error('NPY header has no valid \'fortran_order\' entry.');
    if (!Array.isArray(shape) || !shape.every(size => typeof size === 'number' && Number.isInteger(size) && size >= 0)) {
        throw new Error('NPY header has no valid \'shape\' entry.');
    }
    return { version: [major, minor], descr, fortranOrder, shape: shape as number[], dataOffset: start + headerLength };
}

/** Read an .npy file. The data is copied out of `bytes`; see NdArray for the output types. */
export function readNpy(bytes: Uint8Array): NdArray {
    const header = readNpyHeader(bytes);
    const type = parseDescr(header.descr);
    const count = elementCount(header.shape);
    const needed = count * type.itemSize;
    const available = bytes.length - header.dataOffset;
    if (needed > available) {
        throw new Error(`NPY data is truncated: shape (${header.shape.join(', ')}) of ${header.descr} needs ${needed} bytes, `
            + `${available} remain after the header.`);
    }
    const precision = outputPrecision(type.element);
    const array: NdArray = {
        dtype: header.descr,
        shape: header.shape,
        order: header.fortranOrder ? 'F' : 'C',
        data: decodeElements(bytes, header.dataOffset, count, type.element, type.littleEndian, precision, type.complex ? 2 : 1),
    };
    if (type.complex) {
        const half = ELEMENT_SIZE[type.element];
        array.imag = decodeElements(bytes, header.dataOffset + half, count, type.element, type.littleEndian, precision, 2);
    }
    return array;
}

interface NpyType {
    /** The element type; for complex dtypes, that of each part. */
    element: ElementType;
    complex: boolean;
    littleEndian: boolean;
    itemSize: number;
}

const UNSUPPORTED_KINDS: Record<string, string> = {
    U: 'Unicode strings', S: 'byte strings', a: 'byte strings', O: 'Python objects', V: 'raw or structured records',
    M: 'datetimes', m: 'timedeltas',
};

/** Parse a simple dtype string: byte order ('<', '>', '|' or '='), kind and size. */
function parseDescr(descr: string): NpyType {
    const match = /^([<>|=]?)([a-zA-Z?])(\d*)$/.exec(descr);
    const kind = match ? match[2] : descr.replace(/^[<>|=]/, '').charAt(0);
    const size = match && match[3] ? Number(match[3]) : kind === '?' ? 1 : 0;
    let element: ElementType | undefined;
    let complex = false;
    switch (kind) {
        case 'f': element = size === 2 ? 'f2' : size === 4 ? 'f4' : size === 8 ? 'f8' : undefined; break;
        case 'i': element = size === 1 ? 'i1' : size === 2 ? 'i2' : size === 4 ? 'i4' : size === 8 ? 'i8' : undefined; break;
        case 'u': element = size === 1 ? 'u1' : size === 2 ? 'u2' : size === 4 ? 'u4' : size === 8 ? 'u8' : undefined; break;
        case 'b': case '?': element = size === 1 ? 'b1' : undefined; break;
        case 'c': complex = true; element = size === 8 ? 'f4' : size === 16 ? 'f8' : undefined; break;
    }
    if (!element || !match) {
        const what = UNSUPPORTED_KINDS[kind] ?? (kind === 'f' || kind === 'c' ? 'extended-precision numbers' : 'an unknown type');
        throw new Error(`NPY dtype '${descr}' (${what}) is not supported; save numeric arrays `
            + '(float16/32/64, integers, bool or complex64/128).');
    }
    const order = match[1];
    // '=' (native) refers to the writing machine; like NumPy, assume it matches ours.
    const littleEndian = order === '<' ? true : order === '>' ? false : HOST_LITTLE_ENDIAN;
    return { element, complex, littleEndian, itemSize: (complex ? 2 : 1) * ELEMENT_SIZE[element] };
}

// ─── Writing ─────────────────────────────────────────────────────────────

export type NpyWritableData = Float64Array | Float32Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array;

export interface NpyWriteInput {
    shape: readonly number[];
    data: NpyWritableData;
    /** Imaginary part; makes the array complex: '<c16' when either part is float64 or data is a 32-bit integer array, else '<c8'. */
    imag?: Float32Array | Float64Array;
    /** Memory order of `data` (default 'C'). */
    order?: ArrayOrder;
}

/**
 * An .npy file (format 1.0, little-endian) holding `array`. The header is
 * byte-for-byte what np.save writes for the same dtype, order and shape.
 */
export function writeNpy(array: NpyWriteInput): Uint8Array {
    const count = elementCount(array.shape);
    if (array.data.length !== count) {
        throw new Error(`Array data has ${array.data.length} elements but shape (${array.shape.join(', ')}) needs ${count}.`);
    }
    if (array.imag && array.imag.length !== count) {
        throw new Error(`Imaginary part has ${array.imag.length} elements but shape (${array.shape.join(', ')}) needs ${count}.`);
    }
    const fortranOrder = (array.order ?? 'C') === 'F';
    let descr: string;
    let body: NpyWritableData;
    if (array.imag) {
        const wide = array.data instanceof Float64Array || array.imag instanceof Float64Array
            || array.data instanceof Int32Array || array.data instanceof Uint32Array;
        descr = wide ? '<c16' : '<c8';
        const interleaved = wide ? new Float64Array(2 * count) : new Float32Array(2 * count);
        for (let i = 0; i < count; i++) {
            interleaved[2 * i] = array.data[i];
            interleaved[2 * i + 1] = array.imag[i];
        }
        body = interleaved;
    } else {
        descr = descrOf(array.data);
        body = array.data;
    }
    const header = npyHeader(descr, fortranOrder, array.shape);
    const out = new Uint8Array(header.length + body.byteLength);
    out.set(header);
    writeLittleEndian(body, out, header.length);
    return out;
}

function descrOf(data: NpyWritableData): string {
    if (data instanceof Float64Array) return '<f8';
    if (data instanceof Float32Array) return '<f4';
    if (data instanceof Int32Array) return '<i4';
    if (data instanceof Uint32Array) return '<u4';
    if (data instanceof Int16Array) return '<i2';
    if (data instanceof Uint16Array) return '<u2';
    if (data instanceof Int8Array) return '|i1';
    return '|u1';
}

/** Magic, version 1.0 (2.0 if the header outgrows 16 bits), length and the space-padded dict, as NumPy's _wrap_header. */
function npyHeader(descr: string, fortranOrder: boolean, shape: readonly number[]): Uint8Array {
    const shapeText = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(', ')})`;
    let dict = `{'descr': '${descr}', 'fortran_order': ${fortranOrder ? 'True' : 'False'}, 'shape': ${shapeText}, }`;
    if (shape.length > 0) {
        dict += ' '.repeat(Math.max(0, GROWTH_AXIS_MAX_DIGITS - String(shape[fortranOrder ? shape.length - 1 : 0]).length));
    }
    let lengthField = 2;
    // NumPy pads with a full extra block when the header is already aligned.
    let padding = ARRAY_ALIGN - (8 + lengthField + dict.length + 1) % ARRAY_ALIGN;
    if (dict.length + 1 + padding > 0xffff) {
        lengthField = 4;
        padding = ARRAY_ALIGN - (8 + lengthField + dict.length + 1) % ARRAY_ALIGN;
    }
    const headerLength = dict.length + padding + 1;
    const out = new Uint8Array(8 + lengthField + headerLength);
    out.set(MAGIC);
    out[6] = lengthField === 2 ? 1 : 2;
    out[7] = 0;
    for (let k = 0; k < lengthField; k++) out[8 + k] = (headerLength >>> (8 * k)) & 0xff;
    const text = dict + ' '.repeat(padding) + '\n';
    for (let i = 0; i < text.length; i++) out[8 + lengthField + i] = text.charCodeAt(i);
    return out;
}

function writeLittleEndian(data: NpyWritableData, out: Uint8Array, offset: number): void {
    out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
    if (HOST_LITTLE_ENDIAN) return;
    const size = data.BYTES_PER_ELEMENT;
    for (let p = offset; size > 1 && p < offset + data.byteLength; p += size) out.subarray(p, p + size).reverse();
}

// ─── Python literals ─────────────────────────────────────────────────────

type PyLiteral = string | number | boolean | null | PyLiteral[] | { [key: string]: PyLiteral };

function isDict(value: PyLiteral): value is { [key: string]: PyLiteral } {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function latin1(bytes: Uint8Array): string {
    let text = '';
    for (let i = 0; i < bytes.length; i += 8192) {
        text += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
    }
    return text;
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '\'': '\'', '"': '"', a: '\x07', b: '\b', f: '\f', v: '\v' };

/** Recursive-descent parser for the Python literal subset NPY headers use. */
class LiteralParser {
    private pos = 0;

    constructor(private readonly text: string) {}

    parse(): PyLiteral {
        const value = this.value();
        this.skipSpace();
        if (this.pos < this.text.length) this.fail('unexpected trailing text');
        return value;
    }

    private value(): PyLiteral {
        this.skipSpace();
        const c = this.text[this.pos];
        if (c === '{') return this.dict();
        if (c === '(') return this.sequence(')');
        if (c === '[') return this.sequence(']');
        if (c === '\'' || c === '"') return this.string();
        // Python 2 headers may spell strings u'…'.
        if ((c === 'u' || c === 'b') && (this.text[this.pos + 1] === '\'' || this.text[this.pos + 1] === '"')) {
            this.pos++;
            return this.string();
        }
        const number = /^[+-]?(\d+\.?\d*(e[+-]?\d+)?|\.\d+(e[+-]?\d+)?)[lL]?/i.exec(this.text.slice(this.pos));
        if (number) {
            this.pos += number[0].length;
            return Number(number[0].replace(/[lL]$/, ''));
        }
        const word = /^[A-Za-z_]\w*/.exec(this.text.slice(this.pos));
        if (word) {
            this.pos += word[0].length;
            if (word[0] === 'True') return true;
            if (word[0] === 'False') return false;
            if (word[0] === 'None') return null;
            this.fail(`unexpected name '${word[0]}'`);
        }
        return this.fail('expected a value');
    }

    private dict(): { [key: string]: PyLiteral } {
        const result: { [key: string]: PyLiteral } = {};
        this.pos++;
        for (;;) {
            this.skipSpace();
            if (this.text[this.pos] === '}') { this.pos++; return result; }
            const key = this.value();
            if (typeof key !== 'string') this.fail('dict keys must be strings');
            this.expect(':');
            result[key as string] = this.value();
            this.skipSpace();
            if (this.text[this.pos] === ',') this.pos++;
            else if (this.text[this.pos] !== '}') this.fail('expected \',\' or \'}\'');
        }
    }

    /** Tuples and lists both become arrays; a shape like (5) is read as a tuple too. */
    private sequence(close: string): PyLiteral[] {
        const items: PyLiteral[] = [];
        this.pos++;
        for (;;) {
            this.skipSpace();
            if (this.text[this.pos] === close) { this.pos++; return items; }
            items.push(this.value());
            this.skipSpace();
            if (this.text[this.pos] === ',') this.pos++;
            else if (this.text[this.pos] !== close) this.fail(`expected ',' or '${close}'`);
        }
    }

    private string(): string {
        const quote = this.text[this.pos++];
        let result = '';
        for (;;) {
            if (this.pos >= this.text.length) this.fail('unterminated string');
            const c = this.text[this.pos++];
            if (c === quote) return result;
            if (c !== '\\') { result += c; continue; }
            const e = this.text[this.pos++];
            const hex = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0;
            if (hex) {
                const digits = this.text.slice(this.pos, this.pos + hex);
                if (!/^[0-9a-fA-F]+$/.test(digits) || digits.length !== hex) this.fail('invalid escape');
                result += String.fromCodePoint(parseInt(digits, 16));
                this.pos += hex;
            } else {
                result += ESCAPES[e] ?? `\\${e}`;
            }
        }
    }

    private expect(char: string): void {
        this.skipSpace();
        if (this.text[this.pos] !== char) this.fail(`expected '${char}'`);
        this.pos++;
    }

    private skipSpace(): void {
        while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
    }

    private fail(message: string): never {
        throw new Error(`${message} at position ${this.pos}`);
    }
}
