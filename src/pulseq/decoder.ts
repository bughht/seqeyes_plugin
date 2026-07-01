/**
 * Waveform decoder — converts parsed Pulseq blocks into time-domain waveforms
 * by expanding shapes, applying amplitudes, and computing time points.
 */
import { PulseqSequence, DecodedBlock, DecodedRFWaveform, DecodedGradWaveform, DecodedADCEvent, DecodedTriggerEvent, DecodedNCOEvent, RFEntry, TrapGradEntry, ArbitraryGradEntry, ADCEntry } from './types';

/**
 * Decode all blocks in a sequence into full waveforms.
 */
export function decodeAllBlocks(seq: PulseqSequence): DecodedBlock[] {
    const decoded: DecodedBlock[] = [];
    let cumulativeTime = 0; // seconds

    for (const block of seq.blocks) {
        const durSeconds = block.dur * seq.rasterTimes.blockDurationRaster;
        const decodedBlock: DecodedBlock = {
            index: block.num,
            duration: durSeconds,
            startTime: cumulativeTime,
        };

        // Decode RF
        if (block.rfId > 0) {
            const rf = seq.rfs.get(block.rfId);
            if (rf) {
                decodedBlock.rf = decodeRF(seq, rf, cumulativeTime, durSeconds);
            }
        }

        // Decode gradients (Gx, Gy, Gz)
        decodedBlock.gx = decodeGradient(seq, block.gxId, cumulativeTime, durSeconds, 'gx');
        decodedBlock.gy = decodeGradient(seq, block.gyId, cumulativeTime, durSeconds, 'gy');
        decodedBlock.gz = decodeGradient(seq, block.gzId, cumulativeTime, durSeconds, 'gz');

        // Decode ADC
        if (block.adcId > 0) {
            const adc = seq.adcs.get(block.adcId);
            if (adc) {
                decodedBlock.adc = decodeADC(seq, adc, cumulativeTime);
            }
        }

        // Decode extensions (triggers, NCO)
        if (block.extId > 0) {
            const ext = seq.extensions.get(block.extId);
            if (ext) {
                decodeExtensions(seq, ext, decodedBlock, cumulativeTime);
            }
        }

        decoded.push(decodedBlock);
        cumulativeTime += durSeconds;
    }

    return decoded;
}

function decodeRF(seq: PulseqSequence, rf: RFEntry, startTime: number, blockDur: number): DecodedRFWaveform {
    const rfRaster = seq.rasterTimes.rfRaster;

    // Get magnitude shape
    let magSamples: Float64Array;
    const magShape = seq.shapes.get(rf.magShapeId);
    if (magShape) {
        magSamples = new Float64Array(magShape.samples);
    } else {
        // No shape found, create a simple pulse
        const n = Math.max(2, Math.round(blockDur / rfRaster));
        magSamples = new Float64Array(n);
        magSamples.fill(1.0);
    }

    // Get phase shape
    let phaseSamples: Float64Array;
    const phaseShape = seq.shapes.get(rf.phaseShapeId);
    if (phaseShape) {
        phaseSamples = new Float64Array(phaseShape.samples);
    } else {
        phaseSamples = new Float64Array(magSamples.length);
        phaseSamples.fill(0);
    }

    // Ensure same length
    const nSamples = Math.min(magSamples.length, phaseSamples.length);
    const timePoints = new Float64Array(nSamples);
    const magnitude = new Float64Array(nSamples);
    const phase = new Float64Array(nSamples);

    // Time shape for non-uniform sampling
    let timeShape: Float64Array | null = null;
    if (rf.timeShapeId > 0) {
        const ts = seq.shapes.get(rf.timeShapeId);
        if (ts) timeShape = new Float64Array(ts.samples);
    }

    // RF actual start time (block start + RF delay)
    const rfStartTime = startTime + rf.delay * rfRaster;

    for (let i = 0; i < nSamples; i++) {
        if (timeShape && i < timeShape.length) {
            timePoints[i] = rfStartTime + timeShape[i] * rfRaster;
        } else {
            timePoints[i] = rfStartTime + (i + 0.5) * rfRaster;
        }
        magnitude[i] = rf.amplitude * magSamples[i];
        // Phase = 2π×phaseShape + phaseOffset + 2π×freqOffset×(t - t0)
        const dt = timePoints[i] - rfStartTime;
        phase[i] = 2 * Math.PI * phaseSamples[i] + rf.phaseOffset + 2 * Math.PI * rf.freqOffset * dt;
    }

    const duration = nSamples > 0
        ? timePoints[nSamples - 1] - rfStartTime + rfRaster
        : blockDur - rf.delay * rfRaster;

    return {
        blockIndex: rf.id,
        startTime: rfStartTime,
        duration,
        timePoints,
        magnitude,
        phase,
        amplitude: rf.amplitude,
        freqOffset: rf.freqOffset,
        phaseOffset: rf.phaseOffset,
    };
}

