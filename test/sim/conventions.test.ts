/**
 * Physical sign conventions of the simulator (plan §0), pinned end to end:
 * parse → compile → reference engine → delivered signal.
 */
import { describe, expect, it } from 'vitest';

import { parseSequenceText } from '../../src/pulseq/reader';
import { compileProgram } from '../../src/sim/program/compile';
import { simulateReference, stepRfSpin, rfCells } from '../../src/sim/engine/reference';
import { equilibriumState, spinSetFrom, type SpinSpec } from '../../src/sim/engine/spins';
import { PULSEQ_GAMMA_HZ_PER_T } from '../../src/sim/conventions';
import { seqText, sincShape, type SeqSpec } from './helpers/seqBuilder';

function run(spec: SeqSpec, spins: SpinSpec[], coils = 1) {
    const program = compileProgram(parseSequenceText(seqText(spec)));
    return simulateReference(program, spinSetFrom(spins, coils));
}

function sample(result: ReturnType<typeof run>, s: number, coil = 0): [number, number] {
    const o = (s * result.coils + coil) * 2;
    return [result.signal[o], result.signal[o + 1]];
}

const phaseOf = ([re, im]: [number, number]) => Math.atan2(im, re);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** 90° block pulse: 100 samples of 1 µs at 2500 Hz. */
const BLOCK_90 = { amplitude: 2500, magShape: 1, centerUs: 50 };
const BLOCK_SHAPE = Array<number>(100).fill(1);

describe('delivered-signal conventions', () => {
    it('excites +y (physical) with an RF phase of zero', () => {
        const result = run({
            blocks: [{ ticks: 10, rf: 1 }, { ticks: 1, adc: 1 }],
            rf: [BLOCK_90],
            adc: [{ samples: 1, dwellNs: 1000 }],
            shapes: [BLOCK_SHAPE],
        }, [{}]);
        const [re, im] = sample(result, 0);
        expect(re).toBeCloseTo(0, 12);
        expect(im).toBeCloseTo(1, 12);
    });

    it('reports a constant echo phase when the ADC follows the RF phase (RF spoiling)', () => {
        for (const phase of [0.7, 2.1, -1.3]) {
            const result = run({
                blocks: [{ ticks: 10, rf: 1 }, { ticks: 1, adc: 1 }],
                rf: [{ ...BLOCK_90, phase }],
                adc: [{ samples: 1, dwellNs: 1000, phase }],
                shapes: [BLOCK_SHAPE],
            }, [{}]);
            const [re, im] = sample(result, 0);
            expect(re).toBeCloseTo(0, 12);
            expect(im).toBeCloseTo(1, 12);
        }
    });

    it('evolves as e^{−iωt}: a spin at +100 Hz loses phase over time', () => {
        const result = run({
            blocks: [{ ticks: 10, rf: 1 }, { ticks: 100, adc: 1 }],
            rf: [BLOCK_90],
            adc: [{ samples: 10, dwellNs: 100_000 }],
            shapes: [BLOCK_SHAPE],
        }, [{ df: 100 }]);
        for (let s = 1; s < 10; s++) {
            const step = wrap(phaseOf(sample(result, s)) - phaseOf(sample(result, s - 1)));
            expect(step).toBeCloseTo(wrap(-2 * Math.PI * 100 * 1e-4), 10);
        }
    });

    it('encodes a point object as e^{−i2π·k·r}', () => {
        const g = 1e5;    // Hz/m
        const x0 = 0.01;  // m
        const result = run({
            blocks: [{ ticks: 10, rf: 1 }, { ticks: 120, gx: 1, adc: 1 }],
            rf: [BLOCK_90],
            traps: [{ amplitude: g, riseUs: 100, flatUs: 1000, fallUs: 100 }],
            adc: [{ samples: 50, dwellNs: 20_000, delayUs: 100 }],
            shapes: [BLOCK_SHAPE],
        }, [{ x: x0 }]);
        // On the flat top k grows by g·dwell per sample.
        for (let s = 1; s < 50; s++) {
            const step = wrap(phaseOf(sample(result, s)) - phaseOf(sample(result, s - 1)));
            expect(step).toBeCloseTo(wrap(-2 * Math.PI * g * 20e-6 * x0), 9);
        }
    });

    it('shifts the readout FOV with the ADC frequency in the same direction as RF frequency shifts the slice', () => {
        const g = 1e5, x0 = 0.02;
        // A spin at +x0 under a positive readout gradient precesses at +g·x0 in
        // the engine frame; demodulating at f_adc = +g·x0 must hold it still.
        const result = run({
            blocks: [{ ticks: 10, rf: 1 }, { ticks: 120, gx: 1, adc: 1 }],
            rf: [BLOCK_90],
            traps: [{ amplitude: g, riseUs: 100, flatUs: 1000, fallUs: 100 }],
            adc: [{ samples: 50, dwellNs: 20_000, delayUs: 100, freq: g * x0 }],
            shapes: [BLOCK_SHAPE],
        }, [{ x: x0 }]);
        for (let s = 1; s < 50; s++) {
            expect(wrap(phaseOf(sample(result, s)) - phaseOf(sample(result, 0)))).toBeCloseTo(0, 9);
        }
    });

    it('applies conj(B1−): a receive coil with phase ψ shows the spin with phase +ψ', () => {
        const psi = 0.4;
        const result = run({
            blocks: [{ ticks: 10, rf: 1 }, { ticks: 1, adc: 1 }],
            rf: [BLOCK_90],
            adc: [{ samples: 1, dwellNs: 1000 }],
            shapes: [BLOCK_SHAPE],
        }, [{ rx: [[1, 0], [Math.cos(psi), Math.sin(psi)]] }], 2);
        const reference = phaseOf(sample(result, 0, 0));
        expect(wrap(phaseOf(sample(result, 0, 1)) - reference)).toBeCloseTo(psi, 12);
    });
});

