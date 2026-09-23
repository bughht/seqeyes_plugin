import { classifyRfUses } from './rfClassification';
import type { DecodedBlock, PulseqSequence } from './types';

/**
 * Interactive limits protect the UI/extension process from native-raster
 * allocations large enough to freeze or terminate it. Export code intentionally
 * does not use these limits because it runs an explicitly requested calculation.
 */
export const INTERACTIVE_COMPUTE_LIMITS = Object.freeze({
    kspaceRasterSamples: 12_000_000,
    kspaceAdcSamples: 8_000_000,
    kspaceGridCandidates: 18_000_000,
    derivedRasterSamples: 2_000_000,
    /**
     * Ceiling on the display samples one sequence load may carry to the VS Code
     * webview, counted as (time, amplitude) pairs across every RF and gradient
     * waveform. At 12 bytes per pair this bounds the shared binary buffers at
     * roughly 137 MiB in the extension host and again in the renderer.
     * Per-waveform detail is reduced uniformly once a sequence would exceed it,
     * because the alternative is an allocation neither process can satisfy.
     */
    displayTransportSamples: 12_000_000,
    /**
     * Gradient spectrogram ceilings. Unlike k-space these are never offered
     * as a dangerous override: the spectrogram is scoped to the visible
     * window, so the remedy is always "zoom in" rather than "risk the host".
     */
    spectrogramColumns: 1024,
    spectrogramFftPoints: 16_384,
    spectrogramTotalCells: 4_000_000,
    spectrogramInputSamples: 8_000_000,
    /** About 61.2 s of stereo audio at 44.1 kHz. */
    audioSamples: 5_400_000,
});

/** K-space at or above this estimate requires an explicit dangerous override. */
export const KSPACE_CONFIRMATION_MEMORY_BYTES = 1024 ** 3;

export interface KspaceCostEstimate {
    rasterSamples: number;
    adcSamples: number;
    gridCandidatePoints: number;
}

export interface DerivedCostEstimate {
    rasterSamples: number;
    firstGradientTime: number | null;
    lastGradientTime: number | null;
}

/**
 * Maximum visible duration eligible for an automatic detailed M1/PNS request.
 *
 * Viewport requests are padded by half a viewport on each side, so their
 * nominal calculation span is twice the visible duration. The block selector
 * can add RF/PNS history; the host performs the authoritative sample estimate
 * after selection and may still ask the user to zoom further.
 */
export function derivedDetailViewLimitSec(
    gradientRaster: number,
    trTimeSec: number,
    maxRasterSamples = INTERACTIVE_COMPUTE_LIMITS.derivedRasterSamples,
): number {
    if (!(gradientRaster > 0) || !(maxRasterSamples > 0)) return 0;
    const sampleLimitedDuration = maxRasterSamples * gradientRaster / 2;
    if (!(trTimeSec > 0)) return sampleLimitedDuration;
    return Math.min(sampleLimitedDuration, trTimeSec * 100.5);
}

/** Cheap lower-bound estimate made before k-space allocates raster/ADC arrays. */
export function estimateKspaceCost(
    blocks: DecodedBlock[],
    gradientRaster: number,
    totalDuration: number,
): KspaceCostEstimate {
    let adcSamples = 0;
    let gradientSupportPoints = 0;
    let rfSupportPoints = 0;
    for (const block of blocks) {
        if (block.adc?.numSamples && block.adc.numSamples > 0) {
            adcSamples += block.adc.numSamples;
        }
        for (const gradient of [block.gx, block.gy, block.gz]) {
            if (gradient && gradient.type !== 'none' && gradient.timePoints.length >= 2) {
                gradientSupportPoints += 2;
            }
        }
        if (block.rf) rfSupportPoints += block.rf.use === 'r' ? 2 : 3;
    }
    const rasterSamples = gradientRaster > 0 && totalDuration > 0
        ? Math.max(2, Math.round(totalDuration / gradientRaster) + 1)
        : 0;
    const gridCandidatePoints = rasterSamples + adcSamples + gradientSupportPoints + rfSupportPoints + 2;
    return { rasterSamples, adcSamples, gridCandidatePoints };
}

