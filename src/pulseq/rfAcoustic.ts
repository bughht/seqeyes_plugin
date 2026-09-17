/**
 * rfAcoustic.ts — reduced-order acoustic source proxies for RF events.
 *
 * Port of the `rf_acoustic_model` v2 research package (`python/rf_sound.py`),
 * restricted to the parts a `.seq` file can actually justify. Two mechanisms
 * survive the port:
 *
 *   thermo   ~ d|B1|^2/dt      RF thermoacoustic temporal proxy. The source
 *                              structure follows the thermoacoustic wave
 *                              equation's `-(beta/Cp) dH/dt` term with the
 *                              spatial SAR field factored out. It is a
 *                              *temporal* proxy only: no absorbed-power field
 *                              and no acoustic propagation are modelled, so it
 *                              predicts where energy sits in frequency, never
 *                              a pressure.
 *
 *   control  ~ d(TX_gate)/dt   TX/RX control switching. An RF event keeps its
 *                              timing when the protocol scales flip angle to
 *                              zero, so this term deliberately survives
 *                              `rfScale = 0`. The upstream package labels this
 *                              an empirical hypothesis with no published MRI
 *                              acoustic law behind it; nothing here upgrades
 *                              that status.
 *
 * Three parts of the upstream model are deliberately not ported:
 *
 *   - Mechanical relay clicks exist upstream only at caller-supplied
 *     `relay_times`. A `.seq` file records no relay actuation, and the package
 *     is explicit that RF events must not be assumed to actuate one, so there
 *     is nothing to derive.
 *   - The damped-resonance impulse responses default to a unit delta upstream
 *     (v2 removed the v1 placeholder 800/1600 Hz resonances as unsupported).
 *     With no measured scanner resonance the response equals the source, so
 *     shipping the convolution would only offer a way to invent peaks.
 *   - The external gradient proxy is already the panel's gradient channels.
 *
 * Levels are **relative**. `thermo` is peak-normalised over the resampled
 * window and `control` is +/-1 per gate transition, which is what makes the
 * upstream 1:1 default weighting meaningful — but that ratio is a placeholder
 * until it is fitted to scanner measurements, and neither channel is
 * commensurable with the gradient channels' mT/m or T/m/s.
 */

import type { DecodedBlock, DecodedRFWaveform } from './types';

/** Shared with the gradient resampler, so both agree on event endpoints. */
import { GRADIENT_ENDPOINT_TOLERANCE_SEC } from './physicalGradients';

/**
 * Sign convention for the control-switching source.
 *
 * `signed` keeps the rising edge positive and the falling edge negative, which
 * is upstream's default and cancels to zero mean over a complete pulse.
 * `absolute` treats both edges as the same event, which is the right choice if
 * the hardware click is polarity-independent — untested either way.
 */
export type RfControlEdgeMode = 'signed' | 'absolute';

export interface RfAcousticOptions {
    /** Time of sample 0 [s]. */
    startSec: number;
    /** Sample spacing [s]. */
    dt: number;
    /** Sample count. */
    sampleCount: number;
    /** RF amplitude scale, as a protocol flip-angle scale would apply it. */
    rfScale?: number;
    edgeMode?: RfControlEdgeMode;
}

export interface RfAcousticSources {
    t0: number;
    dt: number;
    n: number;
    /** |B1|^2 on the uniform raster, peak-normalised. Relative. */
    power: Float32Array;
    /** TX event-presence gate: 1 while an RF event is scheduled, else 0. */
    gate: Float32Array;
    /** `rfScale^2 * normalise(d|B1|^2/dt)`. Relative. */
    thermo: Float32Array;
    /** Gate difference per sample: +/-1 at each transition. Relative. */
    control: Float32Array;
    /** True when no RF event overlapped the window. */
    silent: boolean;
    /** RF events that contributed at least one sample or one gate edge. */
    eventCount: number;
    /** Events shorter than `dt`, deposited as an area-preserving impulse. */
    subSampleEventCount: number;
}

