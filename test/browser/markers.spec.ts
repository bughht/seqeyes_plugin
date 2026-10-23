import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { decodeAllBlocks } from '../../src/pulseq/decoder';
import { parseSequenceBytes } from '../../src/pulseq/sequenceReader';

/* Measurement markers in the standalone viewer (the renderer the web app,
   the GitHub Pages preview and MATLAB run). */

const gre = resolve('test/kspace_baselines/v151_gre/seq/writeGradientEcho.seq');
const epi = resolve('test/seqeyes_demo_seq_files/writeEpi.seq');

interface MarkerInfo { id: number; t: number; snap: string; readout: { block: number; gx: number } }
interface DevWindow {
  SeqEyesDev: {
    markers(): MarkerInfo[];
    markerState(): { suggestion: { t: number; label: string } | null; menuOpen: boolean; dragging: boolean; snapEnabled: boolean };
  };
  __seqeyesDebug: {
    state(): { offset: number; scale: number; visibleChannels: string[] };
    setView(start: number, end: number): boolean;
  };
}

/** The first Gx trapezoid's corners, as the decoder places them. */
function firstGxTrapezoid(): number[] {
  const seq = parseSequenceBytes(new Uint8Array(readFileSync(gre)), 'writeGradientEcho.seq');
  const block = decodeAllBlocks(seq).find(b => b.gx && b.gx.type === 'trap' && b.gx.duration > 5e-4)!;
  const times = Array.from(block.gx!.timePoints);
  return times.length === 5 ? times.slice(1) : times;
}

const consoleFailures = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const failures: string[] = [];
  consoleFailures.set(page, failures);
  page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
  page.on('pageerror', (error) => failures.push(error.message));
});

test.afterEach(async ({ page }) => {
  expect(consoleFailures.get(page) ?? []).toEqual([]);
});

test('right-click adds a marker snapped to a gradient corner, and a second gives Δt', async ({ page }) => {
  const corners = firstGxTrapezoid();
  await loadViewer(page, gre);
  await setView(page, corners[0] - 2e-4, corners[3] + 2e-4);

  // Nothing is suggested while just browsing.
  await hoverAt(page, corners[1], 'Gx', 3);
  expect((await markerState(page)).suggestion).toBeNull();

  await rightClickAt(page, corners[1], 'Gx', 3);
  const menu = page.locator('#markerMenu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.mk-item').first()).toContainText('Add marker at Gx flat-top start');
  // While the menu is open the ring marks its target.
  expect((await markerState(page)).suggestion?.label).toBe('Gx flat-top start');
  await menu.locator('.mk-item').first().click();
  await expect(menu).toBeHidden();

  let markers = await markerList(page);
  expect(markers).toHaveLength(1);
  expect(Math.abs(markers[0].t - corners[1])).toBeLessThan(1e-12);
  // This GRE plays Gx and Gy corners together; the pointer's row is named first.
  expect(markers[0].snap).toMatch(/^Gx flat-top start( · |$)/);
  expect(markers[0].readout.gx).not.toBe(0);

  await rightClickAt(page, corners[2], 'Gx', -3);
  await page.locator('#markerMenu .mk-item').first().click();
  markers = await markerList(page);
  expect(markers.map(m => m.snap.split(' · ')[0])).toEqual(['Gx flat-top start', 'Gx flat-top end']);

  const table = page.locator('#mkTable');
  await expect(table).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(2);
  const delta = ((corners[2] - corners[1]) * 1e3).toFixed(4);
  await expect(table.locator('tbody tr').nth(1).locator('td[data-col="delta"]')).toHaveText(delta);
  await expect(table.locator('.mk-summary')).toContainText('span ' + delta + ' ms');
  // Gradients read in mT/m by default, and each row leads with its remove button.
  await expect(page.locator('#gu')).toHaveValue('mT/m');
  await expect(table.locator('th[data-col="gx"]')).toHaveText('Gx (mT/m)');
  await expect(table.locator('tbody tr').first().locator('td').first().locator('button')).toHaveText('×');
  await expect(table.locator('thead th').nth(1)).toHaveText('Marker');

  // Once markers are in use, approaching a corner suggests it.
  await hoverAt(page, corners[3], 'Gx', 2);
  expect((await markerState(page)).suggestion?.label).toContain('Gx ramp-down end');
});

