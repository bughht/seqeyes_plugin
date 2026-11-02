"""
_renderer.py — Jupyter HTML renderer for the SeqEyes interactive viewer.

The viewer is the standalone SeqEyes page (``web/index.html``) run as the
``python`` host: the sequence and the display options are injected ahead of
the page's own script, the way the MATLAB toolbox does it.  Jupyter displays
it inline via ``_repr_html_()`` in a ``data:`` iframe, the same mechanism
Plotly uses; such a frame can fetch nothing, so the stylesheet and both
scripts are inlined.
"""

from __future__ import annotations

import base64
import json
import math
import os
import re
from pathlib import Path
from typing import Any, List, Optional, Union


# ── Paths ─────────────────────────────────────────────────────────────────
_RESOURCES_DIR = Path(__file__).resolve().parent / "resources"
# ``npm run build:web`` copies the page and its assets into resources/; a
# source checkout can read them from web/ instead.
_WEB_DIR = Path(__file__).resolve().parents[3] / "web"

# The page's references to its assets, each present exactly once.
_STYLESHEET_TAG = '<link rel="stylesheet" href="styles.css">'
_PULSEQ_TAG = '<script src="pulseq-bundle.js"></script>'
_WEBVIEW_TAG = '<script src="webview-bundle.js"></script>'
_BODY_TAG = "<body>"

_VALID_GRAD_UNITS = {"Hz/m", "mT/m", "G/cm"}
# The two plain names Python has always accepted, resolved the way the page's
# own "system" theme resolves light and dark.
_THEME_ALIASES = {"light": "githublight", "dark": "github"}
SequenceSource = Union[str, bytes, bytearray, memoryview]


def _read_resource(name: str) -> str:
    """Read one of the page's files from resources/, or from web/ in a checkout."""
    for directory in (_RESOURCES_DIR, _WEB_DIR):
        path = directory / name
        if path.is_file():
            return path.read_text(encoding="utf-8")
    raise FileNotFoundError(
        f"{name} not found in {_RESOURCES_DIR}.  "
        "Build it with: npm run build:web  (from the repo root)."
    )


def _normalize_grad_disp(unit: str) -> str:
    """Return a viewer-supported gradient unit."""
    return unit if unit in _VALID_GRAD_UNITS else "mT/m"


def _page_theme(theme: Optional[str]) -> Optional[str]:
    """Map a Python theme name to one of the page's theme names."""
    if not theme:
        return None
    return _THEME_ALIASES.get(str(theme), str(theme))


