import { fftInPlace, nextPowerOfTwo } from './fft';
import type { PulseqSequence, RFEntry, RFResponseAnalysis, RFResponseBand } from './types';

/** Hard ceiling for automatic RF spectral analysis and its scratch buffers. */
export const MAX_RF_RESPONSE_FFT_POINTS = 131_072;
/** RF events above this size retain only streaming carrier-area metadata. */
export const MAX_RF_RESPONSE_SAMPLES = 131_072;
/** Tooltip metadata stays small even for unusual comb-like RF spectra. */
export const MAX_RF_RESPONSE_BANDS = 8;

const MIN_FFT_POINTS = 64;
const ZERO_PAD_FACTOR = 4;
const DOMINANT_BAND_FRACTION = 0.5;
const MIN_DOMINANT_AREA_DEG = 0.01;
const DEG_PER_CYCLE = 360;
const TAU = 2 * Math.PI;

interface ComplexRfSamples {
    real: Float64Array;
    imaginary: Float64Array;
    times: Float64Array;
    widths: Float64Array;
    uniform: boolean;
    dwell: number;
}

interface SpectralCluster {
    frequencySum: number;
    weightSum: number;
    peakAreaDeg: number;
}

/**
 * Analyze one RF library entry versus static frequency offset.
 *
 * A bounded FFT locates dominant bands for uniformly sampled pulses. Exact
 * demodulated integrals and no-relaxation spinors are then evaluated only at
 * those centers, keeping the nonlinear work proportional to the band count.
 */
export function analyzeRfResponse(
    rf: RFEntry,
    seq: PulseqSequence,
    classifiedUse = rf.use,
): RFResponseAnalysis {
    if (rfSampleCount(rf, seq) > MAX_RF_RESPONSE_SAMPLES) {
        return {
            carrierAreaDeg: estimateRfCarrierAreaDeg(rf, seq),
            bands: [],
            spectrumAnalyzed: false,
            limited: true,
        };
    }
    const samples = buildComplexRfSamples(rf, seq);
    const carrierAreaDeg = frequencyResolvedAreaDeg(samples, 0);
    const normalizedUse = classifiedUse.toLowerCase();
    const inversion = normalizedUse === 'i' || normalizedUse === 'inversion';

    let offsets: number[];
    let spectrumAnalyzed = false;
    let limited = false;

    if (inversion) {
        // A swept adiabatic spectrum is not a collection of multiband passbands.
        offsets = [0];
    } else if (samples.uniform && samples.real.length <= MAX_RF_RESPONSE_FFT_POINTS) {
        offsets = dominantBandOffsets(samples);
        spectrumAnalyzed = true;
    } else {
        offsets = [0];
        limited = true;
    }

    const bands = offsets.map((frequencyOffsetHz): RFResponseBand => {
        const spectralAreaDeg = frequencyResolvedAreaDeg(samples, frequencyOffsetHz);
        const spinor = propagateSpinor(samples, frequencyOffsetHz);
        return {
            frequencyOffsetHz,
            spectralAreaDeg,
            polarFlipDeg: spinor.polarFlipDeg,
            mz: spinor.mz,
        };
    });

    return { carrierAreaDeg, bands, spectrumAnalyzed, limited };
}

/** Carrier-frame complex RF-area equivalent, retained as diagnostic metadata. */
export function estimateRfCarrierAreaDeg(rf: RFEntry, seq: PulseqSequence): number {
    const magnitude = seq.shapes.get(rf.magShapeId);
    if (!magnitude || magnitude.numSamples < 1) return 0;
    const phase = seq.shapes.get(rf.phaseShapeId);
    const time = rf.timeShapeId > 0 ? seq.shapes.get(rf.timeShapeId) : undefined;
    const count = rfSampleCount(rf, seq);
    const raster = seq.rasterTimes.rfRaster;
    let realArea = 0;
    let imaginaryArea = 0;
    for (let index = 0; index < count; index++) {
        const sampleTime = time ? time.samples[index] * raster : (index + 0.5) * raster;
        const nextTime = time && index + 1 < count
            ? time.samples[index + 1] * raster
            : sampleTime + raster;
        const width = nextTime - sampleTime;
        const amplitude = rf.amplitude * magnitude.samples[index];
        const phaseRad = TAU * (phase?.samples[index] ?? 0);
        if (!Number.isFinite(width) || width <= 0
            || !Number.isFinite(amplitude) || !Number.isFinite(phaseRad)) continue;
        realArea += amplitude * Math.cos(phaseRad) * width;
        imaginaryArea += amplitude * Math.sin(phaseRad) * width;
    }
    return DEG_PER_CYCLE * Math.hypot(realArea, imaginaryArea);
}