test('places a marker without snapping, and the menu closes on Escape or an outside click', async ({ page }) => {
  const corners = firstGxTrapezoid();
  await loadViewer(page, gre);
  await setView(page, corners[0] - 2e-4, corners[3] + 2e-4);

  const prevented = page.evaluate(() => new Promise<boolean>(done => {
    window.addEventListener('contextmenu', e => done(e.defaultPrevented), { once: true });
  }));
  await rightClickAt(page, corners[1], 'Gx', 4);
  expect(await prevented).toBe(true);
  await expect(page.locator('#markerMenu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#markerMenu')).toBeHidden();

  await rightClickAt(page, corners[1], 'Gx', 4);
  await page.mouse.click(5, 5);
  await expect(page.locator('#markerMenu')).toBeHidden();

  const pointerTime = await rightClickAt(page, corners[1], 'Gx', 4);
  await page.locator('#markerMenu .mk-item', { hasText: 'no snap' }).click();
  const [marker] = await markerList(page);
  expect(marker.snap).toBe('');
  expect(Math.abs(marker.t - pointerTime)).toBeLessThan(2 / (await viewState(page)).scale);
  expect(Math.abs(marker.t - corners[1])).toBeGreaterThan(1e-7);
});

test('draws markers on the overlay, keeps their times across zoom, and clears them for a new file', async ({ page }) => {
  const corners = firstGxTrapezoid();
  await loadViewer(page, gre);
  await setView(page, corners[0] - 2e-4, corners[3] + 2e-4);
  await page.mouse.move(5, 5);
  const before = await opaquePixelCount(page.locator('#moc'));

  await rightClickAt(page, corners[1], 'Gx', 3);
  await page.locator('#markerMenu .mk-item').first().click();
  await page.mouse.move(5, 5);
  await expect.poll(() => opaquePixelCount(page.locator('#moc'))).toBeGreaterThan(before + 200);

  const placed = (await markerList(page))[0].t;
  await setView(page, corners[0] - 1e-3, corners[3] + 1e-3);
  expect((await markerList(page))[0].t).toBe(placed);

  await page.locator('#fileInput').setInputFiles(epi);
  await expect.poll(async () => (await markerList(page)).length).toBe(0);
  await expect(page.locator('#mkTable')).toBeHidden();
});

test('removes one marker or all of them, from the menu or the table', async ({ page }) => {
  const corners = firstGxTrapezoid();
  await loadViewer(page, gre);
  await setView(page, corners[0] - 2e-4, corners[3] + 2e-4);
  for (const [i, t] of corners.entries()) {
    await rightClickAt(page, t, 'Gx', i === 0 ? 3 : -3);
    await page.locator('#markerMenu .mk-item').first().click();
  }
  expect(await markerList(page)).toHaveLength(4);

  await rightClickAt(page, corners[1], 'Gx', 0);
  await page.locator('#markerMenu .mk-item', { hasText: 'Remove M2' }).click();
  expect((await markerList(page)).map(m => m.id)).toEqual([1, 3, 4]);

  await page.locator('#mkTable tr[data-marker="3"] button').click();
  expect((await markerList(page)).map(m => m.id)).toEqual([1, 4]);

  await rightClickAt(page, corners[1], 'Gx', 0);
  await page.locator('#markerMenu .mk-item', { hasText: 'Clear all markers' }).click();
  expect(await markerList(page)).toEqual([]);
  await expect(page.locator('#mkTable')).toBeHidden();
});

