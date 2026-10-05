/**
 * Spins per voxel along a spoiled axis, chosen by simulating one voxel.
 *
 * A closed-form count fails on spoiled sequences. N stratified spins sum a
 * transverse pathway with dephasing c cycles across the voxel to the Dirichlet
 * kernel sin(πc)/(N·sin(πc/N)), which comes back to 1 whenever c nears a
 * multiple of N. Whether that matters depends on the pathway surviving to that
 * dephasing: relaxation, and RF spoiling, which cancels most pathways but
 * leaves those with j·Δφ ≡ 0 (mod 360°) coherent (j = 40 for the usual 117°).
 * Long-T2 tissue such as CSF therefore needs N above the whole scan's
 * dephasing: about 330 spins per voxel for the demo GRE, where 31 or 256
 * leave visible stripes.
 *
 * The probe therefore measures. It simulates a single voxel, for each tissue,
 * against a reference with enough spins that no pathway aliases within the
 * horizon. It returns the smallest candidate whose signal stays within
 * tolerance (relative L2 over every ADC sample; by Parseval, about the image
 * error).
 */

import { simulateReference } from '../engine/reference';
import type { SpinSet } from '../engine/spins';
import type { SimProgram } from '../program/compile';

export interface ProbeTissue {
    t1: number;
    t2: number;
}

export interface ProbeOptions {
    /** Smallest count to consider (e.g. from the resolution rule). */
    minimum?: number;
    /** Largest count to consider (default 2048). */
    maximum?: number;
    /** Relative L2 signal error to accept (default 0.02). */
    tolerance?: number;
    /**
     * Net dephasing across the voxel between consecutive pulses [cycles]
     * (plan/dephasing.ts). It sizes the default reference.
     */
    intervalCycles?: number;
    /**
     * Reference spins along the axis. The default is twice the dephasing the
     * pulses within the horizon can pile up (intervalCycles × pulses), so no
     * pathway aliases in the reference; 1024 when intervalCycles is not given.
     */
    reference?: number;
    /** Simulated time from the sequence start [s] (default 4 s). */
    horizon?: number;
    /** Counts to try, ascending (default a mixed list; powers of two keep voxels on one lattice). */
    candidates?: readonly number[];
}

/** Powers of two from 1 to 4096: counts whose stratified positions nest on one lattice. */
export const POWER_OF_TWO_COUNTS: readonly number[] = Array.from({ length: 13 }, (_, i) => 2 ** i);

export interface ProbeResult {
    /** Chosen spins per voxel along the axis. */
    count: number;
    /** Its relative error against the reference (worst tissue). */
    error: number;
    reference: number;
    /** No candidate up to `maximum` met the tolerance; `count` is the largest tested. */
    capped: boolean;
    /**
     * Every candidate tried. A candidate stops at the first tissue over the
     * tolerance, so a failing candidate's error is a lower bound.
     */
    tested: { count: number; error: number }[];
}

const CANDIDATES = [2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048];

