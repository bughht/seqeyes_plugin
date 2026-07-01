# SeqEyes Plugin — Pulseq Sequence Viewer for VS Code

Visualize [Pulseq](https://github.com/pulseq/pulseq) MRI sequences directly inside
VS Code. Inspect RF pulses, gradient waveforms, ADC readouts, and digital triggers
with interactive zoom, pan, and per-channel toggles.

Inspired by [SeqEyes](https://github.com/xingwangyong/seqeyes) by Xingwang Yong.

## Features

- **Custom editor for `.seq` files** — opens automatically; no external tools needed
- **7 visualization channels**: RF magnitude, RF phase (φ), Gx, Gy, Gz, ADC, Triggers
- **Interactive Canvas rendering**: scroll to zoom, drag to pan, hover for tooltip
- **Vertical cursor** with live time readout
- **Per-channel toggles** — click legend items to show/hide channels
- **Y-axis ticks** with physical units (Hz, rad, Hz/m)
- **Dark mode** — auto-detects VS Code theme
- **Pulseq version support**: v1.4.1, v1.4.2, v1.5.0, v1.5.1
- **Shape decompression** — full run-length decoding of compressed RF/gradient shapes
- **RF phase computation** with frequency offset modulation

## Supported Pulseq Blocks

| Block Type | Visualized |
|-----------|-----------|
| RF pulses (amplitude, phase, frequency offset, delay) | ✅ |
| Trapezoid gradients (amplitude, rise, flat, fall, delay) | ✅ |
| Arbitrary gradients (shape, time shape, first/last) | ✅ |
| ADC readout (samples, dwell, delay, phase offset) | ✅ |
| Digital triggers (channel, delay, duration) | ✅ |
| NCO (numerically controlled oscillator) | ⬜ planned |

## Requirements

- VS Code ≥ 1.85.0

## Installation

### From VSIX (local)

```bash
npm install
npm run compile
npx vsce package
code --install-extension seqeyes-plugin-0.0.1.vsix --force
```

### Development (F5)

```bash
npm install
# Press F5 in VS Code to launch Extension Development Host
```

## Usage

1. Open any `.seq` file in VS Code — the SeqEyes Viewer opens automatically
2. Or right-click a `.seq` file → **SeqEyes: Open Sequence Viewer**
3. Or run **Ctrl+Shift+P** → `SeqEyes: Hello World`

### Controls

| Action | How |
|--------|-----|
| Zoom in/out | Scroll wheel or toolbar `+`/`−` buttons |
| Pan | Click and drag |
| Fit to window | Toolbar `Fit` button |
| Toggle channel | Click legend items (RF, φ, Gx, Gy, Gz, ADC, Trig) |
| View block details | Hover over any waveform |
| Time cursor | Move mouse — red dashed line with time readout |

## Project Structure

```
seqeyes-plugin/
├── src/
│   ├── extension.ts              # Activation, commands, status bar
│   ├── pulseq/
│   │   ├── types.ts              # TypeScript interfaces for Pulseq data
│   │   ├── reader.ts             # Text-based .seq file parser
│   │   ├── decompressor.ts       # Run-length shape decompression
│   │   └── decoder.ts            # Waveform reconstruction per block
│   └── editor/
│       ├── seqEditorProvider.ts  # CustomTextEditorProvider
│       └── webviewContent.ts     # Canvas-based visualization HTML/JS
├── test/seq/                     # Test .seq files (v1.4.1, v1.4.2, v1.5.1)
├── package.json
├── tsconfig.json
└── PLAN.md                       # Development roadmap
```

## Test Sequences

Test files are in `test/seq/`:

| File | Version | Description |
|------|---------|-------------|
| `spi_1shot_noSMS_CimaX.seq` | v1.4.1 | SPI sequence, 8400 blocks, 84 slices |
| `fs_se_dti_spiral_vds_...seq` | v1.4.2 | DTI with spiral readout, 819 blocks |
| `rosette_mrf_demo.seq` | v1.5.1 | MRF with rosette trajectory, 3814 blocks |
| `spiral_mrf_demo.seq` | v1.5.1 | MRF with spiral trajectory, 5566 blocks |

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgments

- [Pulseq](https://github.com/pulseq/pulseq) — open file format for MR sequences
- [SeqEyes](https://github.com/xingwangyong/seqeyes) — the original Qt/C++ sequence viewer
