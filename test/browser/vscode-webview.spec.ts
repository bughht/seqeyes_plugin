/**
 * The VS Code webview half of the viewport detail contract.
 *
 * standalone-viewer.spec.ts drives web/index.html, which is a different page:
 * it re-declares the renderer inside its own IIFE and talks to an in-heap
 * packer.  The extension's webview runs the shared bundle against messages
 * from another process, and that round trip had no coverage — the failure it
 * is meant to catch is a payload the renderer accepts but cannot draw.
 *
 * There is deliberately no debug hook here.  This asserts what is observable
 * from outside: which messages the webview posts, and that a reply changes
 * what is on the canvas.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { packSequenceBlocks } from '../../src/editor/blockTransport';
import { buildWaveformDetailReply, waveformDetailMessage } from '../../src/editor/waveformDetailReply';
import { serializeKSpace } from '../../src/editor/kspaceTransport';
import { serializeGradientSound } from '../../src/editor/spectrogramTransport';
import { synthesizeGradientSound } from '../../src/pulseq/gradientSound';
import { resolveDetailBlockRange } from '../../src/editor/blockTransport';
import { serializeLabelTable, type SerializedLabelTable } from '../../src/editor/labelTransport';
import { evaluateAdcLabels, listSequenceLabels } from '../../src/pulseq/labels';
import { createSequenceDecodeContext, decodeAllBlocks, decodeBlockRange, getTotalDuration } from '../../src/pulseq/decoder';
import { calculateKspace } from '../../src/pulseq/kspace';
import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';
import { detectSequenceTiming } from '../../src/pulseq/trdetect';

const FIXTURE = resolve('test/seq/spiral_inout.seq');
const OUT = resolve('out/editor/webview/assets');

const b64 = (buffer: ArrayBuffer): string => Buffer.from(new Uint8Array(buffer)).toString('base64');

function loadSequence() {
  const seq = parseSequenceBytes(new Uint8Array(readFileSync(FIXTURE)), 'spiral_inout.seq');
  return { seq, context: createSequenceDecodeContext(seq) };
}

/** Assemble exactly what getWebviewContent() serves, minus the vscode host. */
async function openWebview(page: Page): Promise<void> {
  const css = readFileSync(resolve(OUT, 'styles.css'), 'utf8');
  const body = readFileSync(resolve(OUT, 'template.html'), 'utf8');
  const bundle = readFileSync(resolve(OUT, 'webview-bundle.js'), 'utf8');
  // The stub has to exist before the bundle runs, since it captures the API
  // once at load; an init script does not apply to setContent.
  const host = `window.__posted=[];window.acquireVsCodeApi=function(){return{`
    + `postMessage:function(m){window.__posted.push(m);},`
    + `getState:function(){},setState:function(){}};};`;
  await page.setContent(
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">`
    + `<script>${host}</script><style>${css}</style></head>`
    + `<body>${body}<script>(function(){${bundle}})();</script></body></html>`,
    { waitUntil: 'load' },
  );
}

/** Post the extension's message verbatim, moving its buffers across as base64. */
async function postExtensionMessage(page: Page, message: Record<string, unknown>) {
  const plain: Record<string, unknown> = {};
  const buffers: Record<string, string> = {};
  for (const [key, value] of Object.entries(message)) {
    if (value instanceof ArrayBuffer) buffers[key] = b64(value);
    else plain[key] = value;
  }
  await post(page, plain, buffers);
}

/** Deliver a message the way VS Code does, rebuilding buffers inside the page. */
async function post(page: Page, message: Record<string, unknown>, buffers: Record<string, string> = {}) {
  await page.evaluate(({ msg, bufs }) => {
    const decode = (s: string) => {
      const bin = atob(s);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes.buffer;
    };
    const payload = { ...msg } as Record<string, unknown>;
    for (const [key, value] of Object.entries(bufs)) payload[key] = decode(value);
    window.dispatchEvent(new MessageEvent('message', { data: payload }));
  }, { msg: message, bufs: buffers });
}

const posted = (page: Page) => page.evaluate(() => (window as unknown as { __posted: Record<string, unknown>[] }).__posted);
const canvasShot = (page: Page) => page.locator('#mc').screenshot();

