/**
 * Pulseq .seq File Reader
 *
 * Parses text‑based Pulseq files (v1.4.x – v1.5.x).  The format consists of
 * named sections delimited by `[SECTION_NAME]` headers.  Each section contains
 * structured text data — either key‑value pairs, tables, or sample lists.
 *
 * Section order:
 *   [VERSION] → [DEFINITIONS] → [BLOCKS] → [RF] → [GRADIENTS] →
 *   [TRAP] → [ADC] → [EXTENSIONS] → [SHAPES] → [SIGNATURE]
 */

import { decompressShape } from './decompressor';
import type {
    PulseqSequence, BlockEntry, RFEntry, ArbitraryGradEntry,
    TrapGradEntry, ADCEntry, ExtensionEntry, TriggerSpec, NCOSpec,
} from './types';

// ─── Public API ───────────────────────────────────────────────────────────

/** Parse a .seq file from its text content. */
export function parseSequenceText(text: string): PulseqSequence {
    const lines = text.split(/\r?\n/);
    const seq = createEmptySequence();

    let sectionName: string | null = null;
    let sectionLines: string[] = [];

    for (const line of lines) {
        const m = line.match(/^\[(\w+)\]$/);
        if (m) {
            if (sectionName) dispatchSection(seq, sectionName, sectionLines);
            sectionName = m[1];
            sectionLines = [];
        } else {
            sectionLines.push(line);
        }
    }
    if (sectionName) dispatchSection(seq, sectionName, sectionLines);

    extractRasterTimes(seq);
    return seq;
}

// ─── Section dispatcher ───────────────────────────────────────────────────

function dispatchSection(seq: PulseqSequence, name: string, lines: string[]): void {
    const valid = lines.filter(l => { const t = l.trim(); return t && !t.startsWith('#'); });
    switch (name) {
        case 'VERSION':    parseVersion(seq, valid);     break;
        case 'DEFINITIONS': parseDefinitions(seq, valid); break;
        case 'BLOCKS':     parseBlocks(seq, valid);       break;
        case 'RF':         parseRF(seq, valid);           break;
        case 'GRADIENTS':  parseArbitraryGrads(seq, valid); break;
        case 'TRAP':       parseTrapGrads(seq, valid);    break;
        case 'ADC':        parseADC(seq, valid);          break;
        case 'EXTENSIONS': parseExtensions(seq, valid, lines); break;
        case 'SHAPES':     parseShapes(seq, lines);       break;
        // [SIGNATURE] — intentionally ignored
    }
}

function createEmptySequence(): PulseqSequence {
    return {
        version: { major: 1, minor: 0, revision: 0 },
        definitions: new Map(),
        definitionsRaw: new Map(),
        blocks: [],
        rfs: new Map(),
        arbitraryGrads: new Map(),
        trapGrads: new Map(),
        adcs: new Map(),
        extensions: new Map(),
        triggers: [],
        ncos: [],
        shapes: new Map(),
        rasterTimes: { blockDurationRaster: 1e-5, gradientRaster: 1e-5, rfRaster: 1e-6, adcRaster: 1e-7 },
    };
}

// ─── Section parsers ──────────────────────────────────────────────────────

function parseVersion(seq: PulseqSequence, lines: string[]): void {
    for (const line of lines) {
        const [k, v] = line.trim().split(/\s+/);
        const n = parseInt(v, 10);
        if (k === 'major') seq.version.major = n;
        else if (k === 'minor') seq.version.minor = n;
        else if (k === 'revision') seq.version.revision = n;
    }
}

function parseDefinitions(seq: PulseqSequence, lines: string[]): void {
    for (const line of lines) {
        const idx = line.search(/\s/);
        if (idx < 0) { seq.definitions.set(line.trim(), []); continue; }
        const key = line.substring(0, idx);
        const vals = line.substring(idx + 1).trim().split(/\s+/).map(Number).filter(n => !isNaN(n));
        seq.definitions.set(key, vals);
        seq.definitionsRaw.set(key, line.substring(idx + 1).trim());
    }
}

function parseBlocks(seq: PulseqSequence, lines: string[]): void {
    for (const line of lines) {
        const p = line.trim().split(/\s+/);
        if (p.length >= 8) {
            seq.blocks.push({
                num: +p[0], dur: +p[1],
                rfId: +p[2], gxId: +p[3], gyId: +p[4], gzId: +p[5],
                adcId: +p[6], extId: +p[7],
            });
        }
    }
}

