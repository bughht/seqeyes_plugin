import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { decodeAllBlocks, getTotalDuration } from '../../src/pulseq/decoder';
import { calculateKspace } from '../../src/pulseq/kspace';
import { parseSequenceText } from '../../src/pulseq/reader';

const demoDir = join(__dirname, '..', 'seqeyes_demo_seq_files');
const demoFiles = findSeqFiles(demoDir);

describe('SeqEyes demo sequence smoke coverage', () => {
  it('covers the copied SeqEyes demo sequence set', () => {
    expect(demoFiles.length).toBeGreaterThanOrEqual(30);
    expect(demoFiles.some((file) => file.endsWith('writeRadialGradientEcho_rotExt.seq'))).toBe(true);
    expect(demoFiles.some((file) => file.endsWith('v142/writeGradientEcho.seq'))).toBe(true);
  });

  it.each(demoFiles)('parses, decodes, and calculates finite k-space when ADC exists: %s', (relativePath) => {
    const seq = parseSequenceText(readFileSync(join(demoDir, relativePath), 'utf8'));
    const decoded = decodeAllBlocks(seq);
    const totalDuration = getTotalDuration(seq);

    expect(seq.blocks.length).toBeGreaterThan(0);
    expect(decoded).toHaveLength(seq.blocks.length);
    expect(Number.isFinite(totalDuration)).toBe(true);
    expect(totalDuration).toBeGreaterThan(0);

    const adcSamples = decoded.reduce((sum, block) => sum + (block.adc?.numSamples ?? 0), 0);
    if (adcSamples === 0) return;

    const kspace = calculateKspace(
      decoded,
      seq.rasterTimes.gradientRaster,
      totalDuration,
      0,
      { rfRaster: seq.rasterTimes.rfRaster },
    );

    expect(kspace).not.toBeNull();
    expect(kspace!.t_adc.length).toBe(adcSamples);
    expect(kspace!.ktraj_adc[0]).toHaveLength(adcSamples);
    expectFiniteSamples(kspace!.t_adc, `${relativePath} t_adc`);
    expectFiniteSamples(kspace!.ktraj_adc[0], `${relativePath} kx_adc`);
    expectFiniteSamples(kspace!.ktraj_adc[1], `${relativePath} ky_adc`);
    expectFiniteSamples(kspace!.ktraj_adc[2], `${relativePath} kz_adc`);
  });

  it.each(demoFiles.filter((file) => file.includes('rotExt')))('decodes rotation metadata: %s', (relativePath) => {
    const seq = parseSequenceText(readFileSync(join(demoDir, relativePath), 'utf8'));
    const decoded = decodeAllBlocks(seq);
    const rotatedBlocks = decoded.filter((block) => block.rotation);

    expect(seq.rotations.length).toBeGreaterThan(0);
    expect(seq.extensions.size).toBeGreaterThan(0);
    expect(rotatedBlocks.length).toBeGreaterThan(0);
  });
});

function findSeqFiles(root: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const entryPath = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...findSeqFiles(root, entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.seq')) {
      files.push(entryPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function expectFiniteSamples(values: Float64Array, label: string): void {
  expect(values.length, `${label} should not be empty`).toBeGreaterThan(0);
  const indices = new Set([
    0,
    Math.floor(values.length / 2),
    values.length - 1,
  ]);
  for (const index of indices) {
    expect(Number.isFinite(values[index]), `${label} has non-finite value at ${index}`).toBe(true);
  }
}
