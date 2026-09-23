/**
 * kspace.ts — K-space trajectory calculator.
 *
 * Based on: xingwangyong/SeqEyes (C++)  src/KSpaceTrajectory.cpp
 *           pulseq/matlab/+mr/@Sequence/Sequence.m::calculateKspacePP()
 *
 * Key design:
 *   1. Pulseq-compatible global gradient series from decoded block waveforms.
 *   2. Non-uniform time grid from gradient breakpoints + RF + ADC times.
 *   3. Midpoint-exact integration on the non-uniform piecewise-linear grid.
 *   4. Numerically stable RF-local trajectory state:
 *        Excitation  -> k = 0
 *        Refocusing  -> k = -k
 *   5. NaN marker BEFORE excitation index (clean plot break).
 *   6. No 2pi factor - k-space in Hz/m (matching Pulseq convention).
 */

import type { DecodedBlock } from './types';
import { physicalGradientPiece, type GradientSeries } from './physicalGradients';

/** ADC trajectory storage; Float32 for display, Float64 for export. */
export type AdcSamples = Float64Array | Float32Array;

export interface KSpaceData {
    /** [kx, ky, kz]  [Hz/m] — decimated when `maxTrajectoryPoints` was given. */
    ktraj: Float64Array[];
    /** Time base aligned with `ktraj`, decimated the same way  [s] */
    t_ktraj: Float64Array;
    /**
     * ADC samples  [Hz/m]. Float32 when the caller asked for it — the viewers
     * draw from Float32 either way, so that is the same value they show today,
     * just without a Float64 stage in front of it.
     */
    ktraj_adc: AdcSamples[];
    t_adc: Float64Array;        // ADC times  [s]
    /** Integration grid length, whatever `ktraj` was decimated to. */
    rasterSampleCount: number;
}

/**
 * Options for k-space trajectory calculation.
 *
 * `maxGridPoints` is an optional hard safety cap — if the integration grid would
 * exceed this many points the function returns null rather than risk an
 * out-of-memory crash.  The uniform raster grid ALWAYS uses the native
 * gradient raster for integration accuracy; the cap only applies as a
 * last-resort safety check. A native-raster lower bound is checked before
 * proportional allocation, and the actual deduplicated grid is checked again.
 */
export interface KSpaceOptions {
    /** Optional hard cap on integration grid size. */
    maxGridPoints?: number;
    /**
     * Keep only this many trajectory samples instead of the whole grid.
     *
     * The integration still visits every grid point; this only decides how many
     * are retained, picking the same indices `downsample` would have. The viewer
     * shows the trajectory as an overview of a few thousand points and discards
     * the rest, so retaining the full raster costs gigabytes to no end — 2.7 GB
     * on a 3D wave sequence. Export leaves this unset and gets every sample.
     */
    maxTrajectoryPoints?: number;
    /**
     * Storage for the ADC trajectory. Defaults to `f64`.
     *
     * `f32` halves it, and both viewers already render from Float32 — the
     * browser converts at GPU upload, the extension at transport — so the
     * values they display are unchanged, and the transport copy disappears
     * because the array is already in the right format. Export leaves this
     * alone and keeps full precision, which is what the numeric baselines
     * compare. ADC *times* stay Float64 regardless: Float32 resolves to only
     * ~30 us at the end of a 500 s sequence, which the window culling needs.
     */
    adcPrecision?: 'f32' | 'f64';
    /** Optional hard cap on ADC sample count. */
    maxAdcSamples?: number;
    /** RF raster time in seconds, used to place reset-adjacent grid points. */
    rfRaster?: number;
    /**
     * Gradient waveform support points to include in the integration grid.
     *
     * `endpoints` keeps the interactive viewer fast by using event/discontinuity
     * bounds plus the native gradient raster. `all` also inserts every waveform
     * support point and is intended for exports and CI baselines.
     */
    gradientSupport?: 'endpoints' | 'all';
}

const TRAJECTORY_TIME_ACCURACY_SEC = 1e-10;
const POLYNOMIAL_SUPPORT_EPSILON_SEC = 1e-12;

