/**
 * Phase-graph engine: configuration states instead of isochromats.
 *
 * Within a voxel of one tissue class the magnetization is a sum of
 * configurations,
 *   M⊥(r) = Σ F_(k,τ)(z)·e^{i2π(k·r + Δf·τ)},   Mz(r) = Σ Z_(k,τ)(z)·e^{i2π(k·r + Δf·τ)},
 * where k is the gradient area a configuration has accumulated [1/m], τ the
 * time it has spent transverse [s], and z the position through the slab.
 * The amplitudes do not depend on in-plane position or off-resonance. Those
 * enter only at readout, so one evolution per tissue class serves every voxel
 * of that class, each with its own B0. Spoilers and crushers are exact
 * bookkeeping (k shifts); the isochromat engine has to resolve them with
 * hundreds of spins per voxel, and with as many sub-slices along z.
 *
 * Operators, per lane (tissue class × sub-slice):
 *   - free precession over (Δk, Δt): every F moves to (k + Δk, τ + Δt) and
 *     decays by E2; Z decays by E1, and Z_(0,0) recovers by 1 − E1. With an
 *     ADC D, each configuration also decays by e^{−bD} with its own
 *     b = 4π²∫|k(t)|²dt over the interval (Z states keep their k): exact
 *     isotropic Gaussian diffusion for every pathway, stimulated echoes
 *     included;
 *   - an RF pulse: the exact rotation (with relaxation) the isochromat engine
 *     steps for a spin at the sub-slice's z, at the class's off-resonance Δf
 *     and B1. The precession under the pulse is split at its centre:
 *     R(z) = Rz(2π(k_post·z + Δf·t_post))·R̃(z)·Rz(2π(k_pre·z + Δf·t_pre)).
 *     Each F shifts by (k_pre, t_pre), then R̃ mixes (F_(k,τ),
 *     conj F_(−k,−τ), Z_(k,τ)) pointwise in z, then each F shifts by
 *     (k_post, t_post). R̃ is smooth in z (the rephased profile), so a few
 *     sub-slices per resolution cell sample it. Shaped, adiabatic, multiband,
 *     VERSE and spectral pulses are therefore exact as in the isochromat
 *     engine; a voxel whose B0 differs from its class's precesses at its own
 *     through the pulse, about its centre;
 *   - a readout: each configuration emits from every voxel of its class as a
 *     uniform box, sinc(q_x·Δx)·sinc(q_y·Δy), with q = k + k(t), and decays
 *     by e^{−|τ + t|/T2′}: a Lorentzian line of reversible dephasing (T2′),
 *     which a spin echo refocuses because a refocusing pulse turns τ into −τ.
 *     The line acts about each pulse's centre, as a narrow line does. Through the
 *     slab it is the oscillatory integral ∫F(z)·e^{i2πq_z·z}dz of the
 *     piecewise-linear F (Filon). Crushed configurations, at large q_z,
 *     integrate to almost nothing instead of aliasing. In-plane, the voxels
 *     go through the isochromat engine's readout synthesis (grouped or
 *     lattice) as emitters, one configuration at a time.
 * States below `prune` on every lane are dropped after each pulse, and at
 * most `maxStates` of each kind are kept, the strongest.
 *
 * Not represented: RF with gradients along x or y (in-plane selective
 * excitation: the rotation would depend on in-plane position), dynamic pTx.
 */

import { adcSampleTimes, type SimProgram } from '../program/compile';
import { piecesKAt, windowMoments, type SegmentMoments } from '../program/pwl';
import type { AdcSegment, RfSegment } from '../program/types';
import {
    countAdcSamples,
    emitReadout,
    ReadoutGrouper,
    rfCells,
    SimulationCancelledError,
    stepRfVector,
    synthesizeReadout,
} from './reference';
import type { SpinSet } from './spins';

export interface PhaseGraphClass {
    t1: number;
    t2: number;
    /** Complex B1+ scale (1 = nominal). */
    b1Re: number;
    b1Im: number;
    /** Off-resonance the class's RF operators are built at [Hz] (free precession uses each voxel's own). */
    df: number;
    /** T2′ [s] of a Lorentzian line (absent or Infinity: none). */
    t2prime?: number;
    /** Apparent diffusion coefficient [m²/s], isotropic (absent or 0: none). */
    adc?: number;
}

/** The voxels (one per plane of a 3-D phantom) that emit signal. */
export interface PhaseGraphSources {
    count: number;
    /** Voxel centres [m]. */
    x: Float64Array;
    y: Float64Array;
    /** Each source's own off-resonance [Hz]. */
    df: Float64Array;
    /** Tissue class of each source (index into the model's classes). */
    classOf: Int32Array;
    /** Sub-slices the source covers, [from, to): all of them for a 2-D phantom, a plane's for a 3-D one. */
    sliceFrom: Int32Array;
    sliceTo: Int32Array;
    /** Proton density. */
    pd: Float64Array;
    coils: number;
    /** Complex B1− per coil, coil-major [coil · count + source]. */
    rxRe: Float64Array;
    rxIm: Float64Array;
}

export interface PhaseGraphModel {
    classes: PhaseGraphClass[];
    /**
     * Sub-slices along z [m], ascending, each weighing its width over
     * `reference` (plan/slices.ts). One plane: z = [0], weight = [1].
     */
    slices: { z: Float64Array; weight: Float64Array; reference: number };
    sources: PhaseGraphSources;
    /** In-plane voxel size [m]; 0 treats that axis as a point. */
    voxel: [number, number];
}

export interface PhaseGraphOptions {
    /** States whose amplitude stays below this on every lane are dropped (default 1e-5). */
    prune?: number;
    /** Most transverse (and, separately, longitudinal) states kept after a pulse (default 2000). */
    maxStates?: number;
    /** Called with the fraction of the sequence done, at most every `progressInterval` segments. */
    onProgress?: (fraction: number) => void;
    progressInterval?: number;
    /** Polled with progress; returning true aborts with SimulationCancelledError. */
    isCancelled?: () => boolean;
    /** Stop at the first segment starting at or after this time [s]. */
    until?: number;
}

export interface PhaseGraphStats {
    /** Most transverse states alive after a pulse, and their mean at readouts. */
    maxStates: number;
    meanStates: number;
    /** Configurations that emitted at readouts (summed over readouts). */
    emitted: number;
}

export interface PhaseGraphResult {
    signal: Float64Array;
    sampleCount: number;
    coils: number;
    stats: PhaseGraphStats;
}

/** k and τ merge on these grids [1/m], [s]. */
const K_QUANTUM = 1e-3;
const TAU_QUANTUM = 1e-9;
const TWO_PI = 2 * Math.PI;
const FOUR_PI2 = 4 * Math.PI * Math.PI;

