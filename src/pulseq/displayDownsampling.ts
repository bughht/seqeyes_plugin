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
    const n = Math.min(time.length, values.length);
    if (n === 0 || maxPoints <= 0) return 0;
    if (n <= maxPoints) {
        let kept = 0;
        for (let index = 0; index < n; index++) {
            emit(time[index], values[index]);
            kept++;
        }
        return kept;
    }

    const bucketCount = Math.max(1, Math.floor(maxPoints / 4));
    let kept = 0;
    for (let bucket = 0; bucket < bucketCount; bucket++) {
        const start = Math.floor(bucket * n / bucketCount);
        const end = Math.max(start + 1, Math.floor((bucket + 1) * n / bucketCount));
        kept += emitBucket(time, values, start, Math.min(n, end), emit);
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
    const n = Math.min(time.length, values.length);
    if (n === 0 || maxPoints <= 0) return 0;
    if (n <= maxPoints) {
        for (let index = 0; index < n; index++) emit(time[index], values[index]);
        return n;
    }
    const step = n / maxPoints;
    for (let index = 0; index < maxPoints; index++) {
        const source = Math.floor(index * step);
        emit(time[source], values[source]);
    }
    return maxPoints;
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
