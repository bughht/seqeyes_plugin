import { describe, expect, it } from 'vitest';

import { addPiecesIntegral, mergeAxes, pieceCount, piecesKAt, piecesMoments } from '../../src/sim/program/pwl';

const zero = { times: [0, 10], values: [0, 0] };

describe('piecewise-linear gradient windows', () => {
    it('merges axis breakpoints into one piece list', () => {
        const x = { times: [0, 1, 3], values: [0, 2, 2] };
        const y = { times: [0, 2, 3], values: [1, 1, 0] };
        const pieces = mergeAxes([x, y, zero], 0, 3);
        expect(Array.from(pieces.t)).toEqual([0, 1, 2, 3]);
        expect(pieceCount(pieces)).toBe(3);
        // x ramps 0→2 then holds; y holds 1 then ramps to 0.
        expect(Array.from(pieces.ga)).toEqual([0, 1, 0, 2, 1, 0, 2, 1, 0]);
        expect(Array.from(pieces.gb)).toEqual([2, 1, 0, 2, 1, 0, 2, 0, 0]);
    });

    it('keeps both sides of a jump', () => {
        // A step from 1 to 5 at t = 1 (two points at the same time).
        const x = { times: [0, 1, 1, 2], values: [1, 1, 5, 5] };
        const pieces = mergeAxes([x, zero, zero], 0, 2);
        expect(Array.from(pieces.t)).toEqual([0, 1, 2]);
        expect([pieces.ga[0], pieces.gb[0]]).toEqual([1, 1]);
        expect([pieces.ga[3], pieces.gb[3]]).toEqual([5, 5]);
        expect(piecesMoments(pieces).dk[0]).toBe(6);
    });

    it('clips windows that start and end inside axis segments', () => {
        const x = { times: [0, 4], values: [0, 4] };   // g = t
        const pieces = mergeAxes([x, zero, zero], 1, 3);
        expect(Array.from(pieces.t)).toEqual([1, 3]);
        expect([pieces.ga[0], pieces.gb[0]]).toEqual([1, 3]);
        const m = piecesMoments(pieces);
        expect(m.dk[0]).toBeCloseTo(4, 14);                 // ∫₁³ t dt
        // K(τ) = ∫₁^{1+τ} t dt = τ + τ²/2 on τ ∈ [0, 2].
        expect(m.kIntegral[0]).toBeCloseTo(2 + 8 / 6, 14);
        expect(m.kSecond[0]).toBeCloseTo(4 * 2 / 3 + 2 * 16 / 8 + 32 / 20, 12);
    });

    it('evaluates K at sample times consistently with the moments', () => {
        const x = { times: [0, 1, 2, 3], values: [0, 3, 3, -1] };
        const y = { times: [0, 3], values: [2, 2] };
        const pieces = mergeAxes([x, y, zero], 0, 3);
        const times = [0, 0.5, 1, 1.5, 2, 2.5, 3];
        const out = new Float64Array(3 * times.length);
        piecesKAt(pieces, times, out);
        expect(out[0]).toBe(0);
        expect(out[3 * 2]).toBeCloseTo(1.5, 14);            // ∫₀¹ 3t dt
        expect(out[3 * 4]).toBeCloseTo(4.5, 14);            // + 3
        expect(out[3 * 6]).toBeCloseTo(piecesMoments(pieces).dk[0], 14);
        expect(out[3 * 6 + 1]).toBeCloseTo(6, 14);
    });

    it('integrates any sub-interval exactly', () => {
        const x = { times: [0, 2], values: [0, 2] };
        const pieces = mergeAxes([x, zero, zero], 0, 2);
        const out = new Float64Array(3);
        addPiecesIntegral(pieces, 0.5, 1.5, out);
        expect(out[0]).toBeCloseTo(1, 14);                  // ∫ t dt over [0.5, 1.5]
    });

    it('produces a degenerate single piece for an empty window', () => {
        const pieces = mergeAxes([zero, zero, zero], 1, 1);
        expect(pieceCount(pieces)).toBe(1);
        expect(piecesMoments(pieces).dk[0]).toBe(0);
    });
});
