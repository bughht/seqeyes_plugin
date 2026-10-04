/**
 * A simulation job: one sequence and one built-in phantom, split into chunks
 * that simulate independently and sum to the signal.
 *
 * Planning, once per job:
 *   - spins per voxel: axes the sequence spoils get a count measured by the
 *     probe (plan/probe.ts); others need only enough to resolve the readout;
 *   - folding: axes the sequence rewinds before every pulse (a Cartesian phase
 *     encode) fold, so spins along them share one simulated class
 *     (engine/spins.ts, SpinMembers). A 2D GRE then simulates one row of
 *     spins per tissue per column instead of every voxel;
 *   - chunks: whole columns (rows) when y (x) folds, else voxels in readout
 *     order, so classes and readout groups stay inside a chunk.
 * The split depends only on the settings, never on the worker count, and
 * chunk signals are added in chunk order (ChunkAccumulator). A result is
 * therefore bit-identical however many workers produced it.
 */

import { parseSequenceBytes } from '../pulseq/sequenceReader';
import { simulateReference, type SimulationOptions } from './engine/reference';
import type { SpinMembers, SpinSet } from './engine/spins';
import { nonEmptyVoxels, sheppLoganPhantom, spinsFromGrid2D, type VoxelGrid2D } from './phantom/builtin';
import { analyzeDephasing, foldableAxes, intervalCycles, resolutionCount, type DephasingAnalysis } from './plan/dephasing';
import { probeSubSpins, type ProbeResult } from './plan/probe';
import { compileProgram, type SimProgram } from './program/compile';
import type { SimSegment } from './program/types';
import { reconstructCartesian, type CartesianRecon } from './recon/cartesian';
import { adcTrajectory, type AdcTrajectory } from './recon/trajectory';

export interface JobSettings {
    phantom: 'shepp-logan';
    /** Phantom matrix, n × n. */
    size: number;
    /** Phantom field of view [m]; default the sequence's FOV definition, else 0.256 m. */
    fov?: [number, number];
    /** Spins per voxel along x and y, or 'auto'. */
    subSpins: 'auto' | [number, number];
    /** Largest count 'auto' may choose per axis (default 2048). */
    maxSubSpins?: number;
}

/** Why an axis has the spin count it has. */
export type SubSpinReason = 'manual' | 'spoiling' | 'resolution' | 'none';

export interface AxisPlan {
    count: number;
    reason: SubSpinReason;
    /** Folded: spins along it share their class's simulation. */
    folded: boolean;
    /** Spoiled axes: the probe's verdict. */
    probe?: { error: number; reference: number; capped: boolean; tested: { count: number; error: number }[] };
}

export interface JobPlan {
    blocks: number;
    duration: number;
    rfEvents: number;
    adcEvents: number;
    adcSamples: number;
    phantom: { nx: number; ny: number; fov: [number, number]; voxels: number; tissues: number };
    axes: [AxisPlan, AxisPlan];
    /** Spins per voxel along x and y. */
    subSpins: [number, number];
    /** Spins in the phantom (every voxel × sub-spins). */
    spins: number;
    /** Spins actually simulated (classes; equals `spins` when nothing folds). */
    simulated: number;
    chunks: number;
    coils: number;
    /** Physics and sequence features this run does not represent, and caveats. */
    notes: string[];
}

export interface RawMatrix {
    /** Readouts × the longest readout, row-major; shorter readouts are zero-padded. */
    rows: number;
    columns: number;
    magnitude: Float32Array;
}

/** Phantom spins beyond which a job is refused. */
export const MAX_JOB_SPINS = 32_000_000;
/** Simulated spins (classes) beyond which a job is refused. */
export const MAX_JOB_SIMULATED = 4_000_000;
/** Chunks hold at least this many spins, and a job has at most MAX_CHUNKS of them. */
const MIN_CHUNK_SPINS = 16_384;
const MAX_CHUNKS = 64;
/** Programs up to this many blocks keep their segments in memory between chunks. */
const REPLAY_BLOCK_LIMIT = 200_000;

