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
 *   - every ADC sample is evaluated from the segment-start state (spins that
 *     evolve identically are summed first; see ReadoutGrouper).
 * By default each RF operator is stepped once per spin and cached as the
 * exact affine map it applies (see RfOperatorCache); stepping every event
 * ('stepping') remains available and is the check on the cache.
 * All signs follow ../conventions.ts.
 */

import { rasterCellsFromShapes } from '../../pulseq/rfWaveform';
import type { PulseqSequence } from '../../pulseq/types';
import { demodulationPhase } from '../conventions';
import type { SimProgram } from '../program/compile';
import { adcSampleTimes } from '../program/compile';
import { addPiecesIntegral, piecesKAt, relativePieces } from '../program/pwl';
import type { AdcSegment, RfSegment } from '../program/types';
import type { SpinMembers, SpinSet, SpinState } from './spins';
import { equilibriumState } from './spins';

export interface SimulationResult {
    /** Delivered signal (∝ e^{−iωt}), complex interleaved: [(sample·coils + coil)·2 + {0: re, 1: im}]. */
    signal: Float64Array;
    sampleCount: number;
    coils: number;
    /** Final magnetization in the engine frame (per class when folded). */
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

export interface SimulationOptions {
    /** Start from this state instead of equilibrium (it is updated in place). */
    initial?: SpinState;
    /** 'cached' (default) applies each RF operator as a cached affine map; 'stepping' steps every event. */
    rfMode?: 'cached' | 'stepping';
    /** 'grouped' (default) sums identically-evolving spins per readout; 'direct' synthesises every spin. */
    readout?: 'grouped' | 'direct';
    /** Called with the fraction of the sequence done, at most every `progressInterval` segments. */
    onProgress?: (fraction: number) => void;
    progressInterval?: number;
    /** Polled with progress; returning true aborts the run with SimulationCancelledError. */
    isCancelled?: () => boolean;
    /** Stop at the first segment starting at or after this time [s]; later samples stay zero. */
    until?: number;
    /**
     * The real spins when `spins` holds folded classes (see SpinMembers); they
     * set the signal weights, receive coils and the folded-axis phase.
     */
    members?: SpinMembers;
}

export class SimulationCancelledError extends Error {
    constructor() {
        super('The simulation was cancelled.');
        this.name = 'SimulationCancelledError';
    }
}

export function simulateReference(program: SimProgram, spins: SpinSet, options: SimulationOptions = {}): SimulationResult {
    const state = options.initial ?? equilibriumState(spins.count);
    const sampleCount = countAdcSamples(program.sequence);
    const members = options.members ?? null;
    if (members) checkMembers(members, spins.count);
    const coils = members ? members.coils : spins.coils;
    const signal = new Float64Array(sampleCount * coils * 2);
    // Gradient area since the start: the folded phase at a readout (members only).
    const area = new Float64Array(3);
    const cache = (options.rfMode ?? 'cached') === 'cached' ? new RfOperatorCache(spins) : null;
    const grouper = new ReadoutGrouper(spins, (options.readout ?? 'grouped') === 'grouped');
    const interval = Math.max(1, options.progressInterval ?? 64);
    const free = new PendingFree();
    let sampleOffset = 0;
    let processed = 0;
    const until = options.until ?? Infinity;
    for (const segment of program.segments()) {
        if (segment.t0 >= until) break;
        if (segment.kind === 'free') {
            free.add(segment.moments.dk, segment.t1 - segment.t0);
        } else if (segment.kind === 'rf') {
            free.flush(spins, state);
            if (cache) cache.apply(segment, state);
            else applyRf(segment, spins, state);
        } else {
            free.flush(spins, state);
            sampleAdc(segment, spins, state, signal, sampleOffset, grouper, members, area);
            sampleOffset += segment.numSamples;
            // The window itself is free precession from the state just sampled.
            free.add(segment.moments.dk, segment.t1 - segment.t0);
        }
        for (let a = 0; a < 3; a++) area[a] += segment.moments.dk[a];
        if (++processed % interval === 0) {
            if (options.isCancelled?.()) throw new SimulationCancelledError();
            options.onProgress?.(program.totalDuration > 0 ? segment.t1 / program.totalDuration : 1);
        }
    }
    free.flush(spins, state);
    options.onProgress?.(1);
    return { signal, sampleCount, coils, state };
}

function checkMembers(members: SpinMembers, classes: number): void {
    const points = members.foldPoints.length / 3;
    for (let m = 0; m < members.count; m++) {
        const c = members.classOf[m], p = members.foldOf[m];
        if (!(c >= 0 && c < classes)) throw new Error(`Member ${m} names class ${c} of ${classes}.`);
        if (!(p >= 0 && p < points)) throw new Error(`Member ${m} names fold point ${p} of ${points}.`);
    }
}

// ─── Free precession ─────────────────────────────────────────────────────

/**
 * Consecutive free intervals, applied as one. Free precession is a z-rotation
 * (angles add) with relaxation (E1, E2 multiply, and Mz recovery composes to
 * 1 − E1 of the summed time), so merging is exact; a TR then costs one pass
 * over the spins between pulse and readout instead of one per block.
 */
class PendingFree {
    private readonly dk = new Float64Array(3);
    private dt = 0;
    private empty = true;

