/**
 * Through-slice sampling: where along z to put spins so that every pulse's
 * selectivity along z acts on them.
 *
 * The RF itself is not modelled here. The engine steps each pulse's waveform
 * per raster cell with the gradients playing at the time, the pulse's
 * frequency and phase, and each spin's off-resonance and B1 scale. Every
 * pulse goes through that same stepping: excitation, refocusing, adiabatic
 * inversion, VERSE, multiband, spectral-spatial and spectrally selective
 * (fat-sat). What a 2-D phantom lacks is spins anywhere but z = 0, where
 * every slice-selective pulse acts at its nominal flip. This places them.
 *
 * Each distinct pulse is measured (measurePulses). Spins are stepped through
 * it from equilibrium, without relaxation, and its activity is recorded:
 * |β| = √((1 − Mz)/2), the sine of half the tip. That covers any use: an
 * excitation tips by α (|β| = sin α/2), and refocusing or inversion by up to
 * 180°. A small-tip scan over ±Z_LIMIT (the Fourier transform of B1 along the
 * pulse's excitation k-space) finds where the pulse acts. Each region is then
 * scanned finely with the full spinor, so non-linear and adiabatic pulses get
 * their true profile. The bands are the stretches above SUPPORT_LEVEL of the
 * pulse's peak; a multiband pulse has several.
 *
 * Spins go where the excitation pulses act (and pulses of other or unknown
 * use). Refocusing, inversion and saturation pulses act on every spin placed
 * but do not widen the range. Outside the excited slab they make only
 * pathways that the crushers and spoilers around them are there to remove,
 * and a coarse sampling of those crushers would turn them into false signal.
 * When some excitation is not selective along z, the range is the phantom
 * plane's own thickness instead, since an extruded 2-D phantom would
 * otherwise be excited without bound.
 *
 * The spacing at z is 1/(density · Kz), where Kz is the k-space extent along
 * z of the pulses acting there (|Gz|·T on a plateau; VERSE keeps it). The
 * small-tip profile is the Fourier transform of B1 over that extent, so
 * density 1 samples it at the Nyquist rate. Where a pulse's activity has
 * fallen below 10 %, 2 % and 0.4 % of its peak, the spacing doubles each time:
 * tails matter less, and some are wide (a UTE half-pulse's dispersive part
 * falls off as 1/z). The sub-slices run outward from each range's middle, so
 * a symmetric range gets a symmetric grid: UTE's two half-pulses then cancel
 * their dispersive parts exactly, as they do in the scanner.
 * probeSliceDensity picks the density by simulation. Each sub-slice weighs
 * its width over the excitation's slice thickness, so a sharp slab keeps the
 * 2-D signal scale.
 */

import { rfCells, simulateReference, stepRfVector, type RfCells } from '../engine/reference';
import type { SpinSet } from '../engine/spins';
import type { SimProgram } from '../program/compile';
import type { RfSegment } from '../program/types';

export type PulseRole = 'excitation' | 'refocusing' | 'inversion' | 'saturation' | 'other';

export interface PulseBand {
    /** Where the activity exceeds SUPPORT_LEVEL of the pulse's peak [m]. */
    from: number;
    to: number;
    /** Centroid and FWHM of the band's action [m]: |Mxy| for excitations, (1 − Mz)/2 = |β|² otherwise. */
    centre: number;
    thickness: number;
}

export interface PulseResponse {
    /** RF operator keys measured as this pulse (keys that differ only in x/y gradients act alike along z). */
    keys: string[];
    role: PulseRole;
    /** RF events playing the pulse. */
    events: number;
    /** Start of the first such event [s]. */
    firstTime: number;
    duration: number;
    /** Carrier offset of the pulse [Hz]. */
    freq: number;
    /** Largest tip over the scan [deg]. */
    peakFlipDeg: number;
    /** k-space extent along z [1/m]; 0 for a pulse that plays no z gradient. */
    extentZ: number;
    /** z [m] for pulses selective along z; otherwise the spin's off-resonance [Hz] at the isocentre. */
    axis: 'z' | 'frequency';
    /** Scan points, ascending. Between separately scanned regions the pulse is quiet (equilibrium). */
    offsets: Float64Array;
    /** Magnetization after the pulse from equilibrium, without relaxation. */
    mx: Float64Array;
    my: Float64Array;
    mz: Float64Array;
    /** Stretches scanned (between them the pulse is quiet). */
    regions: [number, number][];
    /** Bands along z (none for frequency scans). */
    bands: PulseBand[];
}

export interface MeasureOptions {
    /** Half-range of the z scan [m] (default Z_LIMIT). */
    zLimit?: number;
}

