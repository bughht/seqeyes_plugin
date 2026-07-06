%% SeqEyes Demo
% Open the SeqEyes viewer with an example Pulseq sequence.
%
% This demo assumes you have a .seq file in your current folder.
% If you don't have one, download an example from:
%   https://github.com/pulseq/pulseq/tree/master/examples

% ── Option 1: Open a specific file ────────────────────────────────────
% seqeyes('spiral_inout.seq');

% ── Option 2: Open empty viewer and drag & drop ───────────────────────
% seqeyes();

% ── Option 3: Use the open handler ────────────────────────────────────
% open('spiral_inout.seq');   % same as double-clicking in Current Folder

fprintf(['SeqEyes Demo\n' ...
         '=============\n' ...
         'Run:  seqeyes(''your_file.seq'')\n' ...
         'Or double-click a .seq file in the Current Folder browser.\n\n' ...
         'Download example .seq files from:\n' ...
         '  https://github.com/pulseq/pulseq/tree/master/examples\n']);
