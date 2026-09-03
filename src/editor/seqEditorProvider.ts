/**
 * Custom readonly editor provider for Pulseq .seq and .bseq files.
 *
 * Registered as `seqeyes.sequenceViewer` — opens automatically when the user
 * opens a supported Pulseq sequence. The provider:
 *   1. Reads the source bytes
 *   2. Parses it via the Pulseq reader
 *   3. Detects TE/TR timing (from definitions or RF‑pulse estimation)
 *   4. Decodes all waveforms via the decoder
 *   5. Packs the block data (see blockTransport.ts — scalars as JSON, waveform
 *      samples as binary buffers) and sends it with timing metadata
 *   6. The webview renders an interactive Canvas diagram with minimap
 *
 * K-space is deliberately calculated only when the analysis panel is opened,
 * so initial waveform readiness does not wait for a derived result.
 */

import * as vscode from 'vscode';
import { parseSequenceBytes } from '../pulseq/sequenceReader';
import {
    createSequenceDecodeContext,
    decodeAllBlocks,
    decodeBlockRange,
    getTotalDuration,
    type SequenceDecodeContext,
} from '../pulseq/decoder';
import { calculateKspace, type KSpaceData } from '../pulseq/kspace';
import { calculateM1, calculateM1Coarse, type CoarseM1Data, type M1Data } from '../pulseq/m1';
import {
    calculatePns,
    calculatePnsCoarse,
    type CoarsePnsResult,
    type PnsHardware,
    type PnsResult,
} from '../pulseq/pns';
import { selectM1WindowBlocks, selectPnsWindowBlocks } from '../pulseq/derivedWindow';
import { computeGradientSpectrogram } from '../pulseq/gradSpectrum';
import { synthesizeGradientSound } from '../pulseq/gradientSound';
import {
    parseAscProfile,
    type AcousticResonance,
} from '../pulseq/acousticAsc';
import {
    audioBudgetRefusal,
    derivedDetailViewLimitSec,
    estimateAudioCost,
    estimateDerivedCost,
    estimateKspacePeakMemoryBytes,
    estimateSequenceKspaceCost,
    estimateSpectrogramCost,
    formatMemorySize,
    formatSampleCount,
    INTERACTIVE_COMPUTE_LIMITS,
    kspaceExceedsInteractiveBudget,
    spectrogramBudgetRefusal,
} from '../pulseq/computeBudget';
import { downsampleM4 } from '../pulseq/displayDownsampling';
import { exportKspaceArtifactsFromBytes } from '../pulseq/kspaceExport';
import { detectSequenceTiming } from '../pulseq/trdetect';
import {
    estimateEnvelopeJsonBytes,
    MAX_DETAIL_PTS,
    MAX_V8_STRING_LENGTH,
    MIN_DISPLAY_PTS,
    packSequenceBlockRange,
    packSequenceBlocks,
    resolveDetailBlockRange,
    WINDOW_DETAIL_SAMPLE_LIMIT,
} from './blockTransport';
import { ByteBoundedLru } from './windowDetailCache';
import { getWebviewContent } from './webviewContent';
import { serializeGradientSound, serializeSpectrogram } from './spectrogramTransport';
import type { DecodedBlock, PulseqSequence } from '../pulseq/types';

// ─── Constants ────────────────────────────────────────────────────────────

const VIEW_TYPE = 'seqeyes.sequenceViewer';
const WINDOW_DETAIL_CACHE_BYTES = 64 * 1024 * 1024;
const WINDOW_DETAIL_BLOCK_LIMIT = 20_000;

export interface SeqEyesDiagnosticLoadState {
    activeUri: string;
    sequenceName: string;
    blockCount: number;
    totalDuration: number;
    adcCount: number;
    kspaceSampleCount: number;
    hasKspace: boolean;
    hasTiming: boolean;
    panelTitle: string;
    loadedAt: string;
}

export interface SeqEyesDiagnosticErrorState {
    activeUri: string;
    message: string;
    failedAt: string;
}

export interface SeqEyesDiagnosticState {
    activeUri?: string;
    lastLoad?: SeqEyesDiagnosticLoadState;
    lastError?: SeqEyesDiagnosticErrorState;
}

export interface SeqEyesDiagnosticSpectrogramResult {
    nTime: number;
    nFreq: number;
    tStartSec: number;
    tStepSec: number;
    unit: string;
    decimationFactor: number;
    maxValue: number;
    /** Bytes of the serialized message, so an accidental JSON blow-up shows. */
    payloadBytes: number;
    warnings: string[];
}

export interface SeqEyesDiagnosticAscResult {
    hasPns: boolean;
    pnsError?: string;
    acousticCount: number;
    acousticError?: string;
    notice?: string;
}

export interface SeqEyesDiagnosticExportResult {
    ktrajAdcUri: string;
    metadataUri: string;
    adcSampleCount: number;
    sequenceName: string;
}

const diagnosticState: SeqEyesDiagnosticState = {};

export function getSeqEyesDiagnosticState(): SeqEyesDiagnosticState {
    return JSON.parse(JSON.stringify(diagnosticState)) as SeqEyesDiagnosticState;
}

export function resetSeqEyesDiagnosticState(): void {
    delete diagnosticState.activeUri;
    delete diagnosticState.lastLoad;
    delete diagnosticState.lastError;
}

/**
 * Run the `calculateSpectrogram` message path end to end, without a live
 * webview. The E2E suite cannot post messages into a webview it does not own,
 * so this exercises exactly the host-side work that handler does — decode,
 * window selection, compute, serialize — and returns a summary to assert on.
 */
export async function computeSpectrogramForTest(
    sourceUri: vscode.Uri,
    startSec: number,
    endSec: number,
    params?: Record<string, unknown>,
): Promise<SeqEyesDiagnosticSpectrogramResult> {
    const bytes = await vscode.workspace.fs.readFile(sourceUri);
    const sequence = parseSequenceBytes(bytes, uriFileName(sourceUri));
    const blocks = decodeAllBlocks(sequence);
    const spectrogram = computeGradientSpectrogram(
        selectWindowBlocks(blocks, startSec, endSec),
        sequence.rasterTimes.gradientRaster,
        { ...(params ?? {}), startSec, endSec },
    );
    const payload = serializeSpectrogram(spectrogram);
    return {
        nTime: spectrogram.nTime,
        nFreq: spectrogram.nFreq,
        tStartSec: spectrogram.tStartSec,
        tStepSec: spectrogram.tStepSec,
        unit: spectrogram.unit,
        decimationFactor: spectrogram.decimationFactor,
        maxValue: spectrogram.maxValue,
        payloadBytes: JSON.stringify(payload).length,
        warnings: spectrogram.warnings,
    };
}

