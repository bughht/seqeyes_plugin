import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { MAX_DISPLAY_PTS, packBlocks } from '../../src/editor/blockTransport';
import { decodeAllBlocks } from '../../src/pulseq/decoder';
import { downsampleM4 } from '../../src/pulseq/displayDownsampling';
import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';
import type { DecodedBlock } from '../../src/pulseq/types';

const ASSETS = join(__dirname, '..', '..', 'src', 'editor', 'webview', 'assets');
const FIXTURES = join(__dirname, '..', 'seqeyes_demo_seq_files');

/**
 * The renderer only ever indexes a waveform array and asks for its length, so
 * typed-array views should be indistinguishable from the plain arrays the
 * standalone web app builds.  These tests run the shipped webview code over
 * both shapes of the same sequence and require identical results — that is what
 * makes the binary transport safe to hand to unchanged drawing code.
 */
interface RenderApi {
  createWaveformOverview: (blocks: unknown[]) => any;
  selectWaveformOverview: (
    overview: unknown, startBlock: number, endBlock: number, maxBuckets: number,
  ) => { first: number; last: number };
  waveformVisiblePointCount: (
    overview: unknown, key: string, startBlock: number, endBlock: number,
  ) => number;
  forEachWaveformPoint: (
    time: ArrayLike<number>, values: ArrayLike<number>, maxPoints: number,
    visit: (time: number, value: number) => void,
  ) => number;
  binRfEvents: (
    series: unknown, viewStart: number, viewEnd: number,
    pixelCount: number, widePixelThreshold: number,
  ) => any;
  unpackSequenceBlocks: (
    envelope: unknown[], timeBuffer: unknown, valueBuffer: unknown, sampleCount: number,
  ) => Array<Record<string, any>>;
}

function loadRenderApi(): RenderApi {
  const context = createContext({
    Float64Array, Float32Array, Int32Array, Uint32Array, ArrayBuffer,
    Infinity, isFinite, Math, Error,
  });
  for (const file of ['block-transport.js', 'derived-series.js']) {
    runInContext(readFileSync(join(ASSETS, file), 'utf8'), context);
  }
  return context as unknown as RenderApi;
}

function loadBlocks(fixture: string): DecodedBlock[] {
  const bytes = readFileSync(join(FIXTURES, fixture));
  return decodeAllBlocks(parseSequenceBytes(new Uint8Array(bytes), fixture));
}

