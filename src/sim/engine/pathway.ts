/**
 * The main echo pathway of a program, which the isochromat engine weights
 * T2′ and diffusion by.
 *
 * Isochromats sum every pathway in each spin's magnetization, so neither a
 * Lorentzian line of reversible dephasing (T2′) nor diffusion can act per
 * pathway as they do in the phase-graph engine. Instead the signal follows
 * one pathway: the transverse magnetization made by the last excitation
 * ('e'), reversed (k → −k, τ → −τ) by every refocusing pulse ('r'), with
 * other pulses (inversion, saturation, preparation) left out. Its dephasing
 * time τ and its b = 4π²∫|k(t)|²dt then weight each spin's signal by
 * e^{−|τ|/T2′}·e^{−bD}.
 *
 * That is exact where the echo's pathways all share τ and b: a gradient echo
 * or spin echo, the echoes of a CPMG train (every pathway of a symmetric
 * train refocuses at the echo) and diffusion-weighted EPI. It is approximate
 * where other pathways carry signal with their own τ or b: balanced SSFP,
 * stimulated echoes (STEAM resets at its second and third 90° pulses), and
 * the diffusion attenuation of spoiled steady states. As in the phase-graph
 * engine, each pulse acts at its centre, with precession and diffusion over
 * the halves before and after it.
 */

import { windowMoments, type SegmentMoments } from '../program/pwl';
import type { RfSegment } from '../program/types';

const FOUR_PI2 = 4 * Math.PI * Math.PI;

export class MainPathway {
    /** Dephasing time since the last excitation, reversed by refocusing [s]. */
    tau = 0;
    /** b-value since the last excitation [s/m²]. */
    b = 0;
    /** An excitation has happened; before it there is no pathway to weight. */
    excited = false;
    /** The pathway's gradient area [1/m]. */
    private readonly k = new Float64Array(3);
    private readonly halves = new Map<string, { pre: SegmentMoments; post: SegmentMoments }>();

    /** Free precession (or a readout window) of `dt` with these moments. */
    free(moments: SegmentMoments, dt: number): void {
        const k = this.k, m1 = moments.kIntegral, m2 = moments.kSecond;
        this.b += FOUR_PI2 * ((k[0] * k[0] + k[1] * k[1] + k[2] * k[2]) * dt
            + 2 * (k[0] * m1[0] + k[1] * m1[1] + k[2] * m1[2]) + m2[0] + m2[1] + m2[2]);
        k[0] += moments.dk[0]; k[1] += moments.dk[1]; k[2] += moments.dk[2];
        this.tau += dt;
    }

    /** An RF pulse: the half before its centre, its action there, the half after. */
    pulse(segment: RfSegment): void {
        let half = this.halves.get(segment.key);
        if (!half) {
            half = {
                pre: windowMoments(segment.gradient, segment.t0, segment.centerTime),
                post: windowMoments(segment.gradient, segment.centerTime, segment.t1),
            };
            this.halves.set(segment.key, half);
        }
        this.free(half.pre, segment.centerTime - segment.t0);
        if (segment.use === 'e') {
            this.k.fill(0);
            this.tau = 0;
            this.b = 0;
            this.excited = true;
        } else if (segment.use === 'r') {
            for (let a = 0; a < 3; a++) this.k[a] = -this.k[a] + 0;
            this.tau = -this.tau;
        }
        this.free(half.post, segment.t1 - segment.centerTime);
    }
}
