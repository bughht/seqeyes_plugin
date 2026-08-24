import { resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

interface PanelState {
  mode: 'off' | 'kspace' | 'spectrogram';
  open: boolean;
  busy: boolean;
  computeCount: number;
  renderCount: number;
  splitRatio: number;
  colormap: string;
  source: string;
  fMin: number;
  fMax: number;
  windowLevel: { width: number; level: number };
  windowLevelAuto: boolean;
  markerTimeSec: number;
  playheadTimeSec: number;
  bands: number;
  hotBands: number;
  audioState: string;
  audioContextState: string;
  audioAvailable: boolean;
  audioActivationPending: boolean;
  pendingAudioId: number;
  audioWindowStartSec: number | null;
  audioWindowEndSec: number | null;
  audioBoundedPreview: boolean;
  tStartSec: number | null;
  tEndSec: number | null;
  viewStartSec: number;
  viewEndSec: number;
  nTime: number;
  nFreq: number;
  dtResolutionSec: number | null;
  dfResolutionHz: number | null;
  decimationFactor: number | null;
  warnings: string[];
  error: string | null;
}

declare global {
  interface Window {
    SeqEyesDev: {
      panelMode(): string;
      setPanelMode(mode: string): string;
      spectrogramState(): PanelState;
      spectrumAtMarker(): { columnIndex: number; timeSec: number; rss: number[] } | null;
      setMarkerTime(t: number): void;
      acousticBands(): { freqHz: number; bwHz: number }[];
      setAcousticBands(bands: { freqHz: number; bwHz: number }[]): void;
      audioState(): {
        state: string;
        contextState: string;
        playing: boolean;
        currentTimeSec: number;
        hasBuffer: boolean;
        durationSec: number;
        auditionDurationSec: number;
      };
      setAudioClock(fn: (() => number) | null): void;
      setSplitRatio(r: number): void;
      getSplitRatio(): number;
    };
    __seqeyesDebug: {
      state(): { kOpen: boolean; totalDuration: number; panelMode: string };
      setView(start: number, end: number): boolean;
      showKspaceSafetyWarning(message: string): void;
    };
    __seqeyesTestClock?: number;
    SeqEyesPanel: {
      deliverSpectrogramError(id: number, message: string): void;
      deliverAudio(id: number, payload: unknown): void;
      stopPlayback(): void;
    };
    SeqEyesPanelHost: {
      getView(): { startSec: number; endSec: number; totalDuration: number };
      requestAudio(id: number, startSec: number, endSec: number, options: unknown): void;
      setNotice(key: string, message: string | string[] | null): void;
    };
  }
}

const fixtures = {
  gre: resolve('test/kspace_baselines/v151_gre/seq/writeGradientEcho.seq'),
  spiral: resolve('test/kspace_baselines/v151_spiral/seq/writeSpiral.seq'),
};

/** An ASC carrying acoustic resonances but no PNS coefficients (§8.2). */
function acousticOnlyAsc(): string {
  return [
    'aflGCAcousticResonanceFrequency[0] = 550.0',
    'aflGCAcousticResonanceBandwidth[0] = 100.0',
    'aflGCAcousticResonanceFrequency[1] = 1150.0',
    'aflGCAcousticResonanceBandwidth[1] = 220.0',
    '',
  ].join('\n');
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

// ─────────────────────────────────────────────────────────────────────────────

test('cycles the panel button through k-space, spectrogram and closed', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  const button = page.locator('#panelBtn');
  const right = page.locator('#right');

  await expect(button).toHaveText('K-Space / Spectrum');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(right).not.toHaveClass(/open/);

  await button.click();
  await expect(button).toHaveText('K-Space ▸ Spectrogram');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(right).toHaveClass(/open/);
  await expect(page.locator('#kpane')).toHaveClass(/on/);
  await expect(page.locator('#spane')).not.toHaveClass(/on/);

  await button.click();
  await expect(button).toHaveText('Spectrogram ✕');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#spane')).toHaveClass(/on/);
  await expect(page.locator('#kpane')).not.toHaveClass(/on/);

  await button.click();
  await expect(button).toHaveText('K-Space / Spectrum');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(right).not.toHaveClass(/open/);
});

test('restores the persisted panel mode across a reload', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.SeqEyesDev.panelMode()), { timeout: 10_000 })
    .toBe('spectrogram');
  await expect(page.locator('#panelBtn')).toHaveText('Spectrogram ✕');
});

