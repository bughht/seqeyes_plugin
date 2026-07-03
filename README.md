# SeqEyes Plugin

Visualize [Pulseq](https://github.com/pulseq/pulseq) MRI sequences inside VS Code — inspect RF pulses, gradients, ADC readouts, and triggers with interactive zoom & pan. Includes a GPU‑accelerated k‑space viewer with camera presets. Inspired by [SeqEyes](https://github.com/xingwangyong/seqeyes).

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=Bughht.seqeyes-plugin)

<img src="images/logo_highres.png" alt="SeqEyes" width="200" />

## Features

- **Custom editor for `.seq` files** — opens automatically on double‑click
- **7 toggle‑able channels**: RF · φ · Gx · Gy · Gz · ADC · Trigger
- **ADC phase curve** on φ axis — continuous $\phi(t) = \phi_0 + 2\pi \cdot f_{offset} \cdot (t - t_0)$
- **K‑space viewer**: WebGL‑accelerated 3D scatter (millions of points @ 60 fps) with camera presets
- **Camera presets** (xy / xz / yz) rotate the 3D view; any drag reverts to free 3D
- **Interactive Canvas**: scroll‑zoom (anchored at cursor), drag‑pan, hover tooltips
- **7 built‑in themes**: One Light · One Dark · Dracula · Nord · GitHub Light · GitHub Dark · System
- **Vertical cursor** with live time readout
- **Unit switchers** for time (s / ms / µs) and gradient (Hz/m / mT/m / G/cm)
- **K‑space unit toggle** (1/m ↔ rad/m) with auto‑updating axis ticks
- **Block boundary lines** — toggle in toolbar
- **Optimized for large files** — binary k‑space encoding, memory‑safe parser
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
| Zoom waveform | Scroll wheel or toolbar `+` / `−` |
| Pan waveform | Click & drag |
| Fit to view | Toolbar `Fit` |
| Toggle channel | Click legend label |
| Toggle block boundaries | Checkbox `☐ Blocks` in toolbar |
| Block details & values | Hover waveform |
| Switch theme | Toolbar `Theme` dropdown |
| Toggle k‑space panel | Toolbar `K‑Space` button |
| Rotate 3D view | Left‑drag in k‑space panel |
| Pan 3D view | Right‑drag or middle‑drag |
| Zoom k‑space (at cursor) | Scroll wheel in k‑space panel |
| Cycle camera preset | `Prj` button — xy → xz → yz → 3D |
| Reset k‑space view | `↺` button |
| Toggle k‑space unit | `U` button — cycles/m ↔ rad/m |
| ADC marker size | `Dot` slider in k‑space panel |
| Resize k‑space panel | Drag left edge handle |

## License

MIT
