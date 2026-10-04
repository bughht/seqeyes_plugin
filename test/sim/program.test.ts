import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';
import { decodeAllBlocks, getTotalDuration } from '../../src/pulseq/decoder';
import { calculateKspace } from '../../src/pulseq/kspace';
import { buildFrozenGradientSeries } from '../../src/pulseq/gradientTimeline';
import { adcSampleTimes, compileProgram } from '../../src/sim/program/compile';
import { piecesKAt } from '../../src/sim/program/pwl';
import type { SimSegment } from '../../src/sim/program/types';

const demo = join(__dirname, '..', 'seqeyes_demo_seq_files');

function load(name: string) {
    const path = join(demo, name);
    return parseSequenceBytes(new Uint8Array(readFileSync(path)), path);
}

function collect(name: string, options = {}) {
    const seq = load(name);
    const program = compileProgram(seq, options);
    const segments: SimSegment[] = [...program.segments()];
    return { seq, program, segments };
}

/**
 * Rebuild the viewer's displayed trajectory from program segments: reset at
 * each excitation centre, negate at each refocusing centre (kspace.ts's
 * display convention), sampling at every ADC sample.
 */
function trajectoryFromProgram(segments: SimSegment[]) {
    const k = [0, 0, 0];
    const out: number[][] = [[], [], []];
    const times: number[] = [];
    for (const segment of segments) {
        if (segment.kind === 'rf') {
            for (let a = 0; a < 3; a++) k[a] += segment.kToCenter[a];
            const use = segment.use || '';
            if (use === 'e' || use === '' || use === 'u') k.fill(0);
            else if (use === 'r') for (let a = 0; a < 3; a++) k[a] = -k[a];
            for (let a = 0; a < 3; a++) k[a] += segment.moments.dk[a] - segment.kToCenter[a];
        } else if (segment.kind === 'adc') {
            const sampleTimes = adcSampleTimes(segment);
            const local = new Float64Array(3 * sampleTimes.length);
            piecesKAt(segment.gradient, sampleTimes, local);
            for (let s = 0; s < sampleTimes.length; s++) {
                for (let a = 0; a < 3; a++) out[a].push(k[a] + local[3 * s + a]);
                times.push(sampleTimes[s]);
            }
            for (let a = 0; a < 3; a++) k[a] += segment.moments.dk[a];
        } else {
            for (let a = 0; a < 3; a++) k[a] += segment.moments.dk[a];
        }
    }
    return { k: out, times };
}

const TRAJECTORY_FIXTURES = [
    'writeGradientEcho.seq',
    'writeGradientEcho_label.seq',
    'writeEpiRS.seq',
    'writeEpiDiffusionRS.seq',
    'writeEpiSpinEchoRS.seq',
    'writeTSE.seq',
    'writeHASTE.seq',
    'writeSpiral.seq',
    'writeRadialGradientEcho_rotExt.seq',
    'writeFastRadialGradientEcho_rotExt.seq',
    'writeUTE.seq',
    'writeFid.seq',
    'writeTrufi.seq',
    'writeSemiLaser.seq',
];

