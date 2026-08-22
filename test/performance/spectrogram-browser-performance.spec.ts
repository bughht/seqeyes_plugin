import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, relative, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

interface PanelState {
  busy: boolean;
  computeCount: number;
  renderCount: number;
  nTime: number;
  nFreq: number;
  lastRedrawMs: number;
  redrawSamples: number[];
  viewStartSec: number;
  viewEndSec: number;
  decimationFactor: number | null;
}

declare global {
  interface Window {
    SeqEyesDev: {
      setPanelMode(mode: string): string;
      spectrogramState(): PanelState;
    };
    __seqeyesDebug: {
      state(): { totalDuration: number };
      setView(start: number, end: number): boolean;
    };
    Pulseq?: { PACKAGE_VERSION?: string };
  }
}

const fixturePath = resolve('test/seq/spiral_inout.seq');
const outputPath = resolve('performance-results/performance-spectrogram-browser.json');
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

test('keeps spectrogram pan redraws interactive', async ({ page, browserName }) => {
  await page.goto('/?debug=1');
  await page.locator('#fileInput').setInputFiles(fixturePath);
  await expect(page.locator('#exportKspaceBtn')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#poverlay')).toBeHidden({ timeout: 15_000 });

  await page.evaluate(() => window.SeqEyesDev.setPanelMode('spectrogram'));
  await expect(page.locator('#spane')).toHaveClass(/on/);
  await settlePanel(page);

  const total = (await page.evaluate(() => window.__seqeyesDebug.state())).totalDuration;
  const span = Math.min(0.5, total / 4);

  // Ten pans across the sequence. The panel times each redraw in-page, from
  // the moment the (debounced) request issues to the moment the new image is
  // painted. Timing it from the test process instead would mostly measure
  // expect.poll back-off, which is how an earlier version of this guard
  // reported a flat ~385 ms for a redraw that actually costs single-digit ms.
  const panCount = 10;
  for (let i = 0; i < panCount; i++) {
    const start = (total - span) * (i / panCount);
    const before = (await panelState(page)).computeCount;
    await page.evaluate(([from, to]) => window.__seqeyesDebug.setView(from, to), [start, start + span]);
    await expect.poll(async () => (await panelState(page)).computeCount, { timeout: 20_000 })
      .toBeGreaterThan(before);
    await expect.poll(async () => (await panelState(page)).busy, { timeout: 20_000 }).toBe(false);
  }

  const panMs = (await panelState(page)).redrawSamples.slice(-panCount);
  expect(panMs.length).toBeGreaterThanOrEqual(panCount);
  const sorted = [...panMs].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  const worst = sorted[sorted.length - 1];

  // Window/level must never recompute: it is a LUT re-index over cached data.
  await settlePanel(page);
  const beforeDrag = (await panelState(page)).computeCount;
  const box = (await page.locator('#sgOvl').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await page.mouse.down({ button: 'middle' });
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(box.x + box.width * 0.6 - i * 2, box.y + box.height * 0.5 + i);
  }
  await page.mouse.up({ button: 'middle' });
  const afterDrag = await panelState(page);

  const report = {
    schemaVersion: 1,
    packageVersion: await page.evaluate(() => window.Pulseq?.PACKAGE_VERSION || 'unknown'),
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
      id: 'spiral_inout_spectrogram',
      file: relative(process.cwd(), fixturePath),
      viewSpanSec: span,
      columns: afterDrag.nTime,
      frequencyBins: afterDrag.nFreq,
      decimationFactor: afterDrag.decimationFactor,
      metricsMs: {
        panSamples: panMs,
        panMedian: sorted[Math.floor(sorted.length / 2)],
        panP95: p95,
        panMax: worst,
        panP95BudgetMs: 250,
        panMaxBudgetMs: 500,
        debounceMs: 120,
        note: "request-issued to painted; the 120 ms debounce is excluded",
      },
      windowLevelDrag: {
        computeCountBefore: beforeDrag,
        computeCountAfter: afterDrag.computeCount,
        renderCountAfter: afterDrag.renderCount,
      },
    },
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  for (const value of panMs) expect(Number.isFinite(value)).toBe(true);
  expect(p95, 'p95 spectrogram pan redraw exceeded 250 ms').toBeLessThan(250);
  expect(worst, 'a spectrogram pan redraw exceeded 500 ms').toBeLessThan(500);
  expect(afterDrag.computeCount, 'window/level drag must not recompute').toBe(beforeDrag);
  expect(afterDrag.nTime).toBeGreaterThan(0);
}, 120_000);

async function panelState(page: Page): Promise<PanelState> {
  return await page.evaluate(() => window.SeqEyesDev.spectrogramState());
}

/** Opening the panel narrows the waveform pane, so the view keeps moving. */
async function settlePanel(page: Page): Promise<void> {
  await expect.poll(async () => {
    const before = await panelState(page);
    await page.waitForTimeout(400);
    const after = await panelState(page);
    const stable = !after.busy
      && before.computeCount === after.computeCount
      && before.viewStartSec === after.viewStartSec
      && before.viewEndSec === after.viewEndSec;
    return stable ? 'settled' : 'moving';
  }, { timeout: 30_000 }).toBe('settled');
}
