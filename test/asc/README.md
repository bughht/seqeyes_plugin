# ASC Fixtures

Siemens ASC profiles used by the PNS and acoustic-resonance tests.

## Provenance

**Every file here is synthetic.** None is derived from, or redistributed from,
a real scanner profile. Real ASC files are scanner-vendor configuration data
and are not ours to vendor — this follows the "document fixture provenance
before committing redistributed samples" rule in `plans/FUTURE_WORK.md`.

The values are hand-written to exercise the parser's structure, not to describe
any real gradient system. They are not usable for prediction and must never be
presented as scanner data.

| File | Purpose | Contains |
|---|---|---|
| `synthetic_combined.asc` | The happy path after the button rename | PNS coefficients **and** acoustic resonances |
| `synthetic_acoustic_only.asc` | Partial success: acoustic without PNS | Acoustic resonances only, nested key spelling |
| `synthetic_pns_only.asc` | Partial success: PNS without acoustic | PNS coefficients only |

## Key spellings

`synthetic_combined.asc` uses the top-level spelling
(`aflGCAcousticResonanceFrequency[i]`); `synthetic_acoustic_only.asc` uses the
nested one (`asGPAParameters[0].sGCParameters.aflAcousticResonanceFrequency[i]`).
Both are documented in pypulseq's `asc_to_hw.py` and both occur in the wild
depending on scanner generation, so both are covered.

`synthetic_combined.asc` also carries a `.CarNS.` variant of the PNS keys, which
must be ignored: it is a different subsystem's table that would otherwise be
picked up by suffix matching.

## Units

Frequencies and bandwidths are in Hz. A band spans `freq ± bw/2`, matching
`gradSpectrum.m`. Entries with `freq <= 0` are padding that the reader drops,
and `synthetic_combined.asc` includes one so that behaviour stays covered.
