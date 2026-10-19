/**
 * ISMRMRD raw data export (https://ismrmrd.github.io): the v1 acquisition
 * header, the HDF5 layout written by the ISMRMRD C library and ismrmrd-python,
 * the streaming protocol of Gadgetron and ismrmrd.serialization, and the XML
 * header defined by ismrmrd.xsd.
 *
 * Samples are float32. `data` is complex and channel-major —
 * [channel][sample][re, im] — and `traj` is [sample][dimension], the layouts
 * of the library's Acquisition arrays.
 *
 * The two 64-bit header fields, `flags` and `channel_mask`, are bigints so no
 * bit is lost; flag bit b (1-based, as in ismrmrd.h) is 1n << BigInt(b − 1).
 */

import { Hdf5Writer, h5t } from './hdf5';

// ─── Acquisition header ──────────────────────────────────────────────────

/** The encoding loop counters of an acquisition (ISMRMRD_EncodingCounters). */
export interface EncodingCounters {
    kspace_encode_step_1: number;
    kspace_encode_step_2: number;
    average: number;
    slice: number;
    contrast: number;
    phase: number;
    repetition: number;
    set: number;
    segment: number;
    /** 8 values. */
    user: readonly number[];
}

/** ISMRMRD_AcquisitionHeader, field for field; array lengths are in the comments. */
export interface AcquisitionHeaderFields {
    version: number;
    /** IsmrmrdAcqFlag bits; see acquisitionFlags(). */
    flags: bigint;
    measurement_uid: number;
    scan_counter: number;
    acquisition_time_stamp: number;
    /** 3 values. */
    physiology_time_stamp: readonly number[];
    number_of_samples: number;
    available_channels: number;
    active_channels: number;
    /** 16 words; channel c is bit c % 64 of word ⌊c / 64⌋. */
    channel_mask: readonly bigint[];
    discard_pre: number;
    discard_post: number;
    center_sample: number;
    encoding_space_ref: number;
    trajectory_dimensions: number;
    sample_time_us: number;
    /** 3 values each. */
    position: readonly number[];
    read_dir: readonly number[];
    phase_dir: readonly number[];
    slice_dir: readonly number[];
    patient_table_position: readonly number[];
    idx: EncodingCounters;
    /** 8 values each. */
    user_int: readonly number[];
    user_float: readonly number[];
}

/** One readout: header, trajectory and samples. */
export interface IsmrmrdAcquisition {
    head: AcquisitionHeaderFields;
    /** number_of_samples × trajectory_dimensions values, sample-major. */
    traj: Float32Array;
    /** active_channels × number_of_samples × 2 values (re, im), channel-major. */
    data: Float32Array;
}

/** sizeof(ISMRMRD_AcquisitionHeader): the struct is #pragma pack(2) and has no padding. */
export const ACQUISITION_HEADER_SIZE = 340;

/** Acquisition flag bits (ISMRMRD_ACQ_*, 1-based); the flag's value is 1 << (bit − 1). */
export const IsmrmrdAcqFlag = Object.freeze({
    FIRST_IN_ENCODE_STEP1: 1,
    LAST_IN_ENCODE_STEP1: 2,
    FIRST_IN_ENCODE_STEP2: 3,
    LAST_IN_ENCODE_STEP2: 4,
    FIRST_IN_AVERAGE: 5,
    LAST_IN_AVERAGE: 6,
    FIRST_IN_SLICE: 7,
    LAST_IN_SLICE: 8,
    FIRST_IN_CONTRAST: 9,
    LAST_IN_CONTRAST: 10,
    FIRST_IN_PHASE: 11,
    LAST_IN_PHASE: 12,
    FIRST_IN_REPETITION: 13,
    LAST_IN_REPETITION: 14,
    FIRST_IN_SET: 15,
    LAST_IN_SET: 16,
    FIRST_IN_SEGMENT: 17,
    LAST_IN_SEGMENT: 18,
    IS_NOISE_MEASUREMENT: 19,
    IS_PARALLEL_CALIBRATION: 20,
    IS_PARALLEL_CALIBRATION_AND_IMAGING: 21,
    IS_REVERSE: 22,
    IS_NAVIGATION_DATA: 23,
    IS_PHASECORR_DATA: 24,
    LAST_IN_MEASUREMENT: 25,
    IS_HPFEEDBACK_DATA: 26,
    IS_DUMMYSCAN_DATA: 27,
    IS_RTFEEDBACK_DATA: 28,
    IS_SURFACECOILCORRECTIONSCAN_DATA: 29,
    IS_PHASE_STABILIZATION_REFERENCE: 30,
    IS_PHASE_STABILIZATION: 31,
    COMPRESSION1: 53,
    COMPRESSION2: 54,
    COMPRESSION3: 55,
    COMPRESSION4: 56,
    USER1: 57,
    USER2: 58,
    USER3: 59,
    USER4: 60,
    USER5: 61,
    USER6: 62,
    USER7: 63,
    USER8: 64,
});

