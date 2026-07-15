import type { DecodedBlock } from './types';

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
});

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

/**
 * Conservative host-process peak for the current JavaScript K-space path.
 *
 * Each candidate can coexist in the candidate/deduplicated number arrays,
 * gradient arrays, integrated trajectory arrays, plot-break copies, and the
 * returned time array. ADC samples additionally require calculation outputs,
 * transfer/base64 staging in VS Code, and renderer/GPU staging. The 25% margin
 * covers sorting temporaries and runtime-dependent array overhead. This is an
 * estimate, not a reservation or a guarantee that the host can allocate it.
 */
export function estimateKspacePeakMemoryBytes(estimate: KspaceCostEstimate): number {
    const gridBytes = Math.max(0, estimate.gridCandidatePoints) * 96;
    const adcAndTransferBytes = Math.max(0, estimate.adcSamples) * 104;
    return Math.ceil(Math.min(Number.MAX_SAFE_INTEGER, (gridBytes + adcAndTransferBytes) * 1.25));
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