describe('simulation program compiler', () => {
    for (const name of TRAJECTORY_FIXTURES) {
        describe(name, () => {
            const { seq, program, segments } = collect(name);

            it('partitions the whole sequence without gaps or overlaps', () => {
                expect(segments.length).toBeGreaterThan(0);
                expect(segments[0].t0).toBe(0);
                for (let i = 1; i < segments.length; i++) {
                    expect(segments[i].t0).toBe(segments[i - 1].t1);
                    expect(segments[i].t1).toBeGreaterThan(segments[i].t0);
                    expect(segments[i].blockIndex).toBeGreaterThanOrEqual(segments[i - 1].blockIndex);
                }
                expect(segments[segments.length - 1].t1).toBe(program.totalDuration);
                expect(program.totalDuration / getTotalDuration(seq)).toBeCloseTo(1, 12);
            });

            it('integrates the same total gradient area as the global series', () => {
                const blocks = decodeAllBlocks(seq);
                const series = buildFrozenGradientSeries(blocks, seq.rasterTimes.gradientRaster, getTotalDuration(seq));
                for (let axis = 0; axis < 3; axis++) {
                    const { times, values } = series[axis];
                    let reference = 0;
                    let scale = 0;
                    for (let i = 1; i < times.length; i++) {
                        reference += 0.5 * (values[i - 1] + values[i]) * (times[i] - times[i - 1]);
                        scale += 0.5 * Math.abs(values[i - 1] + values[i]) * (times[i] - times[i - 1]);
                    }
                    const total = segments.reduce((sum, segment) => sum + segment.moments.dk[axis], 0);
                    // The two sides subtract absolute times on different clocks
                    // (integer raster sums vs float sums), so they agree to float
                    // noise summed over every interval, not bit for bit.
                    expect(Math.abs(total - reference)).toBeLessThanOrEqual(1e-7 * Math.max(1, scale));
                }
            });

            it('reproduces the k-space viewer trajectory at every ADC sample', () => {
                const blocks = decodeAllBlocks(seq);
                const reference = calculateKspace(
                    blocks,
                    seq.rasterTimes.gradientRaster,
                    getTotalDuration(seq),
                    0,
                    { gradientSupport: 'all', rfRaster: seq.rasterTimes.rfRaster },
                )!;
                const { k, times } = trajectoryFromProgram(segments);
                expect(times.length).toBe(reference.t_adc.length);
                let worst = 0;
                for (let s = 0; s < times.length; s++) {
                    expect(Math.abs(times[s] - reference.t_adc[s])).toBeLessThan(1e-12);
                    for (let a = 0; a < 3; a++) {
                        worst = Math.max(worst, Math.abs(k[a][s] - reference.ktraj_adc[a][s]));
                    }
                }
                // kspace.ts snaps RF centres and ADC samples to a 0.1 ns grid and
                // the snapping error accumulates along long refocusing trains; the
                // program places them exactly. 5e-3 1/m is ~0.1 % of a k-space
                // pixel at a 256 mm FOV.
                expect(worst).toBeLessThan(5e-3);
            });
        });
    }

    it('shares one RF operator across an RF-spoiled train', () => {
        const { seq, program, segments } = collect('writeGradientEcho.seq');
        const rfSegments = segments.filter(segment => segment.kind === 'rf');
        const libraryIds = new Set(seq.blocks.filter(block => block.rfId > 0).map(block => block.rfId));
        expect(libraryIds.size).toBeGreaterThan(1);
        expect(program.rfOperators.size).toBe(1);
        expect(new Set(rfSegments.map(segment => segment.key)).size).toBe(1);
        // The per-event phase offsets still differ: they are applied analytically.
        expect(new Set(rfSegments.map(segment => segment.kind === 'rf' ? segment.phaseOffset : 0)).size)
            .toBeGreaterThan(1);
    });

    it('keys RF operators by frequency offset, so multi-slice pulses stay distinct', () => {
        const { segments } = collect('writeEpiDiffusionRS.seq');
        const byKey = new Map<string, Set<number>>();
        for (const segment of segments) {
            if (segment.kind !== 'rf') continue;
            const freqs = byKey.get(segment.key) ?? new Set<number>();
            freqs.add(segment.operator.freqOffset);
            byKey.set(segment.key, freqs);
        }
        expect(byKey.size).toBeGreaterThan(1);
        for (const freqs of byKey.values()) expect(freqs.size).toBe(1);
    });

    it('applies soft-delay inputs to the program clock', () => {
        // This file drives two delay blocks per TR from one TE input: one with
        // factor +1 before the readout and one with factor −1 after it, so a
        // longer TE moves the echo later without changing TR.
        const name = 'writeEpiRS_label_softdelay.seq';
        const base = collect(name);
        const seq = base.seq;
        const teRows = seq.softDelays.filter(delay => delay.hint === 'TE');
        expect(teRows.map(delay => delay.factor).sort()).toEqual([-1, 1]);
        const numId = teRows[0].numId;

        const delayRowOf = (blockIndex: number) => {
            const block = seq.blocks[blockIndex];
            let ext = block.extId > 0 ? seq.extensions.get(block.extId) : undefined;
            while (ext) {
                const row = seq.softDelays.find(delay => delay.id === ext!.ref
                    && seq.extensionNames.get(ext!.type) === 'DELAYS');
                if (row) return row;
                ext = ext.nextId > 0 ? seq.extensions.get(ext.nextId) : undefined;
            }
            return undefined;
        };
        const plus = seq.blocks.findIndex((_, i) => delayRowOf(i)?.numId === numId && delayRowOf(i)?.factor === 1);
        expect(plus).toBeGreaterThanOrEqual(0);
        const raster = seq.rasterTimes.blockDurationRaster;
        const blockSeconds = (program: typeof base.program, i: number) =>
            program.blockStartTimes[i + 1] - program.blockStartTimes[i];

        // The file's own input reproduces the file's timing exactly.
        const row = delayRowOf(plus)!;
        const fileInput = (blockSeconds(base.program, plus) - row.offset * 1e-6) * row.factor;
        const same = collect(name, { softDelayInputs: { [numId]: fileInput } });
        expect(same.program.totalDuration).toBeCloseTo(base.program.totalDuration, 12);

        // TE + 1 ms: every +1 delay block grows by 1 ms, every −1 block shrinks.
        const shifted = collect(name, { softDelayInputs: { [numId]: fileInput + 1e-3 } });
        let plusBlocks = 0;
        for (let i = 0; i < seq.blocks.length; i++) {
            const delay = delayRowOf(i);
            if (delay?.numId !== numId) continue;
            const expected = Math.round(((fileInput + 1e-3) / delay.factor + delay.offset * 1e-6) / raster) * raster;
            expect(blockSeconds(shifted.program, i)).toBeCloseTo(expected, 12);
            if (delay.factor === 1) plusBlocks++;
        }
        expect(plusBlocks).toBeGreaterThan(0);
        expect(shifted.program.totalDuration).toBeCloseTo(base.program.totalDuration, 9);
        expect(shifted.segments[shifted.segments.length - 1].t1).toBe(shifted.program.totalDuration);

        // The first readout after the first +1 delay moves 1 ms later.
        const firstAdcAfter = (segments: SimSegment[]) =>
            segments.find(segment => segment.kind === 'adc' && segment.blockIndex > plus)!.t0;
        expect(firstAdcAfter(shifted.segments) - firstAdcAfter(base.segments)).toBeCloseTo(1e-3, 9);
    });

    it('labels ADC segments in block order', () => {
        const { segments } = collect('writeGradientEcho_label.seq');
        const adc = segments.filter(segment => segment.kind === 'adc');
        expect(adc.map(segment => segment.kind === 'adc' ? segment.adcIndex : -1))
            .toEqual(adc.map((_, index) => index));
    });
});
