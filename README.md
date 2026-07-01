# SeqEyes Plugin

Visualize [Pulseq](https://github.com/pulseq/pulseq) MRI sequences inside VS Code — inspect RF pulses, gradients, ADC readouts and triggers with interactive zoom & pan.

Inspired by [SeqEyes](https://github.com/xingwangyong/seqeyes). The parser follows SeqEyes' **single-loader, version-gated** strategy — one robust parser handles all Pulseq versions (v1.2.0 through v1.5.1) with per‑section integer version comparisons.

## Features

### Visualization
- **Custom editor for `.seq` files** — opens automatically on double‑click
- **7 toggle‑able channels**: RF · φ · Gx · Gy · Gz · ADC · Trigger
- **Interactive Canvas**: scroll‑zoom, drag‑pan, hover tooltips with block‑level details
- **Vertical cursor** with live time readout
- **Y‑axis ticks** with physical units (Hz, rad, Hz/m, mT/m, G/cm)
- **Unit switchers** for time (s / ms / µs) and gradient (Hz/m / mT/m / G/cm)
- **Block boundary lines** — optional dotted vertical lines with block‑number labels (toggle in toolbar, default off)
- **Dark mode** — auto‑detects VS Code theme

### Parser (matching SeqEyes PulseqLoader.cpp)
- **Pulseq v1.2.0 – v1.5.1** — single loader with unified `versionCombined` integer gating
- **Pre‑v1.4 backward compatibility** — 7‑field RF, old delay‑ID block format
- **PPM‑based frequency & phase offsets** — effective offsets computed with γ·B₀ (¹H, 42.576 MHz/T)
- **RF `center` field** — effective pulse centre for TE/TI calculations (v1.5+)
- **Extended trapezoid gradients** — non‑uniform time+wave shape pairs with oversampling support
- **Trapezoid decomposition** — 4‑point analytical model matching SeqEyes SeriesBuilder
- **Run‑length shape decompression** — verified against C++ reference implementation
- **All 7 extension types**: Triggers, NCO, Rotations (quaternion in v1.5+), LabelSet, LabelInc, Soft Delays, RF Shims
- **Label decoding** — maps label‑name strings to Mdh_Label enum; unknown labels get dynamic IDs (≥1000)

## Supported Blocks

| Event | Status |
|-------|--------|
| RF (amplitude, phase, freq/PPM offset, delay, centre, use‑flag) | ✅ |
| Trapezoid gradients (amplitude, rise, flat, fall, delay) | ✅ |
| Arbitrary & extended‑trapezoid gradients (shaped, non‑uniform sampling) | ✅ |
| ADC (dwell, delay, freq/PPM offset, phase modulation shape) | ✅ |
| Digital triggers (channel, type, delay, duration) | ✅ |
| NCO (frequency, phase, delay, duration) | ✅ |
| Gradient rotations (3×3 matrix v1.4.x, quaternion v1.5+) | ✅ |
| Label SET / INC (MDH counters & flags) | ✅ |
| Soft delays (hint strings) | ✅ |
| RF shimming (per‑channel amplitude/phase) | ✅ |

## Install

```bash
npm install && npm run compile && npx vsce package
code --install-extension seqeyes-plugin-0.0.1.vsix --force
```

Or press **F5** for Extension Development Host.

## Usage

| Action | Shortcut |
|--------|----------|
| Open `.seq` file | Double‑click in Explorer |
| Zoom | Scroll wheel or toolbar `+` / `−` |
| Pan | Click & drag |
| Fit | Toolbar `Fit` |
| Toggle channel | Click legend label |
| Toggle block boundaries | Checkbox `☐ Blocks` in toolbar |
| Block details | Hover waveform |
| Time cursor | Move mouse |

## Architecture

```
src/
├── extension.ts                  Activation & commands
├── pulseq/
│   ├── types.ts                  Data types + version constants (3‑layer)
│   ├── reader.ts                 .seq parser (v1.2.0 – v1.5.1, version‑gated)
│   ├── decompressor.ts           Run‑length shape decompression
│   └── decoder.ts                Waveform reconstruction (RF phase, PPM,
│                                 gradient decomposition, ext‑trapezoids)
└── editor/
    ├── seqEditorProvider.ts      CustomTextEditorProvider + serialisation
    └── webviewContent.ts         Canvas‑based interactive viewer
```

## Version Strategy

Following SeqEyes' design, a single v1.5.1‑capable loader handles all versions via a combined integer:

| Threshold | Versions | Key differences |
|-----------|----------|----------------|
| `< 1,004,000` | pre‑v1.4 | No timeShape, old delay‑ID block format |
| `< 1,005,000` | v1.4.x | timeShape added |
| `≥ 1,005,000` | v1.5.x | PPM offsets, RF centre, quaternion rotations, first/last gradient amplitudes |
| `≥ 1,005,001` | v1.5.1+ | RequiredExtensions validation |

## License

MIT
