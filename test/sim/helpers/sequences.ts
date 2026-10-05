/** Whole test sequences built with seqBuilder, shared by unit and browser tests. */

import { seqText, type BlockRow, type TrapRow } from './seqBuilder';

/**
 * spinWarp in 3-D: n × n × nz with a non-selective hard pulse, phase encodes
 * along y and z (partitions) in one block, and the same readout.
 */
export function spinWarp3d(n: number, nz: number, fov: number, fovZ: number): string {
    const dk = 1 / fov, dkz = 1 / fovZ;
    const dwellUs = 20;
    const g = dk / (dwellUs * 1e-6);
    const riseUs = 100, flatUs = n * dwellUs;
    const prephaseArea = -g * (riseUs / 2 + dwellUs * (n + 1) / 2) * 1e-6;
    const preRiseUs = 100, preFlatUs = 500, preArea = (preFlatUs + preRiseUs) * 1e-6;
    const traps: TrapRow[] = [
        { amplitude: g, riseUs, flatUs, fallUs: riseUs },
        { amplitude: prephaseArea / preArea, riseUs: preRiseUs, flatUs: preFlatUs, fallUs: preRiseUs },
    ];
    for (let line = 0; line < n; line++) traps.push({ amplitude: (line - n / 2) * dk / preArea, riseUs: preRiseUs, flatUs: preFlatUs, fallUs: preRiseUs });
    for (let part = 0; part < nz; part++) traps.push({ amplitude: (part - nz / 2) * dkz / preArea, riseUs: preRiseUs, flatUs: preFlatUs, fallUs: preRiseUs });
    const blocks: BlockRow[] = [];
    for (let part = 0; part < nz; part++) {
        for (let line = 0; line < n; line++) {
            blocks.push({ ticks: 20, rf: 1 });
            blocks.push({ ticks: 70, gx: 2, gy: 3 + line, gz: 3 + n + part });
            blocks.push({ ticks: (2 * riseUs + flatUs) / 10, gx: 1, adc: 1 });
            blocks.push({ ticks: 1_000_000 });
        }
    }
    return seqText({
        blocks,
        rf: [{ amplitude: 2500, magShape: 1, centerUs: 50 }],
        traps,
        adc: [{ samples: n, dwellNs: dwellUs * 1000, delayUs: riseUs }],
        shapes: [Array(100).fill(1)],
        extraDefinitions: `FOV ${fov} ${fov} ${fovZ}`,
    });
}
