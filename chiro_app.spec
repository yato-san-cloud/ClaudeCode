# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec (Windows / macOS 両対応)
#
#   pip install pyinstaller
#   pyinstaller chiro_app.spec
#
# 成果物:
#   Windows: dist/ChiroApp.exe            (単一ファイル / ダブルクリックで起動)
#   macOS  : dist/ChiroApp.app            (アプリバンドル / Applicationsへコピー)
#
# アイコン: Windows は static/icons/icon.ico (リポジトリ同梱)。
#           macOS は static/icons/icon.icns (CI で iconutil により生成) が
#           存在する場合のみ適用される。
import os
import sys

APP_NAME = "ChiroApp"
IS_MAC = sys.platform == "darwin"
IS_WIN = sys.platform.startswith("win")

block_cipher = None

datas = [
    ("templates", "templates"),
    ("static", "static"),
]

hiddenimports = ["webview"]
if IS_WIN:
    hiddenimports += [
        "webview.platforms.edgechromium",
        "webview.platforms.winforms",
    ]
elif IS_MAC:
    hiddenimports += ["webview.platforms.cocoa"]
else:
    hiddenimports += ["webview.platforms.gtk", "webview.platforms.qt"]

# DICOM: pydicom はプラグインをエントリポイントで動的検出するため、
# 明示収集してパッケージに含める (非圧縮DICOMは常に、圧縮はプラグイン同梱時)
try:
    from PyInstaller.utils.hooks import collect_submodules
    hiddenimports += collect_submodules("pydicom")
    for _mod in ("pylibjpeg", "libjpeg", "openjpeg"):
        try:
            hiddenimports += collect_submodules(_mod)
        except Exception:
            pass
except Exception:
    pass

win_icon = os.path.join("static", "icons", "icon.ico")
mac_icon = os.path.join("static", "icons", "icon.icns")

a = Analysis(
    ["desktop.py"],
    pathex=["."],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # cryptography はアプリ未使用。壊れたシステムパッケージをフックが
    # スキャンして失敗する環境があるため明示的に除外する (ビルドも軽くなる)
    excludes=["tkinter", "cryptography"],
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

if IS_MAC:
    # macOS: onedir + .app バンドル (onefile は Gatekeeper と相性が悪い)
    exe = EXE(
        pyz,
        a.scripts,
        exclude_binaries=True,
        name=APP_NAME,
        debug=False,
        strip=False,
        upx=False,
        console=False,
        icon=mac_icon if os.path.exists(mac_icon) else None,
    )
    coll = COLLECT(
        exe, a.binaries, a.zipfiles, a.datas,
        strip=False, upx=False, name=APP_NAME,
    )
    app = BUNDLE(
        coll,
        name=f"{APP_NAME}.app",
        icon=mac_icon if os.path.exists(mac_icon) else None,
        bundle_identifier="jp.chiro.pelvis-analyzer",
        info_plist={
            "CFBundleDisplayName": "カイロ骨盤分析",
            "CFBundleShortVersionString": "1.0.0",
            "NSHighResolutionCapable": True,
            "NSHumanReadableCopyright": "For clinical reference use.",
        },
    )
else:
    # Windows / Linux: 単一実行ファイル
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.zipfiles,
        a.datas,
        name=APP_NAME,
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,  # UPX はアンチウイルス誤検知の原因になるため使わない
        console=False,
        icon=win_icon if (IS_WIN and os.path.exists(win_icon)) else None,
    )
