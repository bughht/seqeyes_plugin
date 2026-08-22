/**
 * gradSpectrum.ts — time-frequency content of the physical gradient waveforms.
 *
 * Derived from pulseq's `mr.Sequence.gradSpectrum` (MATLAB, revision
 * 2fd6ab6af5a0cd47b6c15d8e5af09c986eb81007) with one deliberate departure:
 * upstream collapses the time axis with `mean(fseg.^2).^0.5`, a root-mean-square
 * over every 50 ms segment of the whole sequence. That average is gameable —
 * dummy scans, preparation blocks and quiet stretches dilute it, so a sequence
 * with a real resonance excitation inside one TR can be padded into looking
 * compliant. SeqEyes keeps the full time x frequency matrix instead, so a hot
 * 20 ms shows as a hot column.
 *
 * Kept from upstream so results stay comparable: gradient-raster sampling of the
 * *physical* (rotated) waveforms, per-segment DC removal, the Hann window
 * `0.5*(1-cos(2*pi*(1:nwin)/nwin))`, frequency oversampling by zero-padding
 * (`os = 3`), the root-sum-of-squares combination across axes, `fmax = 3000` Hz,
 * and the forbidden-band semantics `freq +/- bw/2`.
 *
 * Changed on purpose, each one testable:
 *   - view window instead of whole sequence (bounds cost, and matches the panel);
 *   - `nwin` derived from the view rather than a fixed 5000 samples;
 *   - magnitudes divided by the window coherent gain, so amplitudes stay
 *     comparable between settings (upstream warns about exactly this);
 *   - anti-aliased decimation before the FFT (see `decimator.ts`);
 *   - `dG/dt` selectable, since an upstream comment argues it is the more
 *     appropriate quantity for gradient sound.
 *
 * `computeGradSpectrumParity` reproduces upstream exactly and exists only for
 * the numeric baseline comparison; it is not what the UI shows.
 */

import type { DecodedBlock } from './types';
import {
    differentiateUniform,
    resamplePhysicalGradients,
} from './physicalGradients';
import {
    hannWindow,
    nextPowerOfTwo,
    previousPowerOfTwo,
    realFFTMagnitude,
    realFFTPairMagnitude,
    windowCoherentGain,
} from './fft';
import { decimatePadded, decimatedLength, planDecimation } from './decimator';
import {
    estimateSpectrogramCost,
    spectrogramBudgetRefusal,
    type SpectrogramCostEstimate,
} from './computeBudget';

export { estimateSpectrogramCost, spectrogramBudgetRefusal };
export type { SpectrogramCostEstimate };

/** Hz/m per mT/m for 1H, matching the viewer's `GAMMA` constant. */
export const GAMMA_HZ_PER_M_PER_MT_PER_M = 42576;
/** Hz/m per T/m for 1H. */
export const GAMMA_HZ_PER_M_PER_T_PER_M = 42.576e6;

export type SpectrogramSource = 'G' | 'dGdt';

export interface SpectrogramParams {
    source: SpectrogramSource;
    /** Lowest displayed frequency [Hz]. */
    fMinHz: number;
    /** Highest computed frequency [Hz]; also sets the decimation factor. */
    fMaxHz: number;
    /** Post-decimation window length in samples; 0 selects the automatic rule. */
    windowSamples: number;
    /** Fraction of the window shared between neighbouring columns. */
    overlap: number;
    /** Zero-pad factor applied before the FFT. */
    oversample: number;
    /** Column budget from the panel width in device pixels. */
    targetColumns: number;
    /** Divide magnitudes by the window coherent gain. */
    normalize: boolean;
}

export interface SpectrogramOptions extends Partial<SpectrogramParams> {
    startSec: number;
    endSec: number;
}

export interface GradientSpectrogramMatrices {
    gx: Float32Array;
    gy: Float32Array;
    gz: Float32Array;
    rss: Float32Array;
}

