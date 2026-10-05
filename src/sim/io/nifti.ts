/**
 * NIfTI-1 and NIfTI-2 single-file images (.nii, optionally gzipped).
 *
 * Both versions share one layout: a fixed header (348 bytes for NIfTI-1, 540
 * with 64-bit fields for NIfTI-2), a 4-byte extension flag and any extensions,
 * then the voxels at vox_offset, x fastest. The byte order is whichever makes
 * sizeof_hdr read as 348 or 540. Field offsets follow nifti1.h and nifti2.h.
 *
 * The voxel-to-world affine follows the standard's precedence (and nibabel's):
 * the sform when sform_code > 0, else the qform quaternion when
 * qform_code > 0, else plain pixdim scaling ("method 1"; nibabel's fallback
 * instead flips x and centres the grid, as Analyze did).
 */

import { gunzip, isGzip } from './compression';
import { decodeElements, ELEMENT_SIZE, outputPrecision, type ElementType } from './elements';
import { elementCount, type NdArray } from './ndarray';

export type NiftiSpatialUnits = 'unknown' | 'meter' | 'mm' | 'micron';
export type NiftiTemporalUnits = 'unknown' | 'sec' | 'msec' | 'usec' | 'hz' | 'ppm' | 'rads';

export interface NiftiImage extends NdArray {
    /** dtype is the NIfTI type name ('float32', 'int16', …); the shape is dim[1..dim[0]]. */
    order: 'F';
    /** 1 for a 348-byte NIfTI-1 header, 2 for a 540-byte NIfTI-2 header. */
    version: 1 | 2;
    littleEndian: boolean;
    /** NIfTI datatype code, e.g. 16 for float32. */
    datatype: number;
    /** pixdim[0..7] as stored: pixdim[0] is qfac, pixdim[k] the step along dimension k in the header's units. */
    pixdim: number[];
    spatialUnits: NiftiSpatialUnits;
    temporalUnits: NiftiTemporalUnits;
    /** Voxel size along i, j, k [m]; unknown spatial units are taken as mm, and missing steps as 1. */
    voxelSize: [number, number, number];
    /** Voxel indices (i, j, k, 1) → world coordinates (x, y, z, 1) in mm: 4×4, row-major. */
    affine: number[];
    affineSource: 'sform' | 'qform' | 'pixdim';
    qformCode: number;
    sformCode: number;
    /** scl_slope and scl_inter as stored. */
    sclSlope: number;
    sclInter: number;
    /** Whether `data` holds scl_slope·stored + scl_inter (scl_slope finite and non-zero). */
    scaled: boolean;
    intentCode: number;
    intentName: string;
    description: string;
}

interface NiftiType {
    name: string;
    element: ElementType;
    complex: boolean;
}

const DATATYPES: Readonly<Record<number, NiftiType>> = {
    2: { name: 'uint8', element: 'u1', complex: false },
    4: { name: 'int16', element: 'i2', complex: false },
    8: { name: 'int32', element: 'i4', complex: false },
    16: { name: 'float32', element: 'f4', complex: false },
    32: { name: 'complex64', element: 'f4', complex: true },
    64: { name: 'float64', element: 'f8', complex: false },
    256: { name: 'int8', element: 'i1', complex: false },
    512: { name: 'uint16', element: 'u2', complex: false },
    768: { name: 'uint32', element: 'u4', complex: false },
    1024: { name: 'int64', element: 'i8', complex: false },
    1280: { name: 'uint64', element: 'u8', complex: false },
    1792: { name: 'complex128', element: 'f8', complex: true },
};

const UNSUPPORTED_DATATYPES: Readonly<Record<number, string>> = {
    0: 'unknown', 1: 'binary (1 bit)', 128: 'RGB24', 1536: 'float128', 2048: 'complex256', 2304: 'RGBA32',
};

const SPATIAL_UNITS: Readonly<Record<number, [NiftiSpatialUnits, number]>> = {
    0: ['unknown', 1e-3], 1: ['meter', 1], 2: ['mm', 1e-3], 3: ['micron', 1e-6],
};

const TEMPORAL_UNITS: Readonly<Record<number, NiftiTemporalUnits>> = {
    0: 'unknown', 8: 'sec', 16: 'msec', 24: 'usec', 32: 'hz', 40: 'ppm', 48: 'rads',
};

/** The header fields this reader uses, version-independent. */
interface NiftiHeader {
    version: 1 | 2;
    littleEndian: boolean;
    datatype: number;
    type: NiftiType;
    shape: number[];
    pixdim: number[];
    voxOffset: number;
    dataBytes: number;
    sclSlope: number;
    sclInter: number;
    xyztUnits: number;
    qformCode: number;
    sformCode: number;
    quatern: [number, number, number];
    qoffset: [number, number, number];
    srow: number[];
    intentCode: number;
    intentName: string;
    description: string;
}

