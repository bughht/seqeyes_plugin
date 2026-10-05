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
 *   - through-slice sampling: sub-slices along z where the sequence's pulses
 *     act (plan/slices.ts), with a spacing probed like the spins per voxel;
 *   - chunks: whole columns (rows) when y (x) folds, else voxels in readout
 *     order, so classes and readout groups stay inside a chunk.
 * The phase-graph engine (engine/phaseGraph.ts) is the other choice: no
 * spins per voxel at all, configuration states per tissue class instead, and
 * chunks of tissue classes.
 *
 * The split depends only on the settings, never on the worker count, and
 * chunk signals are added in chunk order (ChunkAccumulator). A result is
 * therefore bit-identical however many workers produced it.
 */

import { evaluateAdcLabels } from '../pulseq/labels';
import { parseSequenceBytes } from '../pulseq/sequenceReader';
import { simulateReference, type SimulationOptions } from './engine/reference';
import { simulatePhaseGraph, type PhaseGraphSources } from './engine/phaseGraph';
import { phaseGraphPhantom, type ClassBinning, type PhaseGraphPhantom } from './phantom/phaseGraphModel';
import { sheppLoganPhantom2D } from './phantom/builtin';
import {
    assignPlanes,
    foldedPhantomSpins,
    occupiedVoxels,
    phantomSpins,
    physicsTable,
    planeMaps,
    syntheticCoils,
    type Phantom2D,
    type PhysicsTable,
    type ThroughSlice,
} from './phantom/model';
import { analyzeDephasing, foldableAxes, intervalCycles, resolutionCount, type DephasingAnalysis } from './plan/dephasing';
import { POWER_OF_TWO_COUNTS, probeSubSpins, type ProbeResult, type ProbeTissue } from './plan/probe';
import { measurePulses, planSlices, probeSliceDensity, type PulseResponse, type SlicePlan } from './plan/slices';
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

/** The sub-slices a plan chose, for other workers to reuse without measuring (see JobPlan.resolvedSlices). */
export interface ResolvedSlices {
    kind: 'slices';
    z: number[];
    weight: number[];
    density: number;
    reference: number;
    ranges: [number, number][];
    extent: SlicePlan['extent'];
    coarsened: boolean;
}

/** Isochromats (Bloch, spins per voxel) or configuration states (phase graph). */
export type SimulationEngine = 'isochromat' | 'phase-graph';

export interface JobSettings {
    phantom: PhantomSource;
    /** Default 'isochromat'. */
    engine?: SimulationEngine;
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
    /**
     * Spins along z: 'auto' places sub-slices where the sequence's pulses act
     * (default), 'off' keeps every spin at z = 0, or a resolved plan.
     */
    throughSlice?: 'auto' | 'off' | ResolvedSlices;
    /** Phase graph: overrides of what `tolerance` sets (advanced). */
    phaseGraphTuning?: Partial<PhaseGraphTuning>;
}

