import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';
import { decodeAllBlocks, getTotalDuration } from '../../src/pulseq/decoder';
import { physicalGradientPiece, type GradientSeries } from '../../src/pulseq/physicalGradients';
import {
    Float64Chunks,
    GradientAxisAssembler,
    GradientTimelineBuilder,
    buildFrozenGradientSeries,
    sampleSeries,
    type FrozenGradientSeries,
} from '../../src/pulseq/gradientTimeline';
import type { DecodedBlock } from '../../src/pulseq/types';

// ---------------------------------------------------------------------------
// Reference: the whole-sequence builder as it stood in kspace.ts before the
// extraction, copied verbatim. The incremental builder must reproduce it
// point for point, which is what keeps the k-space baselines unchanged.
// ---------------------------------------------------------------------------
const LEGACY_EPSILON = 1e-12;

function legacyFreeze(series: GradientSeries): FrozenGradientSeries {
    return {
        times: Float64Array.from(series.times),
        values: Float64Array.from(series.values),
        requiredSupport: Float64Array.from(series.requiredSupport),
    };
}

function legacyBuild(blocks: DecodedBlock[], gradientRaster: number, totalDuration: number): FrozenGradientSeries[] {
    const output: GradientSeries[] = [
        { times: [], values: [], requiredSupport: [] },
        { times: [], values: [], requiredSupport: [] },
        { times: [], values: [], requiredSupport: [] },
    ];
    for (const block of blocks) {
        for (let axis = 0; axis < 3; axis++) {
            const piece = physicalGradientPiece(block, axis);
            if (piece.times.length) legacyAppend(output[axis], piece, gradientRaster);
        }
    }
    for (const series of output) {
        if (!series.times.length) continue;
        const first = series.times[0];
        const last = series.times[series.times.length - 1];
        if (first > 0) {
            series.times.unshift(-LEGACY_EPSILON, first - LEGACY_EPSILON);
            series.values.unshift(0, 0);
            series.requiredSupport.push(-LEGACY_EPSILON, first - LEGACY_EPSILON);
        }
        if (last < totalDuration) {
            series.times.push(last + LEGACY_EPSILON, totalDuration + LEGACY_EPSILON);
            series.values.push(0, 0);
            series.requiredSupport.push(last + LEGACY_EPSILON, totalDuration + LEGACY_EPSILON);
        }
    }
    return output.map(legacyFreeze);
}

function legacyAppend(target: GradientSeries, piece: GradientSeries, gradientRaster: number): void {
    if (!piece.times.length) return;
    target.requiredSupport.push(piece.times[0], piece.times[piece.times.length - 1]);
    if (!target.times.length) {
        for (const t of piece.times) target.times.push(t);
        for (const v of piece.values) target.values.push(v);
        return;
    }
    const lastIndex = target.times.length - 1;
    const previousTime = target.times[lastIndex];
    const firstTime = piece.times[0];
    if (previousTime + gradientRaster < firstTime) {
        if (target.values[lastIndex] !== 0) {
            if (Math.abs(target.values[lastIndex]) > 1e-6) {
                target.times.push(previousTime + gradientRaster * 0.5);
                target.values.push(0);
                target.requiredSupport.push(previousTime + gradientRaster * 0.5);
            } else {
                target.values[lastIndex] = 0;
            }
        }
        if (piece.values[0] !== 0) {
            if (Math.abs(piece.values[0]) > 1e-6) {
                target.times.push(firstTime - gradientRaster * 0.5);
                target.values.push(0);
                target.requiredSupport.push(firstTime - gradientRaster * 0.5);
            } else {
                piece.values[0] = 0;
            }
        }
    }
    let start = 0;
    const currentLast = target.times[target.times.length - 1];
    while (start < piece.times.length && piece.times[start] <= currentLast) start++;
    for (let i = start; i < piece.times.length; i++) {
        target.times.push(piece.times[i]);
        target.values.push(piece.values[i]);
    }
}

// ---------------------------------------------------------------------------

const root = join(__dirname, '..');
const fixtureDirs = [
    join(root, 'seqeyes_demo_seq_files'),
    join(root, 'seqeyes_demo_seq_files', 'v142'),
    join(root, 'seq'),
    join(root, 'pulseq', 'binary'),
];
const fixtures = fixtureDirs.flatMap(dir => readdirSync(dir)
    .filter(name => name.endsWith('.seq') || name.endsWith('.bseq'))
    .map(name => join(dir, name)));

function load(path: string) {
    const seq = parseSequenceBytes(new Uint8Array(readFileSync(path)), path);
    return { seq, blocks: decodeAllBlocks(seq), total: getTotalDuration(seq) };
}

function sorted(values: Float64Array): Float64Array {
    return Float64Array.from(values).sort();
}

