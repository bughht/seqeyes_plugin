/**
 * Pulseq .bseq reader for the official v1.5.2 binary layout.
 *
 * The wire format mirrors pulseq/pulseq master readBinary.m,
 * writeBinary.m, and ExternalSequence::loadBinary(). All scalar values are
 * little-endian and all section/count reads are bounds checked.
 */

import { decompressShape } from './decompressor';
import {
    createEmptySequence,
    decodeLabel,
    extensionNameToType,
    extractRasterTimes,
    resetUnknownLabels,
    validateSequence,
} from './readerShared';
import type { LabelIncSpec, LabelSetSpec, PulseqSequence } from './types';
import { makeVersionCombined } from './types';

export const PULSEQ_BINARY_VERSION = Object.freeze({ major: 1, minor: 5, revision: 2 });

const MAGIC = new Uint8Array([0x01, 0x70, 0x75, 0x6c, 0x73, 0x65, 0x71, 0x02]);
const SECTION_PREFIX = 0xffff_ffff_0000_0000n;
const SECTION = Object.freeze({
    definitions: SECTION_PREFIX | 1n,
    blocks: SECTION_PREFIX | 2n,
    rf: SECTION_PREFIX | 3n,
    gradients: SECTION_PREFIX | 4n,
    trapezoids: SECTION_PREFIX | 5n,
    adc: SECTION_PREFIX | 6n,
    legacyDelays: SECTION_PREFIX | 7n,
    shapes: SECTION_PREFIX | 8n,
    extensions: SECTION_PREFIX | 9n,
    triggers: SECTION_PREFIX | 10n,
    labelSet: SECTION_PREFIX | 11n,
    labelInc: SECTION_PREFIX | 12n,
    softDelays: SECTION_PREFIX | 13n,
    rfShims: SECTION_PREFIX | 14n,
    rotations: SECTION_PREFIX | 15n,
    signature: SECTION_PREFIX | 0x00ff_ffffn,
});

const MAX_RECORDS = 100_000_000;
const MAX_STRING_BYTES = 16 * 1024 * 1024;
const MAX_SHAPE_SAMPLES = 100_000_000;
const BINARY_LABELS = Object.freeze([
    'SLC', 'SEG', 'REP', 'AVG', 'SET', 'ECO', 'PHS', 'LIN', 'PAR', 'ACQ', 'TRID',
    'NAV', 'REV', 'SMS', 'REF', 'IMA', 'OFF', 'NOISE', 'PMC', 'NOROT', 'NOPOS',
    'NOSCL', 'ONCE',
]);

export function hasPulseqBinaryMagic(bytes: Uint8Array): boolean {
    if (bytes.byteLength < MAGIC.byteLength) return false;
    for (let i = 0; i < MAGIC.byteLength; i++) {
        if (bytes[i] !== MAGIC[i]) return false;
    }
    return true;
}

export function parseSequenceBinary(bytes: Uint8Array): PulseqSequence {
    const reader = new BinaryReader(bytes);
    const magic = reader.bytes(MAGIC.byteLength, 'file header');
    if (!hasPulseqBinaryMagic(magic)) {
        reader.fail('not a Pulseq binary file', 0);
    }

    const seq = createEmptySequence();
    resetUnknownLabels();
    seq.version.major = reader.safeInt64('version major');
    seq.version.minor = reader.safeInt64('version minor');
    seq.version.revision = reader.safeInt64('version revision');
    seq.versionCombined = makeVersionCombined(
        seq.version.major,
        seq.version.minor,
        seq.version.revision,
    );
    assertSupportedVersion(seq, reader);

    const seenSections = new Set<string>(['VERSION']);
    while (!reader.eof()) {
        const sectionOffset = reader.position;
        const section = reader.uint64('section code');
        switch (section) {
            case SECTION.definitions:
                readDefinitions(reader, seq);
                seenSections.add('DEFINITIONS');
                break;
            case SECTION.blocks:
                readBlocks(reader, seq);
                seenSections.add('BLOCKS');
                break;
            case SECTION.rf:
                readRf(reader, seq);
                seenSections.add('RF');
                break;
            case SECTION.gradients:
                readGradients(reader, seq);
                seenSections.add('GRADIENTS');
                break;
            case SECTION.trapezoids:
                readTrapezoids(reader, seq);
                seenSections.add('TRAP');
                break;
            case SECTION.adc:
                readAdc(reader, seq);
                seenSections.add('ADC');
                break;
            case SECTION.legacyDelays:
                readLegacyDelays(reader);
                break;
            case SECTION.shapes:
                readShapes(reader, seq);
                seenSections.add('SHAPES');
                break;
            case SECTION.extensions:
                readExtensions(reader, seq);
                seenSections.add('EXTENSIONS');
                break;
            case SECTION.triggers:
                readTriggers(reader, seq);
                break;
            case SECTION.labelSet:
                readLabels(reader, seq, true);
                break;
            case SECTION.labelInc:
                readLabels(reader, seq, false);
                break;
            case SECTION.softDelays:
                readSoftDelays(reader, seq);
                break;
            case SECTION.rfShims:
                readRfShims(reader, seq);
                break;
            case SECTION.rotations:
                readRotations(reader, seq);
                break;
            case SECTION.signature:
                readSignature(reader, seq, sectionOffset);
                break;
            default:
                reader.fail(`unknown section code 0x${section.toString(16)}`, sectionOffset);
        }
    }

    extractRasterTimes(seq);
    validateSequence(seq, seenSections);
    return seq;
}