/** What the phase graph's accuracy setting chooses (see planPhaseGraph). */
export interface PhaseGraphTuning {
    /** States below this on every lane are dropped after each pulse. */
    prune: number;
    /** Most states of each kind kept. */
    maxStates: number;
    /** Sub-slices per resolution cell of the pulses' profiles. */
    density: number;
    /** Off-resonance bin of the RF operators [Hz]. */
    rfStep: number;
    /** Finest relative T1/T2 and absolute B1 bins when continuous maps exceed the class budget. */
    fine: { t: number; b1: number };
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

/** What the phase-graph engine simulates (JobPlan.phaseGraph). */
export interface PhaseGraphPlan {
    /** Tissue classes, and classes × sub-slices (the lanes states carry amplitudes on). */
    classes: number;
    lanes: number;
    /** Emitting voxels (× planes of a 3-D phantom). */
    sources: number;
    /** States below this are dropped after each pulse; at most maxStates of each kind kept. */
    prune: number;
    maxStates: number;
    /** Class binning: relative T1/T2 and absolute B1+ widths (0 = exact), and the off-resonance width of RF operators [Hz]. */
    binning: ClassBinning;
}

export interface JobPlan {
    /** The engine this plan runs. */
    engine: SimulationEngine;
    /** Phase-graph details, or null for the isochromat engine. */
    phaseGraph: PhaseGraphPlan | null;
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
    /** Through-slice sampling, or null when every spin sits at z = 0. */
    slices: SliceSummary | null;
    /** The sub-slices as other workers take them (JobSettings.throughSlice). */
    resolvedSlices: ResolvedSlices | 'off';
    /** Spins in the phantom (every voxel × sub-spins × sub-slices). */
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

export interface SliceSummary {
    /** Sub-slices, and the ranges they cover [m]. */
    count: number;
    ranges: [number, number][];
    /** Sub-slices per 1/Kz (plan/slices.ts). */
    density: number;
    /** Slice thickness the sub-slice weights refer to [m]. */
    reference: number;
    extent: SlicePlan['extent'];
    coarsened: boolean;
    /** Phantom planes the sub-slices take their maps from (1: a 2-D phantom, extruded). */
    planes: number;
    /** The density probe's verdict, when it ran. */
    probe: { error: number; capped: boolean; tested: { density: number; slices: number; error: number }[] } | null;
}

/** Spins a job stores (members when folded) beyond which it is refused. */
export const MAX_JOB_SPINS = 64_000_000;
/** Simulated spins (classes) beyond which a job is refused. */
export const MAX_JOB_SIMULATED = 128_000_000;
/**
 * Work (simulated spins × RF pulses) the sub-slices may bring a job to before
 * the plan takes a coarser tested density. Continuous maps such as BrainWeb
 * have about one class per spin, so every sub-slice multiplies them; about a
 * minute on 8 workers.
 */
const SLICE_WORK_BUDGET = 4e9;
/** Receive coils beyond which a job is refused. */
export const MAX_JOB_COILS = 32;
/** Chunks hold MIN…MAX_CHUNK_SPINS spins, and about MAX_CHUNKS of them when that allows. */
const MIN_CHUNK_SPINS = 16_384;
const MAX_CHUNK_SPINS = 262_144;
const MAX_CHUNKS = 64;
/** Most sub-slices a plan may use. */
const MAX_SLICES = 512;
/** Tissues the sub-slice density probe simulates. */
const SLICE_PROBE_TISSUES = 2;
/** Phase graph: most tissue classes (continuous maps get binned to fit), lanes per chunk, and chunks. */
const PG_CLASS_BUDGET = 2048;
const PG_LANES_PER_CHUNK = 512;
const PG_MAX_CHUNKS = 64;
/** Phase graph: sources per chunk, at most (a class's voxels split across chunks share its readout work). */
const PG_SOURCES_PER_CHUNK = 2048;
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
    /** Sub-slices along z, or null for one plane at z = 0. */
    private readonly slices: ThroughSlice | null;
    /** The pulses as measured for this plan (empty when the sub-slices came resolved). */
    readonly pulses: PulseResponse[];
    /** The phase-graph model and its chunks, or null for the isochromat engine. */
    private readonly pg: {
        phantom: PhaseGraphPhantom;
        slices: { z: Float64Array; weight: Float64Array; reference: number };
        chunkClasses: Int32Array[];
        chunkSources: Int32Array[];
        prune: number;
        maxStates: number;
    } | null;
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
        if ((settings.engine ?? 'isochromat') === 'phase-graph') {
            const planned = this.planPhaseGraph(settings, voxels.length, fov);
            this.countX = null;
            this.slices = planned.slices;
            this.pulses = planned.pulses;
            this.chunkVoxels = [];
            this.pg = planned.pg;
            this.plan = planned.plan;
            return;
        }
        this.pg = null;
        const banded = this.planBands(voxels, voxel[0], settings);
        const axes = [0, 1].map(axis => (axis === 0 && banded ? banded.axis : this.planAxis(axis as 0 | 1, voxel[axis], settings))) as [AxisPlan, AxisPlan];
        const subSpins: [number, number] = [axes[0].count, axes[1].count];
        this.countX = banded ? banded.countX : null;
        // Other workers must reproduce y as this plan chose it.
        if (banded) banded.resolved.y = subSpins[1];
        // Chunk units do not depend on the sub-slices; classes at z = 0 size their cost.
        const units = this.chunkUnits(voxels);
        const through = this.planThroughSlice(settings, subSpins, banded?.resolved ?? null, this.countClasses(units, subSpins));
        this.slices = through.slices;
        this.pulses = through.pulses;
        // Sub-slices (spins along z) and planes (member sets) present at each voxel.
        const { slicesAt, planesAt } = this.presence(voxels);
        const along = (v: number) => (this.countX ? this.countX[v] : subSpins[0]) * subSpins[1];
        const spinsOf = (v: number) => along(v) * slicesAt[v];

