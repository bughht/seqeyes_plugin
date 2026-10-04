import { describe, expect, it } from 'vitest';

import {
    addSegmentBTensor,
    crossKIntegral,
    integrateLinearSegment,
    linearSegmentKMoments,
} from '../../src/pulseq/segmentMoments';

/** Composite Simpson's rule — exact for the polynomials of degree ≤ 3 per panel,
 *  and very accurate for the degree-4 products here at this panel count. */
function simpson(f: (t: number) => number, h: number, panels = 2000): number {
    const n = panels * 2;
    const dt = h / n;
    let sum = f(0) + f(h);
    for (let i = 1; i < n; i++) sum += (i % 2 ? 4 : 2) * f(i * dt);
    return sum * dt / 3;
}

/** Deterministic pseudo-random numbers so failures reproduce. */
function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

const random = rng(12345);
const cases = Array.from({ length: 20 }, () => ({
    h: 1e-5 + random() * 3e-3,
    k0: (random() - 0.5) * 2e3,
    ga: (random() - 0.5) * 4e6,
    gb: (random() - 0.5) * 4e6,
}));

function trajectory(k0: number, ga: number, gb: number, h: number) {
    const slope = (gb - ga) / h;
    return (t: number) => k0 + ga * t + 0.5 * slope * t * t;
}

describe('segment moments', () => {
    it('integrateLinearSegment matches quadrature for M0 and M1', () => {
        for (const { h, ga, gb } of cases) {
            const a = 0.25, b = a + h, tRef = 0.2;
            const g = (t: number) => ga + (gb - ga) * t / h;
            const [m0, m1] = integrateLinearSegment(a, b, tRef, ga, gb);
            expect(m0).toBeCloseTo(simpson(g, h), 6);
            expect(m1 / simpson(t => g(t) * (a + t - tRef), h)).toBeCloseTo(1, 10);
        }
    });

    it('returns zeros for empty or reversed segments', () => {
        expect(integrateLinearSegment(1, 1, 0, 5, 5)).toEqual([0, 0]);
        expect(linearSegmentKMoments(0, 1, 2, 3)).toEqual({ dk: 0, kIntegral: 0, kSquaredIntegral: 0 });
        expect(crossKIntegral(-1, 1, 2, 3, 4, 5, 6)).toBe(0);
    });

    it('linearSegmentKMoments matches quadrature', () => {
        for (const { h, k0, ga, gb } of cases) {
            const k = trajectory(k0, ga, gb, h);
            const m = linearSegmentKMoments(h, k0, ga, gb);
            expect(m.dk / (k(h) - k0)).toBeCloseTo(1, 12);
            expect(m.kIntegral / simpson(k, h)).toBeCloseTo(1, 10);
            expect(m.kSquaredIntegral / simpson(t => k(t) ** 2, h)).toBeCloseTo(1, 10);
        }
    });

    it('crossKIntegral matches quadrature and is symmetric', () => {
        for (let i = 0; i + 1 < cases.length; i += 2) {
            const p = cases[i], q = { ...cases[i + 1], h: p.h };
            const ki = trajectory(p.k0, p.ga, p.gb, p.h);
            const kj = trajectory(q.k0, q.ga, q.gb, p.h);
            const exact = crossKIntegral(p.h, p.k0, p.ga, p.gb, q.k0, q.ga, q.gb);
            const reverse = crossKIntegral(p.h, q.k0, q.ga, q.gb, p.k0, p.ga, p.gb);
            expect(exact).toBe(reverse);
            const numeric = simpson(t => ki(t) * kj(t), p.h);
            expect(Math.abs(exact - numeric)).toBeLessThan(1e-9 * Math.max(1, Math.abs(numeric)));
        }
    });

    it('gives the Stejskal–Tanner b-value for a rectangular pulsed-gradient spin echo', () => {
        // Ideal PGSE with infinitely fast ramps, on the effective (refocus-negated)
        // trajectory: lobe δ at G, gap Δ−δ holding k, then the second lobe
        // unwinding it. b = (2πγ̄Gδ)²(Δ − δ/3).
        const g = 42.577e6 * 0.04;   // 40 mT/m in Hz/m
        const delta = 0.01, bigDelta = 0.03;
        const b = new Float64Array(6);
        addSegmentBTensor(b, delta, [0, 0, 0], [g, 0, 0], [g, 0, 0]);
        addSegmentBTensor(b, bigDelta - delta, [g * delta, 0, 0], [0, 0, 0], [0, 0, 0]);
        addSegmentBTensor(b, delta, [g * delta, 0, 0], [-g, 0, 0], [-g, 0, 0]);
        const expected = (2 * Math.PI * g * delta) ** 2 * (bigDelta - delta / 3);
        expect(b[0] / expected).toBeCloseTo(1, 12);
        expect(Array.from(b.subarray(1))).toEqual([0, 0, 0, 0, 0]);
    });

    it('accumulates the cross terms of an oblique encoding', () => {
        const g = 1e6;
        const b = new Float64Array(6);
        addSegmentBTensor(b, 1e-3, [0, 0, 0], [g, g, 0], [g, g, 0]);
        // Equal x and y lobes: xx = yy = xy, nothing on z.
        expect(b[0]).toBeGreaterThan(0);
        expect(b[1]).toBe(b[0]);
        expect(b[3]).toBe(b[0]);
        expect(b[2]).toBe(0);
        expect(b[4]).toBe(0);
        expect(b[5]).toBe(0);
    });
});
