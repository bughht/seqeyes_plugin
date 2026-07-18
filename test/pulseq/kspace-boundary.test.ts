import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { decodeAllBlocks, getTotalDuration } from '../../src/pulseq/decoder';
import { calculateKspace } from '../../src/pulseq/kspace';
import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';
import type { DecodedBlock, DecodedGradWaveform } from '../../src/pulseq/types';

describe('k-space gradient boundary equivalence', () => {
  it('preserves repeated narrow arbitrary-gradient areas despite accumulated time drift', () => {
    const raster = 10e-6;
    const duration = 480e-6;
    const amplitude = -100_000;
    const blockCount = 64;
    for (const [channel, axis] of [['gx', 0], ['gy', 1], ['gz', 2]] as const) {
      const blocks: DecodedBlock[] = [];
      let start = 0;

      for (let index = 0; index < blockCount; index++) {
        const activeGradient = gradient(channel, [
          start,
          start + raster,
          start + 3 * raster,
          start + 45 * raster,
          start + 47 * raster,
          start + 48 * raster,
        ], [amplitude, amplitude, 0, 0, amplitude, amplitude]);
        blocks.push(block(index + 1, start, duration, activeGradient));
        start += duration;
      }

      const result = calculateKspace(blocks, raster, start, 0, { gradientSupport: 'all' });

      expect(result).not.toBeNull();
      const expectedAreaPerBlock = 4 * amplitude * raster;
      expect(result!.ktraj[axis][result!.ktraj[axis].length - 1]).toBeCloseTo(
        blockCount * expectedAreaPerBlock,
        10,
      );
    }
  });

  it('matches the frozen EPI-RS Pulseq k-space summaries for text and binary input', () => {
    const fixtureDirectory = join(__dirname, '..', '..', '..', 'bseq', 'benchmark_data', 'demo_seq_pairs');
    const expected = {
      seq: {
        first: [-124.20456885928618, 121.09379999999996, 0.0015000000007603376],
        middle: [-124.20456885928043, 0.00011200000054689685, 0.0015000000007603376],
        last: [-124.20456885927467, -124.99982400001073, 0.0015000000007603376],
        min: [-124.20456885929779, -124.99982400001073, 0.0015000000007603376],
        max: [124.20474885929583, 121.09379999999996, 0.0015000000007603376],
      },
      bseq: {
        first: [-124.20460385438966, 121.09375, 0],
        middle: [-124.20460385438976, 0, 0],
        last: [-124.2046038543906, -125, 0],
        min: [-124.2046038543907, -125, 0],
        max: [124.20460385439057, 121.09375, 0],
      },
    };

    for (const extension of ['seq', 'bseq'] as const) {
      const path = join(fixtureDirectory, `writeEpiRS.${extension}`);
      const sequence = parseSequenceBytes(readFileSync(path), path);
      const blocks = decodeAllBlocks(sequence);
      const result = calculateKspace(
        blocks,
        sequence.rasterTimes.gradientRaster,
        getTotalDuration(sequence),
        0,
        { rfRaster: sequence.rasterTimes.rfRaster, gradientSupport: 'all' },
      );
      expect(result).not.toBeNull();
      const summary = summarize(result!);
      for (const field of Object.keys(expected[extension]) as Array<keyof typeof expected.seq>) {
        summary[field].forEach((value, axis) => {
          expect(Math.abs(value - expected[extension][field][axis])).toBeLessThanOrEqual(1e-5);
        });
      }
    }
  });
});

function summarize(result: NonNullable<ReturnType<typeof calculateKspace>>) {
  const count = result.t_adc.length;
  const middle = Math.floor((count - 1) / 2);
  const vector = (index: number) => result.ktraj_adc.map(axis => axis[index]);
  const bounds = (mode: 'min' | 'max') => result.ktraj_adc.map(axis => (
    mode === 'min' ? Math.min(...axis) : Math.max(...axis)
  ));
  return {
    first: vector(0),
    middle: vector(middle),
    last: vector(count - 1),
    min: bounds('min'),
    max: bounds('max'),
  };
}

function block(
  index: number,
  startTime: number,
  duration: number,
  activeGradient: DecodedGradWaveform,
): DecodedBlock {
  return {
    index,
    startTime,
    duration,
    gx: activeGradient.channel === 'gx' ? activeGradient : zeroGradient('gx', startTime, duration),
    gy: activeGradient.channel === 'gy' ? activeGradient : zeroGradient('gy', startTime, duration),
    gz: activeGradient.channel === 'gz' ? activeGradient : zeroGradient('gz', startTime, duration),
  };
}

function gradient(
  channel: 'gx' | 'gy' | 'gz',
  times: number[],
  values: number[],
): DecodedGradWaveform {
  return {
    blockIndex: 1,
    startTime: times[0],
    duration: times[times.length - 1] - times[0],
    timePoints: new Float64Array(times),
    waveform: new Float64Array(values),
    amplitude: Math.max(...values.map(Math.abs)),
    type: 'arb',
    channel,
  };
}

function zeroGradient(
  channel: 'gx' | 'gy' | 'gz',
  startTime: number,
  duration: number,
): DecodedGradWaveform {
  return {
    blockIndex: 0,
    startTime,
    duration,
    timePoints: new Float64Array([startTime, startTime + duration]),
    waveform: new Float64Array([0, 0]),
    amplitude: 0,
    type: 'none',
    channel,
  };
}
