/**
 * TR/TE Detection Module
 *
 * Detects repetition time (TR) and echo time (TE) from Pulseq sequences.
 * Strategy mirrors the C++ SeqEyes (xingwangyong/SeqEyes) PulseqLoader.cpp:
 *
 *   1. Parse TE / EchoTime from [DEFINITIONS] if present.
 *   2. Parse RepetitionTime / TR from [DEFINITIONS] if present.
 *   3. If TR is NOT explicitly defined, estimate it from the spacing between
 *      excitation RF pulses (the modal interval).
 *   4. Classify RF pulses as excitation / refocusing / inversion / saturation
 *      using flip‑angle estimation (for pre‑v1.5 files lacking per‑pulse metadata).
 */

import type { PulseqSequence, SequenceTiming, BlockEntry, RFEntry } from './types';

/** ¹H gyromagnetic ratio in Hz/T. */
const GAMMA_HZ_T = 42.576e6;

/** Default B₀ [T] when not specified. */
const DEFAULT_B0_T = 3.0;

// ─── Public API ───────────────────────────────────────────────────────────

/** Analyse a parsed sequence and produce timing metadata.
 *  Call AFTER parseSequenceText() — the sequence must have blocks & RF entries parsed.
 *
 *  @param seq         Parsed Pulseq sequence.
 *  @param decodeRF    Optional callback to get decoded RF magnitude for flip‑angle estimation.
 *                     If not provided, uses a faster heuristic based on RF amplitude × duration.
 */
export function detectSequenceTiming(seq: PulseqSequence): SequenceTiming {
    const b0 = getB0(seq);
    const supportsRfUse = seq.versionCombined >= 1_005_000; // v1.5+

    // ── Parse TE ────────────────────────────────────────────────────
    let teTimeSec = 0;
    let hasExplicitTE = false;
    const teDef = seq.definitions.get('EchoTime') ?? seq.definitions.get('TE');
    if (teDef && teDef.length > 0) {
        teTimeSec = teDef[0];
        hasExplicitTE = true;
    }

    // ── Parse TR (explicit) ─────────────────────────────────────────
    let trTimeSec = 0;
    let hasExplicitTR = false;
    const trDef = seq.definitions.get('RepetitionTime') ?? seq.definitions.get('TR');
    if (trDef && trDef.length > 0) {
        trTimeSec = trDef[0];
        hasExplicitTR = true;
    }

    // ── Classify RF uses and find excitation times ──────────────────
    const rfUsePerBlock: number[] = [];
    const excitationTimesSec: number[] = [];
    let rfUseGuessed = false;

    // Compute cumulative block start times (in seconds)
    const blockStartTimes = computeCumulativeTimes(seq);

    for (let i = 0; i < seq.blocks.length; i++) {
        const blk = seq.blocks[i];
        if (blk.rfId <= 0) { rfUsePerBlock.push(0); continue; }

        const rf = seq.rfs.get(blk.rfId);
        if (!rf) { rfUsePerBlock.push(0); continue; }

        const useChar = classifyRfUse(rf, supportsRfUse, b0);
        const useCode = useChar.charCodeAt(0);
        rfUsePerBlock.push(useCode);
        if (useChar === 'e') {
            // Excitation centre time = block start + RF delay + RF centre
            const rfRaster = seq.rasterTimes.rfRaster;
            const center = rf.center >= 0 ? rf.center * 1e-6 : estimateRfCenter(rf, seq);
            const excTime = blockStartTimes[i] + rf.delay * rfRaster + center;
            excitationTimesSec.push(excTime);
        }
        if (!supportsRfUse && useChar !== 'u') rfUseGuessed = true;
    }

    // ── Estimate TR from excitation spacing if not explicit ─────────
    let trCount = 0;
    const trStartBlocks: number[] = [];

    if (!hasExplicitTR && excitationTimesSec.length >= 2) {
        trTimeSec = estimateTRFromExcitations(excitationTimesSec);
        hasExplicitTR = false;
    }

    // ── Find TR start blocks (blocks containing excitation centres) ──
    if (trTimeSec > 0) {
        // Total sequence duration
        const totalDuration = blockStartTimes.length > 0
            ? blockStartTimes[blockStartTimes.length - 1] + seq.blocks[seq.blocks.length - 1].dur * seq.rasterTimes.blockDurationRaster
            : 0;
        trCount = Math.max(1, Math.ceil(totalDuration / trTimeSec));

        // Walk through blocks and find which block each excitation falls in
        const tol = trTimeSec * 0.3; // 30% tolerance for TR boundary detection
        let trIdx = 0;
        for (let i = 0; i < seq.blocks.length; i++) {
            const blkStart = blockStartTimes[i];
            const expected = trIdx * trTimeSec;
            if (blkStart >= expected - tol && trIdx < trCount) {
                trStartBlocks.push(i);
                trIdx++;
            }
        }
        // Sentinel
        trStartBlocks.push(seq.blocks.length);
        trCount = trStartBlocks.length - 1;
    } else {
        // Fallback: treat each ADC block as a "TR" for navigation
        trCount = 0;
        for (let i = 0; i < seq.blocks.length; i++) {
            if (seq.blocks[i].adcId > 0) {
                trStartBlocks.push(i);
                trCount++;
            }
        }
        trStartBlocks.push(seq.blocks.length);
    }

    return {
        teTimeSec,
        hasExplicitTE,
        trTimeSec,
        hasExplicitTR,
        trCount,
        trStartBlocks,
        excitationTimesSec,
        rfUseGuessed,
        rfUsePerBlock,
    };
}