test('renders a spectrogram whose time range tracks the visible window', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);

  const initial = await panelState(page);
  expect(initial.nTime).toBeGreaterThan(0);
  expect(initial.nFreq).toBeGreaterThan(0);
  expect(initial.decimationFactor).toBeGreaterThan(1);
  expect(initial.warnings.some(warning => warning.includes('TRs are visible'))).toBe(true);
  await expectCanvasVaried(page.locator('#sgImg'));

  const total = (await page.evaluate(() => window.__seqeyesDebug.state())).totalDuration;
  await page.evaluate((duration) => window.__seqeyesDebug.setView(duration * 0.3, duration * 0.4), total);
  await settlePanel(page);

  const wide = await panelState(page);
  expect(wide.viewStartSec).toBeCloseTo(total * 0.3, 6);
  expect(wide.viewEndSec).toBeCloseTo(total * 0.4, 6);
  // Column centres sit inside the requested window.
  expect(wide.tStartSec).toBeGreaterThanOrEqual(wide.viewStartSec - 1e-9);
  expect(wide.tEndSec).toBeLessThanOrEqual(wide.viewEndSec + 1e-9);
  // The auto rule keeps at least ~3 independent windows in view (§6.4).
  expect(wide.dtResolutionSec!).toBeLessThanOrEqual((wide.viewEndSec - wide.viewStartSec) / 3 + 1e-9);

  // Zooming further in trades frequency resolution for time resolution.
  await page.evaluate((duration) => window.__seqeyesDebug.setView(duration * 0.3, duration * 0.32), total);
  await settlePanel(page);
  const narrow = await panelState(page);
  expect(narrow.dtResolutionSec!).toBeLessThan(wide.dtResolutionSec!);
  expect(narrow.dfResolutionHz!).toBeGreaterThan(wide.dfResolutionHz!);
  expect(narrow.warnings.some(warning => warning.startsWith('Short view'))).toBe(true);
});

test('serves an unchanged view from cache instead of recomputing', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);

  const total = (await page.evaluate(() => window.__seqeyesDebug.state())).totalDuration;
  await page.evaluate((duration) => window.__seqeyesDebug.setView(duration * 0.2, duration * 0.5), total);
  await settlePanel(page);

  const before = (await panelState(page)).computeCount;
  // Away and back: the second view is a cache hit.
  await page.evaluate((duration) => window.__seqeyesDebug.setView(duration * 0.6, duration * 0.9), total);
  await expect.poll(async () => (await panelState(page)).computeCount, { timeout: 15_000 })
    .toBeGreaterThan(before);
  await settlePanel(page);
  const afterMove = (await panelState(page)).computeCount;

  await page.evaluate((duration) => window.__seqeyesDebug.setView(duration * 0.2, duration * 0.5), total);
  await page.waitForTimeout(500);
  expect((await panelState(page)).computeCount).toBe(afterMove);
});

test('adjusts window and level on middle-drag without recomputing', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);
  await expectCanvasVaried(page.locator('#sgImg'));
  await settlePanel(page);

  const before = await panelState(page);
  const beforePixels = await samplePixels(page.locator('#sgImg'));
  const box = await requireBox(page.locator('#sgOvl'));

  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await page.mouse.down({ button: 'middle' });
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(
      box.x + box.width * 0.6 - i * 2,
      box.y + box.height * 0.5 + i * 1.5,
    );
  }
  await page.mouse.up({ button: 'middle' });

  const after = await panelState(page);
  expect(after.windowLevelAuto).toBe(false);
  expect(after.windowLevel.width).not.toBeCloseTo(before.windowLevel.width, 3);
  // Window/level is a LUT re-index, never a recompute.
  expect(after.computeCount).toBe(before.computeCount);
  expect(await samplePixels(page.locator('#sgImg'))).not.toEqual(beforePixels);

  await page.locator('#sgWlReset').click();
  await expect.poll(async () => (await panelState(page)).windowLevelAuto).toBe(true);
  await expect.poll(async () => (await panelState(page)).windowLevel.width)
    .toBeCloseTo(before.windowLevel.width, 3);
});

test('centers Auto W/L on robust bounds and retains the prior scale for silent data', async ({ page }) => {
  await page.goto('/?debug=1');
  const result = await page.evaluate(() => {
    const populated = new Float32Array(101);
    populated.fill(1e-4, 0, 90);
    populated.fill(1, 90);
    const populatedSpec = {
      nTime: 101,
      nFreq: 1,
      maxValue: 1,
      data: { rss: populated },
    };
    const silentSpec = {
      nTime: 4,
      nFreq: 1,
      maxValue: 0,
      data: { rss: new Float32Array(4) },
    };
    const previous = { level: -23, width: 42 };
    const autoWindowLevel = (window as any).sgAutoWindowLevel as (
      spec: unknown,
      key: string,
      fallback: { level: number; width: number },
    ) => { level: number; width: number };
    return {
      populated: autoWindowLevel(populatedSpec, 'rss', previous),
      silent: autoWindowLevel(silentSpec, 'rss', previous),
    };
  });

  // The robust interval is [-80, 0] dB. Its center is -40 dB; the old
  // independent median calculation incorrectly centered this case at -80 dB.
  expect(result.populated.level).toBeCloseTo(-40, 3);
  expect(result.populated.width).toBeCloseTo(80, 3);
  expect(result.silent).toEqual({ level: -23, width: 42 });
});

test('places a marker on right-click and fills the four spectrum traces', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);
  await expectCanvasVaried(page.locator('#sgImg'));

  // With no marker the second pane shows the view average, never nothing.
  const averaged = await page.evaluate(() => window.SeqEyesDev.spectrumAtMarker());
  expect(averaged).not.toBeNull();
  expect(averaged!.columnIndex).toBe(-1);

  const box = await requireBox(page.locator('#sgOvl'));
  await page.mouse.click(box.x + box.width * 0.65, box.y + box.height * 0.5, { button: 'right' });

  const state = await panelState(page);
  expect(Number.isFinite(state.markerTimeSec)).toBe(true);
  expect(state.markerTimeSec).toBeGreaterThan(state.viewStartSec);
  expect(state.markerTimeSec).toBeLessThan(state.viewEndSec);

  const slice = await page.evaluate(() => window.SeqEyesDev.spectrumAtMarker());
  expect(slice).not.toBeNull();
  expect(slice!.columnIndex).toBeGreaterThanOrEqual(0);
  expect(slice!.rss.length).toBe(state.nFreq);
  await expectCanvasVaried(page.locator('#spCanvas'));

  // Escape clears the marker and returns the pane to the view average.
  await page.locator('#sgOvl').press('Escape');
  await expect.poll(async () => Number.isFinite((await panelState(page)).markerTimeSec)).toBe(false);
  const cleared = await page.evaluate(() => window.SeqEyesDev.spectrumAtMarker());
  expect(cleared!.columnIndex).toBe(-1);
});