export interface SlicePlanOptions {
    /** Sub-slices per 1/Kz (default 2; probeSliceDensity chooses it). */
    density?: number;
    /** Most sub-slices (default 512): the spacing widens to fit. */
    maxSlices?: number;
    /** Largest |off-resonance| among the spins [Hz]: each band widens by Δf/Ḡz. */
    offResonance?: number;
    /** The phantom plane's thickness [m], the range when an excitation is not selective along z. */
    planeThickness?: number;
    /**
     * A 3-D phantom's extent along z [m]. An excitation that is not
     * selective along z (or a sequence without any selective pulse) then
     * excites all of it, and every plane gets sub-slices: they are at most
     * planeThickness apart.
     */
    volume?: [number, number];
    /**
     * The largest |kz| the readouts sample [1/m], e.g. 3-D phase encoding:
     * sub-slices are at most 1/(4·density·kz) apart, so spins at points do
     * not alias the encoding and a box voxel's response at the encoding's
     * edge, sinc(½), comes out within ~3 % (four points per encoded voxel).
     */
    encodingZ?: number;
    /**
     * Sub-slices stand for boxes integrated over their extent (the
     * phase-graph engine, whose states carry gradient dephasing in k): only
     * the pulses' profiles need sampling, so a 3-D phantom's plane needs one
     * sub-slice where no pulse acts, at any density, and the z encoding sets
     * no spacing.
     */
    boxes?: boolean;
}

export interface SlicePlan {
    /** Sub-slice centres [m], ascending. */
    z: Float64Array;
    /** Each sub-slice's signal weight: its width over `reference`. */
    weight: Float64Array;
    /** Width each sub-slice stands for [m]. */
    width: Float64Array;
    density: number;
    /** Slice thickness the weights are relative to [m]. */
    reference: number;
    /** The merged ranges the sub-slices cover [m]. */
    ranges: [number, number][];
    /** Whether the range comes from the pulses' bands, the phantom plane's thickness or a 3-D phantom's extent. */
    extent: 'pulses' | 'plane' | 'volume';
    /** The spacing was widened to stay within maxSlices. */
    coarsened: boolean;
}

/** Half-range of the z scan [m]: a body, beyond which no receive coil sees. */
const Z_LIMIT = 0.25;
/** Below this k-space extent along z [1/m] a pulse varies over more than half a metre: not selective. */
const MIN_EXTENT = 2;
/** Small-tip level, relative to its peak, that marks a region for the fine scan. */
const CANDIDATE_LEVEL = 1e-4;
/**
 * Activity relative to the pulse's peak that ends a band. Lower than it looks
 * necessary: in a spoiled steady state long-T1 tissue is saturated at the
 * slice centre but not in the barely tipped tails, which can then give
 * several times their share of the signal.
 */
const SUPPORT_LEVEL = 0.002;
/** Activity at a scanned region's end, relative to the peak, that makes it grow. */
const EDGE_LEVEL = 1e-3;
/** Points of the small-tip scan, at most, and of all fine scans of one pulse. */
const COARSE_POINTS = 16_384;
const FINE_POINTS = 4096;
/** Fine-scan points per resolution cell (1/Kz or 1/T), and per region at least. */
const FINE_PER_CELL = 4;
const FINE_MIN_POINTS = 64;
/** Points of a frequency scan, and the share of the small-tip energy its window holds. */
const SPECTRAL_POINTS = 1024;
const SPECTRAL_ENERGY = 0.995;
/** Activity tiers (relative to the pulse's peak) below which the spacing doubles. */
const TIERS = [0.1, 0.02, 0.004];
/** Largest off-resonance of a frequency scan [Hz]. */
const FREQUENCY_LIMIT = 50_000;

// ─── Measuring pulses ────────────────────────────────────────────────────

/** Every distinct pulse of the program, measured (see the file comment). */
export function measurePulses(program: SimProgram, options: MeasureOptions = {}): PulseResponse[] {
    const pulses = new PulseCollector();
    for (const segment of program.segments()) if (segment.kind === 'rf') pulses.add(segment);
    return pulses.measure(options);
}

/** measurePulses in two steps, for a pass over the program that does more: each RF segment, then the measurement. */
export class PulseCollector {
    private readonly found = new Map<string, { segment: RfSegment; events: number; uses: Set<string> }>();

    add(segment: RfSegment): void {
        const use = segment.use || 'u';
        const entry = this.found.get(segment.key);
        if (entry) {
            entry.events++;
            entry.uses.add(use);
        } else {
            this.found.set(segment.key, { segment, events: 1, uses: new Set([use]) });
        }
    }

    measure(options: MeasureOptions = {}): PulseResponse[] {
        // Keys that differ only in what does not change the response along z
        // (x and y gradients, as in a TrueFISP whose phase encode overlaps the
        // pulse) are measured once.
        const alike = new Map<string, { segment: RfSegment; cells: RfCells; keys: string[]; events: number; uses: Set<string> }>();
        for (const [key, entry] of this.found) {
            const cells = rfCells(entry.segment, 0);
            const signature = zSignature(cells);
            const twin = alike.get(signature);
            if (twin) {
                twin.keys.push(key);
                twin.events += entry.events;
                for (const use of entry.uses) twin.uses.add(use);
            } else {
                alike.set(signature, { segment: entry.segment, cells, keys: [key], events: entry.events, uses: entry.uses });
            }
        }
        return [...alike.values()].map(entry => measurePulse(entry.segment, entry.cells, entry.keys, roleOf(entry.uses), entry.events, options));
    }
}