function flagBit(bit: number): bigint {
    if (!Number.isInteger(bit) || bit < 1 || bit > 64) throw new RangeError(`Acquisition flag bits are 1 to 64, got ${bit}.`);
    return 1n << BigInt(bit - 1);
}

/** The flags word with the given bits set, as ismrmrd_set_flag would leave it. */
export function acquisitionFlags(...bits: readonly number[]): bigint {
    let flags = 0n;
    for (const bit of bits) flags |= flagBit(bit);
    return flags;
}

export function isFlagSet(flags: bigint, bit: number): boolean {
    return (flags & flagBit(bit)) !== 0n;
}

/** channel_mask with channels 0 … channels − 1 active (ismrmrd_set_channel_on for each). */
export function channelMask(channels: number): bigint[] {
    if (!Number.isInteger(channels) || channels < 0 || channels > 1024) throw new RangeError(`ISMRMRD supports 0 to 1024 channels, got ${channels}.`);
    const mask: bigint[] = new Array<bigint>(16).fill(0n);
    for (let c = 0; c < channels; c++) mask[c >> 6] |= 1n << BigInt(c & 63);
    return mask;
}

export type AcquisitionHeaderInit = Partial<Omit<AcquisitionHeaderFields, 'idx'>> & { idx?: Partial<EncodingCounters> };

/**
 * A complete header from the fields given. The rest default as
 * ismrmrd_init_acquisition_header sets them (version 1, zeros), except that
 * available_channels follows active_channels and channel_mask marks the
 * active channels.
 */
export function acquisitionHeader(init: AcquisitionHeaderInit = {}): AcquisitionHeaderFields {
    const active = init.active_channels ?? 1;
    const zeros = (n: number) => new Array<number>(n).fill(0);
    const head: AcquisitionHeaderFields = {
        version: 1,
        flags: 0n,
        measurement_uid: 0,
        scan_counter: 0,
        acquisition_time_stamp: 0,
        physiology_time_stamp: zeros(3),
        number_of_samples: 0,
        available_channels: active,
        active_channels: active,
        channel_mask: channelMask(active),
        discard_pre: 0,
        discard_post: 0,
        center_sample: 0,
        encoding_space_ref: 0,
        trajectory_dimensions: 0,
        sample_time_us: 0,
        position: zeros(3),
        read_dir: zeros(3),
        phase_dir: zeros(3),
        slice_dir: zeros(3),
        patient_table_position: zeros(3),
        idx: {
            kspace_encode_step_1: 0,
            kspace_encode_step_2: 0,
            average: 0,
            slice: 0,
            contrast: 0,
            phase: 0,
            repetition: 0,
            set: 0,
            segment: 0,
            user: zeros(8),
        },
        user_int: zeros(8),
        user_float: zeros(8),
    };
    const assign = (target: object, values: object, where: string) => {
        for (const [key, value] of Object.entries(values)) {
            if (value === undefined) continue;
            if (!(key in target)) throw new Error(`Unknown acquisition header field '${where}${key}'.`);
            (target as Record<string, unknown>)[key] = value;
        }
    };
    const { idx, ...fields } = init;
    assign(head, fields, '');
    assign(head.idx, idx ?? {}, 'idx.');
    return head;
}

/**
 * Sequential, range-checked little-endian writes over a packed struct. The
 * writers are bound, so they can be handed to each().
 */
class StructWriter {
    private offset: number;

    constructor(private readonly view: DataView, private readonly start: number) {
        this.offset = start;
    }

