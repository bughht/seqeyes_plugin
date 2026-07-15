/**
 * Custom readonly editor provider for Pulseq .seq and .bseq files.
 *
 * Registered as `seqeyes.sequenceViewer` — opens automatically when the user
 * opens a supported Pulseq sequence. The provider:
 *   1. Reads the source bytes
 *   2. Parses it via the Pulseq reader
 *   3. Detects TE/TR timing (from definitions or RF‑pulse estimation)
 *   4. Decodes all waveforms via the decoder
 *   5. Computes k‑space trajectory
 *   6. Sends serialised block data + timing metadata to the webview
 *   7. The webview renders an interactive Canvas diagram with minimap
 */

import * as vscode from 'vscode';
import { parseSequenceBytes } from '../pulseq/sequenceReader';
import { decodeAllBlocks } from '../pulseq/decoder';
import { calculateKspace, type KSpaceData } from '../pulseq/kspace';
import { calculateM1, calculateM1Coarse, type CoarseM1Data, type M1Data } from '../pulseq/m1';
import {
    calculatePns,
    calculatePnsCoarse,
    parsePnsHardwareAsc,
    type CoarsePnsResult,
    type PnsHardware,
    type PnsResult,
} from '../pulseq/pns';
import { selectM1WindowBlocks, selectPnsWindowBlocks } from '../pulseq/derivedWindow';
import {
    estimateDerivedCost,
    estimateKspaceCost,
    estimateKspacePeakMemoryBytes,
    formatMemorySize,
    formatSampleCount,
    INTERACTIVE_COMPUTE_LIMITS,
} from '../pulseq/computeBudget';
import { downsampleM4 } from '../pulseq/displayDownsampling';
import { exportKspaceArtifactsFromBytes } from '../pulseq/kspaceExport';
import { detectSequenceTiming } from '../pulseq/trdetect';
import { getWebviewContent } from './webviewContent';
import type { DecodedBlock, DecodedGradWaveform } from '../pulseq/types';

// ─── Constants ────────────────────────────────────────────────────────────

