/**
 * Pulseq Waveform Decoder
 *
 * Converts parsed .seq data (library entries + block table) into time‑domain
 * waveforms suitable for rendering.  Each block's events are expanded:
 *   - RF:  magnitude shape × amplitude  +  phase with freq‑offset modulation
 *   - Gradients:  trapezoid or arbitrary (shaped) with leading zero anchor
 *   - ADC:  readout window metadata
 *   - Extensions:  triggers, NCO
 *
 * All time‑points are absolute (seconds from sequence start).
 */

import type {
    PulseqSequence, DecodedBlock, DecodedRFWaveform, DecodedGradWaveform,
    DecodedADCEvent, DecodedTriggerEvent, DecodedNCOEvent,
    RFEntry, TrapGradEntry, ArbitraryGradEntry, ADCEntry, ExtensionEntry, BlockEntry,
} from './types';
import { ExtType, VER_PRE_14 } from './types';

// ─── Constants ───────────────────────────────────────────────────────────

/** ¹H gyromagnetic ratio in Hz/T  (γ = 42.576 MHz/T). */
const GAMMA_HZ_T = 42.576e6;

/** Default B₀ field strength [T] when not specified in [DEFINITIONS]. */
const DEFAULT_B0_T = 3.0;

// ─── Public API ───────────────────────────────────────────────────────────

/** Extract B₀ from definitions, falling back to a default. */
function getB0(seq: PulseqSequence): number {
    const raw = seq.definitions.get('B0');
    if (raw && Array.isArray(raw) && raw.length > 0) return +raw[0];
    // Also try lowercase variants
    const raw2 = seq.definitions.get('b0') ?? seq.definitions.get('b_0');
    if (raw2 && Array.isArray(raw2) && raw2.length > 0) return +raw2[0];
    return DEFAULT_B0_T;
}

/** Compute the effective frequency offset including PPM contribution.
 *  Matches SeqEyes PulseqLoader.cpp:
 *    fullFreqOff = freqOffset + freqPPM * 1e-6 * γ * B₀
 */
function effFreqOff(freqOffset: number, freqPPM: number, b0: number): number {
    return freqOffset + freqPPM * 1e-6 * GAMMA_HZ_T * b0;
}

/** Compute the effective phase offset including PPM contribution.
 *    fullPhaseOff = phaseOffset + phasePPM * 1e-6 * γ * B₀
 */
function effPhaseOff(phaseOffset: number, phasePPM: number, b0: number): number {
    return phaseOffset + phasePPM * 1e-6 * GAMMA_HZ_T * b0;
}

/** Decode all blocks into render‑ready waveforms. */
export function decodeAllBlocks(seq: PulseqSequence): DecodedBlock[] {
    return decodeBlockRange(seq, 0, seq.blocks.length);
}

/**
 * Decode a contiguous range of blocks [startBlockIdx, endBlockIdx).
 *
 * This is the core optimization for large 3D sequences — instead of decoding
 * thousands of blocks at once, we decode only the visible range (e.g. first TR,
 * or current viewport).  Shapes are still decompressed on demand via the
 * existing decompressor (which is already O(n) per shape), but the block loop
 * and RF/gradient expansion are limited to the requested range.
 *
 * Cumulative time is computed from block 0 so that startTime values are
 * absolute (correct for rendering).
 *
 * @param seq            Parsed sequence.
 * @param startBlockIdx  0‑based inclusive start block index.
 * @param endBlockIdx    0‑based exclusive end block index.
 * @returns              Decoded blocks [startBlockIdx, endBlockIdx).
 */
