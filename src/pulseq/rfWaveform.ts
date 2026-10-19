/**
 * rfWaveform.ts — what an RF event's shapes mean in time.
 *
 * Pulseq defines two forms, and they are not interchangeable:
 *   - Uniform raster (no time shape): sample i is held for one RF raster
 *     period, [i·Δ, (i+1)·Δ]; the pulse lasts N·Δ.
 *   - Time shape: samples are breakpoints at timeShape[i]·Δ of a piecewise-
 *     linear waveform, and the pulse ends at the last breakpoint. This is how
 *     upstream `makeBlockPulse` writes a block pulse — two points, t = [0; N]·Δ,
 *     shape_dur = t(end) — so treating breakpoints as held samples would add
 *     a spurious raster period (and 1/N of the area).
 *
 * Both forms are reduced here to raster cells, each holding the waveform's
 * mean over the cell: exact for uniform pulses, and exact for breakpoints that
 * sit on the raster (cells then never straddle a breakpoint). Magnitude and
 * phase are interpolated separately, as Pulseq stores them.
 */

import type { PulseqSequence, RFEntry } from './types';

export interface RfRasterCells {
    count: number;
    /** Cell start relative to the RF event start (block start + RF delay) [s]. */
    start: Float64Array;
    /** Cell widths [s]. */
    width: Float64Array;
    /** Normalised magnitude per cell (multiply by the RF amplitude for Hz). */
    magnitude: Float64Array;
    /** Phase per cell [cycles]. */
    phaseCycles: Float64Array;
    /** True when the cells came from uniform raster samples. */
    uniform: boolean;
}

export interface RfShapeArrays {
    raster: number;
    magnitude: ArrayLike<number>;
    phaseCycles: ArrayLike<number> | null;
    /** Breakpoint times in raster units, or null for a uniform raster. */
    timeShape: ArrayLike<number> | null;
}

/** Number of cells `rasterCellsFromShapes` will produce, without building them. */
export function rasterCellCount(shapes: RfShapeArrays): number {
    if (!shapes.timeShape) {
        return Math.min(shapes.magnitude.length, shapes.phaseCycles?.length ?? shapes.magnitude.length);
    }
    const count = breakpointCount(shapes);
    if (count < 2) return count;
    const span = (shapes.timeShape[count - 1] - shapes.timeShape[0]) * shapes.raster;
    return Math.max(1, Math.round(span / shapes.raster));
}

/**
 * Visit every raster cell in time order without allocating:
 * `visit(start, width, magnitude, phaseCycles)`, start relative to the RF event start.
 */
export function forEachRasterCell(
    shapes: RfShapeArrays,
    visit: (start: number, width: number, magnitude: number, phaseCycles: number) => void,
): void {
    const { raster, magnitude, phaseCycles, timeShape } = shapes;
    if (!timeShape) {
        const count = rasterCellCount(shapes);
        for (let i = 0; i < count; i++) visit(i * raster, raster, magnitude[i], phaseCycles ? phaseCycles[i] : 0);
        return;
    }
    const points = breakpointCount(shapes);
    if (points < 2) return;   // a single breakpoint has no extent; nothing is played
    const first = timeShape[0] * raster;
    const last = timeShape[points - 1] * raster;
    const count = Math.max(1, Math.round((last - first) / raster));
    const width = (last - first) / count;
    let k = 0;
    for (let i = 0; i < count; i++) {
        const start = first + i * width;
        const mid = start + 0.5 * width;
        while (k + 1 < points - 1 && timeShape[k + 1] * raster <= mid) k++;
        const t0 = timeShape[k] * raster;
        const t1 = timeShape[k + 1] * raster;
        const u = t1 > t0 ? (mid - t0) / (t1 - t0) : 0;
        const p0 = phaseCycles ? phaseCycles[k] : 0;
        const p1 = phaseCycles ? phaseCycles[k + 1] : 0;
        visit(start, width, magnitude[k] + u * (magnitude[k + 1] - magnitude[k]), p0 + u * (p1 - p0));
    }
}

export function rasterCellsFromShapes(shapes: RfShapeArrays): RfRasterCells {
    const cells = allocate(rasterCellCount(shapes), !shapes.timeShape);
    let i = 0;
    forEachRasterCell(shapes, (start, width, magnitude, phase) => {
        cells.start[i] = start;
        cells.width[i] = width;
        cells.magnitude[i] = magnitude;
        cells.phaseCycles[i] = phase;
        i++;
    });
    return cells;
}

/**
 * Channel count of an RF time shape written with the pTx-Pulseq convention
 * (Roos et al., MRM 2025): every channel's samples sit back to back in one
 * arbitrary RF event, each channel repeating the same time base, so the
 * channel count equals the number of samples at the first sample time.
 * Returns 0 for an ordinary (single-channel) time shape.
 */
export function detectPtxTimeShapeChannels(timeShape: ArrayLike<number>): number {
    const n = timeShape.length;
    if (n < 2) return 0;
    const first = timeShape[0];
    let repeats = 0;
    for (let i = 0; i < n; i++) {
        if (timeShape[i] === first) repeats++;
    }
    if (repeats < 2 || n % repeats !== 0) return 0;
    const perChannel = n / repeats;
    for (let channel = 1; channel < repeats; channel++) {
        const offset = channel * perChannel;
        for (let i = 0; i < perChannel; i++) {
            if (timeShape[offset + i] !== timeShape[i]) return 0;
        }
    }
    return repeats;
}

/** Shapes of an RF library entry; a pTx-Pulseq layout yields its first channel. */
export function rfShapeArrays(rf: RFEntry, seq: PulseqSequence): RfShapeArrays | null {
    const magnitude = seq.shapes.get(rf.magShapeId)?.samples;
    if (!magnitude || magnitude.length < 1) return null;
    const phase = rf.phaseShapeId > 0 ? seq.shapes.get(rf.phaseShapeId)?.samples ?? null : null;
    let time = rf.timeShapeId > 0 ? seq.shapes.get(rf.timeShapeId)?.samples ?? null : null;
    if (time) {
        const channels = detectPtxTimeShapeChannels(time);
        if (channels > 1) time = time.subarray(0, time.length / channels);
    }
    return { raster: seq.rasterTimes.rfRaster, magnitude, phaseCycles: phase, timeShape: time };
}

export function rfRasterCells(rf: RFEntry, seq: PulseqSequence): RfRasterCells {
    const shapes = rfShapeArrays(rf, seq);
    return shapes ? rasterCellsFromShapes(shapes) : allocate(0, true);
}

/** Played duration from the RF event start [s]: N·Δ, or the last breakpoint. */
export function rfShapeDuration(shapes: RfShapeArrays): number {
    if (!shapes.timeShape) return rasterCellCount(shapes) * shapes.raster;
    const points = breakpointCount(shapes);
    return points > 0 ? shapes.timeShape[points - 1] * shapes.raster : 0;
}

function breakpointCount(shapes: RfShapeArrays): number {
    return Math.min(
        shapes.magnitude.length,
        shapes.phaseCycles?.length ?? shapes.magnitude.length,
        shapes.timeShape?.length ?? shapes.magnitude.length,
    );
}

function allocate(count: number, uniform: boolean): RfRasterCells {
    return {
        count,
        start: new Float64Array(count),
        width: new Float64Array(count),
        magnitude: new Float64Array(count),
        phaseCycles: new Float64Array(count),
        uniform,
    };
}
