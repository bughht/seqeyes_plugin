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

/** Optional signature trailer parsed from a binary Pulseq file. */
export interface BinarySignatureInfo {
    type: string;
    hash: string;
    originalSize: number;
}

/**
 * Unified version integer for clean threshold comparisons.
 * Computed as: major*1_000_000 + minor*1_000 + revision.
 *
 * Thresholds (matching SeqEyes):
 *   < 1_004_000  — pre‑v1.4  (no timeShape, old block format)
 *   < 1_005_000  — v1.4.x   (timeShape added)
 *  >= 1_005_000  — v1.5.x   (PPM fields, center, quaternion rotations, etc.)
 *  >= 1_005_001  — RequiredExtensions check added
 *
 * Export these as constants so the reader can use them without magic numbers.
 */
export const VER_PRE_14  = 1_004_000;
export const VER_V15     = 1_005_000;
export const VER_V15001  = 1_005_001;

export function makeVersionCombined(major: number, minor: number, revision: number): number {
    return major * 1_000_000 + minor * 1_000 + revision;
}

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
    center: number;            // [µs] effective pulse centre (v1.5+; -1 = undefined)
    delay: number;             // [µs]  (v1.5+)  or [rf‑raster] (v1.4.x)
    freqPPM: number;           // [ppm]  (v1.5+)
    phasePPM: number;          // [rad/MHz]  (v1.5+)
    freqOffset: number;        // [Hz]
    phaseOffset: number;       // [rad]
    phaseModShapeId: number;   // additional phase modulation (v1.5+)
    use: string;               // 'e'|'r'|'i'|'s'|'u'  (v1.5+)
}

/** [GRADIENTS] — arbitrary (shaped) gradient */
export interface ArbitraryGradEntry {
    id: number;
    amplitude: number;   // [Hz/m]
    first: number;       // [Hz/m] at shape start  (v1.5+; NaN = undefined)
    last: number;        // [Hz/m] at shape end
    shapeId: number;     // normalized waveform shape
    timeId: number;      // 0 = uniform grad‑raster
    delay: number;       // [µs]
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
    freqPPM: number;        // [ppm]  (v1.5+)
    phasePPM: number;       // [rad/MHz]  (v1.5+)
    freqOffset: number;     // [Hz]
    phaseOffset: number;    // [rad]
    deadTime: number;       // [µs]  (v1.5+)
    discardPre: number;
    discardPost: number;
    phaseModShapeId: number;
}

/** [EXTENSIONS] linked‑list node.
 *  Extension type constants (matching SeqEyes ExtType enum). */
export const enum ExtType {
    EXT_LIST    = 0,   // the extension linked-list itself
    EXT_TRIGGER = 1,   // digital trigger output
    EXT_ROTATION= 2,   // gradient rotation matrix / quaternion
    EXT_LABELSET= 3,   // set MDH label counters / flags
    EXT_LABELINC= 4,   // increment MDH label counters
    EXT_DELAY   = 5,   // soft delay (v1.5+)
    EXT_RF_SHIM = 6,   // per‑channel RF shimming (v1.5+)
    EXT_NCO     = 100, // numerically-controlled oscillator (plugin extension)
    EXT_UNKNOWN = 999,
}

export interface ExtensionEntry {
    id: number;
    type: number;    // ExtType value
    ref: number;     // index into the type‑specific library
    nextId: number;  // 0 = end of chain
}

export interface TriggerSpec {
    id: number;
    triggerType: number;  // 1 = digital output
    channel: number;      // 1‑7
    delay: number;        // [µs]
    duration: number;     // [µs]
}

export interface NCOSpec {
    id: number;
    channel: number;
    frequency: number;  // [Hz]
    phase: number;      // [rad]
    delay: number;      // [µs]
    duration: number;   // [µs]
}

/** Gradient rotation — quaternion in v1.5+, 3×3 matrix in v1.4.x */
export interface RotationSpec {
    id: number;
    /** Quaternion [q0,q1,q2,q3] (v1.5+) or rotation matrix (v1.4.x, length 9). */
    values: number[];
}

/** Set MDH label counters / flags */
export interface LabelSetSpec {
    id: number;
    value: number;
    labelId: number;   // decoded label enum value
    flagId: number;    // decoded flag enum value
}

/** Increment MDH label counters */
export interface LabelIncSpec {
    id: number;
    value: number;
    labelId: number;
    flagId: number;
}

/** Soft delay (v1.5+) */
export interface SoftDelaySpec {
    id: number;
    numId: number;     // id of the soft‑delayed event
    offset: number;    // [µs]
    factor: number;    // scaling factor
    hint: string;      // optional description
}