/** Hash of what sets a pulse's response along z: cell widths, B1, z gradient and carrier. */
function zSignature(cells: RfCells): string {
    const n = cells.count;
    const values = new Float64Array(4 * n + 1);
    values[0] = cells.freq;
    for (let j = 0; j < n; j++) {
        values[1 + 4 * j] = cells.width[j];
        values[2 + 4 * j] = cells.b1Re[j];
        values[3 + 4 * j] = cells.b1Im[j];
        values[4 + 4 * j] = cells.grad[3 * j + 2];
    }
    const words = new Uint32Array(values.buffer);
    let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
    for (let i = 0; i < words.length; i++) {
        h1 = Math.imul(h1 ^ words[i], 0x01000193);
        h2 = Math.imul(h2 ^ words[i], 0x5bd1e995) ^ (h2 >>> 15);
    }
    return `${n}:${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}`;
}

/** The role that matters most for signal among the uses a pulse is played with. */
function roleOf(uses: Set<string>): PulseRole {
    if (uses.has('e') || uses.has('u')) return 'excitation';
    if (uses.has('r')) return 'refocusing';
    if (uses.has('p') || uses.has('o')) return 'other';
    if (uses.has('i')) return 'inversion';
    if (uses.has('s')) return 'saturation';
    return 'other';
}

/** Cells of the pulse in excitation k-space: where each cell's B1 lands, along z and in time. */
interface PulseGeometry {
    cells: RfCells;
    duration: number;
    /** Gradient area from each cell's middle to the pulse end along z [1/m]. */
    kappa: Float64Array;
    /** Time from each cell's middle to the pulse end [s]. */
    tau: Float64Array;
    extentZ: number;
}

function geometry(cells: RfCells): PulseGeometry {
    const n = cells.count;
    let duration = 0;
    for (let j = 0; j < n; j++) duration += cells.width[j];
    const kappa = new Float64Array(n), tau = new Float64Array(n);
    let tail = 0, lo = 0, hi = 0, end = duration;
    for (let j = n - 1; j >= 0; j--) {
        const w = cells.width[j], g = cells.grad[3 * j + 2];
        kappa[j] = tail + 0.5 * g * w;
        tau[j] = end - 0.5 * w;
        tail += g * w;
        end -= w;
        lo = Math.min(lo, tail);
        hi = Math.max(hi, tail);
    }
    return { cells, duration, kappa, tau, extentZ: hi - lo };
}

function measurePulse(
    segment: RfSegment, cells: RfCells, keys: string[], role: PulseRole, events: number, options: MeasureOptions,
): PulseResponse {
    const shape = geometry(cells);
    const { duration, extentZ } = shape;
    const selective = extentZ >= MIN_EXTENT;
    // Scan coordinate u: z, or the off-resonance. Cell j's small-tip phase is κ_j·u − f·τ_j cycles.
    const resolution = selective ? 1 / extentZ : 1 / Math.max(duration, 1e-6);
    let limit: number;
    if (selective) {
        limit = options.zLimit ?? Z_LIMIT;
    } else {
        let narrowest = Infinity;
        for (let j = 0; j < cells.count; j++) narrowest = Math.min(narrowest, cells.width[j]);
        limit = Math.min(FREQUENCY_LIMIT, 0.5 / narrowest);
    }
    const slope = selective ? shape.kappa : shape.tau;
    const small = smallTip(cells, slope, shape.tau, -limit, limit, resolution);
    let regions: [number, number][];
    let scan: Scan;
    if (selective) {
        regions = candidateRegions(small, resolution, -limit, limit);
        scan = fineScan(cells, true, regions, resolution, limit);
    } else {
        // Frequency scans are for display: one window holding nearly all the
        // small-tip energy, and the water line Δf = 0.
        const [from, to] = energyWindow(small);
        const pad = Math.max(0.25 * (to - from), 4 * resolution);
        regions = [[Math.max(-limit, Math.min(0, from) - pad), Math.min(limit, Math.max(0, to) + pad)]];
        const points = Math.max(128, Math.min(SPECTRAL_POINTS, Math.ceil((regions[0][1] - regions[0][0]) / (resolution / FINE_PER_CELL)) + 1));
        scan = uniformScan(cells, false, regions[0][0], regions[0][1], points);
    }
    let peak = 0;
    for (let i = 0; i < scan.mz.length; i++) peak = Math.max(peak, activity(scan.mz[i]));
    return {
        keys,
        role,
        events,
        firstTime: segment.t0,
        duration,
        freq: cells.freq,
        peakFlipDeg: 2 * Math.asin(Math.min(1, peak)) * 180 / Math.PI,
        extentZ: selective ? extentZ : 0,
        axis: selective ? 'z' : 'frequency',
        offsets: scan.offsets,
        mx: scan.mx,
        my: scan.my,
        mz: scan.mz,
        regions,
        bands: selective ? findBands(scan, role, resolution) : [],
    };
}

