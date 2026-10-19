import { describe, expect, it } from 'vitest';

import { parseSequenceText } from '../../src/pulseq/reader';
import { decodeAllBlocks, detectPtxTimeShapeChannels } from '../../src/pulseq/decoder';
import { decodeLabel } from '../../src/pulseq/readerShared';
import { classifyRfUse } from '../../src/pulseq/rfClassification';
import { calculateKspace } from '../../src/pulseq/kspace';

const DEFINITIONS = `
[DEFINITIONS]
AdcRasterTime 1e-7
GradientRasterTime 1e-5
RadiofrequencyRasterTime 1e-6
BlockDurationRaster 1e-5
`;

function v151(body: string): string {
    return `
[VERSION]
major 1
minor 5
revision 1
${DEFINITIONS}
${body}`;
}

/** One RF block per use letter, sharing a 4-sample block pulse. */
function rfUseSequence(uses: string[]): string {
    const blocks = uses.map((_, i) => `${i + 1} 100 ${i + 1} 0 0 0 0 0`).join('\n');
    const rfs = uses.map((use, i) => `${i + 1} 2500 1 0 0 2 0 0 0 0 0 ${use}`).join('\n');
    return v151(`
[BLOCKS]
${blocks}

[RF]
${rfs}

[SHAPES]
shape_id 1
num_samples 4
1
1
1
1
`);
}

describe('parser prerequisites for simulation', () => {
    it('accepts every upstream RF use letter, including preparation and other', () => {
        const uses = ['e', 'r', 'i', 's', 'p', 'o', 'u'];
        const seq = parseSequenceText(rfUseSequence(uses));
        expect([...seq.rfs.values()].map(rf => rf.use)).toEqual(uses);
        // v1.5 tags other than 'u' pass straight through the classifier.
        for (const rf of seq.rfs.values()) {
            if (rf.use !== 'u') expect(classifyRfUse(rf, seq)).toBe(rf.use);
        }
    });

    it('still rejects RF use letters outside the upstream set', () => {
        expect(() => parseSequenceText(rfUseSequence(['x']))).toThrow(/invalid use flag 'x'/);
    });

    it('keeps preparation and other pulses out of the k-space excitation and refocusing rules', () => {
        // 'p'/'o' must neither reset nor negate the displayed trajectory, matching
        // upstream calculateKspacePP, which only acts on excitation/refocusing/undefined.
        const seq = parseSequenceText(rfUseSequence(['p', 'o']));
        const blocks = decodeAllBlocks(seq);
        expect(blocks.map(block => block.rf?.use)).toEqual(['p', 'o']);
        expect(() => calculateKspace(blocks, seq.rasterTimes.gradientRaster, 0.002, 0)).not.toThrow();
    });

    it('decodes TRID as a known label', () => {
        expect(decodeLabel('TRID')).toEqual({ labelId: 11, flagId: 0 });
    });

    it('carries the ADC phase-modulation shape (radians, shared with the shape library)', () => {
        const seq = parseSequenceText(v151(`
[BLOCKS]
1 100 0 0 0 0 1 0

[ADC]
1 4 1000 10 0 0 0 0.5 3

[SHAPES]
shape_id 3
num_samples 4
0.1
-0.2
0.3
0.05
`));
        const [block] = decodeAllBlocks(seq);
        expect(block.adc?.phaseOffset).toBe(0.5);
        expect(Array.from(block.adc?.phaseModulation ?? [])).toEqual([0.1, -0.2, 0.3, 0.05]);
        expect(block.adc?.phaseModulation).toBe(seq.shapes.get(3)?.samples);
    });

    it('leaves phaseModulation absent when the ADC has no modulation shape', () => {
        const seq = parseSequenceText(v151(`
[BLOCKS]
1 100 0 0 0 0 1 0

[ADC]
1 4 1000 10 0 0 0 0 0
`));
        const [block] = decodeAllBlocks(seq);
        expect(block.adc).toBeDefined();
        expect(block.adc?.phaseModulation).toBeUndefined();
    });

    it('carries the trigger type so input and output triggers stay distinguishable', () => {
        const seq = parseSequenceText(v151(`
[BLOCKS]
1 100 0 0 0 0 0 1
2 100 0 0 0 0 0 2

[EXTENSIONS]
1 1 1 0
2 1 2 0

extension TRIGGERS 1
1 1 3 10 20
2 2 1 0 100
`));
        const blocks = decodeAllBlocks(seq);
        expect(blocks[0].triggers?.[0]).toMatchObject({ triggerType: 1, channel: 3 });
        expect(blocks[1].triggers?.[0]).toMatchObject({ triggerType: 2, channel: 1 });
    });

    describe('pTx-Pulseq time shapes', () => {
        it('counts channels when every channel repeats the same time base', () => {
            expect(detectPtxTimeShapeChannels([0, 1, 2, 0, 1, 2, 0, 1, 2])).toBe(3);
            expect(detectPtxTimeShapeChannels([0.5, 1.5, 0.5, 1.5])).toBe(2);
        });

        it('returns 0 for ordinary single-channel time shapes', () => {
            expect(detectPtxTimeShapeChannels([0, 1, 2, 3])).toBe(0);
            expect(detectPtxTimeShapeChannels([0])).toBe(0);
            expect(detectPtxTimeShapeChannels([])).toBe(0);
        });

        it('returns 0 when the repeated sections do not share one time base', () => {
            expect(detectPtxTimeShapeChannels([0, 1, 2, 0, 1, 3])).toBe(0);
            expect(detectPtxTimeShapeChannels([0, 1, 0, 1, 2])).toBe(0);
        });

        it('flags a decoded RF event that uses the convention', () => {
            const seq = parseSequenceText(v151(`
[BLOCKS]
1 100 1 0 0 0 0 0

[RF]
1 1000 1 0 2 0 0 0 0 0 0 e

[SHAPES]
shape_id 1
num_samples 4
1
0.5
1
0.5

shape_id 2
num_samples 4
1
2
1
2
`));
            const [block] = decodeAllBlocks(seq);
            expect(block.rf?.ptxChannels).toBe(2);
        });

        it('does not flag ordinary RF events', () => {
            const seq = parseSequenceText(rfUseSequence(['e']));
            const [block] = decodeAllBlocks(seq);
            expect(block.rf?.ptxChannels).toBeUndefined();
        });
    });
});
