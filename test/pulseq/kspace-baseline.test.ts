import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { exportKspaceArtifacts } from '../../src/pulseq/kspaceExport';

interface BaselineCase {
  id: string;
  description: string;
  sequencePath: string;
  baselinePath: string;
  expectedAdcSamples: number;
  sequenceSha256: string;
  baselineSha256: string;
  thresholds: {
    maxAbs: number;
    rmse: number;
    meanAbs: number;
  };
}

interface ComparisonStats {
  maxAbs: [number, number, number];
  rmse: [number, number, number];
  mean: [number, number, number];
}

const baselineDir = join(__dirname, '..', 'kspace_baselines');
const cases = JSON.parse(readFileSync(join(baselineDir, 'cases.json'), 'utf8')) as BaselineCase[];

describe('SeqEyes k-space ADC baselines', () => {
  it('has committed v1.5 numeric baseline cases', () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((testCase) => testCase.id.startsWith('v151_'))).toBe(true);
  });

  it.each(cases)('matches SeqEyes Qt ktraj_adc baseline for $id', (testCase) => {
    const sequenceText = readFixture(testCase.sequencePath);
    const baselineText = readFixture(testCase.baselinePath);

    expect(sha256Hex(sequenceText), `${testCase.id} sequence fixture hash changed`).toBe(testCase.sequenceSha256);
    expect(sha256Hex(baselineText), `${testCase.id} baseline hash changed`).toBe(testCase.baselineSha256);

    const artifacts = exportKspaceArtifacts(sequenceText, testCase.sequencePath, {
      packageVersion: 'test-version',
      gradientSupport: 'all',
    });
    const actual = parseTrajectoryRows(artifacts.ktrajAdcText);
    const expected = parseTrajectoryRows(baselineText);
    const stats = compareTrajectory(actual, expected);

    expect(artifacts.metadata.calculation.gradientSupport).toBe('all');
    expect(artifacts.metadata.adcSampleCount).toBe(testCase.expectedAdcSamples);
    expect(actual).toHaveLength(testCase.expectedAdcSamples);
    expect(expected).toHaveLength(testCase.expectedAdcSamples);
    expect(stats.maxAbs, formatStats(testCase.id, stats)).toSatisfy((values: number[]) => (
      values.every((value) => value <= testCase.thresholds.maxAbs)
    ));
    expect(stats.rmse, formatStats(testCase.id, stats)).toSatisfy((values: number[]) => (
      values.every((value) => value <= testCase.thresholds.rmse)
    ));
    expect(stats.mean.map(Math.abs), formatStats(testCase.id, stats)).toSatisfy((values: number[]) => (
      values.every((value) => value <= testCase.thresholds.meanAbs)
    ));
  });
});

function readFixture(relativePath: string): string {
  return readFileSync(join(baselineDir, relativePath), 'utf8');
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function parseTrajectoryRows(text: string): Array<[number, number, number]> {
  return text.trim().split(/\n/).filter(Boolean).map((line) => {
    const values = line.trim().split(/\s+/).map(Number);
    if (values.length !== 3 || values.some((value) => Number.isNaN(value))) {
      throw new Error(`Invalid trajectory row: ${line}`);
    }
    return values as [number, number, number];
  });
}

function compareTrajectory(
  actual: Array<[number, number, number]>,
  expected: Array<[number, number, number]>,
): ComparisonStats {
  expect(actual).toHaveLength(expected.length);
  const maxAbs: [number, number, number] = [0, 0, 0];
  const sum: [number, number, number] = [0, 0, 0];
  const sumSquares: [number, number, number] = [0, 0, 0];

  for (let row = 0; row < actual.length; row++) {
    for (let axis = 0; axis < 3; axis++) {
      const diff = actual[row][axis] - expected[row][axis];
      maxAbs[axis] = Math.max(maxAbs[axis], Math.abs(diff));
      sum[axis] += diff;
      sumSquares[axis] += diff * diff;
    }
  }

  return {
    maxAbs,
    rmse: sumSquares.map((value) => Math.sqrt(value / actual.length)) as [number, number, number],
    mean: sum.map((value) => value / actual.length) as [number, number, number],
  };
}

function formatStats(id: string, stats: ComparisonStats): string {
  return [
    `${id} ktraj_adc mismatch`,
    `maxAbs=${stats.maxAbs.map(formatScientific).join(',')}`,
    `rmse=${stats.rmse.map(formatScientific).join(',')}`,
    `mean=${stats.mean.map(formatScientific).join(',')}`,
  ].join(' ');
}

function formatScientific(value: number): string {
  return value.toExponential(6);
}
