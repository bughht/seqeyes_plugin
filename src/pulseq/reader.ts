/**
 * Pulseq .seq File Reader
 *
 * Parses text‑based Pulseq files (v1.2.0 – v1.5.x).  The format consists of
 * named sections delimited by `[SECTION_NAME]` headers.
 *
 * Strategy (matching SeqEyes): a SINGLE loader with per‑section version gating
 * using a unified `versionCombined` integer.  Thresholds:
 *   <  VER_PRE_14  (1_004_000) — pre‑v1.4  (no timeShape, old block format)
 *   <  VER_V15     (1_005_000) — v1.4.x   (timeShape added)
 *  >=  VER_V15     (1_005_000) — v1.5.x   (PPM, centre, quaternion rotations)
 *  >=  VER_V15001  (1_005_001) — RequiredExtensions check added
 *
 * Section order:
 *   [VERSION] → [DEFINITIONS] → [BLOCKS] → [RF] → [GRADIENTS] →
 *   [TRAP] → [ADC] → [EXTENSIONS] → [SHAPES] → [SIGNATURE]
 */

import { decompressShape } from './decompressor';
import type {
    PulseqSequence, BlockEntry, RFEntry, ArbitraryGradEntry,
    TrapGradEntry, ADCEntry, ExtensionEntry, TriggerSpec, NCOSpec,
    RotationSpec, LabelSetSpec, LabelIncSpec, SoftDelaySpec, RFShimSpec,
} from './types';
import {
    makeVersionCombined, VER_PRE_14, VER_V15, VER_V15001,
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

    // Compute versionCombined AFTER parsing [VERSION]
    seq.versionCombined = makeVersionCombined(
        seq.version.major, seq.version.minor, seq.version.revision,
    );

    extractRasterTimes(seq);
    return seq;
}

// ─── Section dispatcher ───────────────────────────────────────────────────

function dispatchSection(seq: PulseqSequence, name: string, lines: string[]): void {
    const valid = lines.filter(l => { const t = l.trim(); return t && !t.startsWith('#'); });
    switch (name) {
        case 'VERSION':     parseVersion(seq, valid);     break;
        case 'DEFINITIONS': parseDefinitions(seq, valid); break;
        case 'BLOCKS':      parseBlocks(seq, valid);      break;
        case 'RF':          parseRF(seq, valid);          break;
        case 'GRADIENTS':   parseArbitraryGrads(seq, valid); break;
        case 'TRAP':        parseTrapGrads(seq, valid);   break;
        case 'ADC':         parseADC(seq, valid);         break;
        case 'EXTENSIONS':  parseExtensions(seq, valid);  break;
        case 'SHAPES':      parseShapes(seq, lines);      break;
        // [SIGNATURE] — intentionally ignored
    }
}

