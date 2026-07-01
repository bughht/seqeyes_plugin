/**
 * Shape decompressor — implements Pulseq's run-length compression scheme
 * on the derivative of the waveform.
 *
 * Compression format (from Pulseq C++ reference):
 * - Run-length encoding of the derivative.
 * - When two consecutive packed values DIFFER: output the first value.
 * - When two consecutive packed values are EQUAL:
 *     The THIRD value (at index countPack+2) is rep_count+2.
 *     Output `rep_count+2` copies of the repeated value.
 *     Advance countPack by 3.
 * - After unpacking, cumulative sum reconstructs the original waveform.
 */

/**
 * Decompress a Pulseq shape.
 */
export function decompressShape(compressed: Float64Array | number[], numSamples: number): Float64Array {
    const dataLen = compressed.length;

    // If length matches numSamples, stored uncompressed
    if (dataLen === numSamples) {
        return new Float64Array(compressed);
    }

    const result = new Float64Array(numSamples);
    let countPack = 0;   // index into compressed data
    let countUnpack = 0; // index into result

    while (countPack < dataLen && countUnpack < numSamples) {
        // Need at least one more value to check
        if (countPack + 1 >= dataLen) {
            // Last single value
            result[countUnpack] = compressed[countPack];
            countPack++;
            countUnpack++;
            break;
        }

        if (compressed[countPack] !== compressed[countPack + 1]) {
            // Different consecutive values → output the first
            result[countUnpack] = compressed[countPack];
            countPack++;
            countUnpack++;
        } else {
            // Equal consecutive values → repeat marker
            // The NEXT value (at countPack+2) is (rep_count - 2)
            if (countPack + 2 >= dataLen) break;
            const value = compressed[countPack];
            const rep = Math.round(compressed[countPack + 2]) + 2;
            countPack += 3; // skip: value, value, repCount
            const end = Math.min(countUnpack + rep, numSamples);
            while (countUnpack < end) {
                result[countUnpack] = value;
                countUnpack++;
            }
        }
    }

    // Cumulative sum (derivative → original)
    let cumSum = 0;
    for (let i = 0; i < numSamples; i++) {
        cumSum += result[i];
        result[i] = cumSum;
    }

    return result;
}
