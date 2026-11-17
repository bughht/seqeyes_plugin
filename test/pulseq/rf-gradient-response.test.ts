/**
 * RF response under the gradient played with the pulse: the slice a pulse
 * selects is a position, which a VERSE pulse writes as nonlinear phase that no
 * single frequency offset demodulates.
 */

import { describe, expect, it } from 'vitest';

import { decodeAllBlocks } from '../../src/pulseq/decoder';
import { parseSequenceText } from '../../src/pulseq/reader';
import { analyzeRfResponse } from '../../src/pulseq/rfResponse';
import type { PulseqSequence, RFResponseAnalysis } from '../../src/pulseq/types';
import { PULSEQ_GAMMA_HZ_PER_T } from '../../src/sim/conventions';
import { rfCells, stepRfSpin } from '../../src/sim/engine/reference';
import { equilibriumState, spinSetFrom } from '../../src/sim/engine/spins';
import { compileProgram } from '../../src/sim/program/compile';
import { seqText, sincShape, type SeqSpec } from '../sim/helpers/seqBuilder';

const RASTER = 1e-6;
const G = 10e-3 * PULSEQ_GAMMA_HZ_PER_T;   // 10 mT/m [Hz/m]
const SAMPLES = 2000;

function response(seq: PulseqSequence, block = 0): RFResponseAnalysis {
    return decodeAllBlocks(seq)[block].rf!.response;
}

/** Amplitude giving a real shape a small-tip area of `degrees`. */
function amplitudeFor(shape: number[], degrees: number): number {
    return degrees / 360 / (shape.reduce((sum, v) => sum + v, 0) * RASTER);
}

/** A 2 ms windowed sinc in a 2.2 ms block, played on the flat top of a z trapezoid. */
function slabSelect(options: {
    gradient: number;
    freq?: number;
    phaseCycles?: number[];
    use?: string;
    traps?: SeqSpec['traps'];
}): PulseqSequence {
    const shape = sincShape(SAMPLES, 4);
    const shapes = options.phaseCycles ? [shape, options.phaseCycles] : [shape];
    return parseSequenceText(seqText({
        blocks: [{ ticks: 220, rf: 1, gz: 1 }],
        rf: [{
            amplitude: amplitudeFor(shape, 90), magShape: 1, phaseShape: options.phaseCycles ? 2 : undefined,
            centerUs: 1000, delayUs: 100, freq: options.freq, use: options.use,
        }],
        traps: options.traps ?? [{ amplitude: options.gradient, riseUs: 100, flatUs: 2000, fallUs: 100 }],
        shapes,
    }));
}

/**
 * A VERSE sinc for slice `z`: the gradient dips to 40 % under the main lobe
 * and the RF follows it, so the excitation in k is the plain sinc; the slice
 * is written as phase 2π·z·(k(t) − k_c), as a generator translating a slice
 * by phase does. Gradient and RF have their own delays, so the analysis has to
 * align them.
 */
