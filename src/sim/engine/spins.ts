/**
 * Spin ensembles in structure-of-arrays form, and their magnetization state.
 *
 * Every spin starts at equilibrium M = (0, 0, 1) (M0 = 1); proton density and
 * voxel volume enter only through `weight` in the receive sum, so the signal
 * scale does not depend on how many spins sample a voxel (see conventions.ts).
 */

export interface SpinSet {
    readonly count: number;
    /** Position [m], physical gradient axes. */
    readonly x: Float64Array;
    readonly y: Float64Array;
    readonly z: Float64Array;
    /** Off-resonance [Hz]: B0 map + chemical shift + T2′ offset. */
    readonly df: Float64Array;
    /** Relaxation rates [1/s]; 0 means no relaxation. */
    readonly r1: Float64Array;
    readonly r2: Float64Array;
    /** Signal weight: PD · voxel volume / spins in the voxel. */
    readonly weight: Float64Array;
    /** Effective complex B1+ scale (1 = nominal), real and imaginary parts. */
    readonly b1Re: Float64Array;
    readonly b1Im: Float64Array;
    /** Receive coil count. */
    readonly coils: number;
    /** Complex B1− per coil, coil-major: [coil · count + spin]. */
    readonly rxRe: Float64Array;
    readonly rxIm: Float64Array;
}

/**
 * Spins folded into classes along rewound axes.
 *
 * Suppose an axis carries no gradient during any RF pulse or readout, and
 * its gradient area since the sequence start is zero at every RF pulse (a
 * Cartesian phase encode with its rewinder). Then spins that differ only in
 * their position along that axis meet every pulse in the same state. Between
 * pulses they differ by the phase 2π·K(t)·r, with K the area since the start.
 * One representative per class is simulated (the SpinSet, its folded
 * coordinates zero). Its members are the real spins, which enter only at
 * readout, through that phase. plan/dephasing.ts decides which axes fold.
 */
export interface SpinMembers {
    readonly count: number;
    /** Class (row of the simulated SpinSet) of each member. */
    readonly classOf: Int32Array;
    /** Signal weight of each member (the class rows' own weights are unused). */
    readonly weight: Float64Array;
    /** Fold point of each member: an index into `foldPoints`. */
    readonly foldOf: Int32Array;
    /** Distinct member positions along the folded axes, xyz interleaved [m]; other axes zero. */
    readonly foldPoints: Float64Array;
    /** Receive coils and complex B1− per member, coil-major as on SpinSet. */
    readonly coils: number;
    readonly rxRe: Float64Array;
    readonly rxIm: Float64Array;
    /**
     * Through-slice sampling: the profile of each class (classes sharing a
     * profile differ only in z). Members then index profiles in `classOf`,
     * and a profile's signal is the sum of its classes, each weighted by the
     * class row's weight. All classes of a profile must read out alike.
     */
    readonly profileOf?: Int32Array;
    readonly profiles?: number;
}

export interface SpinState {
    readonly mx: Float64Array;
    readonly my: Float64Array;
    readonly mz: Float64Array;
}

export interface SpinSpec {
    x?: number; y?: number; z?: number;
    df?: number;
    t1?: number; t2?: number;
    weight?: number;
    b1?: [number, number];
    rx?: [number, number][];
}

/** Build a spin set from per-spin descriptions (tests and probes). */
export function spinSetFrom(specs: SpinSpec[], coils = 1): SpinSet {
    const count = specs.length;
    const set = {
        count,
        x: new Float64Array(count), y: new Float64Array(count), z: new Float64Array(count),
        df: new Float64Array(count),
        r1: new Float64Array(count), r2: new Float64Array(count),
        weight: new Float64Array(count),
        b1Re: new Float64Array(count), b1Im: new Float64Array(count),
        coils,
        rxRe: new Float64Array(coils * count), rxIm: new Float64Array(coils * count),
    };
    specs.forEach((spec, i) => {
        set.x[i] = spec.x ?? 0;
        set.y[i] = spec.y ?? 0;
        set.z[i] = spec.z ?? 0;
        set.df[i] = spec.df ?? 0;
        set.r1[i] = spec.t1 && Number.isFinite(spec.t1) ? 1 / spec.t1 : 0;
        set.r2[i] = spec.t2 && Number.isFinite(spec.t2) ? 1 / spec.t2 : 0;
        set.weight[i] = spec.weight ?? 1;
        set.b1Re[i] = spec.b1?.[0] ?? 1;
        set.b1Im[i] = spec.b1?.[1] ?? 0;
        for (let c = 0; c < coils; c++) {
            const rx = spec.rx?.[c] ?? [1, 0];
            set.rxRe[c * count + i] = rx[0];
            set.rxIm[c * count + i] = rx[1];
        }
    });
    return set;
}

export function equilibriumState(count: number): SpinState {
    const mz = new Float64Array(count);
    mz.fill(1);
    return { mx: new Float64Array(count), my: new Float64Array(count), mz };
}

export function copyState(state: SpinState): SpinState {
    return { mx: state.mx.slice(), my: state.my.slice(), mz: state.mz.slice() };
}
