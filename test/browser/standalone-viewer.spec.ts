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
  await expect(m1Legend).toHaveClass(/off/);
  await page.locator('#m1Btn').click();
  await expect(m1Legend).not.toHaveClass(/off/, { timeout: 20_000 });

  const pnsLegend = page.locator('#legend .li').filter({ hasText: 'PNS' });
  await expect(pnsLegend).toHaveClass(/off/);
  await page.locator('#ascInput').setInputFiles({
    name: 'synthetic.asc',
    mimeType: 'text/plain',
    buffer: Buffer.from(syntheticAsc()),
  });
  await expect(pnsLegend).not.toHaveClass(/off/, { timeout: 20_000 });
  await expectCanvasVaried(page.locator('#mc'));
});

async function loadViewer(page: Page, sequencePath: string): Promise<void> {
  await page.goto('/?debug=1');
  await openSequence(page, sequencePath);
}

async function openSequence(page: Page, sequencePath: string): Promise<void> {
  await page.locator('#fileInput').setInputFiles(sequencePath);
  await expect(page.locator('#exportKspaceBtn')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#splash')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('#poverlay')).toBeHidden({ timeout: 10_000 });
  await expect.poll(async () => (await debugState(page)).blocks, { timeout: 20_000 }).toBeGreaterThan(0);
}

async function openKspace(page: Page): Promise<void> {
  const right = page.locator('#right');
  const state = await debugState(page);
  if (!state.kOpen) await page.locator('#kbtn').click();
  await expect(right).toHaveClass(/open/);
  await expect.poll(async () => (await debugState(page)).kOpen).toBe(true);
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
