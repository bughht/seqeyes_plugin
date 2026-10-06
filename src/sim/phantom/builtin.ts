/**
 * Built-in 2D phantoms and their conversion to spins.
 *
 * The Shepp–Logan layout (Toft's modified ellipses) is painted as tissue
 * classes in drawing order — the last ellipse covering a voxel decides its
 * tissue — rather than with the original additive intensities, so every voxel
 * has physical PD, T1, T2, T2′ and ADC and contrast follows from the sequence.
 */

import type { SpinSet } from '../engine/spins';
import type { Phantom2D, PhantomVolume } from './model';

/** A 2D voxel grid in the x–y plane, centred on the isocentre. */
export interface VoxelGrid2D {
    nx: number;
    ny: number;
    /** Field of view [m]. */
    fovX: number;
    fovY: number;
    /** Row-major (y outer, x inner), length nx·ny. */
    pd: Float32Array;
    /** Relaxation times [s]; Infinity means none. */
    t1: Float32Array;
    t2: Float32Array;
    t2prime: Float32Array;
    /** Apparent diffusion coefficient [m²/s]. */
    adc: Float32Array;
}

export interface Tissue {
    name: string;
    pd: number;
    t1: number;
    t2: number;
    /** Reversible dephasing [s]: 1/T2* = 1/T2 + 1/T2′. */
    t2prime: number;
    /** Apparent diffusion coefficient [m²/s]. */
    adc: number;
}

/** Representative 3 T tissue values (T2′ from T2* of about 35, 53, 66, 400 and 80 ms; the lesion's ADC that of oedema). */
export const TISSUES = {
    skin: { name: 'skin', pd: 0.9, t1: 0.25, t2: 0.07, t2prime: 0.07, adc: 0.5e-9 },
    whiteMatter: { name: 'white matter', pd: 0.69, t1: 0.83, t2: 0.08, t2prime: 0.15, adc: 0.7e-9 },
    greyMatter: { name: 'grey matter', pd: 0.8, t1: 1.33, t2: 0.11, t2prime: 0.17, adc: 0.8e-9 },
    csf: { name: 'CSF', pd: 1, t1: 4.0, t2: 2.0, t2prime: 0.5, adc: 3.0e-9 },
    lesion: { name: 'lesion', pd: 0.85, t1: 1.6, t2: 0.25, t2prime: 0.12, adc: 1.4e-9 },
} as const satisfies Record<string, Tissue>;

/** Ellipse: semi-axes (a, b) and centre (x0, y0) in [−1, 1] units, rotation in degrees. */
interface Ellipse {
    a: number; b: number; x0: number; y0: number; deg: number;
    tissue: Tissue;
}

const SHEPP_LOGAN: Ellipse[] = [
    { a: 0.69, b: 0.92, x0: 0, y0: 0, deg: 0, tissue: TISSUES.skin },
    { a: 0.6624, b: 0.874, x0: 0, y0: -0.0184, deg: 0, tissue: TISSUES.whiteMatter },
    { a: 0.11, b: 0.31, x0: 0.22, y0: 0, deg: -18, tissue: TISSUES.csf },
    { a: 0.16, b: 0.41, x0: -0.22, y0: 0, deg: 18, tissue: TISSUES.csf },
    { a: 0.21, b: 0.25, x0: 0, y0: 0.35, deg: 0, tissue: TISSUES.greyMatter },
    { a: 0.046, b: 0.046, x0: 0, y0: 0.1, deg: 0, tissue: TISSUES.greyMatter },
    { a: 0.046, b: 0.046, x0: 0, y0: -0.1, deg: 0, tissue: TISSUES.greyMatter },
    { a: 0.046, b: 0.023, x0: -0.08, y0: -0.605, deg: 0, tissue: TISSUES.lesion },
    { a: 0.023, b: 0.023, x0: 0, y0: -0.606, deg: 0, tissue: TISSUES.lesion },
    { a: 0.023, b: 0.046, x0: 0.06, y0: -0.605, deg: 0, tissue: TISSUES.lesion },
];