        let spins = 0, stored = 0;
        for (const v of voxels) {
            spins += spinsOf(v);
            stored += along(v) * (this.fold ? planesAt[v] : slicesAt[v]);
        }
        if (stored > MAX_JOB_SPINS) {
            throw new Error(`${stored.toLocaleString('en-US')} spins exceed the ${MAX_JOB_SPINS.toLocaleString('en-US')} limit; `
                + 'use a smaller phantom matrix, fewer spins per voxel or fewer sub-slices.');
        }
        this.report('Splitting the spins into chunks', 0.97);
        const simulated = this.countClasses(units, subSpins);
        if (simulated > MAX_JOB_SIMULATED) {
            throw new Error(`${simulated.toLocaleString('en-US')} simulated spins exceed the `
                + `${MAX_JOB_SIMULATED.toLocaleString('en-US')} limit; use a smaller phantom matrix, fewer spins per voxel or fewer sub-slices.`);
        }
        const target = Math.max(MIN_CHUNK_SPINS, Math.min(MAX_CHUNK_SPINS, Math.ceil(spins / MAX_CHUNKS)));
        this.chunkVoxels = splitUnits(units, spinsOf, target);

        const notes = through.notes.slice();
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
        const hasT2prime = this.physics.t2p.some(Number.isFinite), hasDiffusion = this.physics.adc.some(d => d > 0);
        if (hasT2prime || hasDiffusion) {
            notes.push(`${hasT2prime && hasDiffusion ? 'T2′ and diffusion follow' : hasT2prime ? 'T2′ follows' : 'Diffusion follows'} `
                + 'the main echo pathway (from each excitation, reversed by each refocusing pulse): exact for gradient and spin '
                + 'echoes, CPMG trains and diffusion-weighted EPI; approximate where other pathways carry signal (balanced SSFP, '
                + 'stimulated echoes, spoiled steady states). The phase-graph engine is exact for every pathway.');
        }
        for (const note of this.phantom.notes) notes.push(note);
        for (const feature of this.program.ignoredFeatures) notes.push(`Not simulated: ${IGNORED_FEATURE_TEXT[feature]}.`);

        this.plan = {
            engine: 'isochromat',
            phaseGraph: null,
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
            slices: through.summary,
            resolvedSlices: through.resolved,
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
        if (this.pg) return this.simulatePhaseGraphChunk(index, options);
        const voxels = this.chunkVoxels[index];
        if (!voxels) throw new Error(`No chunk ${index} (the job has ${this.chunkVoxels.length}).`);
        const spinOptions = { subSpins: this.plan.subSpins, voxels, countX: this.countX ?? undefined, slices: this.slices ?? undefined };
        if (!this.fold) return simulateReference(this.program, phantomSpins(this.phantom, spinOptions), options).signal;
        const { classes, members } = foldedPhantomSpins(this.phantom, this.physics, spinOptions, this.fold);
        return simulateReference(this.program, classes, { ...options, members }).signal;
    }

