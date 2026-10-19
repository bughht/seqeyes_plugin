/**
 * N-dimensional arrays as the phantom readers return them.
 *
 * Readers keep the file's memory order instead of transposing on load: NumPy
 * files are usually C order while MATLAB and NIfTI files are Fortran order,
 * and reordering a 128³ map costs about as much as parsing it. Consumers index
 * through linearIndex/getValue, or call toOrder once when they need a fixed
 * layout.
 *
 * Values are always Float32Array or Float64Array: the simulator only does
 * arithmetic on the maps, and two output types keep its code paths few. Every
 * array a reader returns is a fresh copy that owns its whole buffer, so it can
 * be transferred to a worker without detaching the input or a sibling array.
 */

export type ArrayOrder = 'C' | 'F';

export interface NdArray {
    /** Source element type, e.g. '<f8', 'int16', 'single'. */
    dtype: string;
    shape: number[];
    /** 'C': last index fastest (NumPy default); 'F': first index fastest (MATLAB, NIfTI, Fortran-order NumPy). */
    order: ArrayOrder;
    /** Real part (or the values), converted: float64 sources and integers wider than 16 bits → Float64Array; everything else → Float32Array. */
    data: Float32Array | Float64Array;
    /** Imaginary part for complex sources. */
    imag?: Float32Array | Float64Array;
}

/** Number of elements of an array of this shape (1 for a 0-d array). */
export function elementCount(shape: readonly number[]): number {
    let count = 1;
    for (const size of shape) {
        if (!(Number.isInteger(size) && size >= 0)) throw new RangeError(`Invalid array shape [${shape.join(', ')}].`);
        count *= size;
    }
    if (!Number.isSafeInteger(count)) throw new RangeError(`Array shape [${shape.join(', ')}] has too many elements.`);
    return count;
}

/** Distance in elements between neighbours along each dimension of a dense array. */
export function stridesOf(shape: readonly number[], order: ArrayOrder): number[] {
    const strides = new Array<number>(shape.length);
    let stride = 1;
    if (order === 'C') {
        for (let k = shape.length - 1; k >= 0; k--) { strides[k] = stride; stride *= shape[k]; }
    } else {
        for (let k = 0; k < shape.length; k++) { strides[k] = stride; stride *= shape[k]; }
    }
    return strides;
}

/** Position in `data` of the element at `indices` (one per dimension, zero-based). */
export function linearIndex(array: Pick<NdArray, 'shape' | 'order'>, indices: ArrayLike<number>): number {
    const { shape } = array;
    if (indices.length !== shape.length) {
        throw new RangeError(`Expected ${shape.length} indices for shape [${shape.join(', ')}], got ${indices.length}.`);
    }
    let index = 0;
    const cOrder = array.order === 'C';
    for (let n = 0; n < shape.length; n++) {
        // Horner's scheme from the slowest dimension to the fastest.
        const k = cOrder ? n : shape.length - 1 - n;
        const i = indices[k];
        if (!(Number.isInteger(i) && i >= 0 && i < shape[k])) {
            throw new RangeError(`Index ${i} is out of range for dimension ${k} of size ${shape[k]}.`);
        }
        index = index * shape[k] + i;
    }
    return index;
}

/** The value (the real part, for complex arrays) at `indices`. */
export function getValue(array: NdArray, ...indices: number[]): number {
    return array.data[linearIndex(array, indices)];
}

/**
 * The same array laid out in `order`. Returns `array` itself when it already
 * is, and shares its data when both layouts coincide (at most one dimension
 * longer than 1); otherwise copies.
 */
export function toOrder(array: NdArray, order: ArrayOrder): NdArray {
    if (array.order === order) return array;
    if (array.shape.filter(size => size > 1).length <= 1) return { ...array, order };
    const result: NdArray = { ...array, order, data: reorder(array.data, array.shape, array.order, order) };
    if (array.imag) result.imag = reorder(array.imag, array.shape, array.order, order);
    return result;
}

function reorder(source: Float32Array | Float64Array, shape: readonly number[], from: ArrayOrder, to: ArrayOrder): Float32Array | Float64Array {
    const count = elementCount(shape);
    const target = source instanceof Float64Array ? new Float64Array(count) : new Float32Array(count);
    if (count === 0) return target;
    const strides = stridesOf(shape, to);
    // Walk the source in its own memory order, carrying the target offset
    // along like an odometer: the innermost run is a strided copy.
    const axes = shape.map((_, k) => k);
    if (from === 'C') axes.reverse();
    const [fast, ...slow] = axes;
    const run = shape[fast], step = strides[fast];
    const counter = new Array<number>(shape.length).fill(0);
    let offset = 0;
    for (let i = 0; i < count; i += run) {
        for (let j = 0; j < run; j++) target[offset + j * step] = source[i + j];
        for (const k of slow) {
            offset += strides[k];
            if (++counter[k] < shape[k]) break;
            offset -= strides[k] * shape[k];
            counter[k] = 0;
        }
    }
    return target;
}
