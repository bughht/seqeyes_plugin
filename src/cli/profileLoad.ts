import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
    estimateEnvelopeJsonBytes,
    packBlocks,
    packSequenceBlocks,
} from '../editor/blockTransport';
import {
    estimateKspaceCost,
    estimateKspacePeakMemoryBytes,
    estimateSequenceKspaceCost,
} from '../pulseq/computeBudget';
import { decodeAllBlocks, getTotalDuration } from '../pulseq/decoder';
import { hasPulseqBinaryMagic, parseSequenceBytes } from '../pulseq/sequenceReader';
import { detectSequenceTiming } from '../pulseq/trdetect';
import type { DecodedBlock, PulseqSequence } from '../pulseq/types';

export type LoadProfileStage = 'parse' | 'decode' | 'display' | 'bounded-display';

interface MemorySnapshot {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
    peakRssBytes: number;
}

interface PhaseMeasurement {
    durationMs: number;
    memory: MemorySnapshot;
}

export interface LoadProfileResult {
    schemaVersion: 1;
    status: 'ok' | 'error';
    requestedStage: LoadProfileStage;
    completedStage: 'none' | LoadProfileStage;
    source: {
        fileName: string;
        path: string;
        bytes: number;
        sha256?: string;
        format?: 'seq' | 'bseq';
    };
    environment: {
        node: string;
        platform: NodeJS.Platform;
        arch: string;
        pid: number;
        gcAvailable: boolean;
    };
    phases: Record<string, PhaseMeasurement>;
    parsed?: ReturnType<typeof parsedCounts>;
    timing?: {
        totalDurationSec: number;
        trTimeSec: number;
        trCount: number;
        hasExplicitTR: boolean;
    };
    decoded?: ReturnType<typeof decodedCounts>;
    display?: {
        sampleCount: number;
        pointsPerWaveform: number;
        timeBufferBytes: number;
        valueBufferBytes: number;
        envelopeEstimatedJsonBytes: number;
        notice: string | null;
    };
    kspaceEstimate?: {
        rasterSamples: number;
        adcSamples: number;
        gridCandidatePoints: number;
        peakMemoryBytes: number;
    };
    afterForcedGc?: MemorySnapshot;
    error?: {
        name: string;
        message: string;
        stack?: string;
    };
}

/**
 * Profile one load stage without silently continuing into a more expensive
 * stage. The supervisor runs each requested stage in a fresh process, so a
 * timeout or process kill identifies a boundary instead of corrupting the
 * measurements for the next case.
 */
export function profileSequenceLoad(inputPath: string, requestedStage: LoadProfileStage): LoadProfileResult {
    const resolvedPath = resolve(inputPath);
    const result: LoadProfileResult = {
        schemaVersion: 1,
        status: 'ok',
        requestedStage,
        completedStage: 'none',
        source: {
            fileName: basename(resolvedPath),
            path: resolvedPath,
            bytes: 0,
        },
        environment: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            pid: process.pid,
            gcAvailable: typeof global.gc === 'function',
        },
        phases: {},
    };

    try {
        validateInput(resolvedPath);
        result.source.bytes = statSync(resolvedPath).size;

        const bytes = measure(result, 'acquireFile', () => readFileSync(resolvedPath));
        result.source.sha256 = measure(result, 'sha256', () => (
            createHash('sha256').update(bytes).digest('hex')
        ));
        result.source.format = hasPulseqBinaryMagic(bytes) ? 'bseq' : 'seq';

        const sequence = measure(result, 'parseSequenceBytes', () => (
            parseSequenceBytes(bytes, resolvedPath)
        ));
        result.parsed = parsedCounts(sequence);

        const timing = measure(result, 'detectSequenceTiming', () => detectSequenceTiming(sequence));
        const totalDurationSec = measure(result, 'getTotalDuration', () => getTotalDuration(sequence));
        result.timing = {
            totalDurationSec,
            trTimeSec: timing.trTimeSec,
            trCount: timing.trCount,
            hasExplicitTR: timing.hasExplicitTR,
        };
        result.completedStage = 'parse';
        if (requestedStage === 'parse') return finish(result);

        if (requestedStage === 'bounded-display') {
            const kspace = measure(result, 'estimateSequenceKspaceCost', () => (
                estimateSequenceKspaceCost(sequence, totalDurationSec)
            ));
            result.kspaceEstimate = {
                ...kspace,
                peakMemoryBytes: measure(result, 'estimateKspacePeakMemoryBytes', () => (
                    estimateKspacePeakMemoryBytes(kspace)
                )),
            };
            const packed = measure(result, 'packSequenceBlocks', () => packSequenceBlocks(sequence));
            result.display = displayCounts(result, packed);
            result.completedStage = 'bounded-display';
            return finish(result);
        }

        const decoded = measure(result, 'decodeAllBlocks', () => decodeAllBlocks(sequence));
        result.decoded = decodedCounts(decoded);
        const kspace = measure(result, 'estimateKspaceCost', () => (
            estimateKspaceCost(decoded, sequence.rasterTimes.gradientRaster, totalDurationSec)
        ));
        result.kspaceEstimate = {
            ...kspace,
            peakMemoryBytes: measure(result, 'estimateKspacePeakMemoryBytes', () => (
                estimateKspacePeakMemoryBytes(kspace)
            )),
        };
        result.completedStage = 'decode';
        if (requestedStage === 'decode') return finish(result);

        const packed = measure(result, 'packBlocks', () => packBlocks(decoded));
        result.display = displayCounts(result, packed);
        result.completedStage = 'display';
        return finish(result);
    } catch (error) {
        result.status = 'error';
        result.error = serializeError(error);
        return finish(result);
    }
}

