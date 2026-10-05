/**
 * Phantoms as the simulator consumes them.
 *
 * A PhantomVolume is what a file holds: 3-D maps on a voxel grid in the
 * file's own axis order, x fastest (index = x + nx·(y + ny·z)). A Phantom2D is
 * what a run simulates: one plane of it placed at z = 0 in the scanner's x–y
 * plane, row-major with row 0 at the top (largest y), the layout the
 * reconstructed image uses. Choosing the plane (xy, xz or yz of the volume)
 * decides which anatomy the sequence's x and y gradients encode.
 *
 * Units: seconds for T1, T2 and T2′ (0 or non-finite: no relaxation), m²/s
 * for ADC, Hz for B0 offsets, relative B1+ (1 = nominal flip), relative PD.
 */

import type { SpinMembers, SpinSet } from '../engine/spins';

export interface PhantomMaps {
    pd: Float32Array;
    t1: Float32Array;
    t2: Float32Array;
    /** Stored and shown; not simulated yet. */
    t2prime?: Float32Array;
    /** Stored and shown; not simulated yet. */
    adc?: Float32Array;
    b0?: Float32Array;
    b1?: Float32Array;
}

export type MapName = keyof PhantomMaps;

export const MAP_UNITS: Record<MapName, string> = {
    pd: '', t1: 's', t2: 's', t2prime: 's', adc: 'm²/s', b0: 'Hz', b1: '',
};
export const MAP_LABELS: Record<MapName, string> = {
    pd: 'PD', t1: 'T1', t2: 'T2', t2prime: 'T2′', adc: 'ADC', b0: 'B0', b1: 'B1+',
};
export const MAP_ORDER: MapName[] = ['pd', 't1', 't2', 't2prime', 'adc', 'b0', 'b1'];

export interface PhantomVolume {
    shape: [number, number, number];
    /** Voxel size [m]. */
    voxel: [number, number, number];
    maps: PhantomMaps;
    /** Human-readable origin (file name, preset). */
    source: string;
    /** Caveats found while loading (unit guesses, defaults applied). */
    notes: string[];
}

export interface CoilMaps {
    count: number;
    /** Complex sensitivity, coil-major: [coil·(nx·ny) + voxel]. */
    re: Float32Array;
    im: Float32Array;
}

export interface Phantom2D {
    nx: number;
    ny: number;
    /** Voxel size [m] along x and y, and the plane's thickness (informational). */
    voxel: [number, number, number];
    maps: PhantomMaps;
    coils?: CoilMaps;
    source: string;
    notes: string[];
}

/** Which two volume axes become the simulated x and y. */
export type SlicePlane = 'xy' | 'xz' | 'yz';

export interface SliceOptions {
    plane?: SlicePlane;
    /** Index along the remaining axis (default its middle). */
    index?: number;
    /** Resample to this many voxels along the longer in-plane axis (nearest neighbour); default native. */
    matrix?: number;
}

/**
 * One plane of a volume as a Phantom2D. Resampling picks the nearest source
 * voxel (tissue parameters are not interpolated: mixing T1 values makes a
 * tissue that does not exist) and keeps the field of view.
 */
export function sliceVolume(volume: PhantomVolume, options: SliceOptions = {}): Phantom2D {
    const plane = options.plane ?? 'xy';
    const [sx, sy, sz] = volume.shape;
    // In-plane volume axes (u → simulated x, v → simulated y) and the normal.
    const axes = plane === 'xy' ? [0, 1, 2] : plane === 'xz' ? [0, 2, 1] : [1, 2, 0];
    const sizes = [sx, sy, sz];
    const nu = sizes[axes[0]], nv = sizes[axes[1]], nw = sizes[axes[2]];
    const index = Math.round(options.index ?? Math.floor(nw / 2));
    if (!(index >= 0 && index < nw)) throw new Error(`Slice ${index} is outside 0…${nw - 1}.`);
    const fovU = nu * volume.voxel[axes[0]], fovV = nv * volume.voxel[axes[1]];
    let nx = nu, ny = nv;
    if (options.matrix && options.matrix > 0) {
        const scale = options.matrix / Math.max(nu, nv);
        nx = Math.max(1, Math.round(nu * scale));
        ny = Math.max(1, Math.round(nv * scale));
    }
    const strides = [1, sx, sx * sy];
    const source = new Int32Array(nx * ny);
    for (let row = 0; row < ny; row++) {
        // Row 0 is the top: the largest v.
        const v = Math.min(nv - 1, Math.floor((ny - 1 - row + 0.5) * nv / ny));
        for (let col = 0; col < nx; col++) {
            const u = Math.min(nu - 1, Math.floor((col + 0.5) * nu / nx));
            source[row * nx + col] = u * strides[axes[0]] + v * strides[axes[1]] + index * strides[axes[2]];
        }
    }
    const pick = (map: Float32Array) => {
        const out = new Float32Array(nx * ny);
        for (let i = 0; i < out.length; i++) out[i] = map[source[i]];
        return out;
    };
    const maps: PhantomMaps = { pd: pick(volume.maps.pd), t1: pick(volume.maps.t1), t2: pick(volume.maps.t2) };
    for (const name of ['t2prime', 'adc', 'b0', 'b1'] as const) {
        const map = volume.maps[name];
        if (map) maps[name] = pick(map);
    }
    const label = 'xyz';
    return {
        nx,
        ny,
        voxel: [fovU / nx, fovV / ny, volume.voxel[axes[2]]],
        maps,
        source: `${volume.source} · ${label[axes[0]]}${label[axes[1]]} plane, ${label[axes[2]]} = ${index}`,
        notes: volume.notes.slice(),
    };
}