/**
 * Run the ASC side of the `openPnsAsc` handler, including `$include`
 * resolution, and report all four outcomes of the partial-success contract.
 */
export async function loadAscProfileForTest(
    sourceUri: vscode.Uri,
): Promise<SeqEyesDiagnosticAscResult> {
    const text = await readAscProfileText(sourceUri);
    const profile = parseAscProfile(text);
    return {
        hasPns: !!profile.pns,
        pnsError: profile.pnsError,
        acousticCount: profile.acoustic.length,
        acousticError: profile.acousticError,
        notice: profile.notice,
    };
}

export async function exportKspaceToDirectoryForTest(
    sourceUri: vscode.Uri,
    outputDir: vscode.Uri,
    packageVersion: string,
): Promise<SeqEyesDiagnosticExportResult> {
    const sequenceName = uriFileName(sourceUri);
    const defaultStem = sanitizeFileStem(sequenceName.replace(/\.(?:seq|bseq)$/i, '') || 'sequence');
    const saveUri = vscode.Uri.joinPath(outputDir, `${defaultStem}_ktraj_adc.txt`);
    return await writeKspaceArtifacts(sourceUri, saveUri, packageVersion, defaultStem);
}

class SeqDocument implements vscode.CustomDocument {
    constructor(public readonly uri: vscode.Uri) { }

    dispose(): void {
        // This viewer is read-only and does not hold native resources.
    }
}

// ─── Provider class ───────────────────────────────────────────────────────

export class SeqEditorProvider implements vscode.CustomReadonlyEditorProvider<SeqDocument> {

    /** Register the provider with VS Code. */
    static register(ctx: vscode.ExtensionContext): vscode.Disposable {
        return vscode.window.registerCustomEditorProvider(VIEW_TYPE, new SeqEditorProvider(ctx), {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: false,
        });
    }

    constructor(private readonly _ctx: vscode.ExtensionContext) { }

    openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken,
    ): SeqDocument {
        return new SeqDocument(uri);
    }

    // ── resolveCustomEditor ──────────────────────────────────────────

    async resolveCustomEditor(
        doc: SeqDocument,
        panel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        panel.webview.options = { enableScripts: true };
        panel.webview.html = this._loadingHtml();
        let activeUri = doc.uri;
        let activeSequence: PulseqSequence | undefined;
        let activeDecodeContext: SequenceDecodeContext | undefined;
        let activeBlocks: DecodedBlock[] = [];
        let activeGradientRaster = 0;
        let activeRfRaster = 0;
        let activeTotalDuration = 0;
        let activePnsHardware: PnsHardware | undefined;
        let activeAcousticBands: AcousticResonance[] = [];
        let sequenceGeneration = 0;
        const waveformDetailCache = new ByteBoundedLru<ReturnType<typeof packSequenceBlockRange>>(
            WINDOW_DETAIL_CACHE_BYTES,
        );

        const activeWindowBlockRange = (startSec: number, endSec: number): { start: number; end: number } => {
            if (!activeSequence || !activeDecodeContext) return { start: 0, end: 0 };
            const starts = activeDecodeContext.blockStartTimes;
            const pad = Math.max((endSec - startSec) * 0.05, 0.05);
            let start = lowerBoundNumeric(starts, startSec - pad) - 1;
            let end = lowerBoundNumeric(starts, endSec + pad) + 1;
            start = Math.max(0, Math.min(start, activeSequence.blocks.length));
            end = Math.max(start, Math.min(end, activeSequence.blocks.length));
            return { start, end };
        };

        const allActiveBlocks = (): DecodedBlock[] => {
            if (!activeBlocks.length && activeSequence) activeBlocks = decodeAllBlocks(activeSequence);
            return activeBlocks;
        };

        const activeWindowBlocks = (startSec: number, endSec: number): DecodedBlock[] => {
            if (!activeSequence || !activeDecodeContext) return [];
            const { start, end } = activeWindowBlockRange(startSec, endSec);
            return decodeBlockRange(activeSequence, start, end, activeDecodeContext);
        };

        const derivedNeedsCoarseFallback = (): boolean => {
            const estimate = estimateDerivedCost(allActiveBlocks(), activeGradientRaster);
            return estimate.rasterSamples > INTERACTIVE_COMPUTE_LIMITS.derivedRasterSamples;
        };

        const calculatePnsForDisplay = (hardware: PnsHardware): PnsResult | CoarsePnsResult => {
            if (derivedNeedsCoarseFallback()) {
                return calculatePnsCoarse(activeBlocks, activeGradientRaster, hardware);
            }
            try {
                return calculatePns(activeBlocks, activeGradientRaster, hardware);
            } catch (err) {
                const coarse = calculatePnsCoarse(activeBlocks, activeGradientRaster, hardware);
                coarse.warnings.unshift(
                    `Exact PNS calculation failed (${err instanceof Error ? err.message : String(err)}); using the bounded fallback.`,
                );
                return coarse;
            }
        };

        // ── Core: parse, decode, prepare waveforms, send ──
        const sendSequenceData = async (uri: vscode.Uri) => {
            try {
                sequenceGeneration++;
                waveformDetailCache.clear();
                activeUri = uri;
                diagnosticState.activeUri = uri.toString();
                const postProgress = (phase: string, percent: number, text: string) => {
                    panel.webview.postMessage({ type: 'progress', phase, percent, text });
                };

                postProgress('start', 0, 'Reading file\u2026');
                const seq = await readAndParseSequence(uri, () => {
                    postProgress('parse', 5, 'Parsing Pulseq sequence\u2026');
                });

                postProgress('timing', 10, 'Detecting TR/TE timing\u2026');
                const timing = detectSequenceTiming(seq);

                const totalBlocks = seq.blocks.length;
                activeSequence = seq;
                activeDecodeContext = createSequenceDecodeContext(seq);
                activeBlocks = [];
                activeGradientRaster = seq.rasterTimes.gradientRaster;
                activeRfRaster = seq.rasterTimes.rfRaster;
                const totalDur = getTotalDuration(seq);
                activeTotalDuration = totalDur;

                const sequenceNotices: string[] = [];
                const kspaceEstimate = estimateSequenceKspaceCost(seq, totalDur);
                const kspaceMemoryEstimate = formatMemorySize(estimateKspacePeakMemoryBytes(kspaceEstimate));
                const kspaceOverBudget = kspaceExceedsInteractiveBudget(kspaceEstimate);
                let kspaceSafety: string | null = null;
                if (kspaceOverBudget) {
                    kspaceSafety = (
                        'K-space was not calculated because this sequence exceeds the interactive safety budget '
                        + `(${formatSampleCount(kspaceEstimate.rasterSamples)} raster samples, `
                        + `${formatSampleCount(kspaceEstimate.adcSamples)} ADC samples). `
                        + `Estimated peak memory: approximately ${kspaceMemoryEstimate} (host-dependent).`
                    );
                }

                postProgress('serialize', 85, 'Preparing data for display\u2026');
                // Build lightweight block‑position array for the minimap
                const blockDurationRaster =
                    seq.rasterTimes.blockDurationRaster;

                let cumulative = 0;

                const blockPositions = seq.blocks.map((block) => {
                    const duration =
                        block.dur * blockDurationRaster;

                    const position = {
                        i: block.num,
                        s: cumulative,
                        d: duration,
                    };

                    cumulative += duration;

                    return position;
                });


                postProgress('decode', 15, `Preparing ${totalBlocks} blocks in bounded batches\u2026`);
                const packed = packSequenceBlocks(seq);
                if (packed.notice) sequenceNotices.push(packed.notice);

                // The waveform samples travel as binary buffers, but a sequence
                // with millions of blocks can still push the scalar envelope
                // past what `JSON.stringify` can produce inside postMessage.
                const envelopeBytes = estimateEnvelopeJsonBytes(packed.blocks);
                if (envelopeBytes > MAX_V8_STRING_LENGTH * 0.8) {
                    throw new Error(
                        `This sequence has ${seq.blocks.length} blocks, whose block metadata alone needs about `
                        + `${formatMemorySize(envelopeBytes)} to transfer \u2014 beyond what the viewer can deliver `
                        + 'to its renderer. Export the k-space trajectory instead, or split the sequence.',
                    );
                }

                postProgress('send', 95, 'Rendering\u2026');
                // Deliberately not awaited: VS Code resolves this promise only
                // once the webview has finished initialising, which can be long
                // after this call \u2014 or never, if the editor is closed first.
                // Serialisation runs synchronously inside postMessage, so
                // attaching a rejection handler is what catches a payload the
                // host cannot serialise; awaiting would deadlock the open.
                const delivery = panel.webview.postMessage({
                    type: 'sequenceData',
                    sequenceGeneration,
                    blocks: packed.blocks,
                    sampleTimes: packed.sampleTimes,
                    sampleValues: packed.sampleValues,
                    sampleCount: packed.sampleCount,
                    totalDuration: totalDur,
                    gradRaster: seq.rasterTimes.gradientRaster,
                    rfRaster: seq.rasterTimes.rfRaster,
                    adcRaster: seq.rasterTimes.adcRaster,
                    blockRaster: seq.rasterTimes.blockDurationRaster,
                    kspace: null,
                    kspaceSafety,
                    timing: {
                        trTimeSec: timing.trTimeSec,
                        trCount: timing.trCount,
                        hasExplicitTR: timing.hasExplicitTR,
                        teTimeSec: timing.teTimeSec,
                        hasExplicitTE: timing.hasExplicitTE,
                        rfUseGuessed: timing.rfUseGuessed,
                        derivedDetailMaxViewSec: derivedDetailViewLimitSec(
                            seq.rasterTimes.gradientRaster,
                            timing.trTimeSec,
                        ),
                    },
                    blockPositions,
                    notices: sequenceNotices,
                });
                delivery.then(undefined, (err: unknown) => {
                    const message = err instanceof Error ? err.message : String(err);
                    recordDiagnosticError(uri, err);
                    panel.webview.postMessage({
                        type: 'loadError',
                        message: `The viewer could not transfer this sequence to its renderer: ${message}`,
                    });
                    vscode.window.showErrorMessage(`SeqEyes could not display this sequence: ${message}`);
                });

                postProgress('done', 100, 'Ready');
                const sourceName = uriFileName(uri);
                const name = seq.definitionsRaw.get('Name') || sourceName || 'SeqEyes Viewer';
                panel.title = `SeqEyes: ${name.replace(/\.(?:seq|bseq)$/i, '')}`;
                diagnosticState.lastLoad = {
                    activeUri: uri.toString(),
                    sequenceName: sourceName,
                    blockCount: seq.blocks.length,
                    totalDuration: totalDur,
                    adcCount: kspaceEstimate.adcSamples,
                    kspaceSampleCount: 0,
                    hasKspace: false,
                    hasTiming: true,
                    panelTitle: panel.title,
                    loadedAt: new Date().toISOString(),
                };
                delete diagnosticState.lastError;
            } catch (err) {
                recordDiagnosticError(uri, err);
                throw err;
            }
        };

        // ── Initial load: set full UI, show progress, then send data ──
        try {
            panel.webview.html = getWebviewContent(0);
            // Give the webview a moment to parse its new HTML, then start progress
            panel.webview.postMessage({ type: 'progress', phase: 'start', percent: 0, text: 'Preparing\u2026' });
            await sendSequenceData(doc.uri);
        } catch (err) {
            recordDiagnosticError(doc.uri, err);
            panel.webview.html = this._errorHtml(err);
            return;
        }

        // ── Handle messages from webview ──
        panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'log') {
                console.log('[SeqEyes]', msg.text);
            } else if (msg.command === 'openFile') {
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { 'Pulseq Sequences': ['seq', 'bseq'] },
                    title: 'Open Pulseq Sequence',
                });
                if (uris && uris.length > 0) {
                    try {
                        await sendSequenceData(uris[0]);
                    } catch (err) {
                        vscode.window.showErrorMessage(
                            'Failed to load sequence: ' + (err instanceof Error ? err.message : String(err))
                        );
                    }
                }
            } else if (msg.command === 'exportKspace') {
                await this._exportKspace(activeUri);
            } else if (msg.command === 'requestWaveformDetail') {
                const requestId = Number(msg.requestId);
                const requestedGeneration = Number(msg.sequenceGeneration);
                if (!activeSequence || !activeDecodeContext || requestedGeneration !== sequenceGeneration) {
                    panel.webview.postMessage({
                        type: 'waveformDetailError',
                        requestId,
                        sequenceGeneration: requestedGeneration,
                        message: 'The waveform detail request belongs to an inactive sequence.',
                    });
                    return;
                }
                const startSec = Number(msg.startSec);
                const endSec = Number(msg.endSec);
                const { start, end } = resolveDetailBlockRange(
                    activeDecodeContext.blockStartTimes,
                    activeSequence.blocks.length,
                    startSec,
                    endSec,
                );
                if (!(endSec > startSec) || end - start > WINDOW_DETAIL_BLOCK_LIMIT) {
                    panel.webview.postMessage({
                        type: 'waveformDetailError',
                        requestId,
                        sequenceGeneration,
                        message: 'This waveform detail window is too large. Zoom in further.',
                    });
                    return;
                }
                // The renderer sends what it can usefully draw across the whole
                // window; the per-waveform ceiling is ours.
                const pointBudget = Math.max(
                    MIN_DISPLAY_PTS,
                    Math.min(WINDOW_DETAIL_SAMPLE_LIMIT, Math.floor(Number(msg.pointBudget) || 0)),
                );
                // The window and budget are what make this detail rather than a
                // second overview, so both belong in the cache identity.
                const cacheKey = `${sequenceGeneration}:${start}:${end}:${pointBudget}:${startSec}:${endSec}`;
                try {
                    let packed = waveformDetailCache.get(cacheKey);
                    if (!packed) {
                        packed = packSequenceBlockRange(
                            activeSequence,
                            start,
                            end,
                            activeDecodeContext,
                            MAX_DETAIL_PTS,
                            undefined,
                            { startSec, endSec },
                            pointBudget,
                        );
                        const retainedBytes = packed.sampleTimes.byteLength + packed.sampleValues.byteLength
                            + estimateEnvelopeJsonBytes(packed.blocks);
                        waveformDetailCache.set(cacheKey, packed, retainedBytes);
                    }
                    panel.webview.postMessage({
                        type: 'waveformDetailData',
                        requestId,
                        sequenceGeneration,
                        startBlock: start,
                        endBlock: end,
                        startSec,
                        endSec,
                        blocks: packed.blocks,
                        sampleTimes: packed.sampleTimes,
                        sampleValues: packed.sampleValues,
                        sampleCount: packed.sampleCount,
                        pointsPerWaveform: packed.pointsPerWaveform,
                    });
                } catch (err) {
                    panel.webview.postMessage({
                        type: 'waveformDetailError',
                        requestId,
                        sequenceGeneration,
                        message: err instanceof Error ? err.message : String(err),
                    });
                }
            } else if (msg.command === 'calculateKspaceUnsafe') {
                if (!activeSequence || activeGradientRaster <= 0 || activeTotalDuration <= 0) {
                    panel.webview.postMessage({ type: 'kspaceError', message: 'No sequence is loaded.' });
                    return;
                }
                panel.webview.postMessage({ type: 'progress', phase: 'start', percent: 0, text: 'Calculating K-space without safety limits…' });
                try {
                    const blocks = allActiveBlocks();
                    const kspace = calculateKspace(
                        blocks,
                        activeGradientRaster,
                        activeTotalDuration,
                        0,
                        { rfRaster: activeRfRaster },
                    );
                    if (!kspace) throw new Error('The calculation did not produce a trajectory.');
                    panel.webview.postMessage({ type: 'kspaceData', kspace: serializeKSpace(kspace) });
                    panel.webview.postMessage({ type: 'progress', phase: 'done', percent: 100, text: 'K-space ready' });
                } catch (err) {
                    panel.webview.postMessage({
                        type: 'kspaceError',
                        message: err instanceof Error ? err.message : String(err),
                    });
                    panel.webview.postMessage({ type: 'progress', phase: 'done', percent: 100, text: 'K-space failed' });
                }
            } else if (msg.command === 'calculateKspace') {
                if (!activeSequence || activeGradientRaster <= 0 || activeTotalDuration <= 0) {
                    panel.webview.postMessage({ type: 'kspaceError', message: 'No sequence is loaded.' });
                    return;
                }
                const estimate = estimateSequenceKspaceCost(activeSequence, activeTotalDuration);
                if (kspaceExceedsInteractiveBudget(estimate)) {
                    panel.webview.postMessage({
                        type: 'kspaceError',
                        message: 'K-space exceeds the interactive safety budget and requires explicit confirmation.',
                    });
                    return;
                }
                panel.webview.postMessage({ type: 'progress', phase: 'start', percent: 0, text: 'Calculating K-space…' });
                try {
                    const blocks = allActiveBlocks();
                    const kspace = calculateKspace(
                        blocks,
                        activeGradientRaster,
                        activeTotalDuration,
                        0,
                        {
                            rfRaster: activeRfRaster,
                            maxGridPoints: INTERACTIVE_COMPUTE_LIMITS.kspaceGridCandidates,
                            maxAdcSamples: INTERACTIVE_COMPUTE_LIMITS.kspaceAdcSamples,
                        },
                    );
                    if (!kspace) throw new Error('The calculation did not produce a trajectory.');
                    panel.webview.postMessage({ type: 'kspaceData', kspace: serializeKSpace(kspace) });
                    panel.webview.postMessage({ type: 'progress', phase: 'done', percent: 100, text: 'K-space ready' });
                    if (diagnosticState.lastLoad?.activeUri === activeUri.toString()) {
                        diagnosticState.lastLoad.adcCount = kspace.t_adc.length;
                        diagnosticState.lastLoad.kspaceSampleCount = kspace.t_ktraj.length;
                        diagnosticState.lastLoad.hasKspace = true;
                    }
                } catch (err) {
                    panel.webview.postMessage({
                        type: 'kspaceError',
                        message: err instanceof Error ? err.message : String(err),
                    });
                    panel.webview.postMessage({ type: 'progress', phase: 'done', percent: 100, text: 'K-space failed' });
                }
            } else if (msg.command === 'calculateM1') {
                if (!activeSequence || activeGradientRaster <= 0) {
                    panel.webview.postMessage({ type: 'm1Error', message: 'Load a sequence before calculating M1.' });
                    return;
                }
                const blocks = allActiveBlocks();
                const referenceMode = msg.referenceMode === 'observationTime' ? 'observationTime' : 'rfCenter';
                try {
                    const m1 = derivedNeedsCoarseFallback()
                        ? calculateM1Coarse(blocks, activeGradientRaster, { referenceMode })
                        : calculateM1(blocks, activeGradientRaster, { referenceMode });
                    panel.webview.postMessage({ type: 'm1Data', m1: serializeM1(m1) });
                } catch (err) {
                    try {
                        const coarse = calculateM1Coarse(blocks, activeGradientRaster, { referenceMode });
                        coarse.warnings.unshift(`Exact M1 calculation failed (${err instanceof Error ? err.message : String(err)}); using the bounded fallback.`);
                        panel.webview.postMessage({ type: 'm1Data', m1: serializeM1(coarse) });
                    } catch (fallbackError) {
                        panel.webview.postMessage({
                            type: 'm1Error',
                            message: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
                        });
                    }
                }
            } else if (msg.command === 'calculateM1Window') {
                const blocks = allActiveBlocks();
                const referenceMode = msg.referenceMode === 'observationTime' ? 'observationTime' : 'rfCenter';
                const selected = selectM1WindowBlocks(blocks, Number(msg.startSec), Number(msg.endSec));
                const estimate = estimateDerivedCost(selected.blocks, activeGradientRaster);
                if (!selected.blocks.length || estimate.rasterSamples > INTERACTIVE_COMPUTE_LIMITS.derivedRasterSamples) {
                    panel.webview.postMessage({
                        type: 'm1WindowData',
                        requestId: msg.requestId,
                        m1: { valid: false, error: 'The requested M1 detail window is still too large. Zoom in further.' },
                    });
                    return;
                }
                try {
                    const m1 = calculateM1(selected.blocks, activeGradientRaster, { referenceMode });
                    panel.webview.postMessage({
                        type: 'm1WindowData',
                        requestId: msg.requestId,
                        m1: serializeM1Window(m1, selected.displayStartSec, selected.displayEndSec, Number(msg.maxPoints)),
                    });
                } catch (err) {
                    panel.webview.postMessage({
                        type: 'm1WindowData',
                        requestId: msg.requestId,
                        m1: { valid: false, error: err instanceof Error ? err.message : String(err) },
                    });
                }
            } else if (msg.command === 'openPnsAsc') {
                if (!activeSequence || activeGradientRaster <= 0) {
                    panel.webview.postMessage({ type: 'pnsError', message: 'Load a sequence before loading an ASC profile.' });
                    return;
                }
                allActiveBlocks();
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { 'Siemens ASC Profiles': ['asc'], 'All Files': ['*'] },
                    title: 'Open Siemens ASC Profile (PNS Prediction and Acoustic Resonances)',
                });
                if (!uris || uris.length === 0) {
                    if (activePnsHardware) {
                        const pns = calculatePnsForDisplay(activePnsHardware);
                        panel.webview.postMessage({ type: 'pnsData', pns: serializePns(pns) });
                    } else {
                        panel.webview.postMessage({ type: 'pnsSelectionCancelled' });
                    }
                    return;
                }
                try {
                    const ascText = await readAscProfileText(uris[0]);
                    // Parse both concerns independently: after the button rename the
                    // same picker must still succeed for a file that carries only one
                    // of them, and failing PNS must not discard acoustic bands.
                    const profile = parseAscProfile(ascText);
                    activeAcousticBands = profile.acoustic;
                    panel.webview.postMessage({
                        type: 'ascProfileData',
                        fileName: uriFileName(uris[0]),
                        acoustic: profile.acoustic,
                        hasPns: !!profile.pns,
                        notice: profile.notice,
                    });
                    if (profile.pns) {
                        activePnsHardware = profile.pns;
                        const pns = calculatePnsForDisplay(profile.pns);
                        panel.webview.postMessage({ type: 'pnsData', pns: serializePns(pns) });
                    } else if (!profile.acoustic.length) {
                        panel.webview.postMessage({
                            type: 'pnsError',
                            message: profile.pnsError
                                ?? 'This ASC contains neither PNS coefficients nor acoustic resonances.',
                        });
                    } else {
                        panel.webview.postMessage({ type: 'pnsSelectionCancelled' });
                    }
                } catch (err) {
                    panel.webview.postMessage({
                        type: 'pnsError',
                        message: err instanceof Error ? err.message : String(err),
                    });
                }
            } else if (msg.command === 'calculatePnsWindow') {
                if (!activePnsHardware) {
                    panel.webview.postMessage({
                        type: 'pnsWindowData',
                        requestId: msg.requestId,
                        pns: { valid: false, error: 'Load PNS hardware before requesting a detailed PNS window.' },
                    });
                    return;
                }
                const selected = selectPnsWindowBlocks(
                    allActiveBlocks(),
                    Number(msg.startSec),
                    Number(msg.endSec),
                    activePnsHardware,
                );
                const estimate = estimateDerivedCost(selected.blocks, activeGradientRaster);
                if (!selected.blocks.length || estimate.rasterSamples > INTERACTIVE_COMPUTE_LIMITS.derivedRasterSamples) {
                    panel.webview.postMessage({
                        type: 'pnsWindowData',
                        requestId: msg.requestId,
                        pns: { valid: false, error: 'The requested PNS detail window is still too large. Zoom in further.' },
                    });
                    return;
                }
                try {
                    const pns = calculatePns(selected.blocks, activeGradientRaster, activePnsHardware);
                    panel.webview.postMessage({
                        type: 'pnsWindowData',
                        requestId: msg.requestId,
                        pns: serializePnsWindow(
                            pns,
                            selected.displayStartSec,
                            selected.displayEndSec,
                            Number(msg.maxPoints),
                        ),
                    });
                } catch (err) {
                    panel.webview.postMessage({
                        type: 'pnsWindowData',
                        requestId: msg.requestId,
                        pns: { valid: false, error: err instanceof Error ? err.message : String(err) },
                    });
                }
            } else if (msg.command === 'calculateSpectrogram') {
                const requestId = msg.requestId;
                if (!activeSequence || activeGradientRaster <= 0) {
                    panel.webview.postMessage({
                        type: 'spectrogramError',
                        requestId,
                        message: 'Load a sequence before calculating the spectrogram.',
                    });
                    return;
                }
                const params = msg.params ?? {};
                const startSec = Number(msg.startSec);
                const endSec = Number(msg.endSec);
                const estimate = estimateSpectrogramCost({
                    startSec,
                    endSec,
                    gradientRaster: activeGradientRaster,
                    fMaxHz: Number(params.fMaxHz) || 3000,
                    windowSamples: Number(params.windowSamples) || 512,
                    overlap: Number(params.overlap) || 0.75,
                    oversample: Number(params.oversample) || 3,
                    targetColumns: Number(params.targetColumns) || 256,
                });
                // Unlike k-space there is no dangerous override here: the
                // spectrogram is scoped to the visible window, so the remedy is
                // always to zoom in rather than to risk the extension host.
                const refusal = spectrogramBudgetRefusal(estimate);
                if (refusal) {
                    panel.webview.postMessage({ type: 'spectrogramError', requestId, message: refusal });
                    return;
                }
                try {
                    const spectrogram = computeGradientSpectrogram(
                        activeWindowBlocks(startSec, endSec),
                        activeGradientRaster,
                        { ...params, startSec, endSec },
                    );
                    panel.webview.postMessage({
                        type: 'spectrogramData',
                        requestId,
                        spectrogram: serializeSpectrogram(spectrogram),
                    });
                } catch (err) {
                    panel.webview.postMessage({
                        type: 'spectrogramError',
                        requestId,
                        message: err instanceof Error ? err.message : String(err),
                    });
                }
            } else if (msg.command === 'synthesizeGradientSound') {
                const requestId = msg.requestId;
                if (!activeSequence) {
                    panel.webview.postMessage({
                        type: 'gradientSoundError',
                        requestId,
                        message: 'Load a sequence before playing the gradient sound.',
                    });
                    return;
                }
                const startSec = Number(msg.startSec);
                const endSec = Number(msg.endSec);
                const sampleRate = Number(msg.sampleRate) || 44100;
                const audioRefusal = audioBudgetRefusal(estimateAudioCost(startSec, endSec, sampleRate));
                if (audioRefusal) {
                    panel.webview.postMessage({ type: 'gradientSoundError', requestId, message: audioRefusal });
                    return;
                }
                try {
                    const sound = synthesizeGradientSound(
                        activeWindowBlocks(startSec, endSec),
                        {
                            startSec,
                            endSec,
                            sampleRate,
                            channelWeights: msg.channelWeights,
                            source: msg.source === 'dGdt' ? 'dGdt' : 'G',
                        },
                    );
                    panel.webview.postMessage({
                        type: 'gradientSoundData',
                        requestId,
                        ...serializeGradientSound(sound),
                    });
                } catch (err) {
                    panel.webview.postMessage({
                        type: 'gradientSoundError',
                        requestId,
                        message: err instanceof Error ? err.message : String(err),
                    });
                }
            } else if (msg.command === 'requestAcousticBands') {
                panel.webview.postMessage({
                    type: 'ascProfileData',
                    acoustic: activeAcousticBands,
                    hasPns: !!activePnsHardware,
                });
            }
        });
    }

    private async _exportKspace(uri: vscode.Uri): Promise<void> {
        try {
            const sequenceName = uriFileName(uri);
            const defaultStem = sanitizeFileStem(sequenceName.replace(/\.(?:seq|bseq)$/i, '') || 'sequence');
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: siblingUri(uri, `${defaultStem}_ktraj_adc.txt`),
                filters: { 'Text': ['txt'] },
                title: 'Export ADC K-Space Trajectory',
            });
            if (!saveUri) return;

            const result = await writeKspaceArtifacts(uri, saveUri, this._packageVersion(), defaultStem);

            vscode.window.showInformationMessage(
                `Exported k-space trajectory (${result.adcSampleCount} ADC samples) and metadata.`
            );
        } catch (err) {
            vscode.window.showErrorMessage(
                'Failed to export k-space trajectory: ' + (err instanceof Error ? err.message : String(err))
            );
        }
    }

    private _packageVersion(): string {
        const pkg = this._ctx.extension.packageJSON as { version?: unknown };
        return typeof pkg.version === 'string' ? pkg.version : 'unknown';
    }

    // ── HTML helpers ─────────────────────────────────────────────────

    private _loadingHtml() {
        return `<!DOCTYPE html><html><head><style>
body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.s{color:#888;text-align:center}
.k{width:36px;height:36px;border:3px solid #e0e0e0;border-top-color:#4363d8;border-radius:50%;animation:spin .7s linear infinite;margin:0 auto 14px}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body><div class="s"><div class="k"></div><p>Loading sequence…</p></div></body></html>`;
    }

    private _errorHtml(err: unknown): string {
        const msg = err instanceof Error ? err.message : String(err);
        return `<!DOCTYPE html><html><head><style>
body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.e{text-align:center;color:#e6194b;max-width:600px}
.e pre{background:#f5f5f5;padding:16px;border-radius:4px;text-align:left;overflow:auto;font-size:12px;color:#333}
</style></head><body><div class="e"><h2>Failed To Open Sequence</h2><pre>${msg.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</pre></div></body></html>`;
    }
}

