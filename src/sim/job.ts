/**
 * A simulation job: one sequence and one phantom, split into chunks that
 * simulate independently and sum to the signal.
 *
 * Planning, once per job:
 *   - spins per voxel: axes the sequence spoils get a count measured by the
 *     probe (plan/probe.ts); others need only enough to resolve the readout;
 *   - folding: axes the sequence rewinds before every pulse (a Cartesian phase
 *     encode) fold, so spins along them share one simulated class
 *     (engine/spins.ts, SpinMembers). A 2D GRE then simulates one row of
 *     spins per tissue per column instead of every voxel. Folding pays off
 *     for phantoms with few distinct tissues (Shepp–Logan, label maps);
 *     continuous maps (BrainWeb) have nearly one class per voxel;
 *   - chunks: whole columns (rows) when y (x) folds, else voxels in readout
 *     order, so classes and readout groups stay inside a chunk.
 * The split depends only on the settings, never on the worker count, and
 * chunk signals are added in chunk order (ChunkAccumulator). A result is
 * therefore bit-identical however many workers produced it.
 */

import { evaluateAdcLabels } from '../pulseq/labels';
import { parseSequenceBytes } from '../pulseq/sequenceReader';
import { simulateReference, type SimulationOptions } from './engine/reference';
import { sheppLoganPhantom2D } from './phantom/builtin';
import {
    foldedPhantomSpins,
    occupiedVoxels,
    phantomSpins,
    physicsTable,
    syntheticCoils,
    type Phantom2D,
    type PhysicsTable,
} from './phantom/model';
import { analyzeDephasing, foldableAxes, intervalCycles, resolutionCount, type DephasingAnalysis } from './plan/dephasing';
import { POWER_OF_TWO_COUNTS, probeSubSpins, type ProbeResult, type ProbeTissue } from './plan/probe';
import { compileProgram, type SimProgram } from './program/compile';
import type { SimSegment } from './program/types';
import { reconstructCartesian, type CartesianRecon } from './recon/cartesian';
import { adcTrajectory, type AdcTrajectory } from './recon/trajectory';

export type PhantomSource =
    /** Built-in tissue Shepp–Logan filling the given FOV (default: the sequence's FOV definition). */
    | { kind: 'shepp-logan'; size: number; fov?: [number, number] }
    /** A phantom already resolved to a plane (from a file, see phantom/files.ts). */
    | { kind: 'phantom'; phantom: Phantom2D };

/**
 * Spins per voxel along x chosen per T2 band (see bandsFor): voxel v gets
 * counts[b] for the first b with T2(v) ≤ edges[b]. What a plan resolves 'auto'
 * to, so other workers reproduce it without probing.
 */
export interface SpinBands {
    kind: 'bands';
    edges: number[];
    counts: number[];
    /** Spins per voxel along y. */
    y: number;
}

export interface JobSettings {
    phantom: PhantomSource;
    /** Synthetic receive coils for phantoms without coil maps (default 1: a uniform coil). */
    coils?: number;
    /** Spins per voxel along x and y, 'auto', or a resolved banded plan. */
    subSpins: 'auto' | [number, number] | SpinBands;
    /** Largest count 'auto' may choose per axis (default 2048). */
    maxSubSpins?: number;
    /**
     * Signal error 'auto' accepts from the spin discretisation, relative L2 per
     * tissue (default 0.02). Larger is faster; long-T2 tissue such as CSF needs
     * the most spins.
     */
    tolerance?: number;
}

/** Planning can take seconds (the probe simulates voxels); these report where it is. */
export interface JobHooks {
    /** A human-readable stage and the fraction of planning done. */
    onPlanProgress?(message: string, fraction: number): void;
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
    phantom: {
        source: string;
        nx: number;
        ny: number;
        /** Field of view of the phantom plane [m]. */
        fov: [number, number];
        voxels: number;
        /** Distinct (T1, T2, B0, B1) combinations among occupied voxels. */
        tissues: number;
        maps: string[];
    };
    axes: [AxisPlan, AxisPlan];
    /** Spins per voxel along x (the largest, when banded) and y. */
    subSpins: [number, number];
    /** Per-T2-band counts along x, when 'auto' found a spoiled x axis. */
    bands: SpinBandPlan[] | null;
    /** What the plan resolved to, for other workers (see SpinBands). */
    resolved: [number, number] | SpinBands;
    /** Spins in the phantom (every voxel × sub-spins). */
    spins: number;
    /** Spins actually simulated (classes; equals `spins` when nothing folds). */
    simulated: number;
    chunks: number;
    coils: number;
    /** Main field [T] used for PPM offsets and the ISMRMRD header. */
    b0: number;
    gamma: number;
    /** Physics and sequence features this run does not represent, and caveats. */
    notes: string[];
}