describe('gradient timeline extraction', () => {
    it('finds the fixtures', () => {
        expect(fixtures.length).toBeGreaterThan(30);
    });

    for (const path of fixtures) {
        const name = path.slice(root.length + 1);
        it(`reproduces the legacy series exactly: ${name}`, () => {
            const { seq, blocks, total } = load(path);
            const raster = seq.rasterTimes.gradientRaster;
            const legacy = legacyBuild(blocks, raster, total);
            const current = buildFrozenGradientSeries(blocks, raster, total);
            for (let axis = 0; axis < 3; axis++) {
                expect(current[axis].times).toEqual(legacy[axis].times);
                expect(current[axis].values).toEqual(legacy[axis].values);
                // Support is a set of grid candidates; only its contents matter.
                expect(sorted(current[axis].requiredSupport)).toEqual(sorted(legacy[axis].requiredSupport));
            }
        });
    }

    it('resumes from a carry snapshot exactly as an uninterrupted build continues', () => {
        const { seq, blocks, total } = load(join(root, 'seqeyes_demo_seq_files', 'writeEpiRS.seq'));
        const raster = seq.rasterTimes.gradientRaster;
        for (const split of [1, 7, Math.floor(blocks.length / 2), blocks.length - 1]) {
            const whole = new GradientTimelineBuilder(raster);
            const head = new GradientTimelineBuilder(raster);
            for (let i = 0; i < split; i++) {
                whole.append(blocks[i]);
                head.append(blocks[i]);
            }
            const emittedBefore = whole.axes.map(axis => axis.times.length);
            const resumed = new GradientTimelineBuilder(raster, head.snapshotCarry());
            for (let i = split; i < blocks.length; i++) {
                whole.append(blocks[i]);
                resumed.append(blocks[i]);
            }
            whole.finish(total);
            resumed.finish(total);
            for (let axis = 0; axis < 3; axis++) {
                const wholeTimes = whole.axes[axis].times.toArray();
                const wholeValues = whole.axes[axis].values.toArray();
                expect(resumed.axes[axis].times.toArray()).toEqual(wholeTimes.subarray(emittedBefore[axis]));
                expect(resumed.axes[axis].values.toArray()).toEqual(wholeValues.subarray(emittedBefore[axis]));
            }
        }
    });

    it('rejects a carry captured on a different raster', () => {
        const carry = new GradientTimelineBuilder(1e-5).snapshotCarry();
        expect(() => new GradientTimelineBuilder(2e-5, carry)).toThrow(/different gradient raster/);
    });

    describe('gap rules on synthetic pieces', () => {
        const raster = 1e-5;
        function assemble(pieces: [number[], number[]][], total: number) {
            const axis = new GradientAxisAssembler(raster);
            for (const [times, values] of pieces) axis.appendPiece(times, values);
            axis.finish(total);
            return axis.freeze();
        }

        it('ramps a nonzero edge to zero over half a raster across a gap', () => {
            const series = assemble([[[0, 1e-4], [0, 5]], [[3e-4, 4e-4], [7, 0]]], 5e-4);
            expect(Array.from(series.times)).toEqual([0, 1e-4, 1e-4 + 5e-6, 3e-4 - 5e-6, 3e-4, 4e-4, 4e-4 + 1e-12, 5e-4 + 1e-12]);
            expect(Array.from(series.values)).toEqual([0, 5, 0, 0, 7, 0, 0, 0]);
        });

        it('snaps a tiny edge to zero instead of ramping, including the held-back point', () => {
            const series = assemble([[[0, 1e-4], [0, 5e-7]], [[3e-4, 4e-4], [-5e-7, 0]]], 4e-4);
            expect(Array.from(series.times)).toEqual([0, 1e-4, 3e-4, 4e-4]);
            expect(Array.from(series.values)).toEqual([0, 0, 0, 0]);
        });

        it('lets the earlier piece win a shared boundary', () => {
            const series = assemble([[[0, 1e-4], [0, 3]], [[1e-4, 2e-4], [9, 0]]], 2e-4);
            expect(Array.from(series.times)).toEqual([0, 1e-4, 2e-4]);
            expect(Array.from(series.values)).toEqual([0, 3, 0]);
        });

        it('pads with zeros before a late first piece and after an early last one', () => {
            const series = assemble([[[2e-4, 3e-4], [0, 0]]], 5e-4);
            expect(Array.from(series.times)).toEqual([-1e-12, 2e-4 - 1e-12, 2e-4, 3e-4, 3e-4 + 1e-12, 5e-4 + 1e-12]);
        });

        it('samples zero outside the support and interpolates inside', () => {
            const series = assemble([[[1e-4, 2e-4], [0, 10]]], 3e-4);
            const cursors = [0, 0, 0];
            expect(sampleSeries(series, -1, cursors, 0)).toBe(0);
            expect(sampleSeries(series, 1.5e-4, cursors, 0)).toBeCloseTo(5, 12);
            expect(sampleSeries(series, 1, cursors, 0)).toBe(0);
        });
    });
});

describe('Float64Chunks', () => {
    it('stores across chunk boundaries and copies out exactly', () => {
        const store = new Float64Chunks();
        const n = 65536 * 2 + 17;
        for (let i = 0; i < n; i++) store.push(i * 0.5);
        expect(store.length).toBe(n);
        expect(store.get(65535)).toBe(65535 * 0.5);
        expect(store.get(65536)).toBe(65536 * 0.5);
        const copy = store.toArray();
        expect(copy.length).toBe(n);
        expect(copy[n - 1]).toBe((n - 1) * 0.5);
    });

    it('releases finished chunks and refuses to read them back', () => {
        const store = new Float64Chunks();
        for (let i = 0; i < 65536 * 2; i++) store.push(i);
        store.releaseBefore(65536 + 5);
        expect(() => store.get(0)).toThrow(/released/);
        expect(store.get(65536)).toBe(65536);
        expect(() => store.toArray()).toThrow(/released/);
    });
});
