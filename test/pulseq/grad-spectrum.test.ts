import { describe, expect, it } from 'vitest';

import {
  appendShortViewConfidenceWarnings,
  chooseWindowSamples,
  computeGradientSpectrogram,
  computeGradientSpectrumAverage,
  computeGradientSpectrumSlice,
  computeGradSpectrumParity,
  GAMMA_HZ_PER_M_PER_MT_PER_M,
  resolveSpectrogramParams,
  spectrogramColumnAt,
  spectrogramRowFrequency,
  type GradientSpectrogram,
} from '../../src/pulseq/gradSpectrum';
import { estimateSpectrogramCost, spectrogramBudgetRefusal } from '../../src/pulseq/computeBudget';
import { hannWindow, nextPowerOfTwo } from '../../src/pulseq/fft';
import { decimatePadded, planDecimation } from '../../src/pulseq/decimator';
import { resamplePhysicalGradients } from '../../src/pulseq/physicalGradients';
import type { DecodedBlock, DecodedGradWaveform } from '../../src/pulseq/types';

const RASTER = 1e-5;   // 10 µs — the usual Pulseq gradient raster

// ─── fixtures ────────────────────────────────────────────────────────────────

function grad(
  channel: 'gx' | 'gy' | 'gz',
  times: number[],
  values: number[],
): DecodedGradWaveform {
  return {
    blockIndex: 1,
    startTime: times[0],
    duration: times[times.length - 1] - times[0],
    timePoints: Float64Array.from(times),
    waveform: Float64Array.from(values),
    amplitude: Math.max(...values.map(Math.abs)),
    type: 'arb',
    channel,
  };
}

/** One block holding an arbitrary waveform sampled on the gradient raster. */
function toneBlock(
  channel: 'gx' | 'gy' | 'gz',
  durationSec: number,
  sample: (t: number) => number,
  rotation?: number[],
): DecodedBlock {
  const n = Math.round(durationSec / RASTER) + 1;
  const times: number[] = [];
  const values: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i * RASTER;
    times.push(t);
    values.push(sample(t));
  }
  const block: DecodedBlock = {
    index: 1,
    duration: durationSec,
    startTime: 0,
    [channel]: grad(channel, times, values),
  } as DecodedBlock;
  if (rotation) block.rotation = { id: 1, values: rotation };
  return block;
}

/** Gx tone plus a Gy tone in the same block, for the rotation test. */
function twoAxisBlock(
  durationSec: number,
  sampleX: (t: number) => number,
  sampleY: (t: number) => number,
  rotation?: number[],
): DecodedBlock {
  const n = Math.round(durationSec / RASTER) + 1;
  const times: number[] = [];
  const vx: number[] = [];
  const vy: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i * RASTER;
    times.push(t);
    vx.push(sampleX(t));
    vy.push(sampleY(t));
  }
  const block: DecodedBlock = {
    index: 1,
    duration: durationSec,
    startTime: 0,
    gx: grad('gx', times, vx),
    gy: grad('gy', times, vy),
  } as DecodedBlock;
  if (rotation) block.rotation = { id: 1, values: rotation };
  return block;
}

/** A 1 kHz trapezoid train — hard corners, so plenty of out-of-band energy. */
function trapezoidTrainBlock(durationSec: number, periodSec: number): DecodedBlock {
  return toneBlock('gx', durationSec, (t) => {
    const phase = (t % periodSec) / periodSec;
    const ramp = 0.15;
    if (phase < ramp) return 1e5 * (phase / ramp);
    if (phase < 0.5 - ramp) return 1e5;
    if (phase < 0.5) return 1e5 * ((0.5 - phase) / ramp);
    return 0;
  });
}

function peakRow(spec: GradientSpectrogram, column: number, key: 'gx' | 'gy' | 'gz' | 'rss'): number {
  let best = -1;
  let bestValue = -Infinity;
  for (let row = 0; row < spec.nFreq; row++) {
    const value = spec.data[key][row * spec.nTime + column];
    if (value > bestValue) { bestValue = value; best = row; }
  }
  return best;
}

