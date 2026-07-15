import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

interface OverviewApi {
  createWaveformOverview: (blocks: unknown[]) => unknown;
  selectWaveformOverview: (
    overview: unknown,
    startBlock: number,
    endBlock: number,
    maxBuckets: number,
  ) => { first: number; last: number };
  waveformVisiblePointCount: (
    overview: unknown,
    key: string,
    startBlock: number,
    endBlock: number,
  ) => number;
}

describe('standalone waveform overview', () => {
  it('selects a pixel-budgeted level while preserving full point counts', () => {
    const api = loadOverviewApi();
    const blocks = Array.from({ length: 1024 }, (_, index) => ({
      s: index * 0.001,
      d: 0.001,
      gx: {
        ty: 'arb',
        t: [index * 0.001, index * 0.001 + 0.0005, index * 0.001 + 0.001],
        w: [-index, index, -index],
      },
      adc: { s: index * 0.001, d: 0, n: 4, dw: 1e-6 },
    }));

    const overview = api.createWaveformOverview(blocks);
    const selected = api.selectWaveformOverview(overview, 0, blocks.length, 64);

    expect(selected.last - selected.first).toBeLessThanOrEqual(64);
    expect(api.waveformVisiblePointCount(overview, 'gx', 0, blocks.length)).toBe(3072);
    expect(api.waveformVisiblePointCount(overview, 'adc', 0, blocks.length)).toBe(1024);
  });
});

function loadOverviewApi(): OverviewApi {
  const source = readFileSync(join(__dirname, '..', '..', 'web', 'derived-series.js'), 'utf8');
  const context = createContext({ Float64Array, Int32Array, Infinity, isFinite, Math });
  runInContext(source, context);
  return context as unknown as OverviewApi;
}
