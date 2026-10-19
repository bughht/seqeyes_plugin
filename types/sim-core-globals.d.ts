/**
 * WHATWG globals that every simulator host provides (browsers, workers,
 * Node >= 20, Deno) but the ES library alone does not declare. Only the
 * members the isomorphic core uses; see tsconfig.sim-core.json.
 */
declare class TextDecoder {
    constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
    decode(input?: ArrayBufferView | ArrayBuffer): string;
}

declare class TextEncoder {
    constructor();
    encode(input?: string): Uint8Array;
}