    private integer(name: string, value: number, min: number, max: number): number {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
            throw new RangeError(`${name} must be an integer in [${min}, ${max}], got ${String(value)}.`);
        }
        return value;
    }

    readonly u16 = (name: string, value: number): void => {
        this.view.setUint16(this.offset, this.integer(name, value, 0, 0xffff), true);
        this.offset += 2;
    };

    readonly u32 = (name: string, value: number): void => {
        this.view.setUint32(this.offset, this.integer(name, value, 0, 0xffffffff), true);
        this.offset += 4;
    };

    readonly i32 = (name: string, value: number): void => {
        this.view.setInt32(this.offset, this.integer(name, value, -0x80000000, 0x7fffffff), true);
        this.offset += 4;
    };

    readonly u64 = (name: string, value: bigint): void => {
        if (typeof value !== 'bigint' || value < 0n || value >= 1n << 64n) {
            throw new RangeError(`${name} must be a bigint in [0, 2^64), got ${String(value)}.`);
        }
        this.view.setBigUint64(this.offset, value, true);
        this.offset += 8;
    };

    readonly f32 = (name: string, value: number): void => {
        if (typeof value !== 'number') throw new RangeError(`${name} must be a number, got ${String(value)}.`);
        this.view.setFloat32(this.offset, value, true);
        this.offset += 4;
    };

    each<T>(name: string, values: readonly T[], count: number, write: (name: string, value: T) => void): void {
        if (!values || values.length !== count) throw new RangeError(`${name} must have ${count} values, got ${values?.length}.`);
        for (let i = 0; i < count; i++) write(`${name}[${i}]`, values[i]);
    }

    end(size: number): void {
        if (this.offset - this.start !== size) throw new Error(`Wrote ${this.offset - this.start} bytes of a ${size}-byte struct.`);
    }
}

function writeAcquisitionHeader(head: AcquisitionHeaderFields, view: DataView, at: number): void {
    const w = new StructWriter(view, at);
    w.u16('version', head.version);
    w.u64('flags', head.flags);
    w.u32('measurement_uid', head.measurement_uid);
    w.u32('scan_counter', head.scan_counter);
    w.u32('acquisition_time_stamp', head.acquisition_time_stamp);
    w.each('physiology_time_stamp', head.physiology_time_stamp, 3, w.u32);
    w.u16('number_of_samples', head.number_of_samples);
    w.u16('available_channels', head.available_channels);
    w.u16('active_channels', head.active_channels);
    w.each('channel_mask', head.channel_mask, 16, w.u64);
    w.u16('discard_pre', head.discard_pre);
    w.u16('discard_post', head.discard_post);
    w.u16('center_sample', head.center_sample);
    w.u16('encoding_space_ref', head.encoding_space_ref);
    w.u16('trajectory_dimensions', head.trajectory_dimensions);
    w.f32('sample_time_us', head.sample_time_us);
    w.each('position', head.position, 3, w.f32);
    w.each('read_dir', head.read_dir, 3, w.f32);
    w.each('phase_dir', head.phase_dir, 3, w.f32);
    w.each('slice_dir', head.slice_dir, 3, w.f32);
    w.each('patient_table_position', head.patient_table_position, 3, w.f32);
    const idx = head.idx;
    w.u16('idx.kspace_encode_step_1', idx.kspace_encode_step_1);
    w.u16('idx.kspace_encode_step_2', idx.kspace_encode_step_2);
    w.u16('idx.average', idx.average);
    w.u16('idx.slice', idx.slice);
    w.u16('idx.contrast', idx.contrast);
    w.u16('idx.phase', idx.phase);
    w.u16('idx.repetition', idx.repetition);
    w.u16('idx.set', idx.set);
    w.u16('idx.segment', idx.segment);
    w.each('idx.user', idx.user, 8, w.u16);
    w.each('user_int', head.user_int, 8, w.i32);
    w.each('user_float', head.user_float, 8, w.f32);
    w.end(ACQUISITION_HEADER_SIZE);
}

/** The header as the 340 packed little-endian bytes of ISMRMRD_AcquisitionHeader. */
export function encodeAcquisitionHeader(head: AcquisitionHeaderFields): Uint8Array {
    const bytes = new Uint8Array(ACQUISITION_HEADER_SIZE);
    writeAcquisitionHeader(head, new DataView(bytes.buffer), 0);
    return bytes;
}