export interface GradientSpectrogram {
    nTime: number;
    nFreq: number;
    /** Centre time of column 0 [s]. */
    tStartSec: number;
    /** Column spacing [s]. */
    tStepSec: number;
    /** Centre frequency of row 0 [Hz]. */
    fStartHz: number;
    /** Row spacing [Hz]. */
    fStepHz: number;
    /** True time resolution — the window length, not the hop. */
    dtResolutionSec: number;
    /** True frequency resolution before zero-padding. */
    dfResolutionHz: number;
    unit: 'mT/m' | 'T/m/s';
    source: SpectrogramSource;
    /** Row-major `[freq][time]`, linear magnitude; dB happens at draw time. */
    data: GradientSpectrogramMatrices;
    minValue: number;
    maxValue: number;
    decimationFactor: number;
    decimatedRateHz: number;
    windowSamples: number;
    hopSamples: number;
    fftPoints: number;
    /** Window the caller asked for, echoed back for cache keys and readouts. */
    requestedStartSec: number;
    requestedEndSec: number;
    warnings: string[];
}

/** Shortest analysis window that still carries usable spectral information. */
export const MIN_WINDOW_SAMPLES = 32;

export const DEFAULT_SPECTROGRAM_PARAMS: SpectrogramParams = Object.freeze({
    source: 'G',
    fMinHz: 0,
    fMaxHz: 3000,
    windowSamples: 0,
    overlap: 0.75,
    oversample: 3,
    targetColumns: 256,
    normalize: true,
});

export function resolveSpectrogramParams(params?: Partial<SpectrogramParams>): SpectrogramParams {
    const merged = { ...DEFAULT_SPECTROGRAM_PARAMS, ...(params ?? {}) };
    const fMaxHz = clamp(finite(merged.fMaxHz, 3000), 1, 5e6);
    return {
        source: merged.source === 'dGdt' ? 'dGdt' : 'G',
        fMinHz: clamp(finite(merged.fMinHz, 0), 0, fMaxHz - 1),
        fMaxHz,
        windowSamples: Math.max(0, Math.floor(finite(merged.windowSamples, 0))),
        overlap: clamp(finite(merged.overlap, 0.75), 0, 0.9375),
        oversample: clamp(Math.round(finite(merged.oversample, 3)), 1, 4),
        targetColumns: clamp(Math.round(finite(merged.targetColumns, 256)), 64, 512),
        normalize: merged.normalize !== false,
    };
}

/**
 * Choose the analysis window length.
 *
 * Time-frequency resolution is a hard trade and a zoomed 10 ms view genuinely
 * cannot resolve 20 Hz features, so the rule and its consequences are surfaced
 * in `warnings` rather than hidden.
 */
export function chooseWindowSamples(
    params: SpectrogramParams,
    decimatedDt: number,
    viewDurationSec: number,
    warnings: string[],
): number {
    // An explicit override is honoured as given. The FFT only needs its
    // zero-padded length to be a power of two, and rounding the *window* would
    // silently change the analysis duration a caller asked for exactly.
    if (params.windowSamples > 0) return clamp(params.windowSamples, MIN_WINDOW_SAMPLES, 4096);

    const dfTarget = Math.max(20, (params.fMaxHz - params.fMinHz) / 64);
    let nwin = clamp(nextPowerOfTwo(Math.round(1 / (dfTarget * decimatedDt))), MIN_WINDOW_SAMPLES, 4096);

    if (nwin * decimatedDt > viewDurationSec / 3) {
        // Round *down* to a power of two: rounding up would leave the window
        // longer than a third of the view, which is the very thing this branch
        // exists to prevent.
        const shrunk = clamp(previousPowerOfTwo(Math.floor(viewDurationSec / (3 * decimatedDt))), MIN_WINDOW_SAMPLES, 4096);
        if (shrunk < nwin) {
            nwin = shrunk;
            const achievedDf = 1 / (nwin * decimatedDt);
            warnings.push(`Short view: frequency resolution is limited to ${formatHz(achievedDf)}.`);
        }
    }
    return nwin;
}

/**
 * Compute the time-frequency matrix over one view window.
 *
 * Returns an empty-but-valid spectrogram (`nTime === 0`) rather than throwing
 * when the window contains no usable gradient samples, so the panel can render
 * an explanatory message instead of an error state.
 */