    private simulatePhaseGraphChunk(index: number, options: SimulationOptions): Float64Array {
        const pg = this.pg!;
        const classes = pg.chunkClasses[index], members = pg.chunkSources[index];
        if (!classes) throw new Error(`No chunk ${index} (the job has ${pg.chunkClasses.length}).`);
        const all = pg.phantom.sources;
        const local = new Int32Array(pg.phantom.classes.length).fill(-1);
        classes.forEach((c, i) => { local[c] = i; });
        const n = members.length, coils = all.coils;
        const pick = (array: Float64Array) => Float64Array.from(members, i => array[i]);
        const rxRe = new Float64Array(coils * n), rxIm = new Float64Array(coils * n);
        for (let c = 0; c < coils; c++) {
            for (let j = 0; j < n; j++) {
                rxRe[c * n + j] = all.rxRe[c * all.count + members[j]];
                rxIm[c * n + j] = all.rxIm[c * all.count + members[j]];
            }
        }
        const sources: PhaseGraphSources = {
            count: n,
            x: pick(all.x), y: pick(all.y), df: pick(all.df), pd: pick(all.pd),
            classOf: Int32Array.from(members, i => local[all.classOf[i]]),
            sliceFrom: Int32Array.from(members, i => all.sliceFrom[i]),
            sliceTo: Int32Array.from(members, i => all.sliceTo[i]),
            coils, rxRe, rxIm,
        };
        const model = {
            classes: Array.from(classes, c => pg.phantom.classes[c]),
            slices: pg.slices,
            sources,
            voxel: [this.phantom.voxel[0], this.phantom.voxel[1]] as [number, number],
        };
        return simulatePhaseGraph(this.program, model, {
            prune: pg.prune, maxStates: pg.maxStates,
            onProgress: options.onProgress, progressInterval: options.progressInterval, isCancelled: options.isCancelled, until: options.until,
        }).signal;
    }

