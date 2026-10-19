import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseSequenceText } from '../../src/pulseq/reader';
import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';
import { simulateReference } from '../../src/sim/engine/reference';
import type { SpinSet } from '../../src/sim/engine/spins';
import { ChunkAccumulator, SimulationJob, type JobSettings } from '../../src/sim/job';
import { sheppLoganPhantom2D } from '../../src/sim/phantom/builtin';
import { assignPlanes, occupiedVoxels, phantomSpins, type Phantom2D, type PhantomMaps } from '../../src/sim/phantom/model';
import { measurePulses, planSlices, type PulseResponse } from '../../src/sim/plan/slices';
import { compileProgram } from '../../src/sim/program/compile';
import { seqText, sincShape, type SeqSpec } from './helpers/seqBuilder';

const demo = (file: string) => {
    const path = join(__dirname, '..', 'seqeyes_demo_seq_files', file);
    return { path, bytes: new Uint8Array(readFileSync(path)) };
};
const programOf = (bytes: Uint8Array, name: string) => compileProgram(parseSequenceBytes(bytes, name));
const programFrom = (spec: SeqSpec) => programOf(new TextEncoder().encode(seqText(spec)), 'test.seq');
const bytesFrom = (spec: SeqSpec) => new TextEncoder().encode(seqText(spec));

function runJob(job: SimulationJob): Float64Array {
    let total: ChunkAccumulator | null = null;
    for (let chunk = 0; chunk < job.plan.chunks; chunk++) {
        const signal = job.simulateChunk(chunk);
        total ??= new ChunkAccumulator(signal.length, job.plan.chunks);
        total.add(chunk, signal);
    }
    return total!.signal;
}

function relativeDifference(a: Float64Array, b: Float64Array): number {
    let diff = 0, norm = 0;
    for (let i = 0; i < a.length; i++) {
        diff += (a[i] - b[i]) ** 2;
        norm += b[i] ** 2;
    }
    return Math.sqrt(diff / norm);
}

/** One slice-selective pulse with its gradient (rise/fall 100 µs, the pulse on the flat top), as the first block. */
function selectivePulse(magnitude: number[], phase: number[] | null, amplitude: number, gradient: number, use = 'e'): SeqSpec {
    const samples = magnitude.length;
    const shapes = [magnitude];
    if (phase) shapes.push(phase);
    return {
        blocks: [{ ticks: (samples + 200) / 10, rf: 1, gz: 1 }],
        rf: [{ amplitude, magShape: 1, phaseShape: phase ? 2 : 0, centerUs: samples / 2, delayUs: 100, use }],
        traps: [{ amplitude: gradient, riseUs: 100, flatUs: samples, fallUs: 100 }],
        shapes,
    };
}

/** A real waveform as Pulseq magnitude (peak 1) and phase (0 or ½ cycle) shapes, and its peak. */
function signedShape(values: number[]): { magnitude: number[]; phase: number[]; peak: number } {
    const peak = Math.max(...values.map(Math.abs));
    return { magnitude: values.map(v => Math.abs(v) / peak), phase: values.map(v => (v < 0 ? 0.5 : 0)), peak };
}

/** Amplitude [Hz] for a flip of `degrees` with a magnitude shape sampled at 1 µs (real, signed by `phase`). */
function amplitudeFor(degrees: number, magnitude: number[], phase: number[] | null): number {
    let area = 0;
    for (let i = 0; i < magnitude.length; i++) area += magnitude[i] * (phase && phase[i] ? -1 : 1) * 1e-6;
    return degrees / 360 / Math.abs(area);
}

const onlyExcitation = (pulses: PulseResponse[]) => pulses.filter(p => p.role === 'excitation');

