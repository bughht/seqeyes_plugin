/**
 * gradientSound.ts — simulated gradient sound.
 *
 * Follows pulseq `Sequence.m::sound()` (revision 2fd6ab6a, line 2653) and the
 * pypulseq port in PR #348 (`seq_sound.py`): resample the physical gradients
 * onto the audio raster, map x/y to left/right with z split between them,
 * smooth with a short Gaussian to suppress ringing, and normalise the peak.
 *
 * This is *simulated*, not calibrated. It reproduces the spectral character of
 * the gradient waveform; it is not sound pressure level, because the coil
 * transfer function that would be needed is not in the ASC. Every UI surface
 * that plays it says so.
 *
 * Two documented deviations from upstream:
 *   - MATLAB sizes the buffer from `sum(obj.blockDurations)` — the *whole*
 *     sequence — even when `blockRange` restricts the calculation, so a
 *     restricted range yields a mostly silent buffer. pypulseq inherited that.
 *     SeqEyes sizes the buffer from the requested window.
 *   - `source: 'dGdt'` runs the same path on the differentiated waveform,
 *     matching the physical argument in the upstream `gradSpectrum.m` comment.
 */

import type { DecodedBlock } from './types';
import { differentiateUniform, resamplePhysicalGradients } from './physicalGradients';
import {
    combineRfSources,
    resampleRfAcousticSources,
    type RfControlEdgeMode,
} from './rfAcoustic';

export const DEFAULT_AUDIO_SAMPLE_RATE = 44100;
export const AUDIO_PEAK = 0.95;

export type GradientSoundSource = 'G' | 'dGdt';

export interface GradientSoundOptions {
    startSec: number;
    endSec: number;
    sampleRate?: number;
    /** Per-axis weights `[wx, wy, wz]`, default `[1, 1, 1]`. */
    channelWeights?: [number, number, number];
    source?: GradientSoundSource;
    /** Mix the RF acoustic proxy into the buffer (see `rfMix`). */
    includeRf?: boolean;
    rfScale?: number;
    rfThermoWeight?: number;
    rfControlWeight?: number;
    rfEdgeMode?: RfControlEdgeMode;
    /**
     * Crossfade between the two sources: 0 is gradient only, 1 is RF only.
     *
     * This is a **listening control, not a prediction**. The two signals have no
     * common unit, so there is no correct ratio to default to; each side is
     * normalised to its own peak and blended by this number. Anything else would
     * either bury the proxy under the gradients or claim a loudness relationship
     * that has not been measured.
     */
    rfMix?: number;
}

export interface GradientSound {
    sampleRate: number;
    /** Frames per channel. */
    n: number;
    left: Float32Array;
    right: Float32Array;
    startSec: number;
    endSec: number;
    /** Peak of the un-normalised *gradient* signal, for the readout. */
    rawPeak: number;
    /** Peak of the un-normalised RF proxy contribution, or 0 when unused. */
    rfRawPeak: number;
    /** True when the RF proxy contributed to the buffer. */
    rfIncluded: boolean;
    /** True when the window held nothing to play from any enabled source. */
    silent: boolean;
    warnings: string[];
}

/**
 * Gaussian smoothing kernel, `len = round(fs/6000)*2 + 1` taps.
 *
 * MATLAB's `gausswin(N)` uses `alpha = 2.5`, so `std = (N-1)/(2*alpha) = (N-1)/5`.
 * pypulseq PR #348 uses `std = len/6` instead. The audible difference is nil,
 * but the choice should not be accidental: SeqEyes follows MATLAB.
 */
export function gaussianSmoothingKernel(sampleRate: number): Float64Array {
    const half = Math.max(1, Math.round(sampleRate / 6000));
    const len = half * 2 + 1;
    const std = (len - 1) / 5;
    const mid = (len - 1) / 2;
    const kernel = new Float64Array(len);
    let sum = 0;
    for (let i = 0; i < len; i++) {
        const z = (i - mid) / std;
        kernel[i] = Math.exp(-0.5 * z * z);
        sum += kernel[i];
    }
    if (sum > 0) for (let i = 0; i < len; i++) kernel[i] /= sum;
    return kernel;
}

/** `mode = 'same'` convolution: output length equals input length. */
function convolveSame(signal: Float32Array, kernel: Float64Array): Float32Array<ArrayBuffer> {
    const n = signal.length;
    const k = kernel.length;
    const half = (k - 1) / 2;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let j = 0; j < k; j++) {
            const idx = i + half - j;
            if (idx < 0 || idx >= n) continue;
            acc += kernel[j] * signal[idx];
        }
        out[i] = acc;
    }
    return out;
}

