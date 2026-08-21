/**
 * acousticAsc.ts — acoustic resonance ("forbidden") bands from a Siemens ASC.
 *
 * Key names follow pypulseq's `asc_to_hw.py` (revision
 * 805c76f9427d536a63bb0a7aa405fa9403e4d08a), which supports two spellings
 * depending on scanner generation. Both are read here; when neither is present
 * the caller is told so explicitly rather than being handed an empty list.
 *
 * Band semantics match `gradSpectrum.m`: `freq` is the centre and `bw` the full
 * width, so the band is `freq +/- bw/2`. Entries with `freq <= 0` are dropped,
 * as both upstream implementations do.
 */

import { findArray, normalizeAscKey, parseAscText, type ParsedAscValues } from './ascText';
import { parsePnsHardwareAsc, type PnsHardware } from './pns';

export interface AcousticResonance {
    /** Band centre [Hz]. */
    freqHz: number;
    /** Full band width [Hz]; the band spans `freqHz +/- bwHz/2`. */
    bwHz: number;
}

const FREQUENCY_KEYS = [
    'aflGCAcousticResonanceFrequency',
    'asGPAParameters[0].sGCParameters.aflAcousticResonanceFrequency',
];
const BANDWIDTH_KEYS = [
    'aflGCAcousticResonanceBandwidth',
    'asGPAParameters[0].sGCParameters.aflAcousticResonanceBandwidth',
];

/** Read acoustic resonance bands from ASC text. Throws on `$include`. */
export function parseAcousticResonancesAsc(text: string): AcousticResonance[] {
    return acousticResonancesFrom(parseAscText(text));
}

/**
 * Locate an array key that may sit under a scanner-specific prefix.
 *
 * `findArray` matches the whole key, and `resolvePnsPrefix` is what handles
 * prefixes on the PNS side. Acoustic tables need the same treatment: a profile
 * may carry `GradPatSup.Phys.Acoustic.aflGCAcousticResonanceFrequency`, and the
 * `.CarNS.` variant must be excluded exactly as it is for PNS.
 *
 * The resolved prefix is returned so the bandwidth table is read from the same
 * section rather than being paired with a different one.
 */
function findArrayWithPrefix(
    asc: ParsedAscValues,
    key: string,
): { values: number[]; prefix: string } | undefined {
    const direct = findArray(asc, key);
    if (direct) return { values: direct, prefix: '' };

    const normalized = normalizeAscKey(key);
    const candidate = [...asc.array.keys()]
        .filter(name => {
            const plain = normalizeAscKey(name);
            return plain !== normalized
                && plain.endsWith(`.${normalized}`)
                && !name.toLowerCase().includes('.carns.');
        })
        .sort()[0];
    if (!candidate) return undefined;

    const values = asc.array.get(candidate);
    if (!values) return undefined;
    const plain = normalizeAscKey(candidate);
    return { values, prefix: plain.slice(0, plain.length - normalized.length) };
}

export function acousticResonancesFrom(asc: ParsedAscValues): AcousticResonance[] {
    for (let i = 0; i < FREQUENCY_KEYS.length; i++) {
        const found = findArrayWithPrefix(asc, FREQUENCY_KEYS[i]);
        if (!found) continue;
        const frequencies = found.values;
        const bandwidths = findArray(asc, `${found.prefix}${BANDWIDTH_KEYS[i]}`)
            ?? findArray(asc, BANDWIDTH_KEYS[i])
            ?? [];
        const bands: AcousticResonance[] = [];
        for (let index = 0; index < frequencies.length; index++) {
            const freqHz = frequencies[index];
            if (!Number.isFinite(freqHz) || freqHz <= 0) continue;
            const raw = bandwidths[index];
            const bwHz = Number.isFinite(raw) && raw > 0 ? raw : 0;
            bands.push({ freqHz, bwHz });
        }
        if (bands.length) return bands.sort((a, b) => a.freqHz - b.freqHz);
    }
    return [];
}

export interface AscProfile {
    pns?: PnsHardware;
    pnsError?: string;
    acoustic: AcousticResonance[];
    acousticError?: string;
    /** Human-readable summary of what the file did and did not contain. */
    notice?: string;
}

/**
 * Parse both concerns of an ASC profile independently.
 *
 * The PNS reader throws when coefficients or `g_scale` are missing, and after
 * the button rename the same file picker must still succeed for a file that
 * carries only acoustic data (and vice versa). Failing one concern must not
 * discard the other, so each is caught separately and reported.
 *
 * A `$include` directive still fails the whole file: nothing can be read from a
 * profile whose companion files were not resolved.
 */
export function parseAscProfile(text: string): AscProfile {
    const asc = parseAscText(text);   // throws on $include — intentional

    let pns: PnsHardware | undefined;
    let pnsError: string | undefined;
    try {
        pns = parsePnsHardwareAsc(text);
    } catch (err) {
        pnsError = err instanceof Error ? err.message : String(err);
    }

    const acoustic = acousticResonancesFrom(asc);
    const acousticError = acoustic.length
        ? undefined
        : 'This ASC has no acoustic resonance table (aflGCAcousticResonanceFrequency '
          + 'or asGPAParameters[0].sGCParameters.aflAcousticResonanceFrequency).';

    return { pns, pnsError, acoustic, acousticError, notice: describeAscProfile(pns, acoustic) };
}

/** The four outcomes of §8.2, each reported distinctly. */
export function describeAscProfile(
    pns: PnsHardware | undefined,
    acoustic: AcousticResonance[],
): string | undefined {
    if (pns && acoustic.length) return undefined;
    if (pns) return 'PNS coefficients loaded. This ASC has no acoustic resonance table.';
    if (acoustic.length) {
        return `Acoustic resonances loaded (${acoustic.length} band${acoustic.length === 1 ? '' : 's'}). `
            + 'PNS coefficients are missing from this ASC.';
    }
    return 'This ASC contains neither PNS coefficients nor acoustic resonances.';
}

/** True when the profile yielded nothing usable at all. */
export function isEmptyAscProfile(profile: AscProfile): boolean {
    return !profile.pns && profile.acoustic.length === 0;
}

/**
 * Bands overlapping a displayed frequency range, for the out-of-range hint.
 * Returns the count that falls entirely outside `[fMinHz, fMaxHz]`.
 */
export function countBandsOutsideRange(
    bands: AcousticResonance[],
    fMinHz: number,
    fMaxHz: number,
): number {
    let outside = 0;
    for (const band of bands) {
        if (band.freqHz < fMinHz || band.freqHz > fMaxHz) outside++;
    }
    return outside;
}