const VIEW_TYPE = 'seqeyes.sequenceViewer';
const MAX_DISPLAY_PTS = 500;   // downsample waveforms to ≤ 500 pts for webview

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
        let activeBlocks: DecodedBlock[] = [];
        let activeGradientRaster = 0;
        let activeRfRaster = 0;
        let activeTotalDuration = 0;
        let activePnsHardware: PnsHardware | undefined;

        const derivedNeedsCoarseFallback = (): boolean => {
            const estimate = estimateDerivedCost(activeBlocks, activeGradientRaster);
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

        // ── Core: parse, decode, compute k‑space, send ──
        const sendSequenceData = async (uri: vscode.Uri) => {
            try {
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
                postProgress('decode', 15, `Decoding ${totalBlocks} blocks\u2026`);
                const blocks = decodeAllBlocks(seq);
                activeBlocks = blocks;
                activeGradientRaster = seq.rasterTimes.gradientRaster;
                activeRfRaster = seq.rasterTimes.rfRaster;
                const totalDur = blocks.length > 0
                    ? blocks[blocks.length - 1].startTime + blocks[blocks.length - 1].duration
                    : 0;
                activeTotalDuration = totalDur;

                postProgress('kspace', 55, 'Computing k-space trajectory\u2026');
                const sequenceNotices: string[] = [];
                const kspaceEstimate = estimateKspaceCost(blocks, seq.rasterTimes.gradientRaster, totalDur);
                const kspaceMemoryEstimate = formatMemorySize(estimateKspacePeakMemoryBytes(kspaceEstimate));
                const kspaceOverBudget = (
                    kspaceEstimate.rasterSamples > INTERACTIVE_COMPUTE_LIMITS.kspaceRasterSamples
                    || kspaceEstimate.adcSamples > INTERACTIVE_COMPUTE_LIMITS.kspaceAdcSamples
                    || kspaceEstimate.gridCandidatePoints > INTERACTIVE_COMPUTE_LIMITS.kspaceGridCandidates
                );
                let ks: KSpaceData | null = null;
                let kspaceError: string | undefined;
                let kspaceSafety: string | null = null;
                if (!kspaceOverBudget) {
                    try {
                        ks = calculateKspace(
                            blocks,
                            seq.rasterTimes.gradientRaster,
                            totalDur,
                            0,
                            {
                                rfRaster: seq.rasterTimes.rfRaster,
                                maxGridPoints: INTERACTIVE_COMPUTE_LIMITS.kspaceGridCandidates,
                                maxAdcSamples: INTERACTIVE_COMPUTE_LIMITS.kspaceAdcSamples,
                            },
                        );
                    } catch (err) {
                        kspaceError = err instanceof Error ? err.message : String(err);
                    }
                }
                if (kspaceOverBudget) {
                    kspaceSafety = (
                        'K-space was not calculated because this sequence exceeds the interactive safety budget '
                        + `(${formatSampleCount(kspaceEstimate.rasterSamples)} raster samples, `
                        + `${formatSampleCount(kspaceEstimate.adcSamples)} ADC samples). `
                        + `Estimated peak memory: approximately ${kspaceMemoryEstimate} (host-dependent).`
                    );
                } else if (kspaceError) {
                    sequenceNotices.push(`K-space calculation failed: ${kspaceError}. Zoom in to inspect waveform detail.`);
                } else if (!ks) {
                    sequenceNotices.push('K-space calculation did not complete. Zoom in to inspect waveform detail.');
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


                const serialized = serializeBlocks(blocks);

                postProgress('send', 95, 'Rendering\u2026');
                panel.webview.postMessage({
                    type: 'sequenceData',
                    blocks: serialized,
                    totalDuration: totalDur,
                    gradRaster: seq.rasterTimes.gradientRaster,
                    rfRaster: seq.rasterTimes.rfRaster,
                    adcRaster: seq.rasterTimes.adcRaster,
                    blockRaster: seq.rasterTimes.blockDurationRaster,
                    kspace: ks ? serializeKSpace(ks) : null,
                    kspaceSafety,
                    timing: {
                        trTimeSec: timing.trTimeSec,
                        trCount: timing.trCount,
                        hasExplicitTR: timing.hasExplicitTR,
                        teTimeSec: timing.teTimeSec,
                        hasExplicitTE: timing.hasExplicitTE,
                        rfUseGuessed: timing.rfUseGuessed,
                    },
                    blockPositions,
                    notices: sequenceNotices,
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
                    adcCount: ks?.t_adc.length ?? 0,
                    kspaceSampleCount: ks?.t_ktraj.length ?? 0,
                    hasKspace: !!ks,
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
            } else if (msg.command === 'calculateKspaceUnsafe') {
                if (!activeBlocks.length || activeGradientRaster <= 0 || activeTotalDuration <= 0) {
                    panel.webview.postMessage({ type: 'kspaceError', message: 'No sequence is loaded.' });
                    return;
                }
                panel.webview.postMessage({ type: 'progress', phase: 'start', percent: 0, text: 'Calculating K-space without safety limits…' });
                try {
                    const kspace = calculateKspace(
                        activeBlocks,
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
            } else if (msg.command === 'calculateM1') {
                if (!activeBlocks.length || activeGradientRaster <= 0) {
                    panel.webview.postMessage({ type: 'm1Error', message: 'Load a sequence before calculating M1.' });
                    return;
                }
                const referenceMode = msg.referenceMode === 'observationTime' ? 'observationTime' : 'rfCenter';
                try {
                    const m1 = derivedNeedsCoarseFallback()
                        ? calculateM1Coarse(activeBlocks, activeGradientRaster, { referenceMode })
                        : calculateM1(activeBlocks, activeGradientRaster, { referenceMode });
                    panel.webview.postMessage({ type: 'm1Data', m1: serializeM1(m1) });
                } catch (err) {
                    try {
                        const coarse = calculateM1Coarse(activeBlocks, activeGradientRaster, { referenceMode });
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
                const referenceMode = msg.referenceMode === 'observationTime' ? 'observationTime' : 'rfCenter';
                const selected = selectM1WindowBlocks(activeBlocks, Number(msg.startSec), Number(msg.endSec));
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
                if (!activeBlocks.length || activeGradientRaster <= 0) {
                    panel.webview.postMessage({ type: 'pnsError', message: 'Load a sequence before calculating PNS.' });
                    return;
                }
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { 'Siemens ASC Profiles': ['asc'], 'All Files': ['*'] },
                    title: 'Open Siemens ASC Profile For PNS Prediction',
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
                    const hardware = parsePnsHardwareAsc(ascText);
                    activePnsHardware = hardware;
                    const pns = calculatePnsForDisplay(hardware);
                    panel.webview.postMessage({ type: 'pnsData', pns: serializePns(pns) });
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
                    activeBlocks,
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
</style></head><body><div class="e"><h2>Parse Error</h2><pre>${msg.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</pre></div></body></html>`;
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

function serializeBlocks(blocks: DecodedBlock[]): object[] {
    return blocks.map(b => {
        const o: Record<string, unknown> = { i: b.index, s: b.startTime, d: b.duration };

        if (b.rf) {
            const rawP = downsample(b.rf.phase, MAX_DISPLAY_PTS);
            o.rf = {
                s: b.rf.startTime, d: b.rf.duration,
                t: downsample(b.rf.timePoints, MAX_DISPLAY_PTS),
                m: downsample(b.rf.magnitude, MAX_DISPLAY_PTS),
                p: rawP ? rawP.map(v => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) : null,
                a: b.rf.amplitude, fo: b.rf.freqOffset, po: b.rf.phaseOffset,
                u: b.rf.use || 'u',   // 'e'=excitation, 'r'=refocusing, 'i'=inversion, 's'=saturation, 'u'=undefined
            };
        }
        if (b.gx) o.gx = serializeGrad(b.gx);
        if (b.gy) o.gy = serializeGrad(b.gy);
        if (b.gz) o.gz = serializeGrad(b.gz);

        if (b.adc) {
            o.adc = {
                s: b.adc.startTime, n: b.adc.numSamples,
                dw: b.adc.dwell, d: b.adc.delay,
                fo: b.adc.freqOffset, po: b.adc.phaseOffset,
            };
        }
        if (b.triggers?.length) {
            o.trg = b.triggers.map(t => ({ s: t.startTime, c: t.channel, d: t.delay, dr: t.duration }));
        }
        return o;
    });
}

async function readAndParseSequence(uri: vscode.Uri, didRead: () => void) {
    const fileBytes = await vscode.workspace.fs.readFile(uri);
    didRead();
    return parseSequenceBytes(fileBytes, uriFileName(uri));
}

function serializeGrad(g: DecodedGradWaveform): Record<string, unknown> {
    const display = downsampleM4(g.timePoints, g.waveform, MAX_DISPLAY_PTS);
    return {
        s: g.startTime, d: g.duration,
        t: display.time,
        w: display.values,
        a: g.amplitude, ty: g.type, ch: g.channel,
    };
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

/** Encode a Float64Array (or number[]) as a base64‑encoded Float32 blob.
 *  Uses Node's Buffer for efficient base64 conversion. */
function encodeF32B64(data: Float64Array | number[]): string {
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
