/**
 * Lower a parsed Pulseq sequence into a simulation program (see ./types.ts).
 *
 * Blocks are decoded one at a time and streamed through the shared gradient
 * timeline, so memory stays bounded by the lookahead window rather than the
 * sequence. A block's segments are emitted once the gradient waveform is final
 * through the block's end; that normally needs one block of lookahead (the next
 * block decides whether an edge ramps, continues or snaps).
 */

import type { ADCEntry, DecodedBlock, PulseqSequence, RFEntry } from '../../pulseq/types';
import { ExtType, VER_PRE_14 } from '../../pulseq/types';
import {
    createSequenceDecodeContext,
    decodeBlockRange,
    detectPtxTimeShapeChannels,
    type SequenceDecodeContext,
} from '../../pulseq/decoder';
import { GradientTimelineBuilder, type GradientAxisAssembler } from '../../pulseq/gradientTimeline';
import { rfShapeArrays, rfShapeDuration, type RfShapeArrays } from '../../pulseq/rfWaveform';
import { DEFAULT_B0_T, PULSEQ_GAMMA_HZ_PER_T } from '../conventions';
import { ContentHasher } from './hash';
import {
    addPiecesIntegral,
    mergeAxes,
    pieceCount,
    piecesMoments,
    relativePieces,
    type AxisPoints,
    type GradientPieces,
} from './pwl';
import type {
    AdcSegment,
    CompileOptions,
    FreeSegment,
    IgnoredFeature,
    RfOperatorSpec,
    RfSegment,
    SimSegment,
} from './types';

/** Events may overshoot their block by float rounding only. */
const EVENT_TIME_TOLERANCE_SEC = 1e-9;
/** Key quantisation: relative times to 0.1 ns, gradient values to 1 µHz/m. */
const KEY_TIME_QUANTUM_SEC = 1e-10;
const KEY_GRADIENT_QUANTUM = 1e6;

export interface SimProgram {
    readonly sequence: PulseqSequence;
    readonly blockCount: number;
    /** Block start times on the program clock, length blockCount + 1 [s]. */
    readonly blockStartTimes: Float64Array;
    readonly totalDuration: number;
    readonly b0: number;
    readonly gamma: number;
    /** Distinct RF operators, filled while segments stream. */
    readonly rfOperators: Map<string, RfOperatorSpec>;
    /** Features present in the file that the program does not represent. */
    readonly ignoredFeatures: Set<IgnoredFeature>;
    /** Stream every segment in time order. */
    segments(): Generator<SimSegment, void, undefined>;
}

export function compileProgram(seq: PulseqSequence, options: CompileOptions = {}): SimProgram {
    const b0 = options.b0 ?? fileB0(seq) ?? DEFAULT_B0_T;
    const gamma = options.gamma ?? PULSEQ_GAMMA_HZ_PER_T;
    const blockStartTimes = computeBlockStartTimes(seq, options);
    const blockCount = seq.blocks.length;
    const totalDuration = blockStartTimes[blockCount];
    const rfOperators = new Map<string, RfOperatorSpec>();
    const ignoredFeatures = new Set<IgnoredFeature>();

    return {
        sequence: seq,
        blockCount,
        blockStartTimes,
        totalDuration,
        b0,
        gamma,
        rfOperators,
        ignoredFeatures,
        segments: () => streamSegments(seq, {
            b0, gamma, blockStartTimes, totalDuration, rfOperators, ignoredFeatures,
        }),
    };
}

interface StreamContext {
    b0: number;
    gamma: number;
    blockStartTimes: Float64Array;
    totalDuration: number;
    rfOperators: Map<string, RfOperatorSpec>;
    ignoredFeatures: Set<IgnoredFeature>;
}