function columnEnergy(spec: GradientSpectrogram, column: number): number {
  let sum = 0;
  for (let row = 0; row < spec.nFreq; row++) sum += spec.data.rss[row * spec.nTime + column];
  return sum;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('gradient spectrogram', () => {
  it('places a single tone in the expected bin and recovers its amplitude', () => {
    // 1 mT/m peak at 1000 Hz, expressed in Hz/m as the decoder would.
    const amplitudeHzPerM = 1.0 * GAMMA_HZ_PER_M_PER_MT_PER_M;
    const blocks = [toneBlock('gx', 0.2, (t) => amplitudeHzPerM * Math.sin(2 * Math.PI * 1000 * t))];

    const spec = computeGradientSpectrogram(blocks, RASTER, {
      startSec: 0.02,
      endSec: 0.18,
      fMaxHz: 3000,
    });

    expect(spec.nTime).toBeGreaterThan(0);
    const column = Math.floor(spec.nTime / 2);
    const row = peakRow(spec, column, 'gx');
    const peakHz = spectrogramRowFrequency(spec, row);
    expect(Math.abs(peakHz - 1000)).toBeLessThanOrEqual(spec.fStepHz * 1.001);

    // Coherent-gain normalisation makes the two-sided peak half the amplitude.
    const peakValue = spec.data.gx[row * spec.nTime + column];
    expect(peakValue).toBeGreaterThan(0.5 * 0.98);
    expect(peakValue).toBeLessThan(0.5 * 1.02);
    expect(spec.unit).toBe('mT/m');
  });

  it('resolves tones 2*df apart and merges tones 0.3*df apart', () => {
    const amp = GAMMA_HZ_PER_M_PER_MT_PER_M;
    const duration = 0.4;

    const probe = computeGradientSpectrogram(
      [toneBlock('gx', duration, (t) => amp * Math.sin(2 * Math.PI * 1000 * t))],
      RASTER,
      { startSec: 0, endSec: duration, fMaxHz: 3000 },
    );
    const df = probe.dfResolutionHz;
    expect(df).toBeGreaterThan(0);

    const resolvable = computeGradientSpectrogram(
      [toneBlock('gx', duration, (t) =>
        amp * Math.sin(2 * Math.PI * 1000 * t) + amp * Math.sin(2 * Math.PI * (1000 + 2 * df) * t))],
      RASTER,
      { startSec: 0, endSec: duration, fMaxHz: 3000 },
    );
    const merged = computeGradientSpectrogram(
      [toneBlock('gx', duration, (t) =>
        amp * Math.sin(2 * Math.PI * 1000 * t) + amp * Math.sin(2 * Math.PI * (1000 + 0.3 * df) * t))],
      RASTER,
      { startSec: 0, endSec: duration, fMaxHz: 3000 },
    );

    const column = Math.floor(resolvable.nTime / 2);
    expect(countLocalMaxima(resolvable, column, 800, 1400)).toBeGreaterThanOrEqual(2);
    expect(countLocalMaxima(merged, Math.floor(merged.nTime / 2), 800, 1400)).toBe(1);
  });

  it('matches gradSpectrum.m Hann window and per-segment DC removal element-wise', () => {
    const n = 8;
    const w = hannWindow(n);
    for (let i = 0; i < n; i++) {
      expect(w[i]).toBeCloseTo(0.5 * (1 - Math.cos(2 * Math.PI * (i + 1) / n)), 12);
    }
    expect(w[n - 1]).toBeCloseTo(0, 12);

    // A pure DC offset must not survive into the spectrum.
    const dc = computeGradientSpectrogram(
      [toneBlock('gx', 0.2, () => 5000)],
      RASTER,
      { startSec: 0.02, endSec: 0.18, fMaxHz: 3000 },
    );
    expect(dc.maxValue).toBeLessThan(1e-6);
  });

  it('changes bin spacing but not peak amplitude or frequency with zero-padding', () => {
    const amp = GAMMA_HZ_PER_M_PER_MT_PER_M;
    const blocks = [toneBlock('gx', 0.25, (t) => amp * Math.sin(2 * Math.PI * 1200 * t))];
    const base = { startSec: 0, endSec: 0.25, fMaxHz: 3000, windowSamples: 256 };

    const os1 = computeGradientSpectrogram(blocks, RASTER, { ...base, oversample: 1 });
    const os4 = computeGradientSpectrogram(blocks, RASTER, { ...base, oversample: 4 });

    expect(os4.fStepHz).toBeLessThan(os1.fStepHz);
    expect(os4.dfResolutionHz).toBeCloseTo(os1.dfResolutionHz, 9);

    const c1 = Math.floor(os1.nTime / 2);
    const c4 = Math.floor(os4.nTime / 2);
    const f1 = spectrogramRowFrequency(os1, peakRow(os1, c1, 'gx'));
    const f4 = spectrogramRowFrequency(os4, peakRow(os4, c4, 'gx'));
    expect(Math.abs(f1 - f4)).toBeLessThan(os1.fStepHz);

    const p1 = os1.data.gx[peakRow(os1, c1, 'gx') * os1.nTime + c1];
    const p4 = os4.data.gx[peakRow(os4, c4, 'gx') * os4.nTime + c4];
    expect(p4 / p1).toBeGreaterThan(0.95);
    expect(p4 / p1).toBeLessThan(1.05);
  });

  it('keeps decimated and undecimated spectra within 0.5 dB below fMax', () => {
    // The guard against the worst failure mode here: naive decimation folds
    // trapezoid corner energy into the displayed band and the result still
    // looks plausible. A 1 kHz trapezoid train has hard corners and therefore
    // strong harmonics well above the band, so it is the case that exposes it.
    //
    // fMax = 2500 Hz is chosen so D lands on 16: with a power-of-two factor and
    // the window widened by exactly D, both paths land on *identical* bin grids
    // and identical column times, so the comparison is bin-for-bin with no
    // interpolation — the only difference left between them is the anti-aliasing.
    const blocks = [trapezoidTrainBlock(0.2, 1e-3)];
    const options = { startSec: 0.02, endSec: 0.18, fMaxHz: 2500, windowSamples: 256, oversample: 2 };

    const decimated = computeGradientSpectrogram(blocks, RASTER, options);
    expect(decimated.decimationFactor).toBe(16);

    const fullRate = computeGradientSpectrogram(blocks, RASTER, {
      ...options,
      fMaxHz: 1 / (2 * RASTER),
      windowSamples: 256 * decimated.decimationFactor,
    });
    expect(fullRate.decimationFactor).toBe(1);
    expect(fullRate.nTime).toBe(decimated.nTime);
    expect(fullRate.fStepHz).toBeCloseTo(decimated.fStepHz, 9);
    expect(fullRate.dtResolutionSec).toBeCloseTo(decimated.dtResolutionSec, 12);

    const column = Math.floor(decimated.nTime / 2);
    let worstDb = 0;
    let compared = 0;
    for (let row = 0; row < decimated.nFreq; row++) {
      const f = spectrogramRowFrequency(decimated, row);
      if (f > options.fMaxHz) continue;
      // Below ~50 Hz the two paths legitimately disagree: per-window DC removal
      // averages 256 samples 160 us apart in one case and 4096 samples 10 us
      // apart in the other, leaving different sub-0.2%-of-peak residuals at the
      // first few bins. That is a sample-rate artefact, not aliasing.
      if (f < 50) continue;
      const a = decimated.data.gx[row * decimated.nTime + column];
      const b = fullRate.data.gx[row * fullRate.nTime + column];
      // -80 dB of the column peak is the numerical noise floor of a 512-point
      // FFT in float32; nulls below it carry no display meaning.
      if (a < decimated.maxValue * 1e-4 && b < decimated.maxValue * 1e-4) continue;
      worstDb = Math.max(worstDb, Math.abs(20 * Math.log10(a / b)));
      compared++;
    }
    expect(compared).toBeGreaterThan(50);
    expect(worstDb).toBeLessThan(0.5);
  });

  it('does not fold out-of-band harmonics into the displayed band', () => {
    // A tone above the decimated Nyquist must be suppressed, not aliased down.
    // Without anti-aliasing a 6 kHz tone at D = 16 (fs' = 6.25 kHz) would
    // reappear at 250 Hz looking exactly like real gradient content.
    const amp = GAMMA_HZ_PER_M_PER_MT_PER_M;
    const blocks = [toneBlock('gx', 0.2, (t) => amp * Math.sin(2 * Math.PI * 6000 * t))];

    const spec = computeGradientSpectrogram(blocks, RASTER, {
      startSec: 0.02, endSec: 0.18, fMaxHz: 2500, windowSamples: 256,
    });

    expect(spec.decimationFactor).toBe(16);
    // 80 dB of stopband attenuation on an 0.5 mT/m half-amplitude peak.
    expect(spec.maxValue).toBeLessThan(0.5 * 1e-4);
  });

  it('localises a burst to the columns that contain it', () => {
    // The property whole-sequence averaging destroys — asserted explicitly.
    const amp = GAMMA_HZ_PER_M_PER_MT_PER_M;
    const blocks = [toneBlock('gx', 0.2, (t) =>
      t > 0.12 && t < 0.16 ? amp * Math.sin(2 * Math.PI * 900 * t) : 0)];

    const spec = computeGradientSpectrogram(blocks, RASTER, {
      startSec: 0,
      endSec: 0.2,
      fMaxHz: 3000,
      windowSamples: 128,
    });

    let hotEnergy = 0;
    let coldEnergy = 0;
    for (let col = 0; col < spec.nTime; col++) {
      const t = spec.tStartSec + col * spec.tStepSec;
      const energy = columnEnergy(spec, col);
      if (t > 0.125 && t < 0.155) hotEnergy = Math.max(hotEnergy, energy);
      else if (t < 0.10 || t > 0.18) coldEnergy = Math.max(coldEnergy, energy);
    }
    expect(hotEnergy).toBeGreaterThan(0);
    expect(coldEnergy).toBeLessThan(hotEnergy * 0.05);
  });

  it('swaps the x and y spectra under a 90-degree rotation extension', () => {
    const amp = GAMMA_HZ_PER_M_PER_MT_PER_M;
    const sampleX = (t: number) => amp * Math.sin(2 * Math.PI * 800 * t);
    const sampleY = () => 0;
    const options = { startSec: 0.01, endSec: 0.09, fMaxHz: 3000, windowSamples: 128 };

    const plain = computeGradientSpectrogram([twoAxisBlock(0.1, sampleX, sampleY)], RASTER, options);
    // Rz(+90°) as a 3x3 row-major matrix: x -> y, y -> -x.
    const rotated = computeGradientSpectrogram(
      [twoAxisBlock(0.1, sampleX, sampleY, [0, -1, 0, 1, 0, 0, 0, 0, 1])],
      RASTER,
      options,
    );

    const column = Math.floor(plain.nTime / 2);
    const plainX = plain.data.gx[peakRow(plain, column, 'gx') * plain.nTime + column];
    const rotatedY = rotated.data.gy[peakRow(rotated, column, 'gy') * rotated.nTime + column];
    const rotatedX = maxOfColumn(rotated, column, 'gx');

    expect(rotatedY).toBeCloseTo(plainX, 5);
    expect(rotatedX).toBeLessThan(plainX * 1e-6);
  });

  it('returns valid empty results for empty, all-zero and single-block windows', () => {
    const empty = computeGradientSpectrogram([], RASTER, { startSec: 0, endSec: 0.05 });
    expect(empty.nTime).toBe(0);
    expect(empty.maxValue).toBe(0);
    expect(Number.isFinite(empty.minValue)).toBe(true);
    expect(computeGradientSpectrumSlice(empty, 0)).toBeNull();
    expect(computeGradientSpectrumAverage(empty)).toBeNull();
    expect(spectrogramColumnAt(empty, 0)).toBe(-1);

    const zeros = computeGradientSpectrogram([toneBlock('gx', 0.05, () => 0)], RASTER, {
      startSec: 0, endSec: 0.05,
    });
    for (const value of zeros.data.rss) expect(Number.isFinite(value)).toBe(true);
    expect(zeros.maxValue).toBe(0);
    expect(zeros.warnings.some(w => w.includes('No gradient activity'))).toBe(true);

    const tiny = computeGradientSpectrogram([toneBlock('gx', 1e-4, () => 1000)], RASTER, {
      startSec: 0, endSec: 1e-4,
    });
    expect(Number.isFinite(tiny.minValue)).toBe(true);
    expect(Number.isFinite(tiny.maxValue)).toBe(true);
  });

  it('warns and shrinks the window when the view holds fewer than three windows', () => {
    const warnings: string[] = [];
    const params = resolveSpectrogramParams({ fMinHz: 0, fMaxHz: 3000 });
    const decimatedDt = RASTER * 13;

    const roomy = chooseWindowSamples(params, decimatedDt, 1.0, warnings);
    expect(warnings).toHaveLength(0);

    const cramped = chooseWindowSamples(params, decimatedDt, 0.01, warnings);
    expect(cramped).toBeLessThan(roomy);
    expect(warnings.some(w => w.startsWith('Short view'))).toBe(true);
  });

  it('warns when the 32-sample floor leaves fewer than three independent windows', () => {
    const block = toneBlock('gx', 0.02, (t) => Math.sin(2 * Math.PI * 700 * t));
    const automatic = computeGradientSpectrogram([block], RASTER, {
      startSec: 0, endSec: 0.008, fMaxHz: 3000,
    });
    const explicit = computeGradientSpectrogram([block], RASTER, {
      startSec: 0, endSec: 0.008, fMaxHz: 3000, windowSamples: 32,
    });

    expect(automatic.nTime).toBeGreaterThan(0);
    expect(automatic.warnings.some(w => w.includes('only') && w.includes('independent analysis windows')))
      .toBe(true);
    expect(explicit.warnings.some(w => w.includes('only') && w.includes('independent analysis windows')))
      .toBe(true);
  });

  it('grades independent-window and visible-TR context without refusing valid data', () => {
    const strong: string[] = [];
    appendShortViewConfidenceWarnings(strong, 0.008, 0.004, 0.003);
    expect(strong.some(w => w.includes('only 2.0 independent'))).toBe(true);
    expect(strong.some(w => w.includes('Only 2.7 TRs'))).toBe(true);

    const advisory: string[] = [];
    appendShortViewConfidenceWarnings(advisory, 0.016, 0.004);
    expect(advisory.some(w => w.includes('4.0 independent'))).toBe(true);
    expect(advisory.some(w => w.includes('high-variance'))).toBe(false);

    const sufficient: string[] = [];
    appendShortViewConfidenceWarnings(sufficient, 0.025, 0.004, 0.005);
    expect(sufficient).toEqual([]);
  });

  it('reads a marker slice and a view-average slice from the same matrix', () => {
    const amp = GAMMA_HZ_PER_M_PER_MT_PER_M;
    const spec = computeGradientSpectrogram(
      [toneBlock('gx', 0.2, (t) => amp * Math.sin(2 * Math.PI * 700 * t))],
      RASTER,
      { startSec: 0.02, endSec: 0.18, fMaxHz: 3000 },
    );

    const midTime = spec.tStartSec + Math.floor(spec.nTime / 2) * spec.tStepSec;
    const slice = computeGradientSpectrumSlice(spec, midTime);
    expect(slice).not.toBeNull();
    expect(slice!.gx).toHaveLength(spec.nFreq);
    expect(slice!.rss[argmax(slice!.rss)]).toBeGreaterThan(0);

    const average = computeGradientSpectrumAverage(spec);
    expect(average).not.toBeNull();
    expect(argmax(average!.gx)).toBe(argmax(slice!.gx));
  });

  it('refuses windows past the interactive budget instead of computing them', () => {
    const affordable = estimateSpectrogramCost({
      startSec: 0, endSec: 0.1, gradientRaster: RASTER,
      fMaxHz: 3000, windowSamples: 512, overlap: 0.75, oversample: 3, targetColumns: 256,
    });
    expect(spectrogramBudgetRefusal(affordable)).toBeNull();

    const huge = estimateSpectrogramCost({
      startSec: 0, endSec: 500, gradientRaster: RASTER,
      fMaxHz: 3000, windowSamples: 512, overlap: 0.75, oversample: 3, targetColumns: 256,
    });
    expect(huge.inputSamples).toBeGreaterThan(8_000_000);
    expect(spectrogramBudgetRefusal(huge)).toMatch(/Zoom in/);
  });

  it('reports dG/dt in T/m/s and scales with frequency', () => {
    const amp = GAMMA_HZ_PER_M_PER_MT_PER_M;
    const options = { startSec: 0.02, endSec: 0.18, fMaxHz: 3000, windowSamples: 256 };
    const slow = computeGradientSpectrogram(
      [toneBlock('gx', 0.2, (t) => amp * Math.sin(2 * Math.PI * 500 * t))], RASTER,
      { ...options, source: 'dGdt' as const },
    );
    const fast = computeGradientSpectrogram(
      [toneBlock('gx', 0.2, (t) => amp * Math.sin(2 * Math.PI * 1000 * t))], RASTER,
      { ...options, source: 'dGdt' as const },
    );

    expect(slow.unit).toBe('T/m/s');
    // d/dt of a sine scales its spectral peak by 2*pi*f, so doubling f doubles it.
    expect(fast.maxValue / slow.maxValue).toBeGreaterThan(1.8);
    expect(fast.maxValue / slow.maxValue).toBeLessThan(2.2);
  });
});

describe('decimation primitives', () => {
  it('preserves DC gain and compensates the filter delay', () => {
    const plan = planDecimation(1 / RASTER, 3000);
    expect(plan.factor).toBeGreaterThan(1);
    expect(plan.delaySamples).toBe((plan.taps.length - 1) / 2);

    let sum = 0;
    for (const tap of plan.taps) sum += tap;
    expect(sum).toBeCloseTo(1, 12);

    const n = 400;
    const constant = new Float32Array(n + 2 * plan.padSamples).fill(7);
    const out = decimatePadded(constant, plan, plan.padSamples, 10);
    for (const value of out) expect(value).toBeCloseTo(7, 4);
  });

  it('leaves the signal untouched when no decimation is needed', () => {
    const plan = planDecimation(8000, 3000);
    expect(plan.factor).toBe(1);
    const input = Float32Array.from([1, 2, 3, 4, 5]);
    expect(Array.from(decimatePadded(input, plan, 0, 5))).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('physical gradient resampling', () => {
  it('zeroes samples outside the sequence and applies block rotations', () => {
    const block = twoAxisBlock(0.001, () => 1000, () => 0, [0, -1, 0, 1, 0, 0, 0, 0, 1]);
    const window = resamplePhysicalGradients([block], {
      startSec: -0.0005,
      endSec: 0.0015,
      dt: RASTER,
    });

    expect(window.gx[0]).toBe(0);              // before the sequence
    expect(window.gy[window.n - 1]).toBe(0);   // after it
    const mid = Math.round(0.0005 / RASTER) + Math.round(0.0005 / RASTER);
    expect(window.gy[mid]).toBeCloseTo(1000, 6);
    expect(window.gx[mid]).toBeCloseTo(0, 6);
  });
});

describe('upstream parity path', () => {
  it('produces an RMS-over-segments spectrum with upstream framing', () => {
    const amp = GAMMA_HZ_PER_M_PER_MT_PER_M;
    const duration = 0.2;
    const blocks = [toneBlock('gx', duration, (t) => amp * Math.sin(2 * Math.PI * 1000 * t))];

    const parity = computeGradSpectrumParity(blocks, RASTER, duration, { fMaxHz: 3000 });

    expect(parity.segments).toBeGreaterThan(1);
    expect(parity.frequencyHz.length).toBe(parity.rss.length);
    expect(parity.frequencyHz[parity.frequencyHz.length - 1]).toBeLessThanOrEqual(3000);

    // nfft = nextPow2(5000 * 3) = 16384, so df = 100000/16384.
    expect(parity.frequencyHz[1]).toBeCloseTo((1 / RASTER) / nextPowerOfTwo(5000 * 3), 9);

    const peak = argmax(parity.gx);
    expect(Math.abs(parity.frequencyHz[peak] - 1000)).toBeLessThan(parity.frequencyHz[1] * 2);
    // Upstream leaves magnitudes unnormalised, so the peak scales with nwin.
    expect(parity.gx[peak]).toBeGreaterThan(1e6);
    expect(parity.rss[peak]).toBeCloseTo(parity.gx[peak], 3);
  });

  it('returns empty arrays rather than NaN for a sequence shorter than one segment', () => {
    const parity = computeGradSpectrumParity(
      [toneBlock('gx', 0.001, () => 1000)], RASTER, 0.001, { fMaxHz: 3000 },
    );
    expect(parity.segments).toBe(0);
    for (const value of parity.rss) expect(value).toBe(0);
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function argmax(values: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

function maxOfColumn(spec: GradientSpectrogram, column: number, key: 'gx' | 'gy' | 'gz'): number {
  let best = 0;
  for (let row = 0; row < spec.nFreq; row++) {
    best = Math.max(best, spec.data[key][row * spec.nTime + column]);
  }
  return best;
}

/** Count spectral peaks in a frequency range, ignoring the noise floor. */
function countLocalMaxima(
  spec: GradientSpectrogram,
  column: number,
  fromHz: number,
  toHz: number,
): number {
  const values: number[] = [];
  const rows: number[] = [];
  for (let row = 0; row < spec.nFreq; row++) {
    const f = spectrogramRowFrequency(spec, row);
    if (f < fromHz || f > toHz) continue;
    values.push(spec.data.gx[row * spec.nTime + column]);
    rows.push(row);
  }
  const peak = Math.max(...values);
  let count = 0;
  for (let i = 1; i < values.length - 1; i++) {
    if (values[i] < peak * 0.25) continue;
    if (values[i] > values[i - 1] && values[i] >= values[i + 1]) count++;
  }
  return count;
}