function createEmptySequence(): PulseqSequence {
    return {
        version: { major: 1, minor: 0, revision: 0 },
        versionCombined: 0,
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
        rotations: [],
        labelSets: [],
        labelIncs: [],
        softDelays: [],
        rfShims: [],
        shapes: new Map(),
        rasterTimes: { blockDurationRaster: 1e-5, gradientRaster: 1e-5, rfRaster: 1e-6, adcRaster: 1e-7 },
    };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Get the combined version from the already‑parsed `seq.version`.
 * Must be called AFTER `parseVersion()`.  We use a closure variable so that
 * sections parsed before [VERSION] (shouldn't happen in practice) get 0.
 *
 * For robustness, we compute it lazily from the already‑set version fields.
 */
function ver(seq: PulseqSequence): number {
    if (seq.versionCombined > 0) return seq.versionCombined;
    // Fallback: compute on‑the‑fly (in case sections are parsed out of order)
    return makeVersionCombined(seq.version.major, seq.version.minor, seq.version.revision);
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
    // Pre‑compute combined version immediately
    seq.versionCombined = makeVersionCombined(
        seq.version.major, seq.version.minor, seq.version.revision,
    );
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

// ─── Blocks ───────────────────────────────────────────────────────────────

function parseBlocks(seq: PulseqSequence, lines: string[]): void {
    const vc = ver(seq);
    for (const line of lines) {
        const p = line.trim().split(/\s+/);
        if (p.length < 8) continue;
        const num = +p[0];

        if (vc < VER_PRE_14) {
            // Pre‑v1.4: block duration is in µs, NOT raster units.
            // Format: num dur_us rf gx gy gz adc ext
            seq.blocks.push({
                num,
                dur: +p[1],  // raw µs — will be converted to raster‑units later
                rfId: +p[2], gxId: +p[3], gyId: +p[4], gzId: +p[5],
                adcId: +p[6], extId: +p[7],
            });
        } else {
            // v1.4+: duration in block‑duration‑raster units
            seq.blocks.push({
                num, dur: +p[1],
                rfId: +p[2], gxId: +p[3], gyId: +p[4], gzId: +p[5],
                adcId: +p[6], extId: +p[7],
            });
        }
    }
}

// ─── RF ───────────────────────────────────────────────────────────────────

function parseRF(seq: PulseqSequence, lines: string[]): void {
    const vc = ver(seq);
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        // Strip trailing use flag ('e'|'r'|'i'|'s'|'u')
        let use = '';
        if (parts.length && /^[erisu]$/i.test(parts[parts.length - 1])) {
            use = parts.pop()!.toLowerCase();
        }
        if (parts.length < 6) continue;
        const id = +parts[0];
        const amp = +parts[1];
        const magId = +parts[2];
        const phId = +parts[3];

        if (vc >= VER_V15) {
            // v1.5.x: 12 fields
            //   id amp mag ph timeShape CENTER(us) delay(us) freqPPM phasePPM freq(Hz) phase(rad) use
            seq.rfs.set(id, {
                id, amplitude: amp,
                magShapeId: magId, phaseShapeId: phId,
                timeShapeId: +parts[4],
                center: parts.length > 5 ? +parts[5] : -1,         // [5] = centre (µs)
                delay: parts.length > 6 ? +parts[6] : 0,           // [6] = delay (µs)
                freqPPM: parts.length > 7 ? +parts[7] : 0,         // [7] = freqPPM
                phasePPM: parts.length > 8 ? +parts[8] : 0,        // [8] = phasePPM
                freqOffset: parts.length > 9 ? +parts[9] : 0,      // [9] = freq (Hz)
                phaseOffset: parts.length > 10 ? +parts[10] : 0,   // [10] = phase (rad)
                phaseModShapeId: 0,
                use,
            });
        } else if (vc >= VER_PRE_14) {
            // v1.4.x: 7‑8 fields (timeShape added)
            //   id amp mag ph [timeShape] delay freq(Hz) phase(rad) [mod]
            const hasTimeShape = parts.length >= 8;
            const timeShapeId = hasTimeShape ? +parts[4] : 0;
            const offset = hasTimeShape ? 1 : 0;  // shift if timeShape present
            seq.rfs.set(id, {
                id, amplitude: amp,
                magShapeId: magId, phaseShapeId: phId,
                timeShapeId,
                center: -1,                                          // not in v1.4.x
                delay: +parts[4 + offset],                           // delay
                freqPPM: 0, phasePPM: 0,
                freqOffset: parts.length > 5 + offset ? +parts[5 + offset] : 0,
                phaseOffset: parts.length > 6 + offset ? +parts[6 + offset] : 0,
                phaseModShapeId: parts.length > 7 + offset ? +parts[7 + offset] : 0,
                use: '',
            });
        } else {
            // Pre‑v1.4: 7 fields, no timeShape
            //   id amp mag ph delay freq(Hz) phase(rad) [mod]
            seq.rfs.set(id, {
                id, amplitude: amp,
                magShapeId: magId, phaseShapeId: phId,
                timeShapeId: 0,
                center: -1,
                delay: +parts[4],
                freqPPM: 0, phasePPM: 0,
                freqOffset: parts.length > 5 ? +parts[5] : 0,
                phaseOffset: parts.length > 6 ? +parts[6] : 0,
                phaseModShapeId: parts.length > 7 ? +parts[7] : 0,
                use: '',
            });
        }
    }
}

// ─── Gradients ────────────────────────────────────────────────────────────

function parseArbitraryGrads(seq: PulseqSequence, lines: string[]): void {
    const vc = ver(seq);
    for (const line of lines) {
        const p = line.trim().split(/\s+/);
        if (p.length < 4) continue;
        const id = +p[0];
        if (vc >= VER_V15) {
            // v1.5+: 7 fields — amp first last shapeId timeId delay
            seq.arbitraryGrads.set(id, {
                id, amplitude: +p[1],
                first: +p[2], last: +p[3],
                shapeId: +p[4], timeId: p.length > 5 ? +p[5] : 0,
                delay: p.length > 6 ? +p[6] : 0,
            });
        } else if (vc >= VER_PRE_14) {
            // v1.4.x: 5‑6 fields — amp shapeId [timeId] [delay]
            seq.arbitraryGrads.set(id, {
                id, amplitude: +p[1],
                first: 0, last: 0,
                shapeId: +p[2], timeId: p.length > 3 ? +p[3] : 0,
                delay: p.length > 4 ? +p[4] : 0,
            });
        } else {
            // Pre‑v1.4: 4 fields — amp shapeId delay
            seq.arbitraryGrads.set(id, {
                id, amplitude: +p[1],
                first: 0, last: 0,
                shapeId: +p[2], timeId: 0,
                delay: p.length > 3 ? +p[3] : 0,
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

// ─── ADC ──────────────────────────────────────────────────────────────────

function parseADC(seq: PulseqSequence, lines: string[]): void {
    const vc = ver(seq);
    for (const line of lines) {
        const p = line.trim().split(/\s+/);
        if (p.length < 5) continue;
        const id = +p[0];
        if (vc >= VER_V15) {
            // v1.5.x: 9 fields
            //   id num dwell(ns) delay(us) freqPPM phasePPM freq(Hz) phase(rad) phase_id
            seq.adcs.set(id, {
                id, numSamples: +p[1], dwell: +p[2], delay: +p[3],
                freqPPM: p.length > 4 ? +p[4] : 0,
                phasePPM: p.length > 5 ? +p[5] : 0,
                freqOffset: p.length > 6 ? +p[6] : 0,
                phaseOffset: p.length > 7 ? +p[7] : 0,
                deadTime: 0, discardPre: 0, discardPost: 0,
                phaseModShapeId: p.length > 8 ? +p[8] : 0,
            });
        } else {
            // v1.4.x (and pre‑v1.4): 6 fields
            //   id num dwell(ns) delay(us) freq(Hz) phase(rad)
            seq.adcs.set(id, {
                id, numSamples: +p[1], dwell: +p[2], delay: +p[3],
                freqPPM: 0, phasePPM: 0,
                freqOffset: p.length > 4 ? +p[4] : 0,
                phaseOffset: p.length > 5 ? +p[5] : 0,
                deadTime: 0, discardPre: 0, discardPost: 0,
                phaseModShapeId: p.length > 6 ? +p[6] : 0,
            });
        }
    }
}

// ─── Extensions ───────────────────────────────────────────────────────────

/**
 * Parse the [EXTENSIONS] section.
 *
 * Mimics SeqEyes' state‑machine approach:
 *   1. First part: the extension linked‑list (id type ref nextId).
 *   2. Then: `extension <NAME> <ID>` headers followed by type‑specific data lines.
 */
function parseExtensions(seq: PulseqSequence, valid: string[]): void {
    const vc = ver(seq);
    let i = 0;

    // Phase 1 — linked‑list entries (before first "extension …" line)
    while (i < valid.length) {
        const line = valid[i].trim();
        if (line.startsWith('extension ')) break;
        const p = line.split(/\s+/);
        if (p.length >= 4) {
            seq.extensions.set(+p[0], {
                id: +p[0], type: +p[1], ref: +p[2], nextId: +p[3],
            });
        }
        i++;
    }

    // Phase 2 — extension type blocks
    while (i < valid.length) {
        const line = valid[i].trim();
        const extM = line.match(/^extension\s+(\w+)\s+(\d+)/i);
        if (!extM) { i++; continue; }

        const extName = extM[1].toUpperCase();
        const extId = +extM[2];
        i++;

        // Collect data lines until next "extension …" header
        const dataLines: string[] = [];
        while (i < valid.length && !valid[i].trim().startsWith('extension ')) {
            dataLines.push(valid[i].trim());
            i++;
        }

        switch (extName) {
            case 'TRIGGERS':  parseTriggerSpecs(seq, dataLines); break;
            case 'NCO':       parseNCOSpecs(seq, dataLines); break;
            case 'ROTATIONS': parseRotationSpecs(seq, dataLines, vc); break;
            case 'LABELSET':  parseLabelSpecs(seq, dataLines, true); break;
            case 'LABELINC':  parseLabelSpecs(seq, dataLines, false); break;
            case 'DELAYS':    parseSoftDelaySpecs(seq, dataLines); break;
            case 'RF_SHIMS':  parseRFShimSpecs(seq, dataLines); break;
            default:
                // Unknown extension — silently ignored (SeqEyes behaviour)
                break;
        }
    }
}

function parseTriggerSpecs(seq: PulseqSequence, lines: string[]): void {
    for (const line of lines) {
        const p = line.split(/\s+/);
        // Format: id triggerType channel delay(us) duration(us)
        if (p.length >= 5) {
            seq.triggers.push({
                id: +p[0],
                triggerType: +p[1],
                channel: +p[2],
                delay: +p[3],
                duration: +p[4],
            });
        }
    }
}

function parseNCOSpecs(seq: PulseqSequence, lines: string[]): void {
    for (const line of lines) {
        const p = line.split(/\s+/);
        // Format: id channel freq(Hz) phase(rad) delay(us) duration(us)
        if (p.length >= 6) {
            seq.ncos.push({
                id: +p[0], channel: +p[1],
                frequency: +p[2], phase: +p[3],
                delay: +p[4], duration: +p[5],
            });
        }
    }
}

function parseRotationSpecs(seq: PulseqSequence, lines: string[], vc: number): void {
    for (const line of lines) {
        const p = line.split(/\s+/).map(Number);
        if (vc >= VER_V15) {
            // v1.5+: quaternion (4 values) — id q0 q1 q2 q3
            if (p.length >= 5) {
                // Normalise quaternion to unit length (SeqEyes does this)
                const [q0, q1, q2, q3] = [p[1], p[2], p[3], p[4]];
                const norm = Math.sqrt(q0 * q0 + q1 * q1 + q2 * q2 + q3 * q3) || 1;
                seq.rotations.push({
                    id: p[0],
                    values: [q0 / norm, q1 / norm, q2 / norm, q3 / norm],
                });
            }
        } else {
            // v1.4.x: 3×3 rotation matrix (9 values) — id r11 r12 r13 … r33
            if (p.length >= 10) {
                seq.rotations.push({ id: p[0], values: p.slice(1, 10) });
            }
        }
    }
}

/**
 * Label name → (labelId, flagId) decoding.
 * SeqEyes maps label string names to Mdh_Label enum values.
 * Unknown labels get dynamically assigned IDs starting at 1000.
 */
const KNOWN_LABELS: Record<string, { labelId: number; flagId: number }> = {
    'SLC':  { labelId: 0,  flagId: 0 },
    'SEG':  { labelId: 1,  flagId: 0 },
    'ECO':  { labelId: 2,  flagId: 0 },
    'PHS':  { labelId: 3,  flagId: 0 },
    'REP':  { labelId: 4,  flagId: 0 },
    'SET':  { labelId: 5,  flagId: 0 },
    'AVG':  { labelId: 6,  flagId: 0 },
    'ACQ':  { labelId: 7,  flagId: 0 },
    'LIN':  { labelId: 8,  flagId: 0 },
    'PAR':  { labelId: 9,  flagId: 0 },
    'ONCE': { labelId: 10, flagId: 0 },
    'NAV':  { labelId: 0,  flagId: 1 },
    'REV':  { labelId: 0,  flagId: 2 },
    'SMS':  { labelId: 0,  flagId: 4 },
    'REF':  { labelId: 0,  flagId: 8 },
    'IMA':  { labelId: 0,  flagId: 16 },
    'OFF':  { labelId: 0,  flagId: 32 },
    'NOISE':{ labelId: 0,  flagId: 64 },
    'PMC':  { labelId: 0,  flagId: 128 },
    'NOPOS':{ labelId: 0,  flagId: 256 },
    'NOROT':{ labelId: 0,  flagId: 512 },
    'NOSCL':{ labelId: 0,  flagId: 1024 },
};

let _unknownLabelCounter = 0;
const _unknownLabels = new Map<string, number>();

function decodeLabel(name: string): { labelId: number; flagId: number } {
    const known = KNOWN_LABELS[name];
    if (known) return known;
    // Dynamic assignment for unknown labels (e.g., TRID) — SeqEyes uses 1000+
    let id = _unknownLabels.get(name);
    if (id === undefined) {
        id = 1000 + (++_unknownLabelCounter);
        _unknownLabels.set(name, id);
    }
    return { labelId: id, flagId: 0 };
}

function parseLabelSpecs(seq: PulseqSequence, lines: string[], isSet: boolean): void {
    for (const line of lines) {
        const p = line.split(/\s+/);
        // Format: id value LABELNAME
        if (p.length < 3) continue;
        const { labelId, flagId } = decodeLabel(p[2]);
        const spec: LabelSetSpec | LabelIncSpec = {
            id: +p[0], value: +p[1], labelId, flagId,
        };
        if (isSet) seq.labelSets.push(spec);
        else seq.labelIncs.push(spec);
    }
}

function parseSoftDelaySpecs(seq: PulseqSequence, lines: string[]): void {
    for (const line of lines) {
        const p = line.split(/\s+/);
        // Format: id numID offset(us) factor [hint_string]
        if (p.length >= 4) {
            const hintIdx = line.search(/[a-zA-Z]/);  // crude hint extraction
            seq.softDelays.push({
                id: +p[0], numId: +p[1],
                offset: +p[2], factor: +p[3],
                hint: hintIdx > 0 ? line.substring(hintIdx).trim() : '',
            });
        }
    }
}

function parseRFShimSpecs(seq: PulseqSequence, lines: string[]): void {
    for (const line of lines) {
        const p = line.split(/\s+/);
        // Format: id nchan [amp phase]×nchan
        if (p.length < 2) continue;
        const nChan = +p[1];
        const amps: number[] = [];
        const phases: number[] = [];
        for (let c = 0; c < nChan && 2 + c * 2 + 1 < p.length; c++) {
            amps.push(+p[2 + c * 2]);
            phases.push(+p[2 + c * 2 + 1]);
        }
        seq.rfShims.push({ id: +p[0], nChannels: nChan, amplitudes: amps, phases });
    }
}

// ─── Shapes ───────────────────────────────────────────────────────────────

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
            if (l.match(/^shape_id\s+\d+/) || l.startsWith('[')) break;
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
    // SeqEyes: decompress if run‑length encoded, otherwise use raw values as‑is.
    // NO normalisation, NO clamping — amplitude shapes are already [0,1],
    // time shapes are in grad‑raster units (can be large integers).
    const decompressed = raw.length === num
        ? new Float64Array(raw)
        : decompressShape(raw, num);
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
