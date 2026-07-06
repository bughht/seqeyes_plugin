import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  exportKspaceArtifacts,
  exportKspaceFiles,
  formatFloat,
  formatTrajectoryText,
} from '../../src/pulseq/kspaceExport';

const fixturePath = join(__dirname, '..', 'seq', 'spiral_inout.seq');

function tinyAdcSequence(): string {
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

[BLOCKS]
1 10 0 1 0 0 1 0

[TRAP]
1 1000 10 60 10 0

[ADC]
1 4 10000 10 0 0 0 0 0
`;
}

describe('k-space export helper', () => {
  it('formats trajectory rows with three scientific-notation columns', () => {
    const text = formatTrajectoryText([
      new Float64Array([0, 1.25e-5]),
      new Float64Array([-3, -0]),
      new Float64Array([Number.NaN, 42]),
    ]);

    expect(text).toBe([
      '0.000000000000e+00 -3.000000000000e+00 NaN',
      '1.250000000000e-05 0.000000000000e+00 4.200000000000e+01',
      '',
    ].join('\n'));
  });

  it('rejects mismatched trajectory axes', () => {
    expect(() => formatTrajectoryText([
      new Float64Array([0]),
      new Float64Array([0, 1]),
      new Float64Array([0]),
    ])).toThrow(/mismatched/);
  });

  it('normalizes exponent width for stable SeqEyes-compatible text output', () => {
    expect(formatFloat(123456)).toBe('1.234560000000e+05');
    expect(formatFloat(-0)).toBe('0.000000000000e+00');
  });

  it('creates ADC trajectory text and metadata from a sequence fixture', () => {
    const sequenceText = readFileSync(fixturePath, 'utf8');
    const artifacts = exportKspaceArtifacts(sequenceText, 'spiral_inout.seq', {
      packageVersion: 'test-version',
    });
    const rows = artifacts.ktrajAdcText.trim().split('\n');

    expect(rows.length).toBe(artifacts.metadata.adcSampleCount);
    expect(artifacts.ktrajText).toBeUndefined();
    expect(artifacts.metadata.sequenceName).toBe('spiral_inout.seq');
    expect(artifacts.metadata.packageVersion).toBe('test-version');
    expect(artifacts.metadata.files.ktrajAdc).toBe('ktraj_adc.txt');
    expect(artifacts.metadata.files.ktraj).toBeUndefined();
    expect(artifacts.metadata.units.trajectory).toBe('1/m');
    expect(artifacts.metadata.adcSampleCount).toBeGreaterThan(0);
    expect(artifacts.metadata.trajectorySampleCount).toBeGreaterThan(0);
    expect(rows[0].trim().split(/\s+/)).toHaveLength(3);
  });

  it('writes ktraj_adc, optional full ktraj, and metadata files', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'seqeyes-kspace-export-'));
    try {
      const inputPath = join(workDir, 'tiny.seq');
      const outputDir = join(workDir, 'export');
      writeFileSync(inputPath, tinyAdcSequence());

      const result = exportKspaceFiles(inputPath, outputDir, {
        includeFullTrajectory: true,
        packageVersion: 'test-version',
      });
      const metadata = JSON.parse(readFileSync(result.metadataPath, 'utf8')) as {
        files: { ktrajAdc: string; ktraj?: string };
        adcSampleCount: number;
      };

      expect(readFileSync(result.ktrajAdcPath, 'utf8').trim().split('\n')).toHaveLength(metadata.adcSampleCount);
      expect(result.ktrajPath).toBeDefined();
      expect(readFileSync(result.ktrajPath!, 'utf8').length).toBeGreaterThan(0);
      expect(metadata.files).toEqual({ ktrajAdc: 'ktraj_adc.txt', ktraj: 'ktraj.txt' });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
