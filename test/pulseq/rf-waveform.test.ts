import { describe, expect, it } from 'vitest';

import { parseSequenceText } from '../../src/pulseq/reader';
import { decodeAllBlocks } from '../../src/pulseq/decoder';
import { analyzeRfResponse, estimateRfCarrierAreaDeg } from '../../src/pulseq/rfResponse';
import {
    rasterCellCount,
    rasterCellsFromShapes,
    rfRasterCells,
    rfShapeDuration,
} from '../../src/pulseq/rfWaveform';

const RASTER = 1e-6;

function v151(body: string): string {
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
${body}`;
}

/**
 * The same 90° block pulse written both ways: 100 held samples, and the two
 * breakpoints upstream makeBlockPulse writes (t = [0; N]·Δ).
 */
function blockPulses() {
    const n = 100;
    const amplitude = 0.25 / (n * RASTER);       // 2500 Hz → 90°
    const uniform = parseSequenceText(v151(`
[BLOCKS]
1 20 1 0 0 0 0 0

[RF]
1 ${amplitude} 1 0 0 50 0 0 0 0 0 e

[SHAPES]
shape_id 1
num_samples ${n}
${Array(n).fill('1').join('\n')}
`));
    const breakpoints = parseSequenceText(v151(`
[BLOCKS]
1 20 1 0 0 0 0 0

[RF]
1 ${amplitude} 1 0 2 50 0 0 0 0 0 e

[SHAPES]
shape_id 1
num_samples 2
1
1

shape_id 2
num_samples 2
0
${n}
`));
    return { n, amplitude, uniform, breakpoints };
}

describe('RF waveform semantics', () => {
    it('gives a two-breakpoint block pulse the same duration as the held one', () => {
        const { n, uniform, breakpoints } = blockPulses();
        const [u] = decodeAllBlocks(uniform);
        const [b] = decodeAllBlocks(breakpoints);
        expect(u.rf!.duration).toBeCloseTo(n * RASTER, 15);
        expect(b.rf!.duration).toBeCloseTo(n * RASTER, 15);
    });

    it('gives both forms the same area and flip angle — no extra raster cell', () => {
        const { uniform, breakpoints } = blockPulses();
        const ru = uniform.rfs.get(1)!;
        const rb = breakpoints.rfs.get(1)!;
        expect(estimateRfCarrierAreaDeg(ru, uniform)).toBeCloseTo(90, 9);
        expect(estimateRfCarrierAreaDeg(rb, breakpoints)).toBeCloseTo(90, 9);
        const au = analyzeRfResponse(ru, uniform);
        const ab = analyzeRfResponse(rb, breakpoints);
        expect(au.carrierAreaDeg).toBeCloseTo(90, 9);
        expect(ab.carrierAreaDeg).toBeCloseTo(90, 9);
        expect(ab.bands[0].polarFlipDeg).toBeCloseTo(au.bands[0].polarFlipDeg, 9);
        expect(ab.bands[0].polarFlipDeg).toBeCloseTo(90, 6);
    });

    it('integrates a linear ramp as a trapezoid', () => {
        const cells = rasterCellsFromShapes({
            raster: RASTER, magnitude: [0, 1], phaseCycles: null, timeShape: [0, 10],
        });
        expect(cells.count).toBe(10);
        const area = cells.magnitude.reduce((sum, m, i) => sum + m * cells.width[i], 0);
        expect(area).toBeCloseTo(0.5 * 10 * RASTER, 15);
        // Cell means of the ramp sit at the cell centres.
        expect(cells.magnitude[0]).toBeCloseTo(0.05, 12);
        expect(cells.magnitude[9]).toBeCloseTo(0.95, 12);
    });

    it('starts cells at the first breakpoint, which need not be zero', () => {
        const shapes = { raster: RASTER, magnitude: [1, 1], phaseCycles: null, timeShape: [3, 8] };
        const cells = rasterCellsFromShapes(shapes);
        expect(cells.count).toBe(5);
        expect(cells.start[0]).toBeCloseTo(3 * RASTER, 15);
        expect(rfShapeDuration(shapes)).toBeCloseTo(8 * RASTER, 15);
        expect(rasterCellCount(shapes)).toBe(5);
    });

    it('interpolates phase linearly between breakpoints', () => {
        const cells = rasterCellsFromShapes({
            raster: RASTER, magnitude: [1, 1, 1], phaseCycles: [0, 0.5, 0.5], timeShape: [0, 4, 6],
        });
        expect(cells.count).toBe(6);
        expect(Array.from(cells.phaseCycles)).toEqual([0.0625, 0.1875, 0.3125, 0.4375, 0.5, 0.5]);
    });

    it('keeps uniform samples held one raster each', () => {
        const shapes = { raster: RASTER, magnitude: [0.2, 0.4, 0.6], phaseCycles: [0, 0.1, 0.2], timeShape: null };
        const cells = rasterCellsFromShapes(shapes);
        expect(cells.uniform).toBe(true);
        expect(Array.from(cells.start)).toEqual([0, RASTER, 2 * RASTER]);
        expect(Array.from(cells.magnitude)).toEqual([0.2, 0.4, 0.6]);
        expect(rfShapeDuration(shapes)).toBeCloseTo(3 * RASTER, 15);
    });

    it('reads the first channel of a pTx-Pulseq layout', () => {
        const seq = parseSequenceText(v151(`
[BLOCKS]
1 20 1 0 0 0 0 0

[RF]
1 1000 1 0 2 0 0 0 0 0 0 e

[SHAPES]
shape_id 1
num_samples 4
1
1
0.5
0.5

shape_id 2
num_samples 4
0
10
0
10
`));
        const cells = rfRasterCells(seq.rfs.get(1)!, seq);
        expect(cells.count).toBe(10);
        expect(Array.from(new Set(cells.magnitude))).toEqual([1]);
    });
});
