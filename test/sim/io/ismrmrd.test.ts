import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Hdf5Writer, typeSize } from '../../../src/sim/io/hdf5';
import {
    ACQUISITION_HDF5_TYPE,
    ACQUISITION_HEADER_HDF5_TYPE,
    ACQUISITION_HEADER_SIZE,
    acquisitionFlags,
    acquisitionHeader,
    buildIsmrmrdHeaderXml,
    channelMask,
    decodeAcquisitionHeader,
    encodeAcquisitionHeader,
    IsmrmrdAcqFlag,
    IsmrmrdMessageId,
    isFlagSet,
    writeIsmrmrdHdf5,
    writeIsmrmrdStream,
    type AcquisitionHeaderFields,
    type IsmrmrdAcquisition,
    type IsmrmrdHeaderInfo,
} from '../../../src/sim/io/ismrmrd';
import { readCollections, readHdf5, readVlen } from './hdf5Reader';
import { FIXTURE_ACQUISITIONS, FIXTURE_XML, fixtureJson } from './ismrmrdFixture';

const FIXTURE_DIR = join(__dirname, '..', '..', 'fixtures', 'ismrmrd');
/** Set UPDATE_FIXTURES=1 to rewrite test/fixtures/ismrmrd from ismrmrdFixture.ts. */
const UPDATE_FIXTURES = process.env.UPDATE_FIXTURES === '1';

const floats = (bytes: Uint8Array) => new Float32Array(bytes.slice().buffer);

/** A header with a distinct value in every field, so a misplaced field shows. */
function distinctHeader(): AcquisitionHeaderFields {
    return acquisitionHeader({
        version: 0x0101,
        flags: 0x8877665544332211n,
        measurement_uid: 0x0a0b0c0d,
        scan_counter: 0x01020304,
        acquisition_time_stamp: 0x05060708,
        physiology_time_stamp: [0x11, 0x12, 0x13],
        number_of_samples: 0x2122,
        available_channels: 0x2324,
        active_channels: 70,
        channel_mask: Array.from({ length: 16 }, (_, i) => BigInt(i + 1) << 56n),
        discard_pre: 0x3132,
        discard_post: 0x3334,
        center_sample: 0x3536,
        encoding_space_ref: 0x3738,
        trajectory_dimensions: 3,
        sample_time_us: 2.5,
        position: [1.25, 2.25, 3.25],
        read_dir: [4.5, 5.5, 6.5],
        phase_dir: [7.75, 8.75, 9.75],
        slice_dir: [10.125, 11.125, 12.125],
        patient_table_position: [-1, -2, -3],
        idx: {
            kspace_encode_step_1: 0x4142, kspace_encode_step_2: 0x4344, average: 0x4546, slice: 0x4748,
            contrast: 0x494a, phase: 0x4b4c, repetition: 0x4d4e, set: 0x4f50, segment: 0x5152,
            user: [0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68],
        },
        user_int: [-1, -2, -3, -4, 5, 6, 7, 2147483647],
        user_float: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, -7.5],
    });
}

function parseStream(bytes: Uint8Array): { xml: string; acquisitions: IsmrmrdAcquisition[] } {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 0;
    let xml = '';
    const acquisitions: IsmrmrdAcquisition[] = [];
    for (;;) {
        const id = view.getUint16(at, true);
        at += 2;
        if (id === IsmrmrdMessageId.CLOSE) break;
        if (id === IsmrmrdMessageId.HEADER) {
            const length = view.getUint32(at, true);
            xml = new TextDecoder().decode(bytes.subarray(at + 4, at + 4 + length));
            at += 4 + length;
        } else if (id === IsmrmrdMessageId.ACQUISITION) {
            const head = decodeAcquisitionHeader(bytes, at);
            at += ACQUISITION_HEADER_SIZE;
            const trajBytes = 4 * head.number_of_samples * head.trajectory_dimensions;
            const dataBytes = 8 * head.number_of_samples * head.active_channels;
            const traj = floats(bytes.subarray(at, at + trajBytes));
            const data = floats(bytes.subarray(at + trajBytes, at + trajBytes + dataBytes));
            acquisitions.push({ head, traj, data });
            at += trajBytes + dataBytes;
        } else {
            throw new Error(`Unexpected message ${id} at ${at - 2}.`);
        }
    }
    expect(at).toBe(bytes.length);
    return { xml, acquisitions };
}

