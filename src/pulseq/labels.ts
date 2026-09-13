/**
 * MDH label evolution, sampled at each ADC.
 *
 * Labels are a running state: every label starts at zero, a LABELSET assigns
 * and a LABELINC adds.  Within a block the label extensions are applied in
 * chain order before that block's ADC is recorded, which is what Pulseq's
 * `seq.evalLabels('evolution', 'adc')` reports.
 *
 * This walks the block table and extension libraries directly, so it costs one
 * pass over the blocks and never decodes a waveform.
 */
import type { LabelIncSpec, LabelSetSpec, PulseqSequence } from './types';
import { ExtType } from './types';
import { blockDurationSeconds } from './decoder';

export type LabelKind = 'counter' | 'flag';

export interface SequenceLabels {
    /** Labels the file's LABELSET/LABELINC tables mention, in display order. */
    names: string[];
    kinds: LabelKind[];
}

export interface AdcLabelTable extends SequenceLabels {
    /** Number of ADC events. */
    count: number;
    /** ADC centre time [s]: block start + delay + half the readout. */
    timeSec: Float64Array;
    /** 1-based block number of each ADC. */
    block: Uint32Array;
    /** Label state at each ADC, row-major: `values[adc * names.length + label]`. */
    values: Int32Array;
    min: number[];
    max: number[];
}

const COUNTER_ORDER = ['SLC', 'SEG', 'REP', 'AVG', 'SET', 'ECO', 'PHS', 'LIN', 'PAR', 'ACQ', 'TRID', 'ONCE'];
const FLAG_ORDER = ['NAV', 'REV', 'SMS', 'REF', 'IMA', 'OFF', 'NOISE', 'PMC', 'NOROT', 'NOPOS', 'NOSCL'];

/** Known counters first, then custom names alphabetically, then flags. */
function labelRank(name: string): number {
    const counter = COUNTER_ORDER.indexOf(name);
    if (counter >= 0) return counter;
    const flag = FLAG_ORDER.indexOf(name);
    return flag >= 0 ? 2000 + flag : 1000;
}

function labelKind(name: string): LabelKind {
    return FLAG_ORDER.includes(name) ? 'flag' : 'counter';
}

/** The labels a sequence mentions.  Untouched labels are deliberately absent. */
export function listSequenceLabels(seq: PulseqSequence): SequenceLabels {
    const seen = new Set<string>();
    for (const spec of seq.labelSets) seen.add(spec.name);
    for (const spec of seq.labelIncs) seen.add(spec.name);
    const names = [...seen].sort((a, b) => (labelRank(a) - labelRank(b)) || (a < b ? -1 : a > b ? 1 : 0));
    return { names, kinds: names.map(labelKind) };
}

interface LabelOp {
    column: number;
    value: number;
    increment: boolean;
}

/**
 * Resolve an extension chain to its label operations.  Many blocks share one
 * chain head, so each head is walked once.  The visited set stops a malformed
 * cyclic chain at the same point `decodeExtensions` does.
 */
function labelOpsForChain(
    seq: PulseqSequence,
    headId: number,
    column: Map<string, number>,
    sets: Map<number, LabelSetSpec>,
    incs: Map<number, LabelIncSpec>,
): LabelOp[] {
    const ops: LabelOp[] = [];
    const visited = new Set<number>();
    let cur = seq.extensions.get(headId);
    while (cur && !visited.has(cur.id)) {
        visited.add(cur.id);
        const type = seq.extensionTypes.get(cur.type) ?? ExtType.EXT_UNKNOWN;
        if (type === ExtType.EXT_LABELSET || type === ExtType.EXT_LABELINC) {
            const increment = type === ExtType.EXT_LABELINC;
            const spec = increment ? incs.get(cur.ref) : sets.get(cur.ref);
            const index = spec ? column.get(spec.name) : undefined;
            if (spec && index !== undefined) ops.push({ column: index, value: spec.value, increment });
        }
        cur = cur.nextId > 0 ? seq.extensions.get(cur.nextId) : undefined;
    }
    return ops;
}

/** Label state at every ADC in the sequence. */
export function evaluateAdcLabels(seq: PulseqSequence): AdcLabelTable {
    const { names, kinds } = listSequenceLabels(seq);
    const width = names.length;
    const column = new Map(names.map((name, index) => [name, index]));
    const sets = new Map(seq.labelSets.map(spec => [spec.id, spec]));
    const incs = new Map(seq.labelIncs.map(spec => [spec.id, spec]));

    let count = 0;
    for (const block of seq.blocks) {
        if (block.adcId > 0 && seq.adcs.has(block.adcId)) count++;
    }
    const timeSec = new Float64Array(count);
    const blockNumbers = new Uint32Array(count);
    const values = new Int32Array(count * width);

    const state = new Int32Array(width);
    const chains = new Map<number, LabelOp[]>();
    let start = 0;
    let row = 0;
    for (const block of seq.blocks) {
        if (width > 0 && block.extId > 0) {
            let ops = chains.get(block.extId);
            if (!ops) {
                ops = labelOpsForChain(seq, block.extId, column, sets, incs);
                chains.set(block.extId, ops);
            }
            for (const op of ops) state[op.column] = op.increment ? state[op.column] + op.value : op.value;
        }
        const adc = block.adcId > 0 ? seq.adcs.get(block.adcId) : undefined;
        if (adc) {
            // Units as in decodeADC: delay in µs, dwell in ns.
            timeSec[row] = start + adc.delay * 1e-6 + adc.numSamples * adc.dwell * 1e-9 / 2;
            blockNumbers[row] = block.num;
            values.set(state, row * width);
            row++;
        }
        start += blockDurationSeconds(seq, block);
    }

    const min = new Array<number>(width).fill(0);
    const max = new Array<number>(width).fill(0);
    for (let label = 0; label < width; label++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let adc = 0; adc < count; adc++) {
            const value = values[adc * width + label];
            if (value < lo) lo = value;
            if (value > hi) hi = value;
        }
        if (count > 0) {
            min[label] = lo;
            max[label] = hi;
        }
    }

    return { names, kinds, count, timeSec, block: blockNumbers, values, min, max };
}
