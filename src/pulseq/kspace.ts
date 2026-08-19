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

import type { DecodedBlock, DecodedGradWaveform } from './types';

export interface KSpaceData {
    ktraj: Float64Array[];      // [kx, ky, kz]  [Hz/m]
    t_ktraj: Float64Array;      // time grid  [s]
    ktraj_adc: Float64Array[];  // ADC samples  [Hz/m]
    t_adc: Float64Array;        // ADC times  [s]
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

interface GradientSeries {
    times: number[];
    values: number[];
    requiredSupport: number[];
}

const TRAJECTORY_TIME_ACCURACY_SEC = 1e-10;
const GRADIENT_ENDPOINT_TOLERANCE_SEC = 1e-12;
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
    const cand: number[] = [];
    const pushC = (t: number) => { if (isFinite(t) && t >= -tacc) cand.push(Math.max(0, tacc * Math.round(t/tacc))); };
    for (const series of gradientSeries) collectSeriesSupport(series, gradientSupport, pushC);
    for (const t of excT) { pushC(t); pushC(t - RF); pushC(t - 2 * RF); }
    for (const t of refT) { pushC(t); pushC(t - RF); }
    for (const t of adcT) pushC(t);
    pushC(0); pushC(totalDuration);
    if (totalDuration > 0) {
        const nS = Math.max(1, Math.round(totalDuration / GR));
        for (let i = 0; i <= nS; i++) pushC(i * GR);
    }

    // Sort and deduplicate in one pass — O(n log n) but safe for any sequence size
    if (cand.length === 0) return null;
    cand.sort((a, b) => a - b);
    const grid: number[] = [];
    for (let i = 0; i < cand.length; i++) {
        if (i === 0 || cand[i] - cand[i - 1] > tacc * 0.5) grid.push(cand[i]);
    }
    const N = grid.length;
    if (N < 2) return null;
    if (_options?.maxGridPoints && N > _options.maxGridPoints) return null;

    // ---- Pass 3: evaluate the assembled piecewise-linear gradients ----
    const gx = new Float64Array(N), gy = new Float64Array(N), gz = new Float64Array(N);
    const cursors = [0, 0, 0];
    for (let i = 0; i < N; i++) {
        const t = grid[i];
        gx[i] = sampleSeries(gradientSeries[0], t, cursors, 0);
        gy[i] = sampleSeries(gradientSeries[1], t, cursors, 1);
        gz[i] = sampleSeries(gradientSeries[2], t, cursors, 2);
    }

    // ---- Pass 4: resolve RF event indices ----
    const eIdx: number[] = [], rIdx: number[] = [];
    for (const t of excT) { const i = timeIdx(t, grid); if (i >= 0) eIdx.push(i); }
    for (const t of refT) { const i = timeIdx(t, grid); if (i >= 0) rIdx.push(i); }
    eIdx.sort((a,b)=>a-b); rIdx.sort((a,b)=>a-b);
    const excitationAt = new Uint8Array(N);
    const refocusingAt = new Uint8Array(N);
    for (const i of eIdx) excitationAt[i] = 1;
    for (const i of rIdx) refocusingAt[i] = 1;

    // ---- Pass 5: integrate the RF-local effective trajectory ----
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
    const kx = new Float64Array(N), ky = new Float64Array(N), kz = new Float64Array(N);
    let cx = 0, cy = 0, cz = 0;
    if (refocusingAt[0] && !excitationAt[0]) {
        kx[0] = -kx[0]; ky[0] = -ky[0]; kz[0] = -kz[0];
    }
    for (let i = 1; i < N; i++) {
        const dt = grid[i] - grid[i-1];
        if (dt <= 0) { kx[i] = kx[i-1]; ky[i] = ky[i-1]; kz[i] = kz[i-1]; continue; }
        const dx = 0.5*(gx[i-1]+gx[i])*dt;
        const dy = 0.5*(gy[i-1]+gy[i])*dt;
        const dz = 0.5*(gz[i-1]+gz[i])*dt;
        const yx = dx - cx, yy = dy - cy, yz = dz - cz;
        const nx = kx[i-1] + yx, ny = ky[i-1] + yy, nz = kz[i-1] + yz;
        cx = (nx - kx[i-1]) - yx;
        cy = (ny - ky[i-1]) - yy;
        cz = (nz - kz[i-1]) - yz;
        kx[i] = nx; ky[i] = ny; kz[i] = nz;

        // Match Pulseq's precedence when an excitation and refocusing map to
        // the same canonical trajectory time.
        if (excitationAt[i]) {
            kx[i] = 0; ky[i] = 0; kz[i] = 0;
            cx = 0; cy = 0; cz = 0;
        } else if (refocusingAt[i]) {
            kx[i] = -kx[i]; ky[i] = -ky[i]; kz[i] = -kz[i];
            cx = -cx; cy = -cy; cz = -cz;
        }
    }

    // ---- Pass 6: NaN before excitation for clean plot breaks ----
    const kxP = new Float64Array(kx), kyP = new Float64Array(ky), kzP = new Float64Array(kz);
    for (const i of eIdx) { if (i > 0) { kxP[i-1] = NaN; kyP[i-1] = NaN; kzP[i-1] = NaN; } }

    // ---- Pass 7: interpolate at ADC times ----
    const nA = adcT.length;
    const kxA = new Float64Array(nA), kyA = new Float64Array(nA), kzA = new Float64Array(nA);
    for (let a = 0; a < nA; a++) { kxA[a] = interp(kx, grid, adcT[a]); kyA[a] = interp(ky, grid, adcT[a]); kzA[a] = interp(kz, grid, adcT[a]); }