function* streamSegments(seq: PulseqSequence, ctx: StreamContext): Generator<SimSegment, void, undefined> {
    const n = seq.blocks.length;
    const raster = seq.rasterTimes.gradientRaster;
    const decodeContext = programDecodeContext(seq, ctx.blockStartTimes);
    const nextPieceBlock = computeNextPieceBlocks(seq);
    const builder = new GradientTimelineBuilder(raster, undefined, false);
    const readers = builder.axes.map(axis => new AxisWindowReader(axis)) as
        [AxisWindowReader, AxisWindowReader, AxisWindowReader];

    const queue: DecodedBlock[] = [];
    let next = 0;            // next block to append
    let finished = false;
    let adcIndex = 0;
    const nextPieceTimes = new Float64Array(3);

    for (let emit = 0; emit < n; emit++) {
        const blockEnd = ctx.blockStartTimes[emit + 1];
        for (;;) {
            if (next >= n) {
                if (!finished) {
                    builder.finish(ctx.totalDuration);
                    finished = true;
                }
                break;
            }
            if (next > emit) {
                for (let axis = 0; axis < 3; axis++) {
                    const block = nextPieceBlock[axis][next];
                    nextPieceTimes[axis] = block < n ? ctx.blockStartTimes[block] : Number.POSITIVE_INFINITY;
                }
                if (builder.finalThrough(nextPieceTimes) >= blockEnd) break;
            }
            const [decoded] = decodeBlockRange(seq, next, next + 1, decodeContext);
            builder.append(decoded);
            queue.push(decoded);
            next++;
        }

        const decoded = queue.shift()!;
        const blockStart = ctx.blockStartTimes[emit];
        noteIgnoredFeatures(decoded, ctx.ignoredFeatures);

        const events: { start: number; end: number; build: () => SimSegment }[] = [];
        if (decoded.rf) {
            const rfEntry = seq.rfs.get(seq.blocks[emit].rfId)!;
            const timing = rfTiming(seq, rfEntry, blockStart);
            events.push({
                start: timing.start,
                end: timing.end,
                build: () => buildRfSegment(seq, ctx, readers, decoded, rfEntry, timing, emit),
            });
        }
        const adcEntry = seq.blocks[emit].adcId > 0 ? seq.adcs.get(seq.blocks[emit].adcId) : undefined;
        if (decoded.adc && adcEntry) {
            const start = blockStart + adcEntry.delay * 1e-6;
            const end = start + adcEntry.numSamples * adcEntry.dwell * 1e-9;
            const ordinal = adcIndex++;
            events.push({
                start,
                end,
                build: () => buildAdcSegment(seq, ctx, readers, adcEntry, start, end, emit, ordinal),
            });
        }
        events.sort((a, b) => a.start - b.start);
        for (const event of events) {
            if (event.start < blockStart - EVENT_TIME_TOLERANCE_SEC || event.end > blockEnd + EVENT_TIME_TOLERANCE_SEC) {
                throw new Error(`Block ${emit + 1}: an event extends outside the block.`);
            }
            event.start = Math.max(event.start, blockStart);
            event.end = Math.min(event.end, blockEnd);
        }
        if (events.length === 2 && events[1].start < events[0].end - EVENT_TIME_TOLERANCE_SEC) {
            throw new Error(`Block ${emit + 1}: RF and ADC overlap, which the simulator does not support yet.`);
        }

        let cursor = blockStart;
        for (const event of events) {
            if (event.start > cursor) yield buildFreeSegment(readers, cursor, event.start, emit);
            yield event.build();
            cursor = Math.max(cursor, event.end);
        }
        if (blockEnd > cursor) yield buildFreeSegment(readers, cursor, blockEnd, emit);

        for (const reader of readers) reader.release();
    }
}

// ─── Segment builders ────────────────────────────────────────────────────

type Readers = readonly [AxisWindowReader, AxisWindowReader, AxisWindowReader];

function windowPieces(readers: Readers, t0: number, t1: number): GradientPieces {
    return mergeAxes(
        [readers[0].points(t0, t1), readers[1].points(t0, t1), readers[2].points(t0, t1)],
        t0,
        t1,
    );
}

function buildFreeSegment(readers: Readers, t0: number, t1: number, blockIndex: number): FreeSegment {
    return { kind: 'free', blockIndex, t0, t1, moments: piecesMoments(windowPieces(readers, t0, t1)) };
}

interface RfTiming {
    start: number;
    end: number;
    waveform: RfShapeArrays;
    ptxChannels: number;
}

