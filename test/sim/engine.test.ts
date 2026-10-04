import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';
import { compileProgram } from '../../src/sim/program/compile';
import { SimulationCancelledError, simulateReference } from '../../src/sim/engine/reference';
import { spinSetFrom, type SpinSpec } from '../../src/sim/engine/spins';
import { CounterRng } from '../../src/sim/rng';
import { sheppLoganPhantom, spinsFromGrid2D } from '../../src/sim/phantom/builtin';

function load(name: string) {
    const path = join(__dirname, '..', 'seqeyes_demo_seq_files', name);
    return parseSequenceBytes(new Uint8Array(readFileSync(path)), path);
}

/** Spins spread over the FOV and the slab, with every per-spin parameter varied. */
function randomSpins(count: number, seed: number): SpinSpec[] {
    const rng = new CounterRng(seed);
    const u = new Float64Array(2);
    const specs: SpinSpec[] = [];
    for (let i = 0; i < count; i++) {
        rng.uniform2(i, 0, 1, u);
        const x = (u[0] - 0.5) * 0.2, y = (u[1] - 0.5) * 0.2;
        rng.uniform2(i, 1, 1, u);
        const z = (u[0] - 0.5) * 0.006, df = (u[1] - 0.5) * 100;
        rng.uniform2(i, 2, 1, u);
        const t1 = 0.3 + u[0], t2 = 0.02 + 0.1 * u[1];
        rng.uniform2(i, 3, 1, u);
        const b1 = 0.8 + 0.4 * u[0], b1Phase = (u[1] - 0.5);
        specs.push({
            x, y, z, df, t1, t2,
            b1: [b1 * Math.cos(b1Phase), b1 * Math.sin(b1Phase)],
            rx: [[1, 0], [Math.cos(u[0] * 3), Math.sin(u[1] * 3)]],
        });
    }
    return specs;
}

describe('reference engine', () => {
    for (const name of ['writeGradientEcho.seq', 'writeTSE.seq']) {
        it(`applies cached RF operators exactly as stepping every event: ${name}`, () => {
            const seq = load(name);
            const spins = spinSetFrom(randomSpins(24, 7), 2);
            const program = compileProgram(seq);
            const cached = simulateReference(program, spins, { rfMode: 'cached' });
            const stepped = simulateReference(compileProgram(seq), spins, { rfMode: 'stepping' });
            let peak = 0, worst = 0;
            for (let i = 0; i < cached.signal.length; i++) {
                peak = Math.max(peak, Math.abs(stepped.signal[i]));
                worst = Math.max(worst, Math.abs(cached.signal[i] - stepped.signal[i]));
            }
            expect(peak).toBeGreaterThan(0);
            expect(worst / peak).toBeLessThan(1e-11);
            for (let i = 0; i < spins.count; i++) {
                expect(cached.state.mz[i]).toBeCloseTo(stepped.state.mz[i], 11);
            }
        });
    }

    it('groups identically evolving spins without changing the signal', () => {
        // A grid phantom has many spins sharing x (and tissue) under an x readout.
        const seq = load('writeGradientEcho.seq');
        const grid = sheppLoganPhantom(24, 0.256, 0.256);
        const spins = spinsFromGrid2D(grid);
        const grouped = simulateReference(compileProgram(seq), spins, { readout: 'grouped' });
        const direct = simulateReference(compileProgram(seq), spins, { readout: 'direct' });
        let peak = 0, worst = 0;
        for (let i = 0; i < grouped.signal.length; i++) {
            peak = Math.max(peak, Math.abs(direct.signal[i]));
            worst = Math.max(worst, Math.abs(grouped.signal[i] - direct.signal[i]));
        }
        expect(peak).toBeGreaterThan(0);
        expect(worst / peak).toBeLessThan(1e-11);
    });

    it('reports monotonic progress ending at 1, and can be cancelled', () => {
        const seq = load('writeGradientEcho.seq');
        const spins = spinSetFrom(randomSpins(4, 1));
        const fractions: number[] = [];
        simulateReference(compileProgram(seq), spins, { onProgress: f => fractions.push(f), progressInterval: 16 });
        expect(fractions.length).toBeGreaterThan(3);
        for (let i = 1; i < fractions.length; i++) expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
        expect(fractions[fractions.length - 1]).toBe(1);

        let polls = 0;
        expect(() => simulateReference(compileProgram(seq), spins, {
            progressInterval: 8,
            isCancelled: () => ++polls > 3,
        })).toThrow(SimulationCancelledError);
    });
});
