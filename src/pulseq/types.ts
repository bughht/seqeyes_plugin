/**
 * Pulseq data types — mirrors the Pulseq v1.x file format specification.
 */

/** Raw definition entry parsed from [DEFINITIONS] section */
export interface DefinitionEntry {
    key: string;
    values: number[];
}

/** Raw block entry parsed from [BLOCKS] section */
export interface BlockEntry {
    num: number;
    dur: number;       // duration in block duration raster units
    rfId: number;      // 0 = none
    gxId: number;      // 0 = none
    gyId: number;
    gzId: number;
    adcId: number;     // 0 = none
    extId: number;     // 0 = none
}

/** RF event data from [RF] section */
export interface RFEntry {
    id: number;
    amplitude: number;           // Hz
    magShapeId: number;
    phaseShapeId: number;
    timeShapeId: number;         // 0 = default raster
    delay: number;               // v1.5+: RF delay in rf raster units
    phaseOffset: number;         // radians
    freqOffset: number;          // Hz
    phaseModShapeId: number;     // v1.5+: shape ID for phase modulation, 0 = none
    use: string;                 // v1.5+: 'e' excitation, 'i' inversion, 's' saturation, 'u' undefined
}

/** Arbitrary gradient entry from [GRADIENTS] section */
export interface ArbitraryGradEntry {
    id: number;
    amplitude: number;   // Hz/m
    first: number;       // v1.5+: amplitude at shape start (v1.4.x: implicit 0)
    last: number;        // v1.5+: amplitude at shape end (v1.4.x: implicit 0)
    shapeId: number;
    timeId: number;      // 0 = default raster
    delay: number;       // v1.5+: delay in grad raster units (v1.4.x: stored as timeRange)
}

/** Trapezoid gradient entry from [TRAP] section */
export interface TrapGradEntry {
    id: number;
    amplitude: number;    // Hz/m
    rise: number;         // us
    flat: number;         // us
    fall: number;         // us
    delay: number;        // us
}

/** ADC entry from [ADC] section */
export interface ADCEntry {
    id: number;
    numSamples: number;
    dwell: number;        // ns
    delay: number;        // us
    freqOffset: number;   // Hz
    phaseOffset: number;  // radians
    deadTime: number;     // v1.5+: ADC dead time (us)
    discardPre: number;   // v1.5+: samples to discard before
    discardPost: number;  // v1.5+: samples to discard after
    phaseModShapeId: number; // v1.5+: shape ID for phase modulation
}

/** Extension list entry from [EXTENSIONS] section */
export interface ExtensionEntry {
    id: number;
    type: number;
    ref: number;
    nextId: number;
}

/** Trigger specification */
export interface TriggerSpec {
    id: number;
    channel: number;   // 1-7
    delay: number;     // us
    duration: number;  // us
}

/** NCO (Numerically Controlled Oscillator) specification */
export interface NCOSpec {
    id: number;
    channel: number;
    frequency: number;  // Hz
    phase: number;      // radians
    delay: number;      // us
    duration: number;   // us
}

/** Decompressed shape data */
export interface DecompressedShape {
    numSamples: number;
    samples: Float64Array;  // normalized [0,1] range
}

/** Fully decoded RF waveform for a block */
export interface DecodedRFWaveform {
    blockIndex: number;
    startTime: number;       // seconds
    duration: number;        // seconds
    timePoints: Float64Array; // seconds
    magnitude: Float64Array;  // Hz
    phase: Float64Array;      // radians
    amplitude: number;        // Hz
    freqOffset: number;       // Hz
    phaseOffset: number;      // radians
}

/** Fully decoded gradient waveform for a block and channel */
export interface DecodedGradWaveform {
    blockIndex: number;
    startTime: number;
    duration: number;
    timePoints: Float64Array;
    waveform: Float64Array;   // Hz/m
    amplitude: number;
    type: 'trap' | 'arb' | 'none';
    channel: 'gx' | 'gy' | 'gz';
}

/** Fully decoded ADC event for a block */
export interface DecodedADCEvent {
    blockIndex: number;
    startTime: number;
    numSamples: number;
    dwell: number;        // seconds
    delay: number;        // seconds
    freqOffset: number;
    phaseOffset: number;
}

/** Fully decoded trigger event for a block */
export interface DecodedTriggerEvent {
    blockIndex: number;
    startTime: number;
    channel: number;
    delay: number;        // seconds
    duration: number;     // seconds
}

/** Fully decoded NCO event for a block */
export interface DecodedNCOEvent {
    blockIndex: number;
    startTime: number;
    channel: number;
    frequency: number;
    phase: number;
    delay: number;
    duration: number;
}

/** Complete decoded block with all waveforms */
export interface DecodedBlock {
    index: number;
    duration: number;       // seconds
    startTime: number;      // seconds (computed cumulatively)
    rf?: DecodedRFWaveform;
    gx?: DecodedGradWaveform;
    gy?: DecodedGradWaveform;
    gz?: DecodedGradWaveform;
    adc?: DecodedADCEvent;
    triggers?: DecodedTriggerEvent[];
    nco?: DecodedNCOEvent[];
}

/** Complete parsed sequence */
export interface PulseqSequence {
    version: { major: number; minor: number; revision: number };
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
        blockDurationRaster: number;    // seconds
        gradientRaster: number;         // seconds
        rfRaster: number;               // seconds
        adcRaster: number;              // seconds
    };
}