/**
 * Where every ADC sample sits: in the acquisition, in time, in k-space and
 * in the sequence's label space. The raw-data views and the ISMRMRD export
 * are built from this and the signal.
 */
export interface RawLayout {
    acquisitions: number;
    coils: number;
    samples: Int32Array;
    offsets: Int32Array;
    /** Readout window start [s] and sample spacing [s]: sample s sits at t0 + (s + ½)·dwell. */
    t0: Float64Array;
    dwell: Float64Array;
    /** k per sample, xyz interleaved [1/m], reset at excitations (recon/trajectory.ts). */
    k: Float32Array;
    /** Excitation ordinal each readout follows (−1 before any). */
    excitation: Int32Array;
    labels: { names: string[]; kinds: string[]; values: Int32Array };
}

/** Phantom spins beyond which a job is refused. */
export const MAX_JOB_SPINS = 32_000_000;
/** Simulated spins (classes) beyond which a job is refused. */
export const MAX_JOB_SIMULATED = 4_000_000;
/** Receive coils beyond which a job is refused. */
export const MAX_JOB_COILS = 32;
/** Chunks hold at least this many spins, and a job has at most MAX_CHUNKS of them. */
const MIN_CHUNK_SPINS = 16_384;
const MAX_CHUNKS = 64;
/** Programs up to this many blocks keep their segments in memory between chunks. */
const REPLAY_BLOCK_LIMIT = 200_000;
/** Tissues the probe simulates (the longest-lived first; see representativeTissues). */
const PROBE_TISSUES = 4;
/** Upper T2 bounds of the bands spins per voxel are probed for [s]. */
const T2_BAND_EDGES = [0.03, 0.06, 0.12, 0.25, 0.5, 1, Infinity];

export interface SpinBandPlan {
    /** T2 range of the band [s]. */
    t2Min: number;
    t2Max: number;
    count: number;
    error: number;
    capped: boolean;
    voxels: number;
}

export class SimulationJob {
    readonly program: SimProgram;
    readonly analysis: DephasingAnalysis;
    readonly phantom: Phantom2D;
    readonly plan: JobPlan;
    /** Folded axes (bit 0 = x, bit 1 = y). */
    private readonly fold: number;
    private readonly physics: PhysicsTable;
    private readonly chunkVoxels: Int32Array[];
    /** Spins along x per voxel when banded (indexed like the maps), else null. */
    private readonly countX: Int32Array | null;
    private readonly sequenceFov: [number, number, number] | null;
    private trajectory: AdcTrajectory | null = null;
    private readonly hooks: JobHooks;