test('draws acoustic bands on both sub-panes and labels the ASC button', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);
  await expectCanvasVaried(page.locator('#sgImg'));

  await expect(page.locator('#pnsBtn')).toHaveText('Load ASC (PNS/Acoustic)');
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#pnsBtn').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'acoustic-only.asc',
    mimeType: 'text/plain',
    buffer: Buffer.from(acousticOnlyAsc()),
  });

  await expect.poll(async () => (await panelState(page)).bands, { timeout: 15_000 }).toBe(2);
  await expect(page.locator('#pnsBtn')).toHaveText('ASC: acoustic-only');
  // Acoustic-only: PNS is reported missing, but the bands still load.
  await expect(page.locator('#viewerNotice')).toContainText('PNS coefficients are missing');

  await expect(page.locator('#sgLegend .li').filter({ hasText: 'Acoustic bands (2)' })).toBeVisible();
  await expectCanvasVaried(page.locator('#sgOvl'));
  await expectCanvasVaried(page.locator('#spCanvas'));

  const bands = await page.evaluate(() => window.SeqEyesDev.acousticBands());
  expect(bands).toEqual([{ freqHz: 550, bwHz: 100 }, { freqHz: 1150, bwHz: 220 }]);
});

test('reports bands that fall outside the displayed frequency range', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);

  await page.evaluate(() => window.SeqEyesDev.setAcousticBands([
    { freqHz: 550, bwHz: 100 },
    { freqHz: 8000, bwHz: 300 },
  ]));

  await expect(page.locator('#viewerNotice'))
    .toContainText('1 resonance band is outside the displayed frequency range');
});

test('changes the colormap without recomputing the matrix', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);
  await expectCanvasVaried(page.locator('#sgImg'));
  await settlePanel(page);

  const before = await panelState(page);
  const beforePixels = await samplePixels(page.locator('#sgImg'));
  expect(before.colormap).toBe('viridis');

  await page.locator('#sgCmap').selectOption('magma');
  await expect.poll(async () => (await panelState(page)).colormap).toBe('magma');
  expect((await panelState(page)).computeCount).toBe(before.computeCount);
  await expect.poll(async () => await samplePixels(page.locator('#sgImg')))
    .not.toEqual(beforePixels);
});

test('recomputes when the frequency ceiling or the source changes', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);
  await settlePanel(page);

  const baseline = await panelState(page);
  expect(baseline.fMax).toBeCloseTo(3000, 3);

  await page.locator('#sgFMax').fill('1500');
  await page.locator('#sgFMax').press('Enter');
  await expect.poll(async () => (await panelState(page)).fMax, { timeout: 15_000 }).toBeCloseTo(1500, 3);
  // A lower ceiling means more aggressive decimation.
  await expect.poll(async () => (await panelState(page)).decimationFactor, { timeout: 15_000 })
    .toBeGreaterThan(baseline.decimationFactor!);

  await page.locator('#sgSource').selectOption('dGdt');
  await expect.poll(async () => (await panelState(page)).source, { timeout: 15_000 }).toBe('dGdt');
  await expectCanvasVaried(page.locator('#sgImg'));

  await page.locator('#sgFit').click();
  await expect.poll(async () => (await panelState(page)).fMax, { timeout: 15_000 }).toBeCloseTo(3000, 3);
});

test('persists the split ratio and flips its direction with the orientation', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);

  expect((await panelState(page)).splitRatio).toBeCloseTo(0.75, 3);   // 3:1 default

  await page.evaluate(() => window.SeqEyesDev.setSplitRatio(0.5));
  await expect.poll(async () => (await panelState(page)).splitRatio).toBeCloseTo(0.5, 3);
  const landscapeHeights = await paneSizes(page);
  // Docked right: the panes stack, so the split runs up/down.
  expect(landscapeHeights.spectrogram.width).toBeCloseTo(landscapeHeights.spectrum.width, 0);
  expect(landscapeHeights.spectrogram.height).toBeGreaterThan(0);

  // Keep this orientation-contract test above the phone breakpoint. Narrow
  // portrait layouts intentionally replace the split with a one-pane switch.
  await page.setViewportSize({ width: 800, height: 1000 });
  await expect.poll(async () => await page.evaluate(() => document.body.classList.contains('layout-vertical')),
    { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(400);
  const portraitSizes = await paneSizes(page);
  // Docked bottom: the panes sit side by side, so the split runs left/right.
  expect(portraitSizes.spectrogram.height).toBeCloseTo(portraitSizes.spectrum.height, 0);
  expect(portraitSizes.spectrogram.width).toBeGreaterThan(0);
  // Each orientation keeps its own ratio; portrait has not been set, so 3:1.
  expect((await panelState(page)).splitRatio).toBeCloseTo(0.75, 3);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await panelState(page)).splitRatio, { timeout: 10_000 })
    .toBeCloseTo(0.5, 3);
});

