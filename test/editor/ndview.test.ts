import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

interface Dim { name: string; size: number; reversed?: boolean }
interface NdViewApi {
    fft(re: Float64Array, im: Float64Array, inverse: boolean): void;
    transformDim(dims: Dim[], re: Float32Array, im: Float32Array, d: number, inverse: boolean): void;
}

const ASSETS = join(__dirname, '..', '..', 'src', 'editor', 'webview', 'assets');

function loadNdView(): NdViewApi {
    const context = createContext({ Float64Array, Float32Array, Int32Array, Math, Error });
    runInContext(readFileSync(join(ASSETS, 'ndview.js'), 'utf8') + '\nthis.SeqEyesNdView = SeqEyesNdView;', context);
    return (context as unknown as { SeqEyesNdView: NdViewApi }).SeqEyesNdView;
}

/** Direct DFT with the same sign and scaling as the viewer's. */
function dft(re: number[], im: number[], inverse: boolean): [number[], number[]] {
    const n = re.length, sign = inverse ? 1 : -1;
    const outRe: number[] = [], outIm: number[] = [];
    for (let k = 0; k < n; k++) {
        let sr = 0, si = 0;
        for (let j = 0; j < n; j++) {
            const angle = sign * 2 * Math.PI * j * k / n;
            sr += re[j] * Math.cos(angle) - im[j] * Math.sin(angle);
            si += re[j] * Math.sin(angle) + im[j] * Math.cos(angle);
        }
        outRe.push(sr);
        outIm.push(si);
    }
    return [outRe, outIm];
}

describe('N-D viewer transforms', () => {
    const api = loadNdView();

    it.each([1, 2, 7, 8, 12, 128, 131])('matches a direct DFT for length %i (radix-2 and Bluestein)', n => {
        const re = Array.from({ length: n }, (_, i) => Math.sin(1.3 * i) + 0.1 * i);
        const im = Array.from({ length: n }, (_, i) => Math.cos(0.7 * i * i));
        for (const inverse of [false, true]) {
            const [er, ei] = dft(re, im, inverse);
            const ar = Float64Array.from(re), ai = Float64Array.from(im);
            api.fft(ar, ai, inverse);
            for (let k = 0; k < n; k++) {
                expect(ar[k]).toBeCloseTo(er[k], 8);
                expect(ai[k]).toBeCloseTo(ei[k], 8);
            }
        }
    });

    it('centres the transform: a constant k-space line becomes a delta at the centre', () => {
        const n = 16;
        const re = new Float32Array(n).fill(1), im = new Float32Array(n);
        api.transformDim([{ name: 'k', size: n }], re, im, 0, true);
        for (let i = 0; i < n; i++) expect(Math.hypot(re[i], im[i])).toBeCloseTo(i === n / 2 ? n : 0, 4);
    });

    it('transforms a top-down dimension as if it were stored bottom-up', () => {
        // A point at position +3 (bottom-up index n/2 + 3) has k-space phase
        // e^{−i2π·k·3/n}; stored top-down, the transform must put it back at
        // top-down row n/2 − 1 − 3.
        const n = 16, shift = 3;
        const re = new Float32Array(n), im = new Float32Array(n);
        for (let row = 0; row < n; row++) {
            const k = (n - 1 - row) - n / 2;     // top-down storage of k
            re[row] = Math.cos(2 * Math.PI * k * shift / n);
            im[row] = -Math.sin(2 * Math.PI * k * shift / n);
        }
        api.transformDim([{ name: 'ky', size: n, reversed: true }], re, im, 0, true);
        const peak = Array.from(re, (r, i) => Math.hypot(r, im[i])).reduce((best, v, i, all) => (v > all[best] ? i : best), 0);
        expect(peak).toBe(n / 2 - 1 - shift);
    });

    it('transforms one dimension of a 3-D array without touching the others', () => {
        const dims = [{ name: 'a', size: 4 }, { name: 'b', size: 6 }, { name: 'c', size: 3 }];
        const size = 4 * 6 * 3;
        const re = Float32Array.from({ length: size }, (_, i) => Math.sin(i)), im = new Float32Array(size);
        const before = Float32Array.from(re);
        api.transformDim(dims, re, im, 1, false);
        api.transformDim(dims, re, im, 1, true);
        // Forward then inverse returns n × the input along that dimension.
        for (let i = 0; i < size; i++) expect(re[i] / 6).toBeCloseTo(before[i], 5);
    });
});
