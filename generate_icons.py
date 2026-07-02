"""アプリアイコン (192x192 / 512x512) を生成する。

塩川カイロのHP風の落ち着いた紺ベースで、シンプルな骨格モチーフを描く。
"""
import os
import cv2
import numpy as np

OUT_DIR = os.path.join(os.path.dirname(__file__), "static", "icons")
os.makedirs(OUT_DIR, exist_ok=True)

PRIMARY = (124, 95, 44)   # BGR for #2c5f7c
ACCENT = (248, 244, 232)  # BGR for #e8f4f8
WHITE = (255, 255, 255)


def make_icon(size):
    img = np.full((size, size, 3), PRIMARY, dtype=np.uint8)

    # 丸い背景 (maskable のためエッジに余白)
    pad = int(size * 0.08)
    cv2.rectangle(img, (0, 0), (size, size), PRIMARY, -1)

    cx, cy = size // 2, size // 2

    # 骨盤シルエット
    cv2.ellipse(img, (cx, int(size * 0.55)),
                (int(size * 0.28), int(size * 0.18)), 0, 0, 360, ACCENT, -1)
    cv2.ellipse(img, (cx, int(size * 0.55)),
                (int(size * 0.22), int(size * 0.14)), 0, 0, 360, PRIMARY, -1)

    # 中央の縦軸 (脊椎ライン)
    cv2.line(img, (cx, int(size * 0.18)), (cx, int(size * 0.55)),
             ACCENT, max(2, size // 60))

    # 椎体ドット
    for i in range(4):
        y = int(size * 0.22 + i * size * 0.075)
        cv2.circle(img, (cx, y), max(3, size // 50), ACCENT, -1)

    # 水平ライン (骨盤傾斜のメタファー)
    cv2.line(img, (int(size * 0.25), int(size * 0.55)),
             (int(size * 0.75), int(size * 0.55)),
             ACCENT, max(2, size // 80))

    return img


for s in (192, 512):
    path = os.path.join(OUT_DIR, f"icon-{s}.png")
    cv2.imwrite(path, make_icon(s))
    print("wrote", path)

# Windows 用 .ico (PyInstaller の exe アイコン)
try:
    from PIL import Image

    src = Image.open(os.path.join(OUT_DIR, "icon-512.png"))
    ico_path = os.path.join(OUT_DIR, "icon.ico")
    src.save(ico_path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48),
                              (64, 64), (128, 128), (256, 256)])
    print("wrote", ico_path)
except ImportError:
    print("Pillow が無いため .ico はスキップ")

# macOS 用 .icns は CI (macOSランナー) 上で iconutil により生成する
# → .github/workflows/build-desktop.yml を参照
