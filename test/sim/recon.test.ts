import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';
import { analyzeRfResponse } from '../../src/pulseq/rfResponse';

import { parseSequenceText } from '../../src/pulseq/reader';
import { compileProgram } from '../../src/sim/program/compile';
import { simulateReference } from '../../src/sim/engine/reference';
import { sheppLoganPhantom, spinsFromGrid2D } from '../../src/sim/phantom/builtin';
import { ChunkAccumulator, SimulationJob } from '../../src/sim/job';
import { adcTrajectory } from '../../src/sim/recon/trajectory';
import { reconstructCartesian } from '../../src/sim/recon/cartesian';
import { seqText, type BlockRow, type TrapRow } from './helpers/seqBuilder';

/**
 * A minimal 2D spin-warp sequence: hard 90° pulse, phase encode with readout
 * prephaser, flat-top readout, long TR so every line starts from equilibrium.
 * Gradient areas are exact in the program's k bookkeeping, so the samples land
 * on the Cartesian grid.
 */
function spinWarp(n: number, fov: number): string {
    const dk = 1 / fov;
    const dwellUs = 20;
    const g = dk / (dwellUs * 1e-6);                    // readout amplitude [Hz/m]
    const riseUs = 100;
    const flatUs = n * dwellUs;
    // k at sample s must be (s − n/2)·dk: prephase −g·(rise/2 + dwell·(n + 1)/2).
    const prephaseArea = -g * (riseUs / 2 + dwellUs * (n + 1) / 2) * 1e-6;
    const preRiseUs = 100, preFlatUs = 500;
    const preAmplitude = prephaseArea / ((preFlatUs + preRiseUs) * 1e-6);
    const traps: TrapRow[] = [
        { amplitude: g, riseUs, flatUs, fallUs: riseUs },
        { amplitude: preAmplitude, riseUs: preRiseUs, flatUs: preFlatUs, fallUs: preRiseUs },
    ];
    const blocks: BlockRow[] = [];
    for (let line = 0; line < n; line++) {
        const area = (line - n / 2) * dk;
        traps.push({ amplitude: area / ((preFlatUs + preRiseUs) * 1e-6), riseUs: preRiseUs, flatUs: preFlatUs, fallUs: preRiseUs });
        blocks.push({ ticks: 20, rf: 1 });                                   // 200 µs: 100 µs hard pulse
        blocks.push({ ticks: 70, gx: 2, gy: 3 + line });                      // prephase + phase encode
        blocks.push({ ticks: (2 * riseUs + flatUs) / 10, gx: 1, adc: 1 });    // readout
        blocks.push({ ticks: 1_000_000 });                                    // 10 s recovery
    }
    return seqText({
        blocks,
        rf: [{ amplitude: 2500, magShape: 1, centerUs: 50 }],
        traps,
        adc: [{ samples: n, dwellNs: dwellUs * 1000, delayUs: riseUs }],
        shapes: [Array(100).fill(1)],
        extraDefinitions: `FOV ${fov} ${fov} 0.005`,
    });
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
    let ma = 0, mb = 0;
    for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
    ma /= a.length; mb /= b.length;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < a.length; i++) {
        sab += (a[i] - ma) * (b[i] - mb);
        saa += (a[i] - ma) ** 2;
        sbb += (b[i] - mb) ** 2;
    }
    return sab / Math.sqrt(saa * sbb);
}

