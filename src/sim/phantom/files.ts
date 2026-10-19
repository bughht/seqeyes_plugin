/**
 * Phantom files → PhantomVolume.
 *
 * Accepted:
 *   - MRzero `.npz` (BrainWeb phantoms from `generate_brainweb_phantoms`):
 *     `PD_map`, `T1_map`, `T2_map`, `T2dash_map`, `D_map` [10⁻⁹ m²/s],
 *     optional `B0_map` [Hz], `B1_map`, `FOV` [m] (MRzero's default 0.192 m);
 *   - MRzero `.mat` (`VoxelGridPhantom.load_mat`): one array [x, y, (z,) 5]
 *     holding PD, T1, T2, B0, B1 in that order, 0.2 × 0.2 × 0.008 m;
 *   - any `.npz`/`.mat` whose variables are named like the maps (PD, T1, T2,
 *     T2prime/T2dash, ADC/D, B0/dB0, B1), optionally with `FOV` [m];
 *   - NIfTI `.nii`/`.nii.gz`, one map per file, named by suffix
 *     (`brain_T1.nii.gz`; no suffix or `_PD`/`_density` for PD).
 * Arrays are 2-D (x, y) or 3-D (x, y, z) in the file's axis order; the volume
 * keeps x fastest. Units are checked for the usual slips (milliseconds,
 * percent) and corrected with a note rather than silently.
 */

import { readMat5, type MatArray } from '../io/mat5';
import type { NdArray } from '../io/ndarray';
import { readNifti } from '../io/nifti';
import { readNpy } from '../io/npy';
import { readNpz } from '../io/npz';
import { mrzeroFieldMaps, type MapName, type PhantomMaps, type PhantomVolume } from './model';

export interface PhantomFile {
    name: string;
    bytes: Uint8Array;
}

/** What to do about B0/B1 maps. */
export type FieldMapMode =
    /** Use the file's maps; ideal fields where it has none. */
    | 'file'
    /** Use the file's maps; where it has none, invent them as MRzero's loader does. */
    | 'mrzero'
    /** Ideal fields whatever the file holds. */
    | 'none';

const MRZERO_NPZ_FOV = 0.192;
const MRZERO_MAT_SIZE: [number, number, number] = [0.2, 0.2, 8e-3];
const MRZERO_MAT_T2DASH = 0.03;
const MRZERO_MAT_ADC = 1e-9;
/** Field of view assumed when a generic file states none [m]. */
const DEFAULT_FOV = 0.2;

/** Accepted variable names per map (compared case-insensitively, `_map` suffix ignored). */
const ALIASES: Record<MapName, string[]> = {
    pd: ['pd', 'rho', 'm0', 'density', 'protondensity'],
    t1: ['t1'],
    t2: ['t2'],
    t2prime: ['t2prime', 't2dash', "t2'", 't2p'],
    adc: ['adc', 'd'],
    b0: ['b0', 'db0', 'df', 'deltab0'],
    b1: ['b1', 'b1+', 'b1plus', 'b1p'],
};

/**
 * The phantom the files describe, B0/B1 as the files hold them (see
 * withFieldMode for the alternatives).
 */
export function loadPhantomFiles(files: readonly PhantomFile[]): PhantomVolume {
    if (!files.length) throw new Error('No phantom file given.');
    const lower = files.map(file => file.name.toLowerCase());
    let volume: PhantomVolume;
    if (lower.every(name => name.endsWith('.nii') || name.endsWith('.nii.gz'))) {
        volume = fromNifti(files);
    } else if (files.length === 1 && lower[0].endsWith('.npz')) {
        volume = fromArrays(readNpz(files[0].bytes), files[0].name);
    } else if (files.length === 1 && lower[0].endsWith('.mat')) {
        volume = fromMat(files[0]);
    } else if (files.length === 1 && lower[0].endsWith('.npy')) {
        volume = fromStack(readNpy(files[0].bytes), files[0].name, null);
    } else if (lower.some(name => name.endsWith('.json'))) {
        throw new Error('MRzero NIfTI phantoms (.json + .nii.gz) are not supported yet; load the maps as separate NIfTI files.');
    } else {
        throw new Error('Load one .npz, .mat or .npy file, or one or more NIfTI (.nii, .nii.gz) maps.');
    }
    return sanitise(volume);
}

