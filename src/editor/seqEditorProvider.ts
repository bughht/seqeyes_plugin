/**
 * Custom Text Editor Provider for Pulseq .seq files.
 *
 * Registered as `seqeyes.sequenceViewer` — opens automatically when the user
 * opens a `.seq` file.  The provider:
 *   1. Reads the .seq file text
 *   2. Parses it via the Pulseq reader
 *   3. Detects TE/TR timing (from definitions or RF‑pulse estimation)
 *   4. Decodes all waveforms via the decoder
 *   5. Computes k‑space trajectory
 *   6. Sends serialised block data + timing metadata to the webview
 *   7. The webview renders an interactive Canvas diagram with minimap
 */

import * as vscode from 'vscode';
import { parseSequenceText } from '../pulseq/reader';
import { decodeAllBlocks } from '../pulseq/decoder';
import { calculateKspace, type KSpaceData } from '../pulseq/kspace';
import { detectSequenceTiming } from '../pulseq/trdetect';
import { getWebviewContent } from './webviewContent';
import type { DecodedBlock, DecodedGradWaveform } from '../pulseq/types';

// ─── Constants ────────────────────────────────────────────────────────────

const VIEW_TYPE = 'seqeyes.sequenceViewer';
const MAX_DISPLAY_PTS = 500;   // downsample waveforms to ≤ 500 pts for webview

// ─── Provider class ───────────────────────────────────────────────────────

export class SeqEditorProvider implements vscode.CustomTextEditorProvider {

    /** Register the provider with VS Code. */
    static register(ctx: vscode.ExtensionContext): vscode.Disposable {
        return vscode.window.registerCustomEditorProvider(VIEW_TYPE, new SeqEditorProvider(ctx), {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: false,
        });
    }

    constructor(private readonly _ctx: vscode.ExtensionContext) { }

    // ── resolveCustomTextEditor ──────────────────────────────────────

    async resolveCustomTextEditor(
        doc: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        panel.webview.options = { enableScripts: true };
        panel.webview.html = this._loadingHtml();

        // ── Core: parse, decode, compute k‑space, send ──
        const sendSequenceData = async (uri: vscode.Uri) => {
            const postProgress = (phase: string, percent: number, text: string) => {
                panel.webview.postMessage({ type: 'progress', phase, percent, text });
            };

            postProgress('start', 0, 'Reading file\u2026');
            const text = (await vscode.workspace.fs.readFile(uri)).toString();

            postProgress('parse', 5, 'Parsing Pulseq sequence\u2026');
            const seq = parseSequenceText(text);

            postProgress('timing', 10, 'Detecting TR/TE timing\u2026');
            const timing = detectSequenceTiming(seq);

            const totalBlocks = seq.blocks.length;
            postProgress('decode', 15, `Decoding ${totalBlocks} blocks\u2026`);
            const blocks = decodeAllBlocks(seq);
            const totalDur = blocks.length > 0
                ? blocks[blocks.length - 1].startTime + blocks[blocks.length - 1].duration
                : 0;

            postProgress('kspace', 55, 'Computing k-space trajectory\u2026');
            const ks = calculateKspace(
                blocks,
                seq.rasterTimes.gradientRaster,
                totalDur,
            );

            postProgress('serialize', 85, 'Preparing data for display\u2026');
            // Build lightweight block‑position array for the minimap
            const blockPositions = seq.blocks.map((b, i) => {
                let cum = 0;
                for (let j = 0; j < i; j++) cum += seq.blocks[j].dur * seq.rasterTimes.blockDurationRaster;
                return { i: b.num, s: cum, d: b.dur * seq.rasterTimes.blockDurationRaster };
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
                timing: {
                    trTimeSec: timing.trTimeSec,
                    trCount: timing.trCount,
                    hasExplicitTR: timing.hasExplicitTR,
                    teTimeSec: timing.teTimeSec,
                    hasExplicitTE: timing.hasExplicitTE,
                    rfUseGuessed: timing.rfUseGuessed,
                },
                blockPositions,
            });

            postProgress('done', 100, 'Ready');
            const name = seq.definitionsRaw.get('Name') || uri.path.split(/[\\/]/).pop() || 'SeqEyes Viewer';
            panel.title = `SeqEyes: ${name.replace(/\.seq$/i, '')}`;
        };

        // ── Initial load: validate, set full UI, show progress, then send data ──
        try {
            parseSequenceText((await vscode.workspace.fs.readFile(doc.uri)).toString());
            panel.webview.html = getWebviewContent(0);
            // Give the webview a moment to parse its new HTML, then start progress
            panel.webview.postMessage({ type: 'progress', phase: 'start', percent: 0, text: 'Preparing\u2026' });
            await sendSequenceData(doc.uri);
        } catch (err) {
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
                    filters: { 'Pulseq Sequences': ['seq'] },
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
            }
        });
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

function serializeGrad(g: DecodedGradWaveform): Record<string, unknown> {
    return {
        s: g.startTime, d: g.duration,
        t: downsample(g.timePoints, MAX_DISPLAY_PTS),
        w: downsample(g.waveform, MAX_DISPLAY_PTS),
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
