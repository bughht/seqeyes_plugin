import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
    exportKspaceArtifacts as buildKspaceExportArtifacts,
    type KspaceExportArtifacts,
    type KspaceExportMetadata,
    type KspaceExportOptions,
} from './kspaceExportArtifacts';

export {
    formatFloat,
    formatTrajectoryText,
    type KspaceExportArtifacts,
    type KspaceExportMetadata,
    type KspaceExportOptions,
} from './kspaceExportArtifacts';

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
    return buildKspaceExportArtifacts(sequenceText, sequenceName, {
        ...options,
        sequenceSha256: options.sequenceSha256 ?? sha256Hex(sequenceText),
    });
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

function sha256Hex(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}