/** Equivalent k-space estimate from parsed references, without waveform decode. */
export function estimateSequenceKspaceCost(
    seq: PulseqSequence,
    totalDuration: number,
): KspaceCostEstimate {
    let adcSamples = 0;
    let gradientSupportPoints = 0;
    let rfSupportPoints = 0;
    const rfUses = classifyRfUses(seq);
    for (let index = 0; index < seq.blocks.length; index++) {
        const block = seq.blocks[index];
        const adc = block.adcId > 0 ? seq.adcs.get(block.adcId) : undefined;
        if (adc?.numSamples && adc.numSamples > 0) adcSamples += adc.numSamples;
        for (const id of [block.gxId, block.gyId, block.gzId]) {
            if (id > 0 && (seq.trapGrads.has(id) || seq.arbitraryGrads.has(id))) {
                gradientSupportPoints += 2;
            }
        }
        if (block.rfId > 0 && seq.rfs.has(block.rfId)) {
            rfSupportPoints += rfUses[index] === 'r' ? 2 : 3;
        }
    }
    const rasterSamples = seq.rasterTimes.gradientRaster > 0 && totalDuration > 0
        ? Math.max(2, Math.round(totalDuration / seq.rasterTimes.gradientRaster) + 1)
        : 0;
    return {
        rasterSamples,
        adcSamples,
        gridCandidatePoints: rasterSamples + adcSamples + gradientSupportPoints + rfSupportPoints + 2,
    };
}

/**
 * What calculating K-space adds to the host process, over what the loaded
 * sequence already costs.
 *
 * The coefficients are measured, not derived. Live memory (heap plus array
 * buffers, after a forced collection) was sampled at each allocation stage for
 * sequences spanning 28 K to 84 M grid candidates and 12 K to 33 M ADC samples,
 * and the two-term fit reproduces every one of them:
 *
 *   writeEpi          0.8 MB predicted,   1 MB measured
 *   writeGradientEcho 2.4 MB              3 MB
 *   rotExt            9.8 MB              9 MB
 *   spiral_inout       76 MB             74 MB
 *   gre_3d_wave_FC  2,251 MB          2,219 MB
 *
 * A candidate costs about 11 bytes: eight for its slot in the one buffer the
 * grid is built in, plus the two RF marker bytes each grid point carries. An
 * ADC sample costs about 43: its Float32 trajectory and Float64 time, plus the
 * staging each host adds. The 25% margin covers sorting temporaries and
 * runtime-dependent overhead.
 *
 * These were 96 and 104 bytes when the trajectory was materialised at full
 * raster — six full-length arrays per grid point — and briefly 17 and 44 after
 * streaming removed them, while the grid was still built through two
 * push-grown arrays. An estimate left at the oldest figures overstated
 * `gre_3d_wave_FC.seq` by 5x, which would gate sequences that now calculate
 * comfortably. Recalibrate whenever the allocation shape changes; it has moved
 * twice already.
 *
 * This is an estimate, not a reservation or a guarantee that the host can
 * allocate it.
 */
export function estimateKspacePeakMemoryBytes(estimate: KspaceCostEstimate): number {
    const gridBytes = Math.max(0, estimate.gridCandidatePoints) * 11;
    const adcAndTransferBytes = Math.max(0, estimate.adcSamples) * 43;
    return Math.ceil(Math.min(Number.MAX_SAFE_INTEGER, (gridBytes + adcAndTransferBytes) * 1.25));
}

/** True when an interactive k-space request must not start automatically. */
export function kspaceExceedsInteractiveBudget(estimate: KspaceCostEstimate): boolean {
    return estimate.rasterSamples > INTERACTIVE_COMPUTE_LIMITS.kspaceRasterSamples
        || estimate.adcSamples > INTERACTIVE_COMPUTE_LIMITS.kspaceAdcSamples
        || estimate.gridCandidatePoints > INTERACTIVE_COMPUTE_LIMITS.kspaceGridCandidates
        || estimateKspacePeakMemoryBytes(estimate) >= KSPACE_CONFIRMATION_MEMORY_BYTES;
}

