"""
_plot.py — SeqEyes plotting API.

Call ``seqeyes.set()`` to switch ``seq.plot()`` to the interactive
SeqEyes viewer.  Call ``seqeyes.reset()`` to restore matplotlib.

In Jupyter the viewer renders inline.  In a ``.py`` script it opens
a native desktop pop‑up window (requires ``pywebview``:  ``pip install pywebview``).
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any, Optional, Tuple, Union


# ── Module state ──────────────────────────────────────────────────────────

_defaults: dict[str, Any] = {}
_original_plot = None
_patched = False


# ── Public API ────────────────────────────────────────────────────────────

def set(
    *,
    theme: Optional[str] = None,
    show_blocks: Optional[bool] = None,
    time_disp: Optional[str] = None,
    grad_disp: Optional[str] = None,
    time_range: Optional[Tuple[float, float]] = None,
) -> None:
    """Enable SeqEyes for all ``seq.plot()`` calls and set global defaults.

    Call this once at the top of your notebook / script — with or
    without arguments.  Any keywords become defaults applied to every
    subsequent ``seq.plot()`` (overridable per‑call).

    >>> seqeyes.set()                             # enable, system defaults
    >>> seqeyes.set(theme="dark", time_disp="ms") # enable + defaults
    >>> seq.plot()                                 # uses dark + ms
    >>> seq.plot(theme="light")                    # overrides theme only
    """
    _store_defaults(theme, show_blocks, time_disp, grad_disp, time_range)
    _ensure_patched()


def reset() -> None:
    """Restore matplotlib ``seq.plot()`` and clear all SeqEyes defaults.

    Call ``seqeyes.set()`` again to re‑enable at any time.
    """
    global _patched
    _defaults.clear()
    _patched = False

    try:
        from pypulseq import Sequence as _Seq
    except ImportError:
        return

    if _original_plot is not None:
        _Seq.plot = _original_plot  # type: ignore[attr-defined]


# ── Internal helpers ──────────────────────────────────────────────────────

def _store_defaults(
    theme: Optional[str],
    show_blocks: Optional[bool],
    time_disp: Optional[str],
    grad_disp: Optional[str],
    time_range: Optional[Tuple[float, float]],
) -> None:
    for name, val in [
        ("theme", theme),
        ("show_blocks", show_blocks),
        ("time_disp", time_disp),
        ("grad_disp", grad_disp),
        ("time_range", time_range),
    ]:
        if val is not None:
            _defaults[name] = val


def _ensure_patched() -> None:
    global _patched, _original_plot

    if _patched:
        return
    _patched = True

    try:
        from pypulseq import Sequence as _Seq
    except ImportError:
        raise ImportError("pypulseq is not installed.  Install with: pip install pypulseq")

    if _original_plot is None:
        _original_plot = getattr(_Seq, "plot", None)

    # ── Replacement .plot() ──────────────────────────────────────────
    def _seqeyes_plot(
        self: object,
        label: str = "",
        show_blocks: bool = False,
        time_range: Any = (0, float("inf")),
        time_disp: str = "s",
        grad_disp: str = "kHz/m",
        **kwargs: Any,
    ) -> None:
        # Merge globals — per‑call args take precedence
        sb = _defaults.get("show_blocks", show_blocks)
        td = _defaults.get("time_disp", time_disp)
        gd = _defaults.get("grad_disp", grad_disp)
        tr = _defaults.get("time_range", time_range)
        th = str(kwargs.pop("theme", _defaults.get("theme", "system")))

        seq_text = _seq_to_text(self)
        if not seq_text:
            raise RuntimeError("Could not write .seq text from the pypulseq Sequence.")

        from seqeyes._renderer import SeqEyesViewer

        viewer = SeqEyesViewer(
            seq_text, label=label, show_blocks=sb,
            time_range=tr, time_disp=td, grad_disp=gd, theme=th,
        )

        if _in_jupyter():
            from IPython.display import display
            display(viewer)
        else:
            _open_in_browser(viewer)

    # Preserve original as _plot_matplotlib
    if _original_plot is not None and not hasattr(_Seq, "_plot_matplotlib"):
        _Seq._plot_matplotlib = _original_plot  # type: ignore[attr-defined]

    _Seq.plot = _seqeyes_plot  # type: ignore[attr-defined]

    # _repr_html_ so bare ``seq`` auto‑renders in Jupyter
    def _seq_repr_html_(self: object) -> str:
        from seqeyes._renderer import SeqEyesViewer
        return SeqEyesViewer(_seq_to_text(self))._repr_html_()

    _Seq._repr_html_ = _seq_repr_html_  # type: ignore[attr-defined]


def _in_jupyter() -> bool:
    try:
        from IPython import get_ipython
        s = get_ipython()
        return s is not None and ("ZMQ" in s.__class__.__name__ or "Shell" in s.__class__.__name__)
    except ImportError:
        return False


def _open_in_browser(viewer: "SeqEyesViewer") -> None:  # noqa: F821
    """Open the viewer in a native desktop pop‑up window (pywebview).

    Spawns a subprocess so ``webview.start()`` runs on its own main
    thread without blocking the calling script.  Falls back to the
    system browser if pywebview is not installed.
    """
    html = viewer.to_html()

    # Write HTML to a temp file — file:// URLs are more reliable with
    # pywebview than inline html= on some backends.
    p = os.path.join(tempfile.gettempdir(), "seqeyes_viewer.html")
    Path(p).write_text(html, encoding="utf-8")
    url = f"file:///{p.replace(os.sep, '/')}"

    try:
        import webview  # type: ignore[import-untyped]
    except ImportError:
        _fallback_browser(url)
        return

    # Run webview in a subprocess so it gets its own main thread.
    # We shell out to a tiny inline script — this avoids multiprocessing
    # "spawn" issues (re‑importing the parent script on Windows).
    import subprocess
    import sys

    script = (
        "import webview;"
        f"webview.create_window(title='SeqEyes — Pulseq MRI Sequence Viewer',url={url!r},width=1280,height=800,resizable=True,easy_drag=False);"
        "webview.start()"
    )
    try:
        subprocess.Popen(
            [sys.executable, "-c", script],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        _fallback_browser(url)


def _fallback_browser(url: str) -> None:
    """Last resort: open the viewer in the system web browser."""
    import webbrowser
    webbrowser.open(url)


def _seq_to_text(seq: object) -> str:
    if hasattr(seq, "write"):
        with tempfile.NamedTemporaryFile(mode="r", suffix=".seq", delete=False, encoding="utf-8") as f:
            tp = f.name
        try:
            seq.write(tp)  # type: ignore[union-attr]
            return Path(tp).read_text(encoding="utf-8")
        finally:
            try:
                os.unlink(tp)
            except OSError:
                pass
    return ""
