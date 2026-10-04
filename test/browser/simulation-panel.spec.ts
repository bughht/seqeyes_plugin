import { resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

interface SimulationState {
  available: boolean;
  shown: boolean;
  running: boolean;
  runs: number;
  workers: number;
  view: string;
  size: number;
  spins: string;
  plan: null | {
    subSpins: [number, number];
    spins: number;
    simulated: number;
    chunks: number;
    axes: { count: number; reason: string; folded: boolean }[];
  };
  done: boolean;
  nu: number;
  nv: number;
  frames: number;
  status: string;
}

/** The test hooks panel.js installs (other specs declare their own subsets). */
interface DevWindow {
  SeqEyesDev: {
    panelMode(): string;
    simulationState(): unknown;
    simulationMatrix(): unknown;
  };
}

const gre = resolve('test/kspace_baselines/v151_gre/seq/writeGradientEcho.seq');
const epi = resolve('test/seqeyes_demo_seq_files/writeEpi.seq');

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

test('simulates a GRE in workers and shows image, k-space and raw data', async ({ page }) => {
  await loadViewer(page, gre);
  await openSimulation(page);

  // Manual spins per voxel skip the probe, which keeps this run short.
  await page.locator('#simSize').selectOption('32');
  await page.locator('#simSpins').selectOption('8x1');
  await page.locator('#simRun').click();
  await expect.poll(async () => (await simulationState(page)).done, { timeout: 60_000 }).toBe(true);

  const state = await simulationState(page);
  expect(state.running).toBe(false);
  expect([state.nu, state.nv]).toEqual([128, 128]);
  expect(state.frames).toBe(1);
  expect(state.plan?.subSpins).toEqual([8, 1]);
  // y is the rewound phase encode: its spins fold into shared classes.
  expect(state.plan?.axes[1].folded).toBe(true);
  expect(state.plan!.simulated).toBeLessThan(state.plan!.spins);
  expect(state.status).toContain('Done in');
  await expectCanvasVaried(page.locator('#simCanvas'));

  for (const view of ['kspace', 'raw', 'image']) {
    await page.locator('#simView').selectOption(view);
    const summary = await simulationMatrix(page);
    expect(summary.max).toBeGreaterThan(0);
    expect(summary.mean).toBeGreaterThan(0);
    if (view === 'raw') expect([summary.width, summary.height]).toEqual([128, 128]);
    await expectCanvasVaried(page.locator('#simCanvas'));
  }

  // The image is brighter in the phantom than outside it.
  const contrast = await page.locator('#simCanvas').evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext('2d')!;
    const centre = context.getImageData(Math.floor(canvas.width / 2) - 4, Math.floor(canvas.height / 2) - 4, 8, 8).data;
    const corner = context.getImageData(Math.floor(canvas.width / 2) - Math.floor(Math.min(canvas.width, canvas.height) * 0.45), Math.floor(canvas.height / 2) - Math.floor(Math.min(canvas.width, canvas.height) * 0.45), 8, 8).data;
    const mean = (data: Uint8ClampedArray) => { let s = 0; for (let i = 0; i < data.length; i += 4) s += data[i]; return s / (data.length / 4); };
    return { centre: mean(centre), corner: mean(corner) };
  });
  expect(contrast.centre).toBeGreaterThan(contrast.corner + 20);
});

test('plans spins per voxel automatically and can be cancelled', async ({ page }) => {
  await loadViewer(page, gre);
  await openSimulation(page);
  await page.locator('#simSize').selectOption('128');
  await page.locator('#simSpins').selectOption('auto');
  await page.locator('#simRun').click();

  // The probe resolves the GRE's x spoiling before the run starts.
  await expect.poll(async () => (await simulationState(page)).plan !== null, { timeout: 60_000 }).toBe(true);
  const planned = await simulationState(page);
  expect(planned.plan!.axes[0].reason).toBe('spoiling');
  expect(planned.plan!.axes[0].count).toBeGreaterThanOrEqual(320);
  expect(planned.plan!.chunks).toBeGreaterThan(1);
  expect(planned.running).toBe(true);
  await expect(page.locator('#simCancel')).toBeEnabled();

  await page.locator('#simCancel').click();
  const cancelled = await simulationState(page);
  expect(cancelled.running).toBe(false);
  expect(cancelled.workers).toBe(0);
  expect(cancelled.done).toBe(false);
  await expect(page.locator('#simReadout')).toContainText('Cancelled');
  await expect(page.locator('#simRun')).toBeEnabled();
});

test('leaves the k-space and spectrogram cycle intact', async ({ page }) => {
  await loadViewer(page, gre);
  await openSimulation(page);
  await expect(page.locator('#panelBtn')).toHaveAttribute('aria-pressed', 'false');

  // From Simulation the cycle button starts over at k-space.
  await page.locator('#panelBtn').click();
  await expect.poll(() => panelMode(page)).toBe('kspace');
  await expect(page.locator('#simpane')).toBeHidden();
  await expect(page.locator('#simBtn')).toHaveAttribute('aria-pressed', 'false');

  // And Simulation closes the panel when toggled off.
  await page.locator('#simBtn').click();
  await expect.poll(() => panelMode(page)).toBe('simulation');
  await page.locator('#simBtn').click();
  await expect.poll(() => panelMode(page)).toBe('off');
  await expect(page.locator('#right')).not.toHaveClass(/open/);
});

test('a new sequence clears the previous result', async ({ page }) => {
  await loadViewer(page, gre);
  await openSimulation(page);
  await page.locator('#simSize').selectOption('32');
  await page.locator('#simSpins').selectOption('1x1');
  await page.locator('#simRun').click();
  await expect.poll(async () => (await simulationState(page)).done, { timeout: 60_000 }).toBe(true);

  await page.locator('#fileInput').setInputFiles(epi);
  await expect.poll(async () => (await simulationState(page)).done, { timeout: 30_000 }).toBe(false);
  await expect(page.locator('#simEmpty')).toBeVisible();
  await expect(page.locator('#simReadout')).toContainText('writeEpi.seq');
});

async function loadViewer(page: Page, sequencePath: string): Promise<void> {
  await page.goto('/?debug=1');
  await page.locator('#fileInput').setInputFiles(sequencePath);
  await expect(page.locator('#exportKspaceBtn')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#poverlay')).toBeHidden({ timeout: 10_000 });
}

async function openSimulation(page: Page): Promise<void> {
  await expect(page.locator('#simBtn')).toBeVisible();
  await page.locator('#simBtn').click();
  await expect(page.locator('#right')).toHaveClass(/open/);
  await expect(page.locator('#simpane')).toBeVisible();
  await expect(page.locator('#simBtn')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await simulationState(page)).shown).toBe(true);
}

async function simulationState(page: Page): Promise<SimulationState> {
  return await page.evaluate(() => (window as unknown as DevWindow).SeqEyesDev.simulationState()) as SimulationState;
}

async function simulationMatrix(page: Page): Promise<{ width: number; height: number; mean: number; max: number }> {
  const summary = await page.evaluate(() => (window as unknown as DevWindow).SeqEyesDev.simulationMatrix());
  if (!summary) throw new Error('No simulation matrix on display.');
  return summary as { width: number; height: number; mean: number; max: number };
}

async function panelMode(page: Page): Promise<string> {
  return await page.evaluate(() => (window as unknown as DevWindow).SeqEyesDev.panelMode());
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
        const key = `${image[i]},${image[i + 1]},${image[i + 2]}`;
        if (!first) first = key;
        else if (key !== first) return true;
      }
      return false;
    });
  }, { timeout: 10_000 }).toBe(true);
}