function rfSampleCount(rf: RFEntry, seq: PulseqSequence): number {
    const magnitude = seq.shapes.get(rf.magShapeId);
    if (!magnitude) return 0;
    const phase = seq.shapes.get(rf.phaseShapeId);
    const time = rf.timeShapeId > 0 ? seq.shapes.get(rf.timeShapeId) : undefined;
    return Math.min(
        magnitude.numSamples,
        phase?.numSamples ?? magnitude.numSamples,
        time?.numSamples ?? magnitude.numSamples,
    );
}

function buildComplexRfSamples(rf: RFEntry, seq: PulseqSequence): ComplexRfSamples {
    const magnitude = seq.shapes.get(rf.magShapeId);
    if (!magnitude || magnitude.numSamples < 1) return emptySamples(seq.rasterTimes.rfRaster);

    const phase = seq.shapes.get(rf.phaseShapeId);
    const time = rf.timeShapeId > 0 ? seq.shapes.get(rf.timeShapeId) : undefined;
    const count = Math.min(
        magnitude.numSamples,
        phase?.numSamples ?? magnitude.numSamples,
        time?.numSamples ?? magnitude.numSamples,
    );
    if (count < 1) return emptySamples(seq.rasterTimes.rfRaster);

    const raster = seq.rasterTimes.rfRaster;
    const real = new Float64Array(count);
    const imaginary = new Float64Array(count);
    const times = new Float64Array(count);
    const widths = new Float64Array(count);
    let uniform = !time;

    for (let index = 0; index < count; index++) {
        const sampleTime = time ? time.samples[index] * raster : (index + 0.5) * raster;
        const nextTime = time && index + 1 < count
            ? time.samples[index + 1] * raster
            : sampleTime + raster;
        const width = nextTime - sampleTime;
        const amplitude = rf.amplitude * magnitude.samples[index];
        const phaseRad = TAU * (phase?.samples[index] ?? 0);
        times[index] = Number.isFinite(sampleTime) ? sampleTime : 0;
        widths[index] = Number.isFinite(width) && width > 0 ? width : 0;
        real[index] = Number.isFinite(amplitude) && Number.isFinite(phaseRad)
            ? amplitude * Math.cos(phaseRad)
            : 0;
        imaginary[index] = Number.isFinite(amplitude) && Number.isFinite(phaseRad)
            ? amplitude * Math.sin(phaseRad)
            : 0;
        if (Math.abs(widths[index] - raster) > Math.max(1e-12, raster * 1e-6)) uniform = false;
    }
    return { real, imaginary, times, widths, uniform, dwell: raster };
}

function emptySamples(raster: number): ComplexRfSamples {
    return {
        real: new Float64Array(0),
        imaginary: new Float64Array(0),
        times: new Float64Array(0),
        widths: new Float64Array(0),
        uniform: true,
        dwell: raster,
    };
}

function frequencyResolvedAreaDeg(samples: ComplexRfSamples, frequencyOffsetHz: number): number {
    let realArea = 0;
    let imaginaryArea = 0;
    for (let index = 0; index < samples.real.length; index++) {
        const angle = -TAU * frequencyOffsetHz * samples.times[index];
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        const width = samples.widths[index];
        realArea += (samples.real[index] * cosine - samples.imaginary[index] * sine) * width;
        imaginaryArea += (samples.real[index] * sine + samples.imaginary[index] * cosine) * width;
    }
    return DEG_PER_CYCLE * Math.hypot(realArea, imaginaryArea);
}