/** What decodeAcquisitionHeader returns for `head`: float fields rounded to float32. */
function stored(head: AcquisitionHeaderFields): AcquisitionHeaderFields {
    const f32 = (values: readonly number[]) => values.map(Math.fround);
    return {
        ...head,
        sample_time_us: Math.fround(head.sample_time_us),
        position: f32(head.position),
        read_dir: f32(head.read_dir),
        phase_dir: f32(head.phase_dir),
        slice_dir: f32(head.slice_dir),
        patient_table_position: f32(head.patient_table_position),
        user_float: f32(head.user_float),
    };
}

describe('acquisition header', () => {
    it('is the packed 340-byte ISMRMRD_AcquisitionHeader', () => {
        const bytes = encodeAcquisitionHeader(distinctHeader());
        expect(bytes.length).toBe(ACQUISITION_HEADER_SIZE);
        const view = new DataView(bytes.buffer);
        // Offsets from the static_asserts in ismrmrd/ismrmrd.h.
        expect(view.getUint16(0, true)).toBe(0x0101);
        expect(view.getBigUint64(2, true)).toBe(0x8877665544332211n);
        expect(view.getUint32(10, true)).toBe(0x0a0b0c0d);
        expect(view.getUint32(14, true)).toBe(0x01020304);
        expect(view.getUint32(18, true)).toBe(0x05060708);
        expect([22, 26, 30].map(o => view.getUint32(o, true))).toEqual([0x11, 0x12, 0x13]);
        expect(view.getUint16(34, true)).toBe(0x2122);
        expect(view.getUint16(36, true)).toBe(0x2324);
        expect(view.getUint16(38, true)).toBe(70);
        expect(view.getBigUint64(40, true)).toBe(1n << 56n);
        expect(view.getBigUint64(40 + 15 * 8, true)).toBe(16n << 56n);
        expect([168, 170, 172, 174, 176].map(o => view.getUint16(o, true))).toEqual([0x3132, 0x3334, 0x3536, 0x3738, 3]);
        expect(view.getFloat32(178, true)).toBe(2.5);
        expect(view.getFloat32(182, true)).toBe(1.25);
        expect(view.getFloat32(194, true)).toBe(4.5);
        expect(view.getFloat32(206, true)).toBe(7.75);
        expect(view.getFloat32(218, true)).toBe(10.125);
        expect(view.getFloat32(230, true)).toBe(-1);
        expect(view.getUint16(242, true)).toBe(0x4142);
        expect(view.getUint16(242 + 16, true)).toBe(0x5152);
        expect(view.getUint16(242 + 18, true)).toBe(0x61);
        expect(view.getUint16(242 + 32, true)).toBe(0x68);
        expect(view.getInt32(276, true)).toBe(-1);
        expect(view.getInt32(276 + 28, true)).toBe(2147483647);
        expect(view.getFloat32(308, true)).toBe(0.5);
        expect(view.getFloat32(336, true)).toBe(-7.5);
    });

    it('round-trips through decodeAcquisitionHeader', () => {
        const head = distinctHeader();
        expect(decodeAcquisitionHeader(encodeAcquisitionHeader(head))).toEqual(head);
        const rounded = acquisitionHeader({ sample_time_us: 0.1, user_float: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] });
        expect(decodeAcquisitionHeader(encodeAcquisitionHeader(rounded))).toEqual(stored(rounded));
    });

    it('is exactly what the HDF5 compound type encodes member by member', () => {
        expect(typeSize(ACQUISITION_HEADER_HDF5_TYPE)).toBe(ACQUISITION_HEADER_SIZE);
        expect(typeSize(ACQUISITION_HDF5_TYPE)).toBe(ACQUISITION_HEADER_SIZE + 2 * 16);
        const head = distinctHeader();
        const file = new Hdf5Writer().dataset('head', ACQUISITION_HEADER_HDF5_TYPE, [1], [head]).finish();
        expect(readHdf5(file).datasets.get('/head')!.raw).toEqual(encodeAcquisitionHeader(head));
    });

    it('rejects values that do not fit their fields', () => {
        expect(() => encodeAcquisitionHeader(acquisitionHeader({ number_of_samples: 65536 }))).toThrow(/number_of_samples .*65535/);
        expect(() => encodeAcquisitionHeader(acquisitionHeader({ flags: -1n }))).toThrow(/flags/);
        expect(() => encodeAcquisitionHeader(acquisitionHeader({ user_int: [0, 0, 0, 0, 0, 0, 0, 2 ** 31] }))).toThrow(/user_int\[7\]/);
        expect(() => encodeAcquisitionHeader(acquisitionHeader({ position: [0, 0] }))).toThrow(/position must have 3/);
        expect(() => acquisitionHeader({ numer_of_samples: 3 } as never)).toThrow(/Unknown acquisition header field 'numer_of_samples'/);
    });

    it('defaults like ismrmrd_init_acquisition_header, with the active channels marked', () => {
        const head = acquisitionHeader({ active_channels: 3, idx: { slice: 2 } });
        expect(head.version).toBe(1);
        expect(head.available_channels).toBe(3);
        expect(head.channel_mask[0]).toBe(7n);
        expect(head.idx).toMatchObject({ slice: 2, kspace_encode_step_1: 0, user: [0, 0, 0, 0, 0, 0, 0, 0] });
        expect(head.read_dir).toEqual([0, 0, 0]);
    });
});

