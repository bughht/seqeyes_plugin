import { describe, expect, it } from 'vitest';

import { estimateEnvelopeJsonBytes, MAX_DISPLAY_PTS, packBlocks } from '../../src/editor/blockTransport';
import { INTERACTIVE_COMPUTE_LIMITS } from '../../src/pulseq/computeBudget';
import { downsampleM4 } from '../../src/pulseq/displayDownsampling';
import type { DecodedBlock } from '../../src/pulseq/types';
import {
    inlineJsonBytes,
    loadBlocks,
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
        checkedRf++;
      }

      for (const key of ['gx', 'gy', 'gz'] as const) {
        const grad = source[key];
        if (!grad) continue;
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
