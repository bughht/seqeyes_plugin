function gettingStarted
% GETTINGSTARTED  Quick-start guide for SeqEyes MATLAB Toolbox.
%
%   SeqEyes is an interactive viewer for Pulseq MRI sequence objects and
%   Pulseq (.seq) files.
%   It visualises RF pulses, gradient waveforms, ADC readouts, triggers,
%   and includes a GPU-accelerated 3D k-space viewer.
%
% ── Quick Start ───────────────────────────────────────────────────────
%
%   >> seqeyes(seq)                   % open an in-memory mr.Sequence
%   >> seqeyes('spiral_inout.seq')    % open a saved .seq file
%   >> seqeyes()                      % open empty viewer, then drag & drop
%
%   seqeyes(seq) writes a temporary .seq file internally. It does not edit
%   Pulseq files or classes.
%
% ── Auto-Open ─────────────────────────────────────────────────────────
%
%   Double-click any .seq file in the Current Folder browser and it will
%   open automatically in SeqEyes.
%
% ── Viewer Controls ───────────────────────────────────────────────────
%
%   Scroll wheel ................ Zoom in / out
%   Ctrl + scroll wheel ......... Amplitude zoom (per channel)
%   Click + drag ................ Pan timeline
%   Hover ....................... Tooltip with block details
%   Minimap bar ................. Click to jump, drag to pan
%
%   Toolbar buttons:
%     📂 Open ... Open another .seq file
%     +/− ........ Zoom
%     Fit ........ Fit entire sequence to view
%     ↺ .......... Reset view
%     Theme ...... Switch colour theme (System / Light / Dark / Dracula / …)
%     K-Space .... Toggle 3D k-space viewer panel
%
% ── K-Space Viewer ────────────────────────────────────────────────────
%
%   • Mouse drag to rotate (3D orbit)
%   • Scroll wheel to zoom
%   • Right-click + drag to pan
%   • Prj button toggles orthographic projection
%   • Unit button toggles 1/m ↔ rad/m
%
% ── Requirements ──────────────────────────────────────────────────────
%
%   MATLAB R2022a or later (for uihtml support).
%   No additional toolboxes required.
%
%   See also: seqeyes, openseq

    help gettingStarted;
end
