/**
 * The simulation program: a Pulseq sequence lowered to a time-ordered stream of
 * segments that partition [0, total duration] without gaps.
 *
 *   free — no RF and no readout; magnetization only precesses and relaxes, so
 *          the whole interval is one exact operator whatever the gradient shape.
 *   rf   — an RF pulse, with the gradient played under it.
 *   adc  — a readout window: free precession observed at each sample.
 *
 * Segments never cross block boundaries. Times are absolute seconds on the
 * program's own clock (integer block-raster prefix sums, soft delays applied).
 * Gradients are physical (rotation applied), in Hz/m; k is in cycles/m.
 */

import type { RFEntry } from '../../pulseq/types';
import type { GradientPieces, SegmentMoments } from './pwl';

export interface SegmentBase {
    /** 0-based index into the block table. */
    blockIndex: number;
    t0: number;
    t1: number;
    /** Gradient moments over [t0, t1], K measured from t0. */
    moments: SegmentMoments;
}

export interface FreeSegment extends SegmentBase {
    kind: 'free';
}

/** RF waveform as Pulseq defines it: uniform raster cells, or time-shape breakpoints. */
export type RfWaveform =
    | {
        /** Sample i is held over [i·raster, (i+1)·raster] from the pulse start. */
        kind: 'uniform';
        raster: number;
        count: number;
        /** Normalised magnitude per sample (shared with the shape library — read-only). */
        magnitude: Float64Array;
        /** Phase per sample in cycles, or null for zero phase (shared — read-only). */
        phaseCycles: Float64Array | null;
    }
    | {
        /**
         * Breakpoints of a piecewise-linear waveform at `times` (seconds from
         * the pulse start, the time shape × raster). The pulse ends at the last
         * breakpoint, as Pulseq's `makeBlockPulse` defines it — no extra raster.
         */
        kind: 'breakpoints';
        raster: number;
        count: number;
        times: Float64Array;
        magnitude: Float64Array;
        phaseCycles: Float64Array | null;
    };

/**
 * Everything that determines an RF pulse's action on a spin at a given
 * position, off-resonance and B1 — and nothing else. Events sharing a key share
 * one operator; the RF phase offset is applied per event analytically.
 */
export interface RfOperatorSpec {
    key: string;
    /** Library entry of the first event seen with this key. */
    rf: RFEntry;
    /** Peak amplitude [Hz]. */
    amplitude: number;
    waveform: RfWaveform;
    /** Effective frequency offset incl. PPM [Hz]. */
    freqOffset: number;
    /** Pulse duration [s]. */
    duration: number;
    /** Gradient under the pulse, times relative to the pulse start. */
    gradient: GradientPieces;
    /** Static pTx weights (raw complex shim vector), or null. */
    shim: { amplitudes: number[]; phases: number[] } | null;
    /** Channel count when the waveform uses the pTx-Pulseq layout (unsupported for now). */
    ptxChannels: number;
}

export interface RfSegment extends SegmentBase {
    kind: 'rf';
    key: string;
    operator: RfOperatorSpec;
    /** Effective phase offset incl. PPM [rad]; applied as a z-rotation conjugation. */
    phaseOffset: number;
    /** Classified use ('e', 'r', 'i', 's', 'p', 'o', 'u'). */
    use: string;
    /** RF centre [s, absolute]. */
    centerTime: number;
    /** ∫ g from t0 to the RF centre per axis [1/m]. */
    kToCenter: Float64Array;
    /** Gradient over [t0, t1] (absolute times). */
    gradient: GradientPieces;
}

export interface AdcSegment extends SegmentBase {
    kind: 'adc';
    /** 0-based ADC ordinal, which indexes the label table rows. */
    adcIndex: number;
    numSamples: number;
    /** [s]; sample s sits at t0 + (s + 0.5)·dwell. */
    dwell: number;
    /** Effective receiver phase offset incl. PPM [rad]. */
    phaseOffset: number;
    /** Effective receiver frequency offset incl. PPM [Hz]. */
    freqOffset: number;
    /** Per-sample receiver phase modulation [rad], shared — read-only. */
    phaseModulation: Float64Array | null;
    /** Gradient over [t0, t1] (absolute times). */
    gradient: GradientPieces;
    /** Bit i set when axis i carries gradient anywhere inside the window. */
    activeAxes: number;
}

export type SimSegment = FreeSegment | RfSegment | AdcSegment;

export interface CompileOptions {
    /** Field strength used for PPM offsets [T]; default the file's `B0`, else 3 T. */
    b0?: number;
    /** Gyromagnetic ratio [Hz/T]; default Pulseq's 42.576e6. */
    gamma?: number;
    /**
     * Soft-delay inputs keyed by the delay's numId [s]. A soft-delayed block
     * then lasts input/factor + offset; unset delays keep the file duration.
     */
    softDelayInputs?: Readonly<Record<number, number>>;
    /** Round soft-delay durations to the block raster, as the scanner does (default true). */
    roundSoftDelays?: boolean;
}

/** Sequence features present but not represented by the program. */
export type IgnoredFeature = 'trigger' | 'nco' | 'dynamic-ptx-rf';