describe('measured RF pulses', () => {
    it('finds the demo GRE slab as designed: 3 mm FWHM, centred, 10°', () => {
        const { path, bytes } = demo('writeGradientEcho.seq');
        const [pulse] = measurePulses(programOf(bytes, path));
        expect(pulse.role).toBe('excitation');
        expect(pulse.events).toBe(128);
        expect(pulse.bands).toHaveLength(1);
        expect(pulse.bands[0].thickness * 1000).toBeCloseTo(3.0, 1);
        expect(Math.abs(pulse.bands[0].centre)).toBeLessThan(1e-5);
        expect(pulse.peakFlipDeg).toBeCloseTo(10, 0);
    });

    it('finds the three slabs of the multi-slice EPI at their offsets', () => {
        const { path, bytes } = demo('writeEpi.seq');
        const centres = onlyExcitation(measurePulses(programOf(bytes, path))).map(p => p.bands[0].centre * 1000).sort((a, b) => a - b);
        expect(centres).toHaveLength(3);
        [-3, 0, 3].forEach((expected, i) => expect(centres[i]).toBeCloseTo(expected, 1));
    });

    it('measures a hard 180° slab exactly as the spinor of a rectangular pulse predicts', () => {
        // Rectangular B1 = 1/(2T) for T = 1 ms on 100 kHz/m. |β|² falls to ½ at
        // u = Δf·T solving 0.25/(0.25 + u²) · sin²(π√(0.25 + u²)) = ½, about
        // two thirds of the small-tip half width (the 180° profile is narrower).
        const samples = 1000, gradient = 100e3;
        const pulse = measurePulses(programFrom(selectivePulse(new Array(samples).fill(1), null, 500, gradient, 'r')))[0];
        const beta2 = (u: number) => 0.25 / (0.25 + u * u) * Math.sin(Math.PI * Math.sqrt(0.25 + u * u)) ** 2;
        let lo = 0, hi = 0.5;
        for (let i = 0; i < 60; i++) {
            const mid = 0.5 * (lo + hi);
            if (beta2(mid) > 0.5) lo = mid; else hi = mid;
        }
        const expected = 2 * lo / (samples * 1e-6 * gradient);
        expect(pulse.role).toBe('refocusing');
        expect(pulse.extentZ).toBeCloseTo(gradient * samples * 1e-6, 6);
        expect(pulse.bands[0].thickness / expected).toBeGreaterThan(0.99);
        expect(pulse.bands[0].thickness / expected).toBeLessThan(1.01);
    });

    it('separates the bands of a multiband pulse and leaves the gap between them empty', () => {
        // A 3 ms, TBW 4 sinc modulated by cos(2π·4 kHz·t): two 3.33 mm bands at ±10 mm on 400 kHz/m.
        const samples = 3000, gradient = 400e3;
        const base = sincShape(samples, 4);
        const waveform = base.map((v, i) => v * Math.cos(2 * Math.PI * 4000 * ((i + 0.5) * 1e-6 - 1.5e-3)));
        const { magnitude, phase } = signedShape(waveform);
        const single = measurePulses(programFrom(selectivePulse(base, null, amplitudeFor(10, base, null), gradient)))[0];
        const pulse = measurePulses(programFrom(selectivePulse(magnitude, phase, amplitudeFor(10, base, null), gradient)))[0];
        expect(pulse.bands).toHaveLength(2);
        const [left, right] = pulse.bands;
        expect(left.centre * 1000).toBeCloseTo(-10, 1);
        expect(right.centre * 1000).toBeCloseTo(10, 1);
        for (const band of pulse.bands) expect(Math.abs(band.thickness / single.bands[0].thickness - 1)).toBeLessThan(0.03);
        const plan = planSlices([pulse], { density: 2 })!;
        expect(plan.ranges).toHaveLength(2);
        expect(Array.from(plan.z).some(z => Math.abs(z) < 0.005)).toBe(false);
        expect(plan.reference / single.bands[0].thickness).toBeCloseTo(1, 2);
    });

    it('gives a VERSE pulse the profile of the plateau pulse it was made from', () => {
        // Plateau: TBW 4 sinc, 3 ms on 400 kHz/m. VERSE: the same k-space path
        // on a 800 kHz/m trapezoid with 750 µs ramps, B1 scaled by g(t)/G.
        const plateauSamples = 3000, g0 = 400e3, t0 = 3e-3;
        const plateau = sincShape(plateauSamples, 4);
        const plateauPulse = measurePulses(programFrom(selectivePulse(plateau, null, amplitudeFor(10, plateau, null), g0)))[0];

        const g1 = 800e3, ramp = 750e-6, flat = 750e-6, total = 2 * ramp + flat;
        const gAt = (t: number) => (t < ramp ? g1 * t / ramp : t < ramp + flat ? g1 : g1 * (total - t) / ramp);
        const kAt = (t: number) => (t < ramp ? 0.5 * g1 * t * t / ramp
            : t < ramp + flat ? 0.5 * g1 * ramp + g1 * (t - ramp)
                : g1 * (ramp + flat) - 0.5 * g1 * (total - t) ** 2 / ramp);
        const sincAt = (tau: number) => {
            const x = 4 * (tau / t0 - 0.5);
            const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
            return sinc * (0.5 + 0.5 * Math.cos(2 * Math.PI * (tau / t0 - 0.5)));
        };
        const samples = Math.round(total * 1e6);
        const waveform = Array.from({ length: samples }, (_, i) => {
            const t = (i + 0.5) * 1e-6;
            return sincAt(kAt(t) / g0) * gAt(t) / g0;
        });
        const { magnitude, phase, peak } = signedShape(waveform);
        // B1 per sample = peak·magnitude·sign; amplitude chosen so the area matches the plateau pulse's.
        const plateauAmplitude = amplitudeFor(10, plateau, null);
        const spec: SeqSpec = {
            blocks: [{ ticks: samples / 10, rf: 1, gz: 1 }],
            rf: [{ amplitude: plateauAmplitude * peak / Math.max(...plateau), magShape: 1, phaseShape: 2, centerUs: samples / 2, use: 'e' }],
            traps: [{ amplitude: g1, riseUs: ramp * 1e6, flatUs: flat * 1e6, fallUs: ramp * 1e6 }],
            shapes: [magnitude, phase],
        };
        const versePulse = measurePulses(programFrom(spec))[0];
        expect(versePulse.extentZ / plateauPulse.extentZ).toBeCloseTo(1, 2);
        expect(versePulse.duration).toBeLessThan(plateauPulse.duration);
        expect(versePulse.bands[0].thickness / plateauPulse.bands[0].thickness).toBeCloseTo(1, 1);
        expect(versePulse.peakFlipDeg).toBeCloseTo(plateauPulse.peakFlipDeg, 0);
    });

    it('inverts with an adiabatic pulse across B1 errors where a hard 180° does not', () => {
        // HS1, 10 ms, β = 800 /s, μ = 4.9 (±624 Hz sweep), 800 Hz peak B1.
        const samples = 10_000, beta = 800, mu = 4.9;
        const magnitude: number[] = [], phase: number[] = [];
        for (let i = 0; i < samples; i++) {
            const t = (i + 0.5) * 1e-6 - 5e-3;
            const sech = 1 / Math.cosh(beta * t);
            magnitude.push(sech);
            phase.push(mu * Math.log(sech) / (2 * Math.PI));
        }
        const hs: SeqSpec = {
            blocks: [{ ticks: samples / 10, rf: 1 }],
            rf: [{ amplitude: 800, magShape: 1, phaseShape: 2, centerUs: samples / 2, use: 'i' }],
            shapes: [magnitude, phase],
        };
        const hard: SeqSpec = {
            blocks: [{ ticks: 50, rf: 1 }],
            rf: [{ amplitude: 1000, magShape: 1, centerUs: 250, use: 'i' }],       // 500 µs × 1 kHz = 180°
            shapes: [new Array(500).fill(1)],
        };
        const scales = [0.7, 1, 1.3], offsets = [-200, 0, 200];
        const spins: SpinSet = {
            count: 9,
            x: new Float64Array(9), y: new Float64Array(9), z: new Float64Array(9),
            df: Float64Array.from({ length: 9 }, (_, i) => offsets[i % 3]),
            r1: new Float64Array(9), r2: new Float64Array(9),
            weight: new Float64Array(9).fill(1),
            b1Re: Float64Array.from({ length: 9 }, (_, i) => scales[Math.floor(i / 3)]), b1Im: new Float64Array(9),
            coils: 1, rxRe: new Float64Array(9).fill(1), rxIm: new Float64Array(9),
        };
        const after = (spec: SeqSpec) => simulateReference(programFrom({ ...spec, blocks: [...spec.blocks, { ticks: 10, adc: 1 }], adc: [{ samples: 1, dwellNs: 1000 }] }), spins).state.mz;
        const adiabatic = after(hs), rect = after(hard);
        for (let i = 0; i < 9; i++) expect(adiabatic[i]).toBeLessThan(-0.95);
        expect(rect[0 * 3 + 1]).toBeGreaterThan(-0.7);                 // B1 0.7 on resonance: cos(0.7π) ≈ −0.59
        // The measured response shows the inverted band, against off-resonance.
        const pulse = measurePulses(programFrom(hs))[0];
        expect(pulse.role).toBe('inversion');
        expect(pulse.axis).toBe('frequency');
        const near = (f: number) => {
            let best = 0;
            for (let i = 0; i < pulse.offsets.length; i++) if (Math.abs(pulse.offsets[i] - f) < Math.abs(pulse.offsets[best] - f)) best = i;
            return pulse.mz[best];
        };
        expect(near(0)).toBeLessThan(-0.99);
        expect(near(400)).toBeLessThan(-0.9);
    });

    it('shows the fat saturation of the demo EPI acting on fat and sparing water', () => {
        const { path, bytes } = demo('writeEpiRS.seq');
        const fatSat = measurePulses(programOf(bytes, path)).find(p => p.role === 'saturation')!;
        expect(fatSat.axis).toBe('frequency');
        const near = (f: number) => {
            let best = 0;
            for (let i = 0; i < fatSat.offsets.length; i++) if (Math.abs(fatSat.offsets[i] - f) < Math.abs(fatSat.offsets[best] - f)) best = i;
            return fatSat.mz[best];
        };
        expect(near(fatSat.freq)).toBeCloseTo(Math.cos(110 * Math.PI / 180), 1);
        expect(near(0)).toBeGreaterThan(0.99);
    });

    it('measures pulses that differ only in their x/y gradients once', () => {
        const { path, bytes } = demo('writeTrufi.seq');
        const pulses = measurePulses(programOf(bytes, path));
        expect(pulses.length).toBeLessThanOrEqual(3);
        expect(pulses.reduce((sum, p) => sum + p.events, 0)).toBeGreaterThan(200);
    });
});

