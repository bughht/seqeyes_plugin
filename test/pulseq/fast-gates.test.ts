import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parseSequenceText } from '../../src/pulseq/reader';
import { decodeAllBlocks, getTotalDuration } from '../../src/pulseq/decoder';
import { calculateKspace } from '../../src/pulseq/kspace';
import { detectSequenceTiming } from '../../src/pulseq/trdetect';

const fixtureDir = join(__dirname, '..', 'seq');
const fixtureFiles = readdirSync(fixtureDir)
  .filter((name) => name.endsWith('.seq'))
  .sort();

function readSeqFixture(name: string): string {
  return readFileSync(join(fixtureDir, name), 'utf8');
}

function minimalSequence(extra = ''): string {
  return `
[VERSION]
major 1
minor 5
revision 1

[DEFINITIONS]
AdcRasterTime 1e-7
GradientRasterTime 1e-5
RadiofrequencyRasterTime 1e-6
BlockDurationRaster 1e-5
${extra}

[BLOCKS]
1 10 0 0 0 0 0 0
`;
}

function legacy110DegreeSequence(): string {
  return `
[VERSION]
major 1
minor 4
revision 0

[DEFINITIONS]
AdcRasterTime 1e-7
GradientRasterTime 1e-5
RadiofrequencyRasterTime 1e-6
BlockDurationRaster 1e-5

[BLOCKS]
1 1000 1 0 0 0 0 0
2 1000 0 0 0 0 0 0
3 1000 1 0 0 0 0 0

[RF]
1 305555.555555556 1 2 0 0 0 0

[SHAPES]
shape_id 1
num_samples 2
1
1

shape_id 2
num_samples 2
0
0
`;
}

function legacyFatSatAnchoredSequence(): string {
  return `
[VERSION]
major 1
minor 4
revision 0

[DEFINITIONS]
AdcRasterTime 1e-7
GradientRasterTime 1e-5
RadiofrequencyRasterTime 1e-6
BlockDurationRaster 1e-5

[BLOCKS]
1 1000 1 0 0 0 0 0
2 1000 2 0 0 0 0 0
3 1000 0 0 0 0 0 0
4 1000 1 0 0 0 0 0
5 1000 2 0 0 0 0 0

[RF]
1 38.1944444444444 1 2 3 0 -424.504 0
2 104.166666666667 1 2 3 0 0 0

[SHAPES]
shape_id 1
num_samples 2
1
1

shape_id 2
num_samples 2
0
0

shape_id 3
num_samples 2
0
8000
`;
}

function expectFiniteArray(values: Float64Array, label: string): void {
  expect(values.length, `${label} should not be empty`).toBeGreaterThan(0);
  const sampledValues = [
    values[0],
    values[Math.floor(values.length / 2)],
    values[values.length - 1],
  ];
  for (const value of sampledValues) {
    expect(Number.isFinite(value), `${label} contains a non-finite sampled value`).toBe(true);
  }
}

