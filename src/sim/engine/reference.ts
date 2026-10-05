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
    /**
     * Readout synthesis. 'lattice' (default) merges groups on the readout
     * lattice where it can (see synthesizeOnLattice) and otherwise does what
     * 'grouped' does: sum identically evolving spins, then advance each
     * group's phasor per sample. 'direct' synthesises every spin.
     */
    readout?: 'lattice' | 'grouped' | 'direct';
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
    const grouper = new ReadoutGrouper(spins, (options.readout ?? 'grouped') !== 'direct');
    // Lattice synthesis is the default for grouped readouts; 'grouped' alone is
    // the per-group recurrence it is checked against.
    const lattice = (options.readout ?? 'lattice') === 'lattice';
    const interval = Math.max(1, options.progressInterval ?? 64);
    const free = new PendingFree(new FreeKernel(spins));
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
            sampleAdc(segment, spins, state, signal, sampleOffset, grouper, members, area, lattice);
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
    let owners = classes;
    if (members.profileOf) {
        owners = members.profiles ?? 0;
        if (members.profileOf.length !== classes) throw new Error(`${members.profileOf.length} class profiles for ${classes} classes.`);
        for (let c = 0; c < classes; c++) {
            const q = members.profileOf[c];
            if (!(q >= 0 && q < owners)) throw new Error(`Class ${c} names profile ${q} of ${owners}.`);
        }
    }
    for (let m = 0; m < members.count; m++) {
        const c = members.classOf[m], p = members.foldOf[m];
        if (!(c >= 0 && c < owners)) throw new Error(`Member ${m} names ${members.profileOf ? 'profile' : 'class'} ${c} of ${owners}.`);
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

    constructor(private readonly kernel: FreeKernel) { }

    add(dk: ArrayLike<number>, dt: number): void {
        this.dk[0] += dk[0];
        this.dk[1] += dk[1];
        this.dk[2] += dk[2];
        this.dt += dt;
        this.empty = false;
    }

    flush(spins: SpinSet, state: SpinState): void {
        if (this.empty) return;
        this.kernel.apply(this.dk, this.dt, state);
        this.dk.fill(0);
        this.dt = 0;
        this.empty = true;
    }
}

/**
 * applyFreeInterval with the work shared where spins allow. Relaxation
 * factors depend only on the interval length, which repeats every TR, so they
 * are cached per length. Phases depend only on position and off-resonance, so
 * spins sharing both (the classes of a folded column) share one phasor per
 * interval. When those keys are many but their coordinates repeat (sub-slices
 * along z times a continuous B0 map), the phasor is built as the product
 * e^{i2πΔk_x·x}·e^{i2πΔk_y·y}·e^{i2πΔk_z·z}·e^{i2πΔf·t} from per-coordinate
 * tables: a few complex products instead of a cos and sin per key, equal to
 * the direct phasor to rounding (each factor's phase folded to ±½ cycle).
 */
class FreeKernel {
    /** Distinct (x, y, z, Δf) of the spins, and each spin's entry. */
    private readonly keyOf: Int32Array;
    private readonly kx: Float64Array;
    private readonly ky: Float64Array;
    private readonly kz: Float64Array;
    private readonly kdf: Float64Array;
    private readonly cos: Float64Array;
    private readonly sin: Float64Array;
    /** Per coordinate (x, y, z, Δf): its distinct values, each key's index into them, phasor scratch. */
    private readonly tables: { values: Float64Array; index: Int32Array; cos: Float64Array; sin: Float64Array }[] | null;
    private readonly relaxation = new Map<number, { e1: Float64Array; e2: Float64Array }>();

