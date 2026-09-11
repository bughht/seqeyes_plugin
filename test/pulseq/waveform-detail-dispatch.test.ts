import { describe, expect, it } from 'vitest';

import {
  BAND_DETAIL_SAMPLES,
  countExactDetailSamples,
  EXACT_DETAIL_SAMPLES,
  resolveDetailBlockRange,
} from '../../src/editor/blockTransport';
import { buildWaveformDetailReply } from '../../src/editor/waveformDetailReply';
import { createSequenceDecodeContext, decodeBlockRange, getTotalDuration } from '../../src/pulseq/decoder';
import { loadSequence } from './blockTransportFixtures';

describe('waveform detail dispatch', () => {
  /** A window and its sample count, so each test can assert its own premise. */
  const windowOf = (fixture: string, startSec = 0, endSec?: number) => {
    const sequence = loadSequence(fixture);
    const context = createSequenceDecodeContext(sequence);
    const end = endSec ?? getTotalDuration(sequence);
    const range = resolveDetailBlockRange(context.blockStartTimes, sequence.blocks.length, startSec, end);
    const decoded = decodeBlockRange(sequence, range.start, range.end, context);
    const samples = countExactDetailSamples(decoded, { startSec, endSec: end });
    return { sequence, context, startSec, endSec: end, blocks: range.end - range.start, samples };
  };

  it('bounds the block count for a sample reply', () => {
    // A window small enough in samples to be sent exactly, but spanning more
    // blocks than the ceiling, must be refused: that payload alone carries a
    // per-block envelope bounded by MAX_V8_STRING_LENGTH.
    const w = windowOf('writeGradientEcho.seq', 0, 0.02);
    expect(w.samples).toBeLessThanOrEqual(EXACT_DETAIL_SAMPLES);
    expect(w.blocks).toBeGreaterThan(1);
    const reply = buildWaveformDetailReply(
      w.sequence, w.context, { startSec: w.startSec, endSec: w.endSec, columns: 900 },
      0, undefined, w.blocks - 1,
    );
    expect(reply.kind).toBe('error');

    // The same window inside the ceiling is sent exactly.
    const ok = buildWaveformDetailReply(
      w.sequence, w.context, { startSec: w.startSec, endSec: w.endSec, columns: 900 },
      0, undefined, w.blocks,
    );
    expect(ok.kind).toBe('samples');
  });

  it('still chooses a band when the block count is over the ceiling', () => {
    // The regression. A band is columns * 6 floats however many blocks it
    // summarises, so the block ceiling must not pre-empt the regime choice —
    // it used to, and refused windows the other lane happily banded.
    const w = windowOf('writeSpiral.seq');
    expect(w.samples).toBeGreaterThan(EXACT_DETAIL_SAMPLES);
    expect(w.samples).toBeLessThanOrEqual(BAND_DETAIL_SAMPLES);
    const reply = buildWaveformDetailReply(
      w.sequence, w.context, { startSec: 0, endSec: w.endSec, columns: 900 },
      0, undefined, Math.max(1, w.blocks - 1),
    );
    expect(reply.kind).toBe('band');
  });

  it('refuses an empty window before reaching a regime', () => {
    const w = windowOf('writeEpiRS.seq');
    const reply = buildWaveformDetailReply(
      w.sequence, w.context, { startSec: 1, endSec: 1, columns: 100 }, 0,
    );
    expect(reply.kind).toBe('error');
  });
});
