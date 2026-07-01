/**
 * SeqEyes Plugin — VS Code Extension Entry Point
 *
 * Registers:
 *   • Custom editor for .seq files  (seqeyes.sequenceViewer)
 *   • Hello World command           (seqeyes.helloWorld)
 *   • Open Sequence Viewer command  (seqeyes.openSequenceViewer)
 *   • Status‑bar indicator          (pulse icon)
 */

import * as vscode from 'vscode';
import { SeqEditorProvider } from './editor/seqEditorProvider';

/** Called when the extension is activated. */
export function activate(context: vscode.ExtensionContext): void {
    // ── Custom editor for .seq files ──
    context.subscriptions.push(SeqEditorProvider.register(context));

    // ── Commands ──
    context.subscriptions.push(
        vscode.commands.registerCommand('seqeyes.helloWorld', () => {
            vscode.window.showInformationMessage('🎉 SeqEyes Plugin — MRI sequence viewer ready.');
        }),
        vscode.commands.registerCommand('seqeyes.openSequenceViewer', async (uri?: vscode.Uri) => {
            if (!uri) {
                const editor = vscode.window.activeTextEditor;
                if (editor?.document.fileName.endsWith('.seq')) uri = editor.document.uri;
            }
            if (uri) {
                await vscode.commands.executeCommand('vscode.openWith', uri, 'seqeyes.sequenceViewer');
            } else {
                vscode.window.showWarningMessage('No .seq file selected.');
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

    console.log('SeqEyes Plugin activated');
}

/** Called when the extension is deactivated. */
export function deactivate(): void {
    console.log('SeqEyes Plugin deactivated');
}