/** |β| from Mz after a rotation from equilibrium. */
function activity(mz: number): number {
    return Math.sqrt(Math.max(0, 0.5 * (1 - mz)));
}

/** The small-tip response |Σ_j B1_j·w_j·e^{i2π(s_j·u − f·τ_j)}| on a uniform grid over [from, to]. */
function smallTip(
    cells: RfCells, slope: Float64Array, tau: Float64Array, from: number, to: number, resolution: number,
): { from: number; step: number; magnitude: Float64Array } {
    const points = Math.max(256, Math.min(COARSE_POINTS, Math.ceil((to - from) / (0.25 * resolution)) + 1));
    const step = (to - from) / (points - 1);
    const sumRe = new Float64Array(points), sumIm = new Float64Array(points);
    const twoPi = 2 * Math.PI;
    for (let j = 0; j < cells.count; j++) {
        const cr = cells.b1Re[j] * cells.width[j], ci = cells.b1Im[j] * cells.width[j];
        if (cr === 0 && ci === 0) continue;
        const stepCycles = slope[j] * step;
        const sr = Math.cos(twoPi * (stepCycles - Math.round(stepCycles)));
        const si = Math.sin(twoPi * (stepCycles - Math.round(stepCycles)));
        let er = 0, ei = 0;
        for (let i = 0; i < points; i++) {
            if (i % 256 === 0) {
                const cycles = slope[j] * (from + i * step) - cells.freq * tau[j];
                const angle = twoPi * (cycles - Math.round(cycles));
                er = Math.cos(angle);
                ei = Math.sin(angle);
            } else {
                const nr = er * sr - ei * si;
                ei = er * si + ei * sr;
                er = nr;
            }
            sumRe[i] += cr * er - ci * ei;
            sumIm[i] += cr * ei + ci * er;
        }
    }
    const magnitude = new Float64Array(points);
    for (let i = 0; i < points; i++) magnitude[i] = Math.hypot(sumRe[i], sumIm[i]);
    return { from, step, magnitude };
}

/** Where the small-tip response exceeds CANDIDATE_LEVEL of its peak, padded by 4 resolution cells (gaps under 2 merged). */
function candidateRegions(
    small: { from: number; step: number; magnitude: Float64Array }, resolution: number, lo: number, hi: number,
): [number, number][] {
    const { from, step, magnitude } = small;
    let peak = 0;
    for (let i = 0; i < magnitude.length; i++) peak = Math.max(peak, magnitude[i]);
    if (!(peak > 0)) return [];
    const runs: [number, number][] = [];
    for (let i = 0; i < magnitude.length; i++) {
        if (magnitude[i] < CANDIDATE_LEVEL * peak) continue;
        const u = from + i * step;
        const last = runs[runs.length - 1];
        if (last && u - last[1] <= 2 * resolution + step) last[1] = u;
        else runs.push([u, u]);
    }
    return mergeIntervals(runs.map(([a, b]) => [Math.max(lo, a - 4 * resolution), Math.min(hi, b + 4 * resolution)]));
}

/** The narrowest window holding SPECTRAL_ENERGY of the small-tip energy, trimmed equally from both ends. */
function energyWindow(small: { from: number; step: number; magnitude: Float64Array }): [number, number] {
    const { from, step, magnitude } = small;
    let total = 0;
    for (let i = 0; i < magnitude.length; i++) total += magnitude[i] * magnitude[i];
    if (!(total > 0)) return [0, 0];
    const cut = 0.5 * (1 - SPECTRAL_ENERGY) * total;
    let lo = 0, hi = magnitude.length - 1, sum = 0;
    while (lo < hi && sum + magnitude[lo] ** 2 <= cut) sum += magnitude[lo++] ** 2;
    sum = 0;
    while (hi > lo && sum + magnitude[hi] ** 2 <= cut) sum += magnitude[hi--] ** 2;
    return [from + lo * step, from + hi * step];
}

/** The pulse stepped at `points` uniform points over [from, to]. */
function uniformScan(cells: RfCells, selective: boolean, from: number, to: number, points: number): Scan {
    const offsets = new Float64Array(points);
    for (let i = 0; i < points; i++) offsets[i] = points > 1 ? from + (to - from) * i / (points - 1) : 0.5 * (from + to);
    const [mx, my, mz] = respond(cells, selective, offsets);
    return { offsets, mx, my, mz, spacing: new Float64Array(points).fill(points > 1 ? (to - from) / (points - 1) : 0) };
}

interface Scan {
    offsets: Float64Array;
    mx: Float64Array;
    my: Float64Array;
    mz: Float64Array;
    /** Point spacing of each sample's region. */
    spacing: Float64Array;
}

/**
 * The pulse stepped from equilibrium at points across each region. A region
 * whose end is still active grows on that side, up to four times.
 */