test('offers the spectrogram as a way out of the k-space safety dialog', async ({ page }) => {
  await page.goto('/?debug=1');
  await page.locator('#splash').evaluate(element => { (element as HTMLElement).style.display = 'none'; });
  await page.evaluate(() => {
    window.__seqeyesDebug.showKspaceSafetyWarning(
      'K-space was skipped for 20.0M raster samples. Estimated peak memory: approximately 2.7 GiB (host-dependent).',
    );
  });

  await page.locator('#viewerNotice').locator('button', { hasText: 'Calculate anyway' }).click();
  const dialog = page.locator('#kspaceSafetyOverlay');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#kspaceSafetySpectrogram')).toBeVisible();

  await dialog.locator('#kspaceSafetySpectrogram').click();
  await expect(dialog).toBeHidden();
  // The spectrogram is view-windowed, so it stays reachable where k-space is not.
  await expect.poll(() => page.evaluate(() => window.SeqEyesDev.panelMode())).toBe('spectrogram');
  await expect(page.locator('#panelBtn')).toHaveText('Spectrogram ✕');
});

test('advances the playhead and the spectrum slice from the audio clock', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);
  // Long enough that playback neither loops (D4 kicks in under 250 ms) nor
  // reaches the end of the buffer while the test is still stepping its clock:
  // the injected clock controls the reported position, but the real
  // AudioContext still ends the source on its own schedule.
  await page.evaluate(() => window.__seqeyesDebug.setView(0, 1.5));
  await settlePanel(page);

  // A fake clock keeps CI off a real audio device while still exercising the
  // real AudioContext path: playback is driven by ctx.currentTime, not frames.
  await page.evaluate(() => {
    window.__seqeyesTestClock = 0;
    window.SeqEyesDev.setAudioClock(() => window.__seqeyesTestClock!);
  });

  await page.locator('#sgPlay').click();
  await expect.poll(async () => (await page.evaluate(() => window.SeqEyesDev.audioState())).hasBuffer,
    { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => (await panelState(page)).audioState, { timeout: 10_000 }).toBe('playing');

  const readings: number[] = [];
  for (let i = 1; i <= 4; i++) {
    await page.evaluate((seconds) => { window.__seqeyesTestClock = seconds; }, i * 0.02);
    await page.waitForTimeout(120);
    readings.push((await panelState(page)).playheadTimeSec);
  }
  for (let i = 1; i < readings.length; i++) {
    expect(readings[i]).toBeGreaterThan(readings[i - 1]);
  }

  await page.locator('#sgStop').click();
  await expect.poll(async () => (await panelState(page)).audioState).toBe('idle');
  await expect.poll(async () => Number.isFinite((await panelState(page)).playheadTimeSec)).toBe(false);
});

test('waits for a suspended audio context to activate before requesting sound', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);
  await page.evaluate(() => {
    const activation = { resumeCalls: 0, resumeHadGesture: false, requestedWhileRunning: false };
    (window as any).__audioActivation = activation;
    (window as any).AudioContext = class {
      state = 'suspended';
      currentTime = 0;
      sampleRate = 44_100;
      destination = {};
      createGain() { return { gain: { value: 0 }, connect() {} }; }
      createBuffer(channels: number, frames: number, sampleRate: number) {
        const data = Array.from({ length: channels }, () => new Float32Array(frames));
        return { duration: frames / sampleRate, getChannelData: (channel: number) => data[channel] };
      }
      createBufferSource() {
        return { buffer: null, loop: false, connect() {}, disconnect() {}, start() {}, stop() {}, onended: null };
      }
      resume() {
        activation.resumeCalls++;
        activation.resumeHadGesture = navigator.userActivation.isActive;
        return new Promise<void>((resolve) => setTimeout(() => {
          this.state = 'running';
          resolve();
        }, 20));
      }
    };
    window.SeqEyesPanelHost.requestAudio = () => {
      activation.requestedWhileRunning = window.SeqEyesDev.audioState().contextState === 'running';
    };
  });

  await page.locator('#sgPlay').click();
  await expect.poll(() => page.evaluate(() => (window as any).__audioActivation.requestedWhileRunning)).toBe(true);
  const activation = await page.evaluate(() => (window as any).__audioActivation);
  expect(activation.resumeCalls).toBe(1);
  expect(activation.resumeHadGesture).toBe(true);
  expect((await page.evaluate(() => window.SeqEyesDev.audioState())).contextState).toBe('running');
  await page.evaluate(() => window.SeqEyesPanel.stopPlayback());
});

test('keeps playback idle and retryable when audio activation is rejected', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);
  await page.evaluate(() => {
    (window as any).AudioContext = class {
      state = 'suspended';
      currentTime = 0;
      sampleRate = 44_100;
      destination = {};
      createGain() { return { gain: { value: 0 }, connect() {} }; }
      createBuffer() { return { duration: 0, getChannelData: () => new Float32Array(1) }; }
      createBufferSource() { return { connect() {}, start() {} }; }
      resume() { return Promise.reject(new Error('blocked')); }
    };
  });

  await page.locator('#sgPlay').click();
  await expect(page.locator('#viewerNotice')).toContainText('Audio could not start');
  await expect.poll(async () => (await panelState(page)).audioActivationPending).toBe(false);
  expect((await panelState(page)).audioState).toBe('idle');
  await expect(page.locator('#sgPlay')).toBeEnabled();
});

