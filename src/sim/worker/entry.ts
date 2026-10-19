/**
 * Simulation worker: the panel's only route into the simulator. Bundled on its
 * own (web/sim-worker.js) so the page never loads the engine or the parsers.
 *
 * Messages (panel → worker):
 *   { type: 'phantom', id, request }                 load or re-slice a phantom
 *   { type: 'pulses',  id, bytes, name, key? }       measure every RF pulse (plan/slices.ts)
 *   { type: 'open',    job, bytes, name, settings, layout? }  parse, compile, plan
 *   { type: 'previewOpen', id, bytes, name }         recon context for live previews
 *   { type: 'preview', id, signal, coils }           reconstruct a partial signal
 *   { type: 'chunk',   job, chunk }                  simulate one chunk
 *   { type: 'recon',   job, signal }                 images, k-space, raw layout
 *   { type: 'export',  job, id, format, signal }     ISMRMRD / NumPy file bytes
 *   { type: 'close',   job }                         release the job
 * Replies (worker → panel):
 *   { type: 'phantom', id, volume, phantom }   { type: 'pulses', id, pulses }
 *   { type: 'plan', job, plan, layout? }
 *   { type: 'planProgress', job, message, fraction }   { type: 'preview', id, recon }
 *   { type: 'progress', job, chunk, fraction } { type: 'chunk', job, chunk, signal, ms }
 *   { type: 'recon', job, recon, layout }      { type: 'export', job, id, name, mime, bytes }
 *   { type: 'error', request, job?, id?, message }   (request: the failed message's type)
 * Several workers serve one job, each opening it; the panel hands out chunks
 * and sums them in order (job.ts). One worker keeps the job after the run
 * for exports. Cancelling terminates the workers.
 */

import { buildExport, type ExportFormat } from '../io/export';
import { SimulationJob, type JobSettings } from '../job';
import { sheppLoganPhantom2D, sheppLoganVolume } from '../phantom/builtin';
import { loadPhantomFiles, withFieldMode, type FieldMapMode } from '../phantom/files';
import { sliceVolume, type Phantom2D, type PhantomVolume, type SliceOptions } from '../phantom/model';
import { PulseCollector, planSlices, type PulseResponse } from '../plan/slices';
import { standardSelfPort } from '../platform/browser';
import { compileProgram } from '../program/compile';
import { reconstructCartesian } from '../recon/cartesian';
import { adcEncodingExtents, adcTrajectory, type AdcTrajectory } from '../recon/trajectory';
import { parseSequenceBytes } from '../../pulseq/sequenceReader';

/**
 * With `neighbours`, a plane of a volume comes with the neighbouring planes
 * the sequence's slabs reach, for through-slice sampling.
 */
type PhantomRequest = SequenceRef & (
    /** The built-in phantom in the FOV of the given sequence (0.256 m without one). */
    | { kind: 'shepp-logan'; size: number }
    /** The built-in 3-D phantom as a volume (kept for re-slicing), size² in-plane (see sheppLogan3d). */
    | { kind: 'shepp-logan-3d'; size: number; fields: FieldMapMode; slice: SliceOptions }
    /** Parse files into a volume (kept for re-slicing) and return one plane. */
    | { kind: 'files'; files: { name: string; bytes: ArrayBuffer }[]; fields: FieldMapMode; slice: SliceOptions }
    /** Another plane, or other field maps, of the volume loaded last. */
    | { kind: 'slice'; fields: FieldMapMode; slice: SliceOptions });

/**
 * The open sequence, sent along with phantom and pulse requests. `key`
 * names these bytes for the panel's session: the worker keeps what it reads
 * from the last keyed sequence (SequenceFacts), so switching phantoms does
 * not parse it again.
 */
interface SequenceRef {
    sequence?: ArrayBuffer;
    name?: string;
    key?: number;
    /** Include the neighbouring planes the sequence's slabs reach (through-slice sampling on). */
    neighbours?: boolean;
}

type Request =
    | { type: 'phantom'; id: number; request: PhantomRequest }
    | { type: 'pulses'; id: number; bytes: ArrayBuffer; name: string; key?: number }
    | { type: 'open'; job: number; bytes: ArrayBuffer; name: string; settings: JobSettings; layout?: boolean }
    | { type: 'previewOpen'; id: number; bytes: ArrayBuffer; name: string }
    | { type: 'preview'; id: number; signal: Float64Array; coils: number }
    | { type: 'chunk'; job: number; chunk: number }
    | { type: 'recon'; job: number; signal: Float64Array }
    | { type: 'export'; job: number; id: number; format: ExportFormat; signal: Float64Array }
    | { type: 'close'; job: number };

