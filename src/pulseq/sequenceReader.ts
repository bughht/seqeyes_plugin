import { hasPulseqBinaryMagic, parseSequenceBinary } from './binaryReader';
import { parseSequenceText } from './reader';
import type { PulseqSequence } from './types';

/** Parse Pulseq source bytes, dispatching by the official binary magic. */
export function parseSequenceBytes(bytes: Uint8Array, fileName = ''): PulseqSequence {
    if (hasPulseqBinaryMagic(bytes)) return parseSequenceBinary(bytes);
    if (/\.bseq$/i.test(fileName)) {
        throw new Error('Pulseq binary parse error: .bseq file is missing the Pulseq binary header');
    }

    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new Error('Pulseq parse error: sequence text is not valid UTF-8');
    }
    return parseSequenceText(text);
}

export { hasPulseqBinaryMagic, parseSequenceBinary } from './binaryReader';
