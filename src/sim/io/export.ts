/**
 * Files from a finished simulation: ISMRMRD (HDF5 dataset or stream) and
 * NumPy, built in the worker that still holds the job.
 *
 * The delivered signal follows the engine's output convention (∝ e^{−iωt},
 * conventions.ts), so an inverse FFT of Cartesian data gives the image, as
 * for scanner data converted to ISMRMRD. Data are complex64, channel-major
 * per acquisition as ISMRMRD stores them.
 */

import { detectSequenceTiming } from '../../pulseq/trdetect';
import type { SimulationJob } from '../job';
import { COUNTERS, normalisedTrajectory, planExport, type ExportPlan, type GridInfo } from './exportPlan';
import {
    acquisitionFlags,
    acquisitionHeader,
    buildIsmrmrdHeaderXml,
    writeIsmrmrdHdf5,
    writeIsmrmrdStream,
    type IsmrmrdAcquisition,
    type IsmrmrdEncodingLimits,
    type IsmrmrdHeaderInfo,
    type IsmrmrdLimitName,
} from './ismrmrd';
import type { NpyWriteInput } from './npy';
import { writeNpz } from './npz';

export type ExportFormat = 'ismrmrd-h5' | 'ismrmrd-stream' | 'npz';

export interface ExportFile {
    /** Suffix appended to the panel's file stem, e.g. '.h5'. */
    name: string;
    mime: string;
    bytes: Uint8Array;
}

/** Fraction of samples off the Cartesian grid above which data is called non-Cartesian. */
const NON_CARTESIAN = 0.05;

export function buildExport(job: SimulationJob, signal: Float64Array, format: ExportFormat): ExportFile {
    const coils = job.plan.coils;
    if (signal.length !== 2 * coils * job.plan.adcSamples) throw new Error('The signal does not match the job.');
    if (format === 'npz') return { name: '.npz', mime: 'application/zip', bytes: numpyExport(job, signal) };

    // The grid only (k placement), so an empty signal will do.
    const recon = job.reconstruct(new Float64Array(signal.length));
    const cartesian = recon.offGridFraction <= NON_CARTESIAN;
    const grid: GridInfo = {
        delta: cartesian ? recon.delta : null,
        axes: recon.axes, nu: recon.nu, nv: recon.nv, offset: recon.offset,
    };
    const plan = planExport(job.rawLayout(), grid);
    const xml = buildIsmrmrdHeaderXml(headerInfo(job, plan, grid, cartesian));
    const acquisitions = ismrmrdAcquisitions(job, signal, plan, cartesian);
    if (format === 'ismrmrd-h5') return { name: '.h5', mime: 'application/x-hdf5', bytes: writeIsmrmrdHdf5(xml, acquisitions) };
    return { name: '.bin', mime: 'application/octet-stream', bytes: writeIsmrmrdStream(xml, acquisitions) };
}

/** ISMRMRD's XML names for the encoding counters. */
const LIMIT_OF: Record<(typeof COUNTERS)[number], IsmrmrdLimitName> = {
    kspace_encode_step_1: 'kspace_encoding_step_1',
    kspace_encode_step_2: 'kspace_encoding_step_2',
    average: 'average',
    slice: 'slice',
    contrast: 'contrast',
    phase: 'phase',
    repetition: 'repetition',
    set: 'set',
    segment: 'segment',
};