function verseSlice(z: number): PulseqSequence {
    const cells = 2560;
    const gradRaster = 10e-6;
    const gradDelayUs = 20;
    const rfDelayUs = 100;
    const lead = (rfDelayUs - gradDelayUs) * 1e-6;   // RF start on the gradient's clock
    const gradSamples = 270;
    const duration = cells * RASTER;
    const profile = (tau: number) => {
        const t = tau - lead - duration / 2;
        return G * (1 - 0.6 * Math.exp(-((t / (0.2 * duration)) ** 2)));
    };
    // The decoder's arbitrary gradient: first at 0, samples at raster centres, last at the end.
    const times = [0];
    const values = [profile(0)];
    for (let i = 0; i < gradSamples; i++) {
        times.push((i + 0.5) * gradRaster);
        values.push(profile((i + 0.5) * gradRaster));
    }
    times.push(gradSamples * gradRaster);
    values.push(profile(gradSamples * gradRaster));

    const kAt = (tau: number) => {
        let k = 0;
        for (let i = 0; i + 1 < times.length && times[i] < tau; i++) {
            const t1 = Math.min(times[i + 1], tau);
            const g1 = values[i] + (values[i + 1] - values[i]) * (t1 - times[i]) / (times[i + 1] - times[i]);
            k += 0.5 * (values[i] + g1) * (t1 - times[i]);
        }
        return k;
    };
    const k = Array.from({ length: cells }, (_, n) => kAt(lead + (n + 0.5) * RASTER));
    const kStart = kAt(lead);
    const kEnd = kAt(lead + duration);
    const kCentre = 0.5 * (kStart + kEnd);
    const kSpan = kEnd - kStart;

    // Weighting in k is a Hann-windowed TBW-4 sinc; B1 = W(k)·g(t).
    const real = k.map((kn, n) => {
        const u = (kn - kCentre) / kSpan;
        const sinc = Math.abs(u) < 1e-12 ? 1 : Math.sin(Math.PI * 4 * u) / (Math.PI * 4 * u);
        return sinc * (0.5 + 0.5 * Math.cos(2 * Math.PI * u)) * profile(lead + (n + 0.5) * RASTER) / G;
    });
    const amplitude = amplitudeFor(real, 90);
    const peak = Math.max(...real.map(Math.abs));
    const magnitude: number[] = [];
    const phaseCycles: number[] = [];
    real.forEach((value, n) => {
        const cycles = (value < 0 ? 0.5 : 0) + z * (k[n] - kCentre);
        magnitude.push(Math.abs(value) / peak);
        phaseCycles.push(cycles - Math.floor(cycles));   // Pulseq stores [0, 1)
    });
    return parseSequenceText(seqText({
        blocks: [{ ticks: 280, rf: 1, gz: 1 }],
        rf: [{ amplitude: amplitude * peak, magShape: 1, phaseShape: 2, centerUs: rfDelayUs + duration * 5e5, delayUs: rfDelayUs }],
        arbs: [{ amplitude: 1, first: values[0], last: values[values.length - 1], shape: 3, delayUs: gradDelayUs }],
        shapes: [magnitude, phaseCycles, values.slice(1, -1)],
    }));
}

/** The reference simulator's polar angle for a spin at `z` after the pulse. */
function simulatedPolarDeg(seq: PulseqSequence, z: number): number {
    const spins = spinSetFrom([{ z }]);
    const state = equilibriumState(spins.count);
    for (const segment of compileProgram(seq).segments()) {
        if (segment.kind !== 'rf') continue;
        stepRfSpin(rfCells(segment), spins, 0, state);
        break;
    }
    return Math.acos(Math.max(-1, Math.min(1, state.mz[0]))) * 180 / Math.PI;
}

