import { expect, type Locator, type Page } from '@playwright/test';

/* Channel row order: gestures and readings shared by the standalone and VS
   Code webview specs, which drive the same module installed by two renderers.
   Both run the wide layout, where rows sit between an 8 px top and a 22 px
   bottom margin and the names fill a 92 px gutter. */

export const DEFAULT_ORDER = ['RF', 'φ', 'Gx', 'Gy', 'Gz', 'ADC', 'Trig', 'Label', 'PNS', 'M1x', 'M1y', 'M1z'];
export const DEFAULT_ROWS = ['RF', 'φ', 'Gx', 'Gy', 'Gz', 'ADC', 'Trig'];
const MARGIN = { top: 8, bottom: 22, left: 92 };

interface RowState { visible: string[]; dragging: boolean; menuOpen: boolean; target: { mode: string; index: number } | null }
interface RowWindow {
  SeqEyesDev: { channelOrder(): string[]; channelOrderState(): RowState };
  SeqEyesPanelHost: { getView(): { startSec: number; endSec: number } };
}

/** The whole order, hidden channels included, as the module reports it. */
export async function rowOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as RowWindow).SeqEyesDev.channelOrder());
}

export async function rowState(page: Page): Promise<RowState> {
  return page.evaluate(() => (window as unknown as RowWindow).SeqEyesDev.channelOrderState());
}

export async function shownRows(page: Page): Promise<string[]> {
  return (await rowState(page)).visible;
}

/** The legend's chips, without the label gear. */
export async function legendOrder(page: Page): Promise<string[]> {
  return (await page.locator('#legend .li').allTextContents()).filter(text => text !== '⚙');
}

/** Start of the visible time window, which a pan would move. */
export async function viewStart(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as RowWindow).SeqEyesPanelHost.getView().startSec);
}

/** Page coordinates on a channel's row: on its name, or in the middle of the plot. */
export async function rowPoint(page: Page, channel: string, frac = 0.5, where: 'gutter' | 'plot' = 'gutter') {
  const box = (await page.locator('#mc').boundingBox())!;
  const rows = await shownRows(page);
  const row = rows.indexOf(channel);
  expect(row, `${channel} is not a row on screen: ${rows.join(', ')}`).toBeGreaterThanOrEqual(0);
  const height = (box.height - MARGIN.top - MARGIN.bottom) / rows.length;
  const x = where === 'gutter' ? MARGIN.left / 2 : MARGIN.left + (box.width - MARGIN.left) / 2;
  return { x: box.x + x, y: box.y + MARGIN.top + (row + frac) * height };
}

/** Press on a channel's name and carry it over `onto`, `frac` of the way down that row; the button stays down. */
export async function dragOver(page: Page, channel: string, onto: string, frac = 0.5): Promise<void> {
  const from = await rowPoint(page, channel);
  const to = await rowPoint(page, onto, frac);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
}

export async function dragRow(page: Page, channel: string, onto: string, frac = 0.5): Promise<void> {
  await dragOver(page, channel, onto, frac);
  await page.mouse.up();
}

/** Right-click a channel's name; returns the row menu. */
export async function openRowMenu(page: Page, channel: string): Promise<Locator> {
  const p = await rowPoint(page, channel);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  const menu = page.locator('#channelOrderMenu');
  await expect(menu).toBeVisible();
  return menu;
}

export function menuItem(menu: Locator, label: string): Locator {
  return menu.getByRole('menuitem', { name: label, exact: true });
}

export async function moveRow(page: Page, channel: string, label: string): Promise<void> {
  const menu = await openRowMenu(page, channel);
  await menuItem(menu, label).click();
  await expect(menu).toBeHidden();
}

export async function ctrlWheelOnRow(page: Page, channel: string, deltaY: number): Promise<void> {
  const p = await rowPoint(page, channel, 0.5, 'plot');
  await page.mouse.move(p.x, p.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, deltaY);
  await page.keyboard.up('Control');
}

/** A hash of each row's pixels on the waveform canvas, top to bottom. */
export async function rowSignatures(page: Page): Promise<string[]> {
  return page.locator('#mc').evaluate((element, margin) => {
    const canvas = element as HTMLCanvasElement, g = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const rows = (window as unknown as RowWindow).SeqEyesDev.channelOrderState().visible.length;
    const height = (canvas.height - (margin.top + margin.bottom) * dpr) / rows;
    const out: string[] = [];
    for (let r = 0; r < rows; r++) {
      // Two pixels in from each edge: the grid line between rows belongs to neither.
      const y0 = Math.ceil(margin.top * dpr + r * height) + 2, y1 = Math.floor(margin.top * dpr + (r + 1) * height) - 2;
      const data = g.getImageData(0, y0, canvas.width, Math.max(1, y1 - y0)).data;
      let hash = 2166136261;
      for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data[i], 16777619) >>> 0;
      out.push(hash.toString(16));
    }
    return out;
  }, MARGIN);
}

/** Row hashes once the canvas has stopped changing (late waveform detail redraws it). */
export async function settledRowSignatures(page: Page): Promise<string[]> {
  let last = await rowSignatures(page);
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(150);
    const next = await rowSignatures(page);
    if (next.join() === last.join()) return next;
    last = next;
  }
  throw new Error('the waveform canvas never settled');
}

/** The hover readout's lines, read from the tooltip. */
export async function readoutLines(page: Page, x: number, y: number): Promise<string[]> {
  await page.mouse.move(x, y);
  await expect(page.locator('#tt')).toBeVisible();
  return page.locator('#tt > div').allTextContents();
}

export function lineIndex(lines: string[], prefix: string): number {
  const at = lines.findIndex(line => line.startsWith(prefix));
  expect(at, `no "${prefix}" line in ${JSON.stringify(lines)}`).toBeGreaterThanOrEqual(0);
  return at;
}

/** Dispatch one touch event on the plot, as a single finger. */
export async function touch(page: Page, type: string, x: number, y: number): Promise<void> {
  await page.evaluate(({ type, x, y }) => {
    const mc = document.getElementById('mc')!;
    const finger = new Touch({ identifier: 1, target: mc, clientX: x, clientY: y });
    const down = type === 'touchend' ? [] : [finger];
    mc.dispatchEvent(new TouchEvent(type, {
      touches: down, targetTouches: down, changedTouches: [finger], bubbles: true, cancelable: true,
    }));
  }, { type, x, y });
}
