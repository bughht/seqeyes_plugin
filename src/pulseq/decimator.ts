/**
 * decimator.ts — anti-aliased integer decimation.
 *
 * Trapezoids have hard corners, so a gradient waveform carries strong energy
 * far above the 3 kHz band the spectrogram displays. Taking every Dth sample
 * would fold that energy straight into the displayed band and produce a
 * plausible-looking but wrong spectrum, which is the worst failure mode this
 * feature has. Everything here exists to make that impossible:
 *
 *   - a Kaiser-windowed sinc low-pass with >= 80 dB stopband attenuation runs
 *     before the sample drop;
 *   - the exact `(taps-1)/2` group delay is compensated, so decimated column
 *     times still line up with the waveform panel;
 *   - the caller supplies real waveform padding on both sides (never zeros),
 *     so edge columns are not attenuated by the filter ramp.
 *
 * Filter taps are cached per (D, cutoff) because a pan gesture recomputes the
 * spectrogram many times with identical decimation.
 */

/** Stopband attenuation the design targets, in dB. */
export const DECIMATION_STOPBAND_DB = 80;

export interface DecimationPlan {
    /** Integer decimation factor; 1 means "no decimation needed". */
    factor: number;
    /** Symmetric FIR taps (odd length); empty when `factor === 1`. */
    taps: Float64Array;
    /** Group delay in input samples, exactly `(taps.length - 1) / 2`. */
    delaySamples: number;
    /** Input samples of real waveform the caller must supply on each side. */
    padSamples: number;
}

const planCache = new Map<string, DecimationPlan>();

/** Zeroth-order modified Bessel function of the first kind. */
function besselI0(x: number): number {
    let sum = 1;
    let term = 1;
    const halfX = x / 2;
    for (let k = 1; k < 60; k++) {
        term *= (halfX / k) * (halfX / k);
        sum += term;
        if (term < sum * 1e-17) break;
    }
    return sum;
}

/** Kaiser beta for a target stopband attenuation (Kaiser's empirical rule). */
export function kaiserBeta(attenuationDb: number): number {
    if (attenuationDb > 50) return 0.1102 * (attenuationDb - 8.7);
    if (attenuationDb >= 21) {
        return 0.5842 * Math.pow(attenuationDb - 21, 0.4) + 0.07886 * (attenuationDb - 21);
    }
    return 0;
}

/**
 * Design a Kaiser-windowed sinc low-pass.
 *
 * @param cutoffNorm  Cutoff as a fraction of the *input* sample rate (0..0.5).
 * @param numTaps     Tap count; forced odd so the delay is a whole sample.
 */
export function designKaiserLowpass(
    cutoffNorm: number,
    numTaps: number,
    attenuationDb = DECIMATION_STOPBAND_DB,
): Float64Array {
    const n = numTaps % 2 === 0 ? numTaps + 1 : numTaps;
    const beta = kaiserBeta(attenuationDb);
    const denominator = besselI0(beta);
    const mid = (n - 1) / 2;
    const taps = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const k = i - mid;
        const sinc = k === 0 ? 2 * cutoffNorm : Math.sin(2 * Math.PI * cutoffNorm * k) / (Math.PI * k);
        const ratio = mid === 0 ? 0 : k / mid;
        const window = besselI0(beta * Math.sqrt(Math.max(0, 1 - ratio * ratio))) / denominator;
        taps[i] = sinc * window;
        sum += taps[i];
    }
    // Unity DC gain: without this the decimated waveform would be scaled and
    // every displayed amplitude would be quietly wrong.
    if (sum !== 0) for (let i = 0; i < n; i++) taps[i] /= sum;
    return taps;
}

/**
 * Tap count needed for a Kaiser design, from Kaiser's empirical order formula
 * `N ~= (A - 8) / (2.285 * dOmega)`.
 *
 * The plan's rule of thumb was `taps ~= 8*D`, but at a 10 us raster and
 * fMax = 3 kHz the transition band is only 846 Hz wide out of 100 kHz, and
 * 8*D = 104 taps reaches nowhere near 80 dB there — the passband is still
 * rolling off at 2.8 kHz, which showed up as a ~22 dB disagreement in the
 * decimation-fidelity test. The binding requirements are the 80 dB stopband and
 * the 0.5 dB in-band agreement, so the order is derived rather than assumed and
 * `8*D + 1` is kept only as a floor. The count is bounded: the decimation rule
 * guarantees a transition width of at least `0.1 / D`, so this stays under
 * roughly `50 * D` taps, and because only every Dth output is evaluated the
 * cost per *input* sample is constant.
 */