test('consumes exact detail and a band over the extension message contract', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', e => failures.push(e.message));
  page.on('console', m => { if (m.type() === 'error') failures.push(m.text()); });

  const { seq, context } = loadSequence();
  const packed = packSequenceBlocks(seq);
  await openWebview(page);

  await post(page, {
    type: 'sequenceData',
    sequenceGeneration: 1,
    blocks: packed.blocks,
    sampleCount: packed.sampleCount,
    totalDuration: getTotalDuration(seq),
    gradRaster: seq.rasterTimes.gradientRaster,
    rfRaster: seq.rasterTimes.rfRaster,
    adcRaster: seq.rasterTimes.adcRaster,
    blockRaster: seq.rasterTimes.blockDurationRaster,
    timing: detectSequenceTiming(seq),
    notices: [],
  }, { sampleTimes: b64(packed.sampleTimes), sampleValues: b64(packed.sampleValues) });

  // Wait for this specific command rather than for any message at all: the
  // webview also posts unrelated ones on load, and a bare length check passes
  // on whichever happens to arrive first.
  await expect.poll(
    async () => (await posted(page)).some(m => m.command === 'requestWaveformDetail'),
    { timeout: 10_000 },
  ).toBe(true);
  const request = (await posted(page)).find(m => m.command === 'requestWaveformDetail');
  expect(request, 'the webview must ask for detail once a sequence is loaded').toBeTruthy();
  // It must ask for the window it is showing, and for columns to draw it with.
  expect(Number(request!.sequenceGeneration)).toBe(1);
  expect(Number(request!.endSec)).toBeGreaterThan(Number(request!.startSec));
  // Regression: this field was dropped by the extension adapter, which left the
  // provider building every band from a single column.
  expect(Number(request!.columns)).toBeGreaterThan(100);

  // The webview also asks the host to re-apply the ASC profile it remembered
  // from a previous session; it can only do that once a sequence has landed,
  // because PNS needs the sequence's blocks.
  await expect.poll(
    async () => (await posted(page)).some(m => m.command === 'restoreAsc'),
    { timeout: 10_000 },
  ).toBe(true);

  const before = await canvasShot(page);

  // Answer with what the extension would actually send: the same decision
  // function the provider delegates to, on the window the webview asked for.
  const startSec = Number(request!.startSec);
  const endSec = Number(request!.endSec);
  const columns = Number(request!.columns);
  const detailReply = buildWaveformDetailReply(seq, context, { startSec, endSec, columns }, 1);
  expect(detailReply.kind, 'a TR-scale window should be answered with samples').toBe('samples');
  if (detailReply.kind !== 'samples') throw new Error('unreachable');
  await postExtensionMessage(
    page, waveformDetailMessage(detailReply, Number(request!.requestId), 1),
  );

  await expect.poll(async () => (await canvasShot(page)).equals(before) === false, { timeout: 5_000 }).toBe(true);
  const afterDetail = await canvasShot(page);

  // And with a band, by asking the same function for a window wide enough that
  // it chooses one — so the payload shape is the extension's, not the test's.
  const total = getTotalDuration(seq);
  const bandReply = buildWaveformDetailReply(seq, context, { startSec: 0, endSec: total, columns }, 1);
  expect(bandReply.kind, 'the whole sequence should be answered with a band').toBe('band');
  if (bandReply.kind !== 'band') throw new Error('unreachable');
  expect(bandReply.columns).toBeGreaterThan(100);
  await postExtensionMessage(
    page, waveformDetailMessage(bandReply, Number(request!.requestId), 1),
  );

  await expect.poll(async () => (await canvasShot(page)).equals(afterDetail) === false, { timeout: 5_000 }).toBe(true);

  // A refusal must be absorbed quietly rather than blanking the viewer.
  await postExtensionMessage(page, waveformDetailMessage(
    { kind: 'unavailable', startSec, endSec }, Number(request!.requestId), 1,
  ));
  await expect(page.locator('#mc')).toBeVisible();
  expect(failures).toEqual([]);
});

/**
 * K-space replies cross the same process boundary as the waveform samples.
 *
 * The failure these cover is a reply the webview accepts but cannot draw: a
 * `kspaceData` message whose ADC arrays did not survive the trip cleared the
 * safety notice — the viewer's only record that a calculation was running —
 * and left a blank k-space panel, which reads as "this sequence has no
 * k-space" rather than "the trajectory never arrived".
 */