def _finite_or_none(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _time_range_option(time_range: Any) -> List[Optional[float]]:
    """Seconds, with None for an open end; ``[0, None]`` keeps the page's first view."""
    try:
        start, end = time_range
    except (TypeError, ValueError):
        return [0.0, None]
    return [_finite_or_none(start), _finite_or_none(end)]


def _script_json(value: Any) -> str:
    """JSON for an inline script, with no character the HTML parser acts on."""
    return (
        json.dumps(value, allow_nan=False, separators=(",", ":"))
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
    )


def _inline_script(source: str) -> str:
    # A literal "</script" would end the element early; "<\/" means the same in JS.
    return "<script>\n" + re.sub(r"</(?=script)", r"<\\/", source, flags=re.IGNORECASE) + "\n</script>"


def _inline_style(source: str) -> str:
    # Likewise for "</style"; "\/" is an escaped "/" in CSS.
    return "<style>\n" + re.sub(r"</(?=style)", r"<\\/", source, flags=re.IGNORECASE) + "\n</style>"


def _replace_tags(page: str, replacements: dict) -> str:
    """Replace each tag, which must occur exactly once, in a single pass."""
    for tag in replacements:
        if page.count(tag) != 1:
            raise ValueError(f"index.html no longer has exactly one {tag!r}")
    pattern = "|".join(re.escape(tag) for tag in replacements)
    return re.sub(pattern, lambda match: replacements[match.group(0)], page)


def _build_html(
    sequence_source: SequenceSource,
    *,
    theme: Optional[str] = None,
    inject_bundle: bool = True,
    label: str = "",
    show_blocks: bool = False,
    time_range: tuple = (0, float("inf")),
    time_disp: str = "s",
    grad_disp: str = "mT/m",
) -> str:
    """Assemble the complete viewer HTML.

    Parameters
    ----------
    sequence_source : str or bytes-like
        Raw text ``.seq`` content or binary ``.bseq`` bytes.
    theme : str or None
        Viewer theme: ``"system"``, ``"light"``, ``"dark"``, or one of the
        page's themes (``"onelight"``, ``"onedark"``, ``"dracula"``,
        ``"nord"``, ``"githublight"``, ``"github"``).  None uses the page's
        remembered or system theme.
    inject_bundle : bool
        If True, inline the stylesheet and both scripts so the page is
        self-contained.  If False, keep the page's relative references to
        ``styles.css``, ``pulseq-bundle.js`` and ``webview-bundle.js``, for a
        page served next to copies of those files.
    label : str
        Sequence file name: names exported files, and titles the page when
        the sequence defines no ``Name``.
    show_blocks : bool
        Initial block‑boundary visibility.
    time_range : tuple[float, float]
        Initial viewport range in seconds.  ``(0, inf)`` keeps the viewer's
        own first view; an infinite end means the end of the sequence.
    time_disp : str
        Initial time display unit (``"s"``, ``"ms"``, ``"us"``).
    grad_disp : str
        Initial gradient display unit (``"mT/m"``, the default, ``"Hz/m"``
        or ``"G/cm"``).
    """
    page = _read_resource("index.html")
    source_is_text = isinstance(sequence_source, str)
    file_name = label or ("sequence.seq" if source_is_text else "sequence.bseq")
    if source_is_text:
        preload = {"text": sequence_source, "fileName": file_name}
    else:
        source_b64 = base64.b64encode(bytes(sequence_source)).decode("ascii")
        preload = {"base64": source_b64, "fileName": file_name}
    page_theme = _page_theme(theme)
    options = {
        "theme": page_theme,
        "timeUnit": time_disp,
        "gradUnit": _normalize_grad_disp(grad_disp),
        "showBlocks": bool(show_blocks),
        "timeRange": _time_range_option(time_range),
    }
    # Runs before both bundles and the page's own script, which read these.
    host_script = (
        "<script>"
        'window._SEQEYES_HOST="python";'
        f"window._SEQEYES_PRELOAD={_script_json(preload)};"
        f"window._SEQEYES_OPTIONS={_script_json(options)};"
        "</script>\n"
    )

    replacements = {_PULSEQ_TAG: host_script + _PULSEQ_TAG}
    if inject_bundle:
        replacements = {
            _STYLESHEET_TAG: _inline_style(_read_resource("styles.css")),
            _PULSEQ_TAG: host_script + _inline_script(_read_resource("pulseq-bundle.js")),
            _WEBVIEW_TAG: _inline_script(_read_resource("webview-bundle.js")),
        }
    # Themed from the first paint; the page's script then applies the same choice.
    if page_theme and page_theme != "system" and re.fullmatch(r"[\w-]+", page_theme):
        replacements[_BODY_TAG] = f'<body class="theme-{page_theme}">'
    return _replace_tags(page, replacements)


class SeqEyesViewer:
    """Interactive Pulseq sequence viewer for Jupyter notebook output.

    Normally you don't create this directly — call ``seqeyes.set()``
    once, then use ``seq.plot(...)`` on any ``pypulseq.Sequence``.

    Parameters
    ----------
    sequence_source : str or bytes-like
        Raw text ``.seq`` content or binary ``.bseq`` bytes.
    label : str
        Sequence file name: names exported files, and titles the viewer when
        the sequence defines no ``Name``.
    show_blocks : bool
        Whether to show block‑boundary lines initially.
    time_range : tuple[float, float]
        Initial time viewport ``(start_sec, end_sec)``.  ``(0, inf)``
        keeps the viewer's own first view (the first TR when one is found).
    time_disp : str
        Time axis unit — ``"s"``, ``"ms"``, or ``"us"``.
    grad_disp : str
        Gradient axis unit — ``"mT/m"`` (default), ``"Hz/m"``, or ``"G/cm"``.
    theme : str or None
        Colour theme: ``"system"``, ``"light"``, ``"dark"``, ``"onelight"``,
        ``"onedark"``, ``"dracula"``, ``"nord"``, ``"githublight"`` or
        ``"github"``.
    width : str
        CSS width of the iframe (e.g. ``"100%"``).
    height : str
        CSS height of the iframe (e.g. ``"550px"``).
    """

    def __init__(
        self,
        sequence_source: SequenceSource,
        *,
        label: str = "",
        show_blocks: bool = False,
        time_range: tuple = (0, float("inf")),
        time_disp: str = "s",
        grad_disp: str = "mT/m",
        theme: Optional[str] = None,
        width: str = "100%",
        height: str = "550px",
    ) -> None:
        if not isinstance(sequence_source, (str, bytes, bytearray, memoryview)):
            raise TypeError("sequence_source must be .seq text or .bseq bytes")
        self._sequence_source = sequence_source
        self._label = label
        self._show_blocks = show_blocks
        self._time_range = time_range
        self._time_disp = time_disp
        self._grad_disp = _normalize_grad_disp(grad_disp)
        self._theme = theme
        self._width = width
        self._height = height

    @classmethod
    def from_file(cls, path: Union[str, os.PathLike[str]], **kwargs: Any) -> "SeqEyesViewer":
        """Create a viewer from a local ``.seq`` or ``.bseq`` file."""
        source_path = Path(path)
        if source_path.suffix.lower() not in {".seq", ".bseq"}:
            raise ValueError("SeqEyesViewer.from_file() expects a .seq or .bseq file")
        if not source_path.is_file():
            raise FileNotFoundError(source_path)
        kwargs.setdefault("label", source_path.name)
        source: SequenceSource = (
            source_path.read_text(encoding="utf-8")
            if source_path.suffix.lower() == ".seq"
            else source_path.read_bytes()
        )
        return cls(source, **kwargs)

    # ── Jupyter integration ───────────────────────────────────────────

    def _repr_html_(self) -> str:
        """Return an HTML iframe that Jupyter renders inline."""
        html = _build_html(
            self._sequence_source,
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
        """Return the full standalone HTML string (for saving to a file).

        With ``inject_bundle=False`` the page references ``styles.css``,
        ``pulseq-bundle.js`` and ``webview-bundle.js`` by relative URL
        instead of inlining them, so it works only next to copies of them.
        """
        return _build_html(
            self._sequence_source,
            theme=self._theme,
            inject_bundle=inject_bundle,
            label=self._label,
            show_blocks=self._show_blocks,
            time_range=self._time_range,
            time_disp=self._time_disp,
            grad_disp=self._grad_disp,
        )