export class SimulationJob {
    readonly program: SimProgram;
    readonly analysis: DephasingAnalysis;
    readonly grid: VoxelGrid2D;
    readonly plan: JobPlan;
    /** Folded axes (bit 0 = x, bit 1 = y). */
    private readonly fold: number;
    /** Tissue index of every voxel (−1 when empty), and the tissues' T1/T2. */
    private readonly tissueOf: Int32Array;
    private readonly tissues: { t1: number; t2: number }[];
    private readonly chunkVoxels: Int32Array[];
    private readonly sequenceFov: [number, number, number] | null;
    private trajectory: AdcTrajectory | null = null;

    constructor(bytes: Uint8Array, name: string, settings: JobSettings) {
        const seq = parseSequenceBytes(bytes, name);
        this.program = replayable(compileProgram(seq));
        this.analysis = analyzeDephasing(this.program);
        if (this.analysis.adcEvents === 0) throw new Error('The sequence has no ADC events, so there is no signal to simulate.');
        const definition = seq.definitions.get('FOV');
        this.sequenceFov = definition && definition.length >= 2 && definition.every(v => Number.isFinite(+v))
            ? [+definition[0], +definition[1], definition.length > 2 ? +definition[2] : 0]
            : null;

        const size = Math.round(settings.size);
        if (!(size >= 2 && size <= 1024)) throw new Error(`Phantom size must be between 2 and 1024, got ${settings.size}.`);
        const fov: [number, number] = settings.fov
            ?? (this.sequenceFov && this.sequenceFov[0] > 0 && this.sequenceFov[1] > 0
                ? [this.sequenceFov[0], this.sequenceFov[1]]
                : [0.256, 0.256]);
        this.grid = sheppLoganPhantom(size, fov[0], fov[1]);
        ({ tissueOf: this.tissueOf, tissues: this.tissues } = tissueTable(this.grid));
        this.fold = foldableAxes(this.analysis, [fov[0], fov[1], 0]) & 3;

        const voxel: [number, number] = [fov[0] / size, fov[1] / size];
        const axes = [0, 1].map(axis => this.planAxis(axis as 0 | 1, voxel[axis], settings)) as [AxisPlan, AxisPlan];
        const subSpins: [number, number] = [axes[0].count, axes[1].count];
        const perVoxel = subSpins[0] * subSpins[1];

        const voxels = nonEmptyVoxels(this.grid);
        const spins = voxels.length * perVoxel;
        if (spins > MAX_JOB_SPINS) {
            throw new Error(`${spins.toLocaleString('en-US')} spins exceed the ${MAX_JOB_SPINS.toLocaleString('en-US')} limit; `
                + 'use a smaller phantom or fewer spins per voxel.');
        }
        const units = this.chunkUnits(voxels);
        const simulated = this.countClasses(units, subSpins);
        if (simulated > MAX_JOB_SIMULATED) {
            throw new Error(`${simulated.toLocaleString('en-US')} simulated spins exceed the `
                + `${MAX_JOB_SIMULATED.toLocaleString('en-US')} limit; use a smaller phantom or fewer spins per voxel.`);
        }
        this.chunkVoxels = splitUnits(units, perVoxel, Math.max(MIN_CHUNK_SPINS, Math.ceil(spins / MAX_CHUNKS)));

        const notes = ['2D phantom: one plane at z = 0, so the slice profile and through-plane dephasing are not simulated.'];
        for (const [axis, plan] of axes.entries()) {
            if (plan.probe?.capped) {
                notes.push(`${'xy'[axis]}: ${plan.count} spins per voxel did not reach the 2 % target `
                    + `(error ${(100 * plan.probe.error).toFixed(0)} %); expect residual stripes from incomplete spoiling.`);
            }
        }
        for (const feature of this.program.ignoredFeatures) notes.push(`Not simulated: ${feature}.`);

        this.plan = {
            blocks: this.program.blockCount,
            duration: this.program.totalDuration,
            rfEvents: this.analysis.rfEvents,
            adcEvents: this.analysis.adcEvents,
            adcSamples: this.analysis.adcSamples,
            phantom: { nx: size, ny: size, fov, voxels: voxels.length, tissues: this.tissues.length },
            axes,
            subSpins,
            spins,
            simulated,
            chunks: this.chunkVoxels.length,
            coils: 1,
            notes,
        };
    }

