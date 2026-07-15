# Official Pulseq Binary Fixtures

These paired `.seq` and `.bseq` files are copied from the official
[`pulseq/pulseq`](https://github.com/pulseq/pulseq) repository for parser and
numeric parity tests.

- Upstream commit: `f08614a2567cceb0b9f1e46833b72372c150d2a1`
- Original directory: `tests/legacy/approved/`
- Files: `gre.seq`, `gre.bseq`, `epi_rs.seq`, `epi_rs.bseq`
- Upstream license: MIT

The fixtures are committed so normal SeqEyes CI is deterministic and does not
require network access. The `.bseq` files declare v1.5.2 while their approved
text counterparts declare v1.5.1; the upstream tests pair them for decoded
behavior rather than exact header equality. They test that the official text
and binary encodings produce equivalent decoded waveforms and k-space
trajectories. Binary shapes are stored as `float32`, so waveform and trajectory
comparisons use explicit numeric tolerances rather than byte-for-byte equality.
