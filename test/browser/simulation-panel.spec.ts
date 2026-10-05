import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

interface ViewState {
  dataset: string;
  x: number;
  y: number;
  xName: string;
  yName: string | null;
  indices: number[];
  part: string;
  fft: boolean[];
  dims: { name: string; size: number }[];
}

interface SimulationState {
  available: boolean;
  shown: boolean;
  running: boolean;
  runs: number;
  workers: number;
  phantom: { choice: string; status: string; error: string | null; nx: number; ny: number; volume: number[] | null; plane: string; index: number | null; source: string };
  coils: number;
  engine: string;
  slices: string;
  pulses: { status: string; count: number; alongZ: number; spectral: number };
  tab: string;
  view: ViewState | null;
  plan: null | {
    subSpins: [number, number];
    spins: number;
    simulated: number;
    chunks: number;
    coils: number;
    axes: { count: number; reason: string; folded: boolean }[];
    slices: null | { count: number; reference: number; extent: string; planes: number };
    engine: string;
    phaseGraph: null | { classes: number; lanes: number; sources: number };
  };
  done: boolean;
  nu: number;
  nv: number;
  frames: number;
  acquisitions: number;
  labelView: boolean;
  live: null | { phase: string; chunks: number; previews: number; cardVisible: boolean; cardMinimized: boolean };
  status: string;
}

interface Summary { width: number; height: number; mean: number; max: number; lineLength: number; lineMax: number }

/** The test hooks panel.js installs (other specs declare their own subsets). */
interface DevWindow {
  SeqEyesDev: {
    panelMode(): string;
    simulationState(): unknown;
    simulationMatrix(): unknown;
  };
}

const gre = resolve('test/kspace_baselines/v151_gre/seq/writeGradientEcho.seq');
const greLabel = resolve('test/seqeyes_demo_seq_files/writeGradientEcho_label.seq');
const epi = resolve('test/seqeyes_demo_seq_files/writeEpi.seq');
const epiFatSat = resolve('test/seqeyes_demo_seq_files/writeEpiRS.seq');
const mrzeroLike = resolve('test/fixtures/sim/mrzero_like_small.npz');

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

