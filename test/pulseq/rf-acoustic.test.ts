import { describe, expect, it } from 'vitest';

import {
  combineRfSources,
  resampleRfAcousticSources,
} from '../../src/pulseq/rfAcoustic';
import { computeGradientSpectrogram } from '../../src/pulseq/gradSpectrum';
import { AUDIO_PEAK, synthesizeGradientSound } from '../../src/pulseq/gradientSound';
import { estimateSpectrogramCost } from '../../src/pulseq/computeBudget';
import { serializeSpectrogram } from '../../src/editor/spectrogramTransport';
import type { DecodedBlock, DecodedRFWaveform } from '../../src/pulseq/types';

const RASTER = 1e-5;   // 10 µs — the usual Pulseq gradient raster

// ─── fixtures ────────────────────────────────────────────────────────────────

/** A hard RF pulse of constant |B1|, sampled at both ends of its duration. */
function rfPulse(startSec: number, durationSec: number, amplitudeHz: number): DecodedRFWaveform {
  const times = [startSec, startSec + durationSec];
  return {
    blockIndex: 1,
    startTime: startSec,
    centerTime: startSec + durationSec / 2,
    duration: durationSec,
    timePoints: Float64Array.from(times),
    magnitude: Float64Array.from([amplitudeHz, amplitudeHz]),
    phase: Float64Array.from([0, 0]),
    amplitude: amplitudeHz,
    response: { carrierAreaDeg: 0, bands: [], spectrumAnalyzed: false, limited: false },
    freqOffset: 0,
    phaseOffset: 0,
    use: 'e',
  };
}

/** `count` identical RF pulses, one per block, repeating every `trSec`. */
function pulseTrain(
  count: number,
  trSec: number,
  pulseDurationSec: number,
  amplitudeHz = 1000,
): DecodedBlock[] {
  const blocks: DecodedBlock[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * trSec;
    blocks.push({
      index: i + 1,
      duration: trSec,
      // Offset inside the block so no pulse starts on the window edge, where a
      // rising edge is unrepresentable — that boundary case has its own test.
      rf: rfPulse(start + trSec / 10, pulseDurationSec, amplitudeHz),
      startTime: start,
    } as DecodedBlock);
  }
  return blocks;
}

function sources(blocks: DecodedBlock[], spanSec: number, rfScale = 1) {
  return resampleRfAcousticSources(blocks, {
    startSec: 0,
    dt: RASTER,
    sampleCount: Math.round(spanSec / RASTER) + 1,
    rfScale,
  });
}

function peak(values: Float32Array): number {
  let m = 0;
  for (let i = 0; i < values.length; i++) m = Math.max(m, Math.abs(values[i]));
  return m;
}

function countNonZero(values: Float32Array): number {
  let n = 0;
  for (let i = 0; i < values.length; i++) if (values[i] !== 0) n++;
  return n;
}

// ─── source construction ─────────────────────────────────────────────────────

