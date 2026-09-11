/**
 * waveformDetailReply.ts — decide what a viewport detail request is answered with.
 *
 * Extracted from the editor provider so the decision can be exercised without a
 * VS Code host.  The provider had grown two halves of one contract — this side
 * choosing a payload, the webview side reading it — that could only be tested
 * separately, and they drifted: the renderer began sending a column count while
 * this side still read a field that no longer existed, which would have built
 * every band from a single column.  Keeping the decision here lets the webview
 * test answer with exactly what the extension would have sent.
 */

import type { SequenceDecodeContext } from '../pulseq/decoder';
import { decodeBlockRange } from '../pulseq/decoder';
import {
    computeGradientEnvelope,
    MAX_ENVELOPE_COLUMNS,
    packGradientEnvelope,
} from '../pulseq/gradientEnvelope';
import type { PulseqSequence } from '../pulseq/types';
import {
    BAND_DETAIL_SAMPLES,
    countExactDetailSamples,
    EXACT_DETAIL_SAMPLES,
    MAX_DETAIL_PTS,
    packSequenceBlockRange,
    resolveDetailBlockRange,
    type PackedBlocks,
} from './blockTransport';

/**
 * Blocks one *sample* reply may span before it is refused.
 *
 * The ceiling exists because only `kind: 'samples'` carries a per-block
 * envelope, and that envelope crosses the VS Code boundary as JSON under
 * `MAX_V8_STRING_LENGTH`.  A band is `columns * 6` floats whatever the block
 * count, and `unavailable` is nothing at all, so neither is bounded by this —
 * which is why the test belongs inside the samples branch rather than ahead of
 * the regime choice.
 */
export const WINDOW_DETAIL_BLOCK_LIMIT = 20_000;

export interface WaveformDetailRequest {
    startSec: number;
    endSec: number;
    columns: number;
}

export type WaveformDetailReply =
    | { kind: 'samples'; startBlock: number; endBlock: number; startSec: number; endSec: number; packed: PackedBlocks; cacheKey: string }
    | { kind: 'band'; startSec: number; endSec: number; columns: number; values: ArrayBuffer }
    | { kind: 'unavailable'; startSec: number; endSec: number }
    | { kind: 'error'; message: string };

/**
 * Choose between exact samples, a min/max band, and deferring to the overview.
 *
 * `lookup`/`store` let the caller supply its own cache without this module
 * owning one; a band is not cached because it is cheap next to the decode.
 */
export function buildWaveformDetailReply(
    seq: PulseqSequence,
    context: SequenceDecodeContext,
    request: WaveformDetailRequest,
    generation = 0,
    lookup?: (key: string) => PackedBlocks | undefined,
    /** Injectable so the ceiling can be tested; no shipped fixture reaches it. */
    blockLimit = WINDOW_DETAIL_BLOCK_LIMIT,
): WaveformDetailReply {
    const startSec = Number(request.startSec);
    const endSec = Number(request.endSec);
    const { start, end } = resolveDetailBlockRange(
        context.blockStartTimes,
        seq.blocks.length,
        startSec,
        endSec,
    );
    if (!(endSec > startSec)) {
        return { kind: 'error', message: 'This waveform detail window is empty.' };
    }
    const columns = Math.max(1, Math.min(
        MAX_ENVELOPE_COLUMNS,
        Math.floor(Number(request.columns) || 0) || 1,
    ));
    // The window is what makes this detail rather than a second overview, so it
    // belongs in the cache identity.
    const cacheKey = `${generation}:${start}:${end}:${startSec}:${endSec}`;

    const cached = lookup?.(cacheKey);
    if (cached && end - start <= blockLimit) {
        return { kind: 'samples', startBlock: start, endBlock: end, startSec, endSec, packed: cached, cacheKey };
    }

    const decoded = decodeBlockRange(seq, start, end, context);
    const windowSamples = countExactDetailSamples(decoded, { startSec, endSec });
    if (windowSamples > EXACT_DETAIL_SAMPLES) {
        // More samples than can be drawn one segment each. Summarise them into a
        // band rather than reducing and connecting a subset, which would assert a
        // path between samples that are not adjacent. Beyond the decode budget,
        // leave the view to the precomputed hierarchy instead.
        if (windowSamples > BAND_DETAIL_SAMPLES) return { kind: 'unavailable', startSec, endSec };
        const band = packGradientEnvelope(computeGradientEnvelope(decoded, startSec, endSec, columns));
        return { kind: 'band', startSec: band.startSec, endSec: band.endSec, columns: band.columns, values: band.values };
    }

    // Only this reply carries a per-block envelope, so only this reply is
    // bounded by the block count.
    if (end - start > blockLimit) {
        return { kind: 'error', message: 'This waveform detail window is too large. Zoom in further.' };
    }
    const packed = packSequenceBlockRange(
        seq, start, end, context, MAX_DETAIL_PTS, undefined, { startSec, endSec },
    );
    return { kind: 'samples', startBlock: start, endBlock: end, startSec, endSec, packed, cacheKey };
}

/**
 * The message the extension posts for a reply.
 *
 * Built here rather than at the call site so the field names have exactly one
 * definition.  The two sides of this contract have already drifted once, and a
 * webview that silently ignores a renamed field looks identical to one that is
 * working.
 */
export function waveformDetailMessage(
    reply: WaveformDetailReply,
    requestId: number,
    sequenceGeneration: number,
): Record<string, unknown> {
    const envelope = { requestId, sequenceGeneration };
    switch (reply.kind) {
        case 'error':
            return { ...envelope, type: 'waveformDetailError', message: reply.message };
        case 'unavailable':
            return {
                ...envelope, type: 'waveformDetailUnavailable',
                startSec: reply.startSec, endSec: reply.endSec,
            };
        case 'band':
            return {
                ...envelope, type: 'waveformBandData',
                startSec: reply.startSec, endSec: reply.endSec,
                columns: reply.columns, values: reply.values,
            };
        case 'samples':
            return {
                ...envelope, type: 'waveformDetailData',
                startBlock: reply.startBlock, endBlock: reply.endBlock,
                startSec: reply.startSec, endSec: reply.endSec,
                blocks: reply.packed.blocks,
                sampleTimes: reply.packed.sampleTimes,
                sampleValues: reply.packed.sampleValues,
                sampleCount: reply.packed.sampleCount,
                pointsPerWaveform: reply.packed.pointsPerWaveform,
            };
    }
}
