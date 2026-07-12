import type { DecodedBlock, DecodedGradWaveform } from './types';

export const GAMMA_HZ_PER_T = 42.576e6;

export interface PnsAxisHardware {
    tau1Ms: number;
    tau2Ms: number;
    tau3Ms: number;
    a1: number;
    a2: number;
    a3: number;
    stimLimit: number;
    stimThreshold: number;
    gScale: number;
}

export interface PnsHardware {
    x: PnsAxisHardware;
    y: PnsAxisHardware;
    z: PnsAxisHardware;
    valid: boolean;
}

export interface PnsResult {
    valid: boolean;
    ok: boolean;
    error?: string;
    timeSec: Float64Array;
    pnsX: Float64Array;
    pnsY: Float64Array;
    pnsZ: Float64Array;
    pnsNorm: Float64Array;
}

interface ParsedAscValues {
    scalar: Map<string, number>;
    array: Map<string, number[]>;
}

interface GradientSeries {
    time: number[];
    value: number[];
}

const TIME_EPS = 1e-15;

export function parsePnsHardwareAsc(text: string): PnsHardware {
    const asc = parseAscText(text);
    const prefix = resolvePnsPrefix(asc);

    const x = getAxisHardware(
        asc,
        `${prefix}flGSWDTauX`,
        `${prefix}flGSWDAX`,
        `${prefix}flGSWDStimulationLimitX`,
        `${prefix}flGSWDStimulationThresholdX`,
        [
            'asGPAParameters[0].sGCParameters.flGScaleFactorX',
            'asGPAParameters.sGCParameters.flGScaleFactorX',
            'flGScaleFactorX',
            'flGCGScaleFactorX',
            'GScaleFactorX',
        ],
    );
    const y = getAxisHardware(
        asc,
        `${prefix}flGSWDTauY`,
        `${prefix}flGSWDAY`,
        `${prefix}flGSWDStimulationLimitY`,
        `${prefix}flGSWDStimulationThresholdY`,
        [
            'asGPAParameters[0].sGCParameters.flGScaleFactorY',
            'asGPAParameters.sGCParameters.flGScaleFactorY',
            'flGScaleFactorY',
            'flGCGScaleFactorY',
            'GScaleFactorY',
        ],
    );
    const z = getAxisHardware(
        asc,
        `${prefix}flGSWDTauZ`,
        `${prefix}flGSWDAZ`,
        `${prefix}flGSWDStimulationLimitZ`,
        `${prefix}flGSWDStimulationThresholdZ`,
        [
            'asGPAParameters[0].sGCParameters.flGScaleFactorZ',
            'asGPAParameters.sGCParameters.flGScaleFactorZ',
            'flGScaleFactorZ',
            'flGCGScaleFactorZ',
            'GScaleFactorZ',
        ],
    );

    if (!hasValidWeights(x) || !hasValidWeights(y) || !hasValidWeights(z)) {
        throw new Error('ASC hardware coefficients are invalid (a1+a2+a3 or stim limit).');
    }
    return { x, y, z, valid: true };
}

