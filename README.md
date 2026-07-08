# SeqEyes Online — Pulseq MRI Sequence Viewer

**Visualize [Pulseq](https://github.com/pulseq/pulseq) MRI sequences — in your browser, MATLAB, or VS Code.** Inspect RF pulses, gradients, ADC readouts, and triggers with interactive zoom & pan. Includes a GPU‑accelerated 3D k‑space viewer with camera presets. Inspired by [SeqEyes](https://github.com/xingwangyong/seqeyes).

<p align="center">
  <a href="https://bughht.github.io/seqeyes_plugin/"><strong>🌐 Try it Online — No Install Required</strong></a>
</p>

<p align="center">
  <img src="images/logo_highres.png" alt="SeqEyes" width="180" />
</p>

<p align="center">
  <a href="https://bughht.github.io/seqeyes_plugin/"><img src="https://img.shields.io/badge/🌐-Open%20in%20Browser-blue?logo=googlechrome&logoColor=white" alt="Web App"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=SeqEyesDeveloper.seqeyes-web"><img src="https://img.shields.io/badge/VS%20Code-Marketplace-blue?logo=visualstudiocode" alt="VS Code Marketplace"></a>
  <a href="https://github.com/bughht/seqeyes_plugin/blob/main/LICENSE.txt"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"></a>
</p>

## 🌐 Web Version — Try It Now!

**[→ bughht.github.io/seqeyes_plugin](https://bughht.github.io/seqeyes_plugin/)**

No download, no extension, no setup. Just drag & drop a `.seq` file and explore:

- **Drag & drop** a `.seq` file onto the page (or click **📂 Open**)
- **All the same features** as the VS Code extension — sequence channels, optional M1/PNS, k‑space viewer, 6 themes, tooltips
- **GPU‑accelerated** 3D k‑space rendered in your browser via WebGL
- **Zero‑dependency parsing** — the Pulseq engine runs entirely in the browser
- **Works offline** — no server calls, your data stays local

## VS Code Extension

Deep integration with VS Code — `.seq` files open automatically in the custom editor.

### Install

From the [Marketplace](https://marketplace.visualstudio.com/items?itemName=SeqEyesDeveloper.seqeyes-web):

```
code --install-extension SeqEyesDeveloper.seqeyes-web
```

Or build from source:

```bash
git clone https://github.com/bughht/seqeyes_plugin.git
cd seqeyes_plugin
npm install
npm run package
code --install-extension seqeyes-web-*.vsix --force
```

Or press **F5** to launch Extension Development Host.

## 🧪 MATLAB Toolbox

Open `.seq` files directly inside MATLAB — double‑click in the Current Folder browser or call `seqeyes()`.

### Install

Download `seqeyes-*.mltbx` from [GitHub Releases](https://github.com/bughht/seqeyes_plugin/releases) and double‑click to install, or run:

```matlab
matlab.addons.toolbox.installToolbox('seqeyes-0.1.7.mltbx')
```

### Usage

```matlab
seqeyes('spiral_inout.seq')   % open a sequence
open('spiral_inout.seq')      % or double‑click in Current Folder
```

All the same features as the browser & VS Code versions — 7 channels, k‑space viewer, themes, tooltips — rendered inside a native MATLAB figure. Requires R2022a+.

## Features

- **Custom editor for `.seq` files** — opens automatically on double‑click
- **📂 Open button** — switch between sequences without closing the editor
- **7 primary channels**: RF · φ · Gx · Gy · Gz · ADC · Trigger
- **Optional M1 channels**: calculate M1x, M1y, and M1z on demand
- **Optional SAFE PNS prediction**: load a user-provided Siemens ASC profile to display PNS X/Y/Z/Norm
- **ADC phase curve** on φ axis — continuous $\phi(t) = \phi_0 + 2\pi \cdot f_{offset} \cdot (t - t_0)$
- **K‑space viewer**: WebGL‑accelerated 3D scatter (millions of points @ 60 fps) with camera presets
- **Camera presets** (xy / xz / yz) rotate the 3D view; any drag reverts to free 3D
- **Interactive Canvas**: cursor‑anchored time zoom, per‑row y‑axis zoom, drag‑pan, hover tooltips
- **6 built‑in themes**: One Light · One Dark · Dracula · Nord · GitHub Light · GitHub Dark (+ system auto)
- **Vertical cursor** with live time readout
- **Unit switchers** for time (s / ms / µs) and gradient (Hz/m / mT/m / G/cm)
- **K‑space unit toggle** (1/m ↔ rad/m) with auto‑updating axis ticks
- **Block boundary lines** — toggle in toolbar
- **Optimized for large files** — binary k‑space encoding, memory‑safe parser
- **Pulseq v1.2.0 – v1.5.1** support

## Usage

| Action | How |
|--------|-----|
| Open a `.seq` file | Double‑click in Explorer, or click **📂 Open** in toolbar |
| Switch to another sequence | **📂 Open** button (top‑left) |
| Zoom waveform | Scroll wheel or toolbar `+` / `−` |
| Zoom waveform y‑axis | `Ctrl` + scroll wheel over a waveform row |
| Fine wheel zoom | Hold `Alt` while scrolling; `Ctrl` + `Alt` + scroll gives finer y‑axis zoom where supported by the browser/OS |
| Pan waveform | Click & drag |
| Fit to view | Toolbar `Fit` |
| Toggle channel | Click legend label |
| Calculate M1 | Toolbar `M1` button |
| Calculate PNS | Toolbar `PNS ASC` button, then select a valid scanner ASC profile |
| Toggle block boundaries | Checkbox `☐ Blocks` in toolbar |
| Block details & values | Hover waveform |
| Switch theme | Toolbar `Theme` dropdown |
| Toggle k‑space panel | Toolbar `K‑Space` button |
| Rotate 3D view | Left‑drag in k‑space panel |
| Pan 3D view | Right‑drag or middle‑drag |
| Zoom k‑space (at cursor) | Scroll wheel in k‑space panel |
| Cycle camera preset | `Prj` button — xy → xz → yz → 3D |
| Reset k‑space view | `↺` button |
| Toggle k‑space unit | `Unit` button — 1/m ↔ rad/m |
| ADC marker size | `Size` slider in k‑space panel |
| Resize k‑space panel | Drag left edge handle |

## License

MIT © [Bughht](https://github.com/bughht)

SAFE PNS prediction components are distributed under the BSD 3-Clause License.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). PNS output is an advisory
prediction, not a clinical, scanner-vendor, or regulatory safety certification.
