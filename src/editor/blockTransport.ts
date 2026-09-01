/**
 * blockTransport.ts — pack decoded blocks for transfer to the webview.
 *
 * The standalone web app hands its serialised blocks straight to the renderer,
 * so each display sample costs one number in one heap.  The extension has to
 * cross a process boundary, and VS Code serialises webview messages with
 * `JSON.stringify`: every sample becomes ~19 characters of text, the extension
 * host and the renderer each hold that string alongside the object graph, and
 * V8 refuses to build a string larger than 512 MiB at all.  Dense arbitrary
 * waveforms reach ~18 KB of JSON per block, so a sequence of a few tens of
 * thousands of such blocks cannot be delivered as JSON no matter how much
 * memory the machine has.
 *
 * The samples therefore travel as two shared binary buffers.  VS Code lifts
 * `ArrayBuffer`s out of a webview message and transfers them as raw binary
 * (extensions declaring `engines.vscode` >= 1.57, as this one does), keeping
 * them out of the JSON entirely; the envelope carries per-block scalars plus an
 * offset/count pair per waveform.  Times stay Float64 because a 1 µs raster
 * late in a long sequence needs more than Float32's ~7 significant digits;
 * amplitudes are Float32, the precision the k-space ADC transfer already ships.
 */

import { INTERACTIVE_COMPUTE_LIMITS } from '../pulseq/computeBudget';
import { createSequenceDecodeContext, decodeBlockRange } from '../pulseq/decoder';
import { reduceM4, reduceUniform } from '../pulseq/displayDownsampling';
import type { DecodedBlock, DecodedGradWaveform, DecodedRFWaveform, PulseqSequence } from '../pulseq/types';

/** Display samples kept per waveform when the sequence fits the budget. */
export const MAX_DISPLAY_PTS = 500;

/**
 * Floor for the reduced cap.  Matches the smallest per-curve budget the
 * renderer itself will draw, so reducing further would buy memory without
 * buying any additional fidelity on screen.
 */
export const MIN_DISPLAY_PTS = 8;

/** A detail request may use at most this many aligned time/value pairs. */
export const WINDOW_DETAIL_SAMPLE_LIMIT = 2_000_000;

const TAU = 2 * Math.PI;

export interface PackedBlocks {
    /** Per-block scalars plus offset/count references into the shared buffers. */
    blocks: object[];
    /** Float64 time samples, indexed by the envelope's offsets. */
    sampleTimes: ArrayBuffer;
    /** Float32 amplitude samples, aligned one-to-one with `sampleTimes`. */
    sampleValues: ArrayBuffer;
    sampleCount: number;
    /** Cap actually applied — below `MAX_DISPLAY_PTS` when the budget bit. */
    pointsPerWaveform: number;
    /** Set when detail was reduced, for display alongside other load notices. */
    notice: string | null;
}

/** One waveform's span inside the shared buffers. */
interface PairRef {
    o: number;
    n: number;
}

const EMPTY_PAIR: PairRef = { o: 0, n: 0 };

/**
 * Collects the waveform pairs of a block.  Counting and writing share one
 * implementation of the walk so the two passes can never disagree about which
 * waveforms exist or how many samples each keeps.
 */
interface PairSink {
    /** False while counting, so the throwaway envelope is not built. */
    readonly buildEnvelope: boolean;
    pair(
        time: ArrayLike<number>,
        values: ArrayLike<number>,
        useM4: boolean,
        wrapPhase: boolean,
    ): PairRef;
}

class CountingSink implements PairSink {
    readonly buildEnvelope = false;
    total = 0;

    constructor(private readonly cap: number) { }

    pair(time: ArrayLike<number>, values: ArrayLike<number>, useM4: boolean): PairRef {
        this.total += useM4
            ? reduceM4(time, values, this.cap, discard)
            : reduceUniform(time, values, this.cap, discard);
        return EMPTY_PAIR;
    }
}

class WritingSink implements PairSink {
    readonly buildEnvelope = true;
    private cursor = 0;
    private wrapPhase = false;

    /** Hoisted so the hot path allocates one closure, not one per waveform. */
    private readonly emit = (time: number, value: number): void => {
        this.times[this.cursor] = time;
        this.values[this.cursor] = this.wrapPhase ? ((value % TAU) + TAU) % TAU : value;
        this.cursor++;
    };

    constructor(
        private readonly cap: number,
        private readonly times: Float64Array,
        private readonly values: Float32Array,
    ) { }

    get written(): number {
        return this.cursor;
    }