    constructor(bytes: Uint8Array, name: string, settings: JobSettings, hooks: JobHooks = {}) {
        this.hooks = hooks;
        this.report('Parsing the sequence', 0);
        const seq = parseSequenceBytes(bytes, name);
        this.program = replayable(compileProgram(seq));
        this.report('Analysing gradients and pulses', 0.05);
        this.analysis = analyzeDephasing(this.program);
        if (this.analysis.adcEvents === 0) throw new Error('The sequence has no ADC events, so there is no signal to simulate.');
        const definition = seq.definitions.get('FOV');
        this.sequenceFov = definition && definition.length >= 2 && definition.every(v => Number.isFinite(+v))
            ? [+definition[0], +definition[1], definition.length > 2 ? +definition[2] : 0]
            : null;

        this.report('Preparing the phantom', 0.15);
        this.phantom = this.resolvePhantom(settings);
        const { nx, ny, voxel } = this.phantom;
        const fov: [number, number] = [nx * voxel[0], ny * voxel[1]];
        this.physics = physicsTable(this.phantom);
        this.fold = foldableAxes(this.analysis, [fov[0], fov[1], 0]) & 3;

        const voxels = occupiedVoxels(this.phantom);
        if (!voxels.length) throw new Error('The phantom plane is empty (no voxel has PD > 0).');
        const banded = this.planBands(voxels, voxel[0], settings);
        const axes = [0, 1].map(axis => (axis === 0 && banded ? banded.axis : this.planAxis(axis as 0 | 1, voxel[axis], settings))) as [AxisPlan, AxisPlan];
        const subSpins: [number, number] = [axes[0].count, axes[1].count];
        this.countX = banded ? banded.countX : null;
        // Other workers must reproduce y as this plan chose it.
        if (banded) banded.resolved.y = subSpins[1];
        const spinsOf = (v: number) => (this.countX ? this.countX[v] : subSpins[0]) * subSpins[1];

        let spins = 0;
        for (const v of voxels) spins += spinsOf(v);
        if (spins > MAX_JOB_SPINS) {
            throw new Error(`${spins.toLocaleString('en-US')} spins exceed the ${MAX_JOB_SPINS.toLocaleString('en-US')} limit; `
                + 'use a smaller phantom matrix or fewer spins per voxel.');
        }
        this.report('Splitting the spins into chunks', 0.95);
        const units = this.chunkUnits(voxels);
        const simulated = this.countClasses(units, subSpins, spinsOf);
        if (simulated > MAX_JOB_SIMULATED) {
            throw new Error(`${simulated.toLocaleString('en-US')} simulated spins exceed the `
                + `${MAX_JOB_SIMULATED.toLocaleString('en-US')} limit; use a smaller phantom matrix or fewer spins per voxel.`);
        }
        this.chunkVoxels = splitUnits(units, spinsOf, Math.max(MIN_CHUNK_SPINS, Math.ceil(spins / MAX_CHUNKS)));

        const notes = ['2D phantom: one plane at z = 0, so the slice profile and through-plane dephasing are not simulated.'];
        for (const band of banded?.bands ?? []) {
            if (band.capped) {
                notes.push(`x, T2 ${(band.t2Min * 1000).toFixed(0)}–${Number.isFinite(band.t2Max) ? (band.t2Max * 1000).toFixed(0) : '∞'} ms: `
                    + `${band.count} spins per voxel did not reach the ${tolerancePercent(settings)} target (error ${(100 * band.error).toFixed(0)} %).`);
            }
        }
        for (const [axis, plan] of axes.entries()) {
            if (plan.probe?.capped) {
                notes.push(`${'xy'[axis]}: ${plan.count} spins per voxel did not reach the ${tolerancePercent(settings)} target `
                    + `(error ${(100 * plan.probe.error).toFixed(0)} %); expect residual stripes from incomplete spoiling.`);
            }
        }
        if (this.phantom.maps.t2prime) notes.push('The T2′ map is loaded but not simulated yet (no intravoxel dephasing).');
        if (this.phantom.maps.adc) notes.push('The ADC map is loaded but diffusion is not simulated yet.');
        for (const note of this.phantom.notes) notes.push(note);
        for (const feature of this.program.ignoredFeatures) notes.push(`Not simulated: ${feature}.`);

        this.plan = {
            blocks: this.program.blockCount,
            duration: this.program.totalDuration,
            rfEvents: this.analysis.rfEvents,
            adcEvents: this.analysis.adcEvents,
            adcSamples: this.analysis.adcSamples,
            phantom: {
                source: this.phantom.source,
                nx, ny, fov,
                voxels: voxels.length,
                tissues: this.physics.t1.length,
                maps: Object.keys(this.phantom.maps).filter(key => this.phantom.maps[key as keyof Phantom2D['maps']]),
            },
            axes,
            subSpins,
            bands: banded ? banded.bands : null,
            resolved: banded ? banded.resolved : subSpins,
            spins,
            simulated,
            chunks: this.chunkVoxels.length,
            coils: this.phantom.coils?.count ?? 1,
            b0: this.program.b0,
            gamma: this.program.gamma,
            notes,
        };
    }

    private report(message: string, fraction: number): void {
        this.hooks.onPlanProgress?.(message, fraction);
    }

