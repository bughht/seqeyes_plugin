import type { DecodedBlock, DecodedGradWaveform } from './types';

export interface M1Data {
    valid: boolean;
    ok: boolean;
    referenceMode: M1ReferenceMode;
    error?: string;
    tSec: Float64Array;
    m1x: Float64Array;
    m1y: Float64Array;
    m1z: Float64Array;
    warnings: string[];
    excitationTimesSec: Float64Array;
    refocusingTimesSec: Float64Array;
}

export type M1ReferenceMode = 'rfCenter' | 'observationTime';

export interface M1Options {
    referenceMode?: M1ReferenceMode;
}

interface RfEvent {
    tSec: number;
    use: string;
}

interface WalkerEvent {
    tSec: number;
    kind: 'reset' | 'flip';
}

interface GradientSeries {
    time: number[];
    value: number[];
}

const TIME_EPS = 1e-15;

export function calculateM1(blocks: DecodedBlock[], gradientRaster: number, options: M1Options = {}): M1Data {
    const referenceMode = normalizeReferenceMode(options.referenceMode);
    if (!blocks.length) {
        return invalidM1('Empty or invalid block list.', referenceMode);
    }

    const gx = collectGradientSeries(blocks, 'gx');
    const gy = collectGradientSeries(blocks, 'gy');
    const gz = collectGradientSeries(blocks, 'gz');
    const ranges = [gx, gy, gz]
        .filter(series => series.time.length > 0)
        .map(series => [series.time[0], series.time[series.time.length - 1]] as const);
    if (!ranges.length) {
        return invalidM1('No gradient waveform available for M1.', referenceMode);
    }

    const tMin = Math.min(...ranges.map(range => range[0]));
    const tMax = Math.max(...ranges.map(range => range[1]));
    if (!Number.isFinite(tMin) || !Number.isFinite(tMax) || tMax < tMin) {
        return invalidM1('Invalid gradient time range for M1.', referenceMode);
    }

    const warnings: string[] = [];
    const rfEvents = collectRfEvents(blocks, warnings);
    const excitationTimes = rfEvents.filter(rf => rf.use === 'e').map(rf => rf.tSec);
    const refocusingTimes = rfEvents.filter(rf => rf.use === 'r').map(rf => rf.tSec);
    const events = buildWalkerEvents(rfEvents);

    let recentExcCount = 0;
    let lastExcT = -1e9;
    for (const rf of rfEvents) {
        if (rf.use === 'e') {
            if (rf.tSec - lastExcT < 0.100) recentExcCount++;
            lastExcT = rf.tSec;
        }
    }
    if (recentExcCount > 8) {
        warnings.push(
            `Sequence shows ${recentExcCount} closely-spaced (<100 ms) excitation events. `
            + 'This pattern is consistent with a steady-state sequence for which the simplified '
            + 'reset/flip bookkeeping does NOT model coherent pathway interference. Treat the M1 curve as advisory only.',
        );
    }
    if (!excitationTimes.length) {
        warnings.push(`No excitation RF events found in sequence. M1 will be integrated from t=${tMin.toFixed(6)} s with no signal basis.`);
    }

    const rasterSec = gradientRaster > 0 ? gradientRaster : 10e-6;
    if (rasterSec <= 0) {
        return invalidM1('gradientRaster must be positive.', referenceMode);
    }
    const samples = buildSampleTimes(tMin, tMax, rasterSec);

    const x = walkM1(gx, samples, events, excitationTimes, tMin, referenceMode);
    const y = walkM1(gy, samples, events, excitationTimes, tMin, referenceMode);
    const z = walkM1(gz, samples, events, excitationTimes, tMin, referenceMode);
    if (x.t.length !== y.t.length || x.t.length !== z.t.length) {
        warnings.push(`Internal warning: per-axis M1 output sizes disagree (${x.t.length}, ${y.t.length}, ${z.t.length}). Plot may be inconsistent.`);
    }

    return {
        valid: true,
        ok: true,
        referenceMode,
        tSec: new Float64Array(x.t),
        m1x: new Float64Array(x.m1),
        m1y: new Float64Array(y.m1),
        m1z: new Float64Array(z.m1),
        warnings,
        excitationTimesSec: new Float64Array(excitationTimes),
        refocusingTimesSec: new Float64Array(refocusingTimes),
    };
}

function invalidM1(error: string, referenceMode: M1ReferenceMode = 'rfCenter'): M1Data {
    return {
        valid: false,
        ok: false,
        referenceMode,
        error,
        tSec: new Float64Array(),
        m1x: new Float64Array(),
        m1y: new Float64Array(),
        m1z: new Float64Array(),
        warnings: [],
        excitationTimesSec: new Float64Array(),
        refocusingTimesSec: new Float64Array(),
    };
}

