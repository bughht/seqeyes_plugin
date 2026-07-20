function seqeyes(source)
% SEQEYES  Open a Pulseq .seq or .bseq file in the SeqEyes MRI sequence viewer.
%
%   seqeyes(seq)         — opens an in-memory mr.Sequence object
%   seqeyes('file.seq')  — opens a text Pulseq sequence file
%   seqeyes('file.bseq') — opens a binary Pulseq sequence file
%   seqeyes()            — opens an empty viewer (drag & drop or use File > Open)
%
%   Double-clicking a .seq or .bseq file in the MATLAB Current Folder browser
%   also opens it automatically (via openseq.m or openbseq.m).
%
%   See also: openseq, openbseq, gettingStarted

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
    fig.UserData = struct();

    screenSize = get(groot, 'ScreenSize');
    fig.Position = [screenSize(1:2) + [80 80], screenSize(3:4) - [160 160]];

    g = uigridlayout(fig, [1, 1], 'Padding', [0 0 0 0]);

    % ── If input is given, embed its source bytes into the HTML ─────────
    cleanupObjects = {};
    hasSequence = (nargin >= 1 && ~isempty(source));
    if hasSequence
        try
            [fullPath, sourceCleanup] = prepareSequenceSource(source);
            cleanupObjects = [cleanupObjects sourceCleanup]; %#ok<AGROW>
        catch err
            if isTextScalar(source)
                warning('SeqEyes:FileNotFound', ...
                        'File not found: %s. Opening empty viewer.', char(source));
                hasSequence = false;
            else
                delete(fig);
                rethrow(err);
            end
        end
    end

    % Always use a MATLAB-stamped temp HTML copy so the web UI can hide
    % browser-only controls such as URL fetching inside uihtml.
    if hasSequence
        [htmlPath, tempDir] = buildMatlabHTML(htmlPath, fullPath);
    else
        [htmlPath, tempDir] = buildMatlabHTML(htmlPath, '');
    end
    cleanupObjects{end+1} = onCleanup(@() safeRemoveDir(tempDir));
    fig.UserData.cleanup = cleanupObjects;

    % ── Create uihtml component ────────────────────────────────────────
    h = uihtml(g, 'HTMLSource', htmlPath);
    h.Layout.Row = 1;
    h.Layout.Column = 1;

    fig.UserData.htmlComponent = h;
    drawnow;
end

% =========================================================================
function [fullPath, cleanupObjects] = prepareSequenceSource(source)
% PREPARESEQUENCESOURCE  Resolve a file path or write an in-memory sequence.
    cleanupObjects = {};

    if isTextScalar(source)
        fullPath = resolveFilePath(char(source));
        if isempty(fullPath) || ~isfile(fullPath)
            error('SeqEyes:FileNotFound', 'File not found: %s', char(source));
        end
        [~, ~, ext] = fileparts(fullPath);
        if ~any(strcmpi(ext, {'.seq', '.bseq'}))
            error('SeqEyes:InvalidFileType', ...
                  'Expected a Pulseq .seq or .bseq file: %s', char(source));
        end
        return;
    end

    if isSequenceLike(source)
        [fullPath, cleanupObj] = writeSequenceTempFile(source);
        cleanupObjects{end+1} = cleanupObj;
        return;
    end

    error('SeqEyes:InvalidInput', ...
          'Input must be a .seq or .bseq file path, or an mr.Sequence-like object with a write() method.');
end

function tf = isTextScalar(value)
% ISTEXTSCALAR  True for char vectors or scalar strings.
    tf = ischar(value) || (isstring(value) && isscalar(value));
end

function tf = isSequenceLike(value)
% ISSEQUENCELIKE  True for mr.Sequence or compatible objects with write().
    if ~isobject(value)
        tf = false;
        return;
    end

    if isa(value, 'mr.Sequence')
        tf = true;
        return;
    end

    try
        tf = ismethod(value, 'write');
    catch
        try
            tf = any(strcmp(methods(value), 'write'));
        catch
            tf = false;
        end
    end
end

function [seqFilePath, cleanupObj] = writeSequenceTempFile(seqObj)
% WRITESEQUENCETEMPFILE  Serialize an in-memory sequence to a temporary file.
    tempDir = tempname;
    mkdir(tempDir);
    seqFilePath = fullfile(tempDir, 'seqeyes_sequence.seq');

    try
        seqObj.write(seqFilePath);
    catch err
        safeRemoveDir(tempDir);
        error('SeqEyes:SequenceWriteFailed', ...
              'Could not write sequence object to a temporary .seq file: %s', err.message);
    end

    if ~isfile(seqFilePath)
        safeRemoveDir(tempDir);
        error('SeqEyes:SequenceWriteFailed', ...
              'Sequence write() completed but did not create a .seq file.');
    end

    cleanupObj = onCleanup(@() safeRemoveDir(tempDir));
end

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

function safeRemoveDir(folderPath)
% SAFEREMOVEDIR  Best-effort cleanup for temporary viewer folders.
    if exist(folderPath, 'dir')
        try
            rmdir(folderPath, 's');
        catch
            % Temporary cleanup should never interrupt figure shutdown.
        end
    end
end

function [newPath, tempDir] = buildMatlabHTML(templatePath, seqFilePath)
% BUILDMATLABHTML  Inject MATLAB host metadata and optional sequence bytes.
    template = fileread(templatePath);

    if ismac
        hostPlatform = 'macos';
    elseif ispc
        hostPlatform = 'windows';
    else
        hostPlatform = 'linux';
    end
    inject = sprintf(['<script>window._SEQEYES_HOST="matlab";' ...
                      'window._SEQEYES_PLATFORM=%s;'], jsonencode(hostPlatform));
    if ~isempty(seqFilePath)
        [~, name, ext] = fileparts(seqFilePath);
        fileName = [name ext];
        sourceBytes = readFileBytes(seqFilePath);
        sourceBase64 = matlab.net.base64encode(sourceBytes);
        inject = sprintf(['%swindow._SEQEYES_PRELOAD={base64:%s,fileName:%s};'], ...
                          inject, jsonencode(sourceBase64), jsonencode(fileName));
    end
    inject = [inject '</script>'];

    % Insert right before the first <script> tag
    template = strrep(template, '<script src="pulseq-bundle.js">', ...
                      [inject '<script src="pulseq-bundle.js">']);

    % Copy supporting files to temp dir
    tempDir = tempname;
    mkdir(tempDir);
    [tmplDir, ~, ~] = fileparts(templatePath);
    copyfile(fullfile(tmplDir, 'pulseq-bundle.js'), fullfile(tempDir, 'pulseq-bundle.js'));
    copyfile(fullfile(tmplDir, 'webview-bundle.js'), fullfile(tempDir, 'webview-bundle.js'));
    copyfile(fullfile(tmplDir, 'styles.css'), fullfile(tempDir, 'styles.css'));
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

function bytes = readFileBytes(filePath)
% READFILEBYTES  Read a sequence without interpreting binary data as text.
    fid = fopen(filePath, 'rb');
    if fid < 0
        error('SeqEyes:FileReadFailed', 'Could not open sequence file: %s', filePath);
    end
    cleanupObj = onCleanup(@() fclose(fid)); %#ok<NASGU>
    bytes = fread(fid, Inf, '*uint8');
end
