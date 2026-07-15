"""
Tests for seqeyes._renderer — HTML assembly and viewer template.
"""
from __future__ import annotations

import base64
import json

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


class TestBuildHtml:
    """Tests for _build_html()."""

    def test_build_html_contains_sequence_data(self):
        """The generated HTML should contain the base64-encoded sequence."""
        from seqeyes._renderer import _build_html

        html = _build_html(SAMPLE_SEQ_TEXT, inject_bundle=False)
        expected_b64 = base64.b64encode(SAMPLE_SEQ_TEXT.encode()).decode()
        assert expected_b64 in html
        assert 'window.SEQEYES_SOURCE_KIND = "text";' in html

    def test_build_html_contains_binary_sequence_data(self):
        """Binary sources should stay byte-exact and use byte dispatch."""
        from seqeyes._renderer import _build_html

        source = b"\x01pulseq\x02\x00\xff"
        html = _build_html(source, label="demo.bseq", inject_bundle=False)
        expected_b64 = base64.b64encode(source).decode()
        assert expected_b64 in html
        assert 'window.SEQEYES_SOURCE_KIND = "bytes";' in html
        assert 'window.SEQEYES_SOURCE_NAME = "demo.bseq";' in html

    def test_build_html_with_theme(self):
        """Theme should be applied as a body class."""
        from seqeyes._renderer import _build_html

        html = _build_html(SAMPLE_SEQ_TEXT, theme="dracula", inject_bundle=False)
        assert 'class="theme-dracula"' in html

    def test_build_html_without_theme(self):
        """Without theme, no theme class should appear."""
        from seqeyes._renderer import _build_html

        html = _build_html(SAMPLE_SEQ_TEXT, inject_bundle=False)
        assert 'class="theme-' not in html

    def test_build_html_is_valid_html(self):
        """The output should be a valid HTML document."""
        from seqeyes._renderer import _build_html

        html = _build_html(SAMPLE_SEQ_TEXT, inject_bundle=False)
        assert "<!DOCTYPE html>" in html
        assert "<html" in html
        assert "</html>" in html
        assert "<body" in html
        assert "</body>" in html


class TestViewerTemplate:
    """Tests that the viewer template exists and is well-formed."""

    def test_template_exists(self):
        """The viewer.html template file should exist."""
        from seqeyes._renderer import _read_viewer_template

        html = _read_viewer_template()
        assert len(html) > 1000
        assert "<!DOCTYPE html>" in html

    def test_template_has_placeholders(self):
        """Template should have the expected placeholders."""
        from seqeyes._renderer import _read_viewer_template

        html = _read_viewer_template()
        assert "<!-- PULSEQ_BUNDLE_PLACEHOLDER -->" in html
        assert "/* SEQEYES_DATA_PLACEHOLDER */" in html
