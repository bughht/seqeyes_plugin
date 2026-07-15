%% SeqEyes Demo
% Open the SeqEyes viewer with an example Pulseq sequence.
%
% If you have an in-memory mr.Sequence object, call seqeyes(seq) directly.
% No manual export is needed; SeqEyes writes a temporary .seq file
% internally. If you don't have a .seq file, download an example from:
%   https://github.com/pulseq/pulseq/tree/master/examples

% ── Option 1: Open an in-memory Pulseq sequence ───────────────────────
% seqeyes(seq);

% ── Option 2: Open a specific file ────────────────────────────────────
% seqeyes('spiral_inout.seq');
% seqeyes('gre.bseq');

% ── Option 3: Open empty viewer and drag & drop ───────────────────────
% seqeyes();

% ── Option 4: Use the open handler ────────────────────────────────────
% open('spiral_inout.seq');   % same as double-clicking in Current Folder
% open('gre.bseq');

fprintf(['SeqEyes Demo\n' ...
         '=============\n' ...
         'Run:  seqeyes(seq) for an in-memory mr.Sequence object\n' ...
         'Run:  seqeyes(''your_file.seq'')\n' ...
         'Run:  seqeyes(''your_file.bseq'')\n' ...
         'Or double-click a .seq or .bseq file in the Current Folder browser.\n\n' ...
         'Download example .seq files from:\n' ...
         '  https://github.com/pulseq/pulseq/tree/master/examples\n']);
