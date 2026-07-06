/**
 * kspace.ts — K-space trajectory calculator.
 *
 * Based on: xingwangyong/SeqEyes (C++)  src/KSpaceTrajectory.cpp
 *           pulseq/matlab/+mr/@Sequence/Sequence.m::calculateKspaceUnfunc()
 *
 * Key design (matching SeqEyes C++):
 *   1. Gradient series from decoded block waveforms.
 *   2. Non-uniform time grid from gradient breakpoints + RF + ADC times.
 *   3. Midpoint integration on the non-uniform grid.
 *   4. RF corrections via running offset dk:
 *        Excitation  -> dk = -k
 *        Refocusing  -> dk = -2*k - dk
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
 * last‑resort safety check after all essential points are collected.
 */
export interface KSpaceOptions {
    /** Optional hard cap on integration grid size. */
    maxGridPoints?: number;
}

export function calculateKspace(
    blocks: DecodedBlock[],
    gradientRaster: number,
    totalDuration: number,
    trajectoryDelay: number = 0,
    _options?: KSpaceOptions,
): KSpaceData | null {
    if (!blocks.length || !gradientRaster || gradientRaster <= 0) return null;

    const GR = gradientRaster;
    const tacc = 1e-10;

    // ---- Pass 1: count total ADC samples & collect RF/ADC events & gradient breakpoints ----
    const excT: number[] = [], refT: number[] = [];
    const gradBreaks: number[] = [];  // only start/end of each gradient waveform
    let totalAdcSamples = 0;
    for (const b of blocks) {
        if (b.adc) totalAdcSamples += b.adc.numSamples;
    }
    // Pre-allocate ADC array to avoid repeated resizing for large sequences
    const adcT = new Float64Array(totalAdcSamples);
    let adcIdx = 0;

    for (const b of blocks) {
        // Collect only gradient breakpoints (first/last time), not every sample
        collectBreaks(b.gx, gradBreaks);
        collectBreaks(b.gy, gradBreaks);
        collectBreaks(b.gz, gradBreaks);
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

    // ---- Pass 2: build non-uniform time grid (memory‑safe: sort+dedup array) ----
    // Use a sorted-array dedup instead of Set to avoid V8's ~16.7M Set size limit.
    // Only essential points are included: gradient breakpoints, RF centres,
    // ADC sample times, block boundaries, and a uniform raster grid.
    const cand: number[] = [];
    const pushC = (t: number) => { if (isFinite(t) && t >= -tacc) cand.push(Math.max(0, tacc * Math.round(t/tacc))); };
    for (const t of gradBreaks) pushC(t);
    for (const t of excT) { pushC(t); pushC(t - GR); }
    for (const t of refT) { pushC(t); pushC(t - GR); }
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

    // ---- Pass 3: evaluate gradient at each grid point ----
    const gx = new Float64Array(N), gy = new Float64Array(N), gz = new Float64Array(N);
    // Build block edges for fast block lookup
    const edges: number[] = [0];
    let cum = 0;
    for (const b of blocks) { cum += b.duration; edges.push(cum); }
    for (let i = 0; i < N; i++) {
        const t = grid[i];
        const bi = blockIdx(t, edges);
        if (bi >= 0 && bi < blocks.length) {
            const block = blocks[bi];
            const localX = gradVal(block.gx, t);
            const localY = gradVal(block.gy, t);
            const localZ = gradVal(block.gz, t);
            const rotated = rotateGradient(block, localX, localY, localZ);
            gx[i] = rotated[0];
            gy[i] = rotated[1];
            gz[i] = rotated[2];
        }
    }

    // ---- Pass 4: midpoint integration ----
    const kx = new Float64Array(N), ky = new Float64Array(N), kz = new Float64Array(N);
    for (let i = 1; i < N; i++) {
        const dt = grid[i] - grid[i-1];
        if (dt <= 0) { kx[i] = kx[i-1]; ky[i] = ky[i-1]; kz[i] = kz[i-1]; continue; }
        const gxm = 0.5*(gx[i-1]+gx[i]), gym = 0.5*(gy[i-1]+gy[i]), gzm = 0.5*(gz[i-1]+gz[i]);
        kx[i] = kx[i-1] + gxm*dt; ky[i] = ky[i-1] + gym*dt; kz[i] = kz[i-1] + gzm*dt;
    }

    // ---- Pass 5: RF corrections via dk offset ----
    const eIdx: number[] = [], rIdx: number[] = [];
    for (const t of excT) { const i = timeIdx(t, grid); if (i >= 0) eIdx.push(i); }
    for (const t of refT) { const i = timeIdx(t, grid); if (i >= 0) rIdx.push(i); }
    eIdx.sort((a,b)=>a-b); rIdx.sort((a,b)=>a-b);

    const bounds = [0];
    for (const i of eIdx) bounds.push(i);
    for (const i of rIdx) bounds.push(i);
    bounds.push(N-1);
    bounds.sort((a,b)=>a-b);
    const bUniq = [bounds[0]];
    for (let i = 1; i < bounds.length; i++) if (bounds[i] !== bUniq[bUniq.length-1]) bUniq.push(bounds[i]);

    let dkX = -kx[0], dkY = -ky[0], dkZ = -kz[0];
    let pE = 0, pR = 0;
    for (let s = 0; s < bUniq.length-1; s++) {
        const st = bUniq[s], en = bUniq[s+1];
        if (pE < eIdx.length && eIdx[pE] === st) { dkX = -kx[st]; dkY = -ky[st]; dkZ = -kz[st]; pE++; }
        else if (pR < rIdx.length && rIdx[pR] === st) { dkX = -2*kx[st] - dkX; dkY = -2*ky[st] - dkY; dkZ = -2*kz[st] - dkZ; pR++; }
        for (let j = st; j < en; j++) { kx[j] += dkX; ky[j] += dkY; kz[j] += dkZ; }
    }
    kx[N-1] += dkX; ky[N-1] += dkY; kz[N-1] += dkZ;

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
/** Collect only the first and last time point of a gradient waveform (breakpoints).
 *  The full waveform is evaluated via `gradVal` interpolation — individual sample
 *  points do NOT need to be in the integration grid.  This avoids blowing up the
 *  candidate array for sequences with many arbitrary (shaped) gradients. */
function collectBreaks(g: DecodedGradWaveform|undefined, breaks: number[]): void {
    if (!g || g.type === 'none' || !g.timePoints || g.timePoints.length < 2) return;
    breaks.push(g.timePoints[0], g.timePoints[g.timePoints.length - 1]);
}
function gradVal(g: DecodedGradWaveform|undefined, t: number): number {
    if (!g || g.type === 'none') return 0;
    const tp = g.timePoints, wf = g.waveform;
    if (!tp || tp.length < 2) return 0;
    if (t < tp[0] || t > tp[tp.length-1]) return 0;
    let lo=0,hi=tp.length-1;
    while(hi-lo>1){const m=(lo+hi)>>1;if(tp[m]<=t)lo=m;else hi=m;}
    const s=tp[hi]-tp[lo];if(s<=0)return wf[lo];
    return wf[lo]+(wf[hi]-wf[lo])*(t-tp[lo])/s;
}
function blockIdx(t: number, edges: number[]): number {
    let lo=0,hi=edges.length-1;
    while(lo<hi){const m=(lo+hi)>>1;if(edges[m]<=t+1e-12)lo=m+1;else hi=m;}
    return Math.max(0,lo-1);
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
