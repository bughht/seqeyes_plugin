/**
 * physicalGradients.ts — single source of truth for *physical* gradient
 * waveforms, i.e. the logical `DecodedGradWaveform` channels after the
 * per-block rotation extension has been applied.
 *
 * `rotateGradient` and `physicalGradientPiece` used to live in `kspace.ts`.
 * They moved here unchanged because acoustics, the gradient spectrogram and
 * the simulated gradient sound are all properties of the physical coils, so
 * three callers now need the same rotated waveform. `kspace.ts` imports them
 * back; its baselines are the guard that the move changed no behaviour.
 */

import type { DecodedBlock, DecodedGradWaveform } from './types';

/** Endpoint merge tolerance, shared with the k-space series builder. */
export const GRADIENT_ENDPOINT_TOLERANCE_SEC = 1e-12;

export interface GradientSeries {
    times: number[];
    values: number[];
    requiredSupport: number[];
}

/**
 * A uniformly resampled window of the three physical gradient axes.
 * Values are in Hz/m, matching `DecodedGradWaveform.waveform`.
 */
export interface PhysicalGradientWindow {
    /** Time of sample 0 [s]. */
    t0: number;
    /** Sample spacing [s]. */
    dt: number;
    /** Sample count per axis. */
    n: number;
    gx: Float32Array;
    gy: Float32Array;
    gz: Float32Array;
}

export interface ResampleOptions {
    startSec: number;
    endSec: number;
    /** Sample rate [Hz]. Ignored when `dt` is given. */
    sampleRate?: number;
    /** Sample spacing [s]. Takes precedence over `sampleRate`. */
    dt?: number;
    /** Explicit sample count; derived from the window and `dt` when omitted. */
    sampleCount?: number;
}

/** Apply a block's rotation extension to one logical gradient triplet. */
export function rotateGradient(
    block: DecodedBlock,
    gx: number,
    gy: number,
    gz: number,
): [number, number, number] {
    const values = block.rotation?.values;
    if (!values) return [gx, gy, gz];

    if (values.length === 4) {
        const [w, x, y, z] = values;
        const r00 = 1 - 2 * y * y - 2 * z * z;
        const r01 = 2 * x * y - 2 * w * z;
        const r02 = 2 * x * z + 2 * w * y;
        const r10 = 2 * x * y + 2 * w * z;
        const r11 = 1 - 2 * x * x - 2 * z * z;
        const r12 = 2 * y * z - 2 * w * x;
        const r20 = 2 * x * z - 2 * w * y;
        const r21 = 2 * y * z + 2 * w * x;
        const r22 = 1 - 2 * x * x - 2 * y * y;
        return [
            r00 * gx + r01 * gy + r02 * gz,
            r10 * gx + r11 * gy + r12 * gz,
            r20 * gx + r21 * gy + r22 * gz,
        ];
    }

    if (values.length === 9) {
        return [
            values[0] * gx + values[1] * gy + values[2] * gz,
            values[3] * gx + values[4] * gy + values[5] * gz,
            values[6] * gx + values[7] * gy + values[8] * gz,
        ];
    }

    return [gx, gy, gz];
}

/** Linear interpolation inside one decoded gradient event; zero outside it. */
export function gradientValueAt(g: DecodedGradWaveform | undefined, t: number): number {
    if (!g || g.type === 'none') return 0;
    const tp = g.timePoints, wf = g.waveform;
    if (!tp || tp.length < 2) return 0;
    const first = tp[0], last = tp[tp.length - 1];
    if (t < first - GRADIENT_ENDPOINT_TOLERANCE_SEC
        || t > last + GRADIENT_ENDPOINT_TOLERANCE_SEC) return 0;
    if (t <= first + GRADIENT_ENDPOINT_TOLERANCE_SEC) return wf[0];
    if (t >= last - GRADIENT_ENDPOINT_TOLERANCE_SEC) return wf[wf.length - 1];
    let lo = 0, hi = tp.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tp[m] <= t) lo = m; else hi = m; }
    const s = tp[hi] - tp[lo];
    if (s <= 0) return wf[lo];
    return wf[lo] + (wf[hi] - wf[lo]) * (t - tp[lo]) / s;
}

/** Physical (rotated) value of one axis of one block at an absolute time. */
export function physicalGradientValueAt(block: DecodedBlock, axis: number, t: number): number {
    if (!block.rotation?.values) {
        const gradient = [block.gx, block.gy, block.gz][axis];
        return gradientValueAt(gradient, t);
    }
    const rotated = rotateGradient(
        block,
        gradientValueAt(block.gx, t),
        gradientValueAt(block.gy, t),
        gradientValueAt(block.gz, t),
    );
    return rotated[axis];
}

/**
 * Piecewise-linear support of one physical axis inside one block.
 *
 * Without a rotation the decoded support is retained exactly — the common path,
 * matching Pulseq's per-axis waveform pieces. With a rotation the differently
 * sampled logical axes are evaluated on their union so the rotated physical
 * component stays piecewise linear.
 */