    /** Simulate one chunk; returns its delivered signal (see SimulationResult.signal). */
    simulateChunk(index: number, options: SimulationOptions = {}): Float64Array {
        const voxels = this.chunkVoxels[index];
        if (!voxels) throw new Error(`No chunk ${index} (the job has ${this.chunkVoxels.length}).`);
        const spinOptions = { subSpins: this.plan.subSpins, voxels, countX: this.countX ?? undefined };
        if (!this.fold) return simulateReference(this.program, phantomSpins(this.phantom, spinOptions), options).signal;
        const { classes, members } = foldedPhantomSpins(this.phantom, this.physics, spinOptions, this.fold);
        return simulateReference(this.program, classes, { ...options, members }).signal;
    }

    reconstruct(signal: Float64Array): CartesianRecon {
        return reconstructCartesian(this.adcTrajectory(), signal, this.plan.coils, { fov: this.sequenceFov, complex: true });
    }

    rawLayout(): RawLayout {
        const trajectory = this.adcTrajectory();
        const labels = evaluateAdcLabels(this.program.sequence);
        if (labels.count !== trajectory.readouts) {
            throw new Error(`Internal error: ${labels.count} labelled ADCs but ${trajectory.readouts} readouts.`);
        }
        return {
            acquisitions: trajectory.readouts,
            coils: this.plan.coils,
            samples: trajectory.samples,
            offsets: trajectory.offsets,
            t0: trajectory.t0,
            dwell: trajectory.dwell,
            k: Float32Array.from(trajectory.k),
            excitation: trajectory.excitation,
            labels: { names: labels.names, kinds: labels.kinds, values: labels.values },
        };
    }

    /** The FOV definition of the sequence, if it has one [m]. */
    get fieldOfView(): [number, number, number] | null {
        return this.sequenceFov;
    }

    adcTrajectory(): AdcTrajectory {
        this.trajectory ??= adcTrajectory(this.program);
        return this.trajectory;
    }

    private resolvePhantom(settings: JobSettings): Phantom2D {
        const source = settings.phantom;
        let phantom: Phantom2D;
        if (source.kind === 'shepp-logan') {
            const size = Math.round(source.size);
            if (!(size >= 2 && size <= 1024)) throw new Error(`Phantom size must be between 2 and 1024, got ${source.size}.`);
            const fov: [number, number] = source.fov
                ?? (this.sequenceFov && this.sequenceFov[0] > 0 && this.sequenceFov[1] > 0
                    ? [this.sequenceFov[0], this.sequenceFov[1]]
                    : [0.256, 0.256]);
            phantom = sheppLoganPhantom2D(size, fov[0], fov[1]);
        } else {
            phantom = source.phantom;
            const cells = phantom.nx * phantom.ny;
            if (!(phantom.nx >= 1 && phantom.ny >= 1) || phantom.maps.pd.length !== cells) {
                throw new Error('The phantom maps do not match its matrix size.');
            }
        }
        const coils = Math.round(settings.coils ?? 1);
        if (!(coils >= 1 && coils <= MAX_JOB_COILS)) throw new Error(`Coils must be between 1 and ${MAX_JOB_COILS}, got ${settings.coils}.`);
        if (!phantom.coils && coils > 1) phantom = { ...phantom, coils: syntheticCoils(phantom.nx, phantom.ny, phantom.voxel, coils) };
        return phantom;
    }

    private planAxis(axis: 0 | 1, voxel: number, settings: JobSettings): AxisPlan {
        const folded = (this.fold & (1 << axis)) !== 0;
        if (Array.isArray(settings.subSpins)) {
            return { count: clampCount(settings.subSpins[axis]), reason: 'manual', folded };
        }
        if (settings.subSpins !== 'auto') {
            // A resolved band plan: x comes from planBands, y as resolved.
            return { count: clampCount(settings.subSpins.y), reason: 'manual', folded };
        }
        const resolution = resolutionCount(this.analysis, axis, voxel);
        // A folded axis has zero area at every pulse, so nothing to spoil.
        if (folded || intervalCycles(this.analysis, axis, voxel) <= 0.05) {
            return { count: resolution, reason: resolution > 1 ? 'resolution' : 'none', folded };
        }
        this.report(`Probing spins per voxel along ${'xy'[axis]}`, 0.2 + 0.4 * axis);
        const probe: ProbeResult = probeSubSpins(this.program, axis, voxel, representativeTissues(this.physics), {
            minimum: resolution,
            maximum: settings.maxSubSpins,
            tolerance: settings.tolerance,
            intervalCycles: intervalCycles(this.analysis, axis, voxel),
        });
        return {
            count: probe.count,
            reason: probe.count > resolution ? 'spoiling' : (resolution > 1 ? 'resolution' : 'none'),
            folded,
            probe: { error: probe.error, reference: probe.reference, capped: probe.capped, tested: probe.tested },
        };
    }

