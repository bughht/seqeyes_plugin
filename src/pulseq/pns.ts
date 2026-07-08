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

    const tAxis = new Float64Array(nSamples);
    const gxTpm = new Float64Array(nSamples);
    const gyTpm = new Float64Array(nSamples);
    const gzTpm = new Float64Array(nSamples);
    for (let i = 0; i < nSamples; i++) {
        const tSec = (ntMin + i) * dtSec;
        tAxis[i] = tSec;
        gxTpm[i] = interpLinearZero(waves[0], tSec) / gammaHzPerT;
        gyTpm[i] = interpLinearZero(waves[1], tSec) / gammaHzPerT;
        gzTpm[i] = interpLinearZero(waves[2], tSec) / gammaHzPerT;
    }

    const longestTauMs = Math.max(
        hardware.x.tau1Ms, hardware.x.tau2Ms, hardware.x.tau3Ms,
        hardware.y.tau1Ms, hardware.y.tau2Ms, hardware.y.tau3Ms,
        hardware.z.tau1Ms, hardware.z.tau2Ms, hardware.z.tau3Ms,
    );
    const zptSec = longestTauMs * 4.0 / 1000.0;
    const preCount = Math.max(0, Math.round(zptSec / (4.0 * dtSec)));
    const postCount = Math.max(0, Math.round(zptSec / dtSec));

    const gxPadded = padSamples(gxTpm, preCount, postCount);
    const gyPadded = padSamples(gyTpm, preCount, postCount);
    const gzPadded = padSamples(gzTpm, preCount, postCount);

    const stimX = safePnsModel(diff(gxPadded, dtSec), dtSec, hardware.x);
    const stimY = safePnsModel(diff(gyPadded, dtSec), dtSec, hardware.y);
    const stimZ = safePnsModel(diff(gzPadded, dtSec), dtSec, hardware.z);

    const hasAnyNonTrap = blocks.some(block => (
        block.gx?.type === 'arb' || block.gy?.type === 'arb' || block.gz?.type === 'arb'
    ));
    const hasAnyLabelExt = blocks.some(block => !!(block.labelSets?.length || block.labelIncs?.length));
    const shift = hasAnyNonTrap || hasAnyLabelExt ? 1 : 0;

    const selectedX: number[] = [];
    const selectedY: number[] = [];
    const selectedZ: number[] = [];
    const selectedT: number[] = [];
    for (let origIdx = 0; origIdx < nSamples; origIdx++) {
        const paddedIdx = preCount + origIdx;
        let stimIdx = paddedIdx - shift;
        if (shift > 0 && hasAnyLabelExt && origIdx === tAxis.length - 1) {
            stimIdx = Math.min(paddedIdx, stimX.length - 1);
        }
        if (stimIdx < 0 || stimIdx >= stimX.length || stimIdx >= stimY.length || stimIdx >= stimZ.length) continue;
        selectedX.push(stimX[stimIdx]);
        selectedY.push(stimY[stimIdx]);
        selectedZ.push(stimZ[stimIdx]);
        selectedT.push(tAxis[origIdx]);
    }

    const timeSec = new Float64Array(selectedX.length);
    const pnsX = new Float64Array(selectedX.length);
    const pnsY = new Float64Array(selectedX.length);
    const pnsZ = new Float64Array(selectedX.length);
    const pnsNorm = new Float64Array(selectedX.length);
    let ok = true;
    for (let i = 0; i < selectedX.length; i++) {
        const xNorm = 0.01 * selectedX[i];
        const yNorm = 0.01 * selectedY[i];
        const zNorm = 0.01 * selectedZ[i];
        const norm = Math.sqrt(xNorm * xNorm + yNorm * yNorm + zNorm * zNorm);
        timeSec[i] = selectedT[i];
        pnsX[i] = xNorm;
        pnsY[i] = yNorm;
        pnsZ[i] = zNorm;
        pnsNorm[i] = norm;
        if (norm >= 1.0) ok = false;
    }

    return { valid: true, ok, timeSec, pnsX, pnsY, pnsZ, pnsNorm };
}

