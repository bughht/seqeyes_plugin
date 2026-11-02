/**
 * The Python package's notebook output: web/index.html run as the "python"
 * host, assembled by the package's own renderer and shown the way Jupyter
 * shows it, in a data: iframe inside the notebook page. A data: iframe has an
 * opaque origin, so it can fetch nothing and its storage throws.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { expect, test, type Frame, type Page } from '@playwright/test';

const PYTHON = process.env.SEQEYES_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
// Overridable so the same checks can be pointed at another copy of the package.
const PYTHON_SRC = resolve(process.env.SEQEYES_PYTHON_SRC ?? 'python/src');

const fixtures = {
  epi: resolve('test/seqeyes_demo_seq_files/writeEpi.seq'),
  binaryGre: resolve('test/pulseq/binary/gre.bseq'),
};

/** What SeqEyesViewer.from_file(path, **options).<method>() returns. */
function pythonOutput(sequencePath: string, options: Record<string, unknown> = {}, method = '_repr_html_'): string {
  const script = [
    'import json, os, sys',
    'import seqeyes',
    'from seqeyes import SeqEyesViewer',
    // Never fall back silently to an installed copy of the package.
    'assert os.path.realpath(seqeyes.__file__).startswith(os.path.realpath(sys.argv[3])), seqeyes.__file__',
    'viewer = SeqEyesViewer.from_file(sys.argv[1], **json.loads(sys.argv[2]))',
    'sys.stdout.write(getattr(viewer, sys.argv[4])())',
  ].join('\n');
  return execFileSync(PYTHON, ['-c', script, sequencePath, JSON.stringify(options), PYTHON_SRC, method], {
    env: { ...process.env, PYTHONPATH: PYTHON_SRC },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** A notebook page holding one output cell, served from the test server's origin. */
async function openNotebook(page: Page, output: string): Promise<Frame> {
  await page.route('**/notebook.html', route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!DOCTYPE html><html><body style="margin:0"><div class="output" style="width:960px;padding:8px">${output}</div></body></html>`,
  }));
  await page.goto('/notebook.html');
  const frame = await (await page.locator('iframe').elementHandle())?.contentFrame();
  expect(frame).toBeTruthy();
  expect(frame!.url()).toMatch(/^data:text\/html;base64,/);
  return frame!;
}

async function openViewer(page: Page, sequencePath: string, options: Record<string, unknown> = {}): Promise<Frame> {
  const frame = await openNotebook(page, pythonOutput(sequencePath, options));
  await expect(frame.locator('#exportKspaceBtn')).toBeEnabled({ timeout: 30_000 });
  await expect(frame.locator('#poverlay')).toBeHidden({ timeout: 10_000 });
  return frame;
}

type View = { startSec: number; endSec: number; totalDuration: number };
const view = (frame: Frame) => frame.evaluate(() =>
  (window as unknown as { SeqEyesPanelHost: { getView(): View } }).SeqEyesPanelHost.getView());

async function expectCanvasVaried(frame: Frame, selector: string): Promise<void> {
  await expect.poll(() => frame.locator(selector).evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    if (!canvas.width || !canvas.height) return false;
    const image = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!image) return false;
    for (let i = 4; i < image.length; i += 4) {
      if (image[i] !== image[0] || image[i + 1] !== image[1] || image[i + 2] !== image[2] || image[i + 3] !== image[3]) return true;
    }
    return false;
  }), { timeout: 10_000 }).toBe(true);
}

/** Text drawn on a canvas by its next full redraw, which a resize forces. */
async function redrawnText(frame: Frame, canvasId: string): Promise<string[]> {
  return frame.evaluate(async (id) => {
    const drawn: string[] = [];
    const proto = CanvasRenderingContext2D.prototype, fill = proto.fillText;
    proto.fillText = function (text: string, x: number, y: number, maxWidth?: number) {
      if (this.canvas.id === id) drawn.push(String(text));
      if (maxWidth === undefined) fill.call(this, text, x, y); else fill.call(this, text, x, y, maxWidth);
    };
    window.dispatchEvent(new Event('resize'));
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    proto.fillText = fill;
    return drawn;
  }, canvasId);
}

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

test('loads and draws the sequence inside the notebook iframe', async ({ page }) => {
  const frame = await openViewer(page, fixtures.epi);

  await expect.poll(() => frame.evaluate(() => document.title)).toMatch(/^SeqEyes: /);
  await expect(frame.locator('#splash')).toBeHidden();
  await expectCanvasVaried(frame, '#mc');
  await expectCanvasVaried(frame, '#mmc');
  // The stylesheet is inlined: the toolbar is laid out as one flex row.
  await expect(frame.locator('#tb')).toHaveCSS('display', 'flex');
  // The default range keeps the page's own first view, not the whole sequence.
  const { startSec, endSec, totalDuration } = await view(frame);
  expect(startSec).toBe(0);
  expect(endSec).toBeLessThan(totalDuration);
});

test('loads binary sequences through the base64 preload', async ({ page }) => {
  const frame = await openViewer(page, fixtures.binaryGre);

  await expect.poll(() => frame.evaluate(() => document.title)).toContain('gre');
  await expectCanvasVaried(frame, '#mc');
});

test('hides what a data: iframe cannot use', async ({ page }) => {
  const frame = await openViewer(page, fixtures.epi);

  for (const id of ['openBtn', 'splashOpen', 'dropZone', 'openUrlBtn', 'openSeqBtn', 'openBseqBtn', 'simBtn', 'prefsBtn', 'tbLogo']) {
    await expect(frame.locator(`#${id}`), id).toBeHidden();
  }
  for (const id of ['panelBtn', 'pnsBtn', 'theme', 'tu', 'gu', 'bbc']) {
    await expect(frame.locator(`#${id}`), id).toBeVisible();
  }
  expect(await frame.evaluate(() => {
    try { localStorage.getItem('seqeyes.theme'); return 'storage works'; } catch { return 'storage throws'; }
  })).toBe('storage throws');
});

test('keeps the settings button where storage works, as in a to_html() page', async ({ page }) => {
  const html = pythonOutput(fixtures.epi, {}, 'to_html');
  await page.route('**/plot.html', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto('/plot.html');
  await expect(page.locator('#exportKspaceBtn')).toBeEnabled({ timeout: 30_000 });

  await expect(page.locator('#prefsBtn')).toBeVisible();
  for (const id of ['openBtn', 'dropZone', 'openUrlBtn', 'simBtn', 'tbLogo']) {
    await expect(page.locator(`#${id}`), id).toBeHidden();
  }
});

test('applies the plot options once the sequence loads', async ({ page }) => {
  const frame = await openViewer(page, fixtures.epi, {
    time_range: [0.01, 0.02], time_disp: 'us', grad_disp: 'G/cm', show_blocks: true, theme: 'dracula',
  });

  await expect(frame.locator('#tu')).toHaveValue('us');
  await expect(frame.locator('#gu')).toHaveValue('G/cm');
  await expect(frame.locator('#bbc')).toBeChecked();
  await expect(frame.locator('#theme')).toHaveValue('dracula');
  await expect(frame.locator('body')).toHaveClass(/(^|\s)theme-dracula(\s|$)/);
  await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(40, 42, 54)');

  const shown = await view(frame);
  expect(shown.startSec).toBeCloseTo(0.01, 9);
  expect(shown.endSec).toBeCloseTo(0.02, 9);

  const text = await redrawnText(frame, 'mc');
  expect(text).toContain('time (us)');
  expect(text.some(label => /^±[\d.]+[kM]?G\/cm$/.test(label)), text.join(' | ')).toBe(true);
  expect(text.some(label => /^#\d+$/.test(label)), 'block boundary labels').toBe(true);
});

test('maps the plain dark theme and an open-ended time range', async ({ page }) => {
  const frame = await openViewer(page, fixtures.epi, { theme: 'dark', time_range: [0.05, null] });

  await expect(frame.locator('#theme')).toHaveValue('github');
  const shown = await view(frame);
  expect(shown.startSec).toBeCloseTo(0.05, 9);
  expect(shown.endSec).toBeCloseTo(shown.totalDuration, 9);
});

test('opens k-space', async ({ page }) => {
  const frame = await openViewer(page, fixtures.epi);

  await frame.locator('#panelBtn').click();
  await expect(frame.locator('#right')).toHaveClass(/open/);
  await expect.poll(async () => {
    const box = await frame.locator('#kc').boundingBox();
    return box ? Math.min(box.width, box.height) : 0;
  }, { timeout: 30_000 }).toBeGreaterThan(100);
  await expect.poll(() => frame.evaluate(() =>
    (window as unknown as { SeqEyesPanelHost: { hasKspaceData(): boolean } }).SeqEyesPanelHost.hasKspaceData()),
  { timeout: 20_000 }).toBe(true);
  await expectCanvasVaried(frame, '#kc');
});

test('fits the default 550 px output height', async ({ page }) => {
  const frame = await openViewer(page, fixtures.epi);

  const iframe = await page.locator('iframe').boundingBox();
  expect(iframe?.height).toBe(550);
  // writeEpi raises a notice; it starts collapsed, as on a phone.
  await expect(frame.locator('#viewerNoticeToggle')).toHaveText('Expand');
  const layout = await frame.evaluate(() => {
    const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    return { waveform: box('cc').height, bottom: box('main').bottom, height: window.innerHeight };
  });
  expect(layout.bottom).toBeLessThanOrEqual(layout.height + 0.5);
  // Most of the output is waveform, not chrome.
  expect(layout.waveform).toBeGreaterThan(layout.height * 0.7);
});

/**
 * The old Jupyter viewer kept its own minimap renderer and blitted its
 * device-resolution cache without a destination size, so above DPR 1 the
 * strip was drawn DPR times too wide. The shared page draws it at CSS size.
 */
test.describe('minimap at high DPI', () => {
  test.use({ deviceScaleFactor: 2 });

  test('places RF blocks at their true times', async ({ page }) => {
    const frame = await openNotebook(page, pythonOutput(fixtures.epi));

    const rfRuns = () => frame.evaluate(() => {
      const canvas = document.getElementById('mmc') as HTMLCanvasElement | null;
      if (!canvas || !canvas.width) return [];
      const dpr = window.devicePixelRatio || 1;
      // Strictly inside the RF band; the Gx band starts at exactly 5*dpr.
      const band = Math.max(1, Math.min(canvas.height, Math.floor(5 * dpr)));
      const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, band).data;
      if (!data) return [];
      const hit: boolean[] = [];
      for (let x = 0; x < canvas.width; x++) {
        let tinted = false;
        for (let y = 0; y < band; y++) {
          const i = (y * canvas.width + x) * 4;
          if (data[i] - data[i + 1] > 8 && data[i] - data[i + 2] > 4) tinted = true;
        }
        hit.push(tinted);
      }
      const runs: { from: number; to: number }[] = [];
      let start: number | null = null;
      hit.forEach((v, i) => {
        if (v && start === null) start = i;
        else if (!v && start !== null) { runs.push({ from: start / hit.length, to: (i - 1) / hit.length }); start = null; }
      });
      if (start !== null) runs.push({ from: start / hit.length, to: (hit.length - 1) / hit.length });
      return runs.filter(r => r.to - r.from > 0.002);
    });

    expect(await frame.evaluate(() => window.devicePixelRatio)).toBe(2);
    await expect.poll(async () => (await rfRuns()).length, { timeout: 30_000 }).toBeGreaterThan(0);
    await frame.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const found = await rfRuns();
    // writeEpi excites once per TR over three TRs.
    expect(found.length, `RF marks at ${JSON.stringify(found)}`).toBe(3);
    [0, 1 / 3, 2 / 3].forEach((want, index) => {
      expect(found[index].from, `RF marks at ${JSON.stringify(found)}`).toBeCloseTo(want, 2);
    });
  });
});