test('drags a marker without panning, snapping unless Shift is held', async ({ page }) => {
  const corners = firstGxTrapezoid();
  await loadViewer(page, gre);
  await setView(page, corners[0] - 2e-4, corners[3] + 2e-4);
  await rightClickAt(page, corners[1], 'Gx', 0);
  await page.locator('#markerMenu .mk-item').first().click();
  const offset = (await viewState(page)).offset;

  const start = await pointFor(page, corners[1], 'Gx', 0);
  const target = await pointFor(page, corners[2], 'Gx', -4);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + target.x) / 2, target.y, { steps: 4 });
  expect((await markerState(page)).dragging).toBe(true);
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await page.mouse.up();
  expect((await viewState(page)).offset).toBe(offset);
  let [marker] = await markerList(page);
  expect(Math.abs(marker.t - corners[2])).toBeLessThan(1e-12);
  expect(marker.snap).toMatch(/^Gx flat-top end( · |$)/);

  const back = await pointFor(page, corners[1], 'Gx', 4);
  await page.mouse.move(target.x + 4, target.y);
  await page.mouse.down();
  await page.keyboard.down('Shift');
  await page.mouse.move(back.x, back.y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  [marker] = await markerList(page);
  expect(marker.snap).toBe('');
  expect(Math.abs(marker.t - corners[1])).toBeGreaterThan(1e-7);
  expect((await viewState(page)).offset).toBe(offset);
});

test('remembers whether to snap', async ({ page }) => {
  const corners = firstGxTrapezoid();
  await loadViewer(page, gre);
  await setView(page, corners[0] - 2e-4, corners[3] + 2e-4);
  await rightClickAt(page, corners[1], 'Gx', 3);
  await page.locator('#markerMenu .mk-check input').first().uncheck();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => localStorage.getItem('seqeyes.markers.snap'))).toBe('0');

  await loadViewer(page, gre);
  await setView(page, corners[0] - 2e-4, corners[3] + 2e-4);
  await rightClickAt(page, corners[1], 'Gx', 3);
  await expect(page.locator('#markerMenu .mk-item').first()).toHaveText(/^Add marker here/);
  expect((await markerState(page)).snapEnabled).toBe(false);
});

/* ── Helpers ─────────────────────────────────────────────────────────── */

async function loadViewer(page: Page, sequencePath: string): Promise<void> {
  await page.goto('/?debug=1');
  await page.locator('#fileInput').setInputFiles(sequencePath);
  await expect(page.locator('#exportKspaceBtn')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#poverlay')).toBeHidden({ timeout: 10_000 });
}

async function setView(page: Page, start: number, end: number): Promise<void> {
  await page.evaluate(([s, e]) => (window as unknown as DevWindow).__seqeyesDebug.setView(s, e), [start, end]);
}

async function viewState(page: Page) {
  return await page.evaluate(() => (window as unknown as DevWindow).__seqeyesDebug.state());
}

/** Page coordinates of time `t` on a channel's row, `dx` pixels to the right. */
async function pointFor(page: Page, t: number, channel: string, dx: number): Promise<{ x: number; y: number; t: number }> {
  const box = (await page.locator('#mc').boundingBox())!;
  const view = await viewState(page);
  const top = 8, bottom = 22, left = 92;
  const row = view.visibleChannels.indexOf(channel);
  const height = (box.height - top - bottom) / view.visibleChannels.length;
  const x = left + (t - view.offset) * view.scale + dx;
  return { x: box.x + x, y: box.y + top + (row + 0.5) * height, t: view.offset + (x - left) / view.scale };
}

async function hoverAt(page: Page, t: number, channel: string, dx: number): Promise<void> {
  const p = await pointFor(page, t, channel, dx);
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(50);
}

/** Right-click there; returns the time under the pointer. */
async function rightClickAt(page: Page, t: number, channel: string, dx: number): Promise<number> {
  const p = await pointFor(page, t, channel, dx);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  return p.t;
}

async function markerList(page: Page): Promise<MarkerInfo[]> {
  return await page.evaluate(() => (window as unknown as DevWindow).SeqEyesDev.markers());
}

async function markerState(page: Page) {
  return await page.evaluate(() => (window as unknown as DevWindow).SeqEyesDev.markerState());
}

async function opaquePixelCount(locator: Locator): Promise<number> {
  return await locator.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (!context || !canvas.width || !canvas.height) return 0;
    const image = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 3; i < image.length; i += 4) if (image[i] > 8) count++;
    return count;
  });
}