describe('selective RF', () => {
    const gz = 4e5;                  // Hz/m (≈ 9.4 mT/m)
    const samples = 2000;            // 2 ms at 1 µs
    const tbw = 4;
    const thickness = tbw / (samples * 1e-6) / gz;   // 5 mm
    const shape = sincShape(samples, tbw);
    // Small-tip 30° pulse: flip = 2π·A·Σ(shape)·raster.
    const area = shape.reduce((a, b) => a + b, 0) * 1e-6;
    const amplitude = (30 / 360) / area;

    function profile(freq: number, withRephaser: boolean) {
        const zs = Array.from({ length: 201 }, (_, i) => (i - 100) * thickness / 25);
        const spec: SeqSpec = {
            blocks: [
                { ticks: 220, rf: 1, gz: 1 },
                withRephaser ? { ticks: 120, gz: 2 } : { ticks: 120 },
                { ticks: 1, adc: 1 },
            ],
            rf: [{ amplitude, magShape: 1, centerUs: 1000, delayUs: 100, freq }],
            traps: [
                { amplitude: gz, riseUs: 100, flatUs: 2000, fallUs: 100 },
                // Rephase half of the slice-select area from the RF centre on: g·(1000 + 100/2) µs.
                { amplitude: -gz * 1050 / 1000, riseUs: 100, flatUs: 900, fallUs: 100 },
            ],
            adc: [{ samples: 1, dwellNs: 1000 }],
            shapes: [shape],
        };
        const program = compileProgram(parseSequenceText(seqText(spec)));
        const spins = spinSetFrom(zs.map(z => ({ z })));
        const state = equilibriumState(spins.count);
        // Run RF and the rephaser, then read the per-spin transverse state.
        for (const segment of program.segments()) {
            if (segment.kind === 'rf') {
                const cells = rfCells(segment);
                for (let i = 0; i < spins.count; i++) stepRfSpin(cells, spins, i, state);
            } else if (segment.kind === 'free') {
                for (let i = 0; i < spins.count; i++) {
                    const cycles = segment.moments.dk[2] * spins.z[i];
                    const c = Math.cos(2 * Math.PI * cycles), s = Math.sin(2 * Math.PI * cycles);
                    const x = state.mx[i], y = state.my[i];
                    state.mx[i] = x * c - y * s;
                    state.my[i] = x * s + y * c;
                }
            } else {
                break;
            }
        }
        return zs.map((z, i) => ({ z, mxy: Math.hypot(state.mx[i], state.my[i]), phase: Math.atan2(state.my[i], state.mx[i]) }));
    }

    it('centres the slice at +f/(γ̄G)', () => {
        const offset = 0.01;
        const p = profile(gz * offset, true);
        const peak = p.reduce((best, v) => (v.mxy > best.mxy ? v : best));
        expect(Math.abs(peak.z - offset)).toBeLessThan(thickness / 10);
        // Nothing comes from the mirrored position.
        const mirror = p.reduce((best, v) => (Math.abs(v.z + offset) < Math.abs(best.z + offset) ? v : best));
        expect(mirror.mxy).toBeLessThan(0.01);
    });

    it('rephases the slice with a half-area gradient: flat phase across the slab', () => {
        const flat = profile(0, true).filter(v => Math.abs(v.z) < 0.3 * thickness);
        const spread = Math.max(...flat.map(v => v.phase)) - Math.min(...flat.map(v => v.phase));
        expect(spread).toBeLessThan(0.15);
        const unrephased = profile(0, false).filter(v => Math.abs(v.z) < 0.3 * thickness);
        const unrephasedSpread = Math.max(...unrephased.map(v => v.phase)) - Math.min(...unrephased.map(v => v.phase));
        expect(unrephasedSpread).toBeGreaterThan(1);
    });

    it('reaches the nominal small-tip flip at the slice centre', () => {
        const centre = profile(0, true).find(v => v.z === 0)!;
        expect(centre.mxy).toBeCloseTo(Math.sin(30 * Math.PI / 180), 2);
    });
});

describe('spectrally selective RF', () => {
    it('saturates fat at −3.35 ppm and leaves water alone (CHESS)', () => {
        const b0 = 3;
        const fat = -3.35e-6 * PULSEQ_GAMMA_HZ_PER_T * b0;     // ≈ −428 Hz
        // 8 ms Gaussian 90° centred on the fat line.
        const n = 8000;
        const shape = Array.from({ length: n }, (_, i) => Math.exp(-0.5 * (((i + 0.5) / n - 0.5) / 0.12) ** 2));
        const area = shape.reduce((a, b) => a + b, 0) * 1e-6;
        const amplitude = 0.25 / area;
        const program = compileProgram(parseSequenceText(seqText({
            blocks: [{ ticks: 810, rf: 1 }],
            rf: [{ amplitude, magShape: 1, centerUs: 4000, delayUs: 50, freqPPM: -3.35, use: 's' }],
            shapes: [shape],
            extraDefinitions: 'B0 3',
        })));
        expect(program.b0).toBe(b0);
        const spins = spinSetFrom([{ df: fat }, { df: 0 }]);
        const result = simulateReference(program, spins);
        expect(result.state.mz[0]).toBeLessThan(0.02);    // fat saturated
        expect(result.state.mz[1]).toBeGreaterThan(0.98); // water untouched
    });
});