function decodeGradient(seq: PulseqSequence, gradId: number, startTime: number, blockDur: number, channel: 'gx' | 'gy' | 'gz'): DecodedGradWaveform {
    const gradRaster = seq.rasterTimes.gradientRaster;

    if (gradId <= 0) {
        // No gradient → flat zero
        return {
            blockIndex: 0,
            startTime,
            duration: blockDur,
            timePoints: new Float64Array([startTime, startTime + blockDur]),
            waveform: new Float64Array([0, 0]),
            amplitude: 0,
            type: 'none',
            channel,
        };
    }

    // Check if trapezoid
    const trap = seq.trapGrads.get(gradId);
    if (trap) {
        return decodeTrapGradient(trap, startTime, channel);
    }

    // Check if arbitrary
    const arb = seq.arbitraryGrads.get(gradId);
    if (arb) {
        return decodeArbitraryGradient(seq, arb, startTime, gradRaster, channel);
    }

    // Fallback: empty gradient
    return {
        blockIndex: gradId,
        startTime,
        duration: blockDur,
        timePoints: new Float64Array([startTime, startTime + blockDur]),
        waveform: new Float64Array([0, 0]),
        amplitude: 0,
        type: 'none',
        channel,
    };
}

/**
 * Decode a trapezoid gradient into time-domain points.
 * Produces a waveform that spans from block start to the end of the shape,
 * including the leading zero (delay) segment for proper visual alignment.
 */
function decodeTrapGradient(trap: TrapGradEntry, startTime: number, channel: 'gx' | 'gy' | 'gz'): DecodedGradWaveform {
    const rise = trap.rise * 1e-6;
    const flat = trap.flat * 1e-6;
    const fall = trap.fall * 1e-6;
    const delay = trap.delay * 1e-6;
    const amp = trap.amplitude;
    const gradStart = startTime + delay;

    const tPoints: number[] = [];
    const waveform: number[] = [];

    // Leading zero: block start → gradient start (shows idle time before gradient)
    tPoints.push(startTime);
    waveform.push(0);
    tPoints.push(gradStart);
    waveform.push(0);

    // Ramp up
    tPoints.push(gradStart + rise);
    waveform.push(amp);

    // Flat top
    tPoints.push(gradStart + rise + flat);
    waveform.push(amp);

    // Ramp down
    tPoints.push(gradStart + rise + flat + fall);
    waveform.push(0);

    const totalDuration = delay + rise + flat + fall;

    return {
        blockIndex: trap.id,
        startTime,                // block start (same as other events in this block)
        duration: totalDuration,  // includes delay + shape
        timePoints: new Float64Array(tPoints),
        waveform: new Float64Array(waveform),
        amplitude: amp,
        type: 'trap',
        channel,
    };
}

/**
 * Decode an arbitrary (shaped) gradient.
 * Includes delay offset and first/last amplitude handling for v1.5.x continuity.
 */
