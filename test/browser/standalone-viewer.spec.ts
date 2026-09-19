import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test, type Download, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';

interface DebugState {
  blocks: number;
  totalDuration: number;
  offset: number;
  scale: number;
  visibleDuration: number;
  minRasterTime: number;
  kOpen: boolean;
  kView: string;
  kRotX: number;
  kRotY: number;
  kScale: number;
  adcCount: number;
  exportEnabled: boolean;
  derivedRenderPoints: number;
  derivedEnvelopeCurves: number;
  derivedRawCurves: number;
  waveformOverviewActive: boolean;
  rfRenderPoints: number;
  rfRawCurves: number;
  rfReducedCurves: number;
  rfOverviewBuckets: number;
  notices: string[];
  lastDrawDurationMs: number;
  drawCount: number;
  m1ReferenceMode: string;
  m1DetailActive: boolean;
  derivedDetailMaxViewSec: number;
  gradViewPoints: number;
  waveformDetailActive: boolean;
  waveformDetailWindowSec: number;
  waveformBandActive: boolean;
  waveformBandColumns: number;
  kDrawnPoints: number;
  kUploadedPoints: number;
  kPanX: number;
  kPanY: number;
  labelNames: string[];
  labelRowVisible: boolean;
  labelMarkersDrawn: number;
  labelPopupOpen: boolean;
  visibleChannels: string[];
  title: string;
}

interface HoverPoint {
  x: number;
  y: number;
  time: number;
}

const fixtures = {
  gre: resolve('test/kspace_baselines/v151_gre/seq/writeGradientEcho.seq'),
  largeSequence: resolve('test/seq/spiral_inout.seq'),
  spiral: resolve('test/kspace_baselines/v151_spiral/seq/writeSpiral.seq'),
  rotExt: resolve('test/seqeyes_demo_seq_files/writeRadialGradientEcho_rotExt.seq'),
  binaryGre: resolve('test/pulseq/binary/gre.bseq'),
  greLabel: resolve('test/seqeyes_demo_seq_files/writeGradientEcho_label.seq'),
  epi: resolve('test/seqeyes_demo_seq_files/writeEpi.seq'),
};

const consoleFailures = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const failures: string[] = [];
  consoleFailures.set(page, failures);
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });
  page.on('pageerror', (error) => failures.push(error.message));
});

test.afterEach(async ({ page }) => {
  expect(consoleFailures.get(page) ?? []).toEqual([]);
});

test('renders GRE waveform, minimap, k-space panel, and enables export', async ({ page }) => {
  await loadViewer(page, fixtures.gre);

  await expectCanvasVaried(page.locator('#mc'));
  await expectCanvasVaried(page.locator('#mmc'));
  expect((await debugState(page)).adcCount).toBe(0);

  await openKspace(page);
  await expectCanvasVaried(page.locator('#kc'));

  const state = await debugState(page);
  expect(state.blocks).toBeGreaterThan(0);
  expect(state.adcCount).toBeGreaterThan(0);
  expect(state.exportEnabled).toBe(true);
});

test('preserves resolvable RF pulse shapes and bounds the full-sequence RF overview', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  const rfEvents = await page.evaluate(() => window.__seqeyesDebug.rfEvents()) as Array<{
    start: number;
    end: number;
    points: number;
    blockPulse: boolean;
    carrierAreaDeg: number;
    responseBands: number[][];
  }>;
  expect(rfEvents.length).toBeGreaterThan(20);
  expect(Math.min(...rfEvents.map(event => event.points))).toBeGreaterThan(100);
  expect(rfEvents.some(event => event.blockPulse)).toBe(false);
  expect(rfEvents.every(event => Number.isFinite(event.carrierAreaDeg))).toBe(true);
  expect(rfEvents.every(event => event.responseBands.length > 0)).toBe(true);

  const first = rfEvents[0];
  const last = rfEvents[7];
  const padding = (last.end - first.start) * 0.03;
  const changed = await page.evaluate(({ start, end }) => window.__seqeyesDebug.setView(start, end), {
    start: Math.max(0, first.start - padding),
    end: last.end + padding,
  });
  expect(changed).toBe(true);

  const detailed = await debugState(page);
  expect(detailed.rfRawCurves).toBeGreaterThanOrEqual(8);
  expect(detailed.rfReducedCurves).toBe(0);
  expect(detailed.rfOverviewBuckets).toBe(0);
  expect(detailed.rfRenderPoints).toBeGreaterThan(1_000);
  await expectCanvasRegionVaried(page.locator('#mc'), 0.05, 0, 0.9, 0.18);

  const detailedState = await debugState(page);
  const waveformBox = await requireBox(page.locator('#mc'));
  const firstRfTime = 0.5 * (first.start + first.end);
  await page.mouse.move(
    waveformBox.x + 92 + (firstRfTime - detailedState.offset) * detailedState.scale,
    waveformBox.y + 18,
  );
  await expect(page.locator('#tt')).toContainText('FA≈');

  await page.locator('#zf').click();
  const overview = await debugState(page);
  expect(overview.rfReducedCurves).toBeGreaterThan(20);
  expect(overview.rfOverviewBuckets).toBe(0);
  expect(overview.rfRenderPoints).toBeGreaterThan(overview.rfReducedCurves * 3);
  expect(overview.rfRenderPoints).toBeLessThan(12_000);
  await expectCanvasRegionVaried(page.locator('#mc'), 0.05, 0, 0.9, 0.18);
});

test('refills deep-zoom gradient detail instead of connecting overview extrema', async ({ page }) => {
  await loadViewer(page, fixtures.largeSequence);

  const event = await page.evaluate(() => window.__seqeyesDebug.longestGradientEvent('gx')) as {
    start: number;
    end: number;
    points: number;
    block: number;
  };
  // The initial transport reduces this readout to a few hundred points across
  // tens of milliseconds, which is what used to draw as straight segments.
  expect(event.points).toBeLessThan(600);
  expect(event.end - event.start).toBeGreaterThan(0.01);

  // Zoom to 0.5 ms in the middle of the readout — far below the transported
  // sample spacing, so nothing but real detail can fill it.
  const width = 0.0005;
  const mid = 0.5 * (event.start + event.end);
  const changed = await page.evaluate(
    ({ start, end }) => window.__seqeyesDebug.setView(start, end),
    { start: mid, end: mid + width },
  );
  expect(changed).toBe(true);

  // Wait for detail fetched *for this view*, not merely for one that covers it.
  await expect
    .poll(async () => {
      const s = await debugState(page);
      return s.waveformDetailActive && s.waveformDetailWindowSec < width * 3;
    }, { timeout: 5_000 })
    .toBe(true);

  const detailed = await debugState(page);
  // What the initial transport alone could have put on screen here.
  const transportedInView = (event.points / (event.end - event.start)) * width;
  expect(transportedInView).toBeLessThan(10);
  expect(detailed.gradViewPoints).toBeGreaterThan(transportedInView * 10);
  expect(detailed.waveformOverviewActive).toBe(false);
  await expectCanvasRegionVaried(page.locator('#mc'), 0.05, 0.2, 0.9, 0.6);
});