function parseRF(seq: PulseqSequence, lines: string[]): void {
    const isV15 = seq.version.minor >= 5;
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        // Strip trailing use flag ('e'|'i'|'s'|'u')
        let use = '';
        if (parts.length && /^[iesu]$/i.test(parts[parts.length - 1])) {
            use = parts.pop()!.toLowerCase();
        }
        if (parts.length < 6) continue;
        const id = +parts[0];
        if (isV15) {
            // v1.5+:  amp  mag ph  time  delay  phOff  freq  [mod]
            seq.rfs.set(id, {
                id, amplitude: +parts[1],
                magShapeId: +parts[2], phaseShapeId: +parts[3],
                timeShapeId: +parts[4], delay: +parts[5],
                phaseOffset: +parts[6], freqOffset: +parts[7],
                phaseModShapeId: parts.length > 8 ? +parts[8] : 0,
                use,
            });
        } else {
            // v1.4.x: amp  mag ph  [time]  [phOff]  [freq]  [mod]
            seq.rfs.set(id, {
                id, amplitude: +parts[1],
                magShapeId: +parts[2], phaseShapeId: +parts[3],
                timeShapeId: parts.length > 4 ? +parts[4] : 0,
                delay: 0,  // v1.4.x has no explicit RF delay
                phaseOffset: parts.length > 5 ? +parts[5] : 0,
                freqOffset: parts.length > 6 ? +parts[6] : 0,
                phaseModShapeId: parts.length > 7 ? +parts[7] : 0,
                use: '',
            });
        }
    }
}

function parseArbitraryGrads(seq: PulseqSequence, lines: string[]): void {
    const isV15 = seq.version.minor >= 5;
    for (const line of lines) {
        const p = line.trim().split(/\s+/);
        if (p.length < 4) continue;
        const id = +p[0];
        if (isV15) {
            // v1.5+:  amp  first  last  shapeId  timeId  delay
            seq.arbitraryGrads.set(id, {
                id, amplitude: +p[1],
                first: +p[2], last: +p[3],
                shapeId: +p[4], timeId: p.length > 5 ? +p[5] : 0,
                delay: p.length > 6 ? +p[6] : 0,
            });
        } else {
            // v1.4.x:  amp  shapeId  timeId  timeRange
            seq.arbitraryGrads.set(id, {
                id, amplitude: +p[1],
                first: 0, last: 0,
                shapeId: +p[2], timeId: p.length > 3 ? +p[3] : 0,
                delay: p.length > 4 ? +p[4] : 0,
            });
        }
    }
}

function parseTrapGrads(seq: PulseqSequence, lines: string[]): void {
    for (const line of lines) {
        const p = line.trim().split(/\s+/);
        if (p.length >= 5) {
            seq.trapGrads.set(+p[0], {
                id: +p[0], amplitude: +p[1],
                rise: +p[2], flat: +p[3], fall: +p[4],
                delay: p.length > 5 ? +p[5] : 0,
            });
        }
    }
}

function parseADC(seq: PulseqSequence, lines: string[]): void {
    const isV15 = seq.version.minor >= 5;
    for (const line of lines) {
        const p = line.trim().split(/\s+/);
        if (p.length < 5) continue;
        const id = +p[0];
        if (isV15) {
            // v1.5+:  nSamp  dwell  delay  freq  phOff  dead  pre  post  [mod]
            seq.adcs.set(id, {
                id, numSamples: +p[1], dwell: +p[2], delay: +p[3],
                freqOffset: +p[4], phaseOffset: +p[5],
                deadTime: p.length > 6 ? +p[6] : 0,
                discardPre: p.length > 7 ? +p[7] : 0,
                discardPost: p.length > 8 ? +p[8] : 0,
                phaseModShapeId: p.length > 9 ? +p[9] : 0,
            });
        } else {
            seq.adcs.set(id, {
                id, numSamples: +p[1], dwell: +p[2], delay: +p[3],
                freqOffset: p.length > 4 ? +p[4] : 0,
                phaseOffset: p.length > 5 ? +p[5] : 0,
                deadTime: 0, discardPre: 0, discardPost: 0,
                phaseModShapeId: p.length > 6 ? +p[6] : 0,
            });
        }
    }
}

