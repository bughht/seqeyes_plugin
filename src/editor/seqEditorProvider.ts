/**
 * Custom Text Editor Provider for Pulseq .seq files.
 *
 * Registered as `seqeyes.sequenceViewer` — opens automatically when the user
 * opens a `.seq` file.  The provider:
 *   1. Reads the .seq file text
 *   2. Parses it via the Pulseq reader
 *   3. Decodes waveforms via the decoder
 *   4. Sends serialised block data to the webview via postMessage
 *   5. The webview renders an interactive Canvas diagram
 */

import * as vscode from 'vscode';
import { parseSequenceText } from '../pulseq/reader';
import { decodeAllBlocks } from '../pulseq/decoder';
import { getWebviewContent } from './webviewContent';
import type { DecodedBlock, DecodedGradWaveform } from '../pulseq/types';

declare var console: any;

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

        try {
            const seq = parseSequenceText(doc.getText());
            const blocks = decodeAllBlocks(seq);
            const totalDur = blocks.length > 0
                ? blocks[blocks.length - 1].startTime + blocks[blocks.length - 1].duration
                : 0;

            panel.webview.html = getWebviewContent(totalDur);
            panel.webview.postMessage({
                type: 'sequenceData',
                blocks: serializeBlocks(blocks),
                totalDuration: totalDur,
            });

            const name = seq.definitionsRaw.get('Name');
            panel.title = name ? `SeqEyes: ${name}` : 'SeqEyes Viewer';
        } catch (err) {
            panel.webview.html = this._errorHtml(err);
        }

        panel.webview.onDidReceiveMessage(msg => {
            if (msg.command === 'log') console.log('[SeqEyes]', msg.text);
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