test.describe('k-space reply contract', () => {
  const SAFETY = 'This sequence needs an estimated 2.6 GiB to calculate K-space.';

  /** Load a sequence that carries a safety warning, so the notice is showing. */
  async function loadWithSafetyNotice(page: Page) {
    const { seq } = loadSequence();
    const packed = packSequenceBlocks(seq);
    await openWebview(page);
    await post(page, {
      type: 'sequenceData',
      sequenceGeneration: 1,
      blocks: packed.blocks,
      sampleCount: packed.sampleCount,
      totalDuration: getTotalDuration(seq),
      gradRaster: seq.rasterTimes.gradientRaster,
      rfRaster: seq.rasterTimes.rfRaster,
      adcRaster: seq.rasterTimes.adcRaster,
      blockRaster: seq.rasterTimes.blockDurationRaster,
      timing: detectSequenceTiming(seq),
      kspaceSafety: SAFETY,
      notices: [],
    }, { sampleTimes: b64(packed.sampleTimes), sampleValues: b64(packed.sampleValues) });
    await expect(page.locator('#viewerNoticeList')).toContainText('2.6 GiB');
    return seq;
  }

  const noticeText = (page: Page) => page.locator('#viewerNoticeList').innerText();

  /**
   * Count the red pixels of the panel's "NO ADC data" glyph.
   *
   * This is the one thing the k-space panel says out loud when it has a
   * trajectory but no ADC samples to plot, so it is what distinguishes a
   * drawn trajectory from the blank panel the lost payload produced.
   */
  const noAdcGlyphPixels = (page: Page) => page.evaluate(() => {
    const canvas = document.getElementById('kc') as HTMLCanvasElement | null;
    if (!canvas || !canvas.width || !canvas.height) return -1;
    const width = Math.min(120, canvas.width);
    const height = Math.min(30, canvas.height);
    const data = canvas.getContext('2d')?.getImageData(0, 0, width, height).data;
    if (!data) return -1;
    let red = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 0 && data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60) red++;
    }
    return red;
  });

  test('draws a trajectory the extension serialized', async ({ page }) => {
    const failures: string[] = [];
    page.on('pageerror', e => failures.push(e.message));

    const seq = await loadWithSafetyNotice(page);
    const ks = calculateKspace(
      decodeAllBlocks(seq), seq.rasterTimes.gradientRaster, getTotalDuration(seq), 0,
      { rfRaster: seq.rasterTimes.rfRaster },
    );
    expect(ks, 'the spiral fixture should produce a trajectory').toBeTruthy();
    const payload = serializeKSpace(ks!);
    // The ADC samples must leave the host as binary, not as base64 in the JSON
    // envelope: that envelope was a single 59 MiB string for a large sequence.
    expect(payload.adcX).toBeInstanceOf(ArrayBuffer);
    expect(payload.nAdc).toBeGreaterThan(1000);

    await postKspace(page, payload);

    // Success clears the safety notice, and the ADC samples reach the viewer.
    await expect.poll(async () => await noticeText(page)).not.toContain('2.6 GiB');
    expect(await noticeText(page)).not.toContain('failed');
    // And the panel plots them rather than reporting that it has none.
    await expect.poll(async () => await noAdcGlyphPixels(page), { timeout: 5_000 })
      .toBe(0);
    expect(failures).toEqual([]);
  });

  test('reports a reply whose ADC samples did not arrive', async ({ page }) => {
    const seq = await loadWithSafetyNotice(page);
    const ks = calculateKspace(
      decodeAllBlocks(seq), seq.rasterTimes.gradientRaster, getTotalDuration(seq), 0,
      { rfRaster: seq.rasterTimes.rfRaster },
    );
    const payload = serializeKSpace(ks!) as unknown as Record<string, unknown>;
    delete payload.adcX;  // what a lost buffer looks like on this side

    await postKspace(page, payload);

    // It must say so rather than clearing the notice and drawing nothing.
    await expect.poll(async () => await noticeText(page)).toContain('failed');
    expect(await noticeText(page)).toContain('binary data');
    expect(await noticeText(page), 'the safety notice must survive a failure')
      .toContain('2.6 GiB');
  });

  test('reports a reply that carried no trajectory at all', async ({ page }) => {
    await loadWithSafetyNotice(page);
    await post(page, { type: 'kspaceData', kspace: null });
    await expect.poll(async () => await noticeText(page)).toContain('failed');
    expect(await noticeText(page)).toContain('did not arrive');
    expect(await noticeText(page)).toContain('2.6 GiB');
  });
});