/** Configuration states with amplitudes on every lane, in flat arrays. */
class States {
    count = 0;
    k: Float64Array;
    tau: Float64Array;
    amp: Float64Array;

    constructor(readonly lanes: number, capacity = 64) {
        this.k = new Float64Array(3 * capacity);
        this.tau = new Float64Array(capacity);
        this.amp = new Float64Array(2 * lanes * capacity);
    }

    /** A new state at (k, τ) with zero amplitudes; returns its index. */
    add(kx: number, ky: number, kz: number, tau: number): number {
        if (this.count === this.tau.length) this.grow(2 * this.count);
        const i = this.count++;
        this.k[3 * i] = kx; this.k[3 * i + 1] = ky; this.k[3 * i + 2] = kz;
        this.tau[i] = tau;
        this.amp.fill(0, 2 * this.lanes * i, 2 * this.lanes * (i + 1));
        return i;
    }

    private grow(capacity: number): void {
        const k = new Float64Array(3 * capacity); k.set(this.k);
        const tau = new Float64Array(capacity); tau.set(this.tau);
        const amp = new Float64Array(2 * this.lanes * capacity); amp.set(this.amp);
        this.k = k; this.tau = tau; this.amp = amp;
    }

    /** Largest |amplitude component| of state i over the lanes. */
    peak(i: number): number {
        let m = 0;
        const base = 2 * this.lanes * i, end = base + 2 * this.lanes;
        for (let o = base; o < end; o++) { const v = Math.abs(this.amp[o]); if (v > m) m = v; }
        return m;
    }

    /** Keep the states `keep` lists, in that order. */
    compact(keep: Int32Array | number[]): void {
        const n = keep.length, L2 = 2 * this.lanes;
        const k = new Float64Array(3 * Math.max(64, n)), tau = new Float64Array(Math.max(64, n)), amp = new Float64Array(L2 * Math.max(64, n));
        for (let j = 0; j < n; j++) {
            const i = keep[j];
            k[3 * j] = this.k[3 * i]; k[3 * j + 1] = this.k[3 * i + 1]; k[3 * j + 2] = this.k[3 * i + 2];
            tau[j] = this.tau[i];
            amp.set(this.amp.subarray(L2 * i, L2 * (i + 1)), L2 * j);
        }
        this.k = k; this.tau = tau; this.amp = amp; this.count = n;
    }
}

/** Open-addressing table from quantized (k, τ) to an index. */
class KeyTable {
    private keys: Float64Array;
    private values: Int32Array;
    private mask: number;
    size = 0;

    constructor(expected: number) {
        let capacity = 16;
        while (capacity < 2 * expected + 2) capacity <<= 1;
        this.keys = new Float64Array(4 * capacity);
        this.values = new Int32Array(capacity).fill(-1);
        this.mask = capacity - 1;
    }

    private slot(a: number, b: number, c: number, d: number): number {
        let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d)
            ^ Math.imul(d | 0, 0x27d4eb2f) ^ Math.imul((d / 4294967296) | 0, 0x165667b1);
        h ^= h >>> 15;
        h = Math.imul(h, 0x2c1b3c6d);
        h ^= h >>> 12;
        let s = h & this.mask;
        while (this.values[s] !== -1) {
            const o = 4 * s;
            if (this.keys[o] === a && this.keys[o + 1] === b && this.keys[o + 2] === c && this.keys[o + 3] === d) return s;
            s = (s + 1) & this.mask;
        }
        return s;
    }

    get(a: number, b: number, c: number, d: number): number {
        return this.values[this.slot(a, b, c, d)];
    }

    /** The index stored for the key, or `value` stored and returned when absent. */
    claim(a: number, b: number, c: number, d: number, value: number): number {
        const s = this.slot(a, b, c, d);
        if (this.values[s] !== -1) return this.values[s];
        const o = 4 * s;
        this.keys[o] = a; this.keys[o + 1] = b; this.keys[o + 2] = c; this.keys[o + 3] = d;
        this.values[s] = value;
        this.size++;
        return value;
    }
}

/** Quantized k and τ, rounded symmetrically so that the key of −k is minus the key of k. */
const qk = (v: number) => (v < 0 ? -Math.round(-v / K_QUANTUM) : Math.round(v / K_QUANTUM)) + 0;
const qt = (v: number) => (v < 0 ? -Math.round(-v / TAU_QUANTUM) : Math.round(v / TAU_QUANTUM)) + 0;

/** Per lane: A, B, C, D (complex), E, c⊥ (complex), cz; built with zero RF phase. */
const COEFFICIENTS = 12;