/** Ellipsoid: semi-axes (a, b, c) and centre (x0, y0, z0) in [−1, 1]³ units, rotated about z by deg (a's direction from x). */
interface Ellipsoid {
    a: number; b: number; c: number;
    x0: number; y0: number; z0: number;
    deg: number;
    tissue: Tissue;
}

/**
 * The 3-D Shepp–Logan head phantom of Kak and Roberts (Kak & Slaney,
 * Principles of Computerized Tomographic Imaging, 1988), as tabulated by
 * Koay, Sarlls and Özarslan, Magn Reson Med 58:430–436 (2007), and as BART
 * draws it (github.com/mrirecon/bart, src/simu/shepplogan.c, BSD-3-Clause).
 * Its structures sit at different heights: the ventricles, the large
 * ellipsoid above them and the small lesions at z = −0.25 (the classic 2-D
 * cross-section), a lesion and a CSF spot near the vertex at z = 0.625.
 * Painted with the 2-D phantom's tissues, in the same order.
 */
const SHEPP_LOGAN_3D: Ellipsoid[] = [
    { a: 0.69, b: 0.92, c: 0.9, x0: 0, y0: 0, z0: 0, deg: 0, tissue: TISSUES.skin },
    { a: 0.6624, b: 0.874, c: 0.88, x0: 0, y0: 0, z0: 0, deg: 0, tissue: TISSUES.whiteMatter },
    { a: 0.41, b: 0.16, c: 0.21, x0: -0.22, y0: 0, z0: -0.25, deg: 108, tissue: TISSUES.csf },
    { a: 0.31, b: 0.11, c: 0.22, x0: 0.22, y0: 0, z0: -0.25, deg: 72, tissue: TISSUES.csf },
    { a: 0.21, b: 0.25, c: 0.5, x0: 0, y0: 0.35, z0: -0.25, deg: 0, tissue: TISSUES.greyMatter },
    { a: 0.046, b: 0.046, c: 0.046, x0: 0, y0: 0.1, z0: -0.25, deg: 0, tissue: TISSUES.greyMatter },
    { a: 0.046, b: 0.023, c: 0.02, x0: -0.08, y0: -0.65, z0: -0.25, deg: 0, tissue: TISSUES.lesion },
    { a: 0.046, b: 0.023, c: 0.02, x0: 0.06, y0: -0.65, z0: -0.25, deg: 90, tissue: TISSUES.lesion },
    { a: 0.056, b: 0.04, c: 0.1, x0: 0.06, y0: -0.105, z0: 0.625, deg: 90, tissue: TISSUES.lesion },
    { a: 0.056, b: 0.056, c: 0.1, x0: 0, y0: 0.1, z0: 0.625, deg: 0, tissue: TISSUES.csf },
];

/**
 * The 3-D tissue Shepp–Logan (SHEPP_LOGAN_3D) on an n × n × nz grid spanning
 * the FOV, painted like the 2-D one (the last ellipsoid covering a voxel
 * decides its tissue).
 * Voxel (i, j, k) is centred at ((i − n/2)Δx, (j − n/2)Δy, (k − nz/2)Δz), the
 * sample points of a centred DFT, with j counting up from the bottom (the
 * volume layout sliceVolume reads).
 */
