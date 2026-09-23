/**
 * The viewer's ADC trajectory must be the exported one, rounded — nothing else.
 *
 * Both viewers render from Float32 regardless: the browser converts at GPU
 * upload, the extension at transport. Producing Float32 directly removes a
 * Float64 stage and its conversion copy, which is worth about 800 MB on a
 * 33 M-sample trajectory, and it must not change a single displayed value.
 *
 * The numeric baselines in kspace-baseline.test.ts go through the export path
 * and so never exercise what the viewer receives. This pins that separately,
 * and pins it harder than a tolerance: every sample has to equal the
 * full-precision result rounded to Float32, exactly.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { decodeAllBlocks, getTotalDuration } from '../../src/pulseq/decoder';
import { calculateKspace } from '../../src/pulseq/kspace';
import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';

const fixtures = [
    'test/seqeyes_demo_seq_files/writeEpi.seq',
    'test/kspace_baselines/v151_gre/seq/writeGradientEcho.seq',
    'test/seqeyes_demo_seq_files/writeRadialGradientEcho_rotExt.seq',
];

describe('viewer ADC precision', () => {
    it.each(fixtures)('is the exported trajectory rounded to Float32 for %s', (fixture) => {
        const seq = parseSequenceBytes(new Uint8Array(readFileSync(resolve(fixture))), fixture);
        const blocks = decodeAllBlocks(seq);
        const args = [blocks, seq.rasterTimes.gradientRaster, getTotalDuration(seq), 0] as const;

        const exported = calculateKspace(...args, { rfRaster: seq.rasterTimes.rfRaster });
        const viewer = calculateKspace(...args, {
            rfRaster: seq.rasterTimes.rfRaster,
            adcPrecision: 'f32',
            maxTrajectoryPoints: 30_000,
        });
        expect(exported).toBeTruthy();
        expect(viewer).toBeTruthy();
        if (!exported || !viewer) throw new Error('unreachable');

        expect(viewer.ktraj_adc[0]).toBeInstanceOf(Float32Array);
        expect(exported.ktraj_adc[0]).toBeInstanceOf(Float64Array);
        expect(viewer.ktraj_adc[0].length).toBe(exported.ktraj_adc[0].length);
        expect(viewer.ktraj_adc[0].length).toBeGreaterThan(0);

        for (let axis = 0; axis < 3; axis++) {
            const shown = viewer.ktraj_adc[axis];
            const exact = exported.ktraj_adc[axis];
            for (let i = 0; i < exact.length; i++) {
                // Exact equality, not a tolerance: the viewer is showing the
                // full-precision answer rounded, or it is showing something else.
                if (shown[i] !== Math.fround(exact[i])) {
                    throw new Error(
                        `axis ${axis} sample ${i}: viewer ${shown[i]} != fround(${exact[i]})`,
                    );
                }
            }
        }

        // ADC times keep full precision either way; Float32 resolves to only
        // ~30 us at the end of a long sequence, which the window culling needs.
        expect(viewer.t_adc).toBeInstanceOf(Float64Array);
        expect(Array.from(viewer.t_adc)).toEqual(Array.from(exported.t_adc));
    });
});