/**
 * Label values are requested on first use, and the reply carries its per-ADC
 * arrays as buffers nested inside the message.
 */
test('asks for label values on first use and draws only the current sequence\'s reply', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', e => failures.push(e.message));
  page.on('console', m => { if (m.type() === 'error') failures.push(m.text()); });

  const { seq } = loadSequence();  // spiral_inout.seq sets REP and LIN
  const packed = packSequenceBlocks(seq);
  await openWebview(page);
  await post(page, {
    type: 'sequenceData',
    sequenceGeneration: 2,
    labels: listSequenceLabels(seq),
    blocks: packed.blocks,
    sampleCount: packed.sampleCount,
    totalDuration: getTotalDuration(seq),
    gradRaster: seq.rasterTimes.gradientRaster,
    rfRaster: seq.rasterTimes.rfRaster,
    adcRaster: seq.rasterTimes.adcRaster,
    blockRaster: seq.rasterTimes.blockDurationRaster,
    timing: detectSequenceTiming(seq),
    notices: [],
  }, { sampleTimes: b64(packed.sampleTimes), sampleValues: b64(packed.sampleValues) });

  const chip = page.locator('#legend .li', { hasText: /^Label$/ });
  await expect(chip).toHaveClass(/off/);
  await expect(page.locator('#legend .lbl-gear')).toHaveCount(1);
  expect((await posted(page)).some(m => m.command === 'requestLabels'), 'nothing is requested before the row is used')
    .toBe(false);

  await chip.click();
  await expect.poll(async () => (await posted(page)).some(m => m.command === 'requestLabels')).toBe(true);
  const request = (await posted(page)).find(m => m.command === 'requestLabels')!;
  expect(Number(request.sequenceGeneration)).toBe(2);

  const payload = serializeLabelTable(evaluateAdcLabels(seq));
  expect(payload.values).toBeInstanceOf(ArrayBuffer);

  // A reply for a sequence the webview has since replaced must not draw.
  await postLabels(page, 1, payload);
  await expect(chip).toHaveClass(/off/);

  const before = await canvasShot(page);
  await postLabels(page, 2, payload);
  await expect(chip).not.toHaveClass(/off/);
  await expect.poll(async () => (await canvasShot(page)).equals(before) === false, { timeout: 5_000 }).toBe(true);
  expect(failures).toEqual([]);
});

/** Post a label reply the way VS Code does, rebuilding its buffers in-page. */
async function postLabels(page: Page, sequenceGeneration: number, payload: SerializedLabelTable) {
  const { timeSec, block, values, ...scalars } = payload;
  await page.evaluate(({ generation, msg, bufs }) => {
    const decode = (s: string) => {
      const bin = atob(s);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes.buffer;
    };
    const labels = { ...msg, timeSec: decode(bufs.timeSec), block: decode(bufs.block), values: decode(bufs.values) };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'labelData', sequenceGeneration: generation, labels } }));
  }, { generation: sequenceGeneration, msg: scalars, bufs: { timeSec: b64(timeSec), block: b64(block), values: b64(values) } });
}

/** Post a k-space reply the way VS Code does, rebuilding its buffers in-page. */
async function postKspace(page: Page, payload: Record<string, unknown>) {
  const plain: Record<string, unknown> = {};
  const buffers: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value instanceof ArrayBuffer) buffers[key] = b64(value);
    else plain[key] = value;
  }
  await page.evaluate(({ msg, bufs }) => {
    const decode = (s: string) => {
      const bin = atob(s);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes.buffer;
    };
    const kspace = { ...msg } as Record<string, unknown>;
    for (const [key, value] of Object.entries(bufs)) kspace[key] = decode(value);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'kspaceData', kspace } }));
  }, { msg: plain, bufs: buffers });
}