export function decodeBlockRange(
    seq: PulseqSequence,
    startBlockIdx: number,
    endBlockIdx: number,
): DecodedBlock[] {
    // Clear per‑sequence extension caches to avoid cross‑sequence contamination
    _trigCache.clear();
    _ncoCache.clear();

    const totalBlocks = seq.blocks.length;
    const s = Math.max(0, Math.min(startBlockIdx, totalBlocks));
    const e = Math.max(s, Math.min(endBlockIdx, totalBlocks));
    if (s >= e) return [];

    // Pre‑compute cumulative time up to startBlockIdx so that all startTime
    // values are absolute (needed for correct k‑space & visual alignment).
    let cumulative = 0;
    for (let i = 0; i < Math.min(s, totalBlocks); i++) {
        cumulative += blockDurationSeconds(seq, seq.blocks[i]);
    }

    const decoded: DecodedBlock[] = [];
    for (let i = s; i < e; i++) {
        const block = seq.blocks[i];
        const dur = blockDurationSeconds(seq, block);
        const db: DecodedBlock = { index: block.num, duration: dur, startTime: cumulative };

        if (block.rfId > 0) {
            const rf = seq.rfs.get(block.rfId);
            if (rf) db.rf = decodeRF(seq, rf, cumulative, dur);
        }
        db.gx = decodeGradient(seq, block.gxId, cumulative, dur, 'gx');
        db.gy = decodeGradient(seq, block.gyId, cumulative, dur, 'gy');
        db.gz = decodeGradient(seq, block.gzId, cumulative, dur, 'gz');

        if (block.adcId > 0) {
            const adc = seq.adcs.get(block.adcId);
            if (adc) db.adc = decodeADC(adc, cumulative, seq);
        }
        if (block.extId > 0) {
            const ext = seq.extensions.get(block.extId);
            if (ext) decodeExtensions(seq, ext, db, cumulative);
        }

        decoded.push(db);
        cumulative += dur;
    }
    return decoded;
}

/**
 * Get the total sequence duration without decoding all blocks.
 * This is a fast O(n) scan of block durations (no shape decompression).
 */
export function getTotalDuration(seq: PulseqSequence): number {
    let total = 0;
    for (const block of seq.blocks) {
        total += blockDurationSeconds(seq, block);
    }
    return total;
}

/**
 * Get cumulative start time for a specific block index without decoding.
 * Useful for translating between block indices and absolute times.
 */
export function getBlockStartTime(seq: PulseqSequence, blockIdx: number): number {
    let cumulative = 0;
    const n = Math.min(blockIdx, seq.blocks.length);
    for (let i = 0; i < n; i++) {
        cumulative += blockDurationSeconds(seq, seq.blocks[i]);
    }
    return cumulative;
}

function blockDurationSeconds(seq: PulseqSequence, block: BlockEntry): number {
    if (seq.versionCombined < VER_PRE_14) return block.dur * 1e-6;
    return block.dur * seq.rasterTimes.blockDurationRaster;
}

// ─── RF decoding ──────────────────────────────────────────────────────────

function decodeRF(seq: PulseqSequence, rf: RFEntry, blockStart: number, _blockDur: number): DecodedRFWaveform {
    const raster = seq.rasterTimes.rfRaster;
    const rfDelay = rf.delay * 1e-6;
    const rfStart = blockStart + rfDelay;
    const b0 = getB0(seq);

    // Effective offsets including PPM contributions (matches SeqEyes PulseqLoader.cpp)
    const freqFull = effFreqOff(rf.freqOffset, rf.freqPPM, b0);
    const phaseFull = effPhaseOff(rf.phaseOffset, rf.phasePPM, b0);

    // Decompress magnitude shape
    const magShape = seq.shapes.get(rf.magShapeId);
    const nSamples = magShape?.numSamples ?? Math.max(2, Math.round(_blockDur / raster));
    const mag = magShape
        ? new Float64Array(magShape.samples)
        : makeConstant(nSamples, 1);

    // Decompress phase shape
    const phShape = seq.shapes.get(rf.phaseShapeId);
    const ph = phShape
        ? new Float64Array(phShape.samples)
        : new Float64Array(mag.length);

    // Time shape (non‑uniform sampling)
    const timeShape = rf.timeShapeId > 0
        ? seq.shapes.get(rf.timeShapeId)?.samples ?? null
        : null;

    const n = Math.min(mag.length, ph.length);
    const t = new Float64Array(n);
    const amp = new Float64Array(n);
    const phase = new Float64Array(n);

    for (let i = 0; i < n; i++) {
        t[i] = timeShape
            ? rfStart + timeShape[i] * raster
            : rfStart + (i + 0.5) * raster;
        amp[i] = rf.amplitude * mag[i];
        const dt = t[i] - rfStart;
        // totalPhase = basePh + phaseFull + 2π × t_local × freqFull  (SeqEyes PulseqLoader.cpp)
        phase[i] = 2 * Math.PI * ph[i] + phaseFull + 2 * Math.PI * freqFull * dt;
    }

    const duration = n > 0 ? t[n - 1] - rfStart + raster : 0;
    const centerTime = rf.center >= 0
        ? blockStart + rfDelay + rf.center * 1e-6
        : estimateRfPeakTime(t, amp, rfStart, duration);

    // Estimate flip angle to classify RF use when metadata is missing (pre‑v1.5)
    let use = rf.use || '';
    if (!use || use === 'u') {
        // Integrate RF magnitude to get flip angle in degrees: FA = 360 × ∫ mag(t) dt
        let faDeg = 0;
        for (let i = 1; i < n; i++) {
            const dt = t[i] - t[i - 1];
            faDeg += 360 * (amp[i] + amp[i - 1]) * 0.5 * dt;
        }
        // Classify: ≤ 100° → excitation, ≥ 120° → refocusing, else → excitation (safe default)
        use = faDeg >= 120 ? 'r' : 'e';
    }

    return {
        blockIndex: rf.id,
        startTime: rfStart,
        centerTime,
        duration,
        timePoints: t,
        magnitude: amp,
        phase,
        amplitude: rf.amplitude,
        freqOffset: freqFull,
        phaseOffset: phaseFull,
        use,
    };
}