function fromArrays(arrays: Map<string, NdArray>, source: string): PhantomVolume {
    const found = new Map<MapName, NdArray>();
    const used: string[] = [];
    for (const [key, array] of arrays) {
        const name = mapNameOf(key);
        if (name && !found.has(name)) {
            found.set(name, array);
            used.push(key);
        }
    }
    if (!found.has('pd')) {
        const keys = [...arrays.keys()].join(', ') || 'none';
        throw new Error(`No proton-density map (PD, PD_map, rho, M0, density) among the arrays: ${keys}.`);
    }
    const mrzero = arrays.has('PD_map') && arrays.has('T1_map');
    const notes: string[] = [];
    const pd = found.get('pd')!;
    const shape = spatialShape(pd, source);
    const fovArray = arrays.get('FOV') ?? arrays.get('fov');
    let fov: [number, number, number];
    if (fovArray) {
        fov = vector3(fovArray, 'FOV');
        if (Math.max(...fov) > 2) {
            fov = fov.map(v => v / 1000) as [number, number, number];
            notes.push('FOV looked like millimetres and was converted to metres.');
        }
    } else if (mrzero) {
        fov = [MRZERO_NPZ_FOV, MRZERO_NPZ_FOV, MRZERO_NPZ_FOV];
    } else {
        fov = [DEFAULT_FOV, DEFAULT_FOV, shape[2] > 1 ? DEFAULT_FOV : 0];
        notes.push(`No FOV in the file: assumed ${DEFAULT_FOV * 1000} mm.`);
    }
    const maps = {} as PhantomMaps;
    for (const [name, array] of found) {
        const values = toVolume(array, shape, `${name.toUpperCase()} map`);
        maps[name] = name === 'adc' && mrzero ? scale(values, 1e-9) : values;
    }
    if (!maps.t1 || !maps.t2) throw new Error('The phantom needs T1 and T2 maps (T1, T2 or T1_map, T2_map).');
    if (!mrzero && maps.adc) notes.push('ADC map taken as m²/s.');
    return {
        shape,
        voxel: voxelOf(fov, shape),
        maps,
        source: `${baseName(source)} (${mrzero ? 'MRzero' : used.join(', ')})`,
        notes,
    };
}

function fromMat(file: PhantomFile): PhantomVolume {
    // Numeric arrays only; text, structs and cells are not maps.
    const variables = readMat5(file.bytes).filter((v): v is MatArray => v.kind === 'array' && v.data.length > 0);
    const arrays = new Map<string, NdArray>(variables.map(v => [v.name, v]));
    // MRzero's load_mat: a single [x, y, (z,) 5] array of PD, T1, T2, B0, B1.
    const stacked = variables.filter(v => v.shape.length >= 3 && v.shape[v.shape.length - 1] === 5);
    if (stacked.length === 1 && ![...arrays.keys()].some(key => mapNameOf(key) === 'pd')) {
        return fromStack(stacked[0], file.name, stacked[0].name);
    }
    return fromArrays(arrays, file.name);
}

