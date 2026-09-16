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
  const combinedAscUri = vscode.Uri.file(path.join(workspacePath, 'combined.asc'));
  const acousticAscUri = vscode.Uri.file(path.join(workspacePath, 'acoustic_only.asc'));
  const pnsAscUri = vscode.Uri.file(path.join(workspacePath, 'pns_only.asc'));
  const emptyAscUri = vscode.Uri.file(path.join(workspacePath, 'empty.asc'));

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

  await step('compute a gradient spectrogram over a view window', async () => {
    // The command reads the sequence itself, exactly as the message handler
    // does; re-opening an already-open editor would not re-fire a load anyway.
    const result = await vscode.commands.executeCommand(
      'seqeyes.test.computeSpectrogram', spiralUri, 0, 0.2, { fMaxHz: 3000 },
    );
    assert.ok(result, 'spectrogram command should return a summary');
    assert.ok(result.nTime > 1, 'spectrogram should have multiple time columns');
    assert.ok(result.nFreq > 1, 'spectrogram should have multiple frequency bins');
    assert.equal(result.unit, 'mT/m');
    assert.ok(result.decimationFactor > 1, 'anti-aliased decimation should be in effect');
    assert.ok(result.maxValue > 0, 'spiral fixture should carry gradient energy');
    // Column centres stay inside the requested window.
    assert.ok(result.tStartSec >= 0, 'first column should start inside the window');
    assert.ok(result.tStartSec + (result.nTime - 1) * result.tStepSec <= 0.2 + 1e-9,
      'last column should end inside the window');
    // The base64 transport is what keeps this deliverable over postMessage.
    assert.ok(result.payloadBytes < 8 * 1024 * 1024, 'serialized spectrogram should stay well under the JSON ceiling');

    const state = await vscode.commands.executeCommand('seqeyes.test.getState');
    assert.equal(state.lastError, undefined, 'spectrogram compute should not record an extension-host error');
  });

  await step('reports a quiet window as quiet rather than averaging it away', async () => {
    // spiral_inout has a long TR: 0-0.2 s carries the readout, 0.2-1.0 s is
    // silent. A whole-sequence average would blend the two; a view-windowed
    // spectrogram must show the gap as a gap. This is the feature’s premise.
    const quiet = await vscode.commands.executeCommand(
      'seqeyes.test.computeSpectrogram', spiralUri, 0.2, 0.4, { fMaxHz: 3000 },
    );
    assert.ok(quiet.nTime > 1, 'a quiet window still has columns');
    assert.equal(quiet.maxValue, 0, 'a quiet window must read as zero energy');
    assert.ok(quiet.warnings.some((warning) => /No gradient activity/.test(warning)),
      'the empty window should say so');
  });

  await step('declines a window shorter than one analysis window', async () => {
    // View-scoped work gets no dangerous override: the remedy is always to
    // zoom, so this returns an explained empty result rather than throwing.
    let error;
    const result = await vscode.commands.executeCommand(
      'seqeyes.test.computeSpectrogram', spiralUri, 0, 0.0001, { fMaxHz: 3000 },
    ).catch((err) => { error = err; return undefined; });
    assert.equal(error, undefined, 'a too-short window should not throw');
    assert.ok(result, 'a too-short window should still return a summary');
    assert.equal(result.nTime, 0, 'a window shorter than one analysis window has no columns');
    assert.ok(result.warnings.length > 0, 'the refusal should be explained in warnings');
  });

  await step('load ASC profiles with independent PNS and acoustic outcomes', async () => {
    const combined = await vscode.commands.executeCommand(
      'seqeyes.test.loadAscProfile', combinedAscUri);
    assert.equal(combined.hasPns, true);
    assert.equal(combined.acousticCount, 2);
    assert.equal(combined.notice, undefined, 'a complete profile needs no notice');

    const acoustic = await vscode.commands.executeCommand(
      'seqeyes.test.loadAscProfile', acousticAscUri);
    assert.equal(acoustic.hasPns, false, 'acoustic-only ASC has no PNS coefficients');
    assert.equal(acoustic.acousticCount, 3, 'acoustic bands must survive the PNS failure');
    assert.match(acoustic.notice, /PNS coefficients are missing/);

    const pnsOnly = await vscode.commands.executeCommand(
      'seqeyes.test.loadAscProfile', pnsAscUri);
    assert.equal(pnsOnly.hasPns, true);
    assert.equal(pnsOnly.acousticCount, 0);
    assert.match(pnsOnly.notice, /no acoustic resonance table/);

    const empty = await vscode.commands.executeCommand(
      'seqeyes.test.loadAscProfile', emptyAscUri);
    assert.equal(empty.hasPns, false);
    assert.equal(empty.acousticCount, 0);
    assert.match(empty.notice, /neither PNS coefficients nor acoustic resonances/);
  });

  await step('remember the ASC profile across sessions, by path', async () => {
    const ascMemory = (next) => vscode.commands.executeCommand('seqeyes.test.ascMemory', next);

    await ascMemory(null);
    assert.equal(await ascMemory(), undefined, 'nothing is remembered until a profile is picked');

    await ascMemory(combinedAscUri);
    assert.equal(await ascMemory(), combinedAscUri.toString(),
      'the picked profile should come back as the same URI');

    // Only a path is kept, so the file stays the source of truth and an edited
    // profile takes effect the next time a sequence is opened.
    const reread = await vscode.commands.executeCommand(
      'seqeyes.test.loadAscProfile', vscode.Uri.parse(await ascMemory()));
    assert.equal(reread.hasPns, true);
    assert.equal(reread.acousticCount, 2);

    await ascMemory(null);
    assert.equal(await ascMemory(), undefined, 'clearing the memory should leave nothing behind');
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
  assert.equal(load.kspaceSampleCount, 0, 'initial load should not calculate k-space');
  assert.equal(load.hasKspace, false);
  assert.equal(load.hasTiming, true);
}

async function readText(uri) {
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { run };
