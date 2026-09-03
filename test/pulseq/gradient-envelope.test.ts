import { describe, expect, it } from 'vitest';

import { reduceM4 } from '../../src/pulseq/displayDownsampling';
import { computeGradientEnvelope, countGradientSamples } from '../../src/pulseq/gradientEnvelope';
import type { DecodedBlock } from '../../src/pulseq/types';
import { loadBlocks } from './blockTransportFixtures';

/** Brute-force truth: densely sample the piecewise-linear waveform per column. */
function trueColumnRange(
  time: ArrayLike<number>,
  values: ArrayLike<number>,
  n: number,
  startSec: number,
  endSec: number,
  columns: number,
  column: number,
) {
  const from = startSec + ((endSec - startSec) * column) / columns;
  const to = startSec + ((endSec - startSec) * (column + 1)) / columns;
  let lo = Infinity;
  let hi = -Infinity;
  const STEPS = 400;
  for (let s = 0; s <= STEPS; s++) {
    const t = from + ((to - from) * s) / STEPS;
    if (t < time[0] || t > time[n - 1]) continue;
    // locate the segment containing t
    let a = 0;
    let b = n - 1;
    while (b - a > 1) {
      const mid = (a + b) >> 1;
      if (time[mid] <= t) a = mid;
      else b = mid;
    }
    const dt = time[b] - time[a];
    const f = dt === 0 ? 0 : (t - time[a]) / dt;
    const v = values[a] + f * (values[b] - values[a]);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { lo, hi };
}

describe('gradient envelope', () => {
  it('reports the true range the waveform covers in every column', () => {
    const blocks = loadBlocks('writeSpiral.seq');
    const index = blocks.findIndex(b => b.gx && b.gx.type !== 'none' && b.gx.timePoints.length > 2000);
    const grad = blocks[index].gx!;
    const n = grad.timePoints.length;
    const startSec = grad.timePoints[0];
    const endSec = grad.timePoints[n - 1];
    const columns = 200;

    const env = computeGradientEnvelope([blocks[index]], startSec, endSec, columns);
    const scale = Math.max(...Array.from(grad.waveform).map(Math.abs));

    let worst = 0;
    let understated = 0;
    let worstUnderstatement = 0;
    for (let c = 0; c < columns; c++) {
      if (!env.channels.gx.filled[c]) continue;
      const truth = trueColumnRange(grad.timePoints, grad.waveform, n, startSec, endSec, columns, c);
      if (!Number.isFinite(truth.lo)) continue;
      worst = Math.max(
        worst,
        Math.abs(env.channels.gx.max[c] - truth.hi) / scale,
        Math.abs(env.channels.gx.min[c] - truth.lo) / scale,
      );
      const trueSwing = truth.hi - truth.lo;
      const bandSwing = env.channels.gx.max[c] - env.channels.gx.min[c];
      // Tolerance is the Float32 the band is stored in, not an allowance for
      // missing the waveform: a real miss is percent-level, this is ~5e-8.
      if (bandSwing < trueSwing - scale * 1e-5) {
        understated++;
        worstUnderstatement = Math.max(worstUnderstatement, (trueSwing - bandSwing) / scale);
      }
    }
    // The band must never claim a narrower swing than the waveform actually had:
    // that is the property a reduced polyline cannot promise.
    expect(worstUnderstatement).toBeLessThan(1e-5);
    expect(understated).toBe(0);
    expect(worst).toBeLessThan(0.01);
  });

  it('loses swing when built from reduced samples instead of native ones', () => {
    const blocks = loadBlocks('writeSpiral.seq');
    const index = blocks.findIndex(b => b.gx && b.gx.type !== 'none' && b.gx.timePoints.length > 2000);
    const grad = blocks[index].gx!;
    const n = grad.timePoints.length;
    const startSec = grad.timePoints[0];
    const endSec = grad.timePoints[n - 1];
    const columns = 200;

    // The same summary built from an M4-reduced series — which is what the
    // block overview hierarchy summarises today.
    const rt: number[] = [];
    const rv: number[] = [];
    reduceM4(grad.timePoints, grad.waveform, 500, (t, v) => { rt.push(t); rv.push(v); });
    const reduced: DecodedBlock = {
      ...blocks[index],
      gx: { ...grad, timePoints: Float64Array.from(rt), waveform: Float64Array.from(rv) },
    };

    const native = computeGradientEnvelope([blocks[index]], startSec, endSec, columns);
    const fromReduced = computeGradientEnvelope([reduced], startSec, endSec, columns);
    const scale = Math.max(...Array.from(grad.waveform).map(Math.abs));

    let lost = 0;
    let worstLoss = 0;
    for (let c = 0; c < columns; c++) {
      if (!native.channels.gx.filled[c] || !fromReduced.channels.gx.filled[c]) continue;
      const nativeSwing = native.channels.gx.max[c] - native.channels.gx.min[c];
      const reducedSwing = fromReduced.channels.gx.max[c] - fromReduced.channels.gx.min[c];
      if (reducedSwing < nativeSwing - scale * 1e-5) {
        lost++;
        worstLoss = Math.max(worstLoss, (nativeSwing - reducedSwing) / scale);
      }
    }
    // Summarising a summary is lossy at a scale that matters, which is why the
    // band is computed from the decoder's samples rather than the transport's.
    expect(lost).toBeGreaterThan(columns / 10);
    expect(worstLoss).toBeGreaterThan(0.01);
  });

  it('marks columns with no waveform as unfilled instead of zero', () => {
    const blocks = loadBlocks('writeGradientEcho.seq');
    const withGrad = blocks.filter(b => b.gx && b.gx.type !== 'none');
    expect(withGrad.length).toBeGreaterThan(0);
    const first = withGrad[0].gx!;
    // A window starting well before the first gradient leaves leading columns empty.
    const startSec = Math.max(0, first.timePoints[0] - 0.01);
    const env = computeGradientEnvelope(withGrad.slice(0, 1), startSec, first.timePoints[0] + 0.001, 64);
    expect(env.channels.gx.filled[0]).toBe(0);
    expect(env.channels.gx.min[0]).toBe(Infinity);
    expect(Array.from(env.channels.gx.filled).some(f => f === 1)).toBe(true);
  });

  it('counts the native gradient samples a window covers', () => {
    const blocks = loadBlocks('writeSpiral.seq');
    const manual = blocks.reduce((sum, b) => sum
      + (['gx', 'gy', 'gz'] as const).reduce((s, k) => {
        const g = b[k];
        return s + (g && g.type !== 'none' ? g.timePoints.length : 0);
      }, 0), 0);
    expect(countGradientSamples(blocks)).toBe(manual);
  });
});