    constructor(private readonly spins: SpinSet) {
        const index = new Map<string, number>();
        const keyOf = new Int32Array(spins.count);
        const x: number[] = [], y: number[] = [], z: number[] = [], df: number[] = [];
        for (let i = 0; i < spins.count; i++) {
            const key = `${spins.x[i]}|${spins.y[i]}|${spins.z[i]}|${spins.df[i]}`;
            let k = index.get(key);
            if (k === undefined) {
                k = x.length;
                index.set(key, k);
                x.push(spins.x[i]); y.push(spins.y[i]); z.push(spins.z[i]); df.push(spins.df[i]);
            }
            keyOf[i] = k;
        }
        this.keyOf = keyOf;
        this.kx = Float64Array.from(x); this.ky = Float64Array.from(y); this.kz = Float64Array.from(z);
        this.kdf = Float64Array.from(df);
        this.cos = new Float64Array(x.length);
        this.sin = new Float64Array(x.length);
        const tables = [this.kx, this.ky, this.kz, this.kdf].map(coordinate => {
            const distinct = new Map<number, number>();
            const at = new Int32Array(coordinate.length);
            for (let k = 0; k < coordinate.length; k++) {
                let j = distinct.get(coordinate[k]);
                if (j === undefined) distinct.set(coordinate[k], j = distinct.size);
                at[k] = j;
            }
            const values = new Float64Array(distinct.size);
            for (const [value, j] of distinct) values[j] = value;
            return { values, index: at, cos: new Float64Array(values.length), sin: new Float64Array(values.length) };
        });
        const tableSize = tables.reduce((sum, table) => sum + table.values.length, 0);
        this.tables = tableSize * 4 < x.length ? tables : null;
    }

    apply(dk: ArrayLike<number>, dt: number, state: SpinState): void {
        const twoPi = 2 * Math.PI;
        if (this.tables) {
            this.factorisedPhasors(dk, dt);
        } else {
            for (let k = 0; k < this.kx.length; k++) {
                const cycles = dk[0] * this.kx[k] + dk[1] * this.ky[k] + dk[2] * this.kz[k] + this.kdf[k] * dt;
                const angle = twoPi * (cycles - Math.round(cycles));
                this.cos[k] = Math.cos(angle);
                this.sin[k] = Math.sin(angle);
            }
        }
        const { e1, e2 } = this.factors(dt);
        const { mx, my, mz } = state;
        const keyOf = this.keyOf, cosT = this.cos, sinT = this.sin;
        for (let i = 0; i < this.spins.count; i++) {
            const k = keyOf[i];
            const c = cosT[k] * e2[i], sn = sinT[k] * e2[i];
            const x = mx[i], y = my[i];
            mx[i] = x * c - y * sn;
            my[i] = x * sn + y * c;
            mz[i] = mz[i] * e1[i] + (1 - e1[i]);
        }
    }

    /** Each key's phasor as the product of its coordinates' factors (only those that turn). */
    private factorisedPhasors(dk: ArrayLike<number>, dt: number): void {
        const tables = this.tables!;
        const scales = [dk[0], dk[1], dk[2], dt];
        const active: number[] = [];
        for (let a = 0; a < 4; a++) {
            if (scales[a] === 0) continue;
            const table = tables[a];
            let turns = false;
            for (let j = 0; j < table.values.length; j++) {
                const cycles = scales[a] * table.values[j];
                const angle = 2 * Math.PI * (cycles - Math.round(cycles));
                table.cos[j] = Math.cos(angle);
                table.sin[j] = Math.sin(angle);
                if (angle !== 0) turns = true;
            }
            if (turns) active.push(a);
        }
        const keys = this.cos.length;
        if (!active.length) {
            this.cos.fill(1);
            this.sin.fill(0);
            return;
        }
        const first = tables[active[0]];
        for (let k = 0; k < keys; k++) {
            const j = first.index[k];
            this.cos[k] = first.cos[j];
            this.sin[k] = first.sin[j];
        }
        for (let n = 1; n < active.length; n++) {
            const table = tables[active[n]];
            for (let k = 0; k < keys; k++) {
                const j = table.index[k];
                const fc = table.cos[j], fs = table.sin[j];
                const c = this.cos[k], s = this.sin[k];
                this.cos[k] = c * fc - s * fs;
                this.sin[k] = c * fs + s * fc;
            }
        }
    }

    /** E1 and E2 of every spin for an interval, cached for the lengths that recur. */
    private factors(dt: number): { e1: Float64Array; e2: Float64Array } {
        let entry = this.relaxation.get(dt);
        if (entry) return entry;
        const n = this.spins.count;
        entry = { e1: new Float64Array(n), e2: new Float64Array(n) };
        for (let i = 0; i < n; i++) {
            entry.e1[i] = Math.exp(-dt * this.spins.r1[i]);
            entry.e2[i] = Math.exp(-dt * this.spins.r2[i]);
        }
        // A sequence repeats a handful of interval lengths; bound the cache for those that do not.
        if (this.relaxation.size >= FREE_CACHE_LENGTHS) this.relaxation.clear();
        this.relaxation.set(dt, entry);
        return entry;
    }
}