function rfTiming(seq: PulseqSequence, rf: RFEntry, blockStart: number): RfTiming {
    const raster = seq.rasterTimes.rfRaster;
    const pulseStart = blockStart + rf.delay * 1e-6;
    const waveform = rfShapeArrays(rf, seq)
        ?? { raster, magnitude: Float64Array.of(1), phaseCycles: null, timeShape: null };
    const rawTime = rf.timeShapeId > 0 ? seq.shapes.get(rf.timeShapeId)?.samples : undefined;
    const ptxChannels = rawTime ? detectPtxTimeShapeChannels(rawTime) : 0;
    const first = waveform.timeShape?.length ? waveform.timeShape[0] * raster : 0;
    return {
        start: pulseStart + first,
        end: pulseStart + rfShapeDuration(waveform),
        waveform,
        ptxChannels,
    };
}

function buildRfSegment(
    seq: PulseqSequence,
    ctx: StreamContext,
    readers: Readers,
    decoded: DecodedBlock,
    rf: RFEntry,
    timing: RfTiming,
    blockIndex: number,
): RfSegment {
    const t0 = timing.start;
    const t1 = timing.end;
    const gradient = windowPieces(readers, t0, t1);
    const freqOffset = rf.freqOffset + rf.freqPPM * 1e-6 * ctx.gamma * ctx.b0;
    const phaseOffset = rf.phaseOffset + rf.phasePPM * 1e-6 * ctx.gamma * ctx.b0;
    const shim = decoded.rfShim
        ? { amplitudes: [...decoded.rfShim.amplitudes], phases: [...decoded.rfShim.phases] }
        : null;

    // Key on exact file content: the RF library fields that shape the pulse, and
    // the block's own gradient events and rotation that play under it. Each
    // event is then checked against the stored operator's gradient, because a
    // neighbouring block's edge can still reach into the window; a mismatch
    // gets its own content-derived key instead of silently sharing.
    let key = rfBaseKey(seq, rf, freqOffset, shim, blockIndex);
    let operator = ctx.rfOperators.get(key);
    if (operator && !sameGradient(operator.gradient, gradient, t0)) {
        key = `${key}:${gradientContentHash(gradient, t0)}`;
        operator = ctx.rfOperators.get(key);
    }
    if (!operator) {
        operator = {
            key,
            rf,
            amplitude: rf.amplitude,
            waveform: timing.waveform,
            freqOffset,
            duration: t1 - t0,
            gradient: relativePieces(gradient, t0),
            shim,
            ptxChannels: timing.ptxChannels,
        };
        ctx.rfOperators.set(key, operator);
    }
    if (timing.ptxChannels > 1) ctx.ignoredFeatures.add('dynamic-ptx-rf');

    const centerTime = decoded.rf!.centerTime;
    const kToCenter = new Float64Array(3);
    addPiecesIntegral(gradient, t0, Math.min(Math.max(centerTime, t0), t1), kToCenter);

    return {
        kind: 'rf',
        blockIndex,
        t0,
        t1,
        moments: piecesMoments(gradient),
        key,
        operator,
        phaseOffset,
        use: decoded.rf!.use,
        centerTime,
        kToCenter,
        gradient,
    };
}

function buildAdcSegment(
    seq: PulseqSequence,
    ctx: StreamContext,
    readers: Readers,
    adc: ADCEntry,
    t0: number,
    t1: number,
    blockIndex: number,
    adcIndex: number,
): AdcSegment {
    const gradient = windowPieces(readers, t0, t1);
    let activeAxes = 0;
    for (let i = 0; i < gradient.ga.length; i++) {
        if (gradient.ga[i] !== 0 || gradient.gb[i] !== 0) activeAxes |= 1 << (i % 3);
    }
    const modulation = adc.phaseModShapeId > 0 ? seq.shapes.get(adc.phaseModShapeId)?.samples ?? null : null;
    return {
        kind: 'adc',
        blockIndex,
        t0,
        t1,
        moments: piecesMoments(gradient),
        adcIndex,
        numSamples: adc.numSamples,
        dwell: adc.dwell * 1e-9,
        phaseOffset: adc.phaseOffset + adc.phasePPM * 1e-6 * ctx.gamma * ctx.b0,
        freqOffset: adc.freqOffset + adc.freqPPM * 1e-6 * ctx.gamma * ctx.b0,
        phaseModulation: modulation,
        gradient,
        activeAxes,
    };
}

