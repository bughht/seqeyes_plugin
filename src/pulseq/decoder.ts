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

// ─── Public API ───────────────────────────────────────────────────────────

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
            if (adc) db.adc = decodeADC(adc, cumulative);
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
        phase[i] = 2 * Math.PI * ph[i] + rf.phaseOffset + 2 * Math.PI * rf.freqOffset * dt;
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
        freqOffset: rf.freqOffset,
        phaseOffset: rf.phaseOffset,
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

/** Trapezoid — includes a leading anchor at block start for visual alignment. */
function decodeTrap(trap: TrapGradEntry, blockStart: number, ch: 'gx' | 'gy' | 'gz'): DecodedGradWaveform {
    const rise = trap.rise * 1e-6;
    const flat = trap.flat * 1e-6;
    const fall = trap.fall * 1e-6;
    const delay = trap.delay * 1e-6;
    const gradStart = blockStart + delay;

    return {
        blockIndex: trap.id,
        startTime: blockStart,
        duration: delay + rise + flat + fall,
        timePoints: new Float64Array([
            blockStart,              // anchor — idle before gradient
            gradStart,               // end of idle
            gradStart + rise,        // ramp‑up done
            gradStart + rise + flat, // flat‑top done
            gradStart + rise + flat + fall,  // ramp‑down done
        ]),
        waveform: new Float64Array([0, 0, trap.amplitude, trap.amplitude, 0]),
        amplitude: trap.amplitude,
        type: 'trap',
        channel: ch,
    };
}

/** Arbitrary (shaped) gradient — includes leading anchor and first/last handling. */
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

    // +2 for the anchor points at blockStart and gradStart
    const tp = new Float64Array(n + 2);
    const wf = new Float64Array(n + 2);
    tp[0] = blockStart;  wf[0] = 0;
    tp[1] = gradStart;   wf[1] = arb.first;

    const timeShape = arb.timeId > 0
        ? seq.shapes.get(arb.timeId)?.samples ?? null
        : null;

    for (let i = 0; i < n; i++) {
        tp[i + 2] = timeShape
            ? gradStart + timeShape[i] * raster
            : gradStart + (i + 0.5) * raster;
        wf[i + 2] = arb.first + arb.amplitude * shape.samples[i];
    }

    const dur = n > 0 ? tp[n + 1] - blockStart + raster : delay;

    return {
        blockIndex: arb.id, startTime: blockStart, duration: dur,
        timePoints: tp, waveform: wf,
        amplitude: arb.amplitude, type: 'arb', channel: ch,
    };
}

// ─── ADC / Extensions ─────────────────────────────────────────────────────

function decodeADC(adc: ADCEntry, blockStart: number): DecodedADCEvent {
    return {
        blockIndex: adc.id, startTime: blockStart,
        numSamples: adc.numSamples,
        dwell: adc.dwell * 1e-9,     // ns → s
        delay: adc.delay * 1e-6,     // µs → s
        freqOffset: adc.freqOffset,
        phaseOffset: adc.phaseOffset,
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