export function simulatePhaseGraph(program: SimProgram, model: PhaseGraphModel, options: PhaseGraphOptions = {}): PhaseGraphResult {
    const { classes, slices, sources } = model;
    const C = classes.length, K = slices.z.length, L = C * K;
    if (!(C >= 1 && K >= 1)) throw new Error('The phase-graph model has no tissue class or no sub-slice.');
    const prune = options.prune ?? 1e-5;
    const maxStates = Math.max(1, Math.floor(options.maxStates ?? 2000));
    const coils = sources.coils;
    const r1 = classes.map(c => (Number.isFinite(c.t1) && c.t1 > 0 ? 1 / c.t1 : 0));
    const r2 = classes.map(c => (Number.isFinite(c.t2) && c.t2 > 0 ? 1 / c.t2 : 0));
    const diffusion = classes.map(c => (c.adc !== undefined && Number.isFinite(c.adc) && c.adc > 0 ? c.adc : 0));
    const anyDiffusion = diffusion.some(d => d > 0);
    // Per class, scratch for e^{−bD}.
    const attenuation = new Float64Array(C);

    let F = new States(L), Z = new States(L);
    // Equilibrium: Z_(0,0) = 1 on every lane.
    const z0 = Z.add(0, 0, 0, 0);
    for (let lane = 0; lane < L; lane++) Z.amp[2 * (L * z0 + lane)] = 1;

    const sampleCount = countAdcSamples(program.sequence);
    const signal = new Float64Array(2 * sampleCount * coils);
    const operators = new Map<string, Float64Array>();
    const relaxation = new Map<number, { e1: Float64Array; e2: Float64Array }>();
    const stats: PhaseGraphStats = { maxStates: 1, meanStates: 0, emitted: 0 };
    let readouts = 0, sampleOffset = 0, processed = 0;

    // Sources as emitters for the readout synthesis (positions, own Δf, the class's R2).
    const emitters: SpinSet = {
        count: sources.count,
        x: sources.x, y: sources.y, z: new Float64Array(sources.count),
        df: sources.df,
        r1: new Float64Array(sources.count),
        r2: Float64Array.from(sources.classOf, c => r2[c]),
        weight: new Float64Array(sources.count),
        b1Re: new Float64Array(sources.count), b1Im: new Float64Array(sources.count),
        coils: 1,
        rxRe: new Float64Array(sources.count), rxIm: new Float64Array(sources.count),
    };
    const grouper = new ReadoutGrouper(emitters);
    // T2′: |τ + t| decays at R2 + R2′ once past the echo (τ + t ≥ 0) and grows back at R2 − R2′ before it.
    const r2p = classes.map(c => (c.t2prime !== undefined && Number.isFinite(c.t2prime) && c.t2prime > 0 ? 1 / c.t2prime : 0));
    const anyT2p = r2p.some(v => v > 0);
    const withRate = (sign: number): ReadoutGrouper => new ReadoutGrouper({
        ...emitters, r2: Float64Array.from(sources.classOf, c => r2[c] + sign * r2p[c]),
    });
    const after = anyT2p ? withRate(1) : grouper, before = anyT2p ? withRate(-1) : grouper;
    const fullRange = Array.from({ length: sources.count }, (_, i) => sources.sliceFrom[i] === 0 && sources.sliceTo[i] === K).every(Boolean);
    // Without B0 differences between voxels, τ does not reach the signal and need not split readout groups.
    const anyB0 = sources.df.some(v => v !== 0);
    // Sources sit on few distinct x and y (a voxel grid): their phase e^{i2π(kx·x + ky·y)} is a product of two table entries.
    const distinct = (values: Float64Array) => {
        const index = new Map<number, number>();
        const of = new Int32Array(values.length);
        for (let i = 0; i < values.length; i++) {
            let j = index.get(values[i]);
            if (j === undefined) { j = index.size; index.set(values[i], j); }
            of[i] = j;
        }
        return { values: Float64Array.from(index.keys()), of };
    };
    const xs = distinct(sources.x), ys = distinct(sources.y);
    const xRe = new Float64Array(xs.values.length), xIm = new Float64Array(xs.values.length);
    const yRe = new Float64Array(ys.values.length), yIm = new Float64Array(ys.values.length);
    const phaseTables = (kx: number, ky: number) => {
        for (let j = 0; j < xs.values.length; j++) {
            const c = kx * xs.values[j], a = TWO_PI * (c - Math.round(c));
            xRe[j] = Math.cos(a); xIm[j] = Math.sin(a);
        }
        for (let j = 0; j < ys.values.length; j++) {
            const c = ky * ys.values[j], a = TWO_PI * (c - Math.round(c));
            yRe[j] = Math.cos(a); yIm[j] = Math.sin(a);
        }
    };
    // Slab weights depend on q_z only, which configurations share.
    const slabCache = new Map<number, Float64Array>();

    // Pending free precession (merged between pulses and readouts), with the
    // moments of K from its start that diffusion needs: ∫K dt and Σᵢ∫Kᵢ² dt.
    const pendingDk = new Float64Array(3), pendingM1 = new Float64Array(3);
    let pendingDt = 0, pendingM2 = 0, pending = false;
    const addPending = (moments: SegmentMoments, dt: number) => {
        if (anyDiffusion) {
            for (let a = 0; a < 3; a++) {
                pendingM2 += pendingDk[a] * pendingDk[a] * dt + 2 * pendingDk[a] * moments.kIntegral[a] + moments.kSecond[a];
                pendingM1[a] += pendingDk[a] * dt + moments.kIntegral[a];
            }
        }
        for (let a = 0; a < 3; a++) pendingDk[a] += moments.dk[a];
        pendingDt += dt;
        pending = true;
    };
    const flush = () => {
        if (!pending) return;
        free(pendingDk, pendingDt, pendingM1, pendingM2);
        pendingDk.fill(0); pendingM1.fill(0); pendingDt = 0; pendingM2 = 0; pending = false;
    };
    // The moments of each pulse's halves before and after its centre, per operator key.
    const halves = new Map<string, { pre: SegmentMoments; post: SegmentMoments }>();
    const until = options.until ?? Infinity;
    const interval = Math.max(1, options.progressInterval ?? 64);

    for (const segment of program.segments()) {
        if (segment.t0 >= until) break;
        if (segment.kind === 'free') {
            addPending(segment.moments, segment.t1 - segment.t0);
        } else if (segment.kind === 'rf') {
            flush();
            pulse(segment, operators.get(segment.key) ?? buildOperator(segment));
            stats.maxStates = Math.max(stats.maxStates, F.count);
        } else {
            flush();
            readout(segment);
            stats.meanStates += F.count;
            readouts++;
            sampleOffset += segment.numSamples;
            addPending(segment.moments, segment.t1 - segment.t0);
        }
        if (++processed % interval === 0) {
            if (options.isCancelled?.()) throw new SimulationCancelledError();
            options.onProgress?.(program.totalDuration > 0 ? segment.t1 / program.totalDuration : 1);
        }
    }
    options.onProgress?.(1);
    if (readouts) stats.meanStates /= readouts;
    return { signal, sampleCount, coils, stats };

    // ─── Free precession ────────────────────────────────────────────────
    function factors(dt: number) {
        let entry = relaxation.get(dt);
        if (entry) return entry;
        entry = { e1: Float64Array.from(r1, r => Math.exp(-dt * r)), e2: Float64Array.from(r2, r => Math.exp(-dt * r)) };
        if (relaxation.size >= 32) relaxation.clear();
        relaxation.set(dt, entry);
        return entry;
    }

    function free(dk: ArrayLike<number>, dt: number, m1: ArrayLike<number>, m2: number): void {
        const { e1, e2 } = factors(dt);
        for (let i = 0; i < F.count; i++) {
            if (anyDiffusion) {
                // b over the interval for this configuration: 4π²(|k₀|²Δt + 2k₀·∫K dt + Σ∫K² dt).
                const kx = F.k[3 * i], ky = F.k[3 * i + 1], kz = F.k[3 * i + 2];
                diffuse(FOUR_PI2 * ((kx * kx + ky * ky + kz * kz) * dt + 2 * (kx * m1[0] + ky * m1[1] + kz * m1[2]) + m2));
            }
            F.k[3 * i] += dk[0]; F.k[3 * i + 1] += dk[1]; F.k[3 * i + 2] += dk[2];
            F.tau[i] += dt;
            let o = 2 * L * i;
            for (let c = 0; c < C; c++) {
                const d = anyDiffusion ? e2[c] * attenuation[c] : e2[c];
                for (let j = 0; j < K; j++, o += 2) { F.amp[o] *= d; F.amp[o + 1] *= d; }
            }
        }
        let zero = -1;
        for (let i = 0; i < Z.count; i++) {
            const kx = Z.k[3 * i], ky = Z.k[3 * i + 1], kz = Z.k[3 * i + 2];
            if (kx === 0 && ky === 0 && kz === 0 && Z.tau[i] === 0) zero = i;
            if (anyDiffusion) diffuse(FOUR_PI2 * (kx * kx + ky * ky + kz * kz) * dt);
            let o = 2 * L * i;
            for (let c = 0; c < C; c++) {
                const d = anyDiffusion ? e1[c] * attenuation[c] : e1[c];
                for (let j = 0; j < K; j++, o += 2) { Z.amp[o] *= d; Z.amp[o + 1] *= d; }
            }
        }
        if (zero < 0) zero = Z.add(0, 0, 0, 0);
        let o = 2 * L * zero;
        for (let c = 0; c < C; c++) {
            const add = 1 - e1[c];
            for (let j = 0; j < K; j++, o += 2) Z.amp[o] += add;
        }
    }

    /** e^{−b·D} per class into `attenuation`. */
    function diffuse(b: number): void {
        for (let c = 0; c < C; c++) attenuation[c] = diffusion[c] > 0 && b > 0 ? Math.exp(-b * diffusion[c]) : 1;
    }

    /**
     * Diffusion over half a pulse (before or after its centre): F at its k
     * with the half's own gradient, Z at its k. Relaxation is in the operator.
     */
    function diffuseHalf(moments: SegmentMoments, dt: number): void {
        if (!(dt > 0)) return;
        let m2 = 0;
        for (let a = 0; a < 3; a++) m2 += moments.kSecond[a];
        const m1 = moments.kIntegral;
        for (const [states, moving] of [[F, true], [Z, false]] as const) {
            for (let i = 0; i < states.count; i++) {
                const kx = states.k[3 * i], ky = states.k[3 * i + 1], kz = states.k[3 * i + 2];
                const b = moving
                    ? FOUR_PI2 * ((kx * kx + ky * ky + kz * kz) * dt + 2 * (kx * m1[0] + ky * m1[1] + kz * m1[2]) + m2)
                    : FOUR_PI2 * (kx * kx + ky * ky + kz * kz) * dt;
                if (!(b > 0)) continue;
                diffuse(b);
                let o = 2 * L * i;
                for (let c = 0; c < C; c++) {
                    const d = attenuation[c];
                    for (let j = 0; j < K; j++, o += 2) { states.amp[o] *= d; states.amp[o + 1] *= d; }
                }
            }
        }
    }

    // ─── RF ─────────────────────────────────────────────────────────────
    function buildOperator(segment: RfSegment): Float64Array {
        const cells = rfCells(segment, 0);
        for (let j = 0; j < cells.count; j++) {
            if (cells.grad[3 * j] !== 0 || cells.grad[3 * j + 1] !== 0) {
                throw new Error('The phase-graph engine cannot simulate RF pulses played with x or y gradients (in-plane selective excitation); use the isochromat engine.');
            }
        }
        const pre = segment.kToCenter[2], post = segment.moments.dk[2] - segment.kToCenter[2];
        const tPre = segment.centerTime - segment.t0, tPost = segment.t1 - segment.centerTime;
        const out = new Float64Array(COEFFICIENTS * L);
        const one: SpinSet = {
            count: 1, x: Float64Array.of(0), y: Float64Array.of(0), z: Float64Array.of(0),
            df: Float64Array.of(0), r1: Float64Array.of(0), r2: Float64Array.of(0), weight: Float64Array.of(1),
            b1Re: Float64Array.of(1), b1Im: Float64Array.of(0), coils: 1, rxRe: Float64Array.of(1), rxIm: Float64Array.of(0),
        };
        for (let c = 0; c < C; c++) {
            const cls = classes[c];
            one.df[0] = cls.df; one.r1[0] = r1[c]; one.r2[0] = r2[c]; one.b1Re[0] = cls.b1Re; one.b1Im[0] = cls.b1Im;
            for (let j = 0; j < K; j++) {
                const z = slices.z[j];
                one.z[0] = z;
                const c0 = stepRfVector(cells, one, 0, 0, 0, 0);
                const ex = stepRfVector(cells, one, 0, 1, 0, 0);
                const ey = stepRfVector(cells, one, 0, 0, 1, 0);
                const ez = stepRfVector(cells, one, 0, 0, 0, 1);
                // A (affine linear part), then R̃ = Rz(−a_post)·A·Rz(−a_pre): the precession
                // up to and after the centre (gradient at z, the class's off-resonance) moves
                // into the states' k and τ.
                const a = [ex[0] - c0[0], ey[0] - c0[0], ez[0] - c0[0], ex[1] - c0[1], ey[1] - c0[1], ez[1] - c0[1], ex[2] - c0[2], ey[2] - c0[2], ez[2] - c0[2]];
                const aPre = TWO_PI * (pre * z + cls.df * tPre), aPost = TWO_PI * (post * z + cls.df * tPost);
                const cp = Math.cos(-aPre), sp = Math.sin(-aPre), cq = Math.cos(-aPost), sq = Math.sin(-aPost);
                // A·Rz(θ): columns 0,1 mix.
                const m = a.slice();
                for (let row = 0; row < 3; row++) {
                    const u = a[3 * row], v = a[3 * row + 1];
                    m[3 * row] = u * cp + v * sp;
                    m[3 * row + 1] = -u * sp + v * cp;
                }
                // Rz(φ)·M: rows 0,1 mix.
                const r = m.slice();
                for (let col = 0; col < 3; col++) {
                    const u = m[col], v = m[3 + col];
                    r[col] = u * cq - v * sq;
                    r[3 + col] = u * sq + v * cq;
                }
                const ctx = c0[0] * cq - c0[1] * sq, cty = c0[0] * sq + c0[1] * cq;
                const o = COEFFICIENTS * (c * K + j);
                const R00 = r[0], R01 = r[1], R02 = r[2], R10 = r[3], R11 = r[4], R12 = r[5], R20 = r[6], R21 = r[7], R22 = r[8];
                out[o] = 0.5 * (R00 + R11); out[o + 1] = 0.5 * (R10 - R01);     // A
                out[o + 2] = 0.5 * (R00 - R11); out[o + 3] = 0.5 * (R10 + R01); // B
                out[o + 4] = R02; out[o + 5] = R12;                              // C
                out[o + 6] = R20; out[o + 7] = -R21;                             // D
                out[o + 8] = R22;                                                // E
                out[o + 9] = ctx; out[o + 10] = cty; out[o + 11] = c0[2];        // recovery
            }
        }
        operators.set(segment.key, out);
        return out;
    }

    function pulse(segment: RfSegment, coefficients: Float64Array): void {
        const pre = segment.kToCenter, total = segment.moments.dk;
        const tPre = segment.centerTime - segment.t0, tPost = segment.t1 - segment.centerTime;
        let half: { pre: SegmentMoments; post: SegmentMoments } | undefined;
        if (anyDiffusion) {
            half = halves.get(segment.key);
            if (!half) {
                half = {
                    pre: windowMoments(segment.gradient, segment.t0, segment.centerTime),
                    post: windowMoments(segment.gradient, segment.centerTime, segment.t1),
                };
                halves.set(segment.key, half);
            }
            diffuseHalf(half.pre, tPre);
        }
        for (let i = 0; i < F.count; i++) { F.k[3 * i] += pre[0]; F.k[3 * i + 1] += pre[1]; F.k[3 * i + 2] += pre[2]; F.tau[i] += tPre; }
        const phi = segment.phaseOffset;
        const p1r = Math.cos(phi), p1i = Math.sin(phi), p2r = Math.cos(2 * phi), p2i = Math.sin(2 * phi);

        // Index the states by quantized (k, τ).
        const fTable = new KeyTable(F.count), zTable = new KeyTable(Z.count);
        const fq = new Float64Array(4 * F.count), zq = new Float64Array(4 * Z.count);
        for (let i = 0; i < F.count; i++) {
            const a = qk(F.k[3 * i]), b = qk(F.k[3 * i + 1]), c = qk(F.k[3 * i + 2]), d = qt(F.tau[i]);
            fq[4 * i] = a; fq[4 * i + 1] = b; fq[4 * i + 2] = c; fq[4 * i + 3] = d;
            const owner = fTable.claim(a, b, c, d, i);
            if (owner !== i) addInto(F, owner, i);             // equal keys merge
        }
        for (let i = 0; i < Z.count; i++) {
            const a = qk(Z.k[3 * i]), b = qk(Z.k[3 * i + 1]), c = qk(Z.k[3 * i + 2]), d = qt(Z.tau[i]);
            zq[4 * i] = a; zq[4 * i + 1] = b; zq[4 * i + 2] = c; zq[4 * i + 3] = d;
            const owner = zTable.claim(a, b, c, d, i);
            if (owner !== i) addInto(Z, owner, i);
        }
        // Every key a new state can sit at: F keys, their negatives, Z keys.
        const keys = new KeyTable(2 * F.count + Z.count);
        const list: number[] = [];      // quantized keys, 4 per entry, plus exact (k, τ) from a representative
        const exact: number[] = [];
        const visit = (a: number, b: number, c: number, d: number, kx: number, ky: number, kz: number, tau: number) => {
            const n = list.length / 4;
            if (keys.claim(a, b, c, d, n) === n) { list.push(a, b, c, d); exact.push(kx, ky, kz, tau); }
        };
        for (let i = 0; i < F.count; i++) {
            if (fTable.get(fq[4 * i], fq[4 * i + 1], fq[4 * i + 2], fq[4 * i + 3]) !== i) continue;
            visit(fq[4 * i], fq[4 * i + 1], fq[4 * i + 2], fq[4 * i + 3], F.k[3 * i], F.k[3 * i + 1], F.k[3 * i + 2], F.tau[i]);
            visit(-fq[4 * i] + 0, -fq[4 * i + 1] + 0, -fq[4 * i + 2] + 0, -fq[4 * i + 3] + 0, -F.k[3 * i], -F.k[3 * i + 1], -F.k[3 * i + 2], -F.tau[i]);
        }
        for (let i = 0; i < Z.count; i++) {
            if (zTable.get(zq[4 * i], zq[4 * i + 1], zq[4 * i + 2], zq[4 * i + 3]) !== i) continue;
            visit(zq[4 * i], zq[4 * i + 1], zq[4 * i + 2], zq[4 * i + 3], Z.k[3 * i], Z.k[3 * i + 1], Z.k[3 * i + 2], Z.tau[i]);
        }

        // Per-lane coefficients with this event's phase offset.
        const rot = new Float64Array(COEFFICIENTS * L);
        for (let lane = 0; lane < L; lane++) {
            const o = COEFFICIENTS * lane;
            const Br = coefficients[o + 2], Bi = coefficients[o + 3], Cr = coefficients[o + 4], Ci = coefficients[o + 5];
            const Dr = coefficients[o + 6], Di = coefficients[o + 7], cr = coefficients[o + 9], ci = coefficients[o + 10];
            rot[o] = coefficients[o]; rot[o + 1] = coefficients[o + 1];
            rot[o + 2] = Br * p2r - Bi * p2i; rot[o + 3] = Br * p2i + Bi * p2r;
            rot[o + 4] = Cr * p1r - Ci * p1i; rot[o + 5] = Cr * p1i + Ci * p1r;
            rot[o + 6] = Dr * p1r + Di * p1i; rot[o + 7] = Di * p1r - Dr * p1i;
            rot[o + 8] = coefficients[o + 8];
            rot[o + 9] = cr * p1r - ci * p1i; rot[o + 10] = cr * p1i + ci * p1r;
            rot[o + 11] = coefficients[o + 11];
        }

        const count = list.length / 4;
        const nextF = new States(L, Math.max(64, count)), nextZ = new States(L, Math.max(64, count));
        const fPeaks: number[] = [], zPeaks: number[] = [];
        for (let u = 0; u < count; u++) {
            const a = list[4 * u], b = list[4 * u + 1], c = list[4 * u + 2], d = list[4 * u + 3];
            const fi = fTable.get(a, b, c, d), mi = fTable.get(-a + 0, -b + 0, -c + 0, -d + 0), zi = zTable.get(a, b, c, d);
            const isZero = a === 0 && b === 0 && c === 0 && d === 0;
            const nf = nextF.add(exact[4 * u], exact[4 * u + 1], exact[4 * u + 2], exact[4 * u + 3]);
            const nz = nextZ.add(exact[4 * u], exact[4 * u + 1], exact[4 * u + 2], exact[4 * u + 3]);
            const fo = fi >= 0 ? 2 * L * fi : -1, mo = mi >= 0 ? 2 * L * mi : -1, zo = zi >= 0 ? 2 * L * zi : -1;
            const no = 2 * L * nf, wo = 2 * L * nz;
            let fPeak = 0, zPeak = 0;
            for (let lane = 0; lane < L; lane++) {
                const o = COEFFICIENTS * lane;
                const fr = fo >= 0 ? F.amp[fo + 2 * lane] : 0, fim = fo >= 0 ? F.amp[fo + 2 * lane + 1] : 0;
                const mr = mo >= 0 ? F.amp[mo + 2 * lane] : 0, mim = mo >= 0 ? -F.amp[mo + 2 * lane + 1] : 0;   // conj F_(−k,−τ)
                const zr = zo >= 0 ? Z.amp[zo + 2 * lane] : 0, zim = zo >= 0 ? Z.amp[zo + 2 * lane + 1] : 0;
                const Ar = rot[o], Ai = rot[o + 1], Br = rot[o + 2], Bi = rot[o + 3], Cr = rot[o + 4], Ci = rot[o + 5];
                const Dr = rot[o + 6], Di = rot[o + 7], E = rot[o + 8];
                let nr = Ar * fr - Ai * fim + Br * mr - Bi * mim + Cr * zr - Ci * zim;
                let ni = Ar * fim + Ai * fr + Br * mim + Bi * mr + Cr * zim + Ci * zr;
                let wr = 0.5 * (Dr * fr - Di * fim + Dr * mr + Di * mim) + E * zr;
                const wi = 0.5 * (Dr * fim + Di * fr + Dr * mim - Di * mr) + E * zim;
                if (isZero) { nr += rot[o + 9]; ni += rot[o + 10]; wr += rot[o + 11]; }
                nextF.amp[no + 2 * lane] = nr; nextF.amp[no + 2 * lane + 1] = ni;
                nextZ.amp[wo + 2 * lane] = wr; nextZ.amp[wo + 2 * lane + 1] = wi;
                const pf = Math.max(Math.abs(nr), Math.abs(ni)), pz = Math.max(Math.abs(wr), Math.abs(wi));
                if (pf > fPeak) fPeak = pf;
                if (pz > zPeak) zPeak = pz;
            }
            fPeaks.push(isZero ? Infinity : fPeak);
            zPeaks.push(isZero ? Infinity : zPeak);
        }
        F = keepStrongest(nextF, fPeaks, false);
        Z = keepStrongest(nextZ, zPeaks, true);
        if (half) diffuseHalf(half.post, tPost);
        for (let i = 0; i < F.count; i++) {
            F.k[3 * i] += total[0] - pre[0]; F.k[3 * i + 1] += total[1] - pre[1]; F.k[3 * i + 2] += total[2] - pre[2];
            F.tau[i] += tPost;
        }
    }

    function addInto(states: States, owner: number, other: number): void {
        const a = 2 * L * owner, b = 2 * L * other;
        for (let o = 0; o < 2 * L; o++) { states.amp[a + o] += states.amp[b + o]; states.amp[b + o] = 0; }
    }

    function keepStrongest(states: States, peaks: number[], keepZero: boolean): States {
        // The level the strongest maxStates reach (typed sort: native and numeric), then those in index order.
        let level = prune;
        let candidates = 0;
        for (let i = 0; i < states.count; i++) if (peaks[i] >= prune || (keepZero && peaks[i] === Infinity)) candidates++;
        if (candidates > maxStates) {
            const sorted = Float64Array.from(peaks).sort();
            level = Math.max(prune, sorted[sorted.length - maxStates]);
        }
        const keep: number[] = [];
        for (let i = 0; i < states.count && keep.length < maxStates; i++) {
            if (peaks[i] >= level || (keepZero && peaks[i] === Infinity)) keep.push(i);
        }
        if (keep.length !== states.count) states.compact(keep);
        return states;
    }

    // ─── Readout ────────────────────────────────────────────────────────
    /**
     * Configurations that share their in-plane k (and τ, when voxels differ
     * in B0) emit alike in-plane: they are summed first, each weighted by its
     * slab integral, and synthesised together.
     */
    function readout(segment: AdcSegment): void {
        const n = segment.numSamples;
        const times = adcSampleTimes(segment);
        const k = new Float64Array(3 * n);
        piecesKAt(segment.gradient, times, k);
        const groups = grouper.groups(segment.activeAxes);
        const sumRe = new Float64Array(n * coils), sumIm = new Float64Array(n * coils);
        if ((segment.activeAxes & 4) !== 0) {
            readoutAlongZ(segment, k, times, groups, sumRe, sumIm);
            emitReadout(segment, sumRe, sumIm, coils, signal, sampleOffset);
            return;
        }
        // The k the readout sweeps, per axis: bounds the box voxel's response without evaluating it.
        const kMin = [Infinity, Infinity], kMax = [-Infinity, -Infinity];
        for (let i = 0; i < n; i++) {
            for (let a = 0; a < 2; a++) { kMin[a] = Math.min(kMin[a], k[3 * i + a]); kMax[a] = Math.max(kMax[a], k[3 * i + a]); }
        }
        const shapeBound = (kx: number, ky: number) => boxBound(kx + kMin[0], kx + kMax[0], model.voxel[0]) * boxBound(ky + kMin[1], ky + kMax[1], model.voxel[1]);
        // Lane-wise slab-weighted amplitudes per emitting group: G[lane] = Σ_σ W_j(k_z,σ)·F_σ[lane].
        const table = new KeyTable(F.count);
        const groupK: number[] = [];
        let G = new Float64Array(2 * L * Math.max(8, Math.min(F.count, 64)));
        let count = 0;
        // A configuration far below the pruning level even at its voxel response's bound cannot matter.
        const floor = 1e-2 * prune;
        for (let s = 0; s < F.count; s++) {
            if (shapeBound(F.k[3 * s], F.k[3 * s + 1]) * F.peak(s) < floor) continue;
            const a = qk(F.k[3 * s]), b = qk(F.k[3 * s + 1]), d = anyB0 || anyT2p ? qt(F.tau[s]) : 0;
            const g = table.claim(a, b, 0, d, count);
            if (g === count) {
                count++;
                groupK.push(F.k[3 * s], F.k[3 * s + 1], F.tau[s]);
                if (2 * L * count > G.length) { const grown = new Float64Array(2 * G.length); grown.set(G); G = grown; }
            }
            const weights = slabWeights(F.k[3 * s + 2]);
            const o = 2 * L * s, go = 2 * L * g;
            for (let c = 0; c < C; c++) {
                for (let j = 0; j < K; j++) {
                    const lane = 2 * (c * K + j);
                    const fr = F.amp[o + lane], fi = F.amp[o + lane + 1];
                    const wr = weights[2 * j], wi = weights[2 * j + 1];
                    G[go + lane] += fr * wr - fi * wi;
                    G[go + lane + 1] += fr * wi + fi * wr;
                }
            }
        }
        const tmpRe = new Float64Array(n * coils), tmpIm = new Float64Array(n * coils);
        const shape = new Float64Array(n);
        const perClass = new Float64Array(2 * C);
        const classFactor = new Float64Array(C).fill(1);
        const tauFirst = times[0] - segment.t0, tauLast = times[n - 1] - segment.t0;
        const buffers = new Map<ReadoutGrouper, { groups: ReturnType<ReadoutGrouper['groups']>; gRe: Float64Array; gIm: Float64Array }>();
        const bufferFor = (which: ReadoutGrouper) => {
            let entry = buffers.get(which);
            if (!entry) {
                const gs = which.groups(segment.activeAxes);
                entry = { groups: gs, gRe: new Float64Array(gs.count * coils), gIm: new Float64Array(gs.count * coils) };
                buffers.set(which, entry);
            }
            return entry;
        };
        for (let g = 0; g < count; g++) {
            const go = 2 * L * g;
            let peak = 0;
            for (let o = go; o < go + 2 * L; o++) peak = Math.max(peak, Math.abs(G[o]));
            if (!(peak > 0)) continue;
            if (shapeBound(groupK[3 * g], groupK[3 * g + 1]) * peak < prune) continue;
            // The box voxel's response along the readout; skip what cannot matter.
            let shapePeak = 0;
            for (let i = 0; i < n; i++) {
                shape[i] = sinc((groupK[3 * g] + k[3 * i]) * model.voxel[0]) * sinc((groupK[3 * g + 1] + k[3 * i + 1]) * model.voxel[1]);
                shapePeak = Math.max(shapePeak, Math.abs(shape[i]));
            }
            if (shapePeak * peak < prune) continue;
            stats.emitted++;
            if (fullRange) {
                for (let c = 0; c < C; c++) {
                    let ar = 0, ai = 0;
                    for (let j = 0; j < K; j++) { ar += G[go + 2 * (c * K + j)]; ai += G[go + 2 * (c * K + j) + 1]; }
                    perClass[2 * c] = ar; perClass[2 * c + 1] = ai;
                }
            }
            phaseTables(groupK[3 * g], groupK[3 * g + 1]);
            const tau = groupK[3 * g + 2];
            // Without T2′ one synthesis; with it, before and/or after the echo (τ + t = 0).
            const branches: { grouper: ReadoutGrouper; sign: number; from: number; to: number }[] = [];
            if (!anyT2p || tau + tauFirst >= 0) {
                branches.push({ grouper: after, sign: 1, from: 0, to: n });
            } else if (tau + tauLast <= 0) {
                branches.push({ grouper: before, sign: -1, from: 0, to: n });
            } else {
                let cross = 0;
                while (cross < n && tau + times[cross] - segment.t0 < 0) cross++;
                branches.push({ grouper: before, sign: -1, from: 0, to: cross }, { grouper: after, sign: 1, from: cross, to: n });
            }
            for (const branch of branches) {
                const { groups, gRe, gIm } = bufferFor(branch.grouper);
                for (let c = 0; c < C; c++) classFactor[c] = r2p[c] > 0 ? Math.exp(-branch.sign * r2p[c] * tau) : 1;
                gRe.fill(0); gIm.fill(0);
                let any = false;
                for (let i = 0; i < sources.count; i++) {
                    const c = sources.classOf[i];
                    let ar: number, ai: number;
                    if (fullRange) {
                        ar = perClass[2 * c]; ai = perClass[2 * c + 1];
                    } else {
                        ar = 0; ai = 0;
                        for (let j = sources.sliceFrom[i]; j < sources.sliceTo[i]; j++) { ar += G[go + 2 * (c * K + j)]; ai += G[go + 2 * (c * K + j) + 1]; }
                    }
                    if (ar === 0 && ai === 0) continue;
                    any = true;
                    if (classFactor[c] !== 1) { ar *= classFactor[c]; ai *= classFactor[c]; }
                    // e^{i2π(kx·x + ky·y)} from the tables, then e^{i2πΔf·τ} where voxels differ in B0.
                    const xi = xs.of[i], yi = ys.of[i];
                    let pr = xRe[xi] * yRe[yi] - xIm[xi] * yIm[yi], pi = xRe[xi] * yIm[yi] + xIm[xi] * yRe[yi];
                    if (anyB0 && sources.df[i] !== 0) {
                        const cyc = sources.df[i] * tau, a = TWO_PI * (cyc - Math.round(cyc));
                        const cr = Math.cos(a), ci = Math.sin(a);
                        const nr = pr * cr - pi * ci;
                        pi = pr * ci + pi * cr;
                        pr = nr;
                    }
                    const pd = sources.pd[i];
                    const vr = (ar * pr - ai * pi) * pd, vi = (ar * pi + ai * pr) * pd;
                    const gg = groups.groupOf[i];
                    for (let cc = 0; cc < coils; cc++) {
                        const rr = sources.rxRe[cc * sources.count + i], ri = -sources.rxIm[cc * sources.count + i];
                        gRe[gg * coils + cc] += rr * vr - ri * vi;
                        gIm[gg * coils + cc] += rr * vi + ri * vr;
                    }
                }
                if (!any) continue;
                tmpRe.fill(0); tmpIm.fill(0);
                synthesizeReadout(segment, groups, gRe, gIm, coils, k, times, tmpRe, tmpIm, true);
                for (let i = branch.from; i < branch.to; i++) {
                    const v = shape[i];
                    for (let c = 0; c < coils; c++) { sumRe[i * coils + c] += v * tmpRe[i * coils + c]; sumIm[i * coils + c] += v * tmpIm[i * coils + c]; }
                }
            }
        }
        emitReadout(segment, sumRe, sumIm, coils, signal, sampleOffset);
    }

    /**
     * A readout with a gradient along z (3-D encoding): the slab integral
     * changes per sample, so each configuration and sample is summed directly.
     */
    function readoutAlongZ(
        segment: AdcSegment, k: Float64Array, times: Float64Array, groups: ReturnType<ReadoutGrouper['groups']>,
        sumRe: Float64Array, sumIm: Float64Array,
    ): void {
        const n = segment.numSamples;
        const gRe = new Float64Array(groups.count * coils), gIm = new Float64Array(groups.count * coils);
        for (let s = 0; s < F.count; s++) {
            if (F.peak(s) < prune) continue;
            stats.emitted++;
            const o = 2 * L * s;
            for (let t = 0; t < n; t++) {
                const shape = sinc((F.k[3 * s] + k[3 * t]) * model.voxel[0]) * sinc((F.k[3 * s + 1] + k[3 * t + 1]) * model.voxel[1]);
                if (shape === 0) continue;
                const weights = slabWeights(F.k[3 * s + 2] + k[3 * t + 2]);
                const tau = times[t] - segment.t0;
                gRe.fill(0); gIm.fill(0);
                for (let i = 0; i < sources.count; i++) {
                    const c = sources.classOf[i];
                    let ar = 0, ai = 0;
                    for (let j = sources.sliceFrom[i]; j < sources.sliceTo[i]; j++) {
                        const fr = F.amp[o + 2 * (c * K + j)], fi = F.amp[o + 2 * (c * K + j) + 1];
                        ar += fr * weights[2 * j] - fi * weights[2 * j + 1];
                        ai += fr * weights[2 * j + 1] + fi * weights[2 * j];
                    }
                    if (ar === 0 && ai === 0) continue;
                    // T2′ at this sample, per class: e^{−|τ_σ + t|/T2′}.
                    const lorentz = r2p[c] > 0 ? Math.exp(-r2p[c] * Math.abs(F.tau[s] + tau)) : 1;
                    accumulate(i, F.k[3 * s], F.k[3 * s + 1], F.tau[s], ar * lorentz, ai * lorentz, groups.groupOf[i], gRe, gIm);
                }
                // The groups' phase at this one sample (positions, own Δf, decay).
                for (let g = 0; g < groups.count; g++) {
                    const cycles = k[3 * t] * groups.x[g] + k[3 * t + 1] * groups.y[g] + groups.df[g] * tau;
                    const angle = TWO_PI * (cycles - Math.round(cycles));
                    const decay = Math.exp(-tau * groups.r2[g]) * shape;
                    const er = Math.cos(angle) * decay, ei = Math.sin(angle) * decay;
                    for (let c = 0; c < coils; c++) {
                        const ar = gRe[g * coils + c], ai = gIm[g * coils + c];
                        sumRe[t * coils + c] += ar * er - ai * ei;
                        sumIm[t * coils + c] += ar * ei + ai * er;
                    }
                }
            }
        }
    }

    /** Add source i's emission of a configuration at in-plane (kx, ky) and τ with slab amplitude (ar, ai): PD·e^{i2π(k·r + Δf·τ)}·conj(B1−). */
    function accumulate(i: number, kx: number, ky: number, tau: number, ar: number, ai: number, g: number, gRe: Float64Array, gIm: Float64Array): void {
        const cycles = kx * sources.x[i] + ky * sources.y[i] + sources.df[i] * tau;
        const angle = TWO_PI * (cycles - Math.round(cycles));
        const pd = sources.pd[i];
        const er = Math.cos(angle) * pd, ei = Math.sin(angle) * pd;
        const vr = ar * er - ai * ei, vi = ar * ei + ai * er;
        for (let c = 0; c < coils; c++) {
            const rr = sources.rxRe[c * sources.count + i], ri = -sources.rxIm[c * sources.count + i];
            gRe[g * coils + c] += rr * vr - ri * vi;
            gIm[g * coils + c] += rr * vi + ri * vr;
        }
    }

    /** slabWeightsAt, cached by q (rounded to K_QUANTUM). */
    function slabWeights(q: number): Float64Array {
        const key = qk(q);
        let w = slabCache.get(key);
        if (!w) {
            if (slabCache.size > 65536) slabCache.clear();
            w = slabWeightsAt(key * K_QUANTUM);
            slabCache.set(key, w);
        }
        return w;
    }

    /** ∫F(z)·e^{i2πqz}dz / reference as complex weights on the sub-slice samples (piecewise-linear F, Filon). */
    function slabWeightsAt(q: number): Float64Array {
        const w = new Float64Array(2 * K);
        const z = slices.z, ref = slices.reference;
        if (K === 1) {
            const a = TWO_PI * q * z[0];
            w[0] = slices.weight[0] * Math.cos(a); w[1] = slices.weight[0] * Math.sin(a);
            return w;
        }
        const width = (j: number) => slices.weight[j] * ref;
        const omega = TWO_PI * q;
        let start = 0;
        while (start < K) {
            let end = start;
            while (end + 1 < K && z[end + 1] - z[end] <= 0.51 * (width(end) + width(end + 1)) + 1e-12) end++;
            cap(w, start, z[start] - width(start) / 2, z[start], omega, ref);
            cap(w, end, z[end], z[end] + width(end) / 2, omega, ref);
            for (let j = start; j < end; j++) {
                const h = z[j + 1] - z[j];
                const [j0r, j0i] = J0(omega, h), [j1r, j1i] = J1(omega, h);
                const er = Math.cos(omega * z[j]), ei = Math.sin(omega * z[j]);
                const fr = j0r - j1r, fi = j0i - j1i;
                w[2 * j] += (er * fr - ei * fi) / ref;
                w[2 * j + 1] += (er * fi + ei * fr) / ref;
                w[2 * (j + 1)] += (er * j1r - ei * j1i) / ref;
                w[2 * (j + 1) + 1] += (er * j1i + ei * j1r) / ref;
            }
            start = end + 1;
        }
        return w;
    }
}

