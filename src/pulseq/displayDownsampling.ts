export interface DisplaySeries {
    time: number[];
    values: number[];
}

/** Receives the samples a reduction keeps, in increasing time order. */
export type DisplaySampleSink = (time: number, value: number) => void;

/**
 * Reduce a time series with ordered first/min/max/last samples per bucket.
 * Unlike uniform stride sampling, narrow extrema remain represented.
 */
export function downsampleM4(
    time: ArrayLike<number>,
    values: ArrayLike<number>,
    maxPoints: number,
): DisplaySeries {
    const outTime: number[] = [];
    const outValues: number[] = [];
    reduceM4(time, values, maxPoints, (t, value) => {
        outTime.push(t);
        outValues.push(value);
    });
    return { time: outTime, values: outValues };
}

/**
 * Stream the same reduction `downsampleM4` performs into `emit`, returning the
 * number of samples kept.  The packed webview transport counts samples with a
 * discarding sink before it allocates the shared buffers and then writes them
 * with a storing sink, so both passes must agree exactly — routing them through
 * one selection rule is what guarantees that.
 */
export function reduceM4(
    time: ArrayLike<number>,
    values: ArrayLike<number>,
    maxPoints: number,
    emit: DisplaySampleSink,
): number {
    return reduceM4Range(time, values, 0, Math.min(time.length, values.length), maxPoints, emit);
}

/**
 * `reduceM4` restricted to the half-open index range `[start, end)`.
 *
 * Viewport detail clips a waveform to the visible interval *before* reducing
 * it, so the point budget is spent on what is on screen instead of on the whole
 * event.  A 48 ms spiral readout reduced whole keeps ~6 points per millisecond;
 * the same budget spent on a visible 0.5 ms keeps every native sample.
 */
export function reduceM4Range(
    time: ArrayLike<number>,
    values: ArrayLike<number>,
    start: number,
    end: number,
    maxPoints: number,
    emit: DisplaySampleSink,
): number {
    const n = Math.max(0, end - start);
    if (n === 0 || maxPoints <= 0) return 0;
    if (n <= maxPoints) {
        for (let index = start; index < end; index++) emit(time[index], values[index]);
        return n;
    }

    const bucketCount = Math.max(1, Math.floor(maxPoints / 4));
    let kept = 0;
    for (let bucket = 0; bucket < bucketCount; bucket++) {
        const bucketStart = start + Math.floor(bucket * n / bucketCount);
        const bucketEnd = Math.max(bucketStart + 1, start + Math.floor((bucket + 1) * n / bucketCount));
        kept += emitBucket(time, values, bucketStart, Math.min(end, bucketEnd), emit);
    }
    return kept;
}

/**
 * Uniform stride reduction, matching the sampling the RF phase pair uses.
 * Time and value arrays of equal length reduce to the same indices, so the
 * transport can store them as one aligned pair.
 */
export function reduceUniform(
    time: ArrayLike<number>,
    values: ArrayLike<number>,
    maxPoints: number,
    emit: DisplaySampleSink,
): number {
    return reduceUniformRange(time, values, 0, Math.min(time.length, values.length), maxPoints, emit);
}

/** `reduceUniform` restricted to the half-open index range `[start, end)`. */
export function reduceUniformRange(
    time: ArrayLike<number>,
    values: ArrayLike<number>,
    start: number,
    end: number,
    maxPoints: number,
    emit: DisplaySampleSink,
): number {
    const n = Math.max(0, end - start);
    if (n === 0 || maxPoints <= 0) return 0;
    if (n <= maxPoints) {
        for (let index = start; index < end; index++) emit(time[index], values[index]);
        return n;
    }
    const step = n / maxPoints;
    for (let index = 0; index < maxPoints; index++) {
        emit(time[start + Math.floor(index * step)], values[start + Math.floor(index * step)]);
    }
    return maxPoints;
}

/**
 * Index range covering `[startSec, endSec]` plus one sample beyond each edge.
 *
 * The extra samples are what let the renderer draw the line segments that
 * cross the viewport boundary; clipping to strictly-inside samples would leave
 * a visible gap at both edges of every detail window.
 */
export function clipIndexRange(
    time: ArrayLike<number>,
    startSec: number,
    endSec: number,
    length: number,
): { start: number; end: number } {
    const n = Math.max(0, Math.min(length, time.length));
    if (n === 0) return { start: 0, end: 0 };
    let lo = 0;
    let hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (time[mid] < startSec) lo = mid + 1;
        else hi = mid;
    }
    const start = Math.max(0, lo - 1);
    lo = start;
    hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (time[mid] <= endSec) lo = mid + 1;
        else hi = mid;
    }
    return { start, end: Math.min(n, lo + 1) };
}

function emitBucket(
    time: ArrayLike<number>,
    values: ArrayLike<number>,
    start: number,
    end: number,
    emit: DisplaySampleSink,
): number {
    let minIndex = start;
    let maxIndex = start;
    for (let index = start + 1; index < end; index++) {
        if (values[index] < values[minIndex]) minIndex = index;
        if (values[index] > values[maxIndex]) maxIndex = index;
    }

    const indices = [start, minIndex, maxIndex, end - 1].sort((a, b) => a - b);
    let previous = -1;
    let kept = 0;
    for (const index of indices) {
        if (index === previous) continue;
        const t = time[index];
        const value = values[index];
        if (Number.isFinite(t) && Number.isFinite(value)) {
            emit(t, value);
            kept++;
        }
        previous = index;
    }
    return kept;
}
