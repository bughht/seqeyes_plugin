import type { DecodedBlock, DecodedGradWaveform } from './types';
import { BoundedSeriesBuilder, type BoundedSeries } from './boundedSeries';
import { createDecodedGradientSampler, decodedGradientTimeRange } from './gradientSampler';

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

export interface CoarseM1Data {
    valid: boolean;
    ok: boolean;
    coarse: true;
    referenceMode: M1ReferenceMode;
    error?: string;
    startSec: number;
    endSec: number;
    x: BoundedSeries;
    y: BoundedSeries;
    z: BoundedSeries;
    warnings: string[];
    excitationTimesSec: Float64Array;
    refocusingTimesSec: Float64Array;
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

interface TimeInterval {
    start: number;
    end: number;
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

    appendM1AdvisoryWarnings(rfEvents, tMin, warnings);

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
    const output = referenceMode === 'rfCenter'
        ? compactRfCenteredSamples(x.t, x.m1, y.m1, z.m1)
        : { t: x.t, x: x.m1, y: y.m1, z: z.m1 };

    return {
        valid: true,
        ok: true,
        referenceMode,
        tSec: new Float64Array(output.t),
        m1x: new Float64Array(output.x),
        m1y: new Float64Array(output.y),
        m1z: new Float64Array(output.z),
        warnings,
        excitationTimesSec: new Float64Array(excitationTimes),
        refocusingTimesSec: new Float64Array(refocusingTimes),
    };
}

/**
 * RF-centered M1 is exactly constant while every axis has zero effective
 * gradient. Preserve both ends of each plateau so browser interpolation is a
 * horizontal hold, while dropping redundant raster samples in its interior.
 */
function compactRfCenteredSamples(
    time: number[],
    x: number[],
    y: number[],
    z: number[],
): { t: number[]; x: number[]; y: number[]; z: number[] } {
    const count = Math.min(time.length, x.length, y.length, z.length);
    if (count <= 2) return {
        t: time.slice(0, count),
        x: x.slice(0, count),
        y: y.slice(0, count),
        z: z.slice(0, count),
    };
    const out = { t: [time[0]], x: [x[0]], y: [y[0]], z: [z[0]] };
    const sameVector = (left: number, right: number): boolean => (
        x[left] === x[right] && y[left] === y[right] && z[left] === z[right]
    );
    for (let index = 1; index < count - 1; index++) {
        const duplicateTime = time[index] <= time[index - 1] + TIME_EPS
            || time[index + 1] <= time[index] + TIME_EPS;
        const insidePlateau = sameVector(index - 1, index) && sameVector(index, index + 1);
        if (!duplicateTime && insidePlateau) continue;
        out.t.push(time[index]);
        out.x.push(x[index]);
        out.y.push(y[index]);
        out.z.push(z[index]);
    }
    out.t.push(time[count - 1]);
    out.x.push(x[count - 1]);
    out.y.push(y[count - 1]);
    out.z.push(z[count - 1]);
    return out;
}

function appendM1AdvisoryWarnings(rfEvents: RfEvent[], tMin: number, warnings: string[]): void {
    let recentExcCount = 0;
    let lastExcT = -1e9;
    let excitationCount = 0;
    for (const rf of rfEvents) {
        if (rf.use === 'e') {
            excitationCount++;
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
    if (!excitationCount) {
        warnings.push(`No excitation RF events found in sequence. M1 will be integrated from t=${tMin.toFixed(6)} s with no signal basis.`);
    }
}

/**
 * Full-sequence M1 calculation with bounded output and no native-raster arrays.
 * The integration still advances on the gradient raster; only storage is coarse.
 */
export function calculateM1Coarse(
    blocks: DecodedBlock[],
    gradientRaster: number,
    options: M1Options & { maxPoints?: number } = {},
): CoarseM1Data {
    const referenceMode = normalizeReferenceMode(options.referenceMode);
    const emptySeries = (): BoundedSeries => ({
        startTime: new Float64Array(),
        endTime: new Float64Array(),
        min: new Float64Array(),
        max: new Float64Array(),
        first: new Float64Array(),
        last: new Float64Array(),
    });
    const invalid = (error: string): CoarseM1Data => ({
        valid: false,
        ok: false,
        coarse: true,
        referenceMode,
        error,
        startSec: 0,
        endSec: 0,
        x: emptySeries(),
        y: emptySeries(),
        z: emptySeries(),
        warnings: [],
        excitationTimesSec: new Float64Array(),
        refocusingTimesSec: new Float64Array(),
    });
    if (!blocks.length) return invalid('Empty or invalid block list.');
    if (!(gradientRaster > 0)) return invalid('gradientRaster must be positive.');
    const range = decodedGradientTimeRange(blocks);
    if (!range) return invalid('No gradient waveform available for M1.');

    const warnings: string[] = [];
    const rfEvents = collectRfEvents(blocks, warnings);
    appendM1AdvisoryWarnings(rfEvents, range.first, warnings);
    const excitationTimes = rfEvents.filter(rf => rf.use === 'e').map(rf => rf.tSec);
    const refocusingTimes = rfEvents.filter(rf => rf.use === 'r').map(rf => rf.tSec);
    const events = buildWalkerEvents(rfEvents);
    const startSec = Math.min(range.first, events[0]?.tSec ?? range.first);
    const endSec = Math.max(range.last, events[events.length - 1]?.tSec ?? range.last);
    const maxPoints = Math.max(1024, Math.min(120_000, options.maxPoints ?? 30_000));
    const maxBuckets = Math.floor(maxPoints / 4);
    const builders = [
        new BoundedSeriesBuilder(startSec, endSec, maxPoints),
        new BoundedSeriesBuilder(startSec, endSec, maxPoints),
        new BoundedSeriesBuilder(startSec, endSec, maxPoints),
    ];
    const samplers = [
        createDecodedGradientSampler(blocks, 'gx'),
        createDecodedGradientSampler(blocks, 'gy'),
        createDecodedGradientSampler(blocks, 'gz'),
    ];
    const effectiveM0 = [0, 0, 0];
    const effectiveM1 = [0, 0, 0];
    let sign = 1;
    let tReset = excitationTimes.length ? excitationTimes[0] : range.first;
    if (range.first < tReset) tReset = range.first;
    let currentT = tReset;

    const reported = (axis: number, tSec: number): number => (
        referenceMode === 'observationTime'
            ? effectiveM1[axis] - (tSec - tReset) * effectiveM0[axis]
            : effectiveM1[axis]
    );
    const advanceTo = (targetT: number): void => {
        if (!(targetT > currentT + TIME_EPS)) return;
        for (let axis = 0; axis < 3; axis++) {
            const ga = samplers[axis](currentT);
            const gb = samplers[axis](targetT);
            const integrated = integrateLinearSegment(currentT, targetT, tReset, ga, gb);
            effectiveM0[axis] += sign * integrated[0];
            effectiveM1[axis] += sign * integrated[1];
        }
        currentT = targetT;
    };
    const addReported = (tSec: number): void => {
        for (let axis = 0; axis < 3; axis++) builders[axis].add(tSec, reported(axis, tSec));
    };

    const regularCount = Math.floor((range.last - range.first) / gradientRaster) + 1;
    const regularLast = range.first + Math.max(0, regularCount - 1) * gradientRaster;
    const hasFinalSample = regularLast < range.last - TIME_EPS;
    const totalSamples = regularCount + (hasFinalSample ? 1 : 0);
    const sampleTimeAt = (index: number): number => (
        index < regularCount ? range.first + index * gradientRaster : range.last
    );
    const gradientFreeIntervals = referenceMode === 'rfCenter'
        ? collectGradientFreeIntervals(blocks)
        : [];
    let gradientFreeIndex = 0;
    let eventIndex = 0;
    let sampleIndex = 0;
    while (eventIndex < events.length || sampleIndex < totalSamples) {
        const eventTime = eventIndex < events.length ? events[eventIndex].tSec : Number.POSITIVE_INFINITY;
        const sampleTime = sampleIndex < totalSamples
            ? sampleTimeAt(sampleIndex)
            : Number.POSITIVE_INFINITY;
        while (gradientFreeIndex < gradientFreeIntervals.length
            && gradientFreeIntervals[gradientFreeIndex].end <= currentT + TIME_EPS) {
            gradientFreeIndex++;
        }
        const gap = gradientFreeIntervals[gradientFreeIndex];
        const ordinaryTarget = Math.min(eventTime, sampleTime);
        if (gap && currentT < gap.start - TIME_EPS && gap.start < ordinaryTarget - TIME_EPS) {
            advanceTo(gap.start);
            addReported(gap.start);
            continue;
        }
        if (gap && currentT >= gap.start - TIME_EPS && currentT < gap.end - TIME_EPS) {
            const jumpTarget = Math.min(gap.end, eventTime, endSec);
            if (jumpTarget > currentT + TIME_EPS) {
                for (let axis = 0; axis < 3; axis++) {
                    builders[axis].addConstantRange(currentT, jumpTarget, effectiveM1[axis]);
                }
                currentT = jumpTarget;
                while (sampleIndex < totalSamples && sampleTimeAt(sampleIndex) <= currentT + TIME_EPS) {
                    sampleIndex++;
                }
                continue;
            }
        }
        if (eventTime <= sampleTime) {
            advanceTo(eventTime);
            if (events[eventIndex].kind === 'reset') {
                sign = 1;
                tReset = eventTime;
                currentT = eventTime;
                effectiveM0.fill(0);
                effectiveM1.fill(0);
                for (const builder of builders) builder.add(eventTime, 0);
            } else {
                addReported(eventTime);
                sign = -sign;
            }
            eventIndex++;
        } else {
            advanceTo(sampleTime);
            addReported(sampleTime);
            sampleIndex++;
        }
    }
    warnings.push(
        `Showing a bounded full-sequence M1 envelope (at most ${maxBuckets.toLocaleString()} buckets per axis). `
        + 'Zoom to 100 TRs or fewer for an automatic detailed calculation.',
    );
    return {
        valid: true,
        ok: true,
        coarse: true,
        referenceMode,
        startSec,
        endSec,
        x: builders[0].finish(),
        y: builders[1].finish(),
        z: builders[2].finish(),
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

/** Conservative block-local gaps where every physical gradient is exactly zero. */
function collectGradientFreeIntervals(blocks: DecodedBlock[]): TimeInterval[] {
    const gaps: TimeInterval[] = [];
    const appendGap = (start: number, end: number): void => {
        if (!(end > start + TIME_EPS)) return;
        const previous = gaps[gaps.length - 1];
        if (previous && start <= previous.end + TIME_EPS) {
            previous.end = Math.max(previous.end, end);
        } else {
            gaps.push({ start, end });
        }
    };
    for (const block of blocks) {
        const blockStart = block.startTime;
        const blockEnd = block.startTime + block.duration;
        if (!(blockEnd > blockStart + TIME_EPS)) continue;
        const active: TimeInterval[] = [];
        for (const gradient of [block.gx, block.gy, block.gz]) {
            if (!gradient?.timePoints.length || !gradient.waveform.length || gradient.type === 'none') continue;
            let nonzero = false;
            for (const value of gradient.waveform) {
                if (value !== 0) { nonzero = true; break; }
            }
            if (!nonzero) continue;
            const first = Math.max(blockStart, gradient.timePoints[0]);
            const last = Math.min(blockEnd, gradient.timePoints[gradient.timePoints.length - 1]);
            if (last > first + TIME_EPS) active.push({ start: first, end: last });
        }
        active.sort((left, right) => left.start - right.start);
        let cursor = blockStart;
        for (const interval of active) {
            if (interval.start > cursor + TIME_EPS) appendGap(cursor, interval.start);
            cursor = Math.max(cursor, interval.end);
        }
        if (cursor < blockEnd - TIME_EPS) appendGap(cursor, blockEnd);
    }
    return gaps;
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
    let effectiveM0 = 0;
    let effectiveM1 = 0;
    let gradientIndex = -1;

    const seekGradient = (t: number): void => {
        while (gradientIndex + 1 < gradient.time.length
            && gradient.time[gradientIndex + 1] <= t + TIME_EPS) {
            gradientIndex++;
        }
    };

    const sampleGradient = (t: number): number => {
        const n = gradient.time.length;
        if (n === 0 || t < gradient.time[0] - TIME_EPS || t > gradient.time[n - 1] + TIME_EPS) return 0;
        seekGradient(t);
        if (gradientIndex < 0) return 0;
        if (gradientIndex >= n - 1 || Math.abs(t - gradient.time[gradientIndex]) <= TIME_EPS) {
            return gradient.value[gradientIndex];
        }
        const t0 = gradient.time[gradientIndex];
        const t1 = gradient.time[gradientIndex + 1];
        if (!(t1 > t0)) return gradient.value[gradientIndex];
        const alpha = (t - t0) / (t1 - t0);
        return gradient.value[gradientIndex]
            + alpha * (gradient.value[gradientIndex + 1] - gradient.value[gradientIndex]);
    };

    const reportedM1At = (t: number): number => {
        if (referenceMode === 'observationTime') return effectiveM1 - (t - tReset) * effectiveM0;
        return effectiveM1;
    };

    const advanceTo = (targetT: number): void => {
        if (!(targetT > currentT + TIME_EPS)) return;
        while (currentT < targetT - TIME_EPS) {
            seekGradient(currentT);
            let nextT = gradientIndex + 1 < gradient.time.length
                ? Math.min(targetT, gradient.time[gradientIndex + 1])
                : targetT;
            if (!(nextT > currentT)) nextT = targetT;
            const ga = sampleGradient(currentT);
            const gb = sampleGradient(nextT);
            const [m0Seg, m1Seg] = integrateLinearSegment(currentT, nextT, tReset, ga, gb);
            effectiveM0 += sign * m0Seg;
            effectiveM1 += sign * m1Seg;
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
                effectiveM0 = 0;
                effectiveM1 = 0;
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
