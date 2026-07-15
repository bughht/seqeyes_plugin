import { describe, expect, it } from 'vitest';

import { calculateM1, calculateM1Coarse } from '../../src/pulseq/m1';
import { calculatePns, calculatePnsCoarse, parsePnsHardwareAsc, safePnsModel } from '../../src/pulseq/pns';
import { selectM1WindowBlocks, selectPnsWindowBlocks } from '../../src/pulseq/derivedWindow';
import type { DecodedBlock, DecodedGradWaveform } from '../../src/pulseq/types';

describe('M1 calculation', () => {
  it('integrates a constant gradient about the RF-centered reference by default', () => {
    const blocks = [
      block(1, 0, 0.2, grad('gx', [0, 0.2], [100, 100])),
    ];

    const result = calculateM1(blocks, 0.1);

    expect(result.valid).toBe(true);
    expect(result.referenceMode).toBe('rfCenter');
    expect(Array.from(result.tSec)).toEqual([0, 0.1, 0.2]);
    expect(result.m1x[0]).toBeCloseTo(0, 12);
    expect(result.m1x[1]).toBeCloseTo(0.5, 12);
    expect(result.m1x[2]).toBeCloseTo(2.0, 12);
    expect(result.m1y[2]).toBeCloseTo(0, 12);
    expect(result.warnings.some(warning => warning.includes('No excitation RF events'))).toBe(true);
  });

  it('keeps the observation-time convention as an explicit developer mode', () => {
    const blocks = [
      block(1, 0, 0.2, grad('gx', [0, 0.2], [100, 100])),
    ];

    const result = calculateM1(blocks, 0.1, { referenceMode: 'observationTime' });

    expect(result.valid).toBe(true);
    expect(result.referenceMode).toBe('observationTime');
    expect(Array.from(result.tSec)).toEqual([0, 0.1, 0.2]);
    expect(result.m1x[0]).toBeCloseTo(0, 12);
    expect(result.m1x[1]).toBeCloseTo(-0.5, 12);
    expect(result.m1x[2]).toBeCloseTo(-2.0, 12);
  });

  it('resets M1 at excitation RF center and flips sign at refocusing RF center', () => {
    const blocks = [
      {
        ...block(1, 0, 0.1, grad('gx', [0, 0.1], [100, 100])),
        rf: rf(1, 0.05, 'e'),
      },
      {
        ...block(2, 0.1, 0.1, grad('gx', [0.1, 0.2], [100, 100])),
        rf: rf(2, 0.15, 'r'),
      },
    ];

    const result = calculateM1(blocks, 0.05);
    const eventIndex = Array.from(result.tSec).findIndex(t => Math.abs(t - 0.05) < 1e-12);
    const refocusIndex = Array.from(result.tSec).findIndex(t => Math.abs(t - 0.15) < 1e-12);

    expect(result.valid).toBe(true);
    expect(result.referenceMode).toBe('rfCenter');
    expect(eventIndex).toBeGreaterThanOrEqual(0);
    expect(refocusIndex).toBeGreaterThanOrEqual(0);
    expect(result.m1x[eventIndex]).toBeCloseTo(0, 12);
    expect(result.m1x[refocusIndex]).toBeGreaterThan(0);
    expect(result.m1x[result.m1x.length - 1]).toBeLessThan(0);
  });

  it('streams a bounded full-sequence M1 envelope without losing extrema', () => {
    const blocks = [block(1, 0, 0.2, grad('gx', [0, 0.2], [100, 100]))];
    const exact = calculateM1(blocks, 0.01);
    const coarse = calculateM1Coarse(blocks, 0.01, { maxPoints: 1024 });

    expect(coarse.valid).toBe(true);
    expect(coarse.coarse).toBe(true);
    expect(coarse.x.startTime.length).toBeLessThanOrEqual(256);
    expect(Math.max(...Array.from(coarse.x.max))).toBeCloseTo(
      Math.max(...Array.from(exact.m1x)),
      10,
    );
  });
});

describe('PNS calculation', () => {
  it('parses Siemens-style PNS ASC hardware coefficients', () => {
    const hardware = parsePnsHardwareAsc(syntheticAsc());

    expect(hardware.valid).toBe(true);
    expect(hardware.x.tau1Ms).toBe(1);
    expect(hardware.y.a2).toBe(0.3);
    expect(hardware.z.gScale).toBe(1.2);
  });

  it('requires a combined profile when browser text contains ASC includes', () => {
    expect(() => parsePnsHardwareAsc('$include MP_GPA\n')).toThrow(/combined ASC profile/);
  });

  it('uses the SAFE low-pass model and reports percent stimulation', () => {
    const stim = safePnsModel(new Float64Array([0, 5, -10]), 1e-3, {
      tau1Ms: 0,
      tau2Ms: 0,
      tau3Ms: 0,
      a1: 1,
      a2: 0,
      a3: 0,
      stimLimit: 10,
      stimThreshold: 1,
      gScale: 1,
    });

    expect(Array.from(stim)).toEqual([0, 50, 100]);
  });

  it('calculates normalized PNS arrays from decoded gradients', () => {
    const hardware = parsePnsHardwareAsc(syntheticAsc());
    const blocks = [
      block(1, 0, 0.00004, grad('gx', [0, 0.00004], [0, 1000])),
    ];

    const result = calculatePns(blocks, 1e-5, hardware);

    expect(result.valid).toBe(true);
    expect(result.timeSec.length).toBeGreaterThan(0);
    expect(result.pnsNorm.length).toBe(result.timeSec.length);
    expect(Math.max(...Array.from(result.pnsNorm))).toBeGreaterThanOrEqual(0);
  });

  it('streams bounded PNS envelopes with the same peak as the exact path', () => {
    const hardware = parsePnsHardwareAsc(syntheticAsc());
    const blocks = [block(1, 0, 0.0002, grad('gx', [0, 0.0001, 0.0002], [0, 1000, 0]))];
    const exact = calculatePns(blocks, 1e-5, hardware);
    const coarse = calculatePnsCoarse(blocks, 1e-5, hardware, { maxPoints: 1024 });

    expect(coarse.valid).toBe(true);
    expect(coarse.norm.startTime.length).toBeLessThanOrEqual(256);
    expect(Math.max(...Array.from(coarse.norm.max))).toBeCloseTo(
      Math.max(...Array.from(exact.pnsNorm)),
      10,
    );
  });
});