describe('flags and channel masks', () => {
    it('numbers flag bits as ismrmrd.h does, from 1', () => {
        expect(IsmrmrdAcqFlag.FIRST_IN_ENCODE_STEP1).toBe(1);
        expect(IsmrmrdAcqFlag.IS_NOISE_MEASUREMENT).toBe(19);
        expect(IsmrmrdAcqFlag.IS_PARALLEL_CALIBRATION).toBe(20);
        expect(IsmrmrdAcqFlag.IS_PARALLEL_CALIBRATION_AND_IMAGING).toBe(21);
        expect(IsmrmrdAcqFlag.IS_REVERSE).toBe(22);
        expect(IsmrmrdAcqFlag.IS_NAVIGATION_DATA).toBe(23);
        expect(IsmrmrdAcqFlag.LAST_IN_MEASUREMENT).toBe(25);
        expect(IsmrmrdAcqFlag.USER8).toBe(64);
        expect(acquisitionFlags(IsmrmrdAcqFlag.FIRST_IN_ENCODE_STEP1)).toBe(1n);
        expect(acquisitionFlags(IsmrmrdAcqFlag.LAST_IN_MEASUREMENT, IsmrmrdAcqFlag.IS_NOISE_MEASUREMENT)).toBe((1n << 24n) | (1n << 18n));
        expect(acquisitionFlags(IsmrmrdAcqFlag.USER8)).toBe(1n << 63n);
        expect(isFlagSet(1n << 21n, IsmrmrdAcqFlag.IS_REVERSE)).toBe(true);
        expect(isFlagSet(1n << 21n, IsmrmrdAcqFlag.IS_NAVIGATION_DATA)).toBe(false);
        expect(() => acquisitionFlags(0)).toThrow(/1 to 64/);
    });

    it('sets bit c % 64 of word c / 64 for each active channel', () => {
        const mask = channelMask(130);
        expect(mask.slice(0, 3)).toEqual([2n ** 64n - 1n, 2n ** 64n - 1n, 3n]);
        expect(mask.slice(3).every(word => word === 0n)).toBe(true);
    });
});