/** Interval lengths whose relaxation factors the free kernel keeps. */
const FREE_CACHE_LENGTHS = 32;

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
    /** Lattice of group positions per axis, computed on first use (null: not a lattice). */
    lattices?: (GroupLattice | null | undefined)[];
}

/** Group positions along one axis as origin + slot·pitch. */
interface GroupLattice {
    origin: number;
    pitch: number;
    span: number;
    slot: Int32Array;
}

function groupLattice(groups: ReadoutGroups, axis: number): GroupLattice | null {
    groups.lattices ??= [];
    const cached = groups.lattices[axis];
    if (cached !== undefined) return cached;
    const position = axis === 0 ? groups.x : axis === 1 ? groups.y : groups.z;
    const values = Float64Array.from(position).sort();
    let result: GroupLattice | null = null;
    if (values.length) {
        const origin = values[0];
        let pitch = Infinity;
        for (let i = 1; i < values.length; i++) {
            const gap = values[i] - values[i - 1];
            if (gap > 1e-12 * Math.max(1, Math.abs(values[i])) && gap < pitch) pitch = gap;
        }
        if (!Number.isFinite(pitch)) pitch = 1;      // a single position
        const span = Math.round((values[values.length - 1] - origin) / pitch) + 1;
        const slot = new Int32Array(groups.count);
        let onLattice = span <= 1 << 22;
        for (let g = 0; g < groups.count && onLattice; g++) {
            const offset = (position[g] - origin) / pitch;
            slot[g] = Math.round(offset);
            if (Math.abs(offset - slot[g]) > 1e-6) onLattice = false;
        }
        if (onLattice) result = { origin, pitch, span, slot };
    }
    groups.lattices[axis] = result;
    return result;
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
 * With profiles (through-slice sampling), a member's magnetization is its
 * profile's: the sum of the profile's classes, each times the class weight.
 */
function sumMembers(
    members: SpinMembers,
    spins: SpinSet,
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
    const profiles = members.profileOf ? profileSums(members, spins, groups, state) : null;
    if (profiles && !profiles.shared) return sumMembersByClass(members, spins, groups, state, pRe, pIm, gRe, gIm);
    const sx = profiles ? profiles.mx : state.mx, sy = profiles ? profiles.my : state.my;
    const groupOf = profiles ? profiles.groupOf : groups.groupOf;
    let any = false;
    for (let m = 0; m < members.count; m++) {
        const k = members.classOf[m];
        const cx = sx[k], cy = sy[k];
        if (cx === 0 && cy === 0) continue;
        any = true;
        const p = members.foldOf[m];
        const mx = cx * pRe[p] - cy * pIm[p];
        const my = cx * pIm[p] + cy * pRe[p];
        const w = members.weight[m];
        const g = groupOf[k];
        for (let c = 0; c < coils; c++) {
            const rr = members.rxRe[c * members.count + m];
            const ri = -members.rxIm[c * members.count + m];
            gRe[g * coils + c] += w * (rr * mx - ri * my);
            gIm[g * coils + c] += w * (rr * my + ri * mx);
        }
    }
    return any;
}

/**
 * Weighted sums of each profile's classes, and the readout group they share.
 * `shared` is false when a profile's classes fall into different groups (a
 * readout gradient along z); its sums are then not used.
 */
function profileSums(members: SpinMembers, spins: SpinSet, groups: ReadoutGroups, state: SpinState) {
    const count = members.profiles ?? 0;
    const profileOf = members.profileOf!;
    const mx = new Float64Array(count), my = new Float64Array(count);
    const groupOf = new Int32Array(count).fill(-1);
    let shared = true;
    for (let c = 0; c < spins.count; c++) {
        const q = profileOf[c];
        const g = groups.groupOf[c];
        if (groupOf[q] < 0) groupOf[q] = g;
        else if (groupOf[q] !== g) shared = false;
        mx[q] += spins.weight[c] * state.mx[c];
        my[q] += spins.weight[c] * state.my[c];
    }
    return { mx, my, groupOf, shared };
}

/** Member sums class by class: each member contributes through every class of its profile. */
function sumMembersByClass(
    members: SpinMembers,
    spins: SpinSet,
    groups: ReadoutGroups,
    state: SpinState,
    pRe: Float64Array,
    pIm: Float64Array,
    gRe: Float64Array,
    gIm: Float64Array,
): boolean {
    const coils = members.coils;
    const count = members.profiles ?? 0;
    const profileOf = members.profileOf!;
    // Classes of each profile, as CSR.
    const start = new Int32Array(count + 1);
    for (let c = 0; c < spins.count; c++) start[profileOf[c] + 1]++;
    for (let q = 0; q < count; q++) start[q + 1] += start[q];
    const fill = start.slice(0, count);
    const classes = new Int32Array(spins.count);
    for (let c = 0; c < spins.count; c++) classes[fill[profileOf[c]]++] = c;
    let any = false;
    for (let m = 0; m < members.count; m++) {
        const q = members.classOf[m];
        const p = members.foldOf[m];
        for (let i = start[q]; i < start[q + 1]; i++) {
            const k = classes[i];
            const cx = state.mx[k] * spins.weight[k], cy = state.my[k] * spins.weight[k];
            if (cx === 0 && cy === 0) continue;
            any = true;
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
    }
    return any;
}

/** Taylor terms the lattice synthesis may use before falling back. */
const LATTICE_MAX_TERMS = 24;
/** Truncation error the lattice synthesis accepts, relative to the signal. */
const LATTICE_TOLERANCE = 1e-13;

/**
 * Readout synthesis on the lattice of group positions.
 *
 * On a gradient plateau along one axis, group g contributes
 *   A_g · e^{i2π k(t)·x_g} · e^{z_g τ},   z_g = −R2_g + i2π·Δf_g,
 * and the positions x_g of stratified spins sit on a lattice x₀ + jδ shared
 * by every voxel. Expanding e^{z_g τ} = e^{z̄τ} Σ_m (δz_g τ)^m / m! around the
 * mean z̄ turns the sum over groups into M sums over lattice points:
 *   S(τ) = e^{z̄τ} Σ_m τ^m · Σ_j C_{m,j} e^{i2π k(t)·x_j},
 *   C_{m,j} = Σ_{g at j} A_g (δz_g)^m / m!.
 * Groups sharing a position (the rows of a column, for an x readout) cost
 * one coefficient update each instead of one phasor per sample, which is
 * what makes continuous phantoms (one group per spin) affordable. M is chosen
 * so the truncation stays below LATTICE_TOLERANCE.
 *
 * Returns false, leaving the sums untouched, when the readout uses more than
 * one axis, the positions are not on a lattice, the spread of z needs too
 * many terms, or the lattice would not be smaller than the groups.
 */
function synthesizeOnLattice(
    segment: AdcSegment,
    groups: ReadoutGroups,
    gRe: Float64Array,
    gIm: Float64Array,
    coils: number,
    k: Float64Array,
    times: Float64Array,
    sumRe: Float64Array,
    sumIm: Float64Array,
): boolean {
    const axes = segment.activeAxes & 7;
    const axis = axes === 1 ? 0 : axes === 2 ? 1 : axes === 4 ? 2 : -1;
    if (axis < 0) return false;
    const lattice = groupLattice(groups, axis);
    if (!lattice) return false;
    const { origin, pitch, span } = lattice;
    const n = segment.numSamples;

    // Groups with signal, their positions and the spread of z.
    const active: number[] = [];
    let zRe = 0, zIm = 0;
    for (let g = 0; g < groups.count; g++) {
        let nonzero = false;
        for (let c = 0; c < coils; c++) if (gRe[g * coils + c] !== 0 || gIm[g * coils + c] !== 0) nonzero = true;
        if (!nonzero) continue;
        active.push(g);
        zRe -= groups.r2[g];
        zIm += 2 * Math.PI * groups.df[g];
    }
    if (active.length < 64) return false;
    zRe /= active.length;
    zIm /= active.length;

    const tauMax = times[n - 1] - segment.t0;
    let spread = 0;
    for (const g of active) {
        const dRe = -groups.r2[g] - zRe, dIm = 2 * Math.PI * groups.df[g] - zIm;
        spread = Math.max(spread, Math.sqrt(dRe * dRe + dIm * dIm));
    }
    spread *= tauMax;
    let terms = 1, bound = Math.exp(spread);
    for (; terms <= LATTICE_MAX_TERMS; terms++) {
        bound *= spread / terms;
        if (bound < LATTICE_TOLERANCE) break;
    }
    if (terms > LATTICE_MAX_TERMS) return false;
    // Worth it only when the lattice evaluation is cheaper than per-group phasors.
    if (span * (1 + terms * coils) > 0.5 * active.length * (1 + coils) || span * terms * coils > 4_000_000) return false;

    const slot = lattice.slot;

    // Coefficients C[m][j][coil], complex.
    const stride = span * coils;
    const cRe = new Float64Array(terms * stride), cIm = new Float64Array(terms * stride);
    for (let i = 0; i < active.length; i++) {
        const g = active[i];
        const dRe = -groups.r2[g] - zRe, dIm = 2 * Math.PI * groups.df[g] - zIm;
        let pRe = 1, pIm = 0;                       // (δz)^m / m!
        for (let m = 0; m < terms; m++) {
            for (let c = 0; c < coils; c++) {
                const ar = gRe[g * coils + c], ai = gIm[g * coils + c];
                const o = m * stride + slot[g] * coils + c;
                cRe[o] += ar * pRe - ai * pIm;
                cIm[o] += ar * pIm + ai * pRe;
            }
            const nr = (pRe * dRe - pIm * dIm) / (m + 1);
            pIm = (pRe * dIm + pIm * dRe) / (m + 1);
            pRe = nr;
        }
    }

    // P[m][s][coil] = Σ_j C[m][j][coil] · e^{i2π k_s x_j}.
    const pStride = n * coils;
    const pRe = new Float64Array(terms * pStride), pIm = new Float64Array(terms * pStride);
    const twoPi = 2 * Math.PI;
    const step = k[3 + axis] - k[axis];
    for (let j = 0; j < span; j++) {
        let any = false;
        for (let m = 0; m < terms && !any; m++) {
            for (let c = 0; c < coils; c++) if (cRe[m * stride + j * coils + c] !== 0 || cIm[m * stride + j * coils + c] !== 0) any = true;
        }
        if (!any) continue;
        const x = origin + j * pitch;
        const stepCycles = step * x;
        const stepAngle = twoPi * (stepCycles - Math.round(stepCycles));
        const sRe = Math.cos(stepAngle), sIm = Math.sin(stepAngle);
        let eRe = 0, eIm = 0;
        for (let s = 0; s < n; s++) {
            if (s % RECURRENCE_ANCHOR === 0) {
                const cycles = k[3 * s + axis] * x;
                const angle = twoPi * (cycles - Math.round(cycles));
                eRe = Math.cos(angle);
                eIm = Math.sin(angle);
            } else {
                const nr = eRe * sRe - eIm * sIm;
                eIm = eRe * sIm + eIm * sRe;
                eRe = nr;
            }
            for (let m = 0; m < terms; m++) {
                for (let c = 0; c < coils; c++) {
                    const o = m * stride + j * coils + c;
                    const ar = cRe[o], ai = cIm[o];
                    const q = m * pStride + s * coils + c;
                    pRe[q] += ar * eRe - ai * eIm;
                    pIm[q] += ar * eIm + ai * eRe;
                }
            }
        }
    }

    // S(τ) = e^{z̄τ} Σ_m τ^m · P_m.
    for (let s = 0; s < n; s++) {
        const tau = times[s] - segment.t0;
        const decay = Math.exp(zRe * tau);
        const turns = zIm * tau / twoPi;
        const angle = twoPi * (turns - Math.round(turns));
        const wRe = decay * Math.cos(angle), wIm = decay * Math.sin(angle);
        for (let c = 0; c < coils; c++) {
            let accRe = 0, accIm = 0, power = 1;
            for (let m = 0; m < terms; m++) {
                const q = m * pStride + s * coils + c;
                accRe += pRe[q] * power;
                accIm += pIm[q] * power;
                power *= tau;
            }
            sumRe[s * coils + c] += accRe * wRe - accIm * wIm;
            sumIm[s * coils + c] += accRe * wIm + accIm * wRe;
        }
    }
    return true;
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
    useLattice: boolean,
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
        ? sumMembers(members, spins, groups, state, area, gRe, gIm)
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
        const lattice = uniform && useLattice
            && synthesizeOnLattice(segment, groups, gRe, gIm, coils, k, times, sumRe, sumIm);
        for (let g = 0; g < groups.count && !lattice; g++) {
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