const port = standardSelfPort();
const jobs = new Map<number, SimulationJob>();
let volume: PhantomVolume | null = null;

/**
 * What phantom and pulse requests need of a sequence: its FOV definition
 * and, when a 3-D phantom or the RF tab asks, its measured pulses and k
 * extent per axis. Reading them takes seconds for a long 3-D sequence
 * (parsing, then two passes over the program), so they are kept for the
 * last keyed sequence.
 */
interface SequenceFacts {
    key: number | undefined;
    /** The FOV definition [m], as many entries as it has, or null. */
    fov: number[] | null;
    pulses?: PulseResponse[];
    /** Largest |k| at the ADC samples along x, y and z [1/m]. */
    encoding?: [number, number, number];
}
let facts: SequenceFacts | null = null;

function sequenceFacts(ref: SequenceRef & { sequence: ArrayBuffer }, full: boolean): SequenceFacts {
    if (ref.key !== undefined && facts?.key === ref.key && (!full || facts.pulses)) return facts;
    const seq = parseSequenceBytes(new Uint8Array(ref.sequence), ref.name ?? '');
    const definition = seq.definitions.get('FOV');
    const found: SequenceFacts = { key: ref.key, fov: definition ? Array.from(definition, Number) : null };
    if (full) {
        // One pass over the program for both: a long sequence takes seconds per pass.
        const pulses = new PulseCollector();
        found.encoding = adcEncodingExtents(tap(compileProgram(seq).segments(), segment => {
            if (segment.kind === 'rf') pulses.add(segment);
        }));
        found.pulses = pulses.measure();
    }
    if (ref.key !== undefined) facts = found;
    return found;
}

function* tap<T>(items: Iterable<T>, see: (item: T) => void): Generator<T> {
    for (const item of items) {
        see(item);
        yield item;
    }
}
/** Trajectory and FOV of the sequence being run, for reconstructing partial signals. */
let previewSession: { id: number; trajectory: AdcTrajectory; fov: [number, number, number] | null } | null = null;
/** Progress messages per chunk are spaced at least this far apart [ms]. */
const PROGRESS_SPACING_MS = 100;

