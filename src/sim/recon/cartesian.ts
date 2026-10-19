/**
 * Preview reconstruction for Cartesian 2D and 3D data: place each sample on a
 * grid by its k-space position, then apply a centred inverse DFT. A third
 * axis whose readouts sit on two or more planes of a Cartesian lattice (3-D
 * phase encoding) is reconstructed too, as planes.
 *
 * Placement by trajectory rather than by labels works for files without
 * labels and handles reversed EPI lines for free; ramp-sampled points snap to
 * the nearest grid cell, which is approximate. Non-Cartesian data is gridded
 * the same way and flagged, since it needs real gridding (planned).
 *
 * Image orientation: column c ↔ u = (c − N/2)·Δu, row r ↔ v = (N/2 − 1 − r)·Δv,
 * matching the built-in phantom, so row 0 is the top (largest v).
 */

import type { AdcTrajectory } from './trajectory';

export interface CartesianOptions {
    /** Field of view per physical axis [m] (Δk = 1/FOV); estimated from k when absent. */
    fov?: [number, number, number] | null;
    /** Largest grid size per axis. */
    maxSize?: number;
    /** Most frames to reconstruct. */
    maxFrames?: number;
    /** Largest number of planes along a 3-D acquisition's third axis. */
    maxPlanes?: number;
    /** Also return complex per-coil images and gridded k-space. */
    complex?: boolean;
}

/** Complex data, frames × coils × nw × nv × nu, rows top-down like the magnitude images. */
export interface ComplexStack {
    re: Float32Array;
    im: Float32Array;
}

export interface CartesianRecon {
    /** Image axes as physical axis indices (0 = x, 1 = y, 2 = z). */
    axes: [number, number];
    nu: number;
    nv: number;
    /** Grid spacing per image axis [1/m] (pixel size = 1/(n·Δk)), and the half-cell offset of each lattice. */
    delta: [number, number];
    offset: [number, number];
    /**
     * A 3-D acquisition's third axis (physical axis index, −1 in 2-D), its
     * planes (1 in 2-D), their k spacing and lattice offset. Plane p sits at
     * w = (p − nw/2)·(1/(nw·Δw)), ascending.
     */
    wAxis: number;
    nw: number;
    deltaW: number;
    offsetW: number;
    frames: number;
    /** Magnitude images, frames × nw × nv × nu (coil root-sum-of-squares). */
    images: Float32Array;
    /** Gridded k-space magnitudes, frames × nw × nv × nu. */
    kspace: Float32Array;
    /** For each frame, the excitation group it came from and its repeat index. */
    frameGroup: Int32Array;
    frameRepeat: Int32Array;
    /** Fraction of grid cells filled, over all frames. */
    fill: number;
    /** Samples falling off the Cartesian grid by more than 10 % of a cell. */
    offGridFraction: number;
    warnings: string[];
    /** With options.complex: per-coil complex images and k-space. */
    coilImages?: ComplexStack;
    coilKspace?: ComplexStack;
}

