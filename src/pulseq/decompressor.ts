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
 * @returns           Shape samples reconstructed from the derivative stream.
 * @throws            Error when the packed stream is malformed.
 */
export function decompressShape(
    compressed: Float64Array | number[],
    numSamples: number,
): Float64Array {
    const packedLen = compressed.length;
    if (!Number.isInteger(numSamples) || numSamples <= 0) {
        throw new Error(`Invalid shape sample count: ${numSamples}`);
    }

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
            if (iPacked + 2 >= packedLen) {
                throw new Error('Malformed compressed shape: repeat marker is missing its count');
            }
            const value = compressed[iPacked];
            const rawRepeat = compressed[iPacked + 2];
            const repeatCount = Math.round(rawRepeat) + 2;
            if (Math.abs(rawRepeat + 2 - repeatCount) > 1e-6 || repeatCount < 2) {
                throw new Error(`Malformed compressed shape: invalid repeat count ${rawRepeat}`);
            }
            if (iUnpacked + repeatCount > numSamples) {
                throw new Error('Malformed compressed shape: repeat block exceeds expected sample count');
            }
            iPacked += 3;  // skip value, value, rep‑count
            const end = iUnpacked + repeatCount;
            while (iUnpacked < end) {
                result[iUnpacked] = value;
                iUnpacked++;
            }
        }
    }
    if (iUnpacked !== numSamples) {
        throw new Error(`Malformed compressed shape: expected ${numSamples} samples, decoded ${iUnpacked}`);
    }

    // Cumulative sum — derivative → original waveform
    let cumSum = 0;
    for (let i = 0; i < numSamples; i++) {
        cumSum += result[i];
        result[i] = cumSum;
    }

    return result;
}
