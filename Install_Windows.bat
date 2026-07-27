@echo off
REM ===============================================================
REM   fEMSA Quant - Windows installer
REM
REM   Creates a self-contained .venv in this directory, installs the
REM   fork into it, and launches. Re-run any time to update.
REM
REM   FORK NOTE - this differs from upstream Slots on purpose.
REM   Upstream's installer runs `pip install -e .` against whatever
REM   Python is first on PATH. That is unsafe here: this fork's
REM   package directory is also named `gel_annotator`, so installing
REM   it into an environment that already has `slotsgeltool` would
REM   have the two distributions fight over the same import name and
REM   break the stock `slots` command. A dedicated venv makes the two
REM   installs incapable of interfering with each other.
REM ===============================================================
SETLOCAL ENABLEDELAYEDEXPANSION

cd /d "%~dp0"

echo.
echo  ==============================================
echo    fEMSA Quant -- installing
echo  ==============================================
echo.

set "PY="
where py >NUL 2>&1
if %ERRORLEVEL% EQU 0 (
    set "PY=py -3"
) else (
    where python >NUL 2>&1
    if %ERRORLEVEL% EQU 0 (
        set "PY=python"
    ) else (
        echo  ERROR: Python 3.10+ not found on PATH.
        echo  Install Python from https://www.python.org/downloads/ then re-run this installer.
        pause
        exit /b 1
    )
)

if not exist ".venv\Scripts\python.exe" (
    echo  Creating .venv ...
    %PY% -m venv .venv
    if errorlevel 1 (
        echo  ERROR: could not create the virtual environment.
        pause
        exit /b 1
    )
) else (
    echo  Reusing existing .venv
)

echo  Installing into .venv ^(this does not touch your system Python^) ...
".venv\Scripts\python.exe" -m pip install -q -U pip
".venv\Scripts\python.exe" -m pip install -e .
if errorlevel 1 (
    echo  ERROR: install failed.
    pause
    exit /b 1
)

echo.
echo  Install OK.
echo    GUI:      .venv\Scripts\femsa.exe          ^(http://localhost:8063^)
echo    Fitting:  .venv\Scripts\femsa-fit.exe --help
echo    Guide:    docs\femsa-quant.md
echo.
".venv\Scripts\femsa.exe"
