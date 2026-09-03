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

import {
  MAX_DETAIL_PTS,
  packSequenceBlockRange,
  packSequenceBlocks,
  resolveDetailBlockRange,
} from '../../src/editor/blockTransport';
import { createSequenceDecodeContext, decodeBlockRange, getTotalDuration } from '../../src/pulseq/decoder';
import { computeGradientEnvelope, packGradientEnvelope } from '../../src/pulseq/gradientEnvelope';
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

  await expect.poll(async () => (await posted(page)).length, { timeout: 10_000 }).toBeGreaterThan(0);
  const request = (await posted(page)).find(m => m.command === 'requestWaveformDetail');
  expect(request, 'the webview must ask for detail once a sequence is loaded').toBeTruthy();
  // It must ask for the window it is showing, and for columns to draw it with.
  expect(Number(request!.sequenceGeneration)).toBe(1);
  expect(Number(request!.endSec)).toBeGreaterThan(Number(request!.startSec));
  // Regression: this field was dropped by the extension adapter, which left the
  // provider building every band from a single column.
  expect(Number(request!.columns)).toBeGreaterThan(100);

  const before = await canvasShot(page);

  // Answer with exactly what the provider would build for that window.
  const startSec = Number(request!.startSec);
  const endSec = Number(request!.endSec);
  const range = resolveDetailBlockRange(context.blockStartTimes, seq.blocks.length, startSec, endSec);
  const decoded = decodeBlockRange(seq, range.start, range.end, context);
  const detail = packSequenceBlockRange(
    seq, range.start, range.end, context, MAX_DETAIL_PTS, undefined, { startSec, endSec },
  );
  await post(page, {
    type: 'waveformDetailData',
    requestId: Number(request!.requestId),
    sequenceGeneration: 1,
    startBlock: range.start,
    endBlock: range.end,
    startSec,
    endSec,
    sampleCount: detail.sampleCount,
    blocks: detail.blocks,
    pointsPerWaveform: detail.pointsPerWaveform,
  }, { sampleTimes: b64(detail.sampleTimes), sampleValues: b64(detail.sampleValues) });

  await expect.poll(async () => (await canvasShot(page)).equals(before) === false, { timeout: 5_000 }).toBe(true);
  const afterDetail = await canvasShot(page);

  // And with a band, which travels as one Float32 buffer rather than as samples.
  const band = packGradientEnvelope(computeGradientEnvelope(decoded, startSec, endSec, 640));
  await post(page, {
    type: 'waveformBandData',
    requestId: Number(request!.requestId),
    sequenceGeneration: 1,
    startSec: band.startSec,
    endSec: band.endSec,
    columns: band.columns,
  }, { values: b64(band.values) });

  await expect.poll(async () => (await canvasShot(page)).equals(afterDetail) === false, { timeout: 5_000 }).toBe(true);

  // A refusal must be absorbed quietly rather than blanking the viewer.
  await post(page, {
    type: 'waveformDetailUnavailable',
    requestId: Number(request!.requestId),
    sequenceGeneration: 1,
    startSec,
    endSec,
  });
  await expect(page.locator('#mc')).toBeVisible();
  expect(failures).toEqual([]);
});
