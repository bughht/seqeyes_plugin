/**
 * Pulseq Shape Decompressor
 *
 * Implements Pulseq's run‑length encoding scheme on the waveform derivative.
 * Reference: ExternalSequence::decompressShape() in the Pulseq C++ source.
 *
 * Algorithm:
 *   The compressed stream encodes the *derivative* of the shape using
 *   run‑length encoding.  When two consecutive values in the packed stream
 *   differ, the first value is a literal derivative sample.  When they are
 *   equal, the *third* value (index +2) is (repeat_count − 2), and the
 *   derivative value should be repeated (repeat_count + 2) times.
 *   After unpacking the derivative, a cumulative sum reconstructs the
 *   original shape.
 */

/**
 * Decompress a Pulseq shape (run‑length encoding of the derivative).
 *
 * @param compressed  Packed sample values from the .seq file.
 * @param numSamples  Expected number of uncompressed samples.
 * @returns           Normalised shape samples in [0, 1] range.
 */
export function decompressShape(
    compressed: Float64Array | number[],
    numSamples: number,
): Float64Array {
    const packedLen = compressed.length;

    // Uncompressed storage — just return as‑is
    if (packedLen === numSamples) {
        return new Float64Array(compressed);
    }

    const result = new Float64Array(numSamples);
    let iPacked = 0;    // index into compressed stream
    let iUnpacked = 0;  // index into output

    while (iPacked < packedLen && iUnpacked < numSamples) {
        // Single trailing value
        if (iPacked + 1 >= packedLen) {
            result[iUnpacked] = compressed[iPacked];
            iPacked++;
            iUnpacked++;
            break;
        }

        if (compressed[iPacked] !== compressed[iPacked + 1]) {
            // Literal sample
            result[iUnpacked] = compressed[iPacked];
            iPacked++;
            iUnpacked++;
        } else {
            // Repeat marker:  v, v, (rep_count − 2)
            if (iPacked + 2 >= packedLen) break;
            const value = compressed[iPacked];
            const repeatCount = Math.round(compressed[iPacked + 2]) + 2;
            iPacked += 3;  // skip value, value, rep‑count
            const end = Math.min(iUnpacked + repeatCount, numSamples);
            while (iUnpacked < end) {
                result[iUnpacked] = value;
                iUnpacked++;
            }
        }
    }

    // Cumulative sum — derivative → original waveform
    let cumSum = 0;
    for (let i = 0; i < numSamples; i++) {
        cumSum += result[i];
        result[i] = cumSum;
    }

    return result;
}
