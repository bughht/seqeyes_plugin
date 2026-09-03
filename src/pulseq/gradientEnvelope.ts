/**
 * gradientEnvelope.ts — summarise gradient waveforms as a per-column min/max band.
 *
 * Once a view holds more samples than it has pixels, drawing a polyline through
 * a reduced subset asserts a path the gradient never took: consecutive drawn
 * points are not adjacent in the data, so the straight line between them is
 * invented.  A band is the honest summary at that scale — each column reports
 * the true range the waveform covered while crossing it, so nothing is missed
 * and nothing is fabricated — and it costs one segment per column to draw
 * rather than one per sample.
 *
 * Waveforms are piecewise linear between samples, so a column's extremes lie at
 * its clipped segment ends.  Interpolating at the column boundaries therefore
 * makes the band exact rather than merely close, which is the whole point of
 * computing it from native samples instead of from an already-reduced series.
 */

import type { DecodedBlock, DecodedGradWaveform } from './types';

export type GradientChannel = 'gx' | 'gy' | 'gz';

export const GRADIENT_CHANNELS: readonly GradientChannel[] = ['gx', 'gy', 'gz'];

/** Largest column count a single envelope request may ask for. */
export const MAX_ENVELOPE_COLUMNS = 8192;

export interface ChannelEnvelope {
    /** Per-column minimum; `Infinity` where the column holds no waveform. */
    min: Float32Array;
    /** Per-column maximum; `-Infinity` where the column holds no waveform. */
    max: Float32Array;
    /** True where any gradient sample covered the column. */
    filled: Uint8Array;
}

export interface GradientEnvelope {
    startSec: number;
    endSec: number;
    columns: number;
    channels: Record<GradientChannel, ChannelEnvelope>;
}

function emptyChannel(columns: number): ChannelEnvelope {
    const min = new Float32Array(columns).fill(Infinity);
    const max = new Float32Array(columns).fill(-Infinity);
    return { min, max, filled: new Uint8Array(columns) };
}

/**
 * Accumulate one piecewise-linear waveform into a channel's columns.
 *
 * A segment is linear, so within any column its extremes are the values at the
 * clipped ends — no need to sample it more finely than the column boundaries.
 */
function accumulate(
    channel: ChannelEnvelope,
    grad: DecodedGradWaveform,
    startSec: number,
    endSec: number,
    columns: number,
): void {
    const time = grad.timePoints;
    const values = grad.waveform;
    const n = Math.min(time.length, values.length);
    if (n === 0) return;
    const span = endSec - startSec;
    if (!(span > 0)) return;
    const toColumn = (t: number): number => ((t - startSec) / span) * columns;

    const put = (column: number, value: number): void => {
        if (column < 0 || column >= columns || !Number.isFinite(value)) return;
        if (value < channel.min[column]) channel.min[column] = value;
        if (value > channel.max[column]) channel.max[column] = value;
        channel.filled[column] = 1;
    };

    if (n === 1) {
        put(Math.floor(toColumn(time[0])), values[0]);
        return;
    }

    for (let i = 1; i < n; i++) {
        const t0 = time[i - 1];
        const t1 = time[i];
        if (t1 < startSec || t0 > endSec) continue;
        const c0 = toColumn(t0);
        const c1 = toColumn(t1);
        const lo = Math.max(0, Math.floor(Math.min(c0, c1)));
        const hi = Math.min(columns - 1, Math.floor(Math.max(c0, c1)));
        const dc = c1 - c0;
        const valueAt = (column: number): number => {
            if (dc === 0) return values[i];
            const f = (column - c0) / dc;
            return values[i - 1] + f * (values[i] - values[i - 1]);
        };
        for (let column = lo; column <= hi; column++) {
            // Clip the segment to this column and take both ends.
            const from = Math.max(Math.min(c0, c1), column);
            const to = Math.min(Math.max(c0, c1), column + 1);
            if (to < from) continue;
            put(column, valueAt(from));
            put(column, valueAt(to));
        }
    }
}

/**
 * Build a per-column min/max band for every gradient channel over
 * `[startSec, endSec]`, from the decoded blocks' native samples.
 */
export function computeGradientEnvelope(
    blocks: DecodedBlock[],
    startSec: number,
    endSec: number,
    columns: number,
): GradientEnvelope {
    const width = Math.max(1, Math.min(MAX_ENVELOPE_COLUMNS, Math.floor(columns)));
    const channels = {
        gx: emptyChannel(width),
        gy: emptyChannel(width),
        gz: emptyChannel(width),
    } as Record<GradientChannel, ChannelEnvelope>;

    for (const block of blocks) {
        for (const key of GRADIENT_CHANNELS) {
            const grad = block[key];
            if (!grad || grad.type === 'none') continue;
            accumulate(channels[key], grad, startSec, endSec, width);
        }
    }

    return { startSec, endSec, columns: width, channels };
}

/** Native gradient samples the window covers, for the exact/summary decision. */
export function countGradientSamples(blocks: DecodedBlock[]): number {
    let total = 0;
    for (const block of blocks) {
        for (const key of GRADIENT_CHANNELS) {
            const grad = block[key];
            if (grad && grad.type !== 'none') total += grad.timePoints.length;
        }
    }
    return total;
}
