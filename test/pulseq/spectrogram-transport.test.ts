import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  encodeF32B64,
  serializeGradientSound,
  serializeSpectrogram,
} from '../../src/editor/spectrogramTransport';
import { decodeAllBlocks } from '../../src/pulseq/decoder';
import { computeGradientSpectrogram, type GradientSpectrogram } from '../../src/pulseq/gradSpectrum';
import { synthesizeGradientSound } from '../../src/pulseq/gradientSound';
import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';

/**
 * The VS Code round trip, exercised over the *shipped* webview decoder rather
 * than a re-implementation of it. A serializer and a deserializer that drift
 * apart would still round-trip cleanly against each other's copy; running
 * `block-transport.js` itself is what makes this test worth having.
 */
interface TransportApi {
  decodeB64F32: (b64: string, n: number) => Float32Array;
  deserializeSpectrogram: (payload: Record<string, unknown>) => GradientSpectrogram | null;
  deserializeGradientSound: (payload: Record<string, unknown>) => {
    sampleRate: number;
    n: number;
    startSec: number;
    endSec: number;
    silent: boolean;
    left: Float32Array;
    right: Float32Array;
  } | null;
}

const ASSETS = join(__dirname, '..', '..', 'src', 'editor', 'webview', 'assets');
const FIXTURES = join(__dirname, '..', 'seqeyes_demo_seq_files');

function loadTransportApi(): TransportApi {
  const context = createContext({
    Float64Array, Float32Array, Int32Array, Uint32Array, ArrayBuffer,
    Infinity, isFinite, Math, Error,
    // The webview has atob natively; Node needs it supplied.
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
  });
  runInContext(readFileSync(join(ASSETS, 'block-transport.js'), 'utf8'), context);
  return context as unknown as TransportApi;
}

/** Reproduce what postMessage does to the payload on the way across. */
function overTheWire<T>(payload: T): T {
  return JSON.parse(JSON.stringify(payload)) as T;
}

function loadSpectrogram(): GradientSpectrogram {
  const bytes = readFileSync(join(FIXTURES, 'writeSpiral.seq'));
  const sequence = parseSequenceBytes(new Uint8Array(bytes), 'writeSpiral.seq');
  const blocks = decodeAllBlocks(sequence);
  return computeGradientSpectrogram(blocks, sequence.rasterTimes.gradientRaster, {
    startSec: 0,
    endSec: 0.05,
    fMaxHz: 3000,
    windowSamples: 128,
  });
}

/* Contextified lazily inside the tests: creating the VM context during test
   collection interferes with vitest's own describe bookkeeping. */
let cachedApi: TransportApi | null = null;
function transportApi(): TransportApi {
  if (!cachedApi) cachedApi = loadTransportApi();
  return cachedApi;
}

describe('spectrogram webview transport', () => {

  it('round-trips a spectrogram matrix through the shipped decoder', () => {
    const original = loadSpectrogram();
    expect(original.nTime).toBeGreaterThan(0);
    expect(original.nFreq).toBeGreaterThan(0);

    const restored = transportApi().deserializeSpectrogram(overTheWire(serializeSpectrogram(original)));
    expect(restored).not.toBeNull();

    expect(restored!.nTime).toBe(original.nTime);
    expect(restored!.nFreq).toBe(original.nFreq);
    expect(restored!.tStartSec).toBeCloseTo(original.tStartSec, 12);
    expect(restored!.tStepSec).toBeCloseTo(original.tStepSec, 12);
    expect(restored!.fStartHz).toBeCloseTo(original.fStartHz, 9);
    expect(restored!.fStepHz).toBeCloseTo(original.fStepHz, 9);
    expect(restored!.unit).toBe(original.unit);
    expect(restored!.source).toBe(original.source);
    expect(restored!.decimationFactor).toBe(original.decimationFactor);
    expect(restored!.windowSamples).toBe(original.windowSamples);
    expect(restored!.hopSamples).toBe(original.hopSamples);
    expect(restored!.fftPoints).toBe(original.fftPoints);
    expect(restored!.requestedStartSec).toBeCloseTo(original.requestedStartSec, 12);
    expect(restored!.requestedEndSec).toBeCloseTo(original.requestedEndSec, 12);
    expect(restored!.warnings).toEqual(original.warnings);

    const cells = original.nTime * original.nFreq;
    for (const key of ['gx', 'gy', 'gz', 'rss'] as const) {
      expect(restored!.data[key].length).toBe(cells);
      // The source arrays are already Float32, so the trip is exact.
      for (let i = 0; i < cells; i += Math.max(1, Math.floor(cells / 500))) {
        expect(restored!.data[key][i]).toBe(original.data[key][i]);
      }
    }
  });

  it('keeps the cache key fields, which decide whether a pan recomputes', () => {
    // panel.js keys its cache on requestedStartSec/requestedEndSec; losing
    // either would make every pan recompute a view it already had.
    const original = loadSpectrogram();
    const restored = transportApi().deserializeSpectrogram(overTheWire(serializeSpectrogram(original)))!;
    expect(restored.requestedStartSec).toBe(original.requestedStartSec);
    expect(restored.requestedEndSec).toBe(original.requestedEndSec);
  });

  it('round-trips an empty spectrogram without producing NaN', () => {
    const empty = computeGradientSpectrogram([], 1e-5, { startSec: 0, endSec: 0.05 });
    const restored = transportApi().deserializeSpectrogram(overTheWire(serializeSpectrogram(empty)))!;

    expect(restored.nTime).toBe(0);
    expect(restored.nFreq).toBe(0);
    expect(restored.data.rss.length).toBe(0);
    expect(Number.isFinite(restored.maxValue)).toBe(true);
    expect(restored.warnings.length).toBeGreaterThan(0);
  });

  it('round-trips a stereo gradient sound buffer', () => {
    const bytes = readFileSync(join(FIXTURES, 'writeSpiral.seq'));
    const sequence = parseSequenceBytes(new Uint8Array(bytes), 'writeSpiral.seq');
    const blocks = decodeAllBlocks(sequence);
    const sound = synthesizeGradientSound(blocks, { startSec: 0, endSec: 0.05 });

    const restored = transportApi().deserializeGradientSound(overTheWire(serializeGradientSound(sound)))!;

    expect(restored.sampleRate).toBe(sound.sampleRate);
    expect(restored.n).toBe(sound.n);
    expect(restored.left.length).toBe(sound.n);
    expect(restored.right.length).toBe(sound.n);
    expect(restored.silent).toBe(sound.silent);
    for (let i = 0; i < sound.n; i += Math.max(1, Math.floor(sound.n / 500))) {
      expect(restored.left[i]).toBe(sound.left[i]);
      expect(restored.right[i]).toBe(sound.right[i]);
    }
  });

  it('encodes a subarray view without dragging in the whole buffer', () => {
    // Float32Array views over a larger buffer are easy to serialise wrongly:
    // `Buffer.from(view.buffer)` would ship every sample behind the view.
    const backing = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const view = backing.subarray(2, 5);

    const decoded = transportApi().decodeB64F32(encodeF32B64(view), view.length);

    expect(Array.from(decoded)).toEqual([3, 4, 5]);
  });
});
