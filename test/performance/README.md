# Performance Guards

Stage 4 performance guards are reporting-first. They write JSON artifacts under
`performance-results/` and use broad sanity caps to catch non-completion or
obvious regressions without making noisy runner timing a hard release blocker.

Run locally:

```sh
npm run perf:node
npm run perf:browser
```

`perf:browser` requires Playwright's Chromium browser to be installed:

```sh
npx playwright install chromium
```

Artifacts:

- `performance-results/performance-node.json`
- `performance-results/performance-browser.json`

The normal `npm run check` gate does not run these performance guards.

## Fresh-process large-load profiler

Use the stage-bounded profiler before attempting to open an uncharacterized
large sequence in a browser or VS Code:

```sh
npm run profile:load -- \
  --input /path/to/case.seq \
  --input /path/to/case.bseq \
  --stages parse,decode,display,bounded-display \
  --output performance-results/load-profile.json
```

Each file/stage combination runs in a new Node process with a default 4 GiB V8
heap ceiling and ten-minute timeout. `parse` stops after parsing and timing
detection; `decode` additionally materializes all decoded blocks and records a
non-allocating k-space estimate; `display` additionally packs the bounded VS
Code waveform transport. `bounded-display` exercises the current initial-load
path: it estimates k-space from parsed references and decodes/packs fixed-size
batches without retaining the full decoded sequence. It never calculates
k-space or starts a browser.

The supervisor records clean completion, parser errors, process exits, signals,
and timeouts. Child reports include SHA-256, semantic counts, phase timings,
memory after each phase, peak RSS, and an optional forced-GC snapshot. Results
remain reporting-first under the ignored `performance-results/` directory.

The Node report includes the official Pulseq `gre` and `epi_rs` `.seq`/`.bseq`
pairs. This makes binary file size and parse timing visible beside the equivalent
text inputs without imposing a brittle speed-ratio threshold on shared CI
runners.