function headerInfo(job: SimulationJob, plan: ExportPlan, grid: GridInfo, cartesian: boolean): IsmrmrdHeaderInfo {
    const timing = detectSequenceTiming(job.program.sequence);
    const fov = job.fieldOfView;
    const p = job.plan;
    const fieldOfView_mm = fov
        ? { x: fov[0] * 1000, y: fov[1] * 1000, z: Math.max(fov[2], 0) * 1000 }
        : grid.delta
            ? { x: 1000 / grid.delta[0], y: 1000 / grid.delta[1], z: 1 }
            : { x: p.phantom.fov[0] * 1000, y: p.phantom.fov[1] * 1000, z: 1 };
    const matrixSize = { x: grid.nu, y: grid.nv, z: 1 };
    const encodingLimits: IsmrmrdEncodingLimits = {
        kspace_encoding_step_0: { minimum: 0, maximum: Math.max(0, grid.nu - 1), center: grid.nu >> 1 },
    };
    for (const counter of COUNTERS) encodingLimits[LIMIT_OF[counter]] = plan.limits[counter];

    const userParameterString = [
        { name: 'seqeyes_simulation', value: 'SeqEyes Bloch simulation (reference engine, cpu-f64)' },
        { name: 'seqeyes_phantom', value: p.phantom.source },
        { name: 'seqeyes_signal_convention', value: 'delivered signal proportional to exp(-i omega t): inverse FFT reconstructs' },
        { name: 'seqeyes_counters_from_labels', value: plan.labelled.join(',') || 'none (kspace_encode_step_1 from the k-space grid)' },
    ];
    const userParameterLong = [
        { name: 'seqeyes_spins', value: p.spins },
        { name: 'seqeyes_simulated_spins', value: p.simulated },
        { name: 'seqeyes_spins_per_voxel_x', value: p.subSpins[0] },
        { name: 'seqeyes_spins_per_voxel_y', value: p.subSpins[1] },
    ];
    for (const counter of COUNTERS) {
        if (plan.counterOffsets[counter] !== 0) userParameterLong.push({ name: `seqeyes_label_offset_${counter}`, value: plan.counterOffsets[counter] });
    }
    const protocolName = job.program.sequence.definitionsRaw.get('Name');
    return {
        H1resonanceFrequency_Hz: Math.round(p.gamma * p.b0),
        receiverChannels: p.coils,
        systemFieldStrength_T: p.b0,
        encodedSpace: { matrixSize, fieldOfView_mm },
        reconSpace: { matrixSize, fieldOfView_mm },
        trajectory: cartesian ? 'cartesian' : 'other',
        encodingLimits,
        sequenceParameters: {
            TR: timing.trTimeSec > 0 ? [timing.trTimeSec * 1000] : undefined,
            TE: timing.hasExplicitTE && timing.teTimeSec > 0 ? [timing.teTimeSec * 1000] : undefined,
        },
        measurementInformation: { protocolName: protocolName ? String(protocolName).trim() : 'pulseq', patientPosition: 'HFS' },
        acquisitionSystemInformation: { systemVendor: 'SeqEyes', systemModel: 'Bloch simulator' },
        userParameters: { userParameterLong, userParameterString },
    };
}

function ismrmrdAcquisitions(job: SimulationJob, signal: Float64Array, plan: ExportPlan, cartesian: boolean): IsmrmrdAcquisition[] {
    const layout = job.rawLayout();
    const coils = layout.coils;
    // Non-Cartesian data carries its trajectory, scaled to ±0.5 at the matrix edge.
    const kmax: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < layout.k.length; i++) kmax[i % 3] = Math.max(kmax[i % 3], Math.abs(layout.k[i]));
    const peak = Math.max(...kmax);
    const trajectoryAxes = cartesian ? [] : [0, 1, 2].filter(axis => kmax[axis] > 1e-9 * peak);
    const out: IsmrmrdAcquisition[] = [];
    for (let a = 0; a < layout.acquisitions; a++) {
        const n = layout.samples[a];
        const data = new Float32Array(coils * n * 2);
        for (let s = 0; s < n; s++) {
            for (let c = 0; c < coils; c++) {
                const src = ((layout.offsets[a] + s) * coils + c) * 2;
                const dst = (c * n + s) * 2;
                data[dst] = signal[src];
                data[dst + 1] = signal[src + 1];
            }
        }
        const acquisition = plan.acquisitions[a];
        out.push({
            head: acquisitionHeader({
                flags: acquisitionFlags(...acquisition.flags),
                scan_counter: a,
                // ISMRMRD time stamps count 2.5 ms ticks, as the scanners' do.
                acquisition_time_stamp: Math.round(layout.t0[a] / 2.5e-3),
                number_of_samples: n,
                active_channels: coils,
                center_sample: acquisition.centerSample,
                trajectory_dimensions: trajectoryAxes.length,
                sample_time_us: layout.dwell[a] * 1e6,
                read_dir: [1, 0, 0],
                phase_dir: [0, 1, 0],
                slice_dir: [0, 0, 1],
                idx: acquisition.idx,
            }),
            traj: trajectoryAxes.length ? normalisedTrajectory(layout, a, kmax, trajectoryAxes) : new Float32Array(0),
            data,
        });
    }
    return out;
}

