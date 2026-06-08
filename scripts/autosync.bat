@echo off
rem Mirror the working tree to origin/<branch> every 15s, so pushes show up with
rem no manual `git pull`. Arg %1 = branch name (passed by dev.bat).
rem WARNING: this HARD-RESETS the working tree -- do not hand-edit code while it
rem runs; any local edits to tracked files will be discarded.
:loop
git fetch origin %1 -q
git reset --hard origin/%1 -q
timeout /t 15 /nobreak >nul
goto loop