describe('Pulseq fast fixture gates', () => {
  it('has committed sequence fixtures for CI smoke coverage', () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  it.each(fixtureFiles)('parses and decodes %s', (fixtureName) => {
    const seq = parseSequenceText(readSeqFixture(fixtureName));
    const decoded = decodeAllBlocks(seq);
    const timing = detectSequenceTiming(seq);
    const totalDuration = getTotalDuration(seq);

    expect(seq.blocks.length).toBeGreaterThan(0);
    expect(decoded).toHaveLength(seq.blocks.length);
    expect(Number.isFinite(totalDuration)).toBe(true);
    expect(totalDuration).toBeGreaterThan(0);
    expect(Number.isFinite(timing.trTimeSec)).toBe(true);
    expect(timing.trStartBlocks.length).toBeGreaterThan(0);
  });

  it.each(fixtureFiles)('computes ADC k-space for %s', (fixtureName) => {
    const seq = parseSequenceText(readSeqFixture(fixtureName));
    const decoded = decodeAllBlocks(seq);
    const totalDuration = getTotalDuration(seq);
    const kspace = calculateKspace(decoded, seq.rasterTimes.gradientRaster, totalDuration);

    expect(kspace).not.toBeNull();
    expect(kspace!.ktraj).toHaveLength(3);
    expect(kspace!.ktraj_adc).toHaveLength(3);
    expect(kspace!.t_ktraj.length).toBeGreaterThan(1);
    expect(kspace!.t_adc.length).toBeGreaterThan(0);
    expect(kspace!.ktraj_adc[0]).toHaveLength(kspace!.t_adc.length);
    expect(kspace!.ktraj_adc[1]).toHaveLength(kspace!.t_adc.length);
    expect(kspace!.ktraj_adc[2]).toHaveLength(kspace!.t_adc.length);

    expectFiniteArray(kspace!.t_ktraj, 't_ktraj');
    expectFiniteArray(kspace!.t_adc, 't_adc');
    expectFiniteArray(kspace!.ktraj_adc[0], 'kx_adc');
    expectFiniteArray(kspace!.ktraj_adc[1], 'ky_adc');
    expectFiniteArray(kspace!.ktraj_adc[2], 'kz_adc');
  });

  it('classifies a legacy 110-degree RF consistently as excitation for TR and M1', () => {
    const seq = parseSequenceText(legacy110DegreeSequence());
    const timing = detectSequenceTiming(seq);
    const decoded = decodeAllBlocks(seq);
    const decodedUses = decoded.flatMap(block => block.rf ? [block.rf.use] : []);

    expect(timing.rfUseGuessed).toBe(true);
    expect(timing.excitationTimesSec).toHaveLength(2);
    expect(timing.trTimeSec).toBeCloseTo(0.02, 12);
    expect(decodedUses).toEqual(['e', 'e']);
  });

  it('uses recurring legacy fat-saturation pulses to identify phase-modulated excitations', () => {
    const seq = parseSequenceText(legacyFatSatAnchoredSequence());
    const timing = detectSequenceTiming(seq);
    const decodedUses = decodeAllBlocks(seq).flatMap(block => block.rf ? [block.rf.use] : []);

    expect(timing.excitationTimesSec).toHaveLength(2);
    expect(timing.trTimeSec).toBeCloseTo(0.03, 12);
    expect(decodedUses).toEqual(['s', 'e', 's', 'e']);
  });
});

describe('Pulseq parser edge gates', () => {
  it('accepts a minimal v1.5 sequence with required rasters', () => {
    const seq = parseSequenceText(minimalSequence());
    expect(seq.versionCombined).toBe(1_005_001);
    expect(seq.blocks).toHaveLength(1);
    expect(seq.rasterTimes.blockDurationRaster).toBe(1e-5);
  });

  it('rejects a missing VERSION section', () => {
    expect(() => parseSequenceText(`
[DEFINITIONS]
AdcRasterTime 1e-7
GradientRasterTime 1e-5
RadiofrequencyRasterTime 1e-6
BlockDurationRaster 1e-5

[BLOCKS]
1 10 0 0 0 0 0 0
`)).toThrow(/VERSION/);
  });

  it('rejects a missing BLOCKS section', () => {
    expect(() => parseSequenceText(`
[VERSION]
major 1
minor 5
revision 1

[DEFINITIONS]
AdcRasterTime 1e-7
GradientRasterTime 1e-5
RadiofrequencyRasterTime 1e-6
BlockDurationRaster 1e-5
`)).toThrow(/BLOCKS/);
  });

  it('rejects missing required raster definitions for v1.4+', () => {
    expect(() => parseSequenceText(`
[VERSION]
major 1
minor 4
revision 0

[DEFINITIONS]
AdcRasterTime 1e-7
GradientRasterTime 1e-5

[BLOCKS]
1 10 0 0 0 0 0 0
`)).toThrow(/Required definition/);
  });

  it('rejects undefined event references from blocks', () => {
    expect(() => parseSequenceText(`
[VERSION]
major 1
minor 5
revision 1

[DEFINITIONS]
AdcRasterTime 1e-7
GradientRasterTime 1e-5
RadiofrequencyRasterTime 1e-6
BlockDurationRaster 1e-5

[BLOCKS]
1 10 99 0 0 0 0 0
`)).toThrow(/undefined RF event 99/);
  });

  it('rejects unknown required extensions for v1.5.1+', () => {
    expect(() => parseSequenceText(minimalSequence('RequiredExtensions DOES_NOT_EXIST'))).toThrow(/Unknown required extension/);
  });

  it('rejects non-normalized v1.5 rotation quaternions', () => {
    expect(() => parseSequenceText(`
[VERSION]
major 1
minor 5
revision 1

[DEFINITIONS]
AdcRasterTime 1e-7
GradientRasterTime 1e-5
RadiofrequencyRasterTime 1e-6
BlockDurationRaster 1e-5

[BLOCKS]
1 10 0 0 0 0 0 0

[EXTENSIONS]
extension ROTATIONS 1
1 2 0 0 0
`)).toThrow(/non-normalized quaternion/);
  });

  it('rejects malformed compressed shapes', () => {
    expect(() => parseSequenceText(`
[VERSION]
major 1
minor 5
revision 1

[DEFINITIONS]
AdcRasterTime 1e-7
GradientRasterTime 1e-5
RadiofrequencyRasterTime 1e-6
BlockDurationRaster 1e-5

[BLOCKS]
1 10 0 0 0 0 0 0

[SHAPES]
shape_id 1
num_samples 5
1
1
0.5
`)).toThrow(/Malformed compressed shape/);
  });
});