const MINIMAL_INFO: IsmrmrdHeaderInfo = {
    H1resonanceFrequency_Hz: 63_867_253.6,
    receiverChannels: 1,
    encodedSpace: { matrixSize: { x: 4, y: 2, z: 1 }, fieldOfView_mm: { x: 200, y: 100.5, z: 5 } },
    trajectory: 'cartesian',
    encodingLimits: { kspace_encoding_step_1: { minimum: 0, maximum: 1, center: 1 } },
};

describe('XML header', () => {
    it('writes the elements in schema order', () => {
        expect(buildIsmrmrdHeaderXml(MINIMAL_INFO)).toBe([
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<ismrmrdHeader xmlns="http://www.ismrm.org/ISMRMRD" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
                + ' xmlns:xs="http://www.w3.org/2001/XMLSchema" xsi:schemaLocation="http://www.ismrm.org/ISMRMRD ismrmrd.xsd">',
            '  <acquisitionSystemInformation>',
            '    <receiverChannels>1</receiverChannels>',
            '  </acquisitionSystemInformation>',
            '  <experimentalConditions>',
            '    <H1resonanceFrequency_Hz>63867254</H1resonanceFrequency_Hz>',
            '  </experimentalConditions>',
            '  <encoding>',
            '    <encodedSpace>',
            '      <matrixSize>',
            '        <x>4</x>',
            '        <y>2</y>',
            '        <z>1</z>',
            '      </matrixSize>',
            '      <fieldOfView_mm>',
            '        <x>200</x>',
            '        <y>100.5</y>',
            '        <z>5</z>',
            '      </fieldOfView_mm>',
            '    </encodedSpace>',
            '    <reconSpace>',
            '      <matrixSize>',
            '        <x>4</x>',
            '        <y>2</y>',
            '        <z>1</z>',
            '      </matrixSize>',
            '      <fieldOfView_mm>',
            '        <x>200</x>',
            '        <y>100.5</y>',
            '        <z>5</z>',
            '      </fieldOfView_mm>',
            '    </reconSpace>',
            '    <encodingLimits>',
            '      <kspace_encoding_step_1>',
            '        <minimum>0</minimum>',
            '        <maximum>1</maximum>',
            '        <center>1</center>',
            '      </kspace_encoding_step_1>',
            '    </encodingLimits>',
            '    <trajectory>cartesian</trajectory>',
            '  </encoding>',
            '</ismrmrdHeader>',
            '',
        ].join('\n'));
    });

    it('orders optional sections and repeated elements as ismrmrd.xsd requires', () => {
        const xml = FIXTURE_XML;
        const order = (...tags: string[]) => {
            const positions = tags.map(tag => xml.indexOf(`<${tag}>`));
            expect(positions.every(p => p >= 0)).toBe(true);
            expect([...positions].sort((a, b) => a - b)).toEqual(positions);
        };
        order('measurementInformation', 'acquisitionSystemInformation', 'experimentalConditions', 'encoding',
            'sequenceParameters', 'userParameters');
        order('patientPosition', 'protocolName');
        order('systemVendor', 'systemModel', 'systemFieldStrength_T', 'receiverChannels');
        order('TR', 'TE', 'flipAngle_deg', 'sequence_type', 'echo_spacing');
        order('kspace_encoding_step_0', 'kspace_encoding_step_1', 'slice', 'contrast', 'repetition');
        order('userParameterLong', 'userParameterDouble', 'userParameterString');
        expect(xml).not.toContain('<version>');
        expect(xml).toContain('<patientPosition>HFS</patientPosition>');
        expect(xml).toContain('<H1resonanceFrequency_Hz>123259792</H1resonanceFrequency_Hz>');
        expect(xml).toContain('<value>9007199254740993</value>');
    });

    it('escapes markup and keeps the document ASCII', () => {
        const xml = buildIsmrmrdHeaderXml({
            ...MINIMAL_INFO,
            measurementInformation: { protocolName: 'a<b & "c" \'d\' > é \u{1F600} \u0001' },
        });
        expect(xml).toContain('<protocolName>a&lt;b &amp; &quot;c&quot; &apos;d&apos; &gt; &#xE9; &#x1F600; &#xFFFD;</protocolName>');
        expect([...xml].every(c => c.charCodeAt(0) < 0x80)).toBe(true);
    });

    it('rejects values the schema does not allow', () => {
        expect(() => buildIsmrmrdHeaderXml({ ...MINIMAL_INFO, trajectory: 'rosette' as never })).toThrow(/trajectory must be one of/);
        expect(() => buildIsmrmrdHeaderXml({ ...MINIMAL_INFO, receiverChannels: 70000 })).toThrow(/receiverChannels/);
        expect(() => buildIsmrmrdHeaderXml({
            ...MINIMAL_INFO,
            encodingLimits: { slice: { minimum: -1, maximum: 0, center: 0 } },
        })).toThrow(/slice.minimum/);
        expect(() => buildIsmrmrdHeaderXml({ ...MINIMAL_INFO, H1resonanceFrequency_Hz: NaN })).toThrow(/finite/);
        expect(() => buildIsmrmrdHeaderXml({
            ...MINIMAL_INFO,
            userParameters: { userParameterLong: [{ name: 'x', value: 0.5 }] },
        })).toThrow(/userParameterLong 'x'/);
    });
});