/** Inverse of encodeAcquisitionHeader; float fields come back float32-rounded. */
export function decodeAcquisitionHeader(bytes: Uint8Array, offset = 0): AcquisitionHeaderFields {
    if (offset < 0 || offset + ACQUISITION_HEADER_SIZE > bytes.length) throw new RangeError('Not enough bytes for an acquisition header.');
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, ACQUISITION_HEADER_SIZE);
    let at = 0;
    const take = (size: number) => (at += size) - size;
    const u16 = () => view.getUint16(take(2), true);
    const u32 = () => view.getUint32(take(4), true);
    const i32 = () => view.getInt32(take(4), true);
    const u64 = () => view.getBigUint64(take(8), true);
    const f32 = () => view.getFloat32(take(4), true);
    const list = <T>(count: number, read: () => T) => Array.from({ length: count }, read);
    const version = u16();
    const flags = u64();
    const measurement_uid = u32();
    const scan_counter = u32();
    const acquisition_time_stamp = u32();
    const physiology_time_stamp = list(3, u32);
    const number_of_samples = u16();
    const available_channels = u16();
    const active_channels = u16();
    const channel_mask = list(16, u64);
    const discard_pre = u16();
    const discard_post = u16();
    const center_sample = u16();
    const encoding_space_ref = u16();
    const trajectory_dimensions = u16();
    const sample_time_us = f32();
    const position = list(3, f32);
    const read_dir = list(3, f32);
    const phase_dir = list(3, f32);
    const slice_dir = list(3, f32);
    const patient_table_position = list(3, f32);
    const idx: EncodingCounters = {
        kspace_encode_step_1: u16(),
        kspace_encode_step_2: u16(),
        average: u16(),
        slice: u16(),
        contrast: u16(),
        phase: u16(),
        repetition: u16(),
        set: u16(),
        segment: u16(),
        user: list(8, u16),
    };
    const user_int = list(8, i32);
    const user_float = list(8, f32);
    return {
        version, flags, measurement_uid, scan_counter, acquisition_time_stamp, physiology_time_stamp,
        number_of_samples, available_channels, active_channels, channel_mask,
        discard_pre, discard_post, center_sample, encoding_space_ref, trajectory_dimensions, sample_time_us,
        position, read_dir, phase_dir, slice_dir, patient_table_position, idx, user_int, user_float,
    };
}

function checkShapes(acquisition: IsmrmrdAcquisition, index: number): void {
    const { head, traj, data } = acquisition;
    const samples = head.number_of_samples;
    if (traj.length !== samples * head.trajectory_dimensions) {
        throw new RangeError(`Acquisition ${index}: traj has ${traj.length} values, but number_of_samples × trajectory_dimensions `
            + `is ${samples} × ${head.trajectory_dimensions}.`);
    }
    if (data.length !== 2 * samples * head.active_channels) {
        throw new RangeError(`Acquisition ${index}: data has ${data.length} values, but 2 × active_channels × number_of_samples `
            + `is 2 × ${head.active_channels} × ${samples}.`);
    }
}

function withIndex<T>(index: number, run: () => T): T {
    try {
        return run();
    } catch (error) {
        throw new RangeError(`Acquisition ${index}: ${(error as Error).message}`);
    }
}

// ─── HDF5 ────────────────────────────────────────────────────────────────

/** get_hdf5type_encoding() of the ISMRMRD C library: member names and types, packed. */
export const ENCODING_COUNTERS_HDF5_TYPE = h5t.compound([
    ['kspace_encode_step_1', h5t.u16],
    ['kspace_encode_step_2', h5t.u16],
    ['average', h5t.u16],
    ['slice', h5t.u16],
    ['contrast', h5t.u16],
    ['phase', h5t.u16],
    ['repetition', h5t.u16],
    ['set', h5t.u16],
    ['segment', h5t.u16],
    ['user', h5t.array(h5t.u16, [8])],
]);

/**
 * get_hdf5type_acquisitionheader(). Packed like the C struct, so a member's
 * file offset equals its struct offset and the 340 bytes of
 * encodeAcquisitionHeader are the compound's bytes; ismrmrd-python reads the
 * head into its ctypes struct by exactly those bytes.
 */