test('keeps an exact completed position, enables reset, and wraps endpoint replay', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);
  await page.evaluate(() => window.__seqeyesDebug.setView(0, 0.35));
  await settlePanel(page);
  await page.evaluate(() => window.SeqEyesDev.setMarkerTime(NaN));

  await page.locator('#sgPlay').click();
  await expect.poll(async () => (await panelState(page)).audioState, { timeout: 20_000 }).toBe('playing');
  await expect.poll(async () => (await panelState(page)).audioState, { timeout: 5_000 }).toBe('idle');

  const completed = await panelState(page);
  expect(completed.markerTimeSec).toBeCloseTo(completed.viewEndSec, 9);
  await expect(page.locator('#sgMarkerClear')).toBeEnabled();

  const replay = await captureNextAudioRequest(page);
  expect(replay.startSec).toBeCloseTo(completed.viewStartSec, 9);
  expect(replay.endSec).toBeCloseTo(completed.viewEndSec, 9);
  await page.evaluate(() => window.SeqEyesPanel.stopPlayback());

  await page.evaluate(() => window.__seqeyesDebug.setView(0.2, 0.55));
  await settlePanel(page);
  const moved = await panelState(page);
  expect(moved.markerTimeSec).toBeCloseTo(completed.viewEndSec, 9);

  const resumed = await captureNextAudioRequest(page);
  expect(resumed.startSec).toBeCloseTo(completed.viewEndSec, 9);
  expect(resumed.endSec).toBeCloseTo(moved.viewEndSec, 9);
  await page.evaluate(() => window.SeqEyesPanel.stopPlayback());

  await page.locator('#sgMarkerClear').click();
  await expect(page.locator('#sgMarkerClear')).toBeDisabled();
  expect(Number.isFinite((await panelState(page)).markerTimeSec)).toBe(false);

  const reset = await captureNextAudioRequest(page);
  expect(reset.startSec).toBeCloseTo(moved.viewStartSec, 9);
  expect(reset.endSec).toBeCloseTo(moved.viewEndSec, 9);
  await page.evaluate(() => window.SeqEyesPanel.stopPlayback());
});

test('preserves short-window loop boundaries across pause and resume', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);
  await page.evaluate(() => window.__seqeyesDebug.setView(0, 0.1));
  await settlePanel(page);
  await page.evaluate(() => {
    window.SeqEyesDev.setMarkerTime(NaN);
    window.__seqeyesTestClock = 0;
    window.SeqEyesDev.setAudioClock(() => window.__seqeyesTestClock!);
  });

  await page.locator('#sgPlay').click();
  await expect.poll(async () => (await panelState(page)).audioState, { timeout: 20_000 }).toBe('playing');
  const audio = await page.evaluate(() => window.SeqEyesDev.audioState());
  const rangeStart = (await panelState(page)).audioWindowStartSec!;

  await page.evaluate(() => { window.__seqeyesTestClock = 0.06; });
  await page.locator('#sgPlay').click();
  await expect.poll(async () => (await panelState(page)).audioState).toBe('paused');
  const paused = await panelState(page);
  expect(paused.markerTimeSec).toBeCloseTo(rangeStart + 0.06, 3);
  await expect(page.locator('#sgMarkerClear')).toBeEnabled();

  await page.locator('#sgPlay').click();
  await expect.poll(async () => (await panelState(page)).audioState).toBe('playing');
  await page.evaluate(() => { window.__seqeyesTestClock = 0.12; });
  await page.waitForTimeout(100);

  const resumed = await page.evaluate(() => window.SeqEyesDev.audioState());
  const expectedOffset = ((paused.markerTimeSec - rangeStart) + 0.06) % audio.durationSec;
  expect(resumed.currentTimeSec).toBeCloseTo(rangeStart + expectedOffset, 3);
  await page.evaluate(() => window.SeqEyesPanel.stopPlayback());
});

test('resumes a short audition once, then repeats the complete visible window', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);
  await page.evaluate(() => window.__seqeyesDebug.setView(0.2, 0.3));
  await settlePanel(page);
  await page.evaluate(() => {
    window.SeqEyesDev.setMarkerTime(0.26);
    window.__seqeyesTestClock = 0;
    window.SeqEyesDev.setAudioClock(() => window.__seqeyesTestClock!);
  });
  const before = await panelState(page);

  await page.locator('#sgPlay').click();
  await expect.poll(async () => (await panelState(page)).audioState, { timeout: 20_000 }).toBe('playing');

  const range = await panelState(page);
  const audio = await page.evaluate(() => window.SeqEyesDev.audioState());
  expect(range.audioWindowStartSec).toBeCloseTo(0.2, 9);
  expect(range.audioWindowEndSec).toBeCloseTo(0.3, 9);
  expect(audio.durationSec).toBeCloseTo(0.1, 3);
  expect(audio.currentTimeSec).toBeCloseTo(before.markerTimeSec, 3);
  const span = before.viewEndSec - before.viewStartSec;
  const firstPass = before.viewEndSec - before.markerTimeSec;
  const repeats = Math.ceil((1 - firstPass) / span - 1e-9);
  expect(audio.auditionDurationSec).toBeCloseTo(firstPass + repeats * span, 3);

  await page.evaluate(() => { window.__seqeyesTestClock = 0.03; });
  expect((await page.evaluate(() => window.SeqEyesDev.audioState())).currentTimeSec)
    .toBeCloseTo(before.markerTimeSec + 0.03, 3);

  await page.evaluate(() => { window.__seqeyesTestClock = 0.05; });
  const wrapped = before.viewStartSec
    + ((before.markerTimeSec - before.viewStartSec + 0.05) % span);
  expect((await page.evaluate(() => window.SeqEyesDev.audioState())).currentTimeSec)
    .toBeCloseTo(wrapped, 3);
  await page.evaluate(() => window.SeqEyesPanel.stopPlayback());
});