export function calculatePns(
    blocks: DecodedBlock[],
    gradientRaster: number,
    hardware: PnsHardware,
    gammaHzPerT: number = GAMMA_HZ_PER_T,
): PnsResult {
    if (!hardware.valid) return invalidPns('PNS hardware is not initialized.');
    if (!blocks.length) return invalidPns('No sequence loaded.');
    if (gradientRaster <= 0 || gammaHzPerT <= 0) return invalidPns('Missing GradientRasterTime or gamma.');

    const dtSec = gradientRaster;
    const waves = [
        collectGradientSeries(blocks, 'gx'),
        collectGradientSeries(blocks, 'gy'),
        collectGradientSeries(blocks, 'gz'),
    ];
    const nonEmpty = waves.filter(wave => wave.time.length > 0);
    if (!nonEmpty.length) return invalidPns('No gradient waveform available for PNS.');

    const tFirst = Math.min(...nonEmpty.map(wave => wave.time[0]));
    const tLast = Math.max(...nonEmpty.map(wave => wave.time[wave.time.length - 1]));
    if (!Number.isFinite(tFirst) || !Number.isFinite(tLast) || tLast <= tFirst) {
        return invalidPns('No gradient waveform available for PNS.');
    }

    let ntMin = Math.floor(tFirst / dtSec + Number.EPSILON) + 0.5;
    const ntMax = Math.ceil(tLast / dtSec - Number.EPSILON) - 0.5;
    if (ntMin < 0.5) ntMin = 0.5;
    if (ntMax < ntMin) return invalidPns('Unable to build regular PNS raster.');

    const nSamples = Math.floor(ntMax - ntMin + 1.0);
    if (nSamples < 2) return invalidPns('Too few samples for PNS computation.');

    const longestTauMs = Math.max(
        hardware.x.tau1Ms, hardware.x.tau2Ms, hardware.x.tau3Ms,
        hardware.y.tau1Ms, hardware.y.tau2Ms, hardware.y.tau3Ms,
        hardware.z.tau1Ms, hardware.z.tau2Ms, hardware.z.tau3Ms,
    );
    const zptSec = longestTauMs * 4.0 / 1000.0;
    const preCount = Math.max(0, Math.round(zptSec / (4.0 * dtSec)));
    const postCount = Math.max(0, Math.round(zptSec / dtSec));

    const stimX = calculatePnsAxis(waves[0], ntMin, nSamples, preCount, postCount, dtSec, gammaHzPerT, hardware.x);
    const stimY = calculatePnsAxis(waves[1], ntMin, nSamples, preCount, postCount, dtSec, gammaHzPerT, hardware.y);
    const stimZ = calculatePnsAxis(waves[2], ntMin, nSamples, preCount, postCount, dtSec, gammaHzPerT, hardware.z);

    const hasAnyNonTrap = blocks.some(block => (
        block.gx?.type === 'arb' || block.gy?.type === 'arb' || block.gz?.type === 'arb'
    ));
    const hasAnyLabelExt = blocks.some(block => !!(block.labelSets?.length || block.labelIncs?.length));
    const shift = hasAnyNonTrap || hasAnyLabelExt ? 1 : 0;

    let selectedCount = 0;
    for (let origIdx = 0; origIdx < nSamples; origIdx++) {
        const paddedIdx = preCount + origIdx;
        let stimIdx = paddedIdx - shift;
        if (shift > 0 && hasAnyLabelExt && origIdx === nSamples - 1) {
            stimIdx = Math.min(paddedIdx, stimX.length - 1);
        }
        if (stimIdx < 0 || stimIdx >= stimX.length || stimIdx >= stimY.length || stimIdx >= stimZ.length) continue;
        selectedCount++;
    }

    const timeSec = new Float64Array(selectedCount);
    const pnsX = new Float64Array(selectedCount);
    const pnsY = new Float64Array(selectedCount);
    const pnsZ = new Float64Array(selectedCount);
    const pnsNorm = new Float64Array(selectedCount);
    let ok = true;
    let selectedIndex = 0;
    for (let origIdx = 0; origIdx < nSamples; origIdx++) {
        const paddedIdx = preCount + origIdx;
        let stimIdx = paddedIdx - shift;
        if (shift > 0 && hasAnyLabelExt && origIdx === nSamples - 1) {
            stimIdx = Math.min(paddedIdx, stimX.length - 1);
        }
        if (stimIdx < 0 || stimIdx >= stimX.length || stimIdx >= stimY.length || stimIdx >= stimZ.length) continue;
        const xNorm = 0.01 * stimX[stimIdx];
        const yNorm = 0.01 * stimY[stimIdx];
        const zNorm = 0.01 * stimZ[stimIdx];
        const norm = Math.sqrt(xNorm * xNorm + yNorm * yNorm + zNorm * zNorm);
        timeSec[selectedIndex] = (ntMin + origIdx) * dtSec;
        pnsX[selectedIndex] = xNorm;
        pnsY[selectedIndex] = yNorm;
        pnsZ[selectedIndex] = zNorm;
        pnsNorm[selectedIndex] = norm;
        if (norm >= 1.0) ok = false;
        selectedIndex++;
    }

    return { valid: true, ok, timeSec, pnsX, pnsY, pnsZ, pnsNorm };
}

export function safePnsModel(dgdt: Float64Array, dtSec: number, hw: PnsAxisHardware): Float64Array {
    return runPnsModel(dgdt.length, index => dgdt[index], dtSec, hw);
}

