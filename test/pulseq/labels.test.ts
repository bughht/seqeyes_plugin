import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { serializeLabelTable } from '../../src/editor/labelTransport';
import { decodeAllBlocks } from '../../src/pulseq/decoder';
import { evaluateAdcLabels, listSequenceLabels, type AdcLabelTable } from '../../src/pulseq/labels';
import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';
import type { PulseqSequence } from '../../src/pulseq/types';
import { loadWebviewAssets } from './blockTransportFixtures';

const ROOT = join(__dirname, '..', '..');
const GRE_LABEL = 'test/seqeyes_demo_seq_files/writeGradientEcho_label.seq';

interface WebviewLabelTable {
    names: string[];
    kinds: string[];
    count: number;
    timeSec: Float64Array;
    block: Uint32Array;
    values: Int32Array;
    min: number[];
    max: number[];
}

interface LabelsApi {
    SeqEyesLabels: {
        fromPayload(payload: unknown): WebviewLabelTable;
        fromTable(table: AdcLabelTable): WebviewLabelTable;
        drawRow(ctx: unknown, table: WebviewLabelTable, geom: object, vs: number, ve: number, t2x: (t: number) => number): number;
        tooltipLine(table: WebviewLabelTable, block: { i: number; s: number; d: number }): string | null;
    };
}

function load(relative: string): PulseqSequence {
    return parseSequenceBytes(new Uint8Array(readFileSync(join(ROOT, relative))), relative.split('/').pop()!);
}

function row(table: AdcLabelTable, adc: number): Record<string, number> {
    const width = table.names.length;
    return Object.fromEntries(table.names.map((name, label) => [name, table.values[adc * width + label]]));
}

/** Records how many markers a draw call emits without needing a canvas. */
function countingContext() {
    const noop = () => undefined;
    return {
        save: noop, restore: noop, beginPath: noop, closePath: noop, fill: noop, stroke: noop,
        moveTo: noop, lineTo: noop, arc: noop, rect: noop, fillRect: noop, fillText: noop,
        measureText: () => ({ width: 18 }),
    };
}

describe('MDH label evaluation', () => {
    it('lists only the labels a sequence mentions, counters before flags', () => {
        expect(listSequenceLabels(load(GRE_LABEL))).toEqual({
            names: ['SLC', 'REP', 'LIN', 'REV'],
            kinds: ['counter', 'counter', 'counter', 'flag'],
        });
        expect(listSequenceLabels(load('test/pulseq/binary/epi_rs.seq')).names)
            .toEqual(['SLC', 'SEG', 'REP', 'AVG', 'LIN', 'NAV', 'REV']);
        expect(listSequenceLabels(load('test/kspace_baselines/v151_gre/seq/writeGradientEcho.seq')).names).toEqual([]);
    });

    it('keeps label names and evolution identical through the text and binary readers', () => {
        for (const stem of ['gre', 'epi_rs']) {
            const text = evaluateAdcLabels(load(`test/pulseq/binary/${stem}.seq`));
            const binary = evaluateAdcLabels(load(`test/pulseq/binary/${stem}.bseq`));
            expect(binary.names).toEqual(text.names);
            expect(binary.count).toBe(text.count);
            expect(Array.from(binary.values)).toEqual(Array.from(text.values));
            expect(Array.from(binary.block)).toEqual(Array.from(text.block));
            for (let adc = 0; adc < text.count; adc++) expect(binary.timeSec[adc]).toBeCloseTo(text.timeSec[adc], 12);
        }
    });

    it('records the running state at each ADC centre', () => {
        const seq = load(GRE_LABEL);
        const table = evaluateAdcLabels(seq);
        expect(table.count).toBe(512);
        expect(row(table, 0)).toEqual({ SLC: 0, REP: 0, LIN: 0, REV: 1 });
        expect(row(table, 1)).toEqual({ SLC: 0, REP: 0, LIN: 1, REV: 1 });
        expect(row(table, 13)).toEqual({ SLC: 0, REP: 0, LIN: 13, REV: 1 });
        expect(table.min).toEqual([0, 0, 0, 1]);
        expect(table.max).toEqual([0, 1, 255, 1]);

        const adcs = decodeAllBlocks(seq).filter(block => block.adc);
        expect(adcs).toHaveLength(table.count);
        adcs.forEach((block, adc) => {
            const centre = block.adc!.startTime + block.adc!.delay + block.adc!.numSamples * block.adc!.dwell / 2;
            expect(table.block[adc]).toBe(block.index);
            expect(table.timeSec[adc]).toBeCloseTo(centre, 12);
        });
    });

    it('applies a block\'s SET and INC before recording its ADC', () => {
        // In this EPI the navigator flags and segment counter are set in the
        // same blocks as the ADCs they describe.
        const table = evaluateAdcLabels(load('test/pulseq/binary/epi_rs.seq'));
        expect(table.block[0]).toBe(6);
        expect(row(table, 0)).toEqual({ SLC: 0, SEG: 1, REP: 0, AVG: 0, LIN: 48, NAV: 1, REV: 1 });
        expect(row(table, 1)).toEqual({ SLC: 0, SEG: 0, REP: 0, AVG: 0, LIN: 48, NAV: 1, REV: 0 });
        expect(row(table, 2)).toEqual({ SLC: 0, SEG: 1, REP: 0, AVG: 1, LIN: 48, NAV: 1, REV: 1 });
        expect(row(table, 3)).toEqual({ SLC: 0, SEG: 0, REP: 0, AVG: 0, LIN: 0, NAV: 0, REV: 0 });
    });
});

