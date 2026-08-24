import { describe, expect, it } from 'vitest';

import { ByteBoundedLru } from '../../src/editor/windowDetailCache';

describe('byte-bounded waveform detail cache', () => {
  it('evicts the least-recently-used entry by retained bytes', () => {
    const cache = new ByteBoundedLru<string>(10);
    expect(cache.set('a', 'A', 4)).toBe(true);
    expect(cache.set('b', 'B', 4)).toBe(true);
    expect(cache.get('a')).toBe('A');

    expect(cache.set('c', 'C', 4)).toBe(true);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('A');
    expect(cache.get('c')).toBe('C');
    expect(cache.sizeBytes).toBe(8);
  });

  it('rejects an entry larger than the entire cache without evicting others', () => {
    const cache = new ByteBoundedLru<string>(8);
    cache.set('kept', 'value', 4);
    expect(cache.set('too-large', 'value', 9)).toBe(false);
    expect(cache.get('kept')).toBe('value');
    expect(cache.size).toBe(1);
    expect(cache.sizeBytes).toBe(4);
  });

  it('clears both entries and retained-byte accounting', () => {
    const cache = new ByteBoundedLru<number>(8);
    cache.set('a', 1, 3);
    cache.set('b', 2, 3);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.sizeBytes).toBe(0);
  });
});
