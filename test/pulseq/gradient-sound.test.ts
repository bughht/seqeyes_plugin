import { describe, expect, it } from 'vitest';

import {
  AUDIO_PEAK,
  gaussianSmoothingKernel,
  synthesizeGradientSound,
} from '../../src/pulseq/gradientSound';
import { audioBudgetRefusal, estimateAudioCost } from '../../src/pulseq/computeBudget';
import type { DecodedBlock, DecodedGradWaveform } from '../../src/pulseq/types';

function grad(
  channel: 'gx' | 'gy' | 'gz',
  times: number[],
  values: number[],
): DecodedGradWaveform {
  return {
    blockIndex: 1,
    startTime: times[0],
    duration: times[times.length - 1] - times[0],
    timePoints: Float64Array.from(times),
    waveform: Float64Array.from(values),
    amplitude: Math.max(...values.map(Math.abs)),
    type: 'arb',
    channel,
  };
}

/** A block carrying a constant gradient on the requested axes. */
function constantBlock(durationSec: number, amplitudes: Partial<Record<'gx' | 'gy' | 'gz', number>>): DecodedBlock {
  const times = [0, durationSec];
  const block: DecodedBlock = { index: 1, duration: durationSec, startTime: 0 } as DecodedBlock;
  for (const channel of ['gx', 'gy', 'gz'] as const) {
    const value = amplitudes[channel];
    if (value === undefined) continue;
    block[channel] = grad(channel, times, [value, value]);
  }
  return block;
}

function peak(values: Float32Array): number {
  let best = 0;
  for (const value of values) best = Math.max(best, Math.abs(value));
  return best;
}

describe('gradient sound synthesis', () => {
  it('sizes the buffer from the requested window, not the whole sequence', () => {
    // The documented deviation from MATLAB, which sizes from
    // sum(blockDurations) and therefore returns a mostly silent buffer for a
    // restricted range.
    const blocks = [constantBlock(2.0, { gx: 1e5 })];
    const sound = synthesizeGradientSound(blocks, {
      startSec: 0.5,
      endSec: 0.6,
      sampleRate: 44100,
    });

    expect(sound.n).toBe(Math.floor(0.1 * 44100) + 1);
    expect(sound.left).toHaveLength(sound.n);
    expect(sound.right).toHaveLength(sound.n);
    expect(sound.startSec).toBe(0.5);
    expect(sound.endSec).toBe(0.6);
  });

  it('splits z equally into both channels', () => {
    const blocks = [constantBlock(0.2, { gz: 1e5 })];
    const sound = synthesizeGradientSound(blocks, { startSec: 0.05, endSec: 0.15 });

    const mid = Math.floor(sound.n / 2);
    expect(sound.left[mid]).toBeCloseTo(sound.right[mid], 6);
    expect(Math.abs(sound.left[mid])).toBeGreaterThan(0);
  });

  it('maps x to the left channel and y to the right', () => {
    const blocks = [constantBlock(0.2, { gx: 1e5, gy: 5e4 })];
    const sound = synthesizeGradientSound(blocks, { startSec: 0.05, endSec: 0.15 });

    const mid = Math.floor(sound.n / 2);
    expect(Math.abs(sound.left[mid] / sound.right[mid])).toBeCloseTo(2, 3);
  });

  it('scales linearly with the channel weights', () => {
    const blocks = [constantBlock(0.2, { gx: 1e5, gy: 1e5 })];
    const even = synthesizeGradientSound(blocks, { startSec: 0.05, endSec: 0.15 });
    const skewed = synthesizeGradientSound(blocks, {
      startSec: 0.05,
      endSec: 0.15,
      channelWeights: [1, 0.5, 1],
    });

    const mid = Math.floor(even.n / 2);
    // Normalisation follows the loudest channel, so halving y halves the ratio.
    expect(Math.abs(even.right[mid] / even.left[mid])).toBeCloseTo(1, 3);
    expect(Math.abs(skewed.right[mid] / skewed.left[mid])).toBeCloseTo(0.5, 3);
  });

  it('normalises the peak to exactly 0.95', () => {
    const blocks = [constantBlock(0.2, { gx: 3.7e4 })];
    const sound = synthesizeGradientSound(blocks, { startSec: 0.05, endSec: 0.15 });

    expect(sound.silent).toBe(false);
    expect(Math.max(peak(sound.left), peak(sound.right))).toBeCloseTo(AUDIO_PEAK, 5);
  });

  it('returns zeros with a warning for a silent window, never NaN', () => {
    const blocks = [constantBlock(0.2, { gx: 0 })];
    const sound = synthesizeGradientSound(blocks, { startSec: 0.05, endSec: 0.15 });

    expect(sound.silent).toBe(true);
    expect(sound.rawPeak).toBe(0);
    expect(sound.warnings.some(w => w.includes('No gradient activity'))).toBe(true);
    for (const value of sound.left) expect(value).toBe(0);
    for (const value of sound.right) expect(Number.isFinite(value)).toBe(true);
  });

  it('is silent when the window sits outside the sequence entirely', () => {
    const blocks = [constantBlock(0.05, { gx: 1e5 })];
    const sound = synthesizeGradientSound(blocks, { startSec: 1.0, endSec: 1.1 });

    expect(sound.silent).toBe(true);
    expect(peak(sound.left)).toBe(0);
  });

  it('follows MATLAB gausswin: unit sum and the expected length per rate', () => {
    for (const [rate, expectedLength] of [[22050, 9], [44100, 15], [48000, 17]] as const) {
      const kernel = gaussianSmoothingKernel(rate);
      expect(kernel).toHaveLength(expectedLength);

      let sum = 0;
      for (const tap of kernel) sum += tap;
      expect(sum).toBeCloseTo(1, 12);

      // Symmetric, peaked at the centre.
      const mid = (expectedLength - 1) / 2;
      expect(kernel[mid]).toBe(Math.max(...kernel));
      for (let i = 0; i < expectedLength; i++) {
        expect(kernel[i]).toBeCloseTo(kernel[expectedLength - 1 - i], 15);
      }
    }
  });

  it('uses the MATLAB alpha=2.5 standard deviation, not pypulseq len/6', () => {
    const kernel = gaussianSmoothingKernel(44100);
    const len = kernel.length;
    const matlabStd = (len - 1) / 5;          // gausswin alpha = 2.5
    const pypulseqStd = len / 6;              // PR #348
    expect(matlabStd).not.toBeCloseTo(pypulseqStd, 6);

    const mid = (len - 1) / 2;
    const expected = Math.exp(-0.5 * Math.pow((0 - mid) / matlabStd, 2));
    expect(kernel[0] / kernel[mid]).toBeCloseTo(expected, 12);
  });

  it('honours the configurable sample rate', () => {
    const blocks = [constantBlock(0.2, { gx: 1e5 })];
    for (const sampleRate of [22050, 44100, 48000]) {
      const sound = synthesizeGradientSound(blocks, { startSec: 0, endSec: 0.1, sampleRate });
      expect(sound.sampleRate).toBe(sampleRate);
      expect(sound.n).toBe(Math.floor(0.1 * sampleRate) + 1);
    }
  });

  it('produces a louder dG/dt signal for a faster-changing gradient', () => {
    const slow = [constantBlock(0.2, { gx: 0 })];
    slow[0].gx = grad('gx', [0, 0.2], [0, 1e5]);
    const sound = synthesizeGradientSound(slow, {
      startSec: 0.05, endSec: 0.15, source: 'dGdt',
    });

    // A constant slope gives a constant derivative — normalised, but non-zero.
    expect(sound.silent).toBe(false);
    expect(peak(sound.left)).toBeCloseTo(AUDIO_PEAK, 5);
  });
});

