/** Whole test sequences built with seqBuilder, shared by unit and browser tests. */

import { seqText, type AdcRow, type BlockRow, type RfRow, type TrapRow } from './seqBuilder';

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

/**
 * An RF-spoiled 3-D gradient echo: n × n × nz, a non-selective 0.2 ms hard
 * pulse of `flipDeg`, phase encodes along y and z with their rewinders,
 * a readout along x, a spoiler along x and z, and RF spoiling (117°
 * quadratic phase, the ADC following it). TR is 10 ms.
 */
export function spoiledGre3d(n: number, nz: number, fov: number, fovZ: number, flipDeg = 15): string {
    const dk = 1 / fov, dkz = 1 / fovZ;
    const dwellUs = 20;
    const g = dk / (dwellUs * 1e-6);
    const riseUs = 100, flatUs = n * dwellUs;
    const readoutUs = 2 * riseUs + flatUs;
    const prephaseArea = -g * (riseUs / 2 + dwellUs * (n + 1) / 2) * 1e-6;
    const preRiseUs = 100, preFlatUs = 300, preArea = (preFlatUs + preRiseUs) * 1e-6;
    // The x moment left after the readout, then a spoiler of four cycles per voxel along x and z.
    const spoilArea = 4 * n * dk;
    const traps: TrapRow[] = [
        { amplitude: g, riseUs, flatUs, fallUs: riseUs },                                              // 1 readout
        { amplitude: prephaseArea / preArea, riseUs: preRiseUs, flatUs: preFlatUs, fallUs: preRiseUs },  // 2 prephaser
        { amplitude: spoilArea / preArea, riseUs: preRiseUs, flatUs: preFlatUs, fallUs: preRiseUs },     // 3 spoiler x
        { amplitude: 4 * nz * dkz / preArea, riseUs: preRiseUs, flatUs: preFlatUs, fallUs: preRiseUs },  // 4 spoiler z
    ];
    const lineTrap = (line: number, rewind: boolean) => {
        traps.push({ amplitude: (rewind ? -1 : 1) * (line - n / 2) * dk / preArea, riseUs: preRiseUs, flatUs: preFlatUs, fallUs: preRiseUs });
        return traps.length;
    };
    const partTrap = (part: number, rewind: boolean) => {
        traps.push({ amplitude: (rewind ? -1 : 1) * (part - nz / 2) * dkz / preArea, riseUs: preRiseUs, flatUs: preFlatUs, fallUs: preRiseUs });
        return traps.length;
    };
    const encode: number[] = [], rewindY: number[] = [], encodeZ: number[] = [], rewindZ: number[] = [];
    for (let line = 0; line < n; line++) { encode.push(lineTrap(line, false)); rewindY.push(lineTrap(line, true)); }
    for (let part = 0; part < nz; part++) { encodeZ.push(partTrap(part, false)); rewindZ.push(partTrap(part, true)); }
    const amplitude = (flipDeg / 360) / 200e-6;
    const rf: RfRow[] = [], adc: AdcRow[] = [];
    const blocks: BlockRow[] = [];
    let j = 0, phase = 0, increment = 0;
    const encodeTicks = (2 * preRiseUs + preFlatUs) / 10;
    const ticks = 1000 - 22 - encodeTicks - readoutUs / 10 - encodeTicks;      // to TR = 10 ms
    for (let part = 0; part < nz; part++) {
        for (let line = 0; line < n; line++, j++) {
            rf.push({ amplitude, magShape: 1, centerUs: 100, delayUs: 10, phase });
            adc.push({ samples: n, dwellNs: dwellUs * 1000, delayUs: riseUs, phase });
            blocks.push({ ticks: 22, rf: rf.length });
            blocks.push({ ticks: encodeTicks, gx: 2, gy: encode[line], gz: encodeZ[part] });
            blocks.push({ ticks: readoutUs / 10, gx: 1, adc: adc.length });
            blocks.push({ ticks: encodeTicks, gx: 3, gy: rewindY[line], gz: rewindZ[part] });
            blocks.push({ ticks, gz: 4 });
            increment += 117 * Math.PI / 180;
            phase = (phase + increment) % (2 * Math.PI);
        }
    }
    return seqText({ blocks, rf, traps, adc, shapes: [Array(200).fill(1)], extraDefinitions: `FOV ${fov} ${fov} ${fovZ}` });
}