    pair(
        time: ArrayLike<number>,
        values: ArrayLike<number>,
        useM4: boolean,
        wrapPhase: boolean,
    ): PairRef {
        const start = this.cursor;
        this.wrapPhase = wrapPhase;
        if (useM4) reduceM4(time, values, this.cap, this.emit);
        else reduceUniform(time, values, this.cap, this.emit);
        this.wrapPhase = false;
        return { o: start, n: this.cursor - start };
    }
}

function discard(): void {
    // Counting only needs reduceM4/reduceUniform's return value.
}

/**
 * Pack every block's display waveforms into shared buffers plus a JSON-safe
 * envelope.  Per-waveform detail is reduced uniformly if the sequence would
 * otherwise exceed `displayTransportSamples`.
 */
export function packBlocks(blocks: DecodedBlock[]): PackedBlocks {
    const budget = INTERACTIVE_COMPUTE_LIMITS.displayTransportSamples;
    let cap = MAX_DISPLAY_PTS;
    let total = countSamples(blocks, cap);

    // Sample count falls roughly linearly with the cap for the waveforms that
    // are actually being reduced, so scaling by the overshoot converges in a
    // couple of passes; the `cap - 1` floor keeps it strictly decreasing.
    for (let attempt = 0; attempt < 8 && total > budget && cap > MIN_DISPLAY_PTS; attempt++) {
        const scaled = Math.floor(cap * (budget / total));
        cap = Math.max(MIN_DISPLAY_PTS, Math.min(cap - 1, scaled));
        total = countSamples(blocks, cap);
    }

    return packBlocksAtCap(blocks, cap, total);
}

/**
 * Decode and pack bounded batches without retaining every full-resolution
 * waveform. The fixed cap is chosen from the parsed event references, so the
 * destination allocation has a deterministic upper bound before decoding.
 */
export function packSequenceBlocks(seq: PulseqSequence, batchSize = 512): PackedBlocks {
    const budget = INTERACTIVE_COMPUTE_LIMITS.displayTransportSamples;
    const seriesCount = countSequenceWaveformSeries(seq);
    const cap = seriesCount > 0
        ? Math.max(MIN_DISPLAY_PTS, Math.min(MAX_DISPLAY_PTS, Math.floor(budget / seriesCount)))
        : MAX_DISPLAY_PTS;
    const capacity = seriesCount * cap;
    const times = new Float64Array(capacity);
    const values = new Float32Array(capacity);
    const envelope = new Array<object>(seq.blocks.length);
    const context = createSequenceDecodeContext(seq);
    let cursor = 0;

    for (let start = 0; start < seq.blocks.length; start += batchSize) {
        const end = Math.min(seq.blocks.length, start + batchSize);
        const decoded = decodeBlockRange(seq, start, end, context);
        const packed = packBlocksAtCap(decoded, cap);
        if (cursor + packed.sampleCount > capacity) {
            throw new Error('The display transport exceeded its structural sample bound.');
        }
        times.set(new Float64Array(packed.sampleTimes), cursor);
        values.set(new Float32Array(packed.sampleValues), cursor);
        for (let index = 0; index < packed.blocks.length; index++) {
            const block = packed.blocks[index] as Record<string, unknown>;
            shiftBlockOffsets(block, cursor);
            envelope[start + index] = block;
        }
        cursor += packed.sampleCount;
    }

    return {
        blocks: envelope,
        sampleTimes: times.buffer.slice(0, cursor * Float64Array.BYTES_PER_ELEMENT),
        sampleValues: values.buffer.slice(0, cursor * Float32Array.BYTES_PER_ELEMENT),
        sampleCount: cursor,
        pointsPerWaveform: cap,
        notice: cap < MAX_DISPLAY_PTS
            ? `Large sequence: waveform detail was reduced to ${cap} points per event `
              + `(normally ${MAX_DISPLAY_PTS}) to stay inside the display transfer budget.`
            : null,
    };
}

/**
 * Decode and pack one indexed block range for viewport detail.
 *
 * The caller resolves the time window through `SequenceDecodeContext`; this
 * function enforces a separate sample ceiling so a fit-all request cannot
 * accidentally recreate the initial all-sequence payload.
 */