/** MRzero's stacked layout: the last dimension holds PD, T1, T2, B0, B1. */
function fromStack(array: NdArray, source: string, variable: string | null): PhantomVolume {
    const channels = array.shape[array.shape.length - 1];
    if (array.shape.length < 3 || channels < 3 || channels > 5) {
        throw new Error(`Expected an array [x, y, (z,) 5] of PD, T1, T2, B0, B1 (MRzero layout); got [${array.shape.join(', ')}].`);
    }
    const spatial = array.shape.slice(0, -1);
    const shape: [number, number, number] = [spatial[0], spatial[1], spatial[2] ?? 1];
    const channel = (c: number) => toVolume(channelOf(array, c), shape, ['PD', 'T1', 'T2', 'B0', 'B1'][c]);
    const maps: PhantomMaps = { pd: channel(0), t1: channel(1), t2: channel(2) };
    if (channels > 3) maps.b0 = channel(3);
    if (channels > 4) maps.b1 = channel(4);
    const n = shape[0] * shape[1] * shape[2];
    maps.t2prime = new Float32Array(n).fill(MRZERO_MAT_T2DASH);
    maps.adc = new Float32Array(n).fill(MRZERO_MAT_ADC);
    const size: [number, number, number] = shape[2] > 1 ? [MRZERO_MAT_SIZE[0], MRZERO_MAT_SIZE[1], MRZERO_MAT_SIZE[0]] : MRZERO_MAT_SIZE;
    return {
        shape,
        voxel: voxelOf(size, shape),
        maps,
        source: `${baseName(source)} (MRzero${variable ? ` ${variable}` : ''})`,
        notes: [`MRzero .mat layout: FOV ${size.map(v => v * 1000).join(' × ')} mm, T2′ 30 ms and ADC 1e-9 m²/s everywhere (MRzero's defaults).`],
    };
}

function fromNifti(files: readonly PhantomFile[]): PhantomVolume {
    const maps = {} as PhantomMaps;
    let shape: [number, number, number] | null = null;
    let voxel: [number, number, number] = [1e-3, 1e-3, 1e-3];
    const names: string[] = [];
    for (const file of files) {
        const image = readNifti(file.bytes);
        const name = niftiMapName(file.name);
        if (!name) throw new Error(`Cannot tell which map ${file.name} holds; name it like brain_T1.nii.gz (PD, T1, T2, T2prime, ADC, B0, B1).`);
        if (maps[name]) throw new Error(`Two files hold the ${name.toUpperCase()} map.`);
        const own = spatialShape(image, file.name);
        if (shape && own.some((v, i) => v !== shape![i])) throw new Error(`${file.name} is ${own.join('×')}, the other maps ${shape.join('×')}.`);
        shape = own;
        maps[name] = toVolume(image, own, file.name);
        voxel = image.voxelSize;
        names.push(name.toUpperCase());
    }
    if (!maps.pd) throw new Error('No proton-density NIfTI (e.g. brain.nii.gz, brain_PD.nii.gz or brain_density.nii.gz).');
    if (!maps.t1 || !maps.t2) throw new Error('NIfTI phantoms need T1 and T2 maps as well (brain_T1.nii.gz, brain_T2.nii.gz).');
    return { shape: shape!, voxel, maps, source: `NIfTI (${names.join(', ')})`, notes: [] };
}

/** Map name from a NIfTI file name: the part after the last '_' (none: PD). */
function niftiMapName(fileName: string): MapName | null {
    const stem = baseName(fileName).replace(/\.nii(\.gz)?$/i, '');
    const cut = stem.lastIndexOf('_');
    if (cut < 0) return 'pd';
    return mapNameOf(stem.slice(cut + 1)) ?? (/^(pd|density)$/i.test(stem.slice(cut + 1)) ? 'pd' : null);
}

function mapNameOf(key: string): MapName | null {
    const normalised = key.toLowerCase().replace(/_map$/, '');
    for (const name of Object.keys(ALIASES) as MapName[]) {
        if (ALIASES[name].includes(normalised)) return name;
    }
    return null;
}

/** Spatial extent of a map: (x, y) or (x, y, z); singleton trailing dims dropped. */
function spatialShape(array: NdArray, what: string): [number, number, number] {
    const shape = array.shape.slice();
    while (shape.length > 3 && shape[shape.length - 1] === 1) shape.pop();
    if (shape.length < 2 || shape.length > 3) {
        throw new Error(`${baseName(what)}: expected a 2-D or 3-D map, got [${array.shape.join(', ')}].`);
    }
    return [shape[0], shape[1], shape[2] ?? 1];
}