export function calculateKspace(
    blocks: DecodedBlock[],
    gradientRaster: number,
    totalDuration: number,
    trajectoryDelay: number = 0,
    _options?: KSpaceOptions,
): KSpaceData | null {
    if (!blocks.length || !gradientRaster || gradientRaster <= 0) return null;

    const GR = gradientRaster;
    const RF = _options?.rfRaster && _options.rfRaster > 0 ? _options.rfRaster : 1e-6;
    const tacc = TRAJECTORY_TIME_ACCURACY_SEC;

    const gradientSupport = _options?.gradientSupport ?? 'endpoints';

    // ---- Pass 1: count total ADC samples & collect RF/ADC events & gradient support points ----
    const excT: number[] = [], refT: number[] = [];
    let totalAdcSamples = 0;
    for (const b of blocks) {
        if (b.adc) totalAdcSamples += b.adc.numSamples;
    }
    if (_options?.maxAdcSamples && totalAdcSamples > _options.maxAdcSamples) return null;
    if (_options?.maxGridPoints && totalDuration > 0) {
        const rasterPointCount = Math.max(2, Math.round(totalDuration / GR) + 1);
        if (rasterPointCount + totalAdcSamples > _options.maxGridPoints) return null;
    }
    // Pre-allocate ADC array to avoid repeated resizing for large sequences
    const adcT = new Float64Array(totalAdcSamples);
    let adcIdx = 0;

    for (const b of blocks) {
        if (b.rf) {
            const iso = Number.isFinite(b.rf.centerTime)
                ? b.rf.centerTime
                : b.rf.startTime + b.rf.duration * 0.5;
            const u = b.rf.use || '';
            if (u === 'e' || u === '' || u === 'u') excT.push(iso);
            else if (u === 'r') refT.push(iso);
        }
        if (b.adc) {
            const t0 = b.adc.startTime + b.adc.delay;
            const dwell = b.adc.dwell;
            const nSamp = b.adc.numSamples;
            for (let s = 0; s < nSamp; s++)
                adcT[adcIdx++] = t0 + (s + 0.5) * dwell + trajectoryDelay;
        }
    }

    // Match Pulseq's waveform assembly before integrating. In particular, keep
    // the support on either side of event gaps instead of asking one block
    // lookup at one deduplicated timestamp to represent both sides.
    const gradientSeries = buildGlobalGradientSeries(blocks, GR, totalDuration);

    // ---- Pass 2: build non-uniform time grid (memory‑safe: sort+dedup array) ----
    // Use a sorted-array dedup instead of Set to avoid V8's ~16.7M Set size limit.
    // Only essential points are included: selected gradient support, RF centres,
    // ADC sample times, block boundaries, and a uniform raster grid.
    // One buffer, sized up front, sorted and deduplicated in place.
    //
    // This used to be a `number[]` grown by push, deduplicated into a second
    // `number[]`, and finally copied into a typed array. Push-grown arrays
    // overshoot: V8 doubles the backing store when it fills and never shrinks
    // it, so 84 M candidates cost 1,894 MB rather than the 675 MB the doubles
    // need, and the deduplicated copy was alive beside it. Those two together
    // were the high-water mark of the whole calculation.
    //
    // Every push site below is counted here. Miscounting would silently drop
    // grid points, because a write past the end of a typed array is ignored, so
    // the refusal below is deliberate: a wrong grid is worse than no answer.
    let candBound = 2;  // the explicit 0 and totalDuration
    for (const series of gradientSeries) candBound += countSeriesSupport(series, gradientSupport);
    candBound += excT.length * 3 + refT.length * 2 + adcT.length;
    // The uniform raster is not among these: it is arithmetic, so it is
    // generated during the walk rather than stored. It is also the larger
    // half — 50.4 M of 84.3 M candidates on a 3D wave sequence.

    const cand = new Float64Array(candBound);
    let candCount = 0;
    let candOverflow = false;
    const pushC = (t: number) => {
        if (!(isFinite(t) && t >= -tacc)) return;
        if (candCount >= cand.length) { candOverflow = true; return; }
        cand[candCount++] = Math.max(0, tacc * Math.round(t/tacc));
    };
    for (const series of gradientSeries) collectSeriesSupport(series, gradientSupport, pushC);
    for (const t of excT) { pushC(t); pushC(t - RF); pushC(t - 2 * RF); }
    for (const t of refT) { pushC(t); pushC(t - RF); }
    for (const t of adcT) pushC(t);
    pushC(0); pushC(totalDuration);
    if (candOverflow) return null;

    // Sort and deduplicate in one pass — O(n log n) but safe for any sequence size
    if (candCount === 0) return null;
    // A typed array sorts numerically without a comparator, and in place.
    cand.subarray(0, candCount).sort();
    // Compacting forward only ever writes at or behind the read cursor, so the
    // predecessor each comparison needs is still the sorted one.
    let kept = 0;
    for (let i = 0; i < candCount; i++) {
        if (i === 0 || cand[i] - cand[i - 1] > tacc * 0.5) cand[kept++] = cand[i];
    }
    const storedCount = kept;

    /*
     * The grid is the stored candidates merged with the generated raster.
     *
     * Every candidate has been quantised to a multiple of `tacc`, so two of
     * them are either the same double or at least `tacc` apart — and the
     * deduplication threshold is `tacc / 2`. That makes deduplication exact
     * duplicate removal, which is why merging the two sorted sources gives the
     * same grid the single sorted array gave: same multiset, same rule.
     *
     * Quantisation is monotonic, so the raster stays ascending through it.
     */
    const rasterSteps = totalDuration > 0 ? Math.max(1, Math.round(totalDuration / GR)) : -1;
    const rasterAt = (i: number): number => Math.max(0, tacc * Math.round((i * GR) / tacc));
    const makeGridWalk = () => {
        let storedIndex = 0;
        let rasterIndex = 0;
        let previous = 0;
        let started = false;
        return (): number => {
            for (;;) {
                const haveStored = storedIndex < storedCount;
                const haveRaster = rasterIndex <= rasterSteps;
                if (!haveStored && !haveRaster) return NaN;
                let value: number;
                if (!haveRaster) {
                    value = cand[storedIndex++];
                } else if (!haveStored) {
                    value = rasterAt(rasterIndex++);
                } else {
                    const stored = cand[storedIndex];
                    const raster = rasterAt(rasterIndex);
                    if (stored <= raster) {
                        value = stored;
                        storedIndex++;
                        if (stored === raster) rasterIndex++;
                    } else {
                        value = raster;
                        rasterIndex++;
                    }
                }
                if (!started || value !== previous) { previous = value; started = true; return value; }
            }
        };
    };

    // ---- Pass 4: size the grid, and resolve RF event indices against it ----
    //
    // Walking rather than searching: `timeIdx` wants the first grid point at or
    // after an event, and a forward cursor over the events in time order finds
    // exactly that. Events with no grid point after them are dropped, as the
    // search's -1 was.
    const excSorted = Float64Array.from(excT); excSorted.sort();
    const refSorted = Float64Array.from(refT); refSorted.sort();
    const eIdx: number[] = [], rIdx: number[] = [];
    let excSeen = 0, refSeen = 0;
    let N = 0;
    {
        const nextGridTime = makeGridWalk();
        for (;;) {
            const t = nextGridTime();
            if (Number.isNaN(t)) break;
            while (excSeen < excSorted.length && t >= excSorted[excSeen] - 1e-12) { eIdx.push(N); excSeen++; }
            while (refSeen < refSorted.length && t >= refSorted[refSeen] - 1e-12) { rIdx.push(N); refSeen++; }
            N++;
        }
    }
    if (N < 2) return null;
    if (_options?.maxGridPoints && N > _options.maxGridPoints) return null;
    // Read through cursors rather than expanding into two Uint8Array(N). The
    // integration walks the grid forward, so a cursor answers the same question
    // a lookup table would, and the tables cost 168 MB on an 83.9 M-point grid
    // to record a few hundred set entries.
    let excCursor = 0, refCursor = 0;
    const excitationAtIndex = (i: number): boolean => {
        while (excCursor < eIdx.length && eIdx[excCursor] < i) excCursor++;
        return excCursor < eIdx.length && eIdx[excCursor] === i;
    };
    const refocusingAtIndex = (i: number): boolean => {
        while (refCursor < rIdx.length && rIdx[refCursor] < i) refCursor++;
        return refCursor < rIdx.length && rIdx[refCursor] === i;
    };

    // ---- Pass 5: integrate, and consume the trajectory as it is produced ----
    //
    // The former implementation first accumulated a raw trajectory over the
    // entire sequence and then applied a large `dk` offset at every RF event.
    // That is algebraically correct, but long echo/spoke trains subtract nearly
    // equal large values and amplify floating-point error. Integrating the
    // effective state directly is equivalent:
    //   excitation  -> reset to zero
    //   refocusing  -> negate the current state
    // Subsequent physical-gradient increments are unchanged. Kahan compensation
    // limits accumulation error within each RF epoch.
    //
    // Every grid point is still visited, in order, with the same arithmetic.
    // What changed is that nothing full-length is stored: the gradients are
    // evaluated a point at a time, the recurrence needs only the previous
    // sample, ADC samples are emitted through a cursor over their own sorted
    // times as each interval closes, and the trajectory output keeps only the
    // samples asked for. Three full-raster arrays for the gradients and three
    // more for the trajectory — 4 GB together on a 3D wave sequence — become a
    // handful of locals.
    const outCount = (_options?.maxTrajectoryPoints && _options.maxTrajectoryPoints > 0)
        ? Math.min(_options.maxTrajectoryPoints, N)
        : N;
    // The same selection `downsample` makes, so the overview is unchanged.
    const outStep = N / outCount;
    const outX = new Float64Array(outCount), outY = new Float64Array(outCount), outZ = new Float64Array(outCount);
    const outT = new Float64Array(outCount);

    const nA = adcT.length;
    const f32Adc = _options?.adcPrecision === 'f32';
    const kxA: AdcSamples = f32Adc ? new Float32Array(nA) : new Float64Array(nA);
    const kyA: AdcSamples = f32Adc ? new Float32Array(nA) : new Float64Array(nA);
    const kzA: AdcSamples = f32Adc ? new Float32Array(nA) : new Float64Array(nA);

    const cursors = [0, 0, 0];
    let cx = 0, cy = 0, cz = 0;
    let lx = 0, ly = 0, lz = 0;
    let a = 0;        // next ADC sample to emit
    let out = 0;      // next trajectory sample to keep
    let nextKeep = 0; // grid index it sits at
    let ec = 0;       // next excitation index, for the plot breaks

    // `interp` returns d[0] for any time at or before the first grid point, and
    // d[n-1] for any time past the last; those two are handled outside the loop.
    const nextGridTime = makeGridWalk();
    let tPrev = nextGridTime();
    let gxPrev = sampleSeries(gradientSeries[0], tPrev, cursors, 0);
    let gyPrev = sampleSeries(gradientSeries[1], tPrev, cursors, 1);
    let gzPrev = sampleSeries(gradientSeries[2], tPrev, cursors, 2);
    if (refocusingAtIndex(0) && !excitationAtIndex(0)) { lx = -lx; ly = -ly; lz = -lz; }

    if (nextKeep === 0) {
        while (ec < eIdx.length && eIdx[ec] < 1) ec++;
        const brk = ec < eIdx.length && eIdx[ec] === 1;
        outT[0] = tPrev;
        outX[0] = brk ? NaN : lx; outY[0] = brk ? NaN : ly; outZ[0] = brk ? NaN : lz;
        out = 1;
        nextKeep = out < outCount ? Math.floor(out * outStep) : -1;
    }
    while (a < nA && adcT[a] <= tPrev) { kxA[a] = lx; kyA[a] = ly; kzA[a] = lz; a++; }

    for (let i = 1; i < N; i++) {
        const tCur = nextGridTime();
        const gxi = sampleSeries(gradientSeries[0], tCur, cursors, 0);
        const gyi = sampleSeries(gradientSeries[1], tCur, cursors, 1);
        const gzi = sampleSeries(gradientSeries[2], tCur, cursors, 2);
        const dt = tCur - tPrev;
        const px = lx, py = ly, pz = lz;   // the settled k[i-1]

        if (dt > 0) {
            const dx = 0.5*(gxPrev+gxi)*dt;
            const dy = 0.5*(gyPrev+gyi)*dt;
            const dz = 0.5*(gzPrev+gzi)*dt;
            const yx = dx - cx, yy = dy - cy, yz = dz - cz;
            const nx = lx + yx, ny = ly + yy, nz = lz + yz;
            cx = (nx - lx) - yx;
            cy = (ny - ly) - yy;
            cz = (nz - lz) - yz;
            lx = nx; ly = ny; lz = nz;

            // Match Pulseq's precedence when an excitation and refocusing map to
            // the same canonical trajectory time.
            if (excitationAtIndex(i)) {
                lx = 0; ly = 0; lz = 0;
                cx = 0; cy = 0; cz = 0;
            } else if (refocusingAtIndex(i)) {
                lx = -lx; ly = -ly; lz = -lz;
                cx = -cx; cy = -cy; cz = -cz;
            }
        }

        if (i === nextKeep) {
            // NaN before an excitation, so the overview breaks cleanly there.
            while (ec < eIdx.length && eIdx[ec] < i + 1) ec++;
            const brk = ec < eIdx.length && eIdx[ec] === i + 1;
            outT[out] = tCur;
            outX[out] = brk ? NaN : lx; outY[out] = brk ? NaN : ly; outZ[out] = brk ? NaN : lz;
            out++;
            nextKeep = out < outCount ? Math.floor(out * outStep) : -1;
        }

        // Every ADC time in (grid[i-1], grid[i]], in the order `interp` would
        // have resolved them, and with its branches in the same order.
        while (a < nA && adcT[a] <= tCur) {
            const t = adcT[a];
            if (Math.abs(tCur - t) < 1e-12 || dt <= 0) {
                kxA[a] = lx; kyA[a] = ly; kzA[a] = lz;
            } else {
                kxA[a] = px + (lx - px) * (t - tPrev) / dt;
                kyA[a] = py + (ly - py) * (t - tPrev) / dt;
                kzA[a] = pz + (lz - pz) * (t - tPrev) / dt;
            }
            a++;
        }

        gxPrev = gxi; gyPrev = gyi; gzPrev = gzi;
        tPrev = tCur;
    }

    // Times past the end of the grid take the last sample, as `interp` does.
    while (a < nA) { kxA[a] = lx; kyA[a] = ly; kzA[a] = lz; a++; }

    // adcT is already a Float64Array filled to exactly totalAdcSamples, so it is
    // returned rather than copied; the guard keeps the trim if that ever stops
    // holding.
    const tAdc = adcIdx === adcT.length ? adcT : adcT.slice(0, adcIdx);
    return {
        ktraj: [outX, outY, outZ],
        t_ktraj: outT,
        ktraj_adc: [kxA, kyA, kzA],
        t_adc: tAdc,
        rasterSampleCount: N,
    };
}