function now(): number {
    const clock = (globalThis as unknown as { performance?: { now(): number } }).performance;
    return clock ? clock.now() : Date.now();
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function jobFor(id: number): SimulationJob {
    const job = jobs.get(id);
    if (!job) throw new Error('The simulation job is not open in this worker.');
    return job;
}

/** Every buffer a phantom holds, so it can be transferred rather than copied. */
function phantomBuffers(phantom: Phantom2D): ArrayBuffer[] {
    const buffers = new Set<ArrayBuffer>();
    for (const maps of [phantom.maps, ...(phantom.planes ?? []).map(plane => plane.maps)]) {
        for (const map of Object.values(maps)) if (map) buffers.add(map.buffer as ArrayBuffer);
    }
    if (phantom.coils) {
        buffers.add(phantom.coils.re.buffer as ArrayBuffer);
        buffers.add(phantom.coils.im.buffer as ArrayBuffer);
    }
    return [...buffers];
}

function volumeSummary(v: PhantomVolume) {
    return {
        shape: v.shape,
        voxel: v.voxel,
        source: v.source,
        notes: v.notes,
        maps: Object.keys(v.maps).filter(key => v.maps[key as keyof PhantomVolume['maps']]),
    };
}

function loadPhantom(request: PhantomRequest): { volume: ReturnType<typeof volumeSummary> | null; phantom: Phantom2D } {
    const sequence = request.sequence;
    if (request.kind === 'shepp-logan') {
        const fov = sequence ? definedFov(sequenceFacts({ ...request, sequence }, false)) : null;
        return { volume: null, phantom: sheppLoganPhantom2D(request.size, fov ? fov[0] : 0.256, fov ? fov[1] : 0.256) };
    }
    if (request.kind === 'files') {
        volume = loadPhantomFiles(request.files.map(file => ({ name: file.name, bytes: new Uint8Array(file.bytes) })));
    } else if (request.kind === 'shepp-logan-3d') {
        // Its neighbouring planes need the pulses too: read everything in one pass.
        volume = sheppLogan3d(request.size, sequence ? definedFov(sequenceFacts({ ...request, sequence }, !!request.neighbours)) : null);
    } else if (!volume) {
        throw new Error('Load a phantom file first.');
    }
    const fielded = withFieldMode(volume, request.fields);
    const slice: SliceOptions = { ...request.slice };
    if (sequence && request.neighbours) {
        const neighbours = neighbourRange(fielded, slice, () => sequenceFacts({ ...request, sequence }, true));
        if (neighbours) slice.neighbours = neighbours;
    }
    const phantom = sliceVolume(fielded, slice);
    return { volume: volumeSummary(volume), phantom };
}

/** The FOV a sequence defines [m] (x and y positive), or null. */
function definedFov(found: SequenceFacts): number[] | null {
    const fov = found.fov;
    return fov && fov.length >= 2 && fov[0] > 0 && fov[1] > 0 ? fov : null;
}

/**
 * The built-in 3-D phantom for a sequence: size × size in the sequence's
 * in-plane FOV. A 3-D sequence (FOV along z at least a quarter of x) sets
 * the extent along z; a 2-D one's FOV along z is its slice, so the phantom
 * is then a cube. Voxels are isotropic, at most 64 planes.
 */
function sheppLogan3d(size: number, fov: number[] | null): PhantomVolume {
    const fx = fov ? fov[0] : 0.256, fy = fov ? fov[1] : 0.256;
    const fz = fov && fov.length > 2 && fov[2] >= 0.25 * fx ? fov[2] : fx;
    const nz = Math.max(2, Math.min(64, Math.round(size * fz / fx)));
    return sheppLoganVolume(size, nz, [fx, fy, fz]);
}

/**
 * Plane offsets along the slice's normal that the sequence's sub-slices can
 * reach (plan/slices.ts), or undefined when one plane is enough: a single
 * plane, or no slab selective along z. An excitation that is not selective
 * along z reaches every plane.
 */
function neighbourRange(v: PhantomVolume, slice: SliceOptions, sequence: () => SequenceFacts): [number, number] | undefined {
    const plane = slice.plane ?? 'xy';
    const normal = plane === 'xy' ? 2 : plane === 'xz' ? 1 : 0;
    const planes = v.shape[normal];
    if (planes < 2) return undefined;
    const spacing = v.voxel[normal];
    const index = Math.round(slice.index ?? Math.floor(planes / 2));
    let offResonance = 0;
    if (v.maps.b0) for (let i = 0; i < v.maps.b0.length; i++) if (v.maps.pd[i] > 0) offResonance = Math.max(offResonance, Math.abs(v.maps.b0[i]));
    const found = sequence();
    const plan = planSlices(found.pulses!, {
        density: 1, planeThickness: spacing, offResonance,
        volume: [(-index - 0.5) * spacing, (planes - 1 - index + 0.5) * spacing],
        encodingZ: found.encoding![normal],
    });
    if (plan?.extent === 'volume') return [-index, planes - 1 - index];
    if (!plan || plan.extent === 'plane' || !(spacing > 0)) return undefined;
    const lo = Math.min(...plan.ranges.map(r => Math.round(r[0] / spacing)));
    const hi = Math.max(...plan.ranges.map(r => Math.round(r[1] / spacing)));
    return lo === 0 && hi === 0 ? undefined : [lo, hi];
}

/** Every buffer of the measured pulses, for transfer. */
function pulseBuffers(pulses: PulseResponse[]): ArrayBuffer[] {
    return pulses.flatMap(p => [p.offsets, p.mx, p.my, p.mz].map(a => a.buffer as ArrayBuffer));
}

function handle(request: Request): void {
    switch (request.type) {
        case 'phantom': {
            const result = loadPhantom(request.request);
            port.post({ type: 'phantom', id: request.id, ...result }, phantomBuffers(result.phantom));
            return;
        }
        case 'pulses': {
            const found = sequenceFacts({ sequence: request.bytes, name: request.name, key: request.key }, true);
            // The worker keeps its own: send copies.
            const pulses = found.pulses!.map(p => ({ ...p, offsets: p.offsets.slice(), mx: p.mx.slice(), my: p.my.slice(), mz: p.mz.slice() }));
            port.post({ type: 'pulses', id: request.id, pulses }, pulseBuffers(pulses));
            return;
        }
        case 'open': {
            // One job at a time: a new open replaces whatever ran before.
            jobs.clear();
            let last = -Infinity;
            const job = new SimulationJob(new Uint8Array(request.bytes), request.name, request.settings, {
                onPlanProgress: (message, fraction) => {
                    const t = now();
                    if (t - last < PROGRESS_SPACING_MS) return;
                    last = t;
                    port.post({ type: 'planProgress', job: request.job, message, fraction }, []);
                },
            });
            jobs.set(request.job, job);
            // The leader sends where every sample sits, so the panel can show partial raw data.
            const layout = request.layout ? job.rawLayout() : undefined;
            port.post({ type: 'plan', job: request.job, plan: job.plan, layout }, layout ? [layout.k.buffer as ArrayBuffer] : []);
            return;
        }
        case 'previewOpen': {
            const seq = parseSequenceBytes(new Uint8Array(request.bytes), request.name);
            const definition = seq.definitions.get('FOV');
            const fov: [number, number, number] | null = definition && definition.length >= 2 && definition.every(v => Number.isFinite(+v))
                ? [+definition[0], +definition[1], definition.length > 2 ? +definition[2] : 0]
                : null;
            previewSession = { id: request.id, trajectory: adcTrajectory(compileProgram(seq)), fov };
            return;
        }
        case 'preview': {
            if (!previewSession || previewSession.id !== request.id) throw new Error('No preview session for this run.');
            const recon = reconstructCartesian(previewSession.trajectory, request.signal, request.coils, { fov: previewSession.fov });
            port.post({
                type: 'preview',
                id: request.id,
                recon: {
                    axes: recon.axes, nu: recon.nu, nv: recon.nv, delta: recon.delta, frames: recon.frames,
                    wAxis: recon.wAxis, nw: recon.nw, deltaW: recon.deltaW,
                    images: recon.images, kspace: recon.kspace,
                },
            }, [recon.images.buffer as ArrayBuffer, recon.kspace.buffer as ArrayBuffer]);
            return;
        }
        case 'chunk': {
            const job = jobFor(request.job);
            const started = now();
            let last = started;
            const signal = job.simulateChunk(request.chunk, {
                progressInterval: 16,
                onProgress: fraction => {
                    const t = now();
                    if (t - last < PROGRESS_SPACING_MS) return;
                    last = t;
                    port.post({ type: 'progress', job: request.job, chunk: request.chunk, fraction }, []);
                },
            });
            port.post(
                { type: 'chunk', job: request.job, chunk: request.chunk, signal, ms: now() - started },
                [signal.buffer as ArrayBuffer],
            );
            return;
        }
        case 'recon': {
            const job = jobFor(request.job);
            const recon = job.reconstruct(request.signal);
            const layout = job.rawLayout();
            const transfer: ArrayBuffer[] = [recon.images.buffer as ArrayBuffer, recon.kspace.buffer as ArrayBuffer];
            for (const stack of [recon.coilImages, recon.coilKspace]) {
                if (stack) transfer.push(stack.re.buffer as ArrayBuffer, stack.im.buffer as ArrayBuffer);
            }
            transfer.push(layout.k.buffer as ArrayBuffer);
            port.post({
                type: 'recon',
                job: request.job,
                recon: {
                    axes: recon.axes,
                    nu: recon.nu,
                    nv: recon.nv,
                    delta: recon.delta,
                    wAxis: recon.wAxis,
                    nw: recon.nw,
                    deltaW: recon.deltaW,
                    frames: recon.frames,
                    images: recon.images,
                    kspace: recon.kspace,
                    coilImages: recon.coilImages,
                    coilKspace: recon.coilKspace,
                    fill: recon.fill,
                    offGridFraction: recon.offGridFraction,
                    warnings: recon.warnings,
                },
                // The phantom the job simulated (resolved coils included), for the Phantom view.
                phantom: job.phantom,
                layout,
            }, transfer);
            return;
        }
        case 'export': {
            const job = jobFor(request.job);
            const file = buildExport(job, request.signal, request.format);
            port.post({ type: 'export', job: request.job, id: request.id, ...file }, [file.bytes.buffer as ArrayBuffer]);
            return;
        }
        case 'close':
            jobs.delete(request.job);
            return;
    }
}

port.onMessage(data => {
    const request = data as Request;
    try {
        handle(request);
    } catch (error) {
        const ids = request as { job?: number; id?: number };
        // `request` says what failed: phantom, pulse and preview ids count separately.
        port.post({ type: 'error', request: request.type, job: ids.job ?? -1, id: ids.id ?? -1, message: errorMessage(error) }, []);
    }
});
