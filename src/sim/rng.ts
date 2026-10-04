/**
 * Counter-based random numbers (Philox4x32-10, Salmon et al., SC'11 — the
 * Random123 generator).
 *
 * A counter-based generator has no state to carry: the value for (key,
 * counter) is a pure function, so spin jitter, noise and Monte Carlo steps
 * come out identical however the work is tiled across workers, replayed from
 * a checkpoint, or recomputed in an adjoint pass. Convention used throughout
 * the simulator: key = seed, counter = (index lo, index hi, step, stream).
 */

const M0 = 0xd2511f53;
const M1 = 0xcd9e8d57;
const W0 = 0x9e3779b9;
const W1 = 0xbb67ae85;

/** Distinct streams so independent uses of one (index, step) never correlate. */
export const RngStream = Object.freeze({
    spinJitter: 1,
    t2PrimePermutation: 2,
    noise: 3,
    diffusion: 4,
});

/** High 32 bits of the 64-bit product of two uint32 values. */
function mulhi32(a: number, b: number): number {
    const a0 = a & 0xffff, a1 = a >>> 16;
    const b0 = b & 0xffff, b1 = b >>> 16;
    const p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1;
    const middle = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
    return (p11 + (p01 >>> 16) + (p10 >>> 16) + (middle >>> 16)) >>> 0;
}

/**
 * Philox4x32 with 10 rounds: four uint32 words of output for a 128-bit counter
 * (c0..c3) and 64-bit key (k0, k1), written into `out`.
 */
export function philox4x32(
    c0: number, c1: number, c2: number, c3: number,
    k0: number, k1: number,
    out: Uint32Array,
): Uint32Array {
    let x0 = c0 >>> 0, x1 = c1 >>> 0, x2 = c2 >>> 0, x3 = c3 >>> 0;
    let key0 = k0 >>> 0, key1 = k1 >>> 0;
    for (let round = 0; round < 10; round++) {
        if (round > 0) {
            key0 = (key0 + W0) >>> 0;
            key1 = (key1 + W1) >>> 0;
        }
        const hi0 = mulhi32(M0, x0), lo0 = Math.imul(M0, x0) >>> 0;
        const hi1 = mulhi32(M1, x2), lo1 = Math.imul(M1, x2) >>> 0;
        const y0 = (hi1 ^ x1 ^ key0) >>> 0;
        const y2 = (hi0 ^ x3 ^ key1) >>> 0;
        x0 = y0; x1 = lo1; x2 = y2; x3 = lo0;
    }
    out[0] = x0; out[1] = x1; out[2] = x2; out[3] = x3;
    return out;
}

const TWO_POW_32 = 4294967296;
const TWO_POW_53 = 9007199254740992;

/** Seeded draws addressed by (index, step, stream). */
export class CounterRng {
    private readonly k0: number;
    private readonly k1: number;
    private readonly words = new Uint32Array(4);

    /** @param seed  Non-negative integer up to 2^53. */
    constructor(seed: number) {
        if (!Number.isSafeInteger(seed) || seed < 0) throw new Error(`seed must be a non-negative safe integer, got ${seed}`);
        this.k0 = seed % TWO_POW_32;
        this.k1 = Math.floor(seed / TWO_POW_32);
    }

    /** Four raw uint32 words for (index, step, stream). */
    raw(index: number, step: number, stream: number): Uint32Array {
        return philox4x32(
            index % TWO_POW_32, Math.floor(index / TWO_POW_32), step, stream,
            this.k0, this.k1, this.words,
        );
    }

    /** Two uniform doubles in [0, 1) with 53-bit resolution, written into `out`. */
    uniform2(index: number, step: number, stream: number, out: Float64Array): Float64Array {
        const w = this.raw(index, step, stream);
        out[0] = ((w[0] >>> 5) * 67108864 + (w[1] >>> 6)) / TWO_POW_53;
        out[1] = ((w[2] >>> 5) * 67108864 + (w[3] >>> 6)) / TWO_POW_53;
        return out;
    }

    /** Two independent standard normal draws (Box–Muller), written into `out`. */
    normal2(index: number, step: number, stream: number, out: Float64Array): Float64Array {
        this.uniform2(index, step, stream, out);
        const radius = Math.sqrt(-2 * Math.log(1 - out[0]));   // 1 − u ∈ (0, 1]
        const angle = 2 * Math.PI * out[1];
        out[0] = radius * Math.cos(angle);
        out[1] = radius * Math.sin(angle);
        return out;
    }
}
