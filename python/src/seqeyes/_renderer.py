"""
_renderer.py — Jupyter HTML renderer for the SeqEyes interactive viewer.

Generates a self‑contained HTML string that Jupyter displays inline via
``_repr_html_()``, exactly the same mechanism Plotly uses.  The viewer is
an iframe embedding the SeqEyes web UI with sequence data injected.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Optional


# ── Paths ─────────────────────────────────────────────────────────────────
_RESOURCES_DIR = Path(__file__).resolve().parent / "resources"
_VIEWER_TEMPLATE_PATH = _RESOURCES_DIR / "viewer.html"

# pulseq-bundle.js lives in the repo root; during dev we read it directly.
# When installed as a package, a copy should be placed in resources/.
_BUNDLE_CANDIDATES = [
    _RESOURCES_DIR / "pulseq-bundle.js",
    Path(__file__).resolve().parent.parent.parent.parent / "web" / "pulseq-bundle.js",
    Path.cwd() / "web" / "pulseq-bundle.js",
]
_VALID_GRAD_UNITS = {"Hz/m", "mT/m", "G/cm"}


def _find_bundle() -> str:
    """Locate and read the pulseq-bundle.js file."""
    for p in _BUNDLE_CANDIDATES:
        if p.is_file():
            return p.read_text(encoding="utf-8")
    raise FileNotFoundError(
        "pulseq-bundle.js not found.  "
        "Build it with: npm run build:web  (from the repo root), "
        "or copy it to python/src/seqeyes/resources/"
    )


def _read_viewer_template() -> str:
    """Read the standalone viewer HTML template."""
    if _VIEWER_TEMPLATE_PATH.is_file():
        return _VIEWER_TEMPLATE_PATH.read_text(encoding="utf-8")
    alt = Path.cwd() / "python" / "src" / "seqeyes" / "resources" / "viewer.html"
    if alt.is_file():
        return alt.read_text(encoding="utf-8")
    raise FileNotFoundError(
        f"Viewer template not found at {_VIEWER_TEMPLATE_PATH}. "
        "Ensure the package is installed correctly."
    )


def _normalize_grad_disp(unit: str) -> str:
    """Return a viewer-supported gradient unit."""
    return unit if unit in _VALID_GRAD_UNITS else "Hz/m"


def _build_html(
    seq_text: str,
    *,
    theme: Optional[str] = None,
    inject_bundle: bool = True,
    label: str = "",
    show_blocks: bool = False,
    time_range: tuple = (0, float("inf")),
    time_disp: str = "s",
    grad_disp: str = "Hz/m",
) -> str:
    """Assemble the complete viewer HTML.

    Parameters
    ----------
    seq_text : str
        Raw .seq file content.
    theme : str or None
        CSS theme class to apply to ``<body>``.
    inject_bundle : bool
        If True, inline the pulseq-bundle.js parser into the HTML.
    label : str
        Display label (injected as JS variable, not yet rendered).
    show_blocks : bool
        Initial block‑boundary visibility.
    time_range : tuple[float, float]
        Initial viewport range in seconds.
    time_disp : str
        Initial time display unit (``"s"``, ``"ms"``, ``"us"``).
    grad_disp : str
        Initial gradient display unit (``"Hz/m"``, ``"mT/m"``, ``"G/cm"``).
    """
    template = _read_viewer_template()
    grad_disp = _normalize_grad_disp(grad_disp)
    seq_b64 = base64.b64encode(seq_text.encode("utf-8")).decode("ascii")

    # 1. Inject the pulseq-bundle.js
    bundle_placeholder = "<!-- PULSEQ_BUNDLE_PLACEHOLDER -->"
    if inject_bundle and bundle_placeholder in template:
        bundle_js = _find_bundle()
        template = template.replace(
            bundle_placeholder,
            f"<script>\n{bundle_js}\n</script>",
        )
    elif bundle_placeholder in template:
        template = template.replace(bundle_placeholder, "")

    # 2. Build options injection block (sequence data + display opts)
    opts = [
        f"window.SEQEYES_RAW_B64 = {json.dumps(seq_b64)};",
        f"window.SEQEYES_LABEL = {json.dumps(label)};",
        f"window.SEQEYES_SHOW_BLOCKS = {json.dumps(show_blocks)};",
        f"window.SEQEYES_TIME_RANGE = {json.dumps(list(time_range))};",
        f"window.SEQEYES_TIME_DISP = {json.dumps(time_disp)};",
        f"window.SEQEYES_GRAD_DISP = {json.dumps(grad_disp)};",
    ]
    opts_block = "\n".join(opts)

    data_placeholder = "/* SEQEYES_DATA_PLACEHOLDER */"
    if data_placeholder in template:
        template = template.replace(data_placeholder, opts_block)
    else:
        template = template.replace(
            "</body>",
            f"<script>{opts_block}</script>\n</body>",
        )

    # 3. Apply theme if specified
    if theme:
        template = template.replace(
            "<body>",
            f'<body class="theme-{theme}">',
        )

    return template


class SeqEyesViewer:
    """Interactive Pulseq sequence viewer for Jupyter notebook output.

    Normally you don't create this directly — call ``seqeyes.set()``
    once, then use ``seq.plot(...)`` on any ``pypulseq.Sequence``.

    Parameters
    ----------
    seq_text : str
        Raw .seq file content as a string.
    label : str
        Display label (not yet rendered on the viewer).
    show_blocks : bool
        Whether to show block‑boundary lines initially.
    time_range : tuple[float, float]
        Initial time viewport ``(start_sec, end_sec)``.  ``(0, inf)``
        shows the whole sequence.
    time_disp : str
        Time axis unit — ``"s"``, ``"ms"``, or ``"us"``.
    grad_disp : str
        Gradient axis unit — ``"Hz/m"``, ``"mT/m"``, or ``"G/cm"``.
    theme : str or None
        Colour theme.
    width : str
        CSS width of the iframe (e.g. ``"100%"``).
    height : str
        CSS height of the iframe (e.g. ``"550px"``).
    """

    def __init__(
        self,
        seq_text: str,
        *,
        label: str = "",
        show_blocks: bool = False,
        time_range: tuple = (0, float("inf")),
        time_disp: str = "s",
        grad_disp: str = "Hz/m",
        theme: Optional[str] = None,
        width: str = "100%",
        height: str = "550px",
    ) -> None:
        self._seq_text = seq_text
        self._label = label
        self._show_blocks = show_blocks
        self._time_range = time_range
        self._time_disp = time_disp
        self._grad_disp = _normalize_grad_disp(grad_disp)
        self._theme = theme
        self._width = width
        self._height = height

    # ── Jupyter integration ───────────────────────────────────────────

    def _repr_html_(self) -> str:
        """Return an HTML iframe that Jupyter renders inline."""
        html = _build_html(
            self._seq_text,
            theme=self._theme,
            label=self._label,
            show_blocks=self._show_blocks,
            time_range=self._time_range,
            time_disp=self._time_disp,
            grad_disp=self._grad_disp,
        )
        b64 = base64.b64encode(html.encode("utf-8")).decode("ascii")
        return (
            f'<iframe src="data:text/html;base64,{b64}" '
            f'width="{self._width}" height="{self._height}" '
            f'frameborder="0" '
            f'style="border:none;max-width:100%;overflow:hidden" '
            f'title="SeqEyes Viewer">'
            f"</iframe>"
        )

    def _ipython_display_(self) -> None:
        """IPython display hook."""
        from IPython.display import HTML, display

        display(HTML(self._repr_html_()))

    # ── Convenience ────────────────────────────────────────────────────

    def show(self) -> "SeqEyesViewer":
        """Display the viewer (useful in IPython when auto‑display is off)."""
        from IPython.display import display

        display(self)
        return self

    # ── Direct HTML access (for debugging / custom embedding) ──────────

    def to_html(self, *, inject_bundle: bool = True) -> str:
        """Return the full standalone HTML string (for saving to a file)."""
        return _build_html(
            self._seq_text,
            theme=self._theme,
            inject_bundle=inject_bundle,
            label=self._label,
            show_blocks=self._show_blocks,
            time_range=self._time_range,
            time_disp=self._time_disp,
            grad_disp=self._grad_disp,
        )