function fineScan(cells: RfCells, selective: boolean, regions: [number, number][], resolution: number, limit: number): Scan {
    // `regions` is updated to the stretches finally scanned.
    const total = regions.reduce((sum, [a, b]) => sum + (b - a), 0);
    const spacingFor = (width: number) => {
        const wanted = resolution / FINE_PER_CELL;
        const budget = total > 0 ? total / FINE_POINTS : wanted;
        return Math.min(Math.max(wanted, budget), width / (FINE_MIN_POINTS - 1));
    };
    const parts: { offsets: Float64Array; m: Float64Array[]; spacing: number }[] = [];
    let peak = 0;
    const scanRegion = (a: number, b: number) => {
        const h = spacingFor(Math.max(b - a, resolution));
        const count = Math.max(FINE_MIN_POINTS, Math.round((b - a) / h) + 1);
        const offsets = new Float64Array(count);
        for (let i = 0; i < count; i++) offsets[i] = count > 1 ? a + (b - a) * i / (count - 1) : 0.5 * (a + b);
        const m = respond(cells, selective, offsets);
        for (let i = 0; i < count; i++) peak = Math.max(peak, activity(m[2][i]));
        return { offsets, m, spacing: count > 1 ? (b - a) / (count - 1) : resolution };
    };
    for (const region of regions) {
        let [a, b] = region;
        let part = scanRegion(a, b);
        for (let grow = 0; grow < 4; grow++) {
            const n = part.offsets.length;
            const left = activity(part.m[2][0]), right = activity(part.m[2][n - 1]);
            const widen = Math.max(b - a, 8 * resolution);
            const growLeft = left > EDGE_LEVEL * peak && a > -limit;
            const growRight = right > EDGE_LEVEL * peak && b < limit;
            if (!growLeft && !growRight) break;
            if (growLeft) a = Math.max(-limit, a - widen);
            if (growRight) b = Math.min(limit, b + widen);
            part = scanRegion(a, b);
        }
        region[0] = a;
        region[1] = b;
        parts.push(part);
    }
    regions.splice(0, regions.length, ...mergeIntervals(regions));
    // Grown regions may overlap: keep points in ascending order, each once.
    parts.sort((p, q) => p.offsets[0] - q.offsets[0]);
    const offsets: number[] = [], mx: number[] = [], my: number[] = [], mz: number[] = [], spacing: number[] = [];
    for (const part of parts) {
        for (let i = 0; i < part.offsets.length; i++) {
            if (offsets.length && part.offsets[i] <= offsets[offsets.length - 1]) continue;
            offsets.push(part.offsets[i]);
            mx.push(part.m[0][i]);
            my.push(part.m[1][i]);
            mz.push(part.m[2][i]);
            spacing.push(part.spacing);
        }
    }
    return {
        offsets: Float64Array.from(offsets),
        mx: Float64Array.from(mx), my: Float64Array.from(my), mz: Float64Array.from(mz),
        spacing: Float64Array.from(spacing),
    };
}

/** Magnetization after the pulse from equilibrium at z (selective) or off-resonance points, no relaxation. */
function respond(cells: RfCells, selective: boolean, offsets: Float64Array): Float64Array[] {
    const n = offsets.length;
    const zeros = new Float64Array(n);
    const spins: SpinSet = {
        count: n,
        x: zeros, y: zeros, z: selective ? offsets : zeros,
        df: selective ? zeros : offsets,
        r1: zeros, r2: zeros,
        weight: new Float64Array(n).fill(1),
        b1Re: new Float64Array(n).fill(1), b1Im: zeros,
        coils: 1,
        rxRe: new Float64Array(n).fill(1), rxIm: zeros,
    };
    const mx = new Float64Array(n), my = new Float64Array(n), mz = new Float64Array(n);
    for (let i = 0; i < n; i++) [mx[i], my[i], mz[i]] = stepRfVector(cells, spins, i, 0, 0, 1);
    return [mx, my, mz];
}

/** Bands of a z scan: runs above SUPPORT_LEVEL of the peak, gaps under 2 resolution cells merged. */
function findBands(scan: Scan, role: PulseRole, resolution: number): PulseBand[] {
    const n = scan.offsets.length;
    const level = new Float64Array(n);
    let peak = 0;
    for (let i = 0; i < n; i++) {
        level[i] = activity(scan.mz[i]);
        peak = Math.max(peak, level[i]);
    }
    if (!(peak > 1e-9)) return [];
    const runs: [number, number][] = [];       // index ranges
    for (let i = 0; i < n; i++) {
        if (level[i] < SUPPORT_LEVEL * peak) continue;
        const last = runs[runs.length - 1];
        if (last && scan.offsets[i] - scan.offsets[last[1]] <= 2 * resolution + scan.spacing[i]) last[1] = i;
        else runs.push([i, i]);
    }
    const excites = role === 'excitation' || role === 'other';
    const action = (i: number) => (excites ? Math.hypot(scan.mx[i], scan.my[i]) : 0.5 * (1 - scan.mz[i]));
    return runs.map(([first, last]) => {
        let top = first, topValue = -1, sum = 0, moment = 0;
        for (let i = first; i <= last; i++) {
            const value = action(i);
            sum += value;
            moment += value * scan.offsets[i];
            if (value > topValue) { topValue = value; top = i; }
        }
        const half = topValue / 2;
        const crossing = (step: number) => {
            let i = top;
            while (i + step >= first && i + step <= last && action(i + step) >= half) i += step;
            const j = i + step;
            if (j < first || j > last) return scan.offsets[i];
            const t = (action(i) - half) / (action(i) - action(j));
            return scan.offsets[i] + t * (scan.offsets[j] - scan.offsets[i]);
        };
        return {
            from: scan.offsets[first] - scan.spacing[first],
            to: scan.offsets[last] + scan.spacing[last],
            centre: sum > 0 ? moment / sum : scan.offsets[top],
            thickness: Math.abs(crossing(1) - crossing(-1)),
        };
    });
}

