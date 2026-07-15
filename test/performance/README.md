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

The Node report includes the official Pulseq `gre` and `epi_rs` `.seq`/`.bseq`
pairs. This makes binary file size and parse timing visible beside the equivalent
text inputs without imposing a brittle speed-ratio threshold on shared CI
runners.