describe('through-slice simulation', () => {
    /** 90° sinc (TBW 4, 2 ms) on 400 kHz/m — a 5 mm slab — then, optionally, its rephaser, then an FID. */
    function fidSequence(rephase: boolean): SeqSpec {
        const shape = sincShape(2000, 4);
        const spec = selectivePulse(shape, null, amplitudeFor(90, shape, null), 400e3);
        spec.traps!.push({ amplitude: -400e3, riseUs: 100, flatUs: 950, fallUs: 100 });
        spec.blocks.push(rephase ? { ticks: 115, gz: 2 } : { ticks: 115 });
        spec.blocks.push({ ticks: 64, adc: 1 });
        spec.adc = [{ samples: 64, dwellNs: 10_000 }];
        return spec;
    }
    const pointPhantom: Phantom2D = {
        nx: 1, ny: 1, voxel: [1e-3, 1e-3, 0],
        maps: { pd: Float32Array.of(1), t1: Float32Array.of(1e3), t2: Float32Array.of(1e3) },
        source: 'point', notes: [],
    };
    const firstSample = (job: SimulationJob) => {
        const signal = runJob(job);
        return Math.hypot(signal[0], signal[1]);
    };

    it('needs the slice rephaser, as a real slab does', () => {
        const settings = (throughSlice: 'auto' | 'off'): JobSettings => ({ phantom: { kind: 'phantom', phantom: pointPhantom }, subSpins: [1, 1], throughSlice });
        const rephased = new SimulationJob(bytesFrom(fidSequence(true)), 'fid.seq', settings('auto'));
        const unrephased = new SimulationJob(bytesFrom(fidSequence(false)), 'fid.seq', settings('auto'));
        const flat = new SimulationJob(bytesFrom(fidSequence(false)), 'fid.seq', settings('off'));
        expect(rephased.plan.slices!.reference * 1000).toBeCloseTo(5.4, 0);
        // The rephased slab gives about the 2-D signal; without the rephaser,
        // ~2 cycles of phase across the slab cancel most of it. At z = 0 the
        // missing rephaser goes unnoticed.
        expect(firstSample(rephased)).toBeGreaterThan(0.9);
        expect(firstSample(rephased)).toBeLessThan(1.1);
        expect(firstSample(unrephased)).toBeLessThan(0.25);
        expect(firstSample(flat)).toBeCloseTo(1, 2);
    });

    it('folded classes with sub-slices give the signal of every spin simulated on its own', () => {
        const { path, bytes } = demo('writeGradientEcho.seq');
        const phantom = sheppLoganPhantom2D(12, 0.024, 0.024);
        const job = new SimulationJob(bytes, path, { phantom: { kind: 'phantom', phantom }, subSpins: [8, 2] });
        expect(job.plan.axes[1].folded).toBe(true);
        const slices = job.plan.resolvedSlices;
        if (slices === 'off') throw new Error('expected sub-slices');
        expect(slices.z.length).toBeGreaterThan(4);
        const folded = runJob(job);
        const z = Float64Array.from(slices.z);
        const spins = phantomSpins(phantom, {
            subSpins: [8, 2], voxels: occupiedVoxels(phantom),
            slices: { z, weight: Float64Array.from(slices.weight), plane: assignPlanes(phantom, z) },
        });
        expect(job.plan.spins).toBe(spins.count);
        expect(job.plan.simulated).toBeLessThan(spins.count);
        const direct = simulateReference(programOf(bytes, path), spins).signal;
        expect(relativeDifference(folded, direct)).toBeLessThan(1e-11);
    });

    it('takes each sub-slice from the nearest plane of a 3-D phantom', () => {
        const { path, bytes } = demo('writeGradientEcho.seq');
        // Own plane empty, its neighbours 1 mm away full: only the sampled
        // slab reaches them (the 3 mm slab spans about ±2.9 mm).
        const base = sheppLoganPhantom2D(8, 0.016, 0.016);
        const empty: PhantomMaps = { pd: new Float32Array(64), t1: base.maps.t1, t2: base.maps.t2 };
        const phantom: Phantom2D = {
            ...base, voxel: [0.002, 0.002, 0.001], maps: empty,
            planes: [-3, -2, -1, 1, 2, 3].map(offset => ({ offset, maps: base.maps })),
        };
        const energy = (signal: Float64Array) => signal.reduce((sum, v) => sum + v * v, 0);
        const sliced = new SimulationJob(bytes, path, { phantom: { kind: 'phantom', phantom }, subSpins: [4, 1] });
        expect(sliced.plan.slices!.planes).toBeGreaterThan(3);
        expect(energy(runJob(sliced))).toBeGreaterThan(0);
        const flat = new SimulationJob(bytes, path, { phantom: { kind: 'phantom', phantom }, subSpins: [4, 1], throughSlice: 'off' });
        expect(energy(runJob(flat))).toBe(0);
        const z = Float64Array.from([-0.0029, -0.0012, 0.0004, 0.0016, 0.0026]);
        expect(Array.from(assignPlanes(phantom, z), p => (p < 0 ? 0 : phantom.planes![p].offset))).toEqual([-3, -1, 0, 2, 3]);
    });

    it('covers every plane of a 3-D phantom exactly once, without straddling plane boundaries', () => {
        // The demo GRE's 3 mm slab over 1 mm planes, and a hard pulse over a 9-plane volume.
        const { path, bytes } = demo('writeGradientEcho.seq');
        const hard = compileProgram(parseSequenceText(seqText({
            blocks: [{ ticks: 2, rf: 1 }, { ticks: 64, adc: 1 }],
            rf: [{ amplitude: 1250, magShape: 1, centerUs: 10 }],
            adc: [{ samples: 64, dwellNs: 10_000 }],
            shapes: [Array(20).fill(1)],
        })));
        const pitch = 0.001;
        const cases = [
            { pulses: measurePulses(programOf(bytes, path)), volume: [-4.5 * pitch, 4.5 * pitch] as [number, number] },
            { pulses: measurePulses(hard), volume: [-4.5 * pitch, 4.5 * pitch] as [number, number] },
        ];
        for (const { pulses, volume } of cases) {
            for (const density of [1, 1.5, 2, 3]) {
                for (const boxes of [false, true]) {
                    const plan = planSlices(pulses, { density, planeThickness: pitch, volume, boxes })!;
                    const perPlane = new Map<number, number>();
                    plan.z.forEach((z, j) => {
                        const plane = Math.round(z / pitch);
                        // The sub-slice lies inside its plane.
                        expect(Math.abs(z - plane * pitch) + plan.width[j] / 2).toBeLessThanOrEqual(0.5 * pitch * (1 + 1e-9));
                        perPlane.set(plane, (perPlane.get(plane) ?? 0) + plan.weight[j] * plan.reference / pitch);
                    });
                    // A plane the sub-slices reach is covered whole, or by the slab's edge.
                    for (const [plane, covered] of perPlane) {
                        if (plan.extent === 'volume' || Math.abs(plane) < 1) expect(covered).toBeCloseTo(1, 9);
                    }
                }
            }
        }
        // Boxes need only one sub-slice per plane where no pulse acts: the hard pulse's volume.
        expect(planSlices(cases[1].pulses, { density: 3, planeThickness: pitch, volume: cases[1].volume, boxes: true })!.z.length).toBe(9);
        expect(planSlices(cases[1].pulses, { density: 3, planeThickness: pitch, volume: cases[1].volume })!.z.length).toBe(27);
    });

    it('loses spin-echo amplitude to a refocusing slab narrower than the excitation', () => {
        // writeTSE: 90° slab 5.5 mm FWHM, 180° refocusing |β|² 4.2 mm.
        const { path, bytes } = demo('writeTSE.seq');
        const phantom = sheppLoganPhantom2D(4, 0.256, 0.256);
        const echo = (throughSlice: 'auto' | 'off') => {
            const job = new SimulationJob(bytes, path, { phantom: { kind: 'phantom', phantom }, subSpins: [2, 1], throughSlice });
            const signal = runJob(job);
            const layout = job.rawLayout();
            let peak = 0;
            for (let s = 0; s < layout.samples[0]; s++) peak = Math.max(peak, Math.hypot(signal[2 * s], signal[2 * s + 1]));
            return peak;
        };
        const ratio = echo('auto') / echo('off');
        expect(ratio).toBeLessThan(0.95);
        expect(ratio).toBeGreaterThan(0.5);
    });
});