    /**
     * The phase-graph plan: sub-slices at a density set by the accuracy
     * target (configuration states need no spins per voxel, and their slab
     * integral converges within a few sub-slices per resolution cell), tissue
     * classes and their sources, and chunks of whole classes.
     */
    private planPhaseGraph(settings: JobSettings, voxelCount: number, fov: [number, number]) {
        if (this.analysis.rfGradientAxes & 3) {
            throw new Error('The phase-graph engine cannot simulate this sequence: its RF pulses play gradients along x or y '
                + '(in-plane selective or oblique excitation). Use the isochromat engine.');
        }
        const tolerance = settings.tolerance ?? 0.02;
        const preset = phaseGraphPreset(tolerance);
        const tuning: PhaseGraphTuning = { ...preset, ...settings.phaseGraphTuning };
        const through = this.planThroughSlice(settings, [1, 1], null, 0, tuning.density, true);
        this.report('Grouping the phantom into tissue classes', 0.95);
        const phantom = phaseGraphPhantom(this.phantom, through.slices, tuning.rfStep, tuning.fine, PG_CLASS_BUDGET);
        const K = through.slices ? through.slices.z.length : 1;
        const C = phantom.classes.length;
        if (!phantom.sources.count) throw new Error('The phantom plane is empty (no voxel has PD > 0).');
        const slices = through.slices && through.resolved !== 'off'
            ? { z: through.slices.z, weight: through.slices.weight, reference: through.resolved.reference }
            : { z: Float64Array.of(0), weight: Float64Array.of(1), reference: 1 };
        // Chunks: whole classes, about PG_MAX_CHUNKS of them, at most PG_LANES_PER_CHUNK lanes each.
        const perChunk = Math.max(1, Math.min(Math.floor(PG_LANES_PER_CHUNK / K) || 1, Math.ceil(C / PG_MAX_CHUNKS)));
        const chunkClasses: Int32Array[] = [];
        for (let c = 0; c < C; c += perChunk) chunkClasses.push(Int32Array.from({ length: Math.min(perChunk, C - c) }, (_, i) => c + i));
        const chunkOf = new Int32Array(C);
        chunkClasses.forEach((list, i) => list.forEach(c => { chunkOf[c] = i; }));
        const lists: number[][] = chunkClasses.map(() => []);
        for (let i = 0; i < phantom.sources.count; i++) lists[chunkOf[phantom.sources.classOf[i]]].push(i);
        // Classes with many voxels are split across chunks: each piece evolves the class's
        // states again (cheap) and synthesises its share of the readout (the costly part).
        const finalClasses: Int32Array[] = [], chunkSources: Int32Array[] = [];
        lists.forEach((list, i) => {
            const pieces = Math.max(1, Math.ceil(list.length / PG_SOURCES_PER_CHUNK));
            const size = Math.ceil(list.length / pieces);
            for (let p = 0; p < pieces; p++) {
                finalClasses.push(chunkClasses[i]);
                chunkSources.push(Int32Array.from(list.slice(p * size, (p + 1) * size)));
            }
        });
        chunkClasses.length = 0;
        chunkClasses.push(...finalClasses);

        const notes = through.notes.slice();
        notes.push(`Phase graph: ${C} tissue classes × ${K} sub-slices; states below ${tuning.prune} are dropped (at most ${tuning.maxStates} of each kind). `
            + 'Voxels are uniform boxes; each voxel\'s own B0 enters exactly through the states\' dephasing time.');
        if (phantom.binning.t > 0 || phantom.binning.b1 > 0) {
            notes.push(`Continuous maps were binned into ${C} classes: T1 and T2 to ${+(100 * phantom.binning.t).toFixed(2)} %, `
                + `B1+ to ${+(100 * phantom.binning.b1).toFixed(2)} %.`);
        }
        if (phantom.sources.df.some(v => v !== 0)) {
            notes.push(`Pulses act at off-resonance rounded to ${phantom.binning.df} Hz; free precession uses each voxel's exact B0.`);
        }
        if (phantom.classes.some(c => c.t2prime !== undefined && Number.isFinite(c.t2prime))) notes.push('T2′ is exact: each configuration decays by e^{−|τ|/T2′} (a Lorentzian line).');
        if (phantom.classes.some(c => (c.adc ?? 0) > 0)) {
            notes.push('Diffusion is exact: each configuration decays by e^{−bD}, b from its own gradient history (isotropic D).');
        }
        for (const note of this.phantom.notes) notes.push(note);
        for (const feature of this.program.ignoredFeatures) notes.push(`Not simulated: ${IGNORED_FEATURE_TEXT[feature]}.`);
        const none: AxisPlan = { count: 1, reason: 'none', folded: false };
        const plan: JobPlan = {
            engine: 'phase-graph',
            phaseGraph: {
                classes: C, lanes: C * K, sources: phantom.sources.count,
                prune: tuning.prune, maxStates: tuning.maxStates, binning: phantom.binning,
            },
            blocks: this.program.blockCount,
            duration: this.program.totalDuration,
            rfEvents: this.analysis.rfEvents,
            adcEvents: this.analysis.adcEvents,
            adcSamples: this.analysis.adcSamples,
            phantom: {
                source: this.phantom.source,
                nx: this.phantom.nx, ny: this.phantom.ny, fov,
                voxels: voxelCount,
                tissues: C,
                maps: Object.keys(this.phantom.maps).filter(key => this.phantom.maps[key as keyof Phantom2D['maps']]),
            },
            axes: [none, { ...none }],
            subSpins: [1, 1],
            bands: null,
            resolved: [1, 1],
            slices: through.summary,
            resolvedSlices: through.resolved,
            spins: phantom.sources.count * K,
            simulated: C * K,
            chunks: chunkClasses.length,
            coils: this.phantom.coils?.count ?? 1,
            b0: this.program.b0,
            gamma: this.program.gamma,
            notes,
        };
        return {
            plan, slices: through.slices, pulses: through.pulses,
            pg: { phantom, slices, chunkClasses, chunkSources, prune: tuning.prune, maxStates: tuning.maxStates },
        };
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
        for (const plane of phantom.planes ?? []) {
            if (plane.maps.pd.length !== phantom.nx * phantom.ny) throw new Error('A phantom plane does not match the phantom matrix size.');
        }
        if (!phantom.coils && coils > 1) phantom = { ...phantom, coils: syntheticCoils(phantom.nx, phantom.ny, phantom.voxel, coils) };
        return phantom;
    }

