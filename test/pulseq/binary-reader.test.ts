import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BinaryReader, hasPulseqBinaryMagic, parseSequenceBinary } from '../../src/pulseq/binaryReader';
import { decodeAllBlocks, getTotalDuration } from '../../src/pulseq/decoder';
import { calculateKspace } from '../../src/pulseq/kspace';
import { parseSequenceText } from '../../src/pulseq/reader';
import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';
import type { DecodedBlock, PulseqSequence } from '../../src/pulseq/types';

const fixtureDir = join(__dirname, 'binary');
const fixtureNames = ['gre', 'epi_rs'] as const;

function readBytes(name: string): Uint8Array {
    return readFileSync(join(fixtureDir, name));
}

function parsePair(name: typeof fixtureNames[number]): { text: PulseqSequence; binary: PulseqSequence } {
    return {
        text: parseSequenceText(readFileSync(join(fixtureDir, `${name}.seq`), 'utf8')),
        binary: parseSequenceBinary(readBytes(`${name}.bseq`)),
    };
}

describe('Pulseq binary reader', () => {
    it.each(fixtureNames)('detects and parses the official %s.bseq fixture', (name) => {
        const bytes = readBytes(`${name}.bseq`);
        expect(hasPulseqBinaryMagic(bytes)).toBe(true);

        const direct = parseSequenceBinary(bytes);
        const dispatched = parseSequenceBytes(bytes, `${name}.bseq`);

        expect(direct.version).toEqual({ major: 1, minor: 5, revision: 2 });
        expect(dispatched.blocks).toHaveLength(direct.blocks.length);
        expect(direct.blocks.length).toBeGreaterThan(0);
        expect(direct.binarySignature?.type).toBe('md5');
        expect(direct.binarySignature?.hash).toMatch(/^[0-9a-f]{32}$/);
    });

    it.each(fixtureNames)('matches official text structure for %s', (name) => {
        const { text, binary } = parsePair(name);

        expect(binary.version.major).toBe(text.version.major);
        expect(binary.version.minor).toBe(text.version.minor);
        expect(binary.version.revision).toBe(2);
        expect(binary.rasterTimes).toEqual(text.rasterTimes);
        expect(binary.blocks).toEqual(text.blocks);
        expect(binary.rfs.size).toBe(text.rfs.size);
        expect(binary.arbitraryGrads.size).toBe(text.arbitraryGrads.size);
        expect(binary.trapGrads.size).toBe(text.trapGrads.size);
        expect(binary.adcs.size).toBe(text.adcs.size);
        expect(binary.shapes.size).toBe(text.shapes.size);
        expect(binary.extensions.size).toBe(text.extensions.size);

        for (const [key, values] of text.definitions) {
            const binaryValues = binary.definitions.get(key);
            expect(binaryValues, `numeric definition ${key}`).toHaveLength(values.length);
            const tolerance = Math.max(1e-12, maxAbs(values) * 1e-8);
            expect(maxAbsDiff(binaryValues!, values), `numeric definition ${key}`).toBeLessThanOrEqual(tolerance);
        }
        for (const [key, raw] of text.definitionsRaw) {
            if ((text.definitions.get(key)?.length ?? 0) === 0) {
                expect(binary.definitionsRaw.get(key), `string definition ${key}`).toBe(raw);
            }
        }
    });

    it.each(fixtureNames)('matches decoded waveform timing and values for %s', (name) => {
        const { text, binary } = parsePair(name);
        const decodedText = decodeAllBlocks(text);
        const decodedBinary = decodeAllBlocks(binary);

        expect(decodedBinary).toHaveLength(decodedText.length);
        compareDecodedBlocks(decodedText, decodedBinary);
    });

    it.each(fixtureNames)('matches ADC k-space for %s', (name) => {
        const { text, binary } = parsePair(name);
        const kText = calculateKspace(
            decodeAllBlocks(text),
            text.rasterTimes.gradientRaster,
            getTotalDuration(text),
            0,
            { rfRaster: text.rasterTimes.rfRaster, gradientSupport: 'all' },
        );
        const kBinary = calculateKspace(
            decodeAllBlocks(binary),
            binary.rasterTimes.gradientRaster,
            getTotalDuration(binary),
            0,
            { rfRaster: binary.rasterTimes.rfRaster, gradientSupport: 'all' },
        );

        expect(kText).not.toBeNull();
        expect(kBinary).not.toBeNull();
        expect(kBinary!.t_adc).toEqual(kText!.t_adc);
        for (let axis = 0; axis < 3; axis++) {
            expect(kBinary!.ktraj_adc[axis]).toHaveLength(kText!.ktraj_adc[axis].length);
            expect(maxAbsDiff(kBinary!.ktraj_adc[axis], kText!.ktraj_adc[axis])).toBeLessThan(0.002);
        }
    });

    it('dispatches ordinary text bytes without changing text parser behavior', () => {
        const bytes = readBytes('gre.seq');
        const parsed = parseSequenceBytes(bytes, 'gre.seq');
        expect(parsed.blocks).toHaveLength(320);
    });

    it('rejects a .bseq filename without the binary magic', () => {
        expect(() => parseSequenceBytes(new TextEncoder().encode('[VERSION]\n'), 'fake.bseq'))
            .toThrow(/missing the Pulseq binary header/);
    });

    it('rejects bad magic and a short binary preamble deterministically', () => {
        const badMagic = new Uint8Array(readBytes('gre.bseq'));
        badMagic[0] = 0;
        expect(() => parseSequenceBinary(badMagic)).toThrow(/not a Pulseq binary file/);
        expect(() => parseSequenceBinary(readBytes('gre.bseq').subarray(0, 12)))
            .toThrow(/unexpected end of file while reading version major/);
    });

    it('uses binary magic as the authoritative detector', () => {
        const parsed = parseSequenceBytes(readBytes('gre.bseq'), 'renamed.seq');
        expect(parsed.version).toEqual({ major: 1, minor: 5, revision: 2 });
        expect(parsed.blocks).toHaveLength(320);
    });

    it('rejects truncated official input with a byte offset', () => {
        const bytes = readBytes('gre.bseq');
        expect(() => parseSequenceBinary(bytes.subarray(0, 100))).toThrow(/byte \d+.*(unexpected end of file|exceeds remaining file data)/);
    });

    it('rejects an unknown section code', () => {
        const source = readBytes('gre.bseq');
        const bytes = new Uint8Array(source.length + 8);
        bytes.set(source);
        new DataView(bytes.buffer).setBigUint64(source.length, 0xffff_ffff_0000_1234n, true);
        expect(() => parseSequenceBinary(bytes)).toThrow(/unknown section code/);
    });

    it('rejects a signature whose original-size pointer is inconsistent', () => {
        const bytes = new Uint8Array(readBytes('gre.bseq'));
        new DataView(bytes.buffer).setBigInt64(bytes.length - 8, 0n, true);
        expect(() => parseSequenceBinary(bytes)).toThrow(/SIGNATURE original size/);
    });

    it('bounds-checks primitives and rejects unsafe int64 conversion', () => {
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigInt64(0, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true);
        expect(() => new BinaryReader(bytes).safeInt64('test integer')).toThrow(/safe integer range/);
        expect(() => new BinaryReader(new Uint8Array(3)).int32('test integer')).toThrow(/unexpected end of file/);
    });

    it('decodes every official extension payload and typed definitions', () => {
        const seq = parseSequenceBinary(makeExtensionFixture());

        expect(seq.definitions.get('TestInts')).toEqual([3, -2, 7]);
        expect(seq.definitionsRaw.get('TestString')).toBe('hello');
        expect(seq.blocks[0].extId).toBe(1);
        expect(seq.extensions.size).toBe(6);
        expect(seq.triggers).toEqual([{ id: 1, triggerType: 2, channel: 3, delay: 2, duration: 3 }]);
        expect(seq.labelSets[0]).toMatchObject({ id: 1, value: 5, labelId: 0, flagId: 0 });
        expect(seq.labelIncs[0]).toMatchObject({ id: 1, value: 1, labelId: 10, flagId: 0 });
        expect(seq.softDelays).toEqual([{ id: 1, numId: 9, offset: -2, factor: 0.5, hint: 'TE' }]);
        expect(seq.rfShims).toEqual([{
            id: 1,
            nChannels: 2,
            amplitudes: [0.75, 0.25],
            phases: [0.1, -0.2],
        }]);
        expect(seq.rotations).toEqual([{ id: 1, values: [1, 0, 0, 0] }]);
    });

    it('rejects invalid binary label indices and zero quaternions', () => {
        expect(() => parseSequenceBinary(makeExtensionFixture({ labelIndex: 24 }))).toThrow(/label index 24/);
        expect(() => parseSequenceBinary(makeExtensionFixture({ quaternion: [0, 0, 0, 0] }))).toThrow(/rotation quaternion/);
    });

    it('rejects section counts beyond the allocation limit', () => {
        const writer = binaryPreamble();
        writer.uint64(SECTION_PREFIX | 1n);
        writer.int64(100_000_001);
        expect(() => parseSequenceBinary(writer.toBytes())).toThrow(/DEFINITIONS count exceeds limit/);
    });

    it('rejects negative section counts and unknown definition types', () => {
        const negativeCount = binaryPreamble();
        negativeCount.uint64(SECTION_PREFIX | 1n);
        negativeCount.int64(-1);
        expect(() => parseSequenceBinary(negativeCount.toBytes())).toThrow(/DEFINITIONS count must be non-negative/);

        const invalidType = binaryPreamble();
        invalidType.uint64(SECTION_PREFIX | 1n);
        invalidType.int64(1);
        writeDefinitionHeader(invalidType, 'Invalid', 0, 'x');
        expect(() => parseSequenceBinary(invalidType.toBytes())).toThrow(/unknown definition value type 'x'/);
    });

    it('rejects unsupported binary revisions and broken event references', () => {
        const unsupported = binaryPreamble({ revision: 3 });
        expect(() => parseSequenceBinary(unsupported.toBytes())).toThrow(/unsupported Pulseq binary version 1\.5\.3/);

        expect(() => parseSequenceBinary(makeMinimalFixture({ rfId: 99 })))
            .toThrow(/Block 1 references undefined RF event 99/);
    });
});