describe('ISMRMRD stream', () => {
    it('is header, acquisitions and close, as ProtocolSerializer writes them', () => {
        const bytes = writeIsmrmrdStream(FIXTURE_XML, FIXTURE_ACQUISITIONS);
        const view = new DataView(bytes.buffer);
        expect(view.getUint16(0, true)).toBe(3);
        expect(view.getUint32(2, true)).toBe(FIXTURE_XML.length);
        expect(view.getUint16(6 + FIXTURE_XML.length, true)).toBe(1008);
        expect(view.getUint16(bytes.length - 2, true)).toBe(4);
        const parsed = parseStream(bytes);
        expect(parsed.xml).toBe(FIXTURE_XML);
        expect(parsed.acquisitions).toHaveLength(FIXTURE_ACQUISITIONS.length);
        for (const [i, acquisition] of FIXTURE_ACQUISITIONS.entries()) {
            expect(parsed.acquisitions[i].head).toEqual(stored(acquisition.head));
            expect(parsed.acquisitions[i].traj).toEqual(acquisition.traj);
            expect(parsed.acquisitions[i].data).toEqual(acquisition.data);
        }
    });

    it('refuses acquisitions whose arrays do not match their header', () => {
        const head = acquisitionHeader({ number_of_samples: 4, active_channels: 2, trajectory_dimensions: 2 });
        const ok = { head, traj: new Float32Array(8), data: new Float32Array(16) };
        expect(() => writeIsmrmrdStream('', [ok, { ...ok, traj: new Float32Array(4) }])).toThrow(/Acquisition 1: traj has 4 values/);
        expect(() => writeIsmrmrdHdf5('', [{ ...ok, data: new Float32Array(8) }])).toThrow(/Acquisition 0: data has 8 values/);
        expect(() => writeIsmrmrdStream('', [{ ...ok, head: { ...head, discard_pre: -1 } }])).toThrow(/Acquisition 0: discard_pre/);
    });
});