export function sheppLoganVolume(n: number, nz: number, fov: readonly [number, number, number]): PhantomVolume {
    if (!(n >= 2) || !Number.isInteger(n) || !(nz >= 1) || !Number.isInteger(nz)) {
        throw new Error(`phantom size must be integers n ≥ 2 and nz ≥ 1, got ${n} × ${n} × ${nz}`);
    }
    const size = n * n * nz;
    const maps = {
        pd: new Float32Array(size),
        t1: new Float32Array(size).fill(Infinity),
        t2: new Float32Array(size).fill(Infinity),
        t2prime: new Float32Array(size).fill(Infinity),
        adc: new Float32Array(size),
    };
    const rotations = SHEPP_LOGAN_3D.map(e => [Math.cos(e.deg * Math.PI / 180), Math.sin(e.deg * Math.PI / 180)]);
    for (let k = 0; k < nz; k++) {
        const w = 2 * (k - nz / 2) / nz;
        for (let j = 0; j < n; j++) {
            const v = 2 * (j - n / 2) / n;
            for (let i = 0; i < n; i++) {
                const u = 2 * (i - n / 2) / n;
                let tissue: Tissue | null = null;
                SHEPP_LOGAN_3D.forEach((e, index) => {
                    const [cos, sin] = rotations[index];
                    const dx = u - e.x0, dy = v - e.y0;
                    const xr = dx * cos + dy * sin, yr = -dx * sin + dy * cos;
                    if ((xr / e.a) ** 2 + (yr / e.b) ** 2 + ((w - e.z0) / e.c) ** 2 <= 1) tissue = e.tissue;
                });
                if (!tissue) continue;
                const t: Tissue = tissue;
                const index = (k * n + j) * n + i;
                maps.pd[index] = t.pd;
                maps.t1[index] = t.t1;
                maps.t2[index] = t.t2;
                maps.t2prime[index] = t.t2prime;
                maps.adc[index] = t.adc;
            }
        }
    }
    return {
        shape: [n, n, nz],
        voxel: [fov[0] / n, fov[1] / n, fov[2] / nz],
        maps,
        source: `Shepp–Logan 3-D ${n}×${n}×${nz}`,
        notes: [],
    };
}

/**
 * Modified Shepp–Logan tissue phantom on an n×n grid spanning the FOV. The
 * ellipses fill 92 % of the shorter side, as in the classic layout.
 */
export function sheppLoganPhantom(n: number, fovX: number, fovY: number): VoxelGrid2D {
    if (!(n >= 2) || !Number.isInteger(n)) throw new Error(`phantom size must be an integer ≥ 2, got ${n}`);
    const size = n * n;
    const grid: VoxelGrid2D = {
        nx: n, ny: n, fovX, fovY,
        pd: new Float32Array(size),
        t1: new Float32Array(size).fill(Infinity),
        t2: new Float32Array(size).fill(Infinity),
        t2prime: new Float32Array(size).fill(Infinity),
        adc: new Float32Array(size),
    };
    for (let iy = 0; iy < n; iy++) {
        // Normalised coordinates of the voxel centre (see spinsFromGrid2D), y up.
        const v = 2 * (n / 2 - 1 - iy) / n;
        for (let ix = 0; ix < n; ix++) {
            const u = 2 * (ix - n / 2) / n;
            let tissue: Tissue | null = null;
            for (const e of SHEPP_LOGAN) {
                const angle = e.deg * Math.PI / 180;
                const dx = u - e.x0, dy = v - e.y0;
                const xr = dx * Math.cos(angle) + dy * Math.sin(angle);
                const yr = -dx * Math.sin(angle) + dy * Math.cos(angle);
                if ((xr / e.a) ** 2 + (yr / e.b) ** 2 <= 1) tissue = e.tissue;
            }
            if (!tissue) continue;
            const index = iy * n + ix;
            grid.pd[index] = tissue.pd;
            grid.t1[index] = tissue.t1;
            grid.t2[index] = tissue.t2;
            grid.t2prime[index] = tissue.t2prime;
            grid.adc[index] = tissue.adc;
        }
    }
    return grid;
}

export interface GridSpinOptions {
    /** Through-plane positions of the spins in each voxel [m]; default the centre plane only. */
    zPositions?: number[];
    /**
     * Spins per voxel along x and y (one number for both), on a stratified grid
     * inside the voxel (default 1, the centre). One point per voxel cannot
     * dephase under a spoiler, so spoiled sequences keep spurious coherence;
     * see suggestSubSpins for the count an axis needs.
     */
    subSpins?: number | readonly [number, number];
    /** Voxels to convert, as row-major indices in this order (default every non-empty voxel). */
    voxels?: ArrayLike<number>;
}