// ─── Sub-slices ──────────────────────────────────────────────────────────

/**
 * Sub-slices for the measured pulses, or null when no pulse is selective
 * along z (or an excitation is not, and the plane has no thickness) and the
 * phantom is not 3-D.
 */
export function planSlices(pulses: readonly PulseResponse[], options: SlicePlanOptions = {}): SlicePlan | null {
    const density = Math.max(0.25, options.density ?? 2);
    const maxSlices = Math.max(4, Math.floor(options.maxSlices ?? 512));
    const selective = pulses.filter(p => p.axis === 'z' && p.bands.length);
    const volume = options.volume && options.volume[1] > options.volume[0] ? options.volume : null;
    if (!selective.length && !volume) return null;
    // Caps on the spacing: every plane of a 3-D phantom, and the readouts' z encoding.
    const planeStep = volume && options.planeThickness && options.planeThickness > 0 ? options.planeThickness : Infinity;
    const encodingStep = !options.boxes && options.encodingZ && options.encodingZ > 0 ? 1 / (4 * options.encodingZ) : Infinity;
    const excites = (p: PulseResponse) => p.role === 'excitation' || p.role === 'other';
    const offResonance = Math.abs(options.offResonance ?? 0);
    // Bands widened by how far off-resonance moves them: Δz = Δf / Ḡz.
    const widened = selective.map(p => {
        const margin = offResonance > 0 ? offResonance * p.duration / p.extentZ : 0;
        let peak = 0;
        for (let i = 0; i < p.mz.length; i++) peak = Math.max(peak, activity(p.mz[i]));
        return { pulse: p, margin, peak, bands: p.bands.map(b => [b.from - margin, b.to + margin] as [number, number]) };
    });

    let ranges: [number, number][];
    let reference: number;
    let extent: SlicePlan['extent'];
    if (volume && (!selective.length || pulses.some(p => p.role === 'excitation' && p.axis !== 'z'))) {
        // Everything is excited: the whole volume, each plane weighing one.
        ranges = [volume];
        reference = options.planeThickness && options.planeThickness > 0 ? options.planeThickness : volume[1] - volume[0];
        extent = 'volume';
    } else if (pulses.some(p => p.role === 'excitation' && p.axis !== 'z')) {
        const thickness = options.planeThickness ?? 0;
        if (!(thickness > 0)) return null;
        ranges = [[-thickness / 2, thickness / 2]];
        reference = thickness;
        extent = 'plane';
    } else {
        ranges = mergeIntervals(widened.filter(w => excites(w.pulse)).flatMap(w => w.bands));
        if (!ranges.length) return null;
        const thicknesses = selective.filter(excites).flatMap(p => p.bands.map(b => b.thickness)).filter(t => t > 0);
        reference = thicknesses.length ? Math.max(...thicknesses) : ranges.reduce((sum, [a, b]) => sum + (b - a), 0);
        extent = 'pulses';
    }

    // The spacing at z: the finest the pulses acting there ask for, by tier,
    // within the caps (and their finest where none acts). Boxes need one per
    // plane whatever the density.
    const cap = Math.min(options.boxes ? Infinity : planeStep, encodingStep);
    const finest = Math.min(cap, ...selective.map(p => 1 / p.extentZ));
    const fallback = Number.isFinite(finest) ? finest : options.boxes && Number.isFinite(planeStep) ? planeStep * density : (ranges[0][1] - ranges[0][0]) / 8;
    const stepAt = (z: number, scale: number) => {
        let best = cap;
        for (const w of widened) {
            if (!w.bands.some(([a, b]) => z >= a && z <= b)) continue;
            // Off-resonant spins see the profile shifted by up to the margin.
            const level = Math.max(activityAt(w.pulse, z), activityAt(w.pulse, z - w.margin), activityAt(w.pulse, z + w.margin));
            let tier = 1;
            for (const threshold of TIERS) if (level < threshold * w.peak) tier *= 2;
            best = Math.min(best, tier / w.pulse.extentZ);
        }
        const step = (Number.isFinite(best) ? best : fallback) * scale / density;
        return options.boxes ? Math.min(step, planeStep * scale) : step;
    };
    // A 3-D phantom's planes: no sub-slice may straddle two, or one plane
    // would weigh more than its neighbour (a ripple along z that partition
    // encoding images). Cells are cut at the plane boundaries (k + ½)·Δz.
    const pitch = volume && options.planeThickness && options.planeThickness > 0 ? options.planeThickness : 0;
    for (let scale = 1, attempt = 0; attempt < 40; attempt++, scale *= 1.25) {
        let cells = layout(ranges, z => stepAt(z, scale), maxSlices + 1, pitch);
        if (pitch > 0 && cells.length <= maxSlices) cells = splitAtPlanes(cells, pitch);
        if (cells.length <= maxSlices) {
            const centres = cells.map(([a, b]) => 0.5 * (a + b)), widths = cells.map(([a, b]) => b - a);
            return {
                z: Float64Array.from(centres),
                width: Float64Array.from(widths),
                weight: Float64Array.from(widths, w => w / reference),
                density,
                reference,
                ranges,
                extent,
                coarsened: scale > 1,
            };
        }
    }
    throw new Error('Could not fit the slab into the sub-slice budget.');
}

