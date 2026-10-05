/**
 * What an export says about each acquisition, independent of the container.
 *
 * ISMRMRD wants, per readout: encoding counters (idx), flags, the sample
 * nearest k = 0, and optionally the trajectory; per file: encoding limits,
 * matrix and FOV. Pulseq labels supply the counters where the sequence sets
 * them (LIN → kspace_encode_step_1, PAR → step 2, SLC → slice, ECO →
 * contrast, PHS → phase, REP → repetition, SET → set, SEG → segment, AVG →
 * average; NAV, REV, NOISE, REF/IMA → flags). Without LIN, a Cartesian
 * readout's phase-encode line comes from where its centre sample sits on the
 * reconstruction grid, so unlabelled sequences still sort correctly.
 */

import type { RawLayout } from '../job';
import { IsmrmrdAcqFlag } from './ismrmrd';

/** ISMRMRD AcquisitionHeader flag bit numbers (value = 1 << (bit − 1)). */
export const ACQ_FLAG_BITS = IsmrmrdAcqFlag;

export type EncodingCounter =
    | 'kspace_encode_step_1' | 'kspace_encode_step_2' | 'average' | 'slice'
    | 'contrast' | 'phase' | 'repetition' | 'set' | 'segment';

export const COUNTERS: EncodingCounter[] = [
    'kspace_encode_step_1', 'kspace_encode_step_2', 'average', 'slice',
    'contrast', 'phase', 'repetition', 'set', 'segment',
];

/** Which Pulseq label fills which ISMRMRD counter. */
const LABEL_OF: Record<EncodingCounter, string> = {
    kspace_encode_step_1: 'LIN',
    kspace_encode_step_2: 'PAR',
    average: 'AVG',
    slice: 'SLC',
    contrast: 'ECO',
    phase: 'PHS',
    repetition: 'REP',
    set: 'SET',
    segment: 'SEG',
};

export interface AcquisitionPlan {
    /** Counter values (uint16 after offsetting; see ExportPlan.counterOffsets). */
    idx: Record<EncodingCounter, number>;
    /** Flag bit numbers to set. */
    flags: number[];
    centerSample: number;
}

export interface ExportPlan {
    acquisitions: AcquisitionPlan[];
    /** Per counter: subtracted from every value so the minimum becomes 0 (labels may be negative). */
    counterOffsets: Record<EncodingCounter, number>;
    /** Per counter: {minimum, maximum, center} after offsetting. */
    limits: Record<EncodingCounter, { minimum: number; maximum: number; center: number }>;
    /** Labels that set a counter (for provenance). */
    labelled: EncodingCounter[];
}

export interface GridInfo {
    /** Recon grid spacing [1/m] and axes (physical indices), when the data is Cartesian. */
    delta: [number, number] | null;
    axes: [number, number];
    nu: number;
    nv: number;
    /** Half-cell offset of each lattice (Pulseq's half-integer kx). */
    offset: [number, number];
}

export function planExport(layout: RawLayout, grid: GridInfo): ExportPlan {
    const names = layout.labels.names;
    const width = names.length;
    const column = (name: string) => names.indexOf(name);
    const label = (a: number, name: string) => {
        const c = column(name);
        return c >= 0 ? layout.labels.values[a * width + c] : 0;
    };
    const has = (name: string) => column(name) >= 0;

    const raw: Record<EncodingCounter, number>[] = [];
    const labelled = COUNTERS.filter(counter => has(LABEL_OF[counter]));
    for (let a = 0; a < layout.acquisitions; a++) {
        const values = {} as Record<EncodingCounter, number>;
        for (const counter of COUNTERS) values[counter] = label(a, LABEL_OF[counter]);
        if (!has('LIN') && grid.delta) values.kspace_encode_step_1 = gridLine(layout, a, grid);
        raw.push(values);
    }

    const counterOffsets = {} as Record<EncodingCounter, number>;
    const limits = {} as ExportPlan['limits'];
    for (const counter of COUNTERS) {
        let min = Infinity, max = -Infinity;
        for (const values of raw) {
            min = Math.min(min, values[counter]);
            max = Math.max(max, values[counter]);
        }
        if (!raw.length) min = max = 0;
        counterOffsets[counter] = min;
        const span = max - min;
        if (span > 65535) throw new Error(`The ${counter} counter spans ${span + 1} values, more than ISMRMRD's 16 bits hold.`);
        // Phase encodes are centred on k = 0 when they come from the grid.
        const center = counter === 'kspace_encode_step_1' && !has('LIN') && grid.delta
            ? Math.round(grid.nv / 2) - min
            : Math.floor(span / 2);
        limits[counter] = { minimum: 0, maximum: span, center: Math.max(0, Math.min(span, center)) };
    }

    // Flags from labels and from the order of the encoding counters.
    const acquisitions: AcquisitionPlan[] = raw.map((values, a) => {
        const idx = {} as Record<EncodingCounter, number>;
        for (const counter of COUNTERS) idx[counter] = values[counter] - counterOffsets[counter];
        const flags: number[] = [];
        if (label(a, 'NAV')) flags.push(ACQ_FLAG_BITS.IS_NAVIGATION_DATA);
        if (label(a, 'NOISE')) flags.push(ACQ_FLAG_BITS.IS_NOISE_MEASUREMENT);
        if (label(a, 'REF')) flags.push(label(a, 'IMA') ? ACQ_FLAG_BITS.IS_PARALLEL_CALIBRATION_AND_IMAGING : ACQ_FLAG_BITS.IS_PARALLEL_CALIBRATION);
        // Reversal from k only means something for Cartesian lines (EPI); a radial spoke is not "reversed".
        if (label(a, 'REV') || (grid.delta && reversedReadout(layout, a))) flags.push(ACQ_FLAG_BITS.IS_REVERSE);
        return { idx, flags, centerSample: centerSample(layout, a) };
    });
    markBoundaries(acquisitions);
    if (acquisitions.length) acquisitions[acquisitions.length - 1].flags.push(ACQ_FLAG_BITS.LAST_IN_MEASUREMENT);
    return { acquisitions, counterOffsets, limits, labelled };
}

