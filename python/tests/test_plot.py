"""
Tests for seqeyes — SeqEyesViewer and patch_pypulseq.
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


class TestPatchPypulseq:
    """Tests for patch_pypulseq(), set(), and reset()."""

    def test_patch_pypulseq_adds_plot(self):
        try:
            import seqeyes
            from pypulseq import Sequence

            seqeyes.patch_pypulseq()
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

    def test_patch_pypulseq_idempotent(self):
        try:
            import seqeyes
            seqeyes.patch_pypulseq()
            seqeyes.patch_pypulseq()  # should not crash
        except ImportError:
            pytest.skip("pypulseq not installed")

    def test_set_and_reset(self):
        """set() should store defaults, reset() should clear them."""
        import seqeyes

        seqeyes.set(theme="dracula", time_disp="ms", show_blocks=True)
        seqeyes.reset()
        # After reset, calling set again should work
        seqeyes.set(theme="dark")
        seqeyes.reset()

    def test_set_defaults_merge(self):
        """Global defaults should merge with per-call args."""
        import seqeyes

        seqeyes.set(theme="dracula", time_disp="ms")
        # Call set again to update a single key
        seqeyes.set(grad_disp="mT/m")
        seqeyes.reset()