function assertSupportedVersion(seq: PulseqSequence, reader: BinaryReader): void {
    const expected = PULSEQ_BINARY_VERSION;
    if (
        seq.version.major !== expected.major
        || seq.version.minor !== expected.minor
        || seq.version.revision !== expected.revision
    ) {
        reader.fail(
            `unsupported Pulseq binary version ${seq.version.major}.${seq.version.minor}.${seq.version.revision}; expected ${expected.major}.${expected.minor}.${expected.revision}`,
            MAGIC.byteLength,
        );
    }
}

function readDefinitions(reader: BinaryReader, seq: PulseqSequence): void {
    const count = reader.count64('DEFINITIONS count', 9);
    for (let i = 0; i < count; i++) {
        const keyLength = reader.length32('DEFINITIONS key length');
        const key = reader.string(keyLength, 'DEFINITIONS key');
        const valueCount = reader.length32('DEFINITIONS value count', MAX_RECORDS);
        const valueType = reader.char('DEFINITIONS value type');

        if (valueType === 'f') {
            reader.requireArray(valueCount, 8, 'DEFINITIONS float values');
            const values = new Array<number>(valueCount);
            for (let j = 0; j < valueCount; j++) values[j] = reader.float64('DEFINITIONS float value');
            seq.definitions.set(key, values);
            seq.definitionsRaw.set(key, values.join(' '));
        } else if (valueType === 'i') {
            reader.requireArray(valueCount, 4, 'DEFINITIONS integer values');
            const values = new Array<number>(valueCount);
            for (let j = 0; j < valueCount; j++) values[j] = reader.int32('DEFINITIONS integer value');
            seq.definitions.set(key, values);
            seq.definitionsRaw.set(key, values.join(' '));
        } else if (valueType === 'c') {
            const raw = reader.string(valueCount, 'DEFINITIONS character value');
            const value = raw.endsWith('\0') ? raw.slice(0, -1) : raw;
            seq.definitions.set(key, []);
            seq.definitionsRaw.set(key, value);
        } else {
            reader.fail(`unknown definition value type '${valueType}'`);
        }
    }
}

function readBlocks(reader: BinaryReader, seq: PulseqSequence): void {
    const count = reader.count64('BLOCKS count', 32);
    seq.blocks.length = 0;
    for (let i = 0; i < count; i++) {
        seq.blocks.push({
            num: i + 1,
            dur: reader.nonNegativeSafeInt64('BLOCKS duration'),
            rfId: reader.int32('BLOCKS RF id'),
            gxId: reader.int32('BLOCKS Gx id'),
            gyId: reader.int32('BLOCKS Gy id'),
            gzId: reader.int32('BLOCKS Gz id'),
            adcId: reader.int32('BLOCKS ADC id'),
            extId: reader.int32('BLOCKS extension id'),
        });
    }
}

function readRf(reader: BinaryReader, seq: PulseqSequence): void {
    const count = reader.count64('RF count', 73);
    seq.rfs.clear();
    for (let i = 0; i < count; i++) {
        const id = reader.int32('RF id');
        const amplitude = reader.float64('RF amplitude');
        const magShapeId = reader.int32('RF magnitude shape id');
        const phaseShapeId = reader.int32('RF phase shape id');
        const timeShapeId = reader.int32('RF time shape id');
        const center = psToUs(reader.safeInt64('RF center'));
        const delay = psToUsRounded(reader.safeInt64('RF delay'));
        const freqPPM = reader.float64('RF frequency ppm');
        const phasePPM = reader.float64('RF phase ppm');
        const freqOffset = reader.float64('RF frequency offset');
        const phaseOffset = reader.float64('RF phase offset');
        const use = reader.char('RF use').toLowerCase();
        if (!/^[erisu]$/.test(use)) reader.fail(`invalid RF use flag '${use}'`);
        seq.rfs.set(id, {
            id,
            amplitude,
            magShapeId,
            phaseShapeId,
            timeShapeId,
            center,
            delay,
            freqPPM,
            phasePPM,
            freqOffset,
            phaseOffset,
            phaseModShapeId: 0,
            use,
        });
    }
}