    /**
     * Sub-slices along z (plan/slices.ts): resolved by another worker, or
     * measured from the pulses with a density probed on one voxel of the
     * longest-lived tissues, at the in-plane spins this plan chose.
     */
    private planThroughSlice(settings: JobSettings, subSpins: [number, number], bands: SpinBands | null, flatClasses: number, fixedDensity?: number, boxes = false): {
        slices: ThroughSlice | null; summary: SliceSummary | null; resolved: ResolvedSlices | 'off'; pulses: PulseResponse[]; notes: string[];
    } {
        const mode = settings.throughSlice ?? 'auto';
        const flat = 'one plane at z = 0, so slice profiles and through-slice dephasing are not simulated';
        if (mode === 'off') {
            return { slices: null, summary: null, resolved: 'off', pulses: [], notes: [`Through-slice sampling is off: ${flat}.`] };
        }
        let plan: ResolvedSlices;
        let probe: SliceSummary['probe'] = null;
        let pulses: PulseResponse[] = [];
        let budgetNote = '';
        if (mode !== 'auto') {
            plan = mode;
        } else {
            this.report('Measuring the RF pulses along z', 0.9);
            pulses = measurePulses(this.program);
            const options = {
                offResonance: this.largestOffResonance(),
                planeThickness: this.phantom.voxel[2],
                maxSlices: MAX_SLICES,
                volume: volumeExtent(this.phantom) ?? undefined,
                encodingZ: encodingExtent(this.adcTrajectory(), 2),
                boxes,
            };
            const selective = pulses.some(p => p.axis === 'z' && p.bands.length);
            if (!planSlices(pulses, { ...options, density: 1 })) {
                const why = selective
                    ? 'An excitation is not selective along z and the phantom plane has no thickness'
                    : 'No pulse is selective along z';
                return { slices: null, summary: null, resolved: 'off', pulses, notes: [`${why}: ${flat}.`] };
            }
            this.report('Probing the sub-slice spacing', 0.93);
            const tissues = representativeTissues(this.physics).slice(0, SLICE_PROBE_TISSUES).map(tissue => ({
                ...tissue,
                countX: this.fold & 1 ? 1 : bands ? bandCount(bands, tissue.t2) : subSpins[0],
            }));
            // A fixed density (the phase graph) skips the isochromat probe.
            const fixed = fixedDensity !== undefined ? planSlices(pulses, { ...options, density: fixedDensity }) : null;
            const result = fixed
                ? { plan: fixed, error: NaN, capped: false, tested: [] }
                : probeSliceDensity(this.program, pulses, tissues, {
                    ...options,
                    voxel: [this.phantom.voxel[0], this.phantom.voxel[1]],
                    countY: this.fold & 2 ? 1 : subSpins[1],
                    tolerance: settings.tolerance,
                })!;
            probe = fixed ? null : { error: result.error, capped: result.capped, tested: result.tested };
            let chosen = result.plan;
            // Each sub-slice repeats the classes: past the budget, the finest
            // tested density that fits (the coarsest when none does).
            const work = (slices: number) => flatClasses * slices * Math.max(1, this.analysis.rfEvents);
            if (work(chosen.z.length) > SLICE_WORK_BUDGET) {
                const fitting = result.tested.filter(t => work(t.slices) <= SLICE_WORK_BUDGET);
                const pick = fitting.length ? fitting[fitting.length - 1] : result.tested[0];
                if (pick && pick.density < chosen.density) {
                    chosen = planSlices(pulses, { ...options, density: pick.density })!;
                    budgetNote = `Through-slice: ${chosen.z.length} sub-slices instead of ${result.plan.z.length} to keep the run affordable `
                        + `(about ${(100 * pick.error).toFixed(0)} % signal error from the z sampling; choose Fast or Draft accuracy to make that the default).`;
                }
            }
            plan = {
                kind: 'slices',
                z: Array.from(chosen.z), weight: Array.from(chosen.weight),
                density: chosen.density, reference: chosen.reference,
                ranges: chosen.ranges, extent: chosen.extent, coarsened: chosen.coarsened,
            };
        }
        const z = Float64Array.from(plan.z);
        const slices: ThroughSlice = { z, weight: Float64Array.from(plan.weight), plane: assignPlanes(this.phantom, z) };
        const planes = new Set(Array.from(slices.plane)).size;
        const summary: SliceSummary = {
            count: z.length, ranges: plan.ranges, density: plan.density, reference: plan.reference,
            extent: plan.extent, coarsened: plan.coarsened, planes, probe,
        };
        const mm = (value: number) => +(value * 1000).toFixed(2);
        const notes: string[] = [];
        const span = plan.ranges.map(([a, b]) => `${mm(a)}…${mm(b)}`).join(', ');
        notes.push(plan.extent === 'plane'
            ? `An excitation is not selective along z: ${z.length} sub-slices span only the phantom plane's ${mm(this.phantom.voxel[2])} mm.`
            : plan.extent === 'volume'
                ? `The excitation reaches the whole phantom along z: ${z.length} sub-slices over z = ${span} mm.`
                : `Through-slice: ${z.length} sub-slices over z = ${span} mm (slice ${mm(plan.reference)} mm FWHM).`);
        notes.push(this.phantom.planes?.length
            ? `${planes} phantom planes along z, ${mm(this.phantom.voxel[2])} mm apart.`
            : 'The 2-D phantom is extruded along z: every sub-slice sees the same plane.');
        if (plan.coarsened) notes.push(`The sub-slice spacing was widened to stay within ${MAX_SLICES} sub-slices.`);
        if (budgetNote) notes.push(budgetNote);
        if (probe?.capped) {
            notes.push(`Through-slice: the z sampling had not converged to the ${tolerancePercent(settings)} target at the finest `
                + `spacing tried (${Number.isFinite(probe.error) ? (100 * probe.error).toFixed(0) : '?'} % between the two finest). `
                + 'Gradients along z such as crushers around refocusing pulses or diffusion lobes dephase faster than the '
                + 'sub-slices resolve, so some signal from pathways they should remove remains.');
        }
        return { slices, summary, resolved: plan, pulses, notes };
    }

