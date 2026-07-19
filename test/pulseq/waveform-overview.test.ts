import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

interface OverviewApi {
  createWaveformOverview: (blocks: unknown[]) => {
    levels: Array<{
      rfStart: Float64Array;
      rfEnd: Float64Array;
      rfMin: Float64Array;
      rfMax: Float64Array;
      gxStart: Float64Array;
      gxEnd: Float64Array;
      gxMin: Float64Array;
      gxMax: Float64Array;
    }>;
    rfEvents: {
      count: number;
      start: Float64Array;
      end: Float64Array;
      peak: Float64Array;
      peakTime: Float64Array;
      area: Float64Array;
    };
  };
  createEnvelopeSeries: (
    start: number[], end: number[], min: number[], max: number[], first: number[], last: number[], scale: number,
  ) => unknown;
  forEachEnvelopeRange: (
    series: unknown, start: number, end: number, maxBuckets: number,
    visit: (t0: number, t1: number, min: number, max: number) => void,
  ) => number;
  sampleEnvelopeRangeAtTime: (
    series: unknown,
    timeSec: number,
  ) => { startTime: number; endTime: number; min: number; max: number; first: number; last: number } | null;
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
  forEachWaveformPoint: (
    time: number[],
    values: number[],
    maxPoints: number,
    visit: (time: number, value: number) => void,
  ) => number;
  binRfEvents: (
    series: unknown,
    viewStart: number,
    viewEnd: number,
    pixelCount: number,
    widePixelThreshold: number,
  ) => {
    peak: Float64Array;
    peakTime: Float64Array;
    occupiedStart: Float64Array;
    occupiedEnd: Float64Array;
    area: Float64Array;
    events: Uint32Array;
    wide: number[];
    secondsPerPixel: number;
  };
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

  it('keeps RF extrema and active pulse support instead of the full block duration', () => {
    const api = loadOverviewApi();
    const overview = api.createWaveformOverview([{
      s: 4,
      d: 1,
      rf: {
        s: 4.25,
        d: 0.1,
        t: [4.25, 4.275, 4.3, 4.325, 4.35],
        m: [0, 2, 9, -3, 0],
      },
    }]);
    const base = overview.levels[0];

    expect(base.rfStart[0]).toBeCloseTo(4.25, 12);
    expect(base.rfEnd[0]).toBeCloseTo(4.35, 12);
    expect(base.rfEnd[0]).toBeLessThan(5);
    expect(base.rfMin[0]).toBe(-3);
    expect(base.rfMax[0]).toBe(9);
    expect(api.waveformVisiblePointCount(overview, 'rfEvents', 0, 1)).toBe(1);
  });

  it('preserves narrow RF extrema during bounded per-pulse reduction', () => {
    const api = loadOverviewApi();
    const time = Array.from({ length: 1_000 }, (_, index) => index * 1e-6);
    const values = new Array<number>(1_000).fill(0);
    values[123] = 11;
    values[777] = -7;
    const reduced: Array<[number, number]> = [];
    const count = api.forEachWaveformPoint(time, values, 80, (sampleTime, value) => {
      reduced.push([sampleTime, value]);
    });

    expect(count).toBeLessThanOrEqual(80);
    expect(reduced.map(([, value]) => value)).toContain(11);
    expect(reduced.map(([, value]) => value)).toContain(-7);
    expect(reduced.map(([sampleTime]) => sampleTime)).toEqual(
      [...reduced.map(([sampleTime]) => sampleTime)].sort((left, right) => left - right),
    );
  });

  it('bins mixed RF pulses as independent peak and volume columns with empty gaps', () => {
    const api = loadOverviewApi();
    const overview = api.createWaveformOverview([
      {
        s: 0.1,
        d: 0.1,
        rf: { s: 0.11, d: 0.02, t: [0.11, 0.12, 0.13], m: [0, 10, 0] },
      },
      {
        s: 0.6,
        d: 0.2,
        rf: { s: 0.61, d: 0.08, t: [0.61, 0.65, 0.69], m: [0, 30, 0] },
      },
    ]);
    const bins = api.binRfEvents(overview.rfEvents, 0, 1, 10, 100);

    expect(overview.rfEvents.count).toBe(2);
    expect(bins.secondsPerPixel).toBeCloseTo(0.1, 12);
    expect(bins.events[1]).toBe(1);
    expect(bins.peak[1]).toBe(10);
    expect(bins.peakTime[1]).toBeCloseTo(0.12, 12);
    expect(bins.occupiedStart[1]).toBeCloseTo(0.11, 12);
    expect(bins.occupiedEnd[1]).toBeCloseTo(0.13, 12);
    expect(bins.area[1]).toBeCloseTo(0.1, 12);
    expect(bins.events[6]).toBe(1);
    expect(bins.peak[6]).toBe(30);
    expect(bins.peakTime[6]).toBeCloseTo(0.65, 12);
    expect(bins.occupiedStart[6]).toBeCloseTo(0.61, 12);
    expect(bins.occupiedEnd[6]).toBeCloseTo(0.69, 12);
    expect(bins.area[6]).toBeCloseTo(1.2, 12);
    expect([...bins.events].filter(Boolean)).toHaveLength(2);
    expect(bins.events[2]).toBe(0);
    expect(bins.events[3]).toBe(0);
    expect(bins.events[4]).toBe(0);
    expect(bins.events[5]).toBe(0);
    expect(bins.wide).toEqual([]);
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

  it('returns an envelope range instead of inventing a point value inside a bucket', () => {
    const api = loadOverviewApi();
    const series = api.createEnvelopeSeries(
      [0, 1], [1, 2],
      [2, 4], [6, 4],
      [2, 4], [6, 4], 1,
    );

    expect(api.sampleEnvelopeRangeAtTime(series, 0.25)).toMatchObject({ min: 2, max: 6 });
    expect(api.sampleEnvelopeRangeAtTime(series, 0.75)).toMatchObject({ min: 2, max: 6 });
    expect(api.sampleEnvelopeRangeAtTime(series, 1.5)).toMatchObject({ min: 4, max: 4 });
  });
});

function loadOverviewApi(): OverviewApi {
  const source = readFileSync(join(__dirname, '..', '..', 'web', 'derived-series.js'), 'utf8');
  const context = createContext({ Float64Array, Int32Array, Infinity, isFinite, Math });
  runInContext(source, context);
  return context as unknown as OverviewApi;
}