    add(dk: ArrayLike<number>, dt: number): void {
        this.dk[0] += dk[0];
        this.dk[1] += dk[1];
        this.dk[2] += dk[2];
        this.dt += dt;
        this.empty = false;
    }

    flush(spins: SpinSet, state: SpinState): void {
        if (this.empty) return;
        applyFreeInterval(this.dk, this.dt, spins, state);
        this.dk.fill(0);
        this.dt = 0;
        this.empty = true;
    }
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

/**
 * Raster cells of an RF event. `phaseOffset` defaults to the event's own; the
 * operator cache builds with 0 and applies each event's offset analytically.
 * Cell gradients are averaged in pulse-relative time (see relativePieces), so
 * every event sharing an RF key yields the same cells.
 */
export function rfCells(segment: RfSegment, phaseOffset = segment.phaseOffset): RfCells {
    const op = segment.operator;
    if (op.ptxChannels > 1) throw new Error('Dynamic pTx RF (pTx-Pulseq layout) is not supported yet.');
    // Raster cells as Pulseq defines the waveform (pulseq/rfWaveform.ts):
    // uniform samples held per raster, time shapes as linear breakpoints.
    const cells = rasterCellsFromShapes(op.waveform);
    if (cells.count < 1) throw new Error('RF event without samples.');
    const starts = cells.start;
    const widths = cells.width;
    const magnitude = cells.magnitude;
    const phase = cells.phaseCycles;
    // Cell starts are relative to the RF event start; the segment opens at the
    // first cell, which is where the relative gradient's clock starts.
    const gradient = relativePieces(segment.gradient, segment.t0);
    const count = starts.length;
    const b1Re = new Float64Array(count);
    const b1Im = new Float64Array(count);
    const grad = new Float64Array(3 * count);
    const area = new Float64Array(3);
    for (let j = 0; j < count; j++) {
        const angle = 2 * Math.PI * phase[j] + phaseOffset;
        const amplitude = op.amplitude * magnitude[j];
        b1Re[j] = amplitude * Math.cos(angle);
        b1Im[j] = amplitude * Math.sin(angle);
        area.fill(0);
        const a = starts[j] - starts[0], b = a + widths[j];
        addPiecesIntegral(gradient, a, b, area);
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
    const out = stepRfVector(cells, spins, i, state.mx[i], state.my[i], state.mz[i]);
    state.mx[i] = out[0];
    state.my[i] = out[1];
    state.mz[i] = out[2];
}

/** Step the vector (x, y, z) through the pulse as seen by spin `i`. */
export function stepRfVector(
    cells: RfCells,
    spins: SpinSet,
    i: number,
    x: number,
    y: number,
    z: number,
): [number, number, number] {
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
    return [x * c - y * s, x * s + y * c, z];
}

/**
 * Exact per-spin RF operators, built once per RF key and reused by every event
 * that shares it.
 *
 * With relaxation, a pulse acts on each spin as an affine map M⁺ = A·M + c
 * (rotation and relaxation are linear, recovery adds the constant). Stepping
 * the three basis vectors and the zero vector through the pulse gives A and c
 * exactly. Built with zero phase offset; an event with offset φ applies
 * Rz(φ)·(A·Rz(−φ)·M + c), which is exact because a constant RF phase only
 * rotates the transverse plane. 12 doubles per spin per key.
 */
export class RfOperatorCache {
    private readonly maps = new Map<string, Float64Array>();

    constructor(private readonly spins: SpinSet) { }

    get size(): number {
        return this.maps.size;
    }

    /** Bytes held by the cached maps. */
    get bytes(): number {
        let total = 0;
        for (const map of this.maps.values()) total += map.byteLength;
        return total;
    }

    apply(segment: RfSegment, state: SpinState): void {
        const map = this.maps.get(segment.key) ?? this.build(segment);
        const phi = segment.phaseOffset;
        const cp = Math.cos(phi), sp = Math.sin(phi);
        const { mx, my, mz } = state;
        for (let i = 0; i < this.spins.count; i++) {
            const o = 12 * i;
            // v = Rz(−φ)·M
            const vx = mx[i] * cp + my[i] * sp;
            const vy = -mx[i] * sp + my[i] * cp;
            const vz = mz[i];
            // w = A·v + c   (A row-major in o..o+8, c in o+9..o+11)
            const wx = map[o] * vx + map[o + 1] * vy + map[o + 2] * vz + map[o + 9];
            const wy = map[o + 3] * vx + map[o + 4] * vy + map[o + 5] * vz + map[o + 10];
            const wz = map[o + 6] * vx + map[o + 7] * vy + map[o + 8] * vz + map[o + 11];
            // M⁺ = Rz(φ)·w
            mx[i] = wx * cp - wy * sp;
            my[i] = wx * sp + wy * cp;
            mz[i] = wz;
        }
    }

    private build(segment: RfSegment): Float64Array {
        const cells = rfCells(segment, 0);
        const spins = this.spins;
        const map = new Float64Array(12 * spins.count);
        // A spin's response depends on its position only along axes the pulse's
        // gradient uses (elsewhere the gradient term is exactly zero), plus its
        // off-resonance, B1 and relaxation. Spins identical in those are built
        // once: a 2D slice under a slice-select gradient collapses to its tissue
        // classes. The copies are bit-identical to building each spin.
        const active = [false, false, false];
        for (let j = 0; j < cells.count; j++) {
            for (let axis = 0; axis < 3; axis++) if (cells.grad[3 * j + axis] !== 0) active[axis] = true;
        }
        const coordinates = [spins.x, spins.y, spins.z];
        const built = new Map<string, number>();
        for (let i = 0; i < spins.count; i++) {
            let signature = `${spins.df[i]}|${spins.r1[i]}|${spins.r2[i]}|${spins.b1Re[i]}|${spins.b1Im[i]}`;
            for (let axis = 0; axis < 3; axis++) if (active[axis]) signature += `|${coordinates[axis][i]}`;
            const twin = built.get(signature);
            if (twin !== undefined) {
                map.copyWithin(12 * i, 12 * twin, 12 * twin + 12);
                continue;
            }
            built.set(signature, i);
            const c = stepRfVector(cells, spins, i, 0, 0, 0);
            const ex = stepRfVector(cells, spins, i, 1, 0, 0);
            const ey = stepRfVector(cells, spins, i, 0, 1, 0);
            const ez = stepRfVector(cells, spins, i, 0, 0, 1);
            const o = 12 * i;
            for (let row = 0; row < 3; row++) {
                map[o + 3 * row] = ex[row] - c[row];
                map[o + 3 * row + 1] = ey[row] - c[row];
                map[o + 3 * row + 2] = ez[row] - c[row];
                map[o + 9 + row] = c[row];
            }
        }
        this.maps.set(segment.key, map);
        return map;
    }
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

/** Spins that evolve identically during a readout, summed into one emitter. */
export interface ReadoutGroups {
    count: number;
    /** Group of each spin. */
    groupOf: Int32Array;
    /** Group position (zero on axes the readout's gradient does not use) [m]. */
    x: Float64Array;
    y: Float64Array;
    z: Float64Array;
    df: Float64Array;
    r2: Float64Array;
}

/**
 * Exact readout grouping. During an ADC window there is no RF, so a spin's
 * transverse magnetization only precesses and decays, at a rate set by its
 * position along the axes whose gradient is active in the window, its
 * off-resonance and its T2. Spins equal in those evolve identically: their
 * weighted, coil-weighted magnetizations can be summed at the window start
 * and synthesised once. For an x readout of a 2D slice that turns ~10⁴ spins
 * into a few hundred emitters. Groupings are cached per active-axis mask.
 */
export class ReadoutGrouper {
    private readonly byMask = new Map<number, ReadoutGroups>();

    constructor(private readonly spins: SpinSet, private readonly enabled = true) { }

    groups(activeAxes: number): ReadoutGroups {
        const mask = this.enabled ? activeAxes & 7 : -1;
        let groups = this.byMask.get(mask);
        if (!groups) {
            groups = this.build(mask);
            this.byMask.set(mask, groups);
        }
        return groups;
    }

    private build(mask: number): ReadoutGroups {
        const spins = this.spins;
        const groupOf = new Int32Array(spins.count);
        const index = new Map<string, number>();
        const x: number[] = [], y: number[] = [], z: number[] = [], df: number[] = [], r2: number[] = [];
        for (let i = 0; i < spins.count; i++) {
            const gx = mask < 0 || mask & 1 ? spins.x[i] : 0;
            const gy = mask < 0 || mask & 2 ? spins.y[i] : 0;
            const gz = mask < 0 || mask & 4 ? spins.z[i] : 0;
            let group: number | undefined;
            if (mask >= 0) {
                const signature = `${gx}|${gy}|${gz}|${spins.df[i]}|${spins.r2[i]}`;
                group = index.get(signature);
                if (group === undefined) {
                    group = x.length;
                    index.set(signature, group);
                }
            } else {
                group = x.length;
            }
            if (group === x.length) {
                x.push(gx); y.push(gy); z.push(gz); df.push(spins.df[i]); r2.push(spins.r2[i]);
            }
            groupOf[i] = group;
        }
        return {
            count: x.length,
            groupOf,
            x: Float64Array.from(x), y: Float64Array.from(y), z: Float64Array.from(z),
            df: Float64Array.from(df), r2: Float64Array.from(r2),
        };
    }
}

/** Group sums Σ conj(B1−)·w·M⊥ over the spins themselves. */
function sumSpins(spins: SpinSet, groups: ReadoutGroups, state: SpinState, gRe: Float64Array, gIm: Float64Array): boolean {
    const coils = spins.coils;
    let any = false;
    for (let i = 0; i < spins.count; i++) {
        const mx = state.mx[i], my = state.my[i];
        if (mx === 0 && my === 0) continue;
        any = true;
        const w = spins.weight[i];
        const g = groups.groupOf[i];
        for (let c = 0; c < coils; c++) {
            // conj(B1−) · w · M⊥
            const rr = spins.rxRe[c * spins.count + i];
            const ri = -spins.rxIm[c * spins.count + i];
            gRe[g * coils + c] += w * (rr * mx - ri * my);
            gIm[g * coils + c] += w * (rr * my + ri * mx);
        }
    }
    return any;
}

/**
 * Group sums over folded members: each member's magnetization is its class's,
 * turned by e^{i2π·K·r} with K the area since the start and r its fold point.
 */
function sumMembers(
    members: SpinMembers,
    groups: ReadoutGroups,
    state: SpinState,
    area: Float64Array,
    gRe: Float64Array,
    gIm: Float64Array,
): boolean {
    const coils = members.coils;
    const points = members.foldPoints;
    const pointCount = points.length / 3;
    const pRe = new Float64Array(pointCount), pIm = new Float64Array(pointCount);
    for (let p = 0; p < pointCount; p++) {
        const cycles = area[0] * points[3 * p] + area[1] * points[3 * p + 1] + area[2] * points[3 * p + 2];
        const angle = 2 * Math.PI * (cycles - Math.round(cycles));
        pRe[p] = Math.cos(angle);
        pIm[p] = Math.sin(angle);
    }
    let any = false;
    for (let m = 0; m < members.count; m++) {
        const k = members.classOf[m];
        const cx = state.mx[k], cy = state.my[k];
        if (cx === 0 && cy === 0) continue;
        any = true;
        const p = members.foldOf[m];
        const mx = cx * pRe[p] - cy * pIm[p];
        const my = cx * pIm[p] + cy * pRe[p];
        const w = members.weight[m];
        const g = groups.groupOf[k];
        for (let c = 0; c < coils; c++) {
            const rr = members.rxRe[c * members.count + m];
            const ri = -members.rxIm[c * members.count + m];
            gRe[g * coils + c] += w * (rr * mx - ri * my);
            gIm[g * coils + c] += w * (rr * my + ri * mx);
        }
    }
    return any;
}

/** Samples between exact re-evaluations of the phasor recurrence. */
const RECURRENCE_ANCHOR = 64;

function sampleAdc(
    segment: AdcSegment,
    spins: SpinSet,
    state: SpinState,
    signal: Float64Array,
    sampleOffset: number,
    grouper: ReadoutGrouper,
    members: SpinMembers | null,
    area: Float64Array,
): void {
    const n = segment.numSamples;
    const coils = members ? members.coils : spins.coils;
    const times = adcSampleTimes(segment);
    const k = new Float64Array(3 * n);
    piecesKAt(segment.gradient, times, k);
    const groups = grouper.groups(segment.activeAxes);

    // Weighted, coil-weighted transverse magnetization of each group at t0.
    const gRe = new Float64Array(groups.count * coils);
    const gIm = new Float64Array(groups.count * coils);
    const any = members
        ? sumMembers(members, groups, state, area, gRe, gIm)
        : sumSpins(spins, groups, state, gRe, gIm);

    const sumRe = new Float64Array(n * coils);
    const sumIm = new Float64Array(n * coils);
    if (any) {
        // On a gradient plateau every sample advances k by the same step, so the
        // phasor can advance by one multiplication per sample.
        let uniform = n > 1;
        for (let s = 2; s < n && uniform; s++) {
            for (let a = 0; a < 3; a++) {
                const first = k[3 + a] - k[a];
                const step = k[3 * s + a] - k[3 * (s - 1) + a];
                if (Math.abs(step - first) > 1e-9 * Math.max(1, Math.abs(first))) uniform = false;
            }
        }
        const twoPi = 2 * Math.PI;
        const dwell = segment.dwell;
        for (let g = 0; g < groups.count; g++) {
            let nonzero = false;
            for (let c = 0; c < coils; c++) if (gRe[g * coils + c] !== 0 || gIm[g * coils + c] !== 0) nonzero = true;
            if (!nonzero) continue;
            const x = groups.x[g], y = groups.y[g], z = groups.z[g], df = groups.df[g], r2 = groups.r2[g];
            const exact = (s: number): [number, number] => {
                const tau = times[s] - segment.t0;
                const cycles = k[3 * s] * x + k[3 * s + 1] * y + k[3 * s + 2] * z + df * tau;
                const angle = twoPi * (cycles - Math.round(cycles));
                const decay = Math.exp(-tau * r2);
                return [Math.cos(angle) * decay, Math.sin(angle) * decay];
            };
            let stepRe = 0, stepIm = 0;
            if (uniform) {
                const cycles = (k[3] - k[0]) * x + (k[4] - k[1]) * y + (k[5] - k[2]) * z + df * dwell;
                const angle = twoPi * (cycles - Math.round(cycles));
                const decay = Math.exp(-dwell * r2);
                stepRe = Math.cos(angle) * decay;
                stepIm = Math.sin(angle) * decay;
            }
            let pRe = 0, pIm = 0;
            for (let s = 0; s < n; s++) {
                if (!uniform || s % RECURRENCE_ANCHOR === 0) {
                    [pRe, pIm] = exact(s);
                } else {
                    const nr = pRe * stepRe - pIm * stepIm;
                    pIm = pRe * stepIm + pIm * stepRe;
                    pRe = nr;
                }
                for (let c = 0; c < coils; c++) {
                    const ar = gRe[g * coils + c], ai = gIm[g * coils + c];
                    sumRe[s * coils + c] += ar * pRe - ai * pIm;
                    sumIm[s * coils + c] += ar * pIm + ai * pRe;
                }
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