function displayCounts(result: LoadProfileResult, packed: ReturnType<typeof packBlocks>) {
    return {
        sampleCount: packed.sampleCount,
        pointsPerWaveform: packed.pointsPerWaveform,
        timeBufferBytes: packed.sampleTimes.byteLength,
        valueBufferBytes: packed.sampleValues.byteLength,
        envelopeEstimatedJsonBytes: measure(result, 'estimateEnvelopeJsonBytes', () => (
            estimateEnvelopeJsonBytes(packed.blocks)
        )),
        notice: packed.notice,
    };
}

function measure<T>(result: LoadProfileResult, name: string, operation: () => T): T {
    const started = performance.now();
    try {
        return operation();
    } finally {
        result.phases[name] = {
            durationMs: performance.now() - started,
            memory: memorySnapshot(),
        };
    }
}

function finish(result: LoadProfileResult): LoadProfileResult {
    if (typeof global.gc === 'function') {
        global.gc();
        result.afterForcedGc = memorySnapshot();
    }
    return result;
}

function memorySnapshot(): MemorySnapshot {
    const memory = process.memoryUsage();
    return {
        rssBytes: memory.rss,
        heapTotalBytes: memory.heapTotal,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
        // Node reports maxRSS in KiB on supported Unix platforms.
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
    };
}

function parsedCounts(sequence: PulseqSequence) {
    let expandedShapeSamples = 0;
    for (const shape of sequence.shapes.values()) expandedShapeSamples += shape.samples.length;

    let adcBlockSamples = 0;
    for (const block of sequence.blocks) {
        if (block.adcId > 0) adcBlockSamples += sequence.adcs.get(block.adcId)?.numSamples ?? 0;
    }

    return {
        version: `${sequence.version.major}.${sequence.version.minor}.${sequence.version.revision}`,
        blocks: sequence.blocks.length,
        rfEvents: sequence.rfs.size,
        arbitraryGradientEvents: sequence.arbitraryGrads.size,
        trapezoidEvents: sequence.trapGrads.size,
        adcEvents: sequence.adcs.size,
        adcBlockSamples,
        shapes: sequence.shapes.size,
        expandedShapeSamples,
        extensions: sequence.extensions.size,
        rotations: sequence.rotations.length,
        rfShims: sequence.rfShims.length,
    };
}

function decodedCounts(blocks: DecodedBlock[]) {
    let rfSamples = 0;
    let gxSamples = 0;
    let gySamples = 0;
    let gzSamples = 0;
    let adcSamples = 0;
    for (const block of blocks) {
        rfSamples += block.rf?.timePoints.length ?? 0;
        gxSamples += block.gx?.timePoints.length ?? 0;
        gySamples += block.gy?.timePoints.length ?? 0;
        gzSamples += block.gz?.timePoints.length ?? 0;
        adcSamples += block.adc?.numSamples ?? 0;
    }
    return {
        blocks: blocks.length,
        rfSamples,
        gxSamples,
        gySamples,
        gzSamples,
        adcSamples,
        totalWaveformSamples: rfSamples + gxSamples + gySamples + gzSamples,
    };
}

function validateInput(inputPath: string): void {
    if (!existsSync(inputPath) || !statSync(inputPath).isFile()) {
        throw new Error(`Input file does not exist: ${inputPath}`);
    }
    if (!/\.(?:seq|bseq)$/i.test(inputPath)) {
        throw new Error(`Input must use the .seq or .bseq extension: ${inputPath}`);
    }
}

function serializeError(error: unknown): LoadProfileResult['error'] {
    if (error instanceof Error) {
        return { name: error.name, message: error.message, stack: error.stack };
    }
    return { name: 'Error', message: String(error) };
}

function parseArgs(argv: string[]): { inputPath: string; stage: LoadProfileStage } {
    let inputPath = '';
    let stage: LoadProfileStage = 'parse';
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--input') inputPath = requireValue(argv, ++index, argument);
        else if (argument === '--stage') stage = parseStage(requireValue(argv, ++index, argument));
        else if (argument === '--help' || argument === '-h') {
            process.stdout.write(`${usage()}\n`);
            process.exit(0);
        } else if (!argument.startsWith('--') && !inputPath) inputPath = argument;
        else throw new Error(`Unknown argument: ${argument}`);
    }
    if (!inputPath) throw new Error('Missing input file');
    return { inputPath, stage };
}

function parseStage(value: string): LoadProfileStage {
    if (value === 'parse' || value === 'decode' || value === 'display' || value === 'bounded-display') return value;
    throw new Error(`Unknown stage '${value}'; expected parse, decode, display, or bounded-display`);
}

function requireValue(argv: string[], index: number, option: string): string {
    const value = argv[index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
    return value;
}

function usage(): string {
    return [
        'Usage: node out/cli/profileLoad.js --input <file.seq|file.bseq> [--stage parse|decode|display|bounded-display]',
        '',
        'The result is written as one JSON object to stdout. Run this executable through',
        'scripts/run-load-profile.mjs to enforce a timeout and memory ceiling.',
    ].join('\n');
}

function main(argv: string[]): number {
    let result: LoadProfileResult;
    try {
        const args = parseArgs(argv);
        result = profileSequenceLoad(args.inputPath, args.stage);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
        return 2;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'ok' ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