export function reconstructCartesian(
    trajectory: AdcTrajectory,
    signal: Float64Array,
    coils: number,
    options: CartesianOptions = {},
): CartesianRecon {
    const maxSize = options.maxSize ?? 512;
    const maxFrames = options.maxFrames ?? 64;
    const warnings: string[] = [];
    const k = trajectory.k;
    const totalSamples = k.length / 3;

    // The image axes: the two with the widest k extent, in axis order. When
    // all three are encoded (3-D), the third is a partition axis instead: one
    // that does not move within readouts, the narrowest such (z on a tie).
    // Rounding leaves a 2-D sequence ~1e-3 /m along z; a partition encode
    // reaches at least ~2 /m (two partitions over half a metre).
    const extent = [0, 0, 0], within = [0, 0, 0];
    for (let s = 0; s < totalSamples; s++) {
        for (let a = 0; a < 3; a++) extent[a] = Math.max(extent[a], Math.abs(k[3 * s + a]));
    }
    for (let r = 0; r < trajectory.readouts; r++) {
        const first = trajectory.offsets[r], last = first + trajectory.samples[r] - 1;
        for (let a = 0; a < 3; a++) {
            let lo = Infinity, hi = -Infinity;
            for (let s = first; s <= last; s++) { lo = Math.min(lo, k[3 * s + a]); hi = Math.max(hi, k[3 * s + a]); }
            if (hi > lo) within[a] = Math.max(within[a], hi - lo);
        }
    }
    const ranked = [0, 1, 2].sort((a, b) => extent[b] - extent[a]);
    const encoded = (axis: number) => extent[axis] >= Math.max(1, 0.01 * extent[ranked[1]]);
    let third = ranked[2];
    if (encoded(ranked[2])) {
        const still = [0, 1, 2].filter(axis => within[axis] <= 0.01 * Math.max(...within));
        // Extents within 1 % are a tie (rounding), which goes to the later axis.
        const narrower = (a: number, b: number) => (Math.abs(extent[a] - extent[b]) <= 0.01 * Math.max(extent[a], extent[b]) ? b - a : extent[a] - extent[b]);
        if (still.length) third = still.sort(narrower)[0];
    }
    const axes = [0, 1, 2].filter(axis => axis !== third) as [number, number];

    const delta = axes.map(axis => {
        const fov = options.fov?.[axis];
        if (fov && fov > 0) return 1 / fov;
        return estimateStep(trajectory, axis, 2 * extent[axis]);
    }) as [number, number];
    // Pulseq's spin-warp readouts sample kx at half-integer positions,
    // (s − N/2 + ½)·Δk, with no sample at k = 0; phase encodes sit on integers.
    // Each axis's grid therefore carries an offset δ ∈ {0, ½}, and the inverse
    // DFT includes it exactly.
    const offset = axes.map((axis, i) => gridOffset(k, axis, delta[i])) as [number, number];
    const size = axes.map((axis, i) => {
        const n = 2 * Math.round(extent[axis] / delta[i] + (offset[i] ? 0.5 : 0));
        return Math.max(2, Math.min(maxSize, n));
    }) as [number, number];
    const [nu, nv] = size;

    // A third axis with readouts on several planes of a lattice: 3-D encoding.
    let wAxis = -1, nw = 1, deltaW = 0, offsetW = 0;
    if (encoded(third)) {
        const fov = options.fov?.[third];
        const step = fov && fov > 0 ? 1 / fov : estimateStep(trajectory, third, 2 * extent[third]);
        const lattice = gridOffset(k, third, step);
        const planes = new Set<number>();
        for (let r = 0; r < trajectory.readouts; r++) {
            const centre = trajectory.offsets[r] + (trajectory.samples[r] >> 1);
            planes.add(Math.round(k[3 * centre + third] / step - lattice));
        }
        if (planes.size >= 2) {
            wAxis = third;
            deltaW = step;
            offsetW = lattice;
            nw = Math.max(2, Math.min(options.maxPlanes ?? 256, 2 * Math.round(extent[third] / step + (lattice ? 0.5 : 0))));
        }
    }
    const planeOf = (index: number) => (wAxis < 0 ? 0 : Math.round(k[3 * index + wAxis] / deltaW - offsetW) + (nw >> 1));

    // Frames: one excitation group (e.g. one slice) each; within a group a new
    // frame starts whenever a readout returns to a row (of a plane) already filled.
    const groupIds = new Map<string, number>();
    const groupFrames = new Map<number, { frame: number; rows: Set<number> }>();
    const frameOfReadout = new Int32Array(trajectory.readouts);
    const frameGroup: number[] = [];
    const frameRepeat: number[] = [];
    const repeats = new Map<number, number>();
    for (let r = 0; r < trajectory.readouts; r++) {
        const key = trajectory.excitationKey[r];
        let group = groupIds.get(key);
        if (group === undefined) {
            group = groupIds.size;
            groupIds.set(key, group);
        }
        const centre = trajectory.offsets[r] + (trajectory.samples[r] >> 1);
        const row = Math.round(k[3 * centre + axes[1]] / delta[1] - offset[1]) * (nw + 1) + planeOf(centre);
        let current = groupFrames.get(group);
        if (!current || current.rows.has(row)) {
            const repeat = repeats.get(group) ?? 0;
            repeats.set(group, repeat + 1);
            current = { frame: frameGroup.length, rows: new Set() };
            groupFrames.set(group, current);
            frameGroup.push(group);
            frameRepeat.push(repeat);
        }
        current.rows.add(row);
        frameOfReadout[r] = current.frame;
    }
    let frames = frameGroup.length;
    if (frames > maxFrames) {
        warnings.push(`Only the first ${maxFrames} of ${frames} frames are reconstructed.`);
        frames = maxFrames;
    }

    const plane = nu * nv;
    const cells = plane * nw;
    const gridRe = new Float64Array(frames * coils * cells);
    const gridIm = new Float64Array(frames * coils * cells);
    const filled = new Uint8Array(frames * cells);
    let offGrid = 0;
    for (let r = 0; r < trajectory.readouts; r++) {
        const frame = frameOfReadout[r];
        if (frame >= frames) continue;
        for (let s = 0; s < trajectory.samples[r]; s++) {
            const index = trajectory.offsets[r] + s;
            const fu = k[3 * index + axes[0]] / delta[0] - offset[0];
            const fv = k[3 * index + axes[1]] / delta[1] - offset[1];
            const cu = Math.round(fu), cv = Math.round(fv);
            if (Math.abs(fu - cu) > 0.1 || Math.abs(fv - cv) > 0.1) offGrid++;
            const iu = cu + (nu >> 1);
            const iv = cv + (nv >> 1);
            const iw = planeOf(index);
            if (iu < 0 || iu >= nu || iv < 0 || iv >= nv || iw < 0 || iw >= nw) continue;
            const cell = (iw * nv + iv) * nu + iu;
            filled[frame * cells + cell] = 1;
            for (let c = 0; c < coils; c++) {
                const o = ((frame * coils + c) * cells) + cell;
                const source = (index * coils + c) * 2;
                gridRe[o] = signal[source];
                gridIm[o] = signal[source + 1];
            }
        }
    }
    const offGridFraction = totalSamples > 0 ? offGrid / totalSamples : 0;
    if (offGridFraction > 0.05) {
        warnings.push('Many samples fall between grid points (non-Cartesian or ramp-sampled); this preview snaps them to the nearest cell.');
    }

    const images = new Float32Array(frames * cells);
    const kspace = new Float32Array(frames * cells);
    const complexSize = options.complex ? frames * coils * cells : 0;
    const coilImages: ComplexStack | undefined = options.complex
        ? { re: new Float32Array(complexSize), im: new Float32Array(complexSize) } : undefined;
    const coilKspace: ComplexStack | undefined = options.complex
        ? { re: new Float32Array(complexSize), im: new Float32Array(complexSize) } : undefined;
    const twiddleU = centredTwiddles(nu, offset[0]);
    const twiddleV = centredTwiddles(nv, offset[1]);
    const twiddleW = nw > 1 ? centredTwiddles(nw, offsetW) : null;
    const workRe = new Float64Array(cells), workIm = new Float64Array(cells);
    const lineRe = new Float64Array(nw), lineIm = new Float64Array(nw);
    for (let frame = 0; frame < frames; frame++) {
        const image = images.subarray(frame * cells, (frame + 1) * cells);
        const ks = kspace.subarray(frame * cells, (frame + 1) * cells);
        for (let c = 0; c < coils; c++) {
            const base = (frame * coils + c) * cells;
            for (let i = 0; i < cells; i++) {
                workRe[i] = gridRe[base + i];
                workIm[i] = gridIm[base + i];
                ks[i] += workRe[i] * workRe[i] + workIm[i] * workIm[i];
            }
            for (let iw = 0; iw < nw; iw++) {
                const at = iw * plane;
                if (coilKspace) copyTopDown(workRe.subarray(at, at + plane), workIm.subarray(at, at + plane), nu, nv, coilKspace, base + at);
                inverseDft2(workRe.subarray(at, at + plane), workIm.subarray(at, at + plane), nu, nv, twiddleU, twiddleV);
            }
            if (twiddleW) {
                for (let i = 0; i < plane; i++) transformLine(workRe, workIm, i, plane, nw, twiddleW, lineRe, lineIm);
            }
            // Grid row iv holds v = (iv − nv/2)·Δv; image row r shows the top first.
            for (let iw = 0; iw < nw; iw++) {
                for (let iv = 0; iv < nv; iv++) {
                    const row = nv - 1 - iv;
                    for (let iu = 0; iu < nu; iu++) {
                        const i = (iw * nv + iv) * nu + iu;
                        image[iw * plane + row * nu + iu] += workRe[i] * workRe[i] + workIm[i] * workIm[i];
                    }
                }
                if (coilImages) copyTopDown(workRe.subarray(iw * plane, (iw + 1) * plane), workIm.subarray(iw * plane, (iw + 1) * plane), nu, nv, coilImages, base + iw * plane);
            }
        }
        for (let i = 0; i < cells; i++) {
            image[i] = Math.sqrt(image[i]);
            ks[i] = Math.sqrt(ks[i]);
        }
        // k-space rows likewise top-down (largest kv first), plane by plane.
        for (let iw = 0; iw < nw; iw++) flipRows(ks.subarray(iw * plane, (iw + 1) * plane), nu, nv);
    }
    let filledCount = 0;
    for (let i = 0; i < filled.length; i++) filledCount += filled[i];
    return {
        axes,
        nu,
        nv,
        delta,
        offset,
        wAxis,
        nw,
        deltaW,
        offsetW,
        frames,
        images,
        kspace,
        frameGroup: Int32Array.from(frameGroup.slice(0, frames)),
        frameRepeat: Int32Array.from(frameRepeat.slice(0, frames)),
        fill: frames > 0 ? filledCount / (frames * cells) : 0,
        offGridFraction,
        warnings,
        coilImages,
        coilKspace,
    };
}

