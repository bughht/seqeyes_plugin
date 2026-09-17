/**
 * Remembered settings in the standalone viewer.
 *
 * The point of issue #26 is not that any one control persists but that the
 * viewer comes back the way it was left, so every test here reloads the page
 * and asserts against a fresh load rather than against in-page state.  The
 * consent switch gets the same treatment from the other direction: with it
 * off, a reload must land on defaults and leave nothing behind in storage.
 */

import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const fixtures = {
  gre: resolve('test/kspace_baselines/v151_gre/seq/writeGradientEcho.seq'),
  combinedAsc: resolve('test/asc/synthetic_combined.asc'),
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

async function openViewer(page: Page): Promise<void> {
  await page.goto('/?debug=1');
  await expect(page.locator('#tb')).toBeVisible();
}

async function loadSequence(page: Page): Promise<void> {
  await page.locator('#fileInput').setInputFiles(fixtures.gre);
  await expect.poll(async () => (await debugState(page)).blocks).toBeGreaterThan(0);
}

async function debugState(page: Page): Promise<{
  blocks: number; kOpen: boolean; kView: string; adcCount: number; visibleChannels: string[];
}> {
  return page.evaluate(() => window.__seqeyesDebug.state());
}

/** The k-space controls live inside the panel, so they need it open first. */
async function openKspace(page: Page): Promise<void> {
  if (!(await debugState(page)).kOpen) await page.locator('#panelBtn').click();
  await expect(page.locator('#right')).toHaveClass(/open/);
  await expect.poll(async () => (await debugState(page)).adcCount, { timeout: 20_000 })
    .toBeGreaterThan(0);
  await expect(page.locator('#kax')).toBeVisible();
}

/** Every `seqeyes.` key the page has written, so "nothing stored" is testable. */
async function storedKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(window.localStorage)
      .filter((key) => key.startsWith('seqeyes.'))
      .sort());
}

test('brings back the units, Blocks toggle and k-space controls after a reload', async ({ page }) => {
  await openViewer(page);
  await loadSequence(page);

  await page.locator('#tu').selectOption('us');
  await page.locator('#gu').selectOption('mT/m');
  await page.locator('#bbc').check();
  await page.locator('#theme').selectOption('nord');

  // Cycle the projection off 3D and widen the ADC markers.
  await openKspace(page);
  await page.locator('#kax').click();
  await page.locator('#kdot').fill('7');

  await openViewer(page);

  await expect(page.locator('#tu')).toHaveValue('us');
  await expect(page.locator('#gu')).toHaveValue('mT/m');
  await expect(page.locator('#bbc')).toBeChecked();
  await expect(page.locator('#theme')).toHaveValue('nord');
  await expect(page.locator('body')).toHaveClass(/theme-nord/);
  await expect(page.locator('#kax')).toHaveText('XY');
  await expect(page.locator('#kdot')).toHaveValue('7');
  expect((await debugState(page)).kView).toBe('xy');
});

test('restores the ASC profile without asking for the file again', async ({ page }) => {
  await openViewer(page);
  await loadSequence(page);

  await page.locator('#ascInput').setInputFiles(fixtures.combinedAsc);
  await expect(page.locator('#pnsBtn')).toHaveText('ASC: synthetic_combined');

  await openViewer(page);

  // Restored before any sequence is open: the profile describes the scanner,
  // not the sequence.
  await expect(page.locator('#pnsBtn')).toHaveText('ASC: synthetic_combined');

  // And it applies to whatever is opened next, rather than leaving a labelled
  // button over an unavailable PNS row.
  await loadSequence(page);
  await expect
    .poll(async () => (await debugState(page)).visibleChannels)
    .toContain('PNS');
});

test('stores nothing and returns to defaults once the user opts out', async ({ page }) => {
  await openViewer(page);
  // A sequence has to be open before the toolbar is reachable: the splash
  // screen covers it, and it is what writes most of the keys being purged.
  await loadSequence(page);
  await page.locator('#tu').selectOption('s');
  expect(await storedKeys(page)).toContain('seqeyes.timeUnit');

  await page.locator('#prefsBtn').click();
  await expect(page.locator('#prefsControls')).toBeVisible();
  await page.locator('#prefsRemember').uncheck();

  expect(await storedKeys(page)).toEqual(['seqeyes.rememberSettings']);

  // The control the user already changed keeps working for this session.
  await page.locator('#gu').selectOption('G/cm');
  await expect(page.locator('#gu')).toHaveValue('G/cm');
  expect(await storedKeys(page)).toEqual(['seqeyes.rememberSettings']);

  await openViewer(page);
  await expect(page.locator('#tu')).toHaveValue('ms');
  await expect(page.locator('#gu')).toHaveValue('Hz/m');
  await expect(page.locator('#prefsBtn')).toBeVisible();
});

test('keeps the choices made while opted out when the user opts back in', async ({ page }) => {
  await openViewer(page);
  await loadSequence(page);
  await page.locator('#prefsBtn').click();
  await page.locator('#prefsRemember').uncheck();

  await page.locator('#tu').selectOption('us');
  expect(await storedKeys(page)).toEqual(['seqeyes.rememberSettings']);

  await page.locator('#prefsRemember').check();
  expect(await storedKeys(page)).toContain('seqeyes.timeUnit');

  await openViewer(page);
  await expect(page.locator('#tu')).toHaveValue('us');
});

test('forgets a stored ASC profile along with everything else', async ({ page }) => {
  await openViewer(page);
  await loadSequence(page);
  await page.locator('#ascInput').setInputFiles(fixtures.combinedAsc);
  await expect(page.locator('#pnsBtn')).toHaveText('ASC: synthetic_combined');
  expect(await storedKeys(page)).toContain('seqeyes.asc.text');

  await page.locator('#prefsBtn').click();
  await page.getByRole('button', { name: 'Forget stored settings' }).click();
  expect(await storedKeys(page)).toEqual([]);

  await openViewer(page);
  await expect(page.locator('#pnsBtn')).toHaveText('Load ASC (PNS/Acoustic)');
});