test('carries every RF audio and spectrogram option across the extension boundary', async ({ page }) => {
  // The RF proxy worked in the standalone lane and produced silence in the
  // packaged extension, because this adapter enumerated the audio fields and
  // dropped the ones panel.js had gained. The contract worth pinning is not a
  // list of field names — it is that whatever the panel sends arrives.
  const failures: string[] = [];
  page.on('pageerror', e => failures.push(e.message));
  page.on('console', m => { if (m.type() === 'error') failures.push(m.text()); });

  const { seq } = loadSequence();
  const packed = packSequenceBlocks(seq);
  await openWebview(page);

  await post(page, {
    type: 'sequenceData',
    sequenceGeneration: 1,
    blocks: packed.blocks,
    sampleCount: packed.sampleCount,
    totalDuration: getTotalDuration(seq),
    gradRaster: seq.rasterTimes.gradientRaster,
    rfRaster: seq.rasterTimes.rfRaster,
    adcRaster: seq.rasterTimes.adcRaster,
    blockRaster: seq.rasterTimes.blockDurationRaster,
    timing: detectSequenceTiming(seq),
    notices: [],
  }, { sampleTimes: b64(packed.sampleTimes), sampleValues: b64(packed.sampleValues) });

  await page.evaluate(() => (window as unknown as { SeqEyesDev: { setPanelMode(m: string): string } })
    .SeqEyesDev.setPanelMode('spectrogram'));
  await expect(page.locator('#spane')).toHaveClass(/on/);

  await page.locator('#sgRf').click();
  await expect(page.locator('#sgRfMix')).toBeEnabled();
  await page.locator('#sgRfMix').fill('80');
  await page.locator('#sgRfMix').dispatchEvent('input');
  await page.locator('#sgRfScale').fill('0');
  await page.locator('#sgRfScale').dispatchEvent('change');

  // The spectrogram request already shipped `params` wholesale; assert it too,
  // so the two halves of the panel stay covered by the same test.
  await expect.poll(async () => {
    const calc = (await posted(page)).filter(m => m.command === 'calculateSpectrogram').pop();
    return (calc?.params as Record<string, unknown> | undefined)?.includeRf;
  }, { timeout: 15_000 }).toBe(true);

  await page.locator('#sgPlay').click();

  const audio = await expect.poll(async () => {
    const all = await posted(page);
    return all.filter(m => m.command === 'synthesizeGradientSound').pop();
  }, { timeout: 15_000 }).toBeTruthy().then(() => page.evaluate(() =>
    (window as unknown as { __posted: Record<string, unknown>[] }).__posted
      .filter(m => m.command === 'synthesizeGradientSound').pop()));

  expect(audio!.includeRf).toBe(true);
  expect(audio!.rfMix).toBeCloseTo(0.8, 6);
  expect(audio!.rfScale).toBe(0);
  expect(audio!.rfThermoWeight).toBe(1);
  expect(audio!.rfControlWeight).toBe(1);
  expect(audio!.rfEdgeMode).toBe('signed');
  // The pre-existing options must still cross unchanged.
  expect(audio!.sampleRate).toBe(44100);
  expect(audio!.source).toBe('G');
  expect(audio!.channelWeights).toEqual([1, 1, 1]);

  expect(failures).toEqual([]);
});

