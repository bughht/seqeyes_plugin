export interface DisplaySeries {
    time: number[];
    values: number[];
}

/**
 * Reduce a time series with ordered first/min/max/last samples per bucket.
 * Unlike uniform stride sampling, narrow extrema remain represented.
 */
export function downsampleM4(
    time: ArrayLike<number>,
    values: ArrayLike<number>,
    maxPoints: number,
): DisplaySeries {
    const n = Math.min(time.length, values.length);
    if (n === 0 || maxPoints <= 0) return { time: [], values: [] };
    if (n <= maxPoints) {
        return {
            time: Array.from({ length: n }, (_, index) => time[index]),
            values: Array.from({ length: n }, (_, index) => values[index]),
        };
    }

    const bucketCount = Math.max(1, Math.floor(maxPoints / 4));
    const outTime: number[] = [];
    const outValues: number[] = [];
    for (let bucket = 0; bucket < bucketCount; bucket++) {
        const start = Math.floor(bucket * n / bucketCount);
        const end = Math.max(start + 1, Math.floor((bucket + 1) * n / bucketCount));
        appendBucket(time, values, start, Math.min(n, end), outTime, outValues);
    }
    return { time: outTime, values: outValues };
}

function appendBucket(
    time: ArrayLike<number>,
    values: ArrayLike<number>,
    start: number,
    end: number,
    outTime: number[],
    outValues: number[],
): void {
    let minIndex = start;
    let maxIndex = start;
    for (let index = start + 1; index < end; index++) {
        if (values[index] < values[minIndex]) minIndex = index;
        if (values[index] > values[maxIndex]) maxIndex = index;
    }

    const indices = [start, minIndex, maxIndex, end - 1].sort((a, b) => a - b);
    let previous = -1;
    for (const index of indices) {
        if (index === previous) continue;
        const t = time[index];
        const value = values[index];
        if (Number.isFinite(t) && Number.isFinite(value)) {
            outTime.push(t);
            outValues.push(value);
        }
        previous = index;
    }
}
