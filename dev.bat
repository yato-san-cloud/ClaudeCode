@echo off
rem One-command dev loop (Windows): auto-pull the current branch + auto-reloading
rem server. Keep the browser open and just press F5 -- pull / restart / cache are
rem all handled. Stop with Ctrl+C (close the "whsim-autosync" window too).
cd /d "%~dp0"
for /f %%b in ('git rev-parse --abbrev-ref HEAD') do set "BR=%%b"
echo [whsim dev] auto-syncing to origin/%BR% every 15s; server runs with --reload.
echo [whsim dev] open http://127.0.0.1:8000  and just press F5 to see the latest.
start "whsim-autosync" cmd /c "scripts\autosync.bat %BR%"
whsim serve --reload
