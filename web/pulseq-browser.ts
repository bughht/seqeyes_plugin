/**
 * Browser entry point — re‑exports the pulseq parser / decoder / k‑space
 * so esbuild can bundle them into a single self‑contained script.
 *
 * Built via:  npm run build:web
 */
import { version } from '../package.json';

export const PACKAGE_VERSION: string = version;
export { parseSequenceText } from '../src/pulseq/reader';
export { hasPulseqBinaryMagic, parseSequenceBinary, parseSequenceBytes } from '../src/pulseq/sequenceReader';
export { decodeAllBlocks, getTotalDuration } from '../src/pulseq/decoder';
export { calculateKspace } from '../src/pulseq/kspace';
export { calculateM1 } from '../src/pulseq/m1';
export { calculatePns, parsePnsHardwareAsc, safePnsModel } from '../src/pulseq/pns';
export { detectSequenceTiming } from '../src/pulseq/trdetect';
export {
    exportKspaceArtifacts,
    exportKspaceArtifactsFromBytes,
    exportKspaceArtifactsFromSequence,
    formatTrajectoryText,
} from '../src/pulseq/kspaceExportArtifacts';
export type { KSpaceData } from '../src/pulseq/kspace';
export type { M1Data } from '../src/pulseq/m1';
export type { PnsHardware, PnsResult } from '../src/pulseq/pns';
export type { DecodedBlock, DecodedGradWaveform } from '../src/pulseq/types';