function uriFileName(uri: vscode.Uri): string {
    const rawName = uri.path.split('/').pop() || 'sequence.seq';
    try {
        return decodeURIComponent(rawName);
    } catch {
        return rawName;
    }
}

function siblingUri(uri: vscode.Uri, fileName: string): vscode.Uri {
    const dir = uri.path.replace(/\/[^/]*$/, '');
    return uri.with({ path: `${dir}/${fileName}` });
}

function sanitizeFileStem(name: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    return cleaned || 'sequence';
}

async function readAscProfileText(uri: vscode.Uri, visited = new Set<string>()): Promise<string> {
    const key = uri.toString();
    if (visited.has(key)) return '';
    visited.add(key);

    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    const output: string[] = [];
    const parentPath = uri.path.replace(/\/[^/]*$/, '');
    for (const rawLine of text.split(/\r?\n/)) {
        const match = /^\s*\$include\s+([A-Za-z0-9_.-]+)\s*$/i.exec(rawLine);
        if (!match) {
            output.push(rawLine);
            continue;
        }

        const names = match[1].toLowerCase().endsWith('.asc')
            ? [match[1]]
            : [match[1], `${match[1]}.asc`];
        let included = false;
        for (const name of names) {
            const candidate = uri.with({ path: `${parentPath}/${name}` });
            try {
                await vscode.workspace.fs.stat(candidate);
                output.push(await readAscProfileText(candidate, visited));
                included = true;
                break;
            } catch {
                // Try the next supported include spelling.
            }
        }
        if (!included) {
            throw new Error(`ASC include file not found beside ${uriFileName(uri)}: ${match[1]}`);
        }
    }
    return output.join('\n');
}