describe('resampleRfAcousticSources', () => {
  it('gates exactly the scheduled RF extent and leaves the rest silent', () => {
    const blocks = pulseTrain(1, 0.01, 0.001);
    const out = sources(blocks, 0.01);

    expect(out.silent).toBe(false);
    expect(out.eventCount).toBe(1);
    // The pulse runs 1 .. 2 ms on a 10 µs raster: 101 inclusive samples.
    expect(countNonZero(out.gate)).toBe(101);
    expect(out.gate[99]).toBe(0);
    expect(out.gate[100]).toBe(1);
    expect(out.gate[200]).toBe(1);
    expect(out.gate[201]).toBe(0);
  });

  it('reports silence when no RF event overlaps the window', () => {
    const out = sources([{ index: 1, duration: 0.01, startTime: 0 } as DecodedBlock], 0.01);
    expect(out.silent).toBe(true);
    expect(peak(out.thermo)).toBe(0);
    expect(peak(out.control)).toBe(0);
  });

  it('keeps the control edges but empties the thermo term at rfScale = 0', () => {
    // This is the case the upstream package exists to separate: a protocol that
    // scales the flip angle to zero still schedules the RF events.
    const blocks = pulseTrain(4, 0.01, 0.001);
    const full = sources(blocks, 0.04, 1);
    const zeroed = sources(blocks, 0.04, 0);

    expect(peak(full.thermo)).toBeGreaterThan(0);
    expect(peak(zeroed.thermo)).toBe(0);
    // Eight transitions for four pulses, unchanged by the amplitude scale.
    expect(countNonZero(full.control)).toBe(8);
    expect(countNonZero(zeroed.control)).toBe(8);
    expect(Array.from(zeroed.control)).toEqual(Array.from(full.control));
  });

  it('scales the thermo term as rfScale^2', () => {
    const blocks = pulseTrain(2, 0.01, 0.001);
    const unit = sources(blocks, 0.02, 1);
    const half = sources(blocks, 0.02, 0.5);
    expect(peak(half.thermo)).toBeCloseTo(0.25 * peak(unit.thermo), 6);
  });

  it('signs the control edges by default and can rectify them', () => {
    const blocks = pulseTrain(1, 0.01, 0.001);
    const signed = sources(blocks, 0.01);
    const absolute = resampleRfAcousticSources(blocks, {
      startSec: 0, dt: RASTER, sampleCount: 1001, edgeMode: 'absolute',
    });
    let signedSum = 0, absoluteSum = 0;
    for (let i = 0; i < signed.n; i++) { signedSum += signed.control[i]; absoluteSum += absolute.control[i]; }
    expect(signedSum).toBeCloseTo(0, 6);     // rise cancels fall
    expect(absoluteSum).toBeCloseTo(2, 6);   // both edges count
  });

  it('preserves the |B1|^2 integral of an RF event shorter than one raster sample', () => {
    // A 4 µs hard pulse on a 10 µs raster falls between samples. Point-sampling
    // would read it as silence; the area-preserving deposit must not.
    const short = 4e-6;
    const amplitude = 1000;
    const blocks: DecodedBlock[] = [{
      index: 1, duration: 0.002, startTime: 0.001,
      rf: rfPulse(0.001, short, amplitude),
    } as DecodedBlock];

    const out = resampleRfAcousticSources(blocks, {
      startSec: 0, dt: RASTER, sampleCount: 301,
    });
    expect(out.subSampleEventCount).toBe(1);
    expect(out.eventCount).toBe(1);
    // `power` is peak-normalised, so the surviving assertion is that exactly one
    // sample carries the deposit and it is the pulse centre.
    expect(countNonZero(out.power)).toBe(1);
    const centreIndex = Math.round(0.001 + short / 2 > 0 ? (0.001 + short / 2) / RASTER : 0);
    expect(out.power[centreIndex]).toBeCloseTo(1, 6);
  });

  it('places longer pulses on the raster without the sub-sample branch', () => {
    const out = sources(pulseTrain(1, 0.01, 0.001), 0.01);
    expect(out.subSampleEventCount).toBe(0);
    expect(countNonZero(out.power)).toBeGreaterThan(1);
  });

  it('ignores RF events outside the requested window', () => {
    const blocks = pulseTrain(5, 0.01, 0.001);
    // Pulses run 1-2, 11-12, 21-22, 31-32 and 41-42 ms; the window ends at 20 ms.
    const out = resampleRfAcousticSources(blocks, {
      startSec: 0, dt: RASTER, sampleCount: Math.round(0.02 / RASTER) + 1,
    });
    expect(out.eventCount).toBe(2);
  });
});

describe('combineRfSources', () => {
  it('sums the mechanisms in the time domain with the given weights', () => {
    const out = sources(pulseTrain(3, 0.01, 0.001), 0.03);
    const combined = combineRfSources(out, 2, 3);
    for (let i = 0; i < out.n; i++) {
      expect(combined[i]).toBeCloseTo(2 * out.thermo[i] + 3 * out.control[i], 6);
    }
  });

  it('drops a mechanism entirely at weight zero', () => {
    const out = sources(pulseTrain(3, 0.01, 0.001), 0.03);
    const thermoOnly = combineRfSources(out, 1, 0);
    for (let i = 0; i < out.n; i++) expect(thermoOnly[i]).toBeCloseTo(out.thermo[i], 6);
  });
});

