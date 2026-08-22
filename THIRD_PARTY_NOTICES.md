# Third-Party Notices

## SAFE PNS Prediction

SeqEyes includes a TypeScript implementation of the SAFE peripheral nerve
stimulation prediction model for optional PNS calculations. The implementation
is based on the SAFE model used by Pulseq/SeqEyes PNS tooling.

The SAFE PNS prediction code is distributed under the BSD 3-Clause License.
See `licenses/license_safe_pns`.

PNS values are advisory predictions and are not a clinical, scanner-vendor, or
regulatory safety certification. Users must provide their own valid hardware
ASC profile for the scanner/system being evaluated.

## Gradient Spectrogram

The gradient spectrogram algorithm is derived from pulseq’s
`matlab/+mr/@Sequence/gradSpectrum.m`, revision
`2fd6ab6af5a0cd47b6c15d8e5af09c986eb81007`, from the MIT-licensed
[pulseq/pulseq](https://github.com/pulseq/pulseq) reference implementation.

Retained from upstream: gradient-raster sampling of the physical gradient
waveforms, per-segment DC removal, the Hann window
`0.5*(1-cos(2*pi*(1:nwin)/nwin))`, frequency oversampling by zero-padding
(`os = 3`), the root-sum-of-squares combination across axes, the 3000 Hz
default ceiling, and the forbidden-band semantics `freq ± bw/2`.

Deliberately changed, and documented in `src/pulseq/gradSpectrum.ts`: SeqEyes
keeps the full time × frequency matrix over the visible window instead of
collapsing the time axis to a segment root-mean-square over the whole
sequence; it derives the analysis window from the view rather than fixing it
at 5000 samples; it normalises magnitudes by the window coherent gain; and it
decimates through a Kaiser-windowed-sinc anti-aliasing filter before the FFT.

`computeGradSpectrumParity` reproduces the upstream algorithm exactly and
exists only for the numeric baseline comparison in
`test/gradspectrum_baselines/`. It is not what the viewer displays.

Spectrogram output shows gradient waveform spectral content. It is a
simulation, not an acoustic measurement, and the in-band energy hint is
advisory rather than a compliance assessment: a calibrated acoustic
prediction would need the gradient coil transfer function, which the ASC
profile does not provide.

## Simulated Gradient Sound

The gradient sound synthesis is derived from pulseq’s
`matlab/+mr/@Sequence/Sequence.m::sound()` at the same revision
(`2fd6ab6af5a0cd47b6c15d8e5af09c986eb81007`), with reference to the Python
port in pypulseq pull request #348 (`seq_sound.py`), open at the time of
writing.

Retained: the channel mapping (x left, y right, z split equally), the short
Gaussian smoothing kernel, peak normalisation to 0.95, and the 44.1 kHz
default sample rate.

Two documented deviations, both in `src/pulseq/gradientSound.ts`:

- MATLAB sizes the output buffer from `sum(obj.blockDurations)` — the whole
  sequence — even when `blockRange` restricts the calculation, so a restricted
  range yields a mostly silent buffer; pypulseq inherited this. SeqEyes sizes
  the buffer from the requested window.
- MATLAB’s `gausswin(N)` uses `alpha = 2.5`, giving `std = (N-1)/5`, while
  pypulseq PR #348 uses `std = len/6`. SeqEyes follows MATLAB. The audible
  difference is nil, but the choice is deliberate rather than accidental.

Audio output is simulated. It is not calibrated sound pressure level and
must not be used to judge how loud a scanner will be.

## Acoustic Resonance ASC Parsing

The acoustic resonance key names and their two nesting paths follow
`pypulseq/src/pypulseq/utils/siemens/asc_to_hw.py`, revision
`805c76f9427d536a63bb0a7aa405fa9403e4d08a`, from
[imr-framework/pypulseq](https://github.com/imr-framework/pypulseq),
distributed under the GNU Affero General Public License v3.0. Only the key
names and the zero-frequency filtering rule are taken from it; the
implementation in `src/pulseq/acousticAsc.ts` is original.

Acoustic resonance bands come from a user-supplied scanner ASC profile.
SeqEyes does not redistribute any scanner profile: the ASC fixtures under
`test/asc/` are synthetic, hand-written for tests, and documented as such in
`test/asc/README.md`.
