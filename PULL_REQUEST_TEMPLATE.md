## Summary

Fixes multiple rendering and layout issues in the VS Code SeqEyes plugin:

### Bugs Fixed

1. **K-Space axes invisible & orientation broken** (`kspace.js`)
   - Removed broken frame-skip wrapper (`_kAxisFrame` counter + `if (!_kAnimId || ...)`) that prevented Canvas 2D axes from rendering on most frames
   - The `function proj` and `function drawAxis3D` declarations were trapped inside an `if` block, causing undefined behavior
   - Fix matches the working standalone web version which draws axes unconditionally

2. **Oversized toolbar buttons on narrow/touch screens** (`styles.css`)
   - Removed `min-height:36px; min-width:36px` rules that forced huge buttons on phone-like screens
   - Removed oversized k-space panel buttons and tooltip rules
   - Kept essential structural changes (hamburger menu, dropdown)

3. **K-Space button wrapping to second row on narrow screens** (`styles.css`)
   - Hide zoom buttons on narrow screens (scroll wheel/pinch work)
   - Use flexbox `order` to place K-Space button before legend, keeping it on row 1

4. **Blank zone on right side of waveform** (`state.js`, `drawing.js`, `web/index.html`)
   - Reduced right margin `M.r` from 30→6 (horizontal) and 10→5 (narrow)
   - Fixed time axis label to right-align at canvas edge instead of being clipped

### Files Changed
- `src/editor/webview/assets/kspace.js`
- `src/editor/webview/assets/styles.css`
- `src/editor/webview/assets/state.js`
- `src/editor/webview/assets/drawing.js`
- `web/index.html`