export function physicalGradientPiece(block: DecodedBlock, axis: number): GradientSeries {
    const gradients = [block.gx, block.gy, block.gz];
    const hasGradient = gradients.some(g => g && g.type !== 'none' && g.timePoints.length >= 2);
    if (!hasGradient) return { times: [], values: [], requiredSupport: [] };

    if (!block.rotation?.values) {
        const gradient = gradients[axis];
        if (!gradient || gradient.type === 'none' || gradient.timePoints.length < 2) {
            return { times: [], values: [], requiredSupport: [] };
        }
        return {
            times: Array.from(gradient.timePoints),
            values: Array.from(gradient.waveform),
            requiredSupport: [],
        };
    }

    const times: number[] = [];
    for (const gradient of gradients) {
        if (!gradient || gradient.type === 'none') continue;
        for (const time of gradient.timePoints) times.push(time);
    }
    times.sort((a, b) => a - b);
    const uniqueTimes: number[] = [];
    for (const time of times) {
        if (!uniqueTimes.length || time - uniqueTimes[uniqueTimes.length - 1] > GRADIENT_ENDPOINT_TOLERANCE_SEC) {
            uniqueTimes.push(time);
        }
    }
    return {
        times: uniqueTimes,
        values: uniqueTimes.map(time => {
            const rotated = rotateGradient(
                block,
                gradientValueAt(block.gx, time),
                gradientValueAt(block.gy, time),
                gradientValueAt(block.gz, time),
            );
            return rotated[axis];
        }),
        requiredSupport: [],
    };
}

/**
 * Resample all three physical gradient axes onto a uniform raster.
 *
 * Times outside every block, and times inside a block but outside its gradient
 * events, evaluate to zero — the physically correct value for "no gradient is
 * being played", and what keeps the spectrogram edges honest when the requested
 * window reaches past the sequence.
 */
export function resamplePhysicalGradients(
    blocks: DecodedBlock[],
    options: ResampleOptions,
): PhysicalGradientWindow {
    const startSec = Number.isFinite(options.startSec) ? options.startSec : 0;
    const endSec = Number.isFinite(options.endSec) ? options.endSec : startSec;
    const dt = options.dt && options.dt > 0
        ? options.dt
        : (options.sampleRate && options.sampleRate > 0 ? 1 / options.sampleRate : 0);
    if (!(dt > 0)) throw new Error('resamplePhysicalGradients requires a positive dt or sampleRate.');

    const span = Math.max(0, endSec - startSec);
    const n = options.sampleCount !== undefined && Number.isFinite(options.sampleCount)
        ? Math.max(0, Math.floor(options.sampleCount))
        : Math.max(1, Math.floor(span / dt + 1e-9) + 1);

    const gx = new Float32Array(n);
    const gy = new Float32Array(n);
    const gz = new Float32Array(n);
    if (!n) return { t0: startSec, dt, n, gx, gy, gz };

    const sorted = blocks.filter(block => Number.isFinite(block.startTime))
        .sort((a, b) => a.startTime - b.startTime);
    if (!sorted.length) return { t0: startSec, dt, n, gx, gy, gz };

    // Forward cursor: sample times increase monotonically and blocks are
    // non-overlapping, so the block covering t is the last one that started.
    let cursor = 0;
    for (let i = 0; i < n; i++) {
        const t = startSec + i * dt;
        while (cursor + 1 < sorted.length && sorted[cursor + 1].startTime <= t) cursor++;
        const block = sorted[cursor];
        if (t < block.startTime - GRADIENT_ENDPOINT_TOLERANCE_SEC
            || t > block.startTime + block.duration + GRADIENT_ENDPOINT_TOLERANCE_SEC) continue;
        const lx = gradientValueAt(block.gx, t);
        const ly = gradientValueAt(block.gy, t);
        const lz = gradientValueAt(block.gz, t);
        if (lx === 0 && ly === 0 && lz === 0) continue;
        if (!block.rotation?.values) {
            gx[i] = lx; gy[i] = ly; gz[i] = lz;
        } else {
            const rotated = rotateGradient(block, lx, ly, lz);
            gx[i] = rotated[0]; gy[i] = rotated[1]; gz[i] = rotated[2];
        }
    }
    return { t0: startSec, dt, n, gx, gy, gz };
}

/**
 * Central-difference derivative of a uniformly sampled signal. Endpoints use
 * one-sided differences so the sample count is preserved.
 */
export function differentiateUniform(values: Float32Array, dt: number): Float32Array {
    const n = values.length;
    const out = new Float32Array(n);
    if (n < 2 || !(dt > 0)) return out;
    out[0] = (values[1] - values[0]) / dt;
    out[n - 1] = (values[n - 1] - values[n - 2]) / dt;
    const inv = 1 / (2 * dt);
    for (let i = 1; i < n - 1; i++) out[i] = (values[i + 1] - values[i - 1]) * inv;
    return out;
}