test('refills gradients at readout scale while other rows use the overview', async ({ page }) => {
  await loadViewer(page, fixtures.largeSequence);
  const event = await page.evaluate(() => window.__seqeyesDebug.longestGradientEvent('gx')) as {
    start: number; end: number; points: number; block: number;
  };
  // A view a few times the readout: the gradients still draw from transported
  // samples here, so this is the scale a spiral looked aliased at.
  const width = 0.3;
  const mid = 0.5 * (event.start + event.end);
  await page.evaluate(({ s, e }) => window.__seqeyesDebug.setView(s, e), { s: mid - width / 2, e: mid + width / 2 });

  await expect
    .poll(async () => (await debugState(page)).waveformDetailActive, { timeout: 5_000 })
    .toBe(true);
  const state = await debugState(page);

  // Phase/ADC have switched to the overview at this width. That must not
  // suppress detail for the gradient rows, which are still drawing raw.
  expect(state.waveformOverviewActive).toBe(true);
  // The whole readout is inside the view, so the initial transport could have
  // contributed at most its own point count per gradient. Detail must beat
  // that by a wide margin or the oscillation still aliases.
  expect(state.gradViewPoints).toBeGreaterThan(event.points * 4);
});

test('draws a TR exactly and hands wider views to a min/max band', async ({ page }) => {
  await loadViewer(page, fixtures.largeSequence);
  const event = await page.evaluate(() => window.__seqeyesDebug.longestGradientEvent('gx')) as {
    start: number; end: number; points: number; block: number;
  };
  const mid = 0.5 * (event.start + event.end);
  const show = async (width: number) => {
    await page.evaluate(({ s, e }) => window.__seqeyesDebug.setView(Math.max(0, s), e),
      { s: mid - width / 2, e: mid + width / 2 });
    await expect
      .poll(async () => {
        const st = await debugState(page);
        return st.waveformDetailActive || st.waveformBandActive;
      }, { timeout: 6_000 })
      .toBe(true);
    return debugState(page);
  };

  // A TR is small enough to send sample for sample: judging a trajectory needs
  // the samples themselves, not a summary of them.
  const oneTr = await show(1.4547);
  expect(oneTr.waveformDetailActive).toBe(true);
  expect(oneTr.waveformBandActive).toBe(false);
  expect(oneTr.gradViewPoints).toBeGreaterThan(event.points * 10);

  // Far wider, the samples stop being drawable one segment each, so the view
  // switches to the band rather than to a polyline through a reduced subset.
  const wide = await show(20);
  expect(wide.waveformBandActive).toBe(true);
  expect(wide.waveformDetailActive).toBe(false);
  expect(wide.waveformBandColumns).toBeGreaterThan(500);
});

test('sharpens waveform detail as zoom deepens instead of reusing a wide window', async ({ page }) => {
  await loadViewer(page, fixtures.largeSequence);
  const event = await page.evaluate(() => window.__seqeyesDebug.longestGradientEvent('gx')) as {
    start: number; end: number; points: number; block: number;
  };
  const mid = 0.5 * (event.start + event.end);

  const settle = async (width: number) => {
    await page.evaluate(({ s, e }) => window.__seqeyesDebug.setView(s, e), { s: mid, e: mid + width });
    await expect
      .poll(async () => (await debugState(page)).waveformDetailActive, { timeout: 5_000 })
      .toBe(true);
    await expect
      .poll(async () => (await debugState(page)).waveformDetailWindowSec < width * 3, { timeout: 5_000 })
      .toBe(true);
    return debugState(page);
  };

  // Zooming in stages is what exposed this: a window fetched for the wider view
  // still time-covers every deeper view, so without a sharpness test the detail
  // freezes at the first zoom that requested it.
  const wide = await settle(0.005);
  const deep = await settle(0.0005);

  // The shrinking window is the signal: reusing the wide one is exactly the
  // defect, and coverage alone would have kept it.
  expect(deep.waveformDetailWindowSec).toBeLessThan(wide.waveformDetailWindowSec / 4);
  // Both views end up at the native raster, so the deep view keeps roughly the
  // same samples-per-second the wide one had rather than a reduced share.
  const density = (s: DebugState, width: number) => s.gradViewPoints / width;
  expect(density(deep, 0.0005)).toBeGreaterThan(density(wide, 0.005) * 0.5);
});

test('labels multiband and inversion RF responses without treating carrier area as generic FA', async ({ page }) => {
  await page.goto('/?debug=1');
  const summaries = await page.evaluate(() => {
    const summarize = (window as unknown as {
      rfResponseSummary: (rf: Record<string, unknown>) => string;
    }).rfResponseSummary;
    return {
      multiband: summarize({
        u: 'e', a0: 0.014,
        rb: [[-4444.44, 90.002, 89.996, 0], [4444.44, 90.002, 89.996, 0]],
      }),
      inversion: summarize({
        u: 'i', a0: 287.145,
        rb: [[0, 287.145, 175.95, -0.9975]],
      }),
    };
  });

  expect(summaries.multiband).toContain('MB2 FA≈90.0°');
  expect(summaries.multiband).toContain('Δf=±4.44 kHz');
  expect(summaries.multiband).not.toContain('area₀');
  expect(summaries.inversion).toContain('Inv≈99.8%');
  expect(summaries.inversion).toContain('θz≈176°');
  expect(summaries.inversion).toContain('area₀=287°');
  expect(summaries.inversion).not.toContain('FA≈287°');
});

test('keeps homogeneous RF pulses discrete and renders mixed dense RF as bounded pulse glyphs', async ({ page }) => {
  await page.goto('/?debug=1');
  await openSequenceText(page, 'homogeneous-rf.seq', syntheticRfSequence(877, false));
  await page.locator('#zf').click();
  const homogeneous = await debugState(page);
  const homogeneousEvents = await page.evaluate(() => window.__seqeyesDebug.rfEvents()) as Array<{ blockPulse: boolean }>;
  expect(homogeneousEvents).toHaveLength(877);
  expect(homogeneousEvents.every(event => event.blockPulse)).toBe(true);
  expect(homogeneous.rfOverviewBuckets).toBe(0);
  expect(homogeneous.rfRawCurves).toBeGreaterThan(800);
  expect(homogeneous.rfReducedCurves).toBe(0);
  expect(homogeneous.rfRenderPoints).toBe(homogeneous.rfRawCurves * 4);
  await expectCanvasRegionVaried(page.locator('#mc'), 0.05, 0, 0.9, 0.18);

  await openSequenceText(page, 'mixed-dense-rf.seq', syntheticRfSequence(2_500, true));
  await page.locator('#zf').click();
  const mixed = await debugState(page);
  expect(mixed.rfOverviewBuckets).toBeGreaterThan(100);
  expect(mixed.rfRenderPoints).toBeGreaterThanOrEqual(mixed.rfOverviewBuckets * 3);
  expect(mixed.rfRenderPoints).toBeLessThan(5_000);
  expect(mixed.rfRawCurves + mixed.rfReducedCurves).toBeGreaterThan(5);
  await expectCanvasRegionVaried(page.locator('#mc'), 0.05, 0, 0.9, 0.18);
});