async function writeKspaceArtifacts(
    sourceUri: vscode.Uri,
    ktrajAdcUri: vscode.Uri,
    packageVersion: string,
    metadataFallbackStem = 'sequence',
): Promise<SeqEyesDiagnosticExportResult> {
    const sequenceBytes = await vscode.workspace.fs.readFile(sourceUri);
    const sequenceName = uriFileName(sourceUri);
    const artifacts = exportKspaceArtifactsFromBytes(sequenceBytes, sequenceName, { packageVersion });
    await vscode.workspace.fs.writeFile(ktrajAdcUri, Buffer.from(artifacts.ktrajAdcText, 'utf8'));

    const outputStem = sanitizeFileStem(uriFileName(ktrajAdcUri).replace(/\.[^.]*$/i, '').replace(/_?ktraj_adc$/i, ''));
    const metadataUri = siblingUri(ktrajAdcUri, `${outputStem || metadataFallbackStem}_metadata.json`);
    await vscode.workspace.fs.writeFile(
        metadataUri,
        Buffer.from(`${JSON.stringify(artifacts.metadata, null, 2)}\n`, 'utf8'),
    );

    return {
        ktrajAdcUri: ktrajAdcUri.toString(),
        metadataUri: metadataUri.toString(),
        adcSampleCount: artifacts.metadata.adcSampleCount,
        sequenceName,
    };
}

