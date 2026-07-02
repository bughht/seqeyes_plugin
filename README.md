# SeqEyes Plugin

Visualize [Pulseq](https://github.com/pulseq/pulseq) MRI sequences inside VS Code — inspect RF pulses, gradients, ADC readouts, and triggers with interactive zoom & pan. Inspired by [SeqEyes](https://github.com/xingwangyong/seqeyes).

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=Bughht.seqeyes-plugin)

<img src="images/logo_highres.png" alt="SeqEyes" width="200" />

## Features

- **Custom editor for `.seq` files** — opens automatically on double‑click
- **7 toggle‑able channels**: RF · φ · Gx · Gy · Gz · ADC · Trigger
- **Interactive Canvas**: scroll‑zoom, drag‑pan, hover tooltips
- **K‑space viewer** (right panel): 2D projections & 3D scatter of ADC samples
- **Vertical cursor** with live time readout
- **Unit switchers** for time (s / ms / µs) and gradient (Hz/m / mT/m / G/cm)
- **K‑space unit toggle** (cycles/m ↔ rad/m) with auto‑updating axis ticks
- **Block boundary lines** — toggle in toolbar, default off
- **Dark mode** — auto‑detects VS Code theme
- **Pulseq v1.2.0 – v1.5.1** support

## Install

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Bughht.seqeyes-plugin) or build from source:

```bash
npm install && npm run compile && npx vsce package
code --install-extension seqeyes-plugin-0.0.x.vsix --force
```

Or press **F5** for Extension Development Host.

## Usage

| Action | How |
|--------|-----|
| Open a `.seq` file | Double‑click in Explorer |
| Zoom | Scroll wheel or toolbar `+` / `−` |
| Pan | Click & drag |
| Fit to view | Toolbar `Fit` |
| Toggle channel | Click legend label |
| Toggle block boundaries | Checkbox `☐ Blocks` in toolbar |
| Block details | Hover waveform |
| Time cursor | Move mouse |
| Toggle k‑space panel | Toolbar `K` button |
| Cycle 2D / 3D view | `Prj` button in k‑space panel |
| Rotate (3D) | Left‑drag in k‑space panel |
| Pan (3D) | Right‑drag or middle‑drag |
| Pan (2D) | Left‑drag |
| Zoom k‑space | Scroll wheel |
| Reset k‑space view | `↺` button |
| Toggle k‑space unit | `U` button — cycles/m ↔ rad/m |
| ADC marker size | `Dot` slider in k‑space panel |
| Resize k‑space panel | Drag left edge handle |

## License

MIT
