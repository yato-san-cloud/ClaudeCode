@echo off
REM ============================================================================
REM  whsim launcher -- THIS IS THE ONE. Just double-click start.bat.
REM  It updates the code, installs/updates Python deps, opens the browser, and
REM  keeps pulling the latest while it runs. No git or Python knowledge needed.
REM
REM  (scripts\autosync.bat is an internal helper called from here -- don't run
REM   it directly. This is the only launcher you need.)
REM ============================================================================
setlocal
cd /d "%~dp0"
title whsim
echo ============================================================
echo   whsim - getting the latest version, please wait...
echo ============================================================

REM Always run THIS folder's code (avoids confusion if you have copies).
set "PYTHONPATH=%~dp0src"

REM Sync to the latest automatically (no git knowledge needed).
git fetch origin claude/warehouse-simulator-qBrf0 -q 2>nul
git reset --hard origin/claude/warehouse-simulator-qBrf0 -q 2>nul

REM Is Python installed?
python --version >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Python not found. Install Python 3.10+ from python.org
  echo         and tick "Add python.exe to PATH" during setup.
  echo.
  pause
  exit /b 1
)

REM Install / UPDATE dependencies. We check every runtime dep that isn't part of
REM the base scientific stack, so when a new feature adds one (e.g. javaobj-py3
REM for native .rmpm, xlrd for legacy .xls) an existing install picks it up on the
REM next launch instead of erroring at import time. `pip install -e` is fast when
REM everything is already satisfied.
python -c "import fastapi, uvicorn, javaobj, xlrd, openpyxl, python_calamine, ezdxf, pptx, reportlab" 1>nul 2>nul
if errorlevel 1 (
  echo Installing / updating dependencies ^(first run takes a few minutes^)...
  echo.
  python -m pip install -e ".[web,docs]"
)

REM Keep pulling the latest while running (a small extra window opens - ignore it).
start "whsim-update" /min cmd /c "scripts\autosync.bat claude/warehouse-simulator-qBrf0"

REM Open the browser automatically.
start "whsim" /min cmd /c "timeout /t 3 /nobreak >nul & explorer http://127.0.0.1:8000"

echo.
echo   Opening  http://127.0.0.1:8000
echo   To SEE NEW CHANGES: just press F5 (refresh) in the browser.
echo   To STOP: close all the black windows.
echo ------------------------------------------------------------
echo.

set WHSIM_DEV=1
python -m uvicorn whsim.web.app:app --host 127.0.0.1 --port 8000 --reload

echo.
echo Server stopped.
pause
endlocal