/** Sample times of an ADC segment [s, absolute]. */
export function adcSampleTimes(segment: AdcSegment): Float64Array {
    const times = new Float64Array(segment.numSamples);
    for (let s = 0; s < segment.numSamples; s++) times[s] = segment.t0 + (s + 0.5) * segment.dwell;
    return times;
}

/**
 * Key from exact file content. Library ids are deliberately absent: RF spoiling
 * gives every phase its own RF entry, and identical gradients may be stored
 * under different ids.
 */
function rfBaseKey(
    seq: PulseqSequence,
    rf: RFEntry,
    freqOffset: number,
    shim: { amplitudes: number[]; phases: number[] } | null,
    blockIndex: number,
): string {
    const hasher = new ContentHasher()
        .number(rf.magShapeId)
        .number(rf.phaseShapeId)
        .number(rf.timeShapeId)
        .number(rf.amplitude)
        .number(rf.delay)
        .number(freqOffset)
        .number(seq.rasterTimes.rfRaster);
    if (shim) hasher.word(1).numbers(shim.amplitudes).numbers(shim.phases);
    else hasher.word(0);
    const block = seq.blocks[blockIndex];
    for (const id of [block.gxId, block.gyId, block.gzId]) {
        const trap = id > 0 ? seq.trapGrads.get(id) : undefined;
        const arb = id > 0 && !trap ? seq.arbitraryGrads.get(id) : undefined;
        if (trap) {
            hasher.word(1).number(trap.amplitude).number(trap.rise).number(trap.flat).number(trap.fall).number(trap.delay);
        } else if (arb) {
            hasher.word(2).number(arb.amplitude).number(arb.shapeId).number(arb.timeId).number(arb.delay)
                .number(arb.first).number(arb.last);
        } else {
            hasher.word(0);
        }
    }
    const rotation = blockRotation(seq, block.extId);
    if (rotation) hasher.word(1).numbers(rotation);
    else hasher.word(0);
    return hasher.digest();
}

/**
 * Whether an event's gradient window (absolute times from `t0`) equals a
 * stored relative one. Both are piecewise linear, so agreement at two interior
 * points of every interval of their merged breakpoints is exact agreement.
 */
function sameGradient(stored: GradientPieces, event: GradientPieces, t0: number): boolean {
    const storedEnd = stored.t[stored.t.length - 1];
    const eventEnd = event.t[event.t.length - 1] - t0;
    if (Math.abs(storedEnd - eventEnd) > KEY_TIME_QUANTUM_SEC) return false;
    const cuts: number[] = [];
    for (let i = 0; i < stored.t.length; i++) cuts.push(stored.t[i]);
    for (let i = 0; i < event.t.length; i++) cuts.push(event.t[i] - t0);
    cuts.sort((a, b) => a - b);
    let peak = 0;
    for (const values of [stored.ga, stored.gb, event.ga, event.gb]) {
        for (let i = 0; i < values.length; i++) peak = Math.max(peak, Math.abs(values[i]));
    }
    const tolerance = 1e-6 + 1e-9 * peak;
    const a = new Float64Array(3), b = new Float64Array(3);
    for (let i = 1; i < cuts.length; i++) {
        const span = cuts[i] - cuts[i - 1];
        if (!(span > KEY_TIME_QUANTUM_SEC)) continue;
        for (const fraction of [1 / 3, 2 / 3]) {
            const time = cuts[i - 1] + fraction * span;
            evaluatePieces(stored, time, a);
            evaluatePieces(event, time + t0, b);
            for (let axis = 0; axis < 3; axis++) {
                if (Math.abs(a[axis] - b[axis]) > tolerance) return false;
            }
        }
    }
    return true;
}