function recordDiagnosticError(uri: vscode.Uri, err: unknown): void {
    diagnosticState.activeUri = uri.toString();
    diagnosticState.lastError = {
        activeUri: uri.toString(),
        message: err instanceof Error ? err.message : String(err),
        failedAt: new Date().toISOString(),
    };
}

// ─── Webview serialisation ────────────────────────────────────────────────

async function readAndParseSequence(uri: vscode.Uri, didRead: () => void) {
    const fileBytes = await vscode.workspace.fs.readFile(uri);
    didRead();
    return parseSequenceBytes(fileBytes, uriFileName(uri));
}

/** Convert k‑space data for webview transfer.
 *  ADC arrays are binary‑encoded (Float32 → base64) to reduce payload ~3×;
 *  the trajectory is JSON (already down‑sampled to MAX_KPTS).  */
function serializeKSpace(ks: KSpaceData): Record<string, unknown> {
    const MAX_KPTS = 30000;
    return {
        kx: downsample(ks.ktraj[0], MAX_KPTS),
        ky: downsample(ks.ktraj[1], MAX_KPTS),
        kz: downsample(ks.ktraj[2], MAX_KPTS),
        tk: downsample(ks.t_ktraj, MAX_KPTS),
        // Binary‑encoded ADC arrays — Float32 base64, ~3× smaller than JSON arrays
        axb: encodeF32B64(ks.ktraj_adc[0]),
        ayb: encodeF32B64(ks.ktraj_adc[1]),
        azb: encodeF32B64(ks.ktraj_adc[2]),
        tab: encodeF32B64(ks.t_adc),
        nAdc: ks.ktraj_adc[0].length,
    };
}

