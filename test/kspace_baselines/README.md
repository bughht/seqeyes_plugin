# K-Space Baselines

These fixtures are SeqEyes Qt trajectory-export baselines for plugin numeric CI.

Current blocking cases are Pulseq v1.5.1 only:

- `v151_gre`
- `v151_spiral`

The v1.5 format carries explicit RF center/use metadata and arbitrary-gradient
edge metadata, so exact `ktraj_adc` parity is a useful CI gate. Older v1.4.x
files need compatibility guesses for missing metadata, so they should remain
parser/k-space smoke or diagnostic cases rather than blocking exact baselines.

Baselines were generated with the SeqEyes application automation
`export_trajectory` action and compare only `ktraj_adc.txt`. The plugin export
path uses the SeqEyes-style `all` gradient support grid for these comparisons;
the interactive viewer may use the faster endpoint-support grid.