test('simulates a labelled GRE and browses its raw data, k-space and image', async ({ page }) => {
  await loadViewer(page, greLabel);
  await openSimulation(page);
  await expect.poll(async () => (await simulationState(page)).phantom.status).toBe('ready');
  // The phantom maps show before any run.
  expect((await simulationState(page)).tab).toBe('phantom');
  expect((await viewSummary(page)).max).toBeGreaterThan(0);

  await page.locator('#simMatrix').selectOption('32');
  await expect.poll(async () => (await simulationState(page)).phantom.nx).toBe(32);
  await page.locator('#simCoils').selectOption('4');
  // Manual spins per voxel skip the probe, which keeps this run short.
  await page.locator('#simSpins').selectOption('8x1');
  await page.locator('#simRun').click();
  await expect.poll(async () => (await simulationState(page)).done, { timeout: 60_000 }).toBe(true);

  const state = await simulationState(page);
  expect(state.running).toBe(false);
  // This demo is 256² with two repetitions (REP), so two image frames.
  expect([state.nu, state.nv]).toEqual([256, 256]);
  expect(state.frames).toBe(2);
  expect(state.plan?.subSpins).toEqual([8, 1]);
  expect(state.plan?.coils).toBe(4);
  expect(state.plan?.axes[1].folded).toBe(true);
  // The 5 mm slab is sampled through (Slices: auto is the default).
  expect(state.slices).toBe('auto');
  expect(state.plan?.slices?.count).toBeGreaterThan(4);
  expect(state.plan?.slices?.reference).toBeCloseTo(0.005, 3);
  expect(state.tab).toBe('image');
  // Image: x, y, a coil dimension led by the root-sum-of-squares, and frames.
  expect(state.view?.dims.map(d => d.name)).toEqual(['x', 'y', 'coil', 'frame']);
  expect(state.view?.dims[2].size).toBe(5);
  await expectCanvasVaried(page.locator('#simCanvas'));
  await expectCanvasVaried(page.locator('#simPlot'));

  // Raw data by labels: samples × LIN × REP × coils for this sequence.
  await page.locator('#simData button[data-tab="raw"]').click();
  let view = (await simulationState(page)).view!;
  expect(state.labelView).toBe(true);
  expect(view.dataset).toBe('raw-labels');
  expect(view.dims.map(d => d.name)).toEqual(['sample', 'LIN', 'REP', 'coil']);
  // Swap the axes: coils across, LIN down.
  await page.locator('#simAxisX').selectOption({ label: 'coil (4)' });
  view = (await simulationState(page)).view!;
  expect([view.xName, view.yName]).toEqual(['coil', 'LIN']);
  // Line plot only, along the samples: the readout waveform.
  await page.locator('#simAxisX').selectOption({ label: 'sample (256)' });
  await page.locator('#simAxisY').selectOption({ label: 'none (line only)' });
  view = (await simulationState(page)).view!;
  expect(view.yName).toBeNull();
  await expect(page.locator('#simBody')).toHaveClass(/full/);
  const line = await viewSummary(page);
  expect(line.lineLength).toBe(256);
  expect(line.lineMax).toBeGreaterThan(0);
  // Real part and an FFT along the readout (hybrid x-ky space).
  await page.locator('#simAxisY').selectOption({ label: 'LIN (256)' });
  await page.locator('#simParts button[data-part="re"]').click();
  await page.locator('#simDims .nd-dim[data-dim="0"] .nd-fft').click();
  view = (await simulationState(page)).view!;
  expect(view.part).toBe('re');
  expect(view.fft[0]).toBe(true);
  await expectCanvasVaried(page.locator('#simCanvas'));

  // Acquisition order is the other raw view.
  await page.locator('#simRawOrder').selectOption('acquisition');
  view = (await simulationState(page)).view!;
  expect(view.dims.map(d => d.name)).toEqual(['sample', 'acquisition', 'coil']);

  // k-space: an inverse FFT along both axes gives the image back.
  await page.locator('#simData button[data-tab="kspace"]').click();
  view = (await simulationState(page)).view!;
  expect(view.dims.map(d => d.name)).toEqual(['kx', 'ky', 'coil', 'frame']);
  await page.locator('#simDims .nd-dim[data-dim="0"] .nd-fft').click();
  await page.locator('#simDims .nd-dim[data-dim="1"] .nd-fft').click();
  // k-space opens in dB; compare linear magnitudes.
  await page.locator('#simLog').click();
  expect((await simulationState(page)).view?.part).toBe('abs');
  const transformed = await viewSummary(page);
  await page.locator('#simData button[data-tab="image"]').click();
  await page.locator('#simDims .nd-dim[data-dim="2"] input[type=range]').fill('1');   // coil 1, not RSS
  const image = await viewSummary(page);
  expect(transformed.max).toBeCloseTo(image.max, 1);
});

test('loads an MRzero-format 3-D phantom, slices it and simulates it', async ({ page }) => {
  await loadViewer(page, gre);
  await openSimulation(page);
  await page.locator('#simPhantomInput').setInputFiles(mrzeroLike);
  await expect.poll(async () => (await simulationState(page)).phantom.status).toBe('ready');
  let state = await simulationState(page);
  expect(state.phantom.choice).toBe('file');
  expect(state.phantom.volume).toEqual([20, 24, 6]);
  expect([state.phantom.nx, state.phantom.ny]).toEqual([20, 24]);
  expect(state.phantom.source).toContain('MRzero');
  await expect(page.locator('#simSliceGroup')).toBeVisible();
  // The maps: PD, T1, T2, T2′, ADC.
  expect(state.view?.dims.map(d => d.name)).toEqual(['x', 'y', 'map']);
  expect(state.view?.dims[2].size).toBe(5);

  // Another plane of the volume.
  await page.locator('#simPlane').selectOption('xz');
  await expect.poll(async () => (await simulationState(page)).phantom.ny).toBe(6);
  await page.locator('#simPlane').selectOption('xy');
  await expect.poll(async () => (await simulationState(page)).phantom.ny).toBe(24);

  await page.locator('#simSpins').selectOption('8x1');
  await page.locator('#simRun').click();
  await expect.poll(async () => (await simulationState(page)).done, { timeout: 60_000 }).toBe(true);
  state = await simulationState(page);
  expect(state.status).toContain('MRzero');
  expect(state.status).toContain('T2′ and diffusion follow the main echo pathway');
  await expectCanvasVaried(page.locator('#simCanvas'));
});