export function computeGradientSpectrogram(
    blocks: DecodedBlock[],
    gradientRaster: number,
    options: SpectrogramOptions,
): GradientSpectrogram {
    const params = resolveSpectrogramParams(options);
    const warnings: string[] = [];
    const raster = gradientRaster > 0 ? gradientRaster : 1e-5;
    const startSec = finite(options.startSec, 0);
    const endSec = Math.max(startSec, finite(options.endSec, startSec));
    const viewDuration = endSec - startSec;

    const sampleRate = 1 / raster;
    const nyquist = sampleRate / 2;
    if (params.fMaxHz > nyquist) {
        warnings.push(
            `f max was reduced to the gradient-raster Nyquist frequency (${formatHz(nyquist)}).`,
        );
        params.fMaxHz = nyquist;
        params.fMinHz = Math.min(params.fMinHz, Math.max(0, nyquist - 1));
    }

    const plan = planDecimation(sampleRate, params.fMaxHz);
    const decimatedDt = raster * plan.factor;
    const decimatedRate = 1 / decimatedDt;

    const coreSamples = Math.max(1, Math.floor(viewDuration / raster + 1e-9) + 1);
    const nDecimated = decimatedLength(coreSamples, plan.factor);

    let windowSamples = chooseWindowSamples(params, decimatedDt, viewDuration, warnings);
    // Below the 32-sample floor there is no spectrum to speak of, and clamping
    // the window down to whatever fits would emit a degenerate one-column
    // result that reads as data. Refuse instead, and say why.
    const tooShort = nDecimated < MIN_WINDOW_SAMPLES;
    if (windowSamples > nDecimated) {
        windowSamples = clamp(previousPowerOfTwo(nDecimated), MIN_WINDOW_SAMPLES, 4096);
    }

    let hop = Math.max(1, Math.round(windowSamples * (1 - params.overlap)));
    let columns = nDecimated >= windowSamples
        ? Math.floor((nDecimated - windowSamples) / hop) + 1
        : 0;
    if (columns > params.targetColumns) {
        // Preserve df by widening the hop rather than shrinking the window.
        hop = Math.max(1, Math.ceil((nDecimated - windowSamples) / Math.max(1, params.targetColumns - 1)));
        columns = Math.floor((nDecimated - windowSamples) / hop) + 1;
    }

    const fftPoints = nextPowerOfTwo(windowSamples * params.oversample);
    const dfBin = decimatedRate / fftPoints;

    if (!blocks.length) {
        warnings.push('No sequence is loaded.');
        return emptySpectrogram(params, startSec, endSec, plan.factor, decimatedRate,
            windowSamples, hop, fftPoints, decimatedDt, warnings);
    }
    if (tooShort || columns <= 0) {
        warnings.push('The visible window is shorter than one analysis window. Zoom out to see a spectrogram.');
        return emptySpectrogram(params, startSec, endSec, plan.factor, decimatedRate,
            windowSamples, hop, fftPoints, decimatedDt, warnings);
    }

    // ── Resample the physical gradients, padded with real waveform ──────────
    const padSamples = plan.padSamples;
    const totalSamples = coreSamples + 2 * padSamples;
    const window = resamplePhysicalGradients(blocks, {
        startSec: startSec - padSamples * raster,
        endSec: startSec + (coreSamples + padSamples - 1) * raster,
        dt: raster,
        sampleCount: totalSamples,
    });

    let sx = window.gx, sy = window.gy, sz = window.gz;
    if (params.source === 'dGdt') {
        sx = differentiateUniform(sx, raster);
        sy = differentiateUniform(sy, raster);
        sz = differentiateUniform(sz, raster);
    }

    const dx = decimatePadded(sx, plan, padSamples, nDecimated);
    const dy = decimatePadded(sy, plan, padSamples, nDecimated);
    const dz = decimatePadded(sz, plan, padSamples, nDecimated);

    // ── Frequency crop ──────────────────────────────────────────────────────
    const binLow = Math.max(0, Math.floor(params.fMinHz / dfBin));
    const binHigh = Math.min(fftPoints / 2, Math.ceil(params.fMaxHz / dfBin));
    const nFreq = Math.max(1, binHigh - binLow + 1);

    const cells = columns * nFreq;
    const gxOut = new Float32Array(cells);
    const gyOut = new Float32Array(cells);
    const gzOut = new Float32Array(cells);
    const rssOut = new Float32Array(cells);

    // ── Framing + FFT ───────────────────────────────────────────────────────
    const w = hannWindow(windowSamples);
    const gain = params.normalize ? windowCoherentGain(w) : 1;
    const invGain = gain > 0 ? 1 / gain : 1;
    const unitScale = params.source === 'dGdt'
        ? 1 / GAMMA_HZ_PER_M_PER_T_PER_M
        : 1 / GAMMA_HZ_PER_M_PER_MT_PER_M;

    const frameA = new Float64Array(fftPoints);
    const frameB = new Float64Array(fftPoints);
    const frameC = new Float64Array(fftPoints);
    const scratchRe = new Float64Array(fftPoints);
    const scratchIm = new Float64Array(fftPoints);
    const magA = new Float64Array(fftPoints / 2 + 1);
    const magB = new Float64Array(fftPoints / 2 + 1);
    const magC = new Float64Array(fftPoints / 2 + 1);

    let minValue = Number.POSITIVE_INFINITY;
    let maxValue = 0;

    for (let col = 0; col < columns; col++) {
        const offset = col * hop;
        prepareFrame(frameA, dx, offset, windowSamples, w, fftPoints);
        prepareFrame(frameB, dy, offset, windowSamples, w, fftPoints);
        prepareFrame(frameC, dz, offset, windowSamples, w, fftPoints);

        realFFTPairMagnitude(frameA, frameB, fftPoints, scratchRe, scratchIm, magA, magB);
        realFFTMagnitude(frameC, fftPoints, scratchRe, scratchIm, magC);

        for (let bin = binLow; bin <= binHigh; bin++) {
            const row = bin - binLow;
            const index = row * columns + col;
            const vx = magA[bin] * invGain * unitScale;
            const vy = magB[bin] * invGain * unitScale;
            const vz = magC[bin] * invGain * unitScale;
            const vr = Math.sqrt(vx * vx + vy * vy + vz * vz);
            gxOut[index] = vx;
            gyOut[index] = vy;
            gzOut[index] = vz;
            rssOut[index] = vr;
            if (vr > maxValue) maxValue = vr;
            if (vr < minValue) minValue = vr;
        }
    }

    if (!Number.isFinite(minValue)) minValue = 0;
    if (maxValue <= 0) warnings.push('No gradient activity in the visible window.');

    // Column centres, not left edges: the readout and the marker snap to these.
    const tStartSec = startSec + (windowSamples / 2) * decimatedDt;
    const tStepSec = hop * decimatedDt;

    return {
        nTime: columns,
        nFreq,
        tStartSec,
        tStepSec,
        fStartHz: binLow * dfBin,
        fStepHz: dfBin,
        dtResolutionSec: windowSamples * decimatedDt,
        dfResolutionHz: decimatedRate / windowSamples,
        unit: params.source === 'dGdt' ? 'T/m/s' : 'mT/m',
        source: params.source,
        data: { gx: gxOut, gy: gyOut, gz: gzOut, rss: rssOut },
        minValue,
        maxValue,
        decimationFactor: plan.factor,
        decimatedRateHz: decimatedRate,
        windowSamples,
        hopSamples: hop,
        fftPoints,
        requestedStartSec: startSec,
        requestedEndSec: endSec,
        warnings,
    };
}

