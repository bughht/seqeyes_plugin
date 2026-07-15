function openbseq(filename)
% OPENBSEQ  Auto-open handler for binary Pulseq .bseq files in MATLAB.
%
%   When you double-click a .bseq file in the MATLAB Current Folder browser,
%   MATLAB calls open('file.bseq'), which dispatches to this function.
%
%   See also: seqeyes, openseq

    if nargin < 1 || isempty(filename)
        seqeyes();
    else
        seqeyes(filename);
    end
end
