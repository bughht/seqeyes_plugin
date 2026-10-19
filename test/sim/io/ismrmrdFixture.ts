/**
 * The small ISMRMRD data set behind test/fixtures/ismrmrd: a noise scan
 * without trajectory, then three radial readouts of different lengths with a
 * 2-D trajectory, two coils, and labels and flags in every header field
 * (including flag bit 64 and a full 32-bit measurement_uid), so a reader that
 * drops a field, swaps an offset or truncates a 64-bit word disagrees with
 * expected.json.
 */

import {
    acquisitionFlags,
    acquisitionHeader,
    buildIsmrmrdHeaderXml,
    IsmrmrdAcqFlag,
    type AcquisitionHeaderFields,
    type IsmrmrdAcquisition,
    type IsmrmrdHeaderInfo,
} from '../../../src/sim/io/ismrmrd';

export const FIXTURE_COILS = 2;

export const FIXTURE_HEADER_INFO: IsmrmrdHeaderInfo = {
    H1resonanceFrequency_Hz: 123_259_792.4,
    receiverChannels: FIXTURE_COILS,
    systemFieldStrength_T: 2.89362,
    encodedSpace: { matrixSize: { x: 16, y: 3, z: 1 }, fieldOfView_mm: { x: 256, y: 256, z: 5 } },
    reconSpace: { matrixSize: { x: 8, y: 8, z: 1 }, fieldOfView_mm: { x: 128.5, y: 128.5, z: 5 } },
    trajectory: 'radial',
    encodingLimits: {
        kspace_encoding_step_0: { minimum: 0, maximum: 11, center: 6 },
        kspace_encoding_step_1: { minimum: 0, maximum: 2, center: 1 },
        slice: { minimum: 0, maximum: 0, center: 0 },
        contrast: { minimum: 0, maximum: 1, center: 0 },
        repetition: { minimum: 0, maximum: 0, center: 0 },
    },
    sequenceParameters: { TR: [8.5], TE: [3.1, 6.2], flipAngle_deg: [15], sequence_type: 'Flash', echo_spacing: [3.1] },
    measurementInformation: { protocolName: 'SeqEyes <fixture> & "radial" \'test\'' },
    acquisitionSystemInformation: { systemVendor: 'SeqEyes', systemModel: 'Bloch simulator' },
    userParameters: {
        userParameterLong: [{ name: 'seed', value: 2026 }, { name: 'big', value: 9_007_199_254_740_993n }],
        userParameterDouble: [{ name: 'B0_T', value: 2.89362 }],
        userParameterString: [{ name: 'sequence', value: 'radial é.seq' }],
    },
};

export const FIXTURE_XML = buildIsmrmrdHeaderXml(FIXTURE_HEADER_INFO);

/** Exact in float32: quarters of small integers. */
function samples(acquisition: number, head: AcquisitionHeaderFields): Float32Array {
    const n = head.number_of_samples;
    const data = new Float32Array(2 * head.active_channels * n);
    for (let c = 0; c < head.active_channels; c++) {
        for (let s = 0; s < n; s++) {
            data[2 * (c * n + s)] = 100 * (acquisition + 1) + 10 * c + s + 0.25;
            data[2 * (c * n + s) + 1] = -(100 * (acquisition + 1) + 10 * c + s) / 4;
        }
    }
    return data;
}

function radialTrajectory(spoke: number, head: AcquisitionHeaderFields): Float32Array {
    const n = head.number_of_samples;
    const traj = new Float32Array(2 * n);
    for (let s = 0; s < n; s++) {
        traj[2 * s] = (s - head.center_sample) / 2;
        traj[2 * s + 1] = spoke - 1 + s / 8;
    }
    return traj;
}

function acquisition(index: number, head: AcquisitionHeaderFields): IsmrmrdAcquisition {
    const traj = head.trajectory_dimensions === 2 ? radialTrajectory(head.idx.kspace_encode_step_1, head) : new Float32Array(0);
    return { head, traj, data: samples(index, head) };
}

const common = {
    measurement_uid: 0xffff_ffff,
    active_channels: FIXTURE_COILS,
    available_channels: 4,
    sample_time_us: 5,
    read_dir: [1, 0, 0],
    phase_dir: [0, 1, 0],
    slice_dir: [0, 0, 1],
    position: [1.5, -2.5, 30.25],
    patient_table_position: [0, 0, -1200.5],
};

