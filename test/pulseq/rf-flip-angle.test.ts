import { describe, expect, it } from 'vitest';

import { decodeAllBlocks } from '../../src/pulseq/decoder';
import { parseSequenceText } from '../../src/pulseq/reader';
import { estimateNominalRfFlipAngleDeg } from '../../src/pulseq/rfClassification';

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

describe('nominal RF flip-angle estimation', () => {
  it('matches the Pulseq complex RF area convention for a uniform 90-degree pulse', () => {
    const sequence = parseSequenceText(twoSampleRfSequence(0));
    const rf = sequence.rfs.get(1)!;

    expect(estimateNominalRfFlipAngleDeg(rf, sequence)).toBeCloseTo(90, 10);
    expect(decodeAllBlocks(sequence)[0].rf?.flipAngleDeg).toBeCloseTo(90, 10);
  });

  it('uses complex phase cancellation rather than integrating RF magnitude', () => {
    const sequence = parseSequenceText(twoSampleRfSequence(0.5));
    const rf = sequence.rfs.get(1)!;

    expect(estimateNominalRfFlipAngleDeg(rf, sequence)).toBeCloseTo(0, 10);
  });

  it('does not fold carrier frequency or constant phase offsets into the nominal estimate', () => {
    const sequence = parseSequenceText(twoSampleRfSequence(0, 2500, Math.PI / 3));
    const decoded = decodeAllBlocks(sequence)[0].rf!;

    expect(decoded.flipAngleDeg).toBeCloseTo(90, 10);
    expect(decoded.freqOffset).toBe(2500);
    expect(decoded.phaseOffset).toBeCloseTo(Math.PI / 3, 12);
  });
});