function parseExtensions(seq: PulseqSequence, valid: string[], allLines: string[]): void {
    let inList = true;
    const extLines: string[] = [];
    for (const line of valid) {
        if (line.startsWith('extension ')) { inList = false; extLines.push(line); continue; }
        if (inList) {
            const p = line.trim().split(/\s+/);
            if (p.length >= 4) seq.extensions.set(+p[0], { id: +p[0], type: +p[1], ref: +p[2], nextId: +p[3] });
        } else {
            extLines.push(line);
        }
    }

    // Parse embedded extension specs (TRIGGERS, NCO, …)
    let i = 0;
    while (i < extLines.length) {
        const line = extLines[i].trim();
        if (line.startsWith('extension TRIGGERS')) {
            i++;
            while (i < extLines.length && !extLines[i].trim().startsWith('extension ')) {
                const p = extLines[i].trim().split(/\s+/);
                if (p.length >= 5) seq.triggers.push({ id: +p[0], channel: +p[2], delay: +p[3], duration: +p[4] });
                i++;
            }
        } else if (line.startsWith('extension NCO')) {
            i++;
            while (i < extLines.length && !extLines[i].trim().startsWith('extension ')) {
                const p = extLines[i].trim().split(/\s+/);
                if (p.length >= 6) seq.ncos.push({ id: +p[0], channel: +p[1], frequency: +p[2], phase: +p[3], delay: +p[4], duration: +p[5] });
                i++;
            }
        } else {
            i++;
        }
    }
}

function parseShapes(seq: PulseqSequence, lines: string[]): void {
    let i = 0;
    while (i < lines.length) {
        const t = lines[i].trim();
        if (!t || t.startsWith('#') || t.startsWith('[')) { i++; continue; }

        const m = t.match(/^shape_id\s+(\d+)/);
        if (!m) { i++; continue; }
        const shapeId = +m[1];
        i++;

        // Find num_samples
        let numSamples = 0;
        while (i < lines.length) {
            const l = lines[i].trim();
            if (!l || l.startsWith('#')) { i++; continue; }
            const nm = l.match(/^num_samples\s+(\d+)/);
            if (nm) { numSamples = +nm[1]; i++; break; }
            if (l.match(/^shape_id\s+\d+/) || l.startsWith('[')) break;
            i++;
        }
        if (numSamples <= 0) continue;

        // Read sample values
        const vals: number[] = [];
        while (i < lines.length && vals.length < numSamples) {
            const l = lines[i].trim();
            if (l.match(/^shape_id\s+\d+/) || (l.startsWith('[') && !l.startsWith('[') === false)) break;
            if (!l || l.startsWith('#')) { i++; continue; }
            for (const n of l.split(/\s+/).map(Number).filter(x => !isNaN(x))) {
                if (vals.length < numSamples) vals.push(n);
            }
            i++;
        }
        if (vals.length === 0) continue;

        storeShape(seq, shapeId, numSamples, vals);
    }
}

function storeShape(seq: PulseqSequence, id: number, num: number, raw: number[]): void {
    const decompressed = raw.length === num
        ? new Float64Array(raw)
        : decompressShape(raw, num);

    // Clamp / normalise to [0, 1]
    const max = Math.max(...decompressed);
    const min = Math.min(...decompressed);
    if (max > 1.5 || min < -0.5) {
        const range = max - min || 1;
        for (let i = 0; i < num; i++) decompressed[i] = (decompressed[i] - min) / range;
    }
    for (let i = 0; i < num; i++) {
        if (decompressed[i] < 0) decompressed[i] = 0;
        if (decompressed[i] > 1) decompressed[i] = 1;
    }
    seq.shapes.set(id, { numSamples: num, samples: decompressed });
}

// ─── Raster times from definitions ────────────────────────────────────────

function extractRasterTimes(seq: PulseqSequence): void {
    const set = (key: string, field: keyof typeof seq.rasterTimes) => {
        const v = seq.definitions.get(key);
        if (v?.length) (seq.rasterTimes as any)[field] = v[0];
    };
    set('BlockDurationRaster', 'blockDurationRaster');
    set('GradientRasterTime', 'gradientRaster');
    set('RadiofrequencyRasterTime', 'rfRaster');
    set('AdcRasterTime', 'adcRaster');
}