/** Per‑channel RF shimming (v1.5+) */
export interface RFShimSpec {
    id: number;
    nChannels: number;
    amplitudes: number[];  // [Hz] per channel
    phases: number[];      // [rad] per channel
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
    centerTime: number;         // [s]  effective pulse center
    duration: number;           // [s]  pulse length
    timePoints: Float64Array;   // [s]  absolute time per sample
    magnitude: Float64Array;    // [Hz]
    phase: Float64Array;        // [rad]  wrapped to [-π, π]
    amplitude: number;          // [Hz]
    freqOffset: number;         // [Hz]  (effective, incl. PPM)
    phaseOffset: number;        // [rad] (effective, incl. PPM)
    use: string;                // 'e'=excitation, 'r'=refocusing, 'i'=inversion, 's'=saturation, 'u'=undefined
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

export interface DecodedRotationEvent {
    id: number;
    values: number[];
}

export interface DecodedLabelEvent {
    id: number;
    value: number;
    labelId: number;
    flagId: number;
}

export interface DecodedSoftDelayEvent {
    id: number;
    numId: number;
    offset: number;
    factor: number;
    hint: string;
}

export interface DecodedRFShimEvent {
    id: number;
    nChannels: number;
    amplitudes: number[];
    phases: number[];
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
    rotation?: DecodedRotationEvent;
    labelSets?: DecodedLabelEvent[];
    labelIncs?: DecodedLabelEvent[];
    softDelay?: DecodedSoftDelayEvent;
    rfShim?: DecodedRFShimEvent;
}

// ═══════════════════════════════════════════════════════════════
// Top‑level container
// ═══════════════════════════════════════════════════════════════

export interface PulseqSequence {
    version: VersionInfo;
    versionCombined: number;          // major*1M + minor*1K + revision
    definitions: Map<string, number[]>;
    definitionsRaw: Map<string, string>;
    blocks: BlockEntry[];
    rfs: Map<number, RFEntry>;
    arbitraryGrads: Map<number, ArbitraryGradEntry>;
    trapGrads: Map<number, TrapGradEntry>;
    adcs: Map<number, ADCEntry>;
    /** Extension linked-list nodes (type→ref→next). */
    extensions: Map<number, ExtensionEntry>;
    /** Extension registry entries from `extension NAME ID` headers. */
    extensionNames: Map<number, string>;
    extensionTypes: Map<number, ExtType>;
    /** Extension type‑specific libraries (ALL present, even if empty). */
    triggers: TriggerSpec[];
    ncos: NCOSpec[];
    rotations: RotationSpec[];
    labelSets: LabelSetSpec[];
    labelIncs: LabelIncSpec[];
    softDelays: SoftDelaySpec[];
    rfShims: RFShimSpec[];
    shapes: Map<number, DecompressedShape>;
    rasterTimes: {
        blockDurationRaster: number;   // [s]
        gradientRaster: number;
        rfRaster: number;
        adcRaster: number;
    };
    /** Binary signature metadata. Parsing does not imply digest verification. */
    binarySignature?: BinarySignatureInfo;
    /** Parsed timing metadata (from [DEFINITIONS]). */
    timing?: SequenceTiming;
}

/** Timing metadata extracted from the sequence — TE, TR, and TR detection info.
 *  Used to enable TR‑based navigation and first‑TR‑only rendering for large 3D sequences. */
export interface SequenceTiming {
    /** TE (echo time) in seconds, if defined via EchoTime / TE in [DEFINITIONS]. */
    teTimeSec: number;
    /** Whether TE was explicitly defined in the sequence file. */
    hasExplicitTE: boolean;
    /** TR (repetition time) in seconds, from RepetitionTime / TR or estimated from RF pulses. */
    trTimeSec: number;
    /** Whether TR was explicitly defined (true) or estimated from excitation RF spacing (false). */
    hasExplicitTR: boolean;
    /** Number of TRs in the sequence (only valid when TR is known). */
    trCount: number;
    /** 1‑based block indices where each TR starts (excitation block indices).
     *  Length = trCount + 1 (last entry is past‑the‑end sentinel). */
    trStartBlocks: number[];
    /** Excitation centre times in seconds (one per TR start). */
    excitationTimesSec: number[];
    /** RF use classification was guessed (pre‑v1.5 files lacking per‑pulse use tag). */
    rfUseGuessed: boolean;
    /** Per‑block RF use character ('e','r','s','i','p','u' or 0). */
    rfUsePerBlock: number[];
}
