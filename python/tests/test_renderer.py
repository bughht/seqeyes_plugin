"""
Tests for seqeyes._renderer — assembling the standalone page as the Python host.
"""
from __future__ import annotations

import base64
from pathlib import Path

import pytest


SAMPLE_SEQ_TEXT = """[VERSION]
major 1
minor 4
revision 0
[DEFINITIONS]
B0 3.0
GradientRasterTime 10
BlockDurationRaster 10
RadiofrequencyRasterTime 1
AdcRasterTime 0.1
[BLOCKS]
1 3 1000 1 0 0 0 0 0
[RF]
1 1000 1 2 1 0 0 0 0 0 0
[SHAPES]
0 1
shape_id 1
num_samples 2
1 0
shape_id 2
num_samples 2
0 1
"""

HOST_SCRIPT = '<script>window._SEQEYES_HOST="python";'
PAGE_REFERENCES = (
    '<link rel="stylesheet" href="styles.css">',
    '<script src="pulseq-bundle.js"></script>',
    '<script src="webview-bundle.js"></script>',
)
WEB_DIR = Path(__file__).resolve().parents[2] / "web"
RESOURCES_DIR = Path(__file__).resolve().parents[1] / "src" / "seqeyes" / "resources"


class TestBuildHtml:
    """Tests for _build_html()."""

    def test_preloads_text_sequence(self, injected):
        from seqeyes._renderer import _build_html

        html = _build_html(SAMPLE_SEQ_TEXT, inject_bundle=False)
        assert injected(html)["_SEQEYES_PRELOAD"] == {"text": SAMPLE_SEQ_TEXT, "fileName": "sequence.seq"}

    def test_preloads_binary_sequence_byte_exact(self, injected):
        from seqeyes._renderer import _build_html

        source = b"\x01pulseq\x02\x00\xff"
        html = _build_html(source, label="demo.bseq", inject_bundle=False)
        preload = injected(html)["_SEQEYES_PRELOAD"]
        assert preload == {"base64": base64.b64encode(source).decode(), "fileName": "demo.bseq"}
        assert _build_html(bytearray(source), inject_bundle=False).count(preload["base64"]) == 1

    def test_default_binary_name_is_bseq(self, injected):
        from seqeyes._renderer import _build_html

        html = _build_html(memoryview(b"\x01pulseq"), inject_bundle=False)
        assert injected(html)["_SEQEYES_PRELOAD"]["fileName"] == "sequence.bseq"

    def test_runs_as_python_host_before_the_page_scripts(self):
        from seqeyes._renderer import _build_html

        html = _build_html(SAMPLE_SEQ_TEXT)
        host = html.index(HOST_SCRIPT)
        assert html.count(HOST_SCRIPT) == 1
        assert host < html.index("var Pulseq")
        assert host < html.index("SeqEyes WebView Bundle")
        assert host < html.index("SeqEyes — Standalone Web Application")

    def test_inlines_stylesheet_and_both_scripts(self):
        from seqeyes._renderer import _build_html

        html = _build_html(SAMPLE_SEQ_TEXT)
        for reference in PAGE_REFERENCES:
            assert reference not in html
        assert "body.theme-dracula{" in html
        assert "var Pulseq" in html
        assert "var SeqEyesLabels" in html

    def test_without_bundle_keeps_relative_references(self, injected):
        """inject_bundle=False is for a page served next to the web/ assets."""
        from seqeyes._renderer import _build_html

        html = _build_html(SAMPLE_SEQ_TEXT, inject_bundle=False)
        for reference in PAGE_REFERENCES:
            assert html.count(reference) == 1
        assert "var Pulseq" not in html
        assert html.index(HOST_SCRIPT) < html.index(PAGE_REFERENCES[1])
        assert injected(html)["_SEQEYES_PRELOAD"]["text"] == SAMPLE_SEQ_TEXT

    def test_sequence_text_cannot_close_the_script(self, injected):
        from seqeyes._renderer import _build_html

        hostile = SAMPLE_SEQ_TEXT + "# </script><script>alert(1)</script> <!-- & -->\n"
        html = _build_html(hostile, inject_bundle=False)
        assert "alert(1)</script>" not in html
        assert "<!-- & -->" not in html
        assert injected(html)["_SEQEYES_PRELOAD"]["text"] == hostile

    def test_inliners_escape_closing_tags(self):
        from seqeyes._renderer import _inline_script, _inline_style

        assert _inline_script('s="</SCRIPT>";') == '<script>\ns="<\\/SCRIPT>";\n</script>'
        assert _inline_style("/* </style> */") == "<style>\n/* <\\/style> */\n</style>"

    def test_page_change_that_drops_a_reference_fails_loudly(self, monkeypatch):
        import seqeyes._renderer as renderer

        real = renderer._read_resource
        monkeypatch.setattr(
            renderer,
            "_read_resource",
            lambda name: real(name).replace(PAGE_REFERENCES[2], "") if name == "index.html" else real(name),
        )
        with pytest.raises(ValueError, match="webview-bundle.js"):
            renderer._build_html(SAMPLE_SEQ_TEXT)

    def test_display_options(self, injected):
        from seqeyes._renderer import _build_html

        html = _build_html(
            SAMPLE_SEQ_TEXT,
            inject_bundle=False,
            show_blocks=True,
            time_range=(0.01, 0.05),
            time_disp="ms",
            grad_disp="G/cm",
        )
        assert injected(html)["_SEQEYES_OPTIONS"] == {
            "theme": None,
            "timeUnit": "ms",
            "gradUnit": "G/cm",
            "showBlocks": True,
            "timeRange": [0.01, 0.05],
        }

    @pytest.mark.parametrize(
        ("time_range", "expected"),
        [
            ((0, float("inf")), [0.0, None]),
            ((0.02, float("inf")), [0.02, None]),
            ([0.01, 0.03], [0.01, 0.03]),
            ((float("nan"), 0.03), [None, 0.03]),
            ("not a range", [0.0, None]),
            (None, [0.0, None]),
        ],
    )
    def test_time_range_has_no_infinities(self, injected, time_range, expected):
        from seqeyes._renderer import _build_html

        html = _build_html(SAMPLE_SEQ_TEXT, inject_bundle=False, time_range=time_range)
        assert injected(html)["_SEQEYES_OPTIONS"]["timeRange"] == expected

    def test_unsupported_gradient_unit_falls_back_to_mt_per_m(self, injected):
        from seqeyes._renderer import _build_html

        html = _build_html(SAMPLE_SEQ_TEXT, inject_bundle=False, grad_disp="kHz/m")
        assert injected(html)["_SEQEYES_OPTIONS"]["gradUnit"] == "mT/m"

    @pytest.mark.parametrize(
        ("theme", "page_theme"),
        [("dracula", "dracula"), ("dark", "github"), ("light", "githublight"), ("nord", "nord")],
    )
    def test_theme_is_a_body_class_and_an_option(self, injected, theme, page_theme):
        from seqeyes._renderer import _build_html

        html = _build_html(SAMPLE_SEQ_TEXT, theme=theme, inject_bundle=False)
        assert f'<body class="theme-{page_theme}">' in html
        assert injected(html)["_SEQEYES_OPTIONS"]["theme"] == page_theme

    @pytest.mark.parametrize("theme", [None, "", "system"])
    def test_no_theme_class_without_a_fixed_theme(self, theme):
        from seqeyes._renderer import _build_html

        html = _build_html(SAMPLE_SEQ_TEXT, theme=theme, inject_bundle=False)
        assert "<body>" in html
        assert 'class="theme-' not in html

    def test_theme_name_cannot_break_out_of_the_class(self, injected):
        from seqeyes._renderer import _build_html

        html = _build_html(SAMPLE_SEQ_TEXT, theme='x" onload="alert(1)', inject_bundle=False)
        assert "<body>" in html
        assert 'onload="alert(1)' not in html.split(HOST_SCRIPT)[0]
        assert injected(html)["_SEQEYES_OPTIONS"]["theme"] == 'x" onload="alert(1)'

    def test_build_html_is_valid_html(self):
        from seqeyes._renderer import _build_html

        html = _build_html(SAMPLE_SEQ_TEXT)
        assert html.lstrip().startswith("<!DOCTYPE html>")
        assert html.count("<body") == 1
        assert html.rstrip().endswith("</html>")
        assert html.count("<script") == html.count("</script>")


class TestResources:
    """The page the package ships."""

    def test_page_and_assets_are_available(self):
        from seqeyes._renderer import _read_resource

        page = _read_resource("index.html")
        for reference in PAGE_REFERENCES:
            assert page.count(reference) == 1
        assert "<body>" in page
        for name in ("styles.css", "pulseq-bundle.js", "webview-bundle.js"):
            assert len(_read_resource(name)) > 1000

    @pytest.mark.skipif(not WEB_DIR.is_dir(), reason="needs a source checkout")
    @pytest.mark.parametrize("name", ["index.html", "styles.css", "pulseq-bundle.js", "webview-bundle.js"])
    def test_resources_match_web_after_build(self, name):
        """resources/ is a copy of web/ made by `npm run build:web`; rebuild if this fails."""
        assert (RESOURCES_DIR / name).read_bytes() == (WEB_DIR / name).read_bytes()
