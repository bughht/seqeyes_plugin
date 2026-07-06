import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { decodeAllBlocks, getTotalDuration } from './decoder';
import { calculateKspace, type KSpaceData } from './kspace';
import { parseSequenceText } from './reader';
import type { PulseqSequence } from './types';

export interface KspaceExportOptions {
    includeFullTrajectory?: boolean;
    maxGridPoints?: number;
    packageVersion?: string;
}

export interface KspaceExportMetadata {
    schemaVersion: 1;
    sequenceName: string;
    sequenceSha256: string;
    packageVersion: string;
    pulseqVersion: {
        major: number;
        minor: number;
        revision: number;
        combined: number;
    };
    blockCount: number;
    rasterTimes: {
        blockDuration: number;
        gradient: number;
        rf: number;
        adc: number;
    };
    totalDurationSec: number;
    adcSampleCount: number;
    trajectorySampleCount: number;
    units: {
        trajectory: '1/m';
        time: 's';
        gradient: 'Hz/m';
        convention: 'Pulseq gradient integral without 2*pi factor';
    };
    files: {
        ktrajAdc: 'ktraj_adc.txt';
        ktraj?: 'ktraj.txt';
    };
}

export interface KspaceExportArtifacts {
    ktrajAdcText: string;
    ktrajText?: string;
    metadata: KspaceExportMetadata;
}

export interface KspaceExportFiles {
    outputDir: string;
    ktrajAdcPath: string;
    ktrajPath?: string;
    metadataPath: string;
    metadata: KspaceExportMetadata;
}

export function exportKspaceArtifacts(
    sequenceText: string,
    sequenceName: string,
    options: KspaceExportOptions = {},
): KspaceExportArtifacts {
    const seq = parseSequenceText(sequenceText);
    const decoded = decodeAllBlocks(seq);
    const totalDuration = getTotalDuration(seq);
    const kspace = calculateKspace(
        decoded,
        seq.rasterTimes.gradientRaster,
        totalDuration,
        0,
        options.maxGridPoints ? { maxGridPoints: options.maxGridPoints } : undefined,
    );

    if (!kspace) {
        throw new Error('Unable to calculate k-space trajectory for sequence');
    }

    const metadata = createMetadata(
        seq,
        kspace,
        sequenceName,
        sha256Hex(sequenceText),
        options.packageVersion ?? 'unknown',
        !!options.includeFullTrajectory,
        totalDuration,
    );

    return {
        ktrajAdcText: formatTrajectoryText(kspace.ktraj_adc),
        ktrajText: options.includeFullTrajectory ? formatTrajectoryText(kspace.ktraj) : undefined,
        metadata,
    };
}

export function exportKspaceFiles(
    inputPath: string,
    outputDir: string,
    options: KspaceExportOptions = {},
): KspaceExportFiles {
    const sequenceText = readFileSync(inputPath, 'utf8');
    const artifacts = exportKspaceArtifacts(sequenceText, basename(inputPath), options);
    mkdirSync(outputDir, { recursive: true });

    const ktrajAdcPath = join(outputDir, 'ktraj_adc.txt');
    const metadataPath = join(outputDir, 'metadata.json');
    writeFileSync(ktrajAdcPath, artifacts.ktrajAdcText);
    writeFileSync(metadataPath, `${JSON.stringify(artifacts.metadata, null, 2)}\n`);

    let ktrajPath: string | undefined;
    if (artifacts.ktrajText !== undefined) {
        ktrajPath = join(outputDir, 'ktraj.txt');
        writeFileSync(ktrajPath, artifacts.ktrajText);
    }

    return {
        outputDir,
        ktrajAdcPath,
        ktrajPath,
        metadataPath,
        metadata: artifacts.metadata,
    };
}

export function formatTrajectoryText(series: Float64Array[]): string {
    assertThreeEqualLengthSeries(series);
    const n = series[0].length;
    if (n === 0) return '';

    const rows: string[] = [];
    for (let i = 0; i < n; i++) {
        rows.push(`${formatFloat(series[0][i])} ${formatFloat(series[1][i])} ${formatFloat(series[2][i])}`);
    }
    return `${rows.join('\n')}\n`;
}

export function formatFloat(value: number): string {
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
    const normalized = Object.is(value, -0) ? 0 : value;
    return normalized.toExponential(12).replace(/e([+-])(\d+)$/, (_match, sign: string, exponent: string) => (
        `e${sign}${exponent.padStart(2, '0')}`
    ));
}

function createMetadata(
    seq: PulseqSequence,
    kspace: KSpaceData,
    sequenceName: string,
    sequenceSha256: string,
    packageVersion: string,
    includeFullTrajectory: boolean,
    totalDurationSec: number,
): KspaceExportMetadata {
    return {
        schemaVersion: 1,
        sequenceName,
        sequenceSha256,
        packageVersion,
        pulseqVersion: {
            major: seq.version.major,
            minor: seq.version.minor,
            revision: seq.version.revision,
            combined: seq.versionCombined,
        },
        blockCount: seq.blocks.length,
        rasterTimes: {
            blockDuration: seq.rasterTimes.blockDurationRaster,
            gradient: seq.rasterTimes.gradientRaster,
            rf: seq.rasterTimes.rfRaster,
            adc: seq.rasterTimes.adcRaster,
        },
        totalDurationSec,
        adcSampleCount: kspace.t_adc.length,
        trajectorySampleCount: kspace.t_ktraj.length,
        units: {
            trajectory: '1/m',
            time: 's',
            gradient: 'Hz/m',
            convention: 'Pulseq gradient integral without 2*pi factor',
        },
        files: includeFullTrajectory
            ? { ktrajAdc: 'ktraj_adc.txt', ktraj: 'ktraj.txt' }
            : { ktrajAdc: 'ktraj_adc.txt' },
    };
}

function assertThreeEqualLengthSeries(series: Float64Array[]): void {
    if (series.length !== 3) {
        throw new Error(`Expected three trajectory axes, received ${series.length}`);
    }
    const n = series[0].length;
    if (series[1].length !== n || series[2].length !== n) {
        throw new Error('Trajectory axes have mismatched sample counts');
    }
}

function sha256Hex(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}
