# Gradient Spectrum Baselines

Numeric baselines comparing `computeGradSpectrumParity` against pulseq's MATLAB
`mr.Sequence.gradSpectrum`.

## What this checks, and what it does not

`computeGradSpectrumParity` (`src/pulseq/gradSpectrum.ts`) is **not what the
SeqEyes panel shows.** It exists only for this comparison. It reproduces
upstream exactly: the whole sequence, `nwin = 5000`, 50 % stagger, `os = 3`, no
decimation, no coherent-gain normalisation, and root-mean-square over every
segment.

The panel deliberately does none of that — it keeps the full time × frequency
matrix over the *visible window*, decimates with an anti-aliasing filter first,
and normalises by the window's coherent gain. Averaging over every segment is
the step the feature exists to avoid: dummy scans, preparation blocks and long
quiet stretches dilute the mean, so a sequence with a genuine resonance
excitation inside one TR can be made to look compliant by padding it.

Keeping the parity path lets the shared plumbing underneath both — the physical
(rotated) gradient resampling, the FFT, and the Hann window — be validated
against a reference implementation.

## Status

**The baseline `.txt` files are not yet generated.** `cases.json` lists the
three cases and their fixtures; `test/pulseq/gradspectrum-baseline.test.ts`
verifies the fixtures and the parity implementation's internal invariants on
every run, and compares against MATLAB numbers only for cases whose baseline
file exists. Cases without one are reported as skipped, with this file named in
the message.

Generating them needs a MATLAB installation with the pulseq toolbox on the
path, which CI does not have.

## Generating a baseline

1. Check out pulseq at the pinned revision:

   ```
   git clone https://github.com/pulseq/pulseq
   cd pulseq && git checkout 2fd6ab6af5a0cd47b6c15d8e5af09c986eb81007
   ```

2. From this directory, with `pulseq/matlab` on the MATLAB path:

   ```matlab
   generate_gradspectrum_baseline('v151_gre/seq/writeGradientEcho.seq', ...
                                  'v151_gre/baseline/gradspectrum.txt')
   ```

   `generate_gradspectrum_baseline.m` sits beside this README. It calls
   `seq.gradSpectrum([], 3000, false)` and writes the columns
   `F, Rx, Ry, Rz, R` as whitespace-separated text, one row per frequency bin.

3. Record the exact revisions in `cases.json` — add `pulseqRevision` and
   `matlabVersion` to the case you generated, as `test/kspace_baselines`
   already does — and add the baseline's SHA-256 as `baselineSha256`.

4. Note the licence and revision in `THIRD_PARTY_NOTICES.md` if they are not
   already recorded there.

## File format

```
# F  Rx  Ry  Rz  R
0.000000e+00  1.234e+03  ...
```

Lines beginning with `#` are ignored. Values are in the units
`gradSpectrum.m` reports them in (Hz/m, unnormalised FFT magnitude), so the
comparison is on the parity path's own scale rather than the panel's mT/m.

## Fixture provenance

| Case | Fixture | Source |
|---|---|---|
| `v151_gre` | `writeGradientEcho.seq` | Copied from `test/kspace_baselines/v151_gre/` |
| `v151_spiral` | `writeSpiral.seq` | Copied from `test/kspace_baselines/v151_spiral/` |
| `v151_epi_rs` | `writeEpiRS.seq` | Copied from `test/seqeyes_demo_seq_files/` |

All three are official Pulseq v1.5.1 demo outputs already vendored elsewhere in
this repository; they are duplicated here so a baseline case is self-contained.
Fixture hashes in `cases.json` are taken over LF-normalised text, so they hold
on a Windows checkout with `core.autocrlf=true`.
