import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test, type Download, type Locator, type Page } from '@playwright/test';

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
  notices: string[];
  lastDrawDurationMs: number;
  drawCount: number;
  m1ReferenceMode: string;
  title: string;
}

interface HoverPoint {
  x: number;
  y: number;
  time: number;
}

const fixtures = {
  gre: resolve('test/kspace_baselines/v151_gre/seq/writeGradientEcho.seq'),
  spiral: resolve('test/kspace_baselines/v151_spiral/seq/writeSpiral.seq'),
  rotExt: resolve('test/seqeyes_demo_seq_files/writeRadialGradientEcho_rotExt.seq'),
  binaryGre: resolve('test/pulseq/binary/gre.bseq'),
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

  await openKspace(page);
  await expectCanvasVaried(page.locator('#kc'));

  const state = await debugState(page);
  expect(state.blocks).toBeGreaterThan(0);
  expect(state.adcCount).toBeGreaterThan(0);
  expect(state.exportEnabled).toBe(true);
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
  await expect(page.locator('#kbtn')).toHaveText('K ✕', { timeout: 20_000 });
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
  await page.locator('#kbtn').click();
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
  expect((await debugState(page)).adcCount).toBe(4096);
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
  await expect(page.locator('#pnsBtn')).toHaveText('Select PNS ASC file');
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

async function loadViewer(page: Page, sequencePath: string): Promise<void> {
  await page.goto('/?debug=1');
  await openSequence(page, sequencePath);
}

async function openSequence(page: Page, sequencePath: string): Promise<void> {
  await page.locator('#fileInput').setInputFiles(sequencePath);
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
  if (!state.kOpen) await page.locator('#kbtn').click();
  await expect(right).toHaveClass(/open/);
  await expect.poll(async () => (await debugState(page)).kOpen).toBe(true);
  await expect.poll(async () => {
    const box = await page.locator('#kc').boundingBox();
    return box ? Math.min(box.width, box.height) : 0;
  }, { timeout: 10_000 }).toBeGreaterThan(100);
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