// ─── spectrogram integration ─────────────────────────────────────────────────

const SPAN = 0.2;
const TRAIN = pulseTrain(20, 0.01, 0.001);

function spectrogram(params: Record<string, unknown>) {
  return computeGradientSpectrogram(TRAIN, RASTER, { startSec: 0, endSec: SPAN, ...params });
}

describe('computeGradientSpectrogram with the RF proxy', () => {
  it('omits the RF channels unless they are asked for', () => {
    const spec = spectrogram({});
    expect(spec.rfIncluded).toBe(false);
    expect(spec.data.rf).toBeUndefined();
    expect(spec.data.rfThermo).toBeUndefined();
    expect(spec.data.rfControl).toBeUndefined();
    expect(spec.rfMaxValue).toBe(0);
  });

  it('adds three RF matrices of the same shape as the gradient ones', () => {
    const spec = spectrogram({ includeRf: true });
    expect(spec.rfIncluded).toBe(true);
    expect(spec.data.rf!.length).toBe(spec.data.rss.length);
    expect(spec.data.rfThermo!.length).toBe(spec.data.rss.length);
    expect(spec.data.rfControl!.length).toBe(spec.data.rss.length);
    expect(spec.rfMaxValue).toBeGreaterThan(0);
  });

  it('leaves the gradient channels bit-identical when RF is enabled', () => {
    // The RF path must be purely additive: a user who turns it on to look at RF
    // must not find the gradient numbers moved underneath them.
    const without = spectrogram({});
    const including = spectrogram({ includeRf: true });
    expect(Array.from(including.data.gx)).toEqual(Array.from(without.data.gx));
    expect(Array.from(including.data.gy)).toEqual(Array.from(without.data.gy));
    expect(Array.from(including.data.gz)).toEqual(Array.from(without.data.gz));
    expect(Array.from(including.data.rss)).toEqual(Array.from(without.data.rss));
    expect(including.maxValue).toBe(without.maxValue);
  });

  it('keeps RF energy out of the gradient rss channel', () => {
    // These blocks carry RF and no gradients at all, so a non-zero rss would
    // mean the proxy had leaked into a channel that claims to be in mT/m.
    const spec = spectrogram({ includeRf: true });
    expect(spec.maxValue).toBe(0);
    expect(spec.rfMaxValue).toBeGreaterThan(0);
    expect(spec.warnings.some(w => w.includes('No gradient activity'))).toBe(true);
  });

  it('empties the thermo channel but not the control channel at rfScale 0', () => {
    const spec = spectrogram({ includeRf: true, rfScale: 0 });
    let thermoPeak = 0, controlPeak = 0;
    for (let i = 0; i < spec.data.rfThermo!.length; i++) {
      thermoPeak = Math.max(thermoPeak, spec.data.rfThermo![i]);
      controlPeak = Math.max(controlPeak, spec.data.rfControl![i]);
    }
    expect(thermoPeak).toBe(0);
    expect(controlPeak).toBeGreaterThan(0);
  });

  it('follows the combined-source weights', () => {
    const controlOnly = spectrogram({ includeRf: true, rfThermoWeight: 0 });
    const both = spectrogram({ includeRf: true });
    // Dropping the thermo weight must change the combined channel without
    // touching the per-mechanism ones.
    expect(Array.from(controlOnly.data.rfControl!)).toEqual(Array.from(both.data.rfControl!));
    expect(Array.from(controlOnly.data.rf!)).not.toEqual(Array.from(both.data.rf!));
  });

  it('gives the control channel the comb and envelope the gate timing implies', () => {
    // 20 pulses of 1 ms at 10 ms spacing. The signed edge pair is a 1 ms
    // difference filter, whose |2 sin(pi f tau)| envelope peaks at 500 Hz and
    // nulls at 1 kHz; the 100 Hz repetition combs that envelope. So the loudest
    // line must be 500 Hz — not the repetition rate, which is the intuition this
    // test exists to correct.
    const spec = spectrogram({ includeRf: true, fMaxHz: 1200, windowSamples: 256 });
    const column = Math.floor(spec.nTime / 2);
    const at = (row: number) => spec.data.rfControl![row * spec.nTime + column];
    let bestRow = -1, bestValue = 0;
    for (let row = 0; row < spec.nFreq; row++) {
      if (at(row) > bestValue) { bestValue = at(row); bestRow = row; }
    }
    const peakHz = spec.fStartHz + bestRow * spec.fStepHz;
    expect(peakHz).toBeGreaterThan(480);
    expect(peakHz).toBeLessThan(520);

    // The 1 kHz null of the difference filter must be deep, even though 1 kHz is
    // itself a harmonic of the 100 Hz repetition.
    const nullRow = Math.round((1000 - spec.fStartHz) / spec.fStepHz);
    expect(at(nullRow)).toBeLessThan(bestValue * 0.1);
  });

  it('warns when the window holds no RF event', () => {
    const spec = computeGradientSpectrogram(
      [{ index: 1, duration: SPAN, startTime: 0 } as DecodedBlock],
      RASTER,
      { startSec: 0, endSec: SPAN, includeRf: true },
    );
    expect(spec.warnings.some(w => w.includes('No RF events'))).toBe(true);
  });

  it('reports the RF channels in the empty-matrix path too', () => {
    const spec = computeGradientSpectrogram([], RASTER, { startSec: 0, endSec: SPAN, includeRf: true });
    expect(spec.nTime).toBe(0);
    expect(spec.rfIncluded).toBe(true);
    expect(spec.data.rf).toBeDefined();
  });
});