/** Peak-normalise in place; an all-zero signal is left alone. */
function normalizePeak(values: Float32Array): void {
    let peak = 0;
    for (let i = 0; i < values.length; i++) {
        const v = values[i] < 0 ? -values[i] : values[i];
        if (v > peak) peak = v;
    }
    if (peak > 0) for (let i = 0; i < values.length; i++) values[i] /= peak;
}

/**
 * Linear interpolation of |B1|^2 between RF sample points.
 *
 * Upstream squares first and interpolates the squared values (`np.interp` over
 * `abs(signal)**2`), so this does the same rather than interpolating magnitude
 * and squaring after — the two differ wherever the raster is coarser than the
 * RF shape.
 */
function rfPowerAt(rf: DecodedRFWaveform, t: number): number {
    const tp = rf.timePoints, mag = rf.magnitude;
    const last = tp.length - 1;
    if (last < 0) return 0;
    if (last === 0) return mag[0] * mag[0];
    if (t < tp[0] - GRADIENT_ENDPOINT_TOLERANCE_SEC
        || t > tp[last] + GRADIENT_ENDPOINT_TOLERANCE_SEC) return 0;
    if (t <= tp[0]) return mag[0] * mag[0];
    if (t >= tp[last]) return mag[last] * mag[last];
    let lo = 0, hi = last;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tp[m] <= t) lo = m; else hi = m; }
    const span = tp[hi] - tp[lo];
    const pLo = mag[lo] * mag[lo];
    if (span <= 0) return pLo;
    const pHi = mag[hi] * mag[hi];
    return pLo + (pHi - pLo) * (t - tp[lo]) / span;
}

/** Trapezoidal integral of |B1|^2 over an RF event [Hz^2 s]. */
function rfPowerArea(rf: DecodedRFWaveform): number {
    const tp = rf.timePoints, mag = rf.magnitude;
    let area = 0;
    for (let i = 1; i < tp.length; i++) {
        const pPrev = mag[i - 1] * mag[i - 1];
        const pCurr = mag[i] * mag[i];
        area += 0.5 * (pPrev + pCurr) * (tp[i] - tp[i - 1]);
    }
    return area;
}

/**
 * Build the RF acoustic source terms on a uniform raster.
 *
 * Iterates RF events rather than raster samples: a sequence has far fewer RF
 * events than gradient-raster samples, and the sub-sample branch below is a
 * per-event decision that a per-sample loop cannot express.
 *
 * **Edge-timing quantisation.** Gate transitions land on the supplied raster,
 * normally the 10 us gradient raster, while RF is defined on a 1 us raster. A
 * gate edge therefore carries up to +/-dt/2 of timing jitter. The spectrogram
 * low-passes well below the raster Nyquist before its FFT, so this is harmless
 * for the displayed band; it would matter if this proxy were ever used to
 * synthesise audio at the raster rate.
 */
