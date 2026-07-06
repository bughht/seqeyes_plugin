% PACK_TOOLBOX  Package SeqEyes as a MATLAB .mltbx toolbox file.
%
%   Usage:
%       >> run('matlab\pack_toolbox.m')   % from the project root
%
%   Output: seqeyes-<version>.mltbx

%% ── Locate project root ────────────────────────────────────────────────
scriptDir = fileparts(mfilename('fullpath'));
projectRoot = fileparts(scriptDir);  % one level up from matlab/
cd(projectRoot);                     % ensure all file ops resolve correctly

%% ── Configuration ──────────────────────────────────────────────────────
infoXml = fileread(fullfile('matlab', 'toolboxInfo.xml'));
versionMatch = regexp(infoXml, '<version>([^<]+)</version>', 'tokens', 'once');
assert(~isempty(versionMatch), 'Could not read version from toolboxInfo.xml');
tbxVersion = versionMatch{1};
tbxName = sprintf('seqeyes-%s', tbxVersion);

includeFiles = {
    fullfile('matlab', 'seqeyes.m')
    fullfile('matlab', 'openseq.m')
    fullfile('matlab', 'gettingStarted.m')
    fullfile('matlab', 'toolboxInfo.xml')
    fullfile('matlab', 'examples', 'demo.m')
    fullfile('web', 'index.html')
    fullfile('web', 'pulseq-bundle.js')
    fullfile('web', 'logo.png')
    fullfile('web', 'logo.svg')
    fullfile('matlab', 'resources', 'logo.png')
    'LICENSE.txt'
};

%% ── Build ──────────────────────────────────────────────────────────────
fprintf('Packaging SeqEyes Toolbox v%s ...\n', tbxVersion);

buildDir = fullfile(tempdir, 'seqeyes_toolbox_build');
if exist(buildDir, 'dir'), rmdir(buildDir, 's'); end

for i = 1:numel(includeFiles)
    src = includeFiles{i};
    srcAbs = fullfile(projectRoot, src);
    if ~isfile(srcAbs)
        warning('File not found, skipping: %s', src);
        continue;
    end

    % Map file to its location inside the toolbox:
    %   matlab/seqeyes.m    → seqeyes.m        (strip matlab/ prefix)
    %   matlab/examples/    → examples/
    %   matlab/resources/   → resources/
    %   web/index.html      → web/index.html   (preserve web/ folder)
    %   LICENSE.txt         → LICENSE.txt
    if startsWith(src, ['matlab' filesep])
        % Strip matlab/ prefix — these go to toolbox root
        relPath = extractAfter(src, ['matlab' filesep]);
        dst = fullfile(buildDir, relPath);
    else
        % Preserve original path (web/, LICENSE.txt, etc.)
        dst = fullfile(buildDir, src);
    end

    dstDir = fileparts(dst);
    if ~exist(dstDir, 'dir'), mkdir(dstDir); end
    copyfile(srcAbs, dst);
    fprintf('  Added: %s\n', src);
end

%% ── Package ────────────────────────────────────────────────────────────
outputFile = fullfile(projectRoot, [tbxName '.mltbx']);

try
    opts = matlab.addons.toolbox.ToolboxOptions(buildDir, 'seqeyes');
    opts.ToolboxName = 'SeqEyes';
    opts.ToolboxVersion = tbxVersion;
    opts.AuthorName = 'SeqEyes Developers';
    opts.AuthorEmail = 'bughht@outlook.com';
    opts.Summary = 'Interactive Pulseq MRI sequence viewer with k-space visualisation';
    opts.Description = fileread(fullfile(projectRoot, 'matlab', 'toolboxInfo.xml'));
    opts.MinimumMatlabRelease = 'R2022a';
    opts.OutputFile = outputFile;
    matlab.addons.toolbox.packageToolbox(opts);
    fprintf('\nToolbox packaged: %s\n', outputFile);
catch
    fprintf('packageToolbox unavailable, using zip fallback...\n');
    zip(outputFile, '*', buildDir);
    fprintf('\nToolbox packaged (zip): %s\n', outputFile);
end

rmdir(buildDir, 's');
fprintf('Done.\n\n');
fprintf('To install:\n  Double-click %s, or run:\n  >> matlab.addons.toolbox.installToolbox(''%s'')\n', ...
        outputFile, outputFile);