export function safePnsModel(dgdt: Float64Array, dtSec: number, hw: PnsAxisHardware): Float64Array {
    const absDgdt = new Float64Array(dgdt.length);
    for (let i = 0; i < dgdt.length; i++) absDgdt[i] = Math.abs(dgdt[i]);
    const dtMs = dtSec * 1000.0;
    const lp1 = lowpassTau(dgdt, hw.tau1Ms, dtMs);
    const lp2 = lowpassTau(absDgdt, hw.tau2Ms, dtMs);
    const lp3 = lowpassTau(dgdt, hw.tau3Ms, dtMs);
    const stim = new Float64Array(dgdt.length);
    const denom = hw.stimLimit > 0 ? hw.stimLimit : 1;
    for (let i = 0; i < dgdt.length; i++) {
        const s1 = hw.a1 * Math.abs(lp1[i]);
        const s2 = hw.a2 * lp2[i];
        const s3 = hw.a3 * Math.abs(lp3[i]);
        stim[i] = ((s1 + s2 + s3) / denom) * hw.gScale * 100.0;
    }
    return stim;
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

function lowpassTau(input: Float64Array, tauMs: number, dtMs: number): Float64Array {
    const out = new Float64Array(input.length);
    if (!input.length) return out;
    if (tauMs <= 0 || dtMs <= 0) {
        out.set(input);
        return out;
    }
    const alpha = dtMs / (tauMs + dtMs);
    out[0] = alpha * input[0];
    for (let i = 1; i < input.length; i++) out[i] = alpha * input[i] + (1.0 - alpha) * out[i - 1];
    return out;
}

function collectGradientSeries(blocks: DecodedBlock[], channel: 'gx' | 'gy' | 'gz'): GradientSeries {
    const time: number[] = [];
    const value: number[] = [];
    for (const block of blocks) {
        const grad = block[channel] as DecodedGradWaveform | undefined;
        if (!grad?.timePoints || !grad.waveform) continue;
        const n = Math.min(grad.timePoints.length, grad.waveform.length);
        for (let i = 0; i < n; i++) {
            time.push(grad.timePoints[i]);
            value.push(grad.waveform[i]);
        }
    }
    return sanitizeGradientSeries(time, value);
}

function sanitizeGradientSeries(time: number[], value: number[]): GradientSeries {
    const pairs: Array<[number, number]> = [];
    const n = Math.min(time.length, value.length);
    for (let i = 0; i < n; i++) {
        if (Number.isFinite(time[i]) && Number.isFinite(value[i])) pairs.push([time[i], value[i]]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const outT: number[] = [];
    const outV: number[] = [];
    for (const [t, v] of pairs) {
        const last = outT.length - 1;
        if (last >= 0 && Math.abs(t - outT[last]) <= TIME_EPS) {
            outV[last] = 0.5 * (outV[last] + v);
            continue;
        }
        outT.push(t);
        outV.push(v);
    }
    return { time: outT, value: outV };
}

function interpLinearZero(series: GradientSeries, t: number): number {
    const n = series.time.length;
    if (!n || t < series.time[0] || t > series.time[n - 1]) return 0;
    if (n === 1 || t <= series.time[0]) return series.value[0];
    if (t >= series.time[n - 1]) return series.value[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (series.time[mid] <= t) lo = mid;
        else hi = mid;
    }
    const t0 = series.time[lo];
    const t1 = series.time[hi];
    if (!(t1 > t0)) return series.value[lo];
    const alpha = (t - t0) / (t1 - t0);
    return series.value[lo] + alpha * (series.value[hi] - series.value[lo]);
}

function padSamples(input: Float64Array, preCount: number, postCount: number): Float64Array {
    const out = new Float64Array(preCount + input.length + postCount);
    out.set(input, preCount);
    return out;
}

function diff(input: Float64Array, dtSec: number): Float64Array {
    const out = new Float64Array(Math.max(0, input.length - 1));
    for (let i = 0; i < out.length; i++) out[i] = (input[i + 1] - input[i]) / dtSec;
    return out;
}
