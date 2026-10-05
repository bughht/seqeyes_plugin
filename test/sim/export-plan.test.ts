import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildExport } from '../../src/sim/io/export';
import { ACQ_FLAG_BITS, planExport } from '../../src/sim/io/exportPlan';
import { SimulationJob } from '../../src/sim/job';
import { sheppLoganVolume } from '../../src/sim/phantom/builtin';
import { sliceVolume } from '../../src/sim/phantom/model';
import { spinWarp3d } from './helpers/sequences';

function job(file: string): SimulationJob {
    const path = join(__dirname, '..', 'seqeyes_demo_seq_files', file);
    return new SimulationJob(new Uint8Array(readFileSync(path)), path, { phantom: { kind: 'shepp-logan', size: 8 }, subSpins: [1, 1] });
}

function gridOf(j: SimulationJob) {
    const recon = j.reconstruct(new Float64Array(j.plan.adcSamples * 2));
    return {
        delta: recon.delta, axes: recon.axes, nu: recon.nu, nv: recon.nv, offset: recon.offset,
        wAxis: recon.wAxis, nw: recon.nw, deltaW: recon.deltaW, offsetW: recon.offsetW,
    };
}

describe('ISMRMRD export planning', () => {
    it('numbers the partitions of an unlabelled 3-D acquisition from the grid', () => {
        const n = 8, nz = 4;
        const phantom = sliceVolume(sheppLoganVolume(n, nz, [0.032, 0.032, 0.016]), { neighbours: [-nz / 2, nz / 2 - 1] });
        const j = new SimulationJob(new TextEncoder().encode(spinWarp3d(n, nz, 0.032, 0.016)), 'warp3d.seq', {
            phantom: { kind: 'phantom', phantom }, subSpins: [1, 1], throughSlice: 'off',
        });
        const plan = planExport(j.rawLayout(), gridOf(j));
        // Partition-major order: 8 lines in each of 4 partitions.
        expect(plan.acquisitions.map(p => p.idx.kspace_encode_step_2)).toEqual(Array.from({ length: n * nz }, (_, a) => Math.floor(a / n)));
        expect(plan.acquisitions.map(p => p.idx.kspace_encode_step_1)).toEqual(Array.from({ length: n * nz }, (_, a) => a % n));
        expect(plan.limits.kspace_encode_step_2).toEqual({ minimum: 0, maximum: nz - 1, center: nz / 2 });
        const xml = new TextDecoder().decode(buildExport(j, new Float64Array(2 * j.plan.adcSamples), 'ismrmrd-stream').bytes);
        expect(xml.replace(/\s+/g, '')).toContain('<encodedSpace><matrixSize><x>8</x><y>8</y><z>4</z></matrixSize>');
    });

    it('takes the phase-encode line from the LIN label', () => {
        const j = job('writeGradientEcho_label.seq');
        const layout = j.rawLayout();
        const plan = planExport(layout, gridOf(j));
        expect(plan.labelled).toContain('kspace_encode_step_1');
        const lin = layout.labels.names.indexOf('LIN');
        const width = layout.labels.names.length;
        for (let a = 0; a < layout.acquisitions; a++) {
            expect(plan.acquisitions[a].idx.kspace_encode_step_1 + plan.counterOffsets.kspace_encode_step_1)
                .toBe(layout.labels.values[a * width + lin]);
        }
        let min = Infinity, max = -Infinity;
        for (let a = 0; a < layout.acquisitions; a++) {
            min = Math.min(min, layout.labels.values[a * width + lin]);
            max = Math.max(max, layout.labels.values[a * width + lin]);
        }
        expect(plan.limits.kspace_encode_step_1).toMatchObject({ minimum: 0, maximum: max - min });
        // This demo also sets SLC (and REV on every other line).
        expect(plan.labelled).toContain('slice');
        expect(plan.acquisitions[plan.acquisitions.length - 1].flags).toContain(ACQ_FLAG_BITS.LAST_IN_MEASUREMENT);
    });

    it('derives lines from the grid for an unlabelled Cartesian GRE', () => {
        const j = job('writeGradientEcho.seq');
        const plan = planExport(j.rawLayout(), gridOf(j));
        expect(plan.labelled).toEqual([]);
        const lines = plan.acquisitions.map(p => p.idx.kspace_encode_step_1);
        // Linear phase-encode order: 0, 1, …, 127, centre at 64.
        expect(lines).toEqual(Array.from({ length: 128 }, (_, i) => i));
        expect(plan.limits.kspace_encode_step_1.center).toBe(64);
        // Half-integer kx: the centre sample is one of the two straddling k = 0.
        expect([63, 64]).toContain(plan.acquisitions[0].centerSample);
        expect(plan.acquisitions[0].flags).toContain(ACQ_FLAG_BITS.FIRST_IN_ENCODE_STEP1);
        expect(plan.acquisitions[127].flags).toContain(ACQ_FLAG_BITS.LAST_IN_ENCODE_STEP1);
        expect(plan.acquisitions.some(p => p.flags.includes(ACQ_FLAG_BITS.IS_REVERSE))).toBe(false);
    });

    it('flags every other EPI line as reversed', () => {
        const j = job('writeEpi.seq');
        const plan = planExport(j.rawLayout(), gridOf(j));
        const reversed = plan.acquisitions.map(p => p.flags.includes(ACQ_FLAG_BITS.IS_REVERSE));
        expect(reversed.filter(Boolean).length).toBeGreaterThan(reversed.length / 3);
        expect(reversed.filter(Boolean).length).toBeLessThan(2 * reversed.length / 3);
        for (let a = 1; a < 10; a++) expect(reversed[a]).toBe(!reversed[a - 1]);
    });
});
