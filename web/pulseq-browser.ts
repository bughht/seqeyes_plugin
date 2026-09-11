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
export { createSequenceDecodeContext, decodeAllBlocks, decodeBlockRange, getTotalDuration } from '../src/pulseq/decoder';
export {
    BAND_DETAIL_SAMPLES,
    countExactDetailSamples,
    EXACT_DETAIL_SAMPLES,
    MAX_DETAIL_PTS,
    MAX_DISPLAY_PTS,
    packSequenceBlockRange,
    packSequenceBlocks,
    resolveDetailBlockRange,
} from '../src/editor/blockTransport';
export {
    computeGradientEnvelope,
    countGradientSamples,
    MAX_ENVELOPE_COLUMNS,
    packGradientEnvelope,
} from '../src/pulseq/gradientEnvelope';
export {
    buildWaveformDetailReply,
    WINDOW_DETAIL_BLOCK_LIMIT,
} from '../src/editor/waveformDetailReply';
export type { WaveformDetailReply } from '../src/editor/waveformDetailReply';
export { calculateKspace } from '../src/pulseq/kspace';
export { calculateM1, calculateM1Coarse } from '../src/pulseq/m1';
export { calculatePns, calculatePnsCoarse, parsePnsHardwareAsc, safePnsModel } from '../src/pulseq/pns';
export { parseAscText } from '../src/pulseq/ascText';
export {
    countBandsOutsideRange,
    describeAscProfile,
    isEmptyAscProfile,
    parseAcousticResonancesAsc,
    parseAscProfile,
} from '../src/pulseq/acousticAsc';
export {
    computeGradientSpectrogram,
    computeGradientSpectrumAverage,
    computeGradientSpectrumSlice,
    computeGradSpectrumParity,
    resolveSpectrogramParams,
    spectrogramColumnAt,
    spectrogramRowFrequency,
} from '../src/pulseq/gradSpectrum';
export { synthesizeGradientSound } from '../src/pulseq/gradientSound';
export {
    differentiateUniform,
    physicalGradientValueAt,
    resamplePhysicalGradients,
    rotateGradient,
} from '../src/pulseq/physicalGradients';
export { selectM1WindowBlocks, selectPnsWindowBlocks } from '../src/pulseq/derivedWindow';
export {
    derivedDetailViewLimitSec,
    estimateDerivedCost,
    estimateKspaceCost,
    estimateKspacePeakMemoryBytes,
    estimateSequenceKspaceCost,
    formatMemorySize,
    formatSampleCount,
    INTERACTIVE_COMPUTE_LIMITS,
    kspaceExceedsInteractiveBudget,
    audioBudgetRefusal,
    estimateAudioCost,
    estimateSpectrogramCost,
    spectrogramBudgetRefusal,
} from '../src/pulseq/computeBudget';
export { detectSequenceTiming } from '../src/pulseq/trdetect';
export {
    analyzeRfResponse,
    estimateRfCarrierAreaDeg,
    MAX_RF_RESPONSE_BANDS,
    MAX_RF_RESPONSE_FFT_POINTS,
    MAX_RF_RESPONSE_SAMPLES,
} from '../src/pulseq/rfResponse';
export {
    exportKspaceArtifacts,
    exportKspaceArtifactsFromBytes,
    exportKspaceArtifactsFromSequence,
    formatTrajectoryText,
} from '../src/pulseq/kspaceExportArtifacts';
export type { KSpaceData } from '../src/pulseq/kspace';
export type { CoarseM1Data, M1Data } from '../src/pulseq/m1';
export type { CoarsePnsResult, PnsHardware, PnsResult } from '../src/pulseq/pns';
export type { AcousticResonance, AscProfile } from '../src/pulseq/acousticAsc';
export type { GradientSpectrogram, SpectrogramParams } from '../src/pulseq/gradSpectrum';
export type { GradientSound } from '../src/pulseq/gradientSound';
export type { DecodedBlock, DecodedGradWaveform } from '../src/pulseq/types';
