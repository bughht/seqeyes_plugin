/**
 * fft.ts — minimal radix-2 FFT for the gradient spectrogram.
 *
 * Deliberately dependency-free: the same code has to run in the VS Code
 * extension host, in a browser page, and inside MATLAB's `uihtml`, so pulling
 * a package in would mean three bundling stories instead of none.
 *
 * Two things matter for the spectrogram's inner loop:
 *   - twiddle tables are cached per transform size, so a 256-column
 *     spectrogram pays for them once rather than 256 times;
 *   - `realFFTPair` transforms two real signals with one complex FFT, which
 *     halves the work for the three-axis case (x+iy in one pass, z in a second).
 */

interface TwiddleTable {
    cos: Float64Array;
    sin: Float64Array;
    reverse: Uint32Array;
}

const twiddleCache = new Map<number, TwiddleTable>();
const hannCache = new Map<number, Float64Array>();

export function isPowerOfTwo(n: number): boolean {
    return n > 0 && (n & (n - 1)) === 0;
}

export function nextPowerOfTwo(n: number): number {
    if (n <= 1) return 1;
    let p = 1;
    while (p < n) p *= 2;
    return p;
}

/** Largest power of two not exceeding `n`. */
export function previousPowerOfTwo(n: number): number {
    if (n <= 1) return 1;
    let p = 1;
    while (p * 2 <= n) p *= 2;
    return p;
}

function getTwiddles(n: number): TwiddleTable {
    const cached = twiddleCache.get(n);
    if (cached) return cached;
    if (!isPowerOfTwo(n)) throw new Error(`FFT size must be a power of two, got ${n}`);

    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
        const angle = -2 * Math.PI * i / n;
        cos[i] = Math.cos(angle);
        sin[i] = Math.sin(angle);
    }

    const bits = Math.round(Math.log2(n));
    const reverse = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
        reverse[i] = r;
    }

    const table = { cos, sin, reverse };
    twiddleCache.set(n, table);
    return table;
}

/**
 * In-place decimation-in-time complex FFT. `re` and `im` must both have length
 * `n`, a power of two.
 */
export function fftInPlace(re: Float64Array, im: Float64Array, n: number): void {
    const { cos, sin, reverse } = getTwiddles(n);

    for (let i = 0; i < n; i++) {
        const j = reverse[i];
        if (j > i) {
            let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
            tmp = im[i]; im[i] = im[j]; im[j] = tmp;
        }
    }

    for (let size = 2; size <= n; size *= 2) {
        const half = size / 2;
        const step = n / size;
        for (let start = 0; start < n; start += size) {
            for (let k = 0; k < half; k++) {
                const twiddleIndex = k * step;
                const wr = cos[twiddleIndex];
                const wi = sin[twiddleIndex];
                const a = start + k;
                const b = a + half;
                const xr = re[b] * wr - im[b] * wi;
                const xi = re[b] * wi + im[b] * wr;
                re[b] = re[a] - xr;
                im[b] = im[a] - xi;
                re[a] += xr;
                im[a] += xi;
            }
        }
    }
}

export interface RealPairSpectra {
    /** Magnitude of the first real signal, bins 0..n/2 inclusive. */
    magA: Float64Array;
    /** Magnitude of the second real signal, bins 0..n/2 inclusive. */
    magB: Float64Array;
}

/**
 * Magnitude spectra of two real signals from a single complex FFT.
 *
 * Packs `z = a + i*b`, transforms, and separates via the Hermitian symmetry
 * `A[k] = (Z[k] + conj(Z[N-k])) / 2`, `B[k] = (Z[k] - conj(Z[N-k])) / 2i`.
 *
 * `scratchRe`/`scratchIm` are reused across calls by the spectrogram builder so
 * a 256-column transform does not allocate 256 pairs of arrays.
 */
export function realFFTPairMagnitude(
    a: Float64Array,
    b: Float64Array,
    n: number,
    scratchRe: Float64Array,
    scratchIm: Float64Array,
    outA: Float64Array,
    outB: Float64Array,
): void {
    for (let i = 0; i < n; i++) {
        scratchRe[i] = a[i];
        scratchIm[i] = b[i];
    }
    fftInPlace(scratchRe, scratchIm, n);

    const half = n >> 1;
    for (let k = 0; k <= half; k++) {
        const j = (n - k) % n;
        const zr = scratchRe[k], zi = scratchIm[k];
        const cr = scratchRe[j], ci = -scratchIm[j];   // conj(Z[N-k])
        const ar = 0.5 * (zr + cr);
        const ai = 0.5 * (zi + ci);
        // (Z[k] - conj(Z[N-k])) / (2i)  ==  ( (zi-ci) , -(zr-cr) ) / 2
        const br = 0.5 * (zi - ci);
        const bi = -0.5 * (zr - cr);
        outA[k] = Math.sqrt(ar * ar + ai * ai);
        outB[k] = Math.sqrt(br * br + bi * bi);
    }
}

/** Magnitude spectrum of a single real signal, bins 0..n/2 inclusive. */
export function realFFTMagnitude(
    a: Float64Array,
    n: number,
    scratchRe: Float64Array,
    scratchIm: Float64Array,
    out: Float64Array,
): void {
    for (let i = 0; i < n; i++) {
        scratchRe[i] = a[i];
        scratchIm[i] = 0;
    }
    fftInPlace(scratchRe, scratchIm, n);
    const half = n >> 1;
    for (let k = 0; k <= half; k++) {
        const re = scratchRe[k], im = scratchIm[k];
        out[k] = Math.sqrt(re * re + im * im);
    }
}

/**
 * Periodic Hann window, matching `gradSpectrum.m`:
 * `w = 0.5 * (1 - cos(2*pi*(1:nwin)/nwin))`.
 *
 * Note the 1-based numerator: `w[0]` is not zero and `w[n-1]` is. Reproducing
 * this exactly is what keeps the parity comparison in
 * `test/gradspectrum_baselines/` meaningful.
 */
export function hannWindow(n: number): Float64Array {
    const cached = hannCache.get(n);
    if (cached) return cached;
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * (i + 1) / n));
    hannCache.set(n, w);
    return w;
}

/** Coherent gain of a window — the divisor that keeps tone amplitudes stable. */
export function windowCoherentGain(w: Float64Array): number {
    let sum = 0;
    for (let i = 0; i < w.length; i++) sum += w[i];
    return sum;
}