test('adds an M1 column once the M1 rows are shown', async ({ page }) => {
  const corners = firstGxTrapezoid();
  await loadViewer(page, gre);
  await setView(page, corners[0] - 2e-4, corners[3] + 2e-4);
  await rightClickAt(page, corners[1], 'Gx', 3);
  await page.locator('#markerMenu .mk-item').first().click();
  await expect(page.locator('#mkTable th', { hasText: 'M1 / PNS' })).toHaveCount(0);

  await page.locator('#legend .li').filter({ hasText: 'M1x' }).click();
  await expect(page.locator('#mkTable th', { hasText: 'M1 / PNS' })).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator('#mkTable tbody tr').first().locator('td[data-col="derived"]')).toHaveText(/^M1: M1x/);
  expect(await page.evaluate(() => (window as unknown as { SeqEyesDev: { markerTable(): string } }).SeqEyesDev.markerTable()))
    .toContain('M1 / PNS');
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });

  test('a long-press opens the menu, a tap still shows the readout, and a finger drags a marker', async ({ page }) => {
    const corners = firstGxTrapezoid();
    await loadViewer(page, gre);
    await setView(page, corners[0] - 2e-4, corners[3] + 2e-4);

    // A tap is still the renderer's: the tooltip, no menu.
    const tap = await pointFor(page, (corners[1] + corners[2]) / 2, 'Gx', 0);
    await touch(page, 'touchstart', tap.x, tap.y);
    await touch(page, 'touchend', tap.x, tap.y);
    await expect(page.locator('#tt')).toBeVisible();
    await expect(page.locator('#markerMenu')).toHaveCount(0);

    // Held still, it opens the menu, which offers the corner within reach.
    const offset = (await viewState(page)).offset;
    const press = await pointFor(page, corners[1], 'Gx', 10);
    await touch(page, 'touchstart', press.x, press.y);
    await page.waitForTimeout(650);
    await expect(page.locator('#markerMenu')).toBeVisible();
    await touch(page, 'touchmove', press.x + 30, press.y);
    await touch(page, 'touchend', press.x + 30, press.y);
    expect((await viewState(page)).offset).toBe(offset);
    await expect(page.locator('#tt')).toBeHidden();
    await expect(page.locator('#markerMenu .mk-item').first()).toContainText('Add marker at Gx flat-top start');
    await page.locator('#markerMenu .mk-item').first().click();
    expect((await markerList(page)).map(m => m.snap.split(' · ')[0])).toEqual(['Gx flat-top start']);

    // A finger on the marker moves it instead of panning.
    const grab = await pointFor(page, corners[1], 'Gx', 6);
    const drop = await pointFor(page, corners[2], 'Gx', -10);
    await touch(page, 'touchstart', grab.x, grab.y);
    await touch(page, 'touchmove', (grab.x + drop.x) / 2, grab.y);
    await touch(page, 'touchmove', drop.x, drop.y);
    await touch(page, 'touchend', drop.x, drop.y);
    expect((await viewState(page)).offset).toBe(offset);
    const [marker] = await markerList(page);
    expect(Math.abs(marker.t - corners[2])).toBeLessThan(1e-12);
  });
});

/** Dispatch one touch event on the plot, as a single finger. */
async function touch(page: Page, type: string, x: number, y: number): Promise<void> {
  await page.evaluate(({ type, x, y }) => {
    const mc = document.getElementById('mc')!;
    const finger = new Touch({ identifier: 1, target: mc, clientX: x, clientY: y });
    const down = type === 'touchend' ? [] : [finger];
    mc.dispatchEvent(new TouchEvent(type, {
      touches: down, targetTouches: down, changedTouches: [finger], bubbles: true, cancelable: true,
    }));
  }, { type, x, y });
}
