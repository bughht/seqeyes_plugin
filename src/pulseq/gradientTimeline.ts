/**
 * gradientTimeline.ts — incremental assembly of the global, piecewise-linear
 * physical gradient waveform, one block at a time.
 *
 * This is the Pulseq-compatible series the k-space calculator integrates, moved
 * out of `kspace.ts` so a streaming consumer (the simulator's program compiler)
 * can share it. The assembly rules are unchanged:
 *   - pieces are the rotated per-block supports from `physicalGradientPiece`;
 *   - across a gap wider than one gradient raster, a nonzero edge ramps to zero
 *     over half a raster (Pulseq's waveform assembly), while an edge of at most
 *     1e-6 Hz/m is snapped to zero instead;
 *   - at a shared boundary the earlier piece wins: points of the next piece at
 *     or before the current last time are dropped;
 *   - the series is padded with zeros just before its first and after its last
 *     support point, so sampling outside it reads zero.
 *
 * The one stateful subtlety is that the gap rule may rewrite the *last* point
 * already appended (snapping a tiny value to zero) when the next piece arrives.
 * The builder therefore holds each axis's last point back as "pending" and only
 * emits it once the next point is known, so emitted points are final and a
 * consumer can stream them. `snapshotCarry()` captures that pending state; a
 * builder restored from it continues exactly as the original would, which is
 * how a consumer resumes mid-sequence (for example from a simulation
 * checkpoint) without replaying earlier blocks.
 */

import type { DecodedBlock } from './types';
import { physicalGradientPiece } from './physicalGradients';

/** Offset of the zero padding placed just outside a series' support [s]. */
export const SERIES_PADDING_EPSILON_SEC = 1e-12;

/** Gap edges at or below this magnitude snap to zero instead of ramping [Hz/m]. */
const GAP_EDGE_SNAP_HZ_PER_M = 1e-6;

const CHUNK_BITS = 16;
const CHUNK_SIZE = 1 << CHUNK_BITS;
const CHUNK_MASK = CHUNK_SIZE - 1;

/**
 * Append-only Float64 storage in fixed-size chunks.
 *
 * A push-grown `number[]` keeps whatever capacity it doubled into, and one big
 * typed array would have to be reallocated as it grows; fixed chunks avoid both,
 * and let a streaming reader drop chunks it has finished with.
 */
export class Float64Chunks {
    private readonly chunks: (Float64Array | null)[] = [];
    private count = 0;

    get length(): number {
        return this.count;
    }

    push(value: number): void {
        const chunkIndex = this.count >>> CHUNK_BITS;
        let chunk = this.chunks[chunkIndex];
        if (!chunk) {
            chunk = new Float64Array(CHUNK_SIZE);
            this.chunks[chunkIndex] = chunk;
        }
        chunk[this.count & CHUNK_MASK] = value;
        this.count++;
    }

    /** Value at an absolute index; throws if that chunk was released. */
    get(index: number): number {
        if (index < 0 || index >= this.count) throw new RangeError(`index ${index} out of range [0, ${this.count})`);
        const chunk = this.chunks[index >>> CHUNK_BITS];
        if (!chunk) throw new RangeError(`index ${index} was released`);
        return chunk[index & CHUNK_MASK];
    }

    /** Release every chunk that lies entirely before `index`. */
    releaseBefore(index: number): void {
        const lastReleasable = Math.min(index, this.count) >>> CHUNK_BITS;
        for (let i = 0; i < lastReleasable; i++) this.chunks[i] = null;
    }

    /** Exact-size copy of every value (none may have been released). */
    toArray(): Float64Array {
        const out = new Float64Array(this.count);
        for (let i = 0, offset = 0; offset < this.count; i++, offset += CHUNK_SIZE) {
            const chunk = this.chunks[i];
            if (!chunk) throw new RangeError('cannot copy a series whose chunks were released');
            const n = Math.min(CHUNK_SIZE, this.count - offset);
            out.set(n === CHUNK_SIZE ? chunk : chunk.subarray(0, n), offset);
        }
        return out;
    }

    clear(): void {
        this.chunks.length = 0;
        this.count = 0;
    }
}

/** The assembled global series of one axis, in exact-size typed arrays. */
export interface FrozenGradientSeries {
    times: Float64Array;
    values: Float64Array;
    /** Support points the `endpoints` k-space grid must include (unordered). */
    requiredSupport: Float64Array;
}

/** Per-axis state a restored builder needs to continue exactly. */
export interface GradientAxisCarry {
    /** A piece has been appended, so leading padding is already emitted. */
    started: boolean;
    pendingTime: number;
    pendingValue: number;
}

export interface GradientTimelineCarry {
    gradientRaster: number;
    axes: [GradientAxisCarry, GradientAxisCarry, GradientAxisCarry];
}

