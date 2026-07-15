import { describe, expect, it } from 'vitest';

import {
  estimateDerivedCost,
  estimateKspaceCost,
  formatSampleCount,
  INTERACTIVE_COMPUTE_LIMITS,
} from '../../src/pulseq/computeBudget';
import { calculateKspace } from '../../src/pulseq/kspace';
import type { DecodedBlock, DecodedGradWaveform } from '../../src/pulseq/types';

describe('interactive calculation budgets', () => {
  it('estimates native-raster and ADC work without allocating result arrays', () => {
    const blocks: DecodedBlock[] = [{
      index: 1,
      startTime: 0,
      duration: 1,
      gx: gradient([0.1, 0.9]),
      adc: {
        blockIndex: 1,
        startTime: 0,
        numSamples: 4096,
        dwell: 1e-6,
        delay: 0,
        freqOffset: 0,
        phaseOffset: 0,
      },
    }];

    expect(estimateKspaceCost(blocks, 1e-5, 1)).toEqual({
      rasterSamples: 100_001,
      adcSamples: 4096,
      gridCandidatePoints: 104_101,
    });
    expect(estimateDerivedCost(blocks, 1e-5).rasterSamples).toBe(80_001);
  });

  it('rejects oversized ADC and raster requests before proportional allocations', () => {
    const blocks: DecodedBlock[] = [{
      index: 1,
      startTime: 0,
      duration: 100,
      adc: {
        blockIndex: 1,
        startTime: 0,
        numSamples: 10_000_000,
        dwell: 1e-6,
        delay: 0,
        freqOffset: 0,
        phaseOffset: 0,
      },
    }];

    expect(calculateKspace(blocks, 1e-5, 100, 0, { maxAdcSamples: 1000 })).toBeNull();
    expect(calculateKspace(blocks, 1e-5, 100, 0, {
      maxAdcSamples: 20_000_000,
      maxGridPoints: 1000,
    })).toBeNull();
  });

  it('keeps the interactive thresholds and messages explicit', () => {
    expect(INTERACTIVE_COMPUTE_LIMITS.kspaceRasterSamples).toBeGreaterThan(
      INTERACTIVE_COMPUTE_LIMITS.derivedRasterSamples,
    );
    expect(INTERACTIVE_COMPUTE_LIMITS.kspaceGridCandidates).toBeGreaterThan(
      INTERACTIVE_COMPUTE_LIMITS.kspaceRasterSamples,
    );
    expect(formatSampleCount(9_250_001)).toBe('9.3 million');
  });
});

function gradient(times: number[]): DecodedGradWaveform {
  return {
    blockIndex: 1,
    startTime: times[0],
    duration: times[times.length - 1] - times[0],
    timePoints: new Float64Array(times),
    waveform: new Float64Array(times.map(() => 1)),
    amplitude: 1,
    type: 'arb',
    channel: 'gx',
  };
}