describe('RF response under the slice gradient', () => {
    it('places a sinc whose freqOffset is G·z at +z, as Pulseq writes a slice offset', () => {
        const centre = response(slabSelect({ gradient: G })).bands[0];
        for (const gradient of [G, -G]) {
            for (const z of [-0.04, 0.02]) {
                const result = response(slabSelect({ gradient, freq: gradient * z }));
                expect(result.domain).toBe('position');
                expect(result.axis).toBe('z');
                expect(result.bands).toHaveLength(1);
                expect(Math.abs(result.bands[0].positionM! - z)).toBeLessThan(0.05e-3);
                expect(result.bands[0].polarFlipDeg).toBeCloseTo(centre.polarFlipDeg, 2);
                // On resonance at the slice, relative to the carrier.
                expect(Math.abs(result.bands[0].frequencyOffsetHz)).toBeLessThan(G * 0.05e-3);
            }
        }
        expect(centre.polarFlipDeg).toBeCloseTo(90, 0);
    });

    it('reduces to the frequency-domain result at f = G·z under a constant gradient', () => {
        const ramp = 3000;   // Hz, written into the phase shape
        const phaseCycles = Array.from({ length: SAMPLES }, (_, i) => {
            const cycles = ramp * (i + 0.5) * RASTER;
            return cycles - Math.floor(cycles);
        });
        const phaseRamp = slabSelect({ gradient: G, phaseCycles });
        const position = response(phaseRamp);
        const frequency = analyzeRfResponse(phaseRamp.rfs.get(1)!, phaseRamp, 'e');
        const offset = response(slabSelect({ gradient: G, freq: ramp }));

        expect(frequency.domain).toBeUndefined();
        expect(position.domain).toBe('position');
        expect(position.bands[0].positionM! * G).toBeCloseTo(frequency.bands[0].frequencyOffsetHz, 6);
        expect(position.bands[0].frequencyOffsetHz).toBeCloseTo(frequency.bands[0].frequencyOffsetHz, 6);
        expect(position.bands[0].spectralAreaDeg).toBeCloseTo(frequency.bands[0].spectralAreaDeg, 9);
        expect(position.bands[0].polarFlipDeg).toBeCloseTo(frequency.bands[0].polarFlipDeg, 9);
        // A freqOffset is the same ramp: it moves the slice, not the frame. The
        // oscillator advances it within each 1 µs sample where the shape holds
        // it, which is worth sinc(f·Δt) of B1: 0.0013° at 3 kHz.
        expect(offset.bands[0].positionM!).toBeCloseTo(position.bands[0].positionM!, 9);
        expect(offset.bands[0].spectralAreaDeg).toBeCloseTo(position.bands[0].spectralAreaDeg, 6);
        expect(offset.bands[0].polarFlipDeg).toBeCloseTo(position.bands[0].polarFlipDeg, 2);
        // A constant phase offset changes neither.
        const shifted = parseSequenceText(seqText({
            blocks: [{ ticks: 220, rf: 1, gz: 1 }],
            rf: [{ amplitude: phaseRamp.rfs.get(1)!.amplitude, magShape: 1, phaseShape: 2, centerUs: 1000, delayUs: 100, phase: 1.3 }],
            traps: [{ amplitude: G, riseUs: 100, flatUs: 2000, fallUs: 100 }],
            shapes: [sincShape(SAMPLES, 4), phaseCycles],
        }));
        expect(response(shifted).bands[0].polarFlipDeg).toBeCloseTo(position.bands[0].polarFlipDeg, 9);
    });

    it('gives every slice of a VERSE pulse the flip angle of the centre slice', () => {
        const zs = [-0.07, -0.0305, 0, 0.0015, 0.05, 0.0735];
        const results = zs.map(z => response(verseSlice(z)));
        const centre = results[2].bands[0];
        expect(centre.polarFlipDeg).toBeGreaterThan(85);
        results.forEach((result, i) => {
            expect(result.domain).toBe('position');
            expect(result.axis).toBe('z');
            expect(result.bands).toHaveLength(1);
            expect(Math.abs(result.bands[0].positionM! - zs[i])).toBeLessThan(0.005e-3);
            expect(Math.abs(result.bands[0].spectralAreaDeg - centre.spectralAreaDeg)).toBeLessThan(1e-4);
            // The slice's phase is held per 1 µs sample while the spin precesses
            // at g·z, which costs up to 0.05° at 74 mm; the simulator agrees.
            expect(Math.abs(result.bands[0].polarFlipDeg - centre.polarFlipDeg)).toBeLessThan(0.1);
        });

        // The static-offset analysis cannot see these slices as one pulse.
        const statics = zs.map(z => {
            const seq = verseSlice(z);
            return analyzeRfResponse(seq.rfs.get(1)!, seq, 'e').bands[0].polarFlipDeg;
        });
        expect(Math.max(...statics) - Math.min(...statics)).toBeGreaterThan(5);
    });

    it('agrees with the reference simulator at the recovered position', () => {
        for (const z of [0, 0.03, -0.065]) {
            const seq = verseSlice(z);
            const band = response(seq).bands[0];
            expect(Math.abs(simulatedPolarDeg(seq, band.positionM!) - band.polarFlipDeg)).toBeLessThan(0.01);
        }
        const offset = slabSelect({ gradient: G, freq: G * 0.02 });
        const band = response(offset).bands[0];
        expect(Math.abs(simulatedPolarDeg(offset, band.positionM!) - band.polarFlipDeg)).toBeLessThan(0.05);
    });

    it('keeps the static analysis under a negligible gradient', () => {
        // 10 Hz/m over 2 ms moves k by 0.02 cycles/m.
        const seq = slabSelect({ gradient: 10, freq: 500 });
        const result = response(seq);
        expect(result.domain).toBeUndefined();
        expect(result.bands[0].frequencyOffsetHz).toBeCloseTo(0, 6);
    });

    it('marks gradients it cannot represent as unmodelled', () => {
        // Gz for the first half, Gy for the second: the direction turns.
        const turning = parseSequenceText(seqText({
            blocks: [{ ticks: 220, rf: 1, gy: 2, gz: 1 }],
            rf: [{ amplitude: amplitudeFor(sincShape(SAMPLES, 4), 90), magShape: 1, centerUs: 1000, delayUs: 100 }],
            traps: [
                { amplitude: G, riseUs: 100, flatUs: 900, fallUs: 100 },
                { amplitude: G, riseUs: 100, flatUs: 900, fallUs: 100, delayUs: 1100 },
            ],
            shapes: [sincShape(SAMPLES, 4)],
        }));
        expect(response(turning).domain).toBe('unmodelled');

        // An oscillating Gz: k goes out and back, as in a spectral-spatial pulse.
        const reversing = parseSequenceText(seqText({
            blocks: [{ ticks: 220, rf: 1, gz: 1 }],
            rf: [{ amplitude: amplitudeFor(sincShape(SAMPLES, 4), 90), magShape: 1, centerUs: 1000, delayUs: 100 }],
            arbs: [{ amplitude: G, first: 0, last: 0, shape: 2 }],
            shapes: [
                sincShape(SAMPLES, 4),
                Array.from({ length: 220 }, (_, i) => Math.sin(2 * Math.PI * 4 * (i + 0.5) / 220)),
            ],
        }));
        const oscillating = response(reversing);
        expect(oscillating.domain).toBe('unmodelled');
        expect(oscillating.bands.length).toBeGreaterThan(0);
    });

    it('keeps inversion pulses on the static analysis whatever the gradient', () => {
        const result = response(slabSelect({ gradient: G, freq: G * 0.02, use: 'i' }));
        expect(result.domain).toBeUndefined();
        expect(result.bands).toHaveLength(1);
        expect(result.bands[0].frequencyOffsetHz).toBe(0);
    });

    it('analyses one RF entry separately under each gradient it plays with', () => {
        const seq = parseSequenceText(seqText({
            blocks: [{ ticks: 220, rf: 1, gz: 1 }, { ticks: 220, rf: 1, gz: 2 }],
            rf: [{ amplitude: amplitudeFor(sincShape(SAMPLES, 4), 90), magShape: 1, centerUs: 1000, delayUs: 100, freq: G * 0.02 }],
            traps: [
                { amplitude: G, riseUs: 100, flatUs: 2000, fallUs: 100 },
                { amplitude: 2 * G, riseUs: 100, flatUs: 2000, fallUs: 100 },
            ],
            shapes: [sincShape(SAMPLES, 4)],
        }));
        const [first, second] = decodeAllBlocks(seq).map(block => block.rf!.response);
        expect(Math.abs(first.bands[0].positionM! - 0.02)).toBeLessThan(0.05e-3);
        expect(Math.abs(second.bands[0].positionM! - 0.01)).toBeLessThan(0.05e-3);
    });
});