function prepareFrame(
    frame: Float64Array,
    source: Float32Array,
    offset: number,
    windowSamples: number,
    w: Float64Array,
    fftPoints: number,
): void {
    // Per-segment DC removal, exactly as upstream's `xseg - mean(xseg,2)`:
    // without it every column carries the block's mean gradient at bin 0 and
    // the low-frequency rows are unreadable.
    let mean = 0;
    for (let i = 0; i < windowSamples; i++) mean += source[offset + i];
    mean /= windowSamples;
    for (let i = 0; i < windowSamples; i++) frame[i] = (source[offset + i] - mean) * w[i];
    for (let i = windowSamples; i < fftPoints; i++) frame[i] = 0;
}

function emptySpectrogram(
    params: SpectrogramParams,
    startSec: number,
    endSec: number,
    decimationFactor: number,
    decimatedRate: number,
    windowSamples: number,
    hop: number,
    fftPoints: number,
    decimatedDt: number,
    warnings: string[],
): GradientSpectrogram {
    return {
        nTime: 0,
        nFreq: 0,
        tStartSec: startSec,
        tStepSec: hop * decimatedDt,
        fStartHz: params.fMinHz,
        fStepHz: decimatedRate / fftPoints,
        dtResolutionSec: windowSamples * decimatedDt,
        dfResolutionHz: decimatedRate / windowSamples,
        unit: params.source === 'dGdt' ? 'T/m/s' : 'mT/m',
        source: params.source,
        data: {
            gx: new Float32Array(0),
            gy: new Float32Array(0),
            gz: new Float32Array(0),
            rss: new Float32Array(0),
        },
        minValue: 0,
        maxValue: 0,
        decimationFactor,
        decimatedRateHz: decimatedRate,
        windowSamples,
        hopSamples: hop,
        fftPoints,
        requestedStartSec: startSec,
        requestedEndSec: endSec,
        warnings,
    };
}

