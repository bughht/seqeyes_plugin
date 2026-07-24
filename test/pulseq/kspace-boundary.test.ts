import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { decodeAllBlocks, getTotalDuration } from '../../src/pulseq/decoder';
import { calculateKspace } from '../../src/pulseq/kspace';
import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';
import type { DecodedBlock, DecodedGradWaveform } from '../../src/pulseq/types';

describe('k-space gradient boundary equivalence', () => {
  it('preserves one-sided support across a zero-gradient gap', () => {
    const raster = 10e-6;
    const first = gradient('gx', [0, 10e-6], [100_000, 100_000]);
    const second = gradient('gx', [40e-6, 50e-6, 60e-6], [200_000, 200_000, 0]);
    const blocks = [
      block(1, 0, 20e-6, first),
      block(2, 20e-6, 20e-6, zeroGradient('gx', 20e-6, 20e-6)),
      block(3, 40e-6, 20e-6, second),
    ];

    for (const gradientSupport of ['endpoints', 'all'] as const) {
      const result = calculateKspace(blocks, raster, 60e-6, 0, { gradientSupport });

      expect(result).not.toBeNull();
      // Pulseq inserts a half-raster ramp to/from zero around the gap:
      // 1.0 + 0.25 + 0.5 + 2.0 + 1.0 = 4.75 1/m.
      expect(result!.ktraj[0][result!.ktraj[0].length - 1]).toBeCloseTo(4.75, 12);
    }
  });

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
    const fixtureDirectory = join(__dirname, 'binary');
    const expected = {
      seq: {
        first: [217.5685765514701, 0, 0.0017550000020492007],
        middle: [-217.56727655184918, -218.181510003301, 0.0017550001284689642],
        last: [-217.56727655181325, -218.1815100216362, 0.0017549972762935795],
        min: [-217.5672765523617, -218.1815100216362, 0.0017549972762935795],
        max: [217.56857655221708, 213.6362400000081, 0.0017550001284689642],
      },
      bseq: {
        first: [217.56800920598332, 0, 5.9117155615240335e-12],
        middle: [-217.5680092063631, -218.18181818511997, 1.446096575818956e-10],
        last: [-217.56800920631972, -218.1818182034574, -2.684828359633684e-9],
        min: [-217.56800920687192, -218.1818182034574, -2.684828359633684e-9],
        max: [217.568009206729, 213.63636363637116, 1.446096575818956e-10],
      },
    };

    for (const extension of ['seq', 'bseq'] as const) {
      const path = join(fixtureDirectory, `epi_rs.${extension}`);
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

  it('matches Pulseq MATLAB summaries for HASTE and TSE in both calculation modes', () => {
    const fixtureDirectory = join(__dirname, '..', 'seqeyes_demo_seq_files');
    const expected = {
      writeHASTE: {
        first: [-247.27493243718664, -31.250016000000009, 0.00048051200110421632],
        middle: [247.27492400502524, 105.46876800000217, -0.00062707635515835136],
        last: [247.2749240052508, 246.0931199999998, -0.00062707738834433258],
      },
      writeTSE: {
        first: [-496.49543173346319, -468.75024000003515, 0.00048051215708255768],
        middle: [496.49547748774057, 496.09439999957812, -0.00062707520555704832],
        last: [496.49547752237413, -472.65696000076423, -0.00062715122476220131],
      },
    };

    for (const id of Object.keys(expected) as Array<keyof typeof expected>) {
      const path = join(fixtureDirectory, `${id}.seq`);
      const sequence = parseSequenceBytes(readFileSync(path), path);
      const blocks = decodeAllBlocks(sequence);
      for (const gradientSupport of ['endpoints', 'all'] as const) {
        const result = calculateKspace(
          blocks,
          sequence.rasterTimes.gradientRaster,
          getTotalDuration(sequence),
          0,
          { rfRaster: sequence.rasterTimes.rfRaster, gradientSupport },
        );
        expect(result).not.toBeNull();
        const summary = summarizeCheckpoints(result!);
        for (const field of ['first', 'middle', 'last'] as const) {
          summary[field].forEach((value, axis) => {
            expect(
              Math.abs(value - expected[id][field][axis]),
              `${id} ${gradientSupport} ${field} axis ${axis}`,
            ).toBeLessThanOrEqual(1e-5);
          });
        }
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

function summarizeCheckpoints(result: NonNullable<ReturnType<typeof calculateKspace>>) {
  const count = result.t_adc.length;
  const middle = Math.floor((count - 1) / 2);
  const vector = (index: number) => result.ktraj_adc.map(axis => axis[index]);
  return {
    first: vector(0),
    middle: vector(middle),
    last: vector(count - 1),
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