test('renders spiral and rotation-extension fixtures without blank canvases', async ({ page }) => {
  await loadViewer(page, fixtures.spiral);
  await expectCanvasVaried(page.locator('#mc'));
  await openKspace(page);
  await expectCanvasVaried(page.locator('#kc'));

  await openSequence(page, fixtures.rotExt);
  await expectCanvasVaried(page.locator('#mc'));
  await openKspace(page);
  await expectCanvasVaried(page.locator('#kc'));

  const state = await debugState(page);
  expect(state.blocks).toBeGreaterThan(0);
  expect(state.adcCount).toBeGreaterThan(0);
});

test('loads a dropped official bseq fixture and exports it', async ({ page }) => {
  await page.goto('/?debug=1');
  await dropSequence(page, fixtures.binaryGre);
  await expectCanvasVaried(page.locator('#mc'));
  expect((await debugState(page)).adcCount).toBe(0);
  await openKspace(page);
  await expectCanvasVaried(page.locator('#kc'));

  const state = await debugState(page);
  expect(state.blocks).toBe(320);
  expect(state.adcCount).toBe(4096);
  expect(state.title).toContain('gre');

  const downloads: Download[] = [];
  page.on('download', (download) => downloads.push(download));
  await page.locator('#exportKspaceBtn').click();
  await expect.poll(() => downloads.length, { timeout: 20_000 }).toBe(2);

  const metadataDownload = downloads.find((download) => download.suggestedFilename().endsWith('_metadata.json'));
  expect(metadataDownload).toBeDefined();
  const metadataPath = await metadataDownload!.path();
  expect(metadataPath).not.toBeNull();
  const metadata = JSON.parse(readFileSync(metadataPath!, 'utf8')) as { sequenceName: string; adcSampleCount: number };
  expect(metadata.sequenceName).toBe('gre.bseq');
  expect(metadata.adcSampleCount).toBe(4096);
});

test('adapts file controls and disables drop for MATLAB on macOS', async ({ page }) => {
  await page.addInitScript(() => {
    const hostWindow = window as Window & { _SEQEYES_HOST?: string; _SEQEYES_PLATFORM?: string };
    hostWindow._SEQEYES_HOST = 'matlab';
    hostWindow._SEQEYES_PLATFORM = 'macos';
  });
  await page.goto('/?debug=1');
  await expect(page.locator('#splashOpenUrl')).toBeHidden();
  await expect(page.locator('#openUrlBtn')).toBeHidden();
  await expect(page.locator('#splashOpen')).toBeHidden();
  await expect(page.locator('#splashOpenSeq')).toBeVisible();
  await expect(page.locator('#splashOpenBseq')).toBeVisible();
  await expect(page.locator('#dropZone')).toHaveClass(/matlab-drop-unavailable/);
  await expect(page.locator('#dropZone')).toContainText('Drag & drop is unavailable in MATLAB Desktop on macOS');
});

test('keeps every in-window k-space point when the visible range narrows', async ({ page }) => {
  await loadViewer(page, fixtures.largeSequence);
  await openKspace(page);

  // Count composited pixels of the WebGL trajectory layer. The trajectory is
  // drawn from a contiguous index range of the ADC buffer chosen for the
  // visible time window; if that range ever excluded a point the shader would
  // have kept, widening the window would stop restoring it.
  // The layer is WebGL with preserveDrawingBuffer disabled, so its pixels
  // cannot be read back through drawImage; the composited screenshot can.
  const drawnPixels = async (): Promise<number> => {
    const png = await page.locator('#kg').screenshot();
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const tally = new Map<number, number>();
    for (let i = 0; i < data.length; i += info.channels) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    let background = 0;
    let most = -1;
    for (const [key, count] of tally) if (count > most) { most = count; background = key; }
    return (info.width * info.height) - (tally.get(background) ?? 0);
  };

  // Fit All redraws k-space over the whole sequence, so every ADC point is in
  // window: the trajectory must be substantially drawn, never blanked.
  await page.locator('#zf').click();
  await expect.poll(drawnPixels, { timeout: 10_000 }).toBeGreaterThan(500);
  const full = await drawnPixels();

  // Zooming in narrows the time window, so the drawn set may only shrink.
  const counts: number[] = [full];
  for (let step = 0; step < 4; step++) {
    await page.locator('#zi').click();
    await page.waitForTimeout(400);
    counts.push(await drawnPixels());
  }
  for (let i = 1; i < counts.length; i++) {
    expect(counts[i], `zoom step ${i} drew more than the wider view`).toBeLessThanOrEqual(counts[i - 1]);
  }

  // Zooming back out must restore the full cloud — the range is a window, not
  // a reduction, so nothing is permanently lost.
  await page.locator('#zf').click();
  await expect.poll(drawnPixels, { timeout: 10_000 }).toBeGreaterThan(full * 0.9);
});

test('reduces the k-space cloud only while the camera moves, never at rest', async ({ page }) => {
  await loadViewer(page, fixtures.largeSequence);
  await openKspace(page);

  // The moving stride is a bundle global, so its policy can be checked directly.
  const policy = await page.evaluate(() => {
    const stride = (window as unknown as { kSpaceMovingStride: (n: number) => number }).kSpaceMovingStride;
    return { small: stride(1000), atTarget: stride(600000), double: stride(1200000), tenfold: stride(6000000) };
  });
  // Below the target nothing is reduced, so modest sequences are always exact.
  expect(policy.small).toBe(1);
  expect(policy.atTarget).toBe(1);
  // Above it the stride bounds the drawn count rather than growing with the data.
  expect(policy.double).toBe(2);
  expect(1200000 / policy.double).toBeLessThanOrEqual(600000);
  expect(6000000 / policy.tenfold).toBeLessThanOrEqual(600000);

  // At rest the cloud must be complete.
  await page.locator('#zf').click();
  await expect.poll(async () => {
    const s = await debugState(page);
    return s.kDrawnPoints > 0 && s.kDrawnPoints === s.kUploadedPoints;
  }, { timeout: 10_000 }).toBe(true);
  const uploaded = (await debugState(page)).kUploadedPoints;

  // Drop the target below this fixture's point count so the moving path
  // engages; no shipped fixture is large enough to reach the real target.
  await page.evaluate(() => { (window as unknown as { __kMovingPointTarget: number }).__kMovingPointTarget = 1000; });

  // Mid-rotation the cloud is a strided subset...
  await page.locator('#kax').click();
  await expect.poll(async () => (await debugState(page)).kDrawnPoints < uploaded, { timeout: 10_000 }).toBe(true);

  // ...and once the easing stops, every point is back.
  await expect.poll(async () => {
    const s = await debugState(page);
    return s.kDrawnPoints === s.kUploadedPoints;
  }, { timeout: 20_000 }).toBe(true);
});

