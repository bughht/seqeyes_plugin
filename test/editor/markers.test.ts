import { describe, expect, it } from 'vitest';

import { loadWebviewAssets } from '../pulseq/blockTransportFixtures';

/* The measurement-marker core, run from the shipped asset in a bare context:
   no DOM, so only the pure functions and the marker list are reachable. */

interface Corner { t: number; w: number; name: string }
interface Snap { t: number; kind: string; ci: number; label: string; labels: string[]; text: string }
interface Units { timeConv(t: number): number; timeUnit: string; gradConv(v: number): number; gradUnit: string }
interface Core {
  blockIndexAt(blocks: Block[], t: number): number;
  trapezoidCorners(g: Grad): Corner[];
  gradientCorners(overview: Grad, detail: Grad | null, lo: number, hi: number): Corner[];
  snapCandidates(blocks: Block[], t: number, tol: number, opts?: object): Snap[];
  snapAt(blocks: Block[], t: number, tol: number, opts?: object): Snap | null;
  readoutAt(blocks: Block[], t: number, detail: object | null): Record<string, any>;
  tableRows(list: object[], blocks: Block[], detail: object | null, units: Units): Record<string, any>[];
  toTsv(rows: object[], units: Units): string;
  formatTime(seconds: number, units: Units): string;
  formatGradient(value: number, units: Units): string;
}
interface Markers {
  core: Core;
  add(t: number, snap?: string): { id: number; t: number };
  remove(id: number): void;
  clear(): void;
  list(): { id: number; t: number; snap: string }[];
}
interface Grad { ty: string; t: Float64Array; w: Float32Array; a?: number; r?: number }
interface Block { i: number; s: number; d: number; gx?: Grad; gy?: Grad; gz?: Grad; rf?: object; adc?: object; trg?: object[] }

function load(): Markers {
  return loadWebviewAssets<{ SeqEyesMarkers: Markers }>(['block-transport.js', 'markers.js']).SeqEyesMarkers;
}

const grad = (ty: string, t: number[], w: number[], extra: Partial<Grad> = {}): Grad => ({
  ty, t: new Float64Array(t), w: new Float32Array(w), a: Math.max(...w.map(Math.abs)), ...extra,
});

/** A trapezoid as the decoder writes it: ramp 0.1 ms, flat 0.6 ms, from `start`. */
const trap = (start: number, amplitude = 1000): Grad =>
  grad('trap', [start, start + 1e-4, start + 7e-4, start + 8e-4], [0, amplitude, amplitude, 0]);

const MS: Units = { timeConv: t => t * 1e3, timeUnit: 'ms', gradConv: v => v / 42576, gradUnit: 'mT/m' };
const names = (corners: Corner[]) => corners.map(c => c.name);

