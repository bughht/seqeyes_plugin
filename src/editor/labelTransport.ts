/**
 * The label table the extension host sends to its webview.
 *
 * Kept out of `seqEditorProvider` for the same reason as `kspaceTransport.ts`:
 * the provider imports `vscode`, which a browser or Vitest run cannot load, and
 * the tests need to build the real payload.
 */
import type { AdcLabelTable, LabelKind } from '../pulseq/labels';

export interface SerializedLabelTable {
    names: string[];
    kinds: LabelKind[];
    count: number;
    min: number[];
    max: number[];
    /** Float64 ADC centre times [s]. */
    timeSec: ArrayBuffer;
    /** Uint32 1-based block numbers. */
    block: ArrayBuffer;
    /** Int32 label values, `count × names.length`, row-major. */
    values: ArrayBuffer;
}

/**
 * Pack a label table for the webview.  The per-ADC arrays travel as raw
 * buffers, like the waveform and k-space samples: a long 3D acquisition has
 * hundreds of thousands of ADCs, and a JSON number array of that size costs
 * far more to build and parse than the bytes themselves.
 */
export function serializeLabelTable(table: AdcLabelTable): SerializedLabelTable {
    return {
        names: [...table.names],
        kinds: [...table.kinds],
        count: table.count,
        min: [...table.min],
        max: [...table.max],
        timeSec: ownBuffer(table.timeSec),
        block: ownBuffer(table.block),
        values: ownBuffer(table.values),
    };
}

/** The view's bytes as a buffer of their own, so a subarray never leaks its parent. */
function ownBuffer(view: Float64Array | Uint32Array | Int32Array): ArrayBuffer {
    const buffer = view.buffer as ArrayBuffer;
    if (view.byteOffset === 0 && view.byteLength === buffer.byteLength) return buffer;
    return buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}
