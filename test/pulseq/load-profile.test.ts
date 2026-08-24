import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { profileSequenceLoad } from '../../src/cli/profileLoad';

const fixture = join(__dirname, 'binary', 'gre.bseq');

describe('stage-bounded load profiler', () => {
    it('stops after parsing when requested', () => {
        const report = profileSequenceLoad(fixture, 'parse');

        expect(report.status).toBe('ok');
        expect(report.completedStage).toBe('parse');
        expect(report.source.format).toBe('bseq');
        expect(report.source.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(report.parsed?.blocks).toBeGreaterThan(0);
        expect(report.decoded).toBeUndefined();
        expect(report.display).toBeUndefined();
        expect(report.phases.parseSequenceBytes.durationMs).toBeGreaterThanOrEqual(0);
        expect(report.phases.parseSequenceBytes.memory.peakRssBytes).toBeGreaterThan(0);
    });

    it('records decode, estimates, and bounded display packing', () => {
        const report = profileSequenceLoad(fixture, 'display');

        expect(report.status).toBe('ok');
        expect(report.completedStage).toBe('display');
        expect(report.decoded?.blocks).toBe(report.parsed?.blocks);
        expect(report.kspaceEstimate?.rasterSamples).toBeGreaterThan(0);
        expect(report.kspaceEstimate?.peakMemoryBytes).toBeGreaterThan(0);
        expect(report.display?.sampleCount).toBeGreaterThan(0);
        expect(report.display?.timeBufferBytes).toBe(report.display!.sampleCount * 8);
        expect(report.display?.valueBufferBytes).toBe(report.display!.sampleCount * 4);
        expect(report.display?.envelopeEstimatedJsonBytes).toBeGreaterThan(0);
    });

    it('profiles bounded display preparation without retaining an eager decode', () => {
        const report = profileSequenceLoad(fixture, 'bounded-display');

        expect(report.status).toBe('ok');
        expect(report.completedStage).toBe('bounded-display');
        expect(report.decoded).toBeUndefined();
        expect(report.phases.decodeAllBlocks).toBeUndefined();
        expect(report.phases.packSequenceBlocks.durationMs).toBeGreaterThanOrEqual(0);
        expect(report.display?.sampleCount).toBeGreaterThan(0);
    });
});
