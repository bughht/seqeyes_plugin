/**
 * What the sequence's gradients say about sampling a voxel with spins, from
 * one pass over the program.
 *
 * A voxel's signal is the integral of its magnetization over the voxel; spins
 * replace it with a sum over N points per axis. Per axis this records:
 *   - the net gradient area between consecutive RF pulses. When it is a
 *     sizeable fraction of a cycle across the voxel, the axis is spoiled and
 *     N must be found by simulation (plan/probe.ts);
 *   - the readout's largest |k|, which sets the spins needed to resolve a
 *     voxel larger than the image pixel (resolutionCount);
 *   - whether the axis can fold: no gradient under any pulse or readout, and
 *     zero area at every pulse. Spins along it then share one history
 *     (engine/spins.ts, SpinMembers).
 */

import type { SimProgram } from '../program/compile';

export interface DephasingAnalysis {
    /** Largest |net gradient area| between consecutive RF pulse centres, per axis [1/m]. */
    intervalArea: [number, number, number];
    /** Largest |k| of the encoding pathway at ADC window edges, per axis [1/m]. */
    readoutExtent: [number, number, number];
    /** Union of the ADC windows' active-axis masks (bit a = axis a). */
    readoutAxes: number;
    /** Axes with any gradient during an RF pulse (bit a = axis a). */
    rfGradientAxes: number;
    /** Largest |gradient area since the start| at an RF pulse start, per axis [1/m]. */
    areaAtRf: [number, number, number];
    rfEvents: number;
    adcEvents: number;
    adcSamples: number;
}

/** One pass over the program; k bookkeeping as in recon/trajectory.ts. */
export function analyzeDephasing(program: SimProgram): DephasingAnalysis {
    const intervalArea: [number, number, number] = [0, 0, 0];
    const readoutExtent: [number, number, number] = [0, 0, 0];
    const areaAtRf: [number, number, number] = [0, 0, 0];
    const sinceRf = [0, 0, 0];
    const k = [0, 0, 0];
    const total = [0, 0, 0];
    let readoutAxes = 0, rfGradientAxes = 0;
    let rfEvents = 0, adcEvents = 0, adcSamples = 0;
    for (const segment of program.segments()) {
        const dk = segment.moments.dk;
        if (segment.kind === 'rf') {
            for (let a = 0; a < 3; a++) areaAtRf[a] = Math.max(areaAtRf[a], Math.abs(total[a]));
            const { ga, gb } = segment.gradient;
            for (let i = 0; i < ga.length; i++) if (ga[i] !== 0 || gb[i] !== 0) rfGradientAxes |= 1 << (i % 3);
            const head = segment.kToCenter;
            if (rfEvents > 0) {
                for (let a = 0; a < 3; a++) {
                    intervalArea[a] = Math.max(intervalArea[a], Math.abs(sinceRf[a] + head[a]));
                }
            }
            for (let a = 0; a < 3; a++) sinceRf[a] = dk[a] - head[a];
            rfEvents++;
            for (let a = 0; a < 3; a++) k[a] += head[a];
            const use = segment.use || '';
            if (use === 'e' || use === '' || use === 'u') k.fill(0);
            else if (use === 'r') for (let a = 0; a < 3; a++) k[a] = -k[a];
            for (let a = 0; a < 3; a++) {
                k[a] += dk[a] - head[a];
                total[a] += dk[a];
            }
            continue;
        }
        if (segment.kind === 'adc') {
            adcEvents++;
            adcSamples += segment.numSamples;
            readoutAxes |= segment.activeAxes;
            for (let a = 0; a < 3; a++) {
                readoutExtent[a] = Math.max(readoutExtent[a], Math.abs(k[a]), Math.abs(k[a] + dk[a]));
            }
        }
        for (let a = 0; a < 3; a++) {
            sinceRf[a] += dk[a];
            k[a] += dk[a];
            total[a] += dk[a];
        }
    }
    return { intervalArea, readoutExtent, readoutAxes, rfGradientAxes, areaAtRf, rfEvents, adcEvents, adcSamples };
}

/**
 * Axes along which spins can be folded into classes (engine/spins.ts,
 * SpinMembers): no gradient under any RF pulse or readout, and a gradient area
 * since the start that is zero at every pulse, to 1e-9 cycles across `extent`
 * (the object size per axis [m]). A Cartesian phase encode with its rewinder
 * qualifies; a readout axis or an unbalanced spoiler does not.
 */
export function foldableAxes(analysis: DephasingAnalysis, extent: readonly [number, number, number]): number {
    let mask = 0;
    for (let a = 0; a < 3; a++) {
        const bit = 1 << a;
        if (analysis.readoutAxes & bit || analysis.rfGradientAxes & bit) continue;
        if (analysis.areaAtRf[a] * extent[a] > 1e-9) continue;
        mask |= bit;
    }
    return mask;
}

/**
 * Spins per voxel an axis needs to resolve a voxel larger than the image
 * pixel: about 4 per cycle of the readout's largest |k| across it.
 */
export function resolutionCount(analysis: DephasingAnalysis, axis: number, voxel: number): number {
    const extent = analysis.readoutExtent[axis] * voxel;
    return extent > 0.5 + 1e-3 ? Math.ceil(4 * extent) : 1;
}

/**
 * Net dephasing across a voxel between consecutive RF pulses [cycles]. Above
 * a small fraction of a cycle the axis is spoiled, and the count must come
 * from plan/probe.ts.
 */
export function intervalCycles(analysis: DephasingAnalysis, axis: number, voxel: number): number {
    return analysis.intervalArea[axis] * voxel;
}