describe('simulate and reconstruct a Pulseq demo GRE', () => {
    // writeGradientEcho samples kx at half-integer multiples of Δk, as Pulseq's
    // spin-warp readouts do; the reconstruction must keep every sample.
    const path = join(__dirname, '..', 'seqeyes_demo_seq_files', 'writeGradientEcho.seq');
    const bytes = new Uint8Array(readFileSync(path));
    const seq = parseSequenceBytes(bytes, path);
    const fov = seq.definitions.get('FOV') as [number, number, number];
    const n = 128;

    it('keeps every sample on the half-integer readout grid', () => {
        const grid = sheppLoganPhantom(n, fov[0], fov[1]);
        const result = simulateReference(compileProgram(seq), spinsFromGrid2D(grid));
        const recon = reconstructCartesian(adcTrajectory(compileProgram(seq)), result.signal, 1, { fov });
        expect([recon.nu, recon.nv]).toEqual([n, n]);
        expect(recon.frames).toBe(1);
        expect(recon.offGridFraction).toBe(0);
        expect(recon.fill).toBe(1);
        expect(recon.warnings).toEqual([]);
    });

    it('matches the RF-spoiled GRE contrast in the right orientation', () => {
        // Each TR leaves ~2.5 cycles of x dephasing across a 2 mm voxel. With
        // the spins per voxel the job's probe chooses, the spoiler cancels
        // transverse pathways as the voxel integral does. A 32×32 object at
        // 2 mm in the centre of the 128² FOV keeps this quick.
        const program = compileProgram(seq);
        const m = 32, voxel = fov[0] / n;
        const job = new SimulationJob(bytes, path, { phantom: 'shepp-logan', size: m, fov: [m * voxel, m * voxel], subSpins: 'auto' });
        expect(job.plan.axes.map(axis => axis.reason)).toEqual(['spoiling', 'none']);
        const grid = job.grid;
        let total: ChunkAccumulator | null = null;
        for (let chunk = 0; chunk < job.plan.chunks; chunk++) {
            const signal = job.simulateChunk(chunk);
            total ??= new ChunkAccumulator(signal.length, job.plan.chunks);
            total.add(chunk, signal);
        }
        const recon = job.reconstruct(total!.signal);
        const image = new Float32Array(m * m);
        for (let r = 0; r < m; r++) {
            for (let c = 0; c < m; c++) image[r * m + c] = recon.images[(n / 2 - m / 2 + r) * n + (n / 2 - m / 2 + c)];
        }

        // Prediction: flip, TR and TE measured from the program; ideal spoiling
        // from equilibrium up to the k-space centre line (linear order, line N/2).
        const centres: number[] = [];
        let flipDeg = 0, firstAdcCentre = NaN;
        for (const segment of program.segments()) {
            if (segment.kind === 'rf') {
                centres.push(segment.centerTime);
                if (!flipDeg) flipDeg = analyzeRfResponse(segment.operator.rf, seq).carrierAreaDeg;
            } else if (segment.kind === 'adc' && Number.isNaN(firstAdcCentre)) {
                firstAdcCentre = 0.5 * (segment.t0 + segment.t1);
            }
        }
        const tr = centres[1] - centres[0];
        const te = firstAdcCentre - centres[0];
        expect(flipDeg).toBeGreaterThan(1);
        const alpha = flipDeg * Math.PI / 180;
        const expected = new Float32Array(m * m);
        for (let i = 0; i < m * m; i++) {
            if (!(grid.pd[i] > 0)) continue;
            const e1 = Math.exp(-tr / grid.t1[i]);
            let mz = 1;
            for (let line = 0; line < n / 2; line++) mz = mz * Math.cos(alpha) * e1 + 1 - e1;
            expected[i] = grid.pd[i] * mz * Math.sin(alpha) * Math.exp(-te / grid.t2[i]);
        }
        const fit = pearson(image, expected);
        expect(fit).toBeGreaterThan(0.99);
        const flipped = new Float32Array(m * m);
        for (let r = 0; r < m; r++) flipped.set(expected.subarray((m - 1 - r) * m, (m - r) * m), r * m);
        expect(fit).toBeGreaterThan(pearson(image, flipped) + 0.1);
    });
});

describe('simulate and reconstruct', () => {
    const n = 32, fov = 0.25;
    const seq = parseSequenceText(spinWarp(n, fov));
    const grid = sheppLoganPhantom(n, fov, fov);
    const spins = spinsFromGrid2D(grid);
    const result = simulateReference(compileProgram(seq), spins);
    const trajectory = adcTrajectory(compileProgram(seq));
    const fovDefinition = seq.definitions.get('FOV') as [number, number, number];
    const recon = reconstructCartesian(trajectory, result.signal, result.coils, { fov: fovDefinition });

    it('places every sample on the grid', () => {
        expect(trajectory.readouts).toBe(n);
        expect(recon.axes).toEqual([0, 1]);
        expect([recon.nu, recon.nv]).toEqual([n, n]);
        expect(recon.frames).toBe(1);
        expect(recon.offGridFraction).toBe(0);
        expect(recon.fill).toBe(1);
    });

    it('reconstructs the phantom proton density in the right orientation', () => {
        // T2 decay to TE (~1 ms) is negligible here, so |image| ∝ PD.
        const image = recon.images.subarray(0, n * n);
        expect(pearson(image, grid.pd)).toBeGreaterThan(0.99);
        const flipped = new Float32Array(n * n);
        for (let r = 0; r < n; r++) flipped.set(grid.pd.subarray((n - 1 - r) * n, (n - r) * n), r * n);
        expect(pearson(image, flipped)).toBeLessThan(0.9);
    });
});
