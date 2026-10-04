/**
 * Piecewise-linear three-axis gradient windows and their exact moments.
 *
 * A window is stored as pieces rather than points so a jump (two support
 * points at one time) keeps its left and right values: piece i covers
 * [t[i], t[i+1]] and carries the gradient at both of its ends.
 *
 * Units: gradient in Hz/m, trajectory k in cycles/m (no 2π), time in s.
 * Moments are segment-local — k is measured from the window start.
 */

/** Ascending support points of one axis covering a window (equal times allowed). */
export interface AxisPoints {
    times: ArrayLike<number>;
    values: ArrayLike<number>;
}

export interface GradientPieces {
    /** Piece boundaries, length n + 1, absolute [s]. */
    t: Float64Array;
    /** Gradient at the start of each piece, xyz interleaved, length 3n [Hz/m]. */
    ga: Float64Array;
    /** Gradient at the end of each piece, xyz interleaved, length 3n [Hz/m]. */
    gb: Float64Array;
}

export interface SegmentMoments {
    /** k(t1) − k(t0) per axis [1/m]. */
    dk: Float64Array;
    /** ∫ K dt per axis with K(t0) = 0 [s/m]. */
    kIntegral: Float64Array;
    /** ∫ Kᵢ Kⱼ dt with K(t0) = 0, ordered xx yy zz xy xz yz [s/m²]. */
    kSecond: Float64Array;
}

/** Number of pieces in a window. */
export function pieceCount(pieces: GradientPieces): number {
    return pieces.t.length - 1;
}

/**
 * Merge three axes into one piece list over [ta, tb]. Each axis must cover the
 * window: its first point at or before `ta` and its last at or after `tb`.
 * Values at merged boundaries come from linear interpolation inside the
 * axis's own segment that contains the piece, so jumps resolve to the
 * correct one-sided value.
 */
export function mergeAxes(axes: readonly [AxisPoints, AxisPoints, AxisPoints], ta: number, tb: number): GradientPieces {
    if (!(tb > ta)) {
        return { t: Float64Array.of(ta, ta), ga: new Float64Array(3), gb: new Float64Array(3) };
    }
    // Union of interior support times.
    const cuts: number[] = [ta];
    for (const axis of axes) {
        for (let i = 0; i < axis.times.length; i++) {
            const time = axis.times[i];
            if (time > ta && time < tb) cuts.push(time);
        }
    }
    cuts.push(tb);
    cuts.sort((a, b) => a - b);
    const boundaries: number[] = [];
    for (const time of cuts) {
        if (!boundaries.length || time > boundaries[boundaries.length - 1]) boundaries.push(time);
    }

    const n = boundaries.length - 1;
    const t = Float64Array.from(boundaries);
    const ga = new Float64Array(3 * n);
    const gb = new Float64Array(3 * n);
    for (let axis = 0; axis < 3; axis++) {
        const { times, values } = axes[axis];
        let segment = 0;   // axis segment [times[segment], times[segment+1]]
        for (let piece = 0; piece < n; piece++) {
            const u = t[piece], v = t[piece + 1];
            // Advance to the axis segment that contains (u, v).
            while (segment + 1 < times.length - 1 && times[segment + 1] <= u) segment++;
            ga[3 * piece + axis] = interpolateWithin(times, values, segment, u);
            gb[3 * piece + axis] = interpolateWithin(times, values, segment, v);
        }
    }
    return { t, ga, gb };
}

function interpolateWithin(times: ArrayLike<number>, values: ArrayLike<number>, segment: number, time: number): number {
    if (times.length === 0) return 0;
    if (times.length === 1) return values[0];
    const t0 = times[segment], t1 = times[segment + 1];
    const v0 = values[segment], v1 = values[segment + 1];
    if (!(t1 > t0)) return v1;
    return v0 + (v1 - v0) * (time - t0) / (t1 - t0);
}