test('rotates k-space about the origin regardless of panning', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openKspace(page);
  // The drag listener lives on #kc, the 2D overlay stacked above the WebGL layer.
  const box = await requireBox(page.locator('#kc'));
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Wait for auto-fit to settle: it targets pan 0, and its easing would
  // otherwise pull the pan back underneath the drag.
  await expect.poll(async () => {
    const a = (await debugState(page)).kScale;
    await page.waitForTimeout(250);
    return (await debugState(page)).kScale === a;
  }, { timeout: 10_000 }).toBe(true);
  expect((await debugState(page)).kPanX).toBe(0);

  // Panning is a screen offset: the view moves exactly as far as the cursor.
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx + 90, cy + 40);
  await page.mouse.up({ button: 'right' });
  // Within a pixel, not exactly: synthetic drags can land sub-pixel. A
  // rotation-dependent pan would be out by tens of pixels, not one.
  await expect.poll(async () => Math.abs((await debugState(page)).kPanX - 90) <= 1, { timeout: 5_000 }).toBe(true);
  const panned = await debugState(page);
  expect(Math.abs(panned.kPanY - 40)).toBeLessThanOrEqual(1);

  // Rotating must not disturb it. The pivot is k = 0 and never moves, so a
  // pan can no longer relocate it and send the cloud orbiting off-centre.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 30);
  await page.mouse.up();
  await page.waitForTimeout(600);
  const rotated = await debugState(page);
  expect(rotated.kRotY).not.toBeCloseTo(panned.kRotY, 3);
  expect(rotated.kPanX).toBeCloseTo(panned.kPanX, 6);
  expect(rotated.kPanY).toBeCloseTo(panned.kPanY, 6);

  // Reset restores the framing.
  await page.locator('#krst').click();
  await expect.poll(async () => Math.abs((await debugState(page)).kPanX) < 0.5, { timeout: 10_000 }).toBe(true);
});

test('offers an explicit dangerous K-space override from the desktop warning', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await page.evaluate(() => {
    (window as unknown as { __seqeyesDebug: { showKspaceSafetyWarning: (message: string) => void } })
      .__seqeyesDebug.showKspaceSafetyWarning('K-space was skipped for 20.0M raster samples. Estimated peak memory: approximately 2.7 GiB (host-dependent).');
  });

  const notice = page.locator('#viewerNotice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('may freeze or crash');
  await expect(notice).toContainText('2.7 GiB');
  await notice.locator('button', { hasText: 'Calculate anyway' }).click();

  const dialog = page.locator('#kspaceSafetyOverlay');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('unsaved work');
  await expect(dialog).toContainText('2.7 GiB');
  await expect(dialog.locator('#kspaceSafetyAcknowledge')).toBeVisible();
  await expect(dialog.locator('#kspaceSafetyProceed')).toContainText('dangerous');
  await dialog.locator('#kspaceSafetyProceed').click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('#panelBtn')).toHaveText('K-Space ▸ Spectrogram', { timeout: 20_000 });
  expect((await debugState(page)).adcCount).toBeGreaterThan(0);
});

test('uses a modal instead of a long K-space warning in a mobile browser', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?debug=1');
  await page.locator('#splash').evaluate(element => { (element as HTMLElement).style.display = 'none'; });
  await page.evaluate(() => {
    (window as unknown as { __seqeyesDebug: { showKspaceSafetyWarning: (message: string) => void } })
      .__seqeyesDebug.showKspaceSafetyWarning('K-space was skipped for 20.0M raster samples. Estimated peak memory: approximately 2.7 GiB (host-dependent).');
  });

  const dialog = page.locator('#kspaceSafetyOverlay');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#viewerNotice')).toBeHidden();
  await dialog.locator('#kspaceSafetyAcknowledge').click();
  await expect(dialog).toBeHidden();
  await page.locator('#panelBtn').click();
  await expect(dialog).toBeVisible();
});

test('keeps drop enabled for MATLAB on Windows', async ({ page }) => {
  await page.addInitScript(() => {
    const hostWindow = window as Window & { _SEQEYES_HOST?: string; _SEQEYES_PLATFORM?: string };
    hostWindow._SEQEYES_HOST = 'matlab';
    hostWindow._SEQEYES_PLATFORM = 'windows';
  });
  await page.goto('/?debug=1');
  await expect(page.locator('#dropZone')).not.toHaveClass(/matlab-drop-unavailable/);
  await expect(page.locator('#dropZone')).toContainText('Or drag & drop a .seq or .bseq file here');
  await dropSequence(page, fixtures.binaryGre);
  await expectCanvasVaried(page.locator('#mc'));
});

