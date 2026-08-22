/**
 * spectrogramTransport.ts — VS Code webview transport for the analysis panel.
 *
 * The spectrogram matrices and the audio buffer are large float arrays, and VS
 * Code serialises webview messages with `JSON.stringify`. A 256 x 401 matrix in
 * four channels is 410k numbers — roughly 7 MB of JSON text, held twice. Float32
 * base64 costs a third of that and is exactly the precision the display needs,
 * which is the same reasoning `blockTransport.ts` and `serializePns` already
 * follow.
 *
 * The webview side lives in `webview/assets/block-transport.js`; the round trip
 * between the two is covered by `test/pulseq/spectrogram-transport.test.ts`,
 * which runs that shipped decoder rather than a re-implementation.
 */

import type { GradientSpectrogram } from '../pulseq/gradSpectrum';
import type { GradientSound } from '../pulseq/gradientSound';

export function serializeSpectrogram(spec: GradientSpectrogram): Record<string, unknown> {
    return {
        nTime: spec.nTime,
        nFreq: spec.nFreq,
        tStartSec: spec.tStartSec,
        tStepSec: spec.tStepSec,
        fStartHz: spec.fStartHz,
        fStepHz: spec.fStepHz,
        dtResolutionSec: spec.dtResolutionSec,
        dfResolutionHz: spec.dfResolutionHz,
        unit: spec.unit,
        source: spec.source,
        gxB64: encodeF32B64(spec.data.gx),
        gyB64: encodeF32B64(spec.data.gy),
        gzB64: encodeF32B64(spec.data.gz),
        rssB64: encodeF32B64(spec.data.rss),
        minValue: spec.minValue,
        maxValue: spec.maxValue,
        decimationFactor: spec.decimationFactor,
        decimatedRateHz: spec.decimatedRateHz,
        windowSamples: spec.windowSamples,
        hopSamples: spec.hopSamples,
        fftPoints: spec.fftPoints,
        requestedStartSec: spec.requestedStartSec,
        requestedEndSec: spec.requestedEndSec,
        warnings: spec.warnings,
    };
}

export function serializeGradientSound(sound: GradientSound): Record<string, unknown> {
    return {
        sampleRate: sound.sampleRate,
        n: sound.n,
        startSec: sound.startSec,
        endSec: sound.endSec,
        silent: sound.silent,
        leftB64: encodeF32B64(sound.left),
        rightB64: encodeF32B64(sound.right),
    };
}

/** Encode a float array as a base64-encoded Float32 blob. */
export function encodeF32B64(data: Float64Array | Float32Array | number[]): string {
    const f32 = data instanceof Float32Array ? data : new Float32Array(data);
    return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}
