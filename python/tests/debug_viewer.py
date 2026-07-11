"""Debug: Generate the viewer HTML and check its integrity."""
import os, re
from seqeyes._renderer import _build_html

# Use a known-good .seq file
seq_path = os.path.join(os.path.dirname(__file__), '..', '..', 'test', 'seqeyes_demo_seq_files', 'writeFid.seq')
seq_text = open(seq_path, 'r').read()

html = _build_html(seq_text, theme='dark')
path = os.path.join(os.path.dirname(__file__), 'debug_viewer.html')
with open(path, 'w', encoding='utf-8') as f:
    f.write(html)

# Check key JS components
checks = [
    ('convertBlock function', 'function convertBlock(blk)'),
    ('loadSequenceText function', 'function loadSequenceText(rawText)'),
    ('SEQEYES_RAW_B64 assignment', 'window.SEQEYES_RAW_B64'),
    ('Pulseq bundle: parseSequenceText', 'parseSequenceText'),
    ('Pulseq bundle: decodeAllBlocks', 'decodeAllBlocks'),
    ('convertBlock: index mapping', 'b.i = blk.index'),
    ('convertBlock: startTime mapping', 'b.s = blk.startTime'),
    ('convertBlock: RF amplitude', 'b.rf.a'),
    ('convertBlock: RF timePoints', 'b.rf.t'),
    ('convertBlock: Grad type mapping', 'b.gx.ty'),
    ('convertBlock: ADC start', 'b.adc.s'),
    ('convertBlock: Triggers', 'b.trg'),
    ('draw function', 'function draw()'),
    ('computeGlobalMax', 'function computeGlobalMax()'),
    ('fit function', 'function fit()'),
    ('drawBlocks function', 'function drawBlocks'),
    ('viewerDrawFrame', 'viewerDrawFrame'),
]
for label, pattern in checks:
    found = pattern in html
    print(f'  {"OK" if found else "MISSING"}  {label}')

# Check that the sequence data is base64-encoded
import base64
seq_b64 = base64.b64encode(seq_text.encode()).decode()
data_in_html = seq_b64[:50] in html or seq_b64[-50:] in html
print(f'  {"OK" if data_in_html else "MISSING"}  Sequence data in HTML')

# Count script tags
script_count = html.count('<script>') + html.count('<script ')
print(f'\nScript tags: {script_count}')

# Check for the critical rendering path
print(f'\nFile size: {len(html):,} bytes')
print(f'Saved to: {os.path.abspath(path)}')