export const ACQUISITION_HEADER_HDF5_TYPE = h5t.compound([
    ['version', h5t.u16],
    ['flags', h5t.u64],
    ['measurement_uid', h5t.u32],
    ['scan_counter', h5t.u32],
    ['acquisition_time_stamp', h5t.u32],
    ['physiology_time_stamp', h5t.array(h5t.u32, [3])],
    ['number_of_samples', h5t.u16],
    ['available_channels', h5t.u16],
    ['active_channels', h5t.u16],
    ['channel_mask', h5t.array(h5t.u64, [16])],
    ['discard_pre', h5t.u16],
    ['discard_post', h5t.u16],
    ['center_sample', h5t.u16],
    ['encoding_space_ref', h5t.u16],
    ['trajectory_dimensions', h5t.u16],
    ['sample_time_us', h5t.f32],
    ['position', h5t.array(h5t.f32, [3])],
    ['read_dir', h5t.array(h5t.f32, [3])],
    ['phase_dir', h5t.array(h5t.f32, [3])],
    ['slice_dir', h5t.array(h5t.f32, [3])],
    ['patient_table_position', h5t.array(h5t.f32, [3])],
    ['idx', ENCODING_COUNTERS_HDF5_TYPE],
    ['user_int', h5t.array(h5t.i32, [8])],
    ['user_float', h5t.array(h5t.f32, [8])],
]);

/**
 * get_hdf5type_acquisition(): the header, then the trajectory and the samples
 * as variable-length float sequences (the C library and ismrmrd-python both
 * store complex data as interleaved floats). Packed as ismrmrd-python writes
 * it; the C library pads to its in-memory struct, and readers match members
 * by name, so either reads everywhere.
 */
export const ACQUISITION_HDF5_TYPE = h5t.compound([
    ['head', ACQUISITION_HEADER_HDF5_TYPE],
    ['traj', h5t.vlen(h5t.f32)],
    ['data', h5t.vlen(h5t.f32)],
]);

export interface IsmrmrdHdf5Options {
    /** Group holding `xml` and `data`; 'dataset' is the libraries' default. */
    datasetName?: string;
}

/**
 * An ISMRMRD HDF5 file: /<datasetName>/xml, a one-element variable-length
 * string holding the XML header, and /<datasetName>/data, one compound
 * element per acquisition.
 *
 * The string is declared ASCII, as the C library's H5T_C_S1 type is: libhdf5
 * refuses to convert between ASCII and UTF-8 strings, so a UTF-8 declaration
 * would make ismrmrd_read_header fail. buildIsmrmrdHeaderXml's output is pure
 * ASCII; other text is stored as its UTF-8 bytes, which the ISMRMRD readers
 * pass through but h5py's asstr() (decoding by the declaration) rejects.
 *
 * `data` is contiguous rather than chunked, so the libraries read it but
 * cannot append to it.
 */
export function writeIsmrmrdHdf5(
    xmlHeader: string,
    acquisitions: readonly IsmrmrdAcquisition[],
    options: IsmrmrdHdf5Options = {},
): Uint8Array {
    const group = options.datasetName ?? 'dataset';
    if (!group || group === '.' || group.includes('/') || group.includes('\0')) {
        throw new Error(`Invalid ISMRMRD dataset name '${group}'.`);
    }
    // All headers in one buffer; each element's head is a 340-byte view of it.
    const heads = new Uint8Array(acquisitions.length * ACQUISITION_HEADER_SIZE);
    const view = new DataView(heads.buffer);
    const rows = acquisitions.map((acquisition, i) => {
        checkShapes(acquisition, i);
        const at = i * ACQUISITION_HEADER_SIZE;
        withIndex(i, () => writeAcquisitionHeader(acquisition.head, view, at));
        return { head: heads.subarray(at, at + ACQUISITION_HEADER_SIZE), traj: acquisition.traj, data: acquisition.data };
    });
    return new Hdf5Writer()
        .dataset(`/${group}/xml`, h5t.string('ascii'), [1], [xmlHeader])
        .dataset(`/${group}/data`, ACQUISITION_HDF5_TYPE, [rows.length], rows)
        .finish();
}

// ─── Stream ──────────────────────────────────────────────────────────────

/** Message identifiers of the ISMRMRD streaming protocol (ISMRMRD_MESSAGE_ID). */
export const IsmrmrdMessageId = Object.freeze({
    CONFIG_FILE: 1,
    CONFIG_TEXT: 2,
    HEADER: 3,
    CLOSE: 4,
    TEXT: 5,
    ACQUISITION: 1008,
    IMAGE: 1022,
    WAVEFORM: 1026,
    NDARRAY: 1030,
});