function compareDecodedBlocks(expected: DecodedBlock[], actual: DecodedBlock[]): void {
    let maxGradient = 0;
    let maxGradientDiff = 0;
    let maxRfDiff = 0;

    for (let i = 0; i < expected.length; i++) {
        expect(actual[i].startTime).toBe(expected[i].startTime);
        expect(actual[i].duration).toBe(expected[i].duration);

        for (const channel of ['gx', 'gy', 'gz'] as const) {
            const left = expected[i][channel];
            const right = actual[i][channel];
            expect(!!right, `block ${i + 1} ${channel} presence`).toBe(!!left);
            if (!left || !right) continue;
            expect(right.timePoints).toEqual(left.timePoints);
            expect(right.waveform).toHaveLength(left.waveform.length);
            maxGradientDiff = Math.max(maxGradientDiff, maxAbsDiff(left.waveform, right.waveform));
            maxGradient = Math.max(maxGradient, maxAbs(left.waveform), maxAbs(right.waveform));
        }

        expect(!!actual[i].rf, `block ${i + 1} RF presence`).toBe(!!expected[i].rf);
        if (expected[i].rf && actual[i].rf) {
            expect(actual[i].rf!.timePoints).toEqual(expected[i].rf!.timePoints);
            maxRfDiff = Math.max(maxRfDiff, maxAbsDiff(expected[i].rf!.magnitude, actual[i].rf!.magnitude));
        }
    }

    expect(maxGradientDiff).toBeLessThanOrEqual(maxGradient * 5e-6);
    expect(maxRfDiff).toBeLessThan(0.001);
}

