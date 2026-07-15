import { decodeAllBlocks, getTotalDuration } from './decoder';
import { calculateKspace, type KSpaceData, type KSpaceOptions } from './kspace';
import { parseSequenceText } from './reader';
import { parseSequenceBytes } from './sequenceReader';
import type { PulseqSequence } from './types';

export interface KspaceExportOptions {
    includeFullTrajectory?: boolean;
    maxGridPoints?: number;
    packageVersion?: string;
    sequenceSha256?: string;
    /**
     * Defaults to `all` so exported artifacts are suitable for SeqEyes Qt
     * numeric parity checks. The interactive viewer keeps the faster endpoint
     * mode by calling calculateKspace directly without this option.
     */
    gradientSupport?: KSpaceOptions['gradientSupport'];
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
    calculation: {
        gradientSupport: 'endpoints' | 'all';
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

export function exportKspaceArtifacts(
    sequenceText: string,
    sequenceName: string,
    options: KspaceExportOptions = {},
): KspaceExportArtifacts {
    const seq = parseSequenceText(sequenceText);
    return exportKspaceArtifactsFromSequence(seq, sequenceName, options);
}

export function exportKspaceArtifactsFromBytes(
    sequenceBytes: Uint8Array,
    sequenceName: string,
    options: KspaceExportOptions = {},
): KspaceExportArtifacts {
    const seq = parseSequenceBytes(sequenceBytes, sequenceName);
    return exportKspaceArtifactsFromSequence(seq, sequenceName, options);
}

export function exportKspaceArtifactsFromSequence(
    seq: PulseqSequence,
    sequenceName: string,
    options: KspaceExportOptions = {},
): KspaceExportArtifacts {
    const decoded = decodeAllBlocks(seq);
    const totalDuration = getTotalDuration(seq);
    const gradientSupport = options.gradientSupport ?? 'all';
    const kspace = calculateKspace(
        decoded,
        seq.rasterTimes.gradientRaster,
        totalDuration,
        0,
        { maxGridPoints: options.maxGridPoints, rfRaster: seq.rasterTimes.rfRaster, gradientSupport },
    );

    if (!kspace) {
        throw new Error('Unable to calculate k-space trajectory for sequence');
    }

    const metadata = createMetadata(
        seq,
        kspace,
        sequenceName,
        options.sequenceSha256 ?? 'unknown',
        options.packageVersion ?? 'unknown',
        !!options.includeFullTrajectory,
        totalDuration,
        gradientSupport,
    );

    return {
        ktrajAdcText: formatTrajectoryText(kspace.ktraj_adc),
        ktrajText: options.includeFullTrajectory ? formatTrajectoryText(kspace.ktraj) : undefined,
        metadata,
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
    gradientSupport: 'endpoints' | 'all',
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
        calculation: {
            gradientSupport,
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
