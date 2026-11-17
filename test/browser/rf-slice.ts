import { PULSEQ_GAMMA_HZ_PER_T } from '../../src/sim/conventions';
import { seqText, sincShape } from '../sim/helpers/seqBuilder';

/**
 * One block: a 2 ms, 90° windowed sinc on the flat top of a 10 mT/m z
 * trapezoid, moved to slice `z` [m] with freqOffset = G·z, as Pulseq writes a
 * slice offset.
 */
export function sliceOffsetSequence(z: number): string {
    const gradient = 10e-3 * PULSEQ_GAMMA_HZ_PER_T;
    const shape = sincShape(2000, 4);
    const amplitude = 0.25 / (shape.reduce((sum, v) => sum + v, 0) * 1e-6);
    return seqText({
        blocks: [{ ticks: 220, rf: 1, gz: 1 }],
        rf: [{ amplitude, magShape: 1, centerUs: 1000, delayUs: 100, freq: gradient * z }],
        traps: [{ amplitude: gradient, riseUs: 100, flatUs: 2000, fallUs: 100 }],
        shapes: [shape],
    });
}