function runPnsModel(
    length: number,
    derivativeAt: (index: number) => number,
    dtSec: number,
    hw: PnsAxisHardware,
): Float64Array {
    const dtMs = dtSec * 1000.0;
    const alpha1 = lowpassAlpha(hw.tau1Ms, dtMs);
    const alpha2 = lowpassAlpha(hw.tau2Ms, dtMs);
    const alpha3 = lowpassAlpha(hw.tau3Ms, dtMs);
    const stim = new Float64Array(length);
    const denom = hw.stimLimit > 0 ? hw.stimLimit : 1;
    let lp1 = 0;
    let lp2 = 0;
    let lp3 = 0;
    for (let i = 0; i < length; i++) {
        const derivative = derivativeAt(i);
        lp1 = alpha1 * derivative + (1.0 - alpha1) * lp1;
        lp2 = alpha2 * Math.abs(derivative) + (1.0 - alpha2) * lp2;
        lp3 = alpha3 * derivative + (1.0 - alpha3) * lp3;
        const s1 = hw.a1 * Math.abs(lp1);
        const s2 = hw.a2 * lp2;
        const s3 = hw.a3 * Math.abs(lp3);
        stim[i] = ((s1 + s2 + s3) / denom) * hw.gScale * 100.0;
    }
    return stim;
}

function lowpassAlpha(tauMs: number, dtMs: number): number {
    return tauMs <= 0 || dtMs <= 0 ? 1 : dtMs / (tauMs + dtMs);
}

function invalidPns(error: string): PnsResult {
    return {
        valid: false,
        ok: false,
        error,
        timeSec: new Float64Array(),
        pnsX: new Float64Array(),
        pnsY: new Float64Array(),
        pnsZ: new Float64Array(),
        pnsNorm: new Float64Array(),
    };
}

function parseAscText(text: string): ParsedAscValues {
    const scalar = new Map<string, number>();
    const array = new Map<string, number[]>();
    const re = /^\s*([A-Za-z0-9_.[\]]+?)(?:\[(\d+)])?\s*=\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*$/;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('###')) continue;
        if (/^\$include\b/i.test(line)) {
            throw new Error('ASC contains $include directives. Use a combined ASC profile in the web viewer, or open it through the VS Code extension so companion ASC files can be resolved.');
        }
        const match = re.exec(line);
        if (!match) continue;
        const key = match[1].trim();
        const index = match[2] === undefined ? -1 : Number.parseInt(match[2], 10);
        const value = Number(match[3]);
        if (!Number.isFinite(value)) continue;
        if (index >= 0) {
            const values = array.get(key) ?? [];
            values[index] = value;
            array.set(key, values);
        } else {
            scalar.set(key, value);
        }
    }
    return { scalar, array };
}

function resolvePnsPrefix(asc: ParsedAscValues): string {
    if (asc.array.has('flGSWDTauX')) return '';
    if (asc.array.has('GradPatSup.Phys.PNS.flGSWDTauX')) return 'GradPatSup.Phys.PNS.';
    const candidates = [...asc.array.keys()]
        .filter(key => key.endsWith('flGSWDTauX') && !key.toLowerCase().includes('.carns.'))
        .sort();
    if (candidates.length) return candidates[0].slice(0, -'flGSWDTauX'.length);
    return 'GradPatSup.Phys.PNS.';
}

function getAxisHardware(
    asc: ParsedAscValues,
    tauKey: string,
    aKey: string,
    stimLimitKey: string,
    stimThreshKey: string,
    gScaleKeys: string[],
): PnsAxisHardware {
    const tau = findArray(asc, tauKey);
    const weights = findArray(asc, aKey);
    if (!tau || !weights) throw new Error(`Missing ASC arrays for ${tauKey} or ${aKey}`);
    if (tau.length < 3 || weights.length < 3) throw new Error(`ASC arrays ${tauKey}/${aKey} require at least 3 values`);

    const stimLimit = findScalar(asc, stimLimitKey);
    const stimThreshold = findScalar(asc, stimThreshKey);
    if (stimLimit === undefined || stimThreshold === undefined) {
        throw new Error(`Missing ASC scalar ${stimLimitKey} or ${stimThreshKey}`);
    }

    let gScale: number | undefined;
    for (const key of gScaleKeys) {
        gScale = findScalar(asc, key);
        if (gScale !== undefined) break;
    }
    if (gScale === undefined) {
        throw new Error('ASC is missing g_scale factors (X/Y/Z). Select a full ASC (e.g. *_twoFilesCombined.asc).');
    }

    return {
        tau1Ms: tau[0],
        tau2Ms: tau[1],
        tau3Ms: tau[2],
        a1: weights[0],
        a2: weights[1],
        a3: weights[2],
        stimLimit,
        stimThreshold,
        gScale,
    };
}

