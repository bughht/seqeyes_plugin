/**
 * ascText.ts — Siemens ASC key/value text parsing.
 *
 * Shared by the PNS hardware reader (`pns.ts`) and the acoustic resonance
 * reader (`acousticAsc.ts`) so both concerns agree on key normalisation,
 * the `.CarNS.` exclusion, and the `$include` policy.
 */

export interface ParsedAscValues {
    scalar: Map<string, number>;
    array: Map<string, number[]>;
}

const ASC_LINE = /^\s*([A-Za-z0-9_.[\]]+?)(?:\[(\d+)])?\s*=\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*$/;

export const ASC_INCLUDE_MESSAGE =
    'ASC contains $include directives. Use a combined ASC profile in the web viewer, '
    + 'or open it through the VS Code extension so companion ASC files can be resolved.';

export function parseAscText(text: string): ParsedAscValues {
    const scalar = new Map<string, number>();
    const array = new Map<string, number[]>();
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('###')) continue;
        if (/^\$include\b/i.test(line)) throw new Error(ASC_INCLUDE_MESSAGE);
        const match = ASC_LINE.exec(line);
        if (!match) continue;
        const key = match[1].trim();
        const index = match[2] === undefined ? -1 : Number.parseInt(match[2], 10);
        const value = Number(match[3]);
        if (!Number.isFinite(value)) continue;
        if (index >= 0) {
            const values = array.get(key) ?? [];
            values[index] = value;
            array.set(key, values);
        } else {
            scalar.set(key, value);
        }
    }
    return { scalar, array };
}

export function findArray(asc: ParsedAscValues, key: string): number[] | undefined {
    const exact = asc.array.get(key);
    if (exact) return exact;
    const keyNorm = normalizeAscKey(key);
    const chosen = [...asc.array.keys()]
        .filter(candidate => normalizeAscKey(candidate) === keyNorm && !candidate.toLowerCase().includes('.carns.'))
        .sort()[0];
    return chosen ? asc.array.get(chosen) : undefined;
}

export function findScalar(asc: ParsedAscValues, key: string): number | undefined {
    const exact = asc.scalar.get(key);
    if (exact !== undefined) return exact;
    const keyNorm = normalizeAscKey(key);
    const chosen = [...asc.scalar.keys()]
        .filter(candidate => normalizeAscKey(candidate) === keyNorm && !candidate.toLowerCase().includes('.carns.'))
        .sort()[0];
    return chosen ? asc.scalar.get(chosen) : undefined;
}

export function normalizeAscKey(key: string): string {
    return key.trim().replace(/\[\d+]/g, '');
}
