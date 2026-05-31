@echo off
setlocal
cd /d "%~dp0"
title whsim warehouse simulator

echo ============================================================
echo   whsim - warehouse simulator
echo ============================================================
echo.

REM --- Check Python ---------------------------------------------------
python --version
if errorlevel 1 (
  echo.
  echo [ERROR] Python was not found.
  echo   Install Python 3.10+ from python.org and tick
  echo   "Add python.exe to PATH" during setup.
  echo.
  pause
  exit /b 1
)

REM --- First run: install dependencies --------------------------------
python -c "import whsim" 1>nul 2>nul
if errorlevel 1 (
  echo First-time setup: installing dependencies ^(this can take a few minutes^)...
  echo.
  python -m pip install -e ".[web,docs]"
  if errorlevel 1 (
    echo.
    echo [ERROR] Dependency install failed. See the messages above.
    pause
    exit /b 1
  )
)

REM --- Open the browser a few seconds later ---------------------------
start "whsim browser" /min cmd /c "timeout /t 3 /nobreak >nul & explorer http://127.0.0.1:8000"

echo.
echo Opening  http://127.0.0.1:8000  in your browser.
echo ^(If it does not open, type that address manually.^)
echo.
echo To stop: press Ctrl+C in this window, or just close it.
echo ------------------------------------------------------------
echo.

REM --- Start the server (does not rely on PATH) -----------------------
python -m uvicorn whsim.web.app:app --host 127.0.0.1 --port 8000

echo.
echo Server stopped.
pause
endlocal