    /** Simulate one chunk; returns its delivered signal (see SimulationResult.signal). */
    simulateChunk(index: number, options: SimulationOptions = {}): Float64Array {
        const voxels = this.chunkVoxels[index];
        if (!voxels) throw new Error(`No chunk ${index} (the job has ${this.chunkVoxels.length}).`);
        if (!this.fold) {
            const spins = spinsFromGrid2D(this.grid, { subSpins: this.plan.subSpins, voxels });
            return simulateReference(this.program, spins, options).signal;
        }
        const { classes, members } = this.foldChunk(voxels);
        return simulateReference(this.program, classes, { ...options, members }).signal;
    }

    reconstruct(signal: Float64Array): CartesianRecon {
        this.trajectory ??= adcTrajectory(this.program);
        return reconstructCartesian(this.trajectory, signal, this.plan.coils, { fov: this.sequenceFov });
    }

    /** |signal| as readouts × samples, for the raw-data view. */
    rawMagnitude(signal: Float64Array): RawMatrix {
        this.trajectory ??= adcTrajectory(this.program);
        const { readouts, samples, offsets } = this.trajectory;
        let columns = 0;
        for (let r = 0; r < readouts; r++) columns = Math.max(columns, samples[r]);
        const coils = this.plan.coils;
        const magnitude = new Float32Array(readouts * columns);
        for (let r = 0; r < readouts; r++) {
            for (let s = 0; s < samples[r]; s++) {
                let power = 0;
                for (let c = 0; c < coils; c++) {
                    const o = ((offsets[r] + s) * coils + c) * 2;
                    power += signal[o] * signal[o] + signal[o + 1] * signal[o + 1];
                }
                magnitude[r * columns + s] = Math.sqrt(power);
            }
        }
        return { rows: readouts, columns, magnitude };
    }

    private planAxis(axis: 0 | 1, voxel: number, settings: JobSettings): AxisPlan {
        const folded = (this.fold & (1 << axis)) !== 0;
        if (settings.subSpins !== 'auto') {
            return { count: clampCount(settings.subSpins[axis]), reason: 'manual', folded };
        }
        const resolution = resolutionCount(this.analysis, axis, voxel);
        // A folded axis has zero area at every pulse, so nothing to spoil.
        if (folded || intervalCycles(this.analysis, axis, voxel) <= 0.05) {
            return { count: resolution, reason: resolution > 1 ? 'resolution' : 'none', folded };
        }
        const probe: ProbeResult = probeSubSpins(this.program, axis, voxel, this.tissues, {
            minimum: resolution,
            maximum: settings.maxSubSpins,
            intervalCycles: intervalCycles(this.analysis, axis, voxel),
        });
        return {
            count: probe.count,
            reason: probe.count > resolution ? 'spoiling' : (resolution > 1 ? 'resolution' : 'none'),
            folded,
            probe: { error: probe.error, reference: probe.reference, capped: probe.capped, tested: probe.tested },
        };
    }

    /** Voxels grouped into the units chunks are cut from (see the file comment). */
    private chunkUnits(voxels: Int32Array): Int32Array[] {
        const nx = this.grid.nx;
        const byColumn = this.fold === 2 || (this.fold === 0 && (this.analysis.readoutAxes & 7) === 1);
        const byRow = this.fold === 1;
        if (!byColumn && !byRow) return Array.from(voxels, v => Int32Array.of(v));
        const lines = new Map<number, number[]>();
        for (const v of voxels) {
            const line = byColumn ? v % nx : Math.floor(v / nx);
            let list = lines.get(line);
            if (!list) lines.set(line, list = []);
            list.push(v);
        }
        return [...lines.keys()].sort((a, b) => a - b).map(line => Int32Array.from(lines.get(line)!));
    }