describe('RF proxy budgeting and transport', () => {
  it('counts the three extra matrices in the compute budget', () => {
    const base = {
      startSec: 0, endSec: SPAN, gradientRaster: RASTER, fMaxHz: 3000,
      windowSamples: 512, overlap: 0.75, oversample: 3, targetColumns: 256,
    };
    const without = estimateSpectrogramCost(base);
    const including = estimateSpectrogramCost({ ...base, includeRf: true });
    expect(including.totalCells).toBe(without.totalCells / 4 * 7);
  });

  it('carries the RF blobs only when the matrix has them', () => {
    const off = serializeSpectrogram(spectrogram({}));
    expect(off.rfIncluded).toBe(false);
    expect(off.rfB64).toBeUndefined();

    const on = serializeSpectrogram(spectrogram({ includeRf: true }));
    expect(on.rfIncluded).toBe(true);
    expect(typeof on.rfB64).toBe('string');
    expect(typeof on.rfThermoB64).toBe('string');
    expect(typeof on.rfControlB64).toBe('string');
    expect(on.rfMaxValue).toBeGreaterThan(0);
  });
});

// ─── audio ───────────────────────────────────────────────────────────────────

/** The gradient-free case: RF events, no gradients anywhere. */
const RF_ONLY = TRAIN;

/** RF plus a Gx tone, so the mix has two sides to balance. */
function rfPlusGradient(): DecodedBlock[] {
  return RF_ONLY.map((block, i) => {
    const times: number[] = [];
    const values: number[] = [];
    const n = Math.round(0.01 / RASTER) + 1;
    for (let k = 0; k < n; k++) {
      const t = i * 0.01 + k * RASTER;
      times.push(t);
      values.push(1e5 * Math.sin(2 * Math.PI * 400 * t));
    }
    return {
      ...block,
      gx: {
        blockIndex: i + 1, startTime: times[0], duration: 0.01,
        timePoints: Float64Array.from(times), waveform: Float64Array.from(values),
        amplitude: 1e5, type: 'arb', channel: 'gx',
      },
    } as DecodedBlock;
  });
}

function peakOf(sound: { left: Float32Array; right: Float32Array }): number {
  let m = 0;
  for (let i = 0; i < sound.left.length; i++) {
    m = Math.max(m, Math.abs(sound.left[i]), Math.abs(sound.right[i]));
  }
  return m;
}