/**
 * B0 and B1 maps the way MRzero invents them for files that lack them
 * (`generate_B0_B1` in MRzero-Core's voxel_grid_phantom.py), so a phantom
 * loaded here matches what MRzero would simulate: smooth Gaussian B1 and a
 * dipole-like B0, normalised to PD-weighted mean 1 and 0.
 */
export function mrzeroFieldMaps(volume: PhantomVolume): { b0: Float32Array; b1: Float32Array } {
    const [nx, ny, nz] = volume.shape;
    const n = nx * ny * nz;
    const b0 = new Float32Array(n), b1 = new Float32Array(n);
    const lin = (count: number, i: number) => (count > 1 ? -1 + 2 * i / (count - 1) : -1);
    let weightSum = 0, b0Sum = 0, b1Sum = 0;
    for (let z = 0; z < nz; z++) {
        const pz = lin(nz, z);
        for (let y = 0; y < ny; y++) {
            const py = lin(ny, y);
            for (let x = 0; x < nx; x++) {
                const px = lin(nx, x);
                const i = x + nx * (y + ny * z);
                const field = Math.exp(-(0.4 * px * px + 0.2 * py * py + 0.3 * pz * pz));
                const dist2 = 0.4 * px * px + 0.2 * (py - 0.7) ** 2 + 0.3 * pz * pz;
                const offset = 7 / (0.05 + dist2) - 45 / (0.3 + dist2);
                b1[i] = field;
                b0[i] = offset;
                const w = volume.maps.pd[i];
                weightSum += w;
                b0Sum += offset * w;
                b1Sum += field * w;
            }
        }
    }
    if (weightSum > 0) {
        const meanB0 = b0Sum / weightSum, meanB1 = b1Sum / weightSum;
        for (let i = 0; i < n; i++) {
            b0[i] -= meanB0;
            if (meanB1 > 0) b1[i] /= meanB1;
        }
    }
    return { b0, b1 };
}

/**
 * Receive coils evenly spaced on a ring around the object, each a smooth
 * complex profile: Gaussian falloff from the coil with the phase of the
 * direction to it. Not an electromagnetic model; enough to give multi-coil
 * data its structure (distinct images per coil, coil-dependent phase).
 * Normalised so the root-sum-of-squares is 1 at the centre.
 */
export function syntheticCoils(nx: number, ny: number, voxel: readonly [number, number, number], count: number): CoilMaps {
    const cells = nx * ny;
    const re = new Float32Array(count * cells), im = new Float32Array(count * cells);
    const halfX = nx * voxel[0] / 2, halfY = ny * voxel[1] / 2;
    const radius = 1.1 * Math.max(halfX, halfY);
    const width = 0.9 * Math.max(halfX, halfY);
    const centre = (c: number) => {
        const angle = 2 * Math.PI * c / count + Math.PI / 2;
        return [radius * Math.cos(angle), radius * Math.sin(angle)];
    };
    let centrePower = 0;
    for (let c = 0; c < count; c++) {
        const [cx, cy] = centre(c);
        centrePower += Math.exp(-(cx * cx + cy * cy) / (width * width));
    }
    const norm = count === 1 ? 1 : 1 / Math.sqrt(centrePower);
    for (let c = 0; c < count; c++) {
        const [cx, cy] = centre(c);
        for (let row = 0; row < ny; row++) {
            const y = (ny / 2 - 1 - row) * voxel[1];
            for (let col = 0; col < nx; col++) {
                const x = (col - nx / 2) * voxel[0];
                const i = c * cells + row * nx + col;
                if (count === 1) {
                    re[i] = 1;
                    continue;
                }
                const dx = x - cx, dy = y - cy;
                const magnitude = norm * Math.exp(-(dx * dx + dy * dy) / (2 * width * width));
                const phase = Math.atan2(dy, dx);
                re[i] = magnitude * Math.cos(phase);
                im[i] = magnitude * Math.sin(phase);
            }
        }
    }
    return { count, re, im };
}

