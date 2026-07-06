function seqeyes(filename)
% SEQEYES  Open a Pulseq .seq file in the SeqEyes MRI sequence viewer.
%
%   seqeyes('file.seq')  — opens the specified .seq file in an interactive viewer
%   seqeyes()            — opens an empty viewer (drag & drop or use File > Open)
%
%   Double-clicking a .seq file in the MATLAB Current Folder browser also
%   opens it automatically (via openseq.m).
%
%   See also: openseq, gettingStarted

    myDir = fileparts(mfilename('fullpath'));

    % Try sibling web/ first (toolbox install layout), then parent web/ (local dev)
    htmlPath = fullfile(myDir, 'web', 'index.html');
    if ~isfile(htmlPath)
        htmlPath = fullfile(fileparts(myDir), 'web', 'index.html');
    end

    if ~isfile(htmlPath)
        error('SeqEyes:NotFound', ...
              'Cannot find web/index.html.  Toolbox may be corrupted.\n' + ...
              'Tried: %s and %s', ...
              fullfile(myDir, 'web', 'index.html'), ...
              fullfile(fileparts(myDir), 'web', 'index.html'));
    end

    toolboxRoot = fileparts(fileparts(htmlPath));  % project root (one above web/)

    % Icon path: try sibling resources/ first (toolbox layout), then matlab/resources/ (dev)
    iconPath = fullfile(toolboxRoot, 'resources', 'logo.png');
    if ~isfile(iconPath)
        iconPath = fullfile(toolboxRoot, 'matlab', 'resources', 'logo.png');
    end

    % ── Create figure ──────────────────────────────────────────────────
    fig = uifigure('Name', 'SeqEyes — Pulseq MRI Sequence Viewer', ...
                   'Icon', iconPath, ...
                   'AutoResizeChildren', 'off', ...
                   'HandleVisibility', 'on');

    screenSize = get(groot, 'ScreenSize');
    fig.Position = [screenSize(1:2) + [80 80], screenSize(3:4) - [160 160]];

    g = uigridlayout(fig, [1, 1], 'Padding', [0 0 0 0]);

    % ── If a file is given, embed its content into the HTML ────────────
    hasFile = (nargin >= 1 && ~isempty(filename));
    if hasFile
        % Resolve to absolute path
        fullPath = resolveFilePath(filename);
        if isempty(fullPath) || ~isfile(fullPath)
            warning('SeqEyes:FileNotFound', ...
                    'File not found: %s.  Opening empty viewer.', filename);
            hasFile = false;
        end
    end

    if hasFile
        % Embed .seq data directly into a temp HTML file (bypasses bridge)
        [htmlPath, tempDir] = buildPreloadedHTML(htmlPath, fullPath);
        cleanupObj = onCleanup(@() rmdir(tempDir, 's'));
        fig.UserData.cleanup = cleanupObj;
    end

    % ── Create uihtml component ────────────────────────────────────────
    h = uihtml(g, 'HTMLSource', htmlPath);
    h.Layout.Row = 1;
    h.Layout.Column = 1;

    fig.UserData.htmlComponent = h;
    drawnow;
end

% =========================================================================
function fullPath = resolveFilePath(filename)
% RESOLVEFILEPATH  Resolve relative paths to absolute, preserve absolute paths.
    if isfile(filename)
        fullPath = filename;  % already a valid path (absolute or relative to pwd)
    else
        fullPath = which(filename);  % search MATLAB path
        if isempty(fullPath)
            fullPath = fullfile(pwd, filename);
        end
    end
    if ~isfile(fullPath)
        fullPath = '';
    end
end

function [newPath, tempDir] = buildPreloadedHTML(templatePath, seqFilePath)
% BUILDPRELOADEDHTML  Inject .seq content into a copy of the template HTML.
    template = fileread(templatePath);
    [~, name, ext] = fileparts(seqFilePath);
    fileName = [name ext];
    seqText = fileread(seqFilePath);

    inject = sprintf(['<script>window._SEQEYES_PRELOAD={text:%s,fileName:%s};' ...
                      'window._seqeyesLoadFile=function(t,n){' ...
                      'loadSequenceText(t,n);};</script>'], ...
                      jsonencode(seqText), jsonencode(fileName));

    % Insert right before the first <script> tag
    template = strrep(template, '<script src="pulseq-bundle.js">', ...
                      [inject '<script src="pulseq-bundle.js">']);

    % Copy supporting files to temp dir
    tempDir = tempname;
    mkdir(tempDir);
    [tmplDir, ~, ~] = fileparts(templatePath);
    copyfile(fullfile(tmplDir, 'pulseq-bundle.js'), fullfile(tempDir, 'pulseq-bundle.js'));
    % Copy logo assets if they exist (silently skip if missing)
    if isfile(fullfile(tmplDir, 'logo.png'))
        copyfile(fullfile(tmplDir, 'logo.png'), fullfile(tempDir, 'logo.png'));
    end
    if isfile(fullfile(tmplDir, 'logo.svg'))
        copyfile(fullfile(tmplDir, 'logo.svg'), fullfile(tempDir, 'logo.svg'));
    end

    newPath = fullfile(tempDir, 'index.html');
    fid = fopen(newPath, 'w', 'n', 'UTF-8');
    fprintf(fid, '%s', template);
    fclose(fid);
end