function normalizeReferenceMode(mode: M1ReferenceMode | undefined): M1ReferenceMode {
    return mode === 'observationTime' ? 'observationTime' : 'rfCenter';
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
        const t = time[i];
        const v = value[i];
        if (Number.isFinite(t) && Number.isFinite(v)) pairs.push([t, v]);
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

function collectRfEvents(blocks: DecodedBlock[], warnings: string[]): RfEvent[] {
    const events: RfEvent[] = [];
    for (const block of blocks) {
        if (!block.rf) continue;
        const use = classifyRfUse(block.rf.use);
        if (!use) continue;
        const rec = { tSec: block.rf.centerTime, use };
        events.push(rec);
        if (use === 'u') {
            warnings.push(`Unknown RF use 'u' at t=${rec.tSec.toFixed(6)} s; M1 bookkeeping treats it as no-op.`);
        } else if (use === 'p') {
            warnings.push(
                `Preparation module 'p' at t=${rec.tSec.toFixed(6)} s; treated as M1 reset `
                + '(simplified handling; prep modules that preserve phase encoding will give wrong results).',
            );
        }
    }
    events.sort((a, b) => a.tSec - b.tSec);
    return events;
}

function classifyRfUse(raw: string | undefined): string {
    const c = (raw || 'u').toLowerCase();
    if (c === 'e' || c === 'r' || c === 's' || c === 'i' || c === 'p') return c;
    return 'u';
}

function buildWalkerEvents(rfs: RfEvent[]): WalkerEvent[] {
    const events: WalkerEvent[] = [];
    for (const rf of rfs) {
        if (rf.use === 'i' || rf.use === 'u') continue;
        events.push({
            tSec: rf.tSec,
            kind: rf.use === 'r' ? 'flip' : 'reset',
        });
    }
    events.sort((a, b) => {
        if (a.tSec !== b.tSec) return a.tSec - b.tSec;
        return a.kind === 'reset' && b.kind === 'flip' ? -1 : 1;
    });
    return events;
}

function buildSampleTimes(tMin: number, tMax: number, rasterSec: number): number[] {
    const samples: number[] = [];
    const nSamples = Math.floor((tMax - tMin) / rasterSec) + 1;
    for (let i = 0; i < nSamples; i++) samples.push(tMin + i * rasterSec);
    if (!samples.length || samples[samples.length - 1] < tMax - TIME_EPS) samples.push(tMax);
    return samples;
}

function walkM1(
    gradient: GradientSeries,
    samples: number[],
    events: WalkerEvent[],
    excitationTimes: number[],
    tMin: number,
    referenceMode: M1ReferenceMode,
): { t: number[]; m1: number[] } {
    const outT: number[] = [];
    const outM1: number[] = [];
    let sign = 1;
    let tReset = excitationTimes.length ? excitationTimes[0] : tMin;
    if (samples.length && samples[0] < tReset) tReset = samples[0];
    let currentT = tReset;
    let unsignedM0 = 0;
    let unsignedM1 = 0;

    const reportedM1At = (t: number): number => {
        if (referenceMode === 'observationTime') return sign * (unsignedM1 - (t - tReset) * unsignedM0);
        return sign * unsignedM1;
    };

    const advanceTo = (targetT: number): void => {
        if (!(targetT > currentT + TIME_EPS)) return;
        while (currentT < targetT - TIME_EPS) {
            let nextT = nextGradientBreakpoint(gradient.time, currentT, targetT);
            if (!(nextT > currentT)) nextT = targetT;
            const ga = sampleGradientAt(gradient, currentT);
            const gb = sampleGradientAt(gradient, nextT);
            const [m0Seg, m1Seg] = integrateLinearSegment(currentT, nextT, tReset, ga, gb);
            unsignedM0 += m0Seg;
            unsignedM1 += m1Seg;
            currentT = nextT;
        }
    };

    let ei = 0;
    let si = 0;
    while (ei < events.length || si < samples.length) {
        const nextEvtT = ei < events.length ? events[ei].tSec : Number.POSITIVE_INFINITY;
        const nextSampT = si < samples.length ? samples[si] : Number.POSITIVE_INFINITY;

        if (nextEvtT <= nextSampT) {
            advanceTo(nextEvtT);
            if (events[ei].kind === 'reset') {
                if (!outT.length || outT[outT.length - 1] < nextEvtT - TIME_EPS) {
                    outT.push(nextEvtT);
                    outM1.push(0);
                } else {
                    outT[outT.length - 1] = nextEvtT;
                    outM1[outM1.length - 1] = 0;
                }
                sign = 1;
                tReset = nextEvtT;
                currentT = nextEvtT;
                unsignedM0 = 0;
                unsignedM1 = 0;
            } else {
                outT.push(nextEvtT);
                outM1.push(reportedM1At(nextEvtT));
                sign = -sign;
            }
            ei++;
        } else {
            advanceTo(nextSampT);
            outT.push(nextSampT);
            outM1.push(reportedM1At(nextSampT));
            si++;
        }
    }
    return { t: outT, m1: outM1 };
}

function sampleGradientAt(gradient: GradientSeries, t: number): number {
    const n = gradient.time.length;
    if (n <= 0 || t < gradient.time[0] || t > gradient.time[n - 1]) return 0;
    if (n === 1 || t <= gradient.time[0]) return gradient.value[0];
    if (t >= gradient.time[n - 1]) return gradient.value[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (gradient.time[mid] <= t) lo = mid;
        else hi = mid;
    }
    const t0 = gradient.time[lo];
    const t1 = gradient.time[hi];
    if (!(t1 > t0)) return gradient.value[lo];
    const alpha = (t - t0) / (t1 - t0);
    return gradient.value[lo] + alpha * (gradient.value[hi] - gradient.value[lo]);
}

function nextGradientBreakpoint(times: number[], t: number, target: number): number {
    if (times.length <= 1 || t >= times[times.length - 1]) return target;
    let lo = 0;
    let hi = times.length;
    const threshold = t + TIME_EPS;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= threshold) lo = mid + 1;
        else hi = mid;
    }
    return lo < times.length ? Math.min(target, times[lo]) : target;
}

function integrateLinearSegment(a: number, b: number, tRef: number, ga: number, gb: number): [number, number] {
    const h = b - a;
    if (!(h > 0)) return [0, 0];
    const slope = (gb - ga) / h;
    const aRel = a - tRef;
    const m0 = ga * h + 0.5 * slope * h * h;
    const m1 = ga * (aRel * h + 0.5 * h * h)
        + slope * (0.5 * aRel * h * h + (h * h * h) / 3.0);
    return [m0, m1];
}