function maxAbs(values: ArrayLike<number>): number {
    let maximum = 0;
    for (let i = 0; i < values.length; i++) maximum = Math.max(maximum, Math.abs(values[i]));
    return maximum;
}

function maxAbsDiff(left: ArrayLike<number>, right: ArrayLike<number>): number {
    if (left.length !== right.length) return Number.POSITIVE_INFINITY;
    let maximum = 0;
    for (let i = 0; i < left.length; i++) maximum = Math.max(maximum, Math.abs(left[i] - right[i]));
    return maximum;
}

const SECTION_PREFIX = 0xffff_ffff_0000_0000n;

function makeExtensionFixture(options: { labelIndex?: number; quaternion?: number[] } = {}): Uint8Array {
    const writer = binaryPreamble();

    writer.uint64(SECTION_PREFIX | 1n);
    writer.int64(7);
    writeFloatDefinition(writer, 'AdcRasterTime', [1e-7]);
    writeFloatDefinition(writer, 'GradientRasterTime', [1e-5]);
    writeFloatDefinition(writer, 'RadiofrequencyRasterTime', [1e-6]);
    writeFloatDefinition(writer, 'BlockDurationRaster', [1e-5]);
    writeIntegerDefinition(writer, 'TestInts', [3, -2, 7]);
    writeStringDefinition(writer, 'TestString', 'hello\0');
    writeStringDefinition(writer, 'RequiredExtensions', 'TRIGGERS LABELSET LABELINC DELAYS RF_SHIMS ROTATIONS');

    writer.uint64(SECTION_PREFIX | 2n);
    writer.int64(1);
    writer.int64(10);
    for (const id of [0, 0, 0, 0, 0, 1]) writer.int32(id);

    writer.uint64(SECTION_PREFIX | 7n);
    writer.int64(1);
    writer.int32(1);
    writer.int64(10_000_000);

    writer.uint64(SECTION_PREFIX | 9n);
    writer.int64(6);
    for (let i = 0; i < 6; i++) {
        writer.int32(i + 1);
        writer.int32(101 + i);
        writer.int32(1);
        writer.int32(i < 5 ? i + 2 : 0);
    }

    writer.uint64(SECTION_PREFIX | 10n);
    writer.int32(101);
    writer.int64(1);
    writer.int32(1);
    writer.int32(2);
    writer.int32(3);
    writer.int64(1_500_000);
    writer.int64(2_500_000);

    writer.uint64(SECTION_PREFIX | 11n);
    writer.int32(102);
    writer.int64(1);
    writer.int32(1);
    writer.int32(5);
    writer.int32(options.labelIndex ?? 1);

    writer.uint64(SECTION_PREFIX | 12n);
    writer.int32(103);
    writer.int64(1);
    writer.int32(1);
    writer.int32(1);
    writer.int32(23);

    writer.uint64(SECTION_PREFIX | 13n);
    writer.int32(104);
    writer.int64(1);
    writer.int32(1);
    writer.int32(9);
    writer.int64(-1_500_000);
    writer.float64(0.5);
    writer.int32(2);
    writer.text('TE');

    writer.uint64(SECTION_PREFIX | 14n);
    writer.int32(105);
    writer.int64(1);
    writer.int32(1);
    writer.int32(2);
    for (const value of [0.75, 0.1, 0.25, -0.2]) writer.float64(value);

    writer.uint64(SECTION_PREFIX | 15n);
    writer.int32(106);
    writer.int64(1);
    writer.int32(1);
    for (const value of options.quaternion ?? [2, 0, 0, 0]) writer.float64(value);

    return writer.toBytes();
}

