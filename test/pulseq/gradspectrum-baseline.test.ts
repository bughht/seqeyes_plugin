import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { decodeAllBlocks, getTotalDuration } from '../../src/pulseq/decoder';
import { computeGradientSpectrogram, computeGradSpectrumParity } from '../../src/pulseq/gradSpectrum';
import { parseSequenceText } from '../../src/pulseq/reader';

interface BaselineCase {
  id: string;
  description: string;
  sequencePath: string;
  baselinePath: string;
  sequenceSha256: string;
  fMaxHz: number;
  oversample: number;
  windowSamples: number;
  thresholds: { relative: number };
}

const baselineDir = join(__dirname, '..', 'gradspectrum_baselines');
const cases = JSON.parse(readFileSync(join(baselineDir, 'cases.json'), 'utf8')) as BaselineCase[];

describe('gradSpectrum MATLAB parity baselines', () => {
  it('lists the cases the parity path is validated against', () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.map(testCase => testCase.id)).toContain('v151_gre');
    expect(cases.map(testCase => testCase.id)).toContain('v151_spiral');
  });

  it.each(cases)('keeps the $id fixture byte-identical', (testCase) => {
    // Hashed over LF-normalised text so the guard holds on a Windows checkout
    // with core.autocrlf=true.
    const text = readFixture(testCase.sequencePath);
    expect(sha256Hex(text), `${testCase.id} sequence fixture changed`).toBe(testCase.sequenceSha256);
  });

  it.each(cases)('computes a finite upstream-shaped parity spectrum for $id', (testCase) => {
    const parity = runParity(testCase);

    expect(parity.segments).toBeGreaterThan(0);
    expect(parity.frequencyHz.length).toBeGreaterThan(1);
    expect(parity.rss.length).toBe(parity.frequencyHz.length);
    expect(parity.frequencyHz[0]).toBe(0);
    expect(parity.frequencyHz[parity.frequencyHz.length - 1]).toBeLessThanOrEqual(testCase.fMaxHz);

    for (let i = 0; i < parity.rss.length; i++) {
      expect(Number.isFinite(parity.rss[i])).toBe(true);
      expect(parity.rss[i]).toBeGreaterThanOrEqual(0);
      // The combined trace is the root-sum-of-squares upstream reports as R.
      const expected = Math.hypot(parity.gx[i], parity.gy[i], parity.gz[i]);
      expect(parity.rss[i]).toBeCloseTo(expected, 6);
    }

    // Something must be above the noise floor, or the comparison is vacuous.
    expect(Math.max(...Array.from(parity.rss))).toBeGreaterThan(0);
  });

  it.each(cases)('matches the MATLAB gradSpectrum baseline for $id', (testCase) => {
    const baselineFile = join(baselineDir, testCase.baselinePath);
    if (!existsSync(baselineFile)) {
      // Generating these needs MATLAB with the pulseq toolbox, which CI does
      // not have. The invariants above still run on every case; see
      // test/gradspectrum_baselines/README.md for the generation procedure.
      console.warn(
        `[gradSpectrum baselines] ${testCase.id}: no MATLAB baseline vendored yet `
        + `(${testCase.baselinePath}); see test/gradspectrum_baselines/README.md.`,
      );
      return;
    }

    const baseline = parseBaseline(readFileSync(baselineFile, 'utf8'));
    const parity = runParity(testCase);

    expect(baseline.frequencyHz.length).toBe(parity.frequencyHz.length);
    for (let i = 0; i < baseline.frequencyHz.length; i++) {
      expect(parity.frequencyHz[i]).toBeCloseTo(baseline.frequencyHz[i], 6);
    }

    const tolerance = testCase.thresholds.relative;
    const scale = Math.max(...baseline.rss);
    for (const key of ['gx', 'gy', 'gz', 'rss'] as const) {
      for (let i = 0; i < baseline[key].length; i++) {
        const reference = baseline[key][i];
        const actual = parity[key][i];
        const denominator = Math.max(Math.abs(reference), scale * 1e-6);
        expect(
          Math.abs(actual - reference) / denominator,
          `${testCase.id} ${key} bin ${i} (${baseline.frequencyHz[i].toFixed(1)} Hz)`,
        ).toBeLessThan(tolerance);
      }
    }
  });
});

describe('sequences shorter than the upstream analysis window', () => {
  // writeEpiRS.seq is a 42.7 ms single-shot EPI — shorter than the 50 ms
  // window gradSpectrum.m fixes at nwin = 5000, so upstream produces no
  // segments at all for it. The SeqEyes path derives its window from the
  // view instead, which is the whole reason it exists, so it still returns a
  // real time × frequency matrix. Asserting both sides of that is worth more
  // than a parity baseline this fixture cannot have.
  const sequence = parseSequenceText(readFixture('v151_epi_rs/seq/writeEpiRS.seq'));
  const blocks = decodeAllBlocks(sequence);
  const raster = sequence.rasterTimes.gradientRaster;
  const duration = getTotalDuration(sequence);

  it('is shorter than the 50 ms window upstream fixes', () => {
    expect(duration).toBeGreaterThan(0);
    expect(duration).toBeLessThan(5000 * raster);
  });

  it('yields no segments on the upstream parity path', () => {
    const parity = computeGradSpectrumParity(blocks, raster, duration, { fMaxHz: 3000 });
    expect(parity.segments).toBe(0);
    expect(Math.max(...Array.from(parity.rss))).toBe(0);
  });

  it('still produces a populated spectrogram on the SeqEyes path', () => {
    const spec = computeGradientSpectrogram(blocks, raster, {
      startSec: 0,
      endSec: duration,
      fMaxHz: 3000,
    });

    expect(spec.nTime).toBeGreaterThan(1);
    expect(spec.nFreq).toBeGreaterThan(1);
    expect(spec.maxValue).toBeGreaterThan(0);
    // The auto rule keeps at least ~3 windows in view, down to its 32-sample floor.
    const floorSec = 32 * raster * spec.decimationFactor;
    expect(spec.dtResolutionSec).toBeLessThanOrEqual(Math.max(duration / 3, floorSec) + 1e-9);
    for (const value of spec.data.rss) expect(Number.isFinite(value)).toBe(true);
  });
});

function runParity(testCase: BaselineCase) {
  const sequence = parseSequenceText(readFixture(testCase.sequencePath));
  const blocks = decodeAllBlocks(sequence);
  return computeGradSpectrumParity(
    blocks,
    sequence.rasterTimes.gradientRaster,
    getTotalDuration(sequence),
    {
      fMaxHz: testCase.fMaxHz,
      oversample: testCase.oversample,
      windowSamples: testCase.windowSamples,
    },
  );
}

interface ParsedBaseline {
  frequencyHz: number[];
  gx: number[];
  gy: number[];
  gz: number[];
  rss: number[];
}

function parseBaseline(text: string): ParsedBaseline {
  const out: ParsedBaseline = { frequencyHz: [], gx: [], gy: [], gz: [], rss: [] };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/).map(Number);
    if (parts.length < 5 || parts.some(value => !Number.isFinite(value))) continue;
    out.frequencyHz.push(parts[0]);
    out.gx.push(parts[1]);
    out.gy.push(parts[2]);
    out.gz.push(parts[3]);
    out.rss.push(parts[4]);
  }
  if (!out.frequencyHz.length) throw new Error('Baseline file contained no numeric rows.');
  return out;
}

function readFixture(relativePath: string): string {
  return readFileSync(join(baselineDir, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
