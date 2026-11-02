# SeqEyes — Interactive Pulseq MRI Sequence Viewer for Python

**SeqEyes** is a lightweight Python package that provides interactive
visualization of Pulseq text (`.seq`) and binary (`.bseq`) MRI sequences in Jupyter notebooks.
It works as a drop‑in replacement for `pypulseq.Sequence.plot()`,
rendering an interactive viewer directly in Jupyter notebook cell
output — just like Plotly.

The output is the [SeqEyes web app](https://bughht.github.io/seqeyes_plugin/)'s
own viewer, so it has the same features and fixes as the web app, VS Code and
MATLAB.

## Features

- 🎛️ **Interactive waveform viewer** — zoom, pan, per‑channel amplitude zoom, reorderable rows
- 📍 **Tooltip** with block details (RF amplitude, gradient strength, ADC params)
- 📏 **Measurement markers** — snap to waveform events, read values and Δt
- 🗺️ **3D k‑space trajectory viewer** — rotate, pan, zoom at the cursor
- 🔊 **Gradient spectrogram and sound** for the visible window
- 🧲 **PNS and acoustic resonances** from a Siemens ASC profile
- 🎨 **Themes** — system, One Light, One Dark, Dracula, Nord, GitHub Light, GitHub Dark
- 📏 **Unit conversion** — time (s / ms / µs), gradient (Hz/m / mT/m / G/cm)
- 📐 **Minimap** with TR/TE overlay and viewport indicator
- 💾 **Export to standalone HTML** — shareable, no Python needed
- 🔌 **Drop‑in pypulseq integration** — `seq.plot()` just works

In notebook output the viewer shows the sequence its cell passed in, so it has
no Open button or drag & drop, and the Bloch simulation is not available there.
The output frame cannot store anything, so settings changed in it are not
remembered; pass them to `seq.plot()` or `seqeyes.set()` instead. Each output
carries the whole viewer, about 1.3 MB plus the sequence.

## Installation

```bash
pip install seqeyes-python
```

For pypulseq integration:
```bash
pip install seqeyes-python[pypulseq]
```

## Quick Start

```python
import seqeyes

# Enable SeqEyes (once per session) — seq.plot() is now interactive
seqeyes.set(theme="dark", time_disp="ms")

# Build your sequence with pypulseq as usual
seq.plot()                          # interactive viewer in Jupyter
seq.plot(show_blocks=True)          # per‑call overrides
seq.plot(time_range=(0, 0.05))      # zoom to first 50 ms

# Restore matplotlib at any time
seqeyes.reset()
```

In a plain `.py` script (no Jupyter), `seq.plot()` opens the viewer
in a desktop pop‑up window (requires `pywebview`) or falls back to
your default browser.

### Using without pypulseq

```python
from seqeyes import SeqEyesViewer

with open('my_sequence.seq') as f:
    viewer = SeqEyesViewer(f.read(), theme="dark")

viewer  # renders inline in Jupyter
```

Open either supported file format directly:

```python
from seqeyes import SeqEyesViewer

SeqEyesViewer.from_file("my_sequence.seq", theme="dark")
SeqEyesViewer.from_file("my_sequence.bseq", theme="dark")
```

## API Reference

| Function | Description |
|---|---|
| `seqeyes.set(**kwargs)` | Enable SeqEyes and set global defaults (`theme`, `show_blocks`, `time_disp`, `grad_disp`, `time_range`) |
| `seqeyes.reset()` | Restore matplotlib `seq.plot()` and clear all defaults |
| `SeqEyesViewer(source, ...)` | Low-level viewer for raw `.seq` text or `.bseq` bytes |
| `SeqEyesViewer.from_file(path, ...)` | Open a local `.seq` or `.bseq` file without pypulseq |
| `viewer.to_html()` | The viewer as one self-contained HTML page |
| `viewer.to_html(inject_bundle=False)` | The same page referencing `styles.css`, `pulseq-bundle.js` and `webview-bundle.js` by relative URL, to serve next to copies of those files |

| Option | Values |
|---|---|
| `theme` | `"system"`, `"light"` (GitHub Light), `"dark"` (GitHub Dark), `"onelight"`, `"onedark"`, `"dracula"`, `"nord"`, `"githublight"`, `"github"` |
| `time_disp` | `"s"` (default), `"ms"`, `"us"` |
| `grad_disp` | `"mT/m"` (default), `"Hz/m"`, `"G/cm"` |
| `show_blocks` | show block boundaries |
| `time_range` | initial view `(start, end)` in seconds; the default `(0, inf)` keeps the viewer's first view (the first TR, when one is detected); an infinite end runs to the end of the sequence |

## Viewer Controls

| Action | How |
|---|---|
| Zoom | Scroll wheel |
| Pan | Click + drag |
| Amplitude zoom (per channel) | Ctrl + scroll wheel |
| Tooltip | Hover over waveform |
| Toggle channels | Click legend labels |
| Reorder rows | Drag a channel's name, or right-click it |
| Measurement markers | Right-click the waveform → **Add marker** |
| K‑space, then spectrogram | The **K‑Space / Spectrum** toolbar button cycles the analysis panel |
| Rotate k‑space | Click + drag in panel |
| Minimap navigation | Click on minimap strip |
| PNS and acoustic bands | **Load ASC (PNS/Acoustic)** |

## Requirements

- Python ≥ 3.9
- numpy ≥ 1.21
- pypulseq ≥ 1.4 (optional, for `seq.plot()` integration)
- pywebview ≥ 5 (optional, for native desktop pop‑up windows)

## License

MIT
