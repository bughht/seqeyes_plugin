/**
 * Shared helpers for the packed block transport tests.
 *
 * Not a `.test.ts` file, so vitest's `test/**\/*.test.ts` include skips it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { MAX_DISPLAY_PTS, packBlocks } from '../../src/editor/blockTransport';
import { decodeAllBlocks } from '../../src/pulseq/decoder';
import { downsampleM4 } from '../../src/pulseq/displayDownsampling';
import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';
import type { DecodedBlock } from '../../src/pulseq/types';
import type { PulseqSequence } from '../../src/pulseq/types';

const FIXTURES = join(__dirname, '..', 'seqeyes_demo_seq_files');
const ASSETS = join(__dirname, '..', '..', 'src', 'editor', 'webview', 'assets');

export interface UnpackApi {
    unpackSequenceBlocks: (
        envelope: unknown[],
        timeBuffer: unknown,
        valueBuffer: unknown,
        sampleCount: number,
    ) => Array<Record<string, any>>;
}

/**
 * Run the named webview assets in a fresh context and return their globals.
 * Loading the shipped files is the point: these tests must exercise the
 * unpacker the extension actually bundles, not a re-implementation of it.
 */
export function loadWebviewAssets<T>(files: string[]): T {
    const context = createContext({
        Float64Array, Float32Array, Int32Array, Uint32Array, ArrayBuffer,
        Infinity, isFinite, Math, Error,
    });
    for (const file of files) {
        runInContext(readFileSync(join(ASSETS, file), 'utf8'), context);
    }
    return context as unknown as T;
}

export function loadUnpackApi(): UnpackApi {
    return loadWebviewAssets<UnpackApi>(['block-transport.js']);
}

export function loadBlocks(fixture: string): DecodedBlock[] {
    return decodeAllBlocks(loadSequence(fixture));
}

export function loadSequence(fixture: string): PulseqSequence {
    const bytes = readFileSync(join(FIXTURES, fixture));
    return parseSequenceBytes(new Uint8Array(bytes), fixture);
}

/**
 * Reproduce the transfer VS Code performs: JSON for the envelope, raw binary
 * for the buffers.  A regression that let samples leak back into the envelope
 * would survive an in-process round trip but not this one.
 */
export function transfer(packed: ReturnType<typeof packBlocks>) {
    const envelopeJson = JSON.stringify(packed.blocks);
    return {
        envelope: JSON.parse(envelopeJson) as unknown[],
        times: packed.sampleTimes,
        values: packed.sampleValues,
        envelopeJson,
    };
}

/** Pack, ship over a simulated wire, and rehydrate — the full round trip. */
export function packAndUnpack(
    api: UnpackApi,
    blocks: DecodedBlock[],
): Array<Record<string, any>> {
    const packed = packBlocks(blocks);
    const wire = transfer(packed);
    return api.unpackSequenceBlocks(wire.envelope, wire.times, wire.values, packed.sampleCount);
}

/**
 * Peak, area and flat-top detection, mirroring `waveformMagnitudeMetrics` in
 * web/index.html.  Reimplemented rather than imported from blockTransport so
 * the reference stays independent of the code under test — the RF event
 * overview reads `pk` and `ar`, so a wrong value here would quietly change
 * what the comparison is comparing.
 */
function magnitudeMetrics(
    time: ArrayLike<number>,
    values: ArrayLike<number>,
): { peak: number; area: number; blockPulse: boolean } {
    const count = Math.min(time.length, values.length);
    let peak = 0;
    let min = Infinity;
    let max = -Infinity;
    let area = 0;
    let finiteCount = 0;
    for (let i = 0; i < count; i++) {
        if (!Number.isFinite(values[i])) continue;
        const magnitude = Math.abs(values[i]);
        peak = Math.max(peak, magnitude);
        min = Math.min(min, magnitude);
        max = Math.max(max, magnitude);
        finiteCount++;
    }
    for (let i = 1; i < count; i++) {
        const delta = time[i] - time[i - 1];
        if (!Number.isFinite(delta) || delta <= 0) continue;
        area += 0.5 * (Math.abs(values[i - 1] || 0) + Math.abs(values[i] || 0)) * delta;
    }
    const tolerance = Math.max(1e-12, peak * 1e-9);
    return {
        peak,
        area,
        blockPulse: finiteCount === count && count >= 2 && peak > 0 && max - min <= tolerance,
    };
}

function uniform(values: ArrayLike<number>, cap: number): number[] {
    const n = values.length;
    if (n <= cap) return Array.from(values);
    const step = n / cap;
    return Array.from({ length: cap }, (_, k) => values[Math.floor(k * step)]);
}

/**
 * Plain-array reference shape used by the rendering-equivalence tests.
 */
export function serializeInlineBlocks(blocks: DecodedBlock[]): Array<Record<string, any>> {
    const wrap = (value: number): number => ((value % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return blocks.map(b => {
        const o: Record<string, any> = { i: b.index, s: b.startTime, d: b.duration };
        if (b.rf) {
            const magnitude = downsampleM4(b.rf.timePoints, b.rf.magnitude, MAX_DISPLAY_PTS);
            const metrics = magnitudeMetrics(b.rf.timePoints, b.rf.magnitude);
            o.rf = {
                s: b.rf.startTime, d: b.rf.duration,
                t: magnitude.time, m: magnitude.values,
                pk: metrics.peak, ar: metrics.area, bp: metrics.blockPulse,
                pt: uniform(b.rf.timePoints, MAX_DISPLAY_PTS),
                p: uniform(b.rf.phase, MAX_DISPLAY_PTS).map(wrap),
                a: b.rf.amplitude,
                a0: b.rf.response.carrierAreaDeg,
                rb: b.rf.response.bands.map(v => [
                    v.frequencyOffsetHz, v.spectralAreaDeg, v.polarFlipDeg, v.mz,
                ]),
                rs: b.rf.response.spectrumAnalyzed ? 1 : 0,
                rl: b.rf.response.limited ? 1 : 0,
                fo: b.rf.freqOffset, po: b.rf.phaseOffset, u: b.rf.use || 'u',
            };
        }
        for (const key of ['gx', 'gy', 'gz'] as const) {
            const grad = b[key];
            if (!grad || grad.type === 'none') continue;
            const display = downsampleM4(grad.timePoints, grad.waveform, MAX_DISPLAY_PTS);
            o[key] = {
                s: grad.startTime, d: grad.duration, t: display.time, w: display.values,
                a: grad.amplitude, ty: grad.type, ch: grad.channel,
            };
        }
        if (b.adc) {
            o.adc = {
                s: b.adc.startTime, n: b.adc.numSamples, dw: b.adc.dwell,
                d: b.adc.delay, fo: b.adc.freqOffset, po: b.adc.phaseOffset,
            };
        }
        return o;
    });
}

export function inlineJsonBytes(blocks: DecodedBlock[]): number {
    return JSON.stringify(serializeInlineBlocks(blocks)).length;
}
