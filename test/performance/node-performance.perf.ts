import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decodeAllBlocks, getTotalDuration } from '../../src/pulseq/decoder';
import { calculateKspace } from '../../src/pulseq/kspace';
import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';
import { detectSequenceTiming } from '../../src/pulseq/trdetect';

interface Timings {
  parseMs: number;
  timingDetectMs: number;
  decodeMs: number;
  kspaceInteractiveMs: number;
  kspaceExportMs: number;
}

interface Counts {
  fileBytes: number;
  shapeSampleCount: number;
  blockCount: number;
  decodedBlockCount: number;
  adcSampleCount: number;
  interactiveTrajectorySampleCount: number;
  exportTrajectorySampleCount: number;
  totalDurationSec: number;
}

interface CaseReport {
  id: string;
  file: string;
  counts: Counts;
  metricsMs: {
    parseMedian: number;
    parseMax: number;
    timingDetectMedian: number;
    timingDetectMax: number;
    decodeMedian: number;
    decodeMax: number;
    kspaceInteractiveMedian: number;
    kspaceInteractiveMax: number;
    kspaceExportMedian: number;
    kspaceExportMax: number;
    totalMedian: number;
    totalMax: number;
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const outputPath = join(repoRoot, 'performance-results', 'performance-node.json');
const iterations = process.env.CI ? 2 : 2;

const cases = [
  {
    id: 'spiral_inout',
    path: join(repoRoot, 'test', 'seq', 'spiral_inout.seq'),
  },
  {
    id: 'dti16',
    path: join(repoRoot, 'test', 'seq', 'fs_se_dti16_b5000_v0.6.0.seq'),
  },
  {
    id: 'spi_demo',
    path: join(repoRoot, 'test', 'seqeyes_demo_seq_files', 'spi.seq'),
  },
  {
    id: 'official_gre_text',
    path: join(repoRoot, 'test', 'pulseq', 'binary', 'gre.seq'),
  },
  {
    id: 'official_gre_binary',
    path: join(repoRoot, 'test', 'pulseq', 'binary', 'gre.bseq'),
  },
  {
    id: 'official_epi_rs_text',
    path: join(repoRoot, 'test', 'pulseq', 'binary', 'epi_rs.seq'),
  },
  {
    id: 'official_epi_rs_binary',
    path: join(repoRoot, 'test', 'pulseq', 'binary', 'epi_rs.bseq'),
  },
];

describe('Node performance guard', () => {
  it('records parser, decoder, and k-space performance metrics', () => {
    const reports = cases.map((testCase) => measureCase(testCase.id, testCase.path));
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
      cases: reports,
    };

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

    expect(reports).toHaveLength(cases.length);
    for (const item of reports) assertCaseReport(item);
  }, 180_000);
});

function measureCase(id: string, filePath: string): CaseReport {
  const sequenceBytes = readFileSync(filePath);
  runPipeline(sequenceBytes, filePath);

  const runs: Array<Timings & { counts: Counts }> = [];
  for (let i = 0; i < iterations; i++) runs.push(runPipeline(sequenceBytes, filePath));

  const timings = runs.map(({ counts: _counts, ...rest }) => rest);
  const counts = runs[runs.length - 1].counts;
  return {
    id,
    file: relative(repoRoot, filePath),
    counts,
    metricsMs: {
      parseMedian: median(timings.map((run) => run.parseMs)),
      parseMax: max(timings.map((run) => run.parseMs)),
      timingDetectMedian: median(timings.map((run) => run.timingDetectMs)),
      timingDetectMax: max(timings.map((run) => run.timingDetectMs)),
      decodeMedian: median(timings.map((run) => run.decodeMs)),
      decodeMax: max(timings.map((run) => run.decodeMs)),
      kspaceInteractiveMedian: median(timings.map((run) => run.kspaceInteractiveMs)),
      kspaceInteractiveMax: max(timings.map((run) => run.kspaceInteractiveMs)),
      kspaceExportMedian: median(timings.map((run) => run.kspaceExportMs)),
      kspaceExportMax: max(timings.map((run) => run.kspaceExportMs)),
      totalMedian: median(timings.map(totalMs)),
      totalMax: max(timings.map(totalMs)),
    },
  };
}

function runPipeline(sequenceBytes: Uint8Array, filePath: string): Timings & { counts: Counts } {
  const parseStart = performance.now();
  const seq = parseSequenceBytes(sequenceBytes, filePath);
  const parseMs = performance.now() - parseStart;

  const timingStart = performance.now();
  detectSequenceTiming(seq);
  const timingDetectMs = performance.now() - timingStart;

  const decodeStart = performance.now();
  const decoded = decodeAllBlocks(seq);
  const decodeMs = performance.now() - decodeStart;
  const totalDurationSec = getTotalDuration(seq);

  const interactiveStart = performance.now();
  const interactive = calculateKspace(
    decoded,
    seq.rasterTimes.gradientRaster,
    totalDurationSec,
    0,
    { rfRaster: seq.rasterTimes.rfRaster, gradientSupport: 'endpoints' },
  );
  const kspaceInteractiveMs = performance.now() - interactiveStart;

  const exportStart = performance.now();
  const exported = calculateKspace(
    decoded,
    seq.rasterTimes.gradientRaster,
    totalDurationSec,
    0,
    { rfRaster: seq.rasterTimes.rfRaster, gradientSupport: 'all' },
  );
  const kspaceExportMs = performance.now() - exportStart;

  if (!interactive || !exported) throw new Error('K-space calculation failed during performance measurement');

  return {
    parseMs,
    timingDetectMs,
    decodeMs,
    kspaceInteractiveMs,
    kspaceExportMs,
    counts: {
      fileBytes: sequenceBytes.byteLength,
      shapeSampleCount: [...seq.shapes.values()].reduce((sum, shape) => sum + shape.numSamples, 0),
      blockCount: seq.blocks.length,
      decodedBlockCount: decoded.length,
      adcSampleCount: exported.t_adc.length,
      interactiveTrajectorySampleCount: interactive.t_ktraj.length,
      exportTrajectorySampleCount: exported.t_ktraj.length,
      totalDurationSec,
    },
  };
}

function assertCaseReport(item: CaseReport): void {
  expect(item.counts.fileBytes).toBeGreaterThan(0);
  expect(item.counts.shapeSampleCount).toBeGreaterThanOrEqual(0);
  expect(item.counts.blockCount).toBeGreaterThan(0);
  expect(item.counts.decodedBlockCount).toBe(item.counts.blockCount);
  expect(item.counts.adcSampleCount).toBeGreaterThan(0);
  expect(item.counts.interactiveTrajectorySampleCount).toBeGreaterThan(0);
  expect(item.counts.exportTrajectorySampleCount).toBeGreaterThan(0);
  expect(item.metricsMs.totalMedian).toBeGreaterThanOrEqual(0);
  expect(item.metricsMs.totalMax).toBeGreaterThanOrEqual(item.metricsMs.totalMedian);

  for (const [name, value] of Object.entries(item.metricsMs)) {
    expect(Number.isFinite(value), `${item.id} ${name} should be finite`).toBe(true);
    expect(value, `${item.id} ${name} exceeded broad Stage 4 sanity cap`).toBeLessThan(120_000);
  }
}

function totalMs(run: Timings): number {
  return run.parseMs + run.timingDetectMs + run.decodeMs + run.kspaceInteractiveMs + run.kspaceExportMs;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function max(values: number[]): number {
  return Math.max(...values);
}

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown };
  return typeof pkg.version === 'string' ? pkg.version : 'unknown';
}
