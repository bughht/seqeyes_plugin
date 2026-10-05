import { describe, expect, it } from 'vitest';

import { Hdf5Writer, h5t, lookup3, typeSize, type Hdf5Type } from '../../../src/sim/io/hdf5';
import { readCollections, readHdf5, readVlen } from './hdf5Reader';

const hex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], byte => parseInt(byte, 16));
const ascii = (text: string) => Uint8Array.from(text, c => c.charCodeAt(0));

describe('lookup3', () => {
    it('matches the vectors in Jenkins\' lookup3.c', () => {
        expect(lookup3(new Uint8Array(0))).toBe(0xdeadbeef);
        expect(lookup3(new Uint8Array(0), 0xdeadbeef)).toBe(0xbd5b7dde);
        expect(lookup3(ascii('Four score and seven years ago'))).toBe(0x17770551);
        expect(lookup3(ascii('Four score and seven years ago'), 1)).toBe(0xcd628161);
    });

    it('matches checksums libhdf5 stored in a file it wrote', () => {
        // From h5py 3.16 / HDF5 2.0.0 with libver 'v108': the superblock (tail of 8
        // bytes), the root group's object header (tail of 7) and a dataset's
        // object header padded with a NIL message (a multiple of 12 bytes).
        const superblock = hex('894844460d0a1a0a020808000000000000000000ffffffffffffffffd2200000000000003000000000000000');
        expect(lookup3(superblock)).toBe(0x5c286862);
        const root = hex(('4f484452020078021200000000ffffffffffffffffffffffffffffffff0a02000100000612000001000764617461'
            + '736574b3000000000000000042').padEnd(2 * 127, '0'));
        expect(lookup3(root)).toBe(0x9984f101);
        const prefix = '4f48445202010001011400000201010103000000000000000300000000000000030c0001100800000800000000004000'
            + '05020001030a081200000301ae18000000000000180000000000000000b80000';
        const dataset = hex(prefix.padEnd(2 * 264, '0'));
        expect(lookup3(dataset)).toBe(0x00767747);
    });
});

function build(add: (writer: Hdf5Writer) => void): Uint8Array {
    const writer = new Hdf5Writer();
    add(writer);
    return writer.finish();
}