    /** Simulated spins over all chunks: classes when folded, else every spin. */
    private countClasses(units: Int32Array[], subSpins: [number, number]): number {
        if (!this.fold) return units.reduce((sum, unit) => sum + unit.length, 0) * subSpins[0] * subSpins[1];
        // Per unit: distinct tissues × sub-positions along the unfolded axes.
        // With both axes folded every unit shares the same few classes; chunks
        // repeat them, which this count ignores.
        const unfolded = (this.fold & 1 ? 1 : subSpins[0]) * (this.fold & 2 ? 1 : subSpins[1]);
        if (this.fold === 3) return this.tissues.length;
        let total = 0;
        for (const unit of units) {
            const seen = new Set<number>();
            for (const v of unit) seen.add(this.tissueOf[v]);
            total += seen.size * unfolded;
        }
        return total;
    }

    /** Classes (one per unfolded sub-position and tissue) and members of a chunk's voxels. */
    private foldChunk(voxels: Int32Array): { classes: SpinSet; members: SpinMembers } {
        const grid = this.grid;
        const [mx, my] = this.plan.subSpins;
        const foldX = (this.fold & 1) !== 0, foldY = (this.fold & 2) !== 0;
        const dx = grid.fovX / grid.nx, dy = grid.fovY / grid.ny;
        const offsetsX = Array.from({ length: mx }, (_, a) => (a + 0.5) / mx - 0.5);
        const offsetsY = Array.from({ length: my }, (_, a) => (a + 0.5) / my - 0.5);
        const lineY = grid.ny * my;

        const memberCount = voxels.length * mx * my;
        const classOf = new Int32Array(memberCount);
        const weight = new Float64Array(memberCount);
        const foldOf = new Int32Array(memberCount);
        const classIndex = new Map<number, number>();
        const pointIndex = new Map<number, number>();
        const classX: number[] = [], classY: number[] = [], classTissue: number[] = [];
        const points: number[] = [];
        let m = 0;
        for (let v = 0; v < voxels.length; v++) {
            const index = voxels[v];
            const ix = index % grid.nx, iy = Math.floor(index / grid.nx);
            const tissue = this.tissueOf[index];
            const w = grid.pd[index] / (mx * my);
            const x0 = (ix - grid.nx / 2) * dx;
            const y0 = (grid.ny / 2 - 1 - iy) * dy;
            for (let ay = 0; ay < my; ay++) {
                const y = y0 + offsetsY[ay] * dy;
                const jy = iy * my + ay;
                for (let ax = 0; ax < mx; ax++) {
                    const x = x0 + offsetsX[ax] * dx;
                    const jx = ix * mx + ax;
                    // Class: tissue and the position along the unfolded axes.
                    const classKey = ((foldX ? 0 : jx) * lineY + (foldY ? 0 : jy)) * this.tissues.length + tissue;
                    let c = classIndex.get(classKey);
                    if (c === undefined) {
                        c = classX.length;
                        classIndex.set(classKey, c);
                        classX.push(foldX ? 0 : x);
                        classY.push(foldY ? 0 : y);
                        classTissue.push(tissue);
                    }
                    // Fold point: the position along the folded axes.
                    const pointKey = (foldX ? jx : 0) * (lineY + 1) + (foldY ? jy : 0);
                    let p = pointIndex.get(pointKey);
                    if (p === undefined) {
                        p = points.length / 3;
                        pointIndex.set(pointKey, p);
                        points.push(foldX ? x : 0, foldY ? y : 0, 0);
                    }
                    classOf[m] = c;
                    weight[m] = w;
                    foldOf[m] = p;
                    m++;
                }
            }
        }
        const count = classX.length;
        const rate = (time: number) => (Number.isFinite(time) && time > 0 ? 1 / time : 0);
        const classes: SpinSet = {
            count,
            x: Float64Array.from(classX), y: Float64Array.from(classY), z: new Float64Array(count),
            df: new Float64Array(count),
            r1: Float64Array.from(classTissue, t => rate(this.tissues[t].t1)),
            r2: Float64Array.from(classTissue, t => rate(this.tissues[t].t2)),
            weight: new Float64Array(count),
            b1Re: new Float64Array(count).fill(1), b1Im: new Float64Array(count),
            coils: 1,
            rxRe: new Float64Array(count).fill(1), rxIm: new Float64Array(count),
        };
        const members: SpinMembers = {
            count: memberCount,
            classOf, weight, foldOf,
            foldPoints: Float64Array.from(points),
            coils: 1,
            rxRe: new Float64Array(memberCount).fill(1), rxIm: new Float64Array(memberCount),
        };
        return { classes, members };
    }
}