    /** Largest |B0 offset| among the phantom's occupied voxels [Hz]. */
    private largestOffResonance(): number {
        let largest = 0;
        for (const maps of [this.phantom.maps, ...(this.phantom.planes ?? []).map(plane => plane.maps)]) {
            if (!maps.b0) continue;
            for (let i = 0; i < maps.b0.length; i++) if (maps.pd[i] > 0) largest = Math.max(largest, Math.abs(maps.b0[i]));
        }
        return largest;
    }

    /** Sub-slices and distinct planes with PD > 0 at each voxel. */
    private presence(voxels: Int32Array): { slicesAt: Int32Array; planesAt: Int32Array } {
        const cells = this.phantom.nx * this.phantom.ny;
        const slicesAt = new Int32Array(cells), planesAt = new Int32Array(cells);
        const planeOf = this.slices ? Array.from(this.slices.plane) : [-1];
        const used = [...new Set(planeOf)];
        for (const v of voxels) {
            for (const plane of planeOf) if (planeMaps(this.phantom, plane).pd[v] > 0) slicesAt[v]++;
            for (const plane of used) if (planeMaps(this.phantom, plane).pd[v] > 0) planesAt[v]++;
        }
        return { slicesAt, planesAt };
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
        // A voxel's band is set by its longest-lived tissue over the planes.
        const { t1, t2 } = this.longestTimes();
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
                    const time1 = Number.isFinite(t1[v]) ? t1[v] : 1e9;
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

    /** Per voxel, the longest T1 and T2 among the planes where it has PD (the own plane's maps without planes). */
    private longestTimes(): { t1: Float32Array; t2: Float32Array } {
        const planes = this.phantom.planes ?? [];
        if (!planes.length) return { t1: this.phantom.maps.t1, t2: this.phantom.maps.t2 };
        const cells = this.phantom.nx * this.phantom.ny;
        const t1 = new Float32Array(cells), t2 = new Float32Array(cells);
        const life = (time: number) => (Number.isFinite(time) && time > 0 ? time : Infinity);
        for (const maps of [this.phantom.maps, ...planes.map(plane => plane.maps)]) {
            for (let v = 0; v < cells; v++) {
                if (!(maps.pd[v] > 0)) continue;
                t1[v] = Math.max(t1[v], life(maps.t1[v]));
                t2[v] = Math.max(t2[v], life(maps.t2[v]));
            }
        }
        return { t1, t2 };
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
    private countClasses(units: Int32Array[], subSpins: [number, number]): number {
        const planeOf = this.slices ? Array.from(this.slices.plane) : [-1];
        const slicesOfPlane = new Map<number, number>();
        for (const plane of planeOf) slicesOfPlane.set(plane, (slicesOfPlane.get(plane) ?? 0) + 1);
        const along = (v: number) => (this.countX ? this.countX[v] : subSpins[0]);
        if (!this.fold) {
            let total = 0;
            for (const unit of units) {
                for (const v of unit) {
                    for (const [plane, count] of slicesOfPlane) if (planeMaps(this.phantom, plane).pd[v] > 0) total += along(v) * subSpins[1] * count;
                }
            }
            return total;
        }
        // Per unit: distinct (physics entry, plane) × sub-positions along the
        // unfolded axes × the plane's sub-slices. With both axes folded,
        // chunks repeat the same few classes, which this count ignores.
        if (this.fold === 3) {
            let total = 0;
            for (const [plane, count] of slicesOfPlane) {
                const entries = new Set<number>();
                const of = plane < 0 ? this.physics.of : this.physics.ofPlanes[plane];
                for (const unit of units) for (const v of unit) if (of[v] >= 0) entries.add(of[v]);
                total += entries.size * count;
            }
            return total;
        }
        let total = 0;
        for (const unit of units) {
            // One class per physics entry, plane and unfolded position; banded counts make positions differ.
            const seen = new Map<string, number>();
            for (const v of unit) {
                const positions = this.fold & 1 ? 1 : along(v);
                for (const [plane, count] of slicesOfPlane) {
                    const of = plane < 0 ? this.physics.of : this.physics.ofPlanes[plane];
                    if (of[v] < 0) continue;
                    seen.set(`${of[v]}|${positions}|${plane}`, positions * (this.fold & 2 ? 1 : subSpins[1]) * count);
                }
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

/** How the notes name what a program leaves out. */
const IGNORED_FEATURE_TEXT: Record<SimProgram['ignoredFeatures'] extends Set<infer F> ? F & string : never, string> = {
    'trigger': 'trigger events',
    'nco': 'NCO frequency and phase events',
    'dynamic-ptx-rf': 'dynamic pTx RF (per-channel waveforms)',
    'rf-shims': 'RF shims (static pTx). Phantoms have no per-channel B1+ maps yet, so the shim weights are not applied',
};

/** Spins along x a band plan gives a tissue of this T2. */
function bandCount(bands: SpinBands, t2: number): number {
    const time = Number.isFinite(t2) && t2 > 0 ? t2 : Infinity;
    let b = 0;
    while (b < bands.edges.length - 1 && time > bands.edges[b]) b++;
    return bands.counts[b] || Math.max(...bands.counts);
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

/** A 3-D phantom's extent along z [m]: its own plane and its neighbours, each a plane thick; null without planes. */
export function volumeExtent(phantom: Phantom2D): [number, number] | null {
    const dz = phantom.voxel[2];
    if (!phantom.planes?.length || !(dz > 0)) return null;
    let lo = 0, hi = 0;
    for (const plane of phantom.planes) { lo = Math.min(lo, plane.offset); hi = Math.max(hi, plane.offset); }
    return [(lo - 0.5) * dz, (hi + 0.5) * dz];
}

/** The largest |k| the readouts sample along a physical axis [1/m]. */
export function encodingExtent(trajectory: AdcTrajectory, axis: number): number {
    let largest = 0;
    for (let s = axis; s < trajectory.k.length; s += 3) largest = Math.max(largest, Math.abs(trajectory.k[s]));
    return largest;
}

/**
 * The phase graph's settings for an accuracy target, measured against the
 * Accurate preset on spoiled GRE, TSE, HASTE, EPI, diffusion EPI, balanced
 * SSFP (2-D) and spoiled 3-D GRE demos, worst case: Fast 1.1 %, Draft 6 %,
 * Sketch 13 %. Pruning carries the trade-off; the state cap is only a safety
 * bound, because a cap that binds drops near-equal states arbitrarily and a
 * balanced SSFP then goes 40 % wrong. Past 1e-2 pruning drops the transverse
 * states of low flip angles (a 10° GRE loses 93 % at 3e-2), and below half a
 * sub-slice per resolution cell slice profiles break (33–85 % at 0.25).
 */
export function phaseGraphPreset(tolerance: number): PhaseGraphTuning {
    if (tolerance <= 0.02) return { prune: 1e-5, maxStates: 2000, density: 2, rfStep: 5, fine: { t: 0.005, b1: 0.0025 } };
    if (tolerance <= 0.05) return { prune: 3e-4, maxStates: 2000, density: 1.5, rfStep: 10, fine: { t: 0.01, b1: 0.005 } };
    if (tolerance <= 0.1) return { prune: 1e-3, maxStates: 2000, density: 1, rfStep: 20, fine: { t: 0.02, b1: 0.01 } };
    return { prune: 1e-2, maxStates: 2000, density: 0.5, rfStep: 40, fine: { t: 0.04, b1: 0.02 } };
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