/** First/last in encode step 1, slice and repetition, by scan order within each group. */
function markBoundaries(acquisitions: AcquisitionPlan[]): void {
    const groups: [number, (p: AcquisitionPlan) => string][] = [
        [ACQ_FLAG_BITS.FIRST_IN_SLICE, p => `${p.idx.slice}|${p.idx.repetition}|${p.idx.contrast}|${p.idx.set}`],
        [ACQ_FLAG_BITS.FIRST_IN_REPETITION, p => `${p.idx.repetition}`],
    ];
    for (const [firstBit, key] of groups) {
        const first = new Map<string, number>(), last = new Map<string, number>();
        acquisitions.forEach((p, a) => {
            const k = key(p);
            if (!first.has(k)) first.set(k, a);
            last.set(k, a);
        });
        for (const a of first.values()) acquisitions[a].flags.push(firstBit);
        for (const a of last.values()) acquisitions[a].flags.push(firstBit + 1);
    }
    // Encode step 1: first and last line within each slice group.
    const byGroup = new Map<string, { min: number; max: number; first: number[]; last: number[] }>();
    acquisitions.forEach((p, a) => {
        const k = `${p.idx.slice}|${p.idx.repetition}|${p.idx.contrast}|${p.idx.set}|${p.idx.kspace_encode_step_2}`;
        const line = p.idx.kspace_encode_step_1;
        let g = byGroup.get(k);
        if (!g) byGroup.set(k, g = { min: line, max: line, first: [], last: [] });
        if (line < g.min) { g.min = line; g.first = []; }
        if (line > g.max) { g.max = line; g.last = []; }
        if (line === g.min) g.first.push(a);
        if (line === g.max) g.last.push(a);
    });
    for (const g of byGroup.values()) {
        if (g.first.length) acquisitions[g.first[0]].flags.push(ACQ_FLAG_BITS.FIRST_IN_ENCODE_STEP1);
        if (g.last.length) acquisitions[g.last[g.last.length - 1]].flags.push(ACQ_FLAG_BITS.LAST_IN_ENCODE_STEP1);
    }
}

/** The sample whose k is nearest the centre of k-space along the readout. */
function centerSample(layout: RawLayout, a: number): number {
    const offset = layout.offsets[a], n = layout.samples[a];
    let best = Math.floor(n / 2), bestNorm = Infinity;
    for (let s = 0; s < n; s++) {
        const i = 3 * (offset + s);
        const norm = layout.k[i] ** 2 + layout.k[i + 1] ** 2 + layout.k[i + 2] ** 2;
        if (norm < bestNorm - 1e-12) {
            bestNorm = norm;
            best = s;
        }
    }
    return best;
}

/** A readout traversing its main k axis downwards (an EPI's odd lines). */
function reversedReadout(layout: RawLayout, a: number): boolean {
    const n = layout.samples[a];
    if (n < 2) return false;
    const first = 3 * layout.offsets[a], last = 3 * (layout.offsets[a] + n - 1);
    let span = 0;
    for (let d = 0; d < 3; d++) {
        const delta = layout.k[last + d] - layout.k[first + d];
        if (Math.abs(delta) > Math.abs(span)) span = delta;
    }
    return span < 0;
}

/** Phase-encode line of a readout from its centre sample's position on the grid. */
function gridLine(layout: RawLayout, a: number, grid: GridInfo): number {
    const centre = 3 * (layout.offsets[a] + (layout.samples[a] >> 1));
    const kv = layout.k[centre + grid.axes[1]];
    return Math.round(kv / grid.delta![1] - grid.offset[1]) + (grid.nv >> 1);
}

/**
 * Trajectory scaled the way Gadgetron's non-Cartesian gadgets expect:
 * k divided by the matrix edge (k·Δx), so the encoded matrix spans ±0.5.
 * Returns samples × dims, dims the axes with any k extent (2 or 3).
 */
export function normalisedTrajectory(layout: RawLayout, a: number, kmax: [number, number, number], axes: number[]): Float32Array {
    const n = layout.samples[a];
    const out = new Float32Array(n * axes.length);
    for (let s = 0; s < n; s++) {
        for (let d = 0; d < axes.length; d++) {
            const axis = axes[d];
            const k = layout.k[3 * (layout.offsets[a] + s) + axis];
            out[s * axes.length + d] = kmax[axis] > 0 ? 0.5 * k / kmax[axis] : 0;
        }
    }
    return out;
}