/** Gradient of a piece list at a time strictly inside one of its pieces. */
function evaluatePieces(pieces: GradientPieces, time: number, out: Float64Array): void {
    const n = pieceCount(pieces);
    let lo = 0, hi = n - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (pieces.t[mid] <= time) lo = mid; else hi = mid - 1;
    }
    const h = pieces.t[lo + 1] - pieces.t[lo];
    const fraction = h > 0 ? Math.min(Math.max((time - pieces.t[lo]) / h, 0), 1) : 0;
    for (let axis = 0; axis < 3; axis++) {
        const ga = pieces.ga[3 * lo + axis];
        out[axis] = ga + (pieces.gb[3 * lo + axis] - ga) * fraction;
    }
}

/** Content hash of a gradient window, ignoring degenerate (sub-quantum) pieces. */
function gradientContentHash(gradient: GradientPieces, t0: number): string {
    const hasher = new ContentHasher();
    const n = pieceCount(gradient);
    for (let i = 0; i < n; i++) {
        if (!(gradient.t[i + 1] - gradient.t[i] > KEY_TIME_QUANTUM_SEC)) continue;
        hasher.number(Math.round((gradient.t[i] - t0) / KEY_TIME_QUANTUM_SEC));
        hasher.number(Math.round((gradient.t[i + 1] - t0) / KEY_TIME_QUANTUM_SEC));
        for (let axis = 0; axis < 3; axis++) {
            hasher.number(Math.round(gradient.ga[3 * i + axis] * KEY_GRADIENT_QUANTUM));
            hasher.number(Math.round(gradient.gb[3 * i + axis] * KEY_GRADIENT_QUANTUM));
        }
    }
    return hasher.digest();
}

function blockRotation(seq: PulseqSequence, extId: number): number[] | undefined {
    for (const ext of extensionChain(seq, extId)) {
        if (seq.extensionTypes.get(ext.type) !== ExtType.EXT_ROTATION) continue;
        return seq.rotations.find(rotation => rotation.id === ext.ref)?.values;
    }
    return undefined;
}

function noteIgnoredFeatures(block: DecodedBlock, ignored: Set<IgnoredFeature>): void {
    if (block.triggers?.length) ignored.add('trigger');
    if (block.nco?.length) ignored.add('nco');
}

// ─── Timing ──────────────────────────────────────────────────────────────

function fileB0(seq: PulseqSequence): number | undefined {
    for (const name of ['B0', 'b0', 'b_0']) {
        const value = seq.definitions.get(name);
        if (value?.length && Number.isFinite(value[0])) return +value[0];
    }
    return undefined;
}

/**
 * Block start times from integer raster prefix sums, so long sequences do not
 * accumulate rounding; soft-delayed blocks take their input-driven duration.
 */
function computeBlockStartTimes(seq: PulseqSequence, options: CompileOptions): Float64Array {
    const legacy = seq.versionCombined < VER_PRE_14;
    const tick = legacy ? 1e-6 : seq.rasterTimes.blockDurationRaster;
    const softDelays = options.softDelayInputs ? softDelayDurations(seq, options, tick) : null;
    const starts = new Float64Array(seq.blocks.length + 1);
    let ticks = 0;
    for (let i = 0; i < seq.blocks.length; i++) {
        starts[i] = ticks * tick;
        ticks += softDelays?.get(i) ?? seq.blocks[i].dur;
    }
    starts[seq.blocks.length] = ticks * tick;
    return starts;
}

/** Block index → duration in ticks for blocks whose soft delay has an input. */
function softDelayDurations(seq: PulseqSequence, options: CompileOptions, tick: number): Map<number, number> {
    const inputs = options.softDelayInputs ?? {};
    const round = options.roundSoftDelays ?? true;
    const specs = new Map(seq.softDelays.map(spec => [spec.id, spec]));
    const durations = new Map<number, number>();
    seq.blocks.forEach((block, index) => {
        for (const ext of extensionChain(seq, block.extId)) {
            if (seq.extensionTypes.get(ext.type) !== ExtType.EXT_DELAY) continue;
            const spec = specs.get(ext.ref);
            if (!spec || !Object.prototype.hasOwnProperty.call(inputs, spec.numId)) continue;
            const seconds = inputs[spec.numId] / spec.factor + spec.offset * 1e-6;
            if (!(seconds >= 0)) {
                throw new Error(`Soft delay ${spec.numId} (${spec.hint}) gives a negative block duration.`);
            }
            durations.set(index, round ? Math.round(seconds / tick) : seconds / tick);
        }
    });
    return durations;
}

