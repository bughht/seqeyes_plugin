import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, relative, resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

interface DebugState {
  blocks: number;
  totalDuration: number;
  offset: number;
  visibleDuration: number;
  minRasterTime: number;
  kOpen: boolean;
  adcCount: number;
  exportEnabled: boolean;
  title: string;
}

interface HoverPoint {
  x: number;
  y: number;
  time: number;
}

const fixturePath = resolve('test/seq/spiral_inout.seq');
const outputPath = resolve('performance-results/performance-browser.json');
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

test('records standalone web load and interaction performance', async ({ page, browserName }) => {
  const metrics: Record<string, number> = {};

  const navigationStart = performance.now();
  await page.goto('/?debug=1');
  metrics.initialPageLoadMs = performance.now() - navigationStart;

  const loadStart = performance.now();
  await page.locator('#fileInput').setInputFiles(fixturePath);
  await expect(page.locator('#exportKspaceBtn')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#splash')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('#poverlay')).toBeHidden({ timeout: 10_000 });
  metrics.fileInputToReadyMs = performance.now() - loadStart;

  const waveformStart = performance.now();
  await expectCanvasVaried(page.locator('#mc'));
  await expectCanvasVaried(page.locator('#mmc'));
  metrics.readyToWaveformNonblankMs = performance.now() - waveformStart;

  const kspaceStart = performance.now();
  await page.locator('#kbtn').click();
  await expect(page.locator('#right')).toHaveClass(/open/);
  await expectCanvasVaried(page.locator('#kc'));
  metrics.kspaceOpenToNonblankMs = performance.now() - kspaceStart;

  const zoomStart = performance.now();
  for (let i = 0; i < 24; i++) await wheelOn(page, page.locator('#mc'), i % 2 === 0 ? -500 : 450);
  metrics.zoomBatchMs = performance.now() - zoomStart;

  const hoverPoint = await page.evaluate(() => window.__seqeyesDebug.hoverPoint()) as HoverPoint;
  const waveformBox = await requireBox(page.locator('#mc'));
  const hoverStart = performance.now();
  for (let i = 0; i < 40; i++) {
    const x = clamp(hoverPoint.x + (i % 8 - 4) * 8, 120, waveformBox.width - 60);
    const y = clamp(hoverPoint.y + (i % 5 - 2) * 6, 30, waveformBox.height - 40);
    await page.mouse.move(waveformBox.x + x, waveformBox.y + y);
  }
  await expect(page.locator('#cur')).toContainText('kxyz=');
  metrics.hoverBatchMs = performance.now() - hoverStart;

  const state = await debugState(page);
  const report = {
    schemaVersion: 1,
    packageVersion: await readBrowserPackageVersion(page),
    timestamp: new Date().toISOString(),
    mode: 'reporting-first',
    environment: {
      browserName,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      ci: !!process.env.CI,
      cpuCount: cpus().length,
    },
    case: {
      id: 'spiral_inout_browser',
      file: relative(process.cwd(), fixturePath),
      state,
      metricsMs: metrics,
    },
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  assertFiniteMetrics(metrics);
  expect(state.blocks).toBeGreaterThan(0);
  expect(state.adcCount).toBeGreaterThan(0);
  expect(state.exportEnabled).toBe(true);
}, 90_000);

async function debugState(page: Page): Promise<DebugState> {
  return await page.evaluate(() => window.__seqeyesDebug.state()) as DebugState;
}

async function readBrowserPackageVersion(page: Page): Promise<string> {
  return await page.evaluate(() => window.Pulseq?.PACKAGE_VERSION || 'unknown') as string;
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
  }, { timeout: 15_000 }).toBe(true);
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

function assertFiniteMetrics(metrics: Record<string, number>): void {
  for (const [name, value] of Object.entries(metrics)) {
    expect(Number.isFinite(value), `${name} should be finite`).toBe(true);
    expect(value, `${name} exceeded broad Stage 4 sanity cap`).toBeLessThan(120_000);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
