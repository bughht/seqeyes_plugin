# Deploying SeqEyes to MathWorks Marketplace

This guide covers packaging and publishing the SeqEyes MATLAB Toolbox.

## Prerequisites

- MATLAB R2022a or later
- The SeqEyes project checked out at the `feature/matlab-toolbox` branch
- A [MathWorks Account](https://www.mathworks.com/login)
- The toolbox must pass MathWorks' [review guidelines](https://www.mathworks.com/matlabcentral/fileexchange/contribute)

## Step 1: Build the Web Bundle

The MATLAB viewer uses the same web assets as the browser and VS Code versions.
Make sure the web bundle is up to date:

```bash
npm run build:web
```

This produces `web/pulseq-bundle.js` (the Pulseq parser) and ensures
`web/index.html` references it correctly.

## Step 2: Verify the Toolbox Locally

Open MATLAB and add the project root to the path:

```matlab
cd('e:\MGH\seqeyes_plugin');
addpath(genpath('matlab'));

% Test the viewer
seqeyes('test\seq\spiral_inout.seq');

% Test auto-open handler
open('test\seq\spiral_inout.seq');
```

## Step 3: Package the .mltbx

Run the packaging script from the project root:

```matlab
cd('e:\MGH\seqeyes_plugin');
run('matlab\pack_toolbox.m');
```

This produces `seqeyes-<package.json version>.mltbx` in the current directory.

## Step 4: Test the Packaged Toolbox

Install the .mltbx file to verify it works end-to-end:

```matlab
% Install
matlab.addons.toolbox.installToolbox('seqeyes-<version>.mltbx');

% Restart MATLAB (recommended after install)

% Test
seqeyes('spiral_inout.seq');
```

To uninstall:
```matlab
matlab.addons.toolbox.uninstallToolbox('seqeyes');
```

## Step 5: Publish to MathWorks File Exchange

1. Go to https://www.mathworks.com/matlabcentral/fileexchange/
2. Click **Submit** → **Toolbox**
3. Upload `seqeyes-<version>.mltbx`
4. Fill in metadata:
   - **Title**: SeqEyes — Pulseq MRI Sequence Viewer
   - **Summary**: Interactive viewer for Pulseq .seq files with k-space visualisation
   - **Description**: (use the content from `matlab/toolboxInfo.xml`)
   - **Categories**: Medical Imaging, Visualization
   - **MATLAB Release**: R2022a and later
   - **Screenshot**: `images/screenshot.png` (add one showing the viewer)
5. Submit for review

## Step 6: Update for New Versions

When releasing a new version:

1. Update version in `package.json` / `package-lock.json`
2. `matlab/pack_toolbox.m` reads `package.json` and syncs the packaged toolbox metadata
3. Commit and tag: `git tag vX.Y.Z`
4. Re-run `matlab/pack_toolbox.m` to produce the new .mltbx
5. Upload the new .mltbx to File Exchange

## File Structure (inside .mltbx)

```
seqeyes/
├── seqeyes.m              # Main entry point
├── openseq.m              # Auto-open handler for .seq files
├── gettingStarted.m       # Getting-started guide
├── toolboxInfo.xml        # Metadata
├── examples/
│   └── demo.m             # Usage example
├── resources/
│   └── logo.png           # Toolbox icon
├── web/
│   ├── index.html         # Viewer UI
│   ├── pulseq-bundle.js   # Pulseq parser (compiled from TypeScript)
│   ├── logo.png
│   └── logo.svg
└── LICENSE.txt
```

## Troubleshooting

### "Cannot find web/index.html"
The toolbox installation may be corrupted. Reinstall from the .mltbx.

### "uihtml is not supported"
MATLAB R2022a or later is required.  `uihtml` was introduced in R2022a.

### File doesn't open on double-click
Make sure `openseq.m` is on the MATLAB path.  The toolbox installer places
all files on the path automatically.

### WebGL / k-space viewer doesn't render
Ensure your system has WebGL support in the embedded Chromium browser.
MATLAB R2022a+ uses a Chromium-based HTML renderer that supports WebGL.