// ─── Gradient decoding ────────────────────────────────────────────────────

function decodeGradient(
    seq: PulseqSequence, gradId: number,
    blockStart: number, blockDur: number,
    channel: 'gx' | 'gy' | 'gz',
): DecodedGradWaveform {
    if (gradId <= 0) return zeroGradient(blockStart, blockDur, channel);

    const trap = seq.trapGrads.get(gradId);
    if (trap) return decodeTrap(trap, blockStart, channel);

    const arb = seq.arbitraryGrads.get(gradId);
    if (arb) return decodeArb(seq, arb, blockStart, channel);

    return zeroGradient(blockStart, blockDur, channel);
}

function zeroGradient(t0: number, dur: number, ch: 'gx' | 'gy' | 'gz'): DecodedGradWaveform {
    return {
        blockIndex: 0, startTime: t0, duration: dur,
        timePoints: new Float64Array([t0, t0 + dur]),
        waveform: new Float64Array([0, 0]),
        amplitude: 0, type: 'none', channel: ch,
    };
}

/** Trapezoid — 4‑point representation matching SeqEyes SeriesBuilder.
 *  t=0 is the gradient start (blockStart + delay).  A leading anchor at
 *  blockStart is included only when delay > 0 for visual continuity. */
function decodeTrap(trap: TrapGradEntry, blockStart: number, ch: 'gx' | 'gy' | 'gz'): DecodedGradWaveform {
    const rise = trap.rise * 1e-6;
    const flat = trap.flat * 1e-6;
    const fall = trap.fall * 1e-6;
    const delay = trap.delay * 1e-6;
    const gradStart = blockStart + delay;

    // SeqEyes 4‑point trapezoid: {0, rampUp, rampUp+flat, rampUp+flat+rampDown}
    // with amplitudes {0, amp, amp, 0}, all relative to gradStart.
    const tRel = [0, rise, rise + flat, rise + flat + fall];
    const wfRel = [0, trap.amplitude, trap.amplitude, 0];

    if (delay > 0) {
        // Prepend a zero anchor at blockStart so the trace doesn't jump
        const tp = new Float64Array(5);
        const wf = new Float64Array(5);
        tp[0] = blockStart; wf[0] = 0;
        for (let i = 0; i < 4; i++) { tp[i + 1] = gradStart + tRel[i]; wf[i + 1] = wfRel[i]; }
        return {
            blockIndex: trap.id, startTime: blockStart,
            duration: delay + rise + flat + fall,
            timePoints: tp, waveform: wf,
            amplitude: trap.amplitude, type: 'trap', channel: ch,
        };
    }

    // No delay — 4 points starting at blockStart (= gradStart)
    const tp = new Float64Array(4);
    const wf = new Float64Array(4);
    for (let i = 0; i < 4; i++) { tp[i] = gradStart + tRel[i]; wf[i] = wfRel[i]; }
    return {
        blockIndex: trap.id, startTime: blockStart,
        duration: rise + flat + fall,
        timePoints: tp, waveform: wf,
        amplitude: trap.amplitude, type: 'trap', channel: ch,
    };
}

/** Arbitrary (shaped) gradient — matches SeqEyes decodeExtTrapGradInBlock.
 *
 *  Three sub‑types (matching SeqEyes inline helpers):
 *    - Extended trapezoid:  timeId > 0     → non‑uniform time+wave shape pair
 *    - Arbitrary:           timeId == 0    → uniform grad‑raster sampling
 *    - Oversampled arb:     timeId == -1   → 2× grad‑raster sampling
 *
 *  Waveform formula:  wf[i] = amplitude × shape[i]
 *  (`first` / `last` are derived metadata, NOT additive offsets.) */