/** Cells cut wherever they cross a plane boundary (k + ½)·pitch; slivers under 1e-9 of a pitch are dropped. */
function splitAtPlanes(cells: [number, number][], pitch: number): [number, number][] {
    const out: [number, number][] = [];
    for (const [a, b] of cells) {
        let from = a;
        for (let k = Math.ceil(a / pitch - 0.5); (k + 0.5) * pitch < b; k++) {
            const boundary = (k + 0.5) * pitch;
            if (boundary - from > 1e-9 * pitch) out.push([from, boundary]);
            from = Math.max(from, boundary);
        }
        if (b - from > 1e-9 * pitch) out.push([from, b]);
    }
    return out;
}

/**
 * Sub-slices over the ranges, run outward from each range's middle (with
 * planes, the plane boundary nearest it) with the local step (looking half a
 * step and a step ahead, so a dense region is not stepped into). The last
 * one on each side absorbs a remainder under half a step. Stops early past
 * `limit` cells.
 */
function layout(ranges: [number, number][], stepAt: (z: number) => number, limit: number, pitch = 0): [number, number][] {
    const cells: [number, number][] = [];
    for (const [a, b] of ranges) {
        // With planes, start on the plane boundary nearest the middle, so whole-plane steps fit the planes.
        let middle = 0.5 * (a + b);
        if (pitch > 0) middle = Math.min(b, Math.max(a, (Math.round(middle / pitch - 0.5) + 0.5) * pitch));
        for (const direction of [1, -1]) {
            const end = direction > 0 ? b : a;
            let z = middle;
            while (direction * (end - z) > 1e-12 && cells.length < limit) {
                let step = stepAt(z);
                step = Math.min(step, stepAt(z + 0.5 * direction * step), stepAt(z + direction * step));
                const remaining = direction * (end - z);
                if (remaining < 1.5 * step) step = remaining;
                const next = z + direction * step;
                cells.push(direction > 0 ? [z, next] : [next, z]);
                z = next;
            }
        }
    }
    return cells.sort((p, q) => p[0] - q[0]);
}

/** A pulse's activity |β| at z, interpolated from its scan (0 outside the scanned regions). */
function activityAt(pulse: PulseResponse, z: number): number {
    if (!pulse.regions.some(([a, b]) => z >= a && z <= b)) return 0;
    const offsets = pulse.offsets;
    let lo = 0, hi = offsets.length - 1;
    if (!(z >= offsets[lo] && z <= offsets[hi])) return 0;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid] <= z) lo = mid; else hi = mid;
    }
    const span = offsets[hi] - offsets[lo];
    const t = span > 0 ? (z - offsets[lo]) / span : 0;
    return (1 - t) * activity(pulse.mz[lo]) + t * activity(pulse.mz[hi]);
}

// ─── Density probe ───────────────────────────────────────────────────────

export interface SliceProbeTissue {
    t1: number;
    t2: number;
    /** Spins along x the plan gives this tissue. */
    countX: number;
}

export interface SliceProbeOptions extends SlicePlanOptions {
    /** Phantom voxel along x and y [m]. */
    voxel: [number, number];
    /** Spins along y (1 when y folds). */
    countY?: number;
    /** Relative L2 signal error to accept (default 0.02). */
    tolerance?: number;
    /** Densities to try, ascending powers of two (default 1…16). */
    densities?: readonly number[];
    /** Simulated time from the start [s] (default 4 s). */
    horizon?: number;
    /** Probe voxels beyond this many spins are not simulated (default 400 000). */
    spinLimit?: number;
}

export interface SliceProbeResult {
    plan: SlicePlan;
    /** Its signal error against the next finer density (worst tissue). */
    error: number;
    /** No density met the tolerance within the limits; `plan` is the finest tried. */
    capped: boolean;
    tested: { density: number; slices: number; error: number }[];
}

