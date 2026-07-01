import * as vscode from 'vscode';
import { SeqEditorProvider } from './editor/seqEditorProvider';

/**
 * Entry point for the SeqEyes Plugin VS Code extension.
 *
 * This extension provides a custom editor for Pulseq .seq files,
 * allowing users to visualize MRI sequence diagrams, k-space trajectories,
 * and gradient moments directly within VS Code.
 */
export function activate(context: vscode.ExtensionContext) {
    // console.log('SeqEyes Plugin is now active!');

    // ================================================================
    // Register Custom Editor for .seq files
    // ================================================================
    context.subscriptions.push(SeqEditorProvider.register(context));

    // ================================================================
    // Hello World Command
    // ================================================================
    const helloWorldCmd = vscode.commands.registerCommand(
        'seqeyes.helloWorld',
        () => {
            vscode.window.showInformationMessage(
                '🎉 Hello from SeqEyes Plugin! Your MRI sequence viewer is ready.'
            );
        }
    );

    // ================================================================
    // Open Sequence Viewer Command
    // ================================================================
    const openViewerCmd = vscode.commands.registerCommand(
        'seqeyes.openSequenceViewer',
        async (uri?: vscode.Uri) => {
            // If no URI was passed (e.g., from command palette),
            // try to use the active editor's document
            if (!uri) {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && activeEditor.document.fileName.endsWith('.seq')) {
                    uri = activeEditor.document.uri;
                }
            }

            if (!uri) {
                vscode.window.showWarningMessage(
                    'No .seq file selected. Please open a .seq file first.'
                );
                return;
            }

            // Open the file with our custom editor
            await vscode.commands.executeCommand(
                'vscode.openWith',
                uri,
                'seqeyes.sequenceViewer'
            );
        }
    );

    // ================================================================
    // Status Bar Item
    // ================================================================
    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.command = 'seqeyes.helloWorld';
    statusBarItem.text = '$(pulse) SeqEyes';
    statusBarItem.tooltip = 'SeqEyes Plugin — MRI Sequence Viewer';
    statusBarItem.show();

    // Register all disposables
    context.subscriptions.push(helloWorldCmd);
    context.subscriptions.push(openViewerCmd);
    context.subscriptions.push(statusBarItem);
}

/**
 * Called when the extension is deactivated.
 */
export function deactivate() {
    // console.log('SeqEyes Plugin deactivated.');
}
