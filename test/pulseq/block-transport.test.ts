import { describe, expect, it } from 'vitest';

import {
  estimateEnvelopeJsonBytes,
  MAX_DETAIL_PTS,
  MAX_DISPLAY_PTS,
  packBlocks,
  packSequenceBlockRange,
  packSequenceBlocks,
} from '../../src/editor/blockTransport';
import { estimateKspaceCost, estimateSequenceKspaceCost, INTERACTIVE_COMPUTE_LIMITS } from '../../src/pulseq/computeBudget';
import { downsampleM4 } from '../../src/pulseq/displayDownsampling';
import type { DecodedBlock } from '../../src/pulseq/types';
import {
    inlineJsonBytes,
    loadBlocks,
    loadSequence,
    loadUnpackApi,
    transfer,
} from './blockTransportFixtures';

describe('packed block transport', () => {
  it('round-trips waveform samples through the binary buffers', () => {
    const api = loadUnpackApi();
    const blocks = loadBlocks('writeEpiRS.seq');
    const packed = packBlocks(blocks);
    const wire = transfer(packed);

    const unpacked = api.unpackSequenceBlocks(
      wire.envelope, wire.times, wire.values, packed.sampleCount,
    );

    expect(unpacked).toHaveLength(blocks.length);
    expect(packed.pointsPerWaveform).toBe(MAX_DISPLAY_PTS);

    let checkedRf = 0;
    let checkedGrad = 0;
    for (let index = 0; index < blocks.length; index++) {
      const source = blocks[index];
      const block = unpacked[index];
      expect(block.i).toBe(source.index);
      expect(block.s).toBeCloseTo(source.startTime, 12);

      if (source.rf) {
        const expected = downsampleM4(source.rf.timePoints, source.rf.magnitude, MAX_DISPLAY_PTS);
        expect(Array.from(block.rf.t as Float64Array)).toEqual(expected.time);
        expect(block.rf.m).toHaveLength(expected.values.length);
        for (let k = 0; k < expected.values.length; k++) {
          expect(block.rf.m[k]).toBeCloseTo(expected.values[k], 3);
        }
        // Phase travels uniformly sampled and pre-wrapped into [0, 2π).
        expect(block.rf.pt).toHaveLength(block.rf.p.length);
        for (let k = 0; k < block.rf.p.length; k++) {
          expect(block.rf.p[k]).toBeGreaterThanOrEqual(0);
          expect(block.rf.p[k]).toBeLessThan(2 * Math.PI + 1e-6);
        }
        expect(block.rf.a0).toBeCloseTo(source.rf.response.carrierAreaDeg, 10);
        expect(block.rf.rb).toHaveLength(source.rf.response.bands.length);
        for (let band = 0; band < block.rf.rb.length; band++) {
          expect(block.rf.rb[band][0]).toBeCloseTo(source.rf.response.bands[band].frequencyOffsetHz, 8);
          expect(block.rf.rb[band][1]).toBeCloseTo(source.rf.response.bands[band].spectralAreaDeg, 8);
          expect(block.rf.rb[band][2]).toBeCloseTo(source.rf.response.bands[band].polarFlipDeg, 8);
          expect(block.rf.rb[band][3]).toBeCloseTo(source.rf.response.bands[band].mz, 8);
        }
        checkedRf++;
      }

      for (const key of ['gx', 'gy', 'gz'] as const) {
        const grad = source[key];
        if (!grad) continue;
        if (grad.type === 'none') {
          expect(block[key]).toBeUndefined();
          continue;
        }
        const expected = downsampleM4(grad.timePoints, grad.waveform, MAX_DISPLAY_PTS);
        expect(Array.from(block[key].t as Float64Array)).toEqual(expected.time);
        expect(block[key].w).toHaveLength(expected.values.length);
        const scale = Math.max(1, Math.abs(grad.amplitude));
        for (let k = 0; k < expected.values.length; k++) {
          expect(Math.abs(block[key].w[k] - expected.values[k])).toBeLessThan(scale * 1e-6);
        }
        expect(block[key].ty).toBe(grad.type);
        checkedGrad++;
      }
    }
    expect(checkedRf).toBeGreaterThan(0);
    expect(checkedGrad).toBeGreaterThan(0);
  });

  it('chunk-packs a parsed sequence without changing its display payload', () => {
    const sequence = loadSequence('writeEpiRS.seq');
    const decoded = loadBlocks('writeEpiRS.seq');
    const eager = packBlocks(decoded);
    const chunked = packSequenceBlocks(sequence, 7);

    expect(chunked.blocks).toEqual(eager.blocks);
    expect(new Float64Array(chunked.sampleTimes)).toEqual(new Float64Array(eager.sampleTimes));
    expect(new Float32Array(chunked.sampleValues)).toEqual(new Float32Array(eager.sampleValues));
    expect(estimateSequenceKspaceCost(sequence, 0.116)).toEqual(
      estimateKspaceCost(decoded, sequence.rasterTimes.gradientRaster, 0.116),
    );
  });

  it('packs indexed viewport ranges with offsets local to the response', () => {
    const sequence = loadSequence('writeEpiRS.seq');
    const decoded = loadBlocks('writeEpiRS.seq');
    const start = 4;
    const end = Math.min(decoded.length, 17);
    const expected = packBlocks(decoded.slice(start, end));
    const detail = packSequenceBlockRange(sequence, start, end);

    expect(detail.blocks).toEqual(expected.blocks);
    expect(new Float64Array(detail.sampleTimes)).toEqual(new Float64Array(expected.sampleTimes));
    expect(new Float32Array(detail.sampleValues)).toEqual(new Float32Array(expected.sampleValues));
  });

  it('spends the point budget on the visible interval rather than the whole event', () => {
    // Long arbitrary readouts reduced as whole events keep only a handful of
    // points per millisecond, which is what made deep zoom draw straight
    // segments between distant extrema.
    const sequence = loadSequence('writeSpiral.seq');
    const decoded = loadBlocks('writeSpiral.seq');
    const index = decoded.findIndex(b => b.gx && b.gx.type !== 'none' && b.gx.timePoints.length > 2000);
    expect(index).toBeGreaterThanOrEqual(0);

    const native = decoded[index].gx!;
    const nativeStart = native.timePoints[0];
    const windowEnd = nativeStart + 0.0005;
    let nativeInWindow = 0;
    for (const t of native.timePoints) if (t >= nativeStart && t <= windowEnd) nativeInWindow++;
    expect(nativeInWindow).toBeGreaterThan(20);

    // A sample ceiling below the event's own size forces the reduced path;
    // without it the window is small enough to be delivered exactly, which is
    // the behaviour the exactness test above covers.
    const limit = 2_000;
    const whole = packSequenceBlockRange(sequence, index, index + 1, undefined, MAX_DISPLAY_PTS, limit);
    const clipped = packSequenceBlockRange(
      sequence, index, index + 1, undefined, MAX_DISPLAY_PTS, limit,
      { startSec: nativeStart, endSec: windowEnd },
    );

    const wholeTimes = new Float64Array(whole.sampleTimes);
    const clippedTimes = new Float64Array(clipped.sampleTimes);
    const inWindow = (times: Float64Array, ref: Record<string, { o: number; n: number }>) => {
      let count = 0;
      for (let i = ref.gx.o; i < ref.gx.o + ref.gx.n; i++) {
        if (times[i] >= nativeStart && times[i] <= windowEnd) count++;
      }
      return count;
    };
    const wholeRef = whole.blocks[0] as Record<string, { o: number; n: number }>;
    const clippedRef = clipped.blocks[0] as Record<string, { o: number; n: number }>;

    // The clipped pack must recover essentially all native detail in the window.
    expect(inWindow(clippedTimes, clippedRef)).toBe(nativeInWindow);
    expect(inWindow(clippedTimes, clippedRef)).toBeGreaterThan(inWindow(wholeTimes, wholeRef) * 4);
    // and it must stay smaller than the unclipped pack, not larger.
    expect(clipped.sampleCount).toBeLessThan(whole.sampleCount);
  });

  it('keeps one sample beyond each clip edge so boundary segments still draw', () => {
    const sequence = loadSequence('writeSpiral.seq');
    const decoded = loadBlocks('writeSpiral.seq');
    const index = decoded.findIndex(b => b.gx && b.gx.type !== 'none' && b.gx.timePoints.length > 2000);
    const native = decoded[index].gx!;
    const startSec = native.timePoints[100];
    const endSec = native.timePoints[140];

    const clipped = packSequenceBlockRange(
      sequence, index, index + 1, undefined, MAX_DISPLAY_PTS, undefined, { startSec, endSec },
    );
    const times = new Float64Array(clipped.sampleTimes);
    const ref = (clipped.blocks[0] as Record<string, { o: number; n: number }>).gx;

    expect(times[ref.o]).toBeCloseTo(native.timePoints[99], 12);
    expect(times[ref.o + ref.n - 1]).toBeCloseTo(native.timePoints[141], 12);
  });

  it('reproduces native sample values exactly inside a detail window', () => {
    const sequence = loadSequence('writeSpiral.seq');
    const decoded = loadBlocks('writeSpiral.seq');
    const index = decoded.findIndex(b => b.gx && b.gx.type !== 'none' && b.gx.timePoints.length > 2000);
    const native = decoded[index].gx!;
    const startSec = native.timePoints[200];
    const endSec = native.timePoints[260];

    const clipped = packSequenceBlockRange(
      sequence, index, index + 1, undefined, MAX_DISPLAY_PTS, undefined, { startSec, endSec },
    );
    const times = new Float64Array(clipped.sampleTimes);
    const values = new Float32Array(clipped.sampleValues);
    const ref = (clipped.blocks[0] as Record<string, { o: number; n: number }>).gx;

    // 62 native samples fit well inside the 500-point cap, so every one of them
    // must survive verbatim — the detail path must not resample or interpolate.
    for (let i = 0; i < ref.n; i++) {
      expect(times[ref.o + i]).toBeCloseTo(native.timePoints[199 + i], 12);
      expect(values[ref.o + i]).toBeCloseTo(Math.fround(native.waveform[199 + i]), 6);
    }
  });

  it('leaves unclipped packing byte-identical when no window is given', () => {
    const sequence = loadSequence('writeEpiRS.seq');
    const decoded = loadBlocks('writeEpiRS.seq');
    const expected = packBlocks(decoded.slice(4, 17));
    const detail = packSequenceBlockRange(sequence, 4, 17, undefined, 500, undefined, null);
    expect(detail.blocks).toEqual(expected.blocks);
    expect(new Float64Array(detail.sampleTimes)).toEqual(new Float64Array(expected.sampleTimes));
  });

  it('delivers a detail window unreduced when every sample fits the budget', () => {
    const sequence = loadSequence('writeSpiral.seq');
    const decoded = loadBlocks('writeSpiral.seq');
    const index = decoded.findIndex(b => b.gx && b.gx.type !== 'none' && b.gx.timePoints.length > 2000);
    const native = decoded[index].gx!;
    // A window wide enough that a reduction would otherwise apply: the event
    // alone carries more points than the per-waveform detail ceiling.
    expect(native.timePoints.length).toBeGreaterThan(MAX_DETAIL_PTS);
    const startSec = native.timePoints[0];
    const endSec = native.timePoints[native.timePoints.length - 1];

    const packed = packSequenceBlockRange(
      sequence, index, index + 1, undefined, MAX_DETAIL_PTS, undefined, { startSec, endSec },
    );
    const times = new Float64Array(packed.sampleTimes);
    const values = new Float32Array(packed.sampleValues);
    const ref = (packed.blocks[0] as Record<string, { o: number; n: number }>).gx;

    // Every native sample, in order, with no substitution or interpolation —
    // this is what makes a trajectory judgeable rather than merely plausible.
    expect(ref.n).toBe(native.timePoints.length);
    for (let i = 0; i < ref.n; i++) {
      expect(times[ref.o + i]).toBeCloseTo(native.timePoints[i], 12);
      expect(values[ref.o + i]).toBeCloseTo(Math.fround(native.waveform[i]), 6);
    }
  });

  it('falls back to a bounded reduction when a window cannot be sent exactly', () => {
    const sequence = loadSequence('writeSpiral.seq');
    // A one-sample exactness budget forces the reduced path for any real window.
    const packed = packSequenceBlockRange(
      sequence, 0, sequence.blocks.length, undefined, MAX_DETAIL_PTS, 1_000, null,
    );
    expect(packed.sampleCount).toBeLessThanOrEqual(1_000);
    expect(packed.pointsPerWaveform).toBeLessThanOrEqual(MAX_DETAIL_PTS);
  });

  it('refuses a viewport whose minimum detail exceeds its sample ceiling', () => {
    const sequence = loadSequence('writeEpiRS.seq');
    expect(() => packSequenceBlockRange(sequence, 0, sequence.blocks.length, undefined, 500, 1))
      .toThrow(/zoom in further/);
  });

  it('keeps waveform samples out of the JSON envelope', () => {
    const blocks = loadBlocks('epi.seq');
    const packed = packBlocks(blocks);
    const wire = transfer(packed);

    // The JSON string is what VS Code's postMessage has to build, and what V8
    // caps at 512 MiB, so the size that matters is the envelope alone.
    expect(packed.sampleCount).toBeGreaterThan(200_000);
    expect(wire.envelopeJson.length).toBeLessThan(inlineJsonBytes(blocks) / 5);
    expect(wire.envelopeJson).not.toMatch(/"[tmwp]":\[/);

    const estimated = estimateEnvelopeJsonBytes(packed.blocks);
    expect(estimated).toBeGreaterThan(wire.envelopeJson.length * 0.8);
    expect(estimated).toBeLessThan(wire.envelopeJson.length * 1.2);
  });

  it('preserves absolute time to well past Float32 precision', () => {
    const api = loadUnpackApi();
    // A gradient two minutes into a sequence, stepping on a 1 µs raster:
    // Float32 could not separate these samples at all.
    const start = 137.000001;
    const timePoints = Float64Array.from({ length: 6 }, (_, k) => start + k * 1e-6);
    const blocks = [{
      index: 1, startTime: start, duration: 6e-6,
      gx: {
        blockIndex: 1, startTime: start, duration: 6e-6,
        timePoints, waveform: Float64Array.from({ length: 6 }, (_, k) => k * 1e5),
        amplitude: 5e5, type: 'arb' as const, channel: 'gx' as const,
      },
    }] as unknown as DecodedBlock[];

    const packed = packBlocks(blocks);
    const wire = transfer(packed);
    const unpacked = api.unpackSequenceBlocks(wire.envelope, wire.times, wire.values, packed.sampleCount);

    for (let k = 0; k < timePoints.length; k++) {
      expect(unpacked[0].gx.t[k]).toBe(timePoints[k]);
    }
    expect(new Set(Array.from(unpacked[0].gx.t as Float64Array)).size).toBe(6);
  });

  it('reduces per-waveform detail instead of exceeding the transfer budget', () => {
    const budget = INTERACTIVE_COMPUTE_LIMITS.displayTransportSamples;
    // Enough dense arbitrary gradients that full detail would need ~4x budget.
    const blockCount = Math.ceil((budget * 4) / (3 * MAX_DISPLAY_PTS));
    const timePoints = Float64Array.from({ length: MAX_DISPLAY_PTS * 2 }, (_, k) => k * 1e-5);
    const waveform = Float64Array.from({ length: MAX_DISPLAY_PTS * 2 }, (_, k) => Math.sin(k));
    const template = {
      index: 1, startTime: 0, duration: 5e-3,
      gx: { blockIndex: 1, startTime: 0, duration: 5e-3, timePoints, waveform, amplitude: 1, type: 'arb', channel: 'gx' },
      gy: { blockIndex: 1, startTime: 0, duration: 5e-3, timePoints, waveform, amplitude: 1, type: 'arb', channel: 'gy' },
      gz: { blockIndex: 1, startTime: 0, duration: 5e-3, timePoints, waveform, amplitude: 1, type: 'arb', channel: 'gz' },
    };
    const blocks = new Array(blockCount).fill(template) as unknown as DecodedBlock[];

    const packed = packBlocks(blocks);

    expect(packed.sampleCount).toBeLessThanOrEqual(budget);
    expect(packed.pointsPerWaveform).toBeLessThan(MAX_DISPLAY_PTS);
    expect(packed.notice).toMatch(/waveform detail was reduced/);

    // Reduced detail still has to be drawable detail, not a stub.
    const api = loadUnpackApi();
    const wire = transfer(packed);
    const unpacked = api.unpackSequenceBlocks(wire.envelope, wire.times, wire.values, packed.sampleCount);
    expect(unpacked[0].gx.t.length).toBeGreaterThan(1);
    expect(unpacked[0].gx.t.length).toBe(unpacked[0].gx.w.length);
  });

  it('leaves ordinary sequences at full detail with no notice', () => {
    const packed = packBlocks(loadBlocks('writeSpiral.seq'));
    expect(packed.pointsPerWaveform).toBe(MAX_DISPLAY_PTS);
    expect(packed.notice).toBeNull();
  });

  it('handles a sequence with no blocks', () => {
    const api = loadUnpackApi();
    const packed = packBlocks([]);
    expect(packed.sampleCount).toBe(0);
    expect(api.unpackSequenceBlocks([], packed.sampleTimes, packed.sampleValues, 0)).toEqual([]);
  });

  it('reports missing buffers instead of drawing an empty sequence', () => {
    const api = loadUnpackApi();
    const packed = packBlocks(loadBlocks('writeFid.seq'));
    const wire = transfer(packed);

    // A host that dropped the binary transfer leaves `{}` behind.
    expect(() => api.unpackSequenceBlocks(wire.envelope, {}, {}, packed.sampleCount))
      .toThrow(/did not arrive as binary data/);
    expect(() => api.unpackSequenceBlocks(
      wire.envelope, new ArrayBuffer(8), new ArrayBuffer(4), packed.sampleCount,
    )).toThrow(/short by/);
  });

  it('accepts buffers delivered as byte views', () => {
    const api = loadUnpackApi();
    const blocks = loadBlocks('writeFid.seq');
    const packed = packBlocks(blocks);
    const wire = transfer(packed);

    const asBytes = api.unpackSequenceBlocks(
      wire.envelope,
      new Uint8Array(packed.sampleTimes),
      new Uint8Array(packed.sampleValues),
      packed.sampleCount,
    );
    expect(asBytes).toHaveLength(blocks.length);
    const rfBlock = asBytes.find(block => block.rf);
    expect(rfBlock).toBeDefined();
    expect(rfBlock!.rf.t.length).toBeGreaterThan(0);
  });
});