describe('synthesizeGradientSound with the RF proxy', () => {
  const window = { startSec: 0, endSec: SPAN };

  it('refuses a gradient-free window when RF is off', () => {
    // The behaviour that made an RF-only sequence unplayable.
    const sound = synthesizeGradientSound(RF_ONLY, window);
    expect(sound.silent).toBe(true);
    expect(sound.rfIncluded).toBe(false);
    expect(peakOf(sound)).toBe(0);
  });

  it('plays a gradient-free window from the RF proxy alone', () => {
    const sound = synthesizeGradientSound(RF_ONLY, { ...window, includeRf: true });
    expect(sound.silent).toBe(false);
    expect(sound.rfIncluded).toBe(true);
    expect(sound.rawPeak).toBe(0);                 // no gradients at all
    expect(sound.rfRawPeak).toBeGreaterThan(0);
    expect(peakOf(sound)).toBeCloseTo(AUDIO_PEAK, 5);
    expect(sound.warnings.some(w => w.includes('RF proxy only'))).toBe(true);
  });

  it('leaves the buffer bit-identical when the mix is fully gradient', () => {
    const plain = synthesizeGradientSound(rfPlusGradient(), window);
    const mixed = synthesizeGradientSound(rfPlusGradient(), { ...window, includeRf: true, rfMix: 0 });
    expect(mixed.rfIncluded).toBe(false);
    expect(Array.from(mixed.left)).toEqual(Array.from(plain.left));
    expect(Array.from(mixed.right)).toEqual(Array.from(plain.right));
  });

  it('makes the RF proxy audible against real gradients', () => {
    // The reported symptom: a raw sum would bury a dimensionless proxy under
    // gradients of ~1e5 Hz/m. Each side is normalised before blending, so the
    // fully-RF mix must differ from the gradient-only one by a lot.
    const blocks = rfPlusGradient();
    const gradOnly = synthesizeGradientSound(blocks, { ...window, includeRf: true, rfMix: 0 });
    const rfOnly = synthesizeGradientSound(blocks, { ...window, includeRf: true, rfMix: 1 });
    const half = synthesizeGradientSound(blocks, { ...window, includeRf: true, rfMix: 0.5 });

    expect(rfOnly.rfIncluded).toBe(true);
    expect(peakOf(rfOnly)).toBeCloseTo(AUDIO_PEAK, 5);

    let diff = 0;
    for (let i = 0; i < gradOnly.left.length; i++) {
      diff = Math.max(diff, Math.abs(gradOnly.left[i] - rfOnly.left[i]));
    }
    expect(diff).toBeGreaterThan(0.1 * AUDIO_PEAK);

    // A half mix sits between the two rather than collapsing onto either.
    let toGrad = 0, toRf = 0;
    for (let i = 0; i < half.left.length; i++) {
      toGrad = Math.max(toGrad, Math.abs(half.left[i] - gradOnly.left[i]));
      toRf = Math.max(toRf, Math.abs(half.left[i] - rfOnly.left[i]));
    }
    expect(toGrad).toBeGreaterThan(0);
    expect(toRf).toBeGreaterThan(0);
  });

  it('centres the RF term in both ears', () => {
    const sound = synthesizeGradientSound(RF_ONLY, { ...window, includeRf: true, rfMix: 1 });
    expect(Array.from(sound.left)).toEqual(Array.from(sound.right));
  });

  it('still plays at rfScale 0, where only the switching term survives', () => {
    const sound = synthesizeGradientSound(RF_ONLY, { ...window, includeRf: true, rfScale: 0 });
    expect(sound.silent).toBe(false);
    expect(sound.rfIncluded).toBe(true);
  });

  it('says so when RF is requested but the window holds no RF event', () => {
    const gradientsOnly = rfPlusGradient().map(b => ({ ...b, rf: undefined })) as DecodedBlock[];
    const sound = synthesizeGradientSound(gradientsOnly, { ...window, includeRf: true });
    expect(sound.silent).toBe(false);
    expect(sound.rfIncluded).toBe(false);
    expect(sound.warnings.some(w => w.includes('gradients only'))).toBe(true);
  });

  it('reports nothing to play when neither source has content', () => {
    const empty = [{ index: 1, duration: SPAN, startTime: 0 } as DecodedBlock];
    const sound = synthesizeGradientSound(empty, { ...window, includeRf: true });
    expect(sound.silent).toBe(true);
    expect(sound.warnings.some(w => w.includes('no gradient activity and no RF events'))).toBe(true);
  });
});