/** Row-major indices of the voxels with PD > 0. */
export function nonEmptyVoxels(grid: VoxelGrid2D): Int32Array {
    let count = 0;
    for (let i = 0; i < grid.pd.length; i++) if (grid.pd[i] > 0) count++;
    const voxels = new Int32Array(count);
    let k = 0;
    for (let i = 0; i < grid.pd.length; i++) if (grid.pd[i] > 0) voxels[k++] = i;
    return voxels;
}

/**
 * Spins for every non-empty voxel (or the `voxels` given). The weight is PD
 * divided by the spins per voxel, so the signal scale does not depend on the
 * sampling.
 *
 * Voxel (ix, iy) is centred at x = (ix − nx/2)·Δx and y = (ny/2 − 1 − iy)·Δy:
 * the sample points of a centred DFT, so a phantom at the image matrix size
 * lands exactly on the reconstruction grid; row 0 is the top (largest y).
 * Sub-spins sit at (a + ½)/m − ½ of a voxel from the centre along each axis.
 */
export function spinsFromGrid2D(grid: VoxelGrid2D, options: GridSpinOptions = {}): SpinSet {
    const zPositions = options.zPositions?.length ? options.zPositions : [0];
    const sub = options.subSpins ?? 1;
    const [mx, my] = (typeof sub === 'number' ? [sub, sub] : sub).map(m => Math.max(1, Math.floor(m)));
    const voxels = options.voxels ?? nonEmptyVoxels(grid);
    const perVoxel = zPositions.length * mx * my;
    const count = voxels.length * perVoxel;
    const set = {
        count,
        x: new Float64Array(count), y: new Float64Array(count), z: new Float64Array(count),
        df: new Float64Array(count),
        r1: new Float64Array(count), r2: new Float64Array(count),
        r2prime: new Float64Array(count), adc: new Float64Array(count),
        weight: new Float64Array(count),
        b1Re: new Float64Array(count).fill(1), b1Im: new Float64Array(count),
        coils: 1,
        rxRe: new Float64Array(count).fill(1), rxIm: new Float64Array(count),
    };
    const dx = grid.fovX / grid.nx, dy = grid.fovY / grid.ny;
    const offsetsX = Array.from({ length: mx }, (_, a) => (a + 0.5) / mx - 0.5);
    const offsetsY = Array.from({ length: my }, (_, a) => (a + 0.5) / my - 0.5);
    let k = 0;
    for (let v = 0; v < voxels.length; v++) {
        const index = voxels[v];
        const ix = index % grid.nx, iy = Math.floor(index / grid.nx);
        const x0 = (ix - grid.nx / 2) * dx;
        const y0 = (grid.ny / 2 - 1 - iy) * dy;
        const t1 = grid.t1[index], t2 = grid.t2[index];
        const r1 = Number.isFinite(t1) && t1 > 0 ? 1 / t1 : 0;
        const r2 = Number.isFinite(t2) && t2 > 0 ? 1 / t2 : 0;
        const t2p = grid.t2prime[index], adc = grid.adc[index];
        const r2p = Number.isFinite(t2p) && t2p > 0 ? 1 / t2p : 0;
        const weight = grid.pd[index] / perVoxel;
        for (const z of zPositions) {
            for (const oy of offsetsY) {
                for (const ox of offsetsX) {
                    set.x[k] = x0 + ox * dx;
                    set.y[k] = y0 + oy * dy;
                    set.z[k] = z;
                    set.r1[k] = r1;
                    set.r2[k] = r2;
                    set.r2prime[k] = r2p;
                    set.adc[k] = adc > 0 ? adc : 0;
                    set.weight[k] = weight;
                    k++;
                }
            }
        }
    }
    return set;
}

/** The tissue Shepp–Logan as a simulator phantom (no field maps, one coil). */
export function sheppLoganPhantom2D(n: number, fovX: number, fovY: number): Phantom2D {
    const grid = sheppLoganPhantom(n, fovX, fovY);
    return {
        nx: n,
        ny: n,
        voxel: [fovX / n, fovY / n, 0],
        maps: { pd: grid.pd, t1: grid.t1, t2: grid.t2, t2prime: grid.t2prime, adc: grid.adc },
        source: `Shepp–Logan ${n}²`,
        notes: [],
    };
}
