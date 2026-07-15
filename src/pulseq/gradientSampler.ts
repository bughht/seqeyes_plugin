import type { DecodedBlock, DecodedGradWaveform } from './types';

const TIME_EPS = 1e-15;

interface GradientEventRef {
    gradient: DecodedGradWaveform;
    first: number;
    last: number;
}

export interface GradientTimeRange {
    first: number;
    last: number;
}

export function decodedGradientTimeRange(blocks: DecodedBlock[]): GradientTimeRange | undefined {
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const block of blocks) {
        for (const gradient of [block.gx, block.gy, block.gz]) {
            if (!gradient?.timePoints.length) continue;
            const gradientFirst = gradient.timePoints[0];
            const gradientLast = gradient.timePoints[gradient.timePoints.length - 1];
            if (Number.isFinite(gradientFirst)) first = Math.min(first, gradientFirst);
            if (Number.isFinite(gradientLast)) last = Math.max(last, gradientLast);
        }
    }
    return Number.isFinite(first) && Number.isFinite(last) && last >= first
        ? { first, last }
        : undefined;
}

/** Sequential sampler over decoded gradient arrays without flattening them. */
export function createDecodedGradientSampler(
    blocks: DecodedBlock[],
    channel: 'gx' | 'gy' | 'gz',
): (timeSec: number) => number {
    const events: GradientEventRef[] = [];
    for (const block of blocks) {
        const gradient = block[channel];
        if (!gradient?.timePoints.length || !gradient.waveform.length) continue;
        const n = Math.min(gradient.timePoints.length, gradient.waveform.length);
        if (n < 1) continue;
        events.push({
            gradient,
            first: gradient.timePoints[0],
            last: gradient.timePoints[n - 1],
        });
    }
    events.sort((a, b) => a.first - b.first);

    let eventIndex = 0;
    let pointIndex = 0;
    let previousTime = Number.NEGATIVE_INFINITY;
    return (timeSec: number): number => {
        if (timeSec < previousTime - TIME_EPS) {
            eventIndex = 0;
            pointIndex = 0;
        }
        previousTime = timeSec;
        while (eventIndex < events.length && events[eventIndex].last < timeSec - TIME_EPS) {
            eventIndex++;
            pointIndex = 0;
        }
        if (eventIndex >= events.length) return 0;
        const event = events[eventIndex];
        if (timeSec < event.first - TIME_EPS || timeSec > event.last + TIME_EPS) return 0;
        const times = event.gradient.timePoints;
        const values = event.gradient.waveform;
        const n = Math.min(times.length, values.length);
        if (Math.abs(timeSec - event.last) <= TIME_EPS && eventIndex + 1 < events.length) {
            const next = events[eventIndex + 1];
            if (Math.abs(next.first - timeSec) <= TIME_EPS && next.gradient.waveform.length) {
                return 0.5 * (values[n - 1] + next.gradient.waveform[0]);
            }
        }
        while (pointIndex + 1 < n && times[pointIndex + 1] <= timeSec + TIME_EPS) pointIndex++;
        if (pointIndex >= n - 1 || timeSec <= times[pointIndex] + TIME_EPS) return values[pointIndex];
        const t0 = times[pointIndex];
        const t1 = times[pointIndex + 1];
        if (!(t1 > t0)) return values[pointIndex];
        const alpha = (timeSec - t0) / (t1 - t0);
        return values[pointIndex] + alpha * (values[pointIndex + 1] - values[pointIndex]);
    };
}
