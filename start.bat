@echo off
REM === カイロ紹介状アプリ 起動 (Windows) ===
REM 初回起動時は依存パッケージを自動インストールします。

cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
    set "PY=py -3"
) else (
    where python >nul 2>nul
    if %errorlevel%==0 (
        set "PY=python"
    ) else (
        echo Python が見つかりません。https://www.python.org/ からインストールしてください。
        pause
        exit /b 1
    )
)

if not exist ".venv\Scripts\python.exe" (
    echo [初回セットアップ] 仮想環境を作成します...
    %PY% -m venv .venv
    call ".venv\Scripts\activate.bat"
    pip install --upgrade pip
    pip install -r requirements.txt
    pip install pywebview
) else (
    call ".venv\Scripts\activate.bat"
)

echo アプリを起動します...
python desktop.py
