/**
 * Pulseq Data Types — complete TypeScript definitions for the Pulseq v1.x format.
 *
 * Three-layer architecture:
 *   Layer 1 — Raw file data (parsed from .seq sections)
 *   Layer 2 — Decompressed shapes
 *   Layer 3 — Decoded time-domain waveforms for visualization
 *
 * @see https://github.com/pulseq/pulseq
 */

// ═══════════════════════════════════════════════════════════════
// Layer 1 — Raw file data
// ═══════════════════════════════════════════════════════════════

export interface VersionInfo { major: number; minor: number; revision: number; }

/** [BLOCKS] section row */
export interface BlockEntry {
    num: number;   // 1‑based block number
    dur: number;   // [block‑duration raster units]
    rfId: number; gxId: number; gyId: number; gzId: number;
    adcId: number; extId: number;  // 0 = none
}

/** [RF] library entry */
export interface RFEntry {
    id: number;
    amplitude: number;         // [Hz]
    magShapeId: number;        // magnitude envelope shape
    phaseShapeId: number;      // phase waveform shape
    timeShapeId: number;       // 0 = uniform rf‑raster
    delay: number;             // [rf‑raster units]  (v1.5+)
    phaseOffset: number;       // [rad]
    freqOffset: number;        // [Hz]
    phaseModShapeId: number;   // additional phase modulation (v1.5+)
    use: string;               // 'e'|'i'|'s'|'u'  (v1.5+)
}

/** [GRADIENTS] — arbitrary (shaped) gradient */
export interface ArbitraryGradEntry {
    id: number;
    amplitude: number;   // [Hz/m]
    first: number;       // [Hz/m] at shape start  (v1.5+; v1.4.x ≡ 0)
    last: number;        // [Hz/m] at shape end
    shapeId: number;     // normalized waveform shape
    timeId: number;      // 0 = uniform grad‑raster
    delay: number;       // [grad‑raster units]
}

/** [TRAP] — trapezoid gradient */
export interface TrapGradEntry {
    id: number;
    amplitude: number;   // [Hz/m]
    rise: number;        // [µs]
    flat: number;        // [µs]
    fall: number;        // [µs]
    delay: number;       // [µs]
}

/** [ADC] readout */
export interface ADCEntry {
    id: number;
    numSamples: number;
    dwell: number;          // [ns]
    delay: number;          // [µs]
    freqOffset: number;     // [Hz]
    phaseOffset: number;    // [rad]
    deadTime: number;       // [µs]  (v1.5+)
    discardPre: number;     // samples to discard (v1.5+)
    discardPost: number;
    phaseModShapeId: number;
}

/** [EXTENSIONS] linked‑list node */
export interface ExtensionEntry {
    id: number;
    type: number;    // 1=trigger  2=NCO  3=rotation  4=label …
    ref: number;
    nextId: number;  // 0 = end of chain
}

export interface TriggerSpec {
    id: number;
    channel: number;   // 1‑7
    delay: number;     // [µs]
    duration: number;  // [µs]
}

export interface NCOSpec {
    id: number;
    channel: number;
    frequency: number;  // [Hz]
    phase: number;      // [rad]
    delay: number;      // [µs]
    duration: number;   // [µs]
}

// ═══════════════════════════════════════════════════════════════
// Layer 2 — Decompressed shapes
// ═══════════════════════════════════════════════════════════════

/** Run‑length decompressed shape, normalized to [0, 1] */
export interface DecompressedShape {
    numSamples: number;
    samples: Float64Array;
}

// ═══════════════════════════════════════════════════════════════
// Layer 3 — Decoded time‑domain output
// ═══════════════════════════════════════════════════════════════

export interface DecodedRFWaveform {
    blockIndex: number;
    startTime: number;          // [s]  includes RF delay
    duration: number;           // [s]  pulse length (without delay)
    timePoints: Float64Array;   // [s]  absolute time per sample
    magnitude: Float64Array;    // [Hz]
    phase: Float64Array;        // [rad]
    amplitude: number;          // [Hz]
    freqOffset: number;
    phaseOffset: number;
}

export interface DecodedGradWaveform {
    blockIndex: number;
    startTime: number;          // [s]  block start (visual anchor)
    duration: number;           // [s]  delay + shape
    timePoints: Float64Array;   // [s]
    waveform: Float64Array;     // [Hz/m]
    amplitude: number;          // [Hz/m]
    type: 'trap' | 'arb' | 'none';
    channel: 'gx' | 'gy' | 'gz';
}

export interface DecodedADCEvent {
    blockIndex: number;
    startTime: number;       // [s]  block start
    numSamples: number;
    dwell: number;           // [s]
    delay: number;           // [s]
    freqOffset: number;
    phaseOffset: number;
}

export interface DecodedTriggerEvent {
    blockIndex: number;
    startTime: number;
    channel: number;
    delay: number;           // [s]
    duration: number;        // [s]
}

export interface DecodedNCOEvent {
    blockIndex: number;
    startTime: number;
    channel: number;
    frequency: number;
    phase: number;
    delay: number;
    duration: number;
}

export interface DecodedBlock {
    index: number;           // 1‑based
    duration: number;        // [s]
    startTime: number;       // [s]  cumulative from sequence start
    rf?: DecodedRFWaveform;
    gx?: DecodedGradWaveform;
    gy?: DecodedGradWaveform;
    gz?: DecodedGradWaveform;
    adc?: DecodedADCEvent;
    triggers?: DecodedTriggerEvent[];
    nco?: DecodedNCOEvent[];
}

// ═══════════════════════════════════════════════════════════════
// Top‑level container
// ═══════════════════════════════════════════════════════════════

export interface PulseqSequence {
    version: VersionInfo;
    definitions: Map<string, number[]>;
    definitionsRaw: Map<string, string>;
    blocks: BlockEntry[];
    rfs: Map<number, RFEntry>;
    arbitraryGrads: Map<number, ArbitraryGradEntry>;
    trapGrads: Map<number, TrapGradEntry>;
    adcs: Map<number, ADCEntry>;
    extensions: Map<number, ExtensionEntry>;
    triggers: TriggerSpec[];
    ncos: NCOSpec[];
    shapes: Map<number, DecompressedShape>;
    rasterTimes: {
        blockDurationRaster: number;   // [s]
        gradientRaster: number;
        rfRaster: number;
        adcRaster: number;
    };
}
