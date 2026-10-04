/**
 * Reference Bloch engine: exact, double precision, single-threaded.
 *
 * This is the oracle the fast paths (cached RF operators, grouped readouts,
 * workers, WebGPU) are validated against, so it favours plainness over speed:
 *   - free segments apply the exact precession/relaxation operator;
 *   - RF is stepped cell by cell on the native RF raster with Cayley–Klein
 *     rotations and Strang-split relaxation (relax ½·w, rotate, relax ½·w),
 *     in the frame rotating at the pulse frequency offset so the offset's
 *     phase ramp is exact rather than sampled;
 *   - every ADC sample is evaluated directly from the segment-start state.
 * All signs follow ../conventions.ts.
 */

import type { PulseqSequence } from '../../pulseq/types';
import { demodulationPhase } from '../conventions';
import type { SimProgram } from '../program/compile';
import { adcSampleTimes } from '../program/compile';
import { addPiecesIntegral, piecesKAt } from '../program/pwl';
import type { AdcSegment, FreeSegment, RfSegment } from '../program/types';
import type { SpinSet, SpinState } from './spins';
import { equilibriumState } from './spins';

export interface SimulationResult {
    /** Delivered signal (∝ e^{−iωt}), complex interleaved: [(sample·coils + coil)·2 + {0: re, 1: im}]. */
    signal: Float64Array;
    sampleCount: number;
    coils: number;
    /** Final magnetization in the engine frame. */
    state: SpinState;
}

/** Total ADC samples of a sequence, from the block table alone. */
export function countAdcSamples(seq: PulseqSequence): number {
    let total = 0;
    for (const block of seq.blocks) {
        const adc = block.adcId > 0 ? seq.adcs.get(block.adcId) : undefined;
        if (adc) total += adc.numSamples;
    }
    return total;
}

export function simulateReference(program: SimProgram, spins: SpinSet, initial?: SpinState): SimulationResult {
    const state = initial ?? equilibriumState(spins.count);
    const sampleCount = countAdcSamples(program.sequence);
    const signal = new Float64Array(sampleCount * spins.coils * 2);
    let sampleOffset = 0;
    for (const segment of program.segments()) {
        if (segment.kind === 'free') {
            applyFree(segment, spins, state);
        } else if (segment.kind === 'rf') {
            applyRf(segment, spins, state);
        } else {
            sampleAdc(segment, spins, state, signal, sampleOffset);
            sampleOffset += segment.numSamples;
            applyFreeInterval(segment.moments.dk, segment.t1 - segment.t0, spins, state);
        }
    }
    return { signal, sampleCount, coils: spins.coils, state };
}

// ─── Free precession ─────────────────────────────────────────────────────

function applyFree(segment: FreeSegment, spins: SpinSet, state: SpinState): void {
    applyFreeInterval(segment.moments.dk, segment.t1 - segment.t0, spins, state);
}

/** Exact free precession and relaxation over an interval with gradient area `dk`. */
export function applyFreeInterval(dk: ArrayLike<number>, dt: number, spins: SpinSet, state: SpinState): void {
    const { mx, my, mz } = state;
    const twoPi = 2 * Math.PI;
    for (let i = 0; i < spins.count; i++) {
        const cycles = dk[0] * spins.x[i] + dk[1] * spins.y[i] + dk[2] * spins.z[i] + spins.df[i] * dt;
        const angle = twoPi * (cycles - Math.round(cycles));
        const e2 = Math.exp(-dt * spins.r2[i]);
        const e1 = Math.exp(-dt * spins.r1[i]);
        const c = Math.cos(angle) * e2, s = Math.sin(angle) * e2;
        const x = mx[i], y = my[i];
        mx[i] = x * c - y * s;
        my[i] = x * s + y * c;
        mz[i] = mz[i] * e1 + (1 - e1);
    }
}

// ─── RF ──────────────────────────────────────────────────────────────────

/** An RF pulse as raster cells in the frame rotating at its frequency offset. */
export interface RfCells {
    count: number;
    /** Cell widths [s]. */
    width: Float64Array;
    /** Complex B1 per cell in that frame [Hz] (event phase offset included). */
    b1Re: Float64Array;
    b1Im: Float64Array;
    /** Cell-average physical gradient, xyz interleaved [Hz/m]. */
    grad: Float64Array;
    /** Pulse frequency offset [Hz]. */
    freq: number;
    /** Rotating-frame phase at the first cell's start and the last cell's end [rad]. */
    phaseIn: number;
    phaseOut: number;
}

