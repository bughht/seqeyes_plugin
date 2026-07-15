import type { PulseqSequence } from './types';
import { ExtType, makeVersionCombined, VER_PRE_14, VER_V15001 } from './types';

/** Create the format-neutral in-memory representation used by both readers. */
export function createEmptySequence(): PulseqSequence {
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

export function parseError(message: string): never {
    throw new Error(`Pulseq parse error: ${message}`);
}

export function extensionNameToType(name: string): ExtType {
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

let unknownLabelCounter = 0;
const unknownLabels = new Map<string, number>();

export function resetUnknownLabels(): void {
    unknownLabelCounter = 0;
    unknownLabels.clear();
}

export function decodeLabel(name: string): { labelId: number; flagId: number } {
    const known = KNOWN_LABELS[name];
    if (known) return known;
    let id = unknownLabels.get(name);
    if (id === undefined) {
        id = 1000 + unknownLabelCounter++;
        unknownLabels.set(name, id);
    }
    return { labelId: id, flagId: 0 };
}

export function extractRasterTimes(seq: PulseqSequence): void {
    const set = (key: string, field: keyof typeof seq.rasterTimes) => {
        const value = seq.definitions.get(key);
        if (value?.length) (seq.rasterTimes as any)[field] = value[0];
    };
    set('BlockDurationRaster', 'blockDurationRaster');
    set('GradientRasterTime', 'gradientRaster');
    set('RadiofrequencyRasterTime', 'rfRaster');
    set('AdcRasterTime', 'adcRaster');
}

/** Apply the same required-section, definition, and reference checks to every format. */
export function validateSequence(seq: PulseqSequence, seenSections: Set<string>): void {
    if (!seenSections.has('VERSION')) parseError('Required [VERSION] section is missing');
    if (seq.version.major !== 1 || seq.version.minor > 5) {
        parseError(`Unsupported Pulseq version ${seq.version.major}.${seq.version.minor}.${seq.version.revision}`);
    }

    const version = seq.versionCombined > 0
        ? seq.versionCombined
        : makeVersionCombined(seq.version.major, seq.version.minor, seq.version.revision);
    if (version >= VER_PRE_14) {
        requireNumericDefinition(seq, 'AdcRasterTime');
        requireNumericDefinition(seq, 'GradientRasterTime');
        requireNumericDefinition(seq, 'RadiofrequencyRasterTime');
        requireNumericDefinition(seq, 'BlockDurationRaster');
    }

    if (version >= VER_V15001) {
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
        case ExtType.EXT_TRIGGER: return seq.triggers.some(value => value.id === ref);
        case ExtType.EXT_ROTATION: return seq.rotations.some(value => value.id === ref);
        case ExtType.EXT_LABELSET: return seq.labelSets.some(value => value.id === ref);
        case ExtType.EXT_LABELINC: return seq.labelIncs.some(value => value.id === ref);
        case ExtType.EXT_DELAY: return seq.softDelays.some(value => value.id === ref);
        case ExtType.EXT_RF_SHIM: return seq.rfShims.some(value => value.id === ref);
        case ExtType.EXT_NCO: return seq.ncos.some(value => value.id === ref);
        default: return false;
    }
}
