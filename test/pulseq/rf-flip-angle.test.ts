import { describe, expect, it } from 'vitest';

import { decodeAllBlocks } from '../../src/pulseq/decoder';
import { parseSequenceText } from '../../src/pulseq/reader';
import {
  analyzeRfResponse,
  estimateRfCarrierAreaDeg,
  MAX_RF_RESPONSE_SAMPLES,
} from '../../src/pulseq/rfResponse';
import type { PulseqSequence } from '../../src/pulseq/types';

function twoSampleRfSequence(phaseDerivative: number, frequencyOffset = 0, phaseOffset = 0): string {
  return `
[VERSION]
major 1
minor 5
revision 1

[DEFINITIONS]
AdcRasterTime 1e-7
GradientRasterTime 1e-5
RadiofrequencyRasterTime 1e-6
BlockDurationRaster 1e-5

[BLOCKS]
1 10 1 0 0 0 0 0

[RF]
1 125000 1 2 0 -1 0 0 0 ${frequencyOffset} ${phaseOffset} e

[SHAPES]
shape_id 1
num_samples 2
1
1

shape_id 2
num_samples 2
0
${phaseDerivative}
`;
}

describe('RF response estimation', () => {
  it('matches the Pulseq complex RF area and spinor rotation for a uniform 90-degree pulse', () => {
    const sequence = parseSequenceText(twoSampleRfSequence(0));
    const rf = sequence.rfs.get(1)!;
    const response = analyzeRfResponse(rf, sequence, 'e');

    expect(estimateRfCarrierAreaDeg(rf, sequence)).toBeCloseTo(90, 10);
    expect(response.carrierAreaDeg).toBeCloseTo(90, 10);
    expect(response.bands).toHaveLength(1);
    expect(response.bands[0].frequencyOffsetHz).toBeCloseTo(0, 8);
    expect(response.bands[0].polarFlipDeg).toBeCloseTo(90, 8);
    expect(response.bands[0].mz).toBeCloseTo(0, 8);
    expect(decodeAllBlocks(sequence)[0].rf?.response.carrierAreaDeg).toBeCloseTo(90, 10);
  });

  it('uses complex phase cancellation rather than integrating RF magnitude', () => {
    const sequence = parseSequenceText(twoSampleRfSequence(0.5));
    const rf = sequence.rfs.get(1)!;

    expect(estimateRfCarrierAreaDeg(rf, sequence)).toBeCloseTo(0, 10);
  });

  it('does not fold carrier frequency or constant phase offsets into the nominal estimate', () => {
    const sequence = parseSequenceText(twoSampleRfSequence(0, 2500, Math.PI / 3));
    const decoded = decodeAllBlocks(sequence)[0].rf!;

    expect(decoded.response.carrierAreaDeg).toBeCloseTo(90, 10);
    expect(decoded.freqOffset).toBe(2500);
    expect(decoded.phaseOffset).toBeCloseTo(Math.PI / 3, 12);
  });

  it('recovers both symmetric MB2 bands when the carrier integral cancels', () => {
    const sequence = parseSequenceText(twoSampleRfSequence(0));
    const samples = 9000;
    const dwell = 1e-6;
    const bandFrequency = 4444.444444444444;
    const singleBandAmplitude = 90 / (360 * samples * dwell);
    const signal = Array.from({ length: samples }, (_, index) => {
      const time = (index + 0.5) * dwell;
      return 2 * singleBandAmplitude * Math.cos(2 * Math.PI * bandFrequency * time);
    });
    setRfSignal(sequence, signal, new Array(samples).fill(0), 'e');

    const response = analyzeRfResponse(sequence.rfs.get(1)!, sequence, 'e');

    expect(response.carrierAreaDeg).toBeLessThan(0.05);
    expect(response.bands).toHaveLength(2);
    expect(response.bands[0].frequencyOffsetHz).toBeCloseTo(-bandFrequency, -1);
    expect(response.bands[1].frequencyOffsetHz).toBeCloseTo(bandFrequency, -1);
    for (const band of response.bands) {
      expect(band.spectralAreaDeg).toBeCloseTo(90, 1);
      expect(band.polarFlipDeg).toBeGreaterThan(89);
      expect(band.polarFlipDeg).toBeLessThan(91);
    }
  });

  it('reports adiabatic inversion action separately from its carrier area', () => {
    const sequence = parseSequenceText(twoSampleRfSequence(0));
    sequence.rasterTimes.rfRaster = 10e-6;
    const signal = makeHypsecSignal();
    setRfSignal(
      sequence,
      signal.map(value => value.real),
      signal.map(value => value.imaginary),
      'i',
    );

    const response = analyzeRfResponse(sequence.rfs.get(1)!, sequence, 'i');

    expect(response.carrierAreaDeg).toBeCloseTo(287.145, 2);
    expect(response.bands).toHaveLength(1);
    expect(response.bands[0].frequencyOffsetHz).toBe(0);
    expect(response.bands[0].polarFlipDeg).toBeCloseTo(175.95, 1);
    expect(response.bands[0].mz).toBeCloseTo(-0.9975, 3);
  });

  it('reuses one response object for repeated references to an RF library entry', () => {
    const sequence = parseSequenceText(twoSampleRfSequence(0));
    sequence.blocks.push({ ...sequence.blocks[0], num: 2 });

    const decoded = decodeAllBlocks(sequence);

    expect(decoded).toHaveLength(2);
    expect(decoded[0].rf?.response).toBe(decoded[1].rf?.response);
  });

  it('falls back to streaming carrier area above the response-analysis sample ceiling', () => {
    const sequence = parseSequenceText(twoSampleRfSequence(0));
    const samples = MAX_RF_RESPONSE_SAMPLES + 1;
    sequence.shapes.set(1, {
      numSamples: samples,
      samples: new Float64Array(samples).fill(1),
    });
    sequence.shapes.set(2, {
      numSamples: samples,
      samples: new Float64Array(samples),
    });
    sequence.rfs.get(1)!.amplitude = 1;

    const response = analyzeRfResponse(sequence.rfs.get(1)!, sequence, 'e');

    expect(response.limited).toBe(true);
    expect(response.spectrumAnalyzed).toBe(false);
    expect(response.bands).toHaveLength(0);
    expect(response.carrierAreaDeg).toBeCloseTo(360 * samples * 1e-6, 10);
  });
});

