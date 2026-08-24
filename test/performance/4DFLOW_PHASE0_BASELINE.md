# 4D-Flow Phase 0 Load Baseline

Date: 2026-08-23. Status: reporting-first Node baseline complete; browser first-paint and the
generated regression derivative remain open.

## Scope and safety

This baseline measures the paired local `4Dflow_3dradial_brain_iso1.seq` and `.bseq` files through
three explicit stopping points in fresh Node processes:

1. `parse`: acquisition, SHA-256, parser/shape expansion, timing detection, and duration;
2. `decode`: parse plus `decodeAllBlocks()` and allocation-free k-space estimation; and
3. `display`: decode plus the VS Code `packBlocks()` display transport.

No run calculated k-space, opened a browser, or loaded the prohibited `wave_test.bseq`. Each child
used a 4 GiB V8 old-space ceiling and a ten-minute timeout. The source files and JSON reports remain
outside the repository.

The `.bseq` was previously produced from this `.seq` by the attributed large-file Python conversion
path documented in the workspace `bseq/benchmarking/README.md`. The text input reports Pulseq 1.4.2;
the converter writes the official 1.5.2 binary layout. Treat the pair as intended-semantic parity,
not byte or version identity.

## Fixture identity

| Format | Bytes | SHA-256 |
|---|---:|---|
| `.seq` | 480,960,678 | `a227364ae814a98a614ccfc8008f94ff58d5ccde714216223abb6aeda98e5510` |
| `.bseq` | 176,198,996 | `31f66ea57746bb86e3548a1e01ab770d7b170eb040d630babef78d552b7f4da1` |

Both parsers reported the same structural workload:

- 512,768 blocks;
- 24 RF, 179,648 arbitrary-gradient, 87,507 trapezoid, and 24 ADC library events;
- 179,651 shapes containing 36,110,649 expanded samples; and
- 16,408,576 ADC samples across block references.

Both decoders produced 158,445,312 waveform samples: 76,915,200 RF, 27,048,512 Gx,
27,048,512 Gy, and 27,433,088 Gz samples.

## Environment

- SeqEyes Plugin base revision: `91a9213635f6651e7c91995641b1303b837275be` (`v0.3.0`).
- Working branch: `perf/large-sequence-phase0` with the stage profiler added.
- Node `v26.7.0`, macOS Darwin `24.6.0`, arm64.
- Apple M3 Pro, 11 logical CPUs, 18 GiB physical memory.
- One reporting run per file and stopping point. Timings and RSS are diagnostic, not regression
  thresholds.

## Results

| Format / stopping point | Parser | Full decode | Display pack | Peak RSS | RSS after forced GC |
|---|---:|---:|---:|---:|---:|
| `.seq` parse | 3.91 s | — | — | 1.35 GiB | 1.34 GiB |
| `.bseq` parse | 0.50 s | — | — | 0.91 GiB | 0.91 GiB |
| `.seq` decode | 3.85 s | 15.36 s | — | 3.03 GiB | 2.60 GiB |
| `.bseq` decode | 0.53 s | 14.85 s | — | 4.82 GiB | 3.00 GiB |
| `.seq` display | 3.79 s | 13.61 s | 12.83 s | 4.34 GiB | 3.18 GiB |
| `.bseq` display | 0.49 s | 14.44 s | 10.58 s | 4.91 GiB | 4.12 GiB |

The single-run `.bseq` decode/display RSS is not evidence that the format intrinsically requires
more memory. Source buffers, garbage-collection timing, external typed arrays, and allocator state
affect peak RSS. Fresh-process repetitions and isolated phase ownership are required before making
a format-memory claim.

`packBlocks()` reduced the sequence to 16 points per waveform event and still produced:

- 11,879,550 aligned display samples;
- a 95,036,400-byte time buffer and 47,518,200-byte value buffer; and
- an estimated 255.6 MiB scalar JSON block envelope.

The allocation-free k-space estimator reported 69,480,065 raster samples, 16,408,576 ADC samples,
88,837,059 grid candidates, and a conservative 12,793,561,960-byte (11.91 GiB) peak. All three
sample counts exceed the current interactive gates, so this workload must not start automatic
k-space.

## Findings and next gate

1. Both files parse and decode successfully. The large-load failure is downstream resource
   architecture, not an inability to parse or decode the formats.
2. `.bseq` substantially reduces acquisition and parser time, but full decode remains about
   15 seconds because both formats enter the same eager object/waveform pipeline.
3. The `v0.2.13` binary transport avoids a giant waveform JSON string, but its initial all-block
   packing remains sequence-scale in CPU and memory. The scalar block envelope is also material.
4. Browser first-paint on the full pair is not the next safe experiment: a renderer would inherit
   multi-GiB decoded/display state before considering canvas/GPU allocations.
5. The next implementation target is the Qt-inspired indexed, overview-first viewport contract:
   publish a bounded overview and initial window without `decodeAllBlocks()` or an all-block display
   payload. K-space remains lazy and independently gated.
6. Before browser regression work, generate and document a smaller structure-preserving 4D-flow
   derivative. Its generator must preserve repeated-block/event-library pressure, arbitrary-gradient
   density, RF/ADC timing, and the `.seq`/`.bseq` intended-semantic relationship.

## Reproduction

Build the profiler, then run each boundary in fresh processes:

```sh
npm run compile

node scripts/run-load-profile.mjs \
  --input ../demo_files/4Dflow_3dradial_brain_iso1.seq \
  --input ../demo_files/4Dflow_3dradial_brain_iso1.bseq \
  --stages parse \
  --output performance-results/4dflow-parse.json \
  --timeout-ms 600000 \
  --max-old-space-mib 4096
```

Repeat with `--stages decode` and then `--stages display`. Do not combine the stages into one child
when measuring phase boundaries; the supervisor intentionally starts a fresh process for every
file/stage pair.