test('wraps a resumed short audition to the window start on the browser audio clock', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);
  await page.evaluate(() => window.__seqeyesDebug.setView(0.2, 0.3));
  await settlePanel(page);
  await page.evaluate(() => window.SeqEyesDev.setMarkerTime(0.26));
  const before = await panelState(page);

  await page.locator('#sgPlay').click();
  await expect.poll(async () => (await panelState(page)).audioState, { timeout: 20_000 }).toBe('playing');

  const positions: number[] = [];
  for (let i = 0; i < 25; i++) {
    positions.push((await page.evaluate(() => window.SeqEyesDev.audioState())).currentTimeSec);
    await page.waitForTimeout(10);
  }
  expect(Math.max(...positions)).toBeGreaterThan(before.markerTimeSec + 0.02);
  expect(Math.min(...positions)).toBeLessThan(before.markerTimeSec - 0.02);
  expect(Math.min(...positions)).toBeGreaterThanOrEqual(before.viewStartSec - 0.002);
  await page.evaluate(() => window.SeqEyesPanel.stopPlayback());
});

test('does not loop a short retained tail from a long visible window', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);
  await page.evaluate(() => window.__seqeyesDebug.setView(0.2, 0.7));
  await settlePanel(page);
  await page.evaluate(() => window.SeqEyesDev.setMarkerTime(0.52));
  const before = await panelState(page);

  const snapshot = await page.evaluate(() => new Promise<{
      startSec: number;
      endSec: number;
      durationSec: number;
      auditionDurationSec: number;
    }>((resolve) => {
    window.SeqEyesPanelHost.requestAudio = (id, startSec, endSec) => {
      const frames = Math.max(1, Math.round((endSec - startSec) * 44_100));
      const left = new Float32Array(frames).fill(0.1);
      const right = new Float32Array(frames).fill(-0.1);
      window.SeqEyesPanel.deliverAudio(id, { sampleRate: 44_100, left, right, startSec });
      const audio = window.SeqEyesDev.audioState();
      resolve({
        startSec,
        endSec,
        durationSec: audio.durationSec,
        auditionDurationSec: audio.auditionDurationSec,
      });
    };
    (document.getElementById('sgPlay') as HTMLButtonElement).click();
  }));

  expect(snapshot).not.toBeNull();
  expect(snapshot!.startSec).toBeCloseTo(before.markerTimeSec, 3);
  expect(snapshot!.endSec).toBeCloseTo(before.viewEndSec, 9);
  const tail = before.viewEndSec - before.markerTimeSec;
  expect(tail).toBeLessThan(0.25);
  expect(snapshot!.durationSec).toBeCloseTo(tail, 3);
  expect(snapshot!.auditionDurationSec).toBeCloseTo(tail, 3);
  await page.evaluate(() => window.SeqEyesPanel.stopPlayback());
});

test('stops playback when the panel leaves spectrogram mode', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);
  await page.evaluate(() => window.__seqeyesDebug.setView(0, 1.5));
  await settlePanel(page);

  await page.evaluate(() => {
    window.__seqeyesTestClock = 0;
    window.SeqEyesDev.setAudioClock(() => window.__seqeyesTestClock!);
  });
  await page.locator('#sgPlay').click();
  await expect.poll(async () => (await panelState(page)).audioState, { timeout: 20_000 }).toBe('playing');

  await page.locator('#panelBtn').click();   // -> off
  await expect.poll(async () => (await panelState(page)).audioState).toBe('idle');
});

test('stops playback on a viewport change and ignores the invalidated audio response', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);
  await page.evaluate(() => window.__seqeyesDebug.setView(0, 1.5));
  await settlePanel(page);

  await page.evaluate(() => { window.SeqEyesPanelHost.requestAudio = () => {}; });
  await page.locator('#sgPlay').click();
  await expect.poll(async () => (await panelState(page)).pendingAudioId).toBeGreaterThan(0);
  const oldId = (await panelState(page)).pendingAudioId;

  await page.evaluate(() => window.__seqeyesDebug.setView(0.1, 1.4));
  await expect.poll(async () => (await panelState(page)).audioState).toBe('idle');
  await expect.poll(async () => (await panelState(page)).pendingAudioId).toBe(0);

  await page.evaluate((id) => {
    window.SeqEyesPanel.deliverAudio(id, {
      sampleRate: 44100,
      startSec: 0,
      left: new Float32Array([0.5, 0.25]),
      right: new Float32Array([0.5, 0.25]),
    });
  }, oldId);
  expect((await panelState(page)).audioState).toBe('idle');
});

