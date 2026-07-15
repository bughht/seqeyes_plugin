import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

interface OverviewApi {
  createWaveformOverview: (blocks: unknown[]) => {
    levels: Array<{
      gxStart: Float64Array;
      gxEnd: Float64Array;
      gxMin: Float64Array;
      gxMax: Float64Array;
    }>;
  };
  createEnvelopeSeries: (
    start: number[], end: number[], min: number[], max: number[], first: number[], last: number[], scale: number,
  ) => unknown;
  forEachEnvelopeRange: (
    series: unknown, start: number, end: number, maxBuckets: number,
    visit: (t0: number, t1: number, min: number, max: number) => void,
  ) => number;
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

  it('limits gradient overview support to active gradient time instead of the full block', () => {
    const api = loadOverviewApi();
    const overview = api.createWaveformOverview([{
      s: 19.26849,
      d: 0.73151,
      gx: { ty: 'arb', t: [19.26849, 19.26882, 19.26924], w: [0, 1, 0] },
    }]);
    const base = overview.levels[0];

    expect(base.gxStart[0]).toBeCloseTo(19.26849, 12);
    expect(base.gxEnd[0]).toBeCloseTo(19.26924, 12);
    expect(base.gxEnd[0]).toBeLessThan(20);
    expect(base.gxMin[0]).toBe(0);
    expect(base.gxMax[0]).toBe(1);
  });

  it('keeps coarse extrema as explicit time buckets when selecting a display level', () => {
    const api = loadOverviewApi();
    const series = api.createEnvelopeSeries(
      [0, 1, 2, 3], [1, 2, 3, 4],
      [-2, -4, -1, -3], [3, 2, 5, 1],
      [0, 1, 0, 1], [1, 0, 1, 0], 1,
    );
    const ranges: Array<[number, number, number, number]> = [];
    const count = api.forEachEnvelopeRange(series, 0, 4, 1, (t0, t1, min, max) => {
      ranges.push([t0, t1, min, max]);
    });

    expect(count).toBe(1);
    expect(ranges).toEqual([[0, 4, -4, 5]]);
  });
});

function loadOverviewApi(): OverviewApi {
  const source = readFileSync(join(__dirname, '..', '..', 'web', 'derived-series.js'), 'utf8');
  const context = createContext({ Float64Array, Int32Array, Infinity, isFinite, Math });
  runInContext(source, context);
  return context as unknown as OverviewApi;
}