test('plays the RF proxy end to end over the extension round trip', async ({ page }) => {
  // The option-forwarding test above only proves the request leaves the
  // webview. This closes the loop: the extension's own synthesis and
  // serialisation run on the posted options, the reply goes back the way the
  // extension sends it, and the webview has to end up with an audio buffer.
  const failures: string[] = [];
  page.on('pageerror', e => failures.push(e.message));
  page.on('console', m => { if (m.type() === 'error') failures.push(m.text()); });

  const { seq, context } = loadSequence();
  const packed = packSequenceBlocks(seq);
  await openWebview(page);

  await post(page, {
    type: 'sequenceData',
    sequenceGeneration: 1,
    blocks: packed.blocks,
    sampleCount: packed.sampleCount,
    totalDuration: getTotalDuration(seq),
    gradRaster: seq.rasterTimes.gradientRaster,
    rfRaster: seq.rasterTimes.rfRaster,
    adcRaster: seq.rasterTimes.adcRaster,
    blockRaster: seq.rasterTimes.blockDurationRaster,
    timing: detectSequenceTiming(seq),
    notices: [],
  }, { sampleTimes: b64(packed.sampleTimes), sampleValues: b64(packed.sampleValues) });

  await page.evaluate(() => (window as unknown as { SeqEyesDev: { setPanelMode(m: string): string } })
    .SeqEyesDev.setPanelMode('spectrogram'));
  await expect(page.locator('#spane')).toHaveClass(/on/);

  await page.locator('#sgRf').click();
  await expect(page.locator('#sgRfMix')).toBeEnabled();
  await page.locator('#sgRfMix').fill('100');          // RF only, so silence is unambiguous
  await page.locator('#sgRfMix').dispatchEvent('input');

  await page.locator('#sgPlay').click();
  await expect.poll(async () =>
    (await posted(page)).some(m => m.command === 'synthesizeGradientSound'), { timeout: 15_000 },
  ).toBe(true);

  const request = (await posted(page)).filter(m => m.command === 'synthesizeGradientSound').pop()!;
  expect(request.includeRf).toBe(true);
  expect(request.rfMix).toBe(1);

  // Exactly what seqEditorProvider's handler does with that message.
  const startSec = Number(request.startSec);
  const endSec = Number(request.endSec);
  const range = resolveDetailBlockRange(
    context.blockStartTimes, seq.blocks.length,
    startSec - 0.05, endSec + 0.05,
  );
  const sound = synthesizeGradientSound(
    decodeBlockRange(seq, range.start, range.end, context),
    {
      startSec, endSec,
      sampleRate: Number(request.sampleRate) || 44100,
      channelWeights: request.channelWeights as [number, number, number],
      source: request.source === 'dGdt' ? 'dGdt' : 'G',
      includeRf: request.includeRf === true,
      rfScale: request.rfScale as number,
      rfThermoWeight: request.rfThermoWeight as number,
      rfControlWeight: request.rfControlWeight as number,
      rfEdgeMode: request.rfEdgeMode === 'absolute' ? 'absolute' : 'signed',
      rfMix: request.rfMix as number,
    },
  );

  // The synthesis itself must have produced RF, or the webview assertion below
  // would be testing the wrong half of the round trip.
  expect(sound.rfIncluded).toBe(true);
  expect(sound.silent).toBe(false);

  await post(page, {
    type: 'gradientSoundData',
    requestId: request.requestId,
    ...serializeGradientSound(sound),
  });

  await expect.poll(async () => page.evaluate(() =>
    (window as unknown as { SeqEyesDev: { audioState(): { hasBuffer: boolean } } })
      .SeqEyesDev.audioState().hasBuffer), { timeout: 15_000 }).toBe(true);

  // The panel must report what the reply actually carried, not what it asked
  // for: that readout is the only thing distinguishing "RF was requested" from
  // "RF reached the buffer" when a user reports silence.
  expect(await page.evaluate(() =>
    (window as unknown as { SeqEyesDev: { spectrogramState(): { audioRfIncluded: boolean | null } } })
      .SeqEyesDev.spectrogramState().audioRfIncluded)).toBe(true);
  await expect(page.locator('#sgReadout')).toContainText('audio RF ✓ 100%');

  expect(failures).toEqual([]);
});

/**
 * The hover tooltip lives in the shared bundle, so the standalone test in
 * standalone-viewer.spec.ts exercises web/index.html's own copy and not this
 * one. It is absolutely positioned inside #cc, and was placed from client
 * coordinates, which put it #cc's offset too low and made the bottom flip
 * fire that far past the real bottom of the window.
 */
test('anchors the hover tooltip to the cursor', async ({ page }) => {
  const { seq } = loadSequence();
  const packed = packSequenceBlocks(seq);
  await openWebview(page);
  await post(page, {
    type: 'sequenceData',
    sequenceGeneration: 1,
    blocks: packed.blocks,
    sampleCount: packed.sampleCount,
    totalDuration: getTotalDuration(seq),
    gradRaster: seq.rasterTimes.gradientRaster,
    rfRaster: seq.rasterTimes.rfRaster,
    adcRaster: seq.rasterTimes.adcRaster,
    blockRaster: seq.rasterTimes.blockDurationRaster,
    timing: detectSequenceTiming(seq),
    notices: [],
  }, { sampleTimes: b64(packed.sampleTimes), sampleValues: b64(packed.sampleValues) });

  const cc = (await page.locator('#cc').boundingBox())!;
  expect(cc.top ?? cc.y).toBeGreaterThan(0);
  const tip = page.locator('#tt');

  await page.mouse.move(cc.x + cc.width / 2, cc.y + cc.height / 2);
  await expect(tip).toBeVisible();
  const box = (await tip.boundingBox())!;
  expect(Math.abs(box.y - (cc.y + cc.height / 2)),
    `tooltip at y=${box.y} for a cursor at y=${cc.y + cc.height / 2}`).toBeLessThan(40);

  // Low in the plot it must flip above the cursor rather than run off screen.
  await page.mouse.move(cc.x + cc.width / 2, cc.y + cc.height - 40);
  await expect(tip).toBeVisible();
  const low = (await tip.boundingBox())!;
  expect(low.y + low.height).toBeLessThanOrEqual(page.viewportSize()!.height);
});

