import { describe, expect, it } from 'vitest';

import { loadWebviewAssets } from '../pulseq/blockTransportFixtures';

/* The channel row order core, run from the shipped asset in a bare context
   (no DOM), with the shipped prefs.js in front of it for persistence. */

type Target = { mode: 'swap' | 'insert'; index: number } | null;
interface Core {
  normalize(stored: unknown[], names: string[], defaults: number[]): number[];
  movesFor(visible: number[], ci: number): Record<'top' | 'up' | 'down' | 'bottom', boolean>;
  move(order: number[], visible: number[], ci: number, where: string): number[] | null;
  dropTarget(count: number, source: number, y: number, top: number, rowH: number): Target;
  applyDrop(order: number[], visible: number[], ci: number, target: Target): number[] | null;
  sortRows(rows: [number | number[], string][], order: number[]): string[];
  save(order: number[], names: string[], defaults: number[]): void;
}
interface ChannelOrder { core: Core; restore(names: string[], defaults: number[]): number[] }
interface Prefs { KEYS: Record<string, string>; setEnabled(on: boolean): boolean }

const CH = ['RF', 'φ', 'Gx', 'Gy', 'Gz', 'ADC', 'Trig', 'PNS', 'M1x', 'M1y', 'M1z', 'Label'];
const DEFAULT = [0, 1, 2, 3, 4, 5, 6, 11, 7, 8, 9, 10];
const KEY = 'seqeyes.channelOrder';
const ci = (...names: string[]) => names.map(n => CH.indexOf(n));
const named = (order: number[] | null) => (order ? order.map(i => CH[i]) : null);

class MemoryStorage {
  readonly map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.map.has(key) ? this.map.get(key)! : null; }
  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
  removeItem(key: string): void { this.map.delete(key); }
}

function load(storage = new MemoryStorage()) {
  const g = loadWebviewAssets<{ SeqEyesChannelOrder: ChannelOrder; SeqEyesPrefs: Prefs }>(
    ['prefs.js', 'channel-order.js'], { localStorage: storage });
  return { order: g.SeqEyesChannelOrder, prefs: g.SeqEyesPrefs, storage };
}

describe('validating a stored order', () => {
  it('falls back to the default order when nothing usable is stored', () => {
    const { core } = load().order;
    expect(named(core.normalize([], CH, DEFAULT))).toEqual(named(DEFAULT));
  });

  it('keeps a full stored order as it is', () => {
    const { core } = load().order;
    const stored = ['Gz', 'Gx', 'Gy', 'RF', 'φ', 'ADC', 'Trig', 'Label', 'PNS', 'M1x', 'M1y', 'M1z'];
    expect(named(core.normalize(stored, CH, DEFAULT))).toEqual(stored);
  });

  it('drops unknown names and repeats, and puts missing channels back at their default position', () => {
    const { core } = load().order;
    expect(named(core.normalize(['Gz', 'Bogus', 'RF', 'Gz', 7], CH, DEFAULT)))
      .toEqual(['Gz', 'φ', 'Gx', 'Gy', 'RF', 'ADC', 'Trig', 'Label', 'PNS', 'M1x', 'M1y', 'M1z']);
  });

  it('slots a channel added since the order was saved in where it belongs by default', () => {
    const { core } = load().order;
    // Saved before the Label row existed.
    const old = ['Gz', 'Gx', 'Gy', 'RF', 'φ', 'ADC', 'Trig', 'PNS', 'M1x', 'M1y', 'M1z'];
    expect(named(core.normalize(old, CH, DEFAULT)))
      .toEqual(['Gz', 'Gx', 'Gy', 'RF', 'φ', 'ADC', 'Trig', 'Label', 'PNS', 'M1x', 'M1y', 'M1z']);
  });
});

describe('moves from the row menu', () => {
  const shown = ci('RF', 'Gx', 'Gy', 'Gz', 'ADC', 'Trig'); // φ hidden

  it('steps over the neighbouring row on screen, so a hidden channel keeps its slot', () => {
    const { core } = load().order;
    expect(named(core.move(DEFAULT, shown, CH.indexOf('Gx'), 'up')))
      .toEqual(['Gx', 'RF', 'φ', 'Gy', 'Gz', 'ADC', 'Trig', 'Label', 'PNS', 'M1x', 'M1y', 'M1z']);
    expect(named(core.move(DEFAULT, shown, CH.indexOf('RF'), 'down')))
      .toEqual(['φ', 'Gx', 'RF', 'Gy', 'Gz', 'ADC', 'Trig', 'Label', 'PNS', 'M1x', 'M1y', 'M1z']);
  });

  it('sends Top and Bottom to the ends of the whole order', () => {
    const { core } = load().order;
    expect(named(core.move(DEFAULT, shown, CH.indexOf('Gz'), 'top'))!.slice(0, 3)).toEqual(['Gz', 'RF', 'φ']);
    expect(named(core.move(DEFAULT, shown, CH.indexOf('Gx'), 'bottom'))!.slice(-2)).toEqual(['M1z', 'Gx']);
  });

  it('refuses what would change nothing, and the menu disables it', () => {
    const { core } = load().order;
    expect(core.move(DEFAULT, shown, CH.indexOf('RF'), 'up')).toBeNull();
    expect(core.move(DEFAULT, shown, CH.indexOf('Trig'), 'down')).toBeNull();
    expect(core.move(DEFAULT, shown, CH.indexOf('φ'), 'up')).toBeNull(); // not on screen
    expect({ ...core.movesFor(shown, CH.indexOf('RF')) }).toEqual({ top: false, up: false, down: true, bottom: true });
    expect({ ...core.movesFor(shown, CH.indexOf('Trig')) }).toEqual({ top: true, up: true, down: false, bottom: false });
  });
});

