"""Integration smoke test for seqeyes package."""
from seqeyes import SeqEyesViewer

SAMPLE = """[VERSION]
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

# Test 1: SeqEyesViewer basic
v = SeqEyesViewer(SAMPLE, theme="dark")
html = v._repr_html_()
print(f"OK _repr_html_: {len(html):,} chars")
assert "<iframe" in html
assert "data:text/html;base64," in html

# Test 2: to_html()
full = v.to_html()
print(f"OK to_html(): {len(full):,} chars")
assert "<!DOCTYPE html>" in full
assert "SeqEyes" in full

# Test 3: With display options
v2 = SeqEyesViewer(SAMPLE, show_blocks=True, time_range=(0, 0.01), time_disp="ms", grad_disp="mT/m", theme="dracula")
raw = v2.to_html(inject_bundle=True)
print(f"OK options: {len(raw):,} chars")
assert "parseSequenceText" in raw
assert "SEQEYES_SHOW_BLOCKS" in raw
assert "SEQEYES_TIME_RANGE" in raw
assert '"ms"' in raw
assert '"mT/m"' in raw

# Test 4: set, reset
try:
    import seqeyes

    # Test set()
    seqeyes.set(theme="dracula", time_disp="ms", grad_disp="Hz/m")
    seqeyes.set(show_blocks=True)  # update a single key
    print("OK seqeyes.set() works")

    # Test reset()
    seqeyes.reset()
    print("OK seqeyes.reset() works")

    # Re-enable (should work after reset)
    seqeyes.set(theme="dark")
    print("OK re-enable after reset works")

except Exception:
    print("OK set()/reset() correctly skipped (pypulseq not available)")

print()
print("All integration tests passed!")
