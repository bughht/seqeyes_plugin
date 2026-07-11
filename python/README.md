# SeqEyes — Interactive Pulseq MRI Sequence Viewer for Python

**SeqEyes** is a lightweight Python package that provides interactive
visualization of Pulseq (.seq) MRI sequences in Jupyter notebooks.
It works as a drop‑in replacement for `pypulseq.Sequence.plot()`,
rendering an interactive viewer directly in Jupyter notebook cell
output — just like Plotly.

## Features

- 🎛️ **Interactive waveform viewer** — zoom, pan, per‑channel amplitude zoom
- 📍 **Tooltip** with block details (RF amplitude, gradient strength, ADC params)
- 🗺️ **3D k‑space trajectory viewer** — rotate, zoom, depth‑sorted rendering
- 🎨 **8 colour themes** — system, light, dark, dracula, nord, and more
- 📏 **Unit conversion** — time (s / ms / µs), gradient (Hz/m / mT/m / G/cm)
- 📐 **Minimap** with TR/TE overlay and viewport indicator
- 💾 **Export to standalone HTML** — shareable, no Python needed
- 🔌 **Drop‑in pypulseq integration** — `seq.plot()` just works

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

## API Reference

| Function | Description |
|---|---|
| `seqeyes.set(**kwargs)` | Enable SeqEyes and set global defaults (`theme`, `show_blocks`, `time_disp`, `grad_disp`, `time_range`) |
| `seqeyes.reset()` | Restore matplotlib `seq.plot()` and clear all defaults |
| `SeqEyesViewer(seq_text, ...)` | Low‑level viewer for raw `.seq` content (no pypulseq needed) |

## Viewer Controls

| Action | How |
|---|---|
| Zoom | Scroll wheel |
| Pan | Click + drag |
| Amplitude zoom (per channel) | Ctrl + scroll wheel |
| Tooltip | Hover over waveform |
| Toggle channels | Click legend labels |
| K‑Space viewer | Click "K‑Space" button |
| Rotate k‑space | Click + drag in panel |
| Minimap navigation | Click on minimap strip |
| Open another file | 📂 Open button |

## Requirements

- Python ≥ 3.9
- numpy ≥ 1.21
- pypulseq ≥ 1.4 (optional, for `seq.plot()` integration)
- pywebview ≥ 5 (optional, for native desktop pop‑up windows)

## License

MIT