describe('dropping a dragged row', () => {
  // Seven rows of 100 px from y = 8: the insert bands are 25 px deep.
  const top = 8, rowH = 100;
  const at = (row: number, within: number) => top + row * rowH + within;

  it('swaps on a row\'s middle and inserts near its edges', () => {
    const { core } = load().order;
    expect({ ...core.dropTarget(7, 4, at(0, 50), top, rowH) }).toEqual({ mode: 'swap', index: 0 });
    expect({ ...core.dropTarget(7, 4, at(1, 10), top, rowH) }).toEqual({ mode: 'insert', index: 1 });
    expect({ ...core.dropTarget(7, 4, at(1, 90), top, rowH) }).toEqual({ mode: 'insert', index: 2 });
    expect({ ...core.dropTarget(7, 4, top - 5, top, rowH) }).toEqual({ mode: 'insert', index: 0 });
    expect({ ...core.dropTarget(7, 4, at(7, 5), top, rowH) }).toEqual({ mode: 'insert', index: 7 });
  });

  it('ignores a drop on itself or on the gaps beside it', () => {
    const { core } = load().order;
    expect(core.dropTarget(7, 4, at(4, 50), top, rowH)).toBeNull();
    expect(core.dropTarget(7, 4, at(4, 5), top, rowH)).toBeNull();
    expect(core.dropTarget(7, 4, at(3, 95), top, rowH)).toBeNull();
    expect(core.dropTarget(7, 4, at(4, 95), top, rowH)).toBeNull();
  });

  it('keeps the edge bands at least 8 px on short rows, as Qt does', () => {
    const { core } = load().order;
    expect({ ...core.dropTarget(10, 0, 8 + 5 * 20 + 7, 8, 20) }).toEqual({ mode: 'insert', index: 5 });
    expect({ ...core.dropTarget(10, 0, 8 + 5 * 20 + 10, 8, 20) }).toEqual({ mode: 'swap', index: 5 });
  });

  it('reorders by channel, leaving hidden channels where they were', () => {
    const { core } = load().order;
    const all = ci('RF', 'φ', 'Gx', 'Gy', 'Gz', 'ADC', 'Trig');
    expect(named(core.applyDrop(DEFAULT, all, CH.indexOf('Gz'), { mode: 'swap', index: 0 }))!.slice(0, 5))
      .toEqual(['Gz', 'φ', 'Gx', 'Gy', 'RF']);
    expect(named(core.applyDrop(DEFAULT, all, CH.indexOf('ADC'), { mode: 'insert', index: 1 }))!.slice(0, 7))
      .toEqual(['RF', 'ADC', 'φ', 'Gx', 'Gy', 'Gz', 'Trig']);
    const withoutPhase = ci('RF', 'Gx', 'Gy', 'Gz', 'ADC', 'Trig');
    expect(named(core.applyDrop(DEFAULT, withoutPhase, CH.indexOf('RF'), { mode: 'insert', index: 6 }))!.slice(0, 8))
      .toEqual(['φ', 'Gx', 'Gy', 'Gz', 'ADC', 'Trig', 'RF', 'Label']);
    expect(core.applyDrop(DEFAULT, all, CH.indexOf('RF'), null)).toBeNull();
  });
});

describe('the hover readout', () => {
  it('lists channel lines in row order, a multi-row line with its highest row', () => {
    const { core } = load().order;
    const rows: [number | number[], string][] = [[0, 'RF'], [4, 'Gz'], [7, 'PNS'], [[8, 10], 'M1'], [99, 'other']];
    expect([...core.sortRows(rows, DEFAULT)]).toEqual(['RF', 'Gz', 'PNS', 'M1', 'other']);
    const custom = ci('M1z', 'Gz', 'RF', 'φ', 'Gx', 'Gy', 'ADC', 'Trig', 'Label', 'PNS', 'M1x', 'M1y');
    expect([...core.sortRows(rows, custom)]).toEqual(['M1', 'Gz', 'RF', 'PNS', 'other']);
  });
});

describe('remembering the order', () => {
  it('stores names, keeps no key for the default order, and restores what it stored', () => {
    const { order, storage } = load();
    const custom = ci('Gz', 'RF', 'φ', 'Gx', 'Gy', 'ADC', 'Trig', 'Label', 'PNS', 'M1x', 'M1y', 'M1z');
    order.core.save(custom, CH, DEFAULT);
    expect(JSON.parse(storage.getItem(KEY)!)).toEqual(named(custom));
    expect(named(load(storage).order.restore(CH, DEFAULT))).toEqual(named(custom));
    order.core.save(DEFAULT.slice(), CH, DEFAULT);
    expect(storage.getItem(KEY)).toBeNull();
  });

  it('writes nothing to storage while the consent switch is off', () => {
    const { order, prefs, storage } = load();
    prefs.setEnabled(false);
    order.core.save(ci('Gz', 'RF', 'φ', 'Gx', 'Gy', 'ADC', 'Trig', 'Label', 'PNS', 'M1x', 'M1y', 'M1z'), CH, DEFAULT);
    expect(storage.getItem(KEY)).toBeNull();
    expect(named(load(storage).order.restore(CH, DEFAULT))).toEqual(named(DEFAULT));
  });

  it('ignores a stored value that is not a list of names', () => {
    for (const raw of ['not json', '{"RF":1}', '42', 'null']) {
      const storage = new MemoryStorage();
      storage.setItem(KEY, raw);
      expect(named(load(storage).order.restore(CH, DEFAULT))).toEqual(named(DEFAULT));
    }
  });
});
