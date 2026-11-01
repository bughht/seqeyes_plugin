/**
 * Wheel-zoom probes shared by the standalone and VS Code webview specs.
 *
 * Not a spec file, so Playwright does not collect it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import { expect, type Page } from '@playwright/test';

/** The shipped calibration, read from the asset so tuning it by feel does not break the tests. */
export const WHEEL = runInNewContext(
  readFileSync(resolve('src/editor/webview/assets/wheel-zoom.js'), 'utf8')
  + ';({ notch: WHEEL_ZOOM_NOTCH, maxStep: WHEEL_ZOOM_MAX_STEP,'
  + ' kNotch: KSPACE_WHEEL_ZOOM_NOTCH, kMaxStep: KSPACE_WHEEL_ZOOM_MAX_STEP })',
) as { notch: number; maxStep: number; kNotch: number; kMaxStep: number };

export interface Wheel { deltaY: number; deltaMode?: number; ctrlKey?: boolean }

export const repeat = (count: number, wheel: Wheel): Wheel[] => Array.from({ length: count }, () => wheel);

/**
 * Dispatch `wheels` on `selector` at `at` (CSS px from its top-left corner;
 * the centre by default). `perFrame` lets one animation frame pass between
 * events, the cadence a trackpad delivers them at.
 */
export async function dispatchWheels(
  page: Page, selector: string, wheels: Wheel[], at?: { x: number; y: number }, perFrame = false,
): Promise<void> {
  await page.evaluate(async ({ selector, wheels, at, perFrame }) => {
    const el = document.querySelector(selector)!;
    const box = el.getBoundingClientRect();
    const clientX = box.left + (at ? at.x : box.width / 2), clientY = box.top + (at ? at.y : box.height / 2);
    for (const wheel of wheels) {
      el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX, clientY, ...wheel }));
      if (perFrame) await new Promise(done => requestAnimationFrame(done));
    }
  }, { selector, wheels, at, perFrame });
}

/** The factor the visible time span shrank by over `wheels`: above 1 zoomed in. */
export async function timeZoom(page: Page, selector: string, wheels: Wheel[]): Promise<number> {
  const span = () => page.evaluate(() => {
    const view = (window as unknown as { SeqEyesPanelHost: { getView(): { startSec: number; endSec: number } } })
      .SeqEyesPanelHost.getView();
    return view.endSec - view.startSec;
  });
  const before = await span();
  await dispatchWheels(page, selector, wheels);
  return before / await span();
}

export const nextFrames = (page: Page) =>
  page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));

/**
 * Keep what each canvas has written with fillText since its last full clear,
 * so a test can read the axis labels and positions of the frame on screen.
 * Install it before the canvas draws what is to be read.
 */
export async function recordCanvasText(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store: Record<string, { text: string; x: number; y: number }[]> = {};
    (window as unknown as { __canvasText: typeof store }).__canvasText = store;
    const proto = CanvasRenderingContext2D.prototype, fill = proto.fillText, clear = proto.clearRect;
    proto.clearRect = function (x: number, y: number, w: number, h: number) {
      if (x === 0 && y === 0) store[this.canvas.id] = [];
      clear.call(this, x, y, w, h);
    };
    proto.fillText = function (text: string, x: number, y: number, maxWidth?: number) {
      (store[this.canvas.id] ||= []).push({ text: String(text), x, y });
      if (maxWidth === undefined) fill.call(this, text, x, y); else fill.call(this, text, x, y, maxWidth);
    };
  });
}

export const canvasText = (page: Page, id: string) => page.evaluate(id =>
  ((window as unknown as { __canvasText: Record<string, { text: string; x: number; y: number }[]> })
    .__canvasText[id] || []).slice(), id);

/** The gradient rows' range labels ("±25.0mT/m") on the waveform canvas, top row first. */
export async function gradientRanges(page: Page): Promise<{ value: number; y: number }[]> {
  return (await canvasText(page, 'mc'))
    .map(({ text, y }) => ({ match: /^±([\d.]+)(k|M)?mT\/m$/.exec(text), y }))
    .filter(({ match }) => match)
    .map(({ match, y }) => ({ value: parseFloat(match![1]) * (match![2] === 'k' ? 1e3 : match![2] === 'M' ? 1e6 : 1), y }))
    .sort((a, b) => a.y - b.y);
}

/**
 * Ctrl+wheel over the first gradient row and return how much its range
 * label grew (the amplitude zoom factor), and whether the other rows held.
 */
export async function amplitudeZoom(page: Page, wheels: Wheel[]): Promise<{ factor: number; othersHeld: boolean }> {
  const before = await gradientRanges(page);
  if (before.length < 2) throw new Error(`expected the gradient rows' range labels, read ${JSON.stringify(before)}`);
  // A row's label sits 12 px below its top; rows are evenly spaced.
  const rowHeight = before[1].y - before[0].y;
  const box = (await page.locator('#mc').boundingBox())!;
  await dispatchWheels(page, '#mc', wheels.map(w => ({ ...w, ctrlKey: true })),
    { x: box.width / 2, y: before[0].y - 12 + rowHeight / 2 });
  await nextFrames(page);
  const after = await gradientRanges(page);
  return {
    factor: after[0].value / before[0].value,
    othersHeld: after.slice(1).every((row, i) => row.value === before[i + 1].value),
  };
}

/** Read `value` until it holds still for a quarter of a second, and return it. */
export async function settled<T>(page: Page, value: () => Promise<T>): Promise<T> {
  let last = await value();
  await expect.poll(async () => {
    const first = await value();
    await page.waitForTimeout(250);
    last = await value();
    return JSON.stringify(last) === JSON.stringify(first);
  }, { timeout: 15_000 }).toBe(true);
  return last;
}

/**
 * End any k-space easing where the camera is: a net-zero pan drag cancels the
 * animation and retargets it to the current view, so a wheel event that
 * follows starts from a still camera.
 */
export async function stillKspaceCamera(page: Page): Promise<void> {
  const box = (await page.locator('#kc').boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx + 1, cy);
  await page.mouse.move(cx, cy);
  await page.mouse.up({ button: 'right' });
}

/**
 * Wheel-zoom k-space by one notch at `at` (fractions of the canvas box) and
 * return, in CSS px, how far the kx and ky axis labels landed from where a
 * zoom anchored there puts them. Each label marks a fixed k, so anchored at
 * the cursor c it moves to c + (p - c) * factor, p being its anchor point; the
 * label itself is drawn 5 px right of and 5 px above p (kspace.js drawAxis3D).
 * Needs recordCanvasText installed before k-space first draws.
 */
export async function kspaceZoomAnchorError(page: Page, at: { x: number; y: number }): Promise<number> {
  const box = (await page.locator('#kc').boundingBox())!;
  const c = { x: box.width * at.x, y: box.height * at.y };
  const axes = async () => {
    const text = await canvasText(page, 'kc');
    return ['kx', 'ky'].map(name => text.find(t => t.text === name)).filter(t => t) as { x: number; y: number }[];
  };
  await expect.poll(async () => (await axes()).length, { timeout: 15_000 }).toBe(2);
  await settled(page, axes);
  await stillKspaceCamera(page);
  const before = await settled(page, axes);
  await dispatchWheels(page, '#kc', [{ deltaY: -100 }], c);
  const after = await settled(page, axes);
  const f = WHEEL.kNotch;
  return Math.max(...before.map((b, i) => {
    const px = b.x - 5, py = b.y + 5;
    return Math.hypot(after[i].x - 5 - (c.x + (px - c.x) * f), after[i].y + 5 - (c.y + (py - c.y) * f));
  }));
}
