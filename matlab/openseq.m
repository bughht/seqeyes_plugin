function openseq(filename)
% OPENSEQ  Auto-open handler for .seq files in MATLAB.
%
%   When you double-click a .seq file in the MATLAB Current Folder browser,
%   MATLAB calls open('file.seq'), which dispatches to this function.
%
%   This simply launches seqeyes() with the given file.
%
%   See also: seqeyes

    if nargin < 1 || isempty(filename)
        seqeyes();
    else
        seqeyes(filename);
    end
end
