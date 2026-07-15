"""
Tests for seqeyes — SeqEyesViewer, set(), and reset().
"""
from __future__ import annotations

import pytest

from seqeyes import SeqEyesViewer


SAMPLE_SEQ_TEXT = """[VERSION]
major 1
minor 5
revision 1
[DEFINITIONS]
AdcRasterTime 1e-07
BlockDurationRaster 1e-05
GradientRasterTime 1e-05
RadiofrequencyRasterTime 1e-06
B0 3.0
[BLOCKS]
 1 5000  1  0  0  0  0  0
 2 100000  0  0  0  0  1  0
[RF]
1  1000  1  2  1  0  0  0  0  0  0  e
[ADC]
1  256  0.1  0  0  0  0  0  0
[SHAPES]
shape_id 1
num_samples 2
1
1
shape_id 2
num_samples 2
0
0
"""


class TestSeqEyesViewer:
    """Tests for SeqEyesViewer."""

    def test_viewer_creates(self):
        v = SeqEyesViewer(SAMPLE_SEQ_TEXT)
        assert v is not None

    def test_viewer_loads_binary_file(self, tmp_path):
        source = b"\x01pulseq\x02\x00\xff"
        path = tmp_path / "demo.bseq"
        path.write_bytes(source)

        raw = SeqEyesViewer.from_file(path).to_html(inject_bundle=False)

        assert 'window.SEQEYES_SOURCE_KIND = "bytes";' in raw
        assert 'window.SEQEYES_SOURCE_NAME = "demo.bseq";' in raw
        assert __import__("base64").b64encode(source).decode() in raw

    def test_viewer_loads_text_file(self, tmp_path):
        path = tmp_path / "demo.seq"
        path.write_text(SAMPLE_SEQ_TEXT, encoding="utf-8")

        raw = SeqEyesViewer.from_file(path).to_html(inject_bundle=False)

        assert 'window.SEQEYES_SOURCE_KIND = "text";' in raw
        assert 'window.SEQEYES_SOURCE_NAME = "demo.seq";' in raw

    def test_viewer_rejects_unsupported_file_extension(self, tmp_path):
        path = tmp_path / "demo.txt"
        path.write_text("not a sequence", encoding="utf-8")
        with pytest.raises(ValueError, match=r"\.seq or \.bseq"):
            SeqEyesViewer.from_file(path)

    def test_repr_html_is_iframe(self):
        v = SeqEyesViewer(SAMPLE_SEQ_TEXT)
        html = v._repr_html_()
        assert html.startswith("<iframe")
        assert "data:text/html;base64," in html

    def test_to_html_standalone(self):
        v = SeqEyesViewer(SAMPLE_SEQ_TEXT)
        html = v.to_html(inject_bundle=False)
        assert "<!DOCTYPE html>" in html
        assert "SeqEyes" in html
        assert "SEQEYES_RAW_B64" in html

    def test_viewer_with_theme(self):
        v = SeqEyesViewer(SAMPLE_SEQ_TEXT, theme="dracula")
        raw = v.to_html(inject_bundle=False)
        assert 'class="theme-dracula"' in raw

    def test_viewer_with_label(self):
        v = SeqEyesViewer(SAMPLE_SEQ_TEXT, label="My GRE")
        raw = v.to_html(inject_bundle=False)
        assert '"My GRE"' in raw

    def test_viewer_with_show_blocks(self):
        v = SeqEyesViewer(SAMPLE_SEQ_TEXT, show_blocks=True)
        raw = v.to_html(inject_bundle=False)
        assert "SEQEYES_SHOW_BLOCKS" in raw

    def test_viewer_with_time_range(self):
        v = SeqEyesViewer(SAMPLE_SEQ_TEXT, time_range=(0.01, 0.05))
        raw = v.to_html(inject_bundle=False)
        assert "SEQEYES_TIME_RANGE" in raw
        assert "0.01" in raw
        assert "0.05" in raw

    def test_viewer_with_units(self):
        v = SeqEyesViewer(SAMPLE_SEQ_TEXT, time_disp="ms", grad_disp="mT/m")
        raw = v.to_html(inject_bundle=False)
        assert '"ms"' in raw
        assert '"mT/m"' in raw

    def test_viewer_default_gradient_unit_is_hz_per_m(self):
        v = SeqEyesViewer(SAMPLE_SEQ_TEXT)
        raw = v.to_html(inject_bundle=False)
        assert 'window.SEQEYES_GRAD_DISP = "Hz/m";' in raw

    def test_viewer_normalizes_unsupported_gradient_unit(self):
        v = SeqEyesViewer(SAMPLE_SEQ_TEXT, grad_disp="kHz/m")
        raw = v.to_html(inject_bundle=False)
        assert 'window.SEQEYES_GRAD_DISP = "Hz/m";' in raw
        assert "kHz/m" not in raw


class TestSetAndReset:
    """Tests for set() and reset()."""

    def test_set_patches_plot(self):
        try:
            import seqeyes
            from pypulseq import Sequence

            seqeyes.set()
            assert hasattr(Sequence, "plot")
            assert callable(Sequence.plot)

            seq = Sequence()
            rf = __import__("pypulseq").make_block_pulse(
                flip_angle=30e-3, duration=1e-3, system=seq.system
            )
            adc = __import__("pypulseq").make_adc(
                num_samples=128, dwell=10e-6, system=seq.system
            )
            seq.add_block(rf)
            seq.add_block(adc)
            seq.plot(show_blocks=True, time_disp="ms")
        except ImportError:
            pytest.skip("pypulseq not installed")

    def test_set_idempotent(self):
        try:
            import seqeyes
            seqeyes.set()
            seqeyes.set()  # should not crash
        except ImportError:
            pytest.skip("pypulseq not installed")

    def test_set_and_reset(self):
        """set() should store defaults, reset() should clear them."""
        try:
            import seqeyes

            seqeyes.set(theme="dracula", time_disp="ms", show_blocks=True)
            seqeyes.reset()
            # After reset, calling set again should work
            seqeyes.set(theme="dark")
            seqeyes.reset()
        except ImportError:
            pytest.skip("pypulseq not installed")

    def test_reset_removes_seqeyes_repr_html(self):
        """reset() should restore bare Sequence display, not only plot()."""
        try:
            import seqeyes
            from pypulseq import Sequence

            had_original = hasattr(Sequence, "_repr_html_")
            original_repr = getattr(Sequence, "_repr_html_", None)

            seqeyes.set()
            assert hasattr(Sequence, "_repr_html_")

            seqeyes.reset()
            if had_original:
                assert getattr(Sequence, "_repr_html_", None) is original_repr
            else:
                assert not hasattr(Sequence, "_repr_html_")
        except ImportError:
            pytest.skip("pypulseq not installed")

    def test_set_defaults_merge(self):
        """Global defaults should merge with per-call args."""
        try:
            import seqeyes

            seqeyes.set(theme="dracula", time_disp="ms")
            # Call set again to update a single key
            seqeyes.set(grad_disp="mT/m")
            seqeyes.reset()
        except ImportError:
            pytest.skip("pypulseq not installed")