// ---- helpers ----
/** How many times `collectSeriesSupport` will call its callback. */
function countSeriesSupport(series: FrozenGradientSeries, mode: 'endpoints' | 'all'): number {
    if (series.times.length < 2) return 0;
    return mode === 'all' ? series.times.length : series.requiredSupport.length;
}

function collectSeriesSupport(
    series: FrozenGradientSeries,
    mode: 'endpoints' | 'all',
    push: (time: number) => void,
): void {
    if (series.times.length < 2) return;
    if (mode === 'all') {
        for (const time of series.times) push(time);
        return;
    }
    for (const time of series.requiredSupport) push(time);
}

/**
 * The assembled global series, in exact-size typed arrays.
 *
 * It is built through `number[]` because the pieces arrive one block at a time
 * and their total is not known until the end, but a push-grown array keeps
 * whatever capacity it doubled into: 72.3 M elements cost 789 MB where the
 * doubles need 552 MB. Freezing at the end returns that, and the transient
 * copy is one axis at a time.
 */
export interface FrozenGradientSeries {
    times: Float64Array;
    values: Float64Array;
    requiredSupport: Float64Array;
}

function freezeSeries(series: GradientSeries): FrozenGradientSeries {
    const frozen = {
        times: Float64Array.from(series.times),
        values: Float64Array.from(series.values),
        requiredSupport: Float64Array.from(series.requiredSupport),
    };
    series.times.length = 0;
    series.values.length = 0;
    series.requiredSupport.length = 0;
    return frozen;
}