/** ∫_a^b e^{iωz}dz added to sub-slice j's weight (a flat end cap of the piecewise-linear profile). */
function cap(w: Float64Array, j: number, a: number, b: number, omega: number, ref: number): void {
    const [cr, ci] = J0(omega, b - a);
    const er = Math.cos(omega * a), ei = Math.sin(omega * a);
    w[2 * j] += (er * cr - ei * ci) / ref;
    w[2 * j + 1] += (er * ci + ei * cr) / ref;
}

/** ∫_0^h e^{iωu}du. */
function J0(omega: number, h: number): [number, number] {
    const x = omega * h;
    if (Math.abs(x) < 1e-4) return [h * (1 - x * x / 6), h * (x / 2 - x * x * x / 24)];
    return [Math.sin(x) / omega, (1 - Math.cos(x)) / omega];
}

/** ∫_0^h (u/h)·e^{iωu}du. */
function J1(omega: number, h: number): [number, number] {
    const x = omega * h;
    if (Math.abs(x) < 1e-4) return [h * (0.5 - x * x / 8), h * (x / 3 - x * x * x / 30)];
    const c = Math.cos(x), s = Math.sin(x);
    return [h * (c + x * s - 1) / (x * x), h * (s - x * c) / (x * x)];
}

/** Largest |sinc(q·size)| for q in [lo, hi]: 1 if the range holds 0, else the 1/(π|q|) envelope (≤ 1). */
function boxBound(lo: number, hi: number, size: number): number {
    if (size === 0 || (lo <= 0 && hi >= 0)) return 1;
    const nearest = Math.min(Math.abs(lo), Math.abs(hi)) * size;
    return nearest > 0 ? Math.min(1, 1 / (Math.PI * nearest)) : 1;
}

/** sin(πx)/(πx). */
function sinc(x: number): number {
    if (x === 0) return 1;
    const px = Math.PI * x;
    return Math.abs(px) < 1e-6 ? 1 - px * px / 6 : Math.sin(px) / px;
}