/** Exact moments of the whole window (K measured from its start). */
export function piecesMoments(pieces: GradientPieces): SegmentMoments {
    const dk = new Float64Array(3);
    const kIntegral = new Float64Array(3);
    const kSecond = new Float64Array(6);
    const n = pieceCount(pieces);
    for (let piece = 0; piece < n; piece++) {
        const h = pieces.t[piece + 1] - pieces.t[piece];
        if (!(h > 0)) continue;
        const o = 3 * piece;
        // K(t) = a + b·τ + c·τ² on this piece, τ ∈ [0, h].
        const ax = dk[0], ay = dk[1], az = dk[2];
        const bx = pieces.ga[o], by = pieces.ga[o + 1], bz = pieces.ga[o + 2];
        const cx = 0.5 * (pieces.gb[o] - bx) / h;
        const cy = 0.5 * (pieces.gb[o + 1] - by) / h;
        const cz = 0.5 * (pieces.gb[o + 2] - bz) / h;
        kIntegral[0] += quadInt(ax, bx, cx, h);
        kIntegral[1] += quadInt(ay, by, cy, h);
        kIntegral[2] += quadInt(az, bz, cz, h);
        kSecond[0] += quadProd(ax, bx, cx, ax, bx, cx, h);
        kSecond[1] += quadProd(ay, by, cy, ay, by, cy, h);
        kSecond[2] += quadProd(az, bz, cz, az, bz, cz, h);
        kSecond[3] += quadProd(ax, bx, cx, ay, by, cy, h);
        kSecond[4] += quadProd(ax, bx, cx, az, bz, cz, h);
        kSecond[5] += quadProd(ay, by, cy, az, bz, cz, h);
        dk[0] += h * (bx + cx * h);
        dk[1] += h * (by + cy * h);
        dk[2] += h * (bz + cz * h);
    }
    return { dk, kIntegral, kSecond };
}

/**
 * K(t) − K(t0) at ascending times inside the window, written xyz-interleaved
 * into `out` (length 3·times.length).
 */
export function piecesKAt(pieces: GradientPieces, times: ArrayLike<number>, out: Float64Array): void {
    const n = pieceCount(pieces);
    let piece = 0;
    let kx = 0, ky = 0, kz = 0;   // K at the start of `piece`
    for (let s = 0; s < times.length; s++) {
        const time = times[s];
        while (piece < n - 1 && pieces.t[piece + 1] <= time) {
            const h = pieces.t[piece + 1] - pieces.t[piece];
            const o = 3 * piece;
            kx += 0.5 * h * (pieces.ga[o] + pieces.gb[o]);
            ky += 0.5 * h * (pieces.ga[o + 1] + pieces.gb[o + 1]);
            kz += 0.5 * h * (pieces.ga[o + 2] + pieces.gb[o + 2]);
            piece++;
        }
        const h = pieces.t[piece + 1] - pieces.t[piece];
        const tau = Math.min(Math.max(time - pieces.t[piece], 0), h);
        const o = 3 * piece;
        if (h > 0) {
            const fx = (pieces.gb[o] - pieces.ga[o]) / h;
            const fy = (pieces.gb[o + 1] - pieces.ga[o + 1]) / h;
            const fz = (pieces.gb[o + 2] - pieces.ga[o + 2]) / h;
            out[3 * s] = kx + tau * (pieces.ga[o] + 0.5 * fx * tau);
            out[3 * s + 1] = ky + tau * (pieces.ga[o + 1] + 0.5 * fy * tau);
            out[3 * s + 2] = kz + tau * (pieces.ga[o + 2] + 0.5 * fz * tau);
        } else {
            out[3 * s] = kx;
            out[3 * s + 1] = ky;
            out[3 * s + 2] = kz;
        }
    }
}

/** Exact ∫ g dt over [a, b] ⊆ window, per axis, added into `out` (length 3). */
export function addPiecesIntegral(pieces: GradientPieces, a: number, b: number, out: Float64Array): void {
    const n = pieceCount(pieces);
    for (let piece = 0; piece < n; piece++) {
        const u = Math.max(a, pieces.t[piece]);
        const v = Math.min(b, pieces.t[piece + 1]);
        if (!(v > u)) continue;
        const h = pieces.t[piece + 1] - pieces.t[piece];
        const o = 3 * piece;
        for (let axis = 0; axis < 3; axis++) {
            const g0 = pieces.ga[o + axis];
            const slope = (pieces.gb[o + axis] - g0) / h;
            const gu = g0 + slope * (u - pieces.t[piece]);
            const gv = g0 + slope * (v - pieces.t[piece]);
            out[axis] += 0.5 * (gu + gv) * (v - u);
        }
    }
}

/** ∫₀ʰ (a + b·τ + c·τ²) dτ. */
function quadInt(a: number, b: number, c: number, h: number): number {
    return h * (a + h * (b / 2 + h * c / 3));
}

/** ∫₀ʰ (a₁ + b₁τ + c₁τ²)(a₂ + b₂τ + c₂τ²) dτ — symmetric to the last bit. */
function quadProd(a1: number, b1: number, c1: number, a2: number, b2: number, c2: number, h: number): number {
    const p0 = a1 * a2;
    const p1 = a1 * b2 + b1 * a2;
    const p2 = (a1 * c2 + c1 * a2) + b1 * b2;
    const p3 = b1 * c2 + c1 * b2;
    const p4 = c1 * c2;
    return h * (p0 + h * (p1 / 2 + h * (p2 / 3 + h * (p3 / 4 + h * p4 / 5))));
}
