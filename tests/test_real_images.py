"""実際のAP骨盤X線に対する検出のサニティ回帰テスト。

Creative Commonsの実X線 (radoss-org/radoss-creative-commons, 出典: Radiopaedia)
を都度取得して検出を走らせ、実写でも破綻しないことを確認する。画像はリポジトリに
コミットしない (帰属/ライセンスのため) — ネットワークで取得できなければスキップする。

実行: python3 tests/test_real_images.py
"""
import os
import sys
import glob
import shutil
import subprocess
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.dicom_loader import is_dicom, load_dicom
from modules.xray_analyzer import detect_landmarks, render_annotated

REPO = "https://github.com/radoss-org/radoss-creative-commons"


def _fetch(dest):
    """実X線リポジトリを浅くクローン。成功で dcm パスのリスト、失敗で None。"""
    try:
        subprocess.run(
            ["git", "clone", "--depth", "1", REPO, dest],
            check=True, capture_output=True, timeout=120,
        )
    except Exception:
        return None
    files = sorted(glob.glob(os.path.join(dest, "dicoms", "xray", "*.dcm")))
    return files or None


def run():
    tmp = tempfile.mkdtemp(prefix="radoss_")
    try:
        files = _fetch(os.path.join(tmp, "cc"))
        if not files:
            print("SKIP: 実X線を取得できませんでした (ネットワーク制限)。")
            return True

        print(f"実X線 {len(files)} 症例で検証")
        checked = 0
        for f in files:
            data = open(f, "rb").read()
            assert is_dicom(data), f"is_dicom failed: {f}"
            r = load_dicom(data)                       # 実DICOM(RGB等)を読めること
            assert r["png"][:8] == b"\x89PNG\r\n\x1a\n"
            w, h = r["width"], r["height"]
            assert w > 0 and h > 0

            det = detect_landmarks(r["png"], "pelvis_full")
            lm = {p["id"]: (p["x"], p["y"]) for p in det["landmarks"]}
            assert len(lm) == 8, f"expected 8 landmarks, got {len(lm)}"

            lf, rf = lm["left_femoral"], lm["right_femoral"]
            li, ri = lm["left_iliac"], lm["right_iliac"]
            # サニティ: 大腿骨頭は下半分側、画面左右に分かれる
            assert lf[0] < w * 0.5 < rf[0] + 1, f"femoral heads not split L/R: {lf},{rf} in {f}"
            assert lf[1] > h * 0.25 and rf[1] > h * 0.25, "femoral heads too high"
            # 腸骨稜は大腿骨頭より上
            assert li[1] < lf[1] and ri[1] < rf[1], "iliac crest not above femoral head"

            annotated, m = render_annotated(r["png"], "pelvis_full", det["landmarks"])
            assert annotated[:8] == b"\x89PNG\r\n\x1a\n"
            assert "clinical_summary" in m
            checked += 1

        print(f"OK: {checked} 症例すべて検出が妥当 (8点/大腿骨頭L-R/腸骨稜が頭より上)")
        return True
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_real_pelvis_detection_sanity():
    assert run() is True


if __name__ == "__main__":
    ok = run()
    print("real-image sanity:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)