function readGradients(reader: BinaryReader, seq: PulseqSequence): void {
    const count = reader.count64('GRADIENTS count', 44);
    for (let i = 0; i < count; i++) {
        const id = reader.int32('GRADIENTS id');
        seq.arbitraryGrads.set(id, {
            id,
            amplitude: reader.float64('GRADIENTS amplitude'),
            first: reader.float64('GRADIENTS first'),
            last: reader.float64('GRADIENTS last'),
            shapeId: reader.int32('GRADIENTS shape id'),
            timeId: reader.int32('GRADIENTS time shape id'),
            delay: psToUsRounded(reader.safeInt64('GRADIENTS delay')),
        });
    }
}

function readTrapezoids(reader: BinaryReader, seq: PulseqSequence): void {
    const count = reader.count64('TRAP count', 44);
    for (let i = 0; i < count; i++) {
        const id = reader.int32('TRAP id');
        seq.trapGrads.set(id, {
            id,
            amplitude: reader.float64('TRAP amplitude'),
            rise: psToUsRounded(reader.safeInt64('TRAP rise')),
            flat: psToUsRounded(reader.safeInt64('TRAP flat')),
            fall: psToUsRounded(reader.safeInt64('TRAP fall')),
            delay: psToUsRounded(reader.safeInt64('TRAP delay')),
        });
    }
}

function readAdc(reader: BinaryReader, seq: PulseqSequence): void {
    const count = reader.count64('ADC count', 64);
    seq.adcs.clear();
    for (let i = 0; i < count; i++) {
        const id = reader.int32('ADC id');
        seq.adcs.set(id, {
            id,
            numSamples: reader.nonNegativeSafeInt64('ADC sample count'),
            dwell: psToNsRounded(reader.safeInt64('ADC dwell')),
            delay: psToUsRounded(reader.safeInt64('ADC delay')),
            freqPPM: reader.float64('ADC frequency ppm'),
            phasePPM: reader.float64('ADC phase ppm'),
            freqOffset: reader.float64('ADC frequency offset'),
            phaseOffset: reader.float64('ADC phase offset'),
            deadTime: 0,
            discardPre: 0,
            discardPost: 0,
            phaseModShapeId: reader.int32('ADC phase shape id'),
        });
    }
}

function readLegacyDelays(reader: BinaryReader): void {
    const count = reader.count64('legacy DELAYS count', 12);
    for (let i = 0; i < count; i++) {
        reader.int32('legacy DELAYS id');
        reader.safeInt64('legacy DELAYS duration');
    }
}

function readShapes(reader: BinaryReader, seq: PulseqSequence): void {
    const count = reader.count64('SHAPES count', 20);
    seq.shapes.clear();
    for (let i = 0; i < count; i++) {
        const id = reader.int32('SHAPES id');
        const numSamples = reader.positiveSafeInt64('SHAPES uncompressed count', MAX_SHAPE_SAMPLES);
        const packedCount = reader.positiveSafeInt64('SHAPES compressed count', MAX_SHAPE_SAMPLES);
        reader.requireArray(packedCount, 4, 'SHAPES compressed data');
        const packed = new Float64Array(packedCount);
        for (let j = 0; j < packedCount; j++) packed[j] = reader.float32('SHAPES sample');
        seq.shapes.set(id, { numSamples, samples: decompressShape(packed, numSamples) });
    }
}

function readExtensions(reader: BinaryReader, seq: PulseqSequence): void {
    const count = reader.count64('EXTENSIONS count', 16);
    seq.extensions.clear();
    for (let i = 0; i < count; i++) {
        const id = reader.int32('EXTENSIONS id');
        seq.extensions.set(id, {
            id,
            type: reader.int32('EXTENSIONS type'),
            ref: reader.int32('EXTENSIONS reference'),
            nextId: reader.int32('EXTENSIONS next id'),
        });
    }
}

function registerExtension(seq: PulseqSequence, id: number, name: string): void {
    seq.extensionNames.set(id, name);
    seq.extensionTypes.set(id, extensionNameToType(name));
}