const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const utf8 = new TextEncoder();

function writeFloat32s(bytes: Uint8Array, view: DataView, at: number, values: Float32Array): number {
    if (LITTLE_ENDIAN_HOST && values instanceof Float32Array) {
        bytes.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), at);
    } else {
        for (let i = 0; i < values.length; i++) view.setFloat32(at + 4 * i, values[i], true);
    }
    return at + 4 * values.length;
}

/**
 * The acquisitions as an ISMRMRD stream, as ProtocolSerializer writes it
 * (ismrmrd-python and the C++ library): a uint16 message id before every
 * message; HEADER = uint32 byte length + UTF-8 XML (no terminator);
 * ACQUISITION = the 340-byte header, traj, then data, as raw float32; CLOSE.
 * All little-endian. This is what Gadgetron reads from a stream.
 */
export function writeIsmrmrdStream(xmlHeader: string, acquisitions: readonly IsmrmrdAcquisition[]): Uint8Array {
    const xml = utf8.encode(xmlHeader);
    let size = 2 + 4 + xml.length + 2;
    for (const [i, acquisition] of acquisitions.entries()) {
        checkShapes(acquisition, i);
        size += 2 + ACQUISITION_HEADER_SIZE + 4 * (acquisition.traj.length + acquisition.data.length);
    }
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, IsmrmrdMessageId.HEADER, true);
    view.setUint32(2, xml.length, true);
    bytes.set(xml, 6);
    let at = 6 + xml.length;
    for (const [i, acquisition] of acquisitions.entries()) {
        view.setUint16(at, IsmrmrdMessageId.ACQUISITION, true);
        withIndex(i, () => writeAcquisitionHeader(acquisition.head, view, at + 2));
        at = writeFloat32s(bytes, view, at + 2 + ACQUISITION_HEADER_SIZE, acquisition.traj);
        at = writeFloat32s(bytes, view, at, acquisition.data);
    }
    view.setUint16(at, IsmrmrdMessageId.CLOSE, true);
    return bytes;
}

// ─── XML header ──────────────────────────────────────────────────────────

export const ISMRMRD_NAMESPACE = 'http://www.ismrm.org/ISMRMRD';

export type IsmrmrdTrajectory = 'cartesian' | 'epi' | 'radial' | 'goldenangle' | 'spiral' | 'other';
export type IsmrmrdPatientPosition = 'HFP' | 'HFS' | 'HFDR' | 'HFDL' | 'FFP' | 'FFS' | 'FFDR' | 'FFDL';

const TRAJECTORIES: readonly string[] = ['cartesian', 'epi', 'radial', 'goldenangle', 'spiral', 'other'];
const PATIENT_POSITIONS: readonly string[] = ['HFP', 'HFS', 'HFDR', 'HFDL', 'FFP', 'FFS', 'FFDR', 'FFDL'];

/** In schema order. */
const LIMIT_NAMES = [
    'kspace_encoding_step_0', 'kspace_encoding_step_1', 'kspace_encoding_step_2',
    'average', 'slice', 'contrast', 'phase', 'repetition', 'set', 'segment',
    'user_0', 'user_1', 'user_2', 'user_3', 'user_4', 'user_5', 'user_6', 'user_7',
] as const;

export type IsmrmrdLimitName = (typeof LIMIT_NAMES)[number];

export interface IsmrmrdLimit {
    minimum: number;
    maximum: number;
    center: number;
}

/** Counters left out are omitted from the header. */
export type IsmrmrdEncodingLimits = Partial<Record<IsmrmrdLimitName, IsmrmrdLimit>>;

export interface IsmrmrdXyz {
    x: number;
    y: number;
    z: number;
}

export interface IsmrmrdEncodingSpace {
    /** Each 0–65535 (xs:unsignedShort). */
    matrixSize: IsmrmrdXyz;
    fieldOfView_mm: IsmrmrdXyz;
}

export interface IsmrmrdSequenceParameters {
    /** [ms] */
    TR?: readonly number[];
    /** [ms] */
    TE?: readonly number[];
    /** [ms] */
    TI?: readonly number[];
    flipAngle_deg?: readonly number[];
    sequence_type?: string;
    /** [ms] */
    echo_spacing?: readonly number[];
}

