/**
 * A phantom as the phase-graph engine sees it (engine/phaseGraph.ts):
 *   - sources: every voxel with PD > 0, once per phantom plane the
 *     sub-slices take (a 3-D phantom), with its centre, its own B0, PD, coil
 *     sensitivities and the run of sub-slices it covers;
 *   - tissue classes: what the configuration amplitudes depend on, namely
 *     T1, T2, B1+ and the off-resonance the RF operators are built at. Each
 *     voxel's own B0 enters exactly at readout (through the dephasing time),
 *     so off-resonance is binned only for the pulses, to `binning.df` Hz.
 * Phantoms with few tissues (Shepp–Logan, label maps) keep their exact
 * T1/T2/B1. Continuous maps would make a class of nearly every voxel; past
 * `budget` classes, T1 and T2 are binned on a relative grid and B1 on an
 * absolute one, coarser until the budget holds. A class takes the
 * PD-weighted mean of its members.
 */

import type { PhaseGraphClass, PhaseGraphSources } from '../engine/phaseGraph';
import { occupiedVoxels, planeMaps, type Phantom2D, type ThroughSlice } from './model';

export interface ClassBinning {
    /** Relative T1/T2 bin width (0: exact). */
    t: number;
    /** Absolute B1+ bin width (0: exact). */
    b1: number;
    /** Off-resonance bin width for RF operators [Hz]. */
    df: number;
}

export interface PhaseGraphPhantom {
    classes: PhaseGraphClass[];
    sources: PhaseGraphSources;
    /** The binning used; `t` and `b1` stay 0 when the exact classes fit the budget. */
    binning: ClassBinning;
}

export function phaseGraphPhantom(
    phantom: Phantom2D,
    slices: ThroughSlice | null,
    rfStep: number,
    fineStep: { t: number; b1: number },
    budget: number,
): PhaseGraphPhantom {
    const K = slices ? slices.z.length : 1;
    // Runs of sub-slices taking each plane (sub-slices ascend in z, planes follow z).
    const runs: { plane: number; from: number; to: number }[] = [];
    for (let j = 0; j < K; j++) {
        const plane = slices ? slices.plane[j] : -1;
        const last = runs[runs.length - 1];
        if (last && last.plane === plane) last.to = j + 1;
        else runs.push({ plane, from: j, to: j + 1 });
    }
    const voxels = occupiedVoxels(phantom);
    const cells = phantom.nx * phantom.ny;
    const [dx, dy] = phantom.voxel;
    const xs: number[] = [], ys: number[] = [], dfs: number[] = [], pds: number[] = [], froms: number[] = [], tos: number[] = [];
    const t1s: number[] = [], t2s: number[] = [], b1s: number[] = [], cellOf: number[] = [];
    for (const v of voxels) {
        const col = v % phantom.nx, row = Math.floor(v / phantom.nx);
        for (const run of runs) {
            const maps = planeMaps(phantom, run.plane);
            const pd = maps.pd[v];
            if (!(pd > 0)) continue;
            xs.push((col - phantom.nx / 2) * dx);
            ys.push((phantom.ny / 2 - 1 - row) * dy);
            dfs.push(maps.b0 ? maps.b0[v] : 0);
            pds.push(pd);
            froms.push(run.from);
            tos.push(run.to);
            t1s.push(maps.t1[v]);
            t2s.push(maps.t2[v]);
            b1s.push(maps.b1 ? maps.b1[v] : 1);
            cellOf.push(v);
        }
    }
    const count = xs.length;

    // Classes: exact T1/T2/B1 if they fit, else binned coarser and coarser.
    let binning: ClassBinning = { t: 0, b1: 0, df: rfStep };
    let assignment = assign(binning);
    while (assignment.keys.size > budget) {
        binning = binning.t === 0
            ? { t: fineStep.t, b1: fineStep.b1, df: rfStep }
            : { t: 2 * binning.t, b1: 2 * binning.b1, df: 2 * binning.df };
        assignment = assign(binning);
        if (binning.t > 1) break;
    }
    const classOf = assignment.classOf;
    const C = assignment.keys.size;
    // PD-weighted means per class.
    const sum = new Float64Array(5 * C);
    for (let i = 0; i < count; i++) {
        const c = classOf[i], w = pds[i];
        sum[5 * c] += w;
        sum[5 * c + 1] += w * finiteOr(t1s[i], 1e6);
        sum[5 * c + 2] += w * finiteOr(t2s[i], 1e6);
        sum[5 * c + 3] += w * b1s[i];
        sum[5 * c + 4] += w * dfs[i];
    }
    const classes: PhaseGraphClass[] = [];
    for (let c = 0; c < C; c++) {
        const w = sum[5 * c];
        classes.push({ t1: sum[5 * c + 1] / w, t2: sum[5 * c + 2] / w, b1Re: sum[5 * c + 3] / w, b1Im: 0, df: sum[5 * c + 4] / w });
    }

    const coils = phantom.coils?.count ?? 1;
    const rxRe = new Float64Array(coils * count), rxIm = new Float64Array(coils * count);
    for (let i = 0; i < count; i++) {
        for (let c = 0; c < coils; c++) {
            rxRe[c * count + i] = phantom.coils ? phantom.coils.re[c * cells + cellOf[i]] : 1;
            rxIm[c * count + i] = phantom.coils ? phantom.coils.im[c * cells + cellOf[i]] : 0;
        }
    }
    return {
        classes,
        sources: {
            count,
            x: Float64Array.from(xs), y: Float64Array.from(ys), df: Float64Array.from(dfs),
            classOf, sliceFrom: Int32Array.from(froms), sliceTo: Int32Array.from(tos),
            pd: Float64Array.from(pds), coils, rxRe, rxIm,
        },
        binning,
    };

    function assign(bins: ClassBinning): { keys: Map<string, number>; classOf: Int32Array } {
        const keys = new Map<string, number>();
        const classOf = new Int32Array(count);
        const logStep = (step: number) => Math.log1p(step);
        const timeKey = (t: number) => (!(Number.isFinite(t) && t > 0) ? 'inf' : bins.t > 0 ? String(Math.round(Math.log(t) / logStep(bins.t))) : String(t));
        for (let i = 0; i < count; i++) {
            const key = `${timeKey(t1s[i])}|${timeKey(t2s[i])}|${bins.b1 > 0 ? Math.round(b1s[i] / bins.b1) : b1s[i]}|${Math.round(dfs[i] / bins.df)}`;
            let c = keys.get(key);
            if (c === undefined) { c = keys.size; keys.set(key, c); }
            classOf[i] = c;
        }
        return { keys, classOf };
    }
}

function finiteOr(value: number, fallback: number): number {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}