    /**
     * Spins per voxel along a spoiled x axis, per T2 band. Long-T2 tissue keeps
     * transverse pathways for many TRs and needs hundreds of spins; white and
     * grey matter lose them in a few. Probing each band's longest-lived tissue
     * (its largest T2 with its largest T1, which bounds the band) and giving
     * each voxel its band's count cuts BrainWeb-like phantoms several-fold.
     * Counts are powers of two, so every voxel's spins lie on one lattice
     * (folding and lattice synthesis need that).
     *
     * Null when x is not spoiled or the settings fix the counts uniformly.
     */
    private planBands(voxels: Int32Array, voxel: number, settings: JobSettings):
        { axis: AxisPlan; countX: Int32Array; bands: SpinBandPlan[]; resolved: SpinBands } | null {
        const folded = (this.fold & 1) !== 0;
        const t2 = this.phantom.maps.t2;
        const bandOf = (v: number, edges: readonly number[]) => {
            const time = Number.isFinite(t2[v]) && t2[v] > 0 ? t2[v] : Infinity;
            let b = 0;
            while (time > edges[b]) b++;
            return b;
        };
        let edges: number[];
        let counts: number[];
        let bands: SpinBandPlan[];
        let y: number;
        if (settings.subSpins !== 'auto' && !Array.isArray(settings.subSpins)) {
            ({ edges, counts, y } = settings.subSpins);
            bands = [];
        } else {
            if (settings.subSpins !== 'auto' || folded || intervalCycles(this.analysis, 0, voxel) <= 0.05) return null;
            const resolution = resolutionCount(this.analysis, 0, voxel);
            edges = T2_BAND_EDGES;
            const members = edges.map(() => [] as number[]);
            for (const v of voxels) members[bandOf(v, edges)].push(v);
            counts = edges.map(() => 0);
            bands = [];
            const occupied = members.filter(list => list.length).length;
            let probed = 0;
            for (let b = 0; b < edges.length; b++) {
                if (!members[b].length) continue;
                const range = `${b ? Math.round(edges[b - 1] * 1000) : 0}–${Number.isFinite(edges[b]) ? Math.round(edges[b] * 1000) + ' ms' : '∞'}`;
                this.report(`Probing spins per voxel: T2 ${range} (band ${++probed} of ${occupied})`, 0.2 + 0.7 * (probed - 1) / occupied);
                // The band's bound: its longest T2 with its longest T1.
                let t1Max = 0, t2Max = 0;
                for (const v of members[b]) {
                    const time1 = Number.isFinite(this.phantom.maps.t1[v]) ? this.phantom.maps.t1[v] : 1e9;
                    const time2 = Number.isFinite(t2[v]) ? t2[v] : 1e9;
                    t1Max = Math.max(t1Max, time1);
                    t2Max = Math.max(t2Max, time2);
                }
                const probe = probeSubSpins(this.program, 0, voxel, [{ t1: t1Max, t2: t2Max }], {
                    minimum: resolution,
                    maximum: settings.maxSubSpins,
            tolerance: settings.tolerance,
                    intervalCycles: intervalCycles(this.analysis, 0, voxel),
                    candidates: POWER_OF_TWO_COUNTS,
                });
                counts[b] = probe.count;
                bands.push({
                    t2Min: b ? edges[b - 1] : 0, t2Max: edges[b], count: probe.count,
                    error: probe.error, capped: probe.capped, voxels: members[b].length,
                });
            }
            y = 0;      // set by the caller from the y plan
        }
        const finest = Math.max(...counts);
        for (const count of counts) {
            if (count && (finest % count !== 0 || (count & (count - 1)) !== 0)) throw new Error('Banded spin counts must be powers of two.');
        }
        const countX = new Int32Array(this.phantom.nx * this.phantom.ny);
        for (const v of voxels) countX[v] = counts[bandOf(v, edges)] || finest;
        const worst = bands.reduce((max, band) => Math.max(max, band.error), 0);
        const axis: AxisPlan = {
            count: finest,
            reason: bands.length ? 'spoiling' : 'manual',
            folded,
            probe: bands.length ? { error: worst, reference: 0, capped: bands.some(b => b.capped), tested: [] } : undefined,
        };
        return { axis, countX, bands, resolved: { kind: 'bands', edges, counts, y } };
    }