export const FIXTURE_ACQUISITIONS: IsmrmrdAcquisition[] = [
    acquisitionHeader({
        ...common,
        scan_counter: 1,
        acquisition_time_stamp: 1000,
        number_of_samples: 6,
        flags: acquisitionFlags(IsmrmrdAcqFlag.IS_NOISE_MEASUREMENT),
    }),
    acquisitionHeader({
        ...common,
        scan_counter: 2,
        acquisition_time_stamp: 1003,
        physiology_time_stamp: [10, 20, 30],
        number_of_samples: 8,
        center_sample: 4,
        trajectory_dimensions: 2,
        flags: acquisitionFlags(
            IsmrmrdAcqFlag.FIRST_IN_ENCODE_STEP1, IsmrmrdAcqFlag.FIRST_IN_SLICE, IsmrmrdAcqFlag.FIRST_IN_REPETITION,
        ),
        idx: { kspace_encode_step_1: 0, set: 1, segment: 2, user: [1, 2, 3, 4, 5, 6, 7, 65535] },
        user_int: [-2147483648, -1, 0, 1, 2, 3, 4, 2147483647],
        // Not −0: expected.json could not tell it from 0.
        user_float: [0.1, -2.25, 1e-7, 3.4e38, -1e-30, 0.5, 6, 7.75],
    }),
    acquisitionHeader({
        ...common,
        scan_counter: 3,
        acquisition_time_stamp: 1006,
        number_of_samples: 12,
        center_sample: 6,
        discard_pre: 1,
        discard_post: 2,
        trajectory_dimensions: 2,
        flags: acquisitionFlags(IsmrmrdAcqFlag.IS_REVERSE, IsmrmrdAcqFlag.LAST_IN_CONTRAST),
        idx: { kspace_encode_step_1: 1, kspace_encode_step_2: 3, average: 4, contrast: 1, phase: 5, repetition: 0 },
        encoding_space_ref: 0,
    }),
    acquisitionHeader({
        ...common,
        scan_counter: 4,
        acquisition_time_stamp: 1009,
        number_of_samples: 5,
        center_sample: 2,
        trajectory_dimensions: 2,
        flags: acquisitionFlags(
            IsmrmrdAcqFlag.LAST_IN_ENCODE_STEP1, IsmrmrdAcqFlag.LAST_IN_SLICE, IsmrmrdAcqFlag.LAST_IN_REPETITION,
            IsmrmrdAcqFlag.LAST_IN_MEASUREMENT, IsmrmrdAcqFlag.USER8,
        ),
        // Channels 0, 1 and 1023: the last word's top bit.
        channel_mask: [3n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 1n << 63n],
        idx: { kspace_encode_step_1: 2, slice: 0 },
        user_float: [1, 2, 3, 4, 5, 6, 7, 8],
    }),
].map((head, index) => acquisition(index, head));

const json = (value: unknown): unknown => {
    if (typeof value === 'bigint') return value.toString();
    if (ArrayBuffer.isView(value)) return Array.from(value as Float32Array);
    if (Array.isArray(value)) return value.map(json);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, json(inner)]));
    }
    return value;
};

/** expected.json: indented, with arrays of numbers and strings kept on one line. */
export function fixtureJson(): string {
    const text = JSON.stringify(fixtureExpectation(), null, 2);
    return `${text.replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_, items: string) => `[${items.split(/,\s+/).join(', ')}]`)}\n`;
}

/**
 * What a reader must find: 64-bit values as decimal strings, float fields as
 * the float32 values actually stored.
 */
export function fixtureExpectation(): unknown {
    const f32 = (values: readonly number[]) => values.map(v => Math.fround(v));
    return {
        description: 'Expected contents of small.h5 and small.stream, written by test/sim/io/ismrmrd.test.ts.',
        datasetName: 'dataset',
        xml: FIXTURE_XML,
        flags: { ...IsmrmrdAcqFlag },
        acquisitions: FIXTURE_ACQUISITIONS.map(({ head, traj, data }) => json({
            head: {
                ...head,
                sample_time_us: Math.fround(head.sample_time_us),
                position: f32(head.position),
                read_dir: f32(head.read_dir),
                phase_dir: f32(head.phase_dir),
                slice_dir: f32(head.slice_dir),
                patient_table_position: f32(head.patient_table_position),
                user_float: f32(head.user_float),
            },
            traj,
            data,
        })),
    };
}