/** Row-major indices of the voxels with PD > 0. */
export function occupiedVoxels(phantom: Phantom2D): Int32Array {
    const pd = phantom.maps.pd;
    let count = 0;
    for (let i = 0; i < pd.length; i++) if (pd[i] > 0) count++;
    const voxels = new Int32Array(count);
    let k = 0;
    for (let i = 0; i < pd.length; i++) if (pd[i] > 0) voxels[k++] = i;
    return voxels;
}

/** Relaxation rate of a time constant [s]: none for 0, negative or non-finite. */
export function rate(time: number): number {
    return Number.isFinite(time) && time > 0 ? 1 / time : 0;
}

/**
 * The parameters that decide how a voxel's magnetization evolves (T1, T2,
 * off-resonance and B1+), as an index into a table of distinct combinations.
 * Voxels sharing an index can share a simulated class when an axis folds.
 */
export interface PhysicsTable {
    of: Int32Array;
    t1: number[];
    t2: number[];
    df: number[];
    b1: number[];
}

export function physicsTable(phantom: Phantom2D): PhysicsTable {
    const { pd, t1, t2, b0, b1 } = phantom.maps;
    const of = new Int32Array(pd.length).fill(-1);
    const table: PhysicsTable = { of, t1: [], t2: [], df: [], b1: [] };
    const index = new Map<string, number>();
    for (let i = 0; i < pd.length; i++) {
        if (!(pd[i] > 0)) continue;
        const df = b0 ? b0[i] : 0, gain = b1 ? b1[i] : 1;
        const key = `${t1[i]}|${t2[i]}|${df}|${gain}`;
        let k = index.get(key);
        if (k === undefined) {
            k = table.t1.length;
            index.set(key, k);
            table.t1.push(t1[i]);
            table.t2.push(t2[i]);
            table.df.push(df);
            table.b1.push(gain);
        }
        of[i] = k;
    }
    return table;
}

export interface SpinOptions {
    /** Spins per voxel along x and y, on a stratified grid inside the voxel. */
    subSpins: readonly [number, number];
    /** Voxels to convert (row-major indices), in this order. */
    voxels: ArrayLike<number>;
    /**
     * Spins along x per voxel (indexed like the maps), overriding subSpins[0].
     * Counts must be powers of two dividing subSpins[0], so every voxel's
     * positions lie on one lattice of pitch Δx / (2·subSpins[0]).
     */
    countX?: Int32Array;
}

/** Spins along x in a voxel. */
function xCount(options: SpinOptions, index: number): number {
    return options.countX ? options.countX[index] : options.subSpins[0];
}

/** Spins in the given voxels. */
export function spinCount(options: SpinOptions): number {
    let total = 0;
    for (let v = 0; v < options.voxels.length; v++) total += xCount(options, options.voxels[v]);
    return total * options.subSpins[1];
}

/**
 * Spins for the given voxels. Voxel (col, row) is centred at
 * x = (col − nx/2)·Δx, y = (ny/2 − 1 − row)·Δy, the sample points of a centred
 * DFT, so a phantom at the image matrix lands on the reconstruction grid.
 * Sub-spins sit at (a + ½)/m − ½ of a voxel from the centre. Each spin weighs
 * PD / spins-per-voxel, so the signal does not depend on the sampling.
 */
export function phantomSpins(phantom: Phantom2D, options: SpinOptions): SpinSet {
    const my = options.subSpins[1];
    const voxels = options.voxels;
    const count = spinCount(options);
    const coils = phantom.coils?.count ?? 1;
    const set = {
        count,
        x: new Float64Array(count), y: new Float64Array(count), z: new Float64Array(count),
        df: new Float64Array(count),
        r1: new Float64Array(count), r2: new Float64Array(count),
        weight: new Float64Array(count),
        b1Re: new Float64Array(count), b1Im: new Float64Array(count),
        coils,
        rxRe: new Float64Array(coils * count), rxIm: new Float64Array(coils * count),
    };
    const { pd, t1, t2, b0, b1 } = phantom.maps;
    const [dx, dy] = phantom.voxel;
    const offsetsY = stratified(my);
    let k = 0;
    for (let v = 0; v < voxels.length; v++) {
        const index = voxels[v];
        const mx = xCount(options, index);
        const offsetsX = stratified(mx);
        const col = index % phantom.nx, row = Math.floor(index / phantom.nx);
        const x0 = (col - phantom.nx / 2) * dx;
        const y0 = (phantom.ny / 2 - 1 - row) * dy;
        const r1 = rate(t1[index]), r2 = rate(t2[index]);
        const df = b0 ? b0[index] : 0;
        const gain = b1 ? b1[index] : 1;
        const weight = pd[index] / (mx * my);
        for (const oy of offsetsY) {
            for (const ox of offsetsX) {
                set.x[k] = x0 + ox * dx;
                set.y[k] = y0 + oy * dy;
                set.df[k] = df;
                set.r1[k] = r1;
                set.r2[k] = r2;
                set.weight[k] = weight;
                set.b1Re[k] = gain;
                for (let c = 0; c < coils; c++) {
                    set.rxRe[c * count + k] = phantom.coils ? phantom.coils.re[c * pd.length + index] : 1;
                    set.rxIm[c * count + k] = phantom.coils ? phantom.coils.im[c * pd.length + index] : 0;
                }
                k++;
            }
        }
    }
    return set;
}