function serializeM1(m1: M1Data | CoarseM1Data): Record<string, unknown> {
    if ('coarse' in m1) {
        const envelope = (series: CoarseM1Data['x'], prefix: string): Record<string, number[]> => ({
            [`${prefix}0`]: Array.from(series.startTime),
            [`${prefix}1`]: Array.from(series.endTime),
            [`${prefix}min`]: Array.from(series.min),
            [`${prefix}max`]: Array.from(series.max),
            [`${prefix}first`]: Array.from(series.first),
            [`${prefix}last`]: Array.from(series.last),
        });
        return {
            valid: m1.valid,
            ok: m1.ok,
            coarse: true,
            referenceMode: m1.referenceMode,
            error: m1.error,
            warnings: m1.warnings,
            startSec: m1.startSec,
            endSec: m1.endSec,
            ...envelope(m1.x, 'x'),
            ...envelope(m1.y, 'y'),
            ...envelope(m1.z, 'z'),
            excitationTimesSec: Array.from(m1.excitationTimesSec),
            refocusingTimesSec: Array.from(m1.refocusingTimesSec),
        };
    }
    const MAX_M1_PTS = 30000;
    const x = downsampleM4(m1.tSec, m1.m1x, MAX_M1_PTS);
    const y = downsampleM4(m1.tSec, m1.m1y, MAX_M1_PTS);
    const z = downsampleM4(m1.tSec, m1.m1z, MAX_M1_PTS);
    return {
        valid: m1.valid,
        ok: m1.ok,
        coarse: false,
        referenceMode: m1.referenceMode,
        error: m1.error,
        warnings: m1.warnings,
        tx: x.time,
        x: x.values,
        ty: y.time,
        y: y.values,
        tz: z.time,
        z: z.values,
        excitationTimesSec: downsample(m1.excitationTimesSec, MAX_M1_PTS),
        refocusingTimesSec: downsample(m1.refocusingTimesSec, MAX_M1_PTS),
    };
}

function serializeM1Window(
    m1: M1Data,
    startSec: number,
    endSec: number,
    maxPoints: number,
): Record<string, unknown> {
    if (m1.tSec.length === 0) {
        return { valid: false, ok: m1.ok, error: 'No M1 samples are available.', startSec, endSec };
    }
    const maxWindowPoints = Number.isFinite(maxPoints)
        ? Math.max(1024, Math.min(200_000, Math.floor(maxPoints)))
        : 120_000;
    const start = Math.max(0, Math.min(startSec, endSec));
    const end = Math.max(start, Math.max(startSec, endSec));
    const i0 = Math.max(0, lowerBoundNumeric(m1.tSec, start) - 1);
    const i1 = Math.min(m1.tSec.length, upperBoundNumeric(m1.tSec, end) + 1);
    if (i1 <= i0) return { valid: false, ok: m1.ok, error: 'No M1 samples in requested time window.', startSec: start, endSec: end };
    const t = m1.tSec.subarray(i0, i1);
    const x = downsampleM4(t, m1.m1x.subarray(i0, i1), maxWindowPoints);
    const y = downsampleM4(t, m1.m1y.subarray(i0, i1), maxWindowPoints);
    const z = downsampleM4(t, m1.m1z.subarray(i0, i1), maxWindowPoints);
    return {
        valid: m1.valid,
        ok: m1.ok,
        coarse: false,
        referenceMode: m1.referenceMode,
        warnings: m1.warnings,
        startSec: start,
        endSec: end,
        tx: x.time,
        x: x.values,
        ty: y.time,
        y: y.values,
        tz: z.time,
        z: z.values,
    };
}

