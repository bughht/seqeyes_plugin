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
infoPath = fullfile('matlab', 'toolboxInfo.xml');
infoXml = fileread(infoPath);
versionMatch = regexp(infoXml, '<version>([^<]+)</version>', 'tokens', 'once');
assert(~isempty(versionMatch), 'Could not read version from toolboxInfo.xml');
packageVersion = readPackageVersion(fullfile(projectRoot, 'package.json'));
if ~isempty(packageVersion)
    tbxVersion = packageVersion;
    if ~strcmp(tbxVersion, versionMatch{1})
        warning('SeqEyes:VersionMismatch', ...
                'toolboxInfo.xml version %s differs from package.json version %s; packaging as %s.', ...
                versionMatch{1}, tbxVersion, tbxVersion);
    end
else
    tbxVersion = versionMatch{1};
end
infoXml = regexprep(infoXml, '<version>[^<]+</version>', ['<version>' tbxVersion '</version>']);
tbxName = sprintf('seqeyes-%s', tbxVersion);

includeFiles = {
    fullfile('matlab', 'seqeyes.m')
    fullfile('matlab', 'openseq.m')
    fullfile('matlab', 'openbseq.m')
    fullfile('matlab', 'gettingStarted.m')
    fullfile('matlab', 'toolboxInfo.xml')
    fullfile('matlab', 'examples', 'demo.m')
    fullfile('web', 'index.html')
    fullfile('web', 'derived-series.js')
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
    if strcmp(src, fullfile('matlab', 'toolboxInfo.xml'))
        writeTextFile(dst, infoXml);
    else
        copyfile(srcAbs, dst);
    end
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
    opts.Description = infoXml;
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

function version = readPackageVersion(packageJsonPath)
% READPACKAGEVERSION  Return package.json version, or '' if unavailable.
    version = '';
    if ~isfile(packageJsonPath), return; end
    packageText = fileread(packageJsonPath);
    try
        packageData = jsondecode(packageText);
        if isfield(packageData, 'version') && (ischar(packageData.version) || isstring(packageData.version))
            version = char(packageData.version);
        end
    catch
        versionMatch = regexp(packageText, '"version"\s*:\s*"([^"]+)"', 'tokens', 'once');
        if ~isempty(versionMatch), version = versionMatch{1}; end
    end
end

function writeTextFile(filePath, text)
% WRITETEXTFILE  Write UTF-8 text, matching how seqeyes.m writes temp HTML.
    fid = fopen(filePath, 'w', 'n', 'UTF-8');
    assert(fid > 0, 'Could not write file: %s', filePath);
    cleanupObj = onCleanup(@() fclose(fid));
    fprintf(fid, '%s', text);
end