/** Copy a grid (row iv = v index, bottom-up) into a stack with the top row first. */
function copyTopDown(re: Float64Array, im: Float64Array, nu: number, nv: number, out: ComplexStack, base: number): void {
    for (let iv = 0; iv < nv; iv++) {
        const row = nv - 1 - iv;
        for (let iu = 0; iu < nu; iu++) {
            out.re[base + row * nu + iu] = re[iv * nu + iu];
            out.im[base + row * nu + iu] = im[iv * nu + iu];
        }
    }
}

/**
 * Smallest spacing between distinct k values along an axis. Values closer
 * than 1e-4 of the axis's whole k span are one value: echoes of a spin-echo
 * train land a hair apart (sub-0.1 % of a step) and must not pass for a grid.
 */
function estimateStep(trajectory: AdcTrajectory, axis: number, span: number): number {
    const values: number[] = [];
    for (let r = 0; r < trajectory.readouts; r++) {
        const centre = trajectory.offsets[r] + (trajectory.samples[r] >> 1);
        values.push(trajectory.k[3 * centre + axis]);
        if (trajectory.samples[r] > 1) {
            const next = centre + 1 < trajectory.offsets[r] + trajectory.samples[r] ? centre + 1 : centre - 1;
            values.push(trajectory.k[3 * next + axis]);
        }
    }
    values.sort((a, b) => a - b);
    let step = Infinity;
    for (let i = 1; i < values.length; i++) {
        const d = values[i] - values[i - 1];
        if (d > span * 1e-4 && d < step) step = d;
    }
    return Number.isFinite(step) && step > 0 ? step : 1;
}