function makeMinimalFixture(options: { rfId?: number } = {}): Uint8Array {
    const writer = binaryPreamble();
    writer.uint64(SECTION_PREFIX | 1n);
    writer.int64(4);
    writeFloatDefinition(writer, 'AdcRasterTime', [1e-7]);
    writeFloatDefinition(writer, 'GradientRasterTime', [1e-5]);
    writeFloatDefinition(writer, 'RadiofrequencyRasterTime', [1e-6]);
    writeFloatDefinition(writer, 'BlockDurationRaster', [1e-5]);
    writer.uint64(SECTION_PREFIX | 2n);
    writer.int64(1);
    writer.int64(1);
    for (const id of [options.rfId ?? 0, 0, 0, 0, 0, 0]) writer.int32(id);
    return writer.toBytes();
}

function binaryPreamble(version: { major?: number; minor?: number; revision?: number } = {}): TestBinaryWriter {
    const writer = new TestBinaryWriter();
    writer.raw([0x01, 0x70, 0x75, 0x6c, 0x73, 0x65, 0x71, 0x02]);
    writer.int64(version.major ?? 1);
    writer.int64(version.minor ?? 5);
    writer.int64(version.revision ?? 2);
    return writer;
}

function writeFloatDefinition(writer: TestBinaryWriter, key: string, values: number[]): void {
    writeDefinitionHeader(writer, key, values.length, 'f');
    for (const value of values) writer.float64(value);
}

function writeIntegerDefinition(writer: TestBinaryWriter, key: string, values: number[]): void {
    writeDefinitionHeader(writer, key, values.length, 'i');
    for (const value of values) writer.int32(value);
}

function writeStringDefinition(writer: TestBinaryWriter, key: string, value: string): void {
    writeDefinitionHeader(writer, key, value.length, 'c');
    writer.text(value);
}

function writeDefinitionHeader(writer: TestBinaryWriter, key: string, count: number, type: string): void {
    writer.int32(key.length);
    writer.text(key);
    writer.int32(count);
    writer.text(type);
}

class TestBinaryWriter {
    private readonly data: number[] = [];

    raw(values: ArrayLike<number>): void {
        for (let i = 0; i < values.length; i++) this.data.push(values[i]);
    }

    text(value: string): void {
        for (let i = 0; i < value.length; i++) this.data.push(value.charCodeAt(i));
    }

    int32(value: number): void {
        this.scalar(4, view => view.setInt32(0, value, true));
    }

    int64(value: number): void {
        this.scalar(8, view => view.setBigInt64(0, BigInt(value), true));
    }

    uint64(value: bigint): void {
        this.scalar(8, view => view.setBigUint64(0, value, true));
    }

    float64(value: number): void {
        this.scalar(8, view => view.setFloat64(0, value, true));
    }

    toBytes(): Uint8Array {
        return Uint8Array.from(this.data);
    }

    private scalar(width: number, write: (view: DataView) => void): void {
        const buffer = new ArrayBuffer(width);
        write(new DataView(buffer));
        this.raw(new Uint8Array(buffer));
    }
}
