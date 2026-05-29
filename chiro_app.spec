# PyInstaller spec: pyinstaller chiro_app.spec
# 実行方法:
#   pip install pyinstaller
#   pyinstaller chiro_app.spec
# 成果物: dist/ChiroReferralApp(.exe)  ダブルクリックで起動可能

# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_submodules

block_cipher = None

datas = [
    ("templates", "templates"),
    ("static", "static"),
]

hiddenimports = (
    collect_submodules("reportlab")
    + collect_submodules("flask")
    + ["webview"]
)

a = Analysis(
    ["desktop.py"],
    pathex=["."],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    name="ChiroReferralApp",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,        # GUIアプリとして起動(コンソール非表示)
    icon="static/icons/icon-512.png",
)
