/**
 * The k-space reply the extension host sends to its webview.
 *
 * This lives outside `seqEditorProvider` so both the provider and the tests can
 * build the real payload: the provider imports `vscode`, which a browser or
 * Vitest run cannot load.  `waveformDetailReply.ts` was split out for the same
 * reason.
 */
import type { KSpaceData } from '../pulseq/kspace';

/** Overview curve budget; the full trajectory is only drawn from ADC samples. */
export const MAX_KSPACE_OVERVIEW_POINTS = 30000;

export interface SerializedKSpace {
    kx: number[];
    ky: number[];
    kz: number[];
    tk: number[];
    adcX: ArrayBuffer;
    adcY: ArrayBuffer;
    adcZ: ArrayBuffer;
    adcTime: ArrayBuffer;
    nAdc: number;
}

/**
 * Pack a trajectory for the webview.
 *
 * The ADC samples travel as raw Float32 buffers, the same transport the
 * waveform samples use.  They were previously base64 strings inside the JSON
 * envelope, which for a 2.9 M-sample trajectory meant a single 59 MiB string —
 * built, copied across the process boundary and re-parsed on the other side,
 * each copy costing twice that in UTF-16 memory.  Sequences that large arrived
 * with their ADC arrays missing, and the viewer drew an empty panel.
 */
export function serializeKSpace(ks: KSpaceData): SerializedKSpace {
    return {
        kx: downsample(ks.ktraj[0], MAX_KSPACE_OVERVIEW_POINTS),
        ky: downsample(ks.ktraj[1], MAX_KSPACE_OVERVIEW_POINTS),
        kz: downsample(ks.ktraj[2], MAX_KSPACE_OVERVIEW_POINTS),
        tk: downsample(ks.t_ktraj, MAX_KSPACE_OVERVIEW_POINTS),
        adcX: toF32Buffer(ks.ktraj_adc[0]),
        adcY: toF32Buffer(ks.ktraj_adc[1]),
        adcZ: toF32Buffer(ks.ktraj_adc[2]),
        adcTime: toF32Buffer(ks.t_adc),
        nAdc: ks.ktraj_adc[0].length,
    };
}

/** Copy a sample series into a standalone Float32 buffer for transfer. */
export function toF32Buffer(data: Float64Array | Float32Array | number[]): ArrayBuffer {
    return new Float32Array(data).buffer;
}

/** Uniformly downsample an array to at most `maxPts` elements. */
export function downsample(arr: Float64Array | number[], maxPts: number): number[] {
    if (!arr) return [];
    const n = arr.length;
    if (n <= maxPts) return Array.from(arr);
    const step = n / maxPts;
    const out = new Array<number>(maxPts);
    for (let i = 0; i < maxPts; i++) out[i] = arr[Math.floor(i * step)];
    return out;
}
