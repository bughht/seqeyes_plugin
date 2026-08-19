import type { PulseqSequence, RFEntry } from './types';
import { VER_V15 } from './types';

/** ¹H gyromagnetic ratio in Hz/T. */
const GAMMA_HZ_T = 42.576e6;
const DEFAULT_B0_T = 3.0;
const sequenceUseCache = new WeakMap<PulseqSequence, string[]>();

/**
 * Classify an RF event consistently for timing detection and decoded waveform
 * calculations. Pulseq v1.5+ carries an explicit use tag; older files require
 * a flip-angle heuristic.
 */
export function classifyRfUse(rf: RFEntry, seq: PulseqSequence): string {
    if (seq.versionCombined >= VER_V15 && rf.use && rf.use.toLowerCase() !== 'u') {
        return rf.use.toLowerCase();
    }

    const flipAngleDeg = estimateRfFlipAngleDeg(rf, seq);
    if (isLegacyFatSaturation(rf, seq)) return 's';

    // Match the decoded-waveform policy: sub-120° pulses are excitations.
    // This includes common slice-profile-compensated 100–110° excitations.
    return flipAngleDeg >= 120 ? 'r' : 'e';
}

/**
 * Classify every block's RF role with sequence context. Some legacy
 * phase-modulated pulses do not have a meaningful magnitude-integral flip
 * angle. When such a sequence contains recurring fat-saturation anchors but
 * no angle-classified excitation, the first non-saturation RF after each
 * anchor is the excitation and later RF events belong to the refocusing train.
 */
export function classifyRfUses(seq: PulseqSequence): string[] {
    const cachedUses = sequenceUseCache.get(seq);
    if (cachedUses) return cachedUses;
    const libraryUses = new Map<number, string>();
    const uses = seq.blocks.map(block => {
        if (block.rfId <= 0) return '';
        const cached = libraryUses.get(block.rfId);
        if (cached !== undefined) return cached;
        const rf = seq.rfs.get(block.rfId);
        const use = rf ? classifyRfUse(rf, seq) : '';
        libraryUses.set(block.rfId, use);
        return use;
    });
    if (seq.versionCombined >= VER_V15 || uses.includes('e')) {
        sequenceUseCache.set(seq, uses);
        return uses;
    }

    const saturationBlocks = uses
        .map((use, index) => use === 's' ? index : -1)
        .filter(index => index >= 0);
    if (saturationBlocks.length < 2) {
        sequenceUseCache.set(seq, uses);
        return uses;
    }

    for (let anchor = 0; anchor < saturationBlocks.length; anchor++) {
        const start = saturationBlocks[anchor] + 1;
        const end = saturationBlocks[anchor + 1] ?? uses.length;
        for (let index = start; index < end; index++) {
            if (!uses[index] || uses[index] === 's') continue;
            uses[index] = 'e';
            break;
        }
    }
    sequenceUseCache.set(seq, uses);
    return uses;
}

export function estimateRfFlipAngleDeg(rf: RFEntry, seq: PulseqSequence): number {
    const magShape = seq.shapes.get(rf.magShapeId);
    if (magShape && magShape.numSamples > 0) {
        const raster = seq.rasterTimes.rfRaster;
        const timeShape = rf.timeShapeId > 0 ? seq.shapes.get(rf.timeShapeId)?.samples : undefined;
        let area = 0;
        let previousTime = timeShape ? timeShape[0] * raster : 0.5 * raster;
        let previousAmplitude = Math.abs(rf.amplitude * magShape.samples[0]);
        for (let index = 1; index < magShape.numSamples; index++) {
            const time = timeShape ? timeShape[index] * raster : (index + 0.5) * raster;
            const amplitude = Math.abs(rf.amplitude * magShape.samples[index]);
            const duration = time - previousTime;
            if (duration > 0) area += 0.5 * (previousAmplitude + amplitude) * duration;
            previousTime = time;
            previousAmplitude = amplitude;
        }
        return 360 * area;
    }

    const absoluteAmplitude = Math.abs(rf.amplitude);
    if (absoluteAmplitude > 3000) return 180;
    if (absoluteAmplitude > 1500) return 120;
    return 90;
}

function isLegacyFatSaturation(rf: RFEntry, seq: PulseqSequence): boolean {
    const b0Tesla = getB0(seq);
    const frequencyPpm = rf.freqPPM !== 0
        ? rf.freqPPM
        : (b0Tesla > 0 ? 1e6 * rf.freqOffset / (GAMMA_HZ_T * b0Tesla) : 0);
    const durationSec = estimateRfDuration(rf, seq);
    return durationSec > 6e-3 && frequencyPpm >= -4.5 && frequencyPpm <= -3.0;
}

function estimateRfDuration(rf: RFEntry, seq: PulseqSequence): number {
    const magShape = seq.shapes.get(rf.magShapeId);
    if (!magShape || magShape.numSamples <= 0) return 0;
    const raster = seq.rasterTimes.rfRaster;
    const timeShape = rf.timeShapeId > 0 ? seq.shapes.get(rf.timeShapeId)?.samples : undefined;
    if (timeShape && timeShape.length > 0) {
        return timeShape[timeShape.length - 1] * raster + raster;
    }
    return magShape.numSamples * raster;
}

function getB0(seq: PulseqSequence): number {
    const raw = seq.definitions.get('B0') ?? seq.definitions.get('b0') ?? seq.definitions.get('b_0');
    if (raw && raw.length > 0) return +raw[0];
    return DEFAULT_B0_T;
}