/**
 * NumPy archive: data (acquisitions × coils × samples, complex64) when every
 * readout has the same length, else (samples, coils) with offsets; the
 * trajectory [1/m]; readout start times and dwell; every label column; and a
 * JSON description as UTF-8 bytes (`bytes(npz['metadata_json']).decode()`).
 */
function numpyExport(job: SimulationJob, signal: Float64Array): Uint8Array {
    const layout = job.rawLayout();
    const coils = layout.coils;
    const total = signal.length / (2 * coils);
    const uniform = layout.samples.every(n => n === layout.samples[0]);
    const re = new Float32Array(total * coils), im = new Float32Array(total * coils);
    let shape: number[];
    if (uniform) {
        const n = layout.samples[0];
        shape = [layout.acquisitions, coils, n];
        for (let a = 0; a < layout.acquisitions; a++) {
            for (let c = 0; c < coils; c++) {
                for (let s = 0; s < n; s++) {
                    const src = ((layout.offsets[a] + s) * coils + c) * 2;
                    const dst = (a * coils + c) * n + s;
                    re[dst] = signal[src];
                    im[dst] = signal[src + 1];
                }
            }
        }
    } else {
        shape = [total, coils];
        for (let i = 0; i < total * coils; i++) {
            re[i] = signal[2 * i];
            im[i] = signal[2 * i + 1];
        }
    }
    const entries = new Map<string, NpyWriteInput>();
    entries.set('data', { shape, data: re, imag: im });
    entries.set('traj', { shape: [total, 3], data: layout.k });
    entries.set('offsets', { shape: [layout.acquisitions], data: layout.offsets });
    entries.set('t0', { shape: [layout.acquisitions], data: layout.t0 });
    entries.set('dwell', { shape: [layout.acquisitions], data: layout.dwell });
    const width = layout.labels.names.length;
    layout.labels.names.forEach((name, l) => {
        const column = new Int32Array(layout.acquisitions);
        for (let a = 0; a < layout.acquisitions; a++) column[a] = layout.labels.values[a * width + l];
        entries.set(`label_${name}`, { shape: [layout.acquisitions], data: column });
    });
    const description = {
        format: 'SeqEyes simulated raw data',
        signal: 'complex64, delivered proportional to exp(-i omega t): an inverse FFT reconstructs',
        data: uniform ? 'data[acquisition, coil, sample]' : 'data[sample, coil]; readout a is data[offsets[a]:offsets[a] + n_a]',
        traj: 'k [1/m] per sample (x, y, z), reset at each excitation',
        times: 'sample s of readout a is at t0[a] + (s + 0.5) * dwell[a] seconds',
        labels: layout.labels.names,
        phantom: job.plan.phantom.source,
        spinsPerVoxel: job.plan.subSpins,
        coils,
        b0T: job.plan.b0,
    };
    const json = utf8(JSON.stringify(description, null, 1));
    entries.set('metadata_json', { shape: [json.length], data: json });
    return writeNpz(entries);
}

/** UTF-8 bytes of a string (TextEncoder is not declared for the isomorphic core). */
function utf8(text: string): Uint8Array {
    const out: number[] = [];
    for (const char of text) {
        const code = char.codePointAt(0)!;
        if (code < 0x80) out.push(code);
        else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
        else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
        else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    }
    return Uint8Array.from(out);
}