test('keeps theme, zoom clamp, hover readout, and k-space drag interactive', async ({ page }) => {
  await loadViewer(page, fixtures.spiral);

  const bgBefore = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--bg').trim());
  await page.locator('#theme').selectOption('dracula');
  await expect(page.locator('body')).toHaveClass(/theme-dracula/);
  const bgAfter = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--bg').trim());
  expect(bgAfter).not.toBe(bgBefore);

  const beforeZoom = await debugState(page);
  await wheelOn(page, page.locator('#mc'), -700);
  const afterZoom = await debugState(page);
  expect(afterZoom.visibleDuration).toBeLessThan(beforeZoom.visibleDuration);

  for (let i = 0; i < 32; i++) await wheelOn(page, page.locator('#mc'), -1200);
  const zoomedIn = await debugState(page);
  expect(zoomedIn.visibleDuration).toBeGreaterThanOrEqual(zoomedIn.minRasterTime * 0.99);

  for (let i = 0; i < 40; i++) await wheelOn(page, page.locator('#mc'), 1200);
  const zoomedOut = await debugState(page);
  expect(zoomedOut.visibleDuration).toBeLessThanOrEqual(zoomedOut.totalDuration * 1.001);
  expect(zoomedOut.offset).toBeGreaterThanOrEqual(-1e-12);

  await openKspace(page);
  await page.evaluate(() => window.SeqEyesDev.setPanelMode('off'));
  const hoverPoint = await page.evaluate(() => window.__seqeyesDebug.hoverPoint()) as HoverPoint;
  const waveformBox = await requireBox(page.locator('#mc'));
  const hoverX = clamp(hoverPoint.x, 120, waveformBox.width - 60);
  const hoverY = clamp(hoverPoint.y, 30, waveformBox.height - 40);
  await page.mouse.move(waveformBox.x + hoverX, waveformBox.y + hoverY);
  await expect(page.locator('#cur')).toContainText('kxyz=');

  await openKspace(page);
  const kBefore = await debugState(page);
  const kBox = await requireBox(page.locator('#kc'));
  await page.mouse.move(kBox.x + kBox.width * 0.5, kBox.y + kBox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(kBox.x + kBox.width * 0.5 + 90, kBox.y + kBox.height * 0.5 + 35);
  await page.mouse.up();
  const kAfter = await debugState(page);
  expect(Math.abs(kAfter.kRotX - kBefore.kRotX) + Math.abs(kAfter.kRotY - kBefore.kRotY)).toBeGreaterThan(0.05);
});

const labelChip = (page: Page) => page.locator('#legend .li', { hasText: /^Label$/ });

test('keeps the Label row off by default and shows it after Trig on request', async ({ page }) => {
  await loadViewer(page, fixtures.greLabel);

  const loaded = await debugState(page);
  expect(loaded.labelNames).toEqual(['SLC', 'REP', 'LIN', 'REV']);
  expect(loaded.labelRowVisible).toBe(false);
  expect(loaded.visibleChannels).toEqual(['RF', 'φ', 'Gx', 'Gy', 'Gz', 'ADC', 'Trig']);
  expect(await page.locator('#legend .li').allTextContents())
    .toEqual(['RF', 'φ', 'Gx', 'Gy', 'Gz', 'ADC', 'Trig', 'Label', '⚙', 'PNS', 'M1x', 'M1y', 'M1z']);

  const before = await page.locator('#mc').screenshot();
  await labelChip(page).click();
  await expect.poll(async () => (await debugState(page)).labelRowVisible).toBe(true);
  const shown = await debugState(page);
  expect(shown.visibleChannels).toEqual(['RF', 'φ', 'Gx', 'Gy', 'Gz', 'ADC', 'Trig', 'Label']);
  expect(shown.labelMarkersDrawn).toBeGreaterThan(0);
  await expect.poll(async () => (await page.locator('#mc').screenshot()).equals(before)).toBe(false);

  // The first ADC is centred at 5.9 ms (see labels.test.ts); hover it.
  await page.evaluate(() => window.__seqeyesDebug.setView(0.004, 0.008));
  const view = await debugState(page);
  const box = await requireBox(page.locator('#mc'));
  await page.mouse.move(box.x + 92 + (0.0059 - view.offset) * view.scale, box.y + box.height * 0.5);
  await expect(page.locator('#tt')).toContainText('Labels: SLC=0  REP=0  LIN=0  REV=1');
});

test('lists only the mentioned labels in the marker popup and remembers their styles', async ({ page }) => {
  await loadViewer(page, fixtures.greLabel);
  await labelChip(page).click();
  await expect.poll(async () => (await debugState(page)).labelRowVisible).toBe(true);
  const allMarkers = (await debugState(page)).labelMarkersDrawn;

  await page.locator('#legend .lbl-gear').click();
  const popup = page.locator('#labelControls');
  await expect(popup).toBeVisible();
  await expect(popup.locator('.lblc-row input[type=checkbox]')).toHaveCount(4);
  for (const name of ['SLC', 'REP', 'LIN', 'REV']) await expect(popup.getByLabel(`Show ${name}`, { exact: true })).toBeChecked();

  await popup.getByLabel('Show LIN', { exact: true }).uncheck();
  await expect.poll(async () => (await debugState(page)).labelMarkersDrawn).toBeLessThan(allMarkers);
  await popup.getByLabel('SLC marker shape').selectOption('diamond');
  await popup.getByLabel('Use #59a14f for REP').click();
  await expect(popup.getByLabel('Use #59a14f for REP')).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  expect((await debugState(page)).labelPopupOpen).toBe(false);

  // A reload keeps the choices, which are stored per label name.
  await loadViewer(page, fixtures.greLabel);
  await page.locator('#legend .lbl-gear').click();
  await expect(popup.getByLabel('Show LIN', { exact: true })).not.toBeChecked();
  await expect(popup.getByLabel('SLC marker shape')).toHaveValue('diamond');
  await expect(popup.getByLabel('Use #59a14f for REP')).toHaveAttribute('aria-pressed', 'true');
  await popup.getByRole('button', { name: 'Reset' }).click();
  await expect(popup.getByLabel('Show LIN', { exact: true })).toBeChecked();
});

test('offers no label row or controls for a sequence without labels', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await expect(labelChip(page)).toHaveAttribute('title', 'This sequence sets no labels');
  await expect(page.locator('#legend .lbl-gear')).toHaveCount(0);
  await labelChip(page).click();
  const state = await debugState(page);
  expect(state.labelNames).toEqual([]);
  expect(state.labelRowVisible).toBe(false);
});

test('shows the marker popup as a sheet inside a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loadViewer(page, fixtures.greLabel);
  await page.locator('#legend .lbl-gear').click();
  const popup = page.locator('#labelControls');
  await expect(popup).toBeVisible();
  await expect(popup).toHaveClass(/sheet/);
  const box = await requireBox(popup);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390 + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(844 + 0.5);
});

