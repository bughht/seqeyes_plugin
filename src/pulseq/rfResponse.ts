import { fftInPlace, nextPowerOfTwo } from './fft';
import type { PulseqSequence, RFEntry, RFResponseAnalysis, RFResponseAxis, RFResponseBand } from './types';
import { forEachRasterCell, rasterCellCount, rasterCellsFromShapes, rfShapeArrays } from './rfWaveform';
import { cellMeanGradients, mergeAxes, piecesKAt, type AxisPoints } from '../sim/program/pwl';

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

/**
 * Cells below this fraction of the peak |B1| do not decide how the gradient is
 * modelled (they still count in every integral): refocusing tails can overlap
 * the crusher ramps.
 */
const SIGNIFICANT_B1_FRACTION = 0.05;
/** A gradient moving k less than this over the significant cells is ignored:
 *  under one cycle across a metre [1/m]. */
const NEGLIGIBLE_K_SPAN = 1;
/** Largest gradient component off the response axis, or reversal along it,
 *  relative to the peak gradient, that still counts as one monotonic direction. */
const DIRECTION_TOLERANCE = 0.01;

/**
 * The gradient played with an RF event, for position-domain analysis. Axes are
 * logical: a rotation leaves the 1-D result along the gradient unchanged.
 */
export interface RfGradientContext {
    /** Gradient per logical axis, times relative to the RF event start [s, Hz/m]. */
    axes: readonly [AxisPoints, AxisPoints, AxisPoints];
    /** Effective frequency offset incl. PPM [Hz]; under a gradient it moves the excited position. */
    freqOffsetHz: number;
}

