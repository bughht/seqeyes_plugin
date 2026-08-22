import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decodeAllBlocks, getTotalDuration } from '../../src/pulseq/decoder';
import { computeGradientSpectrogram } from '../../src/pulseq/gradSpectrum';
import { synthesizeGradientSound } from '../../src/pulseq/gradientSound';
import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';
import type { DecodedBlock } from '../../src/pulseq/types';

interface WindowReport {
  id: string;
  windowSec: number;
  columns: number;
  frequencyBins: number;
  decimationFactor: number;
  medianMs: number;
  maxMs: number;
  budgetMs: number;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const outputPath = join(repoRoot, 'performance-results', 'performance-spectrogram.json');
const iterations = 3;

const fixture = join(repoRoot, 'test', 'seq', 'spiral_inout.seq');

/**
 * Budgets from the plan's §10.4, measured on the CI baseline machine. They are
 * deliberately loose relative to the expected cost (~20-40 ms for the short
 * window) because the point is to catch an order-of-magnitude regression —
 * dropping the anti-aliased decimation, for instance, makes the same view about
 * ten times more expensive.
 */
const windows: Array<{ id: string; seconds: number; budgetMs: number }> = [
  { id: 'window_100ms', seconds: 0.1, budgetMs: 150 },
  { id: 'window_5s', seconds: 5, budgetMs: 600 },
];

describe('Spectrogram performance guard', () => {
  it('computes interactive spectrogram windows inside budget', () => {
    const bytes = readFileSync(fixture);
    const sequence = parseSequenceBytes(bytes, 'spiral_inout.seq');
    const blocks = decodeAllBlocks(sequence);
    const raster = sequence.rasterTimes.gradientRaster;
    const totalDuration = getTotalDuration(sequence);

    const reports: WindowReport[] = [];
    for (const window of windows) {
      const span = Math.min(window.seconds, totalDuration);
      const startSec = Math.max(0, (totalDuration - span) / 2);
      const endSec = startSec + span;
      const selected = selectWindowBlocks(blocks, startSec, endSec);

      // Warm-up: the first call pays for the FFT twiddle tables and the
      // decimation taps, which are then cached for the life of the process —
      // exactly as they are during a pan gesture.
      computeGradientSpectrogram(selected, raster, { startSec, endSec, fMaxHz: 3000 });

      const samples: number[] = [];
      let last = computeGradientSpectrogram(selected, raster, { startSec, endSec, fMaxHz: 3000 });
      for (let i = 0; i < iterations; i++) {
        const began = performance.now();
        last = computeGradientSpectrogram(selected, raster, { startSec, endSec, fMaxHz: 3000 });
        samples.push(performance.now() - began);
      }

      expect(last.nTime).toBeGreaterThan(0);
      expect(last.nFreq).toBeGreaterThan(0);
      expect(last.decimationFactor).toBeGreaterThan(1);

      reports.push({
        id: window.id,
        windowSec: span,
        columns: last.nTime,
        frequencyBins: last.nFreq,
        decimationFactor: last.decimationFactor,
        medianMs: median(samples),
        maxMs: Math.max(...samples),
        budgetMs: window.budgetMs,
      });
    }

    // Audio synthesis shares the resampling path; a regression there would
    // stall the play button rather than the redraw.
    const audioSpan = Math.min(1, totalDuration);
    const audioStart = Math.max(0, (totalDuration - audioSpan) / 2);
    const audioBlocks = selectWindowBlocks(blocks, audioStart, audioStart + audioSpan);
    synthesizeGradientSound(audioBlocks, { startSec: audioStart, endSec: audioStart + audioSpan });
    const audioBegan = performance.now();
    const sound = synthesizeGradientSound(audioBlocks, {
      startSec: audioStart,
      endSec: audioStart + audioSpan,
    });
    const audioMs = performance.now() - audioBegan;
    expect(sound.n).toBeGreaterThan(0);

    const report = {
      schemaVersion: 1,
      packageVersion: readPackageVersion(),
      timestamp: new Date().toISOString(),
      mode: 'reporting-first',
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        ci: !!process.env.CI,
        cpuCount: cpus().length,
      },
      iterations,
      fixture: relative(repoRoot, fixture),
      totalDurationSec: totalDuration,
      spectrogram: reports,
      audio: {
        windowSec: audioSpan,
        frames: sound.n,
        sampleRate: sound.sampleRate,
        elapsedMs: audioMs,
        budgetMs: 1500,
      },
    };

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

    for (const item of reports) {
      expect(Number.isFinite(item.medianMs)).toBe(true);
      expect(item.medianMs, `${item.id} median exceeded its ${item.budgetMs} ms budget`)
        .toBeLessThan(item.budgetMs);
    }
    expect(audioMs, 'gradient sound synthesis exceeded its 1500 ms budget').toBeLessThan(1500);
  }, 180_000);
});

/** Mirrors the host-side window selection so the measurement matches reality. */
function selectWindowBlocks(blocks: DecodedBlock[], startSec: number, endSec: number): DecodedBlock[] {
  const pad = Math.max((endSec - startSec) * 0.05, 0.05);
  return blocks.filter(block => (
    block.startTime + block.duration >= startSec - pad && block.startTime <= endSec + pad
  ));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown };
  return typeof pkg.version === 'string' ? pkg.version : 'unknown';
}