function readTriggers(reader: BinaryReader, seq: PulseqSequence): void {
    const extensionId = reader.int32('TRIGGERS extension type id');
    registerExtension(seq, extensionId, 'TRIGGERS');
    const count = reader.count64('TRIGGERS count', 28);
    seq.triggers.length = 0;
    for (let i = 0; i < count; i++) {
        seq.triggers.push({
            id: reader.int32('TRIGGERS id'),
            triggerType: reader.int32('TRIGGERS type'),
            channel: reader.int32('TRIGGERS channel'),
            delay: psToUsRounded(reader.safeInt64('TRIGGERS delay')),
            duration: psToUsRounded(reader.safeInt64('TRIGGERS duration')),
        });
    }
}

function readLabels(reader: BinaryReader, seq: PulseqSequence, isSet: boolean): void {
    const section = isSet ? 'LABELSET' : 'LABELINC';
    const extensionId = reader.int32(`${section} extension type id`);
    registerExtension(seq, extensionId, section);
    const count = reader.count64(`${section} count`, 12);
    const library = isSet ? seq.labelSets : seq.labelIncs;
    library.length = 0;
    for (let i = 0; i < count; i++) {
        const id = reader.int32(`${section} id`);
        const value = reader.int32(`${section} value`);
        const labelIndex = reader.int32(`${section} label index`);
        if (labelIndex < 1 || labelIndex > BINARY_LABELS.length) {
            reader.fail(`invalid binary label index ${labelIndex}`);
        }
        const { labelId, flagId } = decodeLabel(BINARY_LABELS[labelIndex - 1]);
        const spec: LabelSetSpec | LabelIncSpec = { id, value, labelId, flagId };
        library.push(spec);
    }
}

function readSoftDelays(reader: BinaryReader, seq: PulseqSequence): void {
    const extensionId = reader.int32('DELAYS extension type id');
    registerExtension(seq, extensionId, 'DELAYS');
    const count = reader.count64('DELAYS count', 28);
    seq.softDelays.length = 0;
    for (let i = 0; i < count; i++) {
        const id = reader.int32('DELAYS id');
        const numId = reader.int32('DELAYS numeric id');
        const offset = psToUsRounded(reader.safeInt64('DELAYS offset'));
        const factor = reader.float64('DELAYS factor');
        const hintLength = reader.length32('DELAYS hint length');
        seq.softDelays.push({ id, numId, offset, factor, hint: reader.string(hintLength, 'DELAYS hint') });
    }
}

function readRfShims(reader: BinaryReader, seq: PulseqSequence): void {
    const extensionId = reader.int32('RF_SHIMS extension type id');
    registerExtension(seq, extensionId, 'RF_SHIMS');
    const count = reader.count64('RF_SHIMS count', 8);
    seq.rfShims.length = 0;
    for (let i = 0; i < count; i++) {
        const id = reader.int32('RF_SHIMS id');
        const nChannels = reader.length32('RF_SHIMS channel count', MAX_RECORDS / 2);
        reader.requireArray(nChannels * 2, 8, 'RF_SHIMS channel data');
        const amplitudes = new Array<number>(nChannels);
        const phases = new Array<number>(nChannels);
        for (let channel = 0; channel < nChannels; channel++) {
            amplitudes[channel] = reader.float64('RF_SHIMS magnitude');
            phases[channel] = reader.float64('RF_SHIMS phase');
        }
        seq.rfShims.push({ id, nChannels, amplitudes, phases });
    }
}

function readRotations(reader: BinaryReader, seq: PulseqSequence): void {
    const extensionId = reader.int32('ROTATIONS extension type id');
    registerExtension(seq, extensionId, 'ROTATIONS');
    const count = reader.count64('ROTATIONS count', 36);
    seq.rotations.length = 0;
    for (let i = 0; i < count; i++) {
        const id = reader.int32('ROTATIONS id');
        const values = [
            reader.float64('ROTATIONS q0'),
            reader.float64('ROTATIONS qx'),
            reader.float64('ROTATIONS qy'),
            reader.float64('ROTATIONS qz'),
        ];
        const norm = Math.hypot(...values);
        if (!Number.isFinite(norm) || norm <= 0) reader.fail('invalid zero or non-finite rotation quaternion');
        seq.rotations.push({ id, values: values.map(value => value / norm) });
    }
}

function readSignature(reader: BinaryReader, seq: PulseqSequence, sectionOffset: number): void {
    const typeLength = reader.length32('SIGNATURE type length');
    const type = reader.string(typeLength, 'SIGNATURE type');
    const hashLength = reader.length32('SIGNATURE hash length');
    const hashBytes = reader.bytes(hashLength, 'SIGNATURE hash');
    const originalSize = reader.nonNegativeSafeInt64('SIGNATURE original size');
    if (originalSize !== sectionOffset) {
        reader.fail(`SIGNATURE original size ${originalSize} does not match section offset ${sectionOffset}`);
    }
    let hash = '';
    for (const byte of hashBytes) hash += byte.toString(16).padStart(2, '0');
    seq.binarySignature = { type, hash, originalSize };
}

