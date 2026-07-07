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