describe('ISMRMRD HDF5', () => {
    it('holds /dataset/xml and one /dataset/data element per acquisition', () => {
        const file = writeIsmrmrdHdf5(FIXTURE_XML, FIXTURE_ACQUISITIONS);
        const parsed = readHdf5(file);
        expect(parsed.groups.map(g => [g.path, g.links])).toEqual([['/', ['dataset']], ['/dataset', ['xml', 'data']]]);
        const xml = parsed.datasets.get('/dataset/xml')!;
        expect(xml.dims).toEqual([1]);
        // Variable-length string, null-terminated, ASCII (as H5T_C_S1); base type unsigned char.
        expect(Array.from(xml.datatype)).toEqual([0x19, 0x01, 0x00, 0x00, 16, 0, 0, 0, 0x10, 0, 0, 0, 1, 0, 0, 0, 0, 0, 8, 0]);
        expect(new TextDecoder().decode(readVlen(file, xml.raw, 0).data)).toBe(FIXTURE_XML);

        const data = parsed.datasets.get('/dataset/data')!;
        expect(data.dims).toEqual([FIXTURE_ACQUISITIONS.length]);
        const size = typeSize(ACQUISITION_HDF5_TYPE);
        for (const [i, acquisition] of FIXTURE_ACQUISITIONS.entries()) {
            const element = data.raw.subarray(i * size, (i + 1) * size);
            expect(element.subarray(0, ACQUISITION_HEADER_SIZE)).toEqual(encodeAcquisitionHeader(acquisition.head));
            const traj = readVlen(file, element, ACQUISITION_HEADER_SIZE);
            const samples = readVlen(file, element, ACQUISITION_HEADER_SIZE + 16);
            expect(traj.count).toBe(acquisition.traj.length);
            expect(floats(traj.data)).toEqual(acquisition.traj);
            expect(samples.count).toBe(acquisition.data.length);
            expect(floats(samples.data)).toEqual(acquisition.data);
        }
        const heapStart = data.dataAddress + data.raw.length;
        expect(readCollections(file, heapStart).map(c => c.size)).toEqual([4096]);
    });

    it('names the group after options.datasetName and is deterministic', () => {
        const file = writeIsmrmrdHdf5('<x/>', [], { datasetName: 'sim' });
        expect(readHdf5(file).groups.map(g => g.path)).toEqual(['/', '/sim']);
        expect(readHdf5(file).datasets.get('/sim/data')!.dims).toEqual([0]);
        expect(writeIsmrmrdHdf5(FIXTURE_XML, FIXTURE_ACQUISITIONS)).toEqual(writeIsmrmrdHdf5(FIXTURE_XML, FIXTURE_ACQUISITIONS));
        expect(() => writeIsmrmrdHdf5('', [], { datasetName: 'a/b' })).toThrow(/Invalid ISMRMRD dataset name/);
    });
});

describe('committed fixtures (test/fixtures/ismrmrd)', () => {
    const files = {
        'small.h5': writeIsmrmrdHdf5(FIXTURE_XML, FIXTURE_ACQUISITIONS),
        'small.stream': writeIsmrmrdStream(FIXTURE_XML, FIXTURE_ACQUISITIONS),
        'expected.json': new TextEncoder().encode(fixtureJson()),
    };
    if (UPDATE_FIXTURES) {
        mkdirSync(FIXTURE_DIR, { recursive: true });
        for (const [name, bytes] of Object.entries(files)) writeFileSync(join(FIXTURE_DIR, name), bytes);
    }

    it('are still what the writers produce, byte for byte', () => {
        expect(new Uint8Array(readFileSync(join(FIXTURE_DIR, 'small.h5')))).toEqual(files['small.h5']);
        expect(new Uint8Array(readFileSync(join(FIXTURE_DIR, 'small.stream')))).toEqual(files['small.stream']);
        const expected = JSON.parse(readFileSync(join(FIXTURE_DIR, 'expected.json'), 'utf8'));
        expect(expected).toEqual(JSON.parse(new TextDecoder().decode(files['expected.json'])));
    });
});