function decodeArb(
    seq: PulseqSequence, arb: ArbitraryGradEntry,
    blockStart: number, ch: 'gx' | 'gy' | 'gz',
): DecodedGradWaveform {
    const shape = seq.shapes.get(arb.shapeId);
    if (!shape) return zeroGradient(blockStart, 0, ch);

    const raster = seq.rasterTimes.gradientRaster;
    const delay = arb.delay * 1e-6;
    const gradStart = blockStart + delay;
    const n = shape.numSamples;

    // Oversampling factor:  1× (normal), 2× (timeId == -1)
    const oversampled = arb.timeId === -1;

    // Time shape for non‑uniform sampling (extended trapezoid)
    const timeShape = arb.timeId > 0
        ? seq.shapes.get(arb.timeId)?.samples ?? null
        : null;

    if (timeShape) {
        const tp = new Float64Array(n);
        const wf = new Float64Array(n);
        // Extended trapezoid — explicit time points from decompressed time shape.
        // Time shape values are in grad‑raster units (SeqEyes converts to µs; we to s).
        for (let i = 0; i < n; i++) {
            tp[i] = gradStart + timeShape[i] * raster;
            // SeqEyes:  waveform = amplitude × shape  (no `first` additive offset)
            wf[i] = arb.amplitude * shape.samples[i];
        }
        const dur = n > 0 ? tp[n - 1] - blockStart + raster : delay;
        return {
            blockIndex: arb.id, startTime: blockStart, duration: dur,
            timePoints: tp, waveform: wf,
            amplitude: arb.amplitude, type: 'arb', channel: ch,
        };
    }

    const tp = new Float64Array(n + 2);
    const wf = new Float64Array(n + 2);
    tp[0] = gradStart;
    wf[0] = edgeAmplitude(arb.first, arb.amplitude, shape.samples, true);

    if (oversampled) {
        const dt = raster * 0.5;
        for (let i = 0; i < n; i++) {
            tp[i + 1] = gradStart + (i + 1) * dt;
            wf[i + 1] = arb.amplitude * shape.samples[i];
        }
        tp[n + 1] = gradStart + (n + 1) * dt;
    } else {
        for (let i = 0; i < n; i++) {
            tp[i + 1] = gradStart + (i + 0.5) * raster;
            wf[i + 1] = arb.amplitude * shape.samples[i];
        }
        tp[n + 1] = gradStart + n * raster;
    }
    wf[wf.length - 1] = edgeAmplitude(arb.last, arb.amplitude, shape.samples, false);

    const dur = tp[tp.length - 1] - blockStart;

    return {
        blockIndex: arb.id, startTime: blockStart, duration: dur,
        timePoints: tp, waveform: wf,
        amplitude: arb.amplitude, type: 'arb', channel: ch,
    };
}

function edgeAmplitude(
    stored: number,
    amplitude: number,
    samples: Float64Array,
    first: boolean,
): number {
    let value: number;
    if (Number.isFinite(stored)) {
        value = stored;
        if (Math.abs(value) > 1 + 1e-6 && Math.abs(amplitude) > 0) value /= amplitude;
    } else if (samples.length === 0) {
        value = 0;
    } else if (samples.length === 1) {
        value = samples[0];
    } else if (first) {
        value = 0.5 * (3 * samples[0] - samples[1]);
    } else {
        value = 0.5 * (3 * samples[samples.length - 1] - samples[samples.length - 2]);
    }
    return value * amplitude;
}

// ─── ADC / Extensions ─────────────────────────────────────────────────────

function decodeADC(adc: ADCEntry, blockStart: number, seq: PulseqSequence): DecodedADCEvent {
    const b0 = getB0(seq);
    const freqFull = effFreqOff(adc.freqOffset, adc.freqPPM, b0);
    const phaseFull = effPhaseOff(adc.phaseOffset, adc.phasePPM, b0);
    return {
        blockIndex: adc.id, startTime: blockStart,
        numSamples: adc.numSamples,
        dwell: adc.dwell * 1e-9,     // ns → s
        delay: adc.delay * 1e-6,     // µs → s
        freqOffset: freqFull,
        phaseOffset: phaseFull,
    };
}