/** Estimate the regular gradient-raster grid used by full-sequence M1/PNS. */
export function estimateDerivedCost(
    blocks: DecodedBlock[],
    gradientRaster: number,
): DerivedCostEstimate {
    let firstGradientTime = Infinity;
    let lastGradientTime = -Infinity;
    for (const block of blocks) {
        for (const gradient of [block.gx, block.gy, block.gz]) {
            const times = gradient?.timePoints;
            if (!times?.length) continue;
            const first = times[0];
            const last = times[times.length - 1];
            if (Number.isFinite(first) && first < firstGradientTime) firstGradientTime = first;
            if (Number.isFinite(last) && last > lastGradientTime) lastGradientTime = last;
        }
    }
    if (!Number.isFinite(firstGradientTime) || !Number.isFinite(lastGradientTime)
        || lastGradientTime < firstGradientTime || gradientRaster <= 0) {
        return { rasterSamples: 0, firstGradientTime: null, lastGradientTime: null };
    }
    const span = lastGradientTime - firstGradientTime;
    let rasterSamples = Math.max(1, Math.floor(span / gradientRaster) + 1);
    const finalRasterTime = firstGradientTime + (rasterSamples - 1) * gradientRaster;
    if (finalRasterTime < lastGradientTime - 1e-15) rasterSamples++;
    return { rasterSamples, firstGradientTime, lastGradientTime };
}

export function formatSampleCount(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} million`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)} thousand`;
    return String(value);
}

export function formatMemorySize(bytes: number): string {
    const safeBytes = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
    const kib = 1024;
    const mib = kib * 1024;
    const gib = mib * 1024;
    if (safeBytes >= gib) {
        const value = safeBytes / gib;
        return `${value.toFixed(value >= 10 ? 0 : 1)} GiB`;
    }
    if (safeBytes >= mib) {
        const value = safeBytes / mib;
        return `${value.toFixed(value >= 10 ? 0 : 1)} MiB`;
    }
    if (safeBytes >= kib) return `${(safeBytes / kib).toFixed(1)} KiB`;
    return `${Math.round(safeBytes)} bytes`;
}

export interface SpectrogramCostEstimate {
    /** Pre-decimation raster samples the requested window needs. */
    inputSamples: number;
    /** Post-decimation sample count. */
    decimatedSamples: number;
    /** Spectrogram columns the current hop produces. */
    columns: number;
    /** Zero-padded FFT length. */
    fftPoints: number;
    /** Cells across every stored matrix: four gradient, plus three for RF. */
    totalCells: number;
    /** Integer decimation factor the plan will use. */
    decimationFactor: number;
}

export interface SpectrogramCostInput {
    startSec: number;
    endSec: number;
    gradientRaster: number;
    fMaxHz: number;
    windowSamples: number;
    overlap: number;
    oversample: number;
    targetColumns: number;
    /** RF proxy channels add three more matrices to store and transport. */
    includeRf?: boolean;
}

/**
 * Cheap pre-flight estimate for one spectrogram request.
 *
 * Deliberately mirrors the real pipeline’s arithmetic rather than guessing:
 * the window/hop rule in `gradSpectrum.ts` decides the column count, and the
 * refusal notice quotes the number this function returns.
 */