interface ComplexRfSamples {
    real: Float64Array;
    imaginary: Float64Array;
    /** Cell starts and centres relative to the RF event start [s]. */
    starts: Float64Array;
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

/** The gradient under the pulse, projected onto the response axis. */
interface GradientTrajectory {
    /** k at each cell centre [1/m]. */
    k: Float64Array;
    /** Mean gradient over each cell [Hz/m]. */
    gradient: Float64Array;
    axis: RFResponseAxis;
    /** First and last cells with significant |B1|. */
    first: number;
    last: number;
    /** One direction and monotonic k over the significant cells. */
    modelled: boolean;
}

/**
 * Analyze one RF library entry.
 *
 * Without a gradient (or for inversion pulses) the response is resolved
 * against a static frequency offset: a bounded FFT locates dominant bands for
 * uniformly sampled pulses, then exact demodulated integrals and
 * no-relaxation spinors are evaluated only at those centres.
 *
 * With a gradient that moves k in one direction, the response is resolved
 * along it instead, as the small-tip profile |Σ B1·exp(−i2π·s·k)·Δt|: a slice
 * written as nonlinear phase under a VERSE gradient has no single frequency
 * offset, but it has a position. Under a constant gradient the two coincide at
 * f = G·s.
 */
export function analyzeRfResponse(
    rf: RFEntry,
    seq: PulseqSequence,
    classifiedUse = rf.use,
    gradient: RfGradientContext | null = null,
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

    // The small-tip profile does not describe adiabatic inversion, so inversion
    // pulses keep the static analysis whatever the gradient.
    let unmodelled = false;
    if (gradient && !inversion) {
        const trajectory = gradientTrajectory(samples, gradient);
        if (trajectory) {
            const response = trajectory.modelled
                ? positionResponse(samples, trajectory, gradient.freqOffsetHz, carrierAreaDeg)
                : null;
            if (response) return response;
            unmodelled = true;
        }
    }

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

    return {
        carrierAreaDeg,
        bands,
        spectrumAnalyzed,
        limited,
        ...(unmodelled ? { domain: 'unmodelled' as const } : {}),
    };
}

/** Carrier-frame complex RF-area equivalent, retained as diagnostic metadata. */
export function estimateRfCarrierAreaDeg(rf: RFEntry, seq: PulseqSequence): number {
    const shapes = rfShapeArrays(rf, seq);
    if (!shapes) return 0;
    let realArea = 0;
    let imaginaryArea = 0;
    forEachRasterCell(shapes, (_start, width, magnitude, phaseCycles) => {
        const amplitude = rf.amplitude * magnitude;
        const phaseRad = TAU * phaseCycles;
        if (!Number.isFinite(amplitude) || !Number.isFinite(phaseRad)) return;
        realArea += amplitude * Math.cos(phaseRad) * width;
        imaginaryArea += amplitude * Math.sin(phaseRad) * width;
    });
    return DEG_PER_CYCLE * Math.hypot(realArea, imaginaryArea);
}

function rfSampleCount(rf: RFEntry, seq: PulseqSequence): number {
    const shapes = rfShapeArrays(rf, seq);
    return shapes ? rasterCellCount(shapes) : 0;
}

/**
 * Complex RF samples as raster cells (see rfWaveform.ts): uniform pulses keep
 * their samples, time-shaped pulses are resampled from their breakpoints. Each
 * sample is evaluated at its cell centre.
 */
function buildComplexRfSamples(rf: RFEntry, seq: PulseqSequence): ComplexRfSamples {
    const raster = seq.rasterTimes.rfRaster;
    const shapes = rfShapeArrays(rf, seq);
    if (!shapes) return emptySamples(raster);
    const cells = rasterCellsFromShapes(shapes);
    if (cells.count < 1) return emptySamples(raster);

    const real = new Float64Array(cells.count);
    const imaginary = new Float64Array(cells.count);
    const times = new Float64Array(cells.count);
    const widths = new Float64Array(cells.count);
    let uniform = true;
    for (let index = 0; index < cells.count; index++) {
        const amplitude = rf.amplitude * cells.magnitude[index];
        const phaseRad = TAU * cells.phaseCycles[index];
        const width = cells.width[index];
        times[index] = cells.start[index] + 0.5 * width;
        widths[index] = Number.isFinite(width) && width > 0 ? width : 0;
        const finite = Number.isFinite(amplitude) && Number.isFinite(phaseRad);
        real[index] = finite ? amplitude * Math.cos(phaseRad) : 0;
        imaginary[index] = finite ? amplitude * Math.sin(phaseRad) : 0;
        if (Math.abs(widths[index] - raster) > Math.max(1e-12, raster * 1e-6)) uniform = false;
    }
    return { real, imaginary, starts: cells.start, times, widths, uniform, dwell: uniform ? raster : widths[0] };
}

function emptySamples(raster: number): ComplexRfSamples {
    return {
        real: new Float64Array(0),
        imaginary: new Float64Array(0),
        starts: new Float64Array(0),
        times: new Float64Array(0),
        widths: new Float64Array(0),
        uniform: true,
        dwell: raster,
    };
}

function frequencyResolvedAreaDeg(samples: ComplexRfSamples, frequencyOffsetHz: number): number {
    return resolvedAreaDeg(samples, samples.times, frequencyOffsetHz);
}

/** 360°·|Σ B1[n]·exp(−i2π·conjugate·coordinates[n])·Δt[n]|: frequency against time, or position against k. */
function resolvedAreaDeg(samples: ComplexRfSamples, coordinates: ArrayLike<number>, conjugate: number): number {
    let realArea = 0;
    let imaginaryArea = 0;
    for (let index = 0; index < samples.real.length; index++) {
        const angle = -TAU * conjugate * coordinates[index];
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

    const fftPoints = paddedFftPoints(sampleCount);
    if (fftPoints > MAX_RF_RESPONSE_FFT_POINTS) return [0];

    const real = new Float64Array(fftPoints);
    const imaginary = new Float64Array(fftPoints);
    real.set(samples.real);
    imaginary.set(samples.imaginary);
    fftInPlace(real, imaginary, fftPoints);

    const offsets = dominantCentres(real, imaginary, samples.dwell, 1 / (fftPoints * samples.dwell));
    return offsets.length > 0 ? offsets : [0];
}

/** Zero-padded FFT size for `count` points, padding only while it fits the ceiling. */
function paddedFftPoints(count: number): number {
    const paddedTarget = count <= Math.floor(MAX_RF_RESPONSE_FFT_POINTS / ZERO_PAD_FACTOR)
        ? count * ZERO_PAD_FACTOR
        : count;
    return nextPowerOfTwo(Math.max(MIN_FFT_POINTS, paddedTarget));
}

/**
 * Centres of the dominant passbands of a transformed spectrum, in ascending
 * order: bins within `DOMINANT_BAND_FRACTION` of the peak area form clusters,
 * each reported at its centroid weighted by area² − threshold². The weight
 * reaches zero at the threshold, so a bin crossing it does not jerk the
 * centre by a whole bin's share. Signed bin m sits at m·step; `areaScale`
 * turns |X| into area [cycles].
 */
function dominantCentres(real: Float64Array, imaginary: Float64Array, areaScale: number, step: number): number[] {
    const fftPoints = real.length;
    const half = fftPoints / 2;
    const areaAt = (bin: number) => DEG_PER_CYCLE * areaScale
        * Math.sqrt(real[bin] * real[bin] + imaginary[bin] * imaginary[bin]);

    let peakAreaDeg = 0;
    for (let bin = 0; bin < fftPoints; bin++) peakAreaDeg = Math.max(peakAreaDeg, areaAt(bin));
    if (!Number.isFinite(peakAreaDeg) || peakAreaDeg < MIN_DOMINANT_AREA_DEG) return [];

    const threshold = Math.max(MIN_DOMINANT_AREA_DEG, peakAreaDeg * DOMINANT_BAND_FRACTION);
    const clusters: SpectralCluster[] = [];
    let active: SpectralCluster | null = null;

    // Signed order keeps a passband spanning zero in one cluster.
    for (let signedBin = -half; signedBin < half; signedBin++) {
        const areaDeg = areaAt(signedBin < 0 ? signedBin + fftPoints : signedBin);
        if (areaDeg >= threshold) {
            const weight = areaDeg * areaDeg - threshold * threshold;
            if (!active) active = { frequencySum: 0, weightSum: 0, peakAreaDeg: 0 };
            active.frequencySum += signedBin * step * weight;
            active.weightSum += weight;
            active.peakAreaDeg = Math.max(active.peakAreaDeg, areaDeg);
        } else if (active) {
            clusters.push(active);
            active = null;
        }
    }
    if (active) clusters.push(active);

    return clusters
        .filter(cluster => cluster.weightSum > 0)
        .sort((left, right) => right.peakAreaDeg - left.peakAreaDeg)
        .slice(0, MAX_RF_RESPONSE_BANDS)
        .map(cluster => cluster.frequencySum / cluster.weightSum)
        .sort((left, right) => left - right);
}

/**
 * The gradient under the pulse along its response axis, or null when it is
 * negligible. Cell gradients are averaged as the simulator's rfCells does.
 */
function gradientTrajectory(samples: ComplexRfSamples, context: RfGradientContext): GradientTrajectory | null {
    const count = samples.real.length;
    if (count === 0) return null;
    const ta = samples.starts[0];
    const tb = samples.starts[count - 1] + samples.widths[count - 1];
    const pieces = mergeAxes(
        [covering(context.axes[0], ta, tb), covering(context.axes[1], ta, tb), covering(context.axes[2], ta, tb)],
        ta,
        tb,
    );
    const cellGradient = cellMeanGradients(pieces, samples.starts, samples.widths, 0);
    const cellK = new Float64Array(3 * count);
    piecesKAt(pieces, samples.times, cellK);

    const magnitude = b1Magnitudes(samples);
    let peak = 0;
    for (let n = 0; n < count; n++) peak = Math.max(peak, magnitude[n]);
    if (!(peak > 0)) return null;
    let first = -1;
    let last = -1;
    for (let n = 0; n < count; n++) {
        if (magnitude[n] < SIGNIFICANT_B1_FRACTION * peak) continue;
        if (first < 0) first = n;
        last = n;
    }

    let span = 0;
    let peakGradient = 0;
    for (let n = first; n <= last; n++) {
        span = Math.max(span, norm3(
            cellK[3 * n] - cellK[3 * first],
            cellK[3 * n + 1] - cellK[3 * first + 1],
            cellK[3 * n + 2] - cellK[3 * first + 2],
        ));
        peakGradient = Math.max(peakGradient, norm3(cellGradient[3 * n], cellGradient[3 * n + 1], cellGradient[3 * n + 2]));
    }
    if (span < NEGLIGIBLE_K_SPAN) return null;

    // The response axis is the net direction k moves, signed so that its
    // largest component is positive: a slice along z is reported in z.
    const direction = [0, 1, 2].map(axis => cellK[3 * last + axis] - cellK[3 * first + axis]);
    const length = norm3(direction[0], direction[1], direction[2]);
    let axis: RFResponseAxis = 's';
    let modelled = length > 0;
    if (modelled) {
        let major = 0;
        for (let a = 1; a < 3; a++) if (Math.abs(direction[a]) > Math.abs(direction[major])) major = a;
        const sign = Math.sign(direction[major]);
        for (let a = 0; a < 3; a++) direction[a] *= sign / length;
        if (Math.abs(direction[major]) > 1 - 1e-9) {
            axis = (['x', 'y', 'z'] as const)[major];
            direction.fill(0);
            direction[major] = 1;
        }
    }

    const k = new Float64Array(count);
    const gradient = new Float64Array(count);
    for (let n = 0; n < count; n++) {
        k[n] = cellK[3 * n] * direction[0] + cellK[3 * n + 1] * direction[1] + cellK[3 * n + 2] * direction[2];
        gradient[n] = cellGradient[3 * n] * direction[0]
            + cellGradient[3 * n + 1] * direction[1]
            + cellGradient[3 * n + 2] * direction[2];
    }

    // Over the significant cells the gradient must stay on the axis and not
    // reverse: a spiral, a 2-D pulse or an oscillating spectral-spatial
    // gradient has no single slice position.
    if (modelled) {
        const travel = Math.sign(k[last] - k[first]);
        const tolerance = DIRECTION_TOLERANCE * peakGradient;
        for (let n = first; n <= last && modelled; n++) {
            const along = gradient[n];
            const off = norm3(
                cellGradient[3 * n] - along * direction[0],
                cellGradient[3 * n + 1] - along * direction[1],
                cellGradient[3 * n + 2] - along * direction[2],
            );
            if (off > tolerance || travel * along < -tolerance) modelled = false;
        }
    }
    return { k, gradient, axis, first, last, modelled };
}

/** An axis's points extended with zeros to cover [ta, tb]: a gradient is zero outside its event. */
function covering(points: AxisPoints, ta: number, tb: number): AxisPoints {
    const count = Math.min(points.times.length, points.values.length);
    if (count === 0) return { times: [ta, tb], values: [0, 0] };
    const firstTime = points.times[0];
    const lastTime = points.times[count - 1];
    if (firstTime <= ta && lastTime >= tb) return points;
    const times: number[] = [];
    const values: number[] = [];
    if (firstTime > ta) times.push(ta, firstTime), values.push(0, 0);
    for (let i = 0; i < count; i++) {
        times.push(points.times[i]);
        values.push(points.values[i]);
    }
    if (lastTime < tb) times.push(lastTime, tb), values.push(0, 0);
    return { times, values };
}

/** The response along the gradient, or null when its spectrum does not fit the analysis bounds. */
function positionResponse(
    samples: ComplexRfSamples,
    trajectory: GradientTrajectory,
    freqOffsetHz: number,
    carrierAreaDeg: number,
): RFResponseAnalysis | null {
    // Under a gradient the frequency offset is not a frame choice: it moves
    // the excited position, so the profile sees it as a phase ramp on B1. The
    // spinor runs in the frame rotating at it instead, with each cell
    // off-resonant by G·s − fo: the oscillator advances that phase within a
    // raster cell, where a ramp written into B1 would hold it.
    const b1 = freqOffsetHz !== 0 ? withFrequencyRamp(samples, freqOffsetHz) : samples;
    const positions = dominantPositions(b1, trajectory);
    if (!positions) return null;

    // B1-weighted mean gradient, for each band's equivalent frequency offset.
    const magnitude = b1Magnitudes(b1);
    let weightedGradient = 0;
    let weight = 0;
    for (let n = 0; n < b1.real.length; n++) {
        const w = magnitude[n] * b1.widths[n];
        weightedGradient += w * trajectory.gradient[n];
        weight += w;
    }
    const meanGradient = weight > 0 ? weightedGradient / weight : 0;

    const bands = positions.map((positionM): RFResponseBand => {
        const spinor = propagateSpinor(samples, -freqOffsetHz, trajectory.gradient, positionM);
        return {
            frequencyOffsetHz: meanGradient * positionM - freqOffsetHz,
            positionM,
            spectralAreaDeg: resolvedAreaDeg(b1, trajectory.k, positionM),
            polarFlipDeg: spinor.polarFlipDeg,
            mz: spinor.mz,
        };
    });
    return {
        carrierAreaDeg,
        bands,
        spectrumAnalyzed: true,
        limited: false,
        domain: 'position',
        axis: trajectory.axis,
    };
}

function withFrequencyRamp(samples: ComplexRfSamples, frequencyHz: number): ComplexRfSamples {
    const real = new Float64Array(samples.real.length);
    const imaginary = new Float64Array(samples.real.length);
    for (let n = 0; n < real.length; n++) {
        const angle = TAU * frequencyHz * samples.times[n];
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        real[n] = samples.real[n] * cosine - samples.imaginary[n] * sine;
        imaginary[n] = samples.real[n] * sine + samples.imaginary[n] * cosine;
    }
    return { ...samples, real, imaginary };
}

/**
 * Dominant positions of the small-tip profile. Each cell's B1·Δt is gridded
 * linearly onto a uniform k grid at the largest per-cell k step, then
 * transformed, which searches up to the per-cell Nyquist limit
 * |s| < 1/(2·max|Δk|). Cells between grid points lose up to sinc²(s·Δk), so
 * 19 % half-way to that limit; under a constant gradient every cell sits on
 * the grid and loses nothing.
 */
function dominantPositions(samples: ComplexRfSamples, trajectory: GradientTrajectory): number[] | null {
    const { k, gradient, first, last } = trajectory;
    let maxStep = 0;
    for (let n = first; n <= last; n++) maxStep = Math.max(maxStep, Math.abs(gradient[n]) * samples.widths[n]);
    if (!(maxStep > 0)) return null;
    const spacing = maxStep;

    // Grid every cell when that fits; otherwise only the significant ones,
    // so tails over a crusher do not stretch the grid.
    let range = kRange(k, 0, k.length - 1);
    let bins = Math.floor((range.high - range.low) / spacing) + 2;
    if (bins > MAX_RF_RESPONSE_FFT_POINTS) {
        range = kRange(k, first, last);
        bins = Math.floor((range.high - range.low) / spacing) + 2;
    }
    const fftPoints = paddedFftPoints(bins);
    if (fftPoints > MAX_RF_RESPONSE_FFT_POINTS) return null;

    const real = new Float64Array(fftPoints);
    const imaginary = new Float64Array(fftPoints);
    for (let n = 0; n < k.length; n++) {
        if (k[n] < range.low || k[n] > range.high) continue;
        const position = (k[n] - range.low) / spacing;
        const bin = Math.min(Math.floor(position), bins - 2);
        const upper = position - bin;
        const width = samples.widths[n];
        real[bin] += (1 - upper) * samples.real[n] * width;
        imaginary[bin] += (1 - upper) * samples.imaginary[n] * width;
        real[bin + 1] += upper * samples.real[n] * width;
        imaginary[bin + 1] += upper * samples.imaginary[n] * width;
    }
    fftInPlace(real, imaginary, fftPoints);

    const positions = dominantCentres(real, imaginary, 1, 1 / (fftPoints * spacing));
    return positions.length > 0 ? positions : null;
}

function kRange(k: Float64Array, from: number, to: number): { low: number; high: number } {
    let low = Infinity;
    let high = -Infinity;
    for (let n = from; n <= to; n++) {
        low = Math.min(low, k[n]);
        high = Math.max(high, k[n]);
    }
    return { low, high };
}

/**
 * No-relaxation Cayley–Klein spinor through the pulse for a spin whose
 * off-resonance is `frequencyOffsetHz`, plus `gradientHz[n]·positionM` per cell
 * when it sits at a position under a gradient.
 */
function propagateSpinor(
    samples: ComplexRfSamples,
    frequencyOffsetHz: number,
    gradientHz: Float64Array | null = null,
    positionM = 0,
): { polarFlipDeg: number; mz: number } {
    let stateAReal = 1;
    let stateAImaginary = 0;
    let stateBReal = 0;
    let stateBImaginary = 0;

    for (let index = 0; index < samples.real.length; index++) {
        const bx = samples.real[index];
        const by = samples.imaginary[index];
        const offset = gradientHz ? frequencyOffsetHz + gradientHz[index] * positionM : frequencyOffsetHz;
        const norm = Math.sqrt(bx * bx + by * by + offset * offset);
        const width = samples.widths[index];
        if (!(norm > 0) || !(width > 0)) continue;

        const sine = Math.sin(Math.PI * norm * width);
        const localAReal = Math.cos(Math.PI * norm * width);
        const localAImaginary = -offset / norm * sine;
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

function b1Magnitudes(samples: ComplexRfSamples): Float64Array {
    const magnitude = new Float64Array(samples.real.length);
    for (let n = 0; n < magnitude.length; n++) {
        magnitude[n] = Math.sqrt(samples.real[n] * samples.real[n] + samples.imaginary[n] * samples.imaginary[n]);
    }
    return magnitude;
}

/** |(x, y, z)|; Math.hypot is several times slower in these per-cell loops. */
function norm3(x: number, y: number, z: number): number {
    return Math.sqrt(x * x + y * y + z * z);
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(maximum, value));
}
