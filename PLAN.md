# SeqEyes Plugin — VS Code Extension for Pulseq Sequence Visualization

## Overview

A TypeScript-based VS Code extension that provides rapid, flexible visualization of
MRI pulse sequences defined in the [Pulseq](https://github.com/pulseq/pulseq) open
file format (`.seq`). Inspired by [SeqEyes](https://github.com/xingwangyong/seqeyes)
(Qt/C++ desktop app), this plugin brings the same inspection power directly into
the VS Code editor.

## Goals

1. **Open .seq files in VS Code** — use a custom editor (webview) to render sequence
   diagrams instead of showing raw binary.
2. **Parse the latest Pulseq binary format** — support v1.5.x definitions, all block
   types (RF, gradients, ADC, delays, shaped pulses, etc.), and optional
   `[DEFINITIONS]` metadata.
3. **Interactive visualizations**
   - Sequence timing diagram (block-level: RF magnitude/phase, Gx/Gy/Gz, ADC readout,
     delays, triggers)
   - k-space trajectory plot (2D/3D)
   - Gradient moment curves (M0, M1)
   - Zoom, pan, and hover tooltips with exact timing/amplitude values
4. **TR-aware navigation** — jump between TR periods; overlay TE markers.
5. **Export** — PNG/SVG of the current view.
6. **Performance** — handle long sequences (thousands of blocks) efficiently via
   Canvas-based rendering and downsampling.

## Architecture

```
seqeyes-plugin/
├── src/
│   ├── extension.ts              # Activation, registration, commands
│   ├── pulseq/
│   │   ├── types.ts              # TypeScript interfaces for all Pulseq data structures
│   │   ├── reader.ts             # Binary .seq file parser
│   │   ├── definitions.ts        # [DEFINITIONS] section parser
│   │   └── blocks.ts             # Block type enum & helpers
│   ├── editor/
│   │   ├── seqEditorProvider.ts  # CustomTextEditorProvider implementation
│   │   └── webviewContent.ts     # HTML/CSS/JS generation for the webview
│   ├── visualization/
│   │   ├── sequenceDiagram.ts    # Sequence timing diagram (Canvas)
│   │   ├── kspaceTrajectory.ts   # k-space plot
│   │   ├── gradientMoments.ts    # M0/M1 curves
│   │   └── renderer.ts          # Shared rendering utilities
│   ├── commands/
│   │   └── exportCommands.ts     # Export PNG/SVG commands
│   └── utils/
│       ├── math.ts               # Rotation matrices, spin physics helpers
│       └── colorbrewer.ts        # Color palettes for diagram
├── media/
│   └── icon.svg                  # Extension icon
├── .vscode/
│   ├── launch.json
│   └── tasks.json
├── package.json
├── tsconfig.json
├── .vscodeignore
└── README.md
```

## Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Extension host | TypeScript 5.x | VS Code native; strong typing for binary parsing |
| UI | Webview (HTML5 Canvas) | Sandboxed, performant, matches VS Code theming |
| Charting | Custom Canvas renderer + D3.js helpers | Pulseq diagrams are domain-specific; Canvas gives full control |
| Binary parsing | Pure TypeScript (DataView) | No native dependencies; works cross-platform |
| Build | esbuild (via VS Code extension bundler) | Fast, minimal config |
| Testing | Mocha + VS Code test runner | Built into extension template |
| Linting | ESLint | Built into extension template |

## Development Phases

### Phase 1 — Hello World Extension (current)
- Scaffold VS Code extension with TypeScript
- Basic activation, command registration
- "Hello World" info message on command

### Phase 2 — .seq File Parser
- Implement binary reader for Pulseq v1.5.x format
- Parse sections: `[VERSION]`, `[DEFINITIONS]`, `[BLOCKS]`
- Parse block types: RF, gradients (trap/arbitrary), ADC, delay, shaped pulses,
  triggers, labels
- Unit tests for known .seq files

### Phase 3 — Custom Editor (Webview)
- Register `CustomTextEditorProvider` for `.seq` files
- Build webview HTML/JS that receives parsed data
- Render basic sequence timing diagram (RF + gradient axes vs time)
- Implement zoom/pan

### Phase 4 — Advanced Visualization
- k-space trajectory computation and 2D plot
- Gradient moment curves
- TR navigation, TE overlay
- Hover tooltips with block details

### Phase 5 — Polish & Publish
- Export to PNG/SVG
- VS Code theme integration (light/dark)
- Configuration settings (colors, default view, etc.)
- Publish to VS Code Marketplace

## Pulseq Binary Format (v1.5.x) — Key Points

The `.seq` file is a binary file with these sections:

1. **`[VERSION]`** — magic number + major.minor.revision (int32 each)
2. **`[DEFINITIONS]`** — optional key-value string pairs (e.g., `FOV 220 220 5`)
3. **`[BLOCKS]`** — sequence of blocks, each with:
   - Block ID (int32)
   - Flag word (int64) — bitmask indicating which data fields follow
   - Data fields in order: RF, ADC, delay, gradients, shapes, labels, etc.
   - Each data field has its own sub-structure (e.g., RF has amp, phase, freq,
     shape_id, etc.)

Key data types: `int32`, `int64`, `float32`, `float64`, null-terminated strings.

## References

- [Pulseq GitHub](https://github.com/pulseq/pulseq)
- [Pulseq File Spec (PDF)](https://github.com/pulseq/pulseq/blob/master/doc/specification.pdf)
- [SeqEyes GitHub](https://github.com/xingwangyong/seqeyes)
- [VS Code Custom Editor API](https://code.visualstudio.com/api/extension-guides/custom-editors)
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
