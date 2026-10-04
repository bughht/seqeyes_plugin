/**
 * Sign and unit conventions of the simulator — the single place they are
 * defined (plan §0). Every kernel, backend and writer derives its phases from
 * these helpers, and test/sim/conventions.test.ts pins them physically.
 *
 * The engine runs in Pulseq's native right-handed frame, the frame in which a
 * Pulseq RF waveform b(t)·e^{i(φ + 2πf(t − t₀))} is resonant with spins at
 * Δf = +f (so a slice sits at +f/(γ̄G)) and Pulseq's phase bookkeeping (RF
 * spoiling, phase_ppm centre compensation) holds as written:
 *
 *   free precession  M⊥ ← M⊥ · e^{+i2π(ΔK·r + Δf·dt)}
 *   RF field         B1(t) = Σ_c w_c·B1+_c(r) · shape(t) · e^{i(φ + 2πf(t − t_rf0))}
 *   spinor step      a = cos(π|B|w) − iπw·Bz·sinc(|B|w),
 *                    b = −iπw·(Bx + iBy)·sinc(|B|w)        (B in Hz, w in s)
 *   receive          S_c = Σ w_spin · conj(B1−_c(r)) · M⊥
 *   demodulation     × e^{−i(φ_adc + 2πf_adc·(t − t₀) + pm[s])}
 *   output           conj(S)
 *
 * The output conjugation makes delivered data follow the physical
 * e^{−iωt} convention used by MRzero ≥ 1.0 and KomaMRI, so images reconstruct
 * with an inverse FFT and a point object at r has phase −2π·k·r.
 */

/** Pulseq's default gyromagnetic ratio [Hz/T] (mr.opts). */
export const PULSEQ_GAMMA_HZ_PER_T = 42.576e6;

/** Default field strength when neither the caller nor the file gives one [T]. */
export const DEFAULT_B0_T = 3;

/**
 * Free-precession phase of one spin over a segment, in cycles, engine frame:
 * the spin's M⊥ is multiplied by e^{+i2π·cycles}.
 *
 * @param dk  k(t1) − k(t0) of the segment [1/m], physical axes.
 * @param r   Spin position [m], physical axes.
 * @param df  Spin off-resonance [Hz] (B0 map + chemical shift + T2′ offset).
 * @param dt  Segment duration [s].
 */
export function precessionCycles(dk: ArrayLike<number>, r: ArrayLike<number>, df: number, dt: number): number {
    return dk[0] * r[0] + dk[1] * r[1] + dk[2] * r[2] + df * dt;
}

/**
 * Receiver phase removed from ADC sample `s` [rad] — demodulation multiplies
 * the summed engine-frame signal by e^{−i·phase}. The sample sits at
 * t₀ + (s + ½)·dwell, with t₀ the ADC start (block start + ADC delay).
 * The phase-modulation shape is in radians (upstream stores it unscaled,
 * unlike RF phase shapes, which are in cycles). The 2π on the frequency term
 * is deliberate: upstream Sequence.m omits it for the ADC while applying it to
 * RF, which is inconsistent; including it makes an ADC frequency offset shift
 * the readout FOV exactly as the same RF offset shifts the slice.
 */
export function demodulationPhase(
    phaseOffset: number,
    freqOffset: number,
    dwell: number,
    s: number,
    phaseModulation: ArrayLike<number> | null,
): number {
    const t = (s + 0.5) * dwell;
    return phaseOffset + 2 * Math.PI * freqOffset * t + (phaseModulation ? phaseModulation[s] : 0);
}