export function packSequenceBlockRange(
    seq: PulseqSequence,
    startBlock: number,
    endBlock: number,
    context = createSequenceDecodeContext(seq),
    requestedCap = MAX_DISPLAY_PTS,
    sampleLimit = WINDOW_DETAIL_SAMPLE_LIMIT,
): PackedBlocks {
    const start = Math.max(0, Math.min(seq.blocks.length, Math.floor(startBlock)));
    const end = Math.max(start, Math.min(seq.blocks.length, Math.ceil(endBlock)));
    const seriesCount = countSequenceWaveformSeriesRange(seq, start, end);
    const safeSampleLimit = Number.isFinite(sampleLimit) && sampleLimit >= 0
        ? Math.floor(sampleLimit)
        : WINDOW_DETAIL_SAMPLE_LIMIT;
    const safeRequestedCap = Number.isFinite(requestedCap) && requestedCap > 0
        ? Math.floor(requestedCap)
        : MAX_DISPLAY_PTS;
    if (seriesCount * MIN_DISPLAY_PTS > safeSampleLimit) {
        throw new Error(
            `The waveform detail window needs at least ${seriesCount * MIN_DISPLAY_PTS} samples; zoom in further.`,
        );
    }
    const cap = seriesCount > 0
        ? Math.max(
            MIN_DISPLAY_PTS,
            Math.min(MAX_DISPLAY_PTS, safeRequestedCap, Math.floor(safeSampleLimit / seriesCount)),
        )
        : MAX_DISPLAY_PTS;
    const decoded = decodeBlockRange(seq, start, end, context);
    return packBlocksAtCap(decoded, cap);
}

function packBlocksAtCap(blocks: DecodedBlock[], cap: number, knownTotal?: number): PackedBlocks {
    const total = knownTotal ?? countSamples(blocks, cap);
    const times = new Float64Array(total);
    const values = new Float32Array(total);
    const sink = new WritingSink(cap, times, values);
    const envelope = new Array<object>(blocks.length);
    for (let index = 0; index < blocks.length; index++) {
        envelope[index] = walkBlock(blocks[index], sink) as object;
    }

    if (sink.written !== total) {
        // Offsets in the envelope would no longer describe the buffers, which
        // would draw silently wrong waveforms — fail loudly instead.
        throw new Error(
            `Display transport packed ${sink.written} samples but reserved ${total}.`,
        );
    }

    return {
        blocks: envelope,
        sampleTimes: times.buffer,
        sampleValues: values.buffer,
        sampleCount: total,
        pointsPerWaveform: cap,
        notice: cap < MAX_DISPLAY_PTS
            ? `Large sequence: waveform detail was reduced to ${cap} points per event `
              + `(normally ${MAX_DISPLAY_PTS}) to stay inside the display transfer budget.`
            : null,
    };
}

function countSequenceWaveformSeries(seq: PulseqSequence): number {
    return countSequenceWaveformSeriesRange(seq, 0, seq.blocks.length);
}

function countSequenceWaveformSeriesRange(seq: PulseqSequence, start: number, end: number): number {
    let count = 0;
    for (let index = start; index < end; index++) {
        const block = seq.blocks[index];
        if (block.rfId > 0 && seq.rfs.has(block.rfId)) count += 2;
        for (const id of [block.gxId, block.gyId, block.gzId]) {
            if (id > 0 && (seq.trapGrads.has(id) || seq.arbitraryGrads.has(id))) count++;
        }
    }
    return count;
}

function shiftBlockOffsets(block: Record<string, unknown>, delta: number): void {
    const rf = block.rf as Record<string, number> | undefined;
    if (rf) {
        rf.o += delta;
        rf.qo += delta;
    }
    for (const key of ['gx', 'gy', 'gz'] as const) {
        const gradient = block[key] as Record<string, number> | undefined;
        if (gradient) gradient.o += delta;
    }
}

function countSamples(blocks: DecodedBlock[], cap: number): number {
    const sink = new CountingSink(cap);
    for (const block of blocks) walkBlock(block, sink);
    return sink.total;
}

/**
 * Visit a block's waveforms in a fixed order and, when the sink is writing,
 * build its envelope entry.  Field names match what the standalone web app's
 * `serializeBlocks` produces, so the shared renderer sees one block shape.
 */