test('shows every RF pulse before a run, and samples the slab through or not', async ({ page }) => {
  await loadViewer(page, epiFatSat);
  await openSimulation(page);
  // Measured when the sequence opens: the slice-selective excitation along z,
  // the fat saturation (no gradient) against off-resonance.
  await expect.poll(async () => (await simulationState(page)).pulses.status, { timeout: 30_000 }).toBe('ready');
  let state = await simulationState(page);
  expect([state.pulses.alongZ, state.pulses.spectral]).toEqual([1, 1]);
  await page.locator('#simData button[data-tab="rf"]').click();
  state = await simulationState(page);
  expect(state.view?.dataset).toBe('rf-z');
  expect(state.view?.dims.map(d => d.name)).toEqual(['z', 'quantity', 'pulse']);
  expect(state.view?.part).toBe('re');
  await expectCanvasVaried(page.locator('#simPlot'));
  await expect(page.locator('#simRfAxis')).toBeVisible();
  await page.locator('#simRfAxis').selectOption('frequency');
  state = await simulationState(page);
  expect(state.view?.dataset).toBe('rf-frequency');
  expect(state.view?.dims[0].name).toBe('Δf');
  await expectCanvasVaried(page.locator('#simPlot'));

  await expect.poll(async () => (await simulationState(page)).phantom.status).toBe('ready');
  await page.locator('#simMatrix').selectOption('32');
  await expect.poll(async () => (await simulationState(page)).phantom.nx).toBe(32);
  await page.locator('#simSpins').selectOption('1x1');
  await page.locator('#simRun').click();
  await expect.poll(async () => (await simulationState(page)).done, { timeout: 120_000 }).toBe(true);
  state = await simulationState(page);
  expect(state.plan?.slices?.count).toBeGreaterThan(4);
  expect(state.status).toContain('sub-slices');
  expect(state.status).toContain('extruded along z');

  await page.locator('#simSlices').selectOption('off');
  await page.locator('#simRun').click();
  await expect.poll(async () => (await simulationState(page)).runs).toBe(2);
  await expect.poll(async () => (await simulationState(page)).done && !(await simulationState(page)).running, { timeout: 60_000 }).toBe(true);
  state = await simulationState(page);
  expect(state.plan?.slices).toBeNull();
  expect(state.status).toContain('Through-slice sampling is off');
});

test('simulates with the phase-graph engine when chosen', async ({ page }) => {
  await loadViewer(page, gre);
  await openSimulation(page);
  await expect.poll(async () => (await simulationState(page)).phantom.status).toBe('ready');
  await page.locator('#simMatrix').selectOption('64');
  await expect.poll(async () => (await simulationState(page)).phantom.nx).toBe(64);
  await page.locator('#simEngine').selectOption('phase-graph');
  // No spins per voxel to choose; the accuracy target still applies.
  await expect(page.locator('#simSpins')).toBeHidden();
  await expect(page.locator('#simAccuracy')).toBeVisible();
  await page.locator('#simRun').click();
  await expect.poll(async () => (await simulationState(page)).done, { timeout: 60_000 }).toBe(true);
  const state = await simulationState(page);
  expect(state.engine).toBe('phase-graph');
  expect(state.plan?.engine).toBe('phase-graph');
  expect(state.plan?.phaseGraph?.classes).toBe(5);
  expect(state.status).toContain('phase graph:');
  expect(state.status).toContain('Phase graph:');
  // The built-in phantom's T2′ and ADC, exact for every pathway.
  expect(state.status).toContain('T2′ is exact');
  expect(state.status).toContain('Diffusion is exact');
  await expectCanvasVaried(page.locator('#simCanvas'));
  // Back to isochromats: the spins-per-voxel control returns.
  await page.locator('#simEngine').selectOption('isochromat');
  await expect(page.locator('#simSpins')).toBeVisible();
});