function kaiserTapCount(transitionNorm: number, attenuationDb: number): number {
    const dOmega = 2 * Math.PI * Math.max(1e-6, transitionNorm);
    return Math.ceil((attenuationDb - 8) / (2.285 * dOmega)) + 1;
}

/**
 * Plan the decimation from a source rate to a target usable bandwidth.
 *
 * `D = floor(fs / (2.5 * fMax))` keeps a 25% guard band above the highest
 * displayed frequency, matching the 0.45*fs' filter cutoff below.
 */
export function planDecimation(sampleRateHz: number, fMaxHz: number): DecimationPlan {
    if (!(sampleRateHz > 0) || !(fMaxHz > 0)) return identityPlan();
    // The epsilon is not cosmetic: a 10 us raster gives 1/1e-5 = 99999.99999999999,
    // so an exact ratio of 16 floors to 15 and every derived quantity — decimated
    // rate, column times, bin spacing — shifts with it.
    const factor = Math.max(1, Math.floor(sampleRateHz / (2.5 * fMaxHz) + 1e-9));
    if (factor <= 1) return identityPlan();

    const decimatedRate = sampleRateHz / factor;
    const cutoffNorm = 0.45 * decimatedRate / sampleRateHz;   // == 0.45 / factor
    const key = `${factor}|${cutoffNorm.toFixed(9)}|${fMaxHz.toFixed(3)}`;
    const cached = planCache.get(key);
    if (cached) return cached;

    // Passband must stay flat to fMax; stopband must start by the new Nyquist,
    // otherwise out-of-band energy folds into the displayed range.
    const transitionNorm = Math.max(1e-4, 1 / (2 * factor) - fMaxHz / sampleRateHz);
    const numTaps = Math.max(8 * factor + 1, kaiserTapCount(transitionNorm, DECIMATION_STOPBAND_DB));
    const taps = designKaiserLowpass(cutoffNorm, numTaps);
    const plan: DecimationPlan = {
        factor,
        taps,
        delaySamples: (taps.length - 1) / 2,
        padSamples: taps.length,
    };
    planCache.set(key, plan);
    return plan;
}

function identityPlan(): DecimationPlan {
    return { factor: 1, taps: new Float64Array(0), delaySamples: 0, padSamples: 0 };
}

/**
 * Filter and decimate a padded input buffer.
 *
 * `input` holds `plan.padSamples` real samples of lead-in, then the window of
 * interest, then `plan.padSamples` of lead-out. Output sample `j` corresponds
 * to input sample `padSamples + j * factor` with the filter delay removed, so
 * output time `j` is exactly `windowStart + j * factor * dt`.
 */
export function decimatePadded(
    input: Float32Array,
    plan: DecimationPlan,
    padSamples: number,
    outCount: number,
): Float32Array {
    const out = new Float32Array(Math.max(0, outCount));
    if (!out.length) return out;
    if (plan.factor === 1) {
        for (let j = 0; j < out.length; j++) {
            const idx = padSamples + j;
            out[j] = idx >= 0 && idx < input.length ? input[idx] : 0;
        }
        return out;
    }

    const taps = plan.taps;
    const nTaps = taps.length;
    const delay = plan.delaySamples;
    const n = input.length;
    for (let j = 0; j < out.length; j++) {
        const center = padSamples + j * plan.factor + delay;
        let acc = 0;
        for (let k = 0; k < nTaps; k++) {
            const idx = center - k;
            if (idx < 0 || idx >= n) continue;   // outside the sequence == no gradient
            acc += taps[k] * input[idx];
        }
        out[j] = acc;
    }
    return out;
}

/** Output sample count a decimation produces for a given core-window length. */
export function decimatedLength(coreSamples: number, factor: number): number {
    if (coreSamples <= 0) return 0;
    return Math.floor((coreSamples - 1) / Math.max(1, factor)) + 1;
}