describe('Hdf5Writer', () => {
    it('writes the structures libhdf5 writes, byte for byte where they are fixed', () => {
        const file = build(w => w.dataset('/run/values', h5t.f32, [3], new Float32Array([1, 2, 3])));
        const parsed = readHdf5(file);
        expect(parsed.rootAddress).toBe(48);
        expect(parsed.groups.map(g => [g.path, g.links])).toEqual([['/', ['run']], ['/run', ['values']]]);
        const values = parsed.datasets.get('/run/values')!;
        expect(values.dims).toEqual([3]);
        // Exactly the float32 datatype message and fill value h5py/libhdf5 write.
        expect(Array.from(values.datatype)).toEqual(Array.from(hex('11201f00040000000000200017080017' + '7f000000')));
        expect(Array.from(values.fill)).toEqual([3, 0x0a]);
        expect(Array.from(new Float32Array(values.raw.slice().buffer))).toEqual([1, 2, 3]);
    });

    it('tiles the file with no gaps: superblock, object headers, raw data, heap', () => {
        const file = build(w => {
            w.dataset('a', h5t.string(), [2], ['first', 'é']);
            w.dataset('b/c', h5t.vlen(h5t.i16), [3], [[1, -2], [], new Int16Array([3])]);
            w.dataset('d', h5t.u8, [0], []);
            w.group('e/f');
        });
        const parsed = readHdf5(file);
        const objects = [...parsed.groups, ...parsed.datasets.values()].sort((x, y) => x.address - y.address);
        let at = 48;
        for (const object of objects) {
            expect(object.address).toBe(at);
            at = object.end;
        }
        for (const dataset of [...parsed.datasets.values()].filter(d => d.raw.length > 0)) {
            expect(dataset.dataAddress).toBe(at);
            at += dataset.raw.length;
        }
        const collections = readCollections(file, at);
        expect(collections).toHaveLength(1);
        expect(collections[0].size).toBe(4096);
        expect(parsed.datasets.get('/d')!.dataAddress).toBeNaN();
        expect(parsed.groups.map(g => g.path)).toEqual(['/', '/b', '/e', '/e/f']);
    });

    it('stores strings and sequences in the global heap, empty sequences as nil references', () => {
        const file = build(w => {
            w.dataset('s', h5t.string('ascii'), [3], ['<xml/>', '', 'hé']);
            w.dataset('v', h5t.vlen(h5t.f64), [2], [new Float64Array([0.5, -1]), []]);
        });
        const parsed = readHdf5(file);
        const s = parsed.datasets.get('/s')!;
        const strings = [0, 1, 2].map(i => readVlen(file, s.raw, 16 * i));
        expect(strings.map(r => new TextDecoder().decode(r.data))).toEqual(['<xml/>', '', 'hé']);
        expect(strings.map(r => r.count)).toEqual([6, 0, 3]);
        // The empty string is a zero-length heap object (as libhdf5 writes it), not nil.
        expect(Array.from(s.raw.subarray(16 + 4, 16 + 12)).some(b => b !== 0)).toBe(true);
        const v = parsed.datasets.get('/v')!;
        const first = readVlen(file, v.raw, 0);
        expect(first.count).toBe(2);
        expect(Array.from(new Float64Array(first.data.slice().buffer))).toEqual([0.5, -1]);
        expect(Array.from(v.raw.subarray(16, 32))).toEqual(new Array(16).fill(0));
        // Variable-length datasets always get their fill value written, as libhdf5 does.
        expect(Array.from(v.fill)).toEqual([3, 0x02]);
    });

    it('encodes compounds member by member or from pre-encoded bytes, identically', () => {
        const inner = h5t.compound([['a', h5t.u16], ['user', h5t.array(h5t.u16, [3])]]);
        const type = h5t.compound([
            ['flags', h5t.u64], ['f', h5t.array(h5t.f32, [2])], ['inner', inner], ['i', h5t.i32], ['b', h5t.i8], ['d', h5t.f64],
        ]);
        expect(typeSize(type)).toBe(8 + 8 + 8 + 4 + 1 + 8);
        const value = { flags: 0x0102030405060708n, f: [0.5, -0], inner: { a: 7, user: [1, 2, 65535] }, i: -5, b: -128, d: Math.E };
        const file = build(w => w.dataset('x', type, [1], [value]));
        const raw = readHdf5(file).datasets.get('/x')!.raw.slice();
        const again = build(w => w.dataset('x', type, [1], [raw]));
        expect(again).toEqual(file);
        const view = new DataView(raw.buffer);
        expect(view.getBigUint64(0, true)).toBe(0x0102030405060708n);
        expect(view.getUint16(16 + 6, true)).toBe(65535);
        expect(view.getInt32(24, true)).toBe(-5);
        expect(view.getInt8(28)).toBe(-128);
        expect(view.getFloat64(29, true)).toBe(Math.E);
    });

    it('writes the compound datatype message libhdf5 writes for the same numpy dtype', () => {
        // h5py 3.16 / HDF5 2.0.0 (libver 'v108') for numpy dtype
        // [('version','<u2'),('flags','<u8'),('f','<f4',(2,)),('idx',[('a','<u2'),('user','<u2',(3,))]),
        //  ('d','<f8'),('i','<i4'),('b','i1')] as 'head', then two vlen float32 members.
        const head = h5t.compound([
            ['version', h5t.u16], ['flags', h5t.u64], ['f', h5t.array(h5t.f32, [2])],
            ['idx', h5t.compound([['a', h5t.u16], ['user', h5t.array(h5t.u16, [3])]])],
            ['d', h5t.f64], ['i', h5t.i32], ['b', h5t.i8],
        ]);
        const type = h5t.compound([['head', head], ['traj', h5t.vlen(h5t.f32)], ['data', h5t.vlen(h5t.f32)]]);
        const zeros = { version: 0, flags: 0n, f: [0, 0], idx: { a: 0, user: [0, 0, 0] }, d: 0, i: 0, b: 0 };
        const file = build(w => w.dataset('data', type, [1], [{ head: zeros, traj: [], data: [] }]));
        const expected = [
            '3603000047000000686561640000360700002700000076657273696f6e0000100000000200000000001000666c616773',
            '000210000000080000000000400066000a3a00000008000000010200000011201f000400000000002000170800177f00',
            '0000696478001236020000080000006100001000000002000000000010007573657200023a0000000600000001030000',
            '0010000000020000000000100064001a11203f000800000000004000340b0034ff030000690022100800000400000000',
            '0020006200261008000001000000000008007472616a0027190000001000000011201f00040000000000200017080017',
            '7f000000646174610037190000001000000011201f000400000000002000170800177f000000',
        ].join('');
        expect(Buffer.from(readHdf5(file).datasets.get('/data')!.datatype).toString('hex')).toBe(expected);
    });

    it('splits the heap into collections by object count and size', () => {
        const strings = Array.from({ length: 20_000 }, (_, i) => `s${i}`);
        const big = new Float32Array(1_200_000).map((_, i) => i);
        const file = build(w => {
            w.dataset('many', h5t.string(), [strings.length], strings);
            w.dataset('big', h5t.vlen(h5t.f32), [1], [big]);
        });
        const parsed = readHdf5(file);
        const many = parsed.datasets.get('/many')!;
        const bigData = parsed.datasets.get('/big')!;
        const collections = readCollections(file, bigData.dataAddress + bigData.raw.length);
        expect(collections.map(c => c.objects.size)).toEqual([8192, 8192, 20_000 - 2 * 8192, 1]);
        for (const collection of collections.slice(0, 3)) expect(collection.size).toBeLessThanOrEqual(4 * 1024 * 1024);
        // 4.8 MB does not fit a 4 MiB collection, so it gets one of its own, sized to fit.
        expect(collections[3].size).toBe(16 + 16 + 4 * big.length);
        expect(collections[3].free).toBe(0);
        const last = readVlen(file, many.raw, 16 * (strings.length - 1));
        expect(new TextDecoder().decode(last.data)).toBe('s19999');
        const bigBack = readVlen(file, bigData.raw, 0);
        expect(new Float32Array(bigBack.data.slice().buffer)).toEqual(big);
    });

    it('is deterministic', () => {
        const make = () => build(w => {
            w.dataset('/x/y', h5t.vlen(h5t.f32), [2], [new Float32Array([1, 2]), [3]]);
            w.dataset('/x/z', h5t.string(), [], ['scalar']);
            w.dataset('/n', h5t.i64, [2, 2], [1n, -2n, 3, 4]);
        });
        expect(make()).toEqual(make());
    });

    it('rejects invalid types, shapes and values with the element named', () => {
        const overlapping: Hdf5Type = {
            kind: 'compound',
            size: 8,
            members: [{ name: 'a', offset: 0, type: h5t.u32 }, { name: 'b', offset: 2, type: h5t.u32 }],
        };
        expect(() => new Hdf5Writer().dataset('x', overlapping, [1], [{ a: 1, b: 2 }])).toThrow(/overlap/);
        expect(() => new Hdf5Writer().dataset('x', h5t.vlen(h5t.string()), [1], [['a']])).toThrow(/nested/);
        expect(() => new Hdf5Writer().dataset('x', h5t.f32, [2, 2], [1, 2, 3])).toThrow(/3 elements/);
        expect(() => build(w => w.dataset('x', h5t.u16, [2], [1, 65536]))).toThrow(/Dataset \/x, element 1: .*\[0, 65535\]/);
        expect(() => build(w => w.dataset('x', h5t.compound([['a', h5t.f32]]), [1], [{ b: 1 }]))).toThrow(/member 'a' is missing/);
        const writer = new Hdf5Writer().dataset('x', h5t.u8, [1], [1]);
        expect(() => writer.dataset('x', h5t.u8, [1], [1])).toThrow(/already exists/);
        expect(() => writer.group('x/y')).toThrow(/is a dataset/);
        writer.finish();
        expect(() => writer.finish()).toThrow(/already finished/);
    });
});
