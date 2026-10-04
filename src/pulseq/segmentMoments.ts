/**
 * segmentMoments.ts — exact moments of piecewise-linear gradient segments.
 *
 * Every Pulseq gradient is piecewise linear in time, so within one linear
 * piece g(t) = ga + s·t (s = (gb − ga)/h, t ∈ [0, h]) the trajectory
 *   k(t) = k0 + ga·t + (s/2)·t²
 * is a quadratic, and every moment the simulator needs is a closed-form
 * polynomial integral. Units follow the rest of the parser: g in Hz/m, so k in
 * cycles/m (1/m) and no 2π factor; callers that need rad/m multiply by 2π.
 */

/**
 * Zeroth and first gradient moments of one linear segment over [a, b], with the
 * first moment taken about `tRef`.
 *   M0 = ∫ g dt,  M1 = ∫ g·(t − tRef) dt.
 */
export function integrateLinearSegment(a: number, b: number, tRef: number, ga: number, gb: number): [number, number] {
    const h = b - a;
    if (!(h > 0)) return [0, 0];
    const slope = (gb - ga) / h;
    const aRel = a - tRef;
    const m0 = ga * h + 0.5 * slope * h * h;
    const m1 = ga * (aRel * h + 0.5 * h * h)
        + slope * (0.5 * aRel * h * h + (h * h * h) / 3.0);
    return [m0, m1];
}

/** Moments of k(t) over one linear gradient segment of length `h`. */
export interface LinearSegmentKMoments {
    /** k(h) − k(0) = ∫ g dt. */
    dk: number;
    /** ∫₀ʰ k(t) dt. */
    kIntegral: number;
    /** ∫₀ʰ k(t)² dt. */
    kSquaredIntegral: number;
}

/**
 * Moments of the trajectory over one linear gradient segment, starting from
 * k(0) = `k0`. With `k0 = 0` these are the segment-local quantities a Monte
 * Carlo diffusion step needs; with the running trajectory they give the
 * diffusion b-value increment.
 */
export function linearSegmentKMoments(h: number, k0: number, ga: number, gb: number): LinearSegmentKMoments {
    if (!(h > 0)) return { dk: 0, kIntegral: 0, kSquaredIntegral: 0 };
    const c = 0.5 * (gb - ga) / h;   // k(t) = k0 + ga·t + c·t²
    return {
        dk: ga * h + c * h * h,
        kIntegral: quadraticIntegral(k0, ga, c, h),
        kSquaredIntegral: quadraticProductIntegral(k0, ga, c, k0, ga, c, h),
    };
}

/**
 * ∫₀ʰ kᵢ(t)·kⱼ(t) dt for two axes over the same linear segment, each with its
 * own start value and gradient ramp. This is the off-diagonal term of the
 * diffusion b-tensor; the diagonal is `linearSegmentKMoments().kSquaredIntegral`.
 */
export function crossKIntegral(
    h: number,
    k0i: number, gai: number, gbi: number,
    k0j: number, gaj: number, gbj: number,
): number {
    if (!(h > 0)) return 0;
    return quadraticProductIntegral(
        k0i, gai, 0.5 * (gbi - gai) / h,
        k0j, gaj, 0.5 * (gbj - gaj) / h,
        h,
    );
}

/** Index order of the six independent b-tensor components. */
export const B_TENSOR_COMPONENTS = ['xx', 'yy', 'zz', 'xy', 'xz', 'yz'] as const;

/**
 * Diffusion b-tensor increment of one linear segment [s/m²]:
 *   b_ij = (2π)² ∫ kᵢ kⱼ dt,
 * with k in cycles/m. Components are ordered as `B_TENSOR_COMPONENTS`, and the
 * result is accumulated into `out` so a caller can sum segments without
 * allocating.
 */
export function addSegmentBTensor(
    out: Float64Array,
    h: number,
    k0: ArrayLike<number>,
    ga: ArrayLike<number>,
    gb: ArrayLike<number>,
): void {
    if (!(h > 0)) return;
    const scale = 4 * Math.PI * Math.PI;
    const cx = 0.5 * (gb[0] - ga[0]) / h;
    const cy = 0.5 * (gb[1] - ga[1]) / h;
    const cz = 0.5 * (gb[2] - ga[2]) / h;
    out[0] += scale * quadraticProductIntegral(k0[0], ga[0], cx, k0[0], ga[0], cx, h);
    out[1] += scale * quadraticProductIntegral(k0[1], ga[1], cy, k0[1], ga[1], cy, h);
    out[2] += scale * quadraticProductIntegral(k0[2], ga[2], cz, k0[2], ga[2], cz, h);
    out[3] += scale * quadraticProductIntegral(k0[0], ga[0], cx, k0[1], ga[1], cy, h);
    out[4] += scale * quadraticProductIntegral(k0[0], ga[0], cx, k0[2], ga[2], cz, h);
    out[5] += scale * quadraticProductIntegral(k0[1], ga[1], cy, k0[2], ga[2], cz, h);
}

/** ∫₀ʰ (a + b·t + c·t²) dt. */
function quadraticIntegral(a: number, b: number, c: number, h: number): number {
    return h * (a + h * (b / 2 + h * c / 3));
}

/**
 * ∫₀ʰ (a₁ + b₁t + c₁t²)(a₂ + b₂t + c₂t²) dt, in Horner form. The cross terms
 * are grouped in pairs so swapping the two factors gives a bit-identical
 * result, which keeps the b-tensor exactly symmetric.
 */
function quadraticProductIntegral(
    a1: number, b1: number, c1: number,
    a2: number, b2: number, c2: number,
    h: number,
): number {
    const p0 = a1 * a2;
    const p1 = a1 * b2 + b1 * a2;
    const p2 = (a1 * c2 + c1 * a2) + b1 * b2;
    const p3 = b1 * c2 + c1 * b2;
    const p4 = c1 * c2;
    return h * (p0 + h * (p1 / 2 + h * (p2 / 3 + h * (p3 / 4 + h * p4 / 5))));
}
