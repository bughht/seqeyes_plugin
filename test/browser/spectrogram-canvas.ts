/**
 * Rendered-state checks for the spectrogram panel, shared by the standalone
 * and VS Code webview lanes: both run panel.js from the shared bundle, so they
 * must hold the same canvases to the same standard.
 */
import { expect, type Page } from '@playwright/test';

/** The one visible analysis pane takes the whole body, not its split share. */
export async function expectPaneFillsBody(page: Page, selector: '#sgPane' | '#spPane'): Promise<void> {
  await expect.poll(async () => await page.evaluate((paneSelector) => {
    const body = document.getElementById('sgBody')!.getBoundingClientRect();
    const pane = document.querySelector(paneSelector)!.getBoundingClientRect();
    return Math.abs(body.height - pane.height) <= 1 && Math.abs(body.width - pane.width) <= 1;
  }, selector), { timeout: 10_000 }).toBe(true);
}

/** The visible spectrogram image matches its pane and is not a flat fill. */
export async function expectSpectrogramDrawn(page: Page): Promise<void> {
  await expect.poll(async () => await page.evaluate(() => {
    const pane = document.getElementById('sgPane')!.getBoundingClientRect();
    const canvas = document.getElementById('sgImg') as HTMLCanvasElement;
    const box = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (!(pane.width > 0 && pane.height > 0)) return 'pane hidden';
    if (Math.abs(box.width - pane.width) > 1 || Math.abs(box.height - pane.height) > 1) {
      return `canvas ${box.width}x${box.height} in pane ${pane.width}x${pane.height}`;
    }
    if (Math.abs(canvas.width - pane.width * dpr) > 1 || Math.abs(canvas.height - pane.height * dpr) > 1) {
      return `backing ${canvas.width}x${canvas.height} for pane ${pane.width}x${pane.height}`;
    }
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 4; i < data.length; i += 4) {
      if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2] || data[i + 3] !== data[3]) {
        return 'drawn';
      }
    }
    return 'flat image';
  }), { timeout: 15_000 }).toBe('drawn');
}

/**
 * The spectrum canvas matches its pane, on screen and in its backing store,
 * and carries every gradient trace (and the band shading, when asked) in its
 * own colour — not merely the empty frame.
 */
export async function expectSpectrumDrawn(page: Page, options: { bands?: boolean } = {}): Promise<void> {
  await expect.poll(async () => await page.evaluate((wantBands) => {
    const pane = document.getElementById('spPane')!.getBoundingClientRect();
    const canvas = document.getElementById('spCanvas') as HTMLCanvasElement;
    const box = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (!(pane.width > 0 && pane.height > 0)) return 'pane hidden';
    if (Math.abs(box.width - pane.width) > 1 || Math.abs(box.height - pane.height) > 1) {
      return `canvas ${box.width}x${box.height} in pane ${pane.width}x${pane.height}`;
    }
    if (Math.abs(canvas.width - pane.width * dpr) > 1 || Math.abs(canvas.height - pane.height * dpr) > 1) {
      return `backing ${canvas.width}x${canvas.height} for pane ${pane.width}x${pane.height}`;
    }
    const probe = document.createElement('canvas').getContext('2d')!;
    const rgb = (color: string): number[] => {
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = color;
      probe.fillRect(0, 0, 1, 1);
      return Array.from(probe.getImageData(0, 0, 1, 1).data.slice(0, 3));
    };
    const style = getComputedStyle(document.body);
    const colors: Record<string, number[]> = {
      gx: rgb(style.getPropertyValue('--gx').trim()),
      gy: rgb(style.getPropertyValue('--gy').trim()),
      gz: rgb(style.getPropertyValue('--gz').trim()),
      rss: rgb(style.getPropertyValue('--fg').trim()),
    };
    // A band's centre line is drawn in the hot colour once energy reaches it.
    if (wantBands) { colors.band = rgb('#b8860b'); colors.hotBand = rgb('#e0521b'); }
    const counts: Record<string, number> = {};
    for (const key of Object.keys(colors)) counts[key] = 0;
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 96) continue;
      for (const key of Object.keys(colors)) {
        const c = colors[key];
        if (Math.abs(data[i] - c[0]) + Math.abs(data[i + 1] - c[1]) + Math.abs(data[i + 2] - c[2]) < 60) counts[key]++;
      }
    }
    if (wantBands) { counts.band += counts.hotBand; delete counts.hotBand; }
    const missing = Object.keys(counts).filter(key => counts[key] < 20);
    return missing.length ? `missing ${missing.join(', ')}: ${JSON.stringify(counts)}` : 'drawn';
  }, !!options.bands), { timeout: 15_000 }).toBe('drawn');
}
