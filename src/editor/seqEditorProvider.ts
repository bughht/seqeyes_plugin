/**
 * CustomTextEditorProvider for Pulseq .seq files.
 * Renders sequence diagrams in a webview.
 */
import * as vscode from 'vscode';
import { parseSequenceText } from '../pulseq/reader';
import { decodeAllBlocks } from '../pulseq/decoder';
import { getWebviewContent } from './webviewContent';

export class SeqEditorProvider implements vscode.CustomTextEditorProvider {

    public static readonly viewType = 'seqeyes.sequenceViewer';

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new SeqEditorProvider(context);
        const providerRegistration = vscode.window.registerCustomEditorProvider(
            SeqEditorProvider.viewType,
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            }
        );
        return providerRegistration;
    }

    constructor(private readonly context: vscode.ExtensionContext) {}

    /**
     * Called when a .seq file is opened with this custom editor.
     */
    async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        // Configure webview
        webviewPanel.webview.options = {
            enableScripts: true,
        };

        // Set initial content (loading state)
        webviewPanel.webview.html = this.getLoadingHtml();

        // Parse and render the sequence
        try {
            const text = document.getText();
            const seq = parseSequenceText(text);
            const decodedBlocks = decodeAllBlocks(seq);
            const totalDuration = decodedBlocks.length > 0
                ? decodedBlocks[decodedBlocks.length - 1].startTime + decodedBlocks[decodedBlocks.length - 1].duration
                : 0;

            // Send minimal HTML first, then data via postMessage
            webviewPanel.webview.html = getWebviewContent(totalDuration);

            // Serialize blocks for webview (with downsampling for display)
            const serialized = serializeBlocksForWebview(decodedBlocks);
            webviewPanel.webview.postMessage({
                type: 'sequenceData',
                blocks: serialized,
                totalDuration,
            });

            // Update title with sequence name
            const name = seq.definitionsRaw.get('Name');
            if (name) {
                webviewPanel.title = `SeqEyes: ${name}`;
            } else {
                webviewPanel.title = 'SeqEyes Viewer';
            }
        } catch (error) {
            webviewPanel.webview.html = this.getErrorHtml(error);
        }

        // Handle messages from webview (future: export, settings, etc.)
        webviewPanel.webview.onDidReceiveMessage((message) => {
            switch (message.command) {
                case 'exportPNG':
                    // TODO: implement export
                    break;
                case 'log':
                    console.log('[SeqEyes Webview]', message.text);
                    break;
            }
        });
    }

    private getLoadingHtml(): string {
        return `<!DOCTYPE html>
<html>
<head><style>
    body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .loader { text-align: center; color: #888; }
    .spinner { width: 40px; height: 40px; border: 3px solid #e0e0e0; border-top-color: #4363d8; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
</style></head>
<body><div class="loader"><div class="spinner"></div><p>Loading sequence...</p></div></body>
</html>`;
    }

    private getErrorHtml(error: unknown): string {
        const message = error instanceof Error ? error.message : String(error);
        return `<!DOCTYPE html>
<html>
<head><style>
    body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .error { text-align: center; color: #e6194b; max-width: 600px; }
    .error h2 { margin-bottom: 8px; }
    .error pre { background: #f5f5f5; padding: 16px; border-radius: 4px; text-align: left; overflow: auto; font-size: 12px; color: #333; }
</style></head>
<body><div class="error"><h2>Failed to Parse Sequence</h2><pre>${this.escapeHtml(message)}</pre></div></body>
</html>`;
    }

    private escapeHtml(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
}

/**
 * Serialize decoded blocks for webview with display-friendly property names
 * and downsampled waveforms to keep data transfer size manageable.
 */
const MAX_DISPLAY_PTS = 500;

function serializeBlocksForWebview(blocks: import('../pulseq/types').DecodedBlock[]): any[] {
    return blocks.map(b => {
        const obj: any = {
            i: b.index,
            s: b.startTime,
            d: b.duration,
        };
        if (b.rf) {
            // Wrap phase to [0, 2π] range for display scaling
            const rawPhase = b.rf.phase ? downsample(b.rf.phase, MAX_DISPLAY_PTS) : null;
            const displayPhase = rawPhase ? rawPhase.map(v => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) : null;
            obj.rf = {
                s: b.rf.startTime,
                d: b.rf.duration,
                t: downsample(b.rf.timePoints, MAX_DISPLAY_PTS),
                m: downsample(b.rf.magnitude, MAX_DISPLAY_PTS),
                p: displayPhase,
                a: b.rf.amplitude,
                fo: b.rf.freqOffset,
                po: b.rf.phaseOffset,
            };
        }
        if (b.gx) obj.gx = serializeGradWf(b.gx);
        if (b.gy) obj.gy = serializeGradWf(b.gy);
        if (b.gz) obj.gz = serializeGradWf(b.gz);
        if (b.adc) {
            obj.adc = {
                s: b.adc.startTime,
                n: b.adc.numSamples,
                dw: b.adc.dwell,
                d: b.adc.delay,
                fo: b.adc.freqOffset,
                po: b.adc.phaseOffset,
            };
        }
        if (b.triggers) {
            obj.trg = b.triggers.map(t => ({
                s: t.startTime,
                c: t.channel,
                d: t.delay,
                dr: t.duration,
            }));
        }
        return obj;
    });
}

function serializeGradWf(g: import('../pulseq/types').DecodedGradWaveform): any {
    return {
        s: g.startTime,
        d: g.duration,
        t: downsample(g.timePoints, MAX_DISPLAY_PTS),
        w: downsample(g.waveform, MAX_DISPLAY_PTS),
        a: g.amplitude,
        ty: g.type,
        ch: g.channel,
    };
}

function downsample(arr: Float64Array | number[], maxPts: number): number[] {
    if (!arr) return [];
    const n = arr.length;
    if (n <= maxPts) return Array.from(arr);
    const step = n / maxPts;
    const result: number[] = new Array(maxPts);
    for (let i = 0; i < maxPts; i++) {
        result[i] = arr[Math.floor(i * step)];
    }
    return result;
}