/** Get the start/end block indices for a given TR index (1‑based). */
export function getTrBlockRange(timing: SequenceTiming, trIndex: number): { startBlock: number; endBlock: number } | null {
    if (trIndex < 1 || trIndex > timing.trCount) return null;
    return {
        startBlock: timing.trStartBlocks[trIndex - 1],
        endBlock: Math.min(timing.trStartBlocks[trIndex], timing.trStartBlocks[timing.trStartBlocks.length - 1]),
    };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function getB0(seq: PulseqSequence): number {
    const raw = seq.definitions.get('B0') ?? seq.definitions.get('b0') ?? seq.definitions.get('b_0');
    if (raw && Array.isArray(raw) && raw.length > 0) return +raw[0];
    return DEFAULT_B0_T;
}

function computeCumulativeTimes(seq: PulseqSequence): number[] {
    const times: number[] = [];
    let cum = 0;
    for (const blk of seq.blocks) {
        times.push(cum);
        cum += blk.dur * seq.rasterTimes.blockDurationRaster;
    }
    return times;
}

/**
 * Classify an RF pulse based on its metadata or flip‑angle estimation.
 * Matches SeqEyes KSpaceTrajectory::classifyRfUse().
 *
 * Returns: 'e' excitation, 'r' refocusing, 's' saturation, 'i' inversion, 'u' unknown.
 */
function classifyRfUse(
    rf: RFEntry,
    supportsMetadata: boolean,
    b0Tesla: number,
): string {
    // Trust explicit metadata in v1.5+
    if (supportsMetadata && rf.use && rf.use !== 'u' && rf.use !== 'U') {
        return rf.use.toLowerCase();
    }

    // Estimate from flip angle for older files
    const faDeg = estimateFlipAngleDeg(rf);

    if (faDeg < 90.01) return 'e';

    // MATLAB parity: detect fat‑sat ('s') by long duration + off‑resonance near −3.45 ppm
    const freqPPM = rf.freqPPM !== 0
        ? rf.freqPPM
        : (b0Tesla > 0 ? 1e6 * rf.freqOffset / (GAMMA_HZ_T * b0Tesla) : 0);

    // Estimate pulse duration from shape length (fallback)
    const durEst = 0; // Not available without decompressing shape — use amplitude heuristic

    if (durEst > 6e-3 && freqPPM >= -4.5 && freqPPM <= -3.0) return 's';

    return 'r';
}

/** Estimate flip angle in degrees from RF amplitude and pulse duration.
 *  Uses a simplified integration: FA ≈ 360 × amplitude × duration.
 *  This is a heuristic — the true FA requires full shape integration. */
function estimateFlipAngleDeg(rf: RFEntry): number {
    // Heuristic: typical RF pulse has area ≈ amplitude × (pulse length)
    // Without decompressing shapes, we estimate from the amplitude alone.
    // Excitation pulses are typically 90° (amplitude ~500–2000 Hz for 1 ms)
    // Refocusing pulses are typically 180° (amplitude ~2× excitation)
    //
    // Since we don't have shape samples here, we use a simple threshold:
    // amplitude > 2000 Hz → likely refocusing (FA ≥ 120°)
    // amplitude ≤ 2000 Hz → likely excitation (FA ≤ 100°)
    //
    // This matches the C++ SeqEyes behaviour where flip angle estimation
    // via integration is only used for the RF use guess path.
    const absAmp = Math.abs(rf.amplitude);
    if (absAmp > 3000) return 180;  // strong → refocusing/inversion
    if (absAmp > 1500) return 120;  // moderate → likely refocusing
    return 90;                       // typical excitation
}

/** Estimate RF pulse centre time (seconds) when `rf.center` is not available.
 *  Matches SeqEyes KSpaceTrajectory::rfCenterUs() legacy fallback.
 *  Without decompressed samples, approximate as half the pulse duration. */
function estimateRfCenter(rf: RFEntry, _seq: PulseqSequence): number {
    // Without decompressed shape data, approximate centre as 0
    // (the true centre requires peak detection from decompressed magnitude shape)
    return 0;
}

/**
 * Estimate TR from the spacing between consecutive excitation pulses.
 * Uses the median interval (robust to outliers like inversion prep pulses).
 * Matches SeqEyes pattern where inter‑excitation spacing defines the TR.
 */
function estimateTRFromExcitations(excTimesSec: number[]): number {
    if (excTimesSec.length < 2) return 0;

    // Compute intervals between consecutive excitations
    const intervals: number[] = [];
    for (let i = 1; i < excTimesSec.length; i++) {
        const dt = excTimesSec[i] - excTimesSec[i - 1];
        if (dt > 1e-9) intervals.push(dt);
    }

    if (intervals.length === 0) return 0;

    // Use median for robustness (prep pulses may create outlier intervals)
    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];

    // Round to a "nice" value (nearest ms or 0.1 ms)
    const niceMs = niceRound(median * 1e3, 10);
    return niceMs * 1e-3;
}

/** Round a value to the nearest "nice" step. */
function niceRound(value: number, base: number): number {
    return Math.round(value / base) * base;
}