test('downloads ktraj_adc text and matching metadata from the web export button', async ({ page }) => {
  await loadViewer(page, fixtures.gre);

  const downloads: Download[] = [];
  page.on('download', (download) => downloads.push(download));
  await page.locator('#exportKspaceBtn').click();
  await expect.poll(() => downloads.length, { timeout: 20_000 }).toBe(2);

  const workDir = mkdtempSync(join(tmpdir(), 'seqeyes-browser-export-'));
  try {
    const saved = new Map<string, string>();
    for (const download of downloads) {
      const filePath = join(workDir, download.suggestedFilename());
      await download.saveAs(filePath);
      saved.set(download.suggestedFilename(), filePath);
    }

    const adcEntry = [...saved.entries()].find(([name]) => name.endsWith('_ktraj_adc.txt'));
    const metadataEntry = [...saved.entries()].find(([name]) => name.endsWith('_metadata.json'));
    expect(adcEntry).toBeDefined();
    expect(metadataEntry).toBeDefined();

    const adcText = readFileSync(adcEntry![1], 'utf8').trim();
    const metadata = JSON.parse(readFileSync(metadataEntry![1], 'utf8')) as {
      adcSampleCount: number;
      calculation: { gradientSupport: string };
      packageVersion: string;
      rasterTimes: { gradient: number; rf: number; adc: number };
      sequenceName: string;
      units: { trajectory: string };
    };

    expect(metadata.sequenceName).toMatch(/writeGradientEcho\.seq$/);
    expect(metadata.packageVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(metadata.calculation.gradientSupport).toBe('all');
    expect(metadata.units.trajectory).toBe('1/m');
    expect(metadata.rasterTimes.gradient).toBeGreaterThan(0);
    expect(adcText.split('\n')).toHaveLength(metadata.adcSampleCount);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('loads a sequence from a web URL and converts GitHub blob links to raw files', async ({ page }) => {
  const sequenceText = readFileSync(fixtures.gre, 'utf8');
  const fetchedUrls: string[] = [];
  await page.route('https://raw.githubusercontent.com/bughht/seqeyes_plugin/main/test/seqeyes_demo_seq_files/writeEpi.seq', async (route) => {
    fetchedUrls.push(route.request().url());
    await route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'content-length': String(Buffer.byteLength(sequenceText)),
        'content-type': 'text/plain; charset=utf-8',
      },
      body: sequenceText,
    });
  });

  await page.goto('/?debug=1');
  await expect(page.locator('#splashOpen')).toContainText('Open .seq or .bseq file');
  await expect(page.locator('#dropZone')).toHaveText('Or drag & drop a .seq or .bseq file here');
  await expect(page.locator('#splashOpenUrl')).toBeVisible();

  await openSequenceFromUrl(page, 'https://github.com/bughht/seqeyes_plugin/blob/main/test/seqeyes_demo_seq_files/writeEpi.seq');

  await expect(page.locator('#exportKspaceBtn')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#splash')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('#openUrlBtn')).toBeVisible();
  await expect.poll(async () => (await debugState(page)).blocks, { timeout: 20_000 }).toBeGreaterThan(0);
  expect(fetchedUrls).toEqual(['https://raw.githubusercontent.com/bughht/seqeyes_plugin/main/test/seqeyes_demo_seq_files/writeEpi.seq']);
});

test('loads a bseq from a GitHub-style web URL as binary bytes', async ({ page }) => {
  const binary = readFileSync(fixtures.binaryGre);
  const rawUrl = 'https://raw.githubusercontent.com/pulseq/pulseq/master/tests/legacy/approved/gre.bseq';
  const fetchedUrls: string[] = [];
  await page.route(rawUrl, async (route) => {
    fetchedUrls.push(route.request().url());
    await route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'content-length': String(binary.byteLength),
        'content-type': 'application/octet-stream',
      },
      body: binary,
    });
  });

  await page.goto('/?debug=1');
  await openSequenceFromUrl(page, 'https://github.com/pulseq/pulseq/blob/master/tests/legacy/approved/gre.bseq');
  await expect(page.locator('#exportKspaceBtn')).toBeEnabled({ timeout: 60_000 });
  await expect.poll(async () => (await debugState(page)).blocks, { timeout: 20_000 }).toBe(320);
  expect((await debugState(page)).adcCount).toBe(0);
  expect(fetchedUrls).toEqual([rawUrl]);
});

test('rejects non-seq web URLs before fetching', async ({ page }) => {
  let fetchAttempts = 0;
  await page.route('https://example.com/**', async (route) => {
    fetchAttempts++;
    await route.fulfill({ status: 200, body: 'unexpected' });
  });

  await page.goto('/?debug=1');
  await openSequenceFromUrl(page, 'https://example.com/not-a-sequence.txt');

  await expect(page.locator('#urlStatus')).toContainText('must end with .seq or .bseq');
  await expect(page.locator('#splash')).toBeVisible();
  expect(fetchAttempts).toBe(0);
});

test('rejects HTML and binary-looking responses from seq URLs', async ({ page }) => {
  await page.route('https://example.com/html.seq', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'content-type': 'text/html; charset=utf-8',
      },
      body: '<!doctype html><html><body>not raw seq</body></html>',
    });
  });
  await page.route('https://example.com/binary.seq', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'content-type': 'application/octet-stream',
      },
      body: Buffer.from([0, 1, 2, 3]),
    });
  });

  await page.goto('/?debug=1');
  await openSequenceFromUrl(page, 'https://example.com/html.seq');
  await expect(page.locator('#urlStatus')).toContainText('HTML');
  await expect(page.locator('#exportKspaceBtn')).toBeDisabled();

  await page.locator('#urlInput').fill('https://example.com/binary.seq');
  await page.locator('#urlLoad').click();
  await expect(page.locator('#urlStatus')).toContainText('binary');
  await expect(page.locator('#exportKspaceBtn')).toBeDisabled();
});

test('rejects a bseq URL whose response lacks the Pulseq binary header', async ({ page }) => {
  await page.route('https://example.com/fake.bseq', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream' },
      body: Buffer.from('not a binary Pulseq sequence'),
    });
  });

  await page.goto('/?debug=1');
  await openSequenceFromUrl(page, 'https://example.com/fake.bseq');
  await expect(page.locator('#urlStatus')).toContainText('missing the Pulseq binary header');
  await expect(page.locator('#exportKspaceBtn')).toBeDisabled();
});

test('reloads sequence state without leaking previous viewer data', async ({ page }) => {
  await loadViewer(page, fixtures.spiral);
  const coldSpiral = stableState(await debugState(page));

  await openSequence(page, fixtures.gre);
  const greState = stableState(await debugState(page));
  expect(greState.blocks).not.toBe(coldSpiral.blocks);

  await openSequence(page, fixtures.spiral);
  const warmSpiral = stableState(await debugState(page));
  expect(warmSpiral).toEqual(coldSpiral);
});