export function rfCells(segment: RfSegment): RfCells {
    const op = segment.operator;
    if (op.ptxChannels > 1) throw new Error('Dynamic pTx RF (pTx-Pulseq layout) is not supported yet.');
    const waveform = op.waveform;
    const raster = waveform.raster;
    // Cell boundaries relative to the RF event start (block start + RF delay).
    let starts: Float64Array;
    let widths: Float64Array;
    let magnitude: Float64Array;
    let phase: Float64Array;
    let pulseStart: number;
    if (waveform.kind === 'uniform') {
        const n = waveform.count;
        pulseStart = segment.t0;
        starts = new Float64Array(n);
        widths = new Float64Array(n).fill(raster);
        magnitude = new Float64Array(n);
        phase = new Float64Array(n);
        for (let j = 0; j < n; j++) {
            starts[j] = j * raster;
            magnitude[j] = waveform.magnitude[j];
            phase[j] = waveform.phaseCycles ? waveform.phaseCycles[j] : 0;
        }
    } else {
        // Piecewise-linear breakpoints, resampled to raster cells evaluated at
        // their midpoints (exact for cells inside one linear stretch).
        const times = waveform.times;
        const first = times[0], last = times[waveform.count - 1];
        pulseStart = segment.t0 - first;
        const n = Math.max(1, Math.round((last - first) / raster));
        const width = (last - first) / n;
        starts = new Float64Array(n);
        widths = new Float64Array(n).fill(width);
        magnitude = new Float64Array(n);
        phase = new Float64Array(n);
        let k = 0;
        for (let j = 0; j < n; j++) {
            starts[j] = first + j * width;
            const mid = starts[j] + 0.5 * width;
            while (k + 1 < waveform.count - 1 && times[k + 1] <= mid) k++;
            const span = times[k + 1] - times[k];
            const u = span > 0 ? (mid - times[k]) / span : 0;
            magnitude[j] = waveform.magnitude[k] + u * (waveform.magnitude[k + 1] - waveform.magnitude[k]);
            const p0 = waveform.phaseCycles ? waveform.phaseCycles[k] : 0;
            const p1 = waveform.phaseCycles ? waveform.phaseCycles[k + 1] : 0;
            phase[j] = p0 + u * (p1 - p0);
        }
    }
    const count = starts.length;
    const b1Re = new Float64Array(count);
    const b1Im = new Float64Array(count);
    const grad = new Float64Array(3 * count);
    const area = new Float64Array(3);
    for (let j = 0; j < count; j++) {
        const angle = 2 * Math.PI * phase[j] + segment.phaseOffset;
        const amplitude = op.amplitude * magnitude[j];
        b1Re[j] = amplitude * Math.cos(angle);
        b1Im[j] = amplitude * Math.sin(angle);
        area.fill(0);
        const a = pulseStart + starts[j], b = a + widths[j];
        addPiecesIntegral(segment.gradient, a, b, area);
        for (let axis = 0; axis < 3; axis++) grad[3 * j + axis] = area[axis] / widths[j];
    }
    const freq = op.freqOffset;
    const firstStart = starts[0];
    const lastEnd = starts[count - 1] + widths[count - 1];
    return {
        count,
        width: widths,
        b1Re,
        b1Im,
        grad,
        freq,
        phaseIn: 2 * Math.PI * freq * firstStart,
        phaseOut: 2 * Math.PI * freq * lastEnd,
    };
}

function applyRf(segment: RfSegment, spins: SpinSet, state: SpinState): void {
    const cells = rfCells(segment);
    for (let i = 0; i < spins.count; i++) stepRfSpin(cells, spins, i, state);
}

/**
 * Step one spin through an RF pulse: enter the frame rotating at the pulse
 * frequency, apply each cell as relax(w/2) · rotate · relax(w/2), and return.
 */
export function stepRfSpin(cells: RfCells, spins: SpinSet, i: number, state: SpinState): void {
    const { mx, my, mz } = state;
    let x = mx[i], y = my[i], z = mz[i];
    // Into the rotating frame: M′ = Rz(−phaseIn)·M.
    {
        const c = Math.cos(cells.phaseIn), s = Math.sin(cells.phaseIn);
        const nx = x * c + y * s, ny = -x * s + y * c;
        x = nx; y = ny;
    }
    const sx = spins.x[i], sy = spins.y[i], sz = spins.z[i];
    const offset = spins.df[i] - cells.freq;
    const r1 = spins.r1[i], r2 = spins.r2[i];
    const bRe = spins.b1Re[i], bIm = spins.b1Im[i];
    for (let j = 0; j < cells.count; j++) {
        const w = cells.width[j];
        const half = 0.5 * w;
        const e2h = Math.exp(-half * r2), e1h = Math.exp(-half * r1);
        // relax(w/2)
        x *= e2h; y *= e2h; z = z * e1h + (1 - e1h);
        // B1 scaled by the spin's complex B1+ (phases add).
        const bx = cells.b1Re[j] * bRe - cells.b1Im[j] * bIm;
        const by = cells.b1Re[j] * bIm + cells.b1Im[j] * bRe;
        const bz = cells.grad[3 * j] * sx + cells.grad[3 * j + 1] * sy + cells.grad[3 * j + 2] * sz + offset;
        [x, y, z] = rotateCayleyKlein(x, y, z, bx, by, bz, w);
        // relax(w/2)
        x *= e2h; y *= e2h; z = z * e1h + (1 - e1h);
    }
    // Back to the engine frame: M = Rz(phaseOut)·M′.
    const c = Math.cos(cells.phaseOut), s = Math.sin(cells.phaseOut);
    mx[i] = x * c - y * s;
    my[i] = x * s + y * c;
    mz[i] = z;
}