test('uses a bounded preview instead of synthesising an overlong visible window', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);

  const request = await page.evaluate(() => new Promise<{ id: number; startSec: number; endSec: number }>((resolve) => {
    window.SeqEyesPanelHost.getView = () => ({ startSec: 0, endSec: 120, totalDuration: 120 });
    window.SeqEyesPanelHost.requestAudio = (id, startSec, endSec) => {
      resolve({ id, startSec, endSec });
    };
    (document.getElementById('sgPlay') as HTMLButtonElement).click();
  }));

  expect(request.id).toBeGreaterThan(0);
  expect(request.startSec).toBe(0);
  expect(request.endSec).toBe(30);
  const state = await panelState(page);
  expect(state.audioBoundedPreview).toBe(true);
  expect(state.audioWindowEndSec).toBe(30);
  await page.evaluate(() => window.SeqEyesPanel.stopPlayback());
});

test('clears a stale spectrogram when the current viewport is refused', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);
  expect((await panelState(page)).nTime).toBeGreaterThan(0);

  await page.evaluate(() => {
    window.SeqEyesPanel.deliverSpectrogramError(0, 'Zoom in to compute the spectrogram.');
  });

  const state = await panelState(page);
  expect(state.nTime).toBe(0);
  expect(state.nFreq).toBe(0);
  expect(state.error).toContain('Zoom in');
});

test('renders each warning as a separate theme-aware row', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await page.evaluate(() => {
    window.SeqEyesPanelHost.setNotice('test', ['First warning', 'Second warning']);
  });

  const rows = page.locator('#viewerNotice .viewer-notice-item');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveText('First warning');
  await expect(rows.nth(1)).toHaveText('Second warning');
  const divider = await rows.nth(0).evaluate((row) => getComputedStyle(row).borderBottomStyle);
  expect(divider).toBe('solid');

  const panel = page.locator('#viewerNotice');
  const list = page.locator('#viewerNoticeList');
  const toggle = page.locator('#viewerNoticeToggle');
  await expect(page.locator('#viewerNoticeSummary')).toHaveText('Warnings (2)');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(list).toBeHidden();
  await expect(toggle).toHaveText('Expand');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => localStorage.getItem('seqeyes.viewerNoticesCollapsed'))).toBe('1');

  await page.evaluate(() => {
    window.SeqEyesPanelHost.setNotice('third', 'Third warning');
  });
  await expect(page.locator('#viewerNoticeSummary')).toHaveText('Warnings (3)');
  await expect(list).toBeHidden();

  await toggle.click();
  await expect(list).toBeVisible();
  await expect(rows).toHaveCount(3);
  await expect(toggle).toHaveText('Collapse');
  expect(await page.evaluate(() => localStorage.getItem('seqeyes.viewerNoticesCollapsed'))).toBe('0');
});

test('keeps the portrait mobile viewer compact and switches full-width analysis views', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loadViewer(page, fixtures.gre);
  await page.evaluate(() => {
    window.SeqEyesPanelHost.setNotice('mobile-layout', ['First warning', 'Second warning']);
  });

  await expect(page.locator('#menuBtn')).toBeVisible();
  await expect(page.locator('#tbMore')).toBeHidden();
  await expect(page.locator('#viewerNoticeList')).toBeHidden();
  await expect(page.locator('#viewerNoticeToggle')).toHaveText('Expand');
  expect((await requireBox(page.locator('#tb'))).height).toBeLessThan(80);

  await page.locator('#menuBtn').click();
  await expect(page.locator('#tbMore')).toBeVisible();
  await expect(page.locator('#menuBtn')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#menuBtn').click();

  await openSpectrogram(page);
  const main = await requireBox(page.locator('#main'));
  const panel = await requireBox(page.locator('#right'));
  const waveform = await requireBox(page.locator('#left'));
  expect(panel.height).toBeLessThanOrEqual(main.height - 119);
  expect(waveform.height).toBeGreaterThanOrEqual(119);

  await expect(page.locator('#sgSettings')).toBeHidden();
  await expect(page.locator('#sgSettingsToggle')).toBeVisible();
  await page.locator('#sgSettingsToggle').click();
  await expect(page.locator('#sgSettings')).toBeVisible();
  await expect(page.locator('#sgSettingsToggle')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#sgSettingsToggle').click();

  const panelWidth = (await requireBox(page.locator('#right'))).width;
  await expect(page.locator('#sgPane')).toBeVisible();
  await expect(page.locator('#spPane')).toBeHidden();
  expect((await requireBox(page.locator('#sgPane'))).width).toBeGreaterThan(panelWidth - 2);
  await page.locator('#sgMobileView').click();
  await expect(page.locator('#sgPane')).toBeHidden();
  await expect(page.locator('#spPane')).toBeVisible();
  expect((await requireBox(page.locator('#spPane'))).width).toBeGreaterThan(panelWidth - 2);
  await expect(page.locator('#sgMobileView')).toHaveText('Spectrogram');

  // Mobile browser chrome changes the visual viewport without changing
  // orientation; the panel must be re-clamped on that resize too.
  await page.setViewportSize({ width: 390, height: 650 });
  await expect.poll(async () => (await requireBox(page.locator('#left'))).height).toBeGreaterThanOrEqual(119);

  const viewport = await page.evaluate(() => ({
    innerHeight: window.innerHeight,
    bodyBottom: document.body.getBoundingClientRect().bottom,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(viewport.bodyBottom).toBeLessThanOrEqual(viewport.innerHeight + 1);
  expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.innerHeight + 1);
});

test('mirrors the panel marker onto the waveform panel', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);
  await settlePanel(page);

  expect(await opaquePixelCount(page.locator('#moc'))).toBe(0);
  const state = await panelState(page);
  await page.evaluate((t) => window.SeqEyesDev.setMarkerTime(t),
    (state.viewStartSec + state.viewEndSec) / 2);

  await expect.poll(async () => await opaquePixelCount(page.locator('#moc')), { timeout: 10_000 })
    .toBeGreaterThan(0);

  await page.evaluate(() => window.SeqEyesDev.setMarkerTime(NaN));
  await expect.poll(async () => await opaquePixelCount(page.locator('#moc'))).toBe(0);
});

test('shows a readout with the achieved time and frequency resolution', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);
  await settlePanel(page);

  const readout = page.locator('#sgReadout');
  await expect(readout).toContainText('dt ');
  await expect(readout).toContainText('df ');
  await expect(readout).toContainText('mT/m');
  await expect(readout).toContainText('view average');
});