export function probeSubSpins(
    program: SimProgram,
    axis: 0 | 1 | 2,
    voxel: number,
    tissues: readonly ProbeTissue[],
    options: ProbeOptions = {},
): ProbeResult {
    const minimum = Math.max(1, Math.floor(options.minimum ?? 1));
    const tolerance = options.tolerance ?? 0.02;
    const horizon = Math.min(program.totalDuration, options.horizon ?? 4);
    const reference = Math.max(minimum + 1, Math.floor(options.reference ?? defaultReference(program, horizon, options.intervalCycles)));
    // Candidates stay well below the reference, which must out-resolve them.
    const maximum = Math.max(minimum, Math.min(Math.floor(options.maximum ?? 2048), Math.floor(reference / 2)));
    const run = (count: number, tissue: ProbeTissue) =>
        simulateReference(program, probeVoxel(axis, voxel, count, tissue), { until: horizon }).signal;

    // Longest-lived tissues first: they keep pathways coherent longest, so a
    // failing candidate usually fails on the first tissue tried.
    const order = distinctTissues(tissues).sort((a, b) => lifetime(b) - lifetime(a));
    const references: (Float64Array | null)[] = order.map(() => null);
    const norms: number[] = order.map(() => 0);
    const referenceFor = (t: number): Float64Array => {
        let signal = references[t];
        if (!signal) {
            signal = run(reference, order[t]);
            references[t] = signal;
            norms[t] = norm(signal);
        }
        return signal;
    };

    const list = options.candidates ?? CANDIDATES;
    const first = options.candidates ? list.find(n => n >= minimum) ?? maximum : minimum;
    const candidates = [first, ...list.filter(n => n > first && n <= maximum)];
    const tested: { count: number; error: number }[] = [];
    for (const count of candidates) {
        let error = 0;
        for (let t = 0; t < order.length && error <= tolerance; t++) {
            const target = referenceFor(t);
            if (!(norms[t] > 0)) continue;
            error = Math.max(error, distance(run(count, order[t]), target) / norms[t]);
        }
        tested.push({ count, error });
        if (error <= tolerance) return { count, error, reference, capped: false, tested };
    }
    // Nothing met the tolerance: the largest candidate is the safe choice, even
    // where a smaller one happened to score lower on the tissue that stopped it.
    const last = tested[tested.length - 1];
    return { count: last.count, error: last.error, reference, capped: true, tested };
}

/** Reference size: 2 × cycles × pulses before the horizon, as a power of two in [256, 8192]. */
function defaultReference(program: SimProgram, horizon: number, cycles: number | undefined): number {
    if (!(cycles !== undefined && cycles > 0)) return 1024;
    let pulses = 0;
    for (const segment of program.segments()) {
        if (segment.t0 >= horizon) break;
        if (segment.kind === 'rf') pulses++;
    }
    const wanted = 2 * cycles * Math.max(1, pulses);
    return Math.min(8192, Math.max(256, 2 ** Math.ceil(Math.log2(wanted))));
}

/**
 * One voxel at the isocentre: `count` spins along `axis` at the stratified
 * offsets spinsFromGrid2D uses, weights summing to 1.
 */
function probeVoxel(axis: 0 | 1 | 2, voxel: number, count: number, tissue: ProbeTissue): SpinSet {
    const positions = [new Float64Array(count), new Float64Array(count), new Float64Array(count)];
    for (let a = 0; a < count; a++) positions[axis][a] = ((a + 0.5) / count - 0.5) * voxel;
    const rate = (time: number) => (Number.isFinite(time) && time > 0 ? 1 / time : 0);
    return {
        count,
        x: positions[0], y: positions[1], z: positions[2],
        df: new Float64Array(count),
        r1: new Float64Array(count).fill(rate(tissue.t1)),
        r2: new Float64Array(count).fill(rate(tissue.t2)),
        weight: new Float64Array(count).fill(1 / count),
        b1Re: new Float64Array(count).fill(1), b1Im: new Float64Array(count),
        coils: 1,
        rxRe: new Float64Array(count).fill(1), rxIm: new Float64Array(count),
    };
}

function distinctTissues(tissues: readonly ProbeTissue[]): ProbeTissue[] {
    const seen = new Map<string, ProbeTissue>();
    for (const tissue of tissues) seen.set(`${tissue.t1}|${tissue.t2}`, tissue);
    return [...seen.values()];
}

/** How long a tissue keeps transverse pathways: T2, then T1 to break ties. */
function lifetime(tissue: ProbeTissue): number {
    const t2 = Number.isFinite(tissue.t2) ? tissue.t2 : 1e9;
    const t1 = Number.isFinite(tissue.t1) ? tissue.t1 : 1e9;
    return t2 + 1e-6 * t1;
}

function norm(signal: Float64Array): number {
    let sum = 0;
    for (let i = 0; i < signal.length; i++) sum += signal[i] * signal[i];
    return Math.sqrt(sum);
}

function distance(a: Float64Array, b: Float64Array): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
    return Math.sqrt(sum);
}