describe('detailed derived windows', () => {
  it('anchors M1 at the preceding excitation and gives PNS filter warm-up history', () => {
    const hardware = parsePnsHardwareAsc(syntheticAsc());
    const blocks = [
      { ...block(1, 0, 0.1), rf: rf(1, 0.05, 'e') },
      { ...block(2, 0.1, 0.1), rf: rf(2, 0.15, 'e') },
      block(3, 0.2, 0.1),
    ];

    const m1Window = selectM1WindowBlocks(blocks, 0.16, 0.25);
    const pnsWindow = selectPnsWindowBlocks(blocks, 0.16, 0.25, hardware);

    expect(m1Window.calculationStartSec).toBeCloseTo(0.1, 12);
    expect(m1Window.blocks.map(candidate => candidate.index)).toEqual([2, 3]);
    expect(pnsWindow.calculationStartSec).toBeLessThan(0.16);
    expect(pnsWindow.blocks.at(-1)?.index).toBe(3);
  });
});

function block(
  index: number,
  startTime: number,
  duration: number,
  gx?: DecodedGradWaveform,
): DecodedBlock {
  return {
    index,
    startTime,
    duration,
    gx: gx ?? zeroGrad('gx', startTime, duration),
    gy: zeroGrad('gy', startTime, duration),
    gz: zeroGrad('gz', startTime, duration),
  };
}

function grad(channel: 'gx' | 'gy' | 'gz', times: number[], values: number[]): DecodedGradWaveform {
  return {
    blockIndex: 1,
    startTime: times[0],
    duration: times[times.length - 1] - times[0],
    timePoints: new Float64Array(times),
    waveform: new Float64Array(values),
    amplitude: Math.max(...values.map(Math.abs)),
    type: 'trap',
    channel,
  };
}

function zeroGrad(channel: 'gx' | 'gy' | 'gz', startTime: number, duration: number): DecodedGradWaveform {
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

function rf(blockIndex: number, centerTime: number, use: string): DecodedBlock['rf'] {
  return {
    blockIndex,
    startTime: centerTime,
    centerTime,
    duration: 0,
    timePoints: new Float64Array([centerTime]),
    magnitude: new Float64Array([1]),
    phase: new Float64Array([0]),
    amplitude: 1,
    freqOffset: 0,
    phaseOffset: 0,
    use,
  };
}

function syntheticAsc(): string {
  return `
GradPatSup.Phys.PNS.flGSWDTauX[0] = 1
GradPatSup.Phys.PNS.flGSWDTauX[1] = 2
GradPatSup.Phys.PNS.flGSWDTauX[2] = 3
GradPatSup.Phys.PNS.flGSWDAX[0] = 0.2
GradPatSup.Phys.PNS.flGSWDAX[1] = 0.3
GradPatSup.Phys.PNS.flGSWDAX[2] = 0.5
GradPatSup.Phys.PNS.flGSWDStimulationLimitX = 10
GradPatSup.Phys.PNS.flGSWDStimulationThresholdX = 1
asGPAParameters[0].sGCParameters.flGScaleFactorX = 1

GradPatSup.Phys.PNS.flGSWDTauY[0] = 1
GradPatSup.Phys.PNS.flGSWDTauY[1] = 2
GradPatSup.Phys.PNS.flGSWDTauY[2] = 3
GradPatSup.Phys.PNS.flGSWDAY[0] = 0.2
GradPatSup.Phys.PNS.flGSWDAY[1] = 0.3
GradPatSup.Phys.PNS.flGSWDAY[2] = 0.5
GradPatSup.Phys.PNS.flGSWDStimulationLimitY = 10
GradPatSup.Phys.PNS.flGSWDStimulationThresholdY = 1
asGPAParameters[0].sGCParameters.flGScaleFactorY = 1.1

GradPatSup.Phys.PNS.flGSWDTauZ[0] = 1
GradPatSup.Phys.PNS.flGSWDTauZ[1] = 2
GradPatSup.Phys.PNS.flGSWDTauZ[2] = 3
GradPatSup.Phys.PNS.flGSWDAZ[0] = 0.2
GradPatSup.Phys.PNS.flGSWDAZ[1] = 0.3
GradPatSup.Phys.PNS.flGSWDAZ[2] = 0.5
GradPatSup.Phys.PNS.flGSWDStimulationLimitZ = 10
GradPatSup.Phys.PNS.flGSWDStimulationThresholdZ = 1
asGPAParameters[0].sGCParameters.flGScaleFactorZ = 1.2
`;
}