// Cache for decoded trigger/NCO payloads keyed by extension-list node id.
const _trigCache = new Map<number, DecodedTriggerEvent>();
const _ncoCache = new Map<number, DecodedNCOEvent>();

function decodeExtensions(
    seq: PulseqSequence, ext: ExtensionEntry,
    db: DecodedBlock, blockStart: number,
): void {
    const visited = new Set<number>();
    let cur: ExtensionEntry | undefined = ext;
    while (cur && !visited.has(cur.id)) {
        visited.add(cur.id);
        const type = seq.extensionTypes.get(cur.type) ?? ExtType.EXT_UNKNOWN;
        if (type === ExtType.EXT_TRIGGER) {
            let cached = _trigCache.get(cur.id);
            if (!cached) {
                const trigger = findById(seq.triggers, cur.ref);
                if (trigger) {
                    cached = {
                        blockIndex: trigger.id,
                        startTime: 0,
                        channel: trigger.channel,
                        delay: trigger.delay * 1e-6,
                        duration: trigger.duration * 1e-6,
                    };
                    _trigCache.set(cur.id, cached);
                }
            }
            if (cached) {
                if (!db.triggers) db.triggers = [];
                db.triggers.push({ ...cached, startTime: blockStart });
            }
        } else if (type === ExtType.EXT_NCO) {
            let cached = _ncoCache.get(cur.id);
            if (!cached) {
                const nco = findById(seq.ncos, cur.ref);
                if (nco) {
                    cached = {
                        blockIndex: nco.id,
                        startTime: 0,
                        channel: nco.channel,
                        frequency: nco.frequency,
                        phase: nco.phase,
                        delay: nco.delay * 1e-6,
                        duration: nco.duration * 1e-6,
                    };
                    _ncoCache.set(cur.id, cached);
                }
            }
            if (cached) {
                if (!db.nco) db.nco = [];
                db.nco.push({ ...cached, startTime: blockStart });
            }
        } else if (type === ExtType.EXT_ROTATION) {
            const rotation = findById(seq.rotations, cur.ref);
            if (rotation) db.rotation = { id: rotation.id, values: [...rotation.values] };
        } else if (type === ExtType.EXT_LABELSET) {
            const label = findById(seq.labelSets, cur.ref);
            if (label) {
                if (!db.labelSets) db.labelSets = [];
                db.labelSets.push({ ...label });
            }
        } else if (type === ExtType.EXT_LABELINC) {
            const label = findById(seq.labelIncs, cur.ref);
            if (label) {
                if (!db.labelIncs) db.labelIncs = [];
                db.labelIncs.push({ ...label });
            }
        } else if (type === ExtType.EXT_DELAY) {
            const delay = findById(seq.softDelays, cur.ref);
            if (delay) db.softDelay = { ...delay };
        } else if (type === ExtType.EXT_RF_SHIM) {
            const shim = findById(seq.rfShims, cur.ref);
            if (shim) {
                db.rfShim = {
                    id: shim.id,
                    nChannels: shim.nChannels,
                    amplitudes: [...shim.amplitudes],
                    phases: [...shim.phases],
                };
            }
        }
        cur = cur.nextId > 0 ? seq.extensions.get(cur.nextId) : undefined;
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeConstant(n: number, value: number): Float64Array {
    const a = new Float64Array(Math.max(n, 2));
    a.fill(value);
    return a;
}

function estimateRfPeakTime(
    timePoints: Float64Array,
    magnitude: Float64Array,
    startTime: number,
    duration: number,
): number {
    if (!timePoints.length || !magnitude.length) return startTime + duration * 0.5;
    let peak = Math.abs(magnitude[0]);
    for (let i = 1; i < magnitude.length; i++) {
        const v = Math.abs(magnitude[i]);
        if (v > peak) peak = v;
    }
    const threshold = Math.abs(peak) * 0.99999;
    let firstPeak = -1;
    let lastPeak = -1;
    for (let i = 0; i < magnitude.length; i++) {
        if (Math.abs(magnitude[i]) >= threshold) {
            if (firstPeak < 0) firstPeak = i;
            lastPeak = i;
        }
    }
    if (firstPeak < 0 || lastPeak < 0) return startTime + duration * 0.5;
    return 0.5 * (
        timePoints[Math.min(firstPeak, timePoints.length - 1)]
        + timePoints[Math.min(lastPeak, timePoints.length - 1)]
    );
}

function findById<T extends { id: number }>(items: T[], id: number): T | undefined {
    return items.find(item => item.id === id);
}