function* extensionChain(seq: PulseqSequence, extId: number) {
    const visited = new Set<number>();
    let current = extId > 0 ? seq.extensions.get(extId) : undefined;
    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        yield current;
        current = current.nextId > 0 ? seq.extensions.get(current.nextId) : undefined;
    }
}

function programDecodeContext(seq: PulseqSequence, blockStartTimes: Float64Array): SequenceDecodeContext {
    return { ...createSequenceDecodeContext(seq), blockStartTimes };
}

/**
 * For each physical axis and block i, the first block ≥ i that contributes a
 * gradient piece to that axis (blockCount if none). With a rotation, every
 * gradient lands on all three physical axes.
 */
function computeNextPieceBlocks(seq: PulseqSequence): [Int32Array, Int32Array, Int32Array] {
    const n = seq.blocks.length;
    const next: [Int32Array, Int32Array, Int32Array] = [new Int32Array(n + 1), new Int32Array(n + 1), new Int32Array(n + 1)];
    for (let axis = 0; axis < 3; axis++) next[axis][n] = n;
    const exists = (id: number) => id > 0 && (seq.trapGrads.has(id) || seq.arbitraryGrads.has(id));
    for (let i = n - 1; i >= 0; i--) {
        const block = seq.blocks[i];
        const logical = [exists(block.gxId), exists(block.gyId), exists(block.gzId)];
        const rotated = logical.some(Boolean) && hasRotation(seq, block.extId);
        for (let axis = 0; axis < 3; axis++) {
            next[axis][i] = (rotated || logical[axis]) ? i : next[axis][i + 1];
        }
    }
    return next;
}

function hasRotation(seq: PulseqSequence, extId: number): boolean {
    return blockRotation(seq, extId) !== undefined;
}

// ─── Gradient window reader ──────────────────────────────────────────────

/**
 * Reads windows of one axis's assembled series. Windows must be requested in
 * non-decreasing time and only up to the time the series is final through.
 */
class AxisWindowReader {
    private index = 0;   // last emitted point at or before the latest window start

    constructor(private readonly axis: GradientAxisAssembler) { }

    points(ta: number, tb: number): AxisPoints {
        const { times, values } = this.axis;
        const n = times.length;
        const outTimes: number[] = [];
        const outValues: number[] = [];

        if (n === 0) {
            // Nothing emitted yet: either no piece so far (zero) or only a held
            // point, which cannot happen with ≥ 2-point pieces.
            outTimes.push(ta, tb);
            outValues.push(0, 0);
            return { times: outTimes, values: outValues };
        }
        while (this.index + 1 < n && times.get(this.index + 1) <= ta) this.index++;
        if (times.get(this.index) > ta) {
            outTimes.push(ta);
            outValues.push(0);
        }
        let j = this.index;
        for (; j < n; j++) {
            const time = times.get(j);
            outTimes.push(time);
            outValues.push(values.get(j));
            if (time >= tb) break;
        }
        if (j >= n) {
            // Ran past the emitted points; the caller guarantees finality here.
            if (this.axis.hasPending) {
                const heldTime = this.axis.heldTime;
                if (heldTime > outTimes[outTimes.length - 1]) {
                    outTimes.push(heldTime);
                    outValues.push(this.axis.heldValue);
                }
                if (heldTime < tb) {
                    if (this.axis.heldValue !== 0) throw new Error('internal: gradient tail is not final');
                    outTimes.push(tb);
                    outValues.push(0);
                }
            } else if (outTimes[outTimes.length - 1] < tb) {
                outTimes.push(tb);
                outValues.push(0);
            }
        }
        return { times: outTimes, values: outValues };
    }

    /** Drop storage behind the current position. */
    release(): void {
        this.axis.times.releaseBefore(this.index);
        this.axis.values.releaseBefore(this.index);
    }
}