function psToUs(value: number): number {
    return value / 1_000_000;
}

function psToUsRounded(value: number): number {
    return value >= 0
        ? Math.floor((value + 500_000) / 1_000_000)
        : Math.ceil((value - 500_000) / 1_000_000);
}

function psToNsRounded(value: number): number {
    return value >= 0
        ? Math.floor((value + 500) / 1_000)
        : Math.ceil((value - 500) / 1_000);
}

export class BinaryReader {
    private readonly view: DataView;
    private offset = 0;

    constructor(private readonly source: Uint8Array) {
        this.view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    }

    get position(): number { return this.offset; }
    get remaining(): number { return this.view.byteLength - this.offset; }
    eof(): boolean { return this.remaining === 0; }

    requireArray(count: number, width: number, context: string): void {
        if (!Number.isSafeInteger(count) || count < 0 || count > MAX_RECORDS) {
            this.fail(`${context} has invalid count ${count}`);
        }
        if (count > Math.floor(this.remaining / width)) {
            this.fail(`${context} exceeds remaining file data`);
        }
    }

    count64(context: string, minimumBytesPerEntry: number): number {
        const count = this.nonNegativeSafeInt64(context);
        if (count > MAX_RECORDS) this.fail(`${context} exceeds limit ${MAX_RECORDS}`);
        if (minimumBytesPerEntry > 0 && count > Math.floor(this.remaining / minimumBytesPerEntry)) {
            this.fail(`${context} exceeds remaining file data`);
        }
        return count;
    }

    length32(context: string, limit = MAX_STRING_BYTES): number {
        const value = this.int32(context);
        if (value < 0 || value > limit) this.fail(`${context} has invalid value ${value}`);
        if (value > this.remaining) this.fail(`${context} exceeds remaining file data`);
        return value;
    }

    positiveSafeInt64(context: string, limit: number): number {
        const value = this.safeInt64(context);
        if (value <= 0 || value > limit) this.fail(`${context} has invalid value ${value}`);
        return value;
    }

    nonNegativeSafeInt64(context: string): number {
        const value = this.safeInt64(context);
        if (value < 0) this.fail(`${context} must be non-negative`);
        return value;
    }

    safeInt64(context: string): number {
        const value = this.int64(context);
        if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
            this.fail(`${context} exceeds JavaScript safe integer range`);
        }
        return Number(value);
    }

    int64(context: string): bigint {
        this.require(8, context);
        const value = this.view.getBigInt64(this.offset, true);
        this.offset += 8;
        return value;
    }

    uint64(context: string): bigint {
        this.require(8, context);
        const value = this.view.getBigUint64(this.offset, true);
        this.offset += 8;
        return value;
    }

    int32(context: string): number {
        this.require(4, context);
        const value = this.view.getInt32(this.offset, true);
        this.offset += 4;
        return value;
    }

    float64(context: string): number {
        this.require(8, context);
        const value = this.view.getFloat64(this.offset, true);
        this.offset += 8;
        if (!Number.isFinite(value)) this.fail(`${context} is not finite`, this.offset - 8);
        return value;
    }

    float32(context: string): number {
        this.require(4, context);
        const value = this.view.getFloat32(this.offset, true);
        this.offset += 4;
        if (!Number.isFinite(value)) this.fail(`${context} is not finite`, this.offset - 4);
        return value;
    }

    char(context: string): string {
        return this.string(1, context);
    }

    string(length: number, context: string): string {
        const data = this.bytes(length, context);
        let result = '';
        const chunkSize = 8192;
        for (let start = 0; start < data.length; start += chunkSize) {
            const end = Math.min(data.length, start + chunkSize);
            result += String.fromCharCode(...data.subarray(start, end));
        }
        return result;
    }

    bytes(length: number, context: string): Uint8Array {
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_STRING_BYTES) {
            this.fail(`${context} has invalid byte length ${length}`);
        }
        this.require(length, context);
        const result = this.source.subarray(this.offset, this.offset + length);
        this.offset += length;
        return result;
    }

    fail(message: string, offset = this.offset): never {
        throw new Error(`Pulseq binary parse error at byte ${offset}: ${message}`);
    }

    private require(length: number, context: string): void {
        if (length < 0 || length > this.remaining) {
            this.fail(`unexpected end of file while reading ${context}`);
        }
    }
}
