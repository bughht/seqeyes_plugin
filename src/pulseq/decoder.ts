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
    RFEntry, TrapGradEntry, ArbitraryGradEntry, ADCEntry, ExtensionEntry,
} from './types';

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
    const decoded: DecodedBlock[] = [];
    let cumulative = 0;  // [s]

    for (const block of seq.blocks) {
        const dur = block.dur * seq.rasterTimes.blockDurationRaster;
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

// ─── RF decoding ──────────────────────────────────────────────────────────

function decodeRF(seq: PulseqSequence, rf: RFEntry, blockStart: number, _blockDur: number): DecodedRFWaveform {
    const raster = seq.rasterTimes.rfRaster;
    const rfStart = blockStart + rf.delay * raster;
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

    return {
        blockIndex: rf.id,
        startTime: rfStart,
        duration,
        timePoints: t,
        magnitude: amp,
        phase,
        amplitude: rf.amplitude,
        freqOffset: freqFull,
        phaseOffset: phaseFull,
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
    const delay = arb.delay * raster;
    const gradStart = blockStart + delay;
    const n = shape.numSamples;

    // Oversampling factor:  1× (normal), 2× (timeId == -1)
    const oversample = arb.timeId === -1 ? 2 : 1;
    const nOut = n * oversample;

    // Time shape for non‑uniform sampling (extended trapezoid)
    const timeShape = arb.timeId > 0
        ? seq.shapes.get(arb.timeId)?.samples ?? null
        : null;

    const tp = new Float64Array(nOut);
    const wf = new Float64Array(nOut);

    if (timeShape) {
        // Extended trapezoid — explicit time points from decompressed time shape.
        // Time shape values are in grad‑raster units (SeqEyes converts to µs; we to s).
        for (let i = 0; i < n; i++) {
            tp[i] = gradStart + timeShape[i] * raster;
            // SeqEyes:  waveform = amplitude × shape  (no `first` additive offset)
            wf[i] = arb.amplitude * shape.samples[i];
        }
    } else {
        // Uniform or oversampled arbitrary gradient
        const dt = raster / oversample;
        for (let i = 0; i < nOut; i++) {
            tp[i] = gradStart + (i + 0.5) * dt;
            // Linear interpolation for oversampled case
            const srcIdx = Math.floor(i / oversample);
            const frac = (i % oversample) / oversample;
            const s0 = shape.samples[Math.min(srcIdx, n - 1)];
            const s1 = shape.samples[Math.min(srcIdx + 1, n - 1)];
            const sv = s0 + (s1 - s0) * frac;
            wf[i] = arb.amplitude * sv;
        }
    }

    const dur = nOut > 0 ? tp[nOut - 1] - blockStart + raster : delay;

    return {
        blockIndex: arb.id, startTime: blockStart, duration: dur,
        timePoints: tp, waveform: wf,
        amplitude: arb.amplitude, type: 'arb', channel: ch,
    };
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

function decodeExtensions(
    seq: PulseqSequence, ext: ExtensionEntry,
    db: DecodedBlock, blockStart: number,
): void {
    const visited = new Set<number>();
    let cur: ExtensionEntry | undefined = ext;
    while (cur && !visited.has(cur.id)) {
        visited.add(cur.id);
        if (cur.type === 1) {
            db.triggers = seq.triggers.map(t => ({
                blockIndex: t.id, startTime: blockStart,
                channel: t.channel,
                delay: t.delay * 1e-6, duration: t.duration * 1e-6,
            }));
        } else if (cur.type === 2) {
            db.nco = seq.ncos.map(n => ({
                blockIndex: n.id, startTime: blockStart,
                channel: n.channel, frequency: n.frequency, phase: n.phase,
                delay: n.delay * 1e-6, duration: n.duration * 1e-6,
            }));
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