describe('label row webview module', () => {
    const api = loadWebviewAssets<LabelsApi>(['labels.js']).SeqEyesLabels;

    it('round-trips a table through the host transport', () => {
        const source = evaluateAdcLabels(load('test/pulseq/binary/epi_rs.seq'));
        const serialized = serializeLabelTable(source);
        // JSON for the scalars, raw bytes for the buffers — what VS Code does.
        const { timeSec, block, values, ...scalars } = serialized;
        const payload = {
            ...JSON.parse(JSON.stringify(scalars)),
            timeSec: timeSec.slice(0), block: block.slice(0), values: new Uint8Array(values.slice(0)),
        };
        const table = api.fromPayload(payload);
        expect(Array.from(table.names)).toEqual(source.names);
        expect(Array.from(table.kinds)).toEqual(source.kinds);
        expect(table.count).toBe(source.count);
        expect(Array.from(table.min)).toEqual(source.min);
        expect(Array.from(table.max)).toEqual(source.max);
        expect(Array.from(table.values)).toEqual(Array.from(source.values));
        expect(Array.from(table.block)).toEqual(Array.from(source.block));
        expect(Array.from(table.timeSec)).toEqual(Array.from(source.timeSec));
    });

    it('refuses a reply whose values arrived truncated', () => {
        const serialized = serializeLabelTable(evaluateAdcLabels(load(GRE_LABEL)));
        expect(() => api.fromPayload({ ...serialized, values: serialized.values.slice(0, 64) })).toThrow(/truncated/);
        expect(() => api.fromPayload({ ...serialized, timeSec: null })).toThrow(/binary/);
    });

    it('bounds the markers it draws by the plot width, not the ADC count', () => {
        const table = api.fromTable(evaluateAdcLabels(load(GRE_LABEL)));
        const width = 200;
        const vs = 0;
        const ve = table.timeSec[table.count - 1] + 1e-3;
        const t2x = (t: number) => 92 + (t - vs) * (width / (ve - vs));
        const geom = { left: 92, right: 92 + width, top: 0, height: 60 };
        const dense = api.drawRow(countingContext(), table, geom, vs, ve, t2x);
        expect(dense).toBeGreaterThan(0);
        expect(dense).toBeLessThanOrEqual(2 * table.names.length * width);

        // Three ADCs in a wide plot: every one is drawn, once per label.
        const narrowEnd = (table.timeSec[2] + table.timeSec[3]) / 2;
        const zoom = (t: number) => 92 + t * (800 / narrowEnd);
        const sparse = api.drawRow(countingContext(), table, { ...geom, right: 892 }, 0, narrowEnd, zoom);
        expect(sparse).toBe(3 * table.names.length);
    });

    it('describes the label state at a block\'s ADC', () => {
        const seq = load(GRE_LABEL);
        const table = api.fromTable(evaluateAdcLabels(seq));
        const blocks = decodeAllBlocks(seq);
        const withAdc = blocks.find(block => block.index === 11)!;
        const withoutAdc = blocks.find(block => block.index === 10)!;
        expect(withoutAdc.adc).toBeUndefined();
        expect(api.tooltipLine(table, { i: withAdc.index, s: withAdc.startTime, d: withAdc.duration }))
            .toBe('Labels: SLC=0  REP=0  LIN=1  REV=1');
        expect(api.tooltipLine(table, { i: withoutAdc.index, s: withoutAdc.startTime, d: withoutAdc.duration })).toBeNull();
    });
});
