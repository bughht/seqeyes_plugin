export interface BoundedSeries {
    startTime: Float64Array;
    endTime: Float64Array;
    min: Float64Array;
    max: Float64Array;
    first: Float64Array;
    last: Float64Array;
}

interface EnvelopeBucket {
    firstT: number;
    firstV: number;
    minV: number;
    maxV: number;
    lastT: number;
    lastV: number;
}

/**
 * Streaming first/min/max/last reducer with a fixed memory ceiling.
 * Samples are assigned by time, so narrow extrema remain visible even when
 * the source series is too large to materialize at native raster resolution.
 */
export class BoundedSeriesBuilder {
    private readonly buckets: Array<EnvelopeBucket | undefined>;
    private readonly bucketCount: number;
    private readonly span: number;

    constructor(
        private readonly startSec: number,
        private readonly endSec: number,
        maxPoints: number,
    ) {
        this.bucketCount = Math.max(1, Math.floor(Math.max(4, maxPoints) / 4));
        this.buckets = new Array(this.bucketCount);
        this.span = Math.max(0, endSec - startSec);
    }

    add(tSec: number, value: number): void {
        if (!Number.isFinite(tSec) || !Number.isFinite(value)) return;
        const normalized = this.span > 0 ? (tSec - this.startSec) / this.span : 0;
        const index = Math.max(0, Math.min(
            this.bucketCount - 1,
            Math.floor(normalized * this.bucketCount),
        ));
        const bucket = this.buckets[index];
        if (!bucket) {
            this.buckets[index] = {
                firstT: tSec,
                firstV: value,
                minV: value,
                maxV: value,
                lastT: tSec,
                lastV: value,
            };
            return;
        }
        if (value < bucket.minV) {
            bucket.minV = value;
        }
        if (value > bucket.maxV) {
            bucket.maxV = value;
        }
        bucket.lastT = tSec;
        bucket.lastV = value;
    }

    finish(): BoundedSeries {
        const startTime: number[] = [];
        const endTime: number[] = [];
        const min: number[] = [];
        const max: number[] = [];
        const first: number[] = [];
        const last: number[] = [];
        for (const bucket of this.buckets) {
            if (!bucket) continue;
            startTime.push(bucket.firstT);
            endTime.push(bucket.lastT);
            min.push(bucket.minV);
            max.push(bucket.maxV);
            first.push(bucket.firstV);
            last.push(bucket.lastV);
        }
        return {
            startTime: new Float64Array(startTime),
            endTime: new Float64Array(endTime),
            min: new Float64Array(min),
            max: new Float64Array(max),
            first: new Float64Array(first),
            last: new Float64Array(last),
        };
    }
}