function setRfSignal(
  sequence: PulseqSequence,
  real: number[],
  imaginary: number[],
  use: string,
): void {
  const peak = Math.max(...real.map((value, index) => Math.hypot(value, imaginary[index])));
  const magnitude = real.map((value, index) => Math.hypot(value, imaginary[index]) / peak);
  const phase = real.map((value, index) => Math.atan2(imaginary[index], value) / (2 * Math.PI));
  sequence.shapes.set(1, { numSamples: real.length, samples: Float64Array.from(magnitude) });
  sequence.shapes.set(2, { numSamples: real.length, samples: Float64Array.from(phase) });
  const rf = sequence.rfs.get(1)!;
  rf.amplitude = peak;
  rf.use = use;
}

function makeHypsecSignal(): Array<{ real: number; imaginary: number }> {
  const samples = 1024;
  const dwell = 10e-6;
  const duration = 10.24e-3;
  const beta = 800;
  const mu = 4.9;
  const adiabaticity = 4;
  const amplitudeModulation = new Float64Array(samples);
  const frequencyModulation = new Float64Array(samples);
  const phaseModulation = new Float64Array(samples);

  for (let index = 0; index < samples; index++) {
    const time = (index - samples / 2) / samples * duration;
    amplitudeModulation[index] = 1 / Math.cosh(beta * time);
    frequencyModulation[index] = -mu * beta * Math.tanh(beta * time);
    phaseModulation[index] = frequencyModulation[index] * dwell
      + (index > 0 ? phaseModulation[index - 1] : 0);
  }

  const center = samples / 2;
  const rate = Math.abs(frequencyModulation[center + 1] - frequencyModulation[center - 1]) / (2 * dwell);
  const amplitude = Math.sqrt(rate * adiabaticity) / (2 * Math.PI * amplitudeModulation[center]);
  const centerPhase = phaseModulation[center];
  return Array.from({ length: samples }, (_, index) => {
    const phase = phaseModulation[index] - centerPhase;
    const magnitude = amplitude * amplitudeModulation[index];
    return { real: magnitude * Math.cos(phase), imaginary: magnitude * Math.sin(phase) };
  });
}
