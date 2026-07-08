import { describe, expect, it } from 'vitest';

import { downsampleM4 } from '../../src/pulseq/displayDownsampling';

describe('display downsampling', () => {
  it('preserves narrow extrema and ordered endpoints', () => {
    const time = Float64Array.from({ length: 1000 }, (_, index) => index);
    const values = new Float64Array(1000);
    values[123] = 50;
    values[124] = -40;
    values[777] = 70;

    const result = downsampleM4(time, values, 80);

    expect(result.time.length).toBeLessThanOrEqual(80);
    expect(result.values).toContain(50);
    expect(result.values).toContain(-40);
    expect(result.values).toContain(70);
    expect(result.time).toEqual([...result.time].sort((a, b) => a - b));
  });

  it('returns short series unchanged', () => {
    const result = downsampleM4([0, 1, 2], [4, 5, 6], 20);
    expect(result).toEqual({ time: [0, 1, 2], values: [4, 5, 6] });
  });
});
