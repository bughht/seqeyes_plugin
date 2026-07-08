@echo off
REM release-mltbx.cmd — Build .mltbx locally and upload to the latest GitHub Release
REM Prerequisites: MATLAB, GitHub CLI (gh), authenticated via "gh auth login"

echo.
echo === Step 1: Build .mltbx in MATLAB ===
matlab -batch "run('matlab/pack_toolbox.m')"

if %ERRORLEVEL% neq 0 (
    echo ERROR: MATLAB packaging failed
    exit /b 1
)

REM Find the .mltbx file
for %%f in (seqeyes-*.mltbx) do set MLTBX_FILE=%%f

if not defined MLTBX_FILE (
    echo ERROR: No .mltbx file found
    exit /b 1
)

echo.
echo === Step 2: Get latest release tag ===
for /f "delims=" %%t in ('gh release list -L 1 --json tagName -q ".[0].tagName"') do set TAG=%%t

if not defined TAG (
    echo ERROR: No release found. Did the CI workflow finish?
    exit /b 1
)

echo Latest release: %TAG%

echo.
echo === Step 3: Upload %MLTBX_FILE% to release %TAG% ===
gh release upload %TAG% %MLTBX_FILE% --clobber

if %ERRORLEVEL% equ 0 (
    echo.
    echo Done! %MLTBX_FILE% attached to %TAG%
) else (
    echo ERROR: Upload failed. Check gh auth status with: gh auth status
)