/** One physical axis of the assembled series. */
export class GradientAxisAssembler {
    readonly times = new Float64Chunks();
    readonly values = new Float64Chunks();
    readonly requiredSupport = new Float64Chunks();

    private started = false;
    private pendingTime = 0;
    private pendingValue = 0;
    private finished = false;

    /**
     * @param collectSupport  Record the support points the k-space `endpoints`
     *   grid needs. Streaming consumers pass false: the list would otherwise
     *   grow with the whole sequence.
     */
    constructor(
        private readonly gradientRaster: number,
        carry?: GradientAxisCarry,
        private readonly collectSupport = true,
    ) {
        if (carry?.started) {
            this.started = true;
            this.pendingTime = carry.pendingTime;
            this.pendingValue = carry.pendingValue;
        }
    }

    /** Whether any piece has been appended to this axis. */
    get hasSupport(): boolean {
        return this.started;
    }

    /** True while the last appended point is still held back (not yet final). */
    get hasPending(): boolean {
        return this.started && !this.finished;
    }

    get heldTime(): number {
        return this.pendingTime;
    }

    get heldValue(): number {
        return this.pendingValue;
    }

    /**
     * Latest time through which the waveform of this axis can no longer change,
     * given that no piece still to be appended can start before `nextPieceTime`
     * (+∞ when no further piece will arrive on this axis).
     *
     * Emitted points are final. The held-back point is final unless it is a tiny
     * nonzero value the gap rule may still snap to zero. Past it, a nonzero
     * value's continuation depends on the next piece (continuation, ramp or
     * padding), while a zero value stays zero until within one raster of the
     * next piece.
     */
    finalThrough(nextPieceTime: number): number {
        if (this.finished) return Number.POSITIVE_INFINITY;
        if (!this.started) return nextPieceTime - this.gradientRaster;
        if (this.pendingValue !== 0) {
            if (Math.abs(this.pendingValue) <= GAP_EDGE_SNAP_HZ_PER_M) {
                return this.times.length ? this.times.get(this.times.length - 1) : Number.NEGATIVE_INFINITY;
            }
            return this.pendingTime;
        }
        return Math.max(this.pendingTime, nextPieceTime - this.gradientRaster);
    }

    carry(): GradientAxisCarry {
        return { started: this.started, pendingTime: this.pendingTime, pendingValue: this.pendingValue };
    }

    /** Append one block's piece of this axis (times ascending, absolute [s]). */
    appendPiece(times: ArrayLike<number>, values: ArrayLike<number>): void {
        if (this.finished) throw new Error('cannot append to a finished gradient series');
        const n = times.length;
        if (!n) return;
        const firstTime = times[0];
        this.support(firstTime);
        this.support(times[n - 1]);

        if (!this.started) {
            // The first piece is taken whole; the zero padding in front of it is
            // what lets sampling before the first support point read zero.
            if (firstTime > 0) {
                this.pushPoint(-SERIES_PADDING_EPSILON_SEC, 0);
                this.pushPoint(firstTime - SERIES_PADDING_EPSILON_SEC, 0);
                this.support(-SERIES_PADDING_EPSILON_SEC);
                this.support(firstTime - SERIES_PADDING_EPSILON_SEC);
            }
            for (let i = 0; i < n; i++) this.pushPoint(times[i], values[i]);
            return;
        }

        const raster = this.gradientRaster;
        const previousTime = this.pendingTime;
        let firstValue = values[0];
        if (previousTime + raster < firstTime) {
            if (this.pendingValue !== 0) {
                if (Math.abs(this.pendingValue) > GAP_EDGE_SNAP_HZ_PER_M) {
                    this.pushPoint(previousTime + raster * 0.5, 0);
                    this.support(previousTime + raster * 0.5);
                } else {
                    this.pendingValue = 0;
                }
            }
            if (firstValue !== 0) {
                if (Math.abs(firstValue) > GAP_EDGE_SNAP_HZ_PER_M) {
                    this.pushPoint(firstTime - raster * 0.5, 0);
                    this.support(firstTime - raster * 0.5);
                } else {
                    firstValue = 0;
                }
            }
        }

        const currentLast = this.pendingTime;
        let start = 0;
        while (start < n && times[start] <= currentLast) start++;
        for (let i = start; i < n; i++) this.pushPoint(times[i], i === 0 ? firstValue : values[i]);
    }

    /** Emit the held-back point and the trailing zero padding. */
    finish(totalDuration: number): void {
        if (this.finished) return;
        this.finished = true;
        if (!this.started) return;
        const last = this.pendingTime;
        this.emit(this.pendingTime, this.pendingValue);
        if (last < totalDuration) {
            this.emit(last + SERIES_PADDING_EPSILON_SEC, 0);
            this.emit(totalDuration + SERIES_PADDING_EPSILON_SEC, 0);
            this.support(last + SERIES_PADDING_EPSILON_SEC);
            this.support(totalDuration + SERIES_PADDING_EPSILON_SEC);
        }
    }

