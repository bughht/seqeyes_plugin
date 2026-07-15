"""
SeqEyes — Interactive Pulseq MRI Sequence Viewer
=================================================

Drop‑in replacement for ``pypulseq.Sequence.plot()``.

Quick start
-----------
>>> import seqeyes
>>> seqeyes.set(theme="dark")          # enable SeqEyes + set defaults

>>> seq.plot()                          # interactive viewer in Jupyter
>>> seq.plot(show_blocks=True)          # per‑call overrides
>>> seq.plot(time_range=(0, 0.05))     # zoom to first 50 ms

>>> seqeyes.reset()                     # back to matplotlib

In a plain ``.py`` script (no Jupyter):
>>> seq.plot()   # opens the viewer in your default web browser

API
---
- :func:`set` — enable SeqEyes + configure defaults
- :func:`reset` — restore matplotlib
- :class:`SeqEyesViewer` — low‑level viewer
"""

from seqeyes._plot import set, reset
from seqeyes._renderer import SeqEyesViewer

__all__ = ["set", "reset", "SeqEyesViewer"]
__version__ = "0.2.7"