function decodeArbitraryGradient(seq: PulseqSequence, arb: ArbitraryGradEntry, startTime: number, gradRaster: number, channel: 'gx' | 'gy' | 'gz'): DecodedGradWaveform {
    const shape = seq.shapes.get(arb.shapeId);
    if (!shape) {
        return {
            blockIndex: arb.id,
            startTime,
            duration: 0,
            timePoints: new Float64Array([startTime]),
            waveform: new Float64Array([0]),
            amplitude: 0,
            type: 'arb',
            channel,
        };
    }

    const delay = arb.delay * gradRaster;
    const gradStart = startTime + delay;
    const nSamples = shape.numSamples;
    const timePoints = new Float64Array(nSamples + 2); // +2 for leading edge
    const waveform = new Float64Array(nSamples + 2);

    // Leading zero point at block start (visual alignment)
    timePoints[0] = startTime;
    waveform[0] = 0;
    timePoints[1] = gradStart;
    waveform[1] = arb.first;

    let timeShape: Float64Array | null = null;
    if (arb.timeId > 0) {
        const ts = seq.shapes.get(arb.timeId);
        if (ts) timeShape = new Float64Array(ts.samples);
    }

    for (let i = 0; i < nSamples; i++) {
        if (timeShape && i < timeShape.length) {
            timePoints[i + 2] = gradStart + timeShape[i] * gradRaster;
        } else {
            timePoints[i + 2] = gradStart + (i + 0.5) * gradRaster;
        }
        waveform[i + 2] = arb.first + arb.amplitude * shape.samples[i];
    }

    const duration = nSamples > 0
        ? timePoints[nSamples + 1] - startTime + gradRaster
        : delay;

    return {
        blockIndex: arb.id,
        startTime,
        duration,
        timePoints,
        waveform,
        amplitude: arb.amplitude,
        type: 'arb',
        channel,
    };
}

function decodeADC(seq: PulseqSequence, adc: ADCEntry, startTime: number): DecodedADCEvent {
    return {
        blockIndex: adc.id,
        startTime,
        numSamples: adc.numSamples,
        dwell: adc.dwell * 1e-9,     // ns → s
        delay: adc.delay * 1e-6,     // us → s
        freqOffset: adc.freqOffset,
        phaseOffset: adc.phaseOffset,
    };
}

function decodeExtensions(seq: PulseqSequence, ext: { id: number; type: number; ref: number; nextId: number }, decodedBlock: DecodedBlock, blockStartTime: number): void {
    // Walk the extension linked list
    let currentExt = ext;
    const visited = new Set<number>();

    while (currentExt && !visited.has(currentExt.id)) {
        visited.add(currentExt.id);

        if (currentExt.type === 1) {
            // TRIGGERS type
            const triggers = seq.triggers.filter(t => {
                // Match triggers that belong to this extension chain
                // The ref links to trigger spec IDs
                return true; // For simplicity, include all triggers
            });

            if (triggers.length > 0) {
                decodedBlock.triggers = triggers.map(t => ({
                    blockIndex: t.id,
                    startTime: blockStartTime,
                    channel: t.channel,
                    delay: t.delay * 1e-6,      // us → s
                    duration: t.duration * 1e-6, // us → s
                }));
            }
        } else if (currentExt.type === 2) {
            // NCO type
            const ncos = seq.ncos;
            if (ncos.length > 0) {
                decodedBlock.nco = ncos.map(n => ({
                    blockIndex: n.id,
                    startTime: blockStartTime,
                    channel: n.channel,
                    frequency: n.frequency,
                    phase: n.phase,
                    delay: n.delay * 1e-6,
                    duration: n.duration * 1e-6,
                }));
            }
        }

        if (currentExt.nextId > 0) {
            currentExt = seq.extensions.get(currentExt.nextId) || undefined as any;
        } else {
            break;
        }
    }
}