    /** Copy out the finished series and drop the chunked storage. */
    freeze(): FrozenGradientSeries {
        if (!this.finished) throw new Error('finish() the series before freezing it');
        const frozen = {
            times: this.times.toArray(),
            values: this.values.toArray(),
            requiredSupport: this.requiredSupport.toArray(),
        };
        this.times.clear();
        this.values.clear();
        this.requiredSupport.clear();
        return frozen;
    }

    private support(time: number): void {
        if (this.collectSupport) this.requiredSupport.push(time);
    }

    private pushPoint(time: number, value: number): void {
        if (this.started) this.emit(this.pendingTime, this.pendingValue);
        this.started = true;
        this.pendingTime = time;
        this.pendingValue = value;
    }

    private emit(time: number, value: number): void {
        this.times.push(time);
        this.values.push(value);
    }
}

/** Assembles the three physical gradient axes block by block. */
export class GradientTimelineBuilder {
    readonly axes: [GradientAxisAssembler, GradientAxisAssembler, GradientAxisAssembler];

    constructor(readonly gradientRaster: number, carry?: GradientTimelineCarry, collectSupport = true) {
        if (!(gradientRaster > 0)) throw new Error('gradientRaster must be positive');
        if (carry && carry.gradientRaster !== gradientRaster) {
            throw new Error('carry was captured with a different gradient raster');
        }
        this.axes = [
            new GradientAxisAssembler(gradientRaster, carry?.axes[0], collectSupport),
            new GradientAxisAssembler(gradientRaster, carry?.axes[1], collectSupport),
            new GradientAxisAssembler(gradientRaster, carry?.axes[2], collectSupport),
        ];
    }

    /** Append the next block (blocks must arrive in time order). */
    append(block: DecodedBlock): void {
        for (let axis = 0; axis < 3; axis++) {
            const piece = physicalGradientPiece(block, axis);
            if (piece.times.length) this.axes[axis].appendPiece(piece.times, piece.values);
        }
    }

    /** State at the current block boundary; restore with the constructor. */
    snapshotCarry(): GradientTimelineCarry {
        return {
            gradientRaster: this.gradientRaster,
            axes: [this.axes[0].carry(), this.axes[1].carry(), this.axes[2].carry()],
        };
    }

    finish(totalDuration: number): void {
        for (const axis of this.axes) axis.finish(totalDuration);
    }

    /**
     * Latest time through which all three axes are final, given per axis the
     * earliest time a not-yet-appended piece can start (see the axis method).
     */
    finalThrough(nextPieceTimes: ArrayLike<number>): number {
        return Math.min(
            this.axes[0].finalThrough(nextPieceTimes[0]),
            this.axes[1].finalThrough(nextPieceTimes[1]),
            this.axes[2].finalThrough(nextPieceTimes[2]),
        );
    }
}

/**
 * Build the whole-sequence series of all three physical axes. One axis is
 * copied out at a time, so only one axis is ever held twice.
 */
export function buildFrozenGradientSeries(
    blocks: DecodedBlock[],
    gradientRaster: number,
    totalDuration: number,
): [FrozenGradientSeries, FrozenGradientSeries, FrozenGradientSeries] {
    const builder = new GradientTimelineBuilder(gradientRaster);
    for (const block of blocks) builder.append(block);
    builder.finish(totalDuration);
    return [builder.axes[0].freeze(), builder.axes[1].freeze(), builder.axes[2].freeze()];
}

/**
 * Linear interpolation of a frozen series with a forward cursor; zero outside
 * its support. `cursors[axis]` carries the position between calls, so a caller
 * walking forward in time pays O(1) amortised per sample.
 */
export function sampleSeries(
    series: FrozenGradientSeries,
    time: number,
    cursors: number[],
    axis: number,
): number {
    const n = series.times.length;
    if (!n || time < series.times[0] || time > series.times[n - 1]) return 0;
    let cursor = Math.min(cursors[axis], n - 2);
    while (cursor + 1 < n && series.times[cursor + 1] < time) cursor++;
    cursors[axis] = cursor;
    if (cursor + 1 >= n) return series.values[n - 1];
    const t0 = series.times[cursor], t1 = series.times[cursor + 1];
    const v0 = series.values[cursor], v1 = series.values[cursor + 1];
    if (time <= t0 || t1 <= t0) return v0;
    if (time >= t1) return v1;
    return v0 + (v1 - v0) * (time - t0) / (t1 - t0);
}