test('exports ISMRMRD and NumPy raw data', async ({ page }) => {
  await loadViewer(page, greLabel);
  await openSimulation(page);
  await expect.poll(async () => (await simulationState(page)).phantom.status).toBe('ready');
  await page.locator('#simMatrix').selectOption('32');
  await page.locator('#simCoils').selectOption('2');
  await page.locator('#simSpins').selectOption('1x1');
  await page.locator('#simRun').click();
  await expect.poll(async () => (await simulationState(page)).done, { timeout: 60_000 }).toBe(true);

  const h5 = await download(page, 'ismrmrd-h5');
  expect(h5.name).toMatch(/_sim\.h5$/);
  expect(Array.from(h5.bytes.subarray(0, 8))).toEqual([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);

  const stream = await download(page, 'ismrmrd-stream');
  expect(stream.name).toMatch(/_sim\.bin$/);
  expect(stream.bytes.length).toBeGreaterThan(128 * 128 * 2 * 8);

  const npz = await download(page, 'npz');
  expect(npz.name).toMatch(/_sim\.npz$/);
  expect(Array.from(npz.bytes.subarray(0, 2))).toEqual([0x50, 0x4b]);   // a zip archive
});

test('plans spins per voxel automatically and can be cancelled', async ({ page }) => {
  await loadViewer(page, gre);
  await openSimulation(page);
  await expect.poll(async () => (await simulationState(page)).phantom.status).toBe('ready');
  await page.locator('#simMatrix').selectOption('128');
  await expect.poll(async () => (await simulationState(page)).phantom.nx).toBe(128);
  await page.locator('#simCoils').selectOption('1');
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

  // While it runs: the progress card, and live previews of the partial result.
  await expect(page.locator('#simRunCard')).toBeVisible();
  await expect(page.locator('#simRunPhase')).toContainText('Simulating');
  await expect(page.locator('#simRunStats')).toContainText('chunks');
  // The card minimizes to the corner and comes back; the choice is remembered.
  await page.locator('#simRunMin').click();
  await expect(page.locator('#simRunCard')).toHaveClass(/mini/);
  await expect(page.locator('#simRunStats')).toBeHidden();
  await expect(page.locator('#simRunPercent')).toBeVisible();
  expect((await simulationState(page)).live?.cardMinimized).toBe(true);
  await page.locator('#simRunCard').click();
  await expect(page.locator('#simRunCard')).not.toHaveClass(/mini/);
  await expect(page.locator('#simRunStats')).toBeVisible();
  await expect.poll(async () => (await simulationState(page)).live?.previews ?? 0, { timeout: 60_000 }).toBeGreaterThan(0);
  expect((await simulationState(page)).tab).toBe('image');
  await expect(page.locator('#simData button[data-tab="raw"]')).toBeEnabled();
  await expectCanvasVaried(page.locator('#simCanvas'));

  await page.locator('#simCancel').click();
  await expect(page.locator('#simRunCard')).toBeHidden();
  await expect(page.locator('#simData button[data-tab="image"]')).toBeDisabled();
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
  await expect.poll(async () => (await simulationState(page)).phantom.status).toBe('ready');
  await page.locator('#simMatrix').selectOption('32');
  await page.locator('#simSpins').selectOption('1x1');
  await page.locator('#simRun').click();
  await expect.poll(async () => (await simulationState(page)).done, { timeout: 60_000 }).toBe(true);

  await page.locator('#fileInput').setInputFiles(epi);
  await expect.poll(async () => (await simulationState(page)).done, { timeout: 30_000 }).toBe(false);
  await expect(page.locator('#simData button[data-tab="image"]')).toBeDisabled();
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

async function download(page: Page, format: string): Promise<{ name: string; bytes: Uint8Array }> {
  const pending = page.waitForEvent('download');
  await page.locator('#simExport').selectOption(format);
  const file = await pending;
  const path = await file.path();
  return { name: file.suggestedFilename(), bytes: new Uint8Array(readFileSync(path)) };
}

async function simulationState(page: Page): Promise<SimulationState> {
  return await page.evaluate(() => (window as unknown as DevWindow).SeqEyesDev.simulationState()) as SimulationState;
}

async function viewSummary(page: Page): Promise<Summary> {
  const summary = await page.evaluate(() => (window as unknown as DevWindow).SeqEyesDev.simulationMatrix());
  if (!summary) throw new Error('No simulation data on display.');
  return summary as Summary;
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
