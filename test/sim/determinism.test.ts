import { describe, expect, it } from 'vitest';

import { CounterRng, philox4x32, RngStream } from '../../src/sim/rng';
import { CANONICAL_BLOCK_SPINS, TreeReducer, canonicalBlockCount } from '../../src/sim/reduce';

const hex = (words: Uint32Array) => Array.from(words, w => w.toString(16).padStart(8, '0')).join(' ');

describe('Philox4x32-10', () => {
    // Known-answer vectors from Random123 (kat_vectors, philox4x32 10 rounds).
    it('matches the Random123 known-answer vectors', () => {
        const out = new Uint32Array(4);
        expect(hex(philox4x32(0, 0, 0, 0, 0, 0, out))).toBe('6627e8d5 e169c58d bc57ac4c 9b00dbd8');
        expect(hex(philox4x32(
            0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, out,
        ))).toBe('408f276d 41c83b0e a20bc7c6 6d5451fd');
        expect(hex(philox4x32(
            0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344, 0xa4093822, 0x299f31d0, out,
        ))).toBe('d16cfe09 94fdcceb 5001e420 24126ea1');
    });

    it('is a pure function of seed, index, step and stream', () => {
        const a = new CounterRng(42), b = new CounterRng(42), c = new CounterRng(43);
        const ua = new Float64Array(2), ub = new Float64Array(2), uc = new Float64Array(2);
        a.uniform2(123456789012, 7, RngStream.noise, ua);
        // Interleave unrelated draws on `b` first; order must not matter.
        b.uniform2(1, 1, RngStream.spinJitter, ub);
        b.uniform2(123456789012, 7, RngStream.noise, ub);
        c.uniform2(123456789012, 7, RngStream.noise, uc);
        expect(Array.from(ub)).toEqual(Array.from(ua));
        expect(Array.from(uc)).not.toEqual(Array.from(ua));
        const other = new Float64Array(2);
        a.uniform2(123456789012, 7, RngStream.diffusion, other);
        expect(Array.from(other)).not.toEqual(Array.from(ua));
    });

    it('draws uniforms in [0, 1) and normals with unit variance', () => {
        const rng = new CounterRng(2026);
        const u = new Float64Array(2), z = new Float64Array(2);
        let mean = 0, sq = 0, n = 0, uMin = 1, uMax = 0;
        for (let i = 0; i < 50_000; i++) {
            rng.uniform2(i, 0, RngStream.noise, u);
            uMin = Math.min(uMin, u[0], u[1]);
            uMax = Math.max(uMax, u[0], u[1]);
            rng.normal2(i, 1, RngStream.noise, z);
            for (const v of z) { mean += v; sq += v * v; n++; }
        }
        mean /= n;
        expect(uMin).toBeGreaterThanOrEqual(0);
        expect(uMax).toBeLessThan(1);
        expect(Math.abs(mean)).toBeLessThan(0.02);
        expect(Math.abs(sq / n - mean * mean - 1)).toBeLessThan(0.02);
    });

    it('rejects seeds that are not non-negative safe integers', () => {
        expect(() => new CounterRng(-1)).toThrow(/seed/);
        expect(() => new CounterRng(1.5)).toThrow(/seed/);
    });
});

describe('TreeReducer', () => {
    function leaves(n: number, width: number) {
        // Values chosen so that summation order changes the floating-point result.
        return Array.from({ length: n }, (_, i) => Float64Array.from({ length: width }, (_, j) =>
            (i % 3 === 0 ? 1e16 : 1) * Math.sin(i * 7.3 + j) + (i % 5) * 1e-7));
    }

    function reduceInOrder(n: number, width: number, order: number[]) {
        const reducer = new TreeReducer(n, width);
        const data = leaves(n, width);
        for (const index of order) reducer.add(index, data[index]);
        return Array.from(reducer.result());
    }

    it('gives bit-identical totals for any arrival order', () => {
        for (const n of [1, 2, 3, 5, 8, 13, 64, 100]) {
            const forward = reduceInOrder(n, 4, [...Array(n).keys()]);
            const backward = reduceInOrder(n, 4, [...Array(n).keys()].reverse());
            const shuffled = reduceInOrder(n, 4, [...Array(n).keys()].sort((a, b) => ((a * 37) % n) - ((b * 37) % n)));
            expect(backward).toEqual(forward);
            expect(shuffled).toEqual(forward);
        }
    });

    it('matches the plain sum to rounding', () => {
        const n = 37;
        const data = leaves(n, 2).map(v => v.map(x => x * 1e-16));
        const reducer = new TreeReducer(n, 2);
        data.forEach((v, i) => reducer.add(i, Float64Array.from(v)));
        const total = reducer.result();
        const plain = data.reduce((sum, v) => [sum[0] + v[0], sum[1] + v[1]], [0, 0]);
        expect(total[0]).toBeCloseTo(plain[0], 12);
        expect(total[1]).toBeCloseTo(plain[1], 12);
    });

    it('rejects duplicates, bad widths and early results', () => {
        const reducer = new TreeReducer(4, 1);
        reducer.add(0, Float64Array.of(1));
        expect(() => reducer.add(0, Float64Array.of(1))).toThrow(/twice/);
        expect(() => reducer.add(1, Float64Array.of(1, 2))).toThrow(/width/);
        expect(() => reducer.add(9, Float64Array.of(1))).toThrow(/range/);
        expect(() => reducer.result()).toThrow(/only 1 of 4/);
    });

    it('counts canonical blocks', () => {
        expect(canonicalBlockCount(0)).toBe(0);
        expect(canonicalBlockCount(1)).toBe(1);
        expect(canonicalBlockCount(CANONICAL_BLOCK_SPINS)).toBe(1);
        expect(canonicalBlockCount(CANONICAL_BLOCK_SPINS + 1)).toBe(2);
    });
});