/**
 * The minimap must place blocks where they actually are in time.
 *
 * The block cache is built at device resolution while `mmCtx` carries a
 * `scale(dpr)` transform, so a `drawImage(cache, 0, 0)` with no destination
 * size draws it `dpr` times too wide: at dpr 2 only the first half of the
 * sequence survives, stretched across the whole strip, and the viewport band —
 * which is computed correctly in CSS units — no longer agrees with it.
 *
 * This only reproduces above dpr 1, which is why it went unnoticed: the
 * default Playwright context and an unzoomed browser both run at 1.
 */
test.describe('minimap block cache', () => {
  test.use({ deviceScaleFactor: 2 });

  test('places RF blocks at their true times on a high-DPI display', async ({ page }) => {
    const failures: string[] = [];
    page.on('pageerror', e => failures.push(e.message));

    const seq = parseSequenceBytes(
      new Uint8Array(readFileSync(resolve('test/seqeyes_demo_seq_files/writeEpi.seq'))),
      'writeEpi.seq',
    );
    const packed = packSequenceBlocks(seq);
    const totalDuration = getTotalDuration(seq);

    // Ground truth from the decoded sequence, not from a golden image.
    const expected = (packed.blocks as unknown as { s: number; d: number; rf?: unknown }[])
      .filter(b => b.rf)
      .map(b => ({ from: b.s / totalDuration, to: (b.s + b.d) / totalDuration }));
    expect(expected.length, 'writeEpi should carry three RF blocks').toBe(3);

    await openWebview(page);
    await post(page, {
      type: 'sequenceData',
      sequenceGeneration: 1,
      blocks: packed.blocks,
      sampleCount: packed.sampleCount,
      totalDuration,
      gradRaster: seq.rasterTimes.gradientRaster,
      rfRaster: seq.rasterTimes.rfRaster,
      adcRaster: seq.rasterTimes.adcRaster,
      blockRaster: seq.rasterTimes.blockDurationRaster,
      timing: detectSequenceTiming(seq),
      notices: [],
    }, { sampleTimes: b64(packed.sampleTimes), sampleValues: b64(packed.sampleValues) });

    // Where the strip actually tints its RF band, as a fraction of its width.
    const marks = async () => page.evaluate(() => {
      const canvas = document.getElementById('mmc') as HTMLCanvasElement;
      if (!canvas || !canvas.width) return [];
      const dpr = window.devicePixelRatio || 1;
      // Strictly inside the RF band: the Gx band begins at exactly 5*dpr, and
      // rounding up bleeds into it.
      const band = Math.max(1, Math.min(canvas.height, Math.floor(5 * dpr)));
      const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, band).data;
      if (!data) return [];
      const hit: boolean[] = [];
      for (let x = 0; x < canvas.width; x++) {
        let tinted = false;
        for (let y = 0; y < band; y++) {
          const i = (y * canvas.width + x) * 4;
          if (data[i] - data[i + 1] > 8 && data[i] - data[i + 2] > 4) tinted = true;
        }
        hit.push(tinted);
      }
      const runs: { from: number; to: number }[] = [];
      let start: number | null = null;
      hit.forEach((v, i) => {
        if (v && start === null) start = i;
        else if (!v && start !== null) { runs.push({ from: start / hit.length, to: (i - 1) / hit.length }); start = null; }
      });
      if (start !== null) runs.push({ from: start / hit.length, to: (hit.length - 1) / hit.length });
      return runs.filter(r => r.to - r.from > 0.002);
    });

    await expect.poll(async () => (await marks()).length, { timeout: 10_000 }).toBeGreaterThan(0);
    const found = await marks();

    // Every RF block is represented, and nothing is pushed off the strip.
    expect(found.length, `RF marks at ${JSON.stringify(found)} for blocks at ${JSON.stringify(expected)}`)
      .toBe(expected.length);
    expected.forEach((want, index) => {
      // One pixel column of the strip is worth a few thousandths of the width.
      expect(found[index].from).toBeCloseTo(want.from, 2);
      expect(found[index].to).toBeCloseTo(want.to, 2);
    });

    expect(failures).toEqual([]);
  });
});