function buildGlobalGradientSeries(
    blocks: DecodedBlock[],
    gradientRaster: number,
    totalDuration: number,
): [FrozenGradientSeries, FrozenGradientSeries, FrozenGradientSeries] {
    const output: [GradientSeries, GradientSeries, GradientSeries] = [
        { times: [], values: [], requiredSupport: [] },
        { times: [], values: [], requiredSupport: [] },
        { times: [], values: [], requiredSupport: [] },
    ];

    for (const block of blocks) {
        for (let axis = 0; axis < 3; axis++) {
            const piece = physicalGradientPiece(block, axis);
            if (piece.times.length) appendGradientPiece(output[axis], piece, gradientRaster);
        }
    }

    for (const series of output) {
        if (!series.times.length) continue;
        const first = series.times[0];
        const last = series.times[series.times.length - 1];
        if (first > 0) {
            series.times.unshift(-POLYNOMIAL_SUPPORT_EPSILON_SEC, first - POLYNOMIAL_SUPPORT_EPSILON_SEC);
            series.values.unshift(0, 0);
            series.requiredSupport.push(-POLYNOMIAL_SUPPORT_EPSILON_SEC, first - POLYNOMIAL_SUPPORT_EPSILON_SEC);
        }
        if (last < totalDuration) {
            series.times.push(last + POLYNOMIAL_SUPPORT_EPSILON_SEC, totalDuration + POLYNOMIAL_SUPPORT_EPSILON_SEC);
            series.values.push(0, 0);
            series.requiredSupport.push(last + POLYNOMIAL_SUPPORT_EPSILON_SEC, totalDuration + POLYNOMIAL_SUPPORT_EPSILON_SEC);
        }
    }
    // One axis at a time, so only one oversized array is duplicated at a time.
    return [freezeSeries(output[0]), freezeSeries(output[1]), freezeSeries(output[2])];
}