/** The map in volume layout (x fastest), whatever the source order. */
function toVolume(array: NdArray, shape: [number, number, number], what: string): Float32Array {
    const [nx, ny, nz] = shape;
    const n = nx * ny * nz;
    if (array.data.length < n) throw new Error(`${what}: ${array.data.length} values for a ${nx}×${ny}×${nz} grid.`);
    const out = new Float32Array(n);
    if (array.order === 'F' || (ny === 1 && nz === 1)) {
        for (let i = 0; i < n; i++) out[i] = array.data[i];
        return out;
    }
    // C order: (x, y, z) at ((x·ny) + y)·nz + z.
    for (let x = 0; x < nx; x++) {
        for (let y = 0; y < ny; y++) {
            const row = (x * ny + y) * nz;
            for (let z = 0; z < nz; z++) out[x + nx * (y + ny * z)] = array.data[row + z];
        }
    }
    return out;
}

/** Channel c of an array whose last dimension indexes channels, as its own NdArray. */
function channelOf(array: NdArray, c: number): NdArray {
    const spatial = array.shape.slice(0, -1);
    const n = spatial.reduce((a, b) => a * b, 1);
    const channels = array.shape[array.shape.length - 1];
    const data = new Float32Array(n);
    if (array.order === 'F') {
        for (let i = 0; i < n; i++) data[i] = array.data[c * n + i];
    } else {
        for (let i = 0; i < n; i++) data[i] = array.data[i * channels + c];
    }
    return { dtype: array.dtype, shape: spatial, order: array.order, data };
}

function vector3(array: NdArray, what: string): [number, number, number] {
    const v = Array.from(array.data);
    if (v.length < 2 || v.some(x => !(x > 0))) throw new Error(`${what} must hold 2 or 3 positive numbers.`);
    return [v[0], v[1], v[2] ?? v[0]];
}

function voxelOf(fov: readonly number[], shape: readonly number[]): [number, number, number] {
    return [0, 1, 2].map(i => (fov[i] > 0 ? fov[i] / shape[i] : 1e-3)) as [number, number, number];
}

function scale(values: Float32Array, factor: number): Float32Array {
    for (let i = 0; i < values.length; i++) values[i] *= factor;
    return values;
}

/** Non-finite PD → empty; relaxation in ms or B1 in percent → converted, with a note. */
function sanitise(volume: PhantomVolume): PhantomVolume {
    const { maps, notes } = volume;
    for (let i = 0; i < maps.pd.length; i++) if (!(maps.pd[i] > 0)) maps.pd[i] = 0;
    for (const name of ['t1', 't2', 't2prime'] as const) {
        const map = maps[name];
        if (!map) continue;
        let max = 0;
        for (let i = 0; i < map.length; i++) if (maps.pd[i] > 0 && map[i] > max) max = map[i];
        if (max > 50) {
            scale(map, 1e-3);
            notes.push(`${name.toUpperCase()} looked like milliseconds (max ${max.toFixed(0)}) and was converted to seconds.`);
        }
    }
    if (maps.b1) {
        let max = 0;
        for (let i = 0; i < maps.b1.length; i++) if (maps.pd[i] > 0 && maps.b1[i] > max) max = maps.b1[i];
        if (max > 10) {
            scale(maps.b1, 1e-2);
            notes.push('B1 looked like percent and was converted to a relative factor.');
        }
    }
    return volume;
}

/** The volume with its B0/B1 maps as the mode asks (the input is not changed). */
export function withFieldMode(volume: PhantomVolume, fields: FieldMapMode): PhantomVolume {
    if (fields === 'none') {
        const maps = { ...volume.maps };
        delete maps.b0;
        delete maps.b1;
        return { ...volume, maps };
    }
    if (fields === 'mrzero' && (!volume.maps.b0 || !volume.maps.b1)) {
        const generated = mrzeroFieldMaps(volume);
        const maps = { ...volume.maps, b0: volume.maps.b0 ?? generated.b0, b1: volume.maps.b1 ?? generated.b1 };
        return { ...volume, maps, notes: [...volume.notes, 'B0/B1 generated as MRzero does for files without them.'] };
    }
    return volume;
}

function baseName(path: string): string {
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return cut >= 0 ? path.slice(cut + 1) : path;
}