function dominantBandOffsets(samples: ComplexRfSamples): number[] {
    const sampleCount = samples.real.length;
    if (sampleCount === 0 || !Number.isFinite(samples.dwell) || samples.dwell <= 0) return [0];

    const paddedTarget = sampleCount <= Math.floor(MAX_RF_RESPONSE_FFT_POINTS / ZERO_PAD_FACTOR)
        ? sampleCount * ZERO_PAD_FACTOR
        : sampleCount;
    const fftPoints = nextPowerOfTwo(Math.max(MIN_FFT_POINTS, paddedTarget));
    if (fftPoints > MAX_RF_RESPONSE_FFT_POINTS) return [0];

    const real = new Float64Array(fftPoints);
    const imaginary = new Float64Array(fftPoints);
    real.set(samples.real);
    imaginary.set(samples.imaginary);
    fftInPlace(real, imaginary, fftPoints);

    let peakAreaDeg = 0;
    for (let bin = 0; bin < fftPoints; bin++) {
        peakAreaDeg = Math.max(
            peakAreaDeg,
            DEG_PER_CYCLE * samples.dwell * Math.hypot(real[bin], imaginary[bin]),
        );
    }
    if (!Number.isFinite(peakAreaDeg) || peakAreaDeg < MIN_DOMINANT_AREA_DEG) return [0];

    const threshold = Math.max(MIN_DOMINANT_AREA_DEG, peakAreaDeg * DOMINANT_BAND_FRACTION);
    const clusters: SpectralCluster[] = [];
    let active: SpectralCluster | null = null;
    const half = fftPoints / 2;
    const frequencyStep = 1 / (fftPoints * samples.dwell);

    // Signed-frequency order keeps a passband spanning DC in one cluster.
    for (let signedBin = -half; signedBin < half; signedBin++) {
        const bin = signedBin < 0 ? signedBin + fftPoints : signedBin;
        const areaDeg = DEG_PER_CYCLE * samples.dwell * Math.hypot(real[bin], imaginary[bin]);
        if (areaDeg >= threshold) {
            const weight = areaDeg * areaDeg;
            if (!active) active = { frequencySum: 0, weightSum: 0, peakAreaDeg: 0 };
            active.frequencySum += signedBin * frequencyStep * weight;
            active.weightSum += weight;
            active.peakAreaDeg = Math.max(active.peakAreaDeg, areaDeg);
        } else if (active) {
            clusters.push(active);
            active = null;
        }
    }
    if (active) clusters.push(active);

    const offsets = clusters
        .filter(cluster => cluster.weightSum > 0)
        .sort((left, right) => right.peakAreaDeg - left.peakAreaDeg)
        .slice(0, MAX_RF_RESPONSE_BANDS)
        .map(cluster => cluster.frequencySum / cluster.weightSum)
        .sort((left, right) => left - right);
    return offsets.length > 0 ? offsets : [0];
}

function propagateSpinor(
    samples: ComplexRfSamples,
    frequencyOffsetHz: number,
): { polarFlipDeg: number; mz: number } {
    let stateAReal = 1;
    let stateAImaginary = 0;
    let stateBReal = 0;
    let stateBImaginary = 0;

    for (let index = 0; index < samples.real.length; index++) {
        const bx = samples.real[index];
        const by = samples.imaginary[index];
        const norm = Math.hypot(bx, by, frequencyOffsetHz);
        const width = samples.widths[index];
        if (!(norm > 0) || !(width > 0)) continue;

        const sine = Math.sin(Math.PI * norm * width);
        const localAReal = Math.cos(Math.PI * norm * width);
        const localAImaginary = -frequencyOffsetHz / norm * sine;
        const localBReal = by / norm * sine;
        const localBImaginary = -bx / norm * sine;

        const nextAReal = localAReal * stateAReal - localAImaginary * stateAImaginary
            - localBReal * stateBReal - localBImaginary * stateBImaginary;
        const nextAImaginary = localAReal * stateAImaginary + localAImaginary * stateAReal
            - localBReal * stateBImaginary + localBImaginary * stateBReal;
        const nextBReal = localBReal * stateAReal - localBImaginary * stateAImaginary
            + localAReal * stateBReal + localAImaginary * stateBImaginary;
        const nextBImaginary = localBReal * stateAImaginary + localBImaginary * stateAReal
            + localAReal * stateBImaginary - localAImaginary * stateBReal;

        stateAReal = nextAReal;
        stateAImaginary = nextAImaginary;
        stateBReal = nextBReal;
        stateBImaginary = nextBImaginary;
    }

    const aMagnitudeSquared = stateAReal * stateAReal + stateAImaginary * stateAImaginary;
    const bMagnitudeSquared = stateBReal * stateBReal + stateBImaginary * stateBImaginary;
    const normalization = aMagnitudeSquared + bMagnitudeSquared;
    const mz = normalization > 0
        ? clamp((aMagnitudeSquared - bMagnitudeSquared) / normalization, -1, 1)
        : 1;
    return { mz, polarFlipDeg: Math.acos(mz) * 180 / Math.PI };
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(maximum, value));
}
