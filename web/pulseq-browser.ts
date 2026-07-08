/**
 * Browser entry point — re‑exports the pulseq parser / decoder / k‑space
 * so esbuild can bundle them into a single self‑contained script.
 *
 * Built via:  npm run build:web
 */
import { version } from '../package.json';

export const PACKAGE_VERSION: string = version;
export { parseSequenceText } from '../src/pulseq/reader';
export { decodeAllBlocks, getTotalDuration } from '../src/pulseq/decoder';
export { calculateKspace } from '../src/pulseq/kspace';
export { detectSequenceTiming } from '../src/pulseq/trdetect';
export { exportKspaceArtifacts, formatTrajectoryText } from '../src/pulseq/kspaceExportArtifacts';
export type { KSpaceData } from '../src/pulseq/kspace';
export type { DecodedBlock, DecodedGradWaveform } from '../src/pulseq/types';
