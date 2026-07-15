const assert = require('node:assert/strict');
const path = require('node:path');

const vscode = require('vscode');

async function run() {
  const workspacePath = process.env.SEQEYES_TEST_WORKSPACE;
  assert.ok(workspacePath, 'SEQEYES_TEST_WORKSPACE should be set by the test runner');

  const epiUri = vscode.Uri.file(path.join(workspacePath, 'writeEpi.seq'));
  const spiralUri = vscode.Uri.file(path.join(workspacePath, 'spiral_inout.seq'));
  const binaryUri = vscode.Uri.file(path.join(workspacePath, 'gre.bseq'));
  const invalidUri = vscode.Uri.file(path.join(workspacePath, 'invalid.seq'));
  const invalidBinaryUri = vscode.Uri.file(path.join(workspacePath, 'invalid.bseq'));
  const exportDir = vscode.Uri.file(path.join(workspacePath, 'exports'));

  await step('activate extension', async () => {
    const extension = vscode.extensions.all.find((item) => item.packageJSON?.name === 'seqeyes-web');
    assert.ok(extension, 'SeqEyes extension should be discoverable by package name');
    await extension.activate();
    assert.equal(extension.isActive, true);
    await vscode.commands.executeCommand('seqeyes.test.resetState');
  });

  await step('open valid fixture with custom editor', async () => {
    await vscode.commands.executeCommand('vscode.openWith', epiUri, 'seqeyes.sequenceViewer');
    const load = await waitForLoad(epiUri);
    assertLoadState(load, 'writeEpi.seq');
  });

  await step('open another fixture through SeqEyes command', async () => {
    await vscode.commands.executeCommand('seqeyes.openSequenceViewer', spiralUri);
    const load = await waitForLoad(spiralUri);
    assertLoadState(load, 'spiral_inout.seq');
    assert.ok(load.adcCount > 1000, 'spiral fixture should expose ADC samples');
  });

  await step('export k-space artifacts without native save dialog', async () => {
    await vscode.workspace.fs.createDirectory(exportDir);
    const result = await vscode.commands.executeCommand('seqeyes.test.exportKspace', spiralUri, exportDir);
    assert.ok(result, 'export command should return artifact metadata');
    assert.ok(result.ktrajAdcUri.endsWith('spiral_inout_ktraj_adc.txt'));
    assert.ok(result.metadataUri.endsWith('spiral_inout_metadata.json'));
    assert.ok(result.adcSampleCount > 1000, 'export result should include ADC samples');

    const trajectoryText = await readText(vscode.Uri.parse(result.ktrajAdcUri));
    const metadataText = await readText(vscode.Uri.parse(result.metadataUri));
    const metadata = JSON.parse(metadataText);
    const trajectoryLines = trajectoryText.trim().split(/\r?\n/);
    assert.equal(trajectoryLines.length, result.adcSampleCount);
    assert.match(trajectoryLines[0], /^[-+0-9.eE]+\s+[-+0-9.eE]+\s+[-+0-9.eE]+$/);
    assert.equal(metadata.adcSampleCount, result.adcSampleCount);
    assert.equal(metadata.sequenceName, 'spiral_inout.seq');
  });

  await step('open and export an official binary Pulseq fixture', async () => {
    await vscode.commands.executeCommand('vscode.openWith', binaryUri, 'seqeyes.sequenceViewer');
    const load = await waitForLoad(binaryUri);
    assertLoadState(load, 'gre.bseq');
    assert.equal(load.blockCount, 320);
    assert.equal(load.adcCount, 4096);

    const result = await vscode.commands.executeCommand('seqeyes.test.exportKspace', binaryUri, exportDir);
    assert.ok(result.ktrajAdcUri.endsWith('gre_ktraj_adc.txt'));
    assert.ok(result.metadataUri.endsWith('gre_metadata.json'));
    assert.equal(result.adcSampleCount, 4096);
    const metadata = JSON.parse(await readText(vscode.Uri.parse(result.metadataUri)));
    assert.equal(metadata.sequenceName, 'gre.bseq');
    assert.equal(metadata.adcSampleCount, 4096);
  });

  await step('invalid fixture reports parse error without crashing host', async () => {
    await vscode.commands.executeCommand('vscode.openWith', invalidUri, 'seqeyes.sequenceViewer');
    const error = await waitForError(invalidUri);
    assert.match(error.message, /VERSION|Pulseq|section|sequence|parse|required/i);
  });

  await step('invalid binary fixture reports its missing header', async () => {
    await vscode.commands.executeCommand('vscode.openWith', invalidBinaryUri, 'seqeyes.sequenceViewer');
    const error = await waitForError(invalidBinaryUri);
    assert.match(error.message, /binary header|bseq|Pulseq/i);
  });

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

async function step(name, fn) {
  console.log(`[SeqEyes VS Code E2E] ${name}`);
  await fn();
}

async function waitForLoad(uri, timeoutMs = 60_000) {
  return await waitForState((state) => {
    if (state.lastError?.activeUri === uri.toString()) {
      throw new Error(`Expected ${uri.toString()} to load, but it failed: ${state.lastError.message}`);
    }
    return state.lastLoad?.activeUri === uri.toString() ? state.lastLoad : undefined;
  }, `load state for ${uri.toString()}`, timeoutMs);
}

async function waitForError(uri, timeoutMs = 30_000) {
  return await waitForState((state) => {
    return state.lastError?.activeUri === uri.toString() ? state.lastError : undefined;
  }, `error state for ${uri.toString()}`, timeoutMs);
}

async function waitForState(selector, description, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await vscode.commands.executeCommand('seqeyes.test.getState');
    const selected = selector(state || {});
    if (selected) return selected;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function assertLoadState(load, expectedName) {
  assert.equal(load.sequenceName, expectedName);
  assert.ok(load.panelTitle.includes('SeqEyes:'), 'panel title should identify SeqEyes');
  assert.ok(load.blockCount > 0, 'block count should be positive');
  assert.ok(load.totalDuration > 0, 'total duration should be positive');
  assert.ok(load.adcCount > 0, 'ADC count should be positive');
  assert.ok(load.kspaceSampleCount > 0, 'k-space sample count should be positive');
  assert.equal(load.hasKspace, true);
  assert.equal(load.hasTiming, true);
}

async function readText(uri) {
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { run };