/** The plain-array block shape the standalone web app hands to the renderer. */
function serializeInline(blocks: DecodedBlock[]): Array<Record<string, any>> {
  const uniform = (values: ArrayLike<number>): number[] => {
    const n = values.length;
    if (n <= MAX_DISPLAY_PTS) return Array.from(values);
    const step = n / MAX_DISPLAY_PTS;
    return Array.from({ length: MAX_DISPLAY_PTS }, (_, k) => values[Math.floor(k * step)]);
  };
  const wrap = (value: number): number => ((value % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return blocks.map(b => {
    const o: Record<string, any> = { i: b.index, s: b.startTime, d: b.duration };
    if (b.rf) {
      const magnitude = downsampleM4(b.rf.timePoints, b.rf.magnitude, MAX_DISPLAY_PTS);
      o.rf = {
        s: b.rf.startTime, d: b.rf.duration,
        t: magnitude.time, m: magnitude.values,
        pt: uniform(b.rf.timePoints), p: uniform(b.rf.phase).map(wrap),
        a: b.rf.amplitude, fo: b.rf.freqOffset, po: b.rf.phaseOffset, u: b.rf.use || 'u',
      };
    }
    for (const key of ['gx', 'gy', 'gz'] as const) {
      const grad = b[key];
      if (!grad) continue;
      const display = downsampleM4(grad.timePoints, grad.waveform, MAX_DISPLAY_PTS);
      o[key] = {
        s: grad.startTime, d: grad.duration, t: display.time, w: display.values,
        a: grad.amplitude, ty: grad.type, ch: grad.channel,
      };
    }
    if (b.adc) {
      o.adc = {
        s: b.adc.startTime, n: b.adc.numSamples, dw: b.adc.dwell,
        d: b.adc.delay, fo: b.adc.freqOffset, po: b.adc.phaseOffset,
      };
    }
    return o;
  });
}

function unpackViaTransport(api: RenderApi, blocks: DecodedBlock[]): Array<Record<string, any>> {
  const packed = packBlocks(blocks);
  expect(packed.pointsPerWaveform).toBe(MAX_DISPLAY_PTS);
  return api.unpackSequenceBlocks(
    JSON.parse(JSON.stringify(packed.blocks)),
    packed.sampleTimes,
    packed.sampleValues,
    packed.sampleCount,
  );
}

describe.each(['epi.seq', 'writeSpiral.seq', 'writeTSE.seq'])('renderer over packed blocks (%s)', (fixture) => {
  it('builds an identical waveform overview from typed-array views', () => {
    const api = loadRenderApi();
    const blocks = loadBlocks(fixture);
    const packedView = api.createWaveformOverview(unpackViaTransport(api, blocks));
    const inlineView = api.createWaveformOverview(serializeInline(blocks));

    expect(packedView.blockCount).toBe(inlineView.blockCount);
    expect(packedView.levels.length).toBe(inlineView.levels.length);

    for (const key of ['rf', 'phase', 'gx', 'gy', 'gz', 'adc']) {
      expect(Array.from(packedView.pointPrefix[key] as Float64Array))
        .toEqual(Array.from(inlineView.pointPrefix[key] as Float64Array));
    }

    // Amplitudes are Float32 on the wire, so envelopes match to that precision.
    const base = packedView.levels[0];
    const reference = inlineView.levels[0];
    for (const key of ['t0', 't1', 'rfStart', 'rfEnd', 'gxStart', 'gxEnd', 'adcStart', 'adcEnd']) {
      expect(Array.from(base[key] as Float64Array)).toEqual(Array.from(reference[key] as Float64Array));
    }
    for (const key of ['rfMin', 'rfMax', 'gxMin', 'gxMax', 'gyMin', 'gyMax', 'gzMin', 'gzMax']) {
      const packedValues = base[key] as Float64Array;
      const inlineValues = reference[key] as Float64Array;
      expect(packedValues.length).toBe(inlineValues.length);
      for (let index = 0; index < packedValues.length; index++) {
        if (!Number.isFinite(inlineValues[index])) {
          expect(Number.isFinite(packedValues[index])).toBe(Number.isFinite(inlineValues[index]));
          continue;
        }
        const tolerance = Math.max(1e-9, Math.abs(inlineValues[index]) * 1e-6);
        expect(Math.abs(packedValues[index] - inlineValues[index])).toBeLessThan(tolerance);
      }
    }
  });

  it('emits the same visible point counts and level selection', () => {
    const api = loadRenderApi();
    const blocks = loadBlocks(fixture);
    const packedView = api.createWaveformOverview(unpackViaTransport(api, blocks));
    const inlineView = api.createWaveformOverview(serializeInline(blocks));

    for (const key of ['rf', 'phase', 'gx', 'gy', 'gz', 'adc']) {
      expect(api.waveformVisiblePointCount(packedView, key, 0, blocks.length))
        .toBe(api.waveformVisiblePointCount(inlineView, key, 0, blocks.length));
    }
    for (const buckets of [16, 96, 512]) {
      const packedSelection = api.selectWaveformOverview(packedView, 0, blocks.length, buckets);
      const inlineSelection = api.selectWaveformOverview(inlineView, 0, blocks.length, buckets);
      // Compare the selection, not the level's amplitude arrays: those hold the
      // Float32 values the wire carries and differ in the last few bits.
      expect(packedSelection.first).toBe(inlineSelection.first);
      expect(packedSelection.last).toBe(inlineSelection.last);
      expect((packedSelection as any).level.count).toBe((inlineSelection as any).level.count);
      expect((packedSelection as any).level.bucketSize).toBe((inlineSelection as any).level.bucketSize);
    }
  });

  it('walks gradient waveforms to the same reduced point count', () => {
    const api = loadRenderApi();
    const blocks = loadBlocks(fixture);
    const packed = unpackViaTransport(api, blocks);
    const inline = serializeInline(blocks);

    let compared = 0;
    for (let index = 0; index < blocks.length; index++) {
      for (const key of ['gx', 'gy', 'gz'] as const) {
        const fromPacked = packed[index][key];
        const fromInline = inline[index][key];
        expect(!!fromPacked).toBe(!!fromInline);
        if (!fromPacked) continue;

        for (const budget of [8, 64, 4096]) {
          const packedTimes: number[] = [];
          const inlineTimes: number[] = [];
          const packedCount = api.forEachWaveformPoint(
            fromPacked.t, fromPacked.w, budget, t => packedTimes.push(t),
          );
          const inlineCount = api.forEachWaveformPoint(
            fromInline.t, fromInline.w, budget, t => inlineTimes.push(t),
          );
          expect(packedCount).toBe(inlineCount);
          expect(packedTimes).toEqual(inlineTimes);
        }
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(0);
  });

  it('bins RF events identically', () => {
    const api = loadRenderApi();
    const blocks = loadBlocks(fixture);
    const packedEvents = api.createWaveformOverview(unpackViaTransport(api, blocks)).rfEvents;
    const inlineEvents = api.createWaveformOverview(serializeInline(blocks)).rfEvents;

    expect(packedEvents.count).toBe(inlineEvents.count);
    const duration = blocks.length
      ? blocks[blocks.length - 1].startTime + blocks[blocks.length - 1].duration
      : 1;
    const packedBins = api.binRfEvents(packedEvents, 0, duration, 512, 3);
    const inlineBins = api.binRfEvents(inlineEvents, 0, duration, 512, 3);

    expect(Array.from(packedBins.events as Uint32Array)).toEqual(Array.from(inlineBins.events as Uint32Array));
    expect(packedBins.wide).toEqual(inlineBins.wide);
    expect(Array.from(packedBins.occupiedStart as Float64Array))
      .toEqual(Array.from(inlineBins.occupiedStart as Float64Array));
    for (let index = 0; index < packedBins.peak.length; index++) {
      const tolerance = Math.max(1e-9, Math.abs(inlineBins.peak[index]) * 1e-6);
      expect(Math.abs(packedBins.peak[index] - inlineBins.peak[index])).toBeLessThan(tolerance);
    }
  });
});