/** Read a .nii or .nii.gz image. */
export function readNifti(bytes: Uint8Array): NiftiImage {
    // The header sizes the decompressed file, so a damaged gzip trailer never
    // decides an allocation (see compression.ts).
    const file = isGzip(bytes)
        ? gunzip(bytes, 544, prefix => { const h = parseHeader(prefix); return h.voxOffset + h.dataBytes; }, 'NIfTI')
        : bytes;
    const header = parseHeader(file);
    const available = file.length - header.voxOffset;
    if (header.dataBytes > available) {
        throw new Error(`NIfTI data is truncated: ${header.shape.join('×')} ${header.type.name} voxels need ${header.dataBytes} bytes `
            + `after offset ${header.voxOffset}, ${Math.max(0, available)} remain.`);
    }
    const { element, complex } = header.type;
    const count = elementCount(header.shape);
    const precision = outputPrecision(element);
    const data = decodeElements(file, header.voxOffset, count, element, header.littleEndian, precision, complex ? 2 : 1);
    const imag = complex
        ? decodeElements(file, header.voxOffset + ELEMENT_SIZE[element], count, element, header.littleEndian, precision, 2)
        : undefined;

    // NIfTI scales every type but RGB; a zero or non-finite slope means unscaled.
    const { sclSlope: slope, sclInter: inter } = header;
    const scaled = Number.isFinite(slope) && slope !== 0;
    if (scaled && !Number.isFinite(inter)) throw new Error(`NIfTI header has scl_slope ${slope} but an invalid scl_inter (${inter}).`);
    if (scaled && (slope !== 1 || inter !== 0)) {
        for (let i = 0; i < count; i++) data[i] = data[i] * slope + inter;
        if (imag) for (let i = 0; i < count; i++) imag[i] *= slope;
    }

    const [spatialUnits, metres] = SPATIAL_UNITS[header.xyztUnits & 0x07] ?? SPATIAL_UNITS[0];
    const step = (k: number) => {
        const value = header.pixdim[k];
        return value !== 0 && Number.isFinite(value) ? value : 1;
    };
    const { affine, source } = worldAffine(header, step, metres * 1000);
    const image: NiftiImage = {
        dtype: header.type.name,
        shape: header.shape,
        order: 'F',
        data,
        version: header.version,
        littleEndian: header.littleEndian,
        datatype: header.datatype,
        pixdim: header.pixdim,
        spatialUnits,
        temporalUnits: TEMPORAL_UNITS[header.xyztUnits & 0x38] ?? 'unknown',
        voxelSize: [Math.abs(step(1)) * metres, Math.abs(step(2)) * metres, Math.abs(step(3)) * metres],
        affine,
        affineSource: source,
        qformCode: header.qformCode,
        sformCode: header.sformCode,
        sclSlope: slope,
        sclInter: inter,
        scaled,
        intentCode: header.intentCode,
        intentName: header.intentName,
        description: header.description,
    };
    if (imag) image.imag = imag;
    return image;
}

/** Voxel → world in mm, row-major; `toMm` converts the header's spatial units. */
function worldAffine(
    header: NiftiHeader, step: (k: number) => number, toMm: number,
): { affine: number[]; source: NiftiImage['affineSource'] } {
    let rows: number[];
    let source: NiftiImage['affineSource'];
    if (header.sformCode > 0) {
        rows = header.srow.slice();
        source = 'sform';
    } else if (header.qformCode > 0) {
        rows = quaternionAffine(header);
        source = 'qform';
    } else {
        rows = [step(1), 0, 0, 0, 0, step(2), 0, 0, 0, 0, step(3), 0];
        source = 'pixdim';
    }
    return { affine: [...rows.map(value => value * toMm), 0, 0, 0, 1], source };
}

/** The qform's 3×4 rows, as nifti1_io's nifti_quatern_to_mat44 computes them. */
function quaternionAffine(header: NiftiHeader): number[] {
    let [b, c, d] = header.quatern;
    let a = 1 - (b * b + c * c + d * d);
    if (a < 1e-7) {
        // |(b, c, d)| ≈ 1 (rounding in the stored float32s): a 180° rotation.
        const norm = 1 / Math.sqrt(b * b + c * c + d * d);
        b *= norm; c *= norm; d *= norm;
        a = 0;
    } else {
        a = Math.sqrt(a);
    }
    const positive = (value: number) => (value > 0 ? value : 1);
    const dx = positive(header.pixdim[1]), dy = positive(header.pixdim[2]);
    // qfac (pixdim[0]) = −1 flips the third axis: a left-handed voxel grid.
    const dz = positive(header.pixdim[3]) * (header.pixdim[0] < 0 ? -1 : 1);
    const [qx, qy, qz] = header.qoffset;
    return [
        (a * a + b * b - c * c - d * d) * dx, 2 * (b * c - a * d) * dy, 2 * (b * d + a * c) * dz, qx,
        2 * (b * c + a * d) * dx, (a * a + c * c - b * b - d * d) * dy, 2 * (c * d - a * b) * dz, qy,
        2 * (b * d - a * c) * dx, 2 * (c * d + a * b) * dy, (a * a + d * d - c * c - b * b) * dz, qz,
    ];
}

