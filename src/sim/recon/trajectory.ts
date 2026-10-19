/**
 * The k-space position of every ADC sample, for reconstruction.
 *
 * k restarts at each excitation centre and is negated at each refocusing
 * centre — the encoding convention the viewer's k-space panel uses, which is
 * what places a sample in k-space for recon. (It is a bookkeeping convention,
 * not magnetization physics; the engine never uses it.)
 */

import type { SimProgram } from '../program/compile';
import { adcSampleTimes } from '../program/compile';
import { piecesKAt } from '../program/pwl';
import type { AdcSegment, SimSegment } from '../program/types';

export interface AdcTrajectory {
    /** Number of ADC readouts. */
    readouts: number;
    /** Samples per readout. */
    samples: Int32Array;
    /** First sample index of each readout. */
    offsets: Int32Array;
    /** k per sample, xyz interleaved [1/m]. */
    k: Float64Array;
    /** For each readout, the ordinal of the excitation it follows (−1 before any). */
    excitation: Int32Array;
    /**
     * For each readout, which slice its excitation selects ('' before any):
     * the excitation's frequency offset, which is what places a slice. Not the
     * pulse's operator key, which also changes with the phase-encode rewinders
     * sharing its block or an RF phase cycle, and would make a slice of every TR.
     */
    excitationKey: string[];
    /** Readout window start [s, program clock] and sample spacing [s]; sample s sits at t0 + (s + ½)·dwell. */
    t0: Float64Array;
    dwell: Float64Array;
}

export function adcTrajectory(program: SimProgram): AdcTrajectory {
    const samples: number[] = [];
    const offsets: number[] = [];
    const excitation: number[] = [];
    const excitationKey: string[] = [];
    const t0: number[] = [];
    const dwell: number[] = [];
    const chunks: Float64Array[] = [];
    let total = 0;
    forEachReadout(program.segments(), (segment, local, excitations, currentKey) => {
        chunks.push(local);
        offsets.push(total);
        samples.push(segment.numSamples);
        excitation.push(excitations);
        excitationKey.push(currentKey);
        t0.push(segment.t0);
        dwell.push(segment.dwell);
        total += segment.numSamples;
    });
    const kAll = new Float64Array(3 * total);
    let position = 0;
    for (const chunk of chunks) {
        kAll.set(chunk, position);
        position += chunk.length;
    }
    return {
        readouts: samples.length,
        samples: Int32Array.from(samples),
        offsets: Int32Array.from(offsets),
        k: kAll,
        excitation: Int32Array.from(excitation),
        excitationKey,
        t0: Float64Array.from(t0),
        dwell: Float64Array.from(dwell),
    };
}

/**
 * The largest |k| any ADC sample reaches along x, y and z [1/m], as
 * adcTrajectory places them, without keeping the samples (a long 3-D
 * sequence has hundreds of MB of them). Takes the program's segments, so a
 * pass over them can serve other uses too.
 */
export function adcEncodingExtents(segments: Iterable<SimSegment>): [number, number, number] {
    const largest: [number, number, number] = [0, 0, 0];
    forEachReadout(segments, (_segment, local) => {
        for (let i = 0; i < local.length; i++) {
            const a = i % 3;
            if (Math.abs(local[i]) > largest[a]) largest[a] = Math.abs(local[i]);
        }
    });
    return largest;
}

/**
 * Each readout in program order with its samples' k (xyz interleaved, a
 * fresh array), the ordinal of the excitation it follows and that
 * excitation's frequency key.
 */
function forEachReadout(
    segments: Iterable<SimSegment>,
    visit: (segment: AdcSegment, k: Float64Array, excitation: number, excitationKey: string) => void,
): void {
    const k = [0, 0, 0];
    let excitations = -1;
    let currentKey = '';
    for (const segment of segments) {
        if (segment.kind === 'rf') {
            for (let a = 0; a < 3; a++) k[a] += segment.kToCenter[a];
            const use = segment.use || '';
            if (use === 'e' || use === '' || use === 'u') {
                k.fill(0);
                excitations++;
                currentKey = String(segment.operator.freqOffset);
            } else if (use === 'r') {
                for (let a = 0; a < 3; a++) k[a] = -k[a];
            }
            for (let a = 0; a < 3; a++) k[a] += segment.moments.dk[a] - segment.kToCenter[a];
        } else if (segment.kind === 'adc') {
            const times = adcSampleTimes(segment);
            const local = new Float64Array(3 * times.length);
            piecesKAt(segment.gradient, times, local);
            for (let s = 0; s < times.length; s++) {
                for (let a = 0; a < 3; a++) local[3 * s + a] += k[a];
            }
            visit(segment, local, excitations, currentKey);
            for (let a = 0; a < 3; a++) k[a] += segment.moments.dk[a];
        } else {
            for (let a = 0; a < 3; a++) k[a] += segment.moments.dk[a];
        }
    }
}