/**
 * Sum chunk signals in chunk order. Each chunk is deterministic on its own, so
 * a fixed summation order makes the total independent of who computed what.
 */
export class ChunkAccumulator {
    readonly signal: Float64Array;
    private readonly pending = new Map<number, Float64Array>();
    private next = 0;

    constructor(length: number, readonly chunks: number) {
        this.signal = new Float64Array(length);
    }

    get done(): boolean {
        return this.next >= this.chunks;
    }

    /** Chunks summed so far. */
    get added(): number {
        return this.next;
    }

    add(index: number, signal: Float64Array): void {
        if (!(index >= 0 && index < this.chunks)) throw new Error(`No chunk ${index} (the job has ${this.chunks}).`);
        if (index < this.next || this.pending.has(index)) throw new Error(`Chunk ${index} arrived twice.`);
        if (signal.length !== this.signal.length) throw new Error(`Chunk ${index} has the wrong length.`);
        this.pending.set(index, signal);
        for (let chunk = this.pending.get(this.next); chunk; chunk = this.pending.get(this.next)) {
            this.pending.delete(this.next);
            const total = this.signal;
            for (let i = 0; i < total.length; i++) total[i] += chunk[i];
            this.next++;
        }
    }
}

function clampCount(value: number): number {
    const n = Math.floor(value);
    if (!(n >= 1 && n <= 4096)) throw new Error(`Spins per voxel must be between 1 and 4096 per axis, got ${value}.`);
    return n;
}

/** Tissue index per voxel (−1 when empty) and the distinct (T1, T2) pairs in first-seen order. */
function tissueTable(grid: VoxelGrid2D): { tissueOf: Int32Array; tissues: { t1: number; t2: number }[] } {
    const tissueOf = new Int32Array(grid.pd.length).fill(-1);
    const tissues: { t1: number; t2: number }[] = [];
    const index = new Map<string, number>();
    for (let i = 0; i < grid.pd.length; i++) {
        if (!(grid.pd[i] > 0)) continue;
        const key = `${grid.t1[i]}|${grid.t2[i]}`;
        let t = index.get(key);
        if (t === undefined) {
            t = tissues.length;
            index.set(key, t);
            tissues.push({ t1: grid.t1[i], t2: grid.t2[i] });
        }
        tissueOf[i] = t;
    }
    return { tissueOf, tissues };
}

/** Consecutive units into chunks of about `target` spins (never splitting a unit). */
function splitUnits(units: Int32Array[], perVoxel: number, target: number): Int32Array[] {
    const chunks: Int32Array[] = [];
    let current: number[] = [];
    let spins = 0;
    for (const unit of units) {
        if (current.length && spins + unit.length * perVoxel > target) {
            chunks.push(Int32Array.from(current));
            current = [];
            spins = 0;
        }
        for (const v of unit) current.push(v);
        spins += unit.length * perVoxel;
    }
    if (current.length) chunks.push(Int32Array.from(current));
    return chunks;
}

/** Keep the segments of a modest program in memory so later chunks skip decoding. */
function replayable(program: SimProgram): SimProgram {
    if (program.blockCount > REPLAY_BLOCK_LIMIT) return program;
    let cached: SimSegment[] | null = null;
    return {
        ...program,
        segments: function* () {
            if (!cached) {
                const collected: SimSegment[] = [];
                for (const segment of program.segments()) {
                    collected.push(segment);
                    yield segment;
                }
                cached = collected;
                return;
            }
            yield* cached;
        },
    };
}
