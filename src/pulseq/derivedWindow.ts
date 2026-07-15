import type { DecodedBlock } from './types';
import type { PnsHardware } from './pns';

export interface DerivedBlockWindow {
    blocks: DecodedBlock[];
    calculationStartSec: number;
    displayStartSec: number;
    displayEndSec: number;
}

export function selectM1WindowBlocks(
    blocks: DecodedBlock[],
    startSec: number,
    endSec: number,
): DerivedBlockWindow {
    const displayStartSec = finiteMin(startSec, endSec);
    const displayEndSec = finiteMax(startSec, endSec, displayStartSec);
    let calculationStartSec = displayStartSec;
    for (const block of blocks) {
        const center = block.rf?.centerTime;
        if (center === undefined || center > displayStartSec) continue;
        const use = (block.rf?.use || '').toLowerCase();
        if (use === 'e') calculationStartSec = Math.min(center, block.startTime);
    }
    return {
        blocks: overlappingBlocks(blocks, calculationStartSec, displayEndSec),
        calculationStartSec,
        displayStartSec,
        displayEndSec,
    };
}

export function selectPnsWindowBlocks(
    blocks: DecodedBlock[],
    startSec: number,
    endSec: number,
    hardware: PnsHardware,
): DerivedBlockWindow {
    const displayStartSec = finiteMin(startSec, endSec);
    const displayEndSec = finiteMax(startSec, endSec, displayStartSec);
    const longestTauMs = Math.max(
        hardware.x.tau1Ms, hardware.x.tau2Ms, hardware.x.tau3Ms,
        hardware.y.tau1Ms, hardware.y.tau2Ms, hardware.y.tau3Ms,
        hardware.z.tau1Ms, hardware.z.tau2Ms, hardware.z.tau3Ms,
    );
    const calculationStartSec = Math.max(0, displayStartSec - longestTauMs * 4 / 1000);
    return {
        blocks: overlappingBlocks(blocks, calculationStartSec, displayEndSec),
        calculationStartSec,
        displayStartSec,
        displayEndSec,
    };
}

function overlappingBlocks(blocks: DecodedBlock[], startSec: number, endSec: number): DecodedBlock[] {
    return blocks.filter(block => (
        block.startTime + block.duration >= startSec
        && block.startTime <= endSec
    ));
}

function finiteMin(a: number, b: number): number {
    const aa = Number.isFinite(a) ? a : 0;
    const bb = Number.isFinite(b) ? b : aa;
    return Math.max(0, Math.min(aa, bb));
}

function finiteMax(a: number, b: number, fallback: number): number {
    const aa = Number.isFinite(a) ? a : fallback;
    const bb = Number.isFinite(b) ? b : aa;
    return Math.max(fallback, Math.max(aa, bb));
}
