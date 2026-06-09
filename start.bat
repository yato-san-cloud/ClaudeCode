@echo off
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

REM First run only: install the parts it needs (takes a few minutes).
python -c "import fastapi, uvicorn" 1>nul 2>nul
if errorlevel 1 (
  echo First-time setup: installing dependencies ^(a few minutes^)...
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
