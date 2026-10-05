/**
 * NumPy .npz archives: a zip of .npy members, as np.savez (stored) and
 * np.savez_compressed (DEFLATE) write them. MRzero ships its phantoms this
 * way, one map per member (PD_map, T1_map, …).
 */

import { messageOf } from './compression';
import type { NdArray } from './ndarray';
import { readNpy, writeNpy, type NpyWriteInput } from './npy';
import { readZipDirectory, readZipEntry, writeZip } from './zip';

/**
 * The arrays of an .npz archive, keyed like NumPy's NpzFile: the member name
 * without its '.npy' suffix, in archive order. Members that are not .npy
 * files (directories, a README) are ignored.
 */
export function readNpz(bytes: Uint8Array): Map<string, NdArray> {
    const arrays = new Map<string, NdArray>();
    for (const entry of readZipDirectory(bytes)) {
        if (!entry.name.endsWith('.npy')) continue;
        try {
            arrays.set(entry.name.slice(0, -4), readNpy(readZipEntry(bytes, entry)));
        } catch (error) {
            throw new Error(`NPZ member '${entry.name}': ${messageOf(error)}`);
        }
    }
    return arrays;
}

export interface NpzWriteOptions {
    /** DEFLATE every member, as np.savez_compressed does (default false, as np.savez). */
    compress?: boolean;
}

/**
 * An .npz archive with one '<key>.npy' member per entry (a Map works, and so
 * do the arrays readNpz returns). np.load reads the result.
 */
export function writeNpz(entries: Iterable<readonly [string, NpyWriteInput]>, options: NpzWriteOptions = {}): Uint8Array {
    const files: { name: string; data: Uint8Array }[] = [];
    const seen = new Set<string>();
    for (const [key, array] of entries) {
        if (seen.has(key)) throw new Error(`Duplicate NPZ key '${key}'.`);
        seen.add(key);
        files.push({ name: `${key}.npy`, data: writeNpy(array) });
    }
    return writeZip(files, options.compress ?? false);
}