function findArray(asc: ParsedAscValues, key: string): number[] | undefined {
    const exact = asc.array.get(key);
    if (exact) return exact;
    const keyNorm = normalizeAscKey(key);
    const chosen = [...asc.array.keys()]
        .filter(candidate => normalizeAscKey(candidate) === keyNorm && !candidate.toLowerCase().includes('.carns.'))
        .sort()[0];
    return chosen ? asc.array.get(chosen) : undefined;
}

function findScalar(asc: ParsedAscValues, key: string): number | undefined {
    const exact = asc.scalar.get(key);
    if (exact !== undefined) return exact;
    const keyNorm = normalizeAscKey(key);
    const chosen = [...asc.scalar.keys()]
        .filter(candidate => normalizeAscKey(candidate) === keyNorm && !candidate.toLowerCase().includes('.carns.'))
        .sort()[0];
    return chosen ? asc.scalar.get(chosen) : undefined;
}

function normalizeAscKey(key: string): string {
    return key.trim().replace(/\[\d+]/g, '');
}

function hasValidWeights(hw: PnsAxisHardware): boolean {
    return Math.abs(hw.a1 + hw.a2 + hw.a3 - 1.0) <= 1e-2 && hw.stimLimit > 0;
}

function collectGradientSeries(blocks: DecodedBlock[], channel: 'gx' | 'gy' | 'gz'): GradientSeries {
    const series: GradientSeries = { time: [], value: [] };
    for (const block of blocks) {
        const grad = block[channel] as DecodedGradWaveform | undefined;
        if (!grad?.timePoints || !grad.waveform) continue;
        const n = Math.min(grad.timePoints.length, grad.waveform.length);
        for (let i = 0; i < n; i++) {
            appendGradientPoint(series, grad.timePoints[i], grad.waveform[i]);
        }
    }
    return series;
}

function appendGradientPoint(series: GradientSeries, t: number, value: number): void {
    if (!Number.isFinite(t) || !Number.isFinite(value)) return;
    const last = series.time.length - 1;
    if (last >= 0 && Math.abs(t - series.time[last]) <= TIME_EPS) {
        series.value[last] = 0.5 * (series.value[last] + value);
    } else if (last < 0 || t > series.time[last]) {
        series.time.push(t);
        series.value.push(value);
    }
}

function calculatePnsAxis(
    series: GradientSeries,
    ntMin: number,
    nSamples: number,
    preCount: number,
    postCount: number,
    dtSec: number,
    gammaHzPerT: number,
    hardware: PnsAxisHardware,
): Float64Array {
    const sampleGradient = createGradientSampler(series);
    const totalSamples = preCount + nSamples + postCount;
    const paddedValue = (index: number): number => {
        if (index < preCount || index >= preCount + nSamples) return 0;
        const rasterIndex = index - preCount;
        return sampleGradient((ntMin + rasterIndex) * dtSec) / gammaHzPerT;
    };

    let previous = paddedValue(0);
    return runPnsModel(Math.max(0, totalSamples - 1), index => {
        const current = paddedValue(index + 1);
        const derivative = (current - previous) / dtSec;
        previous = current;
        return derivative;
    }, dtSec, hardware);
}

function createGradientSampler(series: GradientSeries): (t: number) => number {
    let index = -1;
    return (t: number): number => {
        const n = series.time.length;
        if (n === 0 || t < series.time[0] || t > series.time[n - 1]) return 0;
        while (index + 1 < n && series.time[index + 1] <= t + TIME_EPS) index++;
        if (index < 0) return 0;
        if (index >= n - 1 || t <= series.time[index] + TIME_EPS) return series.value[index];
        const t0 = series.time[index];
        const t1 = series.time[index + 1];
        if (!(t1 > t0)) return series.value[index];
        const alpha = (t - t0) / (t1 - t0);
        return series.value[index] + alpha * (series.value[index + 1] - series.value[index]);
    };
}
