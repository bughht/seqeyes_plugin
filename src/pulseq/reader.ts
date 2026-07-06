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
    ExtType, makeVersionCombined, VER_PRE_14, VER_V15, VER_V15001,
} from './types';

// ─── Public API ───────────────────────────────────────────────────────────

/** Parse a .seq file from its text content. */
export function parseSequenceText(text: string): PulseqSequence {
    const lines = text.split(/\r?\n/);
    const seq = createEmptySequence();
    const seenSections = new Set<string>();

    let sectionName: string | null = null;
    let sectionLines: string[] = [];

    for (const line of lines) {
        const m = line.match(/^\[(\w+)\]$/);
        if (m) {
            if (sectionName) dispatchSection(seq, sectionName, sectionLines);
            sectionName = m[1];
            seenSections.add(sectionName);
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
    validateSequence(seq, seenSections);
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
        extensionNames: new Map(),
        extensionTypes: new Map(),
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

function parseError(message: string): never {
    throw new Error(`Pulseq parse error: ${message}`);
}

function requireFieldCount(section: string, line: string, count: number, allowed: number | number[]): void {
    const allowedCounts = Array.isArray(allowed) ? allowed : [allowed];
    if (!allowedCounts.includes(count)) {
        parseError(`${section} row has ${count} fields, expected ${allowedCounts.join(' or ')}: ${line}`);
    }
}

function toNumber(value: string, section: string, line: string): number {
    const n = Number(value);
    if (!Number.isFinite(n)) parseError(`${section} row contains a non-numeric field '${value}': ${line}`);
    return n;
}

function toInt(value: string, section: string, line: string): number {
    const n = toNumber(value, section, line);
    if (!Number.isInteger(n)) parseError(`${section} row contains a non-integer field '${value}': ${line}`);
    return n;
}

function splitFields(line: string): string[] {
    return line.trim().split(/\s+/);
}

// ─── Section parsers ──────────────────────────────────────────────────────

function parseVersion(seq: PulseqSequence, lines: string[]): void {
    for (const line of lines) {
        const p = splitFields(line);
        requireFieldCount('VERSION', line, p.length, 2);
        const [k, v] = p;
        const n = toInt(v, 'VERSION', line);
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
        const p = splitFields(line);
        requireFieldCount('BLOCKS', line, p.length, [7, 8]);
        const num = toInt(p[0], 'BLOCKS', line);
        const extId = p.length === 8 ? toInt(p[7], 'BLOCKS', line) : 0;

        if (vc < VER_PRE_14) {
            // Pre‑v1.4: block duration is in µs, NOT raster units.
            // Format: num dur_us rf gx gy gz adc ext
            seq.blocks.push({
                num,
                dur: toNumber(p[1], 'BLOCKS', line),
                rfId: toInt(p[2], 'BLOCKS', line), gxId: toInt(p[3], 'BLOCKS', line), gyId: toInt(p[4], 'BLOCKS', line), gzId: toInt(p[5], 'BLOCKS', line),
                adcId: toInt(p[6], 'BLOCKS', line), extId,
            });
        } else {
            // v1.4+: duration in block‑duration‑raster units
            seq.blocks.push({
                num, dur: toNumber(p[1], 'BLOCKS', line),
                rfId: toInt(p[2], 'BLOCKS', line), gxId: toInt(p[3], 'BLOCKS', line), gyId: toInt(p[4], 'BLOCKS', line), gzId: toInt(p[5], 'BLOCKS', line),
                adcId: toInt(p[6], 'BLOCKS', line), extId,
            });
        }
    }
}

// ─── RF ───────────────────────────────────────────────────────────────────

function parseRF(seq: PulseqSequence, lines: string[]): void {
    const vc = ver(seq);
    for (const line of lines) {
        const parts = splitFields(line);
        const id = toInt(parts[0], 'RF', line);
        const amp = toNumber(parts[1], 'RF', line);
        const magId = toInt(parts[2], 'RF', line);
        const phId = toInt(parts[3], 'RF', line);

        if (vc >= VER_V15) {
            // v1.5.x: 12 fields
            //   id amp mag ph timeShape CENTER(us) delay(us) freqPPM phasePPM freq(Hz) phase(rad) use
            requireFieldCount('RF', line, parts.length, 12);
            const use = parts[11].toLowerCase();
            if (!/^[erisu]$/.test(use)) parseError(`RF row has invalid use flag '${parts[11]}': ${line}`);
            seq.rfs.set(id, {
                id, amplitude: amp,
                magShapeId: magId, phaseShapeId: phId,
                timeShapeId: toInt(parts[4], 'RF', line),
                center: toNumber(parts[5], 'RF', line),
                delay: toNumber(parts[6], 'RF', line),
                freqPPM: toNumber(parts[7], 'RF', line),
                phasePPM: toNumber(parts[8], 'RF', line),
                freqOffset: toNumber(parts[9], 'RF', line),
                phaseOffset: toNumber(parts[10], 'RF', line),
                phaseModShapeId: 0,
                use,
            });
        } else if (vc >= VER_PRE_14) {
            // v1.4.x: 8 fields
            //   id amp mag ph timeShape delay freq(Hz) phase(rad)
            requireFieldCount('RF', line, parts.length, 8);
            seq.rfs.set(id, {
                id, amplitude: amp,
                magShapeId: magId, phaseShapeId: phId,
                timeShapeId: toInt(parts[4], 'RF', line),
                center: -1,                                          // not in v1.4.x
                delay: toNumber(parts[5], 'RF', line),
                freqPPM: 0, phasePPM: 0,
                freqOffset: toNumber(parts[6], 'RF', line),
                phaseOffset: toNumber(parts[7], 'RF', line),
                phaseModShapeId: 0,
                use: 'u',
            });
        } else {
            // Pre‑v1.4: 7 fields, no timeShape
            //   id amp mag ph delay freq(Hz) phase(rad)
            requireFieldCount('RF', line, parts.length, 7);
            seq.rfs.set(id, {
                id, amplitude: amp,
                magShapeId: magId, phaseShapeId: phId,
                timeShapeId: 0,
                center: -1,
                delay: toNumber(parts[4], 'RF', line),
                freqPPM: 0, phasePPM: 0,
                freqOffset: toNumber(parts[5], 'RF', line),
                phaseOffset: toNumber(parts[6], 'RF', line),
                phaseModShapeId: 0,
                use: 'u',
            });
        }
    }
}

// ─── Gradients ────────────────────────────────────────────────────────────

function parseArbitraryGrads(seq: PulseqSequence, lines: string[]): void {
    const vc = ver(seq);
    for (const line of lines) {
        const p = splitFields(line);
        const id = toInt(p[0], 'GRADIENTS', line);
        if (vc >= VER_V15) {
            // v1.5+: 7 fields — amp first last shapeId timeId delay
            requireFieldCount('GRADIENTS', line, p.length, 7);
            seq.arbitraryGrads.set(id, {
                id, amplitude: toNumber(p[1], 'GRADIENTS', line),
                first: toNumber(p[2], 'GRADIENTS', line), last: toNumber(p[3], 'GRADIENTS', line),
                shapeId: toInt(p[4], 'GRADIENTS', line), timeId: toInt(p[5], 'GRADIENTS', line),
                delay: toNumber(p[6], 'GRADIENTS', line),
            });
        } else if (vc >= VER_PRE_14) {
            // v1.4.x: 5 fields — amp shapeId timeId delay
            requireFieldCount('GRADIENTS', line, p.length, 5);
            seq.arbitraryGrads.set(id, {
                id, amplitude: toNumber(p[1], 'GRADIENTS', line),
                first: NaN, last: NaN,
                shapeId: toInt(p[2], 'GRADIENTS', line), timeId: toInt(p[3], 'GRADIENTS', line),
                delay: toNumber(p[4], 'GRADIENTS', line),
            });
        } else {
            // Pre‑v1.4: 4 fields — amp shapeId delay
            requireFieldCount('GRADIENTS', line, p.length, 4);
            seq.arbitraryGrads.set(id, {
                id, amplitude: toNumber(p[1], 'GRADIENTS', line),
                first: NaN, last: NaN,
                shapeId: toInt(p[2], 'GRADIENTS', line), timeId: 0,
                delay: toNumber(p[3], 'GRADIENTS', line),
            });
        }
    }
}

function parseTrapGrads(seq: PulseqSequence, lines: string[]): void {
    for (const line of lines) {
        const p = splitFields(line);
        requireFieldCount('TRAP', line, p.length, 6);
        const id = toInt(p[0], 'TRAP', line);
        seq.trapGrads.set(id, {
            id, amplitude: toNumber(p[1], 'TRAP', line),
            rise: toNumber(p[2], 'TRAP', line), flat: toNumber(p[3], 'TRAP', line), fall: toNumber(p[4], 'TRAP', line),
            delay: toNumber(p[5], 'TRAP', line),
        });
    }
}

// ─── ADC ──────────────────────────────────────────────────────────────────

function parseADC(seq: PulseqSequence, lines: string[]): void {
    const vc = ver(seq);
    for (const line of lines) {
        const p = splitFields(line);
        const id = toInt(p[0], 'ADC', line);
        if (vc >= VER_V15) {
            // v1.5.x: 9 fields
            //   id num dwell(ns) delay(us) freqPPM phasePPM freq(Hz) phase(rad) phase_id
            requireFieldCount('ADC', line, p.length, 9);
            seq.adcs.set(id, {
                id, numSamples: toInt(p[1], 'ADC', line), dwell: toNumber(p[2], 'ADC', line), delay: toNumber(p[3], 'ADC', line),
                freqPPM: toNumber(p[4], 'ADC', line),
                phasePPM: toNumber(p[5], 'ADC', line),
                freqOffset: toNumber(p[6], 'ADC', line),
                phaseOffset: toNumber(p[7], 'ADC', line),
                deadTime: 0, discardPre: 0, discardPost: 0,
                phaseModShapeId: toInt(p[8], 'ADC', line),
            });
        } else {
            // v1.4.x (and pre‑v1.4): 6 fields
            //   id num dwell(ns) delay(us) freq(Hz) phase(rad)
            requireFieldCount('ADC', line, p.length, 6);
            seq.adcs.set(id, {
                id, numSamples: toInt(p[1], 'ADC', line), dwell: toNumber(p[2], 'ADC', line), delay: toNumber(p[3], 'ADC', line),
                freqPPM: 0, phasePPM: 0,
                freqOffset: toNumber(p[4], 'ADC', line),
                phaseOffset: toNumber(p[5], 'ADC', line),
                deadTime: 0, discardPre: 0, discardPost: 0,
                phaseModShapeId: 0,
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
    _unknownLabelCounter = 0;
    _unknownLabels.clear();
    let i = 0;

    // Phase 1 — linked‑list entries (before first "extension …" line)
    while (i < valid.length) {
        const line = valid[i].trim();
        if (line.startsWith('extension ')) break;
        const p = splitFields(line);
        requireFieldCount('EXTENSIONS', line, p.length, 4);
        const id = toInt(p[0], 'EXTENSIONS', line);
        seq.extensions.set(id, {
            id,
            type: toInt(p[1], 'EXTENSIONS', line),
            ref: toInt(p[2], 'EXTENSIONS', line),
            nextId: toInt(p[3], 'EXTENSIONS', line),
        });
        i++;
    }

    // Phase 2 — extension type blocks
    while (i < valid.length) {
        const line = valid[i].trim();
        const extM = line.match(/^extension\s+(\w+)\s+(\d+)/i);
        if (!extM) { i++; continue; }

        const extName = extM[1].toUpperCase();
        const extId = +extM[2];
        seq.extensionNames.set(extId, extName);
        seq.extensionTypes.set(extId, extensionNameToType(extName));
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

function extensionNameToType(name: string): ExtType {
    switch (name.toUpperCase()) {
        case 'TRIGGERS': return ExtType.EXT_TRIGGER;
        case 'ROTATIONS': return ExtType.EXT_ROTATION;
        case 'LABELSET': return ExtType.EXT_LABELSET;
        case 'LABELINC': return ExtType.EXT_LABELINC;
        case 'DELAYS': return ExtType.EXT_DELAY;
        case 'RF_SHIMS': return ExtType.EXT_RF_SHIM;
        case 'NCO': return ExtType.EXT_NCO;
        default: return ExtType.EXT_UNKNOWN;
    }
}

function parseTriggerSpecs(seq: PulseqSequence, lines: string[]): void {
    for (const line of lines) {
        const p = splitFields(line);
        // Format: id triggerType channel delay(us) duration(us)
        requireFieldCount('TRIGGERS', line, p.length, 5);
        seq.triggers.push({
            id: toInt(p[0], 'TRIGGERS', line),
            triggerType: toInt(p[1], 'TRIGGERS', line),
            channel: toInt(p[2], 'TRIGGERS', line),
            delay: toNumber(p[3], 'TRIGGERS', line),
            duration: toNumber(p[4], 'TRIGGERS', line),
        });
    }
}

function parseNCOSpecs(seq: PulseqSequence, lines: string[]): void {
    for (const line of lines) {
        const p = splitFields(line);
        // Format: id channel freq(Hz) phase(rad) delay(us) duration(us)
        requireFieldCount('NCO', line, p.length, 6);
        seq.ncos.push({
            id: toInt(p[0], 'NCO', line), channel: toInt(p[1], 'NCO', line),
            frequency: toNumber(p[2], 'NCO', line), phase: toNumber(p[3], 'NCO', line),
            delay: toNumber(p[4], 'NCO', line), duration: toNumber(p[5], 'NCO', line),
        });
    }
}

function parseRotationSpecs(seq: PulseqSequence, lines: string[], vc: number): void {
    for (const line of lines) {
        const p = splitFields(line);
        if (vc >= VER_V15) {
            // v1.5+: quaternion (4 values) — id q0 q1 q2 q3
            requireFieldCount('ROTATIONS', line, p.length, 5);
            const [q0, q1, q2, q3] = [
                toNumber(p[1], 'ROTATIONS', line),
                toNumber(p[2], 'ROTATIONS', line),
                toNumber(p[3], 'ROTATIONS', line),
                toNumber(p[4], 'ROTATIONS', line),
            ];
            const norm = Math.sqrt(q0 * q0 + q1 * q1 + q2 * q2 + q3 * q3);
            if (Math.abs(norm - 1) > 1e-3 || norm === 0) {
                parseError(`ROTATIONS row has a non-normalized quaternion: ${line}`);
            }
            seq.rotations.push({
                id: toInt(p[0], 'ROTATIONS', line),
                values: [q0 / norm, q1 / norm, q2 / norm, q3 / norm],
            });
        } else {
            // v1.4.x: 3×3 rotation matrix (9 values) — id r11 r12 r13 … r33
            requireFieldCount('ROTATIONS', line, p.length, 10);
            seq.rotations.push({
                id: toInt(p[0], 'ROTATIONS', line),
                values: p.slice(1, 10).map(v => toNumber(v, 'ROTATIONS', line)),
            });
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
    'REP':  { labelId: 2,  flagId: 0 },
    'AVG':  { labelId: 3,  flagId: 0 },
    'ECO':  { labelId: 4,  flagId: 0 },
    'PHS':  { labelId: 5,  flagId: 0 },
    'SET':  { labelId: 6,  flagId: 0 },
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
        id = 1000 + _unknownLabelCounter++;
        _unknownLabels.set(name, id);
    }
    return { labelId: id, flagId: 0 };
}

function parseLabelSpecs(seq: PulseqSequence, lines: string[], isSet: boolean): void {
    for (const line of lines) {
        const p = splitFields(line);
        // Format: id value LABELNAME
        requireFieldCount(isSet ? 'LABELSET' : 'LABELINC', line, p.length, 3);
        const { labelId, flagId } = decodeLabel(p[2]);
        const spec: LabelSetSpec | LabelIncSpec = {
            id: toInt(p[0], isSet ? 'LABELSET' : 'LABELINC', line),
            value: toNumber(p[1], isSet ? 'LABELSET' : 'LABELINC', line),
            labelId, flagId,
        };
        if (isSet) seq.labelSets.push(spec);
        else seq.labelIncs.push(spec);
    }
}

function parseSoftDelaySpecs(seq: PulseqSequence, lines: string[]): void {
    for (const line of lines) {
        const p = splitFields(line);
        // Format: id numID offset(us) factor [hint_string]
        if (p.length < 4) parseError(`DELAYS row has ${p.length} fields, expected at least 4: ${line}`);
        const hintMatch = line.match(/^\s*\S+\s+\S+\s+\S+\s+\S+\s*(.*)$/);
        seq.softDelays.push({
            id: toInt(p[0], 'DELAYS', line), numId: toInt(p[1], 'DELAYS', line),
            offset: toNumber(p[2], 'DELAYS', line), factor: toNumber(p[3], 'DELAYS', line),
            hint: hintMatch ? hintMatch[1].trim() : '',
        });
    }
}

function parseRFShimSpecs(seq: PulseqSequence, lines: string[]): void {
    for (const line of lines) {
        const p = splitFields(line);
        // Format: id nchan [amp phase]×nchan
        if (p.length < 2) parseError(`RF_SHIMS row has ${p.length} fields, expected at least 2: ${line}`);
        const nChan = toInt(p[1], 'RF_SHIMS', line);
        requireFieldCount('RF_SHIMS', line, p.length, 2 + nChan * 2);
        const amps: number[] = [];
        const phases: number[] = [];
        for (let c = 0; c < nChan; c++) {
            amps.push(toNumber(p[2 + c * 2], 'RF_SHIMS', line));
            phases.push(toNumber(p[2 + c * 2 + 1], 'RF_SHIMS', line));
        }
        seq.rfShims.push({ id: toInt(p[0], 'RF_SHIMS', line), nChannels: nChan, amplitudes: amps, phases });
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

function validateSequence(seq: PulseqSequence, seenSections: Set<string>): void {
    if (!seenSections.has('VERSION')) parseError('Required [VERSION] section is missing');
    if (seq.version.major !== 1 || seq.version.minor > 5) {
        parseError(`Unsupported Pulseq version ${seq.version.major}.${seq.version.minor}.${seq.version.revision}`);
    }

    const vc = ver(seq);
    if (vc >= VER_PRE_14) {
        requireNumericDefinition(seq, 'AdcRasterTime');
        requireNumericDefinition(seq, 'GradientRasterTime');
        requireNumericDefinition(seq, 'RadiofrequencyRasterTime');
        requireNumericDefinition(seq, 'BlockDurationRaster');
    }

    if (vc >= VER_V15001) {
        const required = seq.definitionsRaw.get('RequiredExtensions')?.split(/\s+/).filter(Boolean) ?? [];
        for (const name of required) {
            if (extensionNameToType(name) === ExtType.EXT_UNKNOWN) {
                parseError(`Unknown required extension '${name}'`);
            }
        }
    }

    if (!seenSections.has('BLOCKS')) parseError('Required [BLOCKS] section is missing');

    for (const block of seq.blocks) {
        if (block.rfId > 0 && !seq.rfs.has(block.rfId)) {
            parseError(`Block ${block.num} references undefined RF event ${block.rfId}`);
        }
        for (const [channel, gradId] of [['GX', block.gxId], ['GY', block.gyId], ['GZ', block.gzId]] as const) {
            if (gradId > 0 && !seq.arbitraryGrads.has(gradId) && !seq.trapGrads.has(gradId)) {
                parseError(`Block ${block.num} references undefined ${channel} gradient event ${gradId}`);
            }
        }
        if (block.adcId > 0 && !seq.adcs.has(block.adcId)) {
            parseError(`Block ${block.num} references undefined ADC event ${block.adcId}`);
        }
        if (block.extId > 0 && !seq.extensions.has(block.extId)) {
            parseError(`Block ${block.num} references undefined extension list ${block.extId}`);
        }
    }

    for (const ext of seq.extensions.values()) {
        if (ext.nextId > 0 && !seq.extensions.has(ext.nextId)) {
            parseError(`Extension list ${ext.id} references undefined next extension ${ext.nextId}`);
        }
        const type = seq.extensionTypes.get(ext.type) ?? ExtType.EXT_UNKNOWN;
        if (type === ExtType.EXT_UNKNOWN) continue;
        if (!extensionPayloadExists(seq, type, ext.ref)) {
            const name = seq.extensionNames.get(ext.type) ?? `type ${ext.type}`;
            parseError(`Extension list ${ext.id} references undefined ${name} payload ${ext.ref}`);
        }
    }
}

function requireNumericDefinition(seq: PulseqSequence, name: string): void {
    const value = seq.definitions.get(name);
    if (!value || value.length === 0 || !Number.isFinite(value[0])) {
        parseError(`Required definition ${name} is not present in the file`);
    }
}

function extensionPayloadExists(seq: PulseqSequence, type: ExtType, ref: number): boolean {
    switch (type) {
        case ExtType.EXT_TRIGGER: return seq.triggers.some(v => v.id === ref);
        case ExtType.EXT_ROTATION: return seq.rotations.some(v => v.id === ref);
        case ExtType.EXT_LABELSET: return seq.labelSets.some(v => v.id === ref);
        case ExtType.EXT_LABELINC: return seq.labelIncs.some(v => v.id === ref);
        case ExtType.EXT_DELAY: return seq.softDelays.some(v => v.id === ref);
        case ExtType.EXT_RF_SHIM: return seq.rfShims.some(v => v.id === ref);
        case ExtType.EXT_NCO: return seq.ncos.some(v => v.id === ref);
        default: return false;
    }
}