/** Parse and validate the header from the start of a (decompressed) file. */
function parseHeader(bytes: Uint8Array): NiftiHeader {
    if (bytes.length < 4) throw new Error('Not a NIfTI file: too short.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let littleEndian = true;
    let size = view.getInt32(0, true);
    if (size !== 348 && size !== 540) {
        littleEndian = false;
        size = view.getInt32(0, false);
    }
    if (size !== 348 && size !== 540) throw new Error('Not a NIfTI file: sizeof_hdr is neither 348 (NIfTI-1) nor 540 (NIfTI-2).');
    const version = size === 348 ? 1 : 2;
    if (bytes.length < size) throw new Error(`NIfTI file is truncated inside its ${size}-byte header.`);

    const magic = text(bytes, version === 1 ? 344 : 4, 4);
    const single = version === 1 ? 'n+1' : 'n+2', pair = version === 1 ? 'ni1' : 'ni2';
    if (magic === pair) {
        throw new Error('This is the header of a NIfTI .hdr/.img pair; only single-file .nii or .nii.gz images are supported. '
            + 'Convert it first, e.g. nibabel.save(nibabel.load(\'x.hdr\'), \'x.nii\') or fslchfiletype NIFTI x.');
    }
    if (magic !== single) {
        throw new Error(`Not a single-file NIfTI-${version} image (magic '${magic.replace(/[^\x20-\x7e]/g, '?')}'); `
            + 'Analyze 7.5 and .hdr/.img pairs are not supported.');
    }

    const i16 = (p: number) => view.getInt16(p, littleEndian);
    const i32 = (p: number) => view.getInt32(p, littleEndian);
    const f32 = (p: number) => view.getFloat32(p, littleEndian);
    const f64 = (p: number) => view.getFloat64(p, littleEndian);
    // 64-bit integers (NIfTI-2 dims and offsets) as high·2³² + low.
    const i64 = (p: number) => {
        const low = littleEndian ? p : p + 4, high = littleEndian ? p + 4 : p;
        return view.getInt32(high, littleEndian) * 4294967296 + view.getUint32(low, littleEndian);
    };
    const n1 = version === 1;
    const dim = Array.from({ length: 8 }, (_, k) => (n1 ? i16(40 + 2 * k) : i64(16 + 8 * k)));
    const pixdim = Array.from({ length: 8 }, (_, k) => (n1 ? f32(76 + 4 * k) : f64(104 + 8 * k)));
    const datatype = n1 ? i16(70) : i16(12);

    const rank = dim[0];
    if (!(rank >= 1 && rank <= 7)) throw new Error(`NIfTI header has an invalid dim[0] = ${rank}.`);
    const shape = dim.slice(1, rank + 1);
    if (shape.some(extent => extent < 0)) throw new Error(`NIfTI header has a negative dimension: [${shape.join(', ')}].`);
    const type = DATATYPES[datatype];
    if (!type) {
        const what = UNSUPPORTED_DATATYPES[datatype];
        throw new Error(`NIfTI datatype ${datatype}${what ? ` (${what})` : ''} is not supported; use an integer, float32/64 or complex type.`);
    }
    const voxelBytes = ELEMENT_SIZE[type.element] * (type.complex ? 2 : 1);
    const storedOffset = n1 ? f32(108) : i64(168);
    if (!(storedOffset >= 0 && Number.isFinite(storedOffset))) throw new Error(`NIfTI header has an invalid vox_offset (${storedOffset}).`);
    // nifti1.h: in a .nii file a vox_offset below 352 (544 for NIfTI-2) is
    // equivalent to 352, so writers that leave it 0 still work. (nibabel
    // refuses 1–351 and reads 0 from the start of the file.)
    const voxOffset = Math.max(Math.floor(storedOffset), size + 4);
    const srow = n1
        ? Array.from({ length: 12 }, (_, k) => f32(280 + 4 * k))
        : Array.from({ length: 12 }, (_, k) => f64(400 + 8 * k));
    return {
        version,
        littleEndian,
        datatype,
        type,
        shape,
        pixdim,
        voxOffset,
        dataBytes: elementCount(shape) * voxelBytes,
        sclSlope: n1 ? f32(112) : f64(176),
        sclInter: n1 ? f32(116) : f64(184),
        xyztUnits: n1 ? bytes[123] : i32(500),
        qformCode: n1 ? i16(252) : i32(344),
        sformCode: n1 ? i16(254) : i32(348),
        quatern: n1 ? [f32(256), f32(260), f32(264)] : [f64(352), f64(360), f64(368)],
        qoffset: n1 ? [f32(268), f32(272), f32(276)] : [f64(376), f64(384), f64(392)],
        srow,
        intentCode: n1 ? i16(68) : i32(504),
        intentName: text(bytes, n1 ? 328 : 508, 16),
        description: text(bytes, n1 ? 148 : 240, 80),
    };
}

/** A NUL-terminated Latin-1 string field. */
function text(bytes: Uint8Array, offset: number, length: number): string {
    let result = '';
    for (let i = offset; i < offset + length && bytes[i] !== 0; i++) result += String.fromCharCode(bytes[i]);
    return result;
}