/**
 * The coarsest sub-slice density whose signal matches twice that density
 * within tolerance, for one voxel of each tissue. The voxel keeps the plan's
 * spins along x and y, so the comparison sees only the sampling along z:
 * pathways the in-plane spins already cancel (an x spoiler) cancel at both
 * densities, while dephasing along z alone (a z spoiler, crushers) or a slab
 * profile too coarsely sampled shows up as a difference.
 */
export function probeSliceDensity(
    program: SimProgram,
    pulses: readonly PulseResponse[],
    tissues: readonly SliceProbeTissue[],
    options: SliceProbeOptions,
): SliceProbeResult | null {
    const densities = options.densities ?? [1, 2, 4, 8, 16];
    const tolerance = options.tolerance ?? 0.02;
    const horizon = Math.min(program.totalDuration, options.horizon ?? 4);
    const countY = Math.max(1, Math.floor(options.countY ?? 1));
    const spinLimit = options.spinLimit ?? 400_000;
    const plans = new Map<number, SlicePlan | null>();
    const planAt = (density: number) => {
        if (!plans.has(density)) plans.set(density, planSlices(pulses, { ...options, density }));
        return plans.get(density)!;
    };
    const first = planAt(densities[0]);
    if (!first) return null;
    const order = tissues.slice().sort((a, b) => lifetime(b) - lifetime(a));
    const signals = new Map<string, Float64Array>();
    const signalOf = (plan: SlicePlan, t: number) => {
        const key = `${plan.density}|${t}`;
        let signal = signals.get(key);
        if (!signal) {
            signal = simulateReference(program, probeColumn(plan, order[t], options.voxel, countY), { until: horizon }).signal;
            signals.set(key, signal);
        }
        return signal;
    };
    const tested: SliceProbeResult['tested'] = [];
    let chosen = first;
    for (const density of densities) {
        const plan = planAt(density)!, finer = planAt(2 * density)!;
        const spins = (p: SlicePlan) => Math.max(...order.map(t => t.countX)) * countY * p.z.length;
        if (finer.coarsened || spins(finer) > spinLimit) {
            return { plan: chosen, error: tested.length ? tested[tested.length - 1].error : NaN, capped: true, tested };
        }
        let error = 0;
        for (let t = 0; t < order.length && error <= tolerance; t++) {
            const reference = signalOf(finer, t);
            const scale = norm(reference);
            if (!(scale > 0)) continue;
            error = Math.max(error, distance(signalOf(plan, t), reference) / scale);
        }
        tested.push({ density, slices: plan.z.length, error });
        if (error <= tolerance) return { plan, error, capped: false, tested };
        chosen = finer;
    }
    return { plan: chosen, error: tested[tested.length - 1].error, capped: true, tested };
}

/** One voxel at the isocentre: the tissue's spins along x (and y) at every sub-slice. */
function probeColumn(plan: SlicePlan, tissue: SliceProbeTissue, voxel: [number, number], countY: number): SpinSet {
    const countX = Math.max(1, tissue.countX);
    const perSlice = countX * countY;
    const count = perSlice * plan.z.length;
    const x = new Float64Array(count), y = new Float64Array(count), z = new Float64Array(count);
    const weight = new Float64Array(count);
    let i = 0;
    for (let k = 0; k < plan.z.length; k++) {
        for (let ay = 0; ay < countY; ay++) {
            for (let ax = 0; ax < countX; ax++) {
                x[i] = ((ax + 0.5) / countX - 0.5) * voxel[0];
                y[i] = countY > 1 ? ((ay + 0.5) / countY - 0.5) * voxel[1] : 0;
                z[i] = plan.z[k];
                weight[i] = plan.weight[k] / perSlice;
                i++;
            }
        }
    }
    const rate = (time: number) => (Number.isFinite(time) && time > 0 ? 1 / time : 0);
    return {
        count, x, y, z,
        df: new Float64Array(count),
        r1: new Float64Array(count).fill(rate(tissue.t1)),
        r2: new Float64Array(count).fill(rate(tissue.t2)),
        weight,
        b1Re: new Float64Array(count).fill(1), b1Im: new Float64Array(count),
        coils: 1,
        rxRe: new Float64Array(count).fill(1), rxIm: new Float64Array(count),
    };
}

function lifetime(tissue: { t1: number; t2: number }): number {
    const t2 = Number.isFinite(tissue.t2) ? tissue.t2 : 1e9;
    const t1 = Number.isFinite(tissue.t1) ? tissue.t1 : 1e9;
    return t2 + 1e-6 * t1;
}

function norm(signal: Float64Array): number {
    let sum = 0;
    for (let i = 0; i < signal.length; i++) sum += signal[i] * signal[i];
    return Math.sqrt(sum);
}

function distance(a: Float64Array, b: Float64Array): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
    return Math.sqrt(sum);
}

function mergeIntervals(intervals: [number, number][]): [number, number][] {
    const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [a, b] of sorted) {
        const last = merged[merged.length - 1];
        if (last && a <= last[1]) last[1] = Math.max(last[1], b);
        else merged.push([a, b]);
    }
    return merged;
}