function walkBlock(block: DecodedBlock, sink: PairSink): Record<string, unknown> | null {
    const out: Record<string, unknown> | null = sink.buildEnvelope
        ? { i: block.index, s: block.startTime, d: block.duration }
        : null;

    if (block.rf) {
        const magnitude = sink.pair(block.rf.timePoints, block.rf.magnitude, true, false);
        const phase = sink.pair(block.rf.timePoints, block.rf.phase, false, true);
        if (out) out.rf = packRf(block.rf, magnitude, phase);
    }
    if (block.gx && block.gx.type !== 'none') {
        const ref = sink.pair(block.gx.timePoints, block.gx.waveform, true, false);
        if (out) out.gx = packGrad(block.gx, ref);
    }
    if (block.gy && block.gy.type !== 'none') {
        const ref = sink.pair(block.gy.timePoints, block.gy.waveform, true, false);
        if (out) out.gy = packGrad(block.gy, ref);
    }
    if (block.gz && block.gz.type !== 'none') {
        const ref = sink.pair(block.gz.timePoints, block.gz.waveform, true, false);
        if (out) out.gz = packGrad(block.gz, ref);
    }

    if (out && block.adc) {
        out.adc = {
            s: block.adc.startTime, n: block.adc.numSamples,
            dw: block.adc.dwell, d: block.adc.delay,
            fo: block.adc.freqOffset, po: block.adc.phaseOffset,
        };
    }
    if (out && block.triggers?.length) {
        out.trg = block.triggers.map(t => ({ s: t.startTime, c: t.channel, d: t.delay, dr: t.duration }));
    }
    return out;
}

function packRf(
    rf: DecodedRFWaveform,
    magnitude: PairRef,
    phase: PairRef,
): Record<string, unknown> {
    const metrics = waveformMagnitudeMetrics(rf.timePoints, rf.magnitude);
    const responseBands = rf.response.bands.map(band => [
        band.frequencyOffsetHz,
        band.spectralAreaDeg,
        band.polarFlipDeg,
        band.mz,
    ]);
    return {
        s: rf.startTime, d: rf.duration,
        // `t`/`m` (magnitude) and `pt`/`p` (phase) buffer spans.
        o: magnitude.o, n: magnitude.n,
        qo: phase.o, qn: phase.n,
        pk: metrics.peak,
        ar: metrics.area,
        bp: metrics.blockPulse,
        a: rf.amplitude,
        a0: rf.response.carrierAreaDeg,
        rb: responseBands,
        rs: rf.response.spectrumAnalyzed ? 1 : 0,
        rl: rf.response.limited ? 1 : 0,
        fo: rf.freqOffset, po: rf.phaseOffset,
        u: rf.use || 'u',   // 'e'=excitation, 'r'=refocusing, 'i'=inversion, 's'=saturation, 'u'=undefined
    };
}

function packGrad(grad: DecodedGradWaveform, ref: PairRef): Record<string, unknown> {
    return {
        s: grad.startTime, d: grad.duration,
        o: ref.o, n: ref.n,
        a: grad.amplitude, ty: grad.type, ch: grad.channel,
    };
}

/** Peak, |area| and flat-top detection, measured on the undecimated pulse. */
function waveformMagnitudeMetrics(
    time: Float64Array | number[],
    values: Float64Array | number[],
): { peak: number; area: number; blockPulse: boolean } {
    const count = Math.min(time.length, values.length);
    let peak = 0;
    let min = Infinity;
    let max = -Infinity;
    let area = 0;
    let finiteCount = 0;
    for (let index = 0; index < count; index++) {
        if (Number.isFinite(values[index])) {
            const magnitude = Math.abs(values[index]);
            peak = Math.max(peak, magnitude);
            min = Math.min(min, magnitude);
            max = Math.max(max, magnitude);
            finiteCount++;
        }
    }
    for (let index = 1; index < count; index++) {
        const delta = time[index] - time[index - 1];
        if (!Number.isFinite(delta) || delta <= 0) continue;
        area += 0.5 * (Math.abs(values[index - 1] || 0) + Math.abs(values[index] || 0)) * delta;
    }
    const tolerance = Math.max(1e-12, peak * 1e-9);
    const blockPulse = finiteCount === count && count >= 2 && peak > 0 && max - min <= tolerance;
    return { peak, area, blockPulse };
}

/**
 * Estimate the envelope's JSON size from a sample of its entries.  The
 * waveforms no longer contribute, but a sequence with millions of blocks can
 * still push the scalar envelope past V8's maximum string length, and a
 * measured refusal is far more useful than the `RangeError` VS Code would
 * raise from inside `postMessage`.
 */
export function estimateEnvelopeJsonBytes(envelope: object[]): number {
    if (envelope.length === 0) return 2;
    const sampleSize = Math.min(envelope.length, 64);
    const step = envelope.length / sampleSize;
    let sampled = 0;
    for (let index = 0; index < sampleSize; index++) {
        sampled += JSON.stringify(envelope[Math.floor(index * step)]).length + 1;
    }
    return Math.round((sampled / sampleSize) * envelope.length) + 2;
}

/** V8 refuses to build a longer string, so `JSON.stringify` throws past this. */
export const MAX_V8_STRING_LENGTH = 536_870_888;