test('resizes the spectrogram canvases from the outer panel handle', async ({ page }) => {
  await loadViewer(page, fixtures.gre);
  await openSpectrogram(page);

  const before = await canvasSize(page.locator('#sgImg'));
  expect(before.width).toBeGreaterThan(0);

  const handle = await requireBox(page.locator('#khandle'));
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(handle.x + handle.width / 2 - i * 12, handle.y + handle.height / 2);
  }
  await page.mouse.up();

  // The handle used to drive only the k-space pane, leaving the spectrogram
  // canvases at their old size (and drawing into a hidden pane).
  await expect.poll(async () => (await canvasSize(page.locator('#sgImg'))).width, { timeout: 10_000 })
    .toBeGreaterThan(before.width);
  await expect.poll(async () => (await canvasSize(page.locator('#spCanvas'))).width, { timeout: 10_000 })
    .toBeGreaterThan(0);
  await expectCanvasVaried(page.locator('#sgImg'));

  // And the new size survives a reload.
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.SeqEyesDev.panelMode()), { timeout: 10_000 })
    .toBe('spectrogram');
  await expect.poll(async () => (await requireBox(page.locator('#right'))).width, { timeout: 10_000 })
    .toBeGreaterThan(520);
});

// ─── helpers ─────────────────────────────────────────────────────────────────

async function captureNextAudioRequest(page: Page): Promise<{
  id: number;
  startSec: number;
  endSec: number;
}> {
  return page.evaluate(() => new Promise<{ id: number; startSec: number; endSec: number }>((resolve) => {
    window.SeqEyesPanelHost.requestAudio = (id, startSec, endSec) => {
      resolve({ id, startSec, endSec });
    };
    (document.getElementById('sgPlay') as HTMLButtonElement).click();
  }));
}

async function loadViewer(page: Page, fixturePath: string): Promise<void> {
  await page.goto('/?debug=1');
  await page.locator('#fileInput').setInputFiles(fixturePath);
  await expect(page.locator('#exportKspaceBtn')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#splash')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('#poverlay')).toBeHidden({ timeout: 10_000 });
}

async function openSpectrogram(page: Page): Promise<void> {
  await page.evaluate(() => window.SeqEyesDev.setPanelMode('spectrogram'));
  await expect(page.locator('#spane')).toHaveClass(/on/);
  await expect(page.locator('#right')).toHaveClass(/open/);
  await expect.poll(async () => (await panelState(page)).nTime, { timeout: 20_000 }).toBeGreaterThan(0);
  await settlePanel(page);
}

/**
 * Wait until the panel stops moving.
 *
 * Opening #right narrows #left, which genuinely changes the visible time
 * window while the 250 ms width transition runs, so the spectrogram
 * legitimately recomputes several times. Measurements taken mid-animation
 * are measurements of a moving target, not of the feature.
 */
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
  }, { timeout: 25_000 }).toBe('settled');
}

async function panelState(page: Page): Promise<PanelState> {
  return await page.evaluate(() => window.SeqEyesDev.spectrogramState());
}

async function paneSizes(page: Page): Promise<{
  spectrogram: { width: number; height: number };
  spectrum: { width: number; height: number };
}> {
  const spectrogram = await requireBox(page.locator('#sgPane'));
  const spectrum = await requireBox(page.locator('#spPane'));
  return {
    spectrogram: { width: spectrogram.width, height: spectrogram.height },
    spectrum: { width: spectrum.width, height: spectrum.height },
  };
}

async function samplePixels(locator: Locator): Promise<string> {
  return await locator.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (!context || !canvas.width || !canvas.height) return '';
    const image = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const step = Math.max(4, (Math.floor(image.length / 4 / 400) * 4) || 4);
    const parts: string[] = [];
    for (let i = 0; i < image.length; i += step) {
      parts.push(`${image[i]},${image[i + 1]},${image[i + 2]},${image[i + 3]}`);
    }
    return parts.join('|');
  });
}

/** Non-transparent pixel count — finds thin overlay strokes a stride misses. */
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

async function canvasSize(locator: Locator): Promise<{ width: number; height: number }> {
  return await locator.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    return { width: canvas.width, height: canvas.height };
  });
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

async function requireBox(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}