interface Twiddles {
    re: Float64Array;
    im: Float64Array;
}

/** Grid offset δ (0 or ½) whose lattice holds most samples of an axis, in units of Δk. */
function gridOffset(k: Float64Array, axis: number, delta: number): number {
    let integer = 0, half = 0;
    for (let s = axis; s < k.length; s += 3) {
        const f = k[s] / delta;
        const fraction = Math.abs(f - Math.round(f));
        if (fraction < 0.1) integer++;
        else if (Math.abs(fraction - 0.5) < 0.1) half++;
    }
    return half > integer ? 0.5 : 0;
}

/** e^{+i2π (j − N/2 + δ)(p − N/2)/N}, row-major [j][p]: sample j sits at k = (j − N/2 + δ)·Δk. */
function centredTwiddles(n: number, offset = 0): Twiddles {
    const re = new Float64Array(n * n), im = new Float64Array(n * n);
    const half = n / 2;
    for (let j = 0; j < n; j++) {
        for (let p = 0; p < n; p++) {
            // Reduce the product mod n before scaling, for accuracy.
            const product = ((j - half + offset) * (p - half)) % n;
            const angle = 2 * Math.PI * product / n;
            re[j * n + p] = Math.cos(angle);
            im[j * n + p] = Math.sin(angle);
        }
    }
    return { re, im };
}

/** In-place centred inverse DFT along both axes of an nu × nv grid (row-major v, u). */
function inverseDft2(re: Float64Array, im: Float64Array, nu: number, nv: number, tu: Twiddles, tv: Twiddles): void {
    const lineRe = new Float64Array(Math.max(nu, nv));
    const lineIm = new Float64Array(Math.max(nu, nv));
    for (let v = 0; v < nv; v++) {
        transformLine(re, im, v * nu, 1, nu, tu, lineRe, lineIm);
    }
    for (let u = 0; u < nu; u++) {
        transformLine(re, im, u, nu, nv, tv, lineRe, lineIm);
    }
}

function transformLine(
    re: Float64Array, im: Float64Array, start: number, stride: number, n: number,
    t: Twiddles, outRe: Float64Array, outIm: Float64Array,
): void {
    for (let p = 0; p < n; p++) {
        let sr = 0, si = 0;
        for (let j = 0; j < n; j++) {
            const xr = re[start + j * stride], xi = im[start + j * stride];
            if (xr === 0 && xi === 0) continue;
            const wr = t.re[j * n + p], wi = t.im[j * n + p];
            sr += xr * wr - xi * wi;
            si += xr * wi + xi * wr;
        }
        outRe[p] = sr;
        outIm[p] = si;
    }
    for (let p = 0; p < n; p++) {
        re[start + p * stride] = outRe[p];
        im[start + p * stride] = outIm[p];
    }
}

function flipRows(values: Float32Array, nu: number, nv: number): void {
    const row = new Float32Array(nu);
    for (let top = 0, bottom = nv - 1; top < bottom; top++, bottom--) {
        row.set(values.subarray(top * nu, (top + 1) * nu));
        values.copyWithin(top * nu, bottom * nu, (bottom + 1) * nu);
        values.set(row, bottom * nu);
    }
}