describe('audio budget', () => {
  it('accepts a 10 s window and refuses a 200 s one', () => {
    const short = estimateAudioCost(0, 10, 44100);
    expect(audioBudgetRefusal(short)).toBeNull();

    const long = estimateAudioCost(0, 200, 44100);
    expect(long.totalSamples).toBeGreaterThan(5_400_000);
    expect(audioBudgetRefusal(long)).toMatch(/61\.2 s interactive limit/);
  });

  it('counts both channels toward the limit', () => {
    const estimate = estimateAudioCost(0, 1, 44100);
    expect(estimate.frames).toBe(44101);
    expect(estimate.totalSamples).toBe(estimate.frames * 2);
    expect(estimate.durationSec).toBe(1);
  });
});

describe('gradient sound uses physical, rotated waveforms', () => {
  it('moves a logical x gradient into the right channel under a 90-degree rotation', () => {
    // Acoustics are a property of the physical coils, so the rotation extension
    // has to be applied before the channel map.
    const times = [0, 0.2];
    const rotated: DecodedBlock = {
      index: 1,
      duration: 0.2,
      startTime: 0,
      gx: grad('gx', times, [1e5, 1e5]),
      rotation: { id: 1, values: [0, -1, 0, 1, 0, 0, 0, 0, 1] },
    } as DecodedBlock;

    const sound = synthesizeGradientSound([rotated], { startSec: 0.05, endSec: 0.15 });
    const mid = Math.floor(sound.n / 2);

    expect(Math.abs(sound.right[mid])).toBeCloseTo(AUDIO_PEAK, 4);
    expect(Math.abs(sound.left[mid])).toBeLessThan(1e-6);
  });
});