    /** Voxels grouped into the units chunks are cut from (see the file comment). */
    private chunkUnits(voxels: Int32Array): Int32Array[] {
        const nx = this.phantom.nx;
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
    private countClasses(units: Int32Array[], subSpins: [number, number], spinsOf: (v: number) => number): number {
        if (!this.fold) return units.reduce((sum, unit) => sum + unit.reduce((s, v) => s + spinsOf(v), 0), 0);
        // Per unit: distinct physics entries × sub-positions along the unfolded
        // axes. With both axes folded, chunks repeat the same few classes,
        // which this count ignores.
        if (this.fold === 3) return this.physics.t1.length;
        let total = 0;
        for (const unit of units) {
            // One class per physics entry and unfolded position; banded counts make positions differ.
            const seen = new Map<number, number>();
            for (const v of unit) {
                const along = this.fold & 1 ? 1 : (this.countX ? this.countX[v] : subSpins[0]);
                const key = this.physics.of[v] * 8192 + along;
                seen.set(key, along * (this.fold & 2 ? 1 : subSpins[1]));
            }
            for (const count of seen.values()) total += count;
        }
        return total;
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

function tolerancePercent(settings: JobSettings): string {
    return `${+(100 * (settings.tolerance ?? 0.02)).toFixed(1)} %`;
}

function clampCount(value: number): number {
    const n = Math.floor(value);
    if (!(n >= 1 && n <= 4096)) throw new Error(`Spins per voxel must be between 1 and 4096 per axis, got ${value}.`);
    return n;
}

/**
 * A few tissues that bound the probe's answer. Long T2 keeps transverse
 * pathways alive and long T1 keeps stimulated ones, so those two lead; the
 * median adds an ordinary tissue. Continuous maps (BrainWeb) have thousands of
 * entries, and probing each would cost more than the run.
 */
function representativeTissues(physics: PhysicsTable): ProbeTissue[] {
    const indices = physics.t1.map((_, i) => i);
    if (indices.length <= PROBE_TISSUES) return indices.map(i => ({ t1: physics.t1[i], t2: physics.t2[i] }));
    const life = (time: number) => (Number.isFinite(time) && time > 0 ? time : 0);
    const byT2 = indices.slice().sort((a, b) => life(physics.t2[b]) - life(physics.t2[a]) || life(physics.t1[b]) - life(physics.t1[a]));
    const byT1 = indices.slice().sort((a, b) => life(physics.t1[b]) - life(physics.t1[a]));
    const chosen = new Set<number>([byT2[0], byT1[0], byT2[Math.floor(byT2.length / 2)], byT2[1]]);
    return [...chosen].slice(0, PROBE_TISSUES).map(i => ({ t1: physics.t1[i], t2: physics.t2[i] }));
}

/** Consecutive units into chunks of about `target` spins (never splitting a unit). */
function splitUnits(units: Int32Array[], spinsOf: (v: number) => number, target: number): Int32Array[] {
    const chunks: Int32Array[] = [];
    let current: number[] = [];
    let spins = 0;
    for (const unit of units) {
        let unitSpins = 0;
        for (const v of unit) unitSpins += spinsOf(v);
        if (current.length && spins + unitSpins > target) {
            chunks.push(Int32Array.from(current));
            current = [];
            spins = 0;
        }
        for (const v of unit) current.push(v);
        spins += unitSpins;
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