test('calculates M1 lazily and accepts a synthetic ASC profile for PNS', async ({ page }) => {
  await loadViewer(page, fixtures.gre);

  const m1Legend = page.locator('#legend .li').filter({ hasText: 'M1x' });
  const m1yLegend = page.locator('#legend .li').filter({ hasText: 'M1y' });
  const m1zLegend = page.locator('#legend .li').filter({ hasText: 'M1z' });
  await expect(m1Legend).toHaveClass(/off/);
  await expect(page.locator('#m1Btn')).toHaveCount(0);
  expect((await debugState(page)).m1ReferenceMode).toBe('rfCenter');
  await page.evaluate(() => {
    (window as unknown as { SeqEyesDev: { setM1ReferenceMode: (mode: string) => string } })
      .SeqEyesDev.setM1ReferenceMode('observationTime');
  });
  expect((await debugState(page)).m1ReferenceMode).toBe('observationTime');
  await page.evaluate(() => {
    (window as unknown as { SeqEyesDev: { setM1ReferenceMode: (mode: string) => string } })
      .SeqEyesDev.setM1ReferenceMode('rfCenter');
  });
  expect((await debugState(page)).m1ReferenceMode).toBe('rfCenter');
  await m1Legend.click();
  await expect(m1Legend).not.toHaveClass(/off/, { timeout: 20_000 });
  await expect(m1yLegend).toHaveClass(/off/);
  await m1yLegend.click();
  await m1zLegend.click();
  await expect(m1yLegend).not.toHaveClass(/off/);
  await expect(m1zLegend).not.toHaveClass(/off/);
  await page.evaluate(() => {
    (window as unknown as { SeqEyesDev: { setM1ReferenceMode: (mode: string) => string } })
      .SeqEyesDev.setM1ReferenceMode('observationTime');
  });
  await expect(m1Legend).not.toHaveClass(/off/);
  await expect(m1yLegend).not.toHaveClass(/off/);
  await expect(m1zLegend).not.toHaveClass(/off/);
  expect((await debugState(page)).m1ReferenceMode).toBe('observationTime');

  const pnsLegend = page.locator('#legend .li').filter({ hasText: 'PNS' });
  await expect(pnsLegend).toHaveClass(/off/);
  await expect(page.locator('#pnsBtn')).toHaveText('Load ASC (PNS/Acoustic)');
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#pnsBtn').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'synthetic.asc',
    mimeType: 'text/plain',
    buffer: Buffer.from(syntheticAsc()),
  });
  await expect(pnsLegend).not.toHaveClass(/off/, { timeout: 20_000 });
  const canvasBox = await page.locator('#mc').boundingBox();
  if (!canvasBox) throw new Error('Waveform canvas is not visible');
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.5, canvasBox.y + canvasBox.height * 0.5);
  await expect(page.locator('#tt')).toContainText('M1:', { timeout: 10_000 });
  await expect(page.locator('#tt')).toContainText('PNS:', { timeout: 10_000 });

  await page.locator('#ascInput').dispatchEvent('cancel');
  await expect(pnsLegend).not.toHaveClass(/off/);

  for (let i = 0; i < 40; i++) await wheelOn(page, page.locator('#mc'), 1200);
  const zoomedOut = await debugState(page);
  expect(zoomedOut.visibleDuration).toBeLessThanOrEqual(zoomedOut.totalDuration * 1.001);
  expect(zoomedOut.derivedRenderPoints).toBeLessThan(25_000);
  expect(zoomedOut.derivedEnvelopeCurves).toBeGreaterThan(0);
  const drawCountAtClamp = zoomedOut.drawCount;
  await page.locator('#mc').dispatchEvent('wheel', { deltaY: 1200 });
  await page.waitForTimeout(50);
  expect((await debugState(page)).drawCount).toBe(drawCountAtClamp);
  await expectCanvasVaried(page.locator('#mc'));
  await expectCanvasRegionVaried(page.locator('#mc'), 0, 0, 0.12, 1);

  for (let i = 0; i < 24; i++) await wheelOn(page, page.locator('#mc'), -1200);
  expect((await debugState(page)).derivedRawCurves).toBeGreaterThan(0);
});

test('starts every release session in RF-center mode despite a legacy saved developer mode', async ({ page }) => {
  await page.goto('/?debug=1');
  await page.evaluate(() => localStorage.setItem('seqeyes.m1ReferenceMode', 'observationTime'));
  await page.reload();

  expect((await debugState(page)).m1ReferenceMode).toBe('rfCenter');
  expect(await page.evaluate(() => localStorage.getItem('seqeyes.m1ReferenceMode'))).toBeNull();

  await page.evaluate(() => {
    (window as unknown as { SeqEyesDev: { setM1ReferenceMode: (mode: string) => string } })
      .SeqEyesDev.setM1ReferenceMode('observationTime');
  });
  expect((await debugState(page)).m1ReferenceMode).toBe('observationTime');
  await page.reload();
  expect((await debugState(page)).m1ReferenceMode).toBe('rfCenter');
});

test('uses ranges for coarse M1 tooltips and point values after detailed-window calculation', async ({ page }) => {
  await loadViewer(page, fixtures.largeSequence);
  const m1Legend = page.locator('#legend .li').filter({ hasText: 'M1x' });
  await m1Legend.click();
  await expect(m1Legend).not.toHaveClass(/off/, { timeout: 20_000 });

  const rangeTime = await page.evaluate(() => window.__seqeyesDebug.firstM1RangeTime()) as number | null;
  expect(rangeTime).not.toBeNull();
  const coarseLine = await page.evaluate(time => window.__seqeyesDebug.m1TooltipLineAt(time), rangeTime) as string;
  expect(coarseLine).toContain('∈[');

  const detailStart = Math.max(0, rangeTime! - 0.045);
  await page.evaluate(({ start, end }) => window.__seqeyesDebug.setView(start, end), {
    start: detailStart,
    end: detailStart + 0.09,
  });
  await expect.poll(async () => (
    await page.evaluate(time => window.__seqeyesDebug.m1TooltipLineAt(time), rangeTime)
  ), { timeout: 20_000 }).not.toContain('∈[');
});

test('replaces coarse M1 with budgeted viewport detail when TR metadata is unavailable', async ({ page }) => {
  await page.goto('/?debug=1');
  await openSequenceText(page, 'no-tr-large.seq', syntheticNoTrLargeSequence());
  const initial = await debugState(page);
  expect(initial.derivedDetailMaxViewSec).toBeCloseTo(10, 6);

  await page.evaluate(() => window.__seqeyesDebug.setView(10, 10.1));
  const m1Legend = page.locator('#legend .li').filter({ hasText: 'M1x' });
  await m1Legend.click();
  await expect(m1Legend).not.toHaveClass(/off/, { timeout: 20_000 });
  await expect.poll(async () => (await debugState(page)).m1DetailActive, {
    timeout: 20_000,
  }).toBe(true);
  await expect.poll(async () => (await debugState(page)).notices.join(' '), {
    timeout: 20_000,
  }).toContain('current view is detailed');
});

/**
 * This lane keeps its own copy of the minimap renderer, and it carried the same
 * defect: the block cache is built at device resolution but was blitted without
 * a destination size into a context already scaled by dpr, so above dpr 1 it
 * drew the cache dpr times too wide and the tail of the sequence fell off the
 * strip.  Only the viewport band stayed correct, which is what made the two
 * disagree.
 */
test.describe('minimap block cache at high DPI', () => {
  test.use({ deviceScaleFactor: 2 });

  test('places RF blocks at their true times', async ({ page }) => {
    await loadViewer(page, fixtures.epi);

    const total = (await debugState(page)).totalDuration;
    expect(total).toBeGreaterThan(0);

    const found = await page.evaluate(() => {
      const canvas = document.getElementById('mmc') as HTMLCanvasElement;
      const dpr = window.devicePixelRatio || 1;
      // Strictly inside the RF band; the Gx band starts at exactly 5*dpr.
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

    // writeEpi excites once per TR over three TRs; the third is the one that
    // used to be pushed past the right edge.
    expect(found.length, `RF marks at ${JSON.stringify(found)}`).toBe(3);
    [0, 1 / 3, 2 / 3].forEach((want, index) => {
      expect(found[index].from).toBeCloseTo(want, 2);
    });
  });
});

async function loadViewer(page: Page, sequencePath: string): Promise<void> {
  await page.goto('/?debug=1');
  await openSequence(page, sequencePath);
}

async function openSequence(page: Page, sequencePath: string): Promise<void> {
  await page.locator('#fileInput').setInputFiles(sequencePath);
  await expectSequenceLoaded(page);
}

async function openSequenceText(page: Page, name: string, source: string): Promise<void> {
  await page.locator('#fileInput').setInputFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(source),
  });
  await expectSequenceLoaded(page);
}

