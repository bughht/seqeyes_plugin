/**
 * SeqEyes Plugin — VS Code Extension Entry Point
 *
 * Registers:
 *   • Custom editor for .seq/.bseq files (seqeyes.sequenceViewer)
 *   • Hello World command           (seqeyes.helloWorld)
 *   • Open Sequence Viewer command  (seqeyes.openSequenceViewer)
 *   • Status‑bar indicator          (pulse icon)
 */

import * as vscode from 'vscode';
import {
    SeqEditorProvider,
    computeSpectrogramForTest,
    synthesizeGradientSoundForTest,
    exportKspaceToDirectoryForTest,
    loadAscProfileForTest,
    getSeqEyesDiagnosticState,
    rememberAscUri,
    rememberedAscUri,
    resetSeqEyesDiagnosticState,
} from './editor/seqEditorProvider';

/** Called when the extension is activated. */
export function activate(context: vscode.ExtensionContext): void {
    // ── Custom editor for Pulseq sequence files ──
    context.subscriptions.push(SeqEditorProvider.register(context));

    // ── Commands ──
    context.subscriptions.push(
        vscode.commands.registerCommand('seqeyes.helloWorld', () => {
            vscode.window.showInformationMessage('🎉 SeqEyes Plugin — MRI sequence viewer ready.');
        }),
        vscode.commands.registerCommand('seqeyes.openSequenceViewer', async (uri?: vscode.Uri) => {
            if (!uri) {
                uri = getActiveSequenceUri();
            }
            if (uri) {
                await vscode.commands.executeCommand('vscode.openWith', uri, 'seqeyes.sequenceViewer');
            } else {
                vscode.window.showWarningMessage('No .seq or .bseq file selected.');
            }
        }),
    );

    // ── Status bar ──
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    status.command = 'seqeyes.helloWorld';
    status.text = '$(pulse) SeqEyes';
    status.tooltip = 'SeqEyes Plugin — MRI Sequence Viewer';
    status.show();
    context.subscriptions.push(status);

    if (process.env.SEQEYES_TEST_MODE === '1') {
        context.subscriptions.push(
            vscode.commands.registerCommand('seqeyes.test.getState', () => getSeqEyesDiagnosticState()),
            vscode.commands.registerCommand('seqeyes.test.resetState', () => resetSeqEyesDiagnosticState()),
            vscode.commands.registerCommand(
                'seqeyes.test.computeSpectrogram',
                async (sourceUri: vscode.Uri, startSec: number, endSec: number, params?: Record<string, unknown>) =>
                    await computeSpectrogramForTest(sourceUri, startSec, endSec, params),
            ),
            vscode.commands.registerCommand(
                'seqeyes.test.synthesizeGradientSound',
                async (sourceUri: vscode.Uri, startSec: number, endSec: number, options?: Record<string, unknown>) =>
                    await synthesizeGradientSoundForTest(sourceUri, startSec, endSec, options),
            ),
            vscode.commands.registerCommand(
                'seqeyes.test.loadAscProfile',
                async (sourceUri: vscode.Uri) => await loadAscProfileForTest(sourceUri),
            ),
            // Reads and writes the remembered ASC path the way the picker and
            // the restore path do, so the round trip is testable without
            // driving a native file dialog.
            vscode.commands.registerCommand(
                'seqeyes.test.ascMemory',
                async (next?: vscode.Uri | null) => {
                    if (next !== undefined) await rememberAscUri(context.globalState, next ?? undefined);
                    return rememberedAscUri(context.globalState)?.toString();
                },
            ),
            vscode.commands.registerCommand(
                'seqeyes.test.exportKspace',
                async (sourceUri: vscode.Uri, outputDir: vscode.Uri) => {
                    const pkg = context.extension.packageJSON as { version?: unknown };
                    const packageVersion = typeof pkg.version === 'string' ? pkg.version : 'unknown';
                    return await exportKspaceToDirectoryForTest(sourceUri, outputDir, packageVersion);
                },
            ),
        );
    }

    console.log('SeqEyes Plugin activated');
}

/** Called when the extension is deactivated. */
export function deactivate(): void {
    console.log('SeqEyes Plugin deactivated');
}

function getActiveSequenceUri(): vscode.Uri | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor && isSequencePath(editor.document.fileName)) {
        return editor.document.uri;
    }

    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputText && isSequencePath(input.uri.path)) {
        return input.uri;
    }
    if (input instanceof vscode.TabInputCustom && isSequencePath(input.uri.path)) {
        return input.uri;
    }

    return undefined;
}

function isSequencePath(path: string): boolean {
    return /\.(?:seq|bseq)$/i.test(path);
}