function serializePns(pns: PnsResult | CoarsePnsResult): Record<string, unknown> {
    if ('coarse' in pns) {
        const percent = (values: Float64Array): number[] => Array.from(values, value => value * 100);
        const envelope = (series: CoarsePnsResult['x'], prefix: string): Record<string, number[]> => ({
            [`${prefix}0`]: Array.from(series.startTime),
            [`${prefix}1`]: Array.from(series.endTime),
            [`${prefix}min`]: percent(series.min),
            [`${prefix}max`]: percent(series.max),
            [`${prefix}first`]: percent(series.first),
            [`${prefix}last`]: percent(series.last),
        });
        return {
            valid: pns.valid,
            ok: pns.ok,
            coarse: true,
            error: pns.error,
            warnings: pns.warnings,
            startSec: pns.startSec,
            endSec: pns.endSec,
            ...envelope(pns.x, 'x'),
            ...envelope(pns.y, 'y'),
            ...envelope(pns.z, 'z'),
            ...envelope(pns.norm, 'n'),
        };
    }
    const MAX_PNS_PTS = 30000;
    const x = downsampleM4(pns.timeSec, pns.pnsX, MAX_PNS_PTS);
    const y = downsampleM4(pns.timeSec, pns.pnsY, MAX_PNS_PTS);
    const z = downsampleM4(pns.timeSec, pns.pnsZ, MAX_PNS_PTS);
    const norm = downsampleM4(pns.timeSec, pns.pnsNorm, MAX_PNS_PTS);
    return {
        valid: pns.valid,
        ok: pns.ok,
        coarse: false,
        error: pns.error,
        tx: x.time,
        x: x.values.map(value => value * 100.0),
        ty: y.time,
        y: y.values.map(value => value * 100.0),
        tz: z.time,
        z: z.values.map(value => value * 100.0),
        tn: norm.time,
        n: norm.values.map(value => value * 100.0),
    };
}

function serializePnsWindow(
    pns: PnsResult,
    startSec: number,
    endSec: number,
    maxPoints: number,
): Record<string, unknown> {
    if (pns.timeSec.length === 0) {
        return {
            valid: false,
            ok: pns.ok,
            error: 'No PNS samples are available.',
            startSec: 0,
            endSec: 0,
        };
    }
    const maxWindowPoints = Number.isFinite(maxPoints)
        ? Math.max(1024, Math.min(200_000, Math.floor(maxPoints)))
        : 120_000;
    const fallbackStart = pns.timeSec[0] ?? 0;
    const boundedStart = Number.isFinite(startSec) ? startSec : fallbackStart;
    const boundedEnd = Number.isFinite(endSec) ? endSec : boundedStart;
    const lastTime = pns.timeSec[pns.timeSec.length - 1] ?? boundedEnd;
    const start = Math.max(0, Math.min(Math.min(boundedStart, boundedEnd), lastTime));
    const end = Math.max(start, Math.min(Math.max(boundedStart, boundedEnd), lastTime));
    const i0 = Math.max(0, lowerBoundNumeric(pns.timeSec, start) - 1);
    const i1 = Math.min(pns.timeSec.length, upperBoundNumeric(pns.timeSec, end) + 1);
    if (i1 <= i0) {
        return {
            valid: false,
            ok: pns.ok,
            error: 'No PNS samples in requested time window.',
            startSec: start,
            endSec: end,
        };
    }

    const t = pns.timeSec.subarray(i0, i1);
    const x = downsampleM4(t, pns.pnsX.subarray(i0, i1), maxWindowPoints);
    const y = downsampleM4(t, pns.pnsY.subarray(i0, i1), maxWindowPoints);
    const z = downsampleM4(t, pns.pnsZ.subarray(i0, i1), maxWindowPoints);
    const norm = downsampleM4(t, pns.pnsNorm.subarray(i0, i1), maxWindowPoints);
    return {
        valid: pns.valid,
        ok: pns.ok,
        error: pns.error,
        startSec: start,
        endSec: end,
        tx: x.time,
        x: x.values.map(value => value * 100.0),
        ty: y.time,
        y: y.values.map(value => value * 100.0),
        tz: z.time,
        z: z.values.map(value => value * 100.0),
        tn: norm.time,
        n: norm.values.map(value => value * 100.0),
    };
}

function lowerBoundNumeric(values: ArrayLike<number>, target: number): number {
    let lo = 0;
    let hi = values.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (values[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function upperBoundNumeric(values: ArrayLike<number>, target: number): number {
    let lo = 0;
    let hi = values.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (values[mid] <= target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/**
 * Blocks overlapping a window, so the spectrogram and the sound synthesis walk
 * a handful of blocks instead of the whole sequence on every pan.
 *
 * The window is padded by one block on each side because the decimation filter
 * reads real waveform outside the requested range (never zeros — see
 * decimator.ts), and because a block straddling the edge still contributes.
 */
function selectWindowBlocks(blocks: DecodedBlock[], startSec: number, endSec: number): DecodedBlock[] {
    if (!blocks.length) return blocks;
    const span = Math.max(0, endSec - startSec);
    const pad = Math.max(span * 0.05, 0.05);
    const from = startSec - pad;
    const to = endSec + pad;
    return blocks.filter(block => block.startTime + block.duration >= from && block.startTime <= to);
}

/** Encode a Float64Array (or number[]) as a base64‑encoded Float32 blob.
 *  Uses Node's Buffer for efficient base64 conversion. */
function encodeF32B64(data: Float64Array | Float32Array | number[]): string {
    const f32 = new Float32Array(data);
    return Buffer.from(f32.buffer).toString('base64');
}

/** Uniformly downsample an array to at most `maxPts` elements. */
function downsample(arr: Float64Array | number[], maxPts: number): number[] {
    if (!arr) return [];
    const n = arr.length;
    if (n <= maxPts) return Array.from(arr);
    const step = n / maxPts;
    const out = new Array<number>(maxPts);
    for (let i = 0; i < maxPts; i++) out[i] = arr[Math.floor(i * step)];
    return out;
}