export function resampleRfAcousticSources(
    blocks: DecodedBlock[],
    options: RfAcousticOptions,
): RfAcousticSources {
    const dt = options.dt;
    if (!(dt > 0)) throw new Error('resampleRfAcousticSources requires a positive dt.');
    const t0 = Number.isFinite(options.startSec) ? options.startSec : 0;
    const n = Math.max(0, Math.floor(options.sampleCount));
    const rfScale = Math.max(0, Number.isFinite(options.rfScale as number) ? options.rfScale as number : 1);
    const edgeMode: RfControlEdgeMode = options.edgeMode === 'absolute' ? 'absolute' : 'signed';

    const power = new Float32Array(n);
    const gate = new Float32Array(n);
    const thermo = new Float32Array(n);
    const control = new Float32Array(n);
    const empty: RfAcousticSources = {
        t0, dt, n, power, gate, thermo, control,
        silent: true, eventCount: 0, subSampleEventCount: 0,
    };
    if (!n) return empty;

    const tEnd = t0 + (n - 1) * dt;
    let eventCount = 0;
    let subSampleEventCount = 0;

    for (const block of blocks) {
        const rf = block.rf;
        if (!rf || !rf.timePoints || !rf.timePoints.length || !rf.magnitude.length) continue;
        const last = rf.timePoints.length - 1;
        const rfStart = rf.timePoints[0];
        const rfEnd = rf.timePoints[last];
        if (rfEnd < t0 - GRADIENT_ENDPOINT_TOLERANCE_SEC
            || rfStart > tEnd + GRADIENT_ENDPOINT_TOLERANCE_SEC) continue;
        eventCount++;

        // Gate bounds round outward, matching upstream's floor/ceil pair, so an
        // event shorter than one sample still produces a rise and a fall rather
        // than vanishing.
        const gateLo = clampIndex(Math.floor((rfStart - t0) / dt), n);
        const gateHi = clampIndex(Math.ceil((rfEnd - t0) / dt), n);
        for (let i = gateLo; i <= gateHi; i++) gate[i] = 1;

        // Raster samples strictly inside the event.
        const coverLo = clampIndex(Math.ceil((rfStart - t0) / dt), n);
        const coverHi = clampIndex(Math.floor((rfEnd - t0) / dt), n);
        const spansASample = (rfEnd - rfStart) >= dt && coverHi >= coverLo;

        if (spansASample) {
            for (let i = coverLo; i <= coverHi; i++) power[i] += rfPowerAt(rf, t0 + i * dt);
        } else {
            // Preserve the integral of |B1|^2 instead of point-sampling a pulse
            // the raster cannot see: a 100 us hard pulse on a 10 us raster is
            // fine, a 4 us one would otherwise land between samples and read as
            // silence.
            subSampleEventCount++;
            const area = last === 0
                ? rf.magnitude[0] * rf.magnitude[0] * dt
                : rfPowerArea(rf);
            const mid = clampIndex(Math.round((0.5 * (rfStart + rfEnd) - t0) / dt), n);
            power[mid] += area / dt;
        }
    }

    const silent = eventCount === 0;
    if (silent) return { ...empty, silent: true };

    normalizePeak(power);

    // d|B1|^2/dt, normalised at unit scale *before* rfScale^2 is applied, so
    // rfScale = 0 genuinely empties this channel instead of renormalising a
    // vanishing signal back up to peak 1.
    const invDt = 1 / dt;
    for (let i = 1; i < n; i++) thermo[i] = (power[i] - power[i - 1]) * invDt;
    normalizePeak(thermo);
    const amplitudeGain = rfScale * rfScale;
    if (amplitudeGain !== 1) for (let i = 0; i < n; i++) thermo[i] *= amplitudeGain;

    // Gate difference, left as +/-1 per transition: upstream does not scale this
    // by the sample rate, and that is what puts the two mechanisms on a
    // comparable peak footing at rfScale = 1.
    //
    // The difference starts at i = 1, so an RF event already in progress at
    // sample 0 contributes no rising edge — a finite window cannot show a
    // transition that happened before it began. Upstream avoids this by padding
    // the whole sequence with a second of silence; here the window is the user's
    // view, and the spectrogram's own decimation padding covers the common case.
    for (let i = 1; i < n; i++) {
        const d = gate[i] - gate[i - 1];
        control[i] = edgeMode === 'absolute' ? Math.abs(d) : d;
    }

    return { t0, dt, n, power, gate, thermo, control, silent: false, eventCount, subSampleEventCount };
}

function clampIndex(index: number, n: number): number {
    if (!Number.isFinite(index)) return 0;
    if (index < 0) return 0;
    if (index > n - 1) return n - 1;
    return index;
}

/**
 * Weighted sum of the two mechanisms, formed in the time domain.
 *
 * The combination has to happen before the transform: the FFT is linear but its
 * magnitude is not, so summing two magnitude spectra would discard the phase
 * relationship between a thermoacoustic pulse and the gate edges that bracket
 * it — exactly the interference the model exists to examine.
 */
export function combineRfSources(
    sources: RfAcousticSources,
    thermoWeight: number,
    controlWeight: number,
): Float32Array {
    const wThermo = Number.isFinite(thermoWeight) ? thermoWeight : 1;
    const wControl = Number.isFinite(controlWeight) ? controlWeight : 1;
    const out = new Float32Array(sources.n);
    for (let i = 0; i < sources.n; i++) {
        out[i] = wThermo * sources.thermo[i] + wControl * sources.control[i];
    }
    return out;
}