async function dropSequence(page: Page, sequencePath: string): Promise<void> {
  const data = readFileSync(sequencePath).toString('base64');
  const name = sequencePath.split('/').pop() || 'sequence.bseq';
  await page.locator('#dropZone').evaluate((dropZone, source) => {
    const binary = atob(source.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], source.name, { type: 'application/octet-stream' }));
    dropZone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { data, name });
  await expectSequenceLoaded(page);
}

async function expectSequenceLoaded(page: Page): Promise<void> {
  await expect(page.locator('#exportKspaceBtn')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#splash')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('#poverlay')).toBeHidden({ timeout: 10_000 });
  await expect.poll(async () => (await debugState(page)).blocks, { timeout: 20_000 }).toBeGreaterThan(0);
}

async function openSequenceFromUrl(page: Page, url: string): Promise<void> {
  await page.locator('#splashOpenUrl').click();
  await expect(page.locator('#urlOverlay')).toBeVisible();
  await page.locator('#urlInput').fill(url);
  await page.locator('#urlLoad').click();
}

async function openKspace(page: Page): Promise<void> {
  const right = page.locator('#right');
  const state = await debugState(page);
  if (!state.kOpen) await page.locator('#panelBtn').click();
  await expect(right).toHaveClass(/open/);
  await expect.poll(async () => (await debugState(page)).kOpen).toBe(true);
  await expect.poll(async () => {
    const box = await page.locator('#kc').boundingBox();
    return box ? Math.min(box.width, box.height) : 0;
  }, { timeout: 30_000 }).toBeGreaterThan(100);
  await expect.poll(async () => (await debugState(page)).adcCount, {
    timeout: 20_000,
  }).toBeGreaterThan(0);
}

async function debugState(page: Page): Promise<DebugState> {
  return await page.evaluate(() => window.__seqeyesDebug.state()) as DebugState;
}

async function expectCanvasVaried(locator: Locator): Promise<void> {
  await expect.poll(async () => {
    return await locator.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      if (!canvas.width || !canvas.height) return false;
      const context = canvas.getContext('2d');
      if (!context) return false;
      const image = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let first = '';
      for (let i = 0; i < image.length; i += 4) {
        const key = `${image[i]},${image[i + 1]},${image[i + 2]},${image[i + 3]}`;
        if (!first) first = key;
        else if (key !== first) return true;
      }
      return false;
    });
  }, { timeout: 10_000 }).toBe(true);
}

async function expectCanvasRegionVaried(
  locator: Locator,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  await expect.poll(async () => {
    return await locator.evaluate((element, region) => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext('2d');
      if (!context || !canvas.width || !canvas.height) return false;
      const sx = Math.floor(canvas.width * region.x);
      const sy = Math.floor(canvas.height * region.y);
      const sw = Math.max(1, Math.floor(canvas.width * region.width));
      const sh = Math.max(1, Math.floor(canvas.height * region.height));
      const image = context.getImageData(sx, sy, sw, sh).data;
      const colors = new Set<string>();
      for (let i = 0; i < image.length; i += 16) {
        colors.add(`${image[i]},${image[i + 1]},${image[i + 2]},${image[i + 3]}`);
        if (colors.size >= 3) return true;
      }
      return false;
    }, { x, y, width, height });
  }, { timeout: 10_000 }).toBe(true);
}

async function wheelOn(page: Page, locator: Locator, deltaY: number): Promise<void> {
  const box = await requireBox(locator);
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.wheel(0, deltaY);
}

async function requireBox(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

function stableState(state: DebugState): Pick<DebugState, 'blocks' | 'adcCount' | 'title'> & { totalDuration: number } {
  return {
    blocks: state.blocks,
    adcCount: state.adcCount,
    title: state.title,
    totalDuration: Number(state.totalDuration.toPrecision(12)),
  };
}

function syntheticAsc(): string {
  const axes = ['X', 'Y', 'Z'];
  const lines: string[] = [];
  for (const axis of axes) {
    lines.push(
      `GradPatSup.Phys.PNS.flGSWDTau${axis}[0] = 1`,
      `GradPatSup.Phys.PNS.flGSWDTau${axis}[1] = 2`,
      `GradPatSup.Phys.PNS.flGSWDTau${axis}[2] = 3`,
      `GradPatSup.Phys.PNS.flGSWDA${axis}[0] = 0.2`,
      `GradPatSup.Phys.PNS.flGSWDA${axis}[1] = 0.3`,
      `GradPatSup.Phys.PNS.flGSWDA${axis}[2] = 0.5`,
      `GradPatSup.Phys.PNS.flGSWDStimulationLimit${axis} = 1000000000`,
      `GradPatSup.Phys.PNS.flGSWDStimulationThreshold${axis} = 1`,
      `asGPAParameters[0].sGCParameters.flGScaleFactor${axis} = 1`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function syntheticRfSequence(eventCount: number, mixed: boolean): string {
  const blocks: string[] = [];
  for (let index = 0; index < eventCount; index++) {
    const inversion = mixed && index % 200 === 0;
    blocks.push(`${index + 1} ${inversion ? 2000 : 200} ${inversion ? 2 : 1} 0 0 0 0 0`);
  }
  return `# Synthetic RF density regression fixture
[VERSION]
major 1
minor 5
revision 1

[DEFINITIONS]
AdcRasterTime 1e-7
BlockDurationRaster 1e-5
GradientRasterTime 1e-5
Name ${mixed ? 'mixed_rf_density' : 'homogeneous_rf'}
RadiofrequencyRasterTime 1e-6

[BLOCKS]
${blocks.join('\n')}

[RF]
1 200 1 2 3 50 100 0 0 0 0 e
2 600 1 2 4 5000 100 0 0 0 0 i

[SHAPES]
shape_id 1
num_samples 2
1
1

shape_id 2
num_samples 2
0
0

shape_id 3
num_samples 2
0
100

shape_id 4
num_samples 2
0
10000
`;
}

function syntheticNoTrLargeSequence(): string {
  const blocks = Array.from({ length: 210 }, (_, index) => (
    `${index + 1} 10000 0 1 0 0 ${index === 0 ? 1 : 0} 0`
  ));
  return `# Synthetic no-TR detailed-M1 regression fixture
[VERSION]
major 1
minor 4
revision 0

[DEFINITIONS]
AdcRasterTime 1e-7
BlockDurationRaster 1e-5
GradientRasterTime 1e-5
Name no_tr_large
RadiofrequencyRasterTime 1e-6

[BLOCKS]
${blocks.join('\n')}

[TRAP]
1 1000 1000 98000 1000 0

[ADC]
1 8000001 100 0 0 0
`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