export interface SpectrumSlice {
    columnIndex: number;
    timeSec: number;
    gx: Float32Array;
    gy: Float32Array;
    gz: Float32Array;
    rss: Float32Array;
}

/** Nearest column index for a time, or -1 when the spectrogram is empty. */
export function spectrogramColumnAt(spec: GradientSpectrogram, timeSec: number): number {
    if (spec.nTime <= 0) return -1;
    if (!(spec.tStepSec > 0)) return 0;
    const raw = Math.round((timeSec - spec.tStartSec) / spec.tStepSec);
    return clamp(raw, 0, spec.nTime - 1);
}

/** One time column of the matrix — a pure row lookup, no arithmetic. */
export function computeGradientSpectrumSlice(
    spec: GradientSpectrogram,
    timeSec: number,
): SpectrumSlice | null {
    const col = spectrogramColumnAt(spec, timeSec);
    if (col < 0) return null;
    const gx = new Float32Array(spec.nFreq);
    const gy = new Float32Array(spec.nFreq);
    const gz = new Float32Array(spec.nFreq);
    const rss = new Float32Array(spec.nFreq);
    for (let row = 0; row < spec.nFreq; row++) {
        const index = row * spec.nTime + col;
        gx[row] = spec.data.gx[index];
        gy[row] = spec.data.gy[index];
        gz[row] = spec.data.gz[index];
        rss[row] = spec.data.rss[index];
    }
    return { columnIndex: col, timeSec: spec.tStartSec + col * spec.tStepSec, gx, gy, gz, rss };
}

/**
 * Time-averaged spectrum over the whole visible window.
 *
 * Shown when no marker is set, so the second sub-pane is never empty. This is
 * the RMS-over-columns that upstream reports for the entire sequence — here it
 * is scoped to the view, and it is a fallback rather than the primary reading.
 */
export function computeGradientSpectrumAverage(spec: GradientSpectrogram): SpectrumSlice | null {
    if (spec.nTime <= 0 || spec.nFreq <= 0) return null;
    const gx = new Float32Array(spec.nFreq);
    const gy = new Float32Array(spec.nFreq);
    const gz = new Float32Array(spec.nFreq);
    const rss = new Float32Array(spec.nFreq);
    for (let row = 0; row < spec.nFreq; row++) {
        let ax = 0, ay = 0, az = 0;
        const base = row * spec.nTime;
        for (let col = 0; col < spec.nTime; col++) {
            const vx = spec.data.gx[base + col];
            const vy = spec.data.gy[base + col];
            const vz = spec.data.gz[base + col];
            ax += vx * vx; ay += vy * vy; az += vz * vz;
        }
        const rx = Math.sqrt(ax / spec.nTime);
        const ry = Math.sqrt(ay / spec.nTime);
        const rz = Math.sqrt(az / spec.nTime);
        gx[row] = rx; gy[row] = ry; gz[row] = rz;
        rss[row] = Math.sqrt(rx * rx + ry * ry + rz * rz);
    }
    return {
        columnIndex: -1,
        timeSec: spec.tStartSec + (spec.nTime - 1) * spec.tStepSec / 2,
        gx, gy, gz, rss,
    };
}