export interface IsmrmrdUserParameters {
    userParameterLong?: readonly { name: string; value: number | bigint }[];
    userParameterDouble?: readonly { name: string; value: number }[];
    userParameterString?: readonly { name: string; value: string }[];
}

/** What buildIsmrmrdHeaderXml writes; names follow the XML elements. */
export interface IsmrmrdHeaderInfo {
    /** ¹H resonance frequency [Hz]; the schema wants an integer (xs:long), so it is rounded. */
    H1resonanceFrequency_Hz: number;
    receiverChannels: number;
    systemFieldStrength_T?: number;
    encodedSpace: IsmrmrdEncodingSpace;
    /** Defaults to encodedSpace. */
    reconSpace?: IsmrmrdEncodingSpace;
    trajectory: IsmrmrdTrajectory;
    encodingLimits: IsmrmrdEncodingLimits;
    sequenceParameters?: IsmrmrdSequenceParameters;
    /** patientPosition defaults to 'HFS' (the schema requires one). */
    measurementInformation?: { protocolName?: string; patientPosition?: IsmrmrdPatientPosition };
    acquisitionSystemInformation?: { systemVendor?: string; systemModel?: string };
    userParameters?: IsmrmrdUserParameters;
}

const XML_ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;' };

/**
 * Escapes markup, and writes every non-ASCII character as a character
 * reference so the document is pure ASCII: the HDF5 string is declared ASCII
 * (see writeIsmrmrdHdf5), and readers that decode by that declaration then
 * still see every character. Characters XML 1.0 cannot carry at all (most
 * C0 controls, lone surrogates, U+FFFE/U+FFFF) become U+FFFD.
 */
function escapeXml(text: string): string {
    let out = '';
    for (const char of text) {
        const code = char.codePointAt(0)!;
        if (XML_ENTITIES[char]) out += XML_ENTITIES[char];
        else if (code >= 0x20 && code < 0x7f) out += char;
        else if (code === 0x09 || code === 0x0a || code === 0x0d) out += char;
        else if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) out += '&#xFFFD;';
        else out += `&#x${code.toString(16).toUpperCase()};`;
    }
    return out;
}

/** xs:float / xs:double lexical form. */
function xsFloat(value: number, name: string): string {
    if (typeof value !== 'number') throw new RangeError(`${name} must be a number, got ${String(value)}.`);
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'INF' : '-INF';
    return String(value);
}