    return { ktraj: [kxP, kyP, kzP], t_ktraj: new Float64Array(grid), ktraj_adc: [kxA, kyA, kzA], t_adc: new Float64Array(adcT) };
}

// ---- helpers ----
function collectSeriesSupport(
    series: GradientSeries,
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

function buildGlobalGradientSeries(
    blocks: DecodedBlock[],
    gradientRaster: number,
    totalDuration: number,
): [GradientSeries, GradientSeries, GradientSeries] {
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
    return output;
}

function physicalGradientPiece(block: DecodedBlock, axis: number): GradientSeries {
    const gradients = [block.gx, block.gy, block.gz];
    const hasGradient = gradients.some(g => g && g.type !== 'none' && g.timePoints.length >= 2);
    if (!hasGradient) return { times: [], values: [], requiredSupport: [] };

    // Without a rotation, retain the decoded support exactly. This is the
    // common path and matches Pulseq's per-axis waveform pieces.
    if (!block.rotation?.values) {
        const gradient = gradients[axis];
        if (!gradient || gradient.type === 'none' || gradient.timePoints.length < 2) {
            return { times: [], values: [], requiredSupport: [] };
        }
        return {
            times: Array.from(gradient.timePoints),
            values: Array.from(gradient.waveform),
            requiredSupport: [],
        };
    }

    // A rotation can mix differently sampled logical axes. Evaluate their union
    // so the rotated physical component remains piecewise linear.
    const times: number[] = [];
    for (const gradient of gradients) {
        if (!gradient || gradient.type === 'none') continue;
        for (const time of gradient.timePoints) times.push(time);
    }
    times.sort((a, b) => a - b);
    const uniqueTimes: number[] = [];
    for (const time of times) {
        if (!uniqueTimes.length || time - uniqueTimes[uniqueTimes.length - 1] > GRADIENT_ENDPOINT_TOLERANCE_SEC) {
            uniqueTimes.push(time);
        }
    }
    return {
        times: uniqueTimes,
        values: uniqueTimes.map(time => {
            const rotated = rotateGradient(
                block,
                gradVal(block.gx, time),
                gradVal(block.gy, time),
                gradVal(block.gz, time),
            );
            return rotated[axis];
        }),
        requiredSupport: [],
    };
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
    series: GradientSeries,
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

function gradVal(g: DecodedGradWaveform|undefined, t: number): number {
    if (!g || g.type === 'none') return 0;
    const tp = g.timePoints, wf = g.waveform;
    if (!tp || tp.length < 2) return 0;
    const first = tp[0], last = tp[tp.length - 1];
    if (t < first - GRADIENT_ENDPOINT_TOLERANCE_SEC
        || t > last + GRADIENT_ENDPOINT_TOLERANCE_SEC) return 0;
    if (t <= first + GRADIENT_ENDPOINT_TOLERANCE_SEC) return wf[0];
    if (t >= last - GRADIENT_ENDPOINT_TOLERANCE_SEC) return wf[wf.length - 1];
    let lo=0,hi=tp.length-1;
    while(hi-lo>1){const m=(lo+hi)>>1;if(tp[m]<=t)lo=m;else hi=m;}
    const s=tp[hi]-tp[lo];if(s<=0)return wf[lo];
    return wf[lo]+(wf[hi]-wf[lo])*(t-tp[lo])/s;
}
function timeIdx(t: number, g: number[]): number {
    let lo=0,hi=g.length;
    while(lo<hi){const m=(lo+hi)>>1;if(g[m]<t-1e-12)lo=m+1;else hi=m;}
    return lo < g.length ? lo : -1;
}
function interp(d: Float64Array, g: number[], t: number): number {
    const n=g.length;if(n===0)return 0;
    let lo=0,hi=n;
    while(lo<hi){const m=(lo+hi)>>1;if(g[m]<t)lo=m+1;else hi=m;}
    if(lo===0)return d[0];if(lo>=n)return d[n-1];
    if(Math.abs(g[lo]-t)<1e-12)return d[lo];
    const i0=lo-1,i1=lo,dt=g[i1]-g[i0];
    if(dt<=0)return d[i1];
    return d[i0]+(d[i1]-d[i0])*(t-g[i0])/dt;
}

function rotateGradient(block: DecodedBlock, gx: number, gy: number, gz: number): [number, number, number] {
    const values = block.rotation?.values;
    if (!values) return [gx, gy, gz];

    if (values.length === 4) {
        const [w, x, y, z] = values;
        const r00 = 1 - 2 * y * y - 2 * z * z;
        const r01 = 2 * x * y - 2 * w * z;
        const r02 = 2 * x * z + 2 * w * y;
        const r10 = 2 * x * y + 2 * w * z;
        const r11 = 1 - 2 * x * x - 2 * z * z;
        const r12 = 2 * y * z - 2 * w * x;
        const r20 = 2 * x * z - 2 * w * y;
        const r21 = 2 * y * z + 2 * w * x;
        const r22 = 1 - 2 * x * x - 2 * y * y;
        return [
            r00 * gx + r01 * gy + r02 * gz,
            r10 * gx + r11 * gy + r12 * gz,
            r20 * gx + r21 * gy + r22 * gz,
        ];
    }

    if (values.length === 9) {
        return [
            values[0] * gx + values[1] * gy + values[2] * gz,
            values[3] * gx + values[4] * gy + values[5] * gz,
            values[6] * gx + values[7] * gy + values[8] * gz,
        ];
    }

    return [gx, gy, gz];
}
