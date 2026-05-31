@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title whsim 倉庫シミュレータ

echo ============================================================
echo   whsim 倉庫シミュレータ
echo ============================================================
echo.

REM --- Python の確認 -------------------------------------------------
python --version >nul 2>&1
if errorlevel 1 (
  echo [エラー] Python が見つかりません。
  echo   python.org から Python 3.10 以上をインストールし、
  echo   インストール時に "Add python.exe to PATH" にチェックしてください。
  echo.
  pause
  exit /b 1
)

REM --- 初回のみ依存をインストール ------------------------------------
python -c "import whsim" >nul 2>&1
if errorlevel 1 (
  echo 初回セットアップ: 必要なライブラリをインストールします。
  echo （数分かかることがあります。しばらくお待ちください）
  echo.
  python -m pip install -e ".[web,docs]"
  if errorlevel 1 (
    echo.
    echo [エラー] インストールに失敗しました。上のメッセージをご確認ください。
    pause
    exit /b 1
  )
)

REM --- 数秒後にブラウザを自動で開く（別ウィンドウで待機） -----------
start "whsim browser" /min cmd /c "timeout /t 3 /nobreak >nul & explorer http://127.0.0.1:8000"

echo.
echo ブラウザで  http://127.0.0.1:8000  を開きます。
echo （自動で開かない場合は、上のアドレスに手動でアクセスしてください）
echo.
echo 停止するには、このウィンドウで Ctrl + C を押すか、ウィンドウを閉じてください。
echo ------------------------------------------------------------
echo.

REM --- サーバ起動（PATH 非依存） -----------------------------------
python -m uvicorn whsim.web.app:app --host 127.0.0.1 --port 8000

echo.
echo サーバを停止しました。
pause
endlocal
