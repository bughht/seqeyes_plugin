/**
 * Browser entry point — re‑exports the pulseq parser / decoder / k‑space
 * so esbuild can bundle them into a single self‑contained script.
 *
 * Built via:  npx esbuild web/pulseq-browser.ts --bundle --format=iife
 *            --global-name=Pulseq --outfile=web/pulseq-bundle.js
 */
export { parseSequenceText } from '../src/pulseq/reader';
export { decodeAllBlocks } from '../src/pulseq/decoder';
export { calculateKspace } from '../src/pulseq/kspace';
export type { KSpaceData } from '../src/pulseq/kspace';
export type { DecodedBlock, DecodedGradWaveform } from '../src/pulseq/types';