/**
 * Folded spins for the given voxels: one class per physics entry and position
 * along the unfolded axes, and every spin as a member (engine/spins.ts).
 * `fold` has bit 0 for x and bit 1 for y.
 */
export function foldedPhantomSpins(
    phantom: Phantom2D,
    physics: PhysicsTable,
    options: SpinOptions,
    fold: number,
): { classes: SpinSet; members: SpinMembers } {
    const [finest, my] = options.subSpins;
    const voxels = options.voxels;
    const foldX = (fold & 1) !== 0, foldY = (fold & 2) !== 0;
    const [dx, dy] = phantom.voxel;
    const offsetsY = stratified(my);
    const lineY = phantom.ny * my;
    const entries = physics.t1.length;
    const coils = phantom.coils?.count ?? 1;
    const cells = phantom.nx * phantom.ny;

    const memberCount = spinCount(options);
    const classOf = new Int32Array(memberCount);
    const weight = new Float64Array(memberCount);
    const foldOf = new Int32Array(memberCount);
    const rxRe = new Float64Array(coils * memberCount), rxIm = new Float64Array(coils * memberCount);
    const classIndex = new Map<number, number>();
    const pointIndex = new Map<number, number>();
    const classX: number[] = [], classY: number[] = [], classEntry: number[] = [];
    const points: number[] = [];
    let m = 0;
    for (let v = 0; v < voxels.length; v++) {
        const index = voxels[v];
        const mx = xCount(options, index);
        const offsetsX = stratified(mx);
        // Positions on the finest lattice, Δx / (2·finest): sub-spin a of m sits at (2a + 1)·(finest / m).
        const stepX = finest / mx;
        const col = index % phantom.nx, row = Math.floor(index / phantom.nx);
        const entry = physics.of[index];
        const w = phantom.maps.pd[index] / (mx * my);
        const x0 = (col - phantom.nx / 2) * dx;
        const y0 = (phantom.ny / 2 - 1 - row) * dy;
        for (let ay = 0; ay < my; ay++) {
            const y = y0 + offsetsY[ay] * dy;
            const jy = row * my + ay;
            for (let ax = 0; ax < mx; ax++) {
                const x = x0 + offsetsX[ax] * dx;
                const jx = col * 2 * finest + (2 * ax + 1) * stepX;
                // Class: physics entry and the position along the unfolded axes.
                const classKey = ((foldX ? 0 : jx) * lineY + (foldY ? 0 : jy)) * entries + entry;
                let c = classIndex.get(classKey);
                if (c === undefined) {
                    c = classX.length;
                    classIndex.set(classKey, c);
                    classX.push(foldX ? 0 : x);
                    classY.push(foldY ? 0 : y);
                    classEntry.push(entry);
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
                for (let coil = 0; coil < coils; coil++) {
                    rxRe[coil * memberCount + m] = phantom.coils ? phantom.coils.re[coil * cells + index] : 1;
                    rxIm[coil * memberCount + m] = phantom.coils ? phantom.coils.im[coil * cells + index] : 0;
                }
                m++;
            }
        }
    }
    const count = classX.length;
    const classes: SpinSet = {
        count,
        x: Float64Array.from(classX), y: Float64Array.from(classY), z: new Float64Array(count),
        df: Float64Array.from(classEntry, e => physics.df[e]),
        r1: Float64Array.from(classEntry, e => rate(physics.t1[e])),
        r2: Float64Array.from(classEntry, e => rate(physics.t2[e])),
        weight: new Float64Array(count),
        b1Re: Float64Array.from(classEntry, e => physics.b1[e]), b1Im: new Float64Array(count),
        coils: 1,
        rxRe: new Float64Array(count).fill(1), rxIm: new Float64Array(count),
    };
    const members: SpinMembers = {
        count: memberCount,
        classOf, weight, foldOf,
        foldPoints: Float64Array.from(points),
        coils,
        rxRe, rxIm,
    };
    return { classes, members };
}

function stratified(count: number): number[] {
    return Array.from({ length: count }, (_, a) => (a + 0.5) / count - 0.5);
}