function xsLong(value: number | bigint, name: string): string {
    if (typeof value === 'bigint') {
        if (value < -(2n ** 63n) || value >= 2n ** 63n) throw new RangeError(`${name} does not fit xs:long: ${value}.`);
        return String(value);
    }
    if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be an integer, got ${String(value)}.`);
    return String(value);
}

function unsignedShort(value: number, name: string): string {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError(`${name} must be an integer in [0, 65535], got ${String(value)}.`);
    return String(value);
}

function oneOf(value: string, allowed: readonly string[], name: string): string {
    if (!allowed.includes(value)) throw new RangeError(`${name} must be one of ${allowed.join(', ')}, got '${value}'.`);
    return value;
}

class XmlWriter {
    private readonly lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
    private readonly open: string[] = [];

    start(name: string, attributes = ''): void {
        this.lines.push(`${'  '.repeat(this.open.length)}<${name}${attributes}>`);
        this.open.push(name);
    }

    end(): void {
        const name = this.open.pop();
        this.lines.push(`${'  '.repeat(this.open.length)}</${name}>`);
    }

    leaf(name: string, text: string): void {
        this.lines.push(`${'  '.repeat(this.open.length)}<${name}>${escapeXml(text)}</${name}>`);
    }

    xyz(name: string, value: IsmrmrdXyz, format: (value: number, name: string) => string): void {
        this.start(name);
        for (const axis of ['x', 'y', 'z'] as const) this.leaf(axis, format(value[axis], `${name}.${axis}`));
        this.end();
    }

    toString(): string {
        return `${this.lines.join('\n')}\n`;
    }
}

/**
 * A valid ismrmrdHeader document. Elements follow ismrmrd.xsd's order (most
 * of its types are xs:sequence), and the root carries the namespace
 * declarations the C++ serializer writes. No <version> is written: the C++
 * library refuses to re-serialize a header whose version differs from its own.
 */
export function buildIsmrmrdHeaderXml(info: IsmrmrdHeaderInfo): string {
    const xml = new XmlWriter();
    xml.start('ismrmrdHeader', ` xmlns="${ISMRMRD_NAMESPACE}"`
        + ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
        + ' xmlns:xs="http://www.w3.org/2001/XMLSchema"'
        + ` xsi:schemaLocation="${ISMRMRD_NAMESPACE} ismrmrd.xsd"`);

    const measurement = info.measurementInformation;
    if (measurement) {
        xml.start('measurementInformation');
        xml.leaf('patientPosition', oneOf(measurement.patientPosition ?? 'HFS', PATIENT_POSITIONS, 'patientPosition'));
        if (measurement.protocolName !== undefined) xml.leaf('protocolName', measurement.protocolName);
        xml.end();
    }

    const system = info.acquisitionSystemInformation ?? {};
    xml.start('acquisitionSystemInformation');
    if (system.systemVendor !== undefined) xml.leaf('systemVendor', system.systemVendor);
    if (system.systemModel !== undefined) xml.leaf('systemModel', system.systemModel);
    if (info.systemFieldStrength_T !== undefined) xml.leaf('systemFieldStrength_T', xsFloat(info.systemFieldStrength_T, 'systemFieldStrength_T'));
    xml.leaf('receiverChannels', unsignedShort(info.receiverChannels, 'receiverChannels'));
    xml.end();

    if (!Number.isFinite(info.H1resonanceFrequency_Hz)) {
        throw new RangeError(`H1resonanceFrequency_Hz must be finite, got ${info.H1resonanceFrequency_Hz}.`);
    }
    xml.start('experimentalConditions');
    xml.leaf('H1resonanceFrequency_Hz', xsLong(Math.round(info.H1resonanceFrequency_Hz), 'H1resonanceFrequency_Hz'));
    xml.end();

    xml.start('encoding');
    for (const [name, space] of [['encodedSpace', info.encodedSpace], ['reconSpace', info.reconSpace ?? info.encodedSpace]] as const) {
        xml.start(name);
        xml.xyz('matrixSize', space.matrixSize, unsignedShort);
        xml.xyz('fieldOfView_mm', space.fieldOfView_mm, xsFloat);
        xml.end();
    }
    xml.start('encodingLimits');
    for (const name of LIMIT_NAMES) {
        const limit = info.encodingLimits[name];
        if (!limit) continue;
        xml.start(name);
        xml.leaf('minimum', unsignedShort(limit.minimum, `${name}.minimum`));
        xml.leaf('maximum', unsignedShort(limit.maximum, `${name}.maximum`));
        xml.leaf('center', unsignedShort(limit.center, `${name}.center`));
        xml.end();
    }
    xml.end();
    xml.leaf('trajectory', oneOf(info.trajectory, TRAJECTORIES, 'trajectory'));
    xml.end();

    const sequence = info.sequenceParameters;
    if (sequence && Object.values(sequence).some(value => value !== undefined && !(Array.isArray(value) && value.length === 0))) {
        xml.start('sequenceParameters');
        for (const name of ['TR', 'TE', 'TI', 'flipAngle_deg'] as const) {
            for (const value of sequence[name] ?? []) xml.leaf(name, xsFloat(value, name));
        }
        if (sequence.sequence_type !== undefined) xml.leaf('sequence_type', sequence.sequence_type);
        for (const value of sequence.echo_spacing ?? []) xml.leaf('echo_spacing', xsFloat(value, 'echo_spacing'));
        xml.end();
    }

    const user = info.userParameters;
    const longs = user?.userParameterLong ?? [];
    const doubles = user?.userParameterDouble ?? [];
    const strings = user?.userParameterString ?? [];
    if (longs.length + doubles.length + strings.length > 0) {
        xml.start('userParameters');
        const parameter = (element: string, name: string, value: string) => {
            xml.start(element);
            xml.leaf('name', name);
            xml.leaf('value', value);
            xml.end();
        };
        for (const p of longs) parameter('userParameterLong', p.name, xsLong(p.value, `userParameterLong '${p.name}'`));
        for (const p of doubles) parameter('userParameterDouble', p.name, xsFloat(p.value, `userParameterDouble '${p.name}'`));
        for (const p of strings) parameter('userParameterString', p.name, p.value);
        xml.end();
    }

    xml.end();
    return xml.toString();
}