/** sin(πx)/(πx), with its Taylor series near zero. */
function sinc(x: number): number {
    const px = Math.PI * x;
    if (Math.abs(px) < 1e-4) return 1 - px * px / 6;
    return Math.sin(px) / px;
}

/**
 * Rotate M = (x, y, z) by a constant field B = (bx, by, bz) [Hz] for `w`
 * seconds, through the Cayley–Klein spinor in sinc form (well defined at
 * |B| = 0):  a = cos(π|B|w) − iπw·bz·sinc(|B|w),  b = −iπw·(bx + i·by)·sinc(|B|w);
 *   Mxy⁺ = (a*)²·Mxy − b²·Mxy* + 2a*b·Mz,
 *   Mz⁺  = −2·Re(a·b·Mxy*) + (|a|² − |b|²)·Mz.
 */
export function rotateCayleyKlein(
    x: number, y: number, z: number,
    bx: number, by: number, bz: number,
    w: number,
): [number, number, number] {
    const magnitude = Math.sqrt(bx * bx + by * by + bz * bz);
    const sc = Math.PI * w * sinc(magnitude * w);
    const aRe = Math.cos(Math.PI * magnitude * w);
    const aIm = -bz * sc;
    // b = −i·sc·(bx + i·by) = sc·by − i·sc·bx
    const bRe = sc * by;
    const bIm = -sc * bx;
    // (a*)² = (aRe − i·aIm)²
    const a2Re = aRe * aRe - aIm * aIm;
    const a2Im = -2 * aRe * aIm;
    // b²
    const b2Re = bRe * bRe - bIm * bIm;
    const b2Im = 2 * bRe * bIm;
    // a*·b
    const abRe = aRe * bRe + aIm * bIm;
    const abIm = aRe * bIm - aIm * bRe;
    // Mxy⁺ = (a*)²·M − b²·conj(M) + 2·a*b·z
    const nx = (a2Re * x - a2Im * y) - (b2Re * x + b2Im * y) + 2 * abRe * z;
    const ny = (a2Re * y + a2Im * x) - (b2Im * x - b2Re * y) + 2 * abIm * z;
    // a·b
    const pRe = aRe * bRe - aIm * bIm;
    const pIm = aRe * bIm + aIm * bRe;
    // Re(a·b·conj(M)) = pRe·x + pIm·y
    const nz = -2 * (pRe * x + pIm * y) + (aRe * aRe + aIm * aIm - bRe * bRe - bIm * bIm) * z;
    return [nx, ny, nz];
}

// ─── Readout ─────────────────────────────────────────────────────────────

function sampleAdc(
    segment: AdcSegment,
    spins: SpinSet,
    state: SpinState,
    signal: Float64Array,
    sampleOffset: number,
): void {
    const n = segment.numSamples;
    const coils = spins.coils;
    const times = adcSampleTimes(segment);
    const k = new Float64Array(3 * n);
    piecesKAt(segment.gradient, times, k);
    const sumRe = new Float64Array(n * coils);
    const sumIm = new Float64Array(n * coils);
    const twoPi = 2 * Math.PI;
    for (let i = 0; i < spins.count; i++) {
        const x0 = state.mx[i], y0 = state.my[i];
        if (x0 === 0 && y0 === 0) continue;
        const sx = spins.x[i], sy = spins.y[i], sz = spins.z[i];
        const df = spins.df[i], r2 = spins.r2[i], w = spins.weight[i];
        for (let s = 0; s < n; s++) {
            const tau = times[s] - segment.t0;
            const cycles = k[3 * s] * sx + k[3 * s + 1] * sy + k[3 * s + 2] * sz + df * tau;
            const angle = twoPi * (cycles - Math.round(cycles));
            const e2 = Math.exp(-tau * r2) * w;
            const c = Math.cos(angle) * e2, sn = Math.sin(angle) * e2;
            const re = x0 * c - y0 * sn;
            const im = x0 * sn + y0 * c;
            for (let coil = 0; coil < coils; coil++) {
                // conj(B1−) · M⊥
                const rr = spins.rxRe[coil * spins.count + i];
                const ri = -spins.rxIm[coil * spins.count + i];
                sumRe[s * coils + coil] += rr * re - ri * im;
                sumIm[s * coils + coil] += rr * im + ri * re;
            }
        }
    }
    for (let s = 0; s < n; s++) {
        const phase = demodulationPhase(segment.phaseOffset, segment.freqOffset, segment.dwell, s, segment.phaseModulation);
        const c = Math.cos(phase), sn = Math.sin(phase);
        for (let coil = 0; coil < coils; coil++) {
            const re = sumRe[s * coils + coil], im = sumIm[s * coils + coil];
            // × e^{−i·phase}, then the output conjugation.
            const dRe = re * c + im * sn;
            const dIm = im * c - re * sn;
            const out = ((sampleOffset + s) * coils + coil) * 2;
            signal[out] = dRe;
            signal[out + 1] = -dIm;
        }
    }
}