export function estimateSpectrogramCost(input: SpectrogramCostInput): SpectrogramCostEstimate {
    const span = Math.max(0, (Number.isFinite(input.endSec) ? input.endSec : 0)
        - (Number.isFinite(input.startSec) ? input.startSec : 0));
    const raster = input.gradientRaster > 0 ? input.gradientRaster : 1e-5;
    const inputSamples = Math.max(1, Math.floor(span / raster) + 1);
    const sampleRate = 1 / raster;
    const fMax = input.fMaxHz > 0 ? input.fMaxHz : 3000;
    const decimationFactor = Math.max(1, Math.floor(sampleRate / (2.5 * fMax)));
    const decimatedSamples = Math.floor((inputSamples - 1) / decimationFactor) + 1;

    const windowSamples = input.windowSamples > 0 ? input.windowSamples : 512;
    const overlap = Number.isFinite(input.overlap) ? Math.min(0.95, Math.max(0, input.overlap)) : 0.75;
    const hop = Math.max(1, Math.round(windowSamples * (1 - overlap)));
    const naturalColumns = Math.max(1, Math.floor((decimatedSamples - windowSamples) / hop) + 1);
    const targetColumns = input.targetColumns > 0 ? input.targetColumns : 256;
    const columns = Math.min(naturalColumns, targetColumns, INTERACTIVE_COMPUTE_LIMITS.spectrogramColumns);

    const oversample = input.oversample > 0 ? input.oversample : 3;
    let fftPoints = 1;
    while (fftPoints < windowSamples * oversample) fftPoints *= 2;
    const bins = fftPoints / 2 + 1;

    return {
        inputSamples,
        decimatedSamples,
        columns,
        fftPoints,
        totalCells: columns * bins * (input.includeRf ? 7 : 4),
        decimationFactor,
    };
}

/**
 * Reason the spectrogram request is refused, or `null` when it is affordable.
 * The message never offers an override — see the limits block above.
 */
export function spectrogramBudgetRefusal(estimate: SpectrogramCostEstimate): string | null {
    if (estimate.inputSamples > INTERACTIVE_COMPUTE_LIMITS.spectrogramInputSamples) {
        return `Zoom in to compute the spectrogram: the visible window needs ${formatSampleCount(estimate.inputSamples)} gradient samples.`;
    }
    if (estimate.totalCells > INTERACTIVE_COMPUTE_LIMITS.spectrogramTotalCells) {
        return `Zoom in or widen the frequency resolution: this spectrogram would need ${formatSampleCount(estimate.totalCells)} cells.`;
    }
    if (estimate.fftPoints > INTERACTIVE_COMPUTE_LIMITS.spectrogramFftPoints) {
        return `Reduce the window length or zero-padding: a ${estimate.fftPoints}-point FFT exceeds the interactive limit.`;
    }
    return null;
}

export interface AudioCostEstimate {
    sampleRate: number;
    frames: number;
    /** Frames across both channels — what `audioSamples` bounds. */
    totalSamples: number;
    durationSec: number;
}

export function estimateAudioCost(
    startSec: number,
    endSec: number,
    sampleRate: number,
): AudioCostEstimate {
    const fs = sampleRate > 0 ? sampleRate : 44100;
    const durationSec = Math.max(0, (Number.isFinite(endSec) ? endSec : 0) - (Number.isFinite(startSec) ? startSec : 0));
    const frames = Math.floor(durationSec * fs + 1e-9) + 1;
    return { sampleRate: fs, frames, totalSamples: frames * 2, durationSec };
}

/** Refusal reason for an audio request, or `null` when it fits. */
export function audioBudgetRefusal(estimate: AudioCostEstimate): string | null {
    if (estimate.totalSamples > INTERACTIVE_COMPUTE_LIMITS.audioSamples) {
        const maxDurationSec = (INTERACTIVE_COMPUTE_LIMITS.audioSamples / 2 - 1) / estimate.sampleRate;
        const rawBufferBytes = INTERACTIVE_COMPUTE_LIMITS.audioSamples * Float32Array.BYTES_PER_ELEMENT;
        return `The visible window is ${estimate.durationSec.toFixed(1)} s of audio, beyond the ${maxDurationSec.toFixed(1)} s interactive limit (${formatMemorySize(rawBufferBytes)} of stereo samples before browser audio copies). Zoom in or play a bounded preview.`;
    }
    return null;
}