function appendGradientPiece(
    target: GradientSeries,
    piece: GradientSeries,
    gradientRaster: number,
): void {
    if (!piece.times.length) return;
    target.requiredSupport.push(piece.times[0], piece.times[piece.times.length - 1]);
    if (!target.times.length) {
        target.times.push(...piece.times);
        target.values.push(...piece.values);
        return;
    }

    const lastIndex = target.times.length - 1;
    const previousTime = target.times[lastIndex];
    const firstTime = piece.times[0];
    if (previousTime + gradientRaster < firstTime) {
        if (target.values[lastIndex] !== 0) {
            if (Math.abs(target.values[lastIndex]) > 1e-6) {
                target.times.push(previousTime + gradientRaster * 0.5);
                target.values.push(0);
                target.requiredSupport.push(previousTime + gradientRaster * 0.5);
            } else {
                target.values[lastIndex] = 0;
            }
        }
        if (piece.values[0] !== 0) {
            if (Math.abs(piece.values[0]) > 1e-6) {
                target.times.push(firstTime - gradientRaster * 0.5);
                target.values.push(0);
                target.requiredSupport.push(firstTime - gradientRaster * 0.5);
            } else {
                piece.values[0] = 0;
            }
        }
    }

    let start = 0;
    const currentLast = target.times[target.times.length - 1];
    while (start < piece.times.length && piece.times[start] <= currentLast) start++;
    for (let i = start; i < piece.times.length; i++) {
        target.times.push(piece.times[i]);
        target.values.push(piece.values[i]);
    }
}

function sampleSeries(
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