describe('measurement marker corners', () => {
  it('names a trapezoid\'s four corners, skipping the delay anchor', () => {
    const { core } = load();
    expect(names(core.trapezoidCorners(trap(0)))).toEqual(['ramp-up start', 'flat-top start', 'flat-top end', 'ramp-down end']);
    const delayed = grad('trap', [0, 2e-4, 3e-4, 5e-4, 6e-4], [0, 0, 500, 500, 0]);
    const corners = core.trapezoidCorners(delayed);
    expect(corners.map(c => c.t)).toEqual([2e-4, 3e-4, 5e-4, 6e-4]);
  });

  it('folds coincident corners into one point', () => {
    const { core } = load();
    const triangle = grad('trap', [0, 1e-4, 1e-4, 2e-4], [0, 800, 800, 0]);
    expect(names(core.trapezoidCorners(triangle))).toEqual(['ramp-up start', 'peak', 'ramp-down end']);
  });

  it('finds every breakpoint of an extended trapezoid', () => {
    const { core } = load();
    const ext = grad('arb', [0, 1e-4, 3e-4, 4e-4, 6e-4], [0, 1000, 1000, 400, 0]);
    const corners = core.gradientCorners(ext, null, 0, 6e-4);
    expect(corners.map(c => [c.t, c.name])).toEqual([
      [0, 'start'], [1e-4, 'ramp-up end'], [3e-4, 'ramp-down start'], [4e-4, 'slope change'], [6e-4, 'end'],
    ]);
  });

  it('finds trapezoid corners in a raster-sampled arbitrary gradient', () => {
    const { core } = load();
    // 10 µs raster: 10-sample ramps either side of a 30-sample plateau.
    const t: number[] = [], w: number[] = [];
    for (let i = 0; i <= 50; i++) {
      t.push(i * 1e-5);
      w.push(i <= 10 ? i * 100 : i <= 40 ? 1000 : (50 - i) * 100);
    }
    const corners = core.gradientCorners(grad('arb', t, w), null, 0, 5e-4);
    expect(corners.map(c => [Math.round(c.t * 1e6), c.name])).toEqual([
      [0, 'start'], [100, 'ramp-up end'], [400, 'ramp-down start'], [500, 'end'],
    ]);
  });

  it('keeps little more than the peaks of a smooth waveform', () => {
    const { core } = load();
    const t: number[] = [], w: number[] = [];
    for (let i = 0; i <= 400; i++) { t.push(i * 1e-5); w.push(1000 * Math.sin(2 * Math.PI * i / 400)); }
    const corners = core.gradientCorners(grad('arb', t, w), null, 0, 4e-3).filter(c => c.name !== 'start' && c.name !== 'end');
    // Within a sample of each extreme: Float32 values there are flat to rounding.
    const peaks = corners.filter(c => c.name === 'peak').map(c => Math.round(c.t * 1e5));
    expect(peaks).toHaveLength(2);
    expect(Math.abs(peaks[0] - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(peaks[1] - 300)).toBeLessThanOrEqual(1);
    // Bends near each peak may also qualify, but never a run of them.
    expect(corners.length).toBeLessThanOrEqual(6);
  });

  it('offers only the ends of a waveform the overview reduced', () => {
    const { core } = load();
    const reduced = grad('arb', [0, 1e-4, 3e-4, 4e-4, 6e-4], [0, 1000, 1000, 400, 0], { r: 1 });
    expect(names(core.gradientCorners(reduced, null, 0, 6e-4))).toEqual(['start', 'end']);
    // Exact detail covering the window restores the interior.
    const detail = grad('arb', [0, 1e-4, 3e-4, 4e-4, 6e-4], [0, 1000, 1000, 400, 0]);
    expect(core.gradientCorners(reduced, detail, 0, 6e-4)).toHaveLength(5);
  });
});

describe('measurement marker snapping', () => {
  const blocks = (): Block[] => [
    { i: 1, s: 0, d: 1e-3, gx: trap(1e-4), adc: { s: 0, d: 2e-4, n: 100, dw: 5e-6 } },
    { i: 2, s: 1e-3, d: 1e-3, gy: trap(1e-3) },
  ];

  it('pulls the pointer onto the nearest corner and names it', () => {
    const { core } = load();
    const snap = core.snapAt(blocks(), 2.03e-4, 1e-5)!;
    expect(snap.t).toBeCloseTo(2e-4, 12);
    expect(snap.label).toBe('Gx flat-top start');
    expect(snap.kind).toBe('corner');
  });

  it('prefers a corner to a block boundary at the same instant, and names both', () => {
    const { core } = load();
    const snap = core.snapAt(blocks(), 1.0001e-3, 1e-5)!;
    expect(snap.t).toBe(1e-3);
    expect(snap.label).toBe('Gy ramp-up start');
    expect(snap.labels).toContain('block #1/#2');
  });

  it('snaps to ADC edges and centre', () => {
    const { core } = load();
    expect(core.snapAt(blocks(), 4.49e-4, 5e-6)!.label).toBe('ADC centre');
    expect(core.snapAt(blocks(), 7.01e-4, 5e-6)!.label).toBe('ADC end');
  });

  it('offers nothing from a hidden row, and nothing beyond the tolerance', () => {
    const { core } = load();
    const hidden = core.snapAt(blocks(), 2.03e-4, 1e-5, { rows: [0, 1, 3, 4, 5, 6] });
    expect(hidden?.label ?? null).not.toBe('Gx flat-top start');
    expect(core.snapAt(blocks(), 5e-4, 1e-5)).toBeNull();
  });

  it('refuses to snap when the tolerance spans too many blocks', () => {
    const { core } = load();
    const many: Block[] = [];
    for (let i = 0; i < 100; i++) many.push({ i: i + 1, s: i * 1e-6, d: 1e-6 });
    expect(core.snapCandidates(many, 5e-5, 5e-5)).toEqual([]);
  });
});

describe('measurement marker readout', () => {
  it('reads every channel at the marker, marking reduced samples as approximate', () => {
    const { core } = load();
    const blocks: Block[] = [
      { i: 7, s: 0, d: 1e-3, gx: trap(1e-4, 2000), gy: grad('arb', [0, 1e-3], [0, 1000], { r: 1 }),
        adc: { s: 0, d: 2e-4, n: 100, dw: 5e-6 }, trg: [{ s: 0, d: 0, dr: 1e-4 }] },
    ];
    const r = core.readoutAt(blocks, 1.5e-4, null);
    expect(r.block).toBe(7);
    expect(r.gx).toBeCloseTo(1000, 3);
    expect(r.gy).toBeCloseTo(150, 3);
    expect(r.gz).toBe(0);
    expect(r.approx).toEqual({ gy: true });
    expect(r.adc).toBeNull();
    expect(r.trigger).toBe(false);
    const inAdc = core.readoutAt(blocks, 2.5e-4, null);
    expect(inAdc.adc).toEqual({ sample: 10, count: 100 });
  });

  it('reads exact detail instead of a reduced overview where it covers the time', () => {
    const { core } = load();
    const blocks: Block[] = [{ i: 1, s: 0, d: 1e-3, gx: grad('arb', [0, 1e-3], [0, 0], { r: 1 }) }];
    const detail = { startBlock: 0, endBlock: 1, startSec: 0, endSec: 1e-3, blocks: [{ gx: grad('arb', [0, 5e-4, 1e-3], [0, 900, 0]) }] };
    const r = core.readoutAt(blocks, 5e-4, detail);
    expect(r.gx).toBeCloseTo(900, 3);
    expect(r.approx).toEqual({});
  });

  it('gives a block boundary to the block that starts there, unless that block is empty', () => {
    const { core } = load();
    const blocks: Block[] = [
      { i: 1, s: 0, d: 1e-3 }, { i: 2, s: 1e-3, d: 0 }, { i: 3, s: 1e-3, d: 1e-3 }, { i: 4, s: 2e-3, d: 0 },
    ];
    expect(core.blockIndexAt(blocks, 1e-3)).toBe(2);
    expect(core.blockIndexAt(blocks, 2e-3)).toBe(2);
    expect(core.blockIndexAt(blocks, 3e-3)).toBe(-1);
  });
});

describe('measurement marker list and table', () => {
  it('keeps markers in time order with ids that do not repeat until cleared', () => {
    const markers = load();
    markers.add(3e-3);
    markers.add(1e-3);
    const third = markers.add(2e-3);
    expect(markers.list().map(m => m.id)).toEqual([2, 3, 1]);
    markers.remove(third.id);
    expect(markers.add(4e-3).id).toBe(3);
    markers.clear();
    expect(markers.list()).toEqual([]);
    expect(markers.add(1e-3).id).toBe(1);
  });

  it('tabulates Δt and gradients in the viewer\'s units', () => {
    const { core } = load();
    const blocks: Block[] = [{ i: 1, s: 0, d: 1e-3, gx: trap(1e-4, 42576) }];
    const rows = core.tableRows([{ id: 1, t: 1e-4, snap: 'Gx ramp-up start' }, { id: 2, t: 2e-4, snap: '' }], blocks, null, MS);
    expect(rows[0]).toMatchObject({ name: 'M1', time: '0.1000', delta: '', block: '#1', gx: '0.00', snap: 'Gx ramp-up start' });
    expect(rows[1]).toMatchObject({ name: 'M2', time: '0.2000', delta: '0.1000', gx: '1.00' });
    const tsv = core.toTsv(rows, MS).split('\n');
    expect(tsv[0].split('\t').slice(0, 6)).toEqual(['Marker', 'Time (ms)', 'Δt (ms)', 'Block', 'In block (ms)', 'Gx (mT/m)']);
    expect(tsv).toHaveLength(3);
  });

  it('formats times to 0.1 µs and never prints a negative zero', () => {
    const { core } = load();
    expect(core.formatTime(1.23456789e-3, MS)).toBe('1.2346');
    expect(core.formatTime(1.23456789e-3, { ...MS, timeConv: t => t * 1e6, timeUnit: 'us' })).toBe('1234.6');
    expect(core.formatGradient(-1e-6, MS)).toBe('0.00');
  });
});