/** Centre frequency of a matrix row [Hz]. */
export function spectrogramRowFrequency(spec: GradientSpectrogram, row: number): number {
    return spec.fStartHz + row * spec.fStepHz;
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstream parity path — test-only
// ─────────────────────────────────────────────────────────────────────────────

export interface GradSpectrumParityOptions {
    fMaxHz?: number;
    oversample?: number;
    windowSamples?: number;
}

export interface GradSpectrumParityResult {
    frequencyHz: Float64Array;
    /** Segment-RMS magnitude per axis, in Hz/m as upstream reports it. */
    gx: Float64Array;
    gy: Float64Array;
    gz: Float64Array;
    /** Root-sum-of-squares across axes — upstream's `R`. */
    rss: Float64Array;
    segments: number;
}

/**
 * Reproduce `gradSpectrum.m` numerically: whole sequence, `nwin = 5000`,
 * 50% stagger, `os = 3`, no decimation, no coherent-gain normalisation, and
 * root-mean-square over all segments.
 *
 * This exists only so `test/gradspectrum_baselines/` can compare against
 * MATLAB output. It is *not* what the panel renders — see the file header.
 */
export function computeGradSpectrumParity(
    blocks: DecodedBlock[],
    gradientRaster: number,
    totalDurationSec: number,
    options: GradSpectrumParityOptions = {},
): GradSpectrumParityResult {
    const raster = gradientRaster > 0 ? gradientRaster : 1e-5;
    const fMax = options.fMaxHz && options.fMaxHz > 0 ? options.fMaxHz : 3000;
    const os = options.oversample && options.oversample > 0 ? options.oversample : 3;
    const nwin = options.windowSamples && options.windowSamples > 0 ? options.windowSamples : 5000;
    const sampleRate = 1 / raster;

    const n = Math.max(1, Math.floor(totalDurationSec / raster + 1e-9) + 1);
    const window = resamplePhysicalGradients(blocks, {
        startSec: 0,
        endSec: totalDurationSec,
        dt: raster,
        sampleCount: n,
    });

    const nfft = nextPowerOfTwo(nwin * os);
    const df = sampleRate / nfft;
    const maxBin = Math.min(nfft / 2, Math.floor(fMax / df));
    const bins = maxBin + 1;

    const stagger = Math.floor(nwin / 2);
    const segments = n >= nwin ? Math.floor((n - nwin) / stagger) + 1 : 0;

    const frequencyHz = new Float64Array(bins);
    for (let k = 0; k < bins; k++) frequencyHz[k] = k * df;

    const accX = new Float64Array(bins);
    const accY = new Float64Array(bins);
    const accZ = new Float64Array(bins);
    const rss = new Float64Array(bins);
    if (segments <= 0) {
        return { frequencyHz, gx: accX, gy: accY, gz: accZ, rss, segments: 0 };
    }

    const w = hannWindow(nwin);
    const frameA = new Float64Array(nfft);
    const frameB = new Float64Array(nfft);
    const frameC = new Float64Array(nfft);
    const scratchRe = new Float64Array(nfft);
    const scratchIm = new Float64Array(nfft);
    const magA = new Float64Array(nfft / 2 + 1);
    const magB = new Float64Array(nfft / 2 + 1);
    const magC = new Float64Array(nfft / 2 + 1);

    for (let seg = 0; seg < segments; seg++) {
        const offset = seg * stagger;
        prepareFrame(frameA, window.gx, offset, nwin, w, nfft);
        prepareFrame(frameB, window.gy, offset, nwin, w, nfft);
        prepareFrame(frameC, window.gz, offset, nwin, w, nfft);
        realFFTPairMagnitude(frameA, frameB, nfft, scratchRe, scratchIm, magA, magB);
        realFFTMagnitude(frameC, nfft, scratchRe, scratchIm, magC);
        for (let k = 0; k < bins; k++) {
            accX[k] += magA[k] * magA[k];
            accY[k] += magB[k] * magB[k];
            accZ[k] += magC[k] * magC[k];
        }
    }

    for (let k = 0; k < bins; k++) {
        accX[k] = Math.sqrt(accX[k] / segments);
        accY[k] = Math.sqrt(accY[k] / segments);
        accZ[k] = Math.sqrt(accZ[k] / segments);
        rss[k] = Math.sqrt(accX[k] * accX[k] + accY[k] * accY[k] + accZ[k] * accZ[k]);
    }

    return { frequencyHz, gx: accX, gy: accY, gz: accZ, rss, segments };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function clamp(value: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, value));
}

function finite(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function formatHz(value: number): string {
    if (!Number.isFinite(value)) return '—';
    if (value >= 1000) return `${(value / 1000).toFixed(2)} kHz`;
    if (value >= 10) return `${value.toFixed(0)} Hz`;
    return `${value.toFixed(1)} Hz`;
}
