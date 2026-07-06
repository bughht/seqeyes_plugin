# SeqEyes Demo Sequence Fixtures

These `.seq` files are copied from `seqeyes/test/seq_files` for broad plugin
parser/decode/k-space smoke coverage.

They are not exact numeric baselines. Exact `ktraj_adc` comparisons live under
`test/kspace_baselines` and are intentionally limited to clean v1.5 cases.

Legacy v1.4.x files and extension-heavy demos are covered here as safety tests:
they must parse, decode, and calculate finite ADC k-space when ADC samples are
present, but they do not define formal numeric truth for CI.