export function synthesizeGradientSound(
    blocks: DecodedBlock[],
    options: GradientSoundOptions,
): GradientSound {
    const warnings: string[] = [];
    const sampleRate = options.sampleRate && options.sampleRate > 0
        ? options.sampleRate
        : DEFAULT_AUDIO_SAMPLE_RATE;
    const startSec = Number.isFinite(options.startSec) ? options.startSec : 0;
    const endSec = Math.max(startSec, Number.isFinite(options.endSec) ? options.endSec : startSec);
    const dt = 1 / sampleRate;
    // The epsilon keeps a nominally exact window honest: 0.6 - 0.5 is
    // 0.09999999999999998, which would otherwise drop a whole frame.
    const n = Math.floor((endSec - startSec) * sampleRate + 1e-9) + 1;

    const weights = options.channelWeights ?? [1, 1, 1];
    const wx = Number.isFinite(weights[0]) ? weights[0] : 1;
    const wy = Number.isFinite(weights[1]) ? weights[1] : 1;
    const wz = Number.isFinite(weights[2]) ? weights[2] : 1;

    const window = resamplePhysicalGradients(blocks, {
        startSec,
        endSec,
        dt,
        sampleCount: n,
    });

    let gx = window.gx, gy = window.gy, gz = window.gz;
    if (options.source === 'dGdt') {
        gx = differentiateUniform(gx, dt);
        gy = differentiateUniform(gy, dt);
        gz = differentiateUniform(gz, dt);
    }

    // Channel map: z is split equally into both ears, as upstream does.
    let left = new Float32Array(n);
    let right = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        left[i] = wx * gx[i] + 0.5 * wz * gz[i];
        right[i] = wy * gy[i] + 0.5 * wz * gz[i];
    }

    const kernel = gaussianSmoothingKernel(sampleRate);
    left = convolveSame(left, kernel);
    right = convolveSame(right, kernel);

    let rawPeak = 0;
    for (let i = 0; i < n; i++) {
        const l = Math.abs(left[i]);
        const r = Math.abs(right[i]);
        if (l > rawPeak) rawPeak = l;
        if (r > rawPeak) rawPeak = r;
    }

    // ── RF acoustic proxy ───────────────────────────────────────────────────
    // Built directly on the audio raster rather than at the gradient raster and
    // resampled, matching what the gradient path above already does. Gate edges
    // therefore carry up to +/-dt/2 (about 11 us at 44.1 kHz) of timing jitter,
    // which adds a low noise floor rather than shifting any spectral line.
    const rfMix = clamp01(Number.isFinite(options.rfMix as number) ? options.rfMix as number : 0.5);
    let rfRawPeak = 0;
    let rfMono: Float32Array | null = null;
    if (options.includeRf && rfMix > 0) {
        const sources = resampleRfAcousticSources(blocks, {
            startSec,
            dt,
            sampleCount: n,
            rfScale: options.rfScale,
            edgeMode: options.rfEdgeMode,
        });
        if (!sources.silent) {
            const combined = combineRfSources(
                sources,
                Number.isFinite(options.rfThermoWeight as number) ? options.rfThermoWeight as number : 1,
                Number.isFinite(options.rfControlWeight as number) ? options.rfControlWeight as number : 1,
            );
            rfMono = convolveSame(combined, kernel);
            for (let i = 0; i < n; i++) {
                const v = Math.abs(rfMono[i]);
                if (v > rfRawPeak) rfRawPeak = v;
            }
        }
    }

    const rfIncluded = !!(rfMono && rfRawPeak > 0);
    if (rfIncluded) {
        // Each side is normalised to its own peak before blending: a raw sum
        // would compare Hz/m against a dimensionless proxy and the proxy would
        // be inaudible at any sequence with real gradients — which is exactly
        // the failure this mix exists to avoid. The RF term is centred in both
        // ears; it has no axis to pan by.
        const gradGain = rawPeak > 0 ? (1 - rfMix) / rawPeak : 0;
        const rfGain = rfMix / rfRawPeak;
        for (let i = 0; i < n; i++) {
            const rfSample = rfMono![i] * rfGain;
            left[i] = left[i] * gradGain + rfSample;
            right[i] = right[i] * gradGain + rfSample;
        }
    }

    let mixedPeak = 0;
    for (let i = 0; i < n; i++) {
        const l = Math.abs(left[i]);
        const r = Math.abs(right[i]);
        if (l > mixedPeak) mixedPeak = l;
        if (r > mixedPeak) mixedPeak = r;
    }

    const silent = !(mixedPeak > 0);
    if (silent) {
        warnings.push(options.includeRf
            ? 'Nothing to play in this window — no gradient activity and no RF events.'
            : 'No gradient activity in this window — nothing to play.');
    } else {
        const scale = AUDIO_PEAK / mixedPeak;
        for (let i = 0; i < n; i++) {
            left[i] *= scale;
            right[i] *= scale;
        }
        if (options.includeRf && !rfIncluded && rfMix > 0) {
            warnings.push('No RF events in this window; you are hearing the gradients only.');
        } else if (rfIncluded && rawPeak === 0) {
            warnings.push('No gradient activity in this window; you are hearing the RF proxy only.');
        }
    }

    return {
        sampleRate, n, left, right, startSec, endSec,
        rawPeak, rfRawPeak, rfIncluded, silent, warnings,
    };
}

function clamp01(value: number): number {
    return value < 0 ? 0 : (value > 1 ? 1 : value);
}